// Opinions (SPEC §5 Social). What `of` thinks of `about`, −100..100, is
//
//     base(kinship, household, neighbourhood, rank and estate, reputation, prestige, traits)
//   + memory   (Person.opinions: what the other did to them; fades slowly towards the base)
//
// The base is recomputed from the world every time, so it follows marriages, promotions and deeds
// for free; only the memory is stored. `adjust` changes the memory, remembers the deed (for the
// player's dealings) and tells the UI.
import type { Reputation, Person, PersonId } from '../state';
import { adjustOpinion as stateAdjustOpinion } from '../state';
import { kinshipLabel } from '../api';
import type { SocialCore } from './core';
import { KIN_OPINION, OPINION, REP_WEIGHT } from './tuning';
import { clamp, round1, standingOf } from './util';

export type OpinionBucket = 'hostile' | 'cold' | 'neutral' | 'warm' | 'devoted';

export interface OpinionPart { label: string; value: number }
export interface OpinionBreakdown { total: number; base: number; memory: number; parts: OpinionPart[] }

type Sink = (label: string, value: number) => void;

/** Trait pairs that warm (+) or chill (−) a relationship. Order does not matter. */
const TRAIT_PAIRS: ReadonlyArray<readonly [string, string, number]> = [
  ['honest', 'honest', 3], ['pious', 'pious', 4], ['brave', 'brave', 2], ['patient', 'patient', 2],
  ['content', 'content', 2], ['deceitful', 'deceitful', 2], ['ambitious', 'ambitious', -1],
  ['hot_tempered', 'hot_tempered', -3], ['greedy', 'greedy', -2],
  ['honest', 'deceitful', -4], ['hot_tempered', 'patient', -2], ['pious', 'deceitful', -2],
  ['brave', 'craven', -2], ['ambitious', 'content', -1], ['quick_learner', 'quick_learner', 1],
];

export class OpinionModel {
  constructor(private readonly core: SocialCore) {}

  // ---- the model ----

  /** The base opinion from the world alone, no memory. */
  base(of: Person, about: Person): number {
    return this.compute(of, about, undefined);
  }

  memory(of: Person, about: PersonId): number { return of.opinions[about] ?? 0; }

  /** The full opinion, rounded to a whole number. */
  total(of: Person, about: Person): number {
    return Math.round(clamp(this.compute(of, about, undefined) + (of.opinions[about.id] ?? 0), -100, 100)) + 0;
  }

  opinion(ofId: PersonId, aboutId: PersonId): number {
    const of = this.core.person(ofId), about = this.core.person(aboutId);
    if (!of || !about) return 0;
    return this.total(of, about);
  }

  explain(of: Person, about: Person): OpinionBreakdown {
    const parts: OpinionPart[] = [];
    const base = this.compute(of, about, (label, value) => { if (Math.abs(value) >= 0.05) parts.push({ label, value: round1(value) }); });
    const memory = of.opinions[about.id] ?? 0;
    if (memory !== 0) parts.push({ label: 'memory', value: round1(memory) });
    return { total: Math.round(clamp(base + memory, -100, 100)) + 0, base: round1(base), memory: round1(memory), parts };
  }

  bucket(op: number): OpinionBucket {
    return op < OPINION.hostileBelow ? 'hostile' : op < OPINION.coldBelow ? 'cold' : op < OPINION.warmFrom ? 'neutral' : op < OPINION.devotedFrom ? 'warm' : 'devoted';
  }

