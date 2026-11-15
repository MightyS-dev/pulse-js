import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { vi } from 'vitest';
import { createPulse } from '../src/core.js';
import type { Platform, PulseOptions, Signal, Storage, TransportResponse } from '../src/types.js';

export class MemoryStorage implements Storage {
  value: string | null = null;
  history: string[] = [];
  async read(): Promise<string | null> { return this.value; }
  async write(value: string): Promise<void> { this.history.push(value); this.value = value; }
}

export async function settle(): Promise<void> {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}

export function harness(storage: Storage = new MemoryStorage()) {
  const requests: { body: Uint8Array; gzip: boolean; keepalive: boolean }[] = [];
  const responses: (TransportResponse | Error)[] = [];
  let hidden = (): void => {};
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
      hashUser: async raw => createHash('sha256').update(raw).digest('hex'),
      gzip: async body => new Uint8Array(gzipSync(body)),
      warn: vi.fn(),
    },
    storage: () => storage,
    transport: () => ({
      async send(body, gzip, keepalive) {
        requests.push({ body: new Uint8Array(body), gzip, keepalive });
        const response = responses.shift() ?? { status: 202 };
        if (response instanceof Error) throw response;
        return response;
      },
      cancel: vi.fn(),
    }),
    development: () => development,
    onHidden: callback => { hidden = callback; },
  };
  const client = createPulse(platform);
  return {
    client, platform, requests, responses, storage,
    hide: () => hidden(),
    setDevelopment(value: boolean) { development = value; },
    async start(options: PulseOptions = {}) { client.init('synthetic-app-key', options); await settle(); },
    signals(index = 0): Signal[] {
      const request = requests[index]!;
      return JSON.parse(new TextDecoder().decode(request.gzip ? gunzipSync(request.body) : request.body)) as Signal[];
    },
  };
}
