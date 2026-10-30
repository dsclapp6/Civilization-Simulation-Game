// The military module's context: the simulation, its saved section (`state.ext['military']`), and the
// indexes rebuilt from it. Everything else in this folder takes a `Mil`.
import type { Rng } from '../../core/rng';
import type { WorldModel, Settlement } from '../../world/types';
import type { ZoneApi } from '../../agents/types';
import type { PlayerApi } from '../../player/types';
import type { EconomyApi } from '../economy/types';
import type { SocialApi } from '../social/types';
import type { Simulation } from '../sim';
import type { SimEvents } from '../events';
import { fullName, type GameState, type HouseId, type Person, type PersonId } from '../state';
import type { AdvancementApi, CombatApi, FightResult, PoliticsApi } from '../wave3';
import type { CareerSystem } from './career';
import type { ForceCache } from './forces';
import type { RaidSystem } from './raid';
import type { Realm } from './realm';
import type { SiegeSystem } from './siege';
import { harm } from './harm';
import type { Army, MilState, PlayerMil } from './types';

export const EXT_KEY = 'military';
const VERSION = 1;

export function emptyPlayerMil(): PlayerMil {
  return { valour: 0, battles: 0, wounds: 0, earned: 0, served: 0, last: 0, call: null, drilled: -1, rank: 'none' };
}

export function emptyMilState(): MilState {
  return {
    v: VERSION, nextArmy: 1, nextBattle: 1, armies: [], battles: [], sieges: [], captives: [], feuds: [], hired: {},
    player: emptyPlayerMil(), think: {}, wars: {}, occupied: {}, queue: [], stats: { battles: 0, dead: 0, raids: 0, sieges: 0, ransoms: 0, ransomPaid: 0 },
  };
}

export interface MilDeps {
  economy: EconomyApi;
  social: SocialApi;
  zone?: ZoneApi;
  player?: PlayerApi;
}

export class Mil {
  readonly state: GameState;
  readonly world: WorldModel;
  readonly data: MilState;
  readonly economy: EconomyApi;
  readonly social: SocialApi;
  readonly zone?: ZoneApi;
  readonly playerApi?: PlayerApi;
  readonly armyById = new Map<number, Army>();
  /** Person → army they serve in. */
  readonly armyOfPerson = new Map<PersonId, number>();
  readonly settlementById = new Map<number, Settlement>();
  /** Finished fights reported by the combat module, waiting for their battle to conclude. */
  readonly detailResults = new Map<number, FightResult>();
  // the module's parts (assigned by installMilitary; they refer back to this object)
  realm!: Realm;
  forces!: ForceCache;
  sieges!: SiegeSystem;
  raids!: RaidSystem;
  career!: CareerSystem;

  constructor(readonly sim: Simulation, deps: MilDeps) {
    this.state = sim.state;
    this.world = sim.world;
    this.economy = deps.economy;
    this.social = deps.social;
    this.zone = deps.zone;
    this.playerApi = deps.player;
    for (const s of this.world.settlements) this.settlementById.set(s.id, s);
    const cur = this.state.ext[EXT_KEY] as MilState | undefined;
    if (cur && cur.v === VERSION) this.data = cur;
    else {
      this.data = emptyMilState();
      this.state.ext[EXT_KEY] = this.data;
    }
    this.reindex();
  }

  // ---- other modules, looked up lazily (any may be absent) ----
  get combat(): CombatApi | undefined { return this.sim.services.combat; }
  get politics(): PoliticsApi | undefined { return this.sim.services.politics; }
  get advancement(): AdvancementApi | undefined { return this.sim.services.advancement; }

  /** Sum of a technique effect the House commands (`arms.longbow`, `defence.keep`, …); 0 without the advancement module. */
  techBonus(house: HouseId, key: string): number {
    return house ? this.advancement?.bonus?.(house, key) ?? 0 : 0;
  }

