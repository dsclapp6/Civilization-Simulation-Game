// World props for the view (clarity pass): the results of work, lying about where the work was done. Stooks of sheaves
// on a reaped strip until they are carried, hay cocks on a mown meadow, a woodpile at each home sized by its firewood,
// grain sacks at the home or barn sized by its grain, stone at the quarry, a stump (and for a while the logs) where
// a tree was felled. Only near the focus (≈ 300 m), with stable ids, recomputed only when something that matters
// changes, and the version moves only when the list really differs. Pure reading of the state (the transient
// notes in feednotes.ts are drawn, never saved).
// Civilization pass (docs/CIV.md §5, §8): the materials lying at building sites (what has come in and not yet gone into
// the work, from the construction service's site views), the results at the new works from their keepers' stores
// (carcasses on the slaughterhouse's rail and joints, hides, tallow; brick hacks at kilns, clay at pits, salt at the
// pans, trunks at lumber camps), and a carcass hanging in the yard of a home whose larder holds one (`~h:` markers).
import type { P2 } from '../../core/math';
import { hash01, pointInPolygon } from '../../core/math';
import { toDate } from '../../core/time';
import type { WorldPropView } from '../../core/view';
import type { SiteView } from '../construction/types';
import { BUILDINGS } from '../../content/types';
import type { ScatterItem } from '../../world/types';
import { gardenProgress, peekExtra } from '../farming';
import type { BuildingState, Household, StripState } from '../state';
import type { Econ } from './core';
import { STAPLE_GRAINS } from './diet';
import { countGood } from './items';
import { nextTask } from './farm';
import { scatterAt } from './work-craft';

/** Props are made for things this near the focus (metres). */
export const PROP_RANGE = 300;

const HOME_KINDS: ReadonlySet<string> = new Set(['hovel', 'cottage', 'longhouse', 'townhouse', 'manor_house']);
const BARN_KINDS: ReadonlySet<string> = new Set(['barn', 'tithe_barn', 'granary']);
const TREES: ReadonlySet<string> = new Set(['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple']);

/** Where each kind of prop lives in the id space (a prop's id is `base + n`, so ids never collide and stay stable). */
const BASE = { stook: 1e9, hay: 2e9, wood: 3e9, sack: 4e9, stone: 5e9, stump: 6e9, site: 7e9, works: 8e9, larder: 9e9, garden: 1e10, made: 1.1e10 };

/** What lies at a site for each material, and the stock a full pile (size 8) stands for. */
const SITE_GOODS: readonly { good: string; kind: string; steps: readonly number[] }[] = [
  { good: 'timber', kind: 'timber_stack', steps: [0.5, 4, 10, 20, 35, 55, 80, 120] },
  { good: 'planks', kind: 'plank_pile', steps: [0.5, 5, 12, 25, 40, 60, 90, 130] },
  { good: 'stone', kind: 'stone_pile', steps: [0.5, 10, 25, 50, 100, 180, 300, 500] },
  { good: 'brick', kind: 'brick_stack', steps: [1, 20, 50, 100, 200, 400, 700, 1000] },
  { good: 'straw', kind: 'straw_bundles', steps: [0.5, 5, 10, 20, 35, 55, 80, 120] },
  { good: 'clay', kind: 'clay_heap', steps: [0.5, 3, 8, 15, 25, 40, 60, 90] },
];
const CARCASSES = ['pig_carcass', 'sheep_carcass', 'goat_carcass', 'cow_carcass', 'ox_carcass'] as const;
const WORKS: ReadonlySet<string> = new Set(['slaughterhouse', 'kiln', 'clay_pit', 'salt_pan', 'lumber_camp']);

/** Pile size 1..8 from a stock: how many of the thresholds it reaches. */
function pileCount(stock: number, thresholds: readonly number[]): number {
  let n = 0;
  for (const t of thresholds) if (stock >= t) n++;
  return n;
}
const FIREWOOD_STEPS = [0.5, 2, 5, 9, 14, 20, 28, 40];
const GRAIN_STEPS = [0.5, 4, 10, 20, 35, 55, 80, 120];

