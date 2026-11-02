// How a site gets built: each morning its materials are drawn from the payer's stores (and bought at a market through the
// economy's `procure`, which carts them in), and the day's labour is set — household members on the 'build' task, paid labourers,
// the manor's week-work share — then each working hour that labour is put in, up to what the materials in hand allow. The
// player's own bouts (actions.ts) add to the same site. A finished site makes the building work (or improves, mends, removes it).
import { BUILDINGS } from '../../content/types';
import { hash01 } from '../../core/math';
import { isHolyDay } from '../calendar';
import type { HourInfo } from '../clock';
import { ageYears, type BuildingState, type Household, type Person, type PersonId } from '../state';
import type { Construction } from './core';
import { HORIZON_DAYS, WORK_END, WORK_HOURS, WORK_START, levelCost, maxCrew, priceOf, rulesOf, wageFor } from './data';
import { lordTitleAt } from './scope';
import type { SiteRec } from './save';
import { closeSite, emitSite, materialFraction, progressOf, removeBuilding, salvageOf, tellPlayer } from './sites';

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------------------------------------
// Hands
// ---------------------------------------------------------------------------------------------

/** What fraction of an able adult's day's work this person puts in on a building site. */
export function workFactor(C: Construction, p: Person): number {
  if (p.death) return 0;
  const age = ageYears(p, C.absDay);
  if (age < 12) return 0;
  let f = age < 14 ? 0.35 : age < 16 ? 0.7 : age > 65 ? 0.5 : age > 55 ? 0.75 : 1;
  f *= 0.65 + 0.035 * p.trained.str;
  f *= Math.min(1, 0.45 + p.health.hp * 0.55);
  if (p.needs.hunger < 0.25) f *= 0.7;
  return Math.max(0.1, Math.min(1.4, f));
}

/** Is the man with an army (called up, marching)? He is not at the building site. */
function serving(C: Construction, p: Person): boolean {
  return !!C.sim.services.military?.armyOf(p.id);
}

/** Careers whose people hire themselves out by the day, in the order they are hired. */
const HIRED_CAREERS: Record<string, number> = { labourer: 0, cottar: 1, servant: 2, woodward: 3, farmer: 4, shepherd: 5, swineherd: 5, none: 6 };

export interface PlanCtx {
  busy: Set<PersonId>;
  pools: Map<number, Person[]>;
  taken: Map<number, number>;
  serfs: Map<number, Person[]>;
  week: Map<number, number>;
  /** The household members on the 'build' task, by paying household (asked of the economy once a morning). */
  members: Map<number, Person[]>;
  /** The households whose stores a payer draws on at a place. */
  stores: Map<string, Household[]>;
}

/** The morning's plan in progress: the sites by paying household, dealt out over the shards of the hour. */
export interface PlanRun { ctx: PlanCtx; groups: SiteRec[][] }

/** The hourly system runs in this many shards, so the plan of a hundred sites never lands on one frame. */
export const PLAN_SHARDS = 4;

function newPlanCtx(): PlanCtx {
  return { busy: new Set(), pools: new Map(), taken: new Map(), serfs: new Map(), week: new Map(), members: new Map(), stores: new Map() };
}

/** Adults of the settlement who work for a day's wage, hired in turn (a different set each day). */
function poolFor(C: Construction, ctx: PlanCtx, settlement: number): Person[] {
  const hit = ctx.pools.get(settlement);
  if (hit) return hit;
  const player = C.state.run.playerId;
  const out: Person[] = [];
  for (const p of C.state.residentsOf(settlement)) {
    if (p.id === player || p.rankTier > 2 || p.estate === 'clergy' || p.flags.captive || p.flags.outlaw || p.health.hp < 0.5) continue;
    if (HIRED_CAREERS[p.career] === undefined || serving(C, p)) continue;
    const age = ageYears(p, C.absDay);
    if (age < 15 || age > 55) continue;
    out.push(p);
  }
  const day = C.day;
  out.sort((a, b) => (HIRED_CAREERS[a.career] - HIRED_CAREERS[b.career]) || (hash01(a.id, day, 5) - hash01(b.id, day, 5)) || a.id - b.id);
  ctx.pools.set(settlement, out);
  return out;
}

