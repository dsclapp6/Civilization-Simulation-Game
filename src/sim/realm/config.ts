// Tunables of the realm module (docs/CIV.md §6, numbers marked "tune" there). One place to balance.
import type { RankTier, SkillId, StatId } from '../../core/domain';
import type { CareerId } from '../careers';
import type { UnitKind } from '../military/types';
import type { TitleKind } from '../state';

/** Titles that carry the rule of a place. */
export const RULING_TITLES: ReadonlySet<TitleKind> = new Set<TitleKind>(['kingdom', 'county', 'barony', 'manor', 'town', 'abbey', 'see']);

/** Ledger: the treasury's flows are kept for a rolling year (a game year is 16 days). */
export const LEDGER_DAYS = 16;

export const RESEARCH = {
  /** Projects a House may have running at once. */
  maxProjects: 4,
  /** Days a project may stand still before it is given up. */
  stallDays: 48,
  /** Share of the unspent part of the price that comes back when a project is stopped. */
  refund: 0.5,
  /** Pace of a clerk, monk or master who is not of the technique's own trade. */
  slowPace: 0.5,
  /** Price of the goods bought on the spot, against their usual price (carting, the merchant's profit). */
  buyPremium: 1.2,
  /** Days after an order of goods before the project orders the rest again. */
  reorderDays: 4,
  /** Careers whose people can do book-work and be put to research as clerks and clergy. */
  scholars: ['clerk', 'priest', 'monk', 'nun', 'prior', 'abbot', 'bishop', 'steward', 'bailiff'] as readonly CareerId[],
} as const;

export type RecruitKind = Exclude<UnitKind, 'levy'>;

export interface RecruitSpec {
  label: string;
  /** "3 archers", "3 men-at-arms". */
  plural: string;
  /** What one man is armed with (good → amount). The horse stays with the garrison household; the rest goes into the man's pack. */
  gear: Readonly<Record<string, number>>;
  /** Quality tier of a good that has to be bought (1 = common … 4); 1 where not written. */
  buyTier: Readonly<Record<string, number>>;
  /** Signing fee paid to the man, pence. */
  fee: number;
  /** Wage per day from the treasury, pence (the military module's wages: archers 2.5, men-at-arms 5, sergeants 8). */
  upkeep: number;
  /** The technique the House must command. */
  tech?: string;
  minAge: number;
  maxAge: number;
  minStat: Readonly<Partial<Record<StatId, number>>>;
  /** Skill levels the drill brings him up to. */
  drill: Readonly<Partial<Record<SkillId, number>>>;
  career: CareerId;
  stage: number;
  rank: RankTier;
}

export const RECRUIT: Readonly<Record<RecruitKind, RecruitSpec>> = {
  archer: {
    label: 'Archer', plural: 'archers', gear: { longbow: 1, arrow: 24 }, buyTier: {}, fee: 6, upkeep: 2.5, minAge: 15, maxAge: 45,
    minStat: { str: 9 }, drill: { archery: 3 }, career: 'archer', stage: 1, rank: 2,
  },
  crossbow: {
    label: 'Crossbowman', plural: 'crossbowmen', gear: { crossbow: 1, bolt: 20, padded_armour: 1 }, buyTier: {}, fee: 8, upkeep: 3, tech: 'crossbows', minAge: 15, maxAge: 45,
    minStat: { str: 8, per: 8 }, drill: { archery: 3 }, career: 'archer', stage: 1, rank: 2,
  },
  man_at_arms: {
    label: 'Man-at-arms', plural: 'men-at-arms', gear: { sword: 1, shield: 1, spear: 1, padded_armour: 1, cap_helmet: 1 }, buyTier: {}, fee: 12, upkeep: 5, minAge: 16, maxAge: 45,
    minStat: { str: 10, end: 9 }, drill: { melee: 4 }, career: 'man_at_arms', stage: 1, rank: 2,
  },
  sergeant: {
    label: 'Mounted sergeant', plural: 'mounted sergeants', gear: { horse: 1, sword: 1, lance: 1, shield: 1, padded_armour: 1, cap_helmet: 1 }, buyTier: {}, fee: 24, upkeep: 8, minAge: 18, maxAge: 45,
    minStat: { str: 10, end: 9, agi: 8 }, drill: { melee: 4, riding: 4 }, career: 'sergeant', stage: 2, rank: 3,
  },
  knight: {
    label: 'Knight', plural: 'knights', gear: { horse: 1, sword: 1, lance: 1, shield: 1, mail_hauberk: 1, kettle_hat: 1 }, buyTier: { horse: 2, sword: 2 }, fee: 120, upkeep: 12, minAge: 18, maxAge: 55,
    minStat: { str: 10, end: 10 }, drill: { melee: 6, riding: 6 }, career: 'knight', stage: 2, rank: 5,
  },
  mercenary: {
    label: 'Mercenary', plural: 'mercenaries', gear: {}, buyTier: {}, fee: 12, upkeep: 4, minAge: 18, maxAge: 42,
    minStat: {}, drill: {}, career: 'soldier', stage: 0, rank: 2,
  },
};

export const RECRUIT_KINDS: readonly RecruitKind[] = ['archer', 'crossbow', 'man_at_arms', 'sergeant', 'knight', 'mercenary'];

export const TROOPS = {
  /** Gear missing from the stores is bought from smiths and saddlers at this multiple of the usual price. */
  buyPremium: 1.25,
  /** The treasury must also hold this many days of the new men's wages. */
  reserveDays: 8,
  /** Most men raised by one call. */
  batch: 60,
  /** Days of arrears after which the men begin to desert, and the daily chance of each then leaving. */
  patienceDays: 6,
  desertChance: 0.12,
  /** Careers of men who already serve (they are not raised again as new recruits). */
  serving: ['soldier', 'archer', 'man_at_arms', 'sergeant', 'knight', 'squire', 'page'] as readonly CareerId[],
  /** Mercenary hiring reaches this far from the seat (metres), as in the military module. */
  mercRadius: 5500,
  /** The accolade: a vigil, a feast and a gift (pence), on top of the gear. */
  accolade: 60,
} as const;

export const TRADE = {
  /** Orders one household may keep. */
  maxOrders: 24,
  /** Most units moved by one order in one day. */
  dayLimit: 400,
  /** Hour of the day orders are carried out (the markets are open). */
  hour: 10,
} as const;

export const NEWS = {
  /** Items kept. */
  cap: 160,
  /** Share of the realm's treasury a purchase order may spend in one day. */
  buyShare: 0.25,
} as const;

/** Hours of the day the realm's daily jobs run at (spread so that no frame carries them all). */
export const HOURS = { research: 6, troops: 8, trade: TRADE.hour, news: 12, books: 23 } as const;
