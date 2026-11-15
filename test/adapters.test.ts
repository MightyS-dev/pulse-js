import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserInfo, browserPlatform, LEASE } from '../src/adapters/browser.js';
import { fileStorage, instanceStorage, nodePlatform } from '../src/adapters/node.js';
import { fetchTransport } from '../src/adapters/shared.js';
import { createPulse } from '../src/core.js';
import type { Signal } from '../src/types.js';
import { settle } from './helpers.js';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request in offline tests.'); })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function browser() {
  const values = new Map<string, string>();
  const methods = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  // Like real localStorage, Object.keys lists the stored keys and not the methods.
  const localStorage = new Proxy(methods, {
    ownKeys: () => [...values.keys()],
    getOwnPropertyDescriptor: (_target, key) => typeof key === 'string' && values.has(key)
      ? { value: values.get(key), enumerable: true, configurable: true, writable: true } : undefined,
  });
  const doc = new EventTarget(); Object.defineProperty(doc, 'visibilityState', { value: 'visible', writable: true });
  const page = new EventTarget();
  const requests: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('navigator', { language: 'sr-RS', userAgentData: { platform: 'Windows' }, sendBeacon: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init }); return new Response('', { status: 202 });
  }));
  const platform = browserPlatform(); const client = createPulse(platform);
  return { values, localStorage, doc, page, requests, platform, client };
}

