// Outposts (docs/CIV.md §5, §7, §10): a baron or greater whose lands lack stone, iron, clay, salt or the precious metals may found a
// named camp where they lie in the wild - a quarry, a mine, a clay pit, salt pans - exactly as the player may, and claims the 600 m
// of wild land round it. A ruler founds one only when he lacks what it digs, can pay for it, and the markets can supply the first
// days of the work; a House founds one every few years at most, and holds a handful in all. The choice (a deposit and a spot) is one
// shard of the round and the founding the next.
import type { BuildingKind } from '../../content/types';
import { dist } from '../../core/math';
import { DAYS_PER_YEAR } from '../../core/time';
import type { PlacementCheck } from '../construction/types';
import type { Deposit, ResourceKind } from '../../world/types';
import { AI, OUTPOST, OUTPOSTS } from './aiConfig';
import { refreshFunds, type Place, type Sense } from './aiSense';
import { findSpot } from './aiSpot';
import { liveValue, supplied } from './aiSupply';
import type { Ai } from './ai';

const KIND_FOR: Readonly<Record<ResourceKind, BuildingKind>> = {
  iron: 'mine', silver: 'mine', gold: 'mine', stone: 'quarry', clay: 'clay_pit', salt: 'salt_pan',
};

/** An outpost the round chose to found: the camp's kind, where, and for want of which deposit. */
export interface OutpostPending { kind: BuildingKind; want: ResourceKind; seat: Place; spot: PlacementCheck }

/** Which deposits the ruler would most like, in order: what his building, his arms and his ambition call for. */
function wishes(S: Sense, held: ReadonlySet<ResourceKind>): ResourceKind[] {
  const out: ResourceKind[] = [];
  const m = S.mind;
  if (!held.has('stone')) out.push('stone');
  if (!held.has('iron')) out.push('iron');
  if (!held.has('clay') && S.fear < 0.6) out.push('clay');
  if (!held.has('salt') && S.places.some((p) => p.res?.coast)) out.push('salt');
  if (!held.has('silver') && m.greedy + m.ambitious > 0.8) out.push('silver');
  if (!held.has('gold') && m.greedy + m.ambitious > 0.8) out.push('gold');
  return out;
}

/** Stage 4: finds a deposit in the wild the ruler lacks, and a spot on it. Null when he wants none or none is to be had. */
export function outpostChoose(A: Ai, S: Sense): OutpostPending | null {
  const R = A.R, C = R.construction, T = R.territory;
  if (!C || !T || S.places.length === 0) return null;
  const round = Math.floor(R.day / 4);
  if ((round + S.unit.key) % 4 !== 1) return null;
  const cap = OUTPOSTS[S.class];
  if (cap <= 0) return null;
  const mine = C.outposts().filter((o) => o.house === S.house);
  if (mine.length >= cap) return null;
  if (R.day - A.lastAt(S.house, 'out') < OUTPOST.gapYears * DAYS_PER_YEAR) return null;
  refreshFunds(R, S);
  if (S.allowance < OUTPOST.minFunds) return null;
  const held = new Set<ResourceKind>();
  for (const p of S.places) for (const d of p.res?.deposits ?? []) held.add(d.kind);
  for (const o of mine) {
    const d = o.deposit >= 0 ? T.deposits()[o.deposit] : undefined;
    if (d) held.add(d.kind);
  }
  const seat = S.places.find((p) => p.id === S.seat) ?? S.places[0];
  const all = C.outposts();
  for (const kind of wishes(S, held)) {
    if (A.blocked(S.house, `o:${kind}`)) continue;
    const bk = KIND_FOR[kind];
    const cands: Deposit[] = T.depositsNear(seat.s.x, seat.s.z, OUTPOST.reach, kind).filter((d) => {
      const land = T.landAt(d.x, d.z);
      if (land.settlement >= 0 || land.kind === 'water') return false;
      return !all.some((o) => dist(o.x, o.z, d.x, d.z) < OUTPOST.apart);
    });
    if (cands.length === 0) { A.note(`${S.ruler} outpost for ${kind}: no wild deposit in reach`); A.fail(S.house, `o:${kind}`, AI.retryDays * 2); continue; }
    if (liveValue(A, seat, bk) > S.allowance * 0.4) { A.note(`${S.ruler} outpost for ${kind}: too dear`); continue; }
    const short = supplied(A, S, seat, bk);
    if (short) { A.note(`${S.ruler} outpost for ${kind}: no ${short}`); A.block(S.house, `o:${kind}`, 8); continue; }
    for (const d of cands.slice(0, 3)) {
      const spot = findSpot(R, S, seat, bk, { near: { x: d.x, z: d.z }, settlement: -1 });
      if (spot) return { kind: bk, want: kind, seat, spot };
    }
    A.note(`${S.ruler} outpost for ${kind}: no spot on the deposit`);
    A.fail(S.house, `o:${kind}`, AI.retryDays);
  }
  return null;
}

/** Stage 5: founds the outpost the round chose. */
export function outpostAct(A: Ai, S: Sense, o: OutpostPending): void {
  const R = A.R, C = R.construction;
  if (!C) return;
  const res = C.place(S.ruler, o.kind, o.spot.x, o.spot.z, o.spot.rot);
  if (!res.ok || res.site === undefined) { A.fail(S.house, `o:${o.want}`, AI.retryDays); return; }
  A.worked(S.house, `o:${o.want}`);
  A.sitePlaced(S.house, res.site, o.kind, o.seat.id);
  A.year().outposts++;
  A.rec(S.house).outs++;
  A.mark(S.house, 'out');
  refreshFunds(R, S);
  // the realm's news tells of it the next day (`outpostsDaily`)
}
