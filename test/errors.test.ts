import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../src/adapters/browser.js';
import { describeError, scrub } from '../src/errors.js';
import { createPulse } from '../src/core.js';
import type { Signal } from '../src/types.js';
import { harness, InstallStorage, MemoryStorage, settle } from './helpers.js';

const run = promisify(execFile);

beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-11-16T08:00:00Z') }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const TABLE: [string, string, string][] = [
  ['email', 'failed for jane.doe+x@example.co.uk today', 'failed for <filtered> today'],
  ['url with query', 'GET https://other.invalid/v1/items?token=abc&id=7 failed', 'GET https://other.invalid/v1/items<filtered> failed'],
  ['url with fragment', 'see https://other.invalid/docs/page#section-2 now', 'see https://other.invalid/docs/page<filtered> now'],
  ['uuid', 'order 123e4567-e89b-12d3-a456-426614174000 missing', 'order <filtered> missing'],
  ['ipv4', 'connect to 172.16.1.20 refused', 'connect to <filtered> refused'],
  ['ipv6 full', 'peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 closed', 'peer <filtered> closed'],
  ['ipv6 compressed', 'peer fe80::1ff:fe23:4567:890a closed', 'peer <filtered> closed'],
  ['six digit run', 'account 1234567 not found', 'account <filtered> not found'],
  ['five digit run kept', 'code 12345 not found', 'code 12345 not found'],
  ['unix path', 'cannot read /srv/jane/data/state.db', 'cannot read state.db'],
  ['windows path', 'cannot read C:\\Users\\jane\\AppData\\state.db', 'cannot read state.db'],
  ['frame with path and line', 'checkout /srv/jane/work/cart.js:42:7', 'checkout cart.js:42:7'],
  ['hexadecimal literal kept', 'fault at 0x1234567 and 0xdeadbeef12345678', 'fault at 0x1234567 and 0xdeadbeef12345678'],
  ['digits next to a hexadecimal literal', 'id 9876543 at 0x1234567', 'id <filtered> at 0x1234567'],
  ['file url', 'opened file:///srv/jane/data/state.db ok', 'opened state.db ok'],
  ['time and plain slashes kept', 'at 10:30:45 a/b and a / b', 'at 10:30:45 a/b and a / b'],
  ['email before url', 'a@b.com and c@d.org', '<filtered> and <filtered>'],
];

describe('personal data filter', () => {
  it('keeps the line and column after a file name in a frame only', () => {
    expect(scrub('checkout app.js:1:234567', true)).toBe('checkout app.js:1:234567');
    expect(scrub('Cart.swift:1234567', true)).toBe('Cart.swift:1234567');
    expect(scrub('order 1234567 Cart.kt:42', true)).toBe('order <filtered> Cart.kt:42');
    expect(scrub('failed at app.js:1:234567')).toBe('failed at app.js:1:<filtered>');
  });
  it.each(TABLE)('%s', (_name, input, output) => { expect(scrub(input)).toBe(output); });
  it('has at least the twelve required cases and is stable when applied twice', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(12);
    for (const [, input] of TABLE) expect(scrub(scrub(input))).toBe(scrub(input));
  });
});

const CHROME = `TypeError: Cannot read properties of undefined (reading 'total')
    at checkout (https://shop.invalid/assets/app.js?v=3&user=jane:120:5)
    at async onClick (https://shop.invalid/assets/app.js:88:12)
    at https://shop.invalid/assets/vendor.js:1:123456
    at Object.<anonymous> (/srv/jane/work/server.js:9:3)
    at node:internal/modules/cjs/loader:1554:14`;
const FIREFOX = `checkout@https://shop.invalid/assets/app.js:120:5
onClick/<@https://shop.invalid/assets/app.js:88:12
@https://shop.invalid/assets/vendor.js:1:7`;
const SAFARI = `checkout@https://shop.invalid/assets/app.js:120:5
forEach@[native code]
global code@https://shop.invalid/assets/app.js:3:1`;

function frames(stack: string): string[] {
  return describeError('error', Object.assign(new Error('x'), { stack }), 'full').frames!;
}

