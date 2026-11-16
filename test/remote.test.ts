import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserStorage } from '../src/adapters/browser.js';
import { fileStorage, instanceStorage, nodePlatform } from '../src/adapters/node.js';
import { fetchTransport } from '../src/adapters/shared.js';
import { createPulse } from '../src/core.js';
import { parseRemote } from '../src/remote.js';
import type { TransportResponse } from '../src/types.js';
import { harness, InstallStorage, settle } from './helpers.js';

/** Storage like the Node and native app wrapper ones: install id, statistics and cached settings. */
class AppStorage extends InstallStorage {
  text: string | null = null;
  cached: string | null = null;
  configRemoved = 0;
  usage = {
    read: async (): Promise<string | null> => this.text,
    write: async (value: string): Promise<void> => { this.text = value; },
    remove: async (): Promise<void> => { this.text = null; },
  };
  config = {
    read: async (): Promise<string | null> => this.cached,
    write: async (value: string): Promise<void> => { this.cached = value; },
    remove: async (): Promise<void> => { this.configRemoved++; this.cached = null; },
  };
}

const body = (extra: object = {}): string => JSON.stringify({ version: 3, screenViews: true, automaticSignals: true, groups: {}, disabledSignals: [], ...extra });
const settleAll = async (): Promise<void> => { for (let n = 0; n < 6; n++) await settle(); };
const INFO = {
  platform: 'mobile', osName: 'Android', osVersion: '15', locale: 'en-US', deviceModel: 'Pixel',
  deviceType: 'phone', architecture: 'arm64', runtimeVersion: 'Node 22', targetEnvironment: 'webview',
  screenWidth: '400', screenHeight: '800', screenScale: '2', screenWidthPx: '800', screenHeightPx: '1600', orientation: 'portrait',
  colorScheme: 'dark', layoutDirection: 'ltr', timeZone: 'UTC', utcOffsetMinutes: '0', language: 'en', preferredLanguage: 'en', region: 'US',
  reduceMotion: 'false', invertColors: 'false', increaseContrast: 'false', connectionType: 'wifi', isDebugBuild: 'false',
};
const GROUP_KEYS: Record<string, string[]> = {
  device: ['deviceType', 'architecture', 'runtimeVersion', 'targetEnvironment'],
  screen: ['screenWidth', 'screenHeight', 'screenScale', 'screenWidthPx', 'screenHeightPx', 'orientation'],
  settings: ['colorScheme', 'layoutDirection', 'timeZone', 'utcOffsetMinutes', 'language', 'preferredLanguage', 'region', 'reduceMotion', 'invertColors', 'increaseContrast'],
  network: ['connectionType'],
  app: ['appName', 'isDebugBuild'],
  usage: ['isNewInstall', 'firstSessionDate', 'totalSessionsCount', 'distinctDaysUsed', 'distinctDaysUsedLastMonth', 'sessionSeconds'],
};
const BASE = ['platform', 'osName', 'osVersion', 'locale', 'appVersion', 'deviceModel', 'appBuildNumber', 'sdkName', 'sdkVersion'];

type Answer = TransportResponse | Error | Promise<TransportResponse>;

