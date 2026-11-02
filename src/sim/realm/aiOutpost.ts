// Outposts (docs/CIV.md §5, §7, §10): a baron or greater whose lands lack stone, iron, clay, salt or the precious metals may found a
// named camp where they lie in the wild - a quarry, a mine, a clay pit, salt pans - exactly as the player may, and claims the 600 m
// of wild land round it. A ruler founds one only when he lacks what it digs, can pay for it, and the markets can supply the first
// days of the work; a House founds one every few years at most, and holds a handful in all.
import type { BuildingKind } from '../../content/types';
import { dist } from '../../core/math';
import { DAYS_PER_YEAR } from '../../core/time';
import type { Deposit, ResourceKind } from '../../world/types';
import { AI, OUTPOST, OUTPOSTS } from './aiConfig';
import { refreshFunds, type Sense } from './aiSense';
import { findSpot } from './aiSpot';
import { liveValue, supplied } from './aiSupply';
import type { Ai } from './ai';

const KIND_FOR: Readonly<Record<ResourceKind, BuildingKind>> = {
  iron: 'mine', silver: 'mine', gold: 'mine', stone: 'quarry', clay: 'clay_pit', salt: 'salt_pan',
};

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

export function outpostRound(A: Ai, S: Sense): void {
  const R = A.R, C = R.construction, T = R.territory;
  if (!C || !T || S.places.length === 0) return;
  const round = Math.floor(R.day / 4);
  if ((round + S.unit.key) % 4 !== 1) return;
  const cap = OUTPOSTS[S.class];
  if (cap <= 0) return;
  const mine = C.outposts().filter((o) => o.house === S.house);
  if (mine.length >= cap) return;
  if (R.day - A.lastAt(S.house, 'out') < OUTPOST.gapYears * DAYS_PER_YEAR) return;
  refreshFunds(R, S);
  if (S.allowance < OUTPOST.minFunds) return;
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
    if (cands.length === 0) { A.block(S.house, `o:${kind}`, AI.retryDays * 4); continue; }
    if (liveValue(A, seat, bk) > S.allowance * 0.4) continue;
    if (supplied(A, S, seat, bk)) { A.block(S.house, `o:${kind}`, 8); continue; }
    for (const d of cands.slice(0, 3)) {
      const spot = findSpot(R, S, seat, bk, { near: { x: d.x, z: d.z }, settlement: -1 });
      if (!spot) continue;
      const res = C.place(S.ruler, bk, spot.x, spot.z, spot.rot);
      if (!res.ok || res.site === undefined) { A.block(S.house, `o:${kind}`, AI.retryDays); continue; }
      A.sitePlaced(S.house, res.site, bk, seat.id);
      A.year().outposts++;
      A.rec(S.house).outs++;
      A.mark(S.house, 'out');
      refreshFunds(R, S);
      // the realm's news tells of it the next day (`outpostsDaily`)
      return;
    }
    A.block(S.house, `o:${kind}`, AI.retryDays * 2);
  }
}
