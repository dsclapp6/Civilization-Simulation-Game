// World props for the view (clarity pass): the results of work, lying about where the work was done. Stooks of sheaves
// on a reaped strip until they are carried, hay cocks on a mown meadow, a woodpile at each home sized by its firewood,
// grain sacks at the home or barn sized by its grain, stone at the quarry, a stump (and for a while the logs) where
// a tree was felled. Only near the focus (≈ 300 m), with stable ids, recomputed only when something that matters
// changes, and the version moves only when the list really differs. Pure reading of the state (the transient
// notes in feednotes.ts are drawn, never saved).
import type { P2 } from '../../core/math';
import { hash01, pointInPolygon } from '../../core/math';
import { toDate } from '../../core/time';
import type { WorldPropView } from '../../core/view';
import type { ScatterItem } from '../../world/types';
import { peekExtra } from '../farming';
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
const BASE = { stook: 1e9, hay: 2e9, wood: 3e9, sack: 4e9, stone: 5e9, stump: 6e9 };

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
      Math.floor(now * 24), E.farmRev, st.stripRevision, st.householdRevision, st.buildingRevision, E.sim.view.felledVersion(),
      Math.round(focus.x / 40), Math.round(focus.z / 40), E.notes.rev, E.notes.felled.length,
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
      } else if (b.kind === 'quarry') {
        const dug = E.notes.dug.get(b.id);
        const fresh = dug && now - dug.day < 2 ? dug.blocks : 0;
        pushAt(out, BASE.stone + b.id, 'stone_pile', b, def.w / 2 - 2, def.d / 2 - 1.5, 0.4, Math.min(8, 3 + Math.floor(hash01(b.id, 3, 9) * 3) + Math.floor(fresh / 2)));
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
      sheaves = Math.round((ex?.p ?? 0) * 10);
    } else if (stp.state === 'stubble' && this.stookUntil.has(id)) {
      stooks = 5;
    }
    if (sheaves + stooks === 0) return;
    const f = stripFrame(ws.poly, this.frame);
    const total = sheaves + stooks;
    for (let i = 0; i < total; i++) {
      // stooks first along the strip from its start, then the sheaves still lying beyond them; two staggered rows
      const t = (i + 0.5) / total;
      const lat = ((i % 2 === 0 ? -1 : 1) * 0.18 + (hash01(id, i, 7) - 0.5) * 0.12) * f.width;
      const x = f.sx + f.ux * f.len * t + f.vx * lat, z = f.sz + f.uz * f.len * t + f.vz * lat;
      const isStook = i < stooks;
      out.push({ id: BASE.stook + id * 64 + i, kind: isStook ? 'stook' : 'sheaf', x, z, rot: hash01(id, i, 9) * Math.PI * 2, scale: 0.95 + 0.15 * hash01(id, i, 5) });
    }
  }
}

function sizeOf(b: BuildingState): { w: number; d: number } {
  return SIZES[b.kind] ?? { w: 8, d: 6 };
}
// footprints (content/buildings.json) of the kinds props are attached to
const SIZES: Record<string, { w: number; d: number }> = {
  hovel: { w: 5, d: 4 }, cottage: { w: 8, d: 5 }, longhouse: { w: 14, d: 6 }, townhouse: { w: 6, d: 10 }, manor_house: { w: 18, d: 10 },
  barn: { w: 14, d: 8 }, tithe_barn: { w: 24, d: 10 }, granary: { w: 6, d: 6 }, quarry: { w: 16, d: 16 },
};

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
