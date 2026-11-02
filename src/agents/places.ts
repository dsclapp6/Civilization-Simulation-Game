// Where things are in a settlement: the buildings that matter for daily life (church, alehouse,
// smithy, butts, stalls…), the open fields of each household, pastures, gates. Built lazily per
// settlement from the sim's buildings and the world's strips and parcels, and refreshed when the
// buildings change. Everything the schedule needs to pick a place comes from here.
import { BUILDINGS, type BuildingKind } from '../content/types';
import type { P2 } from '../core/math';
import { hash01 } from '../core/math';
import type { BuildingState, GameState } from '../sim/state';
import type { LandParcel, Settlement, Strip, WorldModel } from '../world/types';
import { doorStand, frontPoint, type DoorPoint } from './geometry';

export interface Spot { x: number; z: number; yaw: number; building: number }

const CHURCH_KINDS: readonly BuildingKind[] = ['church', 'chapel', 'abbey_church', 'cathedral'];
const ALE_KINDS: readonly BuildingKind[] = ['alehouse', 'tavern'];
const LORD_KINDS: readonly BuildingKind[] = ['manor_house', 'keep_stone', 'motte', 'great_hall'];

export class SettlementPlaces {
  readonly buildings: readonly BuildingState[];
  readonly byKind = new Map<BuildingKind, BuildingState[]>();
  church: BuildingState | null = null;
  /** The churchyard: a point in front of the church door where people gather. */
  churchyard: Spot = { x: 0, z: 0, yaw: 0, building: -1 };
  alehouses: BuildingState[] = [];
  lordSeat: BuildingState | null = null;
  /** Centre of the settlement's open space (green, square). */
  green: P2 = { x: 0, z: 0 };
  /** Where a market is held (stalls around the cross or hall; the green otherwise). */
  marketCentre: P2 = { x: 0, z: 0 };
  stalls: BuildingState[] = [];
  hasMarketBuildings = false;
  strips: Strip[] = [];
  pastures: LandParcel[] = [];
  woodlots: LandParcel[] = [];
  gardens: LandParcel[] = [];
  /** world strip ids by holding household (0 = demesne), refreshed daily. */
  private holderDay = -1;
  private readonly byHolder = new Map<number, number[]>();
  private readonly tmp: DoorPoint = { x: 0, z: 0, yaw: 0 };

  constructor(readonly settlement: Settlement, private readonly state: GameState, private readonly world: WorldModel) {
    this.buildings = state.buildingsAt.get(settlement.id) ?? [];
    for (const b of this.buildings) {
      // a building raised in play is a place of daily life only once it is finished (until then it is a site: sites.ts)
      if (b.plot < 0 && b.construction < 1) continue;
      let list = this.byKind.get(b.kind);
      if (!list) { list = []; this.byKind.set(b.kind, list); }
      list.push(b);
    }
    this.green = { x: settlement.x, z: settlement.z };
    this.church = this.pick(CHURCH_KINDS);
    this.alehouses = this.all(ALE_KINDS);
    this.lordSeat = this.pick(LORD_KINDS);
    if (this.church) {
      const d = doorStand(this.church, this.tmp, 3.5);
      this.churchyard = { x: d.x, z: d.z, yaw: d.yaw, building: this.church.id };
    } else {
      this.churchyard = { x: settlement.x, z: settlement.z, yaw: 0, building: -1 };
    }
    // the square: stalls and cross/hall for markets; otherwise the middle of the village
    this.stalls = this.all(['market_stall']);
    const mk = this.all(['market_cross', 'market_hall', 'market_stall']);
    if (mk.length > 0) {
      let sx = 0, sz = 0;
      for (const b of mk) { sx += b.x; sz += b.z; }
      this.marketCentre = { x: sx / mk.length, z: sz / mk.length };
      this.hasMarketBuildings = true;
    } else {
      const well = this.first('well') ?? this.first('stocks');
      this.marketCentre = well ? { x: well.x, z: well.z } : { x: settlement.x, z: settlement.z };
      if (well) this.green = { x: well.x, z: well.z };
    }
    this.strips = settlement.strips.map((id) => world.strips[id]).filter((s): s is Strip => !!s);
    for (const id of settlement.parcels) {
      const par = world.parcels[id];
      if (!par) continue;
      if (par.use === 'pasture' || par.use === 'meadow') this.pastures.push(par);
      else if (par.use === 'woodlot') this.woodlots.push(par);
      else if (par.use === 'garden') this.gardens.push(par);
    }
  }

  first(kind: BuildingKind): BuildingState | null { return this.byKind.get(kind)?.[0] ?? null; }
  all(kinds: readonly BuildingKind[]): BuildingState[] {
    const out: BuildingState[] = [];
    for (const k of kinds) { const l = this.byKind.get(k); if (l) out.push(...l); }
    return out;
  }
  pick(kinds: readonly BuildingKind[]): BuildingState | null {
    for (const k of kinds) { const l = this.byKind.get(k); if (l && l.length) return l[0]; }
    return null;
  }
  /** A building of one of the kinds, chosen by a stable key (so a trade shows up at the same shop). */
  choose(kinds: readonly BuildingKind[], key: number): BuildingState | null {
    const list = this.all(kinds);
    return list.length ? list[Math.floor(hash01(key, 91) * list.length) % list.length] : null;
  }