/** One launch with a settings answer; `versions` collects the cached version each request carried. */
async function launch(store: InstallStorage, answer: Answer, options: object = {}, info: object = INFO) {
  const h = harness(store);
  const base = h.platform.transport('synthetic-app-key', 'https://in.mightys.dev');
  const versions: (number | undefined)[] = [];
  const client = createPulse({
    ...h.platform,
    environment: { ...h.platform.environment, info: () => info as never },
    transport: () => ({
      ...base,
      async config(version) { versions.push(version); if (answer instanceof Error) throw answer; return answer; },
    }),
  });
  client.init('synthetic-app-key', { gzip: false, appVersion: '1.0', appBuildNumber: '7', appName: 'App', ...options });
  await settleAll();
  return { h, client, versions };
}
const sent = async (c: Awaited<ReturnType<typeof launch>>) => { await c.client.flush(); return c.h.requests.flatMap((_, i) => c.h.signals(i)); };
const types = (signals: { type: string }[]): string[] => signals.map(s => s.type);

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 16, 12).getTime() }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('parsing', () => {
  it('reads a full answer', () => {
    const r = parseRemote(body({ screenViews: false, automaticSignals: false, groups: { network: false }, disabledSignals: ['pulse.new_install'] }))!;
    expect(r.version).toBe(3); expect(r.automatic).toBe(false);
    expect(r.off).toEqual(['pulse.new_install', 'pulse.screen_view']); expect(r.hidden).toEqual(['connectionType']);
  });
  it('treats missing keys, unknown keys and wrong types as on', () => {
    for (const text of ['{}', '{"unknown":1,"groups":{"nope":false}}', '{"screenViews":"no","automaticSignals":0,"groups":{"device":"off","app":null},"disabledSignals":"x"}', '{"groups":[],"disabledSignals":{}}', '{"groups":"x"}']) {
      const r = parseRemote(text)!;
      expect(r.automatic).toBe(true); expect(r.off).toEqual([]); expect(r.hidden).toEqual([]);
    }
  });
  it('ignores a bad body without throwing', () => {
    for (const text of ['', '{bad', 'null', '5', '"x"', undefined, null]) expect(parseRemote(text)).toBeUndefined();
  });
});

describe('fetch, cache and next launch', () => {
  it('asks once per launch with the cached version, stores a 200 and keeps the cache on 304', async () => {
    const store = new AppStorage();
    const first = await launch(store, { status: 200, body: body({ version: 3 }) });
    expect(first.versions).toEqual([undefined]); expect(store.cached).toBe(body({ version: 3 }));
    first.client.track('a'); await first.client.flush(); await settleAll();
    expect(first.versions).toHaveLength(1);
    const second = await launch(store, { status: 304 });
    expect(second.versions).toEqual([3]); expect(store.cached).toBe(body({ version: 3 }));
  });

  it('applies a fetched answer from the next launch only', async () => {
    const store = new AppStorage();
    const first = await launch(store, { status: 200, body: body({ automaticSignals: false }) });
    first.client.track('x');
    expect(types(await sent(first))).toEqual(['pulse.new_install', 'pulse.session_started', 'x']); // not applied yet
    const second = await launch(store, { status: 304 });
    second.client.track('x');
    expect(types(await sent(second)).filter(t => t.startsWith('pulse.'))).toEqual([]);
  });

  it('keeps the cache when the request fails, answers 401 or 500, or returns a bad body', async () => {
    for (const answer of [new Error('offline'), { status: 401 }, { status: 500 }, { status: 200, body: '{bad' }, { status: 200 }] as Answer[]) {
      const store = new AppStorage(); store.cached = body({ version: 2, automaticSignals: false });
      const c = await launch(store, answer);
      expect(store.cached).toBe(body({ version: 2, automaticSignals: false }));
      c.client.track('x');
      expect(types(await sent(c)).filter(t => t.startsWith('pulse.'))).toEqual([]);
    }
  });

  it('has everything on with no cache and an unusable one', async () => {
    for (const cached of [null, '{bad', '[]']) {
      const store = new AppStorage(); store.cached = cached;
      const c = await launch(store, { status: 500 }); c.client.track('x');
      const signals = await sent(c);
      expect(types(signals)).toEqual(expect.arrayContaining(['pulse.session_started', 'pulse.new_install', 'x']));
      expect(Object.keys(signals.find(s => s.type === 'x')!.system)).toEqual(expect.arrayContaining([...GROUP_KEYS.device!, ...GROUP_KEYS.usage!.slice(0, 3)]));
    }
  });
});

