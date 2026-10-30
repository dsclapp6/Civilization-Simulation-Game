// Small reusable widgets: buttons, bars, chips, tabs, switches, sliders, headings.
import { h, type Child } from '../core/dom';
import { clamp01 } from '../core/format';
import { icon, type IconName } from '../core/icons';

export interface ButtonOptions {
  variant?: '' | 'primary' | 'danger' | 'ghost' | 'on';
  size?: '' | 'small' | 'big';
  icon?: IconName;
  tip?: string;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  class?: string;
}

export function button(label: Child, o: ButtonOptions = {}): HTMLButtonElement {
  const cls = ['mu-btn', o.variant ?? '', o.size ?? '', o.class ?? ''].filter(Boolean).join(' ');
  const el = h<HTMLButtonElement>('button', { class: cls, type: 'button', tip: o.tip, disabled: o.disabled });
  if (o.icon) el.appendChild(icon(o.icon, o.size === 'big' ? 20 : 16));
  if (label !== null && label !== undefined && label !== '') el.append(h('span', null, label));
  if (o.onClick) {
    const fn = o.onClick;
    el.addEventListener('click', (e) => { if (!el.disabled) fn(e); });
  }
  return el;
}

export function iconButton(name: IconName, tip: string, onClick: (e: MouseEvent) => void, o: { small?: boolean; variant?: ButtonOptions['variant']; disabled?: boolean } = {}): HTMLButtonElement {
  const cls = ['mu-btn', 'icon', o.small ? 'small' : '', o.variant ?? ''].filter(Boolean).join(' ');
  const el = h<HTMLButtonElement>('button', { class: cls, type: 'button', tip, 'aria-label': tip, disabled: o.disabled }, icon(name, o.small ? 14 : 17));
  el.addEventListener('click', (e) => { if (!el.disabled) onClick(e); });
  return el;
}

export function chip(text: Child, tone: '' | 'gold' | 'lapis' | 'vermilion' | 'green' | 'ink' = '', ico?: IconName, tip?: string): HTMLElement {
  return h('span.mu-chip', { class: tone, tip }, ico ? icon(ico, 13) : null, text);
}

export function keycap(text: string, dark = false): HTMLElement {
  return h('span.mu-key', { class: dark ? 'dark' : '' }, text);
}

export interface BarHandle { el: HTMLElement; set(value: number, max?: number): void }

/** A trough with a fill; `kind` picks the colour (hp, sta, xp, lapis, green, vermilion, gold). */
export function bar(kind: string, value = 0, o: { thin?: boolean; slim?: boolean; ghost?: number } = {}): BarHandle {
  const fill = h('i');
  const el = h('div.mu-bar', { class: `${kind}${o.thin ? ' thin' : ''}${o.slim ? ' slim' : ''}` });
  if (o.ghost !== undefined) {
    const g = h('i.ghost');
    g.style.transform = `scaleX(${clamp01(o.ghost)})`;
    el.appendChild(g);
  }
  el.appendChild(fill);
  let last = -1;
  const set = (v: number, max = 1): void => {
    const f = max > 0 ? clamp01(v / max) : 0;
    if (Math.abs(f - last) < 0.002) return;
    last = f;
    fill.style.transform = `scaleX(${f})`;
  };
  set(value);
  return { el, set };
}

/** Stat bar: the trained level in full colour over a ghost of the potential, with a cap tick at 18. */
export function statBar(trained: number, potential: number, scaleMax = 20): HTMLElement {
  const el = h('div.mu-bar.lapis.stat');
  const pot = h('i.ghost');
  pot.style.transform = `scaleX(${clamp01(potential / scaleMax)})`;
  const val = h('i');
  val.style.transform = `scaleX(${clamp01(trained / scaleMax)})`;
  const cap = h('b.mu-captick');
  cap.style.left = `${(18 / scaleMax) * 100}%`;
  el.append(pot, val, cap);
  return el;
}

