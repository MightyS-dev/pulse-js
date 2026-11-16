import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserInfo, browserPlatform } from '../src/adapters/browser.js';
import { fileStorage, instanceStorage, nodeInfo, nodePlatform, osVersionOf } from '../src/adapters/node.js';
import { createPulse } from '../src/core.js';
import { beginSession, localDay, parseUsage, usageFields } from '../src/usage.js';
import { harness, InstallStorage, settle } from './helpers.js';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();

/** Install storage that also keeps the statistics, like the Node and native app wrapper storages. */
class UsageStorage extends InstallStorage {
  text: string | null = null;
  usageFailing = false;
  usageRemoved = 0;
  usage = {
    read: async (): Promise<string | null> => { if (this.usageFailing) throw new Error('unreadable'); return this.text; },
    write: async (value: string): Promise<void> => { if (this.usageFailing) throw new Error('unwritable'); this.text = value; },
    remove: async (): Promise<void> => { this.usageRemoved++; this.text = null; },
  };
}

beforeEach(() => { vi.useFakeTimers({ now: at(2026, 11, 15) }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function launch(store: UsageStorage, options: object = {}) {
  const h = harness(store);
  await h.start({ gzip: false, ...options });
  return h;
}
const sent = async (h: ReturnType<typeof harness>) => { await h.client.flush(); return h.requests.flatMap((_, i) => h.signals(i)); };

describe('Node fields', () => {
  it('gives every field with the allowed format', () => {
    const info = nodeInfo();
    expect(info).toMatchObject({ platform: 'node', deviceType: 'desktop', runtimeVersion: `Node ${process.versions.node}` });
    expect(info.architecture).toBe(({ x64: 'x86_64', arm64: 'arm64', arm: 'armv7' } as Record<string, string>)[process.arch]);
    expect(info.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(info.utcOffsetMinutes).toBe(String(-new Date().getTimezoneOffset() || 0));
    expect(info.utcOffsetMinutes).toMatch(/^-?\d+$/);
    expect(info.language).toMatch(/^[a-z]{2,3}$/); expect(info.preferredLanguage).toBe(info.language);
    if (info.region) expect(info.region).toMatch(/^[A-Z]{2}$/);
    expect(info.isDebugBuild).toBe('true'); // vitest sets NODE_ENV=test
    expect(info.osVersion).toMatch(/^\d+(\.\d+){0,2}$/);
  });

  it('maps the Darwin kernel to the macOS major version, keeps up to three parts elsewhere and omits the unknown', () => {
    for (const [kernel, mac] of [['25.1.0', '26'], ['24.6.0', '15'], ['23.5.0', '14'], ['22.1.0', '13'], ['21.6.0', '12'], ['20.6.0', '11'], ['19.6.0', ''], ['bad', '']] as [string, string][]) {
      expect(osVersionOf('darwin', kernel)).toBe(mac);
    }
    expect(osVersionOf('win32', '10.0.22631')).toBe('10.0.22631');
    expect(osVersionOf('linux', '6.8.0-45-generic')).toBe('6.8.0');
    expect(osVersionOf('linux', '5.15.1.2')).toBe('5.15.1');
  });

  it('leaves out a time zone the platform cannot give', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({ resolvedOptions: () => ({ locale: 'en', timeZone: undefined }) } as never);
    const info = nodeInfo();
    expect(info.timeZone).toBeUndefined(); expect(info).not.toHaveProperty('region');
  });
});

describe('Node files', () => {
  let directory = '';
  beforeEach(async () => { vi.useRealTimers(); await mkdir('.test-storage', { recursive: true }); directory = await mkdtemp(resolve('.test-storage/usage-')); });
  afterEach(async () => {
    if (!resolve(directory).startsWith(resolve('.test-storage') + sep)) throw new Error('Unsafe test cleanup path.');
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('keeps the usage file next to the install id file, in both layouts', async () => {
    const path = resolve(directory, 'queue.json'); const store = fileStorage(path).usage!;
    expect(await store.read()).toBeNull(); await store.write('{"a":1}');
    expect(await readdir(directory)).toEqual(['queue.json.usage']);
    await store.remove(); await store.remove(); expect(await readdir(directory)).toEqual([]);
    const key = sha('synthetic-key'); await instanceStorage(directory, key).usage!.write('{}');
    expect(await readdir(directory)).toEqual([`usage-${key.slice(0, 16)}`]);
  });

  it('counts sessions across two real launches and deletes the file on opt-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 202 })));
    const path = resolve(directory, 'queue.json');
    for (let n = 0; n < 2; n++) { const c = createPulse(nodePlatform()); c.init('synthetic-key', { storagePath: path, gzip: false }); c.track('x'); await c.flush(); }
    const record = JSON.parse(await readFile(`${path}.usage`, 'utf8')) as { total: number };
    expect(record.total).toBe(2);
    const c = createPulse(nodePlatform()); c.init('synthetic-key', { storagePath: path, gzip: false });
    await c.flush(); c.optOut(true); await settle(); await new Promise(r => setTimeout(r, 50));
    await expect(readFile(`${path}.usage`, 'utf8')).rejects.toThrow();
  });
});

describe('session statistics', () => {
  it('computes new install, second session, day change, previous and average', () => {
    const one = beginSession(undefined, at(2026, 11, 1, 9), '1.0', '1');
    expect(one.changed).toBeUndefined();
    expect(usageFields(one.usage, at(2026, 11, 1, 9) + 5000, at(2026, 11, 1, 9))).toEqual({
      firstSessionDate: '2026-11-01', totalSessionsCount: '1', distinctDaysUsed: '1', distinctDaysUsedLastMonth: '1', sessionSeconds: '5', isNewInstall: 'true' });
    const ended = { ...one.usage, cur: [at(2026, 11, 1, 9), at(2026, 11, 1, 9) + 100000] as [number, number] };
    const two = beginSession(ended, at(2026, 11, 1, 11), '1.0', '1');
    expect(usageFields(two.usage, at(2026, 11, 1, 11), at(2026, 11, 1, 11))).toMatchObject({
      totalSessionsCount: '2', distinctDaysUsed: '1', previousSessionSeconds: '100', averageSessionSeconds: '100' });
    expect(usageFields(two.usage, at(2026, 11, 1, 11), at(2026, 11, 1, 11))).not.toHaveProperty('isNewInstall');
    const done = { ...two.usage, cur: [at(2026, 11, 1, 11), at(2026, 11, 1, 11) + 200000] as [number, number] };
    const three = beginSession(done, at(2026, 11, 2, 8), '1.0', '1');
    expect(usageFields(three.usage, at(2026, 11, 2, 8), at(2026, 11, 2, 8))).toMatchObject({
      totalSessionsCount: '3', distinctDaysUsed: '2', distinctDaysUsedLastMonth: '2', previousSessionSeconds: '200', averageSessionSeconds: '150' });
  });

  it('keeps a lifetime day counter beyond the 30 day window and drops sessions older than 90 days', () => {
    let usage = beginSession(undefined, at(2026, 1, 1), '1', '1').usage;
    for (const [m, d] of [[1, 2], [3, 1], [5, 1], [11, 15]] as [number, number][]) {
      usage = { ...usage, cur: [usage.cur![0], usage.cur![0] + 60000] };
      usage = beginSession(usage, at(2026, m, d), '1', '1').usage;
    }
    expect(usage.life).toBe(5); expect(usage.days).toEqual(['2026-11-15']);
    expect(usage.done.every(([end]) => end >= at(2026, 11, 15) - 90 * 86400000)).toBe(true);
    expect(usageFields(usage, at(2026, 11, 15), at(2026, 11, 15))).toMatchObject({ distinctDaysUsed: '5', distinctDaysUsedLastMonth: '1', totalSessionsCount: '5' });
    // The 30 day window includes today and the 29 days before it.
    const edge = beginSession({ ...usage, days: ['2026-10-16', '2026-10-17'] }, at(2026, 11, 15), '1', '1').usage;
    expect(edge.days).toEqual(['2026-10-17', '2026-11-15']);
  });

  it('reads only valid stored records', () => {
    expect(parseUsage(null)).toBeUndefined(); expect(parseUsage('{broken')).toBeUndefined(); expect(parseUsage('{"first":1}')).toBeUndefined();
    const usage = beginSession(undefined, at(2026, 11, 15), '1', '1').usage;
    expect(parseUsage(JSON.stringify(usage))).toEqual(usage);
    expect(localDay(at(2026, 11, 5))).toBe('2026-11-05');
  });

  it('carries the statistics in signals across simulated launches, idle sessions and a day change', async () => {
    const store = new UsageStorage();
    const first = await launch(store); first.client.track('a');
    vi.setSystemTime(at(2026, 11, 15, 12) + 60000); first.client.track('b');
    expect((await sent(first)).find(s => s.type === 'a')!.system).toMatchObject({ totalSessionsCount: '1', isNewInstall: 'true', firstSessionDate: '2026-11-15', distinctDaysUsed: '1' });
    expect((await sent(first)).find(s => s.type === 'b')!.system).toMatchObject({ sessionSeconds: '60' });
    // 31 minutes later the session id rotates and the previous session (60 s) is complete.
    vi.setSystemTime(at(2026, 11, 15, 12) + 60000 + 31 * 60000); first.client.track('c');
    await first.client.flush();
    const c = first.requests.flatMap((_, i) => first.signals(i)).find(s => s.type === 'c')!;
    expect(c.system).toMatchObject({ totalSessionsCount: '2', previousSessionSeconds: '60', averageSessionSeconds: '60', sessionSeconds: '0' });
    expect(c.system).not.toHaveProperty('isNewInstall');
    // A new process on the next day reads the stored record.
    vi.setSystemTime(at(2026, 11, 16, 9));
    const next = await launch(store); next.client.track('d');
    const d = (await sent(next)).find(s => s.type === 'd')!;
    expect(d.system).toMatchObject({ totalSessionsCount: '3', distinctDaysUsed: '2', distinctDaysUsedLastMonth: '2', firstSessionDate: '2026-11-15' });
  });

  it('gives the first signals after start, including ones tracked before init, the full set', async () => {
    const store = new UsageStorage(); const h = harness(store);
    h.client.track('before'); await h.start({ gzip: false, appName: 'Game', appBuildNumber: '42', appVersion: '1.2' }); h.client.track('after');
    const signals = await sent(h);
    for (const s of signals.filter(x => !x.type.startsWith('pulse.'))) {
      expect(s.system).toMatchObject({ totalSessionsCount: '1', firstSessionDate: '2026-11-15', appName: 'Game', appBuildNumber: '42', appVersion: '1.2' });
    }
    expect(signals.map(s => s.type)).toEqual(['pulse.new_install', 'pulse.session_started', 'before', 'after']);
  });

  it('keeps counting in memory, without throwing, when the statistics cannot be read or written', async () => {
    const store = new UsageStorage(); store.usageFailing = true; const h = await launch(store);
    h.client.track('x'); const signals = await sent(h);
    expect(signals.find(s => s.type === 'x')!.system).toMatchObject({ totalSessionsCount: '1' }); expect(store.text).toBeNull();
  });

  it('starts over from a damaged record', async () => {
    const store = new UsageStorage(); store.text = '{"first":'; const h = await launch(store);
    h.client.track('x'); expect((await sent(h)).find(s => s.type === 'x')!.system).toMatchObject({ totalSessionsCount: '1' });
  });
});

describe('automatic signals', () => {
  it('sends session_started once per session and new_install once, with no props and the debug flag', async () => {
    const store = new UsageStorage(); const h = await launch(store, { debug: true });
    h.client.track('a'); h.client.track('b'); vi.setSystemTime(Date.now() + 5 * 60000); h.client.track('c');
    const signals = await sent(h);
    expect(signals.filter(s => s.type === 'pulse.session_started')).toHaveLength(1);
    expect(signals.filter(s => s.type === 'pulse.new_install')).toHaveLength(1);
    expect(signals.filter(s => s.type === 'pulse.app_updated')).toHaveLength(0);
    expect(signals.filter(s => s.type.startsWith('pulse.')).every(s => s.debug && Object.keys(s.props).length === 0)).toBe(true);
    vi.setSystemTime(Date.now() + 31 * 60000); h.client.track('d');
    expect((await sent(h)).filter(s => s.type === 'pulse.session_started')).toHaveLength(2);
    expect((await sent(h)).filter(s => s.type === 'pulse.new_install')).toHaveLength(1);
  });

  it('does not repeat new_install on the next launch, and detects an update with the previous version and build', async () => {
    const store = new UsageStorage();
    const one = await launch(store, { appVersion: '1.0', appBuildNumber: '10' }); one.client.track('a'); await sent(one);
    const two = await launch(store, { appVersion: '1.0', appBuildNumber: '10' }); two.client.track('a');
    expect((await sent(two)).map(s => s.type)).toEqual(['pulse.session_started', 'a']);
    const three = await launch(store, { appVersion: '1.1', appBuildNumber: '10' }); three.client.track('a');
    const updated = (await sent(three)).find(s => s.type === 'pulse.app_updated')!;
    expect(updated.props).toEqual({ previousVersion: '1.0', previousBuild: '10' });
    const four = await launch(store, { appVersion: '1.1', appBuildNumber: '11' }); four.client.track('a');
    expect((await sent(four)).find(s => s.type === 'pulse.app_updated')!.props).toEqual({ previousVersion: '1.1', previousBuild: '10' });
    const five = await launch(store, { appVersion: '1.1', appBuildNumber: '11' }); five.client.track('a');
    expect((await sent(five)).some(s => s.type === 'pulse.app_updated')).toBe(false);
  });

  it('sends nothing when opted out, deletes the statistics, and starts afresh after opt-out is turned off', async () => {
    const store = new UsageStorage(); store.id = 'a'.repeat(32); store.value = '{"version":1,"optOut":true,"queue":[]}'; store.text = '{"first":"x"}';
    const off = await launch(store); off.client.track('x'); await off.client.flush();
    expect(off.requests).toHaveLength(0); expect(store.text).toBeNull();
    const h = await launch(new UsageStorage()); h.client.track('a'); await h.client.flush();
    h.client.optOut(true); await settle(); h.client.track('blocked');
    h.client.optOut(false); h.client.track('again'); await settle();
    const types = (await sent(h)).map(s => s.type);
    expect(types).not.toContain('blocked');
    expect(types.slice(-3)).toEqual(['pulse.new_install', 'pulse.session_started', 'again']);
  });

  it('sends none without a usage store, like a normal browser', async () => {
    const h = harness(new InstallStorage()); await h.start({ gzip: false }); h.client.track('x');
    const signals = await sent(h);
    expect(signals.map(s => s.type)).toEqual(['x']); expect(signals[0]!.system).not.toHaveProperty('totalSessionsCount');
  });
});

describe('web platform fields', () => {
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.231205.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
  const TABLET = ANDROID.replace(' Mobile', '');
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  function media(state: Record<string, boolean>) {
    return (query: string) => ({ matches: state[query.replace(/[()]/g, '')] ?? false });
  }
  function page(userAgent: string, extra: Record<string, unknown> = {}) {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', new Proxy({
      getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); },
    }, { ownKeys: () => [...values.keys()], getOwnPropertyDescriptor: (_t, k) => typeof k === 'string' && values.has(k) ? { value: values.get(k), enumerable: true, configurable: true } : undefined }));
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', documentElement: { lang: 'sr-Latn-RS' } });
    vi.stubGlobal('document', doc);
    const events = new EventTarget(); vi.stubGlobal('addEventListener', events.addEventListener.bind(events));
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['de-DE', 'en-US'], userAgent });
    vi.stubGlobal('screen', { width: 393, height: 852, orientation: { type: 'portrait-primary' } });
    vi.stubGlobal('devicePixelRatio', 3);
    vi.stubGlobal('getComputedStyle', () => ({ direction: 'ltr' }));
    for (const [k, v] of Object.entries(extra)) vi.stubGlobal(k, v);
    const bodies: { type: string; system: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { bodies.push(...JSON.parse(new TextDecoder().decode(init.body as Uint8Array))); return new Response('', { status: 202 }); }));
    const client = createPulse(browserPlatform());
    return { values, bodies, client, doc };
  }

  it('gives a native app wrapper the full set with exact values', async () => {
    const p = page(ANDROID, { Capacitor: { isNativePlatform: () => true }, navigator: { language: 'en-US', languages: ['de-DE', 'en-US'], userAgent: ANDROID, connection: { type: 'cellular' } },
      matchMedia: media({ 'prefers-color-scheme: dark': true, 'prefers-reduced-motion: reduce': true, 'prefers-contrast: more': true, 'inverted-colors: none': true }) });
    p.client.init('k', { gzip: false, appName: 'My Game', appBuildNumber: '7' }); p.client.track('x'); await p.client.flush();
    const system = p.bodies.find(s => s.type === 'x')!.system;
    expect(system).toMatchObject({
      platform: 'mobile', deviceType: 'phone', deviceModel: 'Pixel 8', targetEnvironment: 'capacitor',
      screenWidth: '393', screenHeight: '852', screenScale: '3', screenWidthPx: '1179', screenHeightPx: '2556', orientation: 'portrait',
      colorScheme: 'dark', reduceMotion: 'true', increaseContrast: 'true', invertColors: 'false', layoutDirection: 'ltr',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, utcOffsetMinutes: String(-new Date().getTimezoneOffset() || 0),
      language: 'sr', preferredLanguage: 'de', region: 'US', connectionType: 'cellular', appName: 'My Game', appBuildNumber: '7',
      totalSessionsCount: '1', isNewInstall: 'true', isDebugBuild: 'true' });
    expect(Object.keys(system)).not.toContain('architecture');
    expect(p.values.get('mightys-pulse:usage:k')).toContain('"total":1');
    expect(p.bodies.map(s => s.type)).toEqual(['pulse.new_install', 'pulse.session_started', 'x']);
  });

  it.each([
    ['Capacitor', ANDROID, { Capacitor: { isNativePlatform: () => true } }, 'capacitor'],
    ['Cordova', ANDROID.replace('; wv)', ')'), { cordova: {} }, 'cordova'],
    ['plain WebView', ANDROID, {}, 'webview'],
  ])('names the wrapper %s', (_n, ua, extra, expected) => {
    page(ua, extra);
    expect(browserInfo(navigator).targetEnvironment).toBe(expected);
  });

  it('reads device type from the user agent', () => {
    for (const [ua, type] of [[ANDROID, 'phone'], [TABLET, 'tablet'], [IPAD, 'tablet'], [DESKTOP, 'desktop'], ['', undefined]] as [string, string | undefined][]) {
      page(ua, { navigator: { language: 'en', userAgent: ua } });
      expect(browserInfo(navigator as Navigator, false).deviceType).toBe(type);
    }
  });

  it('maps the connection type and leaves out what the platform cannot give', () => {
    const info = (connection?: object) => { page(ANDROID, { Capacitor: { isNativePlatform: () => true }, navigator: { language: 'en', userAgent: ANDROID, ...(connection ? { connection } : {}) } }); return browserInfo(navigator as Navigator); };
    for (const [type, mapped] of [['wifi', 'wifi'], ['cellular', 'cellular'], ['ethernet', 'ethernet'], ['none', 'none'], ['bluetooth', 'other'], ['wimax', 'other']]) {
      expect(info({ type }).connectionType).toBe(mapped);
    }
    expect(info({ type: 'unknown' }).connectionType).toBeUndefined(); expect(info({}).connectionType).toBeUndefined(); expect(info().connectionType).toBeUndefined();
    // Without matchMedia there is no appearance, motion, contrast or inverted-colors value.
    expect(info().colorScheme).toBeUndefined(); expect(info().invertColors).toBeUndefined();
  });

  it('changes dynamic values between two signals when the state changes', async () => {
    const state: Record<string, boolean> = { 'prefers-color-scheme: dark': false, 'inverted-colors: none': true };
    let type = 'portrait-primary';
    const p = page(ANDROID, { Capacitor: { isNativePlatform: () => true }, matchMedia: (q: string) => media(state)(q),
      screen: { width: 393, height: 852, get orientation() { return { type }; } },
      navigator: { language: 'en', userAgent: ANDROID, get connection() { return { type: state.cell ? 'cellular' : 'wifi' }; } } });
    p.client.init('k', { gzip: false }); await settle(); p.client.track('one'); await p.client.flush();
    state['prefers-color-scheme: dark'] = true; state['inverted-colors: inverted'] = true; state.cell = true; type = 'landscape-primary';
    vi.setSystemTime(Date.now() + 10000); p.client.track('two'); await p.client.flush();
    const [one, two] = ['one', 'two'].map(t => p.bodies.find(s => s.type === t)!.system);
    expect(one).toMatchObject({ colorScheme: 'light', invertColors: 'false', connectionType: 'wifi', orientation: 'portrait', sessionSeconds: '0' });
    expect(two).toMatchObject({ colorScheme: 'dark', invertColors: 'true', connectionType: 'cellular', orientation: 'landscape', sessionSeconds: '10' });
  });

  it('sends only the browser subset in a normal browser, stores nothing and sends no automatic signal', async () => {
    const p = page(DESKTOP, { matchMedia: media({ 'prefers-color-scheme: dark': true }), navigator: { language: 'de-DE', languages: ['fr-FR'], userAgent: DESKTOP, connection: { type: 'wifi' } } });
    p.client.init('k', { gzip: false, appVersion: '2.0', appName: 'Site', appBuildNumber: '9' }); p.client.track('page'); await p.client.flush();
    expect(p.bodies.map(s => s.type)).toEqual(['page']);
    expect(Object.keys(p.bodies[0]!.system).sort()).toEqual(['appVersion', 'colorScheme', 'deviceType', 'increaseContrast', 'language', 'locale', 'osName', 'osVersion',
      'platform', 'preferredLanguage', 'reduceMotion', 'sdkName', 'sdkVersion', 'timeZone', 'utcOffsetMinutes'].sort());
    expect(p.bodies[0]!.system).toMatchObject({ platform: 'web', deviceType: 'desktop', language: 'sr', preferredLanguage: 'fr', colorScheme: 'dark', reduceMotion: 'false', increaseContrast: 'false' });
    expect([...p.values.keys()].filter(k => k.includes('usage') || k.includes('install'))).toEqual([]);
  });

  it('keeps wrapper statistics across launches and deletes them on opt-out', async () => {
    const p = page(ANDROID, { Capacitor: { isNativePlatform: () => true } });
    p.client.init('k', { gzip: false }); p.client.track('first'); await p.client.flush();
    vi.setSystemTime(Date.now() + 3600000);
    const again = createPulse(browserPlatform()); again.init('k', { gzip: false }); again.track('x'); await again.flush();
    expect(JSON.parse(p.values.get('mightys-pulse:usage:k')!).total).toBe(2);
    again.optOut(true); await settle(); await again.flush();
    expect(p.values.has('mightys-pulse:usage:k')).toBe(false);
  });

  it('keeps working when localStorage is blocked', async () => {
    const p = page(ANDROID, { Capacitor: { isNativePlatform: () => true } });
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } });
    p.client.init('k', { gzip: false }); p.client.track('x'); await p.client.flush();
    expect(p.bodies.find(s => s.type === 'x')!.system).toMatchObject({ totalSessionsCount: '1' });
  });
});

describe('hung transport', () => {
  it('is bounded by the request timeout, keeps signals queued, retries with backoff and delivers on recovery, without blocking', async () => {
    let hang = true; let calls = 0; const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      calls++;
      if (!hang) { bodies.push(Buffer.from(init.body as Uint8Array).toString('utf8')); return Promise.resolve(new Response('', { status: 202 })); }
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    }));
    const store = new UsageStorage();
    const h = harness(store);
    // Same core and storage, with the real fetch transport.
    const real = createPulse({ ...h.platform, transport: nodePlatform().transport });
    real.init('synthetic-key', { gzip: false }); await settle();
    const before = Date.now();
    real.track('kept'); const flushing = real.flush();
    expect(Date.now()).toBe(before); // track and flush returned without waiting for the network
    await vi.advanceTimersByTimeAsync(11999); expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200); await flushing;
    expect(store.value).toContain('"kept"');
    // Backoff: no new request right away.
    await vi.advanceTimersByTimeAsync(500); expect(calls).toBe(1);
    hang = false;
    await vi.advanceTimersByTimeAsync(400000); await real.flush();
    expect(bodies.join('')).toContain('"kept"');
  });
});
