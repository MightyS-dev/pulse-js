import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPulse } from '../src/core.js';
import { ServerPolicy } from '../src/server-policy.js';
import { resilientStorage } from '../src/adapters/shared.js';
import type { PulseOptions, Signal, TrackOptions } from '../src/types.js';
import { harness, MemoryStorage, settle } from './helpers.js';

const fixtureUrl = new URL('./fixtures/v1.jsonc', import.meta.url);

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-13T08:00:00Z') }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('test mode default', () => {
  it.each([[true, undefined, true], [false, undefined, false], [true, false, false], [false, true, true], [true, true, true], [false, false, false]])(
    'platform development=%s, debug option=%s marks debug=%s', async (development, debug, expected) => {
      const h = harness(); h.setDevelopment(development);
      await h.start(debug === undefined ? { gzip: false } : { gzip: false, debug });
      h.client.track('mode'); await h.client.flush();
      expect(h.signals()[0]!.debug).toBe(expected);
    });

  it('takes the decision once at init, for signals queued before init and for later ones', async () => {
    const h = harness(); h.setDevelopment(true);
    h.client.track('early');
    await h.start({ gzip: false });
    h.setDevelopment(false);
    h.client.track('late'); await h.client.flush();
    expect(h.signals().map(s => [s.type, s.debug])).toEqual([['early', true], ['late', true]]);
  });

  it('enables warnings only when debug is on, whether explicit or by default', async () => {
    const quiet = harness(); await quiet.start(); quiet.client.track(''); await quiet.client.flush();
    expect(quiet.platform.environment.warn).not.toHaveBeenCalled();
    const loud = harness(); loud.setDevelopment(true); await loud.start(); loud.client.track(''); await loud.client.flush();
    expect(loud.platform.environment.warn).toHaveBeenCalled();
  });
});

describe('v1 signals and privacy', () => {
  it('matches the reference fixture structure with unavailable system fields omitted', async () => {
    const h = harness(); await h.start({ appVersion: '1.2.3', gzip: false });
    await h.client.setUser('synthetic-user');
    h.client.track('purchase', { value: 4.5, props: { item: 'coins', amount: 2 } }); await h.client.flush();
    const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8').replace(/^\/\/.*\r?\n/gm, '')) as Signal[];
    const actual = h.signals()[0]!;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture[0]!).sort());
    const unavailable = ['appBuildNumber', 'deviceModel'];
    expect(Object.keys(actual.system).sort()).toEqual(Object.keys(fixture[0]!.system).filter(k => !unavailable.includes(k)).sort());
    expect(actual).toMatchObject({ timestamp: '2026-11-13T08:00:00.000Z', type: 'purchase', value: 4.5, debug: false,
      system: { platform: 'web', appVersion: '1.2.3', sdkName: 'pulse-js', sdkVersion: '0.9.3' }, props: { item: 'coins', amount: 2 } });
  });

  it('escapes JSON, keeps Unicode and finite numbers, converts booleans and rejects unsupported props', async () => {
    const h = harness(); await h.start({ debug: true, gzip: false });
    h.client.track('quote"\n\u0000😀', { value: -1.25, props: { 'a"\n': 'čć\t\u0000😀', n: 1.5, yes: true, no: false,
      bad: {} as never, nan: NaN, inf: Infinity, undef: undefined as never, arr: [] as never } });
    await h.client.flush();
    expect(h.signals()[0]).toMatchObject({ type: 'quote"\n\u0000😀', value: -1.25, props: { 'a"\n': 'čć\t\u0000😀', n: 1.5, yes: 'true', no: 'false' } });
    expect(h.platform.environment.warn).toHaveBeenCalledTimes(5);
  });

  it.each(['', ' \t', 'x'.repeat(201), '😀'.repeat(101)])('rejects invalid signal types: %s', async type => {
    const h = harness(); await h.start(); h.client.track(type); await h.client.flush(); expect(h.requests).toHaveLength(0);
  });

  it('enforces UTF-16 type and UTF-8 props boundaries, including JSON punctuation', async () => {
    const h = harness(); await h.start({ gzip: false });
    h.client.track('😀'.repeat(100), { props: { x: 'a'.repeat(8184) } }); // {"x":""} is 8 bytes.
    h.client.track('too.big', { props: { x: 'a'.repeat(8185) } });
    h.client.track('utf8.big', { props: { x: 'č'.repeat(4093) } });
    h.client.track('infinite', { value: Infinity }); h.client.track('nan', { value: NaN });
    await h.client.flush(); expect(h.signals()).toHaveLength(1);
    expect(new TextEncoder().encode(JSON.stringify(h.signals()[0]!.props))).toHaveLength(8192);
  });

  it('preserves __proto__ and null values without modifying prototypes', async () => {
    const h = harness(); await h.start();
    h.client.track('safe', { value: null, props: JSON.parse('{"__proto__":"value","constructor":3}') as NonNullable<TrackOptions['props']> });
    await h.client.flush(); expect(h.signals()[0]!.props).toEqual(JSON.parse('{"__proto__":"value","constructor":3}'));
    expect(h.signals()[0]!.value).toBeNull(); expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('omits userHash by default and never persists or sends the raw user identifier', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start();
    h.client.track('anonymous');
    const raw = 'private-user@example.invalid'; await h.client.setUser(raw); h.client.track('identified');
    await h.client.setUser(null); h.client.track('cleared'); await h.client.flush();
    expect(h.signals()[0]).not.toHaveProperty('userHash'); expect(h.signals()[2]).not.toHaveProperty('userHash');
    expect(h.signals()[1]!.userHash).toBe(createHash('sha256').update(raw).digest('hex'));
    expect(JSON.stringify(h.requests)).not.toContain(raw); expect(store.history.join('')).not.toContain(raw);
  });

  it('does not allow an older asynchronous hash to overwrite the newest user or opt-out', async () => {
    const h = harness(); const deferred: ((hash: string) => void)[] = [];
    h.platform.environment.hashUser = () => new Promise(resolve => { deferred.push(resolve); });
    await h.start(); const first = h.client.setUser('first'); const second = h.client.setUser('second');
    deferred[1]!('b'.repeat(64)); await second; deferred[0]!('a'.repeat(64)); await first;
    h.client.track('newest'); await h.client.flush(); expect(h.signals()[0]!.userHash).toBe('b'.repeat(64));
    const third = h.client.setUser('third'); h.client.optOut(true); deferred[2]!('c'.repeat(64)); await third;
    h.client.optOut(false); h.client.track('anonymous'); await h.client.flush(); expect(h.signals(1)[0]).not.toHaveProperty('userHash');
  });

  it('rotates random sessions after 30 minutes of inactivity and at restart', async () => {
    const h = harness(); await h.start(); h.client.track('one'); await h.client.flush();
    vi.setSystemTime(Date.now() + 1799999); h.client.track('two'); await h.client.flush();
    vi.setSystemTime(Date.now() + 1800000); h.client.track('three'); await h.client.flush();
    expect(h.signals()[0]!.sessionId).toBe(h.signals(1)[0]!.sessionId);
    expect(h.signals(2)[0]!.sessionId).not.toBe(h.signals()[0]!.sessionId);
    const other = harness(); other.platform.environment.sessionId = () => 'new-process-session'; await other.start();
    other.client.track('restart'); await other.client.flush(); expect(other.signals()[0]!.sessionId).toBe('new-process-session');
  });
});