describe('browser adapter', () => {
  it('uses the v1 route and public header without cookies, referrer or redirects', async () => {
    const h = browser(); h.client.init('synthetic-key'); h.client.track('web'); await h.client.flush();
    expect(h.requests[0]!.url).toBe('https://in.mightys.dev/api/v1/signals');
    expect(h.requests[0]!.init).toMatchObject({ method: 'POST', headers: { 'X-App-Key': 'synthetic-key', 'Content-Type': 'application/json' },
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', keepalive: false });
    expect(h.localStorage.setItem).toHaveBeenCalled();
    const signals = JSON.parse(new TextDecoder().decode(h.requests[0]!.init.body as Uint8Array)) as Signal[];
    expect(signals[0]!.system).toMatchObject({ platform: 'web', osName: 'Windows', osVersion: '', locale: 'sr-RS' });
    expect(signals[0]!.sessionId).toMatch(/^[a-f0-9]{32}$/);
  });

  it('connects visibilitychange and pagehide to authenticated, uncompressed keepalive fetch', async () => {
    const h = browser(); h.client.init('synthetic-key'); h.client.track('hidden', { props: { text: 'x'.repeat(4000) } }); await settle();
    Object.defineProperty(h.doc, 'visibilityState', { value: 'hidden' }); h.doc.dispatchEvent(new Event('visibilitychange'));
    await h.client.flush(); expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.init.keepalive).toBe(true); expect(h.requests[0]!.init.headers).not.toHaveProperty('Content-Encoding');
    h.client.track('pagehide'); h.page.dispatchEvent(new Event('pagehide')); await h.client.flush();
    expect(h.requests[1]!.init.keepalive).toBe(true);
    expect(navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it('ignores visible lifecycle events and respects saved opt-out after reload', async () => {
    const h = browser(); h.client.init('synthetic-key'); await settle(); h.doc.dispatchEvent(new Event('visibilitychange')); expect(h.requests).toHaveLength(0);
    h.client.optOut(true); await h.client.flush();
    const other = createPulse(browserPlatform()); other.init('synthetic-key'); other.track('disabled'); await other.flush();
    expect(h.requests).toHaveLength(0); expect(JSON.parse([...h.values.values()][0]!).optOut).toBe(true);
  });

  it('hashes UTF-8 user IDs with WebCrypto and compresses using CompressionStream', async () => {
    const h = browser(); h.client.init('synthetic-key'); await h.client.setUser('private-č😀');
    h.client.track('compressed', { props: { content: 'x'.repeat(4000) } }); await h.client.flush();
    expect(h.requests[0]!.init.headers).toHaveProperty('Content-Encoding', 'gzip');
    const json = gunzipSync(h.requests[0]!.init.body as Uint8Array).toString('utf8');
    const signal = (JSON.parse(json) as Signal[])[0]!;
    expect(signal.userHash).toBe(createHash('sha256').update('private-č😀').digest('hex'));
    expect(json).not.toContain('private-č😀'); expect([...h.values.values()].join('')).not.toContain('private-č😀');
  });

  it('falls back when browser compression, localStorage or crypto is unavailable', async () => {
    const h = browser(); vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('localStorage', { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } });
    const realCrypto = globalThis.crypto; vi.stubGlobal('crypto', { randomUUID: realCrypto.randomUUID.bind(realCrypto), subtle: undefined });
    h.client.init('synthetic-key'); await h.client.setUser('private'); h.client.track('fallback', { props: { data: 'x'.repeat(4000) } }); await h.client.flush();
    expect(h.requests).toHaveLength(1); expect(h.requests[0]!.init.headers).not.toHaveProperty('Content-Encoding');
    const signal = (JSON.parse(new TextDecoder().decode(h.requests[0]!.init.body as Uint8Array)) as Signal[])[0]!;
    expect(signal).not.toHaveProperty('userHash');
  });

  it('still creates ephemeral random sessions when WebCrypto is unavailable', async () => {
    const h = browser(); vi.stubGlobal('crypto', undefined); h.client.init('synthetic-key');
    await h.client.setUser('unhashable'); h.client.track('anonymous'); await h.client.flush();
    const signal = (JSON.parse(new TextDecoder().decode(h.requests[0]!.init.body as Uint8Array)) as Signal[])[0]!;
    expect(signal.sessionId).toMatch(/^[a-f0-9]{32}$/); expect(signal).not.toHaveProperty('userHash');
  });

  // Key layout: one consent key per application plus one queue key per page.
  it('namespaces durable queues and consent by application key', async () => {
    const h = browser(); h.client.init('key-one'); h.client.track('one'); await settle();
    const other = createPulse(browserPlatform()); other.init('key-two'); other.track('two'); await settle(); expect(h.requests).toHaveLength(0);
    expect([...h.values.keys()].map(k => k.replace(/[0-9a-f]{32}$/, 'ID'))).toEqual(['mightys-pulse:key-one:q:ID', 'mightys-pulse:key-two:q:ID']);
    h.client.optOut(true); other.optOut(true); await h.client.flush();
    expect(h.values.get('mightys-pulse:key-one')).toBe('{"version":1,"optOut":true}');
    expect(h.values.get('mightys-pulse:key-two')).toBe('{"version":1,"optOut":true}');
    expect([...h.values.keys()].some(k => k.includes(':q:'))).toBe(false);
  });

  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.1.2', 'Windows', ''],
    ['Mozilla/5.0 (Linux; Android 16; Model X) Chrome/144.0.1.2', 'Android', '16'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0_2 like Mac OS X)', 'iOS', '18'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1_2)', 'macOS', ''],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux', ''],
    ['Unknown UA', '', ''],
  ])('extracts only coarse OS information from %s', (userAgent, osName, osVersion) => {
    expect(browserInfo({ userAgent, language: 'en' } as Navigator)).toEqual({ platform: 'web', osName, osVersion, locale: 'en' });
  });

  it('uses low-entropy hints and never calls high-entropy APIs', () => {
    const getHighEntropyValues = vi.fn(() => { throw new Error('forbidden'); });
    const nav = { userAgent: 'private raw UA', userAgentData: { platform: 'Android', getHighEntropyValues }, language: 'en' };
    expect(browserInfo(nav as unknown as Navigator)).toEqual({ platform: 'web', osName: 'Android', osVersion: '', locale: 'en' });
    expect(getHighEntropyValues).not.toHaveBeenCalled(); expect(browserInfo(undefined).osName).toBe('');
  });
});