/**
 * The households the economy keeps by the day buy their fuel and their bread at market and hold next to nothing
 * (it is the player's household that is stocked by hand), yet a home with a hearth has wood stacked outside it and
 * a farm has sacks of corn by the door. So a household that holds no stores shows what its season gives it: more wood
 * in autumn and winter, corn after the harvest; the player's own household shows exactly what it keeps.
 */
function seasonalWood(season: number, key: number): number {
  const h = hash01(key, 7, 3);
  return [h < 0.5 ? 1 : 2, h < 0.7 ? 1 : 0, 2 + (h < 0.5 ? 1 : 0), 3 + (h < 0.5 ? 1 : 0)][season];
}
function seasonalGrain(season: number, key: number): number {
  const h = hash01(key, 8, 3);
  return [1 + (h < 0.5 ? 1 : 0), h < 0.5 ? 1 : 0, 3 + (h < 0.5 ? 1 : 0), 2 + (h < 0.5 ? 1 : 0)][season];
}

/** The long axis of a strip: its start (middle of the short edge that holds the first corner), unit direction, length and unit across. */
interface Frame { sx: number; sz: number; ux: number; uz: number; len: number; vx: number; vz: number; width: number }

export function stripFrame(poly: readonly P2[], out: Frame): Frame {
  const [p0, p1, p2, p3] = poly;
  const e01 = Math.hypot(p1.x - p0.x, p1.z - p0.z), e12 = Math.hypot(p2.x - p1.x, p2.z - p1.z);
  // the short edges are the ends; the start is the one that holds the first corner
  let ax: number, az: number, bx: number, bz: number, width: number, len: number;
  if (e01 >= e12) {
    // long edges p0-p1 and p2-p3; short ends p3-p0 (start) and p1-p2
    ax = (p3.x + p0.x) / 2; az = (p3.z + p0.z) / 2; bx = (p1.x + p2.x) / 2; bz = (p1.z + p2.z) / 2; width = e12; len = e01;
  } else {
    ax = (p0.x + p1.x) / 2; az = (p0.z + p1.z) / 2; bx = (p2.x + p3.x) / 2; bz = (p2.z + p3.z) / 2; width = e01; len = e12;
  }
  const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
  out.sx = ax; out.sz = az; out.ux = dx / l; out.uz = dz / l; out.len = l; out.vx = -out.uz; out.vz = out.ux; out.width = width;
  void len;
  return out;
}

export class PropFeed {
  private list_: WorldPropView[] = [];
  private scratch: WorldPropView[] = [];
  private ver = 0;
  private lastKey = '';
  private readonly frame: Frame = { sx: 0, sz: 0, ux: 0, uz: 1, len: 1, vx: 1, vz: 0, width: 1 };
  /** Strips seen in the middle of the reap-to-barn cycle, and the stooks the household farm left behind (until this day). */
  private readonly seen = new Map<number, string>();
  private readonly stookUntil = new Map<number, number>();
  private readonly stumpCache = new Map<number, ScatterItem | null>();

  constructor(private readonly E: Econ) {}

  version(): number { this.refresh(); return this.ver; }
  list(): readonly WorldPropView[] { this.refresh(); return this.list_; }

  private refresh(): void {
    const E = this.E;
    const st = E.state;
    const focus = E.sim.view.focus();
    const now = E.sim.absDay;
    const key = [
      Math.floor(now * 24), E.farmRev, this.liveKey(), st.stripRevision, st.householdRevision, st.buildingRevision, E.sim.view.felledVersion(),
      Math.round(focus.x / 40), Math.round(focus.z / 40), E.notes.rev, E.notes.felled.length, E.sim.services.construction?.version?.() ?? 0,
    ].join(':');
    if (key === this.lastKey) return;
    this.lastKey = key;
    const out = this.scratch;
    out.length = 0;
    this.build(out, focus.x, focus.z, now);
    if (!sameProps(out, this.list_)) {
      this.scratch = this.list_;
      this.list_ = out;
      this.ver++;
    }
  }

