import type { Clock, Storage, Transport } from '../types.js';

export const realClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout(callback, delay) {
    const timer = setTimeout(callback, delay);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Keeps the latest queue record in memory when backing storage fails. A failed write is retried on the next
 * write; a record that could not be read is never overwritten. Consent, claim and watch pass through unchanged.
 */
export function resilientStorage(backing: Storage): Storage {
  let memory: string | null = null;
  let unreadable = false;
  let written = false;
  return {
    ...backing,
    async read() {
      if (!unreadable && !written) {
        try { memory = await backing.read(); } catch { unreadable = true; }
      }
      return memory;
    },
    async write(value) {
      memory = value;
      written = true;
      if (!unreadable) {
        try { return await backing.write(value); } catch { /* Memory holds the state until a later write succeeds. */ }
      }
    },
  };
}

export function fetchTransport(appKey: string, host: string, getFetch: () => typeof fetch): Transport {
  // A lifecycle request can run beside a normal one; cancel aborts all of them.
  const active = new Set<AbortController>();
  async function request<T>(path: string, ms: number, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
    const current = new AbortController();
    active.add(current);
    const timeout = setTimeout(() => current.abort(), ms);
    try {
      return await read(await getFetch()(`${host}/api/v1/${path}`, {
        ...init, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: current.signal,
        headers: { 'X-App-Key': appKey, ...init.headers as object },
      }));
    } finally {
      clearTimeout(timeout);
      active.delete(current);
    }
  }
  return {
    // 12 seconds plus 1 second per 32000 bytes, so large bodies on slow links are not cut off early.
    send: (body, gzip, keepalive, batch) => request('signals', 12000 + (body.byteLength >> 5), {
      method: 'POST', body: body as Uint8Array<ArrayBuffer>, keepalive,
      headers: { 'Content-Type': 'application/json', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}), ...(batch ? { 'X-Pulse-Batch': batch } : {}) },
    }, async response => ({ status: response.status, body: await response.text(), retryAfter: response.headers.get('Retry-After') })),
    config: version => request('config', 10000, { headers: version ? { 'If-None-Match': `"${version}"` } : {} },
      async response => response.status === 200 ? { status: 200, body: await response.text() } : { status: response.status }),
    cancel: () => active.forEach(controller => controller.abort()),
  };
}