describe('browser tabs', () => {
  // Every tab gets its own window event target; localStorage is shared, as in a real browser.
  function tabs() {
    const shared = browser();
    const open = (key = 'synthetic-key') => {
      const page = new EventTarget();
      vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
      const client = createPulse(browserPlatform()); client.init(key);
      return { client, page };
    };
    const broadcast = (from: EventTarget, targets: EventTarget[], key: string) => {
      for (const target of targets) if (target !== from) target.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: shared.values.get(key) ?? null }));
    };
    const queues = () => [...shared.values].filter(([key]) => key.includes(':q:')).map(([, value]) =>
      (JSON.parse(value.slice(value.indexOf(' ') + 1)).queue as Signal[]).map(s => s.type));
    const sent = () => shared.requests.flatMap(r => (JSON.parse(new TextDecoder().decode(r.init.body as Uint8Array)) as Signal[]).map(s => s.type));
    return { ...shared, open, broadcast, queues, sent };
  }

  it('keeps one queue per tab, so concurrent tabs never erase or resend each other\'s signals', async () => {
    const t = tabs(); const a = t.open(); const b = t.open();
    a.client.track('a1'); b.client.track('b1'); a.client.track('a2'); await settle();
    expect(t.queues().sort()).toEqual([['a1', 'a2'], ['b1']]);
    const c = t.open(); await c.client.flush(); expect(t.requests).toHaveLength(0);
    await a.client.flush(); await b.client.flush(); expect(t.sent().sort()).toEqual(['a1', 'a2', 'b1']);
    expect(t.queues()).toEqual([]);
  });

  it('applies opt-out from another tab immediately and keeps it until an explicit optOut(false)', async () => {
    const t = tabs(); const a = t.open(); const b = t.open();
    b.client.track('queued-in-b'); await settle();
    a.client.optOut(true); await settle(); t.broadcast(a.page, [b.page], 'mightys-pulse:synthetic-key');
    await b.client.flush(); b.client.track('after'); await b.client.flush(); expect(t.requests).toHaveLength(0);
    expect(t.queues()).toEqual([]);
    const c = t.open(); c.client.track('new-tab'); await c.client.flush(); expect(t.requests).toHaveLength(0);
    expect(t.values.get('mightys-pulse:synthetic-key')).toBe('{"version":1,"optOut":true}');
    b.client.optOut(false); await settle(); t.broadcast(b.page, [a.page, c.page], 'mightys-pulse:synthetic-key');
    a.client.track('enabled'); await a.client.flush(); expect(t.sent()).toEqual(['enabled']);
  });

  it('treats an unreadable consent key as opted out', async () => {
    const t = tabs(); t.values.set('mightys-pulse:synthetic-key', '{"optOut":');
    const a = t.open(); a.client.track('blocked'); await a.client.flush(); expect(t.requests).toHaveLength(0);
    const b = t.open(); t.values.set('mightys-pulse:synthetic-key', '{"version":1,"optOut":false}');
    t.broadcast(new EventTarget(), [b.page], 'mightys-pulse:synthetic-key');
    t.values.set('mightys-pulse:synthetic-key', 'garbage'); t.broadcast(new EventTarget(), [b.page], 'mightys-pulse:synthetic-key');
    b.client.track('blocked-again'); await b.client.flush(); expect(t.requests).toHaveLength(0);
  });

  it('adopts the queue of a page that unloaded for good exactly once, and the old page stops at its next write', async () => {
    const t = tabs(); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const a = t.open(); a.client.track('orphan'); await a.client.flush();
    a.page.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false })); await settle();
    expect([...t.values.values()].find(v => v.includes('orphan'))).toMatch(/^0 /);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { t.requests.push({ url, init }); return new Response('', { status: 202 }); }));
    const b = t.open(); const c = t.open(); await b.client.flush(); await c.client.flush();
    expect(t.sent()).toEqual(['orphan']); expect(t.queues()).toEqual([]);
    // The old page learns at its next write that its record was adopted and keeps only the newer signal.
    a.client.track('late'); await settle(); expect(t.queues()).toEqual([['late']]); expect(t.sent()).toEqual(['orphan']);
  });

  it('leaves back/forward-cached and live pages alone until their two-hour lease lapses', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-13T08:00:00Z'), toFake: ['Date'] });
    const t = tabs(); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const a = t.open(); a.client.track('cached'); await a.client.flush();
    a.page.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true })); await settle();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { t.requests.push({ url, init }); return new Response('', { status: 202 }); }));
    const b = t.open(); await b.client.flush(); expect(t.requests).toHaveLength(0);
    vi.setSystemTime(Date.now() + LEASE);
    const c = t.open(); await c.client.flush(); expect(t.sent()).toEqual(['cached']);
  });

  it('retries a failed localStorage write on the next write instead of disabling persistence', async () => {
    const t = tabs(); let full = true;
    t.localStorage.setItem.mockImplementation((key: string, value: string) => { if (full && key.includes(':q:')) throw new Error('quota'); t.values.set(key, value); });
    const a = t.open(); a.client.track('one'); await settle(); expect(t.queues()).toEqual([]);
    a.client.optOut(true); await settle(); expect(t.values.get('mightys-pulse:synthetic-key')).toBe('{"version":1,"optOut":true}');
    a.client.optOut(false); full = false; a.client.track('two'); await settle(); expect(t.queues()).toEqual([['two']]);
  });
});