  private build(out: WorldPropView[], fx: number, fz: number, now: number): void {
    const E = this.E;
    const near = (x: number, z: number, extra = 0): boolean => Math.abs(x - fx) <= PROP_RANGE + extra && Math.abs(z - fz) <= PROP_RANGE + extra && Math.hypot(x - fx, z - fz) <= PROP_RANGE + extra;

    // ---- homes, barns and quarries ----
    const barnOf = new Map<number, BuildingState>();
    const sites: BuildingState[] = [];
    // who lives where: a home belongs to the household that has it as its home
    const livesIn = new Map<number, Household>();
    for (const s of E.world.settlements) {
      if (Math.hypot(s.x - fx, s.z - fz) - s.radius > PROP_RANGE + 40) continue;
      for (const hh of E.state.householdList(s.id)) if (hh.home >= 0) livesIn.set(hh.home, hh);
      for (const b of E.state.buildingsAt.get(s.id) ?? []) {
        if (!near(b.x, b.z)) continue;
        sites.push(b);
        if (b.household && BARN_KINDS.has(b.kind) && !barnOf.has(b.household)) barnOf.set(b.household, b);
      }
    }
    const season = toDate(now).season;
    const pp = E.person(E.playerId);
    const mine = pp ? E.hhOf(pp)?.id ?? -1 : -1;
    const farms = new Set<number>();
    for (const s of E.world.settlements) {
      if (s.strips.length === 0 || Math.hypot(s.x - fx, s.z - fz) - s.radius > PROP_RANGE + 600) continue;
      for (const id of s.strips) { const h = E.state.strips.get(id)?.holder; if (h) farms.add(h); }
    }
    for (const b of sites) {
      if (b.construction < 1 || b.damage > 0.8) continue;
      const def = sizeOf(b);
      if (HOME_KINDS.has(b.kind)) {
        const hh = livesIn.get(b.id);
        if (hh) {
          const stocked = hh.id === mine;
          const n = Math.max(pileCount(countGood(hh.stores, 'firewood'), FIREWOOD_STEPS), stocked || hh.kind !== 'family' ? 0 : seasonalWood(season, hh.id));
          if (n > 0) pushAt(out, BASE.wood + b.id, 'woodpile', b, -def.w / 2 - 1.2, -def.d * 0.15, 0.5 * Math.PI, n);
          // a carcass hanging in the yard while the larder holds one (slaughtered at home, waiting to be jointed)
          const carc = carcassCount(hh.stores);
          if (carc > 0) pushAt(out, BASE.larder + b.id, 'carcass_hanging', b, def.w / 2 + 1.4, -def.d * 0.2, -0.4, 1);
          // grain goes to the barn if the household has one, else it sits by the door
          if (!barnOf.has(hh.id)) {
            const sacks = Math.max(pileCount(grainOf(hh.stores), GRAIN_STEPS), stocked || !farms.has(hh.id) ? 0 : seasonalGrain(season, hh.id));
            if (sacks > 0) pushAt(out, BASE.sack + b.id, 'sack_pile', b, def.w / 2 + 0.9, def.d / 2 - 0.9, 0.2, sacks);
          }
        }
      } else if (BARN_KINDS.has(b.kind) && b.household) {
        const hh = E.state.households.get(b.household);
        if (hh && barnOf.get(hh.id) === b) {
          const stocked = hh.id === mine;
          const sacks = Math.max(pileCount(grainOf(hh.stores), GRAIN_STEPS), stocked || !farms.has(hh.id) ? 0 : seasonalGrain(season, hh.id));
          if (sacks > 0) pushAt(out, BASE.sack + b.id, 'sack_pile', b, def.w / 2 + 0.9, def.d / 2 - 0.9, 0.2, sacks);
        }
      } else if (WORKS.has(b.kind)) {
        worksProps(out, b, E.state.households.get(b.household) ?? null, now);
      } else if (b.kind === 'quarry') {
        const dug = E.notes.dug.get(b.id);
        const fresh = dug && now - dug.day < 2 ? dug.blocks : 0;
        pushAt(out, BASE.stone + b.id, 'stone_pile', b, def.w / 2 - 2, def.d / 2 - 1.5, 0.4, Math.min(8, 3 + Math.floor(hash01(b.id, 3, 9) * 3) + Math.floor(fresh / 2)));
      }
    }

    // ---- building sites: the materials that have come in and not yet gone into the work ----
    const C = E.sim.services.construction;
    if (C) {
      for (const sv of C.sites()) {
        if (sv.status === 'done' || sv.status === 'cancelled' || !near(sv.x, sv.z, 30)) continue;
        siteProps(out, sv);
      }
    }

    // ---- strips: sheaves lying and stooks standing on the reaped ground ----
    for (const s of E.world.settlements) {
      if (s.strips.length === 0 || Math.hypot(s.x - fx, s.z - fz) - s.radius > PROP_RANGE + 600) continue;
      for (const id of s.strips) {
        const c = E.stripCentre.get(id);
        if (!c || !near(c.x, c.z, 40)) continue;
        const stp = E.state.strips.get(id);
        if (stp) this.stripProps(out, id, stp, now);
      }
    }

    // ---- meadows: hay cocks for a day or two after the mowing ----
    for (const [parcel, m] of E.notes.mown) {
      if (now - m.day > 2) { E.notes.mown.delete(parcel); continue; }
      const q = E.world.parcels.find((x) => x.id === parcel);
      if (!q || q.poly.length < 3) continue;
      let cx = 0, cz = 0;
      for (const p of q.poly) { cx += p.x; cz += p.z; }
      if (!near(cx / q.poly.length, cz / q.poly.length, 60)) continue;
      const n = Math.max(1, Math.min(14, Math.round(m.bales / 3)));
      scatterInside(out, BASE.hay + parcel * 64, 'hay_cock', q.poly, n);
    }

    // ---- felled trees: the stump stays, the logs lie there until the woodcutter has gone ----
    const felled = E.sim.view.felled();
    for (const id of felled) {
      let it = this.stumpCache.get(id);
      if (it === undefined) { it = this.treeAt(id); this.stumpCache.set(id, it); }
      if (!it || !near(it.x, it.z)) continue;
      out.push({ id: BASE.stump + id * 2, kind: 'stump', x: it.x, z: it.z, rot: hash01(id, 3, 1) * Math.PI * 2, scale: Math.max(0.7, Math.min(1.6, it.scale)) });
    }
    const player = E.sim.view.player();
    const notes = E.notes.felled;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const gone = now - n.day > 1.5 || (player !== null && now - n.day > 0.004 && Math.hypot(player.x - n.x, player.z - n.z) > 25);
      if (gone) { notes.splice(i, 1); continue; }
      if (!near(n.x, n.z)) continue;
      out.push({ id: BASE.stump + n.id * 2 + 1, kind: 'logs', x: n.x + 1.1, z: n.z + 0.4, rot: hash01(n.id, 4, 2) * Math.PI, scale: 1, count: Math.max(1, Math.min(8, n.logs)) });
    }
    // the stooks the household farm left on a harvested strip are gone by the next day (carried in)
    for (const [id, until] of this.stookUntil) if (now > until) { this.stookUntil.delete(id); this.seen.delete(id); }

