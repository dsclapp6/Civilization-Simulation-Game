// Shared runtime of the advancement module: the persisted section (`state.ext.tech`), the in-memory
// index of who knows what, and the rules for who qualifies to learn a technique. Everything that
// influences the simulation is either in the saved section or a pure function of the world and the
// saved state, so save -> load -> continue gives the same state hash.
import { DAYS_PER_YEAR } from '../../core/time';
import type { Rng } from '../../core/rng';
import type { Settlement, WorldModel } from '../../world/types';
import { CAREERS } from '../careers';
import { skillLevel } from '../people';
import type { Simulation } from '../sim';
import { ageYears, fullName, type GameState, type HouseId, type Person, type PersonId } from '../state';
import type { Wave3Deps } from '../wave3deps';
import { BY_CAREER, BY_ESTATE, BY_FIELD, BY_TITLE, TECHS, TECH_BY_ID } from './data';
import type { TechDef } from './types';

export const TECH_KEY = 'tech';

export interface TechSave {
  v: 1;
  /** 1 once the start-of-run knowledge was dealt out. */
  init: number;
  /** Tech id -> living people who know it. */
  holders: Record<string, number[]>;
  /** Tech id -> settlements whose library holds it in writing. */
  rec: Record<string, number[]>;
  /** Tech id -> day it was first learned by anyone. */
  first: Record<string, number>;
  /** Tech id -> day its last holder died unrecorded (cleared when someone learns it again). */
  lost: Record<string, number>;
  /** The player's practice towards each tech. */
  prog: Record<string, number>;
  /** Techs whose points were paid to the player's line. */
  paid: string[];
}

export function newTechSave(): TechSave {
  return { v: 1, init: 0, holders: {}, rec: {}, first: {}, lost: {}, prog: {}, paid: [] };
}

/** Longest holders list kept per tech (the save stays small; extra learners still count while they live in other lists). */
export const HOLDER_CAP = 600;

/** Depth of each tech in its prerequisite chain (roots 0) - the order techniques are dealt out in. */
const DEPTH = new Map<string, number>();
function depthOf(id: string, guard = 0): number {
  const hit = DEPTH.get(id);
  if (hit !== undefined) return hit;
  const t = TECH_BY_ID.get(id);
  const d = !t || guard > 12 ? 0 : t.requires.length === 0 ? 0 : 1 + Math.max(...t.requires.map((r) => depthOf(r, guard + 1)));
  DEPTH.set(id, d);
  return d;
}
for (const t of TECHS) depthOf(t.id);
export const depth = (id: string): number => DEPTH.get(id) ?? 0;

const EMPTY: readonly string[] = [];
const NO_TECHS: readonly TechDef[] = [];

export class Adv {
  readonly sim: Simulation;
  readonly state: GameState;
  readonly world: WorldModel;
  readonly deps: Wave3Deps;
  save: TechSave;
  /** Person -> techs known (rebuilt from the saved holder lists). */
  private readonly knownBy = new Map<number, Set<string>>();
  /** Bumped whenever anyone learns or loses something (invalidates the caches). */
  version = 0;
  /** True while the start-of-run knowledge is dealt out (no points, no news). */
  seeding = false;
  readonly settlementById = new Map<number, Settlement>();
  private readonly houseCache = new Map<number, { ver: number; techs: ReadonlySet<string> }>();
  private readonly settleCache = new Map<number, { ver: number; day: number; counts: Map<string, number> }>();
  private readonly kindCache = new Map<number, { rev: number; kinds: Set<string> }>();

  constructor(sim: Simulation, deps: Wave3Deps) {
    this.sim = sim;
    this.state = sim.state;
    this.world = sim.world;
    this.deps = deps;
    const cur = sim.state.ext[TECH_KEY] as TechSave | undefined;
    if (cur && typeof cur === 'object') this.save = cur;
    else { this.save = newTechSave(); sim.state.ext[TECH_KEY] = this.save; sim.state.touchExt(TECH_KEY); }
    for (const k of Object.keys(newTechSave()) as Array<keyof TechSave>) {
      if ((this.save as unknown as Record<string, unknown>)[k] === undefined) (this.save as unknown as Record<string, unknown>)[k] = (newTechSave() as unknown as Record<string, unknown>)[k];
    }
    for (const s of sim.world.settlements) this.settlementById.set(s.id, s);
    this.rebuild();
  }

  get day(): number { return this.sim.absDay; }
  get year(): number { return this.sim.absDay / DAYS_PER_YEAR; }
  get playerId(): PersonId { return this.state.run.playerId; }
  rng(name = 'tech'): Rng { return this.sim.rng(name); }
  touch(): void { this.state.touchExt(TECH_KEY); }

  // ---- index ----

