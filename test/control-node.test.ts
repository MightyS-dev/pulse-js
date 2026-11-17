import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nodeInfo, nodePlatform } from '../src/adapters/node.js';
import { fetchTransport } from '../src/adapters/shared.js';
import { platformKey } from '../src/control/engine.js';
import { createPulse } from '../src/core.js';
import { WIRE } from './control-rig.js';

const KEY = 'node-control-key';
const ID = createHash('sha256').update(KEY).digest('hex').slice(0, 32);
const OS = platformKey(nodeInfo(), false);
let directory = '';
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'pulse-control-node-')); });
afterEach(async () => { vi.unstubAllGlobals(); await new Promise(done => setTimeout(done, 60)); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

const rules = (extra: Record<string, unknown>) => WIRE(extra);
/** The remembered state is written in the background, so a test waits for the file instead of assuming it is there. */
async function untilFiles(folder: string, names: string[]): Promise<string[]> {
  for (let n = 0; n < 100; n++) {
    const files = await readdir(folder).catch(() => [] as string[]);
    if (names.every(name => files.includes(name))) return files;
    await new Promise(done => setTimeout(done, 20));
  }
  return readdir(folder).catch(() => []);
}
const update = (rule: Record<string, unknown>) => rules({ update: { [OS]: { min: '2.0.0', latest: '2.0.0', mode: 'required', storeVersion: null, storeUrl: null, ...rule } } });

function node(answer: unknown, options: Record<string, unknown> = {}) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/v1/config')) return new Response('', { status: 404 });
    if (url.includes('/api/v1/control/')) { urls.push(url); return new Response(JSON.stringify(answer), { status: 200 }); }
    return new Response('', { status: 202 });
  }));
  const client = createPulse(nodePlatform());
  client.init(KEY, { storagePath: join(directory, 'queue.json'), appVersion: '1.0.0', host: 'https://host.invalid', debug: false, ...options });
  return { client, urls };
}

describe('App Control in Node.js (no screen, the state is read with await Pulse.control.get())', () => {
  it('a required update with a store link is read from the state', async () => {
    const { client, urls } = node(update({ storeUrl: 'https://example.invalid/download' }));
    const state = await client.control.get();
    expect(state).toMatchObject({ kind: 'updateRequired', title: 'Update required', url: 'https://example.invalid/download', version: '2.0.0', allowContinue: false });
    expect(urls).toEqual([`https://host.invalid/api/v1/control/${ID}`]);
  });

  it('a tool without any store link gets a suggestion instead of a lock (the loop guard)', async () => {
    const { client } = node(update({}));
    expect((await client.control.get()).kind).toBe('updateSuggested');
  });

  it('a version at or above the minimum is normal', async () => {
    const { client } = node(update({ min: '1.0.0', latest: '1.0.0', storeUrl: 'https://example.invalid/download' }));
    expect((await client.control.get()).kind).toBe('normal');
  });

  it('maintenance and an announcement reach a CLI tool as state', async () => {
    const maintenance = node(rules({ maintenance: { startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 3600000).toISOString(), headsUpMinutes: 0, exemptAboveStore: false, platforms: null } }));
    expect((await maintenance.client.control.get()).kind).toBe('maintenance');
  });

  it('subscribe, dismiss and openStore are safe without a screen', async () => {
    const { client } = node(update({ storeUrl: 'https://example.invalid/download' }));
    const seen: string[] = [];
    const stop = client.control.subscribe(state => seen.push(state.kind));
    await client.control.get();
    expect(() => { client.control.openStore(); client.control.dismiss(); stop(); }).not.toThrow();
    expect((await client.control.get()).kind).toBe('updateRequired');
  });

  it('keeps its two small files next to the queue file and reads them back at the next start', async () => {
    const first = node(update({ storeUrl: 'https://example.invalid/download' }));
    await first.client.control.get();
    const files = await untilFiles(directory, ['queue.json.control', 'queue.json.control-local']);
    expect(files).toContain('queue.json.control');
    expect(files).toContain('queue.json.control-local');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const second = createPulse(nodePlatform());
    second.init(KEY, { storagePath: join(directory, 'queue.json'), appVersion: '1.0.0', host: 'https://host.invalid', debug: false });
    expect((await second.control.get()).kind).toBe('updateRequired');
  });

  it('in the default layout the files are named with the first 16 hex characters of the hash of the key', async () => {
    const home = join(directory, 'home');
    const previous = [process.env.HOME, process.env.USERPROFILE];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/api/v1/control/') ? new Response(JSON.stringify(update({ storeUrl: 'https://example.invalid/download' })), { status: 200 }) : new Response('', { status: 404 })));
      const client = createPulse(nodePlatform());
      client.init(KEY, { appVersion: '1.0.0', host: 'https://host.invalid' });
      await client.control.get();
      const hash = createHash('sha256').update(KEY).digest('hex').slice(0, 16);
      const files = await untilFiles(join(home, '.mightys-pulse'), [`control-${hash}`, `control-local-${hash}`]);
      expect(files).toContain(`control-${hash}`);
      expect(files).toContain(`control-local-${hash}`);
    } finally {
      if (previous[0] === undefined) delete process.env.HOME; else process.env.HOME = previous[0];
      if (previous[1] === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous[1];
    }
  });

  it('control "off" asks for nothing and the state is normal', async () => {
    const { client, urls } = node(update({ storeUrl: 'https://example.invalid/download' }), { control: 'off' });
    expect((await client.control.get()).kind).toBe('normal');
    await client.control.checkNow();
    expect(urls).toEqual([]);
  });
});

