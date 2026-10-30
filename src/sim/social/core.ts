// SocialCore: what every part of the social system shares — the simulation, the saved data store,
// the hooks other modules set, the deterministic RNG, and cached facts about the local scene (who is
// lord, priest and reeve of a settlement; what grows in its fields). Components are wired by
// `installSocial` after construction so they can call each other.
import { dist2 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { Settlement, WorldModel } from '../../world/types';
import { dayPart } from '../calendar';
import type { Simulation } from '../sim';
import {
  ageYears, fullName, type GameState, type Person, type PersonId, type Title,
} from '../state';
import type { Barks } from './barks';
import type { CourtshipEngine } from './courtship';
import type { OpinionModel } from './opinion';
import type { Relations } from './relations';
import type { Speech } from './speech';
import type { NewsEngine } from './news';
import { SocialStore } from './store';
import { OPINION } from './tuning';
import type { SocialHooks } from './types';
import { TIER_MONEY, TIER_PURSE } from '../people';

const WATCH_CAREERS: ReadonlySet<string> = new Set([
  'man_at_arms', 'sergeant', 'soldier', 'archer', 'monk', 'nun', 'prior', 'abbot', 'beggar', 'outlaw', 'midwife', 'healer',
]);

/** Things worth knowing about a settlement for a day: refreshed once per game day. */
export interface LocalScene {
  day: number;
  lord: Person | null;
  lordTitle: Title | null;
  priest: Person | null;
  reeve: Person | null;
  /** The crop most strips carry (not fallow), and whether any are ripe / growing / freshly sown. */
  crop: string;
  stage: 'none' | 'ploughed' | 'sown' | 'growing' | 'ripe' | 'stubble';
}

export class SocialCore {
  readonly state: GameState;
  readonly world: WorldModel;
  readonly store: SocialStore;
  hooks: SocialHooks = {};

  private readonly settlements = new Map<number, Settlement>();
  private readonly scenes = new Map<number, LocalScene>();

  // components (wired in installSocial)
  opinion!: OpinionModel;
  speech!: Speech;
  relations!: Relations;
  courtship!: CourtshipEngine;
  barks!: Barks;
  news!: NewsEngine;

  constructor(readonly sim: Simulation) {
    this.state = sim.state;
    this.world = sim.world;
    this.store = new SocialStore(sim.state);
    for (const s of sim.world.settlements) this.settlements.set(s.id, s);
  }

  // ---- basics ----

  get now(): number { return this.sim.absDay; }
  get day(): number { return Math.floor(this.sim.absDay); }
  get playerId(): PersonId { return this.state.run.playerId; }
  /** The stream for every random outcome of the social system. */
  rng(name = 'social'): Rng { return this.sim.rng(name); }

  person(id: PersonId): Person | undefined { return this.state.persons.get(id); }
  living(id: PersonId): Person | undefined {
    const p = this.state.persons.get(id);
    return p && !p.death ? p : undefined;
  }
  age(p: Person): number { return ageYears(p, this.now); }
  name(p: Person): string { return fullName(p); }

  settlement(id: number): Settlement | undefined { return this.settlements.get(id); }
  placeName(id: number): string { return this.settlements.get(id)?.name ?? 'the countryside'; }

  notify(text: string, kind: 'info' | 'gain' | 'loss' | 'warn' | 'social' = 'social', person?: PersonId): void {
    this.sim.events.emit('notify', { kind, text, person: person ?? this.playerId });
  }

  // ---- places ----

  /** Settlements within `radius` metres of `sid` (not itself), nearest first. */
  nearby(sid: number, radius: number): Array<{ id: number; dist: number }> {
    const s = this.settlements.get(sid);
    if (!s) return [];
    const out: Array<{ id: number; dist: number }> = [];
    const r2 = radius * radius;
    for (const o of this.world.settlements) {
      if (o.id === sid) continue;
      const d2 = dist2(o.x, o.z, s.x, s.z);
      if (d2 <= r2) out.push({ id: o.id, dist: Math.sqrt(d2) });
    }
    out.sort((a, b) => a.dist - b.dist || a.id - b.id);
    return out;
  }

  distance(a: number, b: number): number {
    const sa = this.settlements.get(a), sb = this.settlements.get(b);
    return sa && sb ? Math.sqrt(dist2(sa.x, sa.z, sb.x, sb.z)) : Infinity;
  }

  lordTitleOf(sid: number): Title | undefined {
    const st = this.state;
    return st.titleFor('manor', sid) ?? st.titleFor('town', sid) ?? st.titleFor('abbey', sid) ?? st.titleFor('barony', sid);
  }

  /** The cached picture of a settlement for today. */
  scene(sid: number): LocalScene {
    const day = this.day;
    let sc = this.scenes.get(sid);
    if (sc && sc.day === day) return sc;
    sc = sc ?? { day: -1, lord: null, lordTitle: null, priest: null, reeve: null, crop: 'barley', stage: 'none' };
    sc.day = day;
    const title = this.lordTitleOf(sid);
    sc.lordTitle = title ?? null;
    sc.lord = title && title.holder ? this.living(title.holder) ?? null : null;
    sc.priest = null;
    sc.reeve = null;
    for (const p of this.state.residentsOf(sid)) {
      if (!sc.priest && p.career === 'priest') sc.priest = p;
      if (!sc.reeve && p.offices.length > 0 && p.offices.some((o) => o.office === 'reeve' && o.place === sid)) sc.reeve = p;
      if (sc.priest && sc.reeve) break;
    }
    // what the fields hold
    const s = this.settlements.get(sid);
    const counts = new Map<string, number>();
    const stages = new Map<string, number>();
    if (s) {
      for (const id of s.strips) {
        const st = this.state.strips.get(id);
        if (!st) continue;
        if (st.crop !== 'fallow') counts.set(st.crop, (counts.get(st.crop) ?? 0) + 1);
        stages.set(st.state, (stages.get(st.state) ?? 0) + 1);
      }
    }
    let best = '', bestN = 0;
    for (const [c, n] of counts) if (n > bestN || (n === bestN && c < best)) { best = c; bestN = n; }
    sc.crop = best || cropForSeason(this.day);
    const has = (k: string): boolean => (stages.get(k) ?? 0) > 0;
    sc.stage = has('ripe') ? 'ripe' : has('growing') ? 'growing' : has('sown') ? 'sown' : has('ploughed') ? 'ploughed' : has('stubble') || has('harvested') ? 'stubble' : 'none';
    this.scenes.set(sid, sc);
    return sc;
  }

  // ---- people ----

  /** Whether `of` is hostile to `about` (their opinion has soured past the point of friendly company). */
  hostile(of: Person, about: Person): boolean {
    return this.opinion.total(of, about) <= OPINION.hostileBelow;
  }

  /** Asleep (or otherwise unable to talk) by the sim's reckoning; agents/player may refine it with `awakeHook`. */
  isAwake(p: Person): boolean {
    const hook = this.hooks.awakeHook;
    if (hook) return hook(p.id);
    if (p.flags.player) return true;
    if (dayPart(this.now) !== 'night') return true;
    return WATCH_CAREERS.has(p.career) || p.flags.outlaw === true;
  }

  /** How wealthy someone looks for their rank: −1 ragged … +1 richly dressed (clothes follow wealth, appearance.ts). */
  wealthShade(p: Person): number {
    const hh = this.state.households.get(p.household);
    const share = hh ? hh.purse / Math.max(1, hh.members.length) : 0;
    const typical = TIER_MONEY[p.rankTier] + TIER_PURSE[p.rankTier] / 5 + 10;
    const ratio = (p.money + share) / typical;
    return ratio < 0.4 ? -1 : ratio > 4 ? 1 : 0;
  }

  /** True when `observer` has reason to know who `subject` is (kin, same roof, shared history). */
  knows(observer: Person, subject: Person): boolean {
    if (observer.id === subject.id) return true;
    if (observer.household !== 0 && observer.household === subject.household) return true;
    if (observer.opinions[subject.id] !== undefined) return true;
    if (observer.spouse === subject.id || observer.father === subject.id || observer.mother === subject.id) return true;
    if (subject.father === observer.id || subject.mother === observer.id) return true;
    if (observer.settlement === subject.settlement) {
      // a village knows its own; a city does not
      const n = this.state.residentsOf(observer.settlement).length;
      return n <= 140 || observer.house === subject.house;
    }
    return false;
  }

  /** The standing `observer` grants `subject`: rank for those they know, the cut of the clothes for strangers (SPEC §9). */
  perceivedStanding(observer: Person, subject: Person): number {
    if (this.knows(observer, subject)) return subject.rankTier + (subject.estate === 'clergy' && subject.rankTier < 5 ? 0.5 : 0);
    const hook = this.hooks.dressTierHook;
    if (hook) return hook(subject.id);
    return Math.max(1, Math.min(8, subject.rankTier + 0.7 * this.wealthShade(subject) + (subject.estate === 'clergy' && subject.rankTier < 5 ? 0.5 : 0)));
  }
}

const SEASON_CROP = ['oats', 'barley', 'wheat', 'rye'] as const;
function cropForSeason(day: number): string {
  return SEASON_CROP[Math.floor(((day % 16) + 16) % 16 / 4)];
}
