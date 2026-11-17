import type { Rules } from './rules.js';
import { compareVersions } from './version.js';

/** What the SDK knows when it decides. */
export interface DecisionInput {
  rules: Rules | undefined;
  now: number;
  platform: string;
  appVersion: string;
  debug: boolean;
  /** `sdkName@sdkVersion` exactly as the SDK sends `system.sdkName` and `system.sdkVersion`. */
  sdk: string;
  fromCache: boolean;
  cacheAgeHours: number;
  /** How many times the user pressed Update and came back on the same app version. */
  updateReturns: number;
  playUpdateNotAvailable: boolean;
  /** The SDK can build a store link itself when `storeUrl` is missing. */
  canBuildStoreLink: boolean;
  suggestDismissedHoursAgo: number | undefined;
  shownAnnouncements: string[];
  justUpdated: boolean;
  whatsNewShown: boolean;
}

export type Main = 'normal' | 'updateSuggested' | 'updateRequired' | 'versionBlocked' | 'maintenance';
export interface Outcome { state: Main; allowContinue: boolean; banners: string[]; card: 'whatsNew' | 'announcement' | undefined }

export const NORMAL_OUTCOME: Outcome = { state: 'normal', allowContinue: true, banners: [], card: undefined };
export const CACHE_LOCK_HOURS = 30 * 24;
export const CACHE_MAINTENANCE_HOURS = 72;
export const SUGGEST_QUIET_HOURS = 24;
export const UPDATE_RETURNS_LIMIT = 3;
const HOUR = 3600000;
const MINUTE = 60000;

const covers = (platforms: string[] | undefined, platform: string): boolean => !platforms || platforms.includes(platform);

/**
 * The App Control decision, the same in every SDK. Doubt always means no lock: an incomparable version is never below a
 * minimum and never blocked, locking rules from a cache older than 30 days are ignored, and the loop guard turns a
 * required update into a suggestion whenever there is no way out.
 */
export function decide(input: DecisionInput): Outcome {
  const { rules } = input;
  if (!rules || rules.off || rules.disabled.includes(input.sdk)) return NORMAL_OUTCOME;
  const staleLocks = input.fromCache && input.cacheAgeHours > CACHE_LOCK_HOURS;
  const platformRule = rules.update[input.platform];
  const storeVersion = platformRule?.storeVersion;
  const aboveStore = storeVersion !== undefined && compareVersions(input.appVersion, storeVersion) === 1;
  const banners: string[] = [];
  let main: Main = 'normal';
  let allowContinue = true;

  // 2. Maintenance inside its window (from the cache never past 72 hours after the start), unless exempt.
  const maintenance = rules.maintenance;
  if (maintenance && covers(maintenance.platforms, input.platform)) {
    const inWindow = maintenance.startsAt <= input.now && input.now < maintenance.endsAt
      && (!input.fromCache || input.now < maintenance.startsAt + CACHE_MAINTENANCE_HOURS * HOUR);
    if (inWindow && !(maintenance.exemptAboveStore && aboveStore)) { main = 'maintenance'; allowContinue = false; }
    if (input.now < maintenance.startsAt && maintenance.startsAt - maintenance.headsUpMinutes * MINUTE <= input.now) banners.push('maintenanceUpcoming');
  }
  // 3. A blocked version.
  if (main === 'normal' && !staleLocks) {
    const entry = rules.blocked.find(b => compareVersions(input.appVersion, b.version) === 0 && covers(b.platforms, input.platform));
    if (entry) { main = 'versionBlocked'; allowContinue = entry.allowContinue; }
  }
  // 4. Below the minimum (review safe: a version above the store version never is), then the loop guard.
  const min = platformRule?.min;
  if (main === 'normal' && platformRule && min !== undefined && compareVersions(input.appVersion, min) === -1 && !aboveStore) {
    if (platformRule.mode === 'required') {
      if (!staleLocks) {
        const noWayOut = storeVersion !== undefined && (compareVersions(storeVersion, input.appVersion) ?? 1) <= 0
          || input.updateReturns >= UPDATE_RETURNS_LIMIT || input.playUpdateNotAvailable
          || platformRule.storeUrl === undefined && !input.canBuildStoreLink;
        if (noWayOut) main = 'updateSuggested'; else { main = 'updateRequired'; allowContinue = false; }
      }
    } else if (platformRule.mode === 'suggested') main = 'updateSuggested';
  }
  // 5. Suggested by latest.
  const latest = platformRule?.latest;
  if (main === 'normal' && platformRule?.mode === 'suggested' && latest !== undefined && compareVersions(input.appVersion, latest) === -1) main = 'updateSuggested';
  const dismissed = input.suggestDismissedHoursAgo;
  if (main === 'updateSuggested' && dismissed !== undefined && dismissed < SUGGEST_QUIET_HOURS) main = 'normal';
  if (main === 'updateSuggested') allowContinue = true;
  // Debug builds: every locking screen shows the test banner and Continue.
  if (input.debug && (main === 'maintenance' || main === 'versionBlocked' || main === 'updateRequired')) { banners.push('testBuild'); allowContinue = true; }
  // 6. At most one card: What's new first, then the announcement.
  let card: Outcome['card'];
  const news = rules.whatsNew;
  const note = rules.announcement;
  if (input.justUpdated && !input.whatsNewShown && news && compareVersions(input.appVersion, news.version) === 0) card = 'whatsNew';
  else if (note && input.now < note.until && covers(note.platforms, input.platform) && !input.shownAnnouncements.includes(note.id)) card = 'announcement';
  return { state: main, allowContinue, banners, card };
}
