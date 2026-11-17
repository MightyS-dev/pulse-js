import type { Maintenance } from './rules.js';
import { LANGUAGES, TEXTS } from './texts.js';

const FALLBACK: Record<string, string> = { pt: 'pt-BR', zh: 'zh-Hans', sr: 'sr-Latn' };

/** The built-in language for the app's language first, then the system's, then English. */
export function pickLanguage(tags: readonly (string | undefined)[]): string {
  for (const raw of tags) {
    const tag = (raw ?? '').replace(/_/g, '-').trim().toLowerCase();
    if (!tag) continue;
    const exact = LANGUAGES.find(l => l.toLowerCase() === tag);
    if (exact) return exact;
    const primary = tag.split('-')[0]!;
    const found = FALLBACK[primary] ?? LANGUAGES.find(l => l.toLowerCase() === primary);
    if (found) return found;
  }
  return 'en';
}

export const textOf = (language: string, key: string): string => TEXTS[language]?.[key] ?? TEXTS.en?.[key] ?? '';

export interface Context {
  appName: string;
  appVersion: string;
  /** The tags the texts are read for, most preferred first. */
  tags: readonly (string | undefined)[];
  now: number;
}

/** Short time in the device zone, with the date when it is not today. */
export function shortTime(at: number, context: Context, tag: string | undefined): string {
  const day = (t: number): string => new Date(t).toDateString();
  const options: Intl.DateTimeFormatOptions = day(at) === day(context.now) ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' };
  try { return new Intl.DateTimeFormat(tag || undefined, options).format(at); }
  catch { return new Intl.DateTimeFormat(undefined, options).format(at); }
}

/** Fills {appName}, {version}, {startTime} and {endTime}. A missing app name reads "this app" (capitalised at the start of a text). */
export function fill(text: string, context: Context, version: string | undefined, maintenance: Maintenance | undefined): string {
  if (!text.includes('{')) return text;
  const tag = context.tags.find(t => t && t.trim());
  const named = context.appName.trim();
  const out = text
    .replaceAll('{appName}', named || 'this app')
    .replaceAll('{version}', version ?? context.appVersion)
    .replaceAll('{startTime}', maintenance ? shortTime(maintenance.startsAt, context, tag) : '')
    .replaceAll('{endTime}', maintenance ? shortTime(maintenance.endsAt, context, tag) : '');
  return !named && text.startsWith('{appName}') ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}