    // ---- work pass (docs/WORK.md): the player's garden beds, and the fresh results of crafts at the bench ----
    if (pp) {
      const hh = E.hhOf(pp);
      const home = hh ? E.state.buildings.get(hh.home) : undefined;
      if (hh && home && near(home.x, home.z, 40)) this.gardenProps(out, hh.id, home, now);
    }
    for (const [bid, m] of E.notes.made) {
      if (now - m.day > 1) { E.notes.made.delete(bid); continue; }
      const b = E.state.buildings.get(bid);
      if (!b || !near(b.x, b.z)) continue;
      const kind = MADE_PROP[m.good] ?? (/^(cook_|roast|stew|pottage|porridge|fish_dish)/.test(m.good) || DISHES.has(m.good) ? 'dish_pot' : 'crate');
      const def = SITE_FOOTPRINT[b.kind] ?? { w: 8, d: 6 };
      pushAt(out, BASE.made + bid * 4, kind, b, -def.w / 2 + 0.9, def.d / 2 + 1.3, 0, Math.min(8, m.batches));
    }
  }

  /** Quantised progress of the player's garden bout, so a bed being dug changes as the spade goes (not only bout by bout). */
  private liveKey(): string {
    const a = this.E.sim.actions.active(this.E.playerId);
    if (!a || !a.option.id.startsWith('garden.')) return '';
    return `${a.option.id}:${Math.floor(a.progress * 4)}`;
  }

  /**
   * The beds of the player's household, in front of the house. Each shows its state — marked out and partly dug (live, as the spade goes), dug, sown, the crop growing
   * (weedy if not weeded) and ripe, a basket of the vegetables by a bed just gathered.
   */
  private gardenProps(out: WorldPropView[], hhId: number, home: BuildingState, now: number): void {
    const E = this.E;
    const beds = E.farm.g[String(hhId)];
    const live = E.sim.actions.active(E.playerId);
    const ld = live && live.option.id.startsWith('garden.') ? (live.option.data as { step?: string; bed?: number } | undefined) : undefined;
    const gathered = E.notes.gathered.get(hhId);
    const n = Math.max(beds?.length ?? 0, ld?.bed !== undefined ? ld.bed + 1 : 0);
    if (n === 0) return;
    const spots = bedSpots(home, n);
    for (let i = 0; i < n; i++) {
      const bed = beds?.[i];
      const sp = spots[i];
      const id = BASE.garden + hhId * 32 + i * 2;
      const liveHere = ld && ld.bed === i ? live!.progress : 0;
      const step = ld && ld.bed === i ? ld.step : undefined;
      let kind = 'garden_bed', size = 0;
      if (!bed || (!bed.c && !bed.d)) {
        const dug = (bed?.p ?? 0) + (step === 'dig' ? liveHere / 2 : 0);
        if (dug > 0.02) { kind = 'garden_bed'; size = dug >= 0.985 ? 4 : Math.max(1, Math.min(3, Math.floor(dug * 4) || 1)); }
      } else if (!bed.c) {
        size = gathered?.has(i) && now - gathered.get(i)!.day < 1 ? 6 : 4;
      } else {
        const g = gardenProgress(bed.c, bed.s, now);
        if (g < 0.12) size = 5;
        else {
          kind = `bed_${GARDEN_PROP[bed.c] ?? 'cabbage'}`;
          const stage = g >= 1 ? 4 : g >= 0.7 ? 3 : g >= 0.4 ? 2 : 1;
          size = stage + (!bed.w && g > 0.25 ? 4 : 0);
        }
      }
      if (size > 0) out.push({ id, kind, x: sp.x, z: sp.z, rot: sp.rot, scale: 1, count: size });
      // a basket by the bed: filling while the gathering goes on, full for a while after
      const gat = gathered?.get(i);
      const filling = step === 'harvest' ? Math.max(0.1, (bed?.p ?? 0) + liveHere / 2) : 0;
      if (gat && now - gat.day > 1) gathered!.delete(i);
      else if (filling > 0 || gat) {
        const c = Math.cos(sp.rot), s2 = Math.sin(sp.rot);
        const lx = 1.05, lz = -0.9;
        out.push({ id: id + 1, kind: 'veg_basket', x: sp.x + lx * c + lz * s2, z: sp.z - lx * s2 + lz * c, rot: sp.rot, scale: 1, count: gat ? Math.max(3, Math.min(8, Math.round(gat.lb / 2))) : Math.max(1, Math.round(filling * 8)) });
      }
    }
  }

  private treeAt(id: number): ScatterItem | null {
    const it = scatterAt(this.E, id);
    return it && TREES.has(it.kind) ? it : null;
  }

  /** Sheaves lying after the reaping, stooks after the binding and until the carrying, and the household farm's stooks for a day. */
  private stripProps(out: WorldPropView[], id: number, stp: StripState, now: number): void {
    const E = this.E;
    const ex = peekExtra(E.farm, id);
    const ws = E.world.strips[id];
    if (!ws || ws.poly.length < 4) return;
    const prev = this.seen.get(id);
    if ((prev === 'ripe' || prev === 'harvested') && stp.state === 'stubble' && !(ex && (ex.k ?? 0) > 0.5)) this.stookUntil.set(id, now + 0.7);
    this.seen.set(id, stp.state);
    let sheaves = 0, stooks = 0;
    /** How much of the strip, from its start, the props lie along (the part reaped so far while the reaping is on). */
    let span = 1;
    const k = ex?.k ?? 0;
    const task = ex && (ex.p ?? 0) > 0.001 ? nextTask(E, stp) : null;
    if (stp.state === 'harvested' && k > 0.5) {
      // cut and lying: bound ones stand up as the binding goes on
      const total = Math.max(2, Math.min(14, Math.round(k / 5)));
      stooks = task === 'bind' ? Math.floor(total * (ex?.p ?? 0)) : 0;
      sheaves = total - stooks;
    } else if (stp.state === 'stubble' && k > 0.5) {
      stooks = Math.max(1, Math.min(12, Math.ceil(k / 8)));
    } else if (stp.state === 'ripe' && task === 'reap') {
      // behind the reaper: the cut band runs from the strip's start as far as the reaping has got
      sheaves = Math.round((ex?.p ?? 0) * 10);
      span = Math.max(0.1, Math.min(1, ex?.p ?? 0));
    } else if (stp.state === 'stubble' && this.stookUntil.has(id)) {
      stooks = 5;
    }
    if (sheaves + stooks === 0) return;
    const f = stripFrame(ws.poly, this.frame);
    const total = sheaves + stooks;
    for (let i = 0; i < total; i++) {
      // stooks first along the strip from its start, then the sheaves still lying beyond them; two staggered rows
      const t = ((i + 0.5) / total) * span;
      const lat = ((i % 2 === 0 ? -1 : 1) * 0.18 + (hash01(id, i, 7) - 0.5) * 0.12) * f.width;
      const x = f.sx + f.ux * f.len * t + f.vx * lat, z = f.sz + f.uz * f.len * t + f.vz * lat;
      const isStook = i < stooks;
      out.push({ id: BASE.stook + id * 64 + i, kind: isStook ? 'stook' : 'sheaf', x, z, rot: hash01(id, i, 9) * Math.PI * 2, scale: 0.95 + 0.15 * hash01(id, i, 5) });
    }
  }
}

