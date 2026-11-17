import { describe, expect, it, vi } from 'vitest';
import { createUi } from '../src/control/ui.js';
import type { ControlState } from '../src/types.js';
import { watchTaps } from '../src/adapters/taps.js';
import { FakeDocument, FakeNode } from './fake-dom.js';

const state = (extra: Partial<ControlState>): ControlState => ({ kind: 'maintenance', allowContinue: false, isTestBuild: false, ...extra });
const maintenance = state({ title: 'Down for maintenance', body: 'Back by 3 PM.', buttonText: 'Try again' });

function screen() {
  const doc = new FakeDocument();
  const page = doc.createElement('main');
  const footer = doc.createElement('footer');
  doc.body.append(page, footer);
  const actions = { primary: vi.fn(), secondary: vi.fn() };
  const ui = createUi(doc as unknown as Document);
  const host = (): FakeNode | undefined => doc.body.children.find(c => c.hasAttribute('data-pulse-ignore'));
  const root = (): FakeNode => host()!.shadow!.children.find(c => c.className === 'root')!;
  return { doc, page, footer, actions, ui, host, root, show: (s: ControlState) => ui.show(s as ControlState, actions) };
}

describe('the built-in screen', () => {
  it('shows nothing for normal and removes an earlier screen', () => {
    const t = screen();
    t.show(maintenance);
    expect(t.host()).toBeDefined();
    t.show(state({ kind: 'normal', allowContinue: true }));
    expect(t.host()).toBeUndefined();
  });

  it('lives in a closed shadow root on an element the heatmaps ignore, with its own style', () => {
    const t = screen();
    t.show(maintenance);
    const host = t.host()!;
    expect(host.mode).toBe('closed');
    expect(host.hasAttribute('data-pulse-ignore')).toBe(true);
    const css = host.shadow!.children.find(c => c.tagName === 'style')!.textContent;
    expect(css).toContain('prefers-color-scheme:dark');
    expect(css).toContain('prefers-reduced-motion:reduce');
    expect(css).toContain('system-ui');
  });

  it('a locking screen is an alert dialog with a label, a description and the focus on its button', () => {
    const t = screen();
    t.show(maintenance);
    const panel = t.root().find(n => n.className === 'panel')!;
    expect(panel.getAttribute('role')).toBe('alertdialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe('title');
    expect(panel.getAttribute('aria-describedby')).toBe('body');
    expect(t.root().find(n => n.id === 'title')!.textContent).toBe('Down for maintenance');
    expect(t.root().find(n => n.id === 'body')!.textContent).toBe('Back by 3 PM.');
    expect(t.doc.active!.textContent).toBe('Try again');
  });

  it('sets every text as text, never as markup', () => {
    const t = screen();
    t.show(state({ kind: 'announcement', allowContinue: true, title: '<b>x</b>', body: '<img src=x onerror=alert(1)>', buttonText: 'OK' }));
    expect(t.root().find(n => n.id === 'title')!.textContent).toBe('<b>x</b>');
    expect(t.root().find(n => n.id === 'body')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(t.root().all().some(n => n.tagName === 'img')).toBe(false);
  });

  it('makes the page inert and unscrollable while it is up and restores both', () => {
    const t = screen();
    t.doc.documentElement.style.overflow = 'auto';
    t.page.inert = false; t.footer.inert = true;
    t.show(maintenance);
    expect(t.page.inert).toBe(true);
    expect(t.footer.inert).toBe(true);
    expect(t.host()!.inert).toBe(false);
    expect(t.doc.documentElement.style.overflow).toBe('hidden');
    t.ui.hide();
    expect(t.page.inert).toBe(false);
    expect(t.footer.inert).toBe(true);
    expect(t.doc.documentElement.style.overflow).toBe('auto');
  });

  it('Escape does not close a locking screen, Tab stays inside it', () => {
    const t = screen();
    t.show(state({ ...maintenance, secondaryButtonText: 'Continue' }));
    const result = t.doc.key('Escape');
    expect(result.defaultPrevented).toBe(true);
    expect(t.actions.secondary).not.toHaveBeenCalled();
    expect(t.host()).toBeDefined();
    // Only one button exists (a locking screen has no way out), so Tab keeps the focus on it.
    const first = t.doc.active;
    t.doc.key('Tab');
    expect(t.doc.active).toBe(first);
    t.doc.key('Tab', true);
    expect(t.doc.active).toBe(first);
  });

  it('a screen with two buttons wraps Tab and Shift+Tab, and a focus that escapes is brought back', () => {
    const t = screen();
    t.show(state({ kind: 'updateSuggested', allowContinue: true, title: 'Update available', body: 'New.', buttonText: 'Update', secondaryButtonText: 'Not now' }));
    const [one, two] = t.root().all().filter(n => n.tagName === 'button');
    expect(t.doc.active).toBe(one);
    t.doc.key('Tab');
    expect(t.doc.active).toBe(two);
    t.doc.key('Tab');
    expect(t.doc.active).toBe(one);
    t.doc.key('Tab', true);
    expect(t.doc.active).toBe(two);
    const outside = t.doc.createElement('input');
    t.doc.body.append(outside);
    t.doc.active = outside;
    t.doc.dispatch('focusin', { target: outside });
    expect(t.doc.active!.className).toBe('panel');
  });

  it('Escape closes a dialog and a card, buttons call the actions', () => {
    const t = screen();
    t.show(state({ kind: 'updateSuggested', allowContinue: true, title: 'U', body: 'B', buttonText: 'Update', secondaryButtonText: 'Not now' }));
    const [update, later] = t.root().all().filter(n => n.tagName === 'button');
    update!.click();
    later!.click();
    expect(t.actions.primary).toHaveBeenCalledOnce();
    expect(t.actions.secondary).toHaveBeenCalledOnce();
    t.doc.key('Escape');
    expect(t.actions.secondary).toHaveBeenCalledTimes(2);
    t.show(state({ kind: 'whatsNew', allowContinue: true, title: 'New', body: 'B', buttonText: 'OK' }));
    t.doc.key('Escape');
    expect(t.actions.secondary).toHaveBeenCalledTimes(3);
  });

  it('a button that throws never reaches the app', () => {
    const t = screen();
    t.actions.primary.mockImplementation(() => { throw new Error('boom'); });
    t.show(maintenance);
    expect(() => t.root().all().find(n => n.tagName === 'button')!.click()).not.toThrow();
  });

  it('the heads-up bar is a status line with a close button named by the Continue text and no focus trap', () => {
    const t = screen();
    t.show(state({ kind: 'maintenanceUpcoming', allowContinue: true, body: 'Scheduled maintenance at 3 PM.', secondaryButtonText: 'Continue' }));
    const bar = t.root().find(n => n.className === 'bar')!;
    expect(bar.getAttribute('role')).toBe('status');
    expect(bar.children[0]!.textContent).toBe('Scheduled maintenance at 3 PM.');
    const close = bar.children[1]!;
    expect(close.getAttribute('aria-label')).toBe('Continue');
    expect(t.page.inert).toBe(false);
    expect(t.doc.documentElement.style.overflow).toBeUndefined();
    close.click();
    expect(t.actions.secondary).toHaveBeenCalledOnce();
  });

  it('a debug build shows the test bar with the Continue button', () => {
    const t = screen();
    t.show(state({ ...maintenance, allowContinue: true, isTestBuild: true, testBuildText: 'Test build: App Control preview', secondaryButtonText: 'Continue' }));
    expect(t.root().find(n => n.className === 'bar test')!.children[0]!.textContent).toBe('Test build: App Control preview');
    const names = t.root().all().filter(n => n.tagName === 'button').map(n => n.textContent);
    expect(names).toEqual(['Try again', 'Continue']);
    expect(t.root().find(n => n.className === 'panel')!.getAttribute('role')).toBe('dialog');
  });

  it('a second show replaces the first and removes its listeners', () => {
    const t = screen();
    t.show(maintenance);
    t.show(state({ kind: 'whatsNew', allowContinue: true, title: 'New', body: 'B', buttonText: 'OK' }));
    expect(t.doc.body.children.filter(c => c.hasAttribute('data-pulse-ignore'))).toHaveLength(1);
    t.ui.hide();
    expect(t.doc.listeners.get('keydown')!.length).toBe(0);
    expect(t.doc.listeners.get('focusin')!.length).toBe(0);
  });
});

describe('the built-in screen is never app usage', () => {
  it('a tap on it is not captured as a heatmap point, and a tap on the page is', () => {
    const t = screen();
    t.show(maintenance);
    const closest = (node: FakeNode) => (sel: string): FakeNode | null => {
      for (let n: FakeNode | undefined = node; n; n = n.parent) if (sel.includes('[data-pulse-ignore]') && n.hasAttribute('data-pulse-ignore')) return n;
      return null;
    };
    const target = (node: FakeNode) => Object.assign(node, { closest: closest(node) });
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const win = { document: { documentElement: { clientWidth: 400 }, addEventListener: (k: string, f: (e: unknown) => void) => { (listeners[k] ??= []).push(f); } }, scrollY: 0, innerWidth: 400, innerHeight: 800, location: { href: 'x' }, navigator: { maxTouchPoints: 0 } };
    const taps: unknown[] = [];
    watchTaps(win, () => true, tap => { taps.push(tap); return undefined; });
    const fire = (node: FakeNode) => listeners.click!.forEach(f => f({ target: node, composedPath: () => [node], clientX: 5, clientY: 5, detail: 1, pointerType: 'mouse' }));
    const host = t.host()!;
    // A tap on a button inside the closed shadow root reaches the page retargeted to the host.
    fire(target(host));
    expect(taps).toEqual([]);
    fire(target(t.page));
    expect(taps).toHaveLength(1);
  });
});