describe('effects of the settings', () => {
  const cachedLaunch = async (settings: object, options: object = {}) => {
    const store = new AppStorage(); store.cached = body(settings);
    const c = await launch(store, { status: 304 }, options); c.client.track('x'); c.client.screen('Home');
    return { c, signals: await sent(c) };
  };

  it('automaticSignals off sends none of the four automatic signals', async () => {
    const { c, signals } = await cachedLaunch({ automaticSignals: false });
    expect(types(signals)).toEqual(['x']); expect(c.h.screens).toHaveLength(0);
  });
  it('screenViews off installs no hook and drops manual screens too', async () => {
    const { c, signals } = await cachedLaunch({ screenViews: false });
    expect(c.h.screens).toHaveLength(0); expect(types(signals)).toEqual(['pulse.new_install', 'pulse.session_started', 'x']);
  });
  it('a disabled type is the only thing dropped', async () => {
    const { signals } = await cachedLaunch({ disabledSignals: ['pulse.new_install', 'pulse.nonsense'] });
    expect(types(signals)).toEqual(['pulse.session_started', 'x', 'pulse.screen_view']);
  });
  it('a disabled screen_view type drops screens and the hook', async () => {
    const { c, signals } = await cachedLaunch({ disabledSignals: ['pulse.screen_view'] });
    expect(c.h.screens).toHaveLength(0); expect(types(signals)).not.toContain('pulse.screen_view');
  });

  it('with everything on, the hook is installed and all signals are sent', async () => {
    const { c, signals } = await cachedLaunch({});
    expect(c.h.screens).toHaveLength(1); expect(types(signals)).toEqual(['pulse.new_install', 'pulse.session_started', 'x', 'pulse.screen_view']);
  });

  it('code options can only switch off', async () => {
    const off = await cachedLaunch({}, { automaticSignals: false });
    expect(types(off.signals)).toEqual(['x', 'pulse.screen_view']);
    const noHook = await cachedLaunch({}, { automaticScreenViews: false });
    expect(noHook.c.h.screens).toHaveLength(0); expect(types(noHook.signals)).toContain('pulse.screen_view'); // a manual call still sends
    const portalOff = await cachedLaunch({ automaticSignals: false }, { automaticSignals: true, automaticScreenViews: true });
    expect(types(portalOff.signals)).toEqual(['x']);
  });

  it.each(Object.keys(GROUP_KEYS))('group %s off removes exactly its keys and keeps the base keys', async name => {
    const all = await cachedLaunch({});
    const off = await cachedLaunch({ groups: { [name]: false } });
    const read = (r: typeof all) => Object.keys(r.signals.find(s => s.type === 'x')!.system);
    const removed = read(all).filter(k => !read(off).includes(k)).sort();
    const expected = GROUP_KEYS[name]!.filter(k => read(all).includes(k)).sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(removed).toEqual(expected);
    for (const key of BASE) expect(read(off)).toContain(key);
  });

  it('turning every group off leaves only the base keys', async () => {
    const { signals } = await cachedLaunch({ groups: Object.fromEntries(Object.keys(GROUP_KEYS).map(k => [k, false])) });
    expect(Object.keys(signals.find(s => s.type === 'x')!.system).sort()).toEqual([...BASE].sort());
  });
});

describe('opt-out and blocking', () => {
  it('opt-out deletes the cached settings, with the rest, and nothing is asked while opted out', async () => {
    const store = new AppStorage(); store.cached = body();
    const c = await launch(store, { status: 200, body: body({ version: 9 }) });
    c.client.optOut(true); await settleAll();
    expect(store.cached).toBeNull(); expect(store.configRemoved).toBeGreaterThan(0);
    const again = await launch(store, { status: 200, body: body({ version: 10 }) }); // consent stays opted out in this storage
    expect(again.versions.length).toBeLessThanOrEqual(1);
  });

  it('a throwing usage deletion still deletes the cached settings, and the other way round', async () => {
    for (const failing of ['usage', 'config'] as const) {
      const store = new AppStorage(); store.cached = body(); store.text = '{}';
      store[failing].remove = async () => { throw new Error('locked'); };
      const c = await launch(store, { status: 500 });
      c.client.optOut(true); await settleAll();
      if (failing === 'usage') expect(store.cached).toBeNull(); else expect(store.text).toBeNull();
    }
  });

  it('opt-out while the request is in flight stores nothing', async () => {
    const store = new AppStorage();
    let release!: (r: TransportResponse) => void;
    const c = await launch(store, new Promise<TransportResponse>(r => { release = r; }));
    c.client.optOut(true); await settleAll();
    release({ status: 200, body: body() }); await settleAll();
    expect(store.cached).toBeNull();
  });

  it('a hung settings request does not delay track or flush', async () => {
    const store = new AppStorage();
    const c = await launch(store, new Promise<TransportResponse>(() => {}));
    const before = Date.now();
    c.client.track('kept'); await c.client.flush(); await settleAll();
    expect(Date.now()).toBe(before);
    expect(types(c.h.requests.flatMap((_, i) => c.h.signals(i)))).toContain('kept');
  });
});

