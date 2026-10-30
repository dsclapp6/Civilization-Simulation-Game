// Legacy: the per-level meta profile (SPEC §1). Points convert to Legacy gold as they are earned;
// gold is kept forever and buys base-stat upgrades for the starting character of the NEXT run,
// bought fresh each run (consumed). Pure functions over a plain Profile object.
import { STAT_CAP, STATS, type Difficulty, type StatId } from '../core/domain';
import type { LevelId } from './state';

export const PROFILE_VERSION = 1;

export interface LevelProfile {
  legacyGold: number;
  bestScore: number;
  /** Highest % of the continent ruled (0..100). */
  bestContinentPct: number;
  runsPlayed: number;
}

export interface Profile {
  version: number;
  levels: Record<LevelId, LevelProfile>;
  settings: Record<string, unknown>;
}

export function newLevelProfile(): LevelProfile {
  return { legacyGold: 0, bestScore: 0, bestContinentPct: 0, runsPlayed: 0 };
}

export function newProfile(): Profile {
  return { version: PROFILE_VERSION, levels: { medieval: newLevelProfile() }, settings: {} };
}

export function levelProfile(profile: Profile, level: LevelId = 'medieval'): LevelProfile {
  return profile.levels[level] ?? (profile.levels[level] = newLevelProfile());
}

// ---- stat shop ----

/** The nominal stat the shop assumes (population mean). Ranks are applied to the rolled potential
 *  after birth, capped at STAT_CAP, so at most STAT_CAP - SHOP_BASE ranks per stat are sold. */
export const SHOP_BASE_STAT = 10;
export const MAX_RANKS_PER_STAT = STAT_CAP - SHOP_BASE_STAT;
/** Price of the n-th rank (index 0 = first rank). */
export const RANK_PRICES: readonly number[] = [100, 250, 450, 700, 1000, 1400, 1900, 2500];

export type StatUpgrades = Partial<Record<StatId, number>>;

/** Price of the rank-th rank of a stat (1-based). */
export function rankPrice(rank: number): number {
  if (rank < 1 || rank > MAX_RANKS_PER_STAT) throw new RangeError(`rank out of range: ${rank}`);
  return RANK_PRICES[rank - 1];
}

/** Cost of raising a stat from `from` ranks to `to` ranks. */
export function rankCost(from: number, to: number): number {
  let sum = 0;
  for (let r = from + 1; r <= to; r++) sum += rankPrice(r);
  return sum;
}

/** Sanitises a selection: integer ranks within [0, MAX_RANKS_PER_STAT], known stats only. */
export function clampUpgrades(sel: StatUpgrades): StatUpgrades {
  const out: StatUpgrades = {};
  for (const s of STATS) {
    const v = Math.max(0, Math.min(MAX_RANKS_PER_STAT, Math.floor(sel[s] ?? 0)));
    if (v > 0) out[s] = v;
  }
  return out;
}

export function upgradesCost(sel: StatUpgrades): number {
  let sum = 0;
  const c = clampUpgrades(sel);
  for (const s of STATS) sum += rankCost(0, c[s] ?? 0);
  return sum;
}

export function totalRanks(sel: StatUpgrades): number {
  let n = 0;
  for (const s of STATS) n += clampUpgrades(sel)[s] ?? 0;
  return n;
}

export function canAfford(profile: Profile, sel: StatUpgrades, level: LevelId = 'medieval'): boolean {
  return levelProfile(profile, level).legacyGold >= upgradesCost(sel);
}

/** Spends gold on a selection (bought fresh each run, consumed). Returns the sanitised
 *  selection actually bought, or null if it cannot be afforded. */
export function purchaseUpgrades(profile: Profile, sel: StatUpgrades, level: LevelId = 'medieval'): StatUpgrades | null {
  const clean = clampUpgrades(sel);
  const cost = upgradesCost(clean);
  const lp = levelProfile(profile, level);
  if (lp.legacyGold < cost) return null;
  lp.legacyGold -= cost;
  return clean;
}

/** Applies bought ranks to a rolled potential value (never above the cap). */
export function applyRanks(potential: number, ranks: number): number {
  return Math.min(STAT_CAP, potential + ranks);
}

// ---- gold from points ----

export const POINTS_PER_GOLD = 10;

/** Total gold a score is worth. */
export function goldForPoints(points: number, difficulty: Difficulty, goldMultiplier: Record<Difficulty, number>): number {
  return Math.floor((points / POINTS_PER_GOLD) * goldMultiplier[difficulty]);
}

/** Records the end of a run: best score and best continent %, run counter. Gold was banked as it
 *  was earned, so game over keeps it. */
export function recordRunEnd(profile: Profile, result: { score: number; continentPct: number }, level: LevelId = 'medieval'): LevelProfile {
  const lp = levelProfile(profile, level);
  lp.bestScore = Math.max(lp.bestScore, Math.round(result.score));
  lp.bestContinentPct = Math.max(lp.bestContinentPct, Math.round(result.continentPct * 100) / 100);
  return lp;
}

/** Called when a run starts. */
export function recordRunStart(profile: Profile, level: LevelId = 'medieval'): void {
  levelProfile(profile, level).runsPlayed += 1;
}
