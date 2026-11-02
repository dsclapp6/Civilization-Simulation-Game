// Collapsible HUD cards (notices, the message feed, the task tracker, hints): whether each is folded up is a
// per-viewer preference kept in the browser. Storage may be missing or refuse (private windows): everything
// still works, folded state then lasts for the session only.
import { h } from './dom';
import { icon } from './icons';

const KEY = 'millennia.ui.collapsed';
const memory = new Map<string, boolean>();

function readAll(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch { return {}; }
}

export function isCollapsed(name: string): boolean {
  if (memory.has(name)) return memory.get(name) as boolean;
  const v = readAll()[name] === true;
  memory.set(name, v);
  return v;
}

export function setCollapsed(name: string, on: boolean): void {
  memory.set(name, on);
  try {
    const all = readAll();
    all[name] = on;
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all));
  } catch { /* kept in memory only */ }
}

/** A small fold / unfold button: chevron up when open (fold), down when folded (unfold). */
export function foldButton(name: string, what: string, onChange: (collapsed: boolean) => void): HTMLButtonElement {
  const btn = h<HTMLButtonElement>('button.mu-fold', { type: 'button' });
  const paint = (): void => {
    const c = isCollapsed(name);
    btn.replaceChildren(icon(c ? 'chev_down' : 'chev_up', 12));
    btn.setAttribute('aria-label', c ? `Show ${what}` : `Fold ${what} away`);
    btn.setAttribute('aria-expanded', String(!c));
    btn.setAttribute('tip', c ? `Show ${what}` : `Fold ${what} away`);
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setCollapsed(name, !isCollapsed(name));
    paint();
    onChange(isCollapsed(name));
  });
  paint();
  return btn;
}