describe('batching and persistence', () => {
  it('batches at the default 20 seconds and stops idle timers', async () => {
    const h = harness(); await h.start(); h.client.track('time');
    await vi.advanceTimersByTimeAsync(19999); expect(h.requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  });

  it('batches by count before the interval and flush drains multiple batches', async () => {
    const h = harness(); await h.start({ maxBatchSize: 2 }); h.client.track('one'); h.client.track('two');
    await vi.advanceTimersByTimeAsync(0); expect(h.requests).toHaveLength(1); expect(h.signals()).toHaveLength(2);
    for (let i = 0; i < 5; i++) h.client.track(String(i)); await h.client.flush();
    expect(h.requests).toHaveLength(4); expect(h.signals(3)).toHaveLength(1);
  });

  it('stores at most 100 calls before init and uses initialization metadata', async () => {
    const h = harness(); for (let i = 0; i < 120; i++) h.client.track(String(i));
    await h.client.flush(); expect(h.requests).toHaveLength(0);
    await h.start({ maxBatchSize: 1000, appVersion: 'pre-init' }); await h.client.flush();
    expect(h.signals()).toHaveLength(100); expect(h.signals()[0]!.type).toBe('20');
    expect(h.signals()[0]!.system.appVersion).toBe('pre-init');
  });

  it('persists before sending, reloads durable entries and drops oldest entries when full', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start({ maxQueueSize: 3 });
    for (let i = 0; i < 5; i++) h.client.track(String(i)); await settle();
    expect(JSON.parse(store.value!).queue.map((s: Signal) => s.type)).toEqual(['2', '3', '4']);
    vi.clearAllTimers(); const reloaded = harness(store); await reloaded.start(); reloaded.client.track('new'); await reloaded.client.flush();
    expect(reloaded.signals().map(s => s.type)).toEqual(['2', '3', '4', 'new']); expect(JSON.parse(store.value!).queue).toEqual([]);
  });

  it('merges new tracks made while asynchronous storage is loading', async () => {
    const store = new MemoryStorage(); const original = harness(store); await original.start(); original.client.track('saved'); await settle();
    let resolve!: (s: string | null) => void;
    const storage = { read: () => new Promise<string | null>(r => { resolve = r; }), write: store.write.bind(store) };
    const h = harness(storage); h.client.init('key'); h.client.track('during-load'); resolve(store.value); await h.client.flush();
    expect(h.signals().map(s => s.type)).toEqual(['saved', 'during-load']);
  });

  it('discards corrupt, invalid and expired records without losing valid neighbors', async () => {
    const store = new MemoryStorage(); const original = harness(store); await original.start(); original.client.track('valid'); await settle();
    const signal = JSON.parse(store.value!).queue[0] as Signal;
    store.value = JSON.stringify({ version: 1, optOut: false, queue: [null, {}, signal, { ...signal, timestamp: '2026-11-01T00:00:00Z' },
      { ...signal, timestamp: '2026-11-13T09:00:00.001Z' }, { ...signal, userHash: 'raw-id' }, { ...signal, extra: 'unknown' },
      { ...signal, props: { nested: {} } }, { ...signal, system: { ...signal.system, deviceId: 'private' } }] });
    vi.clearAllTimers(); const h = harness(store); await h.start(); await h.client.flush(); expect(h.signals()).toHaveLength(1);
  });

  it.each(['null', '[]', '{"version":2,"optOut":false,"queue":[]}', '{"version":1,"optOut":false,"queue":null}'])('recovers from an invalid storage envelope: %s', async value => {
    const store = new MemoryStorage(); store.value = value; const h = harness(store); await h.start();
    h.client.track('after-corruption'); await h.client.flush(); expect(h.signals()[0]!.type).toBe('after-corruption');
  });

  // An unreadable opt-out record fails closed: '{broken' stays opted out.
  it.each(['{broken', '{"version":1,"optOut":"no","queue":[]}', '{"version":2,"optOut":1}'])('fails closed for opt-out when the only consent record is unreadable: %s', async value => {
    const store = new MemoryStorage(); store.value = value; const h = harness(store); await h.start();
    h.client.track('must-not-send'); await h.client.flush(); expect(h.requests).toHaveLength(0);
    h.client.optOut(false); h.client.track('explicitly-enabled'); await h.client.flush();
    expect(h.signals()[0]!.type).toBe('explicitly-enabled');
  });

  it('keeps a separate consent record authoritative: a corrupt queue cannot opt out, a corrupt consent record does', async () => {
    const queue = new MemoryStorage(); queue.value = '{broken';
    const consent = new MemoryStorage();
    const h = harness({ read: () => queue.read(), write: v => queue.write(v), consent });
    await h.start(); h.client.track('sent'); await h.client.flush(); expect(h.signals()[0]!.type).toBe('sent');
    for (const record of ['{broken', '{}', '"1"', '{"optOut":null}']) {
      vi.clearAllTimers(); consent.value = record;
      const next = harness({ read: async () => null, write: async () => {}, consent }); await next.start();
      next.client.track('blocked'); await next.client.flush(); expect(next.requests).toHaveLength(0);
    }
    const failing = harness({ read: async () => null, write: async () => {}, consent: { read: async () => { throw new Error('EBUSY'); }, write: async () => {} } });
    await failing.start(); failing.client.track('blocked'); await failing.client.flush(); expect(failing.requests).toHaveLength(0);
  });

  it('does not write back a consent change that arrived from another instance while loading, but writes an explicit one', async () => {
    const consent = new MemoryStorage(); let notify!: (value: string | null) => void; let resolve!: (value: string | null) => void;
    const h = harness({ read: () => new Promise(r => { resolve = r; }), write: async () => {}, consent, watch: callback => { notify = callback; } });
    h.client.init('key'); consent.value = '{"version":1,"optOut":false}'; notify(consent.value); resolve(null); await settle();
    expect(consent.history).toEqual([]);
    const explicit = harness({ read: async () => null, write: async () => {}, consent });
    explicit.client.optOut(true); await explicit.start(); expect(consent.history).toEqual(['{"version":1,"optOut":true}']);
  });

  it('applies consent written by other instances at once; only explicit calls write the consent record', async () => {
    const consent = new MemoryStorage(); let notify!: (value: string | null) => void;
    const h = harness({ read: async () => null, write: async () => {}, consent, watch: callback => { notify = callback; } });
    await h.start({ maxBatchSize: 1000 }); h.client.track('queued'); await settle();
    consent.value = '{"version":1,"optOut":true}'; notify(consent.value); await h.client.flush();
    expect(h.requests).toHaveLength(0); h.client.track('while-out'); await h.client.flush(); expect(h.requests).toHaveLength(0);
    notify(null); h.client.track('still-out'); await h.client.flush(); expect(h.requests).toHaveLength(0);
    notify('{"version":1,"optOut":false}'); h.client.track('enabled-elsewhere'); await h.client.flush();
    expect(h.signals().map(s => s.type)).toEqual(['enabled-elsewhere']);
    expect(consent.history).toEqual([]);
    h.client.optOut(true); await settle(); expect(JSON.parse(consent.value!)).toEqual({ version: 1, optOut: true });
  });

  it('enforces age inclusively on reload and before every send, capped at 30 days', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start(); h.client.track('boundary'); await settle();
    vi.clearAllTimers(); vi.setSystemTime(Date.now() + 7 * 86400000);
    const next = harness(store); await next.start(); await next.client.flush(); expect(next.signals()).toHaveLength(1);
    const stale = harness(); await stale.start({ maxQueueAgeDays: 0.01 }); stale.client.track('stale');
    vi.setSystemTime(Date.now() + 864001); await stale.client.flush(); expect(stale.requests).toHaveLength(0);
    const capped = harness(); await capped.start({ maxQueueAgeDays: 31 }); capped.client.track('cap-default'); await settle();
    vi.setSystemTime(Date.now() + 8 * 86400000); await capped.client.flush(); expect(capped.requests).toHaveLength(0);
  });

  it('uses memory fallback when storage reads or writes fail', async () => {
    const broken = { read: vi.fn(async () => { throw new Error('storage denied'); }), write: vi.fn(async () => { throw new Error('quota'); }) };
    const store = resilientStorage(broken); const h = harness(store); await h.start(); h.client.track('memory'); await h.client.flush();
    expect(h.signals()[0]!.type).toBe('memory'); expect(broken.read).toHaveBeenCalledTimes(1); expect(broken.write).not.toHaveBeenCalled();
    const quota = resilientStorage({ read: async () => null, write: async () => { throw new Error('quota'); } });
    await quota.write('latest'); expect(await quota.read()).toBe('latest');
  });

  it('keeps request bodies within 1 MiB and never exceeds the 1000-signal server limit', async () => {
    const h = harness(); await h.start({ maxBatchSize: 1000, maxQueueSize: 1500, gzip: false });
    for (let i = 0; i < 1100; i++) h.client.track(String(i), { props: { payload: 'x'.repeat(8000) } });
    await h.client.flush(); expect(h.requests.flatMap((_, i) => h.signals(i))).toHaveLength(1100);
    for (let i = 0; i < h.requests.length; i++) { expect(h.requests[i]!.body.byteLength).toBeLessThanOrEqual(1048576); expect(h.signals(i).length).toBeLessThanOrEqual(1000); }
  });
});

