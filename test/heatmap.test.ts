import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPulse } from '../src/core.js';
import { Heat, bucketOf } from '../src/heatmap.js';
import { parseRemote } from '../src/remote.js';
import type { HeatTap, Platform, Signal } from '../src/types.js';
import { validStored } from '../src/validation.js';
import { harness, InstallStorage, settle } from './helpers.js';

class AppStorage extends InstallStorage {
  cached: string | null = null;
  config = {
    read: async (): Promise<string | null> => this.cached,
    write: async (value: string): Promise<void> => { this.cached = value; },
    remove: async (): Promise<void> => { this.cached = null; },
  };
}
const T0 = new Date(2026, 10, 16, 12).getTime();
beforeEach(() => { vi.useFakeTimers({ now: T0 }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

const cfg = (extra: object = {}): string => JSON.stringify({ version: 1, screenViews: true, automaticSignals: true, groups: {}, disabledSignals: [], heatmaps: true, ...extra });
const tap = (x = 200, y = 300, width = 400, height = 800): HeatTap => ({ x, y, width, height });

/** A client whose tap hook the test drives directly; `config` is the cached portal answer. */
async function open(config: string | undefined, options: object = {}, store = new AppStorage()) {
  if (config !== undefined) store.cached = config;
  let ready: () => boolean = () => false;
  let report: (t: HeatTap) => (() => void) | undefined = () => undefined;
  const extra: Partial<Platform> = { heatmap: (r, p) => { ready = r; report = p; } };
  const h = harness(store, extra);
  await h.start({ gzip: false, ...options });
  return { h, store, ready: () => ready(), tap: (t: HeatTap = tap()) => report(t) };
}
const sent = async (h: ReturnType<typeof harness>): Promise<Signal[]> => { await h.client.flush(); return h.requests.flatMap((_, i) => h.signals(i)); };
const maps = (s: Signal[]): Signal[] => s.filter(x => x.type === 'pulse.heatmap');

describe('config and switches', () => {
  it('is off without a cached config and with heatmaps absent or false', async () => {
    for (const config of [undefined, cfg({ heatmaps: false }), JSON.stringify({ version: 1 }), cfg({ heatmaps: 'yes' })]) {
      const c = await open(config); c.h.client.screen('/a');
      expect(c.ready()).toBe(false);
      expect(c.tap()).toBeUndefined();
      expect(maps(await sent(c.h))).toEqual([]);
    }
  });

  it('parses heatmaps only when true', () => {
    expect(parseRemote(cfg())!.heatmaps).toBe(true);
    expect(parseRemote(cfg({ heatmaps: 1 }))!.heatmaps).toBe(false);
  });

  it('captures when on and sends one pulse.heatmap with the top-level heatmap object', async () => {
    const c = await open(cfg()); c.h.client.screen('/home');
    expect(c.ready()).toBe(true);
    c.tap(tap(100, 340.26, 400, 800));
    const [m] = maps(await sent(c.h));
    expect(m).toMatchObject({ type: 'pulse.heatmap', props: {}, heatmap: { screen: '/home', bucket: 'phone', orientation: 'portrait', points: [{ x: 0.25, y: 340.3, kind: 'tap' }] } });
  });

  it('captureHeatmaps false never captures', async () => {
    const c = await open(cfg(), { captureHeatmaps: false }); c.h.client.screen('/a');
    expect(c.ready()).toBe(false);
    expect(maps(await sent(c.h))).toEqual([]);
  });

  it.each([
    ['disabledSignals', cfg({ disabledSignals: ['pulse.heatmap'] }), {}],
    ['pausedSignals', cfg({ pausedSignals: ['pulse.heatmap'] }), {}],
    ['portal automaticSignals false', cfg({ automaticSignals: false }), {}],
    ['code automaticSignals false', cfg(), { automaticSignals: false }],
    ['screen views off in the portal', cfg({ screenViews: false }), {}],
    ['screen views paused', cfg({ pausedSignals: ['pulse.screen_view'] }), {}],
  ])('no capture with %s', async (_n, config, options) => {
    const c = await open(config, options); c.h.client.screen('/a');
    expect(c.ready()).toBe(false);
    expect(c.tap()).toBeUndefined();
    expect(maps(await sent(c.h))).toEqual([]);
  });

  it('does not capture before a screen is known or after opt-out', async () => {
    const c = await open(cfg());
    expect(c.ready()).toBe(false);
    c.h.client.screen('/a');
    expect(c.ready()).toBe(true);
    c.tap();
    c.h.client.optOut(true);
    expect(c.ready()).toBe(false);
    expect(maps(await sent(c.h))).toEqual([]);
  });

  it('switching off at a config refresh stops capture at once and drops the buffer', async () => {
    const store = new AppStorage(); store.cached = cfg();
    const h = harness(store);
    let report: (t: HeatTap) => (() => void) | undefined = () => undefined;
    let ready: () => boolean = () => false;
    const base = h.platform.transport('synthetic-app-key', 'https://in.mightys.dev');
    let answer = cfg();
    const client = createPulse({ ...h.platform, heatmap: (r, p) => { ready = r; report = p; },
      transport: () => ({ ...base, config: async () => ({ status: 200, body: answer }) }) });
    client.init('synthetic-app-key', { gzip: false });
    for (let n = 0; n < 6; n++) await settle();
    client.screen('/a');
    report(tap());
    expect(ready()).toBe(true);
    // The next launch's refresh says off.
    answer = cfg({ heatmaps: false });
    const next = createPulse({ ...h.platform, heatmap: (r, p) => { ready = r; report = p; },
      transport: () => ({ ...base, config: async () => ({ status: 200, body: answer }) }) });
    next.init('synthetic-app-key', { gzip: false });
    for (let n = 0; n < 6; n++) await settle();
    next.screen('/a');
    expect(ready()).toBe(false);
    expect(report(tap())).toBeUndefined();
  });
});

describe('points, buckets and orientation', () => {
  it('rounds x to 3 decimals and y to 1, and clamps', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    c.tap(tap(133.3333, 10.04)); c.tap(tap(-5, -3)); c.tap(tap(900, 250000));
    const pts = maps(await sent(c.h))[0]!.heatmap!.points;
    expect(pts.map(p => [p.x, p.y])).toEqual([[0.333, 10], [0, 0], [1, 100000]]);
  });

  it('buckets by logical width and orientation by height against width', () => {
    expect([bucketOf(599), bucketOf(600), bucketOf(1023), bucketOf(1024)]).toEqual(['phone', 'tablet', 'tablet', 'desktop']);
  });

  it.each([[400, 800, 'phone', 'portrait'], [800, 800, 'tablet', 'portrait'], [900, 600, 'tablet', 'landscape'], [1400, 900, 'desktop', 'landscape']])(
    'width %i height %i is %s %s', async (w, hgt, bucket, orientation) => {
      const c = await open(cfg()); c.h.client.screen('/a'); c.tap(tap(10, 10, w, hgt));
      expect(maps(await sent(c.h))[0]!.heatmap).toMatchObject({ bucket, orientation });
    });

  it('ignores a tap with a broken size', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    c.tap(tap(1, 1, 0, 800)); c.tap(tap(NaN, 1));
    expect(maps(await sent(c.h))).toEqual([]);
  });
});

describe('buffer and flush triggers', () => {
  it('sends nothing for an empty buffer, one signal per screen visit on a screen change', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    c.h.client.screen('/b');
    c.tap(); c.tap(tap(50, 60));
    c.h.client.screen('/c');
    c.tap();
    const m = maps(await sent(c.h));
    expect(m.map(s => [s.heatmap!.screen, s.heatmap!.points.length])).toEqual([['/b', 2], ['/c', 1]]);
  });

  it('a bucket or orientation change closes the buffer', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    c.tap(tap(10, 10, 400, 800)); c.tap(tap(10, 10, 800, 400)); c.tap(tap(10, 10, 1200, 600));
    const m = maps(await sent(c.h));
    expect(m.map(s => [s.heatmap!.bucket, s.heatmap!.orientation])).toEqual([['phone', 'portrait'], ['tablet', 'landscape'], ['desktop', 'landscape']]);
  });

  it('page hide sends the buffer', async () => {
    const c = await open(cfg()); c.h.client.screen('/a'); c.tap();
    c.h.hide(); await settle();
    expect(c.h.requests.length).toBe(1);
    expect(maps(c.h.signals(0))).toHaveLength(1);
  });

  it('splits at 200 points and caps a session at 1000', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    for (let n = 0; n < 1100; n++) c.tap(tap(10 + (n % 7) * 100, n * 40));
    const m = maps(await sent(c.h));
    expect(m.map(s => s.heatmap!.points.length)).toEqual([200, 200, 200, 200, 200]);
  });

  it('is not counted by the automatic caps and never adds droppedAutomatic', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    for (let n = 0; n < 600; n++) c.tap(tap(10 + (n % 7) * 100, n * 40));
    const all = await sent(c.h);
    expect(maps(all)).toHaveLength(3);
    expect(all.filter(s => 'droppedAutomatic' in s.system)).toEqual([]);
  });

  it('a stored heatmap signal stays valid after a restart; an out-of-range one is rejected', async () => {
    const c = await open(cfg()); c.h.client.screen('/a'); c.tap();
    const m = maps(await sent(c.h))[0]!;
    expect(validStored(m, Date.now(), 7)).toBe(true);
    const bad = structuredClone(m); bad.heatmap!.points[0]!.x = 2;
    expect(validStored(bad, Date.now(), 7)).toBe(false);
  });
});

