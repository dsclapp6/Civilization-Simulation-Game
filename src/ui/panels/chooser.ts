// A list for choosing someone to live as (docs/CIV.md §2): a search over everyone alive by name, place or trade at the top, then the
// ones suggested first (your family and House) and people near. The death screen and the "Live as someone" chooser (V with nobody in front of you,
// the captivity card's "live as someone else") both use it.
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { PeopleIndex, type PersonHit } from '../core/liveAsModel';
import { chip } from '../components/widgets';
import type { PanelCtx } from '../app/panel';

/** One person as a compact choosable row: name, age, trade, place, rank. */
export function hitEl(hit: PersonHit, selected: boolean, onPick: () => void, note?: string): HTMLElement {
  const el = h('div.mu-card.click.mu-succ.compact', { class: selected ? 'sel' : '', role: 'radio', 'aria-checked': String(selected), tabindex: '0' },
    h('div.mu-row.mu-between.mu-top', null,
      h('div.mu-grow', null, h('h4', null, hit.name), h('div.mu-dim.mu-small', null, `${note ? `${note} · ` : ''}${hit.age} years old · ${hit.role} · ${hit.place || 'the road'}`)),
      selected ? h('span.mu-tier-check.static', null, icon('check', 16)) : chip(hit.rankName, 'gold', 'shield')));
  el.addEventListener('click', onPick);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } });
  return el;
}

/** A person suggested first, drawn the way the caller likes (the death screen shows their strengths). */
export interface ChooserSuggestion {
  id: number;
  first: string;
  el(selected: boolean, pick: () => void): HTMLElement;
}

export interface ChooserOptions {
  suggested: readonly ChooserSuggestion[];
  suggestedTitle?: string;
  nearby: readonly PersonHit[];
  nearTitle?: string;
  /** Left out of the search results (the person who is leaving, the ones already listed). */
  exclude: ReadonlySet<number>;
  /** People of this settlement rank first in the search. */
  near?: number;
  selected(): number | null;
  pick(id: number, first: string): void;
}

export interface Chooser {
  /** The scrolling list with its three sections. */
  el: HTMLElement;
  /** Draws the rows again (the selection changed). */
  render(): void;
  /** How many people are alive (the index is built by the first call). */
  alive(): number;
}

export function personChooser(ctx: PanelCtx, o: ChooserOptions): Chooser {
  const famList = h('div.mu-col.mu-gap-8.mu-succ-family');
  const nearList = h('div.mu-col.mu-gap-6.mu-succ-near');
  const results = h('div.mu-col.mu-gap-6.mu-succ-results');
  const resultsHead = h('div.mu-succ-head.mu-hide', null, icon('search', 14), 'Anyone alive');
  const index = new PeopleIndex(ctx.game);
  const searchBox = h<HTMLInputElement>('input.mu-input', { type: 'search', placeholder: 'Anyone alive: a name, a place, a trade', 'aria-label': 'Search everyone alive', autocomplete: 'off', spellcheck: 'false' });
  let hits: PersonHit[] = [];
  let more = false;
  const search = (): void => {
    const found = index.search(searchBox.value, 13, { exclude: o.exclude, near: o.near });
    more = found.length > 12;
    hits = found.slice(0, 12);
    render();
  };
  searchBox.addEventListener('input', search);

  const render = (): void => {
    const sel = o.selected();
    famList.replaceChildren(...o.suggested.map((c) => c.el(sel === c.id, () => o.pick(c.id, c.first))));
    nearList.replaceChildren(...o.nearby.map((n) => hitEl(n, sel === n.id, () => o.pick(n.id, n.first))));
    const q = searchBox.value.trim();
    const rows: HTMLElement[] = hits.map((n) => hitEl(n, sel === n.id, () => o.pick(n.id, n.first)));
    if (more) rows.push(h('p.mu-tiny.mu-dim.mu-ital', null, 'More people match: add a word to narrow the search.'));
    else if (!hits.length && q) rows.push(h('p.mu-small.mu-dim.mu-ital', null, 'Nobody alive matches that.'));
    results.replaceChildren(...rows);
    resultsHead.classList.toggle('mu-hide', !q);
  };
  render();

  // the search stays at the top of the list, in view however far the list is scrolled: anyone alive is one word away
  const el = h('div.mu-scroll.mu-succ-list', null,
    h('div.mu-succ-search', null, searchBox),
    resultsHead,
    results,
    o.suggested.length ? h('div.mu-succ-head', null, icon('tree', 14), o.suggestedTitle ?? 'Your family and House') : null,
    o.suggested.length ? famList : null,
    o.nearby.length ? h('div.mu-succ-head', null, icon('pin', 14), o.nearTitle ?? 'Near you') : null,
    o.nearby.length ? nearList : null);
  return { el, render, alive: () => index.size };
}
