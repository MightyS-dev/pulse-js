import { createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { vi } from 'vitest';
import { createPulse } from '../src/core.js';
import type { Platform, PulseOptions, Signal, Storage, TransportResponse } from '../src/types.js';

// Existing tests count signal requests; the settings request is answered here without reaching their mocks.
const quiet = (fn: (...args: any[]) => unknown): typeof fn => new Proxy(fn, {
  apply: (target, self, args: unknown[]) => String(args[0]).endsWith('/api/v1/config') ? Promise.resolve(new Response('', { status: 404 })) : Reflect.apply(target, self, args),
});
const stub = vi.stubGlobal.bind(vi);
vi.stubGlobal = ((name: string, value: unknown) => stub(name, name === 'fetch' && typeof value === 'function' ? quiet(value as never) : value)) as typeof vi.stubGlobal;

export class MemoryStorage implements Storage {
  value: string | null = null;
  history: string[] = [];
  async read(): Promise<string | null> { return this.value; }
  async write(value: string): Promise<void> { this.history.push(value); this.value = value; }
}

/** A storage that also keeps the anonymous install id, like the Node and native app wrapper storages. */
export class InstallStorage extends MemoryStorage {
  id: string | null = null;
  failing = false;
  removed = 0;
  install = {
    read: async (): Promise<string | null> => { if (this.failing) throw new Error('unreadable'); return this.id; },
    write: async (value: string): Promise<void> => { if (this.failing) throw new Error('unwritable'); this.id = value; },
    remove: async (): Promise<void> => { this.removed++; this.id = null; },
  };
}

export async function settle(): Promise<void> {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}

export function harness(storage: Storage = new MemoryStorage()) {
  const requests: { body: Uint8Array; gzip: boolean; keepalive: boolean; batch?: string | undefined }[] = [];
  const responses: (TransportResponse | Error)[] = [];
  let hidden = (): void => {};
  const screens: ((name: string) => void)[] = [];
  let id = 0;
  let development = false;
  const platform: Platform = {
    clock: {
      now: () => Date.now(), random: () => 0.25,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    environment: {
      info: () => ({ platform: 'web', osName: 'Windows', osVersion: '', locale: 'sr-RS' }),
      sessionId: () => `session-${++id}`,
      installId: () => randomBytes(16).toString('hex'),
      hashUser: async raw => createHash('sha256').update(raw).digest('hex'),
      gzip: async body => new Uint8Array(gzipSync(body)),
      warn: vi.fn(),
    },
    storage: () => storage,
    transport: () => ({
      async send(body, gzip, keepalive, batch) {
        requests.push({ body: new Uint8Array(body), gzip, keepalive, batch });
        const response = responses.shift() ?? { status: 202 };
        if (response instanceof Error) throw response;
        return response;
      },
      cancel: vi.fn(),
    }),
    development: () => development,
    onHidden: callback => { hidden = callback; },
    screens: callback => { screens.push(callback); },
  };
  const client = createPulse(platform);
  return {
    client, platform, requests, responses, storage,
    hide: () => hidden(),
    screens,
    setDevelopment(value: boolean) { development = value; },
    async start(options: PulseOptions = {}) { client.init('synthetic-app-key', options); await settle(); },
    signals(index = 0): Signal[] {
      const request = requests[index]!;
      return JSON.parse(new TextDecoder().decode(request.gzip ? gunzipSync(request.body) : request.body)) as Signal[];
    },
  };
}
