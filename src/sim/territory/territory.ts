// Territory (civilization pass, docs/CIV.md §4, §7): whose land every point is, who may be where, what the land holds.
// Everything here is a pure function of the world, the game state (titles, strips, buildings, wars) and the day; the only
// thing saved is the lords' leave (`state.ext['territory']`, written when a patrol grants one). Registered as
// `sim.services.territory`; the other modules (military, politics, construction, realm) are found lazily and guarded.
import { BUILDINGS } from '../../content/types';
import type { P2 } from '../../core/math';
import { LandsIndex, type LandsScan } from '../../world/lands';
import { Biome, WORLD_SIZE, type Deposit, type ResourceKind, type Settlement } from '../../world/types';
import { dayPart, isMarketDay } from '../calendar';
import type { Simulation } from '../sim';
import { NONE, type HouseId, type Person, type PersonId } from '../state';
import type { SocialApi } from '../social/types';
import type { Wave3Deps } from '../wave3deps';
import { TERRITORY } from './config';
import { Layers } from './layers';
import { NO_OWNER, resolveOwner, titleOfSettlement, type Owner } from './owners';
import type {
  LandInfo, LandKind, LandOwner, ResourceProfile, TerritoryRuntime, TrespassCause, TrespassCheck,
} from './types';

export const EXT_KEY = 'territory';
/** Offices that come with a title: when one changes hands the land's lord may have changed (the military module's list). */
const TITLE_OFFICES: ReadonlySet<string> = new Set(['lord', 'baron', 'earl', 'king', 'abbot', 'bishop']);

/** Saved: leave granted to people on private land, [person, settlement, absolute day it ends]. */
interface TerritorySave { v: 1; leave: Array<[PersonId, number, number]> }

/** A founded outpost's claim on the land round it. */
interface Claim { id: number; x: number; z: number; parent: number; name: string; owner: Owner }

/** Footprints of buildings raised in play (BuildingState.plot < 0), indexed by 64 m cell. */
class RaisedBuildings {
  private readonly cells = new Map<number, number[]>();
  private readonly ids: number[] = [];
  private readonly c: number[] = [];
  count = 0;
  clear(): void { this.cells.clear(); this.ids.length = 0; this.c.length = 0; this.count = 0; }
  add(id: number, x: number, z: number, rot: number, w: number, d: number): void {
    const i = this.ids.length;
    this.ids.push(id);
    this.c.push(x, z, Math.cos(rot), Math.sin(rot), w / 2, d / 2);
    const r = Math.hypot(w, d) / 2;
    for (let cz = Math.floor((z - r) / 64); cz <= Math.floor((z + r) / 64); cz++) {
      for (let cx = Math.floor((x - r) / 64); cx <= Math.floor((x + r) / 64); cx++) {
        const k = cz * 4096 + cx;
        const a = this.cells.get(k);
        if (a) a.push(i); else this.cells.set(k, [i]);
      }
    }
    this.count++;
  }
  at(x: number, z: number): number {
    const a = this.cells.get(Math.floor(z / 64) * 4096 + Math.floor(x / 64));
    if (!a) return -1;
    for (const i of a) {
      const o = i * 6, dx = x - this.c[o], dz = z - this.c[o + 1];
      const lx = dx * this.c[o + 2] - dz * this.c[o + 3], lz = dx * this.c[o + 3] + dz * this.c[o + 2];
      if (Math.abs(lx) <= this.c[o + 4] && Math.abs(lz) <= this.c[o + 5]) return this.ids[i];
    }
    return -1;
  }
}

