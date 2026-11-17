import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeName, watchScreens } from '../src/adapters/browser.js';
import { nodePlatform } from '../src/adapters/node.js';
import { createPulse } from '../src/core.js';
import { harness, InstallStorage, settle } from './helpers.js';

beforeEach(() => { vi.useFakeTimers({ now: new Date(2026, 10, 16, 12).getTime() }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function sent(h: ReturnType<typeof harness>) {
  await h.client.flush();
  return h.requests.length ? h.signals(0).filter(s => s.type === 'pulse.screen_view') : [];
}

/** A window with a working History API surface, location and event listeners. */
function fakeWindow(path = '/', hash = '') {
  const listeners: Record<string, (() => void)[]> = {};
  const calls: string[] = [];
  const win: Record<string, any> = {
    location: { pathname: path, hash },
    history: {
      pushState(_s: unknown, _t: string, url: string) { calls.push('push'); win.location.pathname = url; },
      replaceState(_s: unknown, _t: string, url: string) { calls.push('replace'); win.location.pathname = url; },
    },
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); },
  };
  return { win, listeners, calls, fire: (type: string) => listeners[type]?.forEach(fn => fn()) };
}

describe('screen names from routes', () => {
  it('keeps the path only and strips query and fragment', () => {
    expect(routeName('/shop/items?color=red#top')).toBe('/shop/items');
    expect(routeName('/a#b')).toBe('/a');
  });
  it('replaces numeric and uuid-like segments', () => {
    expect(routeName('/user/42/orders/7')).toBe('/user/:id/orders/:id');
    expect(routeName('/doc/123e4567-e89b-12d3-a456-426614174000/edit')).toBe('/doc/:id/edit');
    expect(routeName('/k/0123456789abcdef0123456789ABCDEF')).toBe('/k/:id');
    expect(routeName('/v2/about')).toBe('/v2/about');
  });
  it('uses the hash path for hash routers and drops its query', () => {
    expect(routeName('/index.html', '#/level/3?x=1')).toBe('/level/:id');
    expect(routeName('/index.html', '#!/home')).toBe('/home');
    expect(routeName('/page', '#section')).toBe('/page');
  });
  it('is at most 128 characters and never empty', () => {
    expect(routeName('/' + 'a'.repeat(300))).toHaveLength(128);
    expect(routeName('')).toBe('/');
  });
});

describe('watching the History API', () => {
  it('reports the first page, push, replace, popstate and hashchange', () => {
    const { win, fire } = fakeWindow('/home');
    const seen: string[] = [];
    watchScreens(win, name => seen.push(name));
    win.history.pushState(null, '', '/shop/9?q=1');
    win.history.replaceState(null, '', '/cart');
    win.location.pathname = '/back'; fire('popstate');
    win.location.hash = '#/tab/2'; fire('hashchange');
    expect(seen).toEqual(['/home', '/shop/:id', '/cart', '/back', '/tab/:id']);
  });

  it('wraps once, calls the original first and keeps its result', () => {
    const { win, calls, listeners } = fakeWindow('/');
    const original = win.history.pushState;
    watchScreens(win, () => {});
    watchScreens(win, () => {});
    expect(win.history.pushState).not.toBe(original);
    win.history.pushState(null, '', '/x');
    expect(calls).toEqual(['push']);
    expect(listeners.popstate).toHaveLength(1);
    expect(listeners.hashchange).toHaveLength(1);
  });

  it('never reports the full URL or the title', () => {
    const { win } = fakeWindow('/p');
    win.document = { title: 'Secret title' };
    win.location.href = '/p?token=abc#frag';
    const seen: string[] = [];
    watchScreens(win, name => seen.push(name));
    expect(seen.join()).toBe('/p');
  });

  it('does nothing without a history or location', () => {
    expect(() => watchScreens({}, () => {})).not.toThrow();
  });
});

describe('screen views in the core', () => {
  it('registers the hook by default and sends screen, previousScreen and dedupes', async () => {
    const h = harness();
    await h.start({ gzip: false });
    expect(h.screens).toHaveLength(1);
    h.screens[0]!('/home'); h.screens[0]!('/home'); h.screens[0]!('/shop'); h.screens[0]!('/home');
    const out = await sent(h);
    expect(out.map(s => s.props)).toEqual([{ screen: '/home' }, { screen: '/shop', previousScreen: '/home', previousScreenSeconds: 0 }, { screen: '/home', previousScreen: '/shop', previousScreenSeconds: 0 }]);
    expect(out[0]!.system.sdkName).toBeTruthy();
  });

  it('installs nothing when automaticScreenViews is false, but manual screen still works', async () => {
    const h = harness();
    await h.start({ gzip: false, automaticScreenViews: false });
    expect(h.screens).toHaveLength(0);
    h.client.screen('Menu');
    expect(await sent(h)).toHaveLength(1);
  });

  it('manual screen truncates to 128 characters and ignores empty or non-string names', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.screen('x'.repeat(200)); h.client.screen(''); h.client.screen('   '); h.client.screen(5 as unknown as string);
    const out = await sent(h);
    expect(out).toHaveLength(1);
    expect((out[0]!.props.screen as string).length).toBe(128);
  });

  it('sends nothing after opt-out and does not remember the name, then resumes', async () => {
    const h = harness();
    await h.start({ gzip: false });
    h.client.optOut(true);
    h.client.screen('A');
    h.client.optOut(false);
    h.client.screen('A');
    await settle();
    const out = await sent(h);
    expect(out.map(s => s.props)).toEqual([{ screen: 'A' }]);
  });

  it('carries the install id user hash like any signal', async () => {
    const h = harness(new InstallStorage());
    await h.start({ gzip: false });
    h.client.screen('Home');
    const out = await sent(h);
    expect(out[0]!.userHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('Node', () => {
  it('has no automatic hook', () => {
    expect(nodePlatform().screens).toBeUndefined();
    expect(createPulse(nodePlatform()).screen).toBeTypeOf('function');
  });
});