export interface TabItem { id: string; label: string; icon?: IconName; badge?: string | number; locked?: boolean; tip?: string }

export interface TabsHandle { el: HTMLElement; set(id: string): void; badge(id: string, value: string | number | null): void }

export function tabs(items: readonly TabItem[], active: string, onSelect: (id: string) => void): TabsHandle {
  const buttons = new Map<string, HTMLButtonElement>();
  const el = h('div.mu-tabs', { role: 'tablist' });
  for (const it of items) {
    const b = h<HTMLButtonElement>('button.mu-tab', { type: 'button', role: 'tab', tip: it.tip, class: `${it.id === active ? 'active' : ''}${it.locked ? ' locked' : ''}` },
      it.icon ? icon(it.icon, 16) : null, it.label,
      it.badge !== undefined ? h('span.mu-chip.gold', null, String(it.badge)) : null,
      it.locked ? icon('lock', 13) : null);
    b.addEventListener('click', () => onSelect(it.id));
    buttons.set(it.id, b);
    el.appendChild(b);
  }
  return {
    el,
    set(id) { for (const [k, b] of buttons) b.classList.toggle('active', k === id); },
    badge(id, value) {
      const b = buttons.get(id);
      if (!b) return;
      b.querySelector('.mu-chip')?.remove();
      if (value !== null && value !== '' && value !== 0) b.insertBefore(h('span.mu-chip.gold', null, String(value)), b.querySelector('svg:last-child'));
    },
  };
}

export function seg<T extends string>(options: ReadonlyArray<{ id: T; label: string; tip?: string }>, value: T, onChange: (v: T) => void): HTMLElement {
  const el = h('div.mu-seg', { role: 'radiogroup' });
  const buttons: HTMLButtonElement[] = [];
  options.forEach((o) => {
    const b = h<HTMLButtonElement>('button', { type: 'button', role: 'radio', tip: o.tip, class: o.id === value ? 'on' : '' }, o.label);
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.classList.toggle('on', x === b));
      onChange(o.id);
    });
    buttons.push(b);
    el.appendChild(b);
  });
  return el;
}

export function toggle(checked: boolean, onChange: (v: boolean) => void, label = 'Toggle'): HTMLButtonElement {
  const el = h<HTMLButtonElement>('button.mu-switch', { type: 'button', role: 'switch', 'aria-checked': String(checked), 'aria-label': label });
  el.addEventListener('click', () => {
    const next = el.getAttribute('aria-checked') !== 'true';
    el.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return el;
}

export function slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
  const el = h<HTMLInputElement>('input.mu-range', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  el.addEventListener('input', () => onInput(Number(el.value)));
  return el;
}

/** A section heading with the thin double rule trailing off to the right. */
export function heading(text: Child, ico?: IconName, right?: Child): HTMLElement {
  return h('h3.mu-h3', null, ico ? icon(ico, 16) : null, text, right ? h('span.mu-heading-right', null, right) : null);
}

export function empty(text: string): HTMLElement {
  return h('p.mu-empty', null, text);
}

/** Filled / empty pips, e.g. rank markers. */
export function pips(filled: number, total: number, cls = ''): HTMLElement {
  const el = h('span.mu-pips', { class: cls });
  for (let i = 0; i < total; i++) el.appendChild(h('i', { class: i < filled ? 'on' : '' }));
  return el;
}

/** Two-column key/value list. */
export function kv(rows: ReadonlyArray<readonly [Child, Child]>): HTMLElement {
  const dl = h('dl.mu-kv');
  for (const [k, v] of rows) { dl.appendChild(h('dt', null, k)); dl.appendChild(h('dd', null, v)); }
  return dl;
}

/** Ornamental divider used between big sections. */
export function rule(soft = false): HTMLElement { return h('div.mu-rule', { class: soft ? 'soft' : '' }); }

/** A little face-down "page" skeleton while data loads. */
export function placeholder(text = '…'): HTMLElement { return h('p.mu-dim.mu-ital', null, text); }