describe('stack parsing', () => {
  it('reads Chrome and Node frames, keeping only file names and line:col', () => {
    expect(frames(CHROME)).toEqual([
      'checkout app.js:120:5', 'async onClick app.js:88:12', 'vendor.js:1:123456', 'Object.<anonymous> server.js:9:3', 'loader:1554:14',
    ]);
  });
  it('reads Firefox frames', () => {
    expect(frames(FIREFOX)).toEqual(['checkout app.js:120:5', 'onClick/<  app.js:88:12'.replace('  ', ' '), 'vendor.js:1:7']);
  });
  it('reads Safari frames', () => {
    expect(frames(SAFARI)).toEqual(['checkout app.js:120:5', 'forEach [native code]', 'global code app.js:3:1']);
  });
  it('is not confused by an email in a Chrome message header', () => {
    expect(frames('Error: mail a@b.com failed\n    at run (/x/y.js:1:2)')).toEqual(['run y.js:1:2']);
  });
  it('marks minified bundles as not symbolicated and readable ones as symbolicated', () => {
    const min = describeError('error', Object.assign(new Error('x'), { stack: 'Error: x\n    at a (https://x.invalid/a.js:1:2)\n    at t.b (https://x.invalid/a.js:1:9)\n    at Ln (https://x.invalid/a.js:1:20)' }), 'full');
    expect(min.symbolicated).toBe(false);
    expect(describeError('error', Object.assign(new Error('x'), { stack: CHROME }), 'full').symbolicated).toBe(true);
  });
  it('takes the type from name, then the constructor, and builds one for other values', () => {
    expect(describeError('error', new RangeError('r'), 'full').type).toBe('RangeError');
    class Custom extends Error { constructor() { super('c'); this.name = ''; } }
    expect(describeError('error', new Custom(), 'full').type).toBe('Custom');
    expect(describeError('error', 'text', 'full')).toMatchObject({ type: 'StringError', message: 'text' });
    expect(describeError('error', 42, 'full').type).toBe('NumberError');
    expect(describeError('error', { code: 1 }, 'full')).toMatchObject({ type: 'ObjectError', frames: [] });
    expect(describeError('error', null, 'full').type).toBe('NullError');
    expect(describeError('error', undefined, 'full').type).toBe('UndefinedError');
  });
  it('filters the message and every frame', () => {
    const error = describeError('error', Object.assign(new Error('bad jane@example.com 1234567'), { stack: 'Error\n    at f (/srv/jane/a.js:1:2)' }), 'full');
    expect(error.message).toBe('bad <filtered> <filtered>');
    expect(error.frames).toEqual(['f a.js:1:2']);
  });
});