/** Unfree adults of the settlement (the manor's week-work), in a daily rotation. */
function serfsOf(C: Construction, ctx: PlanCtx, settlement: number): Person[] {
  const hit = ctx.serfs.get(settlement);
  if (hit) return hit;
  const out: Person[] = [];
  const player = C.state.run.playerId;
  for (const p of C.state.residentsOf(settlement)) {
    if (p.estate !== 'unfree' || p.id === player || p.flags.captive || p.flags.outlaw || ageYears(p, C.absDay) < 14 || p.health.hp < 0.5 || serving(C, p)) continue;
    out.push(p);
  }
  const day = C.day;
  out.sort((a, b) => (hash01(a.id, day, 9) - hash01(b.id, day, 9)) || a.id - b.id);
  ctx.serfs.set(settlement, out);
  return out;
}

/** Worker-days of week-work the manor's serfs owe on each working day of a four-day week (three working days). */
function weekCapacity(C: Construction, ctx: PlanCtx, settlement: number): number {
  const hit = ctx.week.get(settlement);
  if (hit !== undefined) return hit;
  const season = Math.floor(C.dayOfYear / 4);
  const custom = season === 1 || season === 2 ? 2 : 1;
  const policy = C.sim.services.politics?.manorPolicy?.(settlement)?.labour ?? 0;
  const days = Math.max(0, custom + policy);
  let units = 0;
  for (const p of serfsOf(C, ctx, settlement)) units += (days / 3) * Math.min(1, workFactor(C, p));
  ctx.week.set(settlement, units);
  return units;
}

/** Members of the paying household set to the 'build' task by their head (the economy's plan), the player excluded. */
function buildMembers(C: Construction, ctx: PlanCtx, payer: Household): Person[] {
  const hit = ctx.members.get(payer.id);
  if (hit) return hit;
  const lines = C.economy?.householdPlan?.(payer.id) ?? [];
  const player = C.state.run.playerId;
  const out: Person[] = [];
  for (const l of lines) {
    if (l.task !== 'build' || l.person === player) continue;
    const p = C.living(l.person);
    if (p && !p.flags.captive) out.push(p);
  }
  out.sort((a, b) => a.id - b.id);
  ctx.members.set(payer.id, out);
  return out;
}

function storesFor(C: Construction, ctx: PlanCtx | undefined, payer: Household, settlement: number): Household[] {
  if (!ctx) return C.storeHouseholds(payer, settlement);
  const key = `${payer.id}|${settlement}`;
  let hit = ctx.stores.get(key);
  if (!hit) { hit = C.storeHouseholds(payer, settlement); ctx.stores.set(key, hit); }
  return hit;
}

// ---------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------

const fmtQty = (q: number): string => (Math.abs(q - Math.round(q)) < 0.05 ? String(Math.round(q)) : String(r2(q)));

/** Share of the job whose materials are worth having in hand now: what the next days' work needs. */
function horizonFraction(rec: SiteRec): number {
  return Math.min(1, (rec.done + maxCrew(rec.labour) * HORIZON_DAYS) / rec.labour);
}

/**
 * Draws the materials the next days need from the payer's stores and orders what is missing at a market. Returns the first thing
 * the site is waiting for, in words, and whether anything is on its way.
 */
function supply(C: Construction, rec: SiteRec, payer: Household, ctx?: PlanCtx): { text: string; coming: boolean; stuck: boolean } {
  const hhs = storesFor(C, ctx, payer, rec.settlement);
  const f = horizonFraction(rec);
  let text = '', coming = false, stuck = false;
  const proc = C.economy?.procure;
  for (const [g, total] of Object.entries(rec.need)) {
    const target = f >= 1 ? total : r2(total * f);
    let want = r2(target - (rec.have[g] ?? 0));
    if (want <= 0.005) continue;
    const got = C.takeStock(hhs, g, want);
    if (got > 0) { rec.have[g] = r3((rec.have[g] ?? 0) + got); want = r2(want - got); }
    const tr = rec.transit[g];
    if (want <= 0.005) { if (tr) delete rec.transit[g]; continue; }
    const name = `${fmtQty(want)} ${C.goodUnit(g)}`;
    if (tr && tr[1] + 1 > C.absDay) {
      // ordered and carted: it should arrive soon
      want = r2(want - tr[0]);
      coming = true;
      if (!text) text = `Waiting for ${name}: on the way, ${Math.max(1, Math.ceil(tr[1] - C.absDay))} day${tr[1] - C.absDay > 1 ? 's' : ''}`;
      if (want <= 0.005) continue;
    } else if (tr) delete rec.transit[g];
    if (!proc) {
      if (!text) text = `Waiting for ${name}: none in store`;
      stuck = true;
      continue;
    }
    const qty = Math.ceil(want - 1e-9);
    const res = C.withPurse(payer, qty * priceOf(g) * 1.6, () =>
      proc.call(C.economy, payer.id, g, qty, { settlement: rec.settlement, maxPrice: Math.max(1, priceOf(g) * 3) }));
    if (res.got > 0) {
      const cur = rec.transit[g];
      rec.transit[g] = [r3((cur ? cur[0] : 0) + res.got), C.absDay + res.days];
      coming = true;
      if (!text) text = `Waiting for ${name}: on the way from ${C.settlementName(res.settlement)} market, ${Math.max(1, res.days)} day${res.days > 1 ? 's' : ''}`;
    }
    if (res.got < qty - 0.005) {
      stuck = stuck || res.got <= 0;
      if (!text) text = res.got > 0 ? `Waiting for ${fmtQty(qty - res.got)} more ${C.goodUnit(g)}: the market is short` : `Waiting for ${name}: none to be had`;
    }
  }
  return { text, coming, stuck };
}

