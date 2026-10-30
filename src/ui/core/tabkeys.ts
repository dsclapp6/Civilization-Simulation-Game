// Keyboard for tabbed pages: ← → (and 1–9) switch the tab, ↑ ↓ PgUp PgDn scroll the content.
import type { KeyIntent } from './keys';

/** Returns the `key` handler of a panel. `ids` are the tab ids in order; `locked` ids are skipped by the arrows. */
export function tabKeys(
  ids: readonly string[],
  current: () => string,
  select: (id: string) => void,
  scroller?: HTMLElement | (() => HTMLElement | null),
  locked?: (id: string) => boolean,
): (intent: KeyIntent, e: KeyboardEvent) => boolean {
  return (intent) => {
    const open = (list: readonly string[]): string[] => list.filter((id) => !locked?.(id));
    if (intent.type === 'digit') {
      const id = ids[intent.n - 1];
      if (!id || locked?.(id)) return false;
      select(id);
      return true;
    }
    if (intent.type === 'arrow' && (intent.dir === 'left' || intent.dir === 'right')) {
      const list = open(ids);
      const i = list.indexOf(current());
      if (list.length < 2) return false;
      const next = list[(i + (intent.dir === 'right' ? 1 : -1) + list.length) % list.length];
      select(next);
      return true;
    }
    const el = typeof scroller === 'function' ? scroller() : scroller;
    if (el && (intent.type === 'page' || (intent.type === 'arrow' && (intent.dir === 'up' || intent.dir === 'down')))) {
      const big = intent.type === 'page';
      const dir = intent.dir === 'down' ? 1 : -1;
      el.scrollBy({ top: dir * (big ? el.clientHeight * 0.85 : 70), behavior: 'auto' });
      return true;
    }
    return false;
  };
}
