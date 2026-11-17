import { identity } from '../config.js';
import type { ControlEngine, ControlHost, ControlState, SystemInfo } from '../types.js';
import { CACHE_LOCK_HOURS, CACHE_MAINTENANCE_HOURS, SUGGEST_QUIET_HOURS, decide } from './decision.js';
import type { Outcome } from './decision.js';
import { EMPTY_LOCAL, MAX_IDS, decodeLocal, encodeLocal } from './local.js';
import type { Local } from './local.js';
import { parseRules } from './rules.js';
import type { Rules } from './rules.js';
import { NORMAL_STATE, buildState } from './state.js';
import type { Actions } from './ui.js';

/** What the engine needs from the place it runs in. Only the browser and app wrappers have a screen. */
export interface Io {
  /** Shows a state (or removes the screen for `normal`); absent in Node and in `manual` mode. */
  present?: ((state: ControlState, actions: Actions) => void) | undefined;
  /** Opens a store page or link. */
  open?: ((url: string) => void) | undefined;
  /** The languages for the texts, most preferred first. */
  tags(): (string | undefined)[];
  /** True on a touch screen (an iPad that reports itself as a Mac). */
  touch?: boolean | undefined;
}

const HOUR = 3600000;
const MINUTE = 60000;
const NEVER_ON_WEB = new Set(['updateRequired', 'updateSuggested', 'versionBlocked']);

/** The platform key of the rules. Inside an app wrapper it is the system the app runs on; a normal browser is `web`. */
export function platformKey(info: SystemInfo, app: boolean, touch = false): string {
  const os = (info.osName ?? '').toLowerCase();
  if (app) return os === 'ios' || os === 'macos' && touch ? 'ios' : os === 'android' ? 'android' : 'web';
  if (info.platform !== 'node') return 'web';
  return os === 'macos' || os === 'windows' || os === 'linux' ? os : 'other';
}