/**
 * Someone stands at a site with nothing to build with: what the stores hold now is taken in (and what is missing ordered), at most
 * once in ten game minutes, so goods the player has just brought home or bought do not wait for the morning.
 */
export function refreshSupply(C: Construction, rec: SiteRec): void {
  const hour = Math.floor(C.absDay * 144);
  if (rec.closed !== 0 || C.supplyHour.get(rec.id) === hour) return;
  C.supplyHour.set(rec.id, hour);
  const payer = C.household(rec.household);
  if (!payer) return;
  const sup = supply(C, rec, payer);
  if (sup.text) rec.note = sup.text;
  C.touch();
  C.bump();
}

/** Worker-days the job may still take given the materials in hand. */
export function capacity(rec: SiteRec): number {
  const left = rec.labour - rec.done;
  if (left <= 1e-6) return 0;
  if (rec.work === 'demolish') return left;
  return Math.max(0, Math.min(left, materialFraction(rec) * rec.labour - rec.done + 1e-6));
}

// ---------------------------------------------------------------------------------------------
// The day's plan
// ---------------------------------------------------------------------------------------------

/** The lord's household at a place, or undefined. */
function lordHouseholdAt(C: Construction, settlement: number): Household | undefined {
  const l = lordTitleAt(C, settlement);
  return l ? C.household(l.holder.household) : undefined;
}