describe('retry and server policy', () => {
  it.each([false, true])('restores the exact pending retry bytes after reload with gzip=%s', async gzip => {
    const store = new MemoryStorage(); const h = harness(store); await h.start({ gzip, maxBatchSize: 2 });
    h.responses.push({ status: 500 });
    h.client.track('first', { props: { payload: 'x'.repeat(3000) } }); h.client.track('second'); await h.client.flush();
    const original = h.requests[0]!; vi.clearAllTimers();
    const reloaded = harness(store); await reloaded.start({ gzip, maxBatchSize: 100 }); reloaded.client.track('after-reload'); await reloaded.client.flush();
    expect(reloaded.requests[0]!.body).toEqual(original.body); expect(reloaded.requests[0]!.gzip).toBe(original.gzip);
    expect(reloaded.signals(0).map(s => s.type)).toEqual(['first', 'second']);
    expect(reloaded.signals(1).map(s => s.type)).toEqual(['after-reload']);
  });

  // A restored half that is rejected again keeps splitting.
  it('restores split boundaries across reload without recombining, then keeps splitting a rejected half', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start();
    h.responses.push({ status: 400 }, { status: 500 });
    for (const type of ['a', 'b', 'c', 'd']) h.client.track(type); await h.client.flush(); vi.clearAllTimers();
    const next = harness(store); await next.start(); next.responses.push({ status: 400 }, { status: 400 }, { status: 202 }); await next.client.flush();
    expect(next.requests[0]!.body).toEqual(h.requests[1]!.body); expect(next.requests).toHaveLength(4);
    expect([1, 2, 3].map(i => next.signals(i).map(s => s.type))).toEqual([['a'], ['b'], ['c', 'd']]);
  });

  it.each([500, 503, 429, 'network'])('retries %s with identical bytes, order and content', async failure => {
    const h = harness(); await h.start(); h.responses.push(failure === 'network' ? new Error('offline') : { status: Number(failure) }, { status: 202 });
    h.client.track('one', { props: { text: 'compress'.repeat(500) } }); h.client.track('two'); await h.client.flush();
    const initial = h.requests[0]!.body; h.client.track('later');
    await vi.advanceTimersByTimeAsync(1249); expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(3); expect(h.requests[1]!.body).toEqual(initial);
    expect(h.signals(1).map(s => s.type)).toEqual(['one', 'two']); expect(h.signals(2)[0]!.type).toBe('later');
  });

  it.each(['10', 'Fri, 13 Nov 2026 08:00:10 GMT'])('honors Retry-After %s and explicit flush cannot bypass it', async retryAfter => {
    const h = harness(); await h.start(); h.responses.push({ status: 429, retryAfter }); h.client.track('rate'); await h.client.flush();
    await h.client.flush(); await vi.advanceTimersByTimeAsync(9999); expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(2);
  });

  it('uses exponential backoff with jitter, bounded at 5 minutes', async () => {
    const h = harness(); await h.start(); for (let i = 0; i < 12; i++) h.responses.push({ status: 500 });
    h.client.track('retry'); await h.client.flush();
    for (const delay of [1250, 2500, 5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]) {
      const count = h.requests.length; await vi.advanceTimersByTimeAsync(delay - 1); expect(h.requests).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(count + 1);
    }
  });

  // Halves keep splitting until single bad signals are isolated; valid halves are sent once.
  it.each([400, 413])('splits %s until single bad signals are isolated and sends valid halves once', async status => {
    const h = harness(); await h.start({ gzip: false }); h.responses.push({ status }, { status }, { status }, { status: 202 });
    for (const type of ['one', 'two', 'three', 'four']) h.client.track(type); await h.client.flush();
    expect(h.requests.map((_, i) => h.signals(i).map(s => s.type))).toEqual([['one', 'two', 'three', 'four'], ['one', 'two'], ['one'], ['two'], ['three', 'four']]);
    await h.client.flush(); await vi.advanceTimersByTimeAsync(3600000); expect(h.requests).toHaveLength(5);
  });

  it.each([[16, 5], [100, 99], [7, 0]])('isolates one bad signal among %i within 2*log2(n) extra requests', async (count, bad) => {
    const h = harness(); const delivered: string[] = []; let sent = 0;
    h.platform.transport = () => ({
      async send(body) {
        sent++; const types = (JSON.parse(new TextDecoder().decode(body)) as Signal[]).map(s => s.type);
        if (types.includes(`s${bad}`)) return { status: 400 };
        delivered.push(...types); return { status: 202 };
      }, cancel() {},
    });
    await h.start({ gzip: false, maxBatchSize: 1000 }); for (let i = 0; i < count; i++) h.client.track(`s${i}`); await h.client.flush();
    expect(delivered.sort()).toEqual(Array.from({ length: count }, (_, i) => `s${i}`).filter(t => t !== `s${bad}`).sort());
    expect(sent - 1).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(count)));
  });

  it('retries a gzip 413 uncompressed with the same JSON before splitting', async () => {
    const h = harness(); await h.start(); h.responses.push({ status: 413 }, { status: 413 }, { status: 202 }, { status: 202 });
    h.client.track('a', { props: { text: 'x'.repeat(2000) } }); h.client.track('b', { props: { text: 'y'.repeat(2000) } }); await h.client.flush();
    expect(h.requests.map(r => r.gzip)).toEqual([true, false, true, true]);
    expect(h.signals(1)).toEqual(h.signals(0)); expect(h.signals(2).map(s => s.type)).toEqual(['a']);
    h.client.track('later', { props: { text: 'z'.repeat(2000) } }); await h.client.flush(); expect(h.requests[4]!.gzip).toBe(true);
  });

  it('never retries a single invalid signal', async () => {
    const h = harness(); await h.start(); h.responses.push({ status: 400 }); h.client.track('invalid'); await h.client.flush();
    await vi.advanceTimersByTimeAsync(3600000); expect(h.requests).toHaveLength(1);
  });

  // 408, 425 and unknown 4xx keep the batch and back off instead of deleting data.
  it.each([408, 425, 403, 404, 409, 422, 451, 302])('keeps the batch on %i and retries the same bytes with backoff', async status => {
    const store = new MemoryStorage(); const h = harness(store); await h.start(); h.responses.push({ status }, { status: 202 });
    h.client.track('kept', { props: { text: 'x'.repeat(2000) } }); await h.client.flush();
    expect(JSON.parse(store.value!).queue).toHaveLength(1); expect(JSON.parse(store.value!).batches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1249); expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(2); expect(h.requests[1]!.body).toEqual(h.requests[0]!.body);
    expect(JSON.parse(store.value!).queue).toEqual([]);
  });

  it('shrinks a batch after repeated 408 body-read timeouts', async () => {
    const h = harness(); await h.start({ gzip: false }); h.responses.push({ status: 408 }, { status: 408 });
    for (const type of ['a', 'b', 'c', 'd']) h.client.track(type); await h.client.flush();
    await vi.advanceTimersByTimeAsync(1250); expect(h.requests).toHaveLength(2); expect(h.requests[1]!.body).toEqual(h.requests[0]!.body);
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.requests.slice(2).map((_, i) => h.signals(i + 2).map(s => s.type))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('caps Retry-After at one hour', async () => {
    const h = harness(); await h.start(); h.responses.push({ status: 503, retryAfter: '86400' }); h.client.track('capped'); await h.client.flush();
    await vi.advanceTimersByTimeAsync(3599999); expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(2);
    const dated = harness(); await dated.start(); dated.responses.push({ status: 429, retryAfter: 'Sat, 14 Nov 2026 08:00:00 GMT' });
    dated.client.track('capped-date'); await dated.client.flush(); await vi.advanceTimersByTimeAsync(3600000); expect(dated.requests).toHaveLength(2);
  });

  it('401 stops all sends until reload and preserves the queue', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start(); h.responses.push({ status: 401 });
    h.client.track('saved'); await h.client.flush(); h.client.track('also-saved'); h.client.init('another-key');
    await h.client.flush(); await vi.advanceTimersByTimeAsync(3600000); expect(h.requests).toHaveLength(1);
    const next = harness(store); await next.start(); await next.client.flush(); expect(next.requests.flatMap((_, i) => next.signals(i))).toHaveLength(2);
  });

  it('gzip decompresses to exact JSON and 415 permanently switches to uncompressed until reload', async () => {
    const h = harness(); await h.start(); h.responses.push({ status: 415 }, { status: 202 });
    h.client.track('gzip', { props: { text: 'x'.repeat(2000) } }); await h.client.flush();
    expect(h.requests[0]!.gzip).toBe(true); expect(h.requests[1]!.gzip).toBe(false);
    expect(h.signals(0)).toEqual(h.signals(1));
    h.client.track('plain', { props: { text: 'x'.repeat(2000) } }); await h.client.flush(); expect(h.requests[2]!.gzip).toBe(false);
  });

  it('falls back to uncompressed when compression is absent or fails and skips small bodies', async () => {
    const h = harness(); h.platform.environment.gzip = vi.fn(async () => { throw new Error('no gzip'); }); await h.start();
    h.client.track('small'); await h.client.flush(); expect(h.platform.environment.gzip).not.toHaveBeenCalled();
    h.client.track('big', { props: { text: 'x'.repeat(2000) } }); await h.client.flush(); expect(h.requests[1]!.gzip).toBe(false);
  });

  it('honors interval and pause on success, including count and explicit flush triggers', async () => {
    const h = harness(); await h.start({ maxBatchSize: 2 });
    h.responses.push({ status: 202, body: '{"recommendedSendIntervalSeconds":30,"pause":true,"error":null}' },
      { status: 202, body: '{"recommendedSendIntervalSeconds":5,"pause":false,"error":null}' });
    h.client.track('initial'); await h.client.flush(); h.client.track('one'); h.client.track('two'); await h.client.flush();
    await vi.advanceTimersByTimeAsync(29999); expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(2);
    h.client.track('interval'); await vi.advanceTimersByTimeAsync(4999); expect(h.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(3);
  });

  it.each(['', 'nonsense', 'null', '[]', '{"recommendedSendIntervalSeconds":4,"pause":1}', '{"recommendedSendIntervalSeconds":"20","pause":"true"}', '{"other":5}'])('ignores empty, unknown or invalid policy: %s', body => {
    const p = new ServerPolicy(); p.apply(body, Date.now()); expect(p.intervalSeconds).toBeUndefined(); expect(p.pauseUntil).toBe(0);
  });

  it('accepts inclusive policy boundaries and independent valid fields', () => {
    const p = new ServerPolicy(); p.apply('{"recommendedSendIntervalSeconds":3600,"pause":true,"error":null}', 1000);
    expect(p.intervalSeconds).toBe(3600); expect(p.pauseUntil).toBe(3601000);
    p.apply('{"recommendedSendIntervalSeconds":5,"pause":false,"error":null}', 2000); expect(p.intervalSeconds).toBe(5); expect(p.pauseUntil).toBe(0);
  });

  it('applies the exact normal server response to subsequent timer sends', async () => {
    const h = harness(); await h.start({ flushIntervalSeconds: 1 });
    h.responses.push({ status: 202, body: '{"recommendedSendIntervalSeconds":20,"pause":false,"error":null}' });
    h.client.track('initial'); await h.client.flush(); h.client.track('normal');
    await vi.advanceTimersByTimeAsync(19999); expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(2);
  });

  it.each([2, 100])('keeps queueing within capacity while paused and resumes at the original deadline with batch size %s', async maxBatchSize => {
    const store = new MemoryStorage(); const h = harness(store); await h.start({ maxBatchSize, maxQueueSize: 3 });
    h.responses.push({ status: 202, body: '{"recommendedSendIntervalSeconds":300,"pause":true,"error":null}' });
    h.client.track('initial'); await h.client.flush();
    for (let i = 0; i < 5; i++) h.client.track(String(i));
    await vi.advanceTimersByTimeAsync(100000); await h.client.flush(); h.hide(); await settle();
    expect(h.requests).toHaveLength(1); expect(JSON.parse(store.value!).queue.map((s: Signal) => s.type)).toEqual(['2', '3', '4']);
    await vi.advanceTimersByTimeAsync(199999); expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.requests.flatMap((_, i) => i ? h.signals(i).map(s => s.type) : [])).toEqual(['2', '3', '4']);
  });

  it('expires queued signals normally while the server pause is active', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start({ maxQueueAgeDays: 1 / 86400 });
    h.responses.push({ status: 202, body: '{"recommendedSendIntervalSeconds":5,"pause":true,"error":null}' });
    h.client.track('initial'); await h.client.flush(); h.client.track('expires');
    await vi.advanceTimersByTimeAsync(5000); expect(h.requests).toHaveLength(1); expect(JSON.parse(store.value!).queue).toEqual([]);
  });

  it.each([429, 503])('honors the longer busy hint and Retry-After on %s without changing retry bytes', async status => {
    for (const [retryAfter, delay] of [['10', 30000], ['45', 45000], ['Fri, 13 Nov 2026 08:00:45 GMT', 45000]] as const) {
      vi.setSystemTime(new Date('2026-11-13T08:00:00Z'));
      const h = harness(); await h.start();
      h.responses.push({ status, retryAfter, body: '{"recommendedSendIntervalSeconds":30,"pause":false,"error":null}' });
      h.client.track('busy'); await h.client.flush(); await h.client.flush(); h.hide(); await settle();
      await vi.advanceTimersByTimeAsync(delay - 1); expect(h.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1); expect(h.requests).toHaveLength(2);
      expect(h.requests[1]!.body).toEqual(h.requests[0]!.body);
    }
  });

  it.each([4, 3601, null, '20'])('ignores invalid recommended interval %j without clearing an existing pause', recommendedSendIntervalSeconds => {
    const p = new ServerPolicy(); p.apply('{"recommendedSendIntervalSeconds":20,"pause":true}', 1000);
    p.apply(JSON.stringify({ recommendedSendIntervalSeconds, pause: 'false', error: 'ignored' }), 2000);
    expect(p.intervalSeconds).toBe(20); expect(p.pauseUntil).toBe(21000);
  });

  it('uses the last valid interval or bounded configured fallback when pause has no valid recommendation', () => {
    const p = new ServerPolicy(); p.apply('{"pause":true}', 1000); expect(p.pauseUntil).toBe(21000);
    p.apply('{"recommendedSendIntervalSeconds":30,"pause":false}', 2000);
    p.apply('{"recommendedSendIntervalSeconds":0,"pause":true}', 3000); expect(p.pauseUntil).toBe(33000);
    const fallback = new ServerPolicy(); fallback.apply('{"pause":true}', 1000, 1); expect(fallback.pauseUntil).toBe(6000);
    fallback.apply('{"pause":true}', 1000, 7200); expect(fallback.pauseUntil).toBe(3601000);
  });

  it('accepts unknown fields and empty bodies without resetting active policy; error is informational', () => {
    const p = new ServerPolicy(); p.apply('{"recommendedSendIntervalSeconds":20,"pause":true,"error":null,"future":true}', 1000);
    for (const body of [undefined, '', '{}', '{"future":5}', '{"error":"validation_failed"}']) p.apply(body, 2000);
    expect(p.intervalSeconds).toBe(20); expect(p.pauseUntil).toBe(21000);
    p.apply('{"recommendedSendIntervalSeconds":5,"pause":null}', 3000);
    expect(p.intervalSeconds).toBe(5); expect(p.pauseUntil).toBe(21000);
    p.apply('{"pause":false}', 4000); expect(p.pauseUntil).toBe(0);
  });
});