/** Deposits by 512 m cell of their centres. */
class DepositIndex {
  private readonly cells = new Map<number, Deposit[]>();
  constructor(readonly all: readonly Deposit[]) {
    for (const d of all) {
      const k = Math.floor(d.z / 512) * 1024 + Math.floor(d.x / 512);
      const a = this.cells.get(k);
      if (a) a.push(d); else this.cells.set(k, [d]);
    }
  }
  /** Deposits whose centre lies within `radius` of the point, nearest first. */
  near(x: number, z: number, radius: number, kind?: ResourceKind): Deposit[] {
    const out: Array<{ d: Deposit; d2: number }> = [];
    const r2 = radius * radius;
    for (let cz = Math.floor((z - radius) / 512); cz <= Math.floor((z + radius) / 512); cz++) {
      for (let cx = Math.floor((x - radius) / 512); cx <= Math.floor((x + radius) / 512); cx++) {
        const a = this.cells.get(cz * 1024 + cx);
        if (!a) continue;
        for (const d of a) {
          if (kind && d.kind !== kind) continue;
          const d2 = (d.x - x) ** 2 + (d.z - z) ** 2;
          if (d2 <= r2) out.push({ d, d2 });
        }
      }
    }
    out.sort((p, q) => p.d2 - q.d2 || p.d.id - q.d.id);
    return out.map((e) => e.d);
  }
  /** The deposit whose extent holds the point (the one the point is nearest the middle of), or null. */
  at(x: number, z: number, kind?: ResourceKind): Deposit | null {
    let best: Deposit | null = null, bestR = Infinity;
    const cx0 = Math.floor(x / 512), cz0 = Math.floor(z / 512);
    for (let cz = cz0 - 1; cz <= cz0 + 1; cz++) {
      for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
        const a = this.cells.get(cz * 1024 + cx);
        if (!a) continue;
        for (const d of a) {
          if (kind && d.kind !== kind) continue;
          const d2 = (d.x - x) ** 2 + (d.z - z) ** 2;
          if (d2 > d.radius * d.radius) continue;
          const ratio = d2 / (d.radius * d.radius);
          if (ratio < bestR || (ratio === bestR && best && d.id < best.id)) { bestR = ratio; best = d; }
        }
      }
    }
    return best;
  }
}

export class Territory implements TerritoryRuntime {
  private readonly sim: Simulation;
  private readonly lands: LandsIndex;
  private readonly layers: Layers;
  private readonly sById = new Map<number, Settlement>();
  private readonly depIndex: DepositIndex;
  private readonly raised = new RaisedBuildings();
  private raisedDirty = true;
  private readonly social: SocialApi | undefined;
  private readonly offs: Array<() => void> = [];
  private readonly scan: LandsScan = { lands: -1, built: -1 };
  private readonly scratch: LandInfo = { kind: 'wild', settlement: -1, house: 0, title: 0, household: 0, strip: -1, parcel: -1, building: -1 };

  // ---- change tracking ----
  private ver = 1;
  private hourSeen = Number.NaN;
  private titleSig = 0;
  private warSig = 0;
  private readonly owners: Array<Owner | undefined> = [];
  private claims: Claim[] = [];
  private claimSig = '';
  private profileEpoch = 0;
  private readonly profiles = new Map<number, ResourceProfile>();
  private riverHolders: Set<number> | null = null;
  private readonly alarms = new Map<number, { hour: number; on: boolean }>();

  // ---- saved ----
  private leave = new Map<number, Map<number, number>>();

  constructor(sim: Simulation, deps: Wave3Deps) {
    this.sim = sim;
    this.social = deps.social;
    const world = sim.world;
    for (const s of world.settlements) this.sById.set(s.id, s);
    this.lands = new LandsIndex(world.settlements, { biome: world.macro.biome, res: world.macro.res, cell: world.macro.cell });
    this.layers = new Layers(world);
    this.depIndex = new DepositIndex(world.deposits ?? []);
    this.loadLeave();
    // the events that move who holds land, who fights whom, or what stands on it
    const on = sim.events.on.bind(sim.events);
    this.offs.push(on('inheritance', () => this.bump()));
    this.offs.push(on('office', (e) => { if (TITLE_OFFICES.has(e.office)) this.bump(); }));
    this.offs.push(on('death', (e) => { if (e.wasHead || sim.state.titlesHeldBy(e.person).size > 0) this.bump(); }));
    for (const ev of ['war', 'stance', 'siege', 'raid'] as const) this.offs.push(on(ev, () => this.bump()));
    this.offs.push(on('construction', () => { this.raisedDirty = true; this.watchOutposts(); }));
    this.offs.push(on('dayStarted', () => this.expireLeave()));
    this.titleSig = this.titleSignature();
    this.warSig = this.warSignature();
    this.watchOutposts(false);
  }

