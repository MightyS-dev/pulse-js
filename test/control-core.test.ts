import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXED_NOW, ID, KEY, REQUIRED, WIRE, json, rig } from './control-rig.js';
import type { Call } from './control-rig.js';

const DAY = 86400000;
const HOUR = 3600000;
const wrapperIos = { app: true, info: { osName: 'iOS' } };
const cacheOf = (rules: Record<string, unknown>, ageMs: number): string => JSON.stringify({ at: FIXED_NOW - ageMs, rules });

beforeEach(() => { vi.useFakeTimers({ now: FIXED_NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

/** A server that never answers; it honours the abort signal like fetch does. */
const hang = ({ init }: Call): Promise<Response> => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

describe('the control id', () => {
  const table = new URL('./fixtures/control-v1/control-id-cases.json', import.meta.url);
  it('is the first 32 hex characters of the SHA-256 of the key, in the request path', async () => {
    const r = rig();
    r.init();
    await r.client.control.get();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.url).toBe(`https://host.invalid/api/v1/control/${ID}`);
  });

  it.skipIf(!existsSync(table))('matches every key of the shared control id table (used as given: no trimming, no case change)', async () => {
    const rows = JSON.parse(readFileSync(table, 'utf8')) as { key: string; controlId: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const r = rig();
      // An empty key is refused by init, as before; the table row is still checked through the hash.
      if (!row.key.trim() || /[\r\n]/.test(row.key)) continue;
      r.client.init(row.key, { host: 'https://host.invalid' });
      await r.client.control.get();
      expect(r.calls[0]?.url, JSON.stringify(row.key)).toBe(`https://host.invalid/api/v1/control/${row.controlId}`);
    }
  });
});

describe('what the request carries', () => {
  it('sends Accept and, with a cache, If-None-Match only: no key, no identity, no cookies', async () => {
    const r = rig({ ...wrapperIos });
    r.records.cache = cacheOf(REQUIRED(), HOUR);
    r.init();
    await r.client.control.get();
    const { init } = r.calls[0]!;
    expect(init.headers).toEqual({ Accept: 'application/json', 'If-None-Match': '"1"' });
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.method).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain(KEY);
  });

  it('works with analytics opted out (group 7) and sends the same plain request', async () => {
    const r = rig();
    r.client.optOut(true);
    r.init();
    await r.client.control.get();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.init.headers).toEqual({ Accept: 'application/json' });
  });

  it('follows a custom ingest host', async () => {
    const r = rig();
    r.client.init(KEY, { host: 'https://ingest.example.invalid/' });
    await r.client.control.get();
    expect(r.calls[0]!.url).toBe(`https://ingest.example.invalid/api/v1/control/${ID}`);
  });
});

describe('opt-out and crawlers', () => {
  it('an analytics opt-out while the request is out does not cancel it', async () => {
    let answer: (response: Response) => void = () => {};
    const r = rig({ ...wrapperIos, reply: () => new Promise<Response>(resolve => { answer = resolve; }) });
    r.init();
    await vi.advanceTimersByTimeAsync(10);
    r.client.optOut(true);
    expect(r.calls[0]!.init.signal!.aborted).toBe(false);
    answer(json(REQUIRED()));
    expect(await r.kind()).toBe('updateRequired');
  });

  it('a crawler or automated browser sends and stores nothing, App Control included', async () => {
    const r = rig({ ...wrapperIos, platform: { automated: () => true } });
    r.init();
    expect(await r.kind()).toBe('normal');
    expect(r.calls).toHaveLength(0);
    expect(r.records.cache).toBeNull();
    expect(r.records.local).toBeNull();
  });
});

describe('control off (group 8)', () => {
  it('makes no request at all and the state is normal', async () => {
    const r = rig();
    r.init({ control: 'off' });
    r.foreground();
    await r.client.control.checkNow();
    expect(await r.kind()).toBe('normal');
    expect(r.calls).toHaveLength(0);
  });
});

describe('fail open: the seven failures (group 3)', () => {
  const failures: [string, (call: Call) => Response | Promise<Response>][] = [
    ['server down', () => { throw new TypeError('fetch failed: ECONNREFUSED'); }],
    ['DNS error', () => { throw new TypeError('fetch failed: ENOTFOUND'); }],
    ['TLS error', () => { throw new Error('certificate has expired'); }],
    ['HTTP 500', () => json('boom', 500)],
    ['a body that is not JSON', () => json('<html>maintenance</html>')],
    ['a body that is not an object', () => json('[1,2,3]')],
    ['format 2', () => json(WIRE({ format: 2, update: { ios: { min: '9.0.0', mode: 'required', storeUrl: 'https://store.example.invalid/app/id1' } } }))],
    ['a body of 10 MB', () => json('{"format":1,"pad":"' + 'x'.repeat(10 * 1024 * 1024) + '"}')],
    ['HTTP 404', () => json('', 404)],
  ];

  it.each(failures)('%s: init returns at once, the state is normal, no screen, no second request', async (_name, reply) => {
    const r = rig({ ...wrapperIos, reply });
    const started = performance.now();
    r.init();
    expect(performance.now() - started).toBeLessThan(50);
    expect(await r.kind()).toBe('normal');
    await vi.advanceTimersByTimeAsync(10 * 60000);
    expect(r.calls).toHaveLength(1);
  });

  it.each(failures)('%s: keeps the last known state from the cache', async (_name, reply) => {
    const r = rig({ ...wrapperIos, reply });
    r.records.cache = cacheOf(REQUIRED(), HOUR);
    r.init();
    expect(await r.kind()).toBe('updateRequired');
    expect(r.records.cache).toBe(cacheOf(REQUIRED(), HOUR));
  });

  it('30 seconds without an answer: aborted after 3 seconds without headers', async () => {
    const r = rig({ ...wrapperIos, reply: hang });
    r.init();
    await vi.advanceTimersByTimeAsync(2900);
    expect(r.calls[0]!.init.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(r.calls[0]!.init.signal!.aborted).toBe(true);
    expect(await r.kind()).toBe('normal');
    await vi.advanceTimersByTimeAsync(30000);
    expect(r.calls).toHaveLength(1);
  });

  it('headers in time but a body that never ends: aborted after 5 seconds in all', async () => {
    const r = rig({ ...wrapperIos, reply: ({ init }) => new Response(new ReadableStream({ start(c) { init.signal!.addEventListener('abort', () => c.error(new Error('aborted'))); c.enqueue(new TextEncoder().encode('{"format"')); } }), { status: 200 }) });
    r.init();
    await vi.advanceTimersByTimeAsync(4900);
    expect(r.calls[0]!.init.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(r.calls[0]!.init.signal!.aborted).toBe(true);
    expect(await r.kind()).toBe('normal');
  });

  it('Pulse.init with a fetch that hangs returns in under 5 ms on average', async () => {
    const times: number[] = [];
    for (let n = 0; n < 20; n++) {
      const r = rig({ ...wrapperIos, reply: hang });
      const started = performance.now();
      r.init();
      times.push(performance.now() - started);
    }
    expect(times.reduce((a, b) => a + b, 0) / times.length).toBeLessThan(5);
  });

  it('a request that fails is only repeated at the next return to the foreground, at most once a minute', async () => {
    const r = rig({ ...wrapperIos, reply: () => json('', 500) });
    r.init();
    await r.kind();
    r.foreground();
    await r.client.control.get();
    expect(r.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61000);
    r.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.calls).toHaveLength(2);
  });
});

describe('the cache (group 4)', () => {
  it('first start without a network and without a cache is normal', async () => {
    const r = rig({ reply: () => { throw new TypeError('offline'); } });
    r.init();
    expect(await r.kind()).toBe('normal');
  });

  it('a cache of 31 days ignores locking rules, a cache of 29 days keeps them', async () => {
    const old = rig({ ...wrapperIos, reply: () => json('', 500) });
    old.records.cache = cacheOf(REQUIRED(), 31 * DAY);
    old.init();
    expect(await old.kind()).toBe('normal');
    const fine = rig({ ...wrapperIos, reply: () => json('', 500) });
    fine.records.cache = cacheOf(REQUIRED(), 29 * DAY);
    fine.init();
    expect(await fine.kind()).toBe('updateRequired');
  });

  it('a maintenance window that has ended is ignored from the cache, and one older than 72 hours too', async () => {
    const ended = rig({ ...wrapperIos, reply: () => json('', 500) });
    ended.records.cache = cacheOf(WIRE({ maintenance: { startsAt: new Date(FIXED_NOW - 3 * HOUR).toISOString(), endsAt: new Date(FIXED_NOW - HOUR).toISOString(), headsUpMinutes: 0, exemptAboveStore: false, platforms: null } }), 6 * HOUR);
    ended.init();
    expect(await ended.kind()).toBe('normal');
    const long = rig({ ...wrapperIos, reply: () => json('', 500) });
    long.records.cache = cacheOf(WIRE({ maintenance: { startsAt: new Date(FIXED_NOW - 4 * DAY).toISOString(), endsAt: new Date(FIXED_NOW + 4 * DAY).toISOString(), headsUpMinutes: 0, exemptAboveStore: false, platforms: null } }), 6 * HOUR);
    long.init();
    expect(await long.kind()).toBe('normal');
    const inside = rig({ ...wrapperIos, reply: () => json('', 500) });
    inside.records.cache = cacheOf(WIRE({ maintenance: { startsAt: new Date(FIXED_NOW - 2 * HOUR).toISOString(), endsAt: new Date(FIXED_NOW + HOUR).toISOString(), headsUpMinutes: 0, exemptAboveStore: false, platforms: null } }), 6 * HOUR);
    inside.init();
    expect(await inside.kind()).toBe('maintenance');
  });

  it('a 304 keeps the cache and renews the time of the last good answer', async () => {
    const r = rig({ ...wrapperIos, reply: () => new Response(null, { status: 304 }) });
    r.records.cache = cacheOf(REQUIRED(), 40 * DAY);
    r.init();
    expect(await r.kind()).toBe('updateRequired');
    expect(r.calls[0]!.init.headers!['If-None-Match']).toBe('"1"');
    expect(JSON.parse(r.records.cache!)).toEqual({ at: FIXED_NOW, rules: REQUIRED() });
  });

  it('a good 200 is written to the cache; a rejected one is not', async () => {
    const good = rig({ ...wrapperIos, reply: () => json(REQUIRED()) });
    good.init();
    expect(await good.kind()).toBe('updateRequired');
    expect(JSON.parse(good.records.cache!)).toEqual({ at: FIXED_NOW, rules: REQUIRED() });
    const bad = rig({ ...wrapperIos, reply: () => json({ format: 3 }) });
    bad.init();
    await bad.kind();
    expect(bad.records.cache).toBeNull();
  });

  it('empty rules need no module and are cached too, so a later start asks with If-None-Match', async () => {
    const r = rig({ ...wrapperIos });
    r.init();
    expect(await r.kind()).toBe('normal');
    expect(JSON.parse(r.records.cache!).rules.version).toBe(1);
  });

  it.each(['not json', '{"at":"x"}', '[]', 'null', '{"at":1,"rules":5}'])('a damaged cache record (%s) is simply no cache', async text => {
    const r = rig({ ...wrapperIos, reply: () => json(REQUIRED()) });
    r.records.cache = text;
    r.init();
    expect(await r.kind()).toBe('updateRequired');
    expect(r.calls[0]!.init.headers).toEqual({ Accept: 'application/json' });
  });

  it('a store that cannot be read or written never breaks the check', async () => {
    const r = rig({ ...wrapperIos, reply: () => json(REQUIRED()) });
    r.records.failing = true;
    r.init();
    expect(await r.kind()).toBe('updateRequired');
  });

  it('a place without storage still checks and shows the answer', async () => {
    const r = rig({ ...wrapperIos, noControlStorage: true, reply: () => json(REQUIRED()) });
    r.init();
    expect(await r.kind()).toBe('updateRequired');
  });
});

describe('switched off from the server (group 5)', () => {
  const down = async (answer: Record<string, unknown>): Promise<string[]> => {
    const r = rig({ ...wrapperIos, reply: () => json(REQUIRED()) });
    const seen: string[] = [];
    r.client.control.subscribe(state => seen.push(state.kind));
    r.init();
    expect(await r.kind()).toBe('updateRequired');
    r.setReply(() => json(answer));
    await vi.advanceTimersByTimeAsync(61000);
    r.foreground();
    await r.client.control.checkNow();
    return seen;
  };

  it('"off": true clears a screen that is showing at the next check', async () => {
    expect(await down({ ...REQUIRED(), version: 2, off: true })).toEqual(['updateRequired', 'normal']);
  });

  it('this SDK in disabledSdkVersions clears it too', async () => {
    expect(await down({ ...REQUIRED(), version: 2, disabledSdkVersions: ['pulse-js@0.9.7'] })).toEqual(['updateRequired', 'normal']);
  });

  it('another SDK or another version in the list changes nothing', async () => {
    expect(await down({ ...REQUIRED(), version: 2, disabledSdkVersions: ['pulse-js@0.9.6', 'pulse-swift@0.9.7'] })).toEqual(['updateRequired']);
  });
});

describe('the loop guard (group 6)', () => {
  it('a store version that is not newer than the installed one turns required into suggested', async () => {
    const r = rig({ ...wrapperIos, reply: () => json(REQUIRED({ min: '2.4.0', storeVersion: '2.3.0' })) });
    r.init();
    const state = await r.client.control.get();
    expect(state.kind).toBe('updateSuggested');
    expect(state.allowContinue).toBe(true);
  });

  it('a required update without any store link becomes suggested', async () => {
    const r = rig({ ...wrapperIos, reply: () => json(REQUIRED({ storeUrl: null })) });
    r.init();
    expect((await r.client.control.get()).kind).toBe('updateSuggested');
  });

  it('a link that is not a web link counts as no link', async () => {
    const r = rig({ ...wrapperIos, reply: () => json(REQUIRED({ storeUrl: 'javascript:alert(1)' })) });
    r.init();
    const state = await r.client.control.get();
    expect(state.kind).toBe('updateSuggested');
    expect(state.url).toBeUndefined();
  });

  it('three returns from the store on the same version turn required into suggested', async () => {
    const opened: string[] = [];
    vi.stubGlobal('open', (url: string) => { opened.push(url); });
    try {
      const r = rig({ ...wrapperIos, reply: () => json(REQUIRED()) });
      r.init();
      expect((await r.client.control.get()).kind).toBe('updateRequired');
      for (let press = 1; press <= 3; press++) {
        expect((await r.client.control.get()).kind).toBe('updateRequired');
        r.client.control.openStore();
        await vi.advanceTimersByTimeAsync(0);
        r.foreground();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect((await r.client.control.get()).kind).toBe('updateSuggested');
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('a scheduled maintenance window (group 9)', () => {
  const window = (startsInMs: number, lengthMs: number) => WIRE({
    maintenance: { startsAt: new Date(FIXED_NOW + startsInMs).toISOString(), endsAt: new Date(FIXED_NOW + startsInMs + lengthMs).toISOString(), headsUpMinutes: 1, exemptAboveStore: false, platforms: null },
  });

  it('starts and ends within 5 seconds of its times with no network after the first answer', async () => {
    const r = rig({ ...wrapperIos, reply: () => json(window(10 * 60000, 30 * 60000)) });
    const seen: [number, string][] = [];
    r.client.control.subscribe(state => seen.push([Date.now() - FIXED_NOW, state.kind]));
    r.init();
    expect(await r.kind()).toBe('normal');
    await vi.advanceTimersByTimeAsync(40 * 60000 + 1000);
    expect(r.calls).toHaveLength(1);
    expect(seen.map(s => s[1])).toEqual(['maintenanceUpcoming', 'maintenance', 'normal']);
    expect(seen[0]![0]).toBeGreaterThanOrEqual(9 * 60000);
    expect(seen[0]![0]).toBeLessThan(9 * 60000 + 5000);
    expect(seen[1]![0]).toBeGreaterThanOrEqual(10 * 60000);
    expect(seen[1]![0]).toBeLessThan(10 * 60000 + 5000);
    expect(seen[2]![0]).toBeGreaterThanOrEqual(40 * 60000);
    expect(seen[2]![0]).toBeLessThan(40 * 60000 + 5000);
  });
});
