import { describe, expect, it } from 'vitest';
import { DIFFICULTY_GOLD, STAT_CAP, STATS } from '../../src/core/domain';
import {
  MAX_RANKS_PER_STAT, RANK_PRICES, SHOP_BASE_STAT, applyRanks, canAfford, clampUpgrades, goldForPoints, levelProfile, newProfile,
  purchaseUpgrades, rankCost, rankPrice, recordRunEnd, totalRanks, upgradesCost,
} from '../../src/sim/legacy';
import { MemorySaveStore } from '../../src/sim/save-memory';
import { loadProfile, saveProfile } from '../../src/sim/save';

describe('Legacy stat shop (SPEC §1)', () => {
  it('prices ranks 100, 250, 450, 700, 1000, 1400, 1900, 2500', () => {
    expect(RANK_PRICES).toEqual([100, 250, 450, 700, 1000, 1400, 1900, 2500]);
    RANK_PRICES.forEach((p, i) => expect(rankPrice(i + 1)).toBe(p));
    expect(rankCost(0, 3)).toBe(800);
    expect(rankCost(2, 4)).toBe(450 + 700);
    expect(rankCost(0, MAX_RANKS_PER_STAT)).toBe(RANK_PRICES.reduce((a, b) => a + b, 0));
    expect(() => rankPrice(0)).toThrow();
    expect(() => rankPrice(9)).toThrow();
    // every rank costs more than the one before
    for (let i = 1; i < RANK_PRICES.length; i++) expect(RANK_PRICES[i]).toBeGreaterThan(RANK_PRICES[i - 1]);
  });

  it('never sells beyond the cap of 18: at most 8 ranks per stat from the nominal 10', () => {
    expect(SHOP_BASE_STAT + MAX_RANKS_PER_STAT).toBe(STAT_CAP);
    const all = Object.fromEntries(STATS.map((s) => [s, 50]));
    const clean = clampUpgrades(all);
    for (const s of STATS) expect(clean[s]).toBe(MAX_RANKS_PER_STAT);
    expect(clampUpgrades({ str: -3, end: 2.9, agi: 0 })).toEqual({ end: 2 });
    expect(totalRanks(all)).toBe(MAX_RANKS_PER_STAT * STATS.length);
    expect(upgradesCost(all)).toBe(STATS.length * rankCost(0, 8));
    expect(applyRanks(16, 5)).toBe(18);
    expect(applyRanks(10, 8)).toBe(18);
    expect(applyRanks(3, 2)).toBe(5);
  });

  it('is bought fresh each run: purchase spends the gold, refuses what you cannot afford', () => {
    const profile = newProfile();
    levelProfile(profile).legacyGold = 1000;
    expect(canAfford(profile, { str: 2 })).toBe(true);
    expect(canAfford(profile, { str: 5 })).toBe(false);
    expect(purchaseUpgrades(profile, { str: 5 })).toBeNull();
    expect(levelProfile(profile).legacyGold).toBe(1000);
    expect(purchaseUpgrades(profile, { str: 2, cha: 1 })).toEqual({ str: 2, cha: 1 });
    expect(levelProfile(profile).legacyGold).toBe(1000 - 350 - 100);
    // buying again costs from rank 1 again: upgrades are consumed by the run
    expect(purchaseUpgrades(profile, { str: 2 })).toEqual({ str: 2 });
    expect(levelProfile(profile).legacyGold).toBe(1000 - 450 - 350);
  });

  it('turns points into gold: 1 per 10 points times the difficulty multiplier', () => {
    expect(goldForPoints(1000, 'knight', DIFFICULTY_GOLD)).toBe(100);
    expect(goldForPoints(1000, 'squire', DIFFICULTY_GOLD)).toBe(50);
    expect(goldForPoints(1000, 'lord', DIFFICULTY_GOLD)).toBe(150);
    expect(goldForPoints(1000, 'king', DIFFICULTY_GOLD)).toBe(250);
    expect(goldForPoints(9, 'knight', DIFFICULTY_GOLD)).toBe(0);
  });

  it('records best score and best continent %, never lowering them', () => {
    const profile = newProfile();
    recordRunEnd(profile, { score: 1234.4, continentPct: 3.456 });
    expect(levelProfile(profile).bestScore).toBe(1234);
    expect(levelProfile(profile).bestContinentPct).toBeCloseTo(3.46, 2);
    recordRunEnd(profile, { score: 100, continentPct: 0.5 });
    expect(levelProfile(profile).bestScore).toBe(1234);
    expect(levelProfile(profile).bestContinentPct).toBeCloseTo(3.46, 2);
    recordRunEnd(profile, { score: 5000, continentPct: 12 });
    expect(levelProfile(profile).bestScore).toBe(5000);
    expect(levelProfile(profile).bestContinentPct).toBe(12);
  });

  it('keeps the profile in its own store, separate from the run', async () => {
    const store = new MemorySaveStore();
    expect(await loadProfile(store)).toEqual(newProfile());
    const profile = newProfile();
    levelProfile(profile).legacyGold = 321;
    levelProfile(profile).bestScore = 77;
    levelProfile(profile).runsPlayed = 4;
    await saveProfile(store, profile);
    const back = await loadProfile(store);
    expect(back.levels.medieval).toEqual({ legacyGold: 321, bestScore: 77, bestContinentPct: 0, runsPlayed: 4 });
    expect(store.hasRun).toBe(false);
    await store.saveProfile('not json');
    expect((await loadProfile(store)).levels.medieval.legacyGold).toBe(0);
  });
});
