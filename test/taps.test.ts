import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyboardUp, watchTaps } from '../src/adapters/taps.js';
import type { HeatTap } from '../src/types.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

interface FakeEl { tag: string; attrs: Record<string, string>; parent?: FakeEl; closest(sel: string): FakeEl | null; isContentEditable?: boolean }
function el(tag: string, attrs: Record<string, string> = {}, parent?: FakeEl): FakeEl {
  const node: FakeEl = { tag, attrs, ...(parent ? { parent } : {}), closest(sel) {
    for (let n: FakeEl | undefined = node; n; n = n.parent) {
      if (sel.split(',').some(part => part === n!.tag || (part.startsWith('[contenteditable]') && n!.attrs.contenteditable !== undefined && n!.attrs.contenteditable !== 'false')
        || (part === '[data-pulse-ignore]' && 'data-pulse-ignore' in n!.attrs))) return n;
    }
    return null;
  } };
  return node;
}

/** A document and window the test drives: listeners, an observer that records its lifetime, address and focus. */
function world(over: Record<string, any> = {}) {
  const listeners: Record<string, { fn: (e: any) => void; options: any }[]> = {};
  const observers: { disconnected: boolean; fire(): void; cb: () => void }[] = [];
  const doc: Record<string, any> = {
    documentElement: { clientWidth: 400 }, activeElement: el('body'),
    addEventListener: (type: string, fn: (e: any) => void, options: any) => { (listeners[type] ??= []).push({ fn, options }); },
  };
  class FakeObserver { disconnected = false; constructor(public cb: () => void) { observers.push(this); } observe() {} disconnect() { this.disconnected = true; } fire() { this.cb(); } }
  const win: Record<string, any> = { document: doc, scrollY: 100, innerWidth: 400, innerHeight: 800, location: { href: 'https://in.mightys.dev/a' }, MutationObserver: FakeObserver, navigator: { maxTouchPoints: 0 }, ...over };
  const fire = (type: string, e: object) => listeners[type]?.forEach(l => l.fn(e));
  return { doc, win, listeners, observers, fire };
}
const click = (target: FakeEl, extra: object = {}) => ({ type: 'click', target, composedPath: () => [target], clientX: 50, clientY: 60, detail: 1, pointerType: 'mouse', ...extra });

function setup(over: Record<string, any> = {}, ready = true) {
  const w = world(over);
  const taps: HeatTap[] = [];
  const dead = vi.fn();
  watchTaps(w.win, () => ready, t => { taps.push(t); return dead; });
  return { ...w, taps, dead };
}