describe('fetch transport', () => {
  it('returns policy and Retry-After without using real HTTP', async () => {
    const body = '{"recommendedSendIntervalSeconds":30,"pause":false,"error":null}';
    const fetcher = vi.fn(async () => new Response(body, { status: 429, headers: { 'Retry-After': '10' } }));
    const transport = fetchTransport('synthetic', 'https://example.invalid', () => fetcher as unknown as typeof fetch);
    expect(await transport.send(new Uint8Array([91, 93]), false, false)).toEqual({ status: 429, body, retryAfter: '10' });
  });

  it('cancels an active request and bounds a stalled request to 12 seconds', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const transport = fetchTransport('synthetic', 'https://example.invalid', () => fetcher as unknown as typeof fetch);
    const sending = transport.send(new Uint8Array([91, 93]), false, false); const rejected = expect(sending).rejects.toThrow('aborted');
    transport.cancel(); await rejected; expect(vi.getTimerCount()).toBe(0);
    const stalled = transport.send(new Uint8Array([91, 93]), false, false); const timedOut = expect(stalled).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(12000); await timedOut; expect(vi.getTimerCount()).toBe(0);
  });

  it('scales the timeout with body size and cancels every active request', async () => {
    vi.useFakeTimers(); const aborted: number[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted.push((init.body as Uint8Array).byteLength); reject(new Error('aborted')); });
    }));
    const transport = fetchTransport('synthetic', 'https://example.invalid', () => fetcher as unknown as typeof fetch);
    const large = transport.send(new Uint8Array(1048576), false, false); const failed = expect(large).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(12000 + 32767); expect(aborted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await failed; expect(aborted).toEqual([1048576]);
    const normal = transport.send(new Uint8Array(10), false, false); const lifecycle = transport.send(new Uint8Array(20), false, true);
    const both = Promise.allSettled([normal, lifecycle]); transport.cancel(); await both; expect(aborted).toEqual([1048576, 10, 20]);
  });
});

