// Tunables of the military module (SPEC §13; numbers marked "tune" there). One place to balance.
import type { UnitKind } from './types';

export const CFG = {
  /** Men 15–60 may be levied (SPEC §13). */
  levyMinAge: 15,
  levyMaxAge: 60,
  /** Share of the eligible men of a lord's manors called, by reason. */
  levyFraction: { war: 0.34, defence: 0.5, raid: 0.1, garrison: 0.18, muster: 0.3 } as Record<string, number>,
  /** Most men in one army. */
  armyCap: 420,
  /** Smallest force worth marching (fewer disband). */
  armyMin: 6,
  /** Share of a castle garrison that stays behind to hold the walls. */
  garrisonKept: 0.4,
  garrisonKeptMin: 3,

  /** Days of feudal service a levy owes unpaid; after that wages are due or the men go home. */
  levyFreeDays: 12,
  /** Pence per day (SPEC §4 anchors: a labourer 1–3 d/day). */
  wage: { levy: 1.5, archer: 2.5, crossbow: 3, man_at_arms: 5, sergeant: 8, knight: 0, mercenary: 4 } as Record<UnitKind, number>,
  /** Days of food an army carries away from its muster. */
  startSupplies: 6,
  /** Food a man eats a day (man-days). */
  ration: 1,
  /** Metres per game day by kind of way is applied on top (highway ×1.15 …). */
  speedFoot: 760,
  speedMounted: 1100,
  speedSiegeTrain: 480,
  /** Two hostile armies this close fight. */
  battleRadius: 140,
  /** Armies within this of a settlement besiege / raid it. */
  arriveRadius: 90,

  /** Ransom: a year of the captive's estate income (SPEC §13, §4). */
  ransomMin: 24,
  /** Days a prisoner is held before a hopeless ransom is written off and he is let go. */
  ransomPatience: 30,

  /** Battle model. */
  battleRounds: 10,
  battleRate: 0.115,
  /** Armies stop to fight a detail battle at most this long (simulated seconds). */
  detailSeconds: 480,
  detailMax: 60,

  /** Siege model (days). */
  siege: { ladderDays: 1, ramDays: 3, mineDays: 7, trebuchetDays: 4, assaultGap: 2, foodPerPerson: 0.25 },

  /** Valour: points for deeds → promotion (sergeant → captain → knighted). */
  valour: { battle: 2, victory: 2, wound: 2, command: 4, capture: 6, raid: 1, siege: 3, captainAt: 14, knightAt: 40 },
} as const;

/** Base fighting value of a man of each kind in the macro battle (levy spearman = 1). */
export const UNIT_POWER: Readonly<Record<UnitKind, number>> = {
  levy: 1, archer: 1.3, crossbow: 1.35, man_at_arms: 2.3, sergeant: 3, knight: 4.4, mercenary: 2,
};

/** How exposed a man of each kind is to being hit in the macro battle (armour and position). */
export const UNIT_EXPOSURE: Readonly<Record<UnitKind, number>> = {
  levy: 1.25, archer: 1.05, crossbow: 1.0, man_at_arms: 0.8, sergeant: 0.7, knight: 0.5, mercenary: 0.85,
};

export const UNIT_LABEL: Readonly<Record<UnitKind, string>> = {
  levy: 'Levy spearmen', archer: 'Archers', crossbow: 'Crossbowmen', man_at_arms: 'Men-at-arms', sergeant: 'Mounted sergeants',
  knight: 'Knights', mercenary: 'Mercenaries',
};

export function isRanged(k: UnitKind): boolean { return k === 'archer' || k === 'crossbow'; }
export function isMounted(k: UnitKind): boolean { return k === 'sergeant' || k === 'knight'; }

/** Estate income per year (pence) by title kind, used for ransom values (~ a year's income, SPEC §4). */
export const TITLE_INCOME: Readonly<Record<string, number>> = {
  manor: 4800, town: 9600, barony: 24000, county: 72000, kingdom: 360000, abbey: 24000, see: 36000,
};

/** Goods that raise a man's arms quality (economy goods, SPEC §9). Quality tiers add ±0.05 each. */
export const ARMS_GOODS: Readonly<Record<string, number>> = {
  sword: 0.18, spear: 0.1, bill: 0.1, mace: 0.1, war_axe: 0.12, shield: 0.06, dagger: 0.02, shortbow: 0.05, longbow: 0.1,
  crossbow: 0.1, padded_armour: 0.1, mail_hauberk: 0.26, coat_of_plates: 0.4, cap_helmet: 0.04, kettle_hat: 0.07,
};
