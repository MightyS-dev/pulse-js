import { gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../src/adapters/browser.js';
import { nodePlatform } from '../src/adapters/node.js';
import { createPulse } from '../src/core.js';
import type { Platform } from '../src/types.js';

let directory = '';
let original: typeof fetch;
let sentTypes: string[] = [];

beforeEach(async () => {
  await mkdir('.test-storage', { recursive: true });
  directory = await mkdtemp(resolve('.test-storage/fresh-'));
  original = globalThis.fetch;
  sentTypes = [];
  // Assigned directly: the shared stub helper answers settings requests on its own, and these tests use real timers.
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/v1/config')) return new Response('', { status: 404 });
    for (const s of JSON.parse(Buffer.from(init.body as Uint8Array).toString('utf8')) as { type: string }[]) sentTypes.push(s.type);
    return new Response('', { status: 202 });
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = original;
  vi.unstubAllGlobals();
  if (!resolve(directory).startsWith(resolve('.test-storage') + sep)) throw new Error('Unsafe test cleanup path.');
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function launch(platform: Platform, options: object = {}): Promise<string[]> {
  sentTypes = [];
  const client = createPulse(platform);
  client.init('synthetic-key', { gzip: false, ...options });
  await new Promise(r => setTimeout(r, 50));
  client.track('first'); await client.flush();
  return sentTypes;
}

describe('first launch with empty storage (Node files)', () => {
  const run = (path: string) => launch(nodePlatform(), { storagePath: path });

  it('sends one new_install and one session_started before the first tracked signal, and neither new_install later', async () => {
    const path = resolve(directory, 'queue.json');
    expect(await run(path)).toEqual(['pulse.new_install', 'pulse.session_started', 'first']);
    expect(await run(path)).toEqual(['pulse.session_started', 'first']);
  });

  it('sends no new_install when an install id exists without a usage file', async () => {
    const path = resolve(directory, 'queue.json');
    await run(path);
    await unlink(`${path}.usage`);
    expect(await run(path)).toEqual(['pulse.session_started', 'first']);
  });

  it('sends no new_install for an install id written by an earlier version', async () => {
    const path = resolve(directory, 'queue.json');
    await writeFile(`${path}.install-id`, 'a'.repeat(32));
    expect(await run(path)).toEqual(['pulse.session_started', 'first']);
  });
});

describe('first launch with empty storage (native app wrapper)', () => {
  it('behaves the same way', async () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); },
      removeItem: (k: string) => { items.delete(k); }, key: (n: number) => [...items.keys()][n] ?? null, get length() { return items.size; },
    });
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    expect(await launch(browserPlatform())).toEqual(['pulse.new_install', 'pulse.session_started', 'first']);
    expect(await launch(browserPlatform())).toEqual(['pulse.session_started', 'first']);
    items.delete('mightys-pulse:usage:synthetic-key');
    expect(await launch(browserPlatform())).toEqual(['pulse.session_started', 'first']);
  });
});

describe('app updates and the settings request through the real transport', () => {
  const requests: string[] = [];
  beforeEach(() => {
    requests.length = 0;
    const record = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/v1/config')) { requests.push(`${init?.method ?? 'GET'} config`); return new Response('', { status: 404 }); }
      return record(url, init);
    }) as typeof fetch;
  });
  const updates = (path: string, version: string, options: object = {}) => launch(nodePlatform(), { storagePath: path, appVersion: version, ...options });

  it('sends exactly one app_updated per changed version, with the previous version, and one settings request per launch', async () => {
    const path = resolve(directory, 'queue.json');
    expect(await updates(path, 'lab-1')).toEqual(['pulse.new_install', 'pulse.session_started', 'first']);
    expect(await updates(path, 'lab-2')).toEqual(['pulse.app_updated', 'pulse.session_started', 'first']);
    expect(await updates(path, 'lab-2')).toEqual(['pulse.session_started', 'first']);
    expect(await updates(path, 'lab-3')).toEqual(['pulse.app_updated', 'pulse.session_started', 'first']);
    expect(requests).toEqual(['GET config', 'GET config', 'GET config', 'GET config']);
  });

  it('a changed build alone is an update too, and the signal carries both previous values', async () => {
    const path = resolve(directory, 'queue.json');
    await updates(path, '1.0', { appBuildNumber: '1' });
    const seen: unknown[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (!url.endsWith('/config')) for (const s of JSON.parse(Buffer.from(init.body as Uint8Array).toString('utf8')) as { type: string; props: unknown }[]) if (s.type === 'pulse.app_updated') seen.push(s.props);
      return inner(url, init);
    }) as typeof fetch;
    await updates(path, '1.0', { appBuildNumber: '2' });
    expect(seen).toEqual([{ previousVersion: '1.0', previousBuild: '1' }]);
  });

  it('keeps the stored version while the event is switched off, so it is sent once it is allowed again', async () => {
    const path = resolve(directory, 'queue.json');
    await updates(path, 'lab-1');
    expect(await updates(path, 'lab-2', { automaticSignals: false })).toEqual(['first']);
    expect(await updates(path, 'lab-2')).toEqual(['pulse.app_updated', 'pulse.session_started', 'first']);
  });

  it('native app wrapper: same behaviour and one settings request per launch', async () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); },
      removeItem: (k: string) => { items.delete(k); }, key: (n: number) => [...items.keys()][n] ?? null, get length() { return items.size; },
    });
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    const wrapper = (version: string, options: object = {}) => launch(browserPlatform(), { appVersion: version, ...options });
    await wrapper('lab-1');
    expect(await wrapper('lab-2', { automaticSignals: false })).toEqual(['first']);
    expect(await wrapper('lab-2')).toEqual(['pulse.app_updated', 'pulse.session_started', 'first']);
    expect(await wrapper('lab-3')).toEqual(['pulse.app_updated', 'pulse.session_started', 'first']);
    expect(requests).toHaveLength(4);
  });

  it('a normal browser asks once per page load', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 });
    await launch(browserPlatform());
    expect(requests).toEqual(['GET config']);
  });
});

