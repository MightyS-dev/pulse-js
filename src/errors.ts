import { size, wellFormed } from './validation.js';

export type ErrorKind = 'crash' | 'error' | 'handled';

/** The `error` object of a `pulse.error` signal. With `errorDetail: 'typeOnly'` only `kind` and `type` are present. */
export interface ErrorInfo {
  kind: ErrorKind;
  type: string;
  message?: string;
  frames?: string[];
  symbolicated?: boolean;
}

const MARK = '<filtered>';
const H = '[\\da-f]{1,4}';
const G = `(${H}(:${H}){0,6})?`;
/**
 * Removes personal data from error text, in this order: emails, URL tails (query and fragment), UUIDs, IPv4, IPv6, runs of
 * six or more digits (hexadecimal literals such as 0x1234567 are kept whole), then directories of file URLs and of Unix and
 * Windows paths. Only the file name stays. In a frame, a line and column right after a file name are kept.
 */
export const scrub = (text: string, frame?: boolean): string => text
  .replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, MARK)
  .replace(/([\w+.-]+:\/\/[^\s?#]*)[?#]\S*/gi, `$1${MARK}`)
  .replace(/[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}/gi, MARK)
  .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, MARK)
  .replace(RegExp(`(?<![\\w:])((${H}:){7}${H}|${G}::${G})(?![\\w:])`, 'gi'), MARK)
  .replace(RegExp(`(?<!\\b0x[\\da-f]*|\\d${frame ? '|\\.[a-z\\d]{1,5}:(\\d+:)?' : ''})\\d{6,}`, 'gi'), MARK)
  .replace(/(file:\/\/[^\s/]*|(?<!\w)[a-z]:(?=\\)|(?<![\w/.:<>~-])(?=\/))[\\/](?=[^\s\\/])([^\s\\/]+[\\/])*/gi, '');

const cut = (text: string, limit: number): string => wellFormed(text.slice(0, limit));

/** Frames as `function file.js:line:col`: V8 (`at fn (url:l:c)`) and SpiderMonkey or JavaScriptCore (`fn@url:l:c`). */
function frames(stack: string): [string[], boolean] {
  const re = /^\s+at /m.test(stack) ? /^\s+at (?:(.+?) \()?(.+?)(?::(\d+))?(?::(\d+))?\)?$/gm : /^([^@\n]*)@(.+?)(?::(\d+))?(?::(\d+))?$/gm;
  const out: string[] = [];
  let short = 0;
  for (const [, fn = '', place = '', line, col] of stack.matchAll(re)) {
    // Only the file name: no scheme, host, directory, query or fragment. The filter keeps line and column after it.
    const base = place.split(/[?#]/)[0]!.split(/[\\/]/).pop()!;
    short += +(!!fn && fn.split('.').pop()!.length < 3);
    out.push(cut(scrub(`${fn && `${fn} `}${base}${line ? `:${line}${col ? `:${col}` : ''}` : ''}`, true), 300));
  }
  return [out.slice(0, 30), short * 2 > out.length];
}

/** Builds the `error` object for any thrown value. A value that throws on access makes the caller drop the signal. */
export function describeError(kind: ErrorKind, value: unknown, detail: 'full' | 'typeOnly'): ErrorInfo {
  const v = value as Record<string, string | undefined> | null;
  const known = v instanceof Object && (v instanceof Error || !!v.stack || !!v.message);
  const t = v === null ? 'null' : typeof v;
  const error: ErrorInfo = { kind, type: cut(known ? v.name || v.constructor.name : `${t[0]!.toUpperCase()}${t.slice(1)}Error`, 200) || 'Error' };
  if (detail === 'typeOnly') return error;
  const [list, minified] = frames(known ? String(v.stack ?? '') : '');
  const text = cut(scrub(cut(known ? String(v.message ?? '') : /^[sbn]/.test(t) ? String(value) : '', 4000)), 500);
  const full = Object.assign(error, text && { message: text }, { frames: list, symbolicated: !minified });
  // Within 16384 bytes: frames go from the bottom first, then the message.
  while (size(JSON.stringify(full)) > 16384 && list.pop()) { /* Next frame. */ }
  if (size(JSON.stringify(full)) > 16384) delete full.message;
  return full;
}

/** True for an `error` object this SDK could have written (the server checks every field again). */
export function validError(e: unknown): e is ErrorInfo {
  const x = e as ErrorInfo;
  return x instanceof Object && /^(crash|error|handled)$/.test(x.kind) && typeof x.type === 'string' && !!x.type && size(JSON.stringify(x)) < 16385;
}
