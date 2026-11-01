// "What now?" (Y): a card that is always one key away and says what is worth doing right now — the tracked task's
// next step first, then what the hour and the day suggest (it is getting dark: go home; market day: sell your
// eggs; a holy day: Mass, then the butts). Each line can be followed: it tracks the task or pins the place, so the
// compass, the minimap and the screen edge point at it.
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { suggestionSignature } from '../core/objectiveModel';
import { where } from '../core/nav';
import { button } from '../components/widgets';
import type { Spot } from '../core/finder';
import type { Suggestion } from '../../sim/objectives/types';
import type { GameServices } from '../types';
import type { NavState } from './navstate';

export interface WhatNowDeps {
  game(): GameServices | null;
  nav: NavState;
  /** Mark a place (compass, minimap, screen edge, and a beacon in the world when the objectives module can). */
  show(spot: Spot): void;
  say(text: string): void;
  openJournal(): void;
}

const REFRESH = 2;
const AUTO_CLOSE = 30;

export class WhatNow {
  readonly el = h('div.mu-whatnow.mu-plate.mu-hide');
  private readonly list = h('div.mu-whatnow-list');
  private openedAt = 0;
  private lastRefresh = -10;
  private sig = '';
  private shown = false;
  private now = 0;

  constructor(private readonly deps: WhatNowDeps) {
    this.el.append(
      h('div.mu-whatnow-head', null,
        icon('question', 16), h('b', null, 'What now?'), h('span.mu-grow'),
        h('button.mu-x.small', { type: 'button', 'aria-label': 'Close', tip: 'Close (Y)', onclick: () => this.close() }, icon('cross', 12))),
      this.list,
      h('div.mu-whatnow-foot', null, h('span.mu-dim.mu-tiny', null, 'Choose one to be shown the way.'), h('span.mu-grow'),
        button('Journal', { size: 'small', icon: 'scroll', onClick: () => { this.close(); this.deps.openJournal(); } })),
    );
  }

  isOpen(): boolean { return this.shown; }

  toggle(): void { if (this.shown) this.close(); else this.open(); }

  open(): void {
    this.shown = true;
    this.openedAt = this.now;
    this.lastRefresh = -10;
    this.sig = '';
    this.el.classList.remove('mu-hide');
    this.refresh();
  }

  close(): void {
    this.shown = false;
    this.el.classList.add('mu-hide');
  }

  update(now: number): void {
    this.now = now;
    if (!this.shown) return;
    if (now - this.openedAt > AUTO_CLOSE) { this.close(); return; }
    if (now - this.lastRefresh >= REFRESH) this.refresh();
  }

  private refresh(): void {
    this.lastRefresh = this.now;
    const game = this.deps.game();
    const api = game?.objectives;
    if (!api) { this.list.replaceChildren(h('p.mu-dim.mu-ital.mu-small', null, 'Nothing is asked of you.')); return; }
    const items = api.suggestions(4);
    const sig = suggestionSignature(items);
    if (sig === this.sig) return;
    this.sig = sig;
    if (!items.length) {
      this.list.replaceChildren(h('p.mu-dim.mu-ital.mu-small', null, 'Nothing presses. Walk about, talk to people, see what the day brings.'));
      return;
    }
    this.list.replaceChildren(...items.map((s, i) => this.row(s, i, game)));
  }

  private row(s: Suggestion, i: number, game: GameServices | null): HTMLElement {
    const nav = this.deps.nav;
    const t = s.target;
    const dist = t ? where(nav.x, nav.z, t.x, t.z) : '';
    const el = h<HTMLButtonElement>('button.mu-whatnow-row', { type: 'button', class: i === 0 ? 'first' : '' },
      h('span.mu-whatnow-n', null, String(i + 1)),
      h('span.mu-whatnow-text', null, h('span', null, s.text), dist ? h('span.mu-whatnow-where', null, icon('pin', 12), dist) : null),
      t || s.objective !== undefined ? h('span.mu-whatnow-go', null, 'Show me') : null);
    el.addEventListener('click', () => {
      const api = game?.objectives;
      // a task is tracked (its marker follows its steps); anything else with a place on it is marked there
      if (s.objective !== undefined) api?.track(s.objective);
      if (t && (s.objective === undefined || !api?.trackPlace)) this.deps.show({ ...t, label: t.label || s.text });
      this.deps.say(t ? `Showing the way: ${t.label || s.text}.` : s.text);
      this.close();
    });
    return el;
  }
}