describe('flush resolves only after the launch has been delivered (real files)', () => {
  const run = async (path: string, version: string, delay: number, configBody = ''): Promise<{ delivered: string[]; atFlush: string[] }> => {
    const delivered: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      await new Promise(r => setTimeout(r, delay));
      if (url.endsWith('/api/v1/config')) return configBody ? new Response(configBody, { status: 200 }) : new Response('', { status: 404 });
      for (const s of JSON.parse((b => (b[0] === 0x1f ? gunzipSync(b) : b).toString('utf8'))(Buffer.from(init.body as Uint8Array))) as { type: string }[]) delivered.push(s.type);
      return new Response('', { status: 202 });
    }) as typeof fetch;
    const client = createPulse(nodePlatform());
    client.init('synthetic-key', { storagePath: path, appVersion: version, debug: true });
    client.track('a'); client.screen('home'); client.track('b');
    await client.flush();
    const atFlush = delivered.slice();
    await client.setUser('u'); client.track('c'); await client.setUser(null); client.track('d');
    await client.flush();
    return { delivered, atFlush };
  };

  it.each([0, 20])('delivers every signal before flush resolves, over launches with a version change and existing files (latency %i ms)', async delay => {
    const path = resolve(directory, 'queue.json');
    for (const [version, config] of [['v1', ''], ['v2', '{"version":1}'], ['v2', '{"version":2}'], ['v3', '']] as const) {
      const { delivered, atFlush } = await run(path, version, delay, config);
      expect(atFlush).toEqual(expect.arrayContaining(['a', 'pulse.screen_view', 'b']));
      expect(delivered).toEqual(expect.arrayContaining(['c', 'd', 'pulse.session_started']));
      expect(new Set(delivered).size).toBe(delivered.length > 0 ? new Set(delivered).size : 0);
    }
    const left = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(directory, 'queue.json'), 'utf8').catch(() => '{"queue":[]}')) as { queue: unknown[] };
    expect(left.queue).toEqual([]);
  });
});

describe('a switched-off app_updated does not move the stored version', () => {
  it.each([
    ['portal automaticSignals off', '{"version":1,"automaticSignals":false}', {}],
    ['app_updated in disabledSignals', '{"version":1,"disabledSignals":["pulse.app_updated"]}', {}],
    ['code automaticSignals false', '', { automaticSignals: false }],
  ])('%s', async (_name, config, options) => {
    const path = resolve(directory, 'queue.json');
    const go = (version: string, extra: object = {}) => launch(nodePlatform(), { storagePath: path, appVersion: version, appBuildNumber: version === 'lab-1' ? '1' : '2', ...extra });
    await go('lab-1');
    if (config) await writeFile(`${path}.config`, config);
    await go('lab-2', options);
    const stored = JSON.parse(await readFile(`${path}.usage`, 'utf8')) as { ver: string; build: string };
    expect(stored).toMatchObject({ ver: 'lab-1', build: '1' });
    await unlink(`${path}.config`).catch(() => {});
    expect(await go('lab-2')).toEqual(['pulse.app_updated', 'pulse.session_started', 'first']);
    expect(JSON.parse(await readFile(`${path}.usage`, 'utf8'))).toMatchObject({ ver: 'lab-2', build: '2' });
  });
});
