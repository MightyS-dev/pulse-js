import type { ControlState } from '../types.js';

/** What the buttons do. The engine decides per kind; the screen only calls them. */
export interface Actions { primary(): void; secondary(): void }

export interface Ui {
  show(state: ControlState, actions: Actions): void;
  hide(): void;
}

const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.root{--bg:#fff;--fg:#14171c;--muted:#566070;--line:#d6dbe3;--accent:#1f5eff;--on:#fff;--scrim:rgba(10,14,20,.55);font:1rem/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
@media(prefers-color-scheme:dark){.root{--bg:#161a20;--fg:#eef1f5;--muted:#a3adbb;--line:#323a46;--accent:#7ba0ff;--on:#0b1220;--scrim:rgba(0,0,0,.65)}}
.scrim{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--scrim);animation:in .18s ease-out}
.scrim.full{background:var(--bg);padding:24px}
.panel{width:100%;max-width:420px;max-height:100%;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:24px;box-shadow:0 12px 40px rgba(0,0,0,.25);outline:none}
.full .panel{max-width:440px;border:0;box-shadow:none;text-align:center;padding:16px}
h1{margin:0 0 8px;font-size:1.3rem;line-height:1.25;overflow-wrap:anywhere}
p{margin:0 0 20px;color:var(--muted);white-space:pre-line;overflow-wrap:anywhere}
.row{display:flex;flex-direction:column;gap:8px}
button{font:inherit;min-height:44px;padding:10px 16px;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on);font-weight:600}
button:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.bar{position:fixed;left:0;right:0;top:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:center;padding:10px 16px;background:var(--accent);color:var(--on);font-size:.9rem;text-align:center;overflow-wrap:anywhere}
.bar.test{background:#f5b301;color:#2b2100;font-weight:600}
.bar button{min-height:32px;padding:4px 10px;border-radius:8px;border-color:currentColor;color:inherit}
@keyframes in{from{opacity:0}to{opacity:1}}
@media(prefers-reduced-motion:reduce){.scrim{animation:none}}
`;

const BLOCKING = new Set(['maintenance', 'updateRequired', 'versionBlocked']);
const FOCUSABLE = 'button,[href],[tabindex]:not([tabindex="-1"])';

/**
 * The built-in screens in a closed Shadow DOM (the page's CSS never reaches them and they never reach the page). Text is
 * always set as text, never as markup. A screen that cannot be closed (`allowContinue` false) traps the focus, makes the
 * page behind it inert and ignores Escape; every other screen closes with Escape or its second button.
 */
export function createUi(doc: Document): Ui {
  let host: HTMLElement | undefined;
  let shadow: ShadowRoot | undefined;
  let release: (() => void) | undefined;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string, onClick: () => void, className = ''): HTMLButtonElement => {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', () => { try { onClick(); } catch { /* A screen never breaks the app. */ } });
    return node;
  };

  /** Makes the rest of the page inert and traps the focus inside `panel` until the returned function runs. */
  function lock(panel: HTMLElement, trap: boolean): () => void {
    const root = doc.documentElement;
    const kept: [Element, boolean][] = [];
    for (const child of Array.from(doc.body?.children ?? [])) {
      if (child === host) continue;
      kept.push([child, (child as HTMLElement).inert]);
      (child as HTMLElement).inert = true;
    }
    const overflow = root.style.overflow;
    root.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !trap) return;
      const items = Array.from(shadow!.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) { event.preventDefault(); panel.focus(); return; }
      const at = items.indexOf(shadow!.activeElement as HTMLElement);
      const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at < 0 || at === items.length - 1 ? 0 : at + 1);
      event.preventDefault();
      items[next]!.focus();
    };
    // Focus that leaves the screen (a script, a browser shortcut) is brought back.
    const onFocus = (event: Event): void => { if (trap && event.target !== host) panel.focus(); };
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('focusin', onFocus, true);
    return () => {
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('focusin', onFocus, true);
      for (const [child, was] of kept) (child as HTMLElement).inert = was;
      root.style.overflow = overflow;
    };
  }

  function hide(): void {
    release?.();
    release = undefined;
    host?.remove();
    host = shadow = undefined;
  }

  function show(state: ControlState, actions: Actions): void {
    hide();
    if (state.kind === 'normal') return;
    host = el('div');
    host.setAttribute('data-pulse-ignore', '');
    shadow = host.attachShadow({ mode: 'closed' });
    const root = el('div', 'root');
    shadow.append(el('style', undefined, CSS), root);
    const mount = (): void => { (doc.body ?? doc.documentElement).append(host!); };

    if (state.kind === 'maintenanceUpcoming') {
      const bar = el('div', 'bar');
      bar.setAttribute('role', 'status');
      bar.append(el('span', undefined, state.body ?? ''));
      if (state.secondaryButtonText) {
        const close = button('×', actions.secondary);
        close.setAttribute('aria-label', state.secondaryButtonText);
        bar.append(close);
      }
      root.append(bar);
      mount();
      return;
    }

    const blocking = BLOCKING.has(state.kind) && !state.allowContinue;
    const full = BLOCKING.has(state.kind);
    const scrim = el('div', `scrim${full ? ' full' : ''}`);
    const panel = el('div', 'panel');
    panel.setAttribute('role', blocking ? 'alertdialog' : 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.tabIndex = -1;
    const title = el('h1', undefined, state.title ?? '');
    title.id = 'title';
    const body = el('p', undefined, state.body ?? '');
    body.id = 'body';
    if (state.title) panel.setAttribute('aria-labelledby', 'title'); else title.hidden = true;
    panel.setAttribute('aria-describedby', 'body');
    const row = el('div', 'row');
    if (state.buttonText) row.append(button(state.buttonText, actions.primary, 'primary'));
    if (state.secondaryButtonText && state.allowContinue) row.append(button(state.secondaryButtonText, actions.secondary));
    panel.append(title, body, row);
    scrim.append(panel);
    root.append(scrim);
    if (state.isTestBuild && state.testBuildText) {
      const bar = el('div', 'bar test');
      bar.setAttribute('role', 'status');
      bar.append(el('span', undefined, state.testBuildText));
      root.append(bar);
    }
    // Escape closes what can be closed. A screen that cannot be closed swallows it.
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (!blocking && state.allowContinue) actions.secondary();
    };
    doc.addEventListener('keydown', onEscape, true);
    const unlock = lock(panel, true);
    release = () => { doc.removeEventListener('keydown', onEscape, true); unlock(); };
    mount();
    ((row.querySelector('button') as HTMLElement | null) ?? panel).focus();
  }

  return { show, hide };
}
