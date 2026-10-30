// Points ledger (SPEC §1, §20). Raw points are multiplied by the birth-class and difficulty
// multipliers; each point earned is converted to Legacy gold immediately (1 gold per 10 points), so
// gold follows the difficulty table without multiplying twice.
import { DIFFICULTY_GOLD, type RankTier } from '../core/domain';
import type { EventBus } from '../core/events';
import { DAYS_PER_YEAR } from '../core/time';
import type { WorldModel } from '../world/types';
import type { SimEvents } from './events';
import { POINTS_PER_GOLD } from './legacy';
import type { BirthClass, GameState, ScoreKind, Title, TitleKind } from './state';

/** SPEC §1: harder births earn more. */
export const BIRTH_CLASS_MULTIPLIER: Record<BirthClass, number> = {
  serf: 1.5, free: 1.3, craftsman: 1.1, merchant: 1.0, gentry: 0.9, knightly: 0.8, baronial: 0.6,
};

/** SPEC §20: first time the player's line reaches each rank tier (index = tier). */
export const RANK_MILESTONES: readonly number[] = [0, 50, 150, 400, 1000, 2500, 6000, 15000, 40000];

/** Yearly points per title held by the player's House (and vassals' lands are ruled through them). */
export const TITLE_POINTS: Record<TitleKind, number> = {
  manor: 4, town: 8, barony: 12, abbey: 12, see: 15, county: 30, kingdom: 80,
};

const LEDGER_CAP = 120;

/** Where banked Legacy gold goes (the profile). */
export interface GoldBank { add(gold: number): void }

export class ScoreKeeper {
  constructor(private readonly state: GameState, private readonly events: EventBus<SimEvents>, private readonly bank: GoldBank) {}

  get points(): number { return this.state.score.points; }

  /** Awards `amount` raw points (before the multipliers); returns the points actually added. */
  award(kind: ScoreKind, amount: number, reason: string): number {
    const run = this.state.run;
    if (amount <= 0 || run.phase === 'over') return 0;
    const sc = this.state.score;
    const pts = Math.round(amount * run.multiplier * DIFFICULTY_GOLD[this.state.difficulty] * 100) / 100;
    sc.raw += amount;
    sc.points = Math.round((sc.points + pts) * 100) / 100;
    sc.byKind[kind] = (sc.byKind[kind] ?? 0) + pts;
    sc.ledger.push({ day: this.state.clock.absDay, kind, amount: pts, reason });
    if (sc.ledger.length > LEDGER_CAP) sc.ledger.splice(0, sc.ledger.length - LEDGER_CAP);
    this.bankGold();
    this.state.dirty.meta = true;
    this.events.emit('points', { kind, amount: pts, reason, total: sc.points });
    return pts;
  }

  /** Converts any unbanked points into Legacy gold. */
  bankGold(): number {
    const sc = this.state.score;
    const target = Math.floor(sc.points / POINTS_PER_GOLD);
    const delta = target - sc.goldBanked;
    if (delta > 0) {
      sc.goldBanked = target;
      this.bank.add(delta);
    }
    return Math.max(0, delta);
  }

  /** Call when a member of the player's line attains `tier` (promotion, inheritance, knighting …).
   *  Pays the milestone once, the first time that tier is passed. */
  onRankReached(tier: RankTier): number {
    const run = this.state.run;
    if (tier <= run.maxTier) return 0;
    run.maxTier = tier;
    this.state.dirty.meta = true;
    const sc = this.state.score;
    if (sc.milestones.includes(tier)) return 0;
    sc.milestones.push(tier);
    return this.award('rank', RANK_MILESTONES[tier], `Reached rank ${tier}`);
  }

  /** Yearly hook: points for what the player's House holds, plus the continent share. */
  yearly(world: WorldModel): void {
    const run = this.state.run;
    if (run.phase === 'over') return;
    let holdings = 0;
    for (const t of ruledTitles(this.state)) holdings += TITLE_POINTS[t.kind];
    const player = this.state.persons.get(run.playerId);
    const hh = player ? this.state.households.get(player.household) : undefined;
    const wealth = (player ? player.money : 0) + (hh ? hh.purse : 0);
    holdings += Math.floor(wealth / 24000);
    if (holdings > 0) this.award('holdings', holdings, 'Holdings');
    const pct = continentPct(this.state, world);
    this.state.score.continentPct = pct;
    if (pct > 0) this.award('continent', pct * 10, 'Continent ruled');
  }
}

// ---- holdings / continent ----

/** Titles held by living members of the player's House, plus those held from them (vassals). */
export function ruledTitles(state: GameState): Set<Title> {
  const ruled = new Set<Title>();
  const members = state.houseMembers.get(state.run.houseId);
  if (!members) return ruled;
  const held = new Set<Title>();
  for (const p of members) for (const t of state.titlesHeldBy(p.id)) held.add(t);
  if (held.size === 0) return ruled;
  for (const t of state.titles.values()) {
    let cur: Title | undefined = t;
    for (let guard = 0; cur && guard < 8; guard++) {
      if (held.has(cur)) { ruled.add(t); break; }
      cur = cur.liege ? state.titles.get(cur.liege) : undefined;
    }
  }
  return ruled;
}

interface AreaTable {
  total: number;
  kingdom: Map<number, number>;
  county: Map<number, number>;
  weight: Map<number, number>;
  countyWeight: Map<number, number>;
}
const areaCache = new WeakMap<WorldModel, AreaTable>();

function areas(world: WorldModel): AreaTable {
  let t = areaCache.get(world);
  if (t) return t;
  t = { total: 0, kingdom: new Map(), county: new Map(), weight: new Map(), countyWeight: new Map() };
  const m = world.macro;
  for (let i = 0; i < m.kingdom.length; i++) {
    const k = m.kingdom[i];
    if (k === 0) continue;
    t.total++;
    t.kingdom.set(k - 1, (t.kingdom.get(k - 1) ?? 0) + 1);
    const c = m.county[i];
    if (c) t.county.set(c - 1, (t.county.get(c - 1) ?? 0) + 1);
  }
  for (const s of world.settlements) {
    const w = s.radius * s.radius + 1;
    t.weight.set(s.id, w);
    t.countyWeight.set(s.county, (t.countyWeight.get(s.county) ?? 0) + w);
  }
  areaCache.set(world, t);
  return t;
}

/** Share (0..100) of the continent's land under the player's House titles, vassals included. */
export function continentPct(state: GameState, world: WorldModel): number {
  const ruled = ruledTitles(state);
  if (ruled.size === 0) return 0;
  const a = areas(world);
  if (a.total === 0) return 0;
  const settlementById = new Map(world.settlements.map((s) => [s.id, s]));
  let cells = 0;
  for (const t of ruled) {
    // count only top-level ruled titles: their lands already include everything held from them
    if (t.liege && ruled.has(state.titles.get(t.liege) as Title)) continue;
    if (t.kind === 'kingdom') cells += a.kingdom.get(t.place) ?? 0;
    else if (t.kind === 'county') cells += a.county.get(t.place) ?? 0;
    else {
      const s = settlementById.get(t.place);
      if (!s) continue;
      const cw = a.countyWeight.get(s.county) ?? 1;
      cells += ((a.county.get(s.county) ?? 0) * (a.weight.get(s.id) ?? 0)) / cw;
    }
  }
  return Math.min(100, (cells / a.total) * 100);
}

/** Convenience: years since the run began. */
export function runYears(state: GameState): number {
  return (state.clock.absDay - state.run.startedDay) / DAYS_PER_YEAR;
}