describe('limits', () => {
  it('keeps at most 30 frames of 300 characters, a message of 500 and 16384 bytes', () => {
    const stack = `Error: x\n${Array.from({ length: 80 }, (_, n) => `    at ${'f'.repeat(400)}${n} (https://x.invalid/${'g'.repeat(400)}.js:${n}:1)`).join('\n')}`;
    const error = describeError('error', Object.assign(new Error('m'.repeat(900)), { stack }), 'full');
    expect(error.frames).toHaveLength(30);
    expect(error.frames!.every(f => f.length <= 300)).toBe(true);
    expect(error.message).toHaveLength(500);
    expect(new TextEncoder().encode(JSON.stringify(error)).byteLength).toBeLessThanOrEqual(16384);
  });
  it('trims frames from the bottom until multi-byte text fits in 16384 bytes', () => {
    const stack = `Error: x\n${Array.from({ length: 30 }, (_, n) => `    at ${'\u20ac'.repeat(290)}${n} (a.js:${n}:1)`).join('\n')}`;
    const error = describeError('error', Object.assign(new Error('\u20ac'.repeat(500)), { stack }), 'full');
    expect(new TextEncoder().encode(JSON.stringify(error)).byteLength).toBeLessThanOrEqual(16384);
    expect(error.frames!.length).toBeLessThan(30);
    expect(error.frames![0]!.startsWith('\u20ac')).toBe(true);
  });
});

async function lastError(h: ReturnType<typeof harness>): Promise<Signal[]> {
  await h.client.flush();
  return h.requests.flatMap((_r, n) => h.signals(n)).filter(s => s.type === 'pulse.error');
}

describe('client', () => {
  it('sends an error as a normal pulse.error signal with the error object next to props', async () => {
    const h = harness(); await h.start({ appVersion: '1.0' });
    h.fail('error', Object.assign(new TypeError('boom jane@example.com'), { stack: CHROME }));
    const [signal] = await lastError(h);
    expect(signal).toMatchObject({ type: 'pulse.error', props: {}, error: { kind: 'error', type: 'TypeError', message: 'boom <filtered>', symbolicated: true } });
    expect(signal!.error!.frames![0]).toBe('checkout app.js:120:5');
    expect(Object.keys(signal!).slice(0, 3)).toEqual(['type', 'props', 'error']);
  });
  it('typeOnly sends exactly kind and type', async () => {
    const h = harness(); await h.start({ errorDetail: 'typeOnly' });
    h.fail('crash', new Error('secret'));
    h.client.trackError(new RangeError('also secret'), { screen: 'cart' });
    const signals = await lastError(h);
    expect(signals.map(s => s.error)).toEqual([{ kind: 'crash', type: 'Error' }, { kind: 'handled', type: 'RangeError' }]);
    expect(signals[1]!.props).toEqual({ screen: 'cart' });
  });
  it('trackError sends kind handled with props, also with captureErrors false, and before init', async () => {
    const h = harness();
    h.client.trackError(new Error('early'));
    await h.start({ captureErrors: false });
    h.client.trackError(new Error('late'), { a: 1, b: true });
    const signals = await lastError(h);
    expect(signals.map(s => [s.error!.kind, s.error!.message])).toEqual([['handled', 'early'], ['handled', 'late']]);
    expect(signals[1]!.props).toEqual({ a: 1, b: 'true' });
  });
  it('captureErrors false installs nothing; the default installs once', async () => {
    const off = harness(); await off.start({ captureErrors: false });
    expect(off.installed).toBe(0);
    const on = harness(); await on.start();
    expect(on.installed).toBe(1);
  });
  it('allows at most 10 per session per type and counts again in a new session', async () => {
    const h = harness(); await h.start({ automaticSignals: false });
    for (let n = 0; n < 15; n++) h.fail('error', new TypeError('t'));
    for (let n = 0; n < 12; n++) h.client.trackError(new RangeError('r'));
    expect((await lastError(h)).map(s => s.error!.type).filter(t => t === 'TypeError')).toHaveLength(10);
    expect((await lastError(h)).filter(s => s.error!.type === 'RangeError')).toHaveLength(10);
    vi.setSystemTime(Date.now() + 31 * 60000);
    h.fail('error', new TypeError('t'));
    expect((await lastError(h)).filter(s => s.error!.type === 'TypeError')).toHaveLength(11);
  });
  it('is not an automatic signal: automaticSignals false and disabledSignals do not suppress it', async () => {
    const storage = new InstallStorage();
    const h = harness(storage);
    h.platform.transport = () => ({ send: vi.fn(), cancel: vi.fn(), async config() { return { status: 200, body: JSON.stringify({ version: 1, automaticSignals: false, disabledSignals: ['pulse.error'] }) }; } });
    await h.start({ automaticSignals: false });
    h.fail('error', new Error('x'));
    await settle();
    expect(storage.value ?? '').toContain('pulse.error');
  });
  it('stops after opt-out and starts again after opt-in', async () => {
    const h = harness(); await h.start();
    h.client.optOut(true);
    h.fail('error', new Error('x')); h.client.trackError(new Error('y'));
    expect(await lastError(h)).toEqual([]);
    h.client.optOut(false); await settle();
    h.fail('error', new Error('z'));
    expect((await lastError(h)).map(s => s.error!.message)).toEqual(['z']);
  });
  it('sends nothing from a crawler or automated browser', async () => {
    const h = harness(); h.platform.automated = () => true; await h.start();
    expect(h.installed).toBe(0);
    h.client.trackError(new Error('x'));
    expect(await lastError(h)).toEqual([]);
  });
  it('keeps working when storage fails, and never throws', async () => {
    const storage = new MemoryStorage();
    storage.write = async () => { throw new Error('disk'); };
    (storage as unknown as { flushSync: () => void }).flushSync = () => { throw new Error('disk'); };
    const h = harness(storage); await h.start();
    expect(() => { h.fail('crash', new Error('x'), true); h.fail('error', { get message(): string { throw new Error('no'); } }); h.client.trackError(Symbol('s')); }).not.toThrow();
    expect((await lastError(h)).length).toBeGreaterThanOrEqual(1);
  });
  it('writes the queue at once for a crash, and a stored error signal is loaded again', async () => {
    const storage = new MemoryStorage();
    const synced: string[] = [];
    (storage as unknown as { flushSync: (v: string) => void }).flushSync = v => { synced.push(v); };
    const h = harness(storage); await h.start({ automaticSignals: false });
    h.fail('crash', new TypeError('boom'), true);
    expect(synced).toHaveLength(1);
    const record = JSON.parse(synced[0]!) as { queue: Signal[] };
    expect(record.queue[0]).toMatchObject({ type: 'pulse.error', error: { kind: 'crash', type: 'TypeError', message: 'boom' } });
    const holder = new MemoryStorage(); holder.value = synced[0]!;
    const next = harness(holder);
    await next.start({ automaticSignals: false });
    expect((await lastError(next))[0]!.error).toMatchObject({ kind: 'crash', type: 'TypeError' });
  });
});

describe('a crash before the queue has loaded', () => {
  const crashing = (): InstanceType<typeof MemoryStorage> => {
    const storage = new MemoryStorage();
    (storage as unknown as { flushSync: (v: string, early?: boolean) => void }).flushSync = v => { storage.history.push('sync'); storage.value = v; };
    return storage;
  };
  it('writes the queue synchronously with an early marker, and the next start sends the crash', async () => {
    const storage = crashing();
    const h = harness(storage);
    h.client.init('synthetic-app-key', { automaticSignals: false }); // nothing has been awaited: storage is not read yet
    h.fail('crash', new TypeError('at start'), true);
    expect(storage.history).toEqual(['sync']);
    const record = JSON.parse(storage.value!) as { early?: boolean; queue: Signal[] };
    expect(record.early).toBe(true);
    expect(record.queue).toHaveLength(1);
    expect(record.queue[0]).toMatchObject({ type: 'pulse.error', error: { kind: 'crash', type: 'TypeError', message: 'at start' } });
    const next = harness(storage);
    await next.start({ automaticSignals: false });
    expect((await lastError(next))[0]!.error).toMatchObject({ kind: 'crash', type: 'TypeError' });
  });
  it('is dropped without sending when the stored choice is opted out', async () => {
    const storage = crashing();
    const first = harness(storage);
    first.client.init('synthetic-app-key', { automaticSignals: false });
    first.fail('crash', new Error('early'), true);
    expect(storage.value).toContain('early');
    const consent = { read: async () => JSON.stringify({ optOut: true }), write: async () => {} };
    (storage as unknown as { consent: typeof consent }).consent = consent;
    const next = harness(storage);
    await next.start({ automaticSignals: false });
    expect(await lastError(next)).toHaveLength(0);
  });
  it('is not lost when the process survives and the queue loads afterwards', async () => {
    const storage = crashing();
    const h = harness(storage);
    h.client.init('synthetic-app-key', { automaticSignals: false });
    h.fail('crash', new Error('survived'), true);
    await settle();
    const sent = await lastError(h);
    expect(sent.length).toBeGreaterThanOrEqual(1);
  });
  it('writes nothing for an error that is not a crash', () => {
    const storage = crashing();
    const h = harness(storage);
    h.client.init('synthetic-app-key', { automaticSignals: false });
    h.fail('error', new Error('x'));
    expect(storage.history).toEqual([]);
  });
});

describe('browser hooks', () => {
  function page() {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    const reports: [string, unknown][] = [];
    browserPlatform().errors!((kind, value) => { reports.push([kind, value]); });
    return { target, reports };
  }
  const event = (type: string, extra: object): Event => Object.assign(new Event(type, { cancelable: true }), extra);

  it('reports error events with event.error, else message, file and line', () => {
    const { target, reports } = page();
    const real = new Error('real');
    target.dispatchEvent(event('error', { error: real, message: 'x' }));
    target.dispatchEvent(event('error', { error: null, message: 'plain', filename: 'https://x.invalid/a.js?q=1', lineno: 4, colno: 9 }));
    expect(reports[0]).toEqual(['error', real]);
    expect(describeError('error', reports[1]![1], 'full')).toMatchObject({ type: 'Error', message: 'plain', frames: ['a.js:4:9'] });
  });
  it('reports unhandled rejections as errors and never prevents the default', () => {
    const { target, reports } = page();
    const rejection = event('unhandledrejection', { reason: 'nope' });
    target.dispatchEvent(rejection);
    expect(reports).toEqual([['error', 'nope']]);
    expect(rejection.defaultPrevented).toBe(false);
  });
  it('leaves other listeners alone and keeps them running', () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    const app = vi.fn();
    target.addEventListener('error', app);
    const seen = vi.fn();
    browserPlatform().errors!(seen);
    target.addEventListener('error', app);
    const e = event('error', { error: new Error('x') });
    target.dispatchEvent(e);
    expect(app).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(false);
    // window.onerror is never replaced.
    expect((globalThis as { onerror?: unknown }).onerror).toBeUndefined();
  });
  it('installs through the client only when captureErrors is on', async () => {
    const target = new EventTarget();
    const add = vi.fn(target.addEventListener.bind(target));
    vi.stubGlobal('addEventListener', add);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('navigator', { language: 'en-US', userAgent: 'Mozilla/5.0 Chrome/130.0 Safari/537.36' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 202 })));
    const off = createPulse(browserPlatform()); off.init('k', { captureErrors: false }); await settle();
    expect(add.mock.calls.filter(c => c[0] === 'error' || c[0] === 'unhandledrejection')).toHaveLength(0);
    const on = createPulse(browserPlatform()); on.init('k2'); await settle();
    expect(add.mock.calls.filter(c => c[0] === 'error' || c[0] === 'unhandledrejection')).toHaveLength(2);
  });
});

