import type { ControlState } from '../types.js';
import type { Outcome } from './decision.js';
import type { Rules } from './rules.js';
import { fill, pickLanguage, textOf } from './strings.js';
import type { Context } from './strings.js';

export const NORMAL_STATE: ControlState = { kind: 'normal', allowContinue: true, isTestBuild: false };
const iso = (ms: number | undefined): string | undefined => ms === undefined ? undefined : new Date(ms).toISOString();

/** Turns a decision into the public state: texts in the right language, custom texts, times in the device zone. */
export function buildState(outcome: Outcome, rules: Rules, context: Context, platform: string): ControlState {
  const language = pickLanguage(context.tags);
  const kind = outcome.state !== 'normal' ? outcome.state : outcome.card ?? (outcome.banners.includes('maintenanceUpcoming') ? 'maintenanceUpcoming' : undefined);
  if (!kind) return NORMAL_STATE;
  const custom = rules.custom[kind];
  const rule = rules.update[platform];
  const maintenance = rules.maintenance;
  const note = rules.announcement;
  const news = rules.whatsNew;
  const storeUrl = rule?.storeUrl;
  const version = kind === 'whatsNew' ? news?.version : rule?.storeVersion ?? rule?.latest ?? rule?.min;
  const t = (key: string): string => textOf(language, key);
  const f = (text: string | undefined): string | undefined => text === undefined ? undefined : fill(text, context, version, maintenance);
  const pick = (own: string | undefined, key?: string): string | undefined => f(own ?? (key ? t(key) : undefined));
  const secondary = outcome.allowContinue ? f(t(kind === 'updateSuggested' ? 'updateSuggested.dismiss' : 'continue')) : undefined;

  let state: ControlState;
  switch (kind) {
    case 'updateRequired': case 'updateSuggested':
      state = { kind, title: pick(custom?.title, `${kind}.title`), body: pick(custom?.body, `${kind}.body`), buttonText: pick(custom?.buttonText, `${kind}.button`),
        secondaryButtonText: secondary, url: storeUrl, version, allowContinue: true, isTestBuild: false };
      break;
    case 'versionBlocked': {
      const canUpdate = storeUrl !== undefined;
      state = { kind, title: pick(custom?.title, 'versionBlocked.title'), body: pick(custom?.body, canUpdate ? 'versionBlocked.body' : 'versionBlocked.bodyNoUpdate'),
        buttonText: canUpdate ? pick(custom?.buttonText, 'versionBlocked.button') : undefined, secondaryButtonText: secondary, url: storeUrl, version, allowContinue: true, isTestBuild: false };
      break;
    }
    case 'maintenance':
      state = { kind, title: pick(custom?.title, 'maintenance.title'), body: pick(custom?.body, 'maintenance.body'), buttonText: pick(custom?.buttonText, 'maintenance.button'),
        secondaryButtonText: secondary, startsAt: iso(maintenance?.startsAt), endsAt: iso(maintenance?.endsAt), allowContinue: true, isTestBuild: false };
      break;
    case 'maintenanceUpcoming':
      state = { kind, body: pick(custom?.body, 'maintenanceUpcoming.banner'), startsAt: iso(maintenance?.startsAt), endsAt: iso(maintenance?.endsAt), allowContinue: true, isTestBuild: false };
      break;
    case 'announcement':
      state = { kind, title: pick(custom?.title ?? note?.title), body: pick(custom?.body ?? note?.body), buttonText: pick(custom?.buttonText ?? note?.buttonText, 'announcement.button'),
        url: note?.url, version: note?.id, allowContinue: true, isTestBuild: false };
      break;
    default:
      state = { kind: 'whatsNew', title: pick(custom?.title, 'whatsNew.title'), body: pick(custom?.body ?? news?.body), buttonText: pick(custom?.buttonText, 'whatsNew.button'),
        version: news?.version, allowContinue: true, isTestBuild: false };
  }
  state = { ...state, allowContinue: outcome.state === 'normal' ? true : outcome.allowContinue };
  return outcome.banners.includes('testBuild') ? { ...state, isTestBuild: true, testBuildText: f(t('testBuild.banner')) } : state;
}
