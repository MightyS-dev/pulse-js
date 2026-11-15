import { fetchTransport, realClock, resilientStorage } from './shared.js';
import type { Platform, Storage, SystemInfo } from '../types.js';

interface CoarseNavigator extends Navigator {
  userAgentData?: { platform?: string };
}

/** A queue record whose page has not written for two hours, or that unloaded for good, may be adopted. */
export const LEASE = 7200000;

export function browserInfo(nav: CoarseNavigator | undefined): SystemInfo {
  // Do not request high-entropy Client Hints or collect browser versions.
  const ua = nav?.userAgent ?? '';
  const hints = nav?.userAgentData?.platform;
  let osName = hints ?? '';
  let osVersion = '';
  // First match wins: Android user agents also mention Linux. Only major OS versions are read.
  if (!hints) {
    for (const [name, test, version] of [['Android', 'Android', /Android (\d+)/], ['iOS', 'iP(hone|ad|od)', /OS (\d+)/],
      ['Windows'], ['macOS', 'Macintosh'], ['Linux']] as [string, string?, RegExp?][]) {
      if (RegExp(test ?? name).test(ua)) { osName = name; osVersion = version?.exec(ua)?.[1] ?? ''; break; }
    }
  }
  return { platform: 'web', osName, osVersion, locale: nav?.language ?? '' };
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');

function random(): string {
  const bytes = new Uint8Array(16);
  // Uint8Array.map truncates the fallback's fractional values to bytes.
  return hex(globalThis.crypto?.getRandomValues?.(bytes) ?? bytes.map(() => Math.random() * 256));
}

/**
 * Each page owns one queue key, so tabs never overwrite each other's queues. Consent lives in one shared key that
 * only explicit optOut calls write, and storage events carry it to every tab. Application keys are public;
 * namespacing prevents cross-application reuse.
 */
export function browserStorage(appKey: string): Storage {
  const local = (): globalThis.Storage => localStorage;
  const record = `mightys-pulse:${appKey}`;
  const prefix = `${record}:q:`;
  const own = prefix + random();
  let written = false;
  let closed = false;
  let last = '';
  const put = (value: string): void => { local().setItem(own, `${closed ? 0 : Date.now()} ${value}`); };
  // A page that unloads for good (not into the back/forward cache) releases its queue to the next page at once.
  globalThis.addEventListener?.('pagehide', event => {
    closed = !(event as PageTransitionEvent).persisted;
    try { if (closed && written) put(last); } catch { /* Storage unavailable. */ }
  });
  return resilientStorage({
    // A new page never has a record yet; earlier pages' records are adopted through claim.
    read: async () => null,
    async write(value) {
      if (written && local().getItem(own) === null) { written = false; return false; }
      if (value.includes('"queue":[]')) { local().removeItem(own); written = false; }
      else { put(last = value); written = true; }
    },
    consent: {
      // Blocked storage cannot hold a record, so it reads as absent.
      async read() { try { return local().getItem(record); } catch { return null; } },
      write: async value => { local().setItem(record, value); },
    },
    async claim() {
      const store = local();
      const values: string[] = [];
      const moved: string[] = [];
      for (const key of Object.keys(store)) {
        const item = key.startsWith(prefix) && !key.startsWith(own) ? store.getItem(key) : null;
        if (item && !(Date.now() - parseInt(item) < LEASE)) {
          // One synchronous move under this page's name, so pages starting together do not adopt it twice. The moved
          // copy has a fresh lease and is removed once this page has stored the signals; a crash before that keeps it.
          const value = item.slice(item.indexOf(' ') + 1);
          const target = own + values.push(value);
          store.setItem(target, `${Date.now()} ${value}`);
          store.removeItem(key);
          moved.push(target);
        }
      }
      return { values, done: () => moved.forEach(key => store.removeItem(key)) };
    },
    watch(callback) {
      addEventListener('storage', event => { if (event.key === record) callback(event.newValue); });
    },
  });
}

export function browserPlatform(): Platform {
  return {
    clock: realClock,
    environment: {
      info: () => browserInfo(globalThis.navigator),
      sessionId: random,
      async hashUser(id) {
        return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))));
      },
      async gzip(body) {
        if (typeof CompressionStream !== 'function') return;
        const stream = new Blob([body as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
      warn: message => console.warn(message),
    },
    storage: browserStorage,
    transport: (appKey, host) => fetchTransport(appKey, host, () => fetch),
    development() {
      // Bundlers replace the exact expression process.env.NODE_ENV at build time. Without a replacement and without
      // a process global, the read throws and the default is real data. A production bundle drops the check.
      // The expression is written out twice so that a minifier can fold each comparison after the replacement.
      try { return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'; } catch { return false; }
    },
    onHidden(callback) {
      if (typeof document === 'undefined') return;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') callback(); });
      addEventListener('pagehide', callback);
    },
  };
}
