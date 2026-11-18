import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Platform, Signal } from '../src/types.js';
import { harness, InstallStorage, MemoryStorage, settle } from './helpers.js';

class AppStorage extends InstallStorage {
  text: string | null = null;
  cached: string | null = null;
  usage = {
    read: async (): Promise<string | null> => this.text,
    write: async (value: string): Promise<void> => { this.text = value; },
    remove: async (): Promise<void> => { this.text = null; },
  };
  config = {
    read: async (): Promise<string | null> => this.cached,
    write: async (value: string): Promise<void> => { this.cached = value; },
    remove: async (): Promise<void> => { this.cached = null; },
  };
}

const START = Date.UTC(2026, 10, 18, 12);
beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function page(wrapped = false, store: MemoryStorage = wrapped ? new AppStorage() : new MemoryStorage()) {
  let change: (shown: boolean) => void = () => {};
  const extra: Partial<Platform> = { wrapped: () => wrapped, lifecycle: cb => { change = cb; return true; } };
  const h = harness(store, extra);
  return { ...h, show: () => change(true), background: () => change(false) };
}
const signals = (h: ReturnType<typeof page>): Signal[] => h.requests.flatMap((_, i) => h.signals(i));
const backgrounds = (h: ReturnType<typeof page>): Signal[] => signals(h).filter(s => s.type === 'pulse.app_backgrounded');

