import type { HeatTap } from '../types.js';

const SKIP = 'input,textarea,select,[contenteditable]:not([contenteditable=false]),[data-pulse-ignore]';
const SLOP = 10;

/** True while the soft keyboard probably covers the page: a touch device whose visual viewport shrank below 75%. */
export function keyboardUp(win: Record<string, any>): boolean {
  const vv = win.visualViewport;
  return !!vv && (win.navigator?.maxTouchPoints > 0 || 'ontouchstart' in win) && vv.height < win.innerHeight * 0.75;
}

/** True for a target that must never be captured: text inputs, selects, editable content, or marked to ignore. */
export function skipTarget(event: Event): boolean {
  const el = (event.composedPath?.()[0] ?? event.target) as Element | null;
  return !el?.closest || !!el.closest(SKIP);
}

/**
 * Passive capture-phase listeners: `click` for mouse and `pointerup` for touch (no drag beyond a few px). Nothing is
 * consumed or delayed. A click that nothing answers within 1 s (no address change, no DOM change, no focus change,
 * watched by one MutationObserver that exists only while a click is pending) is marked dead.
 */
export function watchTaps(win: Record<string, any>, ready: () => boolean, report: (tap: HeatTap) => (() => void) | undefined): void {
  const doc = win.document as Document | undefined;
  if (!doc?.addEventListener) return;
  let down: [number, number] | undefined;
  // Clicks waiting for an answer; the observer lives exactly as long as this set is not empty.
  const pending = new Set<{ alive: boolean }>();
  let observer: MutationObserver | undefined;
  const capture = (event: Event, x: number, y: number): void => {
    try {
      if (!ready() || keyboardUp(win) || skipTarget(event)) return;
      const root = doc.documentElement;
      const dead = report({ x, y: y + (win.scrollY || 0), width: root.clientWidth || win.innerWidth, height: win.innerHeight });
      if (!dead) return;
      const where = win.location.href;
      const focus = doc.activeElement;
      const click = { alive: false };
      if (!pending.size && typeof win.MutationObserver === 'function') {
        const o = observer = new win.MutationObserver(() => pending.forEach(c => { c.alive = true; }));
        o.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      pending.add(click);
      setTimeout(() => {
        pending.delete(click);
        if (!pending.size) { observer?.disconnect(); observer = undefined; }
        if (!click.alive && win.location.href === where && doc.activeElement === focus) dead();
      }, 1000);
    } catch { /* Capture never affects the page. */ }
  };
  doc.addEventListener('pointerdown', e => { const p = e as PointerEvent; down = p.pointerType === 'touch' ? [p.clientX, p.clientY] : undefined; }, { capture: true, passive: true });
  doc.addEventListener('pointerup', e => {
    const p = e as PointerEvent;
    if (p.pointerType !== 'touch' || !down || Math.hypot(p.clientX - down[0], p.clientY - down[1]) > SLOP) return;
    capture(e, p.clientX, p.clientY);
  }, { capture: true, passive: true });
  doc.addEventListener('click', e => {
    const c = e as MouseEvent;
    // Keyboard and scripted clicks have no position (detail 0); touch clicks are counted from their pointerup.
    if (c.detail === 0 || (c as PointerEvent).pointerType === 'touch') return;
    capture(e, c.clientX, c.clientY);
  }, { capture: true, passive: true });
}