function planSite(C: Construction, ctx: PlanCtx, rec: SiteRec): void {
  const b = C.state.buildings.get(rec.building);
  if (!b) { closeSite(C, rec, 'cancelled'); return; }
  let payer = C.household(rec.household);
  if (!payer) {
    // the household is gone: the lord of the place takes the work over, or it is dropped
    payer = lordHouseholdAt(C, rec.settlement);
    if (!payer) { closeSite(C, rec, 'cancelled'); return; }
    rec.household = payer.id;
    if (rec.work === 'build' && b.construction < 1 && rulesOf(rec.kind).cat === 'home') { b.household = payer.id; C.state.touchBuilding(b); }
    C.touch();
  }
  rec.crew = [];
  rec.perDay = 0;
  rec.from = [0, 0, 0];
  rec.planned = C.day;

  const sup = supply(C, rec, payer, ctx);
  const cap = capacity(rec);
  const holy = isHolyDay(C.absDay);
  const crewCap = maxCrew(rec.labour);
  let units = 0, household = 0, week = 0, hired = 0;

  if (!holy && cap > 0.001) {
    // 1. the household's own, on the 'build' task
    for (const m of buildMembers(C, ctx, payer)) {
      if (units >= Math.min(cap, crewCap) - 1e-6) break;
      if (ctx.busy.has(m.id)) continue;
      const f = workFactor(C, m);
      if (f <= 0) continue;
      rec.crew.push(m.id);
      ctx.busy.add(m.id);
      units += f;
      household += f;
    }
    // 2. the manor's week-work share, on the lord's own works
    const share = C.realm?.worksShare?.(rec.settlement) ?? 0;
    const lordHH = share > 0 ? lordHouseholdAt(C, rec.settlement) : undefined;
    if (share > 0 && lordHH && lordHH.id === payer.id && units < Math.min(cap, crewCap) - 1e-6) {
      const room = Math.min(cap, crewCap) - units;
      const give = Math.min(room, share * weekCapacity(C, ctx, rec.settlement));
      let got = 0;
      for (const p of serfsOf(C, ctx, rec.settlement)) {
        if (got >= give - 1e-6 || rec.crew.length >= 14) break;
        if (ctx.busy.has(p.id)) continue;
        const f = Math.min(1, workFactor(C, p));
        rec.crew.push(p.id);
        ctx.busy.add(p.id);
        got += f;
      }
      // the rest of the share is work done out of sight, by serfs not drawn
      const unseen = Math.max(0, give - got);
      week = got + unseen;
      units += week;
    }
    // 3. paid labourers
    const want = rec.hired === 'auto' ? crewCap : Math.min(crewCap, rec.hired);
    const slots = Math.min(want, Math.floor(Math.min(cap, crewCap) - units + 0.999));
    if (slots > 0) {
      const wage = wageFor(rec.kind);
      const funds = C.funds(payer);
      const reserve = payer.kind === 'family' ? 20 : funds * 0.1;
      const afford = Math.max(0, Math.floor((funds - reserve) / wage));
      const pool = poolFor(C, ctx, rec.settlement);
      const limit = Math.max(0, Math.floor(pool.length * 0.3) - (ctx.taken.get(rec.settlement) ?? 0));
      let n = Math.min(slots, afford, limit);
      for (let i = 0; i < pool.length && n > 0; i++) {
        const p = pool[i];
        if (ctx.busy.has(p.id) || p.household === payer.id) continue;
        const f = workFactor(C, p);
        if (f <= 0) continue;
        const paid = C.spend(payer, wage);
        if (paid < wage - 1e-6) break;
        C.credit(C.household(p.household), p, wage);
        rec.crew.push(p.id);
        ctx.busy.add(p.id);
        ctx.taken.set(rec.settlement, (ctx.taken.get(rec.settlement) ?? 0) + 1);
        units += f;
        hired += f;
        n--;
      }
    }
  }
  rec.from = [r3(household), r3(week), r3(hired)];
  rec.perDay = r3(Math.min(units, cap));

  // how it stands
  const before = rec.status;
  if (holy) {
    rec.status = 'waiting';
    rec.note = 'The holy day: the workers rest. Work goes on tomorrow';
  } else if (rec.perDay > 0.01) {
    rec.status = 'working';
    rec.note = sup.text && cap < rec.labour - rec.done - 0.01 ? sup.text : '';
    rec.idle = 0;
  } else if (cap <= 0.001) {
    rec.idle += sup.stuck && !sup.coming ? 1 : 0;
    rec.status = rec.idle >= 2 ? 'stalled' : 'waiting';
    rec.note = sup.text || 'Waiting';
  } else {
    rec.idle++;
    rec.status = rec.idle >= 2 ? 'stalled' : 'waiting';
    rec.note = 'No hands: set the household to Build, hire labourers or work on it yourself';
  }
  if (rec.status === 'stalled' && before !== 'stalled') {
    emitSite(C, 'stalled', rec);
    tellPlayer(C, rec, 'warn', `Work on the ${BUILDINGS[rec.kind].name.toLowerCase()} has stopped. ${rec.note}.`);
  }
  for (const p of rec.crew) C.crewOf.set(p, rec.id);
  C.touch();
  C.bump();
}

/** Starts the morning plan: the open sites grouped by paying household, in the order of their priority. */
export function beginPlan(C: Construction): void {
  C.plan = null;
  const open = C.openSites();
  if (open.length === 0) return;
  // the old crews are off
  C.crewOf.clear();
  const ctx = newPlanCtx();
  // sites already planned today keep their people out of the pool
  for (const s of open) if (s.planned === C.day) for (const p of s.crew) { ctx.busy.add(p); C.crewOf.set(p, s.id); }
  open.sort((a, b) => a.household - b.household || a.priority - b.priority || a.id - b.id);
  const groups: SiteRec[][] = [];
  for (const s of open) {
    if (s.planned === C.day) continue;
    const g = groups[groups.length - 1];
    if (g && g[0].household === s.household) g.push(s); else groups.push([s]);
  }
  C.plan = { ctx, groups };
}

