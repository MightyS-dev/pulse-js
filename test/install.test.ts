import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserInfo, browserPlatform, inWrapper } from '../src/adapters/browser.js';
import { fileStorage, instanceStorage, nodePlatform } from '../src/adapters/node.js';
import { createPulse } from '../src/core.js';
import { harness, InstallStorage, settle } from './helpers.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-15T08:00:00Z') }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('anonymous install id in the core', () => {
  it('creates the id once as 32 lowercase hex characters and reuses it after a restart with the same storage', async () => {
    const store = new InstallStorage();
    const first = harness(store); await first.start({ gzip: false });
    const id = store.id!; expect(id).toMatch(/^[a-f0-9]{32}$/);
    const second = harness(store); await second.start({ gzip: false });
    expect(store.id).toBe(id);
  });

  it('sends userHash without setUser, equal to the SHA-256 of the install id, also for signals tracked before init', async () => {
    const store = new InstallStorage(); const h = harness(store);
    h.client.track('early'); await h.start({ gzip: false }); h.client.track('late'); await h.client.flush();
    const hash = sha(store.id!);
    expect(h.signals().map(s => s.userHash)).toEqual([hash, hash]);
  });

  it('lets setUser replace it and setUser(null) bring it back', async () => {
    const store = new InstallStorage(); const h = harness(store); await h.start({ gzip: false });
    h.client.track('anonymous'); await h.client.setUser('my-user'); h.client.track('identified');
    await h.client.setUser(null); h.client.track('restored'); await h.client.flush();
    expect(h.signals().map(s => s.userHash)).toEqual([sha(store.id!), sha('my-user'), sha(store.id!)]);
  });

  it('opt-out deletes the id, sends nothing, and opt-out off creates a different id at the next signal', async () => {
    const store = new InstallStorage(); const h = harness(store); await h.start({ gzip: false });
    const before = store.id!;
    h.client.optOut(true); await h.client.flush(); expect(store.id).toBeNull(); expect(store.removed).toBeGreaterThan(0);
    h.client.track('blocked'); h.client.optOut(false); h.client.track('again'); await h.client.flush();
    expect(store.id).toMatch(/^[a-f0-9]{32}$/); expect(store.id).not.toBe(before);
    const signals = h.signals(); expect(signals.map(s => s.type)).toEqual(['again']);
    expect(signals[0]!.userHash).toBe(sha(store.id!));
  });

  it('opt-out followed at once by opt-out off still ends with an install hash', async () => {
    const store = new InstallStorage(); const h = harness(store); await h.start({ gzip: false });
    h.client.optOut(true); h.client.optOut(false); h.client.track('after'); await h.client.flush();
    expect(h.signals()[0]!.userHash).toBe(sha(store.id!));
  });

  it('keeps counting with an in-memory id when the stored id cannot be read or written, without throwing', async () => {
    const store = new InstallStorage(); store.failing = true; const h = harness(store);
    await h.start({ gzip: false }); h.client.track('memory'); await h.client.flush();
    expect(h.signals()[0]!.userHash).toMatch(/^[a-f0-9]{64}$/); expect(store.id).toBeNull();
  });

  it('ignores a stored value that is not a valid id and replaces it', async () => {
    const store = new InstallStorage(); store.id = 'not-an-id'; const h = harness(store);
    await h.start({ gzip: false }); expect(store.id).toMatch(/^[a-f0-9]{32}$/);
  });

  it('sends no userHash and stores nothing when the platform has no install storage', async () => {
    const h = harness(); await h.start({ gzip: false }); h.client.track('plain'); await h.client.flush();
    expect(h.signals()[0]).not.toHaveProperty('userHash');
    expect((h.storage as InstallStorage).history.join('').replace(/"id":"[a-f0-9]{32}"/g, '')).not.toMatch(/[a-f0-9]{32}/);  // a batch id belongs to one batch, never to the device
  });

  it('starts opted out without creating or keeping an id', async () => {
    const store = new InstallStorage(); store.id = 'a'.repeat(32); store.value = '{"version":1,"optOut":true,"queue":[]}';
    const h = harness(store); await h.start({ gzip: false }); h.client.track('x'); await h.client.flush();
    expect(h.requests).toHaveLength(0); expect(store.id).toBeNull();
  });
});