  /** Rebuilds the who-knows-what index; drops holders who no longer exist or are dead. */
  rebuild(): void {
    this.knownBy.clear();
    for (const [tech, list] of Object.entries(this.save.holders)) {
      const keep: number[] = [];
      for (const id of list) {
        const p = this.state.persons.get(id);
        if (!p || p.death) continue;
        keep.push(id);
        let set = this.knownBy.get(id);
        if (!set) { set = new Set(); this.knownBy.set(id, set); }
        set.add(tech);
      }
      if (keep.length !== list.length) { this.save.holders[tech] = keep; this.touch(); }
    }
    this.version++;
  }

  knows(person: PersonId, tech: string): boolean { return this.knownBy.get(person)?.has(tech) ?? false; }
  techsOf(person: PersonId): readonly string[] {
    const s = this.knownBy.get(person);
    return s ? Array.from(s) : EMPTY;
  }
  holdersOf(tech: string): readonly number[] { return this.save.holders[tech] ?? EMPTY as unknown as number[]; }
  knownAnywhere(tech: string): boolean { return (this.save.holders[tech]?.length ?? 0) > 0; }

  /** The tech has no living holder but is written in some library. */
  isPreserved(tech: string): boolean { return !this.knownAnywhere(tech) && (this.save.rec[tech]?.length ?? 0) > 0; }
  isLost(tech: string): boolean { return !this.knownAnywhere(tech) && (this.save.rec[tech]?.length ?? 0) === 0 && this.save.lost[tech] !== undefined; }

  addHolder(p: Person, tech: string): boolean {
    let set = this.knownBy.get(p.id);
    if (!set) { set = new Set(); this.knownBy.set(p.id, set); }
    if (set.has(tech)) return false;
    set.add(tech);
    let list = this.save.holders[tech];
    if (!list) { list = []; this.save.holders[tech] = list; }
    list.push(p.id);
    if (list.length > HOLDER_CAP) {
      // the oldest holders drop off the record (they still know it in play: only the saved list is capped)
      const gone = list.shift() as number;
      this.knownBy.get(gone)?.delete(tech);
    }
    this.version++;
    this.touch();
    return true;
  }

  removeHolder(personId: PersonId, tech: string): void {
    this.knownBy.get(personId)?.delete(tech);
    const list = this.save.holders[tech];
    if (list) {
      const i = list.indexOf(personId);
      if (i >= 0) list.splice(i, 1);
    }
    this.version++;
    this.touch();
  }

  // ---- derived knowledge ----

  /** Techniques the House commands: anything a living member or sworn person knows. */
  houseTechs(house: HouseId): ReadonlySet<string> {
    if (!house) return new Set();
    const hit = this.houseCache.get(house);
    if (hit && hit.ver === this.version) return hit.techs;
    const techs = new Set<string>();
    for (const m of this.state.houseMembers.get(house) ?? []) {
      const k = this.knownBy.get(m.id);
      if (k) for (const t of k) techs.add(t);
    }
    this.houseCache.set(house, { ver: this.version, techs });
    return techs;
  }

  houseHas(house: HouseId, tech: string): boolean { return this.houseTechs(house).has(tech); }

