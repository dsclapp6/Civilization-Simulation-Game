// What every part of the law module shares: the simulation, the modules it finds lazily (any may be missing: headless runs have no
// zone, no player and perhaps no combat), the saved store, names and the small helpers they need.
import type { P2 } from '../../core/math';
import { dist } from '../../core/math';
import type { ZoneApi } from '../../agents/types';
import type { PlayerApi } from '../../player/types';
import { BUILDINGS } from '../../content/types';
import { ageYears, fullName, type BuildingState, type HouseId, type Person, type PersonId } from '../state';
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import type { CombatApi, MilitaryApi, PoliticsApi } from '../wave3';
import type { RealmApi } from '../realm/types';
import type { TerritoryApi } from '../territory/types';
import type { SocialApi } from '../social/types';
import type { EconomyApi } from '../economy/types';
import { titled } from './names';
import { LawStore } from './store';

export { titled };

/** A man-at-arms' rank in a few words ("knight", "sergeant", "man-at-arms") for the card. */
export function arm(p: Person): string {
  switch (p.career) {
    case 'knight': return 'knight';
    case 'sergeant': return 'sergeant';
    case 'man_at_arms': return 'man-at-arms';
    case 'soldier': return 'soldier';
    case 'archer': return 'archer';
    case 'squire': return 'squire';
    case 'bailiff': return 'bailiff';
    case 'steward': return 'steward';
    default: return p.estate === 'unfree' ? 'bondman' : 'man';
  }
}

/** What the military module's runtime offers beyond the cross-module contract (prisoners and ransoms), looked up lazily. */
export interface MilitaryHooks {
  captiveOf?(person: PersonId): { person: PersonId; captor: PersonId; holder: HouseId; ransom: number; since: number; place: number } | null;
  captives?(): ReadonlyArray<{ person: PersonId; captor: PersonId; holder: HouseId; ransom: number; since: number; place: number }>;
  payRansom?(captive: PersonId, payer?: PersonId): { ok: boolean; reason?: string };
  ransomValue?(person: PersonId): number;
}

export class Law {
  readonly store: LawStore;
  readonly offs: Array<() => void> = [];

  constructor(readonly sim: Simulation, readonly deps: Wave3Deps) {
    this.store = new LawStore(sim.state);
  }

  // ---- the world and the other modules, found lazily ----
  get state() { return this.sim.state; }
  get world() { return this.sim.world; }
  get day(): number { return this.sim.absDay; }
  get playerId(): PersonId { return this.sim.state.run.playerId; }
  get zone(): ZoneApi | undefined { return this.deps.zone; }
  get player(): PlayerApi | undefined { return this.deps.player; }
  get economy(): EconomyApi | undefined { return this.deps.economy; }
  get social(): SocialApi | undefined { return this.deps.social; }
  get territory(): TerritoryApi | undefined { return this.sim.services.territory; }
  get military(): (MilitaryApi & MilitaryHooks) | undefined { return this.sim.services.military as (MilitaryApi & MilitaryHooks) | undefined; }
  get combat(): CombatApi | undefined { return this.sim.services.combat; }
  get politics(): PoliticsApi | undefined { return this.sim.services.politics; }
  get realm(): RealmApi | undefined { return this.sim.services.realm; }

  rng(): ReturnType<Simulation['rng']> { return this.sim.rng('law'); }

  person(id: PersonId): Person | undefined { return this.state.persons.get(id); }
  alive(id: PersonId): Person | undefined { const p = this.state.persons.get(id); return p && !p.death ? p : undefined; }
  name(id: PersonId): string { const p = this.state.persons.get(id); return p ? fullName(p) : 'someone'; }
  titled(id: PersonId): string { return titled(this.state.persons.get(id)); }
  placeName(settlement: number): string { return this.world.settlements.find((s) => s.id === settlement)?.name ?? 'the place'; }
  houseName(house: HouseId): string { const h = this.state.houses.get(house); return h ? `House ${h.name}` : 'the lord'; }

  /** The person who holds a settlement's lands and acts for them (the regent while he is a child or a captive); 0 = nobody. */
  lordOf(settlement: number): PersonId { return this.territory?.ownerOf?.(settlement).lord ?? 0; }
  houseOf(settlement: number): HouseId { return this.territory?.ownerOf?.(settlement).house ?? 0; }