  dispose(): void { for (const off of this.offs) off(); this.offs.length = 0; }

  private get state() { return this.sim.state; }
  private get world() { return this.sim.world; }

  // ---------------------------------------------------------------- change tracking

  version(): number { this.sync(); return this.ver; }

  refresh(): void { this.hourSeen = Number.NaN; this.sync(); }

  /** Once a game hour: compare titles, wars and outposts with what the caches were built from. */
  private sync(): void {
    const hour = Math.floor(this.sim.absDay * 24);
    if (hour === this.hourSeen) return;
    this.hourSeen = hour;
    let changed = false;
    const t = this.titleSignature();
    if (t !== this.titleSig) { this.titleSig = t; changed = true; }
    const w = this.warSignature();
    if (w !== this.warSig) { this.warSig = w; changed = true; }
    if (this.watchOutposts(false)) changed = true;
    if (changed) this.bump();
  }

  private bump(): void {
    this.ver++;
    this.owners.length = 0;
    this.alarms.clear();
    for (const c of this.claims) c.owner = NO_OWNER;
    // what the caches will be rebuilt from: a later quiet change away from it (a title going back to its old holder) is seen
    this.titleSig = this.titleSignature();
    this.warSig = this.warSignature();
  }

  /** A sum over every title's holder and regent (order-independent, so a loaded game agrees with the live one). */
  private titleSignature(): number {
    let sum = 0;
    for (const t of this.state.titles.values()) {
      const p = this.state.persons.get(t.holder);
      sum = (sum + Math.imul(t.id * 31 + t.holder * 7 + t.regent * 3 + (p && !p.death ? 1 : 0) + (p ? p.house * 13 : 0), 0x9e3779b1)) | 0;
    }
    return sum;
  }

  private warSignature(): number {
    const pol = this.sim.services.politics;
    if (!pol) return 0;
    let sum = 0;
    for (const w of pol.wars()) sum = (sum + Math.imul(w.id * 17 + w.attackers.length * 5 + w.defenders.length * 3 + 1, 0x85ebca6b)) | 0;
    return sum;
  }

  /** Reads the outposts founded so far; true when they changed (and the claims, owners and profiles are rebuilt). */
  private watchOutposts(bumpIfChanged = true): boolean {
    const c = this.sim.services.construction;
    const list = c ? c.outposts() : [];
    let sig = '';
    for (const o of list) sig += `${o.id},${Math.round(o.x)},${Math.round(o.z)},${o.settlement};`;
    if (sig === this.claimSig) return false;
    this.claimSig = sig;
    this.claims = list.map((o) => ({ id: o.id, x: o.x, z: o.z, parent: o.settlement, name: o.name, owner: NO_OWNER }));
    this.profileEpoch++;
    this.profiles.clear();
    this.owners.length = 0;
    if (bumpIfChanged) this.ver++;
    return true;
  }

  // ---------------------------------------------------------------- owners

  /** Who holds the lands of a settlement now (cached until something moves). */
  private ownerInternal(settlement: number): Owner {
    if (settlement < 0) return NO_OWNER;
    let o = this.owners[settlement];
    if (!o) {
      const s = this.sById.get(settlement);
      o = s ? resolveOwner(this.state, titleOfSettlement(this.state, this.world, s), this.sim.absDay) : NO_OWNER;
      this.owners[settlement] = o;
    }
    return o;
  }

  ownerOf(settlement: number): LandOwner { this.sync(); const o = this.ownerInternal(settlement); return { house: o.house, title: o.title, holder: o.holder, lord: o.lord }; }

  /** The House whose lord holds the lands round a person's home (what a commoner's loyalty follows). */
  private lordHouseAt(settlement: number): HouseId {
    const holder = this.lands.holderOf(settlement);
    return this.ownerInternal(holder >= 0 ? holder : settlement).house;
  }

  // ---------------------------------------------------------------- land

