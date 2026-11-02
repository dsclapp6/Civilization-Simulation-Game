// The hint card of the first-minutes guide (see core/guide.ts for what it says and when). A small parchment note
// under the player plate: one hint at a time, gone when answered, dismissable, and switched off in the settings.
import { foldButton, isCollapsed } from '../core/collapse';
import { ageYears } from '../../sim/state';
import { dayFlags } from '../core/hudModel';
import type { SimEvents } from '../../sim/events';
import { h } from '../core/dom';
import { HINTS, pickHint, type GuideFacts, type HintDef } from '../core/guide';
import { icon } from '../core/icons';
import type { PanelRequest } from '../core/requests';
import type { GameServices } from '../types';

export interface GuideDeps {
  game(): GameServices | null;
  open(req: PanelRequest): void;
  enabled(): boolean;
  /** Turns the hints off for good (the settings). */
  disable(): void;
  /** A panel or screen covers the HUD: keep quiet. */
  suppressed(): boolean;
}

const COOLDOWN = 5;
const COMBAT_HINTS = new Set(['fight', 'bow', 'wounds']);
const STORE = 'millennia.guide.';

function readSeen(seed: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORE + seed);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}

function writeSeen(seed: string, seen: ReadonlySet<string>): void {
  try { window.localStorage.setItem(STORE + seed, JSON.stringify([...seen])); } catch { /* private window: hints just repeat next time */ }
}

export class Guide {
  readonly el = h('div.mu-guide.mu-hide', { role: 'note' });

  private seed = '';
  private seen = new Set<string>();
  private current: HintDef | null = null;
  private shownAt = 0;
  private hiddenAt = -100;
  private lastTick = -1;
  private seconds = 0;
  private lastT = -1;
  private moved = 0;
  private lastPos: { x: number; z: number } | null = null;
  private worked = 0;
  private interacted = 0;
  private speedChanged = false;
  private readonly opened = new Set<string>();

  constructor(private readonly deps: GuideDeps) {}

  /** A new run (or a different character): forget the counters, load what was already seen. */
  reset(seed: string): void {
    this.seed = seed;
    this.seen = readSeen(seed);
    this.current = null;
    this.seconds = 0; this.lastT = -1; this.moved = 0; this.lastPos = null; this.worked = 0; this.interacted = 0;
    this.speedChanged = false; this.hiddenAt = -100; this.lastTick = -1;
    this.opened.clear();
    this.el.classList.add('mu-hide');
  }

  noteAction(e: SimEvents['action'], player: number): void {
    if (e.actor !== player) return;
    if (e.type === 'started') this.interacted++;
    else if (e.type === 'completed' && e.option.seconds > 0 && e.outcome.ok) this.worked++;
  }

  noteConversation(): void { this.interacted++; }
  notePanel(id: string): void {
    this.opened.add(id);
    if (id === 'actions') this.interacted++;
  }
  noteSpeed(): void { this.speedChanged = true; }

  update(now: number): void {
    if (this.lastT >= 0) this.seconds += Math.min(0.25, now - this.lastT);
    this.lastT = now;
    if (now - this.lastTick < 0.25) return;
    this.lastTick = now;
    const game = this.deps.game();
    if (!game || !this.seed) return;
    const facts = this.facts(game);
    if (!facts || !this.deps.enabled()) { this.hide(false); return; }
    const cur = this.current;
    if (cur) {
      const age = now - this.shownAt;
      if (cur.done(facts) || (cur.maxSeconds !== undefined && age > cur.maxSeconds) || (!cur.when(facts) && age > 3)) { this.finish(); return; }
      this.el.classList.toggle('quiet', this.deps.suppressed() || (facts.engaged && !COMBAT_HINTS.has(cur.id)));
      return;
    }
    if (this.deps.suppressed() || facts.travelling || now - this.hiddenAt < COOLDOWN) return;
    const next = pickHint(facts, this.seen);
    if (next) this.show(next, now);
  }

  private facts(game: GameServices): GuideFacts | null {
    const sim = game.sim;
    const hud = game.player.hud();
    const p = sim.state.persons.get(sim.state.run.playerId);
    if (!hud || !p) return null;
    const body = game.player.body();
    if (body) {
      if (this.lastPos) {
        const d = Math.hypot(body.x - this.lastPos.x, body.z - this.lastPos.z);
        if (d < 12) this.moved += d;
      }
      this.lastPos = { x: body.x, z: body.z };
    }
    const wounds = sim.services.combat?.wounds(p.id) ?? [];
    return {
      seconds: this.seconds, moved: this.moved, age: ageYears(p, sim.absDay), careerChosen: p.career !== 'child',
      worked: this.worked, interacted: this.interacted, opened: this.opened,
      needs: { hunger: hud.hunger, rest: hud.rest, warmth: hud.warmth, mood: hud.mood },
      holyDay: dayFlags(sim.absDay, null).holy,
      engaged: !!hud.combat?.engaged, ranged: !!hud.combat?.ranged, wounded: wounds.length > 0,
      speedChanged: this.speedChanged, travelling: !!hud.travel, money: hud.money,
    };
  }

  private show(def: HintDef, now: number): void {
    this.current = def;
    this.shownAt = now;
    const link = def.link;
    const kids: Array<HTMLElement | null> = [
      h('div.mu-guide-head', null,
        h('span.mu-guide-ico', null, icon(def.icon, 18)),
        h('span.mu-guide-title', null, def.title),
        foldButton('hints', 'the hint', (c) => this.el.classList.toggle('folded', c)),
        h('button.mu-guide-x', { type: 'button', tip: 'Got it', 'aria-label': 'Dismiss this hint', onclick: () => this.finish() }, icon('cross', 12))),
      h('p', null, def.text),
      def.keys?.length ? h('div.mu-guide-keys', null, def.keys.map((x) => h('span.mu-key', null, x))) : null,
      h('div.mu-guide-foot', null,
        link ? h('button.mu-btn.small', { type: 'button', onclick: () => { this.finish(); this.deps.open(link.request); } }, link.label) : null,
        h('button.mu-guide-off', { type: 'button', onclick: () => this.deps.disable() }, 'Hide all hints')),
    ];
    this.el.replaceChildren(...kids.filter((x): x is HTMLElement => x !== null));
    this.el.classList.toggle('folded', isCollapsed('hints'));
    this.el.classList.remove('mu-hide', 'quiet');
    this.el.classList.remove('in');
    void this.el.offsetWidth;
    this.el.classList.add('in');
  }

  private finish(): void {
    if (this.current) { this.seen.add(this.current.id); writeSeen(this.seed, this.seen); }
    this.hide(true);
  }

  private hide(count: boolean): void {
    if (!this.current && this.el.classList.contains('mu-hide')) return;
    this.current = null;
    this.el.classList.add('mu-hide');
    if (count) this.hiddenAt = this.lastT;
  }

  /** For tools and tests: puts a given hint on the card now. */
  force(id: string): boolean {
    const def = HINTS.find((x) => x.id === id);
    if (!def) return false;
    this.show(def, this.lastT);
    return true;
  }

  /** For tools and tests: the hint on show. */
  shown(): string | null { return this.current ? this.current.id : null; }

  all(): readonly HintDef[] { return HINTS; }
}