describe('what is captured', () => {
  it('reports a click with page coordinates (clientY plus scroll) and the viewport size', () => {
    const w = setup(); w.fire('click', click(el('div')));
    expect(w.taps).toEqual([{ x: 50, y: 160, width: 400, height: 800 }]);
  });

  it('listens in the capture phase and passively, so nothing is consumed or delayed', () => {
    const w = setup();
    for (const type of ['click', 'pointerup', 'pointerdown']) expect(w.listeners[type]![0]!.options).toEqual({ capture: true, passive: true });
    const e = { ...click(el('div')), preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    w.fire('click', e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('does nothing while the gate is closed', () => {
    const w = setup({}, false); w.fire('click', click(el('div')));
    expect(w.taps).toEqual([]);
  });

  it('skips keyboard and scripted clicks (detail 0)', () => {
    const w = setup(); w.fire('click', click(el('button'), { detail: 0 }));
    expect(w.taps).toEqual([]);
  });

  it.each([
    ['input', el('input')], ['textarea', el('textarea')], ['select', el('select')],
    ['password input', el('input', { type: 'password' })], ['contenteditable', el('div', { contenteditable: 'true' })],
    ['inside contenteditable', el('b', {}, el('div', { contenteditable: '' }))],
    ['data-pulse-ignore', el('div', { 'data-pulse-ignore': '' })], ['inside data-pulse-ignore', el('span', {}, el('section', { 'data-pulse-ignore': '' }))],
  ])('never captures %s', (_n, target) => {
    const w = setup(); w.fire('click', click(target)); w.fire('pointerup', { ...click(target), pointerType: 'touch' });
    expect(w.taps).toEqual([]);
  });

  it('captures contenteditable=false and ordinary elements', () => {
    const w = setup(); w.fire('click', click(el('div', { contenteditable: 'false' })));
    expect(w.taps).toHaveLength(1);
  });

  it('skips while the soft keyboard is visible on a touch device only', () => {
    const touch = setup({ visualViewport: { height: 300 }, navigator: { maxTouchPoints: 5 } });
    touch.fire('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5 });
    touch.fire('pointerup', { ...click(el('div')), pointerType: 'touch', clientX: 5, clientY: 5 });
    expect(touch.taps).toEqual([]);
    const desktop = setup({ visualViewport: { height: 300 } }); desktop.fire('click', click(el('div')));
    expect(desktop.taps).toHaveLength(1);
    expect(keyboardUp({ visualViewport: { height: 700 }, innerHeight: 800, navigator: { maxTouchPoints: 1 } })).toBe(false);
    expect(keyboardUp({ visualViewport: { height: 599 }, innerHeight: 800, navigator: { maxTouchPoints: 1 } })).toBe(true);
    expect(keyboardUp({ visualViewport: { height: 600 }, innerHeight: 800, navigator: { maxTouchPoints: 1 } })).toBe(false);
  });

  it('touch: counts the pointerup once (not its click) and ignores a drag', () => {
    const w = setup();
    w.fire('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
    w.fire('pointerup', { ...click(el('div')), pointerType: 'touch', clientX: 12, clientY: 12 });
    w.fire('click', click(el('div'), { pointerType: 'touch' }));
    expect(w.taps).toHaveLength(1);
    w.fire('pointerdown', { pointerType: 'touch', clientX: 10, clientY: 10 });
    w.fire('pointerup', { ...click(el('div')), pointerType: 'touch', clientX: 80, clientY: 10 });
    expect(w.taps).toHaveLength(1);
  });

  it('survives a throwing report', () => {
    const w = world(); watchTaps(w.win, () => true, () => { throw new Error('x'); });
    expect(() => w.fire('click', click(el('div')))).not.toThrow();
  });
});

describe('dead clicks', () => {
  it('a click nothing answers within 1 s is dead', () => {
    const w = setup(); w.fire('click', click(el('div')));
    vi.advanceTimersByTime(999); expect(w.dead).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2); expect(w.dead).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a DOM mutation', (w: ReturnType<typeof setup>) => w.observers[0]!.fire()],
    ['an address change', (w: ReturnType<typeof setup>) => { w.win.location.href = 'https://in.mightys.dev/b'; }],
    ['a focus change', (w: ReturnType<typeof setup>) => { w.doc.activeElement = el('input'); }],
  ])('is not dead after %s', (_n, act) => {
    const w = setup(); w.fire('click', click(el('div')));
    act(w); vi.advanceTimersByTime(1100);
    expect(w.dead).not.toHaveBeenCalled();
  });

  it('the observer exists only while a click is pending, and one serves overlapping clicks', () => {
    const w = setup();
    expect(w.observers).toHaveLength(0);
    w.fire('click', click(el('div'))); vi.advanceTimersByTime(300); w.fire('click', click(el('div')));
    expect(w.observers).toHaveLength(1);
    vi.advanceTimersByTime(800);
    expect(w.observers[0]!.disconnected).toBe(false);
    vi.advanceTimersByTime(300);
    expect(w.observers[0]!.disconnected).toBe(true);
    expect(w.dead).toHaveBeenCalledTimes(2);
  });

  it('a mutation seen while pending keeps the click alive', () => {
    const w = setup(); w.fire('click', click(el('div')));
    vi.advanceTimersByTime(500); w.observers[0]!.fire();
    vi.advanceTimersByTime(600);
    expect(w.dead).not.toHaveBeenCalled();
  });

  it('no dead function (rage or capture dropped) means no observer at all', () => {
    const w = world(); watchTaps(w.win, () => true, () => undefined);
    w.fire('click', click(el('div')));
    expect(w.observers).toHaveLength(0);
  });
});