/** Plans the groups of one shard (group number modulo the shards). */
export function planShard(C: Construction, shard: number): void {
  const run = C.plan;
  if (!run) return;
  for (let gi = shard; gi < run.groups.length; gi += PLAN_SHARDS) {
    for (const s of run.groups[gi]) if (s.closed === 0) planSite(C, run.ctx, s);
  }
}

/** Ends the morning plan: a finished or cancelled site is forgotten after a few days. */
export function endPlan(C: Construction): void {
  C.plan = null;
  const keep = C.save.sites.filter((s) => s.closed === 0 || s.closed + 3 > C.day + 1);
  if (keep.length !== C.save.sites.length) { C.save.sites = keep; C.reindex(); C.touch(); }
}

/** The whole morning plan at once (tests and tools; the game runs it in shards). */
export function planAll(C: Construction): void {
  beginPlan(C);
  for (let k = 0; k < PLAN_SHARDS; k++) planShard(C, k);
  endPlan(C);
}

/** A site just staked out: its materials are ordered at once and, in working hours, its crew is set. */
export function planNow(C: Construction, rec: SiteRec): void {
  const hour = (C.absDay - C.day) * 24;
  if (rec.planned === C.day) return;
  if (hour >= WORK_START && hour < WORK_END - 1) {
    const ctx = newPlanCtx();
    for (const s of C.openSites()) if (s.planned === C.day && s !== rec) for (const p of s.crew) ctx.busy.add(p);
    planSite(C, ctx, rec);
    return;
  }
  const payer = C.household(rec.household);
  if (!payer) return;
  const sup = supply(C, rec, payer);
  rec.note = sup.text || 'Staked out: work starts in the morning';
  C.touch();
}

// ---------------------------------------------------------------------------------------------
// Working hours
// ---------------------------------------------------------------------------------------------

/** Makes the building show how far the work has got (in steps, so it is not touched every hour). */
function show(C: Construction, rec: SiteRec): void {
  const b = C.state.buildings.get(rec.building);
  if (!b) return;
  const p = progressOf(rec);
  const q = p >= 1 ? 1 : Math.floor(p * 40) / 40;
  if (q === rec.shown) return;
  rec.shown = q;
  switch (rec.work) {
    case 'build': b.construction = Math.min(0.975, q); break;
    case 'repair': b.damage = r2(rec.damage0 * (1 - q)); break;
    case 'demolish': b.damage = r2(Math.max(rec.damage0, Math.min(0.9, q))); break;
    default: break;
  }
  if (rec.work !== 'upgrade') C.state.touchBuilding(b);
  C.bump();
}

/**
 * Adds worker-days to a site (an hour of the crew's day, or a bout of the player's). Cash fees are paid as the work goes; if the
 * payer cannot pay them the work waits. Returns the worker-days put in.
 */
export function putIn(C: Construction, rec: SiteRec, days: number): number {
  if (rec.closed !== 0) return 0;
  let add = Math.min(days, capacity(rec));
  if (add <= 1e-6) return 0;
  const payer = C.household(rec.household);
  if (rec.pence > 0) {
    const fee = rec.pence * (add / rec.labour);
    if (!payer) return 0;
    const paid = C.spend(payer, fee);
    if (paid < fee - 1e-6) {
      add = r6(add * (paid / fee)); // what was paid buys that much of the work
      if (add <= 1e-6) {
        rec.note = 'Waiting for the money to pay the masons';
        rec.status = 'waiting';
        return 0;
      }
    }
    rec.paid = r2(rec.paid + (paid >= fee - 1e-6 ? fee : paid));
  }
  rec.done = r6(Math.min(rec.labour, rec.done + add));
  // a sliver of a worker-day left over is not worth another day's hire
  if (rec.labour - rec.done < 0.02 && capacity(rec) >= rec.labour - rec.done - 1e-6) rec.done = rec.labour;
  rec.idle = 0;
  if (!rec.started) {
    rec.started = true;
    emitSite(C, 'started', rec);
    tellPlayer(C, rec, 'info', `Work has begun on the ${BUILDINGS[rec.kind].name.toLowerCase()}.`);
  }
  const p = progressOf(rec);
  while (rec.told < 3 && p >= (rec.told + 1) * 0.25 && p < 1) { rec.told++; emitSite(C, 'progress', rec); }
  show(C, rec);
  C.touch();
  if (rec.done >= rec.labour - 1e-6 && Object.entries(rec.need).every(([g, q]) => (rec.have[g] ?? 0) >= q - 0.005)) finish(C, rec);
  return add;
}

