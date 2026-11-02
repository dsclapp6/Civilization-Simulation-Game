// Construction (civilization pass, docs/CIV.md §5): raising, upgrading, repairing and pulling down buildings, for the
// player (build mode, B) and the AI alike. A building raised in play is an ordinary BuildingState (plot −1) whose
// `construction` grows 0→1 while its site gets labour; the renderer draws the stages.
//
// Who builds where: a ruler (holder, regent, steward; realm `rules`) anywhere in the lands of the places he rules;
// anyone on and around their own household's home (small buildings). What it costs: materials and labour, paid in coin
// from the builder's treasury (the ruling household's purse, else the builder's household) when the site is staked out —
// the steward buys the materials and hires the hands. How fast: a crew of hired hands plus the share of the manor's
// week-work the lord sends to his works (realm `worksShare`), every hour of daylight.
//
// Saved in state.ext['construction'] (sites, demolished world buildings), deterministic.
import { BUILDINGS, BUILDING_KINDS, type BuildingKind } from '../../content/types';
import type { P2 } from '../../core/math';
import { formatMoney } from '../money';
import type { RealmApi } from '../realm/types';
import type { Simulation } from '../sim';
import { NONE, ageYears, type BuildingState, type HouseholdId, type PersonId } from '../state';
import type { Wave3Deps } from '../wave3deps';
import type {
  BuildCategory, BuildCost, BuildOption, BuildScope, ConstructionApi, PlacementCheck, Result, SeatPlan, SeatStage, SiteStatus, SiteView,
} from './types';

export const CONSTRUCTION_KEY = 'construction';

interface SiteRec {
  id: number;
  building: number;
  kind: BuildingKind;
  work: SiteView['work'];
  settlement: number;
  household: HouseholdId;
  house: number;
  /** Worker-days in all, and done so far. */
  labour: number;
  done: number;
  priority: number;
  started: number;
  status: SiteStatus;
  /** For an upgrade, the level it reaches. */
  toLevel?: number;
  /** For a rebuild, the kind the building becomes. */
  toKind?: BuildingKind;
  /** People of the builder's own set to work here (besides the hired hands). */
  workers?: PersonId[];
}

interface ConSave { v: 1; next: number; sites: SiteRec[]; gone: number[] }

/** Kinds nobody raises from the builder's catalogue (great church works of whole orders; camp tents). */
const NOT_BUILT: ReadonlySet<string> = new Set(['tent', 'cathedral', 'abbey_church', 'cloister']);
const STONE: ReadonlySet<string> = new Set(['keep_stone', 'tower', 'wall', 'gatehouse', 'church', 'great_hall', 'gaol', 'guildhall', 'infirmary', 'market_cross', 'quarry', 'mine']);
/** What anyone may raise by their own home without ruling anything. */
const HOMESTEAD: ReadonlySet<string> = new Set(['henhouse', 'pigsty', 'dovecote', 'cowshed', 'sheepfold', 'kiln', 'well', 'granary', 'hovel', 'cottage', 'barn', 'stable']);
/** Kinds that need a rank (SPEC tiers) in the builder's realm. */
const RANKED: Readonly<Record<string, number>> = { keep_stone: 5, tower: 5, wall: 5, gatehouse: 5, motte: 5, great_hall: 5, barracks: 5, gallows: 5, gaol: 5 };

const CATEGORY: Readonly<Record<string, BuildCategory>> = {
  hovel: 'home', cottage: 'home', longhouse: 'home', townhouse: 'home', manor_house: 'home',
  barn: 'farm', tithe_barn: 'farm', granary: 'farm', cowshed: 'farm', stable: 'farm', sheepfold: 'farm', pigsty: 'farm', henhouse: 'farm', dovecote: 'farm',
  watermill: 'food', windmill: 'food', bakehouse: 'food', brewhouse: 'food', slaughterhouse: 'food', alehouse: 'food', tavern: 'food',
  smithy: 'craft', carpenter: 'craft', sawpit: 'craft', tannery: 'craft', weaver: 'craft', fulling_mill: 'craft', kiln: 'craft', charcoal_mound: 'craft', bloomery: 'craft',
  quarry: 'resource', clay_pit: 'resource', salt_pan: 'resource', lumber_camp: 'resource', mine: 'resource', dock: 'resource',
  library: 'civic', market_stall: 'civic', market_cross: 'civic', market_hall: 'civic', guildhall: 'civic', warehouse: 'civic', well: 'civic', stocks: 'civic', gaol: 'civic', gallows: 'civic', school: 'civic', infirmary: 'civic',
  chapel: 'religion', church: 'religion',
  palisade: 'defence', wall: 'defence', tower: 'defence', gatehouse: 'defence', motte: 'defence', keep_stone: 'defence', great_hall: 'defence',
  barracks: 'military', archery_butts: 'military', training_yard: 'military',
};

