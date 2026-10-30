// Tiny DOM toolkit: a hyperscript helper, SVG helper and a few element utilities. All dynamic text goes
// through text nodes (never innerHTML), so names from the simulation can never inject markup.

export type Child = Node | string | number | null | undefined | false | readonly Child[];
export type Attrs = Record<string, unknown>;

const SVG_NS = 'http://www.w3.org/2000/svg';

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'scrollTop', 'scrollLeft']);

function parseSelector(sel: string): { tag: string; id: string; classes: string[] } {
  let tag = '';
  let i = 0;
  while (i < sel.length && sel[i] !== '.' && sel[i] !== '#') i++;
  tag = sel.slice(0, i) || 'div';
  let id = '';
  const classes: string[] = [];
  while (i < sel.length) {
    const kind = sel[i++];
    let j = i;
    while (j < sel.length && sel[j] !== '.' && sel[j] !== '#') j++;
    const name = sel.slice(i, j);
    if (kind === '#') id = name; else if (name) classes.push(name);
    i = j;
  }
  return { tag, id, classes };
}

function isAttrs(v: unknown): v is Attrs {
  return typeof v === 'object' && v !== null && !(v instanceof Node) && !Array.isArray(v);
}

function appendChildren(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(parent, c as readonly Child[]);
    else if (c instanceof Node) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (v === undefined || v === null || v === false) {
      if (PROPS.has(key) && key !== 'value') (el as unknown as Record<string, unknown>)[key] = false;
      continue;
    }
    if (key === 'class') { if (v) el.classList.add(...String(v).split(/\s+/).filter(Boolean)); continue; }
    if (key === 'style') {
      const st = (el as HTMLElement).style;
      if (typeof v === 'string') st.cssText += v;
      else for (const k of Object.keys(v as Record<string, unknown>)) {
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined || val === null) continue;
        if (k.startsWith('--')) st.setProperty(k, String(val));
        else (st as unknown as Record<string, unknown>)[k] = val;
      }
      continue;
    }
    if (key === 'dataset') { for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) (el as HTMLElement).dataset[dk] = String(dv); continue; }
    if (key === 'tip') { el.setAttribute('data-tip', String(v)); continue; }
    if (key === 'text') { el.textContent = String(v); continue; }
    if (key.startsWith('on') && typeof v === 'function') { el.addEventListener(key.slice(2).toLowerCase(), v as EventListener); continue; }
    if (PROPS.has(key)) { (el as unknown as Record<string, unknown>)[key] = v; continue; }
    if (v === true) { el.setAttribute(key, ''); continue; }
    el.setAttribute(key, String(v));
  }
}

/** `h('div.card.big#id', { onclick }, child, 'text', [more])` */
export function h<T extends HTMLElement = HTMLElement>(sel: string, attrsOrChild?: Attrs | Child, ...children: Child[]): T {
  const { tag, id, classes } = parseSelector(sel);
  const el = document.createElement(tag) as T;
  if (id) el.id = id;
  if (classes.length) el.classList.add(...classes);
  if (attrsOrChild !== undefined && attrsOrChild !== null) {
    if (isAttrs(attrsOrChild)) applyAttrs(el, attrsOrChild);
    else appendChildren(el, [attrsOrChild as Child]);
  }
  appendChildren(el, children);
  return el;
}

export function svgEl<T extends SVGElement = SVGElement>(tag: string, attrs?: Attrs | null, ...children: Child[]): T {
  const el = document.createElementNS(SVG_NS, tag) as T;
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.setAttribute('class', String(v));
      else if (k === 'style' && typeof v === 'string') el.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else el.setAttribute(k, String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

/** Parses a trusted, static SVG/HTML string (icons, ornaments). Never pass dynamic text here. */
export function staticSvg(markup: string): SVGElement {
  const wrap = document.createElementNS(SVG_NS, 'svg');
  wrap.innerHTML = markup;
  return wrap;
}

export function clear(el: Element): void { el.replaceChildren(); }

export function replace(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  appendChildren(el, children);
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions,
): () => void {
  target.addEventListener(type, fn as EventListener, opts);
  return () => target.removeEventListener(type, fn as EventListener, opts);
}

export function toggleClass(el: Element, cls: string, on: boolean): void { el.classList.toggle(cls, on); }

/** Remembers the last value written, so per-frame updates touch the DOM only when something changed. */
export function textBinder(el: Node): (value: string) => void {
  let last: string | null = null;
  return (value) => { if (value !== last) { last = value; el.textContent = value; } };
}

export function styleBinder(el: HTMLElement, prop: string): (value: string) => void {
  let last: string | null = null;
  return (value) => { if (value !== last) { last = value; el.style.setProperty(prop, value); } };
}

export function classBinder(el: Element, cls: string): (on: boolean) => void {
  let last: boolean | null = null;
  return (flag) => { if (flag !== last) { last = flag; el.classList.toggle(cls, flag); } };
}

export function attrBinder(el: Element, name: string): (value: string | null) => void {
  let last: string | null | undefined;
  return (value) => {
    if (value === last) return;
    last = value;
    if (value === null) el.removeAttribute(name); else el.setAttribute(name, value);
  };
}

/** True when the element is a text-entry control (hotkeys must not fire while typing). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type;
    return !(type === 'range' || type === 'checkbox' || type === 'radio' || type === 'button');
  }
  return t.isContentEditable;
}
