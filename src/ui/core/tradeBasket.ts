// The trade basket: what you are buying (positive) and selling (negative), bounded by their stock and
// your inventory. A good can only be on one side at a time; a basket with both sides is a barter.
import type { ItemKey, TradeLine } from '../../sim/economy/types';

export interface Bounds {
  /** How many they can sell you. */
  stock: number;
  /** How many you can sell them. */
  have: number;
}

export class TradeBasket {
  private readonly lines = new Map<ItemKey, number>();

  /** Signed quantity: > 0 you buy, < 0 you sell, 0 not in the basket. */
  qty(key: ItemKey): number { return this.lines.get(key) ?? 0; }

  /** Adds `delta` (positive buys more or sells less, negative the reverse) within the bounds.
   *  Returns the new signed quantity. */
  adjust(key: ItemKey, delta: number, bounds: Bounds): number {
    const next = Math.max(-Math.max(0, bounds.have), Math.min(Math.max(0, bounds.stock), this.qty(key) + delta));
    if (next === 0) this.lines.delete(key); else this.lines.set(key, next);
    return next;
  }

  /** Buy one more (or `n`) of `key`; if you were selling it, selling shrinks first. */
  buy(key: ItemKey, n: number, bounds: Bounds): number { return this.adjust(key, n, bounds); }
  sell(key: ItemKey, n: number, bounds: Bounds): number { return this.adjust(key, -n, bounds); }

  set(key: ItemKey, signed: number, bounds: Bounds): number { return this.adjust(key, signed - this.qty(key), bounds); }

  remove(key: ItemKey): void { this.lines.delete(key); }
  clear(): void { this.lines.clear(); }
  get size(): number { return this.lines.size; }
  isEmpty(): boolean { return this.lines.size === 0; }

  hasBuy(): boolean { for (const q of this.lines.values()) if (q > 0) return true; return false; }
  hasSell(): boolean { for (const q of this.lines.values()) if (q < 0) return true; return false; }
  /** Goods both ways: a barter, settled in goods with money making up any difference. */
  isBarter(): boolean { return this.hasBuy() && this.hasSell(); }

  toLines(): TradeLine[] {
    return [...this.lines.entries()].map(([key, qty]) => ({ key, qty }));
  }

  /** Drops lines that no longer fit (stock sold out, items used): clamps every line to the bounds. */
  prune(bounds: (key: ItemKey) => Bounds): void {
    for (const [key, q] of [...this.lines.entries()]) {
      const b = bounds(key);
      const clamped = Math.max(-Math.max(0, b.have), Math.min(Math.max(0, b.stock), q));
      if (clamped === 0) this.lines.delete(key); else if (clamped !== q) this.lines.set(key, clamped);
    }
  }
}

/** Words for the net of a quote: "You pay 5d", "You receive 1s 2d", "An even exchange". */
export function settlementWords(money: number, format: (pence: number) => string): string {
  if (Math.abs(money) < 0.001) return 'An even exchange';
  return money > 0 ? `You pay ${format(money)}` : `You receive ${format(-money)}`;
}

/** Words for a −1..1 price trend (vs the reference price): "a little dearer than usual". */
export function trendWords(trend: number): string {
  const a = Math.abs(trend);
  if (a < 0.12) return 'about the usual price';
  return `${a < 0.5 ? 'a little ' : 'much '}${trend > 0 ? 'dearer' : 'cheaper'} than usual`;
}

export function trendLevel(trend: number): 'up' | 'down' | 'flat' {
  return trend > 0.12 ? 'up' : trend < -0.12 ? 'down' : 'flat';
}
