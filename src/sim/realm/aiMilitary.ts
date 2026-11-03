// The arms of an AI ruler (docs/CIV.md §10): he takes men on and drills them when his neighbours frighten him (or his own ambition
// is large), through the same `recruitOptions` / `recruit` the player's panel uses, pays the same fees and wages from the same
// treasury, and knights a deserving man with `dub`. How many he keeps follows the people he rules, his fear and his purse; what
// kind follows what his House commands (crossbowmen once it has the technique) and what he can afford (mounted men are dear).
import { hash01 } from '../../core/math';
import { skillLevel } from '../people';
import { ageYears, type Person } from '../state';
import type { UnitKind } from '../military/types';
import { AI, TROOPS_AI } from './aiConfig';
import { refreshFunds, type Sense } from './aiSense';
import type { Ai } from './ai';
import { discharge, dub, recruit, recruitOptions } from './recruit';

/** How many men of his own the ruler would like to keep. */
export function troopTarget(S: Sense): number {
  if (S.class === 'abbey' || S.role === 'reeve') return 0;
  let pop = 0;
  for (const p of S.places) pop += p.pop;
  const per = TROOPS_AI.perHeadPeace + TROOPS_AI.perHeadThreat * S.fear * S.fear;
  const want = Math.round(pop * per * S.pace * (0.8 + 0.4 * S.mind.ambitious));
  return Math.max(0, Math.min(TROOPS_AI.cap[S.class], want));
}

/** Which kind to take on next: the one furthest below its share of the standing troop. */
function nextKind(A: Ai, S: Sense, target: number): UnitKind[] {
  const R = A.R;
  const have: Record<string, number> = {};
  for (const t of S.troops) have[t.k] = (have[t.k] ?? 0) + 1;
  const crossbows = R.advancement?.houseHas(S.house, 'crossbows') ?? false;
  const out: Array<{ kind: UnitKind; gap: number }> = [];
  for (const [k, share] of Object.entries(TROOPS_AI.mix)) {
    if (k === 'crossbow' && !crossbows) continue;
    if (k === 'sergeant' && S.allowance < 400) continue;
    const want = target * (k === 'archer' && crossbows ? share - 0.06 : share);
    out.push({ kind: k as UnitKind, gap: want - (have[k] ?? 0) });
  }
  out.sort((a, b) => b.gap - a.gap || (a.kind < b.kind ? -1 : 1));
  return out.filter((o) => o.gap > 0.3).map((o) => o.kind);
}

export function armsRound(A: Ai, S: Sense): void {
  const R = A.R;
  if (!S.payer || S.places.length === 0) return;
  refreshFunds(R, S);
  // thrift: a purse that nears comfort (under 1.6 times it) keeps a plain table - the economy spends less on luxuries there - until it is well above
  {
    const key = String(S.payer.id);
    const on = R.data.thrift[key] === 1;
    if (!on && S.funds < S.comfort * AI.thriftOn) { R.data.thrift[key] = 1; R.touch(); }
    else if (on && S.funds >= S.comfort * AI.thriftOff) { delete R.data.thrift[key]; R.touch(); }
  }
  const target = troopTarget(S);
  const cur = S.troops.length;
  const day = R.day;
  // the arrears of the treasury: no new men while the old are unpaid
  const behind = (R.data.behind[String(S.payer.id)] ?? 0) > 0;

  // a purse below comfort trims: the dearest men (not the knights, who are paid by their lands) go back to the plough, a couple a round,
  // down to a standing troop that matches the purse (so the wages stop draining it); recruiting waits until the purse is comfortable again
  if (S.funds < S.comfort && cur > 0 && day - A.lastAt(S.house, 'trim') >= TROOPS_AI.trimGapDays) {
    const ratio = S.funds / S.comfort;
    // (a purse under half of comfort keeps no standing men of its own at all; above it, a troop of at least two)
    const keep = ratio < 0.5 ? 0 : Math.max(2, Math.floor(Math.max(target, cur * 0.5) * Math.max(0.35, ratio)));
    const dear = S.troops.filter((t) => t.k !== 'knight').sort((a, b) => b.wage - a.wage || a.p - b.p);
    let n = Math.min(TROOPS_AI.trimPerRound, cur - keep, dear.length);
    for (const t of dear) {
      if (n <= 0) break;
      if (discharge(R, S.ruler, t.p).ok) { n--; A.mark(S.house, 'trim'); }
    }
    S.troops = S.troops.filter((t) => !!R.alive(t.p) && R.data.troops.includes(t));
  }

  if (cur < target && !behind && day >= 2 + 10 * hash01(S.house, 13) && day - A.lastAt(S.house, 'rec') >= TROOPS_AI.gapDays / Math.max(0.5, S.pace)) {
    // the wages of a year must be in hand besides the fee: the thin purse raises no one
    const spare = S.funds - S.comfort;
    if (spare > 200) {
      // the biggest places first (the seat, the towns), the rest in turn
      const order = S.places.slice().sort((a, b) => b.pop - a.pop || a.id - b.id);
      let done = false;
      for (const p of order.slice(0, 3)) {
        if (done) break;
        for (const kind of nextKind(A, S, target)) {
          if (A.blocked(S.house, `r:${p.id}:${kind}`)) continue;
          const opts = recruitOptions(R, S.ruler, p.id);
          const o = opts.find((x) => x.kind === kind);
          if (!o || !o.ok || o.affordable === undefined || o.affordable < 1) { A.block(S.house, `r:${p.id}:${kind}`, AI.retryDays); continue; }
          const n = Math.min(target - cur, TROOPS_AI.batch, o.affordable, o.available);
          if (n < 1) continue;
          const res = recruit(R, S.ruler, p.id, kind, n);
          if (res.ok && res.raised) {
            A.year().recruits += res.raised;
            A.mark(S.house, 'rec');
            done = true;
            break;
          }
          A.block(S.house, `r:${p.id}:${kind}`, AI.retryDays);
        }
      }
      if (!done) A.mark(S.house, 'rec');
    }
  }

  // the accolade: a deserving man of his own is knighted from time to time by a ruler who can afford it
  if (S.troops.length >= 4 && S.funds - S.comfort > 900 && day - A.lastAt(S.house, 'dub') >= TROOPS_AI.dubGapDays / Math.max(0.5, S.pace)) {
    const man = worthiest(A, S);
    if (man) {
      const res = dub(R, S.ruler, man.id);
      if (res.ok) A.year().knights++;
      A.mark(S.house, 'dub');
      if (!res.ok) A.block(S.house, `d:${man.id}`, AI.retryDays * 2);
    } else A.mark(S.house, 'dub');
  }
}

/** The man of the ruler's retinue most fit to be knighted: skilled at arms, grown, whole, not yet a knight. */
function worthiest(A: Ai, S: Sense): Person | null {
  const R = A.R;
  let best: Person | null = null, bs = -Infinity;
  for (const t of S.troops) {
    if (t.k === 'knight') continue;
    const p = R.alive(t.p);
    if (!p || p.career === 'knight' || p.estate === 'clergy' || A.blocked(S.house, `d:${p.id}`)) continue;
    const age = ageYears(p, R.day);
    if (age < 20 || age > 50 || p.health.hp < 0.8) continue;
    const melee = skillLevel(p.skills.melee ?? 0), riding = skillLevel(p.skills.riding ?? 0);
    if (melee < 5) continue;
    const score = melee * 2 + riding + p.trained.str * 0.3 + (t.k === 'sergeant' ? 3 : 0) - p.id * 1e-6;
    if (score > bs) { bs = score; best = p; }
  }
  return best;
}
