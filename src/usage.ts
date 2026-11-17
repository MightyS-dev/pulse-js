import { DAY } from './validation.js';

/** Session statistics of one install. Times are epoch milliseconds, days are local dates (YYYY-MM-DD). */
export interface Usage {
  first: string;
  total: number;
  /** Distinct local days with a session in the last 30 days. */
  days: string[];
  /** Distinct local days with a session, lifetime. */
  life: number;
  /** Completed sessions of the last 90 days: [end, seconds]. */
  done: [number, number][];
  prev?: number;
  ver: string;
  build: string;
  /** The running session: [start, last activity]. */
  cur?: [number, number];
  /** Automatic signals queued today: [local day, count]. */
  q?: [string, number];
  /** Foregrounds today: [local day, count]. */
  fg?: [string, number];
  /** Seconds of the last foreground. */
  fgp?: number;
  /** The last notification permission seen. */
  perm?: string;
}

export const localDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const num = (v: unknown): boolean => Number.isFinite(v);
const dayCount = (v: unknown): boolean => v === undefined || (Array.isArray(v) && typeof v[0] === 'string' && num(v[1]));
const pair = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && v.every(num);

/** Reads a stored record; anything unexpected counts as no record. */
export function parseUsage(text: string | null): Usage | undefined {
  try {
    const u = JSON.parse(text ?? 'null') as Usage | null;
    if (u && typeof u.first === 'string' && num(u.total) && num(u.life) && Array.isArray(u.days) && Array.isArray(u.done)
      && u.done.every(pair) && typeof u.ver === 'string' && typeof u.build === 'string' && (!u.cur || pair(u.cur)) && dayCount(u.q) && dayCount(u.fg)) return u;
  } catch { /* Unreadable: start over. */ }
}

/** Registers a new session. Returns the new record and, when the app version or build changed, the previous values. */
export function beginSession(old: Usage | undefined, now: number, ver: string, build: string): { usage: Usage; changed?: [string, string] } {
  const u: Usage = old ? { ...old, days: [...old.days], done: [...old.done] } : { first: localDay(now), total: 0, days: [], life: 0, done: [], ver, build };
  if (u.cur) {
    const seconds = Math.max(0, Math.round((u.cur[1] - u.cur[0]) / 1000));
    u.done.push([u.cur[1], seconds]);
    u.prev = seconds;
  }
  u.done = u.done.filter(([end]) => end >= now - 90 * DAY);
  const today = localDay(now);
  if (!u.days.includes(today)) { u.days.push(today); u.life++; }
  const oldest = localDay(now - 29 * DAY);
  u.days = u.days.filter(d => d >= oldest);
  u.total++;
  u.cur = [now, now];
  const changed: [string, string] | undefined = old && (old.ver !== ver || old.build !== build) ? [old.ver, old.build] : undefined;
  u.ver = ver;
  u.build = build;
  return { usage: u, ...(changed ? { changed } : {}) };
}

/** The statistics fields of a signal sent at `at`. */
export function usageFields(u: Usage, at: number, started: number): Record<string, string> {
  const seconds = u.done.map(d => d[1]);
  return {
    firstSessionDate: u.first,
    totalSessionsCount: String(u.total),
    distinctDaysUsed: String(u.life),
    distinctDaysUsedLastMonth: String(u.days.length),
    sessionSeconds: String(Math.max(0, Math.round((at - started) / 1000))),
    ...(u.fg?.[0] === localDay(at) ? { foregroundsToday: String(u.fg[1]) } : {}),
    ...(u.fgp === undefined ? {} : { previousForegroundSeconds: String(u.fgp) }),
    ...(u.total === 1 ? { isNewInstall: 'true' } : {}),
    ...(u.prev === undefined ? {} : { previousSessionSeconds: String(u.prev) }),
    ...(seconds.length ? { averageSessionSeconds: String(Math.round(seconds.reduce((a, b) => a + b, 0) / seconds.length)) } : {}),
  };
}
