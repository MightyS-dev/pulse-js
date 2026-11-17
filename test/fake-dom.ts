/** A very small DOM: only what the App Control screens use, so that the screens can be tested without a browser. */
type Listener = (event: any) => void;

export class FakeNode {
  tagName: string;
  className = '';
  textContent = '';
  id = '';
  type = '';
  hidden = false;
  inert = false;
  tabIndex = 0;
  children: FakeNode[] = [];
  parent: FakeNode | undefined;
  attrs = new Map<string, string>();
  listeners = new Map<string, Listener[]>();
  shadow: FakeNode | undefined;
  mode: string | undefined;
  hostEl: FakeNode | undefined;
  style: Record<string, string> = {};
  doc: FakeDocument;

  constructor(tag: string, doc: FakeDocument) { this.tagName = tag; this.doc = doc; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  append(...nodes: FakeNode[]): void { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  removeEventListener(type: string, listener: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(l => l !== listener)); }
  attachShadow(init: { mode: string }): FakeNode {
    this.mode = init.mode;
    this.shadow = new FakeNode('#shadow', this.doc);
    this.shadow.hostEl = this;
    return this.shadow;
  }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = undefined; }
  focus(): void { this.doc.focus(this); }
  click(): void { for (const l of this.listeners.get('click') ?? []) l({ target: this }); }
  get activeElement(): FakeNode | undefined { return this.doc.active; }
  all(): FakeNode[] { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelectorAll(): FakeNode[] {
    // The screens ask for buttons, links and explicit tab stops only.
    return this.all().filter(n => n.tagName === 'button' || n.attrs.has('href') || (n.attrs.has('tabindex') && n.attrs.get('tabindex') !== '-1'));
  }
  querySelector(selector: string): FakeNode | null { return this.all().find(n => n.tagName === selector) ?? null; }
  find(predicate: (n: FakeNode) => boolean): FakeNode | undefined { return this.all().find(predicate); }
}

export class FakeDocument {
  body = new FakeNode('body', this);
  documentElement = new FakeNode('html', this);
  active: FakeNode | undefined;
  listeners = new Map<string, { listener: Listener; capture: boolean }[]>();
  constructor() { this.documentElement.append(this.body); }
  createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
  focus(node: FakeNode): void {
    this.active = node;
    // Focus inside a closed shadow root is seen from outside as the host element.
    let top: FakeNode = node;
    while (top.parent) top = top.parent;
    this.dispatch('focusin', { target: top.hostEl ?? node });
  }
  addEventListener(type: string, listener: Listener, capture?: boolean): void { this.listeners.set(type, [...this.listeners.get(type) ?? [], { listener, capture: capture === true }]); }
  removeEventListener(type: string, listener: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(l => l.listener !== listener)); }
  dispatch(type: string, event: Record<string, unknown>): { defaultPrevented: boolean } {
    const full = { defaultPrevented: false, preventDefault() { full.defaultPrevented = true; }, ...event };
    for (const { listener } of this.listeners.get(type) ?? []) listener(full);
    return full;
  }
  key(key: string, shift = false): { defaultPrevented: boolean } { return this.dispatch('keydown', { key, shiftKey: shift }); }
}
