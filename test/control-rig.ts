import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { fetchTransport } from '../src/adapters/shared.js';
import { createPulse } from '../src/core.js';
import type { ControlItem, Platform, PulseOptions, Storage, SystemInfo } from '../src/types.js';

export const KEY = 'control-test-key';
export const ID = createHash('sha256').update(KEY).digest('hex').slice(0, 32);
export const WIRE = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 1, version: 1, off: false, update: {}, blocked: [], maintenance: null, announcement: null, whatsNew: null, texts: { custom: {} }, disabledSdkVersions: [], ...extra,
});

export interface Call { url: string; init: RequestInit & { headers?: Record<string, string> } }
export type Reply = (call: Call) => Response | Promise<Response>;

/** A memory place for the two App Control records of one app. */
export class Records {
  cache: string | null = null;
  local: string | null = null;
  failing = false;
  item(name: 'cache' | 'local'): ControlItem {
    return {
      read: async () => { if (this.failing) throw new Error('unreadable'); return this[name]; },
      write: async value => { if (this.failing) throw new Error('unwritable'); this[name] = value; },
    };
  }
}

export interface RigOptions {
  info?: Partial<SystemInfo>;
  app?: boolean;
  records?: Records;
  reply?: Reply;
  noControlStorage?: boolean;
  development?: boolean;
  platform?: Partial<Platform>;
}

/** Real transport and storage plumbing with a fake network, so every request the SDK makes is visible. */
export function rig(options: RigOptions = {}) {
  const calls: Call[] = [];
  const records = options.records ?? new Records();
  let reply: Reply = options.reply ?? (() => new Response(JSON.stringify(WIRE()), { status: 200 }));
  const fetcher = vi.fn(async (url: string, init: Call['init']) => {
    const call = { url: String(url), init };
    if (call.url.endsWith('/api/v1/config')) return new Response('', { status: 404 });
    if (call.url.includes('/api/v1/control/')) { calls.push(call); return reply(call); }
    return new Response('', { status: 202 });
  });
  let visible: (on: boolean) => void = () => {};
  const storage: Storage = {
    read: async () => null,
    write: async () => {},
    ...(options.noControlStorage ? {} : { control: () => ({ cache: records.item('cache'), local: records.item('local') }) }),
  };
  const platform: Platform = {
    clock: { now: () => Date.now(), random: () => 0.25, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
    environment: {
      info: () => ({ platform: 'web', osName: 'iOS', osVersion: '19', locale: 'en-US', ...options.info }),
      sessionId: () => 'session',
      installId: () => '0'.repeat(32),
      hashUser: async value => createHash('sha256').update(value).digest('hex'),
      gzip: async body => body,
      warn: vi.fn(),
    },
    storage: () => storage,
    transport: (key, host) => fetchTransport(key, host, () => fetcher as unknown as typeof fetch),
    development: () => options.development ?? false,
    onHidden: () => {},
    lifecycle: callback => { visible = callback; return true; },
    ...(options.app ? { wrapped: () => true } : {}),
    ...options.platform,
  };
  const client = createPulse(platform);
  return {
    client, calls, records, fetcher,
    setReply: (next: Reply) => { reply = next; },
    init: (extra: PulseOptions = {}) => client.init(KEY, { appVersion: '2.3.0', host: 'https://host.invalid', ...extra }),
    /** The page or app comes back to the front. */
    foreground: () => { visible(false); visible(true); },
    kind: async () => (await client.control.get()).kind,
  };
}

export const json = (body: unknown, status = 200): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
export const FIXED_NOW = Date.UTC(2026, 11, 1, 13, 30);
/** An update rule that asks for a newer version on iOS. */
export const REQUIRED = (extra: Record<string, unknown> = {}) => WIRE({
  update: { ios: { min: '2.4.0', latest: '2.4.0', mode: 'required', storeVersion: null, storeUrl: 'https://store.example.invalid/app/id123', ...extra } },
});
