import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserStorage, LEASE } from '../src/adapters/browser.js';
import type { Signal } from '../src/types.js';
import { harness, InstallStorage, settle } from './helpers.js';

class UsageStorage extends InstallStorage {
  text: string | null = null;
  usage = {
    read: async (): Promise<string | null> => this.text,
    write: async (value: string): Promise<void> => { this.text = value; },
    remove: async (): Promise<void> => { this.text = null; },
  };
}

const MINUTE = 60000;
const START = new Date(2026, 10, 15, 12).getTime();
beforeEach(() => { vi.useFakeTimers({ now: START }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const all = async (h: ReturnType<typeof harness>): Promise<Signal[]> => {
  await h.client.flush();
  return h.requests.flatMap((_, i) => h.signals(i));
};
const ids = (signals: Signal[], type?: string): string[] => signals.filter(s => !type || s.type === type).map(s => s.sessionId);

describe('session idle rule', () => {
  it('keeps one id within 29 minutes and starts a new one at 30 minutes without signals', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.track('a');
    vi.setSystemTime(START + 29 * MINUTE); h.client.track('b');
    vi.setSystemTime(START + 58 * MINUTE); h.client.track('c');
    vi.setSystemTime(START + 88 * MINUTE); h.client.track('d');
    const s = await all(h);
    expect(ids(s)[0]).toBe(ids(s)[1]);
    expect(ids(s)[1]).toBe(ids(s)[2]);
    expect(ids(s)[3]).not.toBe(ids(s)[2]);
  });

  it('measures idle from the last captured signal, not from flushes, timers or visibility', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.track('a');
    for (let n = 1; n <= 40; n++) {
      vi.setSystemTime(START + n * MINUTE);
      await h.client.flush(); h.hide();
      await vi.advanceTimersByTimeAsync(0);
    }
    h.client.track('b');
    const s = await all(h);
    expect(ids(s)[1]).not.toBe(ids(s)[0]);
  });

  it('starts a new session when the clock moves back by 30 minutes or more', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.track('a');
    vi.setSystemTime(START - 5 * MINUTE); h.client.track('b');
    vi.setSystemTime(START - 40 * MINUTE); h.client.track('c');
    const s = await all(h);
    expect(ids(s)[1]).toBe(ids(s)[0]);
    expect(ids(s)[2]).not.toBe(ids(s)[1]);
  });

  it('starts a new session after a 14 hour gap', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.track('a'); await h.client.flush();
    vi.setSystemTime(START + 14 * 60 * MINUTE); h.client.track('b');
    const s = await all(h);
    expect(ids(s)[1]).not.toBe(ids(s)[0]);
  });

  it('judges signals tracked before init by their own capture times', async () => {
    const h = harness();
    h.client.track('early-1');
    vi.setSystemTime(START + 10 * MINUTE); h.client.track('early-2');
    vi.setSystemTime(START + 41 * MINUTE); h.client.track('early-3');
    await h.start({ gzip: false });
    vi.setSystemTime(START + 50 * MINUTE); h.client.track('late');
    const s = await all(h);
    expect(ids(s)[0]).toBe(ids(s)[1]);
    expect(ids(s)[2]).not.toBe(ids(s)[1]);
    expect(ids(s)[3]).toBe(ids(s)[2]);
  });

  it('emits pulse.session_started once per new session where automatic signals apply', async () => {
    const h = harness(new UsageStorage());
    await h.start({ gzip: false });
    h.client.track('a');
    vi.setSystemTime(START + 20 * MINUTE); h.client.track('b');
    vi.setSystemTime(START + 40 * MINUTE); h.client.track('c');
    vi.setSystemTime(START + 71 * MINUTE); h.client.track('d');
    vi.setSystemTime(START + 15 * 60 * MINUTE); h.client.track('e');
    const s = await all(h);
    const started = s.filter(x => x.type === 'pulse.session_started');
    expect(started).toHaveLength(3);
    expect(new Set(ids(started)).size).toBe(3);
    expect(started.map(x => x.sessionId)).toEqual([ids(s, 'a')[0], ids(s, 'd')[0], ids(s, 'e')[0]]);
  });

  it('starts the session of a signal tracked before init after a gap, with one start per session', async () => {
    const h = harness(new UsageStorage());
    h.client.track('early-1');
    vi.setSystemTime(START + 45 * MINUTE); h.client.track('early-2');
    await h.start({ gzip: false });
    const s = await all(h);
    expect(s.filter(x => x.type === 'pulse.session_started')).toHaveLength(2);
    expect(ids(s, 'early-1')[0]).not.toBe(ids(s, 'early-2')[0]);
  });
});

describe('browser pages', () => {
  function fakeBrowser() {
    const data = new Map<string, string>();
    const methods: Record<string, unknown> = {
      getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); },
      removeItem: (k: string) => { data.delete(k); },
    };
    vi.stubGlobal('localStorage', new Proxy(methods, {
      get: (t, k) => t[k as string],
      ownKeys: () => [...data.keys()],
      getOwnPropertyDescriptor: (_, k) => data.has(k as string) ? { enumerable: true, configurable: true, value: data.get(k as string) } : undefined,
    }));
    return data;
  }

  it('does not revive the session of an adopted queue for new signals, also after 31 minutes', async () => {
    const data = fakeBrowser();
    const first = harness(browserStorage('k'));
    await first.start({ gzip: false });
    first.responses.push({ status: 500 }, { status: 500 });
    first.client.track('old'); await settle();
    const oldId = JSON.stringify([...data.values()]).match(/session-\d+/)![0];
    vi.setSystemTime(START + LEASE + MINUTE);
    const second = harness(browserStorage('k'));
    second.platform.environment.sessionId = () => 'second-1';
    await second.start({ gzip: false });
    second.client.track('new');
    const s = await all(second);
    expect(ids(s, 'old')).toEqual([oldId]);
    expect(ids(s, 'new')[0]).not.toBe(oldId);
  });

  it('starts a new session on a page load 31 minutes after the previous page signalled', async () => {
    fakeBrowser();
    const first = harness(browserStorage('k'));
    await first.start({ gzip: false });
    first.client.track('one'); const a = await all(first);
    vi.setSystemTime(START + 31 * MINUTE);
    const second = harness(browserStorage('k'));
    second.platform.environment.sessionId = () => 'second-1';
    await second.start({ gzip: false });
    second.client.track('two'); const b = await all(second);
    expect(ids(a)[0]).not.toBe(ids(b)[0]);
  });
});