  landsRadius(settlement: number): number { return this.lands.radiusOf(settlement); }

  landAt(x: number, z: number): LandInfo {
    this.sync();
    const info: LandInfo = { kind: 'wild', settlement: -1, house: 0, title: 0, household: 0, strip: -1, parcel: -1, building: -1 };
    this.locate(x, z, info);
    return info;
  }

  settlementOf(x: number, z: number): number {
    this.sync();
    this.locate(x, z, this.scratch);
    return this.scratch.settlement;
  }

  /** The outpost claim holding a point of wild land, if any. */
  private claimAt(x: number, z: number): Claim | null {
    const r2 = TERRITORY.outpostClaim * TERRITORY.outpostClaim;
    let best: Claim | null = null, bd = Infinity;
    for (const c of this.claims) {
      const d2 = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d2 <= r2 && d2 < bd) { bd = d2; best = c; }
    }
    if (best && best.owner === NO_OWNER) best.owner = this.ownerInternal(this.lands.holderOf(best.parent) >= 0 ? this.lands.holderOf(best.parent) : best.parent);
    return best;
  }

  /** Is there a castle whose park holds this woodland (the castle's lands are those of the settlement)? Returns the castle's id or -1. */
  private parkAt(x: number, z: number, settlement: number): number {
    const reach = TERRITORY.parkRadius;
    for (const c of this.layers.castles) {
      const d = Math.hypot(x - c.cx, z - c.cz);
      if (d > reach + 40) continue;
      const holder = this.lands.holderOf(c.settlement);
      if (holder === settlement || c.settlement === settlement) return c.settlement;
    }
    return -1;
  }

  /** Is the building with this id still standing (a demolished one leaves its footprint)? */
  private standing(id: number): boolean { return this.state.buildings.has(id); }

  /** Fills `info` for the point and returns who holds the land. */
  private locate(x: number, z: number, info: LandInfo): Owner {
    info.kind = 'wild'; info.settlement = -1; info.house = 0; info.title = 0; info.household = 0; info.strip = -1; info.parcel = -1; info.building = -1;
    if (!(x >= 0 && z >= 0 && x < WORLD_SIZE && z < WORLD_SIZE)) return NO_OWNER;
    const world = this.world, state = this.state, L = this.layers;
    const scan = this.lands.scan(x, z, this.scan);
    let settlement = scan.lands;
    let kind: LandKind | '' = '';
    let owner: Owner | null = null;

    const pi = L.plotAt(x, z);
    if (pi >= 0 && this.standing(world.plots[pi].id)) info.building = world.plots[pi].id;
    else {
      if (this.raisedDirty) this.refreshRaised();
      if (this.raised.count > 0) { const rb = this.raised.at(x, z); if (rb >= 0 && this.standing(rb)) info.building = rb; }
    }

    const si = L.stripAt(x, z);
    if (si >= 0) {
      const st = world.strips[si];
      kind = 'field'; settlement = st.settlement; info.strip = st.id;
      info.household = state.strips.get(st.id)?.holder ?? NONE;
    } else {
      const ci = L.parcelAt(x, z);
      if (ci >= 0) {
        const par = world.parcels[ci];
        settlement = par.settlement; info.parcel = par.id;
        switch (par.use) {
          case 'pasture': kind = 'pasture'; break;
          case 'meadow': kind = 'meadow'; break;
          case 'woodlot': kind = 'forest'; break;
          case 'orchard': case 'demesne': kind = 'demesne'; break;
          case 'garden': {
            kind = 'garden';
            const plot = L.gardenPlot[ci];
            if (plot >= 0) info.household = state.buildings.get(world.plots[plot].id)?.household ?? NONE;
            break;
          }
        }
      }
    }
    if (!kind) {
      const castle = L.castleAt(x, z);
      if (castle >= 0) { kind = 'castle'; settlement = castle; } else {
        const court = L.courtAt(x, z);
        if (court >= 0) { kind = 'demesne'; settlement = court; }
      }
    }
    if (!kind && scan.built >= 0) { kind = 'town'; settlement = scan.built; }
    if (!kind && L.roadAt(x, z) >= 0) kind = 'road';
    if (!kind && world.waterSurfaceAt(x, z) !== null) kind = 'water';
    // wild land near an outpost belongs to the outpost's House (and to the settlement the outpost belongs to)
    let claimed = false;
    if (settlement < 0 && this.claims.length > 0) {
      const claim = this.claimAt(x, z);
      if (claim) { settlement = claim.parent; owner = claim.owner; claimed = true; }
    }
    if (!kind) {
      if (settlement < 0) kind = 'wild';
      else if (world.forestAt(x, z) >= TERRITORY.forestMin) {
        const castle = this.parkAt(x, z, settlement);
        if (castle >= 0) { kind = 'park'; settlement = castle; owner = null; claimed = false; } else kind = 'forest';
      } else kind = claimed ? 'wild' : 'pasture';
    }
    info.kind = kind;
    info.settlement = settlement;
    if (settlement >= 0) {
      const o = owner ?? this.ownerInternal(settlement);
      info.house = o.house; info.title = o.title;
      return o;
    }
    return NO_OWNER;
  }

  private refreshRaised(): void {
    this.raisedDirty = false;
    this.raised.clear();
    for (const b of this.state.buildings.values()) {
      if (b.plot >= 0) continue;
      const def = BUILDINGS[b.kind];
      this.raised.add(b.id, b.x, b.z, b.rot, def.w, def.d);
    }
  }

  // ---------------------------------------------------------------- trespass

  trespass(person: PersonId, x: number, z: number): TrespassCheck {
    this.sync();
    const land = this.landAt(x, z);
    const none: TrespassCheck = { level: 'none', land, reason: '' };
    const p = this.state.persons.get(person);
    // a prisoner goes where he is led
    if (!p || p.death || p.flags.captive || land.settlement < 0 || land.house === 0) return none;
    const owner = this.ownerForLand(land);
    if (p.house === owner.house) return none;

    const hostile = this.hostility(p, owner);
    if (hostile) return { level: 'hostile', land, reason: hostile.reason, cause: hostile.cause, lord: owner.lord };

    const kind = land.kind;
    if (kind !== 'demesne' && kind !== 'park' && kind !== 'castle') return none;
    if (kind === 'castle' && !this.castleClosed(land.settlement, owner)) return none;
    if (this.hasBusiness(p, owner, land)) return none;
    const where = this.sById.get(land.settlement)?.name ?? 'the place';
    switch (kind) {
      case 'demesne': return { level: 'private', land, reason: `the lord's closes at ${where}`, cause: 'demesne', lord: owner.lord };
      case 'park': return { level: 'private', land, reason: `the lord's deer park at ${where}`, cause: 'park', lord: owner.lord };
      default: return { level: 'private', land, reason: `the grounds of ${where}, closed ${this.alarm(land.settlement, owner) ? 'while the castle is on alert' : 'at night'}`, cause: 'castle', lord: owner.lord };
    }
  }

  /** The owner of a point already classified (the lands of an outpost belong to the House that holds it). */
  private ownerForLand(land: LandInfo): Owner {
    const o = this.ownerInternal(land.settlement);
    if (o.house === land.house && o.title === land.title) return o;
    // an outpost's claim: the owner is that of the settlement it belongs to
    for (const c of this.claims) if (c.owner !== NO_OWNER && c.owner.house === land.house && c.owner.title === land.title) return c.owner;
    return { house: land.house, title: land.title, holder: 0, lord: 0 };
  }

  private houseName(id: HouseId): string {
    const h = this.state.houses.get(id);
    return h ? `House ${h.name}` : 'the lord';
  }

  /** War, a feud, bad blood, an outlaw's flight or a lord's grudge make the land hostile. */
  private hostility(p: Person, owner: Owner): { cause: TrespassCause; reason: string } | null {
    const lordName = `${this.houseName(owner.house)}`;
    if (p.flags.outlaw) return { cause: 'outlaw', reason: `lands of ${lordName}, where you are an outlaw` };
    const lord = owner.lord ? this.state.persons.get(owner.lord) : undefined;
    if (lord && !lord.death && lord.id !== p.id) {
      const memory = lord.opinions[p.id] ?? 0;
      // the stored memory is the cheap part of an opinion; only a grudge worth the name is looked at in full
      if (memory <= -5) {
        if (memory <= TERRITORY.enemyOpinion || this.opinionOf(lord.id, p.id) <= TERRITORY.enemyOpinion) {
          return { cause: 'enemy', reason: `the lands of ${lordName}, whose lord counts you his enemy` };
        }
      }
    }
    const lordHouse = this.lordHouseAt(p.settlement);
    const ties: HouseId[] = [p.house];
    if (lordHouse && lordHouse !== p.house) ties.push(lordHouse);
    const mil = this.sim.services.military, pol = this.sim.services.politics;
    for (const a of ties) {
      if (!a || a === owner.house) { if (a === owner.house) return null; continue; }
      const mine = a === p.house ? 'yours' : "your lord's";
      if (pol && pol.stance(owner.house, a) === 'war') return { cause: 'war', reason: `lands of ${lordName}, at war with ${mine}` };
      if (mil?.hostile?.(owner.house, a)) {
        return this.atWar(owner.house, a)
          ? { cause: 'war', reason: `lands of ${lordName}, at war with ${mine}` }
          : { cause: 'feud', reason: `lands of ${lordName}, in a feud with ${mine}` };
      }
      if (pol && pol.stance(owner.house, a) === 'hostile') return { cause: 'hostile', reason: `lands of ${lordName}, hostile to ${mine}` };
    }
    return null;
  }

  /** Is there a war between the House (or its lieges) and the other House (or its lieges)? */
  private atWar(a: HouseId, b: HouseId): boolean {
    const pol = this.sim.services.politics;
    if (!pol) return false;
    const chain = (h: HouseId): HouseId[] => { const out = [h]; for (let i = 0; i < 4; i++) { const l = pol.liegeOf(out[out.length - 1]); if (!l || out.includes(l)) break; out.push(l); } return out; };
    const ca = chain(a), cb = chain(b);
    for (const w of pol.wars()) {
      const aAtt = ca.some((h) => w.attackers.includes(h)), aDef = ca.some((h) => w.defenders.includes(h));
      const bAtt = cb.some((h) => w.attackers.includes(h)), bDef = cb.some((h) => w.defenders.includes(h));
      if ((aAtt && bDef) || (aDef && bAtt)) return true;
    }
    return false;
  }

  private opinionOf(of: PersonId, about: PersonId): number { return this.social ? this.social.opinion(of, about) : 0; }

  /** Is the castle shut: night, or a siege or a hostile army near? */
  private castleClosed(settlement: number, owner: Owner): boolean {
    return dayPart(this.sim.absDay) === 'night' || this.alarm(settlement, owner);
  }

  private alarm(settlement: number, owner: Owner): boolean {
    const hour = Math.floor(this.sim.absDay * 24);
    const hit = this.alarms.get(settlement);
    if (hit && hit.hour === hour) return hit.on;
    let on = false;
    const mil = this.sim.services.military;
    if (mil) {
      if (mil.siegeAt?.(settlement)) on = true;
      else {
        const st = this.sById.get(settlement);
        if (st && owner.house) {
          const r2 = TERRITORY.alarmRadius * TERRITORY.alarmRadius;
          for (const a of mil.armies()) {
            if ((a.x - st.x) ** 2 + (a.z - st.z) ** 2 < r2 && a.house !== owner.house && mil.hostile?.(owner.house, a.house)) { on = true; break; }
          }
        }
      }
    }
    this.alarms.set(settlement, { hour, on });
    return on;
  }

  /** Belonging, service, a pass or the market day: reasons to be on private ground. */
  private hasBusiness(p: Person, owner: Owner, land: LandInfo): boolean {
    const state = this.state;
    const hh = p.household ? state.households.get(p.household) : undefined;
    if (hh) {
      if (hh.house === owner.house) return true;
      const lord = owner.lord ? state.persons.get(owner.lord) : undefined;
      if (lord && lord.household === hh.id) return true;
    }
    for (const o of p.offices) if (o.place === land.settlement) return true;
    // the manor's bound people work his closes
    if (land.kind === 'demesne' && p.estate === 'unfree' && p.settlement === land.settlement) return true;
    if (this.leaveUntil(p.id, land.settlement) > this.sim.absDay) return true;
    const st = this.sById.get(land.settlement);
    if (st && st.market && (st.kind === 'town' || st.kind === 'city') && isMarketDay(this.sim.absDay, st.id)) return true;
    return false;
  }

  // ---- the lord's leave (saved) ----

  grantLeave(person: PersonId, settlement: number, days: number): void {
    let m = this.leave.get(person);
    if (!m) { m = new Map(); this.leave.set(person, m); }
    const until = this.sim.absDay + Math.max(0, days);
    if ((m.get(settlement) ?? 0) >= until) return;
    m.set(settlement, until);
    this.saveLeave();
  }

  leaveUntil(person: PersonId, settlement: number): number {
    return this.leave.get(person)?.get(settlement) ?? 0;
  }

  private loadLeave(): void {
    const save = this.state.ext[EXT_KEY] as TerritorySave | undefined;
    if (!save || save.v !== 1 || !Array.isArray(save.leave)) return;
    for (const [person, settlement, until] of save.leave) {
      let m = this.leave.get(person);
      if (!m) { m = new Map(); this.leave.set(person, m); }
      m.set(settlement, until);
    }
  }

  private saveLeave(): void {
    const out: Array<[PersonId, number, number]> = [];
    for (const [person, m] of this.leave) for (const [settlement, until] of m) out.push([person, settlement, until]);
    out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.state.ext[EXT_KEY] = { v: 1, leave: out } satisfies TerritorySave;
    this.state.touchExt(EXT_KEY);
  }

  private expireLeave(): void {
    const now = this.sim.absDay;
    let any = false;
    for (const [person, m] of this.leave) {
      for (const [settlement, until] of m) if (until <= now) { m.delete(settlement); any = true; }
      if (m.size === 0) this.leave.delete(person);
    }
    if (any) this.saveLeave();
  }

  /** The nearest point where the person stops trespassing, found by walking out in eight directions. */
  exitFrom(person: PersonId, x: number, z: number): P2 | null {
    if (this.trespass(person, x, z).level === 'none') return { x, z };
    let best: P2 | null = null, bestD = Infinity;
    for (let k = 0; k < 8; k++) {
      const dx = Math.cos((k / 8) * Math.PI * 2), dz = Math.sin((k / 8) * Math.PI * 2);
      let lo = 0;
      for (let r = 30; r <= 1500 && r < bestD; r += 30) {
        if (this.trespass(person, x + dx * r, z + dz * r).level === 'none') {
          let hi = r;
          for (let i = 0; i < 4; i++) { const mid = (lo + hi) / 2; if (this.trespass(person, x + dx * mid, z + dz * mid).level === 'none') hi = mid; else lo = mid; }
          if (hi < bestD) { bestD = hi; best = { x: x + dx * hi, z: z + dz * hi }; }
          break;
        }
        lo = r;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- deposits and resources

  deposits(): readonly Deposit[] { return this.depIndex.all; }
  depositsNear(x: number, z: number, radius: number, kind?: ResourceKind): Deposit[] { return this.depIndex.near(x, z, radius, kind); }
  depositAt(x: number, z: number, kind?: ResourceKind): Deposit | null { return this.depIndex.at(x, z, kind); }

  resources(settlement: number): ResourceProfile {
    this.sync();
    const holder = this.lands.holderOf(settlement);
    const id = holder >= 0 ? holder : settlement;
    let p = this.profiles.get(id);
    if (!p) { p = this.profileOf(id); this.profiles.set(id, p); }
    return p.settlement === settlement ? p : { ...p, settlement };
  }

  private riversIn(): Set<number> {
    if (this.riverHolders) return this.riverHolders;
    const set = new Set<number>();
    for (const r of this.world.rivers) for (let i = 0; i < r.points.length; i += 2) { const id = this.lands.lookup(r.points[i].x, r.points[i].z); if (id >= 0) set.add(id); }
    this.riverHolders = set;
    return set;
  }

  private profileOf(id: number): ResourceProfile {
    const world = this.world;
    const s = this.sById.get(id);
    const empty: ResourceProfile = { settlement: id, deposits: [], forest: 0, fertility: 0, coast: false, river: false, yields: [] };
    if (!s) return empty;
    const R = this.lands.radiusOf(id);
    const step = Math.max(TERRITORY.profileStep, Math.sqrt((4 * R * R) / TERRITORY.profileMaxSamples));
    const m = world.macro;
    const biomes = new Map<number, number>();
    let land = 0, wooded = 0, fertSum = 0, coast = s.port;
    for (let z = s.z - R; z <= s.z + R; z += step) {
      for (let x = s.x - R; x <= s.x + R; x += step) {
        if ((x - s.x) ** 2 + (z - s.z) ** 2 > R * R || x < 0 || z < 0 || x >= WORLD_SIZE || z >= WORLD_SIZE) continue;
        if (this.lands.lookup(x, z) !== id) continue;
        const k = Math.floor(z / m.cell) * m.res + Math.floor(x / m.cell);
        const b = m.biome[k];
        if (m.water[k] === 1 || b === Biome.Beach) { coast = true; continue; }
        if (m.water[k] === 2) continue;
        land++;
        if (m.forest[k] >= TERRITORY.forestMin * 255) wooded++;
        fertSum += m.fertility[k] / 255;
        biomes.set(b, (biomes.get(b) ?? 0) + 1);
      }
    }
    // woodlot parcels are woodland too; the fields' own fertility (not the hills round them) is what grain depends on
    let area = 0, fa = 0, pasture = 0, meadow = 0;
    for (const sid of s.strips) {
      const st = world.strips[sid];
      if (!st) continue;
      const cx = (st.poly[0].x + st.poly[2].x) / 2, cz = (st.poly[0].z + st.poly[2].z) / 2;
      const k = Math.floor(cz / m.cell) * m.res + Math.floor(cx / m.cell);
      area += st.area; fa += st.area * (m.fertility[k] / 255);
    }
    for (const pid of s.parcels) { const par = world.parcels[pid]; if (par?.use === 'pasture') pasture++; else if (par?.use === 'meadow') meadow++; }
    const forest = land ? wooded / land : 0;
    const fertility = area > 0 ? fa / area : land ? fertSum / land : 0;

    const outpostDeposits = new Set<number>();
    for (const c of this.claims) {
      if ((this.lands.holderOf(c.parent) >= 0 ? this.lands.holderOf(c.parent) : c.parent) !== id) continue;
      for (const d of this.depIndex.near(c.x, c.z, TERRITORY.outpostClaim)) outpostDeposits.add(d.id);
    }
    const deposits = this.depIndex.all.filter((d) => d.settlement === id || outpostDeposits.has(d.id));
    const kinds = new Set(deposits.map((d) => d.kind));

    const yields: string[] = [];
    if (area > 0 && fertility >= TERRITORY.grainFertility) yields.push('grain');
    if (pasture > 0 || ((biomes.get(Biome.Upland) ?? 0) + (biomes.get(Biome.Moor) ?? 0) + (biomes.get(Biome.Heath) ?? 0)) > land * 0.2) yields.push('wool');
    if (meadow > 0) yields.push('hay');
    if (forest >= TERRITORY.timberForest) yields.push('timber');
    if (forest >= TERRITORY.firewoodForest) yields.push('firewood');
    const river = this.riversIn().has(id);
    if (coast || river) yields.push('fish');
    if (kinds.has('iron')) yields.push('iron_ore');
    if (kinds.has('stone')) yields.push('stone');
    if (kinds.has('clay')) yields.push('clay');
    if (kinds.has('salt')) yields.push('salt');
    if (kinds.has('silver')) yields.push('silver_ore');
    if (kinds.has('gold')) yields.push('gold_ore');
    return { settlement: id, deposits, forest, fertility, coast, river, yields };
  }
}