describe('rage and dead', () => {
  const kinds = async (c: Awaited<ReturnType<typeof open>>) => maps(await sent(c.h))[0]!.heatmap!.points.map(p => p.kind);

  it('the 3rd and later taps within 1 s and 30 px of the first are rage, earlier ones stay tap', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    c.tap(tap(100, 100)); vi.advanceTimersByTime(200);
    c.tap(tap(110, 105)); vi.advanceTimersByTime(200);
    c.tap(tap(90, 95)); vi.advanceTimersByTime(200);
    c.tap(tap(100, 100));
    expect(await kinds(c)).toEqual(['tap', 'tap', 'rage', 'rage']);
  });

  it('taps too far apart or too slow are not rage', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    c.tap(tap(100, 100)); c.tap(tap(100, 100)); c.tap(tap(100, 135));
    vi.advanceTimersByTime(1100);
    c.tap(tap(100, 100)); c.tap(tap(100, 100));
    expect(await kinds(c)).toEqual(['tap', 'tap', 'tap', 'tap', 'tap']);
  });

  it('the function a tap returns marks it dead while it is still a tap in the open buffer', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    const dead = c.tap(tap(10, 10))!;
    dead();
    expect(await kinds(c)).toEqual(['dead']);
  });

  it('a rage tap gets no dead function and a flushed point is not changed', async () => {
    const c = await open(cfg()); c.h.client.screen('/a');
    c.tap(tap(100, 100)); c.tap(tap(100, 100));
    expect(c.tap(tap(100, 100))).toBeUndefined();
    const late = c.tap(tap(300, 600))!;
    c.h.client.screen('/b');
    const m = maps(await sent(c.h))[0]!;
    late();
    expect(m.heatmap!.points[3]!.kind).toBe('tap');
  });
});

describe('Heat', () => {
  it('counts points per session and resets the buffer without resetting the count', () => {
    const heat = new Heat(); const out: number[] = [];
    heat.add('/a', tap(), 1, i => out.push(i.points.length));
    heat.reset();
    expect(heat.buffer).toBeUndefined();
    expect(heat.total).toBe(1);
  });
});
