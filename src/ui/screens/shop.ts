// The Legacy stat shop (SPEC §1): ranks bought for the next run's character, paid in Legacy gold.
// Pure maths over `sim/legacy.ts` so the rules (prices, cap, affordability) live in one place.
import { STATS, STAT_CAP, type StatId } from '../../core/domain';
import { MAX_RANKS_PER_STAT, RANK_PRICES, SHOP_BASE_STAT, clampUpgrades, rankCost, upgradesCost, type StatUpgrades } from '../../sim/legacy';

export class StatShop {
  private ranks: Record<StatId, number> = { str: 0, end: 0, agi: 0, int: 0, per: 0, cha: 0 };

  constructor(private gold: number) {}

  get balance(): number { return this.gold; }

  /** The balance changed (another profile loaded): drop ranks that can no longer be afforded. */
  setGold(gold: number): void {
    this.gold = gold;
    while (this.spent() > this.gold && this.totalRanks() > 0) this.removeMostExpensive();
  }

  rank(stat: StatId): number { return this.ranks[stat]; }

  /** Price of the next rank of `stat`, or null at the maximum. */
  nextPrice(stat: StatId): number | null {
    const r = this.ranks[stat];
    return r >= MAX_RANKS_PER_STAT ? null : RANK_PRICES[r];
  }

  /** What the last bought rank cost (the refund when removed), or null with none. */
  lastPrice(stat: StatId): number | null {
    const r = this.ranks[stat];
    return r <= 0 ? null : RANK_PRICES[r - 1];
  }

  canAdd(stat: StatId): boolean {
    const price = this.nextPrice(stat);
    return price !== null && this.remaining() >= price;
  }

  canRemove(stat: StatId): boolean { return this.ranks[stat] > 0; }

  add(stat: StatId): boolean {
    if (!this.canAdd(stat)) return false;
    this.ranks[stat]++;
    return true;
  }

  remove(stat: StatId): boolean {
    if (!this.canRemove(stat)) return false;
    this.ranks[stat]--;
    return true;
  }

  /** Sets a stat to an exact number of ranks if affordable; returns the ranks actually set. */
  set(stat: StatId, ranks: number): number {
    const target = Math.max(0, Math.min(MAX_RANKS_PER_STAT, Math.floor(ranks)));
    const before = this.ranks[stat];
    this.ranks[stat] = target;
    if (this.spent() > this.gold) this.ranks[stat] = before;
    return this.ranks[stat];
  }

  reset(): void { for (const s of STATS) this.ranks[s] = 0; }

  spent(): number { return upgradesCost(this.ranks); }
  remaining(): number { return this.gold - this.spent(); }
  totalRanks(): number { let n = 0; for (const s of STATS) n += this.ranks[s]; return n; }

  /** The selection to hand to `UiHost.startNewRun`. */
  selection(): StatUpgrades { return clampUpgrades(this.ranks); }

  /** Cost of raising `stat` from its current rank to `to` (for tooltips). */
  costTo(stat: StatId, to: number): number { return rankCost(this.ranks[stat], to); }

  /** Potential of an average roll (10) after the bought ranks, never above the cap. */
  expectedPotential(stat: StatId): number { return Math.min(STAT_CAP, SHOP_BASE_STAT + this.ranks[stat]); }

  private removeMostExpensive(): void {
    let worst: StatId | null = null;
    let worstPrice = -1;
    for (const s of STATS) {
      const p = this.lastPrice(s);
      if (p !== null && p > worstPrice) { worst = s; worstPrice = p; }
    }
    if (worst) this.ranks[worst]--;
  }
}

export { MAX_RANKS_PER_STAT, RANK_PRICES, SHOP_BASE_STAT };