/** A stable or a farm building comes stocked: the beasts are bought with it and live in the payer's yard. */
export const STOCK: Readonly<Partial<Record<BuildingKind, Readonly<Record<string, number>>>>> = {
  stable: { horse: 3 }, cowshed: { cow: 4, ox: 2 }, sheepfold: { sheep: 20 }, pigsty: { pig: 5 }, henhouse: { chicken: 12 },
};

const DOES: Readonly<Record<string, string>> = {
  library: 'Books and a quiet room: any technique can be worked out here, and faster (research)',
  stable: 'Stalls for horses: comes with three horses, for riding and for knights and sergeants',
  cowshed: 'A byre: comes with four cows and a yoke of oxen',
  sheepfold: 'A fold: comes with twenty sheep (wool, mutton)',
  pigsty: 'A sty: comes with five pigs',
  henhouse: 'Comes with a dozen hens (eggs)',
  manor_house: 'The lord’s hall and seat; each level adds chambers, a solar and stone',
  keep_stone: 'A stone keep: the heart of a castle, the last refuge in a siege',
  tower: 'A wall tower: archers command the approaches',
  wall: 'A length of curtain wall',
  palisade: 'A length of timber palisade',
  gatehouse: 'The gate of the walls, with its towers',
  great_hall: 'A great hall for the lord’s court and feasts',
  barracks: 'Lodging for the garrison and the lord’s men',
  training_yard: 'Where men drill with sword and spear',
  archery_butts: 'Where the bowmen practise',
  watermill: 'Grinds grain; the lord takes a toll',
  windmill: 'Grinds grain where no river runs',
  church: 'The parish church', chapel: 'A chapel for prayer',
  smithy: 'Iron worked into tools and arms', carpenter: 'Timber worked into planks and furniture',
  cottage: 'A home for a family', hovel: 'A poor home', longhouse: 'A long home with the beasts under one roof', townhouse: 'A town home with a shop',
  market_hall: 'A covered market', warehouse: 'Storage for the House’s goods', granary: 'Stores grain', barn: 'Stores the harvest',
};

function footprintOf(kind: BuildingKind, x: number, z: number, rot: number): P2[] {
  const def = BUILDINGS[kind];
  const hw = def.w / 2, hd = def.d / 2, c = Math.cos(rot), s = Math.sin(rot);
  // local (lx, lz) → world, the same rotation the renderer uses for a yaw
  const at = (lx: number, lz: number): P2 => ({ x: x + lx * c + lz * s, z: z - lx * s + lz * c });
  return [at(-hw, -hd), at(hw, -hd), at(hw, hd), at(-hw, hd)];
}

/** Separating-axis overlap of two rotated rectangles (with a margin). */
function overlaps(a: { x: number; z: number; w: number; d: number; rot: number }, b: { x: number; z: number; w: number; d: number; rot: number }, margin: number): boolean {
  const axes = [a.rot, a.rot + Math.PI / 2, b.rot, b.rot + Math.PI / 2];
  const corners = (r: typeof a): P2[] => {
    const hw = r.w / 2 + margin / 2, hd = r.d / 2 + margin / 2, c = Math.cos(r.rot), s = Math.sin(r.rot);
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => ({ x: r.x + lx * c + lz * s, z: r.z - lx * s + lz * c }));
  };
  const ca = corners(a), cb = corners(b);
  for (const ang of axes) {
    const ax = Math.cos(ang), az = -Math.sin(ang);
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const p of ca) { const v = p.x * ax + p.z * az; amin = Math.min(amin, v); amax = Math.max(amax, v); }
    for (const p of cb) { const v = p.x * ax + p.z * az; bmin = Math.min(bmin, v); bmax = Math.max(bmax, v); }
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}

