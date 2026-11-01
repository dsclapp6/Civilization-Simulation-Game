// Floating results of the player's work (clarity pass): what a completed action brought ("+8 sheaves", "+1d",
// "Farming +2"), a level gained ("Farming 3!"), what a trade cost and brought ("−4d", "+2 eggs") and what the person you
// dealt with thinks of it ("♥ +3"). The view drains them like effects. They are only a reading of events (nothing
// is written to the state), shown a few at a time so each can be read.
import type { SkillId } from '../../core/domain';
import { SKILLS } from '../../core/domain';
import type { FloatText } from '../../core/view';
import type { TargetRef } from '../actions';
import type { PersonId } from '../state';
import type { Econ } from './core';
import { GOODS, pd } from './data';
import { parseItemKey } from './types';

/** Height above the ground the texts start at: over a person's head. */
const HEAD = 2.3;
/** Least real time (ms) between two floaters leaving the queue: a few a second. */
const GAP_MS = 230;
/** More than this waiting and the quieter kinds are dropped. */
const BACKLOG = 14;

const SKILL_NAME: Record<string, string> = {
  farming: 'Farming', husbandry: 'Husbandry', woodcutting: 'Woodcutting', mining: 'Mining', smithing: 'Smithing', carpentry: 'Carpentry',
  masonry: 'Masonry', tailoring: 'Tailoring', brewing: 'Brewing', trade: 'Trade', persuasion: 'Persuasion', leadership: 'Leadership',
  stewardship: 'Stewardship', letters: 'Letters', medicine: 'Medicine', hunting: 'Hunting', archery: 'Archery', melee: 'Melee',
  riding: 'Riding', stealth: 'Stealth',
};

interface Spot { x: number; y: number; z: number }
interface Pending { at: number; ft: FloatText }

/** A short word for a quantity of goods in a floating text: "wheat", "eggs", "loaves", "sickle". */
function itemWord(item: string, qty: number): string {
  const g = GOODS[parseItemKey(item).good];
  if (!g) return item;
  if (/ of |^dozen /.test(g.unit) || Math.abs(qty) === 1) return g.name.toLowerCase();
  return g.unit;
}

export class FloatFeed {
  /** Real clock in ms; tests replace it. */
  clock: () => number = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  private readonly queue: Pending[] = [];
  private readonly out: FloatText[] = [];
  private nextAt = 0;
  private readonly xp: Partial<Record<SkillId, number>> = {};
  private levels: Array<{ skill: string; level: number }> = [];
  private readonly offs: Array<() => void> = [];
  /** Trade lines of the current moment, netted and floated together when the frame ends. */
  private trade: { pence: number; items: Map<string, number>; at: Spot | null } | null = null;

  constructor(private readonly E: Econ) {
    const sim = E.sim;
    this.offs.push(sim.actions.onEvent((e) => {
      if (e.actor !== E.playerId) return;
      if (e.type === 'started') { this.snapshot(); this.levels = []; return; }
      if (e.type === 'completed') this.completed(e.option.target, e.outcome.gains ?? [], e.outcome.ok);
    }));
    this.offs.push(sim.events.on('skillLevel', (e) => {
      if (e.person !== E.playerId) return;
      this.levels.push({ skill: SKILL_NAME[e.skill] ?? String(e.skill), level: e.level });
    }));
    this.offs.push(sim.events.on('trade', (e) => {
      const me = E.playerId;
      if (e.buyer !== me && e.seller !== me) return;
      const t = this.trade ?? (this.trade = { pence: 0, items: new Map(), at: this.playerSpot() });
      const buying = e.buyer === me;
      t.pence += buying ? -e.pence : e.pence;
      const name = parseItemKey(e.item).good;
      t.items.set(name, (t.items.get(name) ?? 0) + (buying ? e.qty : -e.qty));
    }));
    this.offs.push(sim.events.on('opinion', (e) => {
      if (e.about !== E.playerId) return;
      const r = Math.round(Math.abs(e.delta) * 10) / 10;
      if (r < 0.5) return;
      const n = r >= 10 ? Math.round(r) : r;
      this.push(this.spotOf(e.of) ?? this.playerSpot(), `♥ ${e.delta > 0 ? '+' : '−'}${n}`, e.delta > 0 ? 'gain' : 'loss', 0.4);
    }));
    this.snapshot();
  }

  dispose(): void { for (const o of this.offs.splice(0)) o(); }

  /** Floaters that have come due since the last call (drained). */
  drain(): readonly FloatText[] {
    this.flushLoose();
    const out = this.out;
    out.length = 0;
    if (this.queue.length === 0) return out;
    const now = this.clock();
    while (this.queue.length > 0 && this.queue[0].at <= now) out.push(this.queue.shift()!.ft);
    return out;
  }

  // ---- events ----