/** Keeps the current rules and the device's memory, decides, and shows. Nothing here can throw into the app. */
export async function createEngine(host: ControlHost, io: Io): Promise<ControlEngine> {
  const { clock, options } = host;
  const sdk = `${identity.sdkName}@${identity.version}`;
  let info: SystemInfo = { platform: 'web', osName: '', osVersion: '', locale: '' };
  try { info = host.env.info(); } catch { /* The platform key falls back to web. */ }
  const platform = platformKey(info, host.app, io.touch);
  let local: Local = EMPTY_LOCAL;
  try { local = decodeLocal(await host.local?.read()); } catch { /* A fresh memory. */ }
  let rules: Rules | undefined;
  let savedAt = 0;
  let fresh = false;
  let timer: unknown;
  let current: ControlState = NORMAL_STATE;
  let shown = JSON.stringify(NORMAL_STATE);
  const continued = new Set<string>();
  // `automatic` is the default: anything but `manual` shows the screens.
  const visible = host.mode === 'manual' ? undefined : io.present;

  const store = (next: Local): void => {
    local = next;
    try { void host.local?.write(encodeLocal(next)).catch(() => {}); } catch { /* Kept in memory for this run. */ }
  };
  // A new app version is an update (what's new); a press of Update is counted when the user comes back on the same version.
  if (options.appVersion && local.appVersion !== options.appVersion) {
    store(local.appVersion === undefined ? { ...local, appVersion: options.appVersion }
      : { ...local, appVersion: options.appVersion, updatedTo: options.appVersion, updateReturns: 0, pressPending: undefined });
  }

  const safe = (action: () => void): void => { try { action(); } catch { /* Never reaches the app. */ } };

  function evaluate(): void {
    if (!rules) return publish(NORMAL_STATE);
    const now = clock.now();
    const ageHours = Math.max(0, now - savedAt) / HOUR;
    const dismissedAgo = local.dismissedVersion === options.appVersion ? Math.max(0, now - local.dismissedAt) / HOUR : undefined;
    const news = rules.whatsNew?.version;
    let outcome: Outcome = decide({
      rules, now, platform, appVersion: options.appVersion, debug: options.debug, sdk, fromCache: !fresh || ageHours > 1, cacheAgeHours: ageHours,
      updateReturns: local.updateReturns, playUpdateNotAvailable: false, canBuildStoreLink: false, suggestDismissedHoursAgo: dismissedAgo,
      shownAnnouncements: local.shownAnnouncements, justUpdated: local.updatedTo === options.appVersion, whatsNewShown: news !== undefined && local.whatsNewShown === news,
    });
    if (continued.has(outcome.state)) outcome = { ...outcome, state: 'normal', banners: outcome.banners.filter(b => b !== 'testBuild') };
    if (continued.has('maintenanceUpcoming')) outcome = { ...outcome, banners: outcome.banners.filter(b => b !== 'maintenanceUpcoming') };
    publish(buildState(outcome, rules, { appName: options.appName, appVersion: options.appVersion, tags: io.tags(), now }, platform));
    boundary(rules, now);
  }

  /** The clock rules (maintenance window, heads-up, announcement end, cache limits, a quiet suggestion) apply on time, also offline. */
  function boundary(current: Rules, now: number): void {
    clock.clearTimeout(timer);
    timer = undefined;
    const times: number[] = [savedAt + HOUR, savedAt + CACHE_LOCK_HOURS * HOUR];
    const m = current.maintenance;
    if (m) times.push(m.startsAt - m.headsUpMinutes * MINUTE, m.startsAt, m.endsAt, m.startsAt + CACHE_MAINTENANCE_HOURS * HOUR);
    if (current.announcement) times.push(current.announcement.until);
    if (local.dismissedVersion === options.appVersion) times.push(local.dismissedAt + SUGGEST_QUIET_HOURS * HOUR);
    const next = Math.min(...times.filter(t => t > now));
    if (Number.isFinite(next)) timer = clock.setTimeout(() => safe(evaluate), Math.min(next - now + 1, HOUR));
  }

  function publish(next: ControlState): void {
    const text = JSON.stringify(next);
    if (text === shown) return;
    shown = text;
    current = next;
    host.shared.state = next;
    host.shared.listeners.forEach(listener => safe(() => listener(next)));
    // A plain web page never gets the update screens (reloading is the update); the state still says what the rules ask for.
    if (visible) safe(() => visible(host.app || !NEVER_ON_WEB.has(next.kind) ? next : NORMAL_STATE, { primary, secondary: dismiss }));
  }

  /** What the main button does for the state on screen. */
  function primary(): void {
    const s = current;
    if (s.kind === 'maintenance') void host.check().catch(() => {});
    else if (s.kind === 'whatsNew') dismiss();
    else { openStore(); if (s.kind === 'announcement') dismiss(); }
  }

  function openStore(): void {
    const s = current;
    if (!s.url) return;
    if (s.kind === 'updateRequired' || s.kind === 'updateSuggested' || s.kind === 'versionBlocked') store({ ...local, pressPending: options.appVersion });
    safe(() => io.open?.(s.url!));
  }

  /** Lets the user leave the current state where it allows that. Locking screens without `allowContinue` ignore it. */
  function dismiss(): void {
    const s = current;
    if (s.kind === 'normal' || !s.allowContinue && s.kind !== 'updateSuggested') return;
    if (s.kind === 'updateSuggested') store({ ...local, dismissedVersion: options.appVersion, dismissedAt: clock.now() });
    else if (s.kind === 'announcement') { if (rules?.announcement) store({ ...local, shownAnnouncements: [...local.shownAnnouncements, rules.announcement.id].slice(-MAX_IDS) }); }
    else if (s.kind === 'whatsNew') store({ ...local, whatsNewShown: s.version });
    else continued.add(s.kind);
    evaluate();
  }

  return {
    apply(raw, at, isFresh) {
      const parsed = parseRules(raw);
      if (!parsed || !Number.isFinite(at)) return false;
      rules = parsed;
      savedAt = at;
      fresh ||= isFresh;
      safe(evaluate);
      return true;
    },
    foreground() {
      safe(() => {
        // The user pressed Update and is back: on the same version this counts toward the loop guard.
        if (local.pressPending !== undefined) store({ ...local, pressPending: undefined, updateReturns: local.pressPending === options.appVersion ? local.updateReturns + 1 : 0 });
        evaluate();
      });
    },
    dismiss: () => safe(dismiss),
    openStore: () => safe(openStore),
  };
}