/** Garden crops → their bed's prop (bed_<crop>). */
const GARDEN_PROP: Record<string, string> = { cabbage: 'cabbage', onions: 'onions', leeks: 'leeks', turnips: 'turnips' };
/** What a craft's fresh result looks like lying at the bench. */
const MADE_PROP: Record<string, string> = {
  bread: 'bread_board', cheese: 'cheese_board', candle: 'cheese_board', malt: 'sack_pile', charcoal: 'sack_pile', ale: 'barrel', salt_meat: 'barrel',
  barrel: 'barrel', bucket: 'barrel', yarn: 'cloth_bolts', cloth: 'cloth_bolts', linen: 'cloth_bolts', clothes: 'cloth_bolts', cloak: 'cloth_bolts',
  padded_armour: 'cloth_bolts', leather: 'leather_rail', vellum: 'leather_rail', planks: 'plank_pile', stone: 'stone_pile', pot: 'pot_rows', brick: 'brick_stack',
  salt: 'salt_heap', iron: 'anvil_work', nails: 'anvil_work', sickle: 'anvil_work', hoe: 'anvil_work', spade: 'anvil_work', pitchfork: 'anvil_work', axe: 'anvil_work',
  pick: 'anvil_work', hammer: 'anvil_work', tongs: 'anvil_work', chisel: 'anvil_work', shears: 'anvil_work', saw: 'anvil_work', scythe: 'anvil_work', dagger: 'anvil_work',
  bill: 'anvil_work', mace: 'anvil_work', war_axe: 'anvil_work', sword: 'anvil_work', crossbow: 'anvil_work', bolt: 'anvil_work', cap_helmet: 'anvil_work',
  kettle_hat: 'anvil_work', mail_hauberk: 'anvil_work', coat_of_plates: 'anvil_work', plough: 'anvil_work', spear: 'anvil_work',
  // the works of the land, the mill, the byre and the block
  iron_ore: 'stone_pile', silver_ore: 'stone_pile', gold_ore: 'stone_pile', clay: 'clay_heap', timber: 'log_pile', flour: 'sack_pile',
  meat: 'meat_joints', wool: 'sack_pile', milk: 'barrel', manure: 'dung_heap',
};
const DISHES: ReadonlySet<string> = new Set(['roast_meat', 'roast_fowl', 'stew', 'salt_stew', 'fish_dish', 'pottage', 'porridge']);