describe('background session length', () => {
  it.each([false, true])('sends one default background and flushes with keepalive, wrapped=%s', async wrapped => {
    const h = page(wrapped);
    await h.start({ gzip: false });
    h.client.track('start');
    vi.setSystemTime(START + 60000);
    h.background(); h.hide(); h.background();
    await settle();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.keepalive).toBe(true);
    expect(backgrounds(h)).toHaveLength(1);
    expect(backgrounds(h)[0]).toMatchObject({ timestamp: new Date(START + 60000).toISOString(),
      props: { foregroundSeconds: 60 }, system: { sessionSeconds: '60', sdkVersion: '0.9.8' } });
    expect(signals(h).some(s => s.type === 'pulse.app_opened')).toBe(false);
  });

  it.each([false, true])('counts only the foreground span, session seconds span the session, wrapped=%s', async wrapped => {
    const h = page(wrapped); await h.start({ gzip: false }); h.client.track('start');
    vi.setSystemTime(START + 10000); h.background(); await settle();
    vi.setSystemTime(START + 40000); h.show();
    vi.setSystemTime(START + 60000); h.background(); await settle();
    expect(backgrounds(h).map(s => [s.props.foregroundSeconds, s.system.sessionSeconds])).toEqual([[10, '10'], [20, '60']]);
  });

  it('persists the end before sending and keeps the original background after failure for the next launch', async () => {
    const store = new AppStorage(); const h = page(true, store);
    await h.start({ gzip: false }); h.client.track('start'); await h.client.flush();
    h.responses.push(new Error('offline'));
    vi.setSystemTime(START + 60000); h.background(); await settle();
    expect(JSON.parse(store.text!).cur).toEqual([START, START + 60000]);
    const queued = (JSON.parse(store.value!).queue as Signal[]).find(s => s.type === 'pulse.app_backgrounded')!;
    expect(queued.system.sessionSeconds).toBe('60');
    vi.setSystemTime(START + 120000);
    const next = page(true, store); await next.start({ gzip: false }); next.client.track('next'); await next.client.flush();
    expect(signals(next).find(s => s.type === 'next')!.system.previousSessionSeconds).toBe('60');
    expect(backgrounds(next)).toEqual([queued]);
  });

  it('finishes the session and queue writes before the background request', async () => {
    const store = new AppStorage(); const h = page(true, store);
    const transport = h.platform.transport('', '');
    h.platform.transport = () => ({ ...transport, async send(...args) {
      expect(JSON.parse(store.text!).cur).toEqual([START, START + 60000]);
      expect((JSON.parse(store.value!).queue as Signal[]).some(s => s.type === 'pulse.app_backgrounded')).toBe(true);
      return transport.send(...args);
    } });
    await h.start({ gzip: false }); h.client.track('start');
    vi.setSystemTime(START + 60000); h.background(); await settle();
    expect(backgrounds(h)).toHaveLength(1);
  });

  it('keeps an early hide while initialization is still reading storage', async () => {
    const store = new AppStorage(); const h = page(true, store);
    let release!: () => void;
    const loading = new Promise<void>(resolve => { release = resolve; });
    store.read = async () => { await loading; return null; };
    h.client.init('synthetic-key', { gzip: false });
    vi.setSystemTime(START + 60000); h.background();
    release(); await h.client.flush();
    expect(JSON.parse(store.text!).cur).toEqual([START, START + 60000]);
    expect(backgrounds(h)[0]!.system.sessionSeconds).toBe('60');
  });

  it.each([
    { disabledSignals: ['pulse.app_backgrounded'] },
    { pausedSignals: ['pulse.app_backgrounded'] },
    { automaticSignals: false },
  ])('obeys remote settings %j and still saves the end', async settings => {
    const store = new AppStorage();
    store.cached = JSON.stringify({ version: 1, ...settings });
    const h = page(true, store); await h.start({ gzip: false }); h.client.track('start');
    vi.setSystemTime(START + 60000); h.background(); await settle();
    expect(backgrounds(h)).toHaveLength(0);
    expect(JSON.parse(store.text!).cur).toEqual([START, START + 60000]);
    vi.setSystemTime(START + 120000);
    const next = page(true, store); await next.start({ gzip: false }); next.client.track('next'); await next.client.flush();
    expect(signals(next).find(s => s.type === 'next')!.system.previousSessionSeconds).toBe('60');
  });

  it('obeys the code switch and opt-out', async () => {
    for (const wrapped of [false, true]) {
      const h = page(wrapped); await h.start({ automaticSignals: false, gzip: false }); h.client.track('start');
      vi.setSystemTime(START + 60000); h.background(); await settle();
      expect(backgrounds(h)).toHaveLength(0);
      const out = page(wrapped); await out.start(); out.client.optOut(true); out.background(); await settle();
      expect(out.requests).toHaveLength(0);
    }
  });

  it.each([1800000, 1860000])('drops a background at %i ms idle without opening a session', async elapsed => {
    const h = page(true); await h.start({ gzip: false }); h.client.track('start');
    vi.setSystemTime(START + elapsed); h.background(); await settle();
    expect(backgrounds(h)).toHaveLength(0);
    expect(signals(h).filter(s => s.type === 'pulse.session_started')).toHaveLength(1);
  });

  it('accepts a background just before 30 minutes idle', async () => {
    const h = page(); await h.start({ gzip: false }); h.client.track('start');
    vi.setSystemTime(START + 1799999); h.background(); await settle();
    expect(backgrounds(h)).toHaveLength(1);
  });

  it.each([false, true])('caps default backgrounds at 20 per session, wrapped=%s', async wrapped => {
    const h = page(wrapped); await h.start({ gzip: false }); h.client.track('start');
    for (let n = 1; n <= 25; n++) {
      vi.setSystemTime(START + n * 1000); h.background(); await settle(); h.show();
    }
    expect(backgrounds(h)).toHaveLength(20);
    expect(new Set(backgrounds(h).map(s => s.sessionId)).size).toBe(1);
    if (h.storage instanceof AppStorage) expect(JSON.parse(h.storage.text!).cur[1]).toBe(START + 25000);
  });

  it('does not create a browser session just because an empty page hides', async () => {
    const h = page(); await h.start(); h.background(); await settle();
    expect(h.requests).toHaveLength(0);
  });

  it('keeps sessionSeconds even when the usage group is hidden', async () => {
    const store = new AppStorage(); store.cached = JSON.stringify({ version: 1, groups: { usage: false } });
    const h = page(true, store); await h.start({ gzip: false });
    vi.setSystemTime(START + 60000); h.background(); await settle();
    expect(backgrounds(h)[0]!.system.sessionSeconds).toBe('60');
  });
});
