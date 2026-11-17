/** The rules of format 1 as the SDK reads them. A field of the wrong type counts as missing; unknown fields are ignored. */
export interface UpdateRule { min?: string | undefined; latest?: string | undefined; mode?: string | undefined; storeVersion?: string | undefined; storeUrl?: string | undefined }
export interface Blocked { version?: string | undefined; platforms?: string[] | undefined; allowContinue: boolean }
export interface Maintenance { startsAt: number; endsAt: number; headsUpMinutes: number; exemptAboveStore: boolean; platforms?: string[] | undefined }
export interface Announcement { id: string; title?: string | undefined; body?: string | undefined; url?: string | undefined; buttonText?: string | undefined; until: number; platforms?: string[] | undefined }
export interface WhatsNew { version?: string | undefined; body?: string | undefined }
export interface Custom { title?: string | undefined; body?: string | undefined; buttonText?: string | undefined }
export interface Rules {
  version: number;
  off: boolean;
  update: Record<string, UpdateRule>;
  blocked: Blocked[];
  maintenance?: Maintenance | undefined;
  announcement?: Announcement | undefined;
  whatsNew?: WhatsNew | undefined;
  custom: Record<string, Custom>;
  disabled: string[];
}

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Dict : undefined;
const text = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
/** Only web links are ever opened: a link with another scheme (javascript:, data:) counts as missing. */
const link = (v: unknown): string | undefined => typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v) ? v : undefined;
const list = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;
const ISO = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?([Zz]|[+-]\d{2}:?\d{2})?$/;

/** An ISO 8601 time (UTC when there is no zone) as milliseconds, or undefined when it is not a valid time. */
export function parseTime(value: unknown): number | undefined {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!ISO.test(s)) return;
  const iso = s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/z$/, 'Z');
  const time = Date.parse(/(Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`);
  // Date.parse rolls over impossible dates only in some engines; compare the day to be sure.
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)!;
  return Number.isNaN(time) || new Date(Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!)).getUTCDate() !== +day[3]! ? undefined : time;
}

const natural = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0;

/** The rules of a good answer: a JSON object of format 1. Anything else is undefined, which keeps the last known state. */
export function parseRules(input: unknown): Rules | undefined {
  const root = dict(input);
  if (!root || root.format !== 1) return;
  const update: Rules['update'] = {};
  for (const [key, value] of Object.entries(dict(root.update) ?? {})) {
    const rule = dict(value);
    if (rule) update[key] = { min: text(rule.min), latest: text(rule.latest), mode: text(rule.mode), storeVersion: text(rule.storeVersion), storeUrl: link(rule.storeUrl) };
  }
  const blocked: Blocked[] = [];
  if (Array.isArray(root.blocked)) {
    for (const item of root.blocked) {
      const entry = dict(item);
      if (entry) blocked.push({ version: text(entry.version), platforms: list(entry.platforms), allowContinue: entry.allowContinue === true });
    }
  }
  const m = dict(root.maintenance);
  const starts = parseTime(m?.startsAt);
  const ends = parseTime(m?.endsAt);
  const a = dict(root.announcement);
  const until = parseTime(a?.until);
  const n = dict(root.whatsNew);
  const custom: Rules['custom'] = {};
  for (const [key, value] of Object.entries(dict(dict(root.texts)?.custom) ?? {})) {
    const entry = dict(value);
    if (entry) custom[key] = { title: text(entry.title), body: text(entry.body), buttonText: text(entry.buttonText) };
  }
  return {
    version: natural(root.version),
    off: root.off === true,
    update,
    blocked,
    ...(m && starts !== undefined && ends !== undefined ? { maintenance: { startsAt: starts, endsAt: ends, headsUpMinutes: natural(m.headsUpMinutes), exemptAboveStore: m.exemptAboveStore === true, platforms: list(m.platforms) } } : {}),
    ...(a && until !== undefined && text(a.id) !== undefined ? { announcement: { id: text(a.id)!, title: text(a.title), body: text(a.body), url: link(a.url), buttonText: text(a.buttonText), until, platforms: list(a.platforms) } } : {}),
    ...(n ? { whatsNew: { version: text(n.version), body: text(n.body) } } : {}),
    custom,
    disabled: list(root.disabledSdkVersions) ?? [],
  };
}