/**
 * Where the beds of a household lie (centre and rotation; a bed's long side is its local z): a cottage garden in front of
 * the house, to the right of the door, in a row along the facade — where one stands to work at the house, so the spade's
 * work is seen as it is done (a croft behind the house hid it).
 */
function bedSpots(home: BuildingState, n: number): { x: number; z: number; rot: number }[] {
  const out: { x: number; z: number; rot: number }[] = [];
  const def = SITE_FOOTPRINT[home.kind] ?? { w: 8, d: 6 };
  const c = Math.cos(home.rot), s = Math.sin(home.rot);
  for (let i = 0; i < n; i++) {
    const lx = 1.6 + i * 2.1, lz = def.d / 2 + 2.7;
    out.push({ x: home.x + lx * c + lz * s, z: home.z - lx * s + lz * c, rot: home.rot });
  }
  return out;
}

function sizeOf(b: BuildingState): { w: number; d: number } {
  return SIZES[b.kind] ?? { w: 8, d: 6 };
}
// footprints (content/buildings.json) of the kinds props are attached to
const SIZES: Record<string, { w: number; d: number }> = {
  hovel: { w: 5, d: 4 }, cottage: { w: 8, d: 5 }, longhouse: { w: 14, d: 6 }, townhouse: { w: 6, d: 10 }, manor_house: { w: 18, d: 10 },
  barn: { w: 14, d: 8 }, tithe_barn: { w: 24, d: 10 }, granary: { w: 6, d: 6 }, quarry: { w: 16, d: 16 },
  slaughterhouse: { w: 9, d: 6 }, kiln: { w: 4, d: 4 }, clay_pit: { w: 12, d: 12 }, salt_pan: { w: 14, d: 12 }, lumber_camp: { w: 10, d: 8 },
};

