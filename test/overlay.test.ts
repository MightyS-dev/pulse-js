import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPlatform } from '../src/adapters/browser.js';
import { nodePlatform } from '../src/adapters/node.js';
import { OVERLAY_PARAM, OVERLAY_URL, startOverlay, takeToken } from '../src/adapters/overlay-token.js';
import { boxes, load, mount } from '../src/heatmap-overlay.js';
import type { Grid } from '../src/heatmap-overlay.js';

const TOKEN = 'a'.repeat(40);

describe('overlay token in the hash', () => {
  it('uses the documented fragment parameter and the fixed module URL', () => {
    expect(OVERLAY_PARAM).toBe('pulse_overlay');
    expect(OVERLAY_URL).toBe('https://pulse.mightys.dev/sdk/heatmap-overlay.js');
  });

  it.each([
    [`#pulse_overlay=${TOKEN}`, TOKEN, ''],
    [`#/level/3&pulse_overlay=${TOKEN}`, TOKEN, '#/level/3'],
    [`#a=1&pulse_overlay=${TOKEN}&b=2`, TOKEN, '#a=1&b=2'],
    [`#pulse_overlay=${TOKEN}&keep`, TOKEN, '#keep'],
    ['#section', undefined, '#section'],
    ['', undefined, ''],
    ['#pulse_overlay=short', undefined, ''],
    [`#pulse_overlay=${'b'.repeat(201)}`, undefined, ''],
  ])('takeToken(%s)', (hash, token, rest) => {
    expect(takeToken(hash)).toEqual({ token, rest });
  });

  function fakeWin(hash: string) {
    const win: Record<string, any> = { location: { hash, pathname: '/p', search: '?q=1' }, history: { state: { s: 1 }, replaceState: vi.fn((_s, _t, url: string) => {
      win.location.hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    }) } };
    return win;
  }

  it('removes only the token part at once with replaceState, keeps path, query and other hash content, then loads the module', async () => {
    const win = fakeWin(`#/route&pulse_overlay=${TOKEN}`);
    const mountFn = vi.fn();
    const load = vi.fn(async () => ({ mount: mountFn }));
    startOverlay(win, 'https://in.mightys.dev', load);
    expect(win.history.replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/p?q=1#/route');
    expect(win.location.hash).toBe('#/route');
    expect(load).toHaveBeenCalledWith(OVERLAY_URL);
    await Promise.resolve(); await Promise.resolve();
    expect(mountFn).toHaveBeenCalledWith({ token: TOKEN, host: 'https://in.mightys.dev' });
  });

  it('a normal visitor (no token) touches nothing and loads nothing', () => {
    for (const hash of ['', '#top', '#/route']) {
      const win = fakeWin(hash); const load = vi.fn();
      startOverlay(win, 'https://in.mightys.dev', load);
      expect(win.history.replaceState).not.toHaveBeenCalled();
      expect(load).not.toHaveBeenCalled();
    }
  });

  it('an invalid token is removed from the address bar but never loads the module', () => {
    const win = fakeWin('#pulse_overlay=short'); const load = vi.fn();
    startOverlay(win, 'https://in.mightys.dev', load);
    expect(win.location.hash).toBe('');
    expect(load).not.toHaveBeenCalled();
  });

  it('a failing module load or broken window never throws', () => {
    expect(() => startOverlay(fakeWin(`#pulse_overlay=${TOKEN}`), 'https://in.mightys.dev', async () => { throw new Error('x'); })).not.toThrow();
    expect(() => startOverlay({}, 'https://in.mightys.dev', vi.fn())).not.toThrow();
  });
});

/** A reply shaped exactly like HeatmapGrid in the API contract (getHeatmapOverlay 200). */
const GRID: Grid & Record<string, unknown> = {
  meta: { generated_at: '2026-11-16T10:00:00Z' }, screen: '/home', bucket: 'phone', orientation: 'portrait', columns: 50, cell_height_px: 20, rows: 40,
  total_points: 9, max_cell: 5, screenshot: { available: false, app_version: null, width: null, height: null, uploaded_at: null },
  cells: [{ x: 0, y: 0, tap: 5, rage: 0, dead: 0 }, { x: 49, y: 3, tap: 1, rage: 2, dead: 1 }],
};

describe('overlay module', () => {
  it('boxes: one per cell and visible layer, positioned by columns and rows, opacity from the count', () => {
    const all = boxes(GRID, { tap: true, rage: true, dead: true });
    expect(all).toHaveLength(4);
    expect(all[0]).toMatchObject({ left: 0, top: 0, width: 2, height: 20, title: 'tap: 5' });
    expect(all[1]).toMatchObject({ left: 98, top: 60, title: 'tap: 1' });
    expect(all[0]!.color).toBe('rgba(255,140,0,0.75)');
    expect(boxes(GRID, { tap: false, rage: true, dead: false }).map(b => b.title)).toEqual(['rage: 2']);
    expect(boxes(GRID, { tap: false, rage: false, dead: false })).toEqual([]);
  });

  function env(status = 200) {
    const fetch = vi.fn(async () => ({ status, json: async () => GRID }));
    return { fetch, innerWidth: 400, innerHeight: 800, location: { pathname: '/user/42/home', hash: '' } };
  }

  it('load: GET /api/v1/heatmap/overlay with the token header, the page screen, bucket and orientation; nothing else sent', async () => {
    const e = env();
    const grid = await load({ token: TOKEN, host: 'https://in.mightys.dev' }, e);
    expect(grid).toBe(GRID);
    const [url, init] = e.fetch.mock.calls[0]! as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://in.mightys.dev/api/v1/heatmap/overlay');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ screen: '/user/:id/home', bucket: 'phone', orientation: 'portrait' });
    expect(init).toMatchObject({ headers: { 'X-Pulse-Overlay-Token': TOKEN }, credentials: 'omit' });
    expect(e.fetch).toHaveBeenCalledTimes(1);
  });

  it('load: a 401 rejects', async () => {
    await expect(load({ token: TOKEN, host: 'https://in.mightys.dev' }, env(401))).rejects.toThrow();
  });

  /** Minimal DOM: elements with children, style, listeners. */
  function dom() {
    const make = (tag: string): any => {
      const node: any = { tag, children: [] as any[], style: { cssText: '' }, attrs: {} as Record<string, string>, listeners: {} as Record<string, () => void>,
        appendChild(c: any) { node.children.push(c); return c; }, append(...cs: any[]) { cs.forEach(c => node.children.push(c)); },
        setAttribute(k: string, v: string) { node.attrs[k] = v; }, addEventListener(t: string, fn: () => void) { node.listeners[t] = fn; },
        remove: vi.fn(),
      };
      let text = '';
      Object.defineProperty(node, 'textContent', { get: () => text, set: (v: string) => { text = v; if (v === '') node.children = []; } });
      return node;
    };
    const body = make('body');
    return { document: { createElement: make, body, documentElement: { scrollHeight: 2000 } }, body };
  }

  it('mount: renders the grid from the fetch response, with layer toggles and counts as titles', async () => {
    const d = dom();
    const handle = await mount({ token: TOKEN, host: 'https://in.mightys.dev' }, { ...env(), ...d });
    const root = d.body.children[0];
    expect(root.attrs).toHaveProperty('data-pulse-ignore');
    const [layer, panel] = root.children;
    expect(layer.children.map((c: any) => c.title)).toEqual(['tap: 5', 'tap: 1', 'rage: 2', 'dead: 1']);
    expect(layer.children[1].style.cssText).toContain('left:98%');
    expect(panel.children).toHaveLength(3);
    // Switch the rage layer off.
    const rage = panel.children[1].children[0];
    rage.checked = false; rage.listeners.change();
    expect(layer.children.map((c: any) => c.title)).toEqual(['tap: 5', 'tap: 1', 'dead: 1']);
    handle.remove();
    expect(root.remove).toHaveBeenCalled();
  });
});

describe('where it runs', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('Node has no tap capture and no overlay', () => {
    const p = nodePlatform();
    expect(p.heatmap).toBeUndefined();
    expect(p.overlay).toBeUndefined();
  });
  it('a wrapper captures taps but never reads an overlay token', () => {
    const replace = vi.fn();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
    vi.stubGlobal('location', { hash: `#pulse_overlay=${'a'.repeat(40)}`, pathname: '/', search: '' });
    vi.stubGlobal('history', { state: null, replaceState: replace });
    const p = browserPlatform();
    expect(p.heatmap).toBeTypeOf('function');
    p.overlay!('https://in.mightys.dev');
    expect(replace).not.toHaveBeenCalled();
  });
});
