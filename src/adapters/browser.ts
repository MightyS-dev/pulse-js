import { fetchTransport, realClock, resilientStorage } from './shared.js';
import type { Platform, Storage, SystemInfo } from '../types.js';

interface CoarseNavigator extends Omit<Navigator, 'connection'> {
  userAgentData?: { platform?: string };
}

/** A queue record whose page has not written for two hours, or that unloaded for good, may be adopted. */
export const LEASE = 7200000;

/**
 * True inside an iOS or Android app that shows a web page (a wrapped web game or app), from positive evidence only.
 * There the page's storage belongs to the app. An ordinary browser never matches.
 */
export function inWrapper(win: Record<string, any> = globalThis, ua: string = win.navigator?.userAgent ?? ''): boolean {
  try {
    return win.Capacitor?.isNativePlatform?.() === true || win.cordova !== undefined || ua.includes('; wv)')
      || (!!win.webkit?.messageHandlers && !ua.includes('Safari/'));
  } catch { return false; }
}

const media = (query: string): boolean | undefined => {
  try { return globalThis.matchMedia?.(query)?.matches; } catch { return undefined; }
};
const text = (value: unknown): string | undefined => value === undefined || value === null || value === '' ? undefined : String(value);

/** True only in a development build; the bundler replaces the expression. A production bundle drops the check. */
function developmentBuild(): boolean {
  // The expression is written out twice so that a minifier can fold each comparison after the replacement.
  try { return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'; } catch { return false; }
}

/**
 * A normal browser gives only a small set of coarse values (no screen size, no connection type, nothing that helps
 * to recognize a device). Inside a native app wrapper the full set the web platform offers is added.
 */
export function browserInfo(nav: CoarseNavigator | undefined, wrapped = inWrapper(globalThis, nav?.userAgent ?? '')): SystemInfo {
  // Do not request high-entropy Client Hints or collect browser versions.
  const ua = nav?.userAgent ?? '';
  let osName = nav?.userAgentData?.platform ?? '';
  let osVersion = '';
  // First match wins: Android user agents also mention Linux. Only major OS versions are read.
  for (const [name, test, version] of [['Android', 'Android', /Android (\d+)/], ['iOS', 'iP(hone|ad|od)', /OS (\d+)/],
    ['Windows'], ['macOS', 'Macintosh'], ['Linux']] as [string, string?, RegExp?][]) {
    if (RegExp(test ?? name).test(ua)) { osName ||= name; osVersion = version?.exec(ua)?.[1] ?? ''; break; }
  }
  // The device model is read only inside an app wrapper: the Android model token, or iPhone or iPad.
  const deviceModel = !wrapped ? '' : /;\s*([^;)]+?)\s+Build\//.exec(ua)?.[1] ?? (/iPad/.test(ua) ? 'iPad' : /iP(hone|od)/.test(ua) ? 'iPhone' : '');
  const tag = (typeof document === 'undefined' ? '' : document.documentElement?.lang) || nav?.language || '';
  const language = tag.split('-')[0];
  const preferred = (nav?.languages?.[0] ?? nav?.language ?? '').split('-')[0];
  let zone: string | undefined;
  try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* No time zone data. */ }
  const deviceType = /iPad|Android(?!.*Mobile)/.test(ua) ? 'tablet' : /iP(hone|od)|Android/.test(ua) ? 'phone' : /Windows|Macintosh|X11|Linux/.test(ua) ? 'desktop' : undefined;
  const dark = media('(prefers-color-scheme: dark)');
  const flag = (value: boolean | undefined): string | undefined => value === undefined ? undefined : String(value);
  const info: SystemInfo = {
    platform: wrapped ? 'mobile' : 'web', osName, osVersion, locale: nav?.language ?? '', ...(deviceModel ? { deviceModel } : {}),
    language: text(language), preferredLanguage: text(preferred), timeZone: zone, utcOffsetMinutes: String(-new Date().getTimezoneOffset() || 0),
    colorScheme: dark === undefined ? undefined : dark ? 'dark' : 'light', deviceType,
    reduceMotion: flag(media('(prefers-reduced-motion: reduce)')), increaseContrast: flag(media('(prefers-contrast: more)')),
  };
  if (!wrapped) return info;
  const screen = globalThis.screen as Screen | undefined;
  const ratio = globalThis.devicePixelRatio;
  const kind = screen?.orientation?.type ?? '';
  const connection = (nav as { connection?: { type?: string } } | undefined)?.connection?.type;
  let direction = '';
  try { direction = getComputedStyle(document.documentElement).direction; } catch { /* No document. */ }
  const win = globalThis as unknown as Record<string, any>;
  return {
    ...info,
    region: /-([A-Za-z]{2})(?:-|$)/.exec(nav?.language ?? '')?.[1]?.toUpperCase(),
    screenWidth: text(screen?.width), screenHeight: text(screen?.height),
    screenScale: ratio > 0 ? String(Math.round(ratio * 1000) / 1000) : undefined,
    screenWidthPx: screen && ratio > 0 ? String(Math.round(screen.width * ratio)) : undefined,
    screenHeightPx: screen && ratio > 0 ? String(Math.round(screen.height * ratio)) : undefined,
    orientation: kind.startsWith('portrait') ? 'portrait' : kind.startsWith('landscape') ? 'landscape'
      : media('(orientation: portrait)') ? 'portrait' : media('(orientation: landscape)') ? 'landscape' : undefined,
    invertColors: media('(inverted-colors: none)') || media('(inverted-colors: inverted)') ? flag(media('(inverted-colors: inverted)')) : undefined,
    layoutDirection: direction === 'ltr' || direction === 'rtl' ? direction : undefined,
    connectionType: !connection || connection === 'unknown' ? undefined : ['wifi', 'cellular', 'ethernet', 'none'].includes(connection) ? connection : 'other',
    targetEnvironment: win.Capacitor?.isNativePlatform?.() === true ? 'capacitor' : win.cordova !== undefined ? 'cordova' : 'webview',
    isDebugBuild: String(developmentBuild()),
  };
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
  const key = `mightys-pulse:install:${appKey}`;
  const usage = `mightys-pulse:usage:${appKey}`;
  return resilientStorage({
    // Only inside an app wrapper does the page's storage belong to the app; a normal browser stores no identifier.
    ...(inWrapper() ? { install: {
      read: async () => local().getItem(key),
      write: async (id: string) => { local().setItem(key, id); },
      remove: async () => { local().removeItem(key); },
    }, usage: {
      read: async () => local().getItem(usage),
      write: async (value: string) => { local().setItem(usage, value); },
      remove: async () => { local().removeItem(usage); },
    } } : {}),
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
      installId: () => hex(globalThis.crypto.getRandomValues(new Uint8Array(16))),
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
    development: developmentBuild,
    onHidden(callback) {
      if (typeof document === 'undefined') return;
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') callback(); });
      addEventListener('pagehide', callback);
    },
  };
}
