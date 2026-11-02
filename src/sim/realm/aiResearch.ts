// The learning of an AI ruler (docs/CIV.md §6.4, §10): which technique his House should have worked out next, and when he can pay
// for it. He asks for the same things the player's research page shows - the technique's price in its branch's currencies, a
// place of the right kind in his lands, a researcher who could work it out - and pays the same (buying the goods he lacks at the
// market, as `startResearch(..., { buy: true })` does). What he wants follows his fear (the military branch and the walls),
// his lands (a mill where there is a river, charters where there is a market) and his temper (the pious favour letters).
import type { BuildingKind } from '../../content/types';
import type { TechDef } from '../advancement/types';
import { AI, RESEARCH_AT_ONCE, RESEARCH_GAP } from './aiConfig';
import { held, refreshFunds, type Sense } from './aiSense';
import type { Ai } from './ai';
import { SCARCE } from './aiSupply';
import { startResearch } from './research';
import { hash01 } from '../../core/math';

/** What the ruler's realm is, for the sake of what suits it. */
interface Facts {
  river: boolean;
  grain: boolean;
  wool: boolean;
  markets: number;
  pop: number;
  castle: boolean;
  abbey: boolean;
}

function factsOf(S: Sense): Facts {
  const f: Facts = { river: false, grain: false, wool: false, markets: 0, pop: 0, castle: false, abbey: false };
  for (const p of S.places) {
    if (p.res?.river) f.river = true;
    if (p.res?.yields.includes('grain')) f.grain = true;
    if (p.res?.yields.includes('wool')) f.wool = true;
    if (p.market) f.markets++;
    f.pop += p.pop;
    if (p.kind === 'castle') f.castle = true;
    if (p.kind === 'abbey' || p.kind === 'priory' || p.kind === 'nunnery') f.abbey = true;
  }
  return f;
}

const standing = new WeakMap<Sense, Set<string>>();

/** The kinds of building that stand finished in the realm (a technique is worked in a place of one of its kinds). */
function standingKinds(A: Ai, S: Sense): Set<string> {
  let k = standing.get(S);
  if (!k) {
    k = new Set();
    for (const sid of S.unit.settlements) for (const b of A.R.state.buildingsAt.get(sid) ?? []) if (b.construction >= 1 && b.damage < 0.9) k.add(b.kind);
    standing.set(S, k);
  }
  return k;
}

/** How much the ruler wants a technique (about 0..1.4), before its price is weighed. */
export function techValue(S: Sense, def: TechDef, f: Facts, has: (id: string) => boolean): number {
  const m = S.mind;
  const fear = S.fear;
  let v: number;
  switch (def.branch) {
    case 'economy': v = 0.5 + (S.places.some((p) => p.prosperity < 1) ? 0.12 : 0) + 0.15 * m.greedy; break;
    case 'military': v = 0.2 + 0.85 * fear + 0.3 * m.ambitious; break;
    case 'kinship': v = 0.22 + 0.3 * m.cautious + 0.2 * m.honourable; break;
    default: v = 0.22 + 0.4 * m.pious + (f.abbey ? 0.15 : 0); break;
  }
  switch (def.id) {
    case 'heavy_plough': case 'improved_rotation': v += 0.2; break;
    case 'watermill': v += f.river && f.grain ? 0.4 : -0.35; break;
    case 'windmill': v += f.grain ? 0.15 : -0.35; break;
    case 'fulling_mill': v += f.river && f.wool ? 0.25 : -0.4; break;
    case 'market_charter': case 'wool_trade': v += f.markets > 0 ? 0.22 : -0.35; break;
    case 'fair_charter': case 'letters_of_credit': v += f.markets > 0 && f.pop > 200 ? 0.1 : -0.4; break;
    case 'guild_charter': v += f.pop > 220 ? 0.1 : -0.4; break;
    case 'stone_keep': v += 0.15 + 0.5 * fear; break;
    case 'curtain_walls': v += 0.9 * fear + 0.1; break;
    case 'concentric_castle': v += 0.25 * fear - 0.1; break;
    case 'longbow_drill': v += 0.15 + 0.35 * fear; break;
    case 'crossbows': v += 0.3 * fear; break;
    case 'coat_of_plates': case 'plate_armour': v += 0.25 * fear; break;
    case 'destriers': v += 0.15 * fear + 0.15 * m.ambitious; break;
    case 'paid_retinues': v += 0.35 * fear; break;
    case 'trebuchet': case 'bombards': v += 0.55 * m.ambitious * (1 - m.cautious) - 0.15; break;
    case 'parish_school': case 'written_charters': v += 0.15; break;
    case 'scriptorium': v += f.abbey ? 0.25 : -0.1; break;
    case 'cathedral_school': case 'university': case 'printing': v -= 0.2; break;
    case 'herbal_medicine': case 'infirmary_care': v += S.places.some((p) => p.prosperity < 0.98) ? 0.2 : 0.05; break;
    case 'accounting': v += 0.1; break;
    case 'marriage_pacts': case 'oaths': case 'truces': v += 0.1 * m.cautious; break;
    case 'wardship': case 'heralds': case 'tournaments': v -= 0.1; break;
    case 'alliance_treaties': v += 0.2 * fear; break;
    case 'council_of_the_realm': v -= 0.1; break;
    default: break;
  }
  void has;
  return Math.max(0, v);
}

