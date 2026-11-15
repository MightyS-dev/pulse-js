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
  // A lifecycle request can run beside a normal one; cancel aborts both.
  const active = new Set<AbortController>();
  return {
    async send(body, gzip, keepalive) {
      const current = new AbortController();
      active.add(current);
      // 12 seconds plus 1 second per 32000 bytes, so large bodies on slow links are not cut off early.
      const timeout = setTimeout(() => current.abort(), 12000 + (body.byteLength >> 5));
      try {
        const response = await getFetch()(`${host}/api/v1/signals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-App-Key': appKey, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) },
          body: body as Uint8Array<ArrayBuffer>,
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          keepalive,
          signal: current.signal,
        });
        return { status: response.status, body: await response.text(), retryAfter: response.headers.get('Retry-After') };
      } finally {
        clearTimeout(timeout);
        active.delete(current);
      }
    },
    cancel: () => active.forEach(controller => controller.abort()),
  };
}