describe('Node adapter and published entry points', () => {
  let directory = '';
  beforeEach(async () => { await mkdir('.test-storage', { recursive: true }); directory = await mkdtemp(resolve('.test-storage/case-')); });
  afterEach(async () => {
    const root = resolve('.test-storage') + sep;
    if (!resolve(directory).startsWith(root)) throw new Error('Unsafe test cleanup path.');
    await rm(directory, { recursive: true, force: true });
  });

  it('atomically saves new files, restores across instances, recovers corruption, and leaves no temporary files', async () => {
    const path = resolve(directory, 'queue.json'); const store = fileStorage(path);
    expect(await store.read()).toBeNull(); await store.write('first'); await store.write('second');
    expect(await fileStorage(path).read()).toBe('second'); expect(await readdir(directory)).toEqual(['queue.json']);
    await store.write('{corrupt');
    const platform = nodePlatform(); platform.storage = () => fileStorage(path);
    const fetcher = vi.fn(async () => new Response('', { status: 202 })); vi.stubGlobal('fetch', fetcher);
    const client = createPulse(platform); client.init('synthetic-key'); client.track('recovered'); await client.flush();
    expect(fetcher).toHaveBeenCalledTimes(1); expect(JSON.parse(await readFile(path, 'utf8')).queue).toEqual([]);
  });

  it('runs without window, uses node:crypto and node:zlib, and persists only hashed users', async () => {
    expect(typeof window).toBe('undefined'); const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { requests.push(init); return new Response('', { status: 202 }); }));
    const path = resolve(directory, 'queue.json'); const client = createPulse(nodePlatform());
    client.init('synthetic-key', { storagePath: path, appVersion: '2.0' }); await client.setUser('node-private');
    client.track('node', { props: { text: 'x'.repeat(4000) } }); await client.flush();
    const signal = (JSON.parse(gunzipSync(requests[0]!.body as Uint8Array).toString('utf8')) as Signal[])[0]!;
    expect(signal.system.platform).toBe('node'); expect(signal.system.osVersion).not.toContain('.');
    expect(signal.userHash).toBe(createHash('sha256').update('node-private').digest('hex'));
    expect(await readFile(path, 'utf8')).not.toContain('node-private');
  });

  it('uses memory fallback when a file path cannot be used', async () => {
    const store = fileStorage(directory); await store.read(); await store.write('memory'); expect(await store.read()).toBe('memory');
    expect(await readdir(directory)).toEqual([]);
  });

  it('treats a consent file that exists but cannot be read as opted out', async () => {
    const path = resolve(directory, 'queue.json'); await mkdir(`${path}.consent`);
    const fetcher = vi.fn(async () => new Response('', { status: 202 })); vi.stubGlobal('fetch', fetcher);
    const client = createPulse(nodePlatform()); client.init('synthetic-key', { storagePath: path }); client.track('blocked'); await client.flush();
    expect(fetcher).not.toHaveBeenCalled();
  });

  // The default layout gives every process its own queue file and shares only consent.
  it('gives each instance its own queue file and adopts files of exited processes exactly once', async () => {
    const key = 'a'.repeat(64); const dead = new Set([111]); const alive = (pid: number) => !dead.has(pid);
    const one = instanceStorage(directory, key, 222, alive); const two = instanceStorage(directory, key, 222, alive);
    await one.write('{"version":1,"queue":["one"]}'); await two.write('{"version":1,"queue":["two"]}');
    expect((await readdir(directory)).filter(f => f.endsWith('.queue'))).toHaveLength(2);
    expect((await one.claim!()).values).toEqual([]);
    const exited = instanceStorage(directory, key, 111, alive); await exited.write('{"version":1,"queue":["orphan"]}');
    await instanceStorage(directory, 'b'.repeat(64), 111, alive).write('{"other":"app"}');
    const [first, second] = await Promise.all([instanceStorage(directory, key, 333, alive).claim!(), instanceStorage(directory, key, 444, alive).claim!()]);
    expect([...first!.values, ...second!.values]).toEqual(['{"version":1,"queue":["orphan"]}']);
    first!.done(); second!.done(); await new Promise(r => setTimeout(r, 50));
    const files = await readdir(directory);
    expect(files.filter(f => f.startsWith(key)).map(f => f.split('.')[1]).sort()).toEqual(['222', '222']);
    expect(files.filter(f => f.startsWith('b'.repeat(64)))).toHaveLength(1);
    await one.consent!.write('{"version":1,"optOut":true}'); expect(await two.consent!.read()).toBe('{"version":1,"optOut":true}');
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
  });

  it('keeps an adopted file until the new owner has stored it, so a crash in between loses nothing', async () => {
    const key = 'c'.repeat(64); const alive = (pid: number) => pid !== 111;
    await instanceStorage(directory, key, 111, alive).write('{"version":1,"queue":["kept"]}');
    const crashed = await instanceStorage(directory, key, 555, () => false).claim!(); expect(crashed.values).toHaveLength(1);
    const later = await instanceStorage(directory, key, 666, pid => pid === 666).claim!();
    expect(later.values).toEqual(['{"version":1,"queue":["kept"]}']);
  });

  it('the minified Node build retries, adopts the queue of an exited process and persists consent in the default layout', async () => {
    const script = resolve(directory, 'e2e.mjs');
    await writeFile(script, [
      `import { Pulse } from ${JSON.stringify(pathToFileURL(resolve('dist/node.js')).href)};`,
      'const mode = process.argv[2]; const sent = []; let calls = 0;',
      'globalThis.fetch = async (url, init) => {',
      '  calls++; if (mode === "offline") throw new Error("offline");',
      '  sent.push(JSON.parse(Buffer.from(init.body).toString("utf8")).map(s => [s.type, s.system.sdkName]));',
      '  return calls === 1 ? new Response("", { status: 429, headers: { "Retry-After": "1" } }) : new Response("", { status: 202 });',
      '};',
      'Pulse.init("synthetic-key", { gzip: false }); if (mode === "offline") Pulse.track("from-exited-process");',
      'await Pulse.flush(); if (mode === "online") { await new Promise(r => setTimeout(r, 2100)); await Pulse.flush(); Pulse.optOut(true); await new Promise(r => setTimeout(r, 200)); }',
      'console.log(JSON.stringify({ calls, sent }));',
    ].join('\n'));
    const env = { ...process.env, HOME: directory, USERPROFILE: directory };
    const run = (mode: string) => JSON.parse(execFileSync(process.execPath, [script, mode], { encoding: 'utf8', env }).trim()) as { calls: number; sent: string[][][] };
    expect(run('offline').calls).toBe(1);
    const online = run('online');
    expect(online).toEqual({ calls: 2, sent: [[['from-exited-process', 'pulse-js']], [['from-exited-process', 'pulse-js']]] });
    const files = await readdir(resolve(directory, '.mightys-pulse'));
    const consent = files.filter(f => /^[0-9a-f]{64}\.json$/.test(f));
    expect(consent).toHaveLength(1);
    expect(await readFile(resolve(directory, '.mightys-pulse', consent[0]!), 'utf8')).toBe('{"version":1,"optOut":true}');
    expect(files.filter(f => f.endsWith('.queue'))).toHaveLength(1);
  });

  it('uses the default per-process layout without a storagePath and an explicit file with one', () => {
    expect(nodePlatform().storage('synthetic-key', {}).claim).toBeTypeOf('function');
    expect(nodePlatform().storage('synthetic-key', { storagePath: resolve(directory, 'q.json') }).claim).toBeUndefined();
  });

  it('builds importable ESM and CJS web and Node objects, with no import side effects', async () => {
    const esm = await import('../dist/node.js'); const web = await import('../dist/web.js');
    const require = createRequire(import.meta.url);
    for (const entry of [esm, web, require('../dist/node.cjs'), require('../dist/web.cjs')]) {
      expect(Object.keys(entry.Pulse).sort()).toEqual(['flush', 'init', 'optOut', 'setUser', 'track']);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps Node modules, tooling and package build metadata out of the browser bundle', async () => {
    const bundle = await readFile(new URL('../dist/web.js', import.meta.url), 'utf8');
    expect(bundle).not.toMatch(/node:|devDependencies|vitest|typescript|esbuild|install-scripts/);
  });

  it('resolves package self-imports under native Node and browser conditions', () => {
    const script = 'import {Pulse} from "@mightys-dev/pulse"; if (typeof window !== "undefined" || typeof Pulse.init !== "function") process.exit(1); console.log("ok")';
    for (const conditions of [[], ['--conditions=browser']]) {
      expect(execFileSync(process.execPath, [...conditions, '--input-type=module', '-e', script], { encoding: 'utf8' }).trim()).toBe('ok');
    }
    expect(execFileSync(process.execPath, ['-e', 'const {Pulse}=require("@mightys-dev/pulse"); console.log(typeof Pulse.track)'], { encoding: 'utf8' }).trim()).toBe('function');
  });
});
