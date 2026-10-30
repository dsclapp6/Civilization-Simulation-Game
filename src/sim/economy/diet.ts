// What households eat, drink and burn: the daily bundle per consumer unit (an adult = 1.0). One
// "ration" is a day's food for an adult. The same tables size the market stocks (market.ts) and
// drive the households' consumption (macro.ts), so supply and demand are calibrated together.

/** Rations per unit of each food good (a gallon of wheat feeds an adult for 3.6 days of staple). */
export const RATION: Readonly<Record<string, number>> = {
  wheat: 3.6, rye: 3.6, barley: 3.2, oats: 2.4, peas: 3.4, beans: 3.4,
  bread: 0.7, vegetables: 0.25, eggs: 0.5, cheese: 0.8, meat: 0.9, fish: 0.7,
};

/** Grains and legumes a household keeps in its stores, as staple. */
export const STAPLE_GRAINS: readonly string[] = ['wheat', 'rye', 'barley', 'oats', 'peas', 'beans'];

export interface Diet {
  /** Share of staple rations from each grain (sums to 1). */
  staple: ReadonlyArray<readonly [string, number]>;
  /** Share of the staple rations that urban households buy as bread. */
  breadShare: number;
  /** Share of the day's rations that come from other foods. */
  optionalShare: number;
  /** Weights within the other foods (sum to 1). */
  optional: ReadonlyArray<readonly [string, number]>;
  /** Gallons of ale per consumer unit and day. */
  ale: number;
  /** Bundles of firewood per consumer unit and day (average over the year). */
  fuel: number;
}

const POOR: Diet = {
  staple: [['rye', 0.35], ['barley', 0.3], ['oats', 0.15], ['peas', 0.1], ['wheat', 0.05], ['beans', 0.05]],
  breadShare: 0.35, optionalShare: 0.2,
  optional: [['vegetables', 0.4], ['eggs', 0.15], ['cheese', 0.25], ['meat', 0.1], ['fish', 0.1]],
  ale: 0.3, fuel: 0.1,
};
const MIDDLING: Diet = {
  staple: [['wheat', 0.5], ['rye', 0.2], ['barley', 0.15], ['peas', 0.1], ['beans', 0.05]],
  breadShare: 0.5, optionalShare: 0.32,
  optional: [['vegetables', 0.2], ['eggs', 0.13], ['cheese', 0.27], ['meat', 0.25], ['fish', 0.15]],
  ale: 0.35, fuel: 0.12,
};
const RICH: Diet = {
  staple: [['wheat', 0.85], ['rye', 0.05], ['barley', 0.06], ['peas', 0.04]],
  breadShare: 0.4, optionalShare: 0.5,
  optional: [['vegetables', 0.08], ['eggs', 0.08], ['cheese', 0.2], ['meat', 0.44], ['fish', 0.2]],
  ale: 0.5, fuel: 0.2,
};

export function dietOf(tier: number): Diet { return tier <= 2 ? POOR : tier <= 4 ? MIDDLING : RICH; }

/** Representative rank tier of the people of a kind of settlement (for sizing market stocks). */
export function typicalTier(kind: string): number {
  switch (kind) {
    case 'city': return 3;
    case 'town': return 2.6;
    case 'castle': return 3.5;
    case 'abbey': case 'priory': case 'nunnery': return 3;
    default: return 1.5;
  }
}

/** Share of a settlement's people who buy their food at a market instead of growing it. */
export function marketBuyShare(kind: string): number {
  switch (kind) {
    case 'city': return 1;
    case 'town': return 0.95;
    case 'castle': return 0.8;
    case 'abbey': return 0.25;
    case 'priory': case 'nunnery': return 0.5;
    case 'hamlet': return 0.08;
    default: return 0.1;
  }
}

/** Units of a market good that one consumer unit draws per day when it buys everything (urban households buy bread too). */
export function dailyUse(good: string, tier: number, urban: boolean): number {
  const d = dietOf(tier);
  const staple = 1 - d.optionalShare;
  const breadFrac = urban ? d.breadShare : 0;
  if (good === 'bread') return (staple * breadFrac) / RATION.bread;
  for (const [g, w] of d.staple) if (g === good) return (staple * (1 - breadFrac) * w) / RATION[g];
  for (const [g, w] of d.optional) if (g === good) return (d.optionalShare * w) / RATION[g];
  if (good === 'ale') return d.ale;
  if (good === 'firewood') return d.fuel;
  return 0;
}

/** Grain gallons a consumer unit needs per day in total (all staple rations as grain). */
export const GRAIN_PER_UNIT_DAY = 0.215;
