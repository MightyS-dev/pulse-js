import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine, platformKey } from '../src/control/engine.js';
import type { Io } from '../src/control/engine.js';
import { openUrl } from '../src/control/open.js';
import { pickLanguage } from '../src/control/strings.js';
import type { ControlHost, ControlState } from '../src/types.js';
import { FIXED_NOW, REQUIRED, Records, WIRE } from './control-rig.js';

const HOUR = 3600000;
const NOW = FIXED_NOW;
const iso = (offset: number): string => new Date(NOW + offset).toISOString();

beforeEach(() => { vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

interface Setup { unset?: boolean; app?: boolean; os?: string; version?: string; debug?: boolean; mode?: string; appName?: string; locale?: string; records?: Records; tags?: string[]; platform?: string }

async function engineOf(setup: Setup = {}) {
  const records = setup.records ?? new Records();
  const shared: ControlHost['shared'] = { state: { kind: 'normal', allowContinue: true, isTestBuild: false }, listeners: new Set() };
  const seen: ControlState[] = [];
  const shown: { state: ControlState; actions: { primary(): void; secondary(): void } }[] = [];
  const opened: string[] = [];
  shared.listeners.add(state => seen.push(state));
  const host: ControlHost = {
    mode: setup.unset ? undefined : setup.mode ?? 'automatic', options: { appVersion: setup.version ?? '2.3.0', appName: setup.appName ?? 'Orbit', debug: setup.debug ?? false },
    env: { info: () => ({ platform: setup.platform ?? 'web', osName: setup.os ?? 'iOS', osVersion: '19', locale: setup.locale ?? 'en-US' }), sessionId: () => 's', installId: () => '0'.repeat(32), hashUser: async v => v, gzip: async b => b, warn: () => {} },
    clock: { now: () => Date.now(), random: () => 0.5, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>) },
    shared, app: setup.app ?? true, local: records.item('local'), check: vi.fn(async () => {}),
  };
  const io: Io = {
    present: (state, actions) => { shown.push({ state, actions }); },
    open: url => { opened.push(url); },
    tags: () => setup.tags ?? [setup.locale ?? 'en-US'],
  };
  const engine = await createEngine(host, io);
  return { engine, host, records, seen, shown, opened, state: () => shared.state, last: () => shown.at(-1)?.state };
}

describe('the platform key', () => {
  it.each([
    [{ platform: 'mobile', osName: 'iOS' }, true, false, 'ios'],
    [{ platform: 'mobile', osName: 'Android' }, true, false, 'android'],
    [{ platform: 'mobile', osName: 'macOS' }, true, true, 'ios'],
    [{ platform: 'mobile', osName: 'macOS' }, true, false, 'web'],
    [{ platform: 'mobile', osName: 'Windows' }, true, false, 'web'],
    [{ platform: 'web', osName: 'iOS' }, false, false, 'web'],
    [{ platform: 'web', osName: 'Android' }, false, false, 'web'],
    [{ platform: 'node', osName: 'macOS' }, false, false, 'macos'],
    [{ platform: 'node', osName: 'Windows' }, false, false, 'windows'],
    [{ platform: 'node', osName: 'Linux' }, false, false, 'linux'],
    [{ platform: 'node', osName: 'Other' }, false, false, 'other'],
  ])('%j app=%s touch=%s is %s', (info, app, touch, key) => {
    expect(platformKey({ locale: 'en', osVersion: '', ...info }, app, touch)).toBe(key);
  });
});

describe('states and what the screen is asked to show', () => {
  it('shows a required update in an app wrapper, with the store link and the texts of the table', async () => {
    const t = await engineOf({ app: true });
    t.engine.apply(REQUIRED(), NOW, true);
    expect(t.state()).toMatchObject({ kind: 'updateRequired', title: 'Update required', buttonText: 'Update', url: 'https://store.example.invalid/app/id123', allowContinue: false, isTestBuild: false, version: '2.4.0' });
    expect(t.state().body).toBe('This version of Orbit is no longer supported. Please update to keep using the app.');
    expect(t.state().secondaryButtonText).toBeUndefined();
    expect(t.last()?.kind).toBe('updateRequired');
  });

  it('keeps the update states in the state of a plain web page but never puts them on screen', async () => {
    const t = await engineOf({ app: false, platform: 'web', os: 'iOS' });
    t.engine.apply(WIRE({ update: { web: { min: '2.4.0', latest: '2.4.0', mode: 'required', storeVersion: null, storeUrl: 'https://example.invalid/app' } } }), NOW, true);
    expect(t.state().kind).toBe('updateRequired');
    expect(t.shown.map(s => s.state.kind)).toEqual(['normal']);
    const blocked = await engineOf({ app: false });
    blocked.engine.apply(WIRE({ blocked: [{ version: '2.3.0', platforms: null, allowContinue: false }] }), NOW, true);
    expect(blocked.state().kind).toBe('versionBlocked');
    expect(blocked.shown.map(s => s.state.kind)).toEqual(['normal']);
  });

  it('shows maintenance, a heads-up bar, an announcement and what is new on a plain web page', async () => {
    const maintenance = { startsAt: iso(-HOUR), endsAt: iso(HOUR), headsUpMinutes: 30, exemptAboveStore: false, platforms: null };
    const t = await engineOf({ app: false });
    t.engine.apply(WIRE({ maintenance }), NOW, true);
    expect(t.last()).toMatchObject({ kind: 'maintenance', title: 'Down for maintenance', buttonText: 'Try again', allowContinue: false });
    const upcoming = await engineOf({ app: false });
    upcoming.engine.apply(WIRE({ maintenance: { ...maintenance, startsAt: iso(10 * 60000), endsAt: iso(HOUR) } }), NOW, true);
    expect(upcoming.last()).toMatchObject({ kind: 'maintenanceUpcoming', allowContinue: true });
    expect(upcoming.last()?.body).toMatch(/^Scheduled maintenance at /);
    const note = await engineOf({ app: false });
    note.engine.apply(WIRE({ announcement: { id: 'a1', title: 'Winter event', body: 'Snow is here', url: 'https://example.invalid/winter', buttonText: 'See it', until: iso(HOUR), platforms: null } }), NOW, true);
    expect(note.last()).toMatchObject({ kind: 'announcement', title: 'Winter event', body: 'Snow is here', buttonText: 'See it', url: 'https://example.invalid/winter', version: 'a1' });
  });

  it('maintenance texts carry the window in the device time zone', async () => {
    const t = await engineOf({ app: false, tags: ['en-US'] });
    t.engine.apply(WIRE({ maintenance: { startsAt: iso(-HOUR), endsAt: iso(HOUR), headsUpMinutes: 0, exemptAboveStore: false, platforms: null } }), NOW, true);
    expect(t.state().body).toContain(new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(NOW + HOUR));
    expect(t.state()).toMatchObject({ startsAt: iso(-HOUR), endsAt: iso(HOUR) });
  });

  it('without the control option the screens are shown (automatic is the default)', async () => {
    const t = await engineOf({ unset: true });
    t.engine.apply(REQUIRED(), NOW, true);
    expect(t.last()?.kind).toBe('updateRequired');
  });

  it('manual mode keeps the state and shows nothing', async () => {
    const t = await engineOf({ mode: 'manual' });
    t.engine.apply(REQUIRED(), NOW, true);
    expect(t.state().kind).toBe('updateRequired');
    expect(t.shown).toHaveLength(0);
  });

  it('rules that are rejected (wrong format, not finite time) change nothing', async () => {
    const t = await engineOf();
    t.engine.apply(REQUIRED(), NOW, true);
    expect(t.engine.apply({ format: 2 }, NOW, true)).toBe(false);
    expect(t.engine.apply(REQUIRED(), Number.NaN, true)).toBe(false);
    expect(t.engine.apply('x', NOW, true)).toBe(false);
    expect(t.state().kind).toBe('updateRequired');
  });

  it('a listener that throws does not break the others or the SDK', async () => {
    const t = await engineOf();
    const other = vi.fn();
    t.host.shared.listeners.add(() => { throw new Error('listener'); });
    t.host.shared.listeners.add(other);
    t.engine.apply(REQUIRED(), NOW, true);
    expect(other).toHaveBeenCalledOnce();
  });

  it('a screen that throws never reaches the app', async () => {
    const t = await engineOf();
    const host = { ...t.host };
    const engine = await createEngine(host, { present: () => { throw new Error('draw'); }, tags: () => ['en'] });
    expect(() => engine.apply(REQUIRED(), NOW, true)).not.toThrow();
    expect(host.shared.state.kind).toBe('updateRequired');
  });
});

describe('texts', () => {
  it('uses the table language of the app, then the system, then English', () => {
    expect(pickLanguage(['de-AT'])).toBe('de');
    expect(pickLanguage(['pt'])).toBe('pt-BR');
    expect(pickLanguage(['zh-Hant-TW'])).toBe('zh-Hans');
    expect(pickLanguage(['sr_RS'])).toBe('sr-Latn');
    expect(pickLanguage(['xx', '', undefined, 'FR-ca'])).toBe('fr');
    expect(pickLanguage(['xx'])).toBe('en');
    expect(pickLanguage([])).toBe('en');
  });

  it('a screen in German', async () => {
    const t = await engineOf({ tags: ['de-DE'] });
    t.engine.apply(REQUIRED(), NOW, true);
    expect(t.state()).toMatchObject({ title: 'Update erforderlich', buttonText: 'Updaten' });
  });

  it('custom texts replace title, body or button for every language, null keeps the built-in text', async () => {
    const t = await engineOf({ tags: ['de-DE'] });
    t.engine.apply({ ...REQUIRED(), texts: { custom: { updateRequired: { title: null, body: 'Version {version} of {appName} is out.', buttonText: 'Get it' } } } }, NOW, true);
    expect(t.state()).toMatchObject({ title: 'Update erforderlich', body: 'Version 2.4.0 of Orbit is out.', buttonText: 'Get it' });
  });

  it('without an app name the text says "this app" and starts with a capital letter', async () => {
    const t = await engineOf({ appName: '' });
    t.engine.apply({ ...WIRE({ maintenance: { startsAt: iso(-HOUR), endsAt: iso(HOUR), headsUpMinutes: 0, exemptAboveStore: false, platforms: null } }) }, NOW, true);
    expect(t.state().body).toMatch(/^This app is being updated\./);
  });

  it('markup in a text stays text', async () => {
    const t = await engineOf();
    t.engine.apply(WIRE({ announcement: { id: 'x', title: '<img src=x onerror=alert(1)>', body: '<script>1</script>', until: iso(HOUR), url: null, buttonText: null, platforms: null } }), NOW, true);
    expect(t.state().title).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('dismiss', () => {
  it('a closed suggestion stays away for 24 hours and then comes back, also after a restart', async () => {
    const records = new Records();
    const suggested = REQUIRED({ mode: 'suggested', min: null, latest: '2.4.0' });
    const t = await engineOf({ records });
    t.engine.apply(suggested, NOW, true);
    expect(t.state()).toMatchObject({ kind: 'updateSuggested', secondaryButtonText: 'Not now', allowContinue: true });
    t.engine.dismiss();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.state().kind).toBe('normal');
    const again = await engineOf({ records });
    again.engine.apply(suggested, Date.now(), true);
    expect(again.state().kind).toBe('normal');
    await vi.advanceTimersByTimeAsync(24 * HOUR + 2000);
    expect(t.state().kind).toBe('updateSuggested');
  });

  it('a locking screen without allowContinue ignores dismiss', async () => {
    const t = await engineOf();
    t.engine.apply(REQUIRED(), NOW, true);
    t.engine.dismiss();
    expect(t.state().kind).toBe('updateRequired');
    const maintenance = await engineOf({ app: false });
    maintenance.engine.apply(WIRE({ maintenance: { startsAt: iso(-HOUR), endsAt: iso(HOUR), headsUpMinutes: 0, exemptAboveStore: false, platforms: null } }), NOW, true);
    maintenance.engine.dismiss();
    expect(maintenance.state().kind).toBe('maintenance');
  });

  it('an announcement is shown once per id on this device, a new id shows again', async () => {
    const records = new Records();
    const note = (id: string) => WIRE({ announcement: { id, title: 'T', body: 'B', until: iso(HOUR), url: null, buttonText: null, platforms: null } });
    const t = await engineOf({ records });
    t.engine.apply(note('a1'), NOW, true);
    expect(t.state().kind).toBe('announcement');
    t.engine.dismiss();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.state().kind).toBe('normal');
    expect(JSON.parse(records.local!).shownAnnouncements).toEqual(['a1']);
    const later = await engineOf({ records });
    later.engine.apply(note('a1'), NOW, true);
    expect(later.state().kind).toBe('normal');
    later.engine.apply(note('a2'), NOW, true);
    expect(later.state().kind).toBe('announcement');
  });

  it('an announcement ends by itself at its end time', async () => {
    const t = await engineOf();
    t.engine.apply(WIRE({ announcement: { id: 'a1', title: 'T', body: 'B', until: iso(HOUR), url: null, buttonText: null, platforms: null } }), NOW, true);
    expect(t.state().kind).toBe('announcement');
    await vi.advanceTimersByTimeAsync(HOUR + 2000);
    expect(t.state().kind).toBe('normal');
  });

  it('the local memory keeps only the last 20 announcement ids', async () => {
    const records = new Records();
    const t = await engineOf({ records });
    for (let n = 0; n < 25; n++) {
      t.engine.apply(WIRE({ announcement: { id: `id${n}`, title: 'T', body: 'B', until: iso(HOUR), url: null, buttonText: null, platforms: null } }), NOW, true);
      t.engine.dismiss();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(records.local!).shownAnnouncements).toHaveLength(20);
  });

  it('what is new shows once after an update to that version, never on the first launch or without an app version', async () => {
    const news = WIRE({ whatsNew: { version: '2.4.0', body: 'Dark mode is here.' } });
    const first = await engineOf({ version: '2.4.0' });
    first.engine.apply(news, NOW, true);
    expect(first.state().kind).toBe('normal');
    const records = new Records();
    records.local = JSON.stringify({ appVersion: '2.3.0', updateReturns: 0, dismissedAt: 0, shownAnnouncements: [] });
    const updated = await engineOf({ version: '2.4.0', records });
    updated.engine.apply(news, NOW, true);
    expect(updated.state()).toMatchObject({ kind: 'whatsNew', title: "What's new in 2.4.0", body: 'Dark mode is here.', version: '2.4.0' });
    updated.engine.dismiss();
    await vi.advanceTimersByTimeAsync(0);
    expect(updated.state().kind).toBe('normal');
    const restarted = await engineOf({ version: '2.4.0', records });
    restarted.engine.apply(news, NOW, true);
    expect(restarted.state().kind).toBe('normal');
    const none = await engineOf({ version: '', records: new Records() });
    none.engine.apply(news, NOW, true);
    expect(none.state().kind).toBe('normal');
  });

  it('in a debug build a locking screen has the test bar and can be left', async () => {
    const t = await engineOf({ debug: true });
    t.engine.apply(REQUIRED(), NOW, true);
    expect(t.state()).toMatchObject({ kind: 'updateRequired', isTestBuild: true, testBuildText: 'Test build: App Control preview', allowContinue: true, secondaryButtonText: 'Continue' });
    t.engine.dismiss();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.state().kind).toBe('normal');
  });

  it('the heads-up bar can be closed', async () => {
    const t = await engineOf({ app: false });
    t.engine.apply(WIRE({ maintenance: { startsAt: iso(10 * 60000), endsAt: iso(HOUR), headsUpMinutes: 30, exemptAboveStore: false, platforms: null } }), NOW, true);
    expect(t.state().kind).toBe('maintenanceUpcoming');
    t.engine.dismiss();
    expect(t.state().kind).toBe('normal');
  });
});

describe('the store button', () => {
  it('opens the link and counts a press; three returns on the same version make a required update a suggestion', async () => {
    const records = new Records();
    const t = await engineOf({ records });
    t.engine.apply(REQUIRED(), NOW, true);
    for (let n = 0; n < 3; n++) {
      expect(t.state().kind).toBe('updateRequired');
      t.last() && t.shown.at(-1)!.actions.primary();
      t.engine.foreground();
    }
    expect(t.opened).toEqual(Array(3).fill('https://store.example.invalid/app/id123'));
    expect(t.state().kind).toBe('updateSuggested');
    expect(JSON.parse(records.local!).updateReturns).toBe(3);
  });

  it('the guard starts again from zero after an app update', async () => {
    const records = new Records();
    records.local = JSON.stringify({ appVersion: '2.3.0', updateReturns: 3, dismissedAt: 0, shownAnnouncements: [] });
    const t = await engineOf({ records, version: '2.3.5' });
    t.engine.apply(REQUIRED(), NOW, true);
    expect(t.state().kind).toBe('updateRequired');
    expect(JSON.parse(records.local!).updateReturns).toBe(0);
  });

  it('Try again on a maintenance screen asks the core for a check', async () => {
    const t = await engineOf({ app: false });
    t.engine.apply(WIRE({ maintenance: { startsAt: iso(-HOUR), endsAt: iso(HOUR), headsUpMinutes: 0, exemptAboveStore: false, platforms: null } }), NOW, true);
    t.shown.at(-1)!.actions.primary();
    expect(t.host.check).toHaveBeenCalledOnce();
  });

  it('an announcement button opens its link and closes the card', async () => {
    const t = await engineOf();
    t.engine.apply(WIRE({ announcement: { id: 'a1', title: 'T', body: 'B', until: iso(HOUR), url: 'https://example.invalid/more', buttonText: null, platforms: null } }), NOW, true);
    t.shown.at(-1)!.actions.primary();
    expect(t.opened).toEqual(['https://example.invalid/more']);
    expect(t.state().kind).toBe('normal');
  });

  it('the openStore of the API does nothing where there is no link', async () => {
    const t = await engineOf();
    t.engine.openStore();
    expect(t.opened).toEqual([]);
  });
});

describe('opening a link', () => {
  it('a browser opens a new tab without opener access', () => {
    const win = { open: vi.fn() };
    openUrl('https://example.invalid/a', false, win);
    expect(win.open).toHaveBeenCalledWith('https://example.invalid/a', '_blank', 'noopener');
  });

  it('Capacitor and Cordova open through the system, other web views navigate', () => {
    const cap = { Capacitor: { isNativePlatform: () => true }, open: vi.fn(), location: { href: '' } };
    openUrl('https://example.invalid/a', true, cap);
    expect(cap.open).toHaveBeenCalledWith('https://example.invalid/a', '_system');
    const cordova = { cordova: {}, open: vi.fn(), location: { href: '' } };
    openUrl('https://example.invalid/b', true, cordova);
    expect(cordova.open).toHaveBeenCalledWith('https://example.invalid/b', '_system');
    const view = { open: vi.fn(), location: { href: '' } };
    openUrl('https://example.invalid/c', true, view);
    expect(view.location.href).toBe('https://example.invalid/c');
    expect(view.open).not.toHaveBeenCalled();
  });

  it('never throws', () => {
    expect(() => openUrl('https://example.invalid', true, {})).not.toThrow();
    expect(() => openUrl('https://example.invalid', false, {})).not.toThrow();
  });
});
