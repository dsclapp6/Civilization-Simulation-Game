// The shared runtime of the construction module: the saved section, the indexes over it, and the small operations on goods and
// money every part of the module uses. Everything that influences the simulation is in the saved section or is a pure function of
// it and the game state, so save → load → continue gives the same state hash.
import { BUILDINGS } from '../../content/types';
import { DAYS_PER_YEAR } from '../../core/time';
import type { Settlement, WorldModel } from '../../world/types';
import type { Simulation } from '../sim';
import { fullName, type GameState, type Household, type HouseId, type HouseholdId, type Person, type PersonId } from '../state';
import type { EconomyApi } from '../economy/types';
import type { Wave3Deps } from '../wave3deps';
import { Spatial } from './geometry';
import type { PlanRun } from './progress';
import { EXT_KEY, normalise, type ConstructionSave, type OutpostRec, type SiteRec } from './save';

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export class Construction {
  readonly sim: Simulation;
  readonly state: GameState;
  readonly world: WorldModel;
  readonly deps: Wave3Deps;
  save: ConstructionSave;
  readonly spatial: Spatial;
  readonly sitesById = new Map<number, SiteRec>();
  /** Sites still open (not done, not cancelled), by the building they work on. */
  readonly openByBuilding = new Map<number, SiteRec>();
  /** Who is at work on which site today. */
  readonly crewOf = new Map<PersonId, number>();
  readonly settlementById = new Map<number, Settlement>();
  /** Bumped on any change a UI would show (sites, outposts, progress in steps). */
  version = 0;
  /** Cache of views and checks, cleared when `version` or the building registry moves. */
  cacheKey = '';
  /** The ten-minute stretch of the game day a site's supply was last looked at on someone's asking (not saved: it only keeps the asking cheap). */
  readonly supplyHour = new Map<number, number>();
  /** The morning plan in progress (between the first shard of the hour and the last). */
  plan: PlanRun | null = null;
  /** Set by the progress module: plans a site's materials (and its crew, in working hours) at once. */
  planNow: ((rec: SiteRec) => void) | undefined = undefined;

  constructor(sim: Simulation, deps: Wave3Deps) {
    this.sim = sim;
    this.state = sim.state;
    this.world = sim.world;
    this.deps = deps;
    const cur = sim.state.ext[EXT_KEY] as Partial<ConstructionSave> | undefined;
    this.save = normalise(cur);
    if (cur) sim.state.ext[EXT_KEY] = this.save;
    for (const s of sim.world.settlements) this.settlementById.set(s.id, s);
    this.spatial = new Spatial(sim.world, sim.state);
    this.reindex();
  }

  // ---- time ----
  get absDay(): number { return this.sim.absDay; }
  get day(): number { return Math.floor(this.sim.absDay); }
  get dayOfYear(): number { return this.day % DAYS_PER_YEAR; }

  // ---- services (all optional: any module may be missing in a test) ----
  get territory() { return this.sim.services.territory; }
  get realm() { return this.sim.services.realm; }
  get advancement() { return this.sim.services.advancement; }
  get economy(): EconomyApi | undefined { return this.deps.economy as EconomyApi | undefined; }

  // ---- saving ----
  /** Marks the saved section changed (and creates it in the state on first use). */
  touch(): void {
    if (this.state.ext[EXT_KEY] !== this.save) this.state.ext[EXT_KEY] = this.save;
    this.state.touchExt(EXT_KEY);
  }

  /** Something a UI would show changed. */
  bump(): void { this.version++; }

  reindex(): void {
    this.sitesById.clear();
    this.openByBuilding.clear();
    this.crewOf.clear();
    for (const s of this.save.sites) {
      this.sitesById.set(s.id, s);
      if (s.closed === 0) {
        this.openByBuilding.set(s.building, s);
        if (s.planned === this.day) for (const p of s.crew) if (!this.crewOf.has(p)) this.crewOf.set(p, s.id);
      }
    }
  }

  openSites(): SiteRec[] { return this.save.sites.filter((s) => s.closed === 0); }

  /** The site the player is working at right now (a bout under way), or 0. */
  playerSite(): number {
    const pid = this.state.run.playerId;
    if (!pid) return 0;
    const a = this.sim.actions.active(pid);
    if (a && a.option.provider === 'construction') return (a.option.data as { site?: number } | undefined)?.site ?? 0;
    return 0;
  }

  // ---- people and places ----
  person(id: PersonId): Person | undefined { return this.state.persons.get(id); }
  living(id: PersonId): Person | undefined { const p = this.state.persons.get(id); return p && !p.death ? p : undefined; }
  household(id: HouseholdId): Household | undefined { return this.state.households.get(id); }
  headOf(hh: Household): Person | undefined { return hh.head ? this.living(hh.head) : undefined; }

  settlementName(id: number): string { return this.settlementById.get(id)?.name ?? 'the wild'; }
  settlementKind(id: number) { return this.settlementById.get(id)?.kind; }

  houseName(id: HouseId): string { return this.state.houses.get(id)?.name ?? ''; }
  nameOf(p: Person | undefined): string { return p ? fullName(p) : 'Someone'; }

  /** Name of a building kind for notes ("cottage", "stone keep"). */
  kindName(kind: keyof typeof BUILDINGS): string { return BUILDINGS[kind].name.toLowerCase(); }

  // ---- goods ----
  goodUnit(good: string): string { return this.economy?.good?.(good)?.unit ?? good; }
  goodName(good: string): string { return this.economy?.good?.(good)?.name?.toLowerCase() ?? good; }

  /** Households whose stores a job paid by `payer` draws on: the payer's own and, for institutions, those the House keeps in the place. */
  storeHouseholds(payer: Household, settlement: number): Household[] {
    const out: Household[] = [payer];
    if (payer.kind === 'family') return out;
    const house = payer.house ?? this.headOf(payer)?.house ?? 0;
    if (!house) return out;
    for (const hh of this.state.householdList(settlement)) {
      if (hh.id === payer.id || hh.kind === 'family') continue;
      const h = hh.house ?? 0;
      if (h === house) out.push(hh);
    }
    return out;
  }

  stockOf(hhs: readonly Household[], good: string): number {
    let n = 0;
    for (const hh of hhs) n += hh.stores[good] ?? 0;
    return n;
  }

  /** Takes up to `qty` of a good from the households' stores, in order; returns what was taken. */
  takeStock(hhs: readonly Household[], good: string, qty: number): number {
    let need = qty;
    for (const hh of hhs) {
      if (need <= 1e-9) break;
      const have = hh.stores[good] ?? 0;
      if (have <= 0) continue;
      const t = Math.min(have, need);
      const left = r3(have - t);
      if (left <= 0.0005) delete hh.stores[good]; else hh.stores[good] = left;
      this.state.touchHousehold(hh);
      need = r3(need - t);
    }
    return r3(qty - need);
  }

  addStock(hh: Household, good: string, qty: number): void {
    if (qty <= 0) return;
    hh.stores[good] = r3((hh.stores[good] ?? 0) + qty);
    this.state.touchHousehold(hh);
  }

  // ---- money ----
  /** What the payer can spend: the household purse and its head's pocket. */
  funds(hh: Household): number {
    const head = this.headOf(hh);
    return hh.purse + (head ? head.money : 0);
  }

  /** Spends `amount` from the purse, then the head's pocket. Returns what was actually taken. */
  spend(hh: Household, amount: number): number {
    if (amount <= 0) return 0;
    const fromPurse = Math.min(hh.purse, amount);
    if (fromPurse > 0) { hh.purse = r2(hh.purse - fromPurse); this.state.touchHousehold(hh); }
    let rest = amount - fromPurse;
    const head = this.headOf(hh);
    if (rest > 1e-9 && head) {
      const t = Math.min(head.money, rest);
      head.money = r2(head.money - t);
      this.state.touch(head);
      rest -= t;
    }
    return r2(amount - rest);
  }

  /** Pays a household (wages to a labourer's family). */
  credit(hh: Household | undefined, person: Person | undefined, amount: number): void {
    if (amount <= 0) return;
    if (hh) { hh.purse = r2(hh.purse + amount); this.state.touchHousehold(hh); } else if (person) { person.money = r2(person.money + amount); this.state.touch(person); }
  }

  /**
   * Runs `fn` with at least `need` pence in the payer's purse (the economy's `procure` pays from the purse only): the head's
   * pocket tops it up, and what `fn` leaves unspent of that goes back to the pocket.
   */
  withPurse<T>(hh: Household, need: number, fn: () => T): T {
    const head = this.headOf(hh);
    const before = hh.purse;
    let moved = 0;
    if (head && before < need && head.money > 0) {
      moved = r2(Math.min(head.money, need - before));
      head.money = r2(head.money - moved);
      hh.purse = r2(hh.purse + moved);
      this.state.touch(head);
      this.state.touchHousehold(hh);
    }
    const out = fn();
    if (head && moved > 0) {
      const spent = Math.max(0, r2(before + moved - hh.purse));
      const spentFromMoved = Math.max(0, r2(spent - before));
      const back = Math.min(r2(moved - spentFromMoved), hh.purse);
      if (back > 0) {
        hh.purse = r2(hh.purse - back);
        head.money = r2(head.money + back);
        this.state.touch(head);
        this.state.touchHousehold(hh);
      }
    }
    return out;
  }

  // ---- outposts ----
  outpost(id: number): OutpostRec | undefined { return this.save.outposts.find((o) => o.id === id); }
}
