// "Who you are now" (docs/CIV.md §2): the card that follows taking up another life — name, age, place, role, household, what they
// were doing, and the tasks the objectives set them. It sits in the HUD's left column (the world keeps running), refreshes its
// task list while the objectives settle, and goes by itself after a while, with its cross or with Esc.
import { h } from '../core/dom';
import { plural } from '../core/format';
import { icon } from '../core/icons';
import { whoNowCard, type WhoNowCard } from '../core/liveAsModel';
import { roleAndRank } from '../core/titles';
import { button } from '../components/widgets';
import type { GameServices } from '../types';

/** The card stays this long (UI seconds) unless it is dismissed. */
export const ARRIVAL_SECONDS = 40;
/** The tasks are read again for this long after the switch (the objectives start afresh when a life is taken up). */
const SETTLE_SECONDS = 15;
/** Tasks listed on the card (the rest are in the journal). */
const MAX_TASKS = 3;

export interface ArrivalDeps {
  game(): GameServices | null;
  openJournal(): void;
}

export class ArrivalCard {
  readonly el = h('div.mu-arrival.mu-plate.mu-hide', { role: 'note', 'aria-label': 'Who you are now' });
  private model: WhoNowCard | null = null;
  private bornAt = 0;
  private lastRead = -10;
  private sig = '';
  private now = 0;

  constructor(private readonly deps: ArrivalDeps) {}

  isOn(): boolean { return this.model !== null; }

  /** The card is still reading the tasks again for the new life: they are on it, so "A new task" need not be said as well. */
  settling(now: number): boolean { return this.model !== null && now - this.bornAt < SETTLE_SECONDS; }

  /** The person now shown (tools and tests). */
  current(): WhoNowCard | null { return this.model; }

  show(model: WhoNowCard, now: number): void {
    this.model = model;
    this.bornAt = now;
    this.lastRead = now;
    this.now = now;
    this.sig = '';
    this.paint();
    this.el.classList.remove('mu-hide', 'leaving');
    // the entrance plays again for each card
    this.el.classList.remove('in');
    void this.el.offsetWidth;
    this.el.classList.add('in');
  }

  hide(): void {
    if (!this.model) return;
    this.model = null;
    this.sig = '';
    this.el.classList.add('mu-hide');
  }

  update(now: number): void {
    this.now = now;
    const m = this.model;
    if (!m) return;
    const age = now - this.bornAt;
    if (age > ARRIVAL_SECONDS) { this.hide(); return; }
    this.el.classList.toggle('leaving', age > ARRIVAL_SECONDS - 1.5);
    const game = this.deps.game();
    if (game && age < SETTLE_SECONDS && now - this.lastRead >= 1) {
      this.lastRead = now;
      const fresh = whoNowCard(game, m.id, m.doing);
      if (fresh) { this.model = fresh; this.paint(); }
    }
  }

  private paint(): void {
    const m = this.model;
    if (!m) return;
    const sig = JSON.stringify([m.id, m.tasks]);
    if (sig === this.sig) return;
    this.sig = sig;
    const doing = `${m.sex === 'm' ? 'He' : 'She'} was ${m.doing}.`;
    this.el.replaceChildren(
      h('div.mu-arrival-head', null,
        h('span.mu-arrival-ico', null, icon('user', 18)),
        h('div.mu-arrival-title', null, h('div.mu-arrival-kicker', null, 'You are now'), h('div.mu-arrival-name', null, m.name)),
        h('button.mu-guide-x', { type: 'button', 'aria-label': 'Dismiss', tip: 'Dismiss (Esc)', onclick: () => this.hide() }, icon('cross', 13))),
      h('div.mu-arrival-sub', null, `${plural(m.age, 'year')} old · ${roleAndRank(m.role, m.rankName)}`),
      h('div.mu-arrival-where', null, icon('pin', 13), `${m.place} · ${m.household}${m.house ? ` · ${m.house}` : ''}`),
      h('p.mu-arrival-doing', null, doing),
      m.tasks.length
        ? h('div.mu-arrival-tasks', null,
          h('div.mu-arrival-tasks-head', null, icon('flag', 13), 'Your tasks', h('span.mu-grow'),
            button('Journal', { size: 'small', variant: 'ghost', icon: 'scroll', onClick: () => this.deps.openJournal() })),
          // a line each (the card must leave room for the rest of the column); the first, the tracked one, says what to do next
          m.tasks.slice(0, MAX_TASKS).map((t, i) => h('div.mu-arrival-task', { class: t.tracked ? 'tracked' : '', tip: t.step ? `${t.title}: ${t.step}` : t.title },
            h('b', null, t.title), i === 0 && t.step ? h('span.mu-arrival-step', null, t.step) : null)),
          m.tasks.length > MAX_TASKS ? h('div.mu-arrival-more', null, `and ${m.tasks.length - MAX_TASKS} more in the journal`) : null)
        : h('p.mu-arrival-none', null, 'Nothing is asked of you yet. Press Y to see what is worth doing.'),
    );
  }
}