/** Carcasses hanging in a household's larder (the `~h:` markers say since when; the count is the goods'). */
function carcassCount(stores: Record<string, number>): number {
  let n = 0;
  for (const g of CARCASSES) n += countGood(stores, g);
  return Math.floor(n + 0.01);
}

/**
 * The new works show what their keepers hold (a household the economy keeps by the day holds little: then the works
 * show the ordinary look of a working place on most days, from a hash of the building and the day).
 */
function worksProps(out: WorldPropView[], b: BuildingState, hh: Household | null, now: number): void {
  const stores = hh?.stores ?? {};
  const day = Math.floor(now);
  const busy = hash01(b.id, day, 13) < 0.7;
  const def = sizeOf(b);
  const id = (k: number) => BASE.works + b.id * 16 + k;
  switch (b.kind) {
    case 'slaughterhouse': {
      // carcasses on the rail under the eaves (left of the wide door), joints on a rack, a hide on its frame, tallow
      const carc = Math.min(3, carcassCount(stores) || (busy ? 1 + Math.floor(hash01(b.id, day, 14) * 2) : 0));
      for (let i = 0; i < carc; i++) pushAt(out, id(i), 'carcass_hook', b, -3.4 + i * 0.75, def.d / 2 - 0.5 - 0.15, 0, 1);
      // behind the house: joints on a rack, a hide on its frame; the tallow pot at the end wall
      if (countGood(stores, 'meat') + countGood(stores, 'salt_meat') > 0.5 || busy) pushAt(out, id(4), 'meat_joints', b, -1.6, -def.d / 2 - 0.7, 0, 1);
      if (countGood(stores, 'hide') > 0.2 || busy) pushAt(out, id(5), 'hide_frame', b, 1.0, -def.d / 2 - 0.8, Math.PI, 1);
      if (countGood(stores, 'tallow') > 0.5 || (busy && hash01(b.id, day, 15) < 0.5)) pushAt(out, id(6), 'tallow_pot', b, -def.w / 2 - 0.7, 0.6, 0, 1);
      return;
    }
    case 'kiln': {
      const n = Math.max(pileCount(countGood(stores, 'brick'), [1, 20, 50, 100, 200, 400, 700, 1000]), busy ? 2 + Math.floor(hash01(b.id, day, 16) * 3) : 1);
      pushAt(out, id(0), 'brick_stack', b, def.w / 2 + 1.6, 0.4, Math.PI / 2, n);
      return;
    }
    case 'clay_pit': {
      const n = Math.max(pileCount(countGood(stores, 'clay'), [0.5, 3, 8, 15, 25, 40, 60, 90]), busy ? 3 : 1);
      pushAt(out, id(0), 'clay_heap', b, 2.4, def.d / 2 - 1.6, 0, n);
      return;
    }
    case 'salt_pan': {
      const n = Math.max(pileCount(countGood(stores, 'salt'), [0.5, 10, 25, 50, 90, 140, 200, 300]), busy ? 2 : 1);
      pushAt(out, id(0), 'salt_heap', b, -def.w / 2 + 4.6, def.d / 2 - 1.1, 0, n);
      return;
    }
    case 'lumber_camp': {
      const n = Math.max(pileCount(countGood(stores, 'timber'), [0.5, 2, 4, 7, 10, 14, 19, 25]), busy ? 3 + Math.floor(hash01(b.id, day, 17) * 3) : 2);
      pushAt(out, id(0), 'log_pile', b, 1.2, def.d / 2 + 1.3, 0, n);
      return;
    }
  }
}