function pointInPoly(x: number, z: number, poly: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

export function installConstruction(sim: Simulation, deps: Wave3Deps): ConstructionApi {
  const st = sim.state;
  const save = (): ConSave => {
    let s = st.ext[CONSTRUCTION_KEY] as ConSave | undefined;
    if (!s || s.v !== 1) { s = { v: 1, next: 1, sites: [], gone: [] }; st.ext[CONSTRUCTION_KEY] = s; }
    return s;
  };
  let version = 0;
  const touch = (): void => { version++; st.touchExt(CONSTRUCTION_KEY); };
  const realm = (): RealmApi | undefined => sim.services.realm as RealmApi | undefined;
  const price = (good: string): number => deps.economy?.good(good)?.basePrice ?? 2;

  // demolished world buildings stay gone after a load
  for (const id of save().gone) removeBuilding(id);

  function removeBuilding(id: number): void {
    const b = st.buildings.get(id);
    if (!b) return;
    st.buildings.delete(id);
    const list = st.buildingsAt.get(b.settlement);
    if (list) { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); }
    st.touchBuilding(b);
  }

  // ---- who may build where ----
  const ruled = (person: PersonId): number[] => {
    const R = realm();
    if (!R) return [];
    const v = R.view(person);
    if (!v) return [];
    const role = v.role ?? 'holder';
    return role === 'reeve' ? [] : [...v.settlements];
  };
  const payer = (person: PersonId): HouseholdId => {
    const v = realm()?.view(person);
    if (v && v.household) return v.household;
    return st.persons.get(person)?.household ?? NONE;
  };
  const scope = (person: PersonId): BuildScope => {
    const p = st.persons.get(person);
    const settlements = ruled(person);
    const hh = p ? st.households.get(p.household) : undefined;
    const own = hh && hh.home ? [hh.home] : [];
    const names = settlements.map((s) => sim.world.settlements[s]?.name).filter(Boolean);
    return {
      person, settlements, own, outposts: false,
      label: names.length ? `the lands of ${names.join(' and ')}` : 'your own home',
      household: payer(person), house: p?.house ?? 0,
    };
  };

  // ---- costs ----
  const cost = (kind: BuildingKind, level = 1): BuildCost => {
    const def = BUILDINGS[kind];
    const area = def.w * def.d;
    const stone = STONE.has(kind) || (kind === 'manor_house' && level >= 2);
    const step = Math.max(1, level);
    const k = step === 1 ? 1 : 0.6 * step;
    const goods: Record<string, number> = {};
    if (stone) { goods.stone = Math.round(area * 1.4 * k); goods.timber = Math.round(area * 0.15 * k); }
    else { goods.timber = Math.round(area * 0.3 * k); goods.planks = Math.round(area * 0.15 * k); if (CATEGORY[kind] !== 'defence') goods.straw = Math.round(area * 0.3 * k); }
    const labour = Math.max(1, Math.round(area * (stone ? 0.45 : 0.12) * k));
    let pence = labour * 2; // hired hands, a day's wage each
    for (const [g, n] of Object.entries(goods)) pence += n * price(g);
    if (step === 1) for (const [g, n] of Object.entries(STOCK[kind] ?? {})) pence += n * price(g);
    return { goods, labour, pence: Math.round(pence) };
  };
  const treasury = (hh: HouseholdId): number => st.households.get(hh)?.purse ?? 0;

  const catalogue = (person: PersonId, settlement: number): BuildOption[] => {
    const sc = scope(person);
    const rules = sc.settlements.includes(settlement);
    const me = st.persons.get(person);
    const out: BuildOption[] = [];
    for (const kind of BUILDING_KINDS) {
      if (NOT_BUILT.has(kind)) continue;
      const def = BUILDINGS[kind];
      const c = cost(kind, 1);
      const rank = RANKED[kind] ?? 0;
      const o: BuildOption = {
        kind, name: def.name, category: CATEGORY[kind] ?? 'civic', level: 1, cost: c,
        requires: { ...(rank ? { rank } : {}), ...(def.needsRiver ? { terrain: 'river' as const } : {}) },
        does: DOES[kind] ?? def.name, ok: true,
      };
      if (!rules && !HOMESTEAD.has(kind)) { o.ok = false; o.reason = 'Only the lord of this place may raise it'; }
      else if (rank && (me?.rankTier ?? 0) < rank && !rules) { o.ok = false; o.reason = 'Needs the rank of a lord'; }
      else if (treasury(sc.household) < c.pence) { o.ok = false; o.reason = `Needs ${formatMoney(c.pence)}; you have ${formatMoney(treasury(sc.household))}`; }
      out.push(o);
    }
    return out;
  };

  // ---- placement ----
  const nearRiver = (x: number, z: number, r: number): boolean => {
    for (const rv of sim.world.rivers) for (const p of rv.points) if (Math.hypot(p.x - x, p.z - z) < r) return true;
    return false;
  };
  const check = (person: PersonId, kind: BuildingKind, x: number, z: number, rot: number, ignore = -1): PlacementCheck => {
    const def = BUILDINGS[kind];
    const footprint = footprintOf(kind, x, z, rot);
    const s = sim.world.settlementAt(x, z) ?? sim.world.nearestSettlement(x, z);
    const res = (ok: boolean, reason?: string): PlacementCheck => ({ ok, ...(reason ? { reason } : {}), x, z, rot, settlement: s ? s.id : -1, footprint });
    if (!s) return res(false, 'Wild land');
    const sc = scope(person);
    const rules = sc.settlements.includes(s.id);
    if (!rules) {
      const home = sc.own.length ? st.buildings.get(sc.own[0]) : undefined;
      if (!home || !HOMESTEAD.has(kind) || Math.hypot(home.x - x, home.z - z) > 35) return res(false, rules ? 'Too far from your home' : 'Not your land');
    }
    if (Math.hypot(s.x - x, s.z - z) > 700) return res(false, 'Too far from the settlement');
    // ground: dry and not too steep
    let lo = Infinity, hi = -Infinity;
    for (const c of [...footprint, { x, z }]) { const y = sim.world.heightAt(c.x, c.z); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    if (lo < 0.4) return res(false, 'In the water');
    if (hi - lo > 2.5 + Math.max(def.w, def.d) * 0.08) return res(false, 'Too steep');
    if (def.needsRiver && !nearRiver(x, z, 30)) return res(false, 'Needs a river bank');
    if (!def.needsRiver && nearRiver(x, z, 6)) return res(false, 'In the river');
    // other buildings and building sites
    const me = { x, z, w: def.w, d: def.d, rot };
    for (const b of st.buildingsAt.get(s.id) ?? []) {
      if (b.id === ignore) continue;
      const bd = BUILDINGS[b.kind];
      if (Math.hypot(b.x - x, b.z - z) > (bd.w + bd.d + def.w + def.d) / 2 + 4) continue;
      if (overlaps(me, { x: b.x, z: b.z, w: bd.w, d: bd.d, rot: b.rot }, def.segment && bd.segment ? 0 : 1.5)) return res(false, `Overlaps the ${bd.name.toLowerCase()}`);
    }
    // the open fields are for the plough
    for (const strip of sim.world.strips) {
      if (strip.settlement !== s.id) continue;
      if (pointInPoly(x, z, strip.poly)) return res(false, 'On the open fields');
    }
    return res(true);
  };

  // ---- sites ----
  const newSite = (rec: Omit<SiteRec, 'id' | 'done' | 'status' | 'started'>): SiteRec => {
    const s = save();
    const site: SiteRec = { ...rec, id: s.next++, done: 0, status: 'working', started: sim.absDay };
    s.sites.push(site);
    touch();
    return site;
  };
  const pay = (hh: HouseholdId, pence: number): Result => {
    const h = st.households.get(hh);
    if (!h) return { ok: false, reason: 'No purse to pay from' };
    if (h.purse < pence) return { ok: false, reason: `The treasury holds ${formatMoney(h.purse)}; this needs ${formatMoney(pence)}` };
    h.purse = Math.round((h.purse - pence) * 100) / 100;
    st.touchHousehold(h);
    return { ok: true };
  };
  const mayWorkOn = (person: PersonId, b: BuildingState): Result => {
    const sc = scope(person);
    if (sc.settlements.includes(b.settlement) || sc.own.includes(b.id)) return { ok: true };
    return { ok: false, reason: 'It is not yours to change' };
  };

  /** Set while a line of wall is laid: one notice for the whole run, not one per length. */
  let quiet = false;
  const place: ConstructionApi['place'] = (person, kind, x, z, rot) => {
    if (NOT_BUILT.has(kind)) return { ok: false, reason: 'That is not raised by one lord' };
    const chk = check(person, kind, x, z, rot);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const c = cost(kind, 1);
    const hh = payer(person);
    const paid = pay(hh, c.pence);
    if (!paid.ok) return paid;
    const p = st.persons.get(person);
    const id = st.nextBuildingId++;
    const b: BuildingState = {
      id, plot: -1, kind, level: 1, settlement: chk.settlement, construction: 0.02, damage: 0, onFire: false,
      owner: p?.house ?? NONE, household: NONE, occupied: false, x, z, rot, culture: sim.world.settlements[chk.settlement]?.culture ?? 'anglo',
      seed: (id * 2654435761) >>> 0,
    };
    st.buildings.set(id, b);
    let list = st.buildingsAt.get(b.settlement);
    if (!list) { list = []; st.buildingsAt.set(b.settlement, list); }
    list.push(b);
    st.touchBuilding(b);
    const site = newSite({ building: id, kind, work: 'build', settlement: b.settlement, household: hh, house: p?.house ?? 0, labour: c.labour, priority: 1 });
    if (!quiet) sim.events.emit('notify', { kind: 'info', text: `The site of a ${BUILDINGS[kind].name.toLowerCase()} is staked out (${formatMoney(c.pence)}).`, person });
    return { ok: true, site: site.id };
  };

  const upgrade: ConstructionApi['upgrade'] = (person, building) => {
    const b = st.buildings.get(building);
    if (!b) return { ok: false, reason: 'No such building' };
    const may = mayWorkOn(person, b);
    if (!may.ok) return may;
    const def = BUILDINGS[b.kind];
    if (b.level >= def.maxLevel) return { ok: false, reason: 'It cannot be raised further' };
    if (b.construction < 1) return { ok: false, reason: 'It is still being built' };
    if (save().sites.some((s) => s.building === building && s.status !== 'done' && s.status !== 'cancelled')) return { ok: false, reason: 'Work is already under way there' };
    const c = cost(b.kind, b.level + 1);
    const hh = payer(person);
    const paid = pay(hh, c.pence);
    if (!paid.ok) return paid;
    const site = newSite({ building, kind: b.kind, work: 'upgrade', settlement: b.settlement, household: hh, house: st.persons.get(person)?.house ?? 0, labour: c.labour, priority: 1, toLevel: b.level + 1 });
    sim.events.emit('notify', { kind: 'info', text: `Work begins to enlarge the ${def.name.toLowerCase()} (${formatMoney(c.pence)}).`, person });
    return { ok: true, site: site.id };
  };

  const repair: ConstructionApi['repair'] = (person, building) => {
    const b = st.buildings.get(building);
    if (!b) return { ok: false, reason: 'No such building' };
    const may = mayWorkOn(person, b);
    if (!may.ok) return may;
    if (b.damage <= 0.01) return { ok: false, reason: 'It needs no repair' };
    const c = cost(b.kind, 1);
    const pence = Math.round(c.pence * b.damage * 0.6);
    const paid = pay(payer(person), pence);
    if (!paid.ok) return paid;
    const site = newSite({ building, kind: b.kind, work: 'repair', settlement: b.settlement, household: payer(person), house: 0, labour: Math.max(1, Math.round(c.labour * b.damage * 0.5)), priority: 1 });
    return { ok: true, site: site.id };
  };

  const demolish: ConstructionApi['demolish'] = (person, building) => {
    const b = st.buildings.get(building);
    if (!b) return { ok: false, reason: 'No such building' };
    const may = mayWorkOn(person, b);
    if (!may.ok) return may;
    if (b.household && b.occupied) return { ok: false, reason: 'A household lives there' };
    for (const hh of st.households.values()) if (hh.home === b.id) return { ok: false, reason: 'It is someone’s home' };
    const site = newSite({ building, kind: b.kind, work: 'demolish', settlement: b.settlement, household: payer(person), house: 0, labour: Math.max(1, Math.round(cost(b.kind, 1).labour * 0.25)), priority: 1 });
    return { ok: true, site: site.id };
  };

  const cancel: ConstructionApi['cancel'] = (person, siteId) => {
    const s = save().sites.find((x) => x.id === siteId);
    if (!s || s.status === 'done' || s.status === 'cancelled') return { ok: false, reason: 'No such work' };
    const b = st.buildings.get(s.building);
    if (b && !mayWorkOn(person, b).ok) return { ok: false, reason: 'It is not yours to stop' };
    s.status = 'cancelled';
    // a building not yet up comes down again
    if (s.work === 'build' && b && b.construction < 1) removeBuilding(b.id);
    touch();
    return { ok: true };
  };

  // ---- the work, every daylight hour ----
  const crewOf = (s: SiteRec): number => {
    const pop = st.residentsOf(s.settlement).filter((p) => !p.death && ageYears(p, sim.absDay) >= 16).length;
    const share = realm()?.worksShare(s.settlement) ?? 0;
    // the hired hands, the week-work sent to the works, and your own people set to it (who work a little harder)
    const own = (s.workers ?? []).filter((id) => { const p = st.persons.get(id); return !!p && !p.death; }).length;
    return 3 + Math.round(pop * share * 0.25) + Math.round(own * 1.3);
  };
  const toView = (s: SiteRec): SiteView => {
    const b = st.buildings.get(s.building);
    const crew = crewOf(s);
    const left = Math.max(0, s.labour - s.done);
    return {
      id: s.id, building: s.building, kind: s.kind, work: s.work, settlement: s.settlement, x: b?.x ?? 0, z: b?.z ?? 0, rot: b?.rot ?? 0,
      household: s.household, house: s.house, progress: s.labour > 0 ? Math.min(1, s.done / s.labour) : 1, missing: {}, labourLeft: left,
      workers: s.status === 'working' ? crew : 0, status: s.status, eta: s.status === 'working' ? sim.absDay + left / Math.max(1, crew) : Infinity,
      priority: s.priority, ...(s.status === 'working' ? { note: `${crew} hands at work · about ${Math.max(1, Math.ceil(left / Math.max(1, crew)))} days left` } : {}),
    };
  };
  const finish = (s: SiteRec): void => {
    const b = st.buildings.get(s.building);
    s.status = 'done';
    if (b) {
      if (s.work === 'build') {
        b.construction = 1;
        // the beasts come home to it
        const stock = STOCK[b.kind];
        const hh = st.households.get(s.household);
        if (stock && hh) {
          for (const [g, n] of Object.entries(stock)) hh.stores[g] = (hh.stores[g] ?? 0) + n;
          st.touchHousehold(hh);
        }
      }
      else if (s.work === 'upgrade') b.level = Math.min(BUILDINGS[b.kind].maxLevel, s.toLevel ?? b.level + 1);
      else if (s.work === 'rebuild' && s.toKind) { b.kind = s.toKind; b.level = 1; }
      else if (s.work === 'repair') b.damage = 0;
      else if (s.work === 'demolish') {
        if (b.plot >= 0) save().gone.push(b.id);
        removeBuilding(b.id);
      }
      if (st.buildings.has(b.id)) st.touchBuilding(b);
    }
    const name = BUILDINGS[s.kind].name.toLowerCase();
    const text = s.work === 'rebuild' && s.toKind ? `Your seat is rebuilt as a ${BUILDINGS[s.toKind].name.toLowerCase()}.` : s.work === 'build' ? `The ${name} is finished.` : s.work === 'upgrade' ? `The ${name} is enlarged.` : s.work === 'repair' ? `The ${name} is repaired.` : `The ${name} is pulled down.`;
    st.log(sim.absDay, 'built', `${text.slice(0, -1)} at ${sim.world.settlements[s.settlement]?.name ?? 'home'}.`, []);
    sim.events.emit('notify', { kind: 'gain', text });
  };
  sim.registerSystem({
    name: 'construction.hour', phase: 'hourly', order: 85,
    run: (_ctx, info) => {
      if (info.hour < 6 || info.hour >= 19) return;
      let any = false;
      for (const s of save().sites) {
        if (s.status !== 'working') continue;
        s.done += crewOf(s) / 13; // thirteen working hours make a worker-day
        const b = st.buildings.get(s.building);
        if (!b) { s.status = 'cancelled'; any = true; continue; }
        if (s.work === 'build') { b.construction = Math.max(0.02, Math.min(0.99, s.done / s.labour)); st.touchBuilding(b); }
        if (s.done >= s.labour) finish(s);
        any = true;
      }
      if (any) {
        // keep finished work for a few days, then forget it
        const sv = save();
        sv.sites = sv.sites.filter((s) => s.status === 'working' || sim.absDay - s.started < 8);
        touch();
      }
    },
  });

  // ---- the seat grows into a castle ----
  const seatOf = (person: PersonId): BuildingState | undefined => {
    const v = realm()?.view(person);
    if (!v) return undefined;
    const hh = st.households.get(v.household);
    return hh ? st.buildings.get(hh.home) : undefined;
  };
  const nearSeat = (seat: BuildingState, kind: BuildingKind, r = 90): BuildingState[] =>
    (st.buildingsAt.get(seat.settlement) ?? []).filter((b) => b.kind === kind && Math.hypot(b.x - seat.x, b.z - seat.z) < r);
  const stagesOf = (seat: BuildingState): SeatStage[] => {
    const hall = seat.kind === 'manor_house' || seat.kind === 'keep_stone';
    const out: SeatStage[] = [
      { label: 'Rebuild your hall as a manor house', kind: 'manor_house', work: 'rebuild', done: hall },
      { label: 'Raise the manor house: chambers and a solar', kind: 'manor_house', work: 'upgrade', done: hall && (seat.kind !== 'manor_house' || seat.level >= 2) },
      { label: 'Raise the manor house in stone', kind: 'manor_house', work: 'upgrade', done: hall && (seat.kind !== 'manor_house' || seat.level >= 3) },
      { label: 'A great hall for your court', kind: 'great_hall', work: 'build', done: nearSeat(seat, 'great_hall').length > 0 },
      { label: 'A stone keep', kind: 'keep_stone', work: 'build', done: nearSeat(seat, 'keep_stone').length > 0 },
    ];
    const towers = nearSeat(seat, 'tower').length;
    for (let i = 0; i < 4; i++) out.push({ label: `Tower ${i + 1} of the curtain`, kind: 'tower', work: 'build', done: towers > i });
    out.push({ label: 'A gatehouse', kind: 'gatehouse', work: 'build', done: nearSeat(seat, 'gatehouse').length > 0 });
    const keep = nearSeat(seat, 'keep_stone')[0];
    out.push({ label: 'Heighten the keep', kind: 'keep_stone', work: 'upgrade', done: !!keep && keep.level >= 2 });
    out.push({ label: 'Crown the keep with a great tower', kind: 'keep_stone', work: 'upgrade', done: !!keep && keep.level >= 3 });
    return out;
  };
  const seatPlan = (person: PersonId): SeatPlan | null => {
    const seat = seatOf(person);
    if (!seat) return null;
    const stages = stagesOf(seat);
    const ids = new Set([seat.id, ...(st.buildingsAt.get(seat.settlement) ?? []).filter((b) => Math.hypot(b.x - seat.x, b.z - seat.z) < 90).map((b) => b.id)]);
    const busy = save().sites.find((s) => s.status === 'working' && ids.has(s.building) && ['manor_house', 'great_hall', 'keep_stone', 'tower', 'gatehouse'].includes(s.toKind ?? s.kind));
    const n = stages.find((x) => !x.done);
    const lvl = n?.work === 'upgrade' ? (n.kind === 'manor_house' ? seat.level + 1 : (nearSeat(seat, 'keep_stone')[0]?.level ?? 1) + 1) : 1;
    return { seat: seat.id, stages, next: n && !busy ? { ...n, cost: cost(n.kind, lvl) } : null, underway: busy ? toView(busy) : null };
  };
  /** A spot round the seat for a castle building: towers at the corners of a square round it, the rest close by. */
  const spotNearSeat = (person: PersonId, seat: BuildingState, kind: BuildingKind): PlacementCheck | null => {
    if (kind === 'tower') {
      const r = 34;
      for (let i = 0; i < 4; i++) {
        const a = seat.rot + Math.PI / 4 + (i * Math.PI) / 2;
        for (const rr of [r, r + 8, r + 16]) {
          const c = check(person, kind, seat.x + Math.cos(a) * rr, seat.z + Math.sin(a) * rr, seat.rot);
          if (c.ok) return c;
        }
      }
      return null;
    }
    if (kind === 'gatehouse') {
      for (const rr of [38, 46, 54]) {
        const c = check(person, kind, seat.x + Math.sin(seat.rot) * rr, seat.z + Math.cos(seat.rot) * rr, seat.rot);
        if (c.ok) return c;
      }
    }
    return api.suggestSpot(person, kind, seat.settlement, { x: seat.x, z: seat.z });
  };
  const expandSeat = (person: PersonId): Result & { site?: number } => {
    const plan = seatPlan(person);
    if (!plan) return { ok: false, reason: 'You hold no seat' };
    if (plan.underway) return { ok: false, reason: 'Work on the seat is already under way' };
    const n = plan.next;
    if (!n) return { ok: false, reason: 'Your castle is complete' };
    const seat = st.buildings.get(plan.seat)!;
    if (n.work === 'upgrade') {
      const target = n.kind === 'manor_house' ? seat : nearSeat(seat, 'keep_stone')[0];
      return target ? upgrade(person, target.id) : { ok: false, reason: 'Nothing to raise' };
    }
    if (n.work === 'rebuild') {
      const chk = check(person, n.kind, seat.x, seat.z, seat.rot, seat.id);
      if (!chk.ok) return { ok: false, reason: `No room to rebuild: ${chk.reason?.toLowerCase()}` };
      const paid = pay(payer(person), n.cost.pence);
      if (!paid.ok) return paid;
      const site = newSite({ building: seat.id, kind: seat.kind, work: 'rebuild', toKind: n.kind, settlement: seat.settlement, household: payer(person), house: st.persons.get(person)?.house ?? 0, labour: n.cost.labour, priority: 0 });
      sim.events.emit('notify', { kind: 'info', text: `Masons begin to rebuild your hall as a ${BUILDINGS[n.kind].name.toLowerCase()} (${formatMoney(n.cost.pence)}).`, person });
      return { ok: true, site: site.id };
    }
    const spot = spotNearSeat(person, seat, n.kind);
    if (!spot) return { ok: false, reason: `No room near your seat for a ${BUILDINGS[n.kind].name.toLowerCase()}` };
    return place(person, n.kind, spot.x, spot.z, spot.rot);
  };

  // ---- your own people at the works ----
  const SERVING: ReadonlySet<string> = new Set(['servant', 'labourer', 'farmer', 'serf', 'none', 'cottar', 'shepherd', 'woodward', 'carpenter', 'mason']);
  const assignable = (person: PersonId, siteId: number): PersonId[] => {
    const s = save().sites.find((x) => x.id === siteId);
    const me = st.persons.get(person);
    if (!s || !me) return [];
    const busy = new Set(save().sites.filter((x) => x.status === 'working' && x.id !== siteId).flatMap((x) => x.workers ?? []));
    const out: Array<{ id: PersonId; rank: number }> = [];
    const hh = st.households.get(payer(person));
    const fit = (id: PersonId): boolean => {
      const p = st.persons.get(id);
      if (!p || p.death || id === person || busy.has(id) || p.flags.player || p.flags.captive) return false;
      const a = ageYears(p, sim.absDay);
      return a >= 14 && a <= 60;
    };
    // the household's servants and retainers first, then the place's serfs and labourers
    for (const id of hh?.members ?? []) if (fit(id) && st.persons.get(id)!.rankTier <= 3) out.push({ id, rank: 0 });
    for (const p of st.residentsOf(s.settlement)) {
      if (out.length >= 40) break;
      if (!fit(p.id) || out.some((o) => o.id === p.id) || p.rankTier > 2 || !SERVING.has(p.career)) continue;
      out.push({ id: p.id, rank: p.estate === 'unfree' ? 1 : 2 });
    }
    return out.sort((a, b) => a.rank - b.rank || a.id - b.id).map((o) => o.id);
  };
  const assign = (person: PersonId, siteId: number, workers: readonly PersonId[]): Result => {
    const s = save().sites.find((x) => x.id === siteId);
    if (!s || s.status !== 'working') return { ok: false, reason: 'No work under way there' };
    const b = st.buildings.get(s.building);
    if (b && !mayWorkOn(person, b).ok) return { ok: false, reason: 'It is not yours to order' };
    const allowed = new Set(assignable(person, siteId));
    s.workers = workers.filter((id) => allowed.has(id) || (s.workers ?? []).includes(id)).slice(0, 40);
    touch();
    return { ok: true };
  };
  /** Segments along a line: each one turned along it, set end to end. */
  const placeLine = (person: PersonId, kind: BuildingKind, from: P2, to: P2): Result & { sites?: number[]; skipped?: number } => {
    const def = BUILDINGS[kind];
    if (!def.segment) return { ok: false, reason: 'Only walls and palisades are laid in a line' };
    const len = Math.hypot(to.x - from.x, to.z - from.z);
    if (len < def.w * 0.5) return { ok: false, reason: 'Too short' };
    if (len > 400) return { ok: false, reason: 'Too long for one order (400 m at most)' };
    const n = Math.max(1, Math.round(len / (def.w + 0.05)));
    const ux = (to.x - from.x) / len, uz = (to.z - from.z) / len;
    // local x runs along the line: the rotation that turns (1, 0) onto (ux, uz)
    const rot = Math.atan2(-uz, ux);
    const total = cost(kind, 1).pence * n;
    const purse = st.households.get(payer(person))?.purse ?? 0;
    if (purse < total) return { ok: false, reason: `${n} lengths cost ${formatMoney(total)}; the treasury holds ${formatMoney(purse)}` };
    const sites: number[] = [];
    let skipped = 0;
    quiet = true;
    try {
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) * (len / n);
        const r = place(person, kind, from.x + ux * t, from.z + uz * t, rot);
        if (r.ok && r.site) sites.push(r.site); else skipped++;
      }
    } finally { quiet = false; }
    if (sites.length) sim.events.emit('notify', { kind: 'info', text: `${sites.length} lengths of ${def.name.toLowerCase()} are staked out${skipped ? ` (${skipped} could not be laid: something is in the way)` : ''}.`, person });
    return sites.length ? { ok: true, sites, skipped } : { ok: false, reason: 'No length of it could be laid there', skipped };
  };

  const api: ConstructionApi = {
    seatPlan, expandSeat, assignable, assign, placeLine,
    scope, catalogue, check, place, upgrade, repair, demolish, cancel,
    setPriority: (person, siteId, priority) => {
      const s = save().sites.find((x) => x.id === siteId);
      if (!s) return { ok: false, reason: 'No such work' };
      void person;
      s.priority = priority; touch();
      return { ok: true };
    },
    sites: (settlement) => save().sites.filter((s) => s.status !== 'cancelled' && (settlement === undefined || s.settlement === settlement)).map(toView),
    site: (id) => { const s = save().sites.find((x) => x.id === id); return s ? toView(s) : null; },
    siteOf: (building) => { const s = save().sites.find((x) => x.building === building && x.status === 'working'); return s ? toView(s) : null; },
    outposts: () => [],
    cost,
    suggestSpot: (person, kind, settlement, near) => {
      const s = sim.world.settlements[settlement];
      if (!s) return null;
      const cx = near?.x ?? s.x, cz = near?.z ?? s.z;
      for (let r = 12; r <= 260; r += 8) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2 + r * 0.13;
          const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
          const c = check(person, kind, x, z, Math.round((a + Math.PI / 2) / (Math.PI / 2)) * (Math.PI / 2));
          if (c.ok) return c;
        }
      }
      return null;
    },
    workersAt: (siteId) => {
      const s = save().sites.find((x) => x.id === siteId);
      return s && s.status === 'working' ? (s.workers ?? []).filter((id) => !st.persons.get(id)?.death) : [];
    },
    version: () => version,
  };
  sim.services.construction = api;
  return api;
}