export interface ResearchPick {
  def: TechDef;
  score: number;
  /** Pence the coin and the goods come to at the usual prices. */
  value: number;
  /** A kind of building the realm lacks to work it in (the works planner raises one). */
  place?: BuildingKind;
}

/** The techniques the House may take up, best first (rating over price). */
export function researchPicks(A: Ai, S: Sense): ResearchPick[] {
  const R = A.R, rt = R.tech;
  if (!rt) return [];
  const f = factsOf(S);
  const day = R.day;
  const seat = S.seat;
  const techs = new Map<string, boolean>();
  const has = (id: string): boolean => {
    let v = techs.get(id);
    if (v === undefined) { v = R.advancement ? R.advancement.houseHas(S.house, id) : false; techs.set(id, v); }
    return v;
  };
  const running = new Set<string>();
  for (const pr of R.data.projects) if (pr.house === S.house && (pr.state === 'active' || pr.state === 'stalled')) running.add(pr.tech);
  const out: ResearchPick[] = [];
  for (const def of rt.techs()) {
    const res = def.research;
    if (!res || has(def.id) || running.has(def.id)) continue;
    if (def.requires.some((r) => !has(r))) continue;
    if (def.year !== undefined && day / 16 < def.year) continue;
    let goods = 0, short = false;
    for (const [g, q] of Object.entries(res.goods)) {
      const gd = R.economy.good(g);
      goods += q * (gd?.basePrice ?? 1);
      if (!R.economy.stockAt) continue;
      const missing = q - held(S, g);
      if (missing <= 0) continue;
      if (!gd?.macro) {
        // goods the markets keep only a shelf of (arrows, cloth, horses) are bought a shelf at a time: the price of a hundred where
        // there are a score runs away
        const shelf = gd?.category === 'livestock' ? 4 : gd?.quality ? 10 : 25;
        if (missing > shelf) short = true;
      } else if (SCARCE.has(g)) {
        // the dear materials must be in the markets: a technique that wants 400 stone waits for a quarry
        if (A.stockAt(seat, g) * 0.9 < missing * AI.supplyMargin) short = true;
      } else if (A.stockAt(seat, g) * 0.9 < missing) short = true;
    }
    if (short) continue;
    const value = res.pence + goods;
    const want = techValue(S, def, f, has);
    if (want <= 0.05) continue;
    const scale = Math.max(1500, S.allowance);
    const score = want / (1 + value / (0.18 * scale));
    const haveKinds = standingKinds(A, S);
    const placed = res.place.some((k) => haveKinds.has(k));
    const pick: ResearchPick = { def, score: placed ? score : score * 0.9, value };
    if (!placed) pick.place = res.place[0] as BuildingKind;
    out.push(pick);
  }
  out.sort((a, b) => b.score - a.score || (a.def.id < b.def.id ? -1 : 1));
  return out;
}

/** The kind of workplace the best technique lacks in the realm, for the works planner to raise. */
export function researchPlaceWanted(A: Ai, S: Sense): { kind: BuildingKind; tech: string } | null {
  for (const p of researchPicks(A, S).slice(0, 4)) {
    if (p.place && p.score > 0.2 && p.value < S.allowance * 0.4) return { kind: p.place, tech: p.def.id };
  }
  return null;
}

/** Number of works a ruler of this realm keeps going at once. */
export function researchLimit(S: Sense): number {
  return Math.max(1, Math.round(RESEARCH_AT_ONCE[S.class] * Math.min(1.2, S.pace)));
}

export function researchRound(A: Ai, S: Sense): void {
  const R = A.R;
  if (!R.tech || S.role === 'reeve' || !S.payer) return;
  refreshFunds(R, S);
  let running = 0;
  for (const pr of R.data.projects) if (pr.house === S.house && (pr.state === 'active' || pr.state === 'stalled')) running++;
  if (running >= researchLimit(S)) return;
  // a House's first work is begun some days into the run (the Houses do not all begin on the first morning), and the next after a gap
  // that is longer for the lesser realms: a manor's scholars are few
  if (R.day < 2 + 12 * hash01(S.house, 11)) return;
  const gap = RESEARCH_GAP[S.class] / Math.max(0.5, S.pace);
  if (R.day - A.lastAt(S.house, 'res') < gap) return;
  if (S.allowance < 300) return;
  let tried = 0;
  for (const pick of researchPicks(A, S)) {
    if (tried >= 3) break;
    if (pick.score < 0.12) break;
    if (A.blocked(S.house, `r:${pick.def.id}`)) continue;
    if (pick.place) continue;
    if (pick.value > S.allowance * 0.55 || pick.def.research!.pence > S.funds - S.comfort * 0.5) continue;
    tried++;
    const res = startResearch(R, S.ruler, pick.def.id, 0, -1, { buy: true });
    if (res.ok) {
      A.mark(S.house, 'res');
      A.year().research++;
      if (res.project !== undefined) { A.data.r.push(res.project); if (A.data.r.length > 60) A.data.r.shift(); }
      A.touch();
      refreshFunds(R, S);
      return;
    }
    // no researcher in the realm, no goods to be had, a work already going: try again another season
    A.block(S.house, `r:${pick.def.id}`, AI.retryDays * (res.reason?.startsWith('Nobody') ? 3 : 1));
  }
  A.mark(S.house, 'res');
}