describe('Node install id', () => {
  let directory = '';
  beforeEach(async () => { vi.useRealTimers(); await mkdir('.test-storage', { recursive: true }); directory = await mkdtemp(resolve('.test-storage/id-')); });
  afterEach(async () => {
    if (!resolve(directory).startsWith(resolve('.test-storage') + sep)) throw new Error('Unsafe test cleanup path.');
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the id next to the queue file, shares it between instances and reuses it', async () => {
    const path = resolve(directory, 'queue.json');
    const one = fileStorage(path).install!; const two = fileStorage(path).install!;
    expect(await one.read()).toBeNull();
    const id = 'ab'.repeat(16); expect(await one.write(id)).toBe(id);
    expect(await two.read()).toBe(id);
    expect(await readdir(directory)).toEqual(['queue.json.install-id']);
    // A second creator loses the race and adopts the stored id.
    expect(await two.write('cd'.repeat(16))).toBe(id);
    expect(await readdir(directory)).toEqual(['queue.json.install-id']);
  });

  it('replaces a damaged id file', async () => {
    const path = resolve(directory, 'queue.json'); await writeFile(`${path}.install-id`, 'garbage');
    const id = 'ef'.repeat(16); expect(await fileStorage(path).install!.write(id)).toBe(id);
    expect(await readFile(`${path}.install-id`, 'utf8')).toBe(id);
  });

  it('uses one file per app key in the shared directory, named by the first 16 hex of the key hash', async () => {
    const key = sha('synthetic-key'); const store = instanceStorage(directory, key).install!;
    await store.write('12'.repeat(16));
    expect(await readdir(directory)).toEqual([`install-id-${key.slice(0, 16)}`]);
  });

  it('sends the hash of the stored id from a real client, keeps it across clients and deletes it on opt-out', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { bodies.push(Buffer.from(init.body as Uint8Array).toString('utf8')); return new Response('', { status: 202 }); }));
    const path = resolve(directory, 'queue.json'); const file = `${path}.install-id`;
    const send = async (): Promise<{ userHash: string }> => {
      const client = createPulse(nodePlatform()); client.init('synthetic-key', { storagePath: path, gzip: false });
      client.track('node'); await client.flush();
      return (JSON.parse(bodies.pop()!) as { userHash: string }[])[0]!;
    };
    const first = await send(); const id = (await readFile(file, 'utf8'));
    expect(id).toMatch(/^[a-f0-9]{32}$/); expect(first.userHash).toBe(sha(id));
    expect((await send()).userHash).toBe(sha(id));
    const client = createPulse(nodePlatform()); client.init('synthetic-key', { storagePath: path, gzip: false });
    await client.flush(); client.optOut(true); await settle(); await new Promise(r => setTimeout(r, 50));
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('gives the system fields on Node', () => {
    const info = nodePlatform().environment.info();
    for (const key of ['platform', 'osName', 'osVersion', 'locale'] as const) expect(info[key]).not.toBe('');
  });
});