  /** Strip ids held by a household today (0 = the lord's demesne). */
  stripsOf(household: number, day: number): readonly number[] {
    if (day !== this.holderDay) {
      this.holderDay = day;
      this.byHolder.clear();
      for (const s of this.strips) {
        const st = this.state.strips.get(s.id);
        if (!st) continue;
        let list = this.byHolder.get(st.holder);
        if (!list) { list = []; this.byHolder.set(st.holder, list); }
        list.push(s.id);
      }
    }
    return this.byHolder.get(household) ?? EMPTY;
  }

  /** A point just outside the door of a building, `extra` metres further out. */
  door(b: BuildingState, out: DoorPoint, extra = 0): DoorPoint { return doorStand(b, out, extra); }

  /** A point in front of a building at local (lx, lz) beyond its front face. */
  front(b: BuildingState, lx: number, out: DoorPoint, depth = 2, yawOffset = 0): DoorPoint {
    return frontPoint(b, lx, BUILDINGS[b.kind].d / 2 + depth, out, yawOffset);
  }

  gates(): readonly P2[] { return this.settlement.gates ?? EMPTY_P2; }
}

const EMPTY: readonly number[] = [];
const EMPTY_P2: readonly P2[] = [];

/** Lazily built places for every settlement; rebuilt when the sim's buildings change. */
export class Places {
  private readonly cache = new Map<number, SettlementPlaces>();
  private revision = -1;
  private buildingCount = -1;
  private readonly byId: Map<number, Settlement>;
  /** For each settlement without a market: the nearest settlement that has one (within reach), or −1. */
  private readonly marketTown = new Map<number, number>();
  private feeders: Map<number, number[]> | null = null;

  constructor(private readonly state: GameState, private readonly world: WorldModel) {
    this.byId = new Map(world.settlements.map((s) => [s.id, s] as const));
  }

  of(settlementId: number): SettlementPlaces | null {
    // (a building put up or pulled down changes the count even when nobody touched the revision)
    if (this.revision !== this.state.buildingRevision || this.buildingCount !== this.state.buildings.size) {
      this.cache.clear(); this.revision = this.state.buildingRevision; this.buildingCount = this.state.buildings.size;
    }
    let p = this.cache.get(settlementId);
    if (!p) {
      const s = this.byId.get(settlementId);
      if (!s) return null;
      p = new SettlementPlaces(s, this.state, this.world);
      this.cache.set(settlementId, p);
    }
    return p;
  }

  settlement(id: number): Settlement | undefined { return this.byId.get(id); }

  /** The market a settlement's people trade at (itself if it has one): nearest within 3.2 km, else −1. */
  marketTownOf(settlementId: number): number {
    const hit = this.marketTown.get(settlementId);
    if (hit !== undefined) return hit;
    const s = this.byId.get(settlementId);
    let best = -1;
    if (s) {
      if (s.market) best = s.id;
      else {
        let bd = 3200 * 3200;
        for (const o of this.world.settlements) {
          if (!o.market || o.kingdom !== s.kingdom) continue;
          const d = (o.x - s.x) ** 2 + (o.z - s.z) ** 2;
          if (d < bd) { bd = d; best = o.id; }
        }
      }
    }
    this.marketTown.set(settlementId, best);
    return best;
  }

  /** Settlements whose people go to `town`'s market (not including the town itself). */
  feedersOf(town: number): readonly number[] {
    if (!this.feeders) {
      this.feeders = new Map();
      for (const s of this.world.settlements) {
        if (s.market) continue;
        const t = this.marketTownOf(s.id);
        if (t < 0) continue;
        let list = this.feeders.get(t);
        if (!list) { list = []; this.feeders.set(t, list); }
        list.push(s.id);
      }
    }
    return this.feeders.get(town) ?? EMPTY;
  }

  /** The gate of `town` nearest to a point (the town centre when it has none). */
  nearestGate(town: number, x: number, z: number, out: P2): P2 {
    const s = this.byId.get(town);
    if (!s) { out.x = x; out.z = z; return out; }
    let best: P2 = { x: s.x, z: s.z };
    let bd = Infinity;
    for (const g of s.gates ?? EMPTY_P2) {
      const d = (g.x - x) ** 2 + (g.z - z) ** 2;
      if (d < bd) { bd = d; best = g; }
    }
    if (bd === Infinity) {
      // no gates: the edge of the settlement on the side facing (x, z)
      const dx = x - s.x, dz = z - s.z, l = Math.hypot(dx, dz) || 1;
      out.x = s.x + (dx / l) * s.radius; out.z = s.z + (dz / l) * s.radius;
      return out;
    }
    out.x = best.x; out.z = best.z;
    return out;
  }
}