  get day(): number { return this.sim.absDay; }
  rng(name = 'military'): Rng { return this.sim.rng(name); }
  touch(): void { this.state.touchExt(EXT_KEY); }

  person(id: PersonId): Person | undefined { return this.state.persons.get(id); }
  alive(id: PersonId): Person | undefined {
    const p = this.state.persons.get(id);
    return p && !p.death ? p : undefined;
  }
  name(id: PersonId): string {
    const p = this.state.persons.get(id);
    return p ? fullName(p) : 'Someone';
  }
  houseName(id: HouseId): string {
    const h = this.state.houses.get(id);
    return h ? h.name : 'No House';
  }
  placeName(id: number): string { return this.settlementById.get(id)?.name ?? 'open country'; }
  get playerId(): PersonId { return this.state.run.playerId; }

  // ---- armies ----
  reindex(): void {
    this.armyById.clear();
    this.armyOfPerson.clear();
    for (const a of this.data.armies) {
      this.armyById.set(a.id, a);
      for (const id of a.men) this.armyOfPerson.set(id, a.id);
    }
  }
  army(id: number): Army | undefined { return this.armyById.get(id); }
  allArmies(): readonly Army[] { return this.data.armies; }
  addArmy(a: Army): void {
    this.data.armies.push(a);
    this.armyById.set(a.id, a);
    for (const id of a.men) this.armyOfPerson.set(id, a.id);
    this.touch();
  }
  removeArmy(a: Army): void {
    const i = this.data.armies.indexOf(a);
    if (i >= 0) this.data.armies.splice(i, 1);
    this.armyById.delete(a.id);
    for (const id of a.men) if (this.armyOfPerson.get(id) === a.id) this.armyOfPerson.delete(id);
    this.touch();
  }

  // ---- enmity without war ----
  /** Two Houses are enemies in the field for a while (a raid, an attack): their armies fight. */
  declareFeud(a: HouseId, b: HouseId, days = 24, cause = 'feud'): void {
    if (!a || !b || a === b) return;
    const until = this.day + days;
    const cur = this.data.feuds.find((f) => (f.a === a && f.b === b) || (f.a === b && f.b === a));
    if (cur) cur.until = Math.max(cur.until, until);
    else this.data.feuds.push({ a, b, until, cause });
    this.realm.invalidateEnmity();
    this.touch();
  }

  /** A civilian hurt in a raid (the same wound model as the soldiers). */
  harmFolk(p: Person, intensity: number, cause: string): void {
    harm(this, p, intensity, cause);
  }

  /** Section timings for tools and perf tests (null = off). */
  timings: Record<string, { ms: number; calls: number; max: number; over8?: number }> | null = null;
  time<T>(name: string, fn: () => T): T {
    const t = this.timings;
    if (!t) return fn();
    const t0 = performance.now();
    try { return fn(); } finally {
      const dt = performance.now() - t0;
      const e = t[name] ?? (t[name] = { ms: 0, calls: 0, max: 0 });
      e.ms += dt; e.calls++; if (dt > e.max) e.max = dt;
      if (dt > 8) e.over8 = (e.over8 ?? 0) + 1;
    }
  }

  // ---- messages ----
  notify(text: string, kind: SimEvents['notify']['kind'] = 'info', person?: PersonId): void {
    this.sim.events.emit('notify', person === undefined ? { kind, text } : { kind, text, person });
  }
  log(kind: string, text: string, persons: PersonId[] = []): void {
    this.state.log(this.day, kind, text, persons);
  }
  /** True when the player's House or the player is part of the story. */
  concernsPlayer(house: HouseId, ...others: HouseId[]): boolean {
    const mine = this.state.run.houseId;
    return house === mine || others.includes(mine);
  }

  /** The player is serving in an army. */
  playerArmy(): Army | undefined {
    const id = this.armyOfPerson.get(this.playerId);
    return id ? this.armyById.get(id) : undefined;
  }
}
