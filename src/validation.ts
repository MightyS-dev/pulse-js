import { validError } from './errors.js';
import type { Signal, TrackOptions } from './types.js';

export const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
export const size = (value: string): number => encode(value).byteLength;
export const DAY = 86400000;
/** Every key a signal's system object may carry. */
const SYSTEM = ('platform osName osVersion locale appVersion appBuildNumber appName sdkName sdkVersion deviceModel deviceType architecture runtimeVersion '
  + 'isDebugBuild targetEnvironment screenWidth screenHeight screenScale screenWidthPx screenHeightPx orientation colorScheme layoutDirection '
  + 'timeZone utcOffsetMinutes language preferredLanguage region reduceMotion increaseContrast invertColors connectionType isNewInstall '
  + 'firstSessionDate totalSessionsCount distinctDaysUsed distinctDaysUsedLastMonth previousSessionSeconds averageSessionSeconds sessionSeconds '
  + 'foregroundsToday previousForegroundSeconds notificationPermission launchMs droppedAutomatic').split(' ');
/** Replaces lone surrogates with U+FFFD, as String.prototype.toWellFormed does, without requiring ES2024. */
export const wellFormed = (value: string): string =>
  value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, m => m[1] ? m : '�');

export function normalize(type: string, options: TrackOptions = {}, warn?: () => void): Pick<Signal, 'type' | 'props' | 'value'> | undefined {
  if (typeof type !== 'string') return;
  // Well-formed text first, so the UTF-16 and UTF-8 limits measure exactly what is sent.
  type = wellFormed(type);
  if (!type.trim() || type.length > 200 || !options || typeof options !== 'object') return;
  const value = options.value;
  if (value !== undefined && value !== null && !Number.isFinite(value)) return;
  const props: Signal['props'] = Object.create(null) as Signal['props'];
  const input = options.props;
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) return;
  for (const [raw, item] of Object.entries(input ?? {})) {
    const key = wellFormed(raw);
    if (typeof item === 'string') props[key] = wellFormed(item);
    else if (Number.isFinite(item)) props[key] = item as number;
    else if (typeof item === 'boolean') props[key] = String(item);
    else warn?.();
  }
  if (size(JSON.stringify(props)) > 8192) return;
  return { type, props, ...(value === undefined ? {} : { value }) };
}

export function validStored(input: unknown, now: number, age: number): input is Signal {
  try {
    const s = input as Signal;
    const { timestamp, sessionId, userHash, system } = s;
    const time = Date.parse(timestamp);
    const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 512;
    // Rebuild the record exactly as this SDK writes it; any extra, missing, reordered or retyped field differs.
    return text(sessionId) && !!sessionId && timestamp.endsWith('Z') && time >= now - age * DAY && time <= now + 3600000 &&
      (userHash === undefined || /^[a-f0-9]{64}$/.test(userHash)) && (s.error === undefined || validError(s.error)) && (s.heatmap === undefined || validHeatmap(s.heatmap)) && Object.values(system).every(text) &&
      SYSTEM.slice(0, 5).concat(SYSTEM.slice(7, 9)).every(k => k in system) && Object.keys(system).every(k => SYSTEM.includes(k)) &&
      JSON.stringify(s) === JSON.stringify({ ...normalize(s.type, s), error: s.error, heatmap: s.heatmap, timestamp, sessionId, ...(userHash === undefined ? {} : { userHash: '' + userHash }),
        debug: s.debug === true, system });
  } catch { return false; }
}

/** A stored heatmap object: the bounds of the contract. */
const validHeatmap = (h: NonNullable<Signal['heatmap']>): boolean => h.screen.length <= 128 && h.points.length > 0 && h.points.length <= 200
  && h.points.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 100000 && ['tap', 'rage', 'dead'].includes(p.kind));
