import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../src/adapters/browser.js';
import { nodePlatform } from '../src/adapters/node.js';
import { parseRemote } from '../src/remote.js';
import { utm } from '../src/signals.js';
import type { Platform, Signal } from '../src/types.js';
import { harness, InstallStorage, settle } from './helpers.js';

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

const at = (h: number, m = 0): number => new Date(2026, 10, 16, h, m).getTime();
beforeEach(() => { vi.useFakeTimers({ now: at(12) }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A page or wrapper whose visibility, permission and scroll the test drives. */
function page(over: Partial<Platform> = {}, wrapped = true) {
  const state = { visible: true, permission: 'default' as string | undefined, scroll: 0, utm: '' };
  let change: (visible: boolean) => void = () => {};
  const extra: Partial<Platform> = {
    lifecycle: cb => { change = cb; return state.visible; },
    wrapped: () => wrapped,
    permission: () => wrapped ? state.permission : undefined,
    scroll: () => { const v = state.scroll; return v; },
    campaign: () => new URLSearchParams(state.utm),
    launch: () => wrapped ? 321.6 : undefined,
    ...over,
  };
  return { state, extra, set: (visible: boolean) => { state.visible = visible; change(visible); } };
}
const cfg = (extra: object = {}): string => JSON.stringify({ version: 1, screenViews: true, automaticSignals: true, groups: {}, disabledSignals: [], ...extra });
async function open(p: ReturnType<typeof page>, options: object = {}, config?: string, store = new AppStorage()) {
  if (config) store.cached = config;
  const h = harness(store, p.extra);
  await h.start({ gzip: false, ...options });
  return { h, store };
}
const sent = async (h: ReturnType<typeof harness>): Promise<Signal[]> => { await h.client.flush(); return h.requests.flatMap((_, i) => h.signals(i)); };
const of = (signals: Signal[], type: string): Signal[] => signals.filter(s => s.type === type);
const ON = cfg({ enabledSignals: ['pulse.app_opened', 'pulse.app_backgrounded'] });

describe('config keys', () => {
  it('parses enabledSignals and pausedSignals and ignores pauseExpensiveAt90', () => {
    const r = parseRemote(cfg({ enabledSignals: ['pulse.app_opened', 3], pausedSignals: ['pulse.screen_view'], pauseExpensiveAt90: true }))!;
    expect(r.enabled).toEqual(['pulse.app_opened']);
    expect(r.paused).toEqual(['pulse.screen_view']);
    expect(parseRemote(cfg())!.enabled).toEqual([]);
  });
});

describe('screen time, scroll and campaign', () => {
  it('sends visible seconds of the previous screen, hidden time excluded', async () => {
    const p = page(); const { h } = await open(p);
    h.client.screen('/a');
    vi.setSystemTime(at(12, 0) + 10000); p.set(false);
    vi.setSystemTime(at(12, 0) + 70000); p.set(true);
    vi.setSystemTime(at(12, 0) + 75000);
    h.client.screen('/b');
    const views = of(await sent(h), 'pulse.screen_view');
    expect(views[0]!.props).not.toHaveProperty('previousScreenSeconds');
    expect(views[1]!.props).toMatchObject({ previousScreen: '/a', previousScreenSeconds: 15 });
  });

  it('sends the max scroll of the previous page on browsers only where the platform reports it', async () => {
    const p = page(); p.state.scroll = 64.4;
    const { h } = await open(p);
    h.client.screen('/a'); h.client.screen('/b');
    const views = of(await sent(h), 'pulse.screen_view');
    expect(views[0]!.props).not.toHaveProperty('previousScrollPercent');
    expect(views[1]!.props.previousScrollPercent).toBe(64);
    const bare = page(); delete bare.extra.scroll;
    const n = await open(bare);
    n.h.client.screen('/a'); n.h.client.screen('/b');
    expect(of(await sent(n.h), 'pulse.screen_view')[1]!.props).not.toHaveProperty('previousScrollPercent');
  });

  it('adds utm tags on the first screen view of a page load only, filtered and at most 64 characters', async () => {
    const p = page(); p.state.utm = `utm_source=news&utm_medium=${'m'.repeat(80)}&utm_campaign=a%40b.com&gclid=zzz&ref=x`;
    const { h } = await open(p);
    h.client.screen('/a'); h.client.screen('/b');
    const [first, second] = of(await sent(h), 'pulse.screen_view');
    expect(first!.props).toMatchObject({ utmSource: 'news', utmMedium: 'm'.repeat(64), utmCampaign: '<filtered>' });
    expect(Object.keys(first!.props).sort()).toEqual(['screen', 'utmCampaign', 'utmMedium', 'utmSource']);
    expect(second!.props).not.toHaveProperty('utmSource');
  });

  it('utm reads only the three tags', () => {
    expect(utm(new URLSearchParams('utm_term=x&utm_source=s'))).toEqual({ utmSource: 's' });
    expect(utm(undefined)).toEqual({});
  });

  it('Node and a plain page without the hooks send none of it, but Node still times screens', async () => {
    const h = harness(new AppStorage());
    await h.start({ gzip: false });
    h.client.screen('/a'); vi.setSystemTime(at(12) + 4000); h.client.screen('/b');
    const views = of(await sent(h), 'pulse.screen_view');
    expect(views[1]!.props).toMatchObject({ previousScreenSeconds: 4 });
    expect(views[0]!.props).toEqual({ screen: '/a' });
  });
});

describe('wrapper lifecycle', () => {
  it('app_opened is not sent without enabledSignals or without a cached config', async () => {
    for (const config of [undefined, cfg(), cfg({ enabledSignals: ['pulse.app_opened'], disabledSignals: ['pulse.app_opened'] })]) {
      const p = page(); const { h } = await open(p, {}, config);
      p.set(false); p.set(true);
      expect(of(await sent(h), 'pulse.app_opened')).toHaveLength(0);
    }
  });

  it('sends app_opened (cold, then warm) and app_backgrounded with foreground seconds', async () => {
    const p = page(); const { h } = await open(p, {}, ON);
    vi.setSystemTime(at(12) + 30000); p.set(false);
    vi.setSystemTime(at(12) + 90000); p.set(true);
    const all = await sent(h);
    expect(of(all, 'pulse.app_opened').map(s => s.props.coldStart)).toEqual(['true', 'false']);
    expect(of(all, 'pulse.app_backgrounded').map(s => s.props.foregroundSeconds)).toEqual([30]);
    expect(all.map(s => s.type).slice(0, 4)).toEqual(['pulse.new_install', 'pulse.session_started', 'pulse.app_opened', 'pulse.app_backgrounded']);
  });

  it('counts foregrounds per local day and reports the previous foreground length', async () => {
    const p = page(); const { h } = await open(p, {}, ON);
    vi.setSystemTime(at(12) + 20000); p.set(false);
    p.set(true); p.set(false); p.set(true);
    h.client.screen('/x');
    const last = (await sent(h)).at(-1)!;
    expect(last.system).toMatchObject({ foregroundsToday: '3', previousForegroundSeconds: '0' });
    vi.setSystemTime(at(12) + 86400000 + 1000);
    p.set(false); p.set(true);
    h.client.screen('/y');
    h.hide();
    const again = (await sent(h)).at(-1)!;
    expect(again.system.foregroundsToday).toBe('1');
  });

  it('works without enabledSignals for counters and drops nothing else; groups can hide them', async () => {
    const p = page(); const { h } = await open(p, {}, cfg({ groups: { usage: false, permissions: false } }));
    h.client.screen('/x');
    const s = (await sent(h)).at(-1)!;
    expect(s.system).not.toHaveProperty('foregroundsToday');
    expect(s.system).not.toHaveProperty('notificationPermission');
  });

  it('app_backgrounded after 30 minutes without a signal is dropped, counters still move', async () => {
    const p = page(); const { h, store } = await open(p, {}, ON);
    h.client.screen('/x');
    vi.setSystemTime(at(12) + 31 * 60000); p.set(false);
    p.set(true);
    const all = await sent(h);
    expect(of(all, 'pulse.app_backgrounded')).toHaveLength(0);
    expect(JSON.parse(store.text!).fgp).toBe(31 * 60);
    expect(of(all, 'pulse.session_started')).toHaveLength(2);
  });

  it('respects automaticSignals false, disabledSignals, pausedSignals and the master switch', async () => {
    for (const [options, config] of [[{ automaticSignals: false }, ON], [{}, cfg({ enabledSignals: ['pulse.app_opened', 'pulse.app_backgrounded'], disabledSignals: ['pulse.app_opened', 'pulse.app_backgrounded'] })],
      [{}, cfg({ enabledSignals: ['pulse.app_opened', 'pulse.app_backgrounded'], pausedSignals: ['pulse.app_opened', 'pulse.app_backgrounded'] })],
      [{}, cfg({ enabledSignals: ['pulse.app_opened', 'pulse.app_backgrounded'], automaticSignals: false })]] as [object, string][]) {
      const p = page(); const { h } = await open(p, options, config);
      p.set(false); p.set(true);
      const all = await sent(h);
      expect(all.filter(s => /app_opened|app_backgrounded/.test(s.type))).toHaveLength(0);
    }
  });

  it('opt-out sends nothing; debug flag marks the signals', async () => {
    const p = page(); const { h } = await open(p, { debug: true }, ON);
    p.set(false);
    expect((await sent(h)).every(s => s.debug)).toBe(true);
    const q = page(); const o = await open(q, {}, ON);
    o.h.client.optOut(true); q.set(false); q.set(true);
    await o.h.client.flush();
    expect(o.h.requests).toHaveLength(0);
  });

  it('a plain browser sends none of the wrapper-only data', async () => {
    const p = page({}, false); const { h } = await open(p, {}, ON);
    p.set(false); p.set(true);
    h.client.screen('/a');
    h.client.deepLink?.('myapp://x/y');
    const all = await sent(h);
    expect(all.filter(s => /app_|deep_link|permission/.test(s.type))).toHaveLength(0);
    for (const s of all) for (const k of ['launchMs', 'foregroundsToday', 'previousForegroundSeconds', 'notificationPermission']) expect(s.system).not.toHaveProperty(k);
  });
});

describe('launch time and permissions', () => {
  it('launchMs only on the session_started of a cold start, as an integer', async () => {
    const p = page(); const { h } = await open(p);
    h.client.screen('/a');
    vi.setSystemTime(at(14)); h.client.screen('/b');
    const all = await sent(h);
    const starts = of(all, 'pulse.session_started');
    expect(starts).toHaveLength(2);
    expect(starts[0]!.system.launchMs).toBe('322');
    expect(starts[1]!.system).not.toHaveProperty('launchMs');
    expect(of(all, 'pulse.screen_view')[0]!.system).not.toHaveProperty('launchMs');
  });

  it('Node sends launchMs from process uptime and no foreground data', async () => {
    const h = harness(new AppStorage(), { launch: nodePlatform().launch! });
    await h.start({ gzip: false });
    h.client.screen('/a');
    const start = of(await sent(h), 'pulse.session_started')[0]!;
    expect(Number(start.system.launchMs)).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(Number(start.system.launchMs))).toBe(true);
    expect(start.system).not.toHaveProperty('foregroundsToday');
  });

  it('notificationPermission is a status read and permission_changed is sent once per change', async () => {
    const read = vi.fn(() => p.state.permission);
    const p = page({ permission: read });
    const { h } = await open(p);
    h.client.screen('/a');
    p.state.permission = 'granted';
    h.client.screen('/b'); h.client.screen('/c');
    const all = await sent(h);
    expect(of(all, 'pulse.screen_view').map(v => v.system.notificationPermission)).toEqual(['default', 'granted', 'granted']);
    const changes = of(all, 'pulse.permission_changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.props).toEqual({ permission: 'notification', from: 'default', to: 'granted' });
    expect(all.map(s => s.type).indexOf('pulse.permission_changed')).toBeLessThan(all.map(s => s.type).lastIndexOf('pulse.screen_view'));
  });

  it('never asks for a permission', async () => {
    const request = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: request });
    const b = browserPlatform();
    expect(b.permission?.()).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('deep links', () => {
  it('sends scheme, host and path with ids, never the query or fragment, and utm tags', async () => {
    const p = page(); const { h } = await open(p);
    h.client.deepLink('myapp://open/item/42/ref/123e4567-e89b-12d3-a456-426614174000?utm_source=mail&utm_content=zz&token=secret#frag');
    const link = of(await sent(h), 'pulse.deep_link')[0]!;
    expect(link.props).toEqual({ scheme: 'myapp', host: 'open', path: '/item/:id/ref/:id', utmSource: 'mail' });
  });

  it('caps the path at 128 and ignores junk', async () => {
    const p = page(); const { h } = await open(p);
    h.client.deepLink('https://x.invalid/' + 'a'.repeat(300));
    h.client.deepLink('not a url'); h.client.deepLink(5 as never);
    const links = of(await sent(h), 'pulse.deep_link');
    expect(links).toHaveLength(1);
    expect((links[0]!.props.path as string).length).toBe(128);
  });

  it('respects automaticSignals false, disabledSignals and pausedSignals', async () => {
    for (const [options, config] of [[{ automaticSignals: false }, undefined], [{}, cfg({ disabledSignals: ['pulse.deep_link'] })], [{}, cfg({ pausedSignals: ['pulse.deep_link'] })]] as [object, string | undefined][]) {
      const p = page(); const { h } = await open(p, options, config);
      h.client.deepLink('myapp://a/b');
      expect(of(await sent(h), 'pulse.deep_link')).toHaveLength(0);
    }
  });
});

describe('quota guards', () => {
  it('caps per session and type, counts the drops and sends the count once', async () => {
    const p = page(); const { h } = await open(p, {}, ON);
    for (let n = 0; n < 12; n++) h.client.deepLink(`myapp://a/${n}`);
    for (let n = 0; n < 7; n++) h.client.screen(`/s${n}`);
    const all = await sent(h);
    expect(of(all, 'pulse.deep_link')).toHaveLength(10);
    const carriers = all.filter(s => s.system.droppedAutomatic);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]!.system.droppedAutomatic).toBe('2');
    h.client.deepLink('myapp://a/x');
    h.client.screen('/last');
    const more = await sent(h);
    expect(more.filter(s => s.system.droppedAutomatic).map(s => s.system.droppedAutomatic)).toEqual(['2', '1']);
  });

  it('caps screen views at 100, permission changes at 5 and app events at 20 per session', async () => {
    const p = page(); const { h } = await open(p, {}, ON);
    for (let n = 0; n < 110; n++) h.client.screen(`/s${n}`);
    for (let n = 0; n < 25; n++) { p.set(false); p.set(true); }
    for (let n = 0; n < 8; n++) { p.state.permission = n % 2 ? 'granted' : 'denied'; h.client.track('x'); }
    // Finish the hide's single keepalive attempt before draining the rest of this large queue.
    await h.client.flush();
    const all = await sent(h);
    expect(of(all, 'pulse.screen_view')).toHaveLength(100);
    expect(of(all, 'pulse.app_opened')).toHaveLength(20);
    expect(of(all, 'pulse.app_backgrounded')).toHaveLength(20);
    expect(of(all, 'pulse.permission_changed')).toHaveLength(5);
    expect(of(all, 'x')).toHaveLength(8);
  });

  it('caps 300 automatic signals per install and local day, never manual signals or errors, and rolls over', async () => {
    const p = page(); const { h, store } = await open(p, { maxBatchSize: 1000, maxQueueSize: 5000 }, ON);
    for (let n = 0; n < 700; n++) {
      if (n % 100 === 0) vi.setSystemTime(at(12) + (n / 100) * 31 * 60000);
      h.client.screen(`/s${n}`);
    }
    h.client.track('manual'); h.client.trackError(new Error('boom'));
    const all = await sent(h);
    const autos = all.filter(s => s.type.startsWith('pulse.') && s.type !== 'pulse.error');
    expect(autos.length).toBe(300);
    expect(of(all, 'manual')).toHaveLength(1);
    expect(of(all, 'pulse.error')).toHaveLength(1);
    expect(JSON.parse(store.text!).q[1]).toBe(300);
    vi.setSystemTime(at(12) + 86400000 * 2);
    h.client.screen('/next');
    const next = await sent(h);
    expect(of(next, 'pulse.screen_view').some(s => s.props.screen === '/next')).toBe(true);
  });

  it('a plain browser has no install, so only session caps apply', async () => {
    const plain = harness(undefined, { wrapped: () => false });
    await plain.start({ gzip: false });
    for (let n = 0; n < 150; n++) plain.client.screen(`/s${n}`);
    expect(of(await sent(plain), 'pulse.screen_view')).toHaveLength(100);
  });
});

describe('platform adapters', () => {
  it('Node reports no lifecycle, wrapper, permission or campaign', () => {
    const n = nodePlatform();
    expect(n.lifecycle).toBeUndefined();
    expect(n.wrapped).toBeUndefined();
    expect(n.permission).toBeUndefined();
    expect(n.campaign).toBeUndefined();
  });

  it('the plain browser platform gives no permission, launch time or wrapper flag', () => {
    vi.stubGlobal('Notification', { permission: 'granted' });
    const b = browserPlatform();
    expect(b.wrapped?.()).toBe(false);
    expect(b.permission?.()).toBeUndefined();
    expect(b.launch?.()).toBeUndefined();
  });

  it('inside a wrapper the browser platform maps Notification.permission', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    for (const [given, expected] of [['granted', 'granted'], ['denied', 'denied'], ['default', 'notDetermined']]) {
      vi.stubGlobal('Notification', { permission: given });
      expect(browserPlatform().permission?.()).toBe(expected);
    }
    vi.stubGlobal('Notification', undefined);
    expect(browserPlatform().permission?.()).toBeUndefined();
  });
});

void settle;
