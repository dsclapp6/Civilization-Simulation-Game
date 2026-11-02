// The objective tracker (under the player plate): the task being tracked, which step is next and how to do it,
// how far it is and which way, and two buttons — the journal (O) and "What now?" (Y). It is the answer to
// "what am I supposed to be doing?" and sits where the eye already is.
import { foldButton, isCollapsed } from '../core/collapse';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { relativeYaw, sideWord, where } from '../core/nav';
import {
  SOURCE_ICON, currentStep, objectiveSignature, progressFraction, progressText, sourceLine, stepPips,
} from '../core/objectiveModel';
import { dueLine } from '../core/objectiveModel';
import { bar, type BarHandle } from '../components/widgets';
import type { Objective } from '../../sim/objectives/types';
import type { GameServices } from '../types';
import type { NavState } from './navstate';

export interface TrackerDeps {
  game(): GameServices | null;
  nav: NavState;
  openJournal(): void;
  whatNow(): void;
  nameOf(id: number): string;
}

export class Tracker {
  readonly el = h('div.mu-tracker.mu-plate.mu-hide');
  private readonly src = h('span.mu-tracker-src');
  private readonly pips = h('span.mu-tracker-pips');
  private readonly title = h('div.mu-tracker-title');
  private readonly step = h('div.mu-tracker-step');
  private readonly hint = h('div.mu-tracker-hint');
  private readonly prog = h('div.mu-tracker-prog.mu-hide');
  private readonly progBar: BarHandle = bar('gold', 0, { thin: true });
  private readonly progText = h('span.mu-tracker-prog-text');
  private readonly where = h('div.mu-tracker-where.mu-hide');
  private readonly whereArrow = h('span.mu-tracker-arrow', null, icon('arrow_up', 15));
  private readonly whereText = h('span');
  private readonly reward = h('div.mu-tracker-reward.mu-hide');
  private readonly empty = h('div.mu-tracker-empty.mu-hide', null, 'Nothing is asked of you just now. Press ', h('span.mu-key', null, 'Y'), ' to see what is worth doing.');
  private readonly body = h('div.mu-tracker-body');
  private sig = '';
  /** The module's change counter when the tracked task was last read (it says when anything about the tasks changed). */
  private version = -2;
  private checkedAt = -10;
  private cur: Objective | null = null;
  private lastTargetText = '';
  private flashUntil = 0;
  private now = 0;

  constructor(private readonly deps: TrackerDeps) {
    this.where.append(this.whereArrow, this.whereText);
    this.prog.append(this.progBar.el, this.progText);
    // folded, the card keeps its title (the task) and hides the step, hint, distance and reward
    const fold = foldButton('tracker', 'the task card', (c) => this.el.classList.toggle('folded', c));
    this.el.classList.toggle('folded', isCollapsed('tracker'));
    this.body.append(
      h('div.mu-tracker-top', null, this.src, h('span.mu-row.mu-gap-4', null, this.pips, fold)),
      this.title, this.step, this.hint, this.prog, this.where, this.reward,
    );
    this.el.append(
      this.body, this.empty,
      h('div.mu-tracker-foot', null,
        h('button.mu-btn.small', { type: 'button', tip: 'Your tasks, the day, the people you know and the places (O)', onclick: () => this.deps.openJournal() }, icon('scroll', 14), 'Journal ', h('span.mu-key', null, 'O')),
        h('button.mu-btn.small.primary', { type: 'button', tip: 'What is worth doing right now (Y)', onclick: () => this.deps.whatNow() }, icon('question', 14), 'What now? ', h('span.mu-key', null, 'Y'))),
    );
    this.body.addEventListener('click', () => this.deps.openJournal());
  }

  /** A task was added, advanced or finished: draw the eye to the card for a moment. */
  flash(kind: 'added' | 'progress' | 'done'): void {
    this.el.classList.remove('flash-added', 'flash-progress', 'flash-done');
    void this.el.offsetWidth;
    this.el.classList.add(`flash-${kind}`);
    this.flashUntil = this.now + 2;
  }

  setVisible(v: boolean): void { this.el.classList.toggle('mu-hide', !v); }

  update(now: number): void {
    this.now = now;
    if (this.flashUntil && now > this.flashUntil) { this.flashUntil = 0; this.el.classList.remove('flash-added', 'flash-progress', 'flash-done'); }
    const game = this.deps.game();
    const api = game?.objectives;
    if (!game || !api) { this.setVisible(false); return; }
    this.setVisible(true);
    // without a change counter the task is read every frame; with one, when it changes (and once a second regardless)
    const v = api.version?.();
    if (v === undefined || v !== this.version || now - this.checkedAt > 1) {
      this.version = v ?? -2;
      this.checkedAt = now;
      this.cur = api.tracked();
      const sig = objectiveSignature(this.cur);
      if (sig !== this.sig) {
        this.sig = sig;
        this.paint(this.cur, game.sim.absDay);
      }
    }
    const o = this.cur;
    // the way to go changes as you walk and turn
    if (o) {
      const st = currentStep(o);
      // the world marker follows a person about; the step's own copy of where they are is only refreshed now and then
      const t = this.deps.nav.primary() ?? st?.target;
      if (t) {
        const nav = this.deps.nav;
        const rel = relativeYaw(Math.atan2(t.x - nav.x, t.z - nav.z), nav.camYaw);
        const text = `${where(nav.x, nav.z, t.x, t.z)}${nav.street ? ` · ${sideWord(rel)}` : ''}`;
        this.where.classList.remove('mu-hide');
        if (text !== this.lastTargetText) { this.lastTargetText = text; this.whereText.textContent = text; }
        this.whereArrow.style.transform = `rotate(${(-rel).toFixed(2)}rad)`;
      } else if (!this.where.classList.contains('mu-hide')) this.where.classList.add('mu-hide');
    }
  }

  private paint(o: ReturnType<NonNullable<GameServices['objectives']>['tracked']>, absDay: number): void {
    this.body.classList.toggle('mu-hide', !o);
    this.empty.classList.toggle('mu-hide', !!o);
    this.lastTargetText = '';
    if (!o) return;
    const step = currentStep(o);
    this.src.replaceChildren(icon(SOURCE_ICON[o.source], 14), sourceLine(o, this.deps.nameOf));
    this.pips.replaceChildren(...stepPips(o).map((p) => h('i', { class: p })));
    this.pips.setAttribute('data-tip', `Step ${Math.min(o.steps.length, Math.max(1, o.steps.findIndex((s) => !s.done) + 1 || o.steps.length))} of ${o.steps.length}`);
    const due = dueLine(o, absDay);
    this.title.textContent = o.title;
    this.step.replaceChildren(h('span.mu-tracker-mark', null, icon('chev_right', 14)), step?.text ?? '');
    this.hint.textContent = step?.hint ?? '';
    this.hint.classList.toggle('mu-hide', !step?.hint);
    const frac = progressFraction(step);
    this.prog.classList.toggle('mu-hide', frac === null);
    if (frac !== null) { this.progBar.set(frac); this.progText.textContent = progressText(step) ?? ''; }
    const reward = [o.reward ? `Reward: ${o.reward}` : '', due].filter(Boolean).join(' · ');
    this.reward.textContent = reward;
    this.reward.classList.toggle('mu-hide', !reward);
  }
}