  private snapshot(): void {
    const p = this.E.person(this.E.playerId);
    if (!p) return;
    for (const k of SKILLS) this.xp[k] = p.skills[k];
  }

  private completed(target: TargetRef, gains: ReadonlyArray<{ label: string; amount?: number; ref?: string }>, ok: boolean): void {
    if (!ok) { this.snapshot(); this.levels = []; return; }
    const at = this.targetSpot(target) ?? this.playerSpot();
    if (!at) return;
    let lift = 0;
    const say = (text: string, tone: FloatText['tone']): void => { this.push(at, text, tone, lift); lift += 0.5; };
    // goods and money, as the action reports them
    for (const g of gains) {
      if (g.amount === undefined || g.amount === 0) continue;
      if (g.ref === 'money') { say(`${g.amount > 0 ? '+' : '−'}${pd(Math.abs(g.amount))}`, g.amount > 0 ? 'gain' : 'loss'); continue; }
      if (g.ref === 'days') continue; // week-work credit is for the ledger
      const n = Math.abs(g.amount);
      const shown = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
      say(`${g.amount > 0 ? '+' : '−'}${shown} ${g.label.toLowerCase()}`, g.amount > 0 ? 'gain' : 'loss');
    }
    // the experience the action gave
    const p = this.E.person(this.E.playerId);
    if (p) {
      let best: { skill: SkillId; d: number } | null = null;
      for (const k of SKILLS) {
        const d = p.skills[k] - (this.xp[k] ?? p.skills[k]);
        // (a birthday's year of practice lands whenever it lands: it is not the work of this bout)
        if (d >= 0.45 && d <= 60 && (!best || d > best.d)) best = { skill: k, d };
      }
      if (best) say(`${SKILL_NAME[best.skill] ?? best.skill} +${best.d >= 9.5 ? Math.round(best.d) : Math.max(1, Math.round(best.d))}`, 'skill');
    }
    for (const l of this.levels) say(`${l.skill} ${l.level}!`, 'skill');
    this.levels = [];
    this.snapshot();
  }

  /** Trade lines gathered this frame and levels gained outside an action. */
  private flushLoose(): void {
    const t = this.trade;
    if (t) {
      this.trade = null;
      const at = t.at ?? this.playerSpot();
      if (at) {
        let lift = 0;
        if (Math.abs(t.pence) >= 0.05) { this.push(at, `${t.pence > 0 ? '+' : '−'}${pd(Math.abs(t.pence))}`, t.pence > 0 ? 'gain' : 'loss', lift); lift += 0.5; }
        let shown = 0;
        for (const [name, q] of t.items) {
          if (Math.abs(q) < 0.05 || shown >= 3) continue;
          const n = Math.abs(q) >= 10 ? Math.round(Math.abs(q)) : Math.round(Math.abs(q) * 10) / 10;
          this.push(at, `${q > 0 ? '+' : '−'}${n} ${itemWord(name, n)}`, q > 0 ? 'gain' : 'loss', lift);
          lift += 0.5; shown++;
        }
      }
    }
    if (this.levels.length > 0 && !this.E.sim.actions.active(this.E.playerId)) {
      const at = this.playerSpot();
      if (at) { let lift = 0; for (const l of this.levels) { this.push(at, `${l.skill} ${l.level}!`, 'skill', lift); lift += 0.5; } }
      this.levels = [];
    }
  }

  // ---- placing and pacing ----

  private push(at: Spot | null, text: string, tone: FloatText['tone'], lift: number): void {
    if (!at) return;
    if (this.queue.length >= BACKLOG && tone !== 'skill') return; // a flood of small ones is not worth reading
    const now = this.clock();
    const when = Math.max(now, this.nextAt);
    this.nextAt = when + GAP_MS;
    this.queue.push({ at: when, ft: { x: at.x, y: at.y + lift, z: at.z, text, tone } });
  }

  private playerSpot(): Spot | null {
    const v = this.E.sim.view.player();
    return v ? { x: v.x, y: v.y + HEAD, z: v.z } : null;
  }

  /** Over a person's head, if they are drawn. */
  private spotOf(person: PersonId): Spot | null {
    for (const c of this.E.sim.view.characters()) if (c.id === person) return { x: c.x, y: c.y + c.look.height + 0.45, z: c.z };
    return null;
  }

  /** Trees and people are where they are; for work on a strip or at a building the worker stands at it, so the text rises over them. */
  private targetSpot(t: TargetRef): Spot | null {
    const world = this.E.world;
    if (t.kind === 'person') return this.spotOf(t.id);
    if (t.kind === 'scatter') {
      const hit = this.E.notes.felled.find((n) => n.id === t.id);
      if (hit) return { x: hit.x, y: world.heightAt(hit.x, hit.z) + 2.4, z: hit.z };
    }
    return null;
  }
}