  private compute(of: Person, about: Person, sink: Sink | undefined): number {
    const core = this.core;
    const st = core.state;
    let sum = 0;
    const add = (label: string, v: number): void => { sum += v; if (sink) sink(label, v); };

    // kinship and the shared roof
    const kin = kinshipLabel(st, of, about);
    if (kin) add(`kin (${kin})`, KIN_OPINION[kin] ?? 4);
    if (of.household !== 0 && of.household === about.household) {
      const hh = st.households.get(of.household);
      add('same household', hh && hh.kind === 'family' ? 5 : 2);
    }

    // place and kind
    if (of.settlement === about.settlement) {
      const n = st.residentsOf(of.settlement).length;
      add('neighbours', n <= 140 ? 3 : n <= 400 ? 1.5 : 0.5);
    } else {
      let strangers = -2;
      if (of.culture !== about.culture) strangers -= 4;
      const a = core.settlement(of.settlement), b = core.settlement(about.settlement);
      if (a && b && a.kingdom !== b.kingdom) strangers -= 2;
      add('strangers', strangers);
    }

    // rank: deference upwards, disdain downwards among the gentry and above
    const gap = standingOf(about) - standingOf(of);
    if (gap > 0) {
      add('rank (respect)', Math.min(6, 1.5 * gap));
      if (of.estate === 'unfree') {
        const lord = core.lordTitleOf(of.settlement);
        if (lord && lord.holder === about.id) add('serf of the lord', -4);
      }
    } else if (gap < 0 && of.rankTier >= 4) {
      add('rank (disdain)', -Math.min(8, 2 * -gap));
    }

    // reputation, weighed by what the observer values
    const tr = of.traits;
    const has = (t: string): boolean => tr.includes(t as never);
    const r = about.rep;
    const honour = REP_WEIGHT.honour * r.honour * (has('honest') ? 1.6 : has('deceitful') ? 0.6 : 1);
    const generosity = REP_WEIGHT.generosity * r.generosity * (has('greedy') ? 1.5 : has('content') ? 0.8 : 1);
    const piety = REP_WEIGHT.piety * r.piety * (has('pious') ? 2.5 : 1);
    const cruelty = REP_WEIGHT.cruelty * r.cruelty * (has('hot_tempered') ? 0.6 : has('patient') ? 1.3 : has('pious') ? 1.2 : has('ambitious') ? 0.8 : 1);
    const valour = REP_WEIGHT.valour * r.valour * (has('brave') ? 1.8 : 1);
    add('reputation', clamp(honour + generosity + piety + cruelty + valour, -22, 22));
    if (gap >= -1 && about.prestige > 0) add('prestige', 0.04 * Math.min(150, about.prestige));

    // temperament
    let tdelta = 0;
    for (const [x, y, v] of TRAIT_PAIRS) {
      if ((has(x) && about.traits.includes(y as never)) || (x !== y && has(y) && about.traits.includes(x as never))) tdelta += v;
    }
    if (tdelta !== 0) add('temperament', clamp(tdelta, -8, 8));

    // looks
    if (about.traits.includes('comely')) add('comely', of.sex !== about.sex && this.core.age(of) >= 14 ? 3 : 1);
    else if (about.traits.includes('scarred')) add('scarred', -1);

    return clamp(sum, -45, 65);
  }

  // ---- change ----

  /**
   * Moves what `of` thinks of `about` by `delta` (memory part). Deeds towards or by the player are
   * remembered ("what you did to them") and announced as an `opinion` event.
   */
  adjust(ofId: PersonId, aboutId: PersonId, delta: number, reason: string): void {
    const core = this.core;
    const of = core.person(ofId);
    if (!of || of.death || ofId === aboutId) return;
    const d = round1(delta);
    if (d === 0) return;
    stateAdjustOpinion(of, aboutId, d);
    const stored = of.opinions[aboutId];
    if (stored !== undefined) of.opinions[aboutId] = round1(stored);
    core.state.touch(of);
    const player = core.playerId;
    // what the player does to people, and any big change, is remembered; passing pleasantries are not
    if (Math.abs(d) >= 2 && (aboutId === player || ofId === player || Math.abs(d) >= 4)) {
      core.store.addMemory({ o: ofId, a: aboutId, d: core.day, r: reason, v: d });
    }
    if (aboutId === player && Math.abs(d) >= 0.5) {
      core.sim.events.emit('opinion', { of: ofId, about: aboutId, delta: d, reason: core.speech.reasonUi(reason) });
    }
  }

  // ---- reputation ----

  /** Changes one of the facets others judge a person by. Whole points only. */
  addRep(p: Person, facet: keyof Reputation, delta: number): void {
    const v = clamp(Math.round(p.rep[facet] + delta), -100, 100) + 0;
    if (v === p.rep[facet]) return;
    p.rep[facet] = v;
    this.core.state.touch(p);
  }

  // ---- fading ----

  /** One season's fading of a person's memory of others; forgets the dead and the trivial. */
  decayPerson(p: Person): void {
    const ops = p.opinions;
    let touched = false;
    for (const key in ops) {
      const id = Number(key);
      const v = ops[id];
      if (!this.core.state.persons.has(id)) { delete ops[id]; touched = true; continue; }
      let next = round1(v * OPINION.decayPerSeason);
      if (next === v) next = round1(v - Math.sign(v) * 0.1); // rounding must not freeze a faint memory
      if (Math.abs(next) < OPINION.forgetBelow) delete ops[id];
      else ops[id] = next;
      touched = true;
    }
    if (touched) this.core.state.touch(p);
  }

  /** Decays everyone living in a settlement (called on its own hour of its own day). */
  decaySettlement(sid: number): number {
    let n = 0;
    for (const p of this.core.state.residentsOf(sid)) {
      for (const _ in p.opinions) { this.decayPerson(p); n++; break; }
    }
    return n;
  }
}