  /** tech -> number of residents of the settlement who know it (cached for the day). */
  settlementCounts(settlement: number): ReadonlyMap<string, number> {
    const day = Math.floor(this.day);
    const hit = this.settleCache.get(settlement);
    if (hit && hit.ver === this.version && hit.day === day) return hit.counts;
    const counts = new Map<string, number>();
    for (const p of this.state.residentsOf(settlement)) {
      const k = this.knownBy.get(p.id);
      if (k) for (const t of k) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    this.settleCache.set(settlement, { ver: this.version, day, counts });
    return counts;
  }

  /** Sum of an effect over the techniques anyone in the settlement knows. */
  settlementBonus(settlement: number, key: string): number {
    return this.effectOf(this.settlementCounts(settlement).keys(), key);
  }

  effectOf(techs: Iterable<string>, key: string): number {
    let sum = 0;
    for (const id of techs) sum += TECH_BY_ID.get(id)?.effects[key] ?? 0;
    return sum;
  }

  /** Completed building kinds standing in a settlement. */
  buildingKinds(settlement: number): ReadonlySet<string> {
    const rev = this.state.buildingRevision;
    const hit = this.kindCache.get(settlement);
    if (hit && hit.rev === rev) return hit.kinds;
    const kinds = new Set<string>();
    for (const b of this.state.buildingsAt.get(settlement) ?? []) if (b.construction >= 1 && b.damage < 0.9) kinds.add(b.kind);
    this.kindCache.set(settlement, { rev, kinds });
    return kinds;
  }

  // ---- qualification ----

  skillOf(p: Person, skill: string): number { return skillLevel(p.skills[skill as keyof Person['skills']] ?? 0); }

  /** Techs that match the person's role (career, field, titles, estate) - not yet checked against skill, tier or buildings. */
  candidates(p: Person): readonly TechDef[] {
    const out: TechDef[] = [];
    const add = (list: readonly TechDef[] | undefined): void => { if (list) for (const t of list) if (!out.includes(t)) out.push(t); };
    add(BY_CAREER.get(p.career));
    add(BY_FIELD.get(CAREERS[p.career]?.field ?? 'none'));
    add(BY_ESTATE.get(p.estate));
    const held = this.state.titlesHeldBy(p.id);
    if (held.size > 0) for (const t of held) add(BY_TITLE.get(t.kind));
    return out.length ? out : NO_TECHS;
  }

  /** Does the person's work, standing and surroundings let them take up the technique? */
  qualifies(p: Person, def: TechDef): boolean {
    if (p.death) return false;
    if (def.year !== undefined && this.year < def.year) return false;
    const l = def.learn;
    if (l.skill && this.skillOf(p, l.skill) < (l.minSkill ?? 0)) return false;
    if (l.minTier !== undefined && p.rankTier < l.minTier) return false;
    if (l.minStage !== undefined && p.careerStage < l.minStage) return false;
    if (l.building && l.building.length > 0) {
      const kinds = this.buildingKinds(p.settlement);
      let any = false;
      for (const k of l.building) if (kinds.has(k)) { any = true; break; }
      if (!any) return false;
    }
    if (l.market && !this.settlementById.get(p.settlement)?.market) return false;
    return true;
  }

  /** The person knows every prerequisite. */
  prereqsKnown(p: Person, def: TechDef): boolean {
    for (const r of def.requires) if (!this.knows(p.id, r)) return false;
    return true;
  }

  /** The person or their House commands every prerequisite. */
  prereqsHeld(p: Person, def: TechDef): boolean {
    for (const r of def.requires) if (!this.knows(p.id, r) && !this.houseHas(p.house, r)) return false;
    return true;
  }

  // ---- learning ----

  /** Gives a person the technique. Returns true if it was new to them. */
  grant(p: Person, tech: string, via: string): boolean {
    const def = TECH_BY_ID.get(tech);
    if (!def || p.death) return false;
    const hadHouse = this.houseHas(p.house, tech);
    if (!this.addHolder(p, tech)) return false;
    const day = this.day;
    if (this.save.first[tech] === undefined) this.save.first[tech] = day;
    delete this.save.lost[tech];
    if (this.seeding) return true;
    const run = this.state.run;
    const mine = p.house === run.houseId;
    if (mine && !this.save.paid.includes(tech)) {
      this.save.paid.push(tech);
      this.sim.score.award('deed', def.points, `Learned ${def.name}`);
    }
    const house = this.state.houses.get(p.house);
    if (!hadHouse && (mine || (house && house.kind !== 'peasant'))) {
      this.sim.events.emit('tech', { house: p.house, tech, person: p.id });
    }
    if (mine) {
      const how = via === 'practice' ? 'by long practice' : via === 'taught' ? 'from a master' : via === 'books' ? 'from the books' : via === 'inherited' ? 'from the family papers' : '';
      if (p.id === run.playerId) {
        this.sim.events.emit('notify', { kind: 'gain', text: `You have learned ${def.name}${how ? ` ${how}` : ''}.`, person: p.id });
        this.state.log(day, 'tech', `${fullName(p)} learned ${def.name}.`, [p.id]);
      } else if (!hadHouse) {
        this.sim.events.emit('notify', { kind: 'info', text: `${p.first} has learned ${def.name}: your House commands it now.` });
        this.state.log(day, 'tech', `${fullName(p)} learned ${def.name}.`, [p.id]);
      }
      this.sim.requestSave('technique learned');
    }
    return true;
  }

  /** After a holder is gone: if nobody knows the technique and no book keeps it, it is lost. */
  checkLost(tech: string, cause: string): void {
    if (this.knownAnywhere(tech) || (this.save.rec[tech]?.length ?? 0) > 0) return;
    if (this.save.first[tech] === undefined || this.save.lost[tech] !== undefined) return;
    const def = TECH_BY_ID.get(tech);
    this.save.lost[tech] = this.day;
    this.save.prog[tech] = 0;
    this.touch();
    if (!def) return;
    this.state.log(this.day, 'tech', `The art of ${def.name.toLowerCase()} is lost: ${cause}.`, []);
    // only a technique the player's line had commanded is news to the player
    if (this.save.paid.includes(tech)) this.sim.events.emit('notify', { kind: 'warn', text: `${def.name} is lost: nobody who knew it lives, and no book keeps it.` });
  }

  ageOf(p: Person): number { return ageYears(p, this.day); }
}