describe('normal browser (no storage for the app)', () => {
  it('applies the answer to the rest of the page; signals before it use all-on', async () => {
    const store = new InstallStorage() as InstallStorage & { id: null };
    const plain = Object.assign(Object.create(Object.getPrototypeOf(store)), { value: null, history: [], read: async () => null, write: async () => {} });
    let release!: (r: TransportResponse) => void;
    const c = await launch(plain, new Promise<TransportResponse>(r => { release = r; }), {}, { platform: 'web', osName: 'Windows', osVersion: '', locale: 'en', language: 'en' });
    c.client.screen('Before');
    expect(c.h.screens).toHaveLength(1);
    release({ status: 200, body: body({ screenViews: false, groups: { settings: false } }) }); await settleAll();
    c.client.screen('After'); c.client.track('x');
    const signals = await sent(c);
    expect(signals.map(s => s.props?.screen ?? s.type)).toEqual(['Before', 'x']);
    expect(c.versions).toEqual([undefined]);
    expect('language' in signals[0]!.system).toBe(true); expect('language' in signals[1]!.system).toBe(false);
  });
});

describe('request and storage locations', () => {
  it('sends the key, the cached version, no credentials and no referrer, and gives up after 10 seconds', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_res, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    const transport = fetchTransport('synthetic', 'https://host.invalid', () => fetcher as unknown as typeof fetch);
    const pending = transport.config!(3).catch(e => e as Error);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://host.invalid/api/v1/config');
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { 'X-App-Key': 'synthetic', 'If-None-Match': '"3"' } });
    expect(init.method).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9999); expect(init.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2); expect(init.signal!.aborted).toBe(true);
    expect((await pending as Error).message).toBe('aborted');
  });

  it('sends no If-None-Match without a cached version and returns no body for a 304', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 304 }));
    const transport = fetchTransport('synthetic', 'https://host.invalid', () => fetcher as unknown as typeof fetch);
    expect(await transport.config!()).toEqual({ status: 304 });
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({ 'X-App-Key': 'synthetic' });
  });

  it('cancel aborts a settings request too', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_res, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
    const transport = fetchTransport('synthetic', 'https://host.invalid', () => fetcher as unknown as typeof fetch);
    const pending = transport.config!().catch(e => (e as Error).message);
    transport.cancel(); expect(await pending).toBe('aborted');
  });

  describe('files', () => {
    let directory = '';
    beforeEach(async () => { vi.useRealTimers(); await mkdir('.test-storage', { recursive: true }); directory = await mkdtemp(resolve('.test-storage/config-')); });
    afterEach(async () => {
      if (!resolve(directory).startsWith(resolve('.test-storage') + sep)) throw new Error('Unsafe test cleanup path.');
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });

    it('uses <storagePath>.config and config-<16 hex of the key hash> in the default layout', async () => {
      const path = resolve(directory, 'queue.json'); const store = fileStorage(path).config!;
      expect(await store.read()).toBeNull(); await store.write('{"version":1}');
      expect(await readFile(`${path}.config`, 'utf8')).toBe('{"version":1}');
      await store.remove(); await store.remove(); expect(await store.read()).toBeNull();
      const key = createHash('sha256').update('synthetic-key', 'utf8').digest('hex');
      await instanceStorage(directory, key).config!.write('{}');
      expect(await readFile(resolve(directory, `config-${key.slice(0, 16)}`), 'utf8')).toBe('{}');
    });

    it('a real Node launch stores the answer and the next launch applies it', async () => {
      const path = resolve(directory, 'queue.json');
      const sentTypes: string[] = [];
      // Assigned directly: the shared stub helper answers settings requests on its own.
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        if (url.endsWith('/api/v1/config')) return new Response(body({ version: 4, automaticSignals: false }), { status: 200 });
        for (const s of JSON.parse(Buffer.from(init.body as Uint8Array).toString('utf8')) as { type: string }[]) sentTypes.push(s.type);
        return new Response('', { status: 202 });
      }) as typeof fetch;
      try {
      for (let n = 0; n < 2; n++) {
        const c = createPulse(nodePlatform()); c.init('synthetic-key', { storagePath: path, gzip: false });
        await new Promise(r => setTimeout(r, 100)); c.track('x'); await c.flush();
      }
      } finally { globalThis.fetch = original; }
      expect(JSON.parse(await readFile(`${path}.config`, 'utf8'))).toMatchObject({ version: 4 });
      expect(sentTypes).toEqual(['pulse.new_install', 'pulse.session_started', 'x', 'x']); // the second launch sends no automatic signal
    });
  });

  it('a native app wrapper keeps the settings in localStorage under mightys-pulse:config:<key>; a plain browser has none', async () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); }, key: () => null, get length() { return items.size; } });
    expect(browserStorage('synthetic-key').config).toBeUndefined();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    const store = browserStorage('synthetic-key').config!;
    await store.write('{"version":2}');
    expect(items.get('mightys-pulse:config:synthetic-key')).toBe('{"version":2}');
    expect(await store.read()).toBe('{"version":2}');
    await store.remove(); expect(items.size).toBe(0);
  });
});

