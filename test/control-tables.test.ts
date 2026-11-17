import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decide } from '../src/control/decision.js';
import { parseRules, parseTime } from '../src/control/rules.js';
import { LANGUAGES, TEXTS } from '../src/control/texts.js';
import { compareVersions } from '../src/control/version.js';

// The shared tables are copied byte for byte. A copy of this package without them skips these rows, visibly.
const dir = new URL('./fixtures/control-v1/', import.meta.url);
const present = existsSync(new URL('decision-cases.json', dir));
const read = (name: string): { text: string; json: any } => {
  const text = readFileSync(new URL(name, dir), 'utf8');
  return { text, json: JSON.parse(text) };
};
const SHA: Record<string, string> = {
  'version-cases.json': '027cc69450b95177d4c50ee2a9026df3dfe05e2b6f46d4e449dca872b4ab4009',
  'decision-cases.json': 'fdc4ef65c3bf22e1a5775e756d5660cf3608085eb2a5977c683b25affd15c622',
  'control-id-cases.json': 'f236a1c986276ea69aeca69ccafff368ba8a07a749269986814e57b256d01b2f',
  'texts.json': '39aac628bda36bbb86fb4a091dad3252be82dd2a6353af9ea1db574a5264dbf4',
};

describe.skipIf(!present)('shared App Control tables', () => {
  it.each(Object.keys(SHA))('%s is byte for byte the shared copy', name => {
    expect(createHash('sha256').update(readFileSync(new URL(name, dir))).digest('hex')).toBe(SHA[name]);
  });

  it('compares every version case (200 or more) in both directions', () => {
    const cases = read('version-cases.json').json as { a: string; b: string; result: number | 'incomparable' }[];
    expect(cases.length).toBeGreaterThanOrEqual(200);
    for (const row of cases) expect(compareVersions(row.a, row.b), `${row.a} vs ${row.b}`).toBe(row.result === 'incomparable' ? undefined : row.result);
  });

  it('decides every decision case (60 or more) with the expected state, banners, card and allowContinue', () => {
    const cases = read('decision-cases.json').json as { name: string; input: any; expected: any }[];
    expect(cases.length).toBeGreaterThanOrEqual(60);
    for (const { name, input, expected } of cases) {
      const outcome = decide({
        rules: input.rules ? parseRules(input.rules) : undefined, now: parseTime(input.now)!, platform: input.platform, appVersion: input.appVersion,
        debug: input.debug, sdk: input.sdk, fromCache: input.fromCache, cacheAgeHours: input.cacheAgeHours, updateReturns: input.updateReturns,
        playUpdateNotAvailable: input.playUpdateNotAvailable, canBuildStoreLink: input.canBuildStoreLink,
        suggestDismissedHoursAgo: input.suggestDismissedHoursAgo ?? undefined, shownAnnouncements: input.shownAnnouncements,
        justUpdated: input.justUpdated, whatsNewShown: input.whatsNewShown,
      });
      expect({ state: outcome.state, allowContinue: outcome.allowContinue, banners: outcome.banners, card: outcome.card ?? null }, name).toEqual(expected);
    }
  });

  it('has the built-in texts of the shared table in all 12 languages', () => {
    const table = read('texts.json').json as { languages: string[]; texts: Record<string, Record<string, string>> };
    expect(LANGUAGES).toEqual(table.languages);
    expect(LANGUAGES).toHaveLength(12);
    expect(TEXTS).toEqual(table.texts);
  });
});

describe('time parsing', () => {
  it.each([
    ['2026-12-01T13:00:00Z', Date.UTC(2026, 11, 1, 13)],
    ['2026-12-01T13:00:00.250Z', Date.UTC(2026, 11, 1, 13, 0, 0, 250)],
    ['2026-12-01T15:00:00+02:00', Date.UTC(2026, 11, 1, 13)],
    ['2026-12-01T15:00:00+0200', Date.UTC(2026, 11, 1, 13)],
    ['2026-12-01 13:00:00', Date.UTC(2026, 11, 1, 13)],
    ['2024-02-29T00:00:00Z', Date.UTC(2024, 1, 29)],
  ])('reads %s', (text, expected) => expect(parseTime(text)).toBe(expected));

  it.each(['', 'soon', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2026-12-01', '2026-12-01T25:00:00Z', 5, null])('rejects %s', value => {
    expect(parseTime(value)).toBeUndefined();
  });
});

describe('rules parsing', () => {
  const base = { format: 1, version: 3, off: false, update: {}, blocked: [], maintenance: null, announcement: null, whatsNew: null, texts: { custom: {} }, disabledSdkVersions: [] };

  it('reads empty rules', () => {
    expect(parseRules(base)).toMatchObject({ version: 3, off: false, update: {}, blocked: [], custom: {}, disabled: [] });
  });

  it.each([null, 'text', 5, [], { format: 2 }, { version: 1 }, { format: '1' }])('rejects %j', value => {
    expect(parseRules(value)).toBeUndefined();
  });

  it('treats a field of the wrong type as missing and ignores unknown fields', () => {
    const rules = parseRules({ ...base, update: 5, blocked: 'x', maintenance: 'x', announcement: [], whatsNew: 7, texts: 3, disabledSdkVersions: 'x', surprise: { a: 1 } });
    expect(rules).toMatchObject({ update: {}, blocked: [], custom: {}, disabled: [] });
    expect(rules?.maintenance).toBeUndefined();
    expect(rules?.announcement).toBeUndefined();
    expect(rules?.whatsNew).toBeUndefined();
  });

  it('reads the full rule set', () => {
    const rules = parseRules({
      ...base,
      update: { ios: { min: '2.4.0', latest: '2.4.0', mode: 'required', storeVersion: '2.4.0', storeUrl: 'https://store.example.invalid/app/id1' }, bad: 3 },
      blocked: [{ version: '2.3.1', platforms: ['ios'], allowContinue: false }, 'nope'],
      maintenance: { startsAt: '2026-12-01T13:00:00Z', endsAt: '2026-12-01T14:00:00Z', headsUpMinutes: 60, exemptAboveStore: true, platforms: null },
      announcement: { id: 'a7', title: 'T', body: 'B', url: null, buttonText: null, until: '2026-12-08T00:00:00Z', platforms: null },
      whatsNew: { version: '2.4.0', body: 'New' },
      texts: { custom: { updateRequired: { title: null, body: 'Custom', buttonText: null } } },
      disabledSdkVersions: ['pulse-js@0.9.6', 4],
    });
    expect(rules?.update.ios).toMatchObject({ min: '2.4.0', mode: 'required', storeUrl: 'https://store.example.invalid/app/id1' });
    expect(Object.keys(rules!.update)).toEqual(['ios']);
    expect(rules?.blocked).toEqual([{ version: '2.3.1', platforms: ['ios'], allowContinue: false }]);
    expect(rules?.maintenance).toMatchObject({ headsUpMinutes: 60, exemptAboveStore: true, platforms: undefined });
    expect(rules?.announcement?.id).toBe('a7');
    expect(rules?.whatsNew).toEqual({ version: '2.4.0', body: 'New' });
    expect(rules?.custom.updateRequired?.body).toBe('Custom');
    expect(rules?.disabled).toEqual(['pulse-js@0.9.6']);
  });

  it('drops a maintenance window or an announcement whose times cannot be read', () => {
    const rules = parseRules({ ...base, maintenance: { startsAt: 'x', endsAt: '2026-12-01T14:00:00Z' }, announcement: { id: 'a', until: 'x' } });
    expect(rules?.maintenance).toBeUndefined();
    expect(rules?.announcement).toBeUndefined();
  });
});