  notify(kind: 'info' | 'gain' | 'loss' | 'warn' | 'danger' | 'quest' | 'social', text: string, person: PersonId = this.playerId): void {
    if (person !== this.playerId) return;
    this.sim.events.emit('notify', { kind, text, person });
  }

  log(kind: string, text: string, persons: PersonId[]): void { this.state.log(this.day, kind, text, persons); }

  age(p: Person): number { return ageYears(p, this.day); }

  /** Is the person one of the lord's armed men (or an officer who may send them)? */
  armed(p: Person): boolean {
    return p.career === 'knight' || p.career === 'sergeant' || p.career === 'man_at_arms' || p.career === 'soldier' || p.career === 'archer' || p.career === 'squire';
  }

  /** The settlement nearest a point (id). */
  nearestSettlement(x: number, z: number): number { return this.world.nearestSettlement(x, z).id; }

  /** A finished building of one of the kinds in a settlement, the first by id. */
  finished(settlement: number, kinds: readonly string[]): BuildingState | undefined {
    for (const k of kinds) {
      for (const b of this.state.buildingsAt.get(settlement) ?? []) if (b.kind === k && b.construction >= 1 && b.damage < 0.9) return b;
    }
    return undefined;
  }

  distance(a: P2, b: P2): number { return dist(a.x, a.z, b.x, b.z); }

  /** The buildings that hold prisoners, best first, with how the card names them ("the gaol of Dromore"). */
  static readonly LOCKUPS: ReadonlyArray<readonly [string, string]> = [
    ['gaol', 'the gaol of'], ['keep_stone', 'the keep of'], ['motte', 'the keep of'], ['manor_house', "the manor's lock-up at"],
    ['great_hall', 'the guardroom at'], ['barracks', 'the guardroom at'], ['gatehouse', 'the gatehouse cell at'], ['tower', 'the tower cell at'],
  ];

  /** The building that holds prisoners in a settlement and what to call it, or null when it keeps none. One pass over the place's buildings. */
  lockup(settlement: number): { building: BuildingState; text: string } | null {
    let best: BuildingState | null = null;
    let rank = Law.LOCKUPS.length;
    for (const b of this.state.buildingsAt.get(settlement) ?? []) {
      if (b.construction < 1 || b.damage >= 0.9) continue;
      const r = Law.LOCKRANK.get(b.kind);
      if (r !== undefined && r < rank) { best = b; rank = r; }
    }
    return best ? { building: best, text: `${Law.LOCKUPS[rank][1]} ${this.placeName(settlement)}` } : null;
  }

  private static readonly LOCKRANK: ReadonlyMap<string, number> = new Map(Law.LOCKUPS.map(([kind], i) => [kind, i]));

  /** Where a prisoner taken on the lands of `settlement` (held by `house`) is kept: the place itself, else the nearest of the House's. */
  holdingPlace(settlement: number, house: HouseId): { settlement: number; building: BuildingState | null; text: string } {
    const here = this.lockup(settlement);
    if (here) return { settlement, building: here.building, text: here.text };
    // the nearest place of the same House with a gaol, keep or lock-up
    const from = this.world.settlements.find((s) => s.id === settlement);
    if (from) {
      let best: { settlement: number; building: BuildingState; text: string; d: number } | null = null;
      for (const s of this.world.settlements) {
        if (s.id === settlement) continue;
        const d = Math.hypot(s.x - from.x, s.z - from.z);
        if (d > 7000 || (best && d >= best.d)) continue;
        if (house && this.houseOf(s.id) !== house) continue;
        const l = this.lockup(s.id);
        if (l) best = { settlement: s.id, building: l.building, text: l.text, d };
      }
      if (best) return { settlement: best.settlement, building: best.building, text: best.text };
    }
    return { settlement, building: null, text: `the stocks at ${this.placeName(settlement)}` };
  }

  /** The door of a building as the zone's navigation has it (the point to stand at), or the building's own place. */
  doorOf(building: number): { x: number; z: number; yaw: number } | null {
    const z = this.zone;
    const d = z?.nav.doorOf(building) ?? null;
    if (d) return d;
    const b = this.state.buildings.get(building);
    if (!b) return null;
    const depth = (BUILDINGS[b.kind]?.d ?? 6) / 2 + 1.6;
    return { x: b.x + Math.sin(b.rot) * depth, z: b.z + Math.cos(b.rot) * depth, yaw: b.rot };
  }
}