describe('browser: plain page and native app wrapper', () => {
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.231205.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
  const IPHONE_WK = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const IPHONE_SAFARI = `${IPHONE_WK} Version/17.2 Safari/604.1`;
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  function page(userAgent: string, extra: Record<string, unknown> = {}, hints?: { platform: string }) {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', new Proxy({
      getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); },
    }, { ownKeys: () => [...values.keys()], getOwnPropertyDescriptor: (_t, k) => typeof k === 'string' && values.has(k) ? { value: values.get(k), enumerable: true, configurable: true } : undefined }));
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const events = new EventTarget(); vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
    vi.stubGlobal('navigator', { language: 'de-DE', userAgent, ...(hints ? { userAgentData: hints } : {}) });
    for (const [k, v] of Object.entries(extra)) vi.stubGlobal(k, v);
    const bodies: { userHash?: string; system: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { bodies.push(...JSON.parse(new TextDecoder().decode(init.body as Uint8Array))); return new Response('', { status: 202 }); }));
    const client = createPulse(browserPlatform());
    return { values, bodies, client, installKey: (key = 'k') => `mightys-pulse:install:${key}` };
  }

  it('stores no identifier and sends no userHash in a plain browser, and does not call it a wrapper', async () => {
    for (const ua of [DESKTOP, IPHONE_SAFARI]) {
      const p = page(ua, { webkit: { messageHandlers: {} } });
      p.client.init('k', { gzip: false }); p.client.track('plain'); await p.client.flush();
      expect(p.bodies[0]).not.toHaveProperty('userHash'); expect(p.bodies[0]!.system).not.toHaveProperty('deviceModel');
      expect(p.bodies[0]!.system.platform).toBe('web');
      expect([...p.values.keys()].filter(k => k.includes('install'))).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['Capacitor', IPHONE_WK, { Capacitor: { isNativePlatform: () => true } }, 'iPhone'],
    ['Cordova', ANDROID.replace('; wv)', ')'), { cordova: {} }, 'Pixel 8'],
    ['Android WebView', ANDROID, {}, 'Pixel 8'],
    ['iOS WKWebView', IPHONE_WK.replace('iPhone', 'iPad').replace('iPhone OS', 'OS'), { webkit: { messageHandlers: {} } }, 'iPad'],
  ])('%s: stores the id in localStorage, sends its hash and the device model', async (_name, ua, extra, model) => {
    const p = page(ua, extra);
    p.client.init('k', { gzip: false }); p.client.track('wrapped'); await p.client.flush();
    const id = p.values.get(p.installKey())!;
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(p.bodies[0]!.userHash).toBe(sha(id));
    expect(p.bodies[0]!.system).toMatchObject({ platform: 'mobile', deviceModel: model, locale: 'de-DE' });
    expect(p.bodies[0]!.system.osName).toMatch(/Android|iOS/); expect(p.bodies[0]!.system.osVersion).toMatch(/^\d+$/);
  });

  it('reuses the id on the next launch, and opt-out deletes it while opt-out off gives a new one', async () => {
    const p = page(ANDROID);
    p.client.init('k', { gzip: false }); await p.client.flush(); const id = p.values.get(p.installKey())!;
    const again = createPulse(browserPlatform()); again.init('k', { gzip: false }); await again.flush();
    expect(p.values.get(p.installKey())).toBe(id);
    again.optOut(true); await again.flush(); expect(p.values.has(p.installKey())).toBe(false);
    again.optOut(false); again.track('new'); await again.flush();
    const next = p.values.get(p.installKey())!; expect(next).toMatch(/^[a-f0-9]{32}$/); expect(next).not.toBe(id);
    expect(p.bodies.at(-1)!.userHash).toBe(sha(next));
  });

  it('still counts, in memory, when localStorage or WebCrypto random fail', async () => {
    const p = page(ANDROID);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    p.client.init('k', { gzip: false }); p.client.track('blocked'); await p.client.flush();
    expect(p.bodies[0]!.userHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('detects a wrapper only from positive evidence', () => {
    const win = (extra: object = {}) => ({ ...extra });
    expect(inWrapper(win({ Capacitor: { isNativePlatform: () => true } }), DESKTOP)).toBe(true);
    expect(inWrapper(win({ Capacitor: { isNativePlatform: () => false } }), DESKTOP)).toBe(false);
    expect(inWrapper(win({ cordova: {} }), DESKTOP)).toBe(true);
    expect(inWrapper(win(), ANDROID)).toBe(true);
    expect(inWrapper(win({ webkit: { messageHandlers: {} } }), IPHONE_WK)).toBe(true);
    expect(inWrapper(win({ webkit: { messageHandlers: {} } }), IPHONE_SAFARI)).toBe(false);
    expect(inWrapper(win(), IPHONE_WK)).toBe(false);
    expect(inWrapper(win(), DESKTOP)).toBe(false);
  });

  it('reads the Android version even when Client Hints name the platform, and the iOS major version', () => {
    expect(browserInfo({ language: 'x', userAgent: ANDROID, userAgentData: { platform: 'Android' } } as never, true))
      .toMatchObject({ osName: 'Android', osVersion: '14', deviceModel: 'Pixel 8', platform: 'mobile' });
    expect(browserInfo({ language: 'x', userAgent: IPHONE_WK } as never, true)).toMatchObject({ osName: 'iOS', osVersion: '17', deviceModel: 'iPhone' });
  });
});