/**
 * Goods ordered for a site that has no crew today come in during the working day: the site is looked at again at once, so the
 * hands that were not hired this morning (nothing to build with) are hired now.
 */
function refreshArrivals(C: Construction): void {
  let ctx: PlanCtx | null = null;
  for (const s of C.save.sites) {
    if (s.closed !== 0 || s.planned !== C.day || s.perDay > 0 || s.crew.length > 0) continue;
    let due = false;
    for (const tr of Object.values(s.transit)) if (tr[1] <= C.absDay + 1e-9) { due = true; break; }
    if (!due) continue;
    if (!ctx) {
      ctx = newPlanCtx();
      for (const o of C.save.sites) if (o.closed === 0 && o.planned === C.day) for (const p of o.crew) ctx.busy.add(p);
    }
    planSite(C, ctx, s);
  }
}

/** One working hour of every site with a crew. */
export function accrueAll(C: Construction): void {
  refreshArrivals(C);
  for (const s of C.save.sites) {
    if (s.closed !== 0 || s.planned !== C.day || s.perDay <= 0) continue;
    putIn(C, s, s.perDay / WORK_HOURS);
  }
}

export function hourly(C: Construction, info: HourInfo, shard = 0): void {
  if (info.hour === WORK_START - 1) {
    if (shard === 0) beginPlan(C);
    planShard(C, shard);
    if (shard === PLAN_SHARDS - 1) endPlan(C);
    return;
  }
  if (shard === 0 && C.save.sites.length > 0 && info.hour >= WORK_START && info.hour < WORK_END) accrueAll(C);
}

// ---------------------------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------------------------

/** Moves a household into a building as its home (leaving the old home vacant). */
export function moveIn(C: Construction, hh: Household, b: BuildingState): void {
  if (hh.settlement !== b.settlement) C.state.relocateHousehold(hh, b.settlement, b.id);
  else C.state.setHome(hh, b.id);
}

function finish(C: Construction, rec: SiteRec): void {
  const b = C.state.buildings.get(rec.building);
  const payer = C.household(rec.household);
  const def = BUILDINGS[rec.kind];
  const name = def.name.toLowerCase();
  if (!b) { closeSite(C, rec, 'cancelled'); return; }
  switch (rec.work) {
    case 'build': {
      b.construction = 1;
      b.owner = rec.house;
      const cat = rulesOf(rec.kind).cat;
      if (cat === 'home') { b.household = 0; b.occupied = false; }
      if (rec.occupant === 'builder' && payer) {
        if (cat === 'home') moveIn(C, payer, b);
        else {
          b.household = payer.id;
          if (cat === 'craft' || cat === 'food') b.occupied = true;
        }
      }
      C.state.touchBuilding(b);
      break;
    }
    case 'upgrade':
      b.level = rec.level;
      C.state.touchBuilding(b);
      break;
    case 'repair':
      b.damage = 0;
      C.state.touchBuilding(b);
      break;
    case 'demolish': {
      if (payer) for (const [g, q] of Object.entries(salvageOf(rec.kind, b.level))) C.addStock(payer, g, q);
      removeBuilding(C, b);
      C.save.stats.demolished++;
      break;
    }
  }
  C.save.stats.finished++;
  closeSite(C, rec, 'done');
  emitSite(C, 'done', rec);
  const where = C.settlementName(rec.settlement);
  const text = rec.work === 'build' ? `The ${name} at ${where} is finished.`
    : rec.work === 'upgrade' ? `The ${name} at ${where} is improved.`
    : rec.work === 'repair' ? `The ${name} at ${where} is mended.`
    : `The ${name} at ${where} is pulled down.`;
  tellPlayer(C, rec, 'gain', text);
  const big = levelCost(rec.kind, rec.level).labour >= 60 || def.cat === 'defence' || def.cat === 'church';
  if (big || isPlayersHouse(C, rec)) C.state.log(C.absDay, 'construction', text, rec.builder ? [rec.builder] : []);
}

function isPlayersHouse(C: Construction, rec: SiteRec): boolean {
  return rec.house !== 0 && rec.house === C.state.run.houseId;
}

/** What a day's wage is for the site (for the player hired on someone else's work). */
export function wageOfSite(rec: SiteRec): number { return wageFor(rec.kind); }