describe('lifecycle, consent and public failures', () => {
  it('keeps retry bytes identical when a lifecycle request follows a failed compressed send', async () => {
    const h = harness(); await h.start(); h.responses.push({ status: 500 });
    h.client.track('compressed', { props: { data: 'x'.repeat(3000) } }); await h.client.flush();
    vi.setSystemTime(Date.now() + 1250); h.hide(); await h.client.flush();
    expect(h.requests[1]!.keepalive).toBe(true); expect(h.requests[1]!.gzip).toBe(true);
    expect(h.requests[1]!.body).toEqual(h.requests[0]!.body);
  });

  it('keeps retry bytes identical after the first send used keepalive without compression', async () => {
    const h = harness(); await h.start(); h.responses.push({ status: 500 });
    h.client.track('plain', { props: { data: 'x'.repeat(3000) } }); h.hide(); await h.client.flush();
    await vi.advanceTimersByTimeAsync(1250); expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.body).toEqual(h.requests[0]!.body); expect(h.requests[1]!.gzip).toBe(false);
  });

  it('skips oversized existing keepalive work and leaves it durably queued for normal sending', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start({ gzip: false }); h.responses.push({ status: 500 });
    for (let i = 0; i < 12; i++) h.client.track(String(i), { props: { data: 'x'.repeat(8000) } }); await h.client.flush();
    vi.setSystemTime(Date.now() + 1250); h.hide(); await h.client.flush(); expect(h.requests).toHaveLength(1);
    expect(JSON.parse(store.value!).queue).toHaveLength(12); await h.client.flush(); expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.body).toEqual(h.requests[0]!.body);
  });

  // Eviction drops one signal and the batch's prepared bytes, never the batch's other signals.
  it('evicts only the oldest signal of a pending retry and resends the survivors as a new batch', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start({ maxQueueSize: 3, maxBatchSize: 2 }); h.responses.push({ status: 500 });
    h.client.track('a'); h.client.track('b'); await h.client.flush(); h.client.track('c'); h.client.track('d'); await settle();
    expect(JSON.parse(store.value!)).toMatchObject({ batches: [] }); expect(JSON.parse(store.value!).queue.map((s: Signal) => s.type)).toEqual(['b', 'c', 'd']);
    await vi.advanceTimersByTimeAsync(1250); expect(h.requests).toHaveLength(3);
    expect(h.signals(1).map(s => s.type)).toEqual(['b', 'c']); expect(h.signals(2).map(s => s.type)).toEqual(['d']);
  });

  it('keeps later prepared batches restorable after a partial eviction of an earlier one', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start({ maxQueueSize: 5, gzip: false });
    h.responses.push({ status: 400 }, { status: 500 });
    for (const type of ['a', 'b', 'c', 'd']) h.client.track(type); await h.client.flush();
    h.client.track('e'); h.client.track('f'); await settle();
    const saved = JSON.parse(store.value!); expect(saved.queue.map((s: Signal) => s.type)).toEqual(['c', 'd', 'b', 'e', 'f']);
    expect(saved.batches).toEqual([{ indices: [0, 1] }]);
    vi.clearAllTimers(); const next = harness(store); await next.start({ gzip: false }); await next.client.flush();
    expect(next.requests.map((_, i) => next.signals(i).map(s => s.type))).toEqual([['c', 'd'], ['b', 'e', 'f']]);
  });

  it('retains later split batches if an active older batch is evicted while sending', async () => {
    const h = harness(); const sent: string[][] = []; let release!: () => void;
    h.platform.transport = () => ({
      async send(bytes) {
        sent.push((JSON.parse(new TextDecoder().decode(bytes)) as Signal[]).map(s => s.type));
        if (sent.length === 1) return { status: 400 };
        if (sent.length === 2) await new Promise<void>(resolve => { release = resolve; });
        return { status: 202 };
      }, cancel() {},
    });
    await h.start({ maxQueueSize: 4, gzip: false }); for (const type of ['a', 'b', 'c', 'd']) h.client.track(type);
    const sending = h.client.flush(); await settle(); h.client.track('e'); release(); await sending;
    expect(sent).toEqual([['a', 'b', 'c', 'd'], ['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('waits for durable writes before sending and serializes writes made during an active write', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const store = new MemoryStorage(); let first = true;
    const h = harness({ read: store.read.bind(store), async write(value) { if (first) { first = false; await gate; } await store.write(value); } });
    h.client.init('key'); h.client.track('one'); await settle(); h.client.track('two'); const sending = h.client.flush();
    await settle(); expect(h.requests).toHaveLength(0); release(); await sending;
    expect(h.signals().map(s => s.type)).toEqual(['one', 'two']);
    expect(store.history.some(s => JSON.parse(s).batches.length === 1 && JSON.parse(s).queue.length === 2)).toBe(true);
    expect(JSON.parse(store.value!).queue).toEqual([]);
  });

  it('honors saved opt-out even if queue records are corrupt and survives cancellation failures', async () => {
    const store = new MemoryStorage(); store.value = '{"version":1,"optOut":true,"queue":null}';
    const h = harness(store); h.platform.transport = () => ({ async send() { throw new Error('must not send'); }, cancel() { throw new Error('unsupported'); } });
    h.client.init('key'); await h.client.setUser('private'); h.client.track('discarded'); await h.client.flush();
    expect(JSON.parse(store.value!).optOut).toBe(true); h.client.optOut(false); h.client.track('clear-me');
    expect(() => h.client.optOut(true)).not.toThrow(); await h.client.flush();
    expect(JSON.parse(store.value!)).toMatchObject({ optOut: true, queue: [] });
  });

  it.each([null, {}, [{ indices: [-1], split: false }], [{ indices: [0, 0], split: false }], [{ indices: [0], split: false, gzip: true, body: [0] }],
    [{ indices: [0], split: false, gzip: true, body: [31, 139, 256] }]])('discards corrupt stored batch metadata: %j', async batches => {
    const store = new MemoryStorage(); const first = harness(store); await first.start(); first.client.track('retained'); await settle();
    store.value = JSON.stringify({ ...JSON.parse(store.value!), batches }); vi.clearAllTimers();
    const h = harness(store); await h.start(); await h.client.flush(); expect(h.signals()[0]!.type).toBe('retained');
  });

  it('flushes on hidden via authenticated uncompressed keepalive, at most 64 KiB', async () => {
    const h = harness(); await h.start({ maxBatchSize: 1000 });
    for (let i = 0; i < 20; i++) h.client.track(String(i), { props: { text: 'x'.repeat(8000) } });
    h.hide(); h.hide(); await settle();
    expect(h.requests).toHaveLength(1); expect(h.requests[0]!.keepalive).toBe(true); expect(h.requests[0]!.gzip).toBe(false);
    expect(h.requests[0]!.body.byteLength).toBeLessThanOrEqual(65536); expect(h.signals().length).toBeGreaterThan(0);
    await h.client.flush(); expect(h.requests.flatMap((_, i) => h.signals(i))).toHaveLength(20);
  });

  it('serializes overlapping flush calls and tracks during an active send', async () => {
    const h = harness(); let release!: () => void;
    const send = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 202 }; });
    h.platform.transport = () => ({ send, cancel() {} }); await h.start(); h.client.track('one');
    const first = h.client.flush(); const second = h.client.flush(); await settle(); expect(send).toHaveBeenCalledTimes(1);
    h.client.track('two'); release(); await settle(); expect(send).toHaveBeenCalledTimes(2); release(); await Promise.all([first, second]);
  });

  it('persists opt-out, clears pending and durable data, and does not collect or send until enabled', async () => {
    const store = new MemoryStorage(); const h = harness(store); h.client.track('before'); h.client.optOut(true); await h.start();
    h.client.track('disabled'); await h.client.setUser('private'); await h.client.flush(); expect(h.requests).toHaveLength(0);
    expect(JSON.parse(store.value!)).toEqual({ version: 1, optOut: true, queue: [], batches: [] });
    const next = harness(store); await next.start(); next.client.track('still-disabled'); await next.client.flush(); expect(next.requests).toHaveLength(0);
    next.client.optOut(false); next.client.track('enabled'); await next.client.flush(); expect(next.signals()[0]!.type).toBe('enabled');
    expect(next.signals()[0]).not.toHaveProperty('userHash');
  });

  it('cancels active transport and prevents later batches after opt-out', async () => {
    const h = harness(); let release!: () => void; const cancel = vi.fn();
    const send = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 202 }; });
    h.platform.transport = () => ({ send, cancel }); await h.start({ maxBatchSize: 1 });
    h.client.track('one'); h.client.track('two'); const flushing = h.client.flush(); await settle();
    h.client.optOut(true); release(); await flushing; expect(cancel).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
  });

  it('public calls never throw or reject for malformed runtime inputs or unavailable capabilities', async () => {
    const h = harness(); const bad = new Proxy({}, { get() { throw new Error('getter'); } });
    expect(() => h.client.init('key', bad)).not.toThrow(); expect(() => h.client.track(null as never)).not.toThrow();
    expect(() => h.client.track('bad', bad)).not.toThrow(); expect(() => h.client.optOut(null as never)).not.toThrow();
    await expect(h.client.setUser({} as never)).resolves.toBeUndefined(); await expect(h.client.flush()).resolves.toBeUndefined();
    h.platform.environment.hashUser = async () => { throw new Error('crypto denied'); }; await h.start();
    await expect(h.client.setUser('user')).resolves.toBeUndefined();
    h.platform.environment.info = () => { throw new Error('denied'); }; expect(() => h.client.track('safe')).not.toThrow();
    await expect(h.client.flush()).resolves.toBeUndefined();
    const broken = createPulse({ ...h.platform, storage() { throw new Error('storage factory'); } });
    expect(() => broken.init('key')).not.toThrow(); await expect(broken.flush()).resolves.toBeUndefined();
  });

  it.each([{ host: 'file:///private' }, { host: 'https://user:pass@example.invalid' }, { host: 'https://example.invalid/?key=secret' }])('rejects invalid hosts: %j', async (options: PulseOptions) => {
    const h = harness(); h.client.init('key', options); h.client.track('safe'); await h.client.flush(); expect(h.requests).toHaveLength(0);
  });
});