describe('the built Node entries load the control module from their own files', () => {
  const script = (entry: string, cjs: boolean) => [
    cjs ? `const { Pulse } = require(${JSON.stringify(entry)});` : `import { Pulse } from ${JSON.stringify(pathToFileURL(entry).href)};`,
    'globalThis.fetch = async url => {',
    '  if (String(url).includes("/api/v1/control/")) return new Response(JSON.stringify(JSON.parse(process.env.RULES)), { status: 200 });',
    '  return new Response("", { status: 404 });',
    '};',
    'Pulse.init("built-node-key", { storagePath: process.env.QUEUE, appVersion: "1.0.0", host: "https://host.invalid", debug: false });',
    'Pulse.control.get().then(state => { console.log(JSON.stringify({ kind: state.kind, url: state.url })); });',
  ].join('\n');

  it.each([['ESM', 'dist/node.js', 'mjs', false], ['CJS', 'dist/node.cjs', 'cjs', true]] as const)('%s: an update asked for by the rules is read from the state', async (_name, entry, extension, cjs) => {
    expect(existsSync(resolve(entry))).toBe(true);
    const file = join(directory, `run.${extension}`);
    await writeFile(file, script(resolve(entry), cjs));
    const env = { ...process.env, HOME: directory, USERPROFILE: directory, QUEUE: join(directory, `queue-${extension}.json`), RULES: JSON.stringify(update({ storeUrl: 'https://example.invalid/download' })) };
    const output = execFileSync(process.execPath, [file], { encoding: 'utf8', env }).trim();
    expect(JSON.parse(output)).toEqual({ kind: 'updateRequired', url: 'https://example.invalid/download' });
  });

  it('empty rules never touch the control module: the main bundles hold no screen text', () => {
    for (const name of ['dist/web.js', 'dist/web.cjs', 'dist/node.js', 'dist/node.cjs']) {
      const text = readFileSync(resolve(name), 'utf8');
      expect(text, name).not.toContain('Down for maintenance');
      expect(text, name).not.toContain('attachShadow');
    }
    expect(readFileSync(resolve('dist/web.js'), 'utf8')).toContain('./control.js');
    expect(readFileSync(resolve('dist/web.cjs'), 'utf8')).toContain('./control.cjs');
    expect(readFileSync(resolve('dist/control.js'), 'utf8')).toContain('Down for maintenance');
  });
});

describe('the App Control timers never keep Node.js alive', () => {
  it('the 3 s and 5 s timers of the request are unref\'d; the settings request keeps its normal timer', async () => {
    const timers: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => { const t = real(fn, ms); timers.push(t); return t; }) as typeof setTimeout);
    const hang = vi.fn(() => new Promise<Response>(() => {}));
    const transport = fetchTransport('key', 'https://host.invalid', () => hang as unknown as typeof fetch);
    void transport.control!(ID);
    await Promise.resolve();
    expect(timers.length).toBe(2);
    expect(timers.map(t => t.hasRef())).toEqual([false, false]);
    void transport.config!();
    await Promise.resolve();
    expect(timers.length).toBe(3);
    expect(timers[2]!.hasRef()).toBe(true);
    timers.forEach(t => clearTimeout(t));
  });

  it('a short-lived script ends at once while the control request hangs (built ESM entry)', async () => {
    const file = join(directory, 'hang.mjs');
    await writeFile(file, [
      `import { Pulse } from ${JSON.stringify(pathToFileURL(resolve('dist/node.js')).href)};`,
      'globalThis.fetch = async url => {',
      '  if (String(url).includes("/api/v1/control/")) return new Promise(() => {});',
      '  return new Response("", { status: 404 });',
      '};',
      'Pulse.init("hang-node-key", { storagePath: process.env.QUEUE, appVersion: "1.0.0", host: "https://host.invalid" });',
    ].join('\n'));
    const started = Date.now();
    execFileSync(process.execPath, [file], { encoding: 'utf8', env: { ...process.env, HOME: directory, USERPROFILE: directory, QUEUE: join(directory, 'queue-hang.json') }, timeout: 15000 });
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe('the code of App Control never ends the app', () => {
  it.each(['control-main.ts', ...readdirSync(resolve('src/control')).map(f => `control/${f}`)])('%s has no exit, abort or quit', file => {
    const text = readFileSync(resolve('src', file), 'utf8');
    expect(text).not.toMatch(/process\.exit|process\.abort|\bexit\(|finishAffinity|Application\.Quit|window\.close/);
  });
});