describe('the settings loaded at start govern the whole launch', () => {
  /** Starts a launch without waiting, so signals are captured before the cached settings are read. */
  const early = (store: AppStorage, answer: Answer) => {
    const h = harness(store);
    const base = h.platform.transport('synthetic-app-key', 'https://in.mightys.dev');
    const client = createPulse({ ...h.platform, transport: () => ({ ...base, async config() { if (answer instanceof Error) throw answer; return answer; } }) });
    client.init('synthetic-app-key', { gzip: false });
    return { h, client };
  };

  it('screens captured before the cache is read follow the cache', async () => {
    const store = new AppStorage(); store.cached = body({ version: 1, screenViews: false });
    const slow = store.config.read; store.config.read = async () => { await settle(); return slow(); };
    const { h, client } = early(store, { status: 304 });
    client.screen('home'); client.screen('detail'); client.track('x');
    await settleAll();
    const signals = await sent({ h, client, versions: [] });
    expect(types(signals)).not.toContain('pulse.screen_view'); expect(types(signals)).toContain('x');
  });

  it('a config fetched during the launch does not change it; the next launch applies it', async () => {
    const store = new AppStorage(); store.cached = body({ version: 1, screenViews: false });
    let release!: (r: TransportResponse) => void;
    const first = await launch(store, new Promise<TransportResponse>(r => { release = r; }));
    first.client.screen('home');
    release({ status: 200, body: body({ version: 2, screenViews: true }) }); await settleAll();
    first.client.screen('detail'); first.client.track('x');
    expect(types(await sent(first))).not.toContain('pulse.screen_view');
    expect(store.cached).toBe(body({ version: 2, screenViews: true }));
    const second = await launch(store, { status: 304 });
    second.client.screen('home');
    expect(types(await sent(second))).toContain('pulse.screen_view');
  });

  it('a normal browser applies the answer to the rest of the page, but signals captured before it keep the defaults', async () => {
    const plain = Object.assign(Object.create(Object.getPrototypeOf(new InstallStorage())), { read: async () => null, write: async () => {} });
    let release!: (r: TransportResponse) => void;
    const c = await launch(plain, new Promise<TransportResponse>(r => { release = r; }), {}, { platform: 'web', osName: 'Windows', osVersion: '', locale: 'en' });
    c.client.screen('before');
    release({ status: 200, body: body({ screenViews: false }) }); await settleAll();
    c.client.screen('after');
    expect((await sent(c)).map(s => s.props?.screen)).toEqual(['before']);
  });
});