describe('input limits, adoption and storage failures', () => {
  it('replaces lone surrogates with U+FFFD in type, prop keys and values before size checks', async () => {
    const h = harness(); await h.start({ gzip: false });
    h.client.track('a\uD800b\uDC00c😀', { props: { ['k\uDBFF']: 'v\uDFFF', pair: '😀' } });
    // As JSON escapes, 2728 lone surrogates take 6 bytes each; as U+FFFD they take 3, and {"x":...} is exactly 8192 bytes.
    h.client.track('sized', { props: { x: '\uD800'.repeat(2728) } });
    h.client.track('\uD800'.repeat(200)); h.client.track('\uD800'.repeat(201));
    await h.client.flush();
    const sent = h.signals();
    expect(sent.map(s => s.type)).toEqual(['a�b�c😀', 'sized', '�'.repeat(200)]);
    expect(sent[0]!.props).toEqual({ ['k�']: 'v�', pair: '😀' });
    expect(sent[1]!.props.x).toBe('�'.repeat(2728));
    expect(new TextDecoder('utf-8', { fatal: true }).decode(h.requests[0]!.body)).not.toMatch(/\\ud[89ab]/i);
  });

  it('caps queue age at 29 days even when 30 is configured', async () => {
    const store = new MemoryStorage(); const h = harness(store); await h.start({ maxQueueAgeDays: 30 }); h.client.track('old'); await settle();
    vi.clearAllTimers(); vi.setSystemTime(new Date('2026-12-12T08:00:00.000Z'));
    const kept = harness(store); await kept.start({ maxQueueAgeDays: 30 }); expect(JSON.parse(store.value!).queue).toHaveLength(1);
    vi.clearAllTimers(); vi.setSystemTime(new Date('2026-12-12T08:00:00.001Z'));
    const next = harness(store); await next.start({ maxQueueAgeDays: 30 }); await next.client.flush(); expect(next.requests).toHaveLength(0);
  });

  it('makes one keepalive attempt on page hide while a normal send is in flight, never resending the in-flight batch', async () => {
    const h = harness(); const sent: { types: string[]; keepalive: boolean }[] = []; let release!: () => void;
    h.platform.transport = () => ({
      async send(body, _gzip, keepalive) {
        sent.push({ types: (JSON.parse(new TextDecoder().decode(body)) as Signal[]).map(s => s.type), keepalive });
        if (sent.length === 1) await new Promise<void>(resolve => { release = resolve; });
        return { status: 202 };
      }, cancel() {},
    });
    await h.start({ gzip: false, maxBatchSize: 2 }); h.client.track('a'); h.client.track('b');
    const sending = h.client.flush(); await settle(); h.client.track('c'); h.client.track('d'); h.client.track('e');
    h.hide(); h.hide(); await settle();
    expect(sent).toEqual([{ types: ['a', 'b'], keepalive: false }, { types: ['c', 'd'], keepalive: true }]);
    release(); await sending; await h.client.flush();
    expect(sent.slice(2)).toEqual([{ types: ['e'], keepalive: false }]);
  });

  it('drops only the signals of the stored record another instance adopted', async () => {
    let lost = false; const store = new MemoryStorage();
    const h = harness({ read: () => store.read(), async write(value) { if (lost) { lost = false; return false; } await store.write(value); } });
    await h.start({ maxBatchSize: 1000 }); h.client.track('adopted'); await settle();
    lost = true; h.client.track('also-adopted'); await settle(); h.client.track('mine'); await h.client.flush();
    // Only the last stored record was adopted; the signal tracked after it stays with this instance.
    expect(h.signals().map(s => s.type)).toEqual(['also-adopted', 'mine']);
    expect(JSON.parse(store.value!).queue).toEqual([]);
  });

  it('adopts claimed queues with their prepared bytes, removes them only after a durable save, and deletes them when opted out', async () => {
    const donor = new MemoryStorage(); const first = harness(donor); await first.start({ gzip: false, maxBatchSize: 1 });
    first.responses.push({ status: 500 }); first.client.track('orphan-1'); first.client.track('orphan-2'); await first.client.flush(); vi.clearAllTimers();
    const own = new MemoryStorage(); const events: string[] = [];
    const storage = {
      read: () => own.read(), write: async (value: string) => { events.push('write'); await own.write(value); },
      claim: async () => ({ values: [donor.value!, '{broken'], done: () => { events.push('done'); } }),
      consent: { read: async () => null, write: async () => {} },
    };
    const h = harness(storage); await h.start({ gzip: false }); expect(events.slice(0, 2)).toEqual(['write', 'done']);
    expect(JSON.parse(own.value!).queue.map((s: Signal) => s.type)).toEqual(['orphan-1', 'orphan-2']);
    await h.client.flush(); expect(h.requests[0]!.body).toEqual(first.requests[0]!.body);
    expect(h.requests.flatMap((_, i) => h.signals(i).map(s => s.type))).toEqual(['orphan-1', 'orphan-2']);
    vi.clearAllTimers(); const quiet = harness({ ...storage, consent: { read: async () => '{"version":1,"optOut":true}', write: async () => {} } });
    events.length = 0; await quiet.start(); await quiet.client.flush();
    expect(quiet.requests).toHaveLength(0); expect(events).toContain('done'); expect(JSON.parse(own.value!).queue).toEqual([]);
  });

  it('writes the tiny consent record even when queue writes keep failing, and retries queue writes', async () => {
    const consent = new MemoryStorage(); let fail = true; const writes: string[] = [];
    const store = resilientStorage({ read: async () => null, async write(value) { writes.push(value); if (fail) throw new Error('quota'); }, consent });
    const h = harness(store); await h.start({ maxBatchSize: 1000 });
    h.client.track('one'); await settle(); h.client.optOut(true); await settle();
    expect(JSON.parse(consent.value!)).toEqual({ version: 1, optOut: true });
    fail = false; h.client.optOut(false); h.client.track('two'); await settle();
    expect(JSON.parse(writes.at(-1)!).queue.map((s: Signal) => s.type)).toEqual(['two']); expect(writes.length).toBeGreaterThan(3);
  });
});
