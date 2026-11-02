// Tunables of the AI rulers (docs/CIV.md §10, docs/REALM.md "The AI rulers"). One place to balance. Nothing here is a bonus: the
// rulers pay the same prices, use the same labour and meet the same rules as the player; these numbers only say how readily and how
// much they ask of those rules.
import type { Difficulty } from '../../core/domain';
import type { BuildingKind } from '../../content/types';

export const AI = {
  /** Hours between a ruler's rounds: one four-day week (the calendar's season). The rulers are dealt over these hours so that about one is due each. */
  periodHours: 96,
  /** Days (not hours) a thing that did not work is left alone: a place with no room, a technique refused. */
  retryDays: 16,
  /** Most candidate spots one search looks at (each is a `check`, 25-55 us): keeps a round's longest call under a few ms. */
  searchChecks: 40,
  /** Share of the free funds (above the comfortable purse) a single new work may take, and the share all works under way may owe in all. */
  projectShare: 0.4,
  committedShare: 0.8,
  /** The comfortable purse, as a share of what a head of that rank usually holds (TIER_PURSE): below it the ruler saves. */
  comfort: 0.3,
  /** A purse below this many days of the men's wages is thin: no new men are raised, works wait. */
  wageReserveDays: 40,
  /** A ruler keeps this much in hand for the first days' wages: no site is staked out below it. */
  minFunds: 120,
  /** Days a work may stand still (no materials to be had, no hands) before its ruler gives it up. */
  stallDays: 16,
  /** The dear materials (timber, stone, iron, planks, bricks) are not bought at more than this many times their usual price, and need this margin over the market's stock. */
  dearPrice: 2.6,
  supplyMargin: 1.35,
  /** Least score a work needs to be started, and an improvement to be made. */
  startScore: 0.26,
  improveScore: 0.2,
  /** Works a House may stake out in a game year: a base, and more for each place it rules, times the realm class's share (and the difficulty's pace). */
  yearBase: 0.25,
  yearPerPlace: 0.35,
} as const;

/**
 * Difficulty (SPEC §1): "Squire: rivals less aggressive and slower to expand ... King: ruthless rivals". The pace scales how many
 * works a ruler keeps going, how often he starts research and how many men he keeps under arms. Prices, labour and rules are the
 * same on every difficulty.
 */
export const PACE: Readonly<Record<Difficulty, number>> = { squire: 0.6, knight: 1, lord: 1.15, king: 1.3 };

/** What kind of realm a ruler has; the sizes of everything he does follow it. */
export type RealmClass = 'manor' | 'abbey' | 'barony' | 'county' | 'kingdom';

/** Works a ruler keeps going at once, and works he may stake out in one round, by realm class; and the class's share of the year's works. */
export const YEAR_SHARE: Readonly<Record<RealmClass, number>> = { manor: 1, abbey: 1, barony: 1.3, county: 1.8, kingdom: 2.2 };
export const OPEN_SITES: Readonly<Record<RealmClass, number>> = { manor: 2, abbey: 2, barony: 3, county: 4, kingdom: 6 };
export const PLACE_PER_ROUND: Readonly<Record<RealmClass, number>> = { manor: 1, abbey: 1, barony: 1, county: 2, kingdom: 2 };
/** Research projects at once. */
export const RESEARCH_AT_ONCE: Readonly<Record<RealmClass, number>> = { manor: 1, abbey: 1, barony: 1, county: 2, kingdom: 3 };
/** Days between one research begun and the next, for a House of the class. */
export const RESEARCH_GAP: Readonly<Record<RealmClass, number>> = { manor: 24, abbey: 24, barony: 16, county: 10, kingdom: 6 };
/** Outposts a ruler of the class may hold in all; only barons and greater found them (and a House founds one only every `OUTPOST.gapYears`). */
export const OUTPOSTS: Readonly<Record<RealmClass, number>> = { manor: 0, abbey: 0, barony: 1, county: 1, kingdom: 2 };

export const OUTPOST = {
  /** Years between one outpost founded and the next, for a House. */
  gapYears: 3,
  /** Furthest (m) from the ruler's lands a deposit in the wild is looked for. */
  reach: 6500,
  /** A deposit this close (m) to another outpost is already taken. */
  apart: 700,
  /** Funds it takes: the ruler's free funds must be at least this many pence. */
  minFunds: 2500,
} as const;

/** The siege model's fortification weights (src/sim/military/siege.ts DEFENCE_WEIGHT) and ceiling, so the rulers build what the sieges count. */
export const FORT_WEIGHT: Readonly<Partial<Record<BuildingKind, number>>> = { palisade: 0.45, wall: 0.9, tower: 0.25, gatehouse: 0.3, motte: 0.8, keep_stone: 1.1 };
export const FORT_MAX = 3.2;

/** Kinds that count as a defence work (for the news and the yearly table). */
export const DEFENCE_KINDS: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['palisade', 'wall', 'tower', 'gatehouse', 'motte', 'keep_stone']);
/** Works the neighbours hear of when they are staked out (news). */
export const NOTABLE: Readonly<Partial<Record<BuildingKind, number>>> = {
  palisade: 0.45, wall: 0.7, tower: 0.65, gatehouse: 0.65, keep_stone: 0.75, motte: 0.5, barracks: 0.55, training_yard: 0.45,
  mine: 0.3, quarry: 0.25, dock: 0.2, watermill: 0.15, windmill: 0.15, church: 0.15, market_hall: 0.2, guildhall: 0.2,
};

/** Settlement kinds that are towns of houses (the crowding rule applies), and the ones that are not (castles, cloisters). */
export const HOUSING_KINDS: ReadonlySet<string> = new Set(['village', 'hamlet', 'town', 'city']);

/** Troops: shares of each kind in what a ruler keeps, and the men he keeps per head of his people. */
export const TROOPS_AI = {
  /** Men under arms per resident in peace, and the extra per resident at full threat. */
  perHeadPeace: 0.01,
  perHeadThreat: 0.05,
  /** Never more than this many raised in one call, nor kept in all by class. */
  batch: 10,
  cap: { manor: 14, abbey: 4, barony: 30, county: 70, kingdom: 140 } as Readonly<Record<RealmClass, number>>,
  /** Shares of the standing troop by kind (crossbowmen replace archers once the House has the technique). */
  mix: { archer: 0.45, man_at_arms: 0.35, sergeant: 0.14, crossbow: 0.06 } as Readonly<Record<string, number>>,
  /** Days between one call to raise men and the next, for a House. */
  gapDays: 6,
  /** Days between knighting one of his men and the next. */
  dubGapDays: 12,
} as const;

/** Cheap building kinds the ruler may have from the start to train the men and house the garrison. */
export const BARRACKS_MEN = 8;
