import { describe, expect, it } from 'vitest';
import { STATS } from '../../src/core/domain';
import { MAX_RANKS_PER_STAT, RANK_PRICES, canAfford, newProfile, levelProfile, upgradesCost } from '../../src/sim/legacy';
import { StatShop } from '../../src/ui/screens/shop';

describe('stat shop', () => {
  it('sells ranks at the legacy prices, cheapest first', () => {
    const shop = new StatShop(10_000);
    expect(shop.nextPrice('str')).toBe(RANK_PRICES[0]);
    shop.add('str');
    expect(shop.nextPrice('str')).toBe(RANK_PRICES[1]);
    expect(shop.spent()).toBe(RANK_PRICES[0]);
    shop.add('str');
    expect(shop.spent()).toBe(RANK_PRICES[0] + RANK_PRICES[1]);
    expect(shop.rank('str')).toBe(2);
    expect(shop.lastPrice('str')).toBe(RANK_PRICES[1]);
  });

  it('refuses what gold cannot buy, and refunds on removal', () => {
    const shop = new StatShop(RANK_PRICES[0] + RANK_PRICES[1] - 1);
    expect(shop.add('str')).toBe(true);
    expect(shop.canAdd('str')).toBe(false);
    expect(shop.add('str')).toBe(false);
    expect(shop.remaining()).toBe(RANK_PRICES[0] + RANK_PRICES[1] - 1 - RANK_PRICES[0]);
    // a different stat's first rank is still affordable
    expect(shop.canAdd('end')).toBe(true);
    expect(shop.remove('str')).toBe(true);
    expect(shop.remove('str')).toBe(false);
    expect(shop.remaining()).toBe(shop.balance);
  });

  it('stops at the maximum ranks per stat (the cap of 18)', () => {
    const shop = new StatShop(1e9);
    for (let i = 0; i < 20; i++) shop.add('int');
    expect(shop.rank('int')).toBe(MAX_RANKS_PER_STAT);
    expect(shop.nextPrice('int')).toBeNull();
    expect(shop.canAdd('int')).toBe(false);
    expect(shop.expectedPotential('int')).toBe(18);
  });

  it('hands the host a clean selection the legacy module can charge', () => {
    const profile = newProfile();
    levelProfile(profile).legacyGold = 900;
    const shop = new StatShop(levelProfile(profile).legacyGold);
    shop.add('str'); shop.add('str'); shop.add('per');
    const sel = shop.selection();
    expect(sel).toEqual({ str: 2, per: 1 });
    expect(upgradesCost(sel)).toBe(shop.spent());
    expect(canAfford(profile, sel)).toBe(true);
    expect(shop.remaining()).toBe(900 - shop.spent());
  });

  it('resets, sets exact ranks within the budget, and trims when the balance drops', () => {
    const shop = new StatShop(1000);
    shop.set('agi', 3);
    expect(shop.rank('agi')).toBe(3);
    expect(shop.set('agi', 8)).toBe(3); // unaffordable: unchanged
    shop.add('cha');
    shop.setGold(RANK_PRICES[0]);
    expect(shop.spent()).toBeLessThanOrEqual(RANK_PRICES[0]);
    shop.reset();
    expect(STATS.every((s) => shop.rank(s) === 0)).toBe(true);
    expect(shop.totalRanks()).toBe(0);
  });
});
