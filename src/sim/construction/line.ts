// Walls laid in a line (CIV §5, docs/CONSTRUCTION.md §3b): a run of wall or palisade from one point to another, with a tower at each
// end and every so often, and a gate in the middle if asked. The run is laid out as pieces set end to end along the ground, priced
// and checked as one plan, and staked as sites that share a line id (all or none). Cancelling the line calls them all off.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { P2 } from '../../core/math';
import { formatMoney } from '../money';
import type { PersonId } from '../state';
import { countKind, evaluate } from './check';
import type { Construction } from './core';
import { levelCost, maxPerSettlement, rulesOf } from './data';
import { cancelSite, canManageSite, placeSite, viewOf } from './sites';
import type { BuildCost, LineOptions, LinePart, LinePlan, Result, SiteView } from './types';

/** The longest run one order lays, m. */
export const LINE_MAX = 400;
/** About how far apart the towers stand along a run, m. */
export const TOWER_EVERY = 36;
/** A hair of room between pieces so rounding never overlaps them. */
const EPS = 0.02;

const r2 = (v: number): number => Math.round(v * 100) / 100;

interface Slot { kind: BuildingKind; len: number }

/** The pieces of a run, in order from the start, that fit whole in `length` metres. */
export function lineSlots(kind: BuildingKind, length: number, opts: LineOptions, room: { tower: number; gate: number }): Slot[] {
  const seg = BUILDINGS[kind].w + EPS;
  const tw = BUILDINGS.tower.w + EPS;
  const gw = BUILDINGS.gatehouse.w + EPS;
  const towers = !!opts.towers && room.tower > 0;
  const gate = !!opts.gate && kind === 'wall' && room.gate > 0 && length >= gw + 2 * seg;
  const out: Slot[] = [];
  let pos = 0, towersLeft = room.tower, sinceTower = 0, gated = false;
  const endTower = towers && towersLeft >= 2;
  if (towers) { out.push({ kind: 'tower', len: tw }); pos += tw; towersLeft--; }
  const reserve = endTower ? tw : 0;
  for (;;) {
    if (gate && !gated && pos + gw / 2 >= length / 2) {
      if (pos + gw + reserve > length) break;
      out.push({ kind: 'gatehouse', len: gw }); pos += gw; gated = true; sinceTower = 0;
      continue;
    }
    if (towers && towersLeft > (endTower ? 1 : 0) && sinceTower * seg >= TOWER_EVERY && pos + tw + seg + reserve <= length) {
      out.push({ kind: 'tower', len: tw }); pos += tw; towersLeft--; sinceTower = 0;
      continue;
    }
    if (pos + seg + reserve > length) break;
    out.push({ kind, len: seg }); pos += seg; sinceTower++;
  }
  if (endTower) out.push({ kind: 'tower', len: tw });
  return out;
}

/** Room left for towers and gatehouses at the place the run starts in. */
function roomAt(C: Construction, settlement: number): { tower: number; gate: number } {
  if (settlement < 0) return { tower: 0, gate: 0 };
  const sk = C.settlementKind(settlement);
  const left = (k: BuildingKind): number => {
    const n = Math.max(0, maxPerSettlement(k, sk) - countKind(C, settlement, k));
    return Number.isFinite(n) ? n : 99;
  };
  return { tower: left('tower'), gate: left('gatehouse') };
}