/** The materials lying at a site: what has come in less what the work has used so far, in piles beside it. */
function siteProps(out: WorldPropView[], sv: SiteView): void {
  const need = sv.cost?.goods ?? {};
  const def = SITE_FOOTPRINT[sv.kind] ?? { w: 8, d: 6 };
  const c = Math.cos(sv.rot), s = Math.sin(sv.rot);
  let slot = 0;
  for (const g of SITE_GOODS) {
    const total = need[g.good] ?? 0;
    if (total <= 0) continue;
    const delivered = Math.max(0, total - (sv.missing[g.good] ?? 0));
    const used = sv.work === 'demolish' ? 0 : total * Math.min(1, sv.progress * 1.08);
    const here = sv.work === 'demolish' ? total * 0.35 * sv.progress : delivered - used;
    const n = pileCount(here, g.steps);
    if (n <= 0) continue;
    // along the left side, then the right, a pile every two metres from the front
    const side = slot < 3 ? -1 : 1;
    const k = slot % 3;
    const lx = side * (def.w / 2 + 1.5), lz = def.d / 2 - 0.9 - k * 2.1;
    out.push({
      id: BASE.site + sv.id * 16 + slot, kind: g.kind, x: sv.x + lx * c + lz * s, z: sv.z - lx * s + lz * c,
      rot: sv.rot + Math.PI / 2 + (hash01(sv.id, slot, 4) - 0.5) * 0.3, scale: 1, count: n,
    });
    slot++;
  }
}

/** Footprints of every kind a site may be (content/buildings.json, the w × d the models are built to). */
const SITE_FOOTPRINT: Record<string, { w: number; d: number }> = Object.fromEntries(Object.entries(BUILDINGS).map(([k, d]) => [k, { w: d.w, d: d.d }]));

function grainOf(stores: Record<string, number>): number {
  let n = 0;
  for (const g of STAPLE_GRAINS) n += countGood(stores, g);
  return n + countGood(stores, 'flour') / 6.5;
}

/** Puts a prop at local (lx, lz) of a building (door on +z). */
function pushAt(out: WorldPropView[], id: number, kind: string, b: BuildingState, lx: number, lz: number, rotOffset: number, count: number): void {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  out.push({ id, kind, x: b.x + lx * c + lz * s, z: b.z - lx * s + lz * c, rot: b.rot + rotOffset + (hash01(id, 6, 2) - 0.5) * 0.3, scale: 1, count });
}

/** `n` props at stable pseudo-random points inside a polygon. */
function scatterInside(out: WorldPropView[], base: number, kind: string, poly: readonly P2[], n: number): void {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of poly) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  let placed = 0;
  for (let i = 0; i < 80 && placed < n; i++) {
    const x = x0 + (x1 - x0) * hash01(base, i, 21), z = z0 + (z1 - z0) * hash01(base, i, 22);
    if (!pointInPolygon(x, z, poly)) continue;
    out.push({ id: base + placed, kind, x, z, rot: hash01(base, i, 23) * Math.PI * 2, scale: 0.9 + 0.2 * hash01(base, i, 24) });
    placed++;
  }
}

function sameProps(a: readonly WorldPropView[], b: readonly WorldPropView[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = b[i];
    if (p.id !== q.id || p.kind !== q.kind || p.count !== q.count || Math.abs(p.x - q.x) > 0.01 || Math.abs(p.z - q.z) > 0.01) return false;
  }
  return true;
}