describe('Node process behaviour', () => {
  let dir = '';
  let bundle = '';
  beforeAll(async () => {
    vi.useRealTimers();
    dir = await mkdtemp(join(tmpdir(), 'pulse-errors-'));
    bundle = join(dir, 'pulse.mjs');
    await build({ entryPoints: ['src/node.ts'], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: bundle, logLevel: 'silent' });
  }, 60000);
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function child(name: string, body: string, withPulse = true) {
    const queue = join(dir, `${name}.queue`);
    const script = join(dir, `${name}.mjs`);
    await writeFile(script, `${withPulse ? `import { Pulse } from ${JSON.stringify(pathToFileURL(bundle).href)};\n` : ''}
${withPulse ? `Pulse.init('synthetic-app-key', { host: 'http://host.invalid', storagePath: ${JSON.stringify(queue)}, automaticSignals: false });\nawait new Promise(r => setTimeout(r, 300));\n` : ''}${body}`);
    const result = await run(process.execPath, [script], { cwd: dir, env: { ...process.env, HOME: dir } }).then(
      r => ({ code: 0, stdout: r.stdout, stderr: r.stderr }),
      (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
    const stored = await readFile(queue, 'utf8').then(t => (JSON.parse(t) as { queue: Signal[] }).queue.filter(s => s.type === 'pulse.error'), () => []);
    return { ...result, stored };
  }

  it('an uncaught exception still exits with the same code and message, and is stored as a crash', async () => {
    const control = await child('c1', "setTimeout(() => { throw new Error('boom at /srv/jane/app.js'); }, 0);", false);
    const withPulse = await child('p1', "setTimeout(() => { throw new Error('boom at /srv/jane/app.js'); }, 0);");
    expect(withPulse.code).toBe(1);
    expect(withPulse.code).toBe(control.code);
    expect(withPulse.stderr).toContain('Error: boom at /srv/jane/app.js');
    expect(withPulse.stored).toHaveLength(1);
    expect(withPulse.stored[0]!.error).toMatchObject({ kind: 'crash', type: 'Error', message: 'boom at app.js' });
  }, 30000);

  it('a throw right after init is stored as a crash, and the next process sends it', async () => {
    const queue = join(dir, 'early.queue');
    const first = join(dir, 'early1.mjs');
    await writeFile(first, `import { Pulse } from ${JSON.stringify(pathToFileURL(bundle).href)};\nPulse.init('synthetic-app-key', { host: 'http://host.invalid', storagePath: ${JSON.stringify(queue)}, automaticSignals: false });\nqueueMicrotask(() => { throw new Error('right at the start'); });`);
    const crashed = await run(process.execPath, [first], { cwd: dir, env: { ...process.env, HOME: dir } }).then(() => 0, (e: { code: number }) => e.code);
    expect(crashed).toBe(1);
    const stored = JSON.parse(await readFile(queue, 'utf8')) as { early?: boolean; queue: Signal[] };
    expect(stored.early).toBe(true);
    expect(stored.queue.filter(s => s.type === 'pulse.error')[0]!.error).toMatchObject({ kind: 'crash', type: 'Error', message: 'right at the start' });
    const second = join(dir, 'early2.mjs');
    await writeFile(second, `import { Pulse } from ${JSON.stringify(pathToFileURL(bundle).href)};\nimport { gunzipSync } from 'node:zlib';\nconst seen = [];\nglobalThis.fetch = async (url, init) => { if (init?.method === 'POST') { const raw = Buffer.from(init.body); seen.push(...JSON.parse((init.headers['Content-Encoding'] ? gunzipSync(raw) : raw).toString())); } return new Response('', { status: 202 }); };\nPulse.init('synthetic-app-key', { host: 'http://host.invalid', storagePath: ${JSON.stringify(queue)}, automaticSignals: false });\nawait new Promise(r => setTimeout(r, 300));\nawait Pulse.flush();\nconsole.log(JSON.stringify(seen.filter(s => s.type === 'pulse.error').map(s => s.error.kind)));`);
    const next = await run(process.execPath, [second], { cwd: dir, env: { ...process.env, HOME: dir } });
    expect(next.stdout.trim()).toBe('["crash"]');
  }, 30000);

  it('respects the application own uncaughtException listener: no exit, the app decides, crash still stored', async () => {
    const result = await child('p2', "process.on('uncaughtException', e => console.log('app handled ' + e.message));\nsetTimeout(() => { throw new Error('mine'); }, 0);\nawait new Promise(r => setTimeout(r, 200));\nconsole.log('still alive');");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('app handled mine');
    expect(result.stdout).toContain('still alive');
    expect(result.stored[0]!.error).toMatchObject({ kind: 'crash', message: 'mine' });
  }, 30000);

  it('an unhandled rejection keeps the default crash (same exit code as without Pulse) and is stored as error', async () => {
    const control = await child('c3', "Promise.reject(new TypeError('nope'));\nawait new Promise(r => setTimeout(r, 200));", false);
    const result = await child('p3', "Promise.reject(new TypeError('nope'));\nawait new Promise(r => setTimeout(r, 200));");
    expect(control.code).toBe(1);
    expect(result.code).toBe(control.code);
    expect(result.stderr).toContain('TypeError: nope');
    expect(result.stored[0]!.error).toMatchObject({ kind: 'error', type: 'TypeError' });
  }, 30000);

  it('adds an unhandledRejection listener only when the application has one, and Node default handling stays as the app set it', async () => {
    const result = await child('p4', "process.on('unhandledRejection', r => console.log('app saw ' + r.message));\nPulse.init('another-key', { host: 'http://host.invalid', storagePath: " + JSON.stringify(join('/tmp', 'unused')) + " });\nPromise.reject(new Error('rej'));\nawait new Promise(r => setTimeout(r, 200));\nconsole.log('ok ' + process.listenerCount('unhandledRejection'));");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('app saw rej');
  }, 30000);

  it('adds no unhandledRejection listener when the application has none', async () => {
    const result = await child('p5', "console.log('n=' + process.listenerCount('unhandledRejection') + ' u=' + process.listenerCount('uncaughtException') + ' m=' + process.listenerCount('uncaughtExceptionMonitor'));");
    expect(result.stdout).toContain('n=0 u=0 m=1');
  }, 30000);

  it('captureErrors false adds no process listener', async () => {
    const queue = join(dir, 'off.queue');
    const script = join(dir, 'off.mjs');
    await writeFile(script, `import { Pulse } from ${JSON.stringify(pathToFileURL(bundle).href)};\nPulse.init('k', { host: 'http://host.invalid', storagePath: ${JSON.stringify(queue)}, captureErrors: false });\nconsole.log(process.listenerCount('uncaughtExceptionMonitor'));`);
    const { stdout } = await run(process.execPath, [script], { cwd: dir, env: { ...process.env, HOME: dir } });
    expect(stdout.trim()).toBe('0');
  }, 30000);
});