export function planLine(C: Construction, person: PersonId, kind: BuildingKind, from: P2, to: P2, opts: LineOptions = {}): LinePlan {
  const none = (reason: string): LinePlan => ({ ok: false, reason, parts: [], bad: 0, end: from, length: 0, cost: { goods: {}, labour: 0, pence: 0 }, byKind: {} });
  const def = BUILDINGS[kind];
  if (!def?.segment || !rulesOf(kind)) return none('Only walls and palisades are laid in a line');
  const len = Math.hypot(to.x - from.x, to.z - from.z);
  if (!Number.isFinite(len) || len < def.w) return none(`Too short: a length is ${def.w} m`);
  if (len > LINE_MAX) return none(`Too long for one order (${LINE_MAX} m at most)`);
  const ux = (to.x - from.x) / len, uz = (to.z - from.z) / len;
  // local x runs along the line: the rotation that turns (1, 0) onto (ux, uz) as the renderer reads `rot`
  const rot = Math.round(Math.atan2(-uz, ux) * 1000) / 1000;
  // how many towers and gatehouses the place can still keep, from where the run starts
  const first = evaluate(C, person, kind, from.x + ux * def.w / 2, from.z + uz * def.w / 2, rot);
  const slots = lineSlots(kind, len, opts, roomAt(C, first.check.settlement));
  if (!slots.length) return none('Too short for the pieces asked');
  const parts: LinePart[] = [];
  const goods: Record<string, number> = {};
  let labour = 0, pence = 0;
  const byKind: Record<string, number> = {};
  let pos = 0, bad = 0, reason: string | undefined;
  for (const s of slots) {
    const t = pos + s.len / 2;
    const x = r2(from.x + ux * t), z = r2(from.z + uz * t);
    const ev = evaluate(C, person, s.kind, x, z, rot);
    const part: LinePart = { kind: s.kind, x, z, rot, ok: ev.check.ok, footprint: ev.check.footprint };
    if (!ev.check.ok) { part.reason = ev.check.reason; bad++; reason ??= ev.check.reason; }
    parts.push(part);
    const c = levelCost(s.kind, 1);
    for (const [g, q] of Object.entries(c.goods)) goods[g] = (goods[g] ?? 0) + q;
    labour += c.labour;
    pence += c.pence;
    byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
    pos += s.len;
  }
  const end = { x: r2(from.x + ux * pos), z: r2(from.z + uz * pos) };
  const cost: BuildCost = { goods, labour, pence };
  const plan: LinePlan = { ok: bad === 0, parts, bad, end, length: r2(pos), cost, byKind };
  if (bad) plan.reason = bad === 1 ? reason : `${bad} of ${parts.length} pieces cannot be laid: ${reason}`;
  return plan;
}

/** Stakes the run out, all or none: a piece that fails after the plan passed (the purse, a count) calls the rest off again. */
export function placeLine(C: Construction, person: PersonId, kind: BuildingKind, from: P2, to: P2, opts: LineOptions = {}): Result & { line?: number; sites?: number[]; plan?: LinePlan } {
  const plan = planLine(C, person, kind, from, to, opts);
  if (!plan.ok) return { ok: false, reason: plan.reason ?? 'It cannot be laid there', plan };
  const line = C.save.nextLine ?? 1;
  const sites: number[] = [];
  for (const part of plan.parts) {
    const r = placeSite(C, person, part.kind, part.x, part.z, part.rot, { line });
    if (!r.ok || !r.site) {
      // nothing has come in yet, so calling the lengths off costs nothing
      for (const id of sites) { const rec = C.sitesById.get(id); if (rec) cancelSite(C, rec.builder, id); }
      return { ok: false, reason: r.reason ?? 'It cannot be laid there', plan };
    }
    sites.push(r.site);
  }
  C.save.nextLine = line + 1;
  const bits = Object.entries(plan.byKind).map(([k, n]) => `${n} ${BUILDINGS[k as BuildingKind].name.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ');
  C.sim.events.emit('notify', { kind: 'info', text: `A run of ${Math.round(plan.length)} m is staked out: ${bits} (${formatMoney(plan.cost.pence)} in fees besides the materials).`, person });
  return { ok: true, line, sites, plan };
}

export function lineSites(C: Construction, line: number): SiteView[] {
  return C.save.sites.filter((s) => s.line === line && s.closed === 0).sort((a, b) => a.id - b.id).map((r) => viewOf(C, r));
}

export function cancelLine(C: Construction, person: PersonId, line: number): Result & { cancelled?: number } {
  const open = C.save.sites.filter((s) => s.line === line && s.closed === 0);
  if (!open.length) return { ok: false, reason: 'No such run under way' };
  if (!open.every((s) => canManageSite(C, person, s))) return { ok: false, reason: 'It is not your work to stop' };
  for (const s of open) cancelSite(C, person, s.id);
  return { ok: true, cancelled: open.length };
}
