// The per-level records profile (SPEC §1): best score, best share of the continent, runs played. Nothing in it
// carries from one run into the next game: there is no currency between runs and no shop. Pure functions over a
// plain Profile object.
import type { LevelId } from './state';

export const PROFILE_VERSION = 1;

export interface LevelProfile {
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
  return { bestScore: 0, bestContinentPct: 0, runsPlayed: 0 };
}

export function newProfile(): Profile {
  return { version: PROFILE_VERSION, levels: { medieval: newLevelProfile() }, settings: {} };
}

export function levelProfile(profile: Profile, level: LevelId = 'medieval'): LevelProfile {
  const lp = profile.levels[level] ?? (profile.levels[level] = newLevelProfile());
  // profiles saved before the shop was removed still carry the old currency: drop it
  delete (lp as LevelProfile & { legacyGold?: number }).legacyGold;
  return lp;
}

/** Records the end of a run: best score and best continent %. */
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
