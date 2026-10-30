// Every tunable number of the social system in one place (documented in docs/SOCIAL.md).

/** Opinion scale (−100..100) and the thresholds other code reads. */
export const OPINION = {
  /** Memory of deeds fades this much every four days (half-life ≈ 12 seasons ≈ 3 game years). */
  decayPerSeason: 0.944,
  /** Memory entries weaker than this are forgotten. */
  forgetBelow: 0.4,
  /** At or below this they refuse to talk to you at all. */
  refuseAtOrBelow: -45,
  /** Buckets used to choose lines ("hostile" … "devoted"). */
  hostileBelow: -30,
  coldBelow: -8,
  warmFrom: 14,
  devotedFrom: 40,
  /** Relationship labels. */
  friendFrom: 28,
  rivalAtOrBelow: -28,
  enemyAtOrBelow: -50,
  /** Conversation mood. */
  moodFriendlyFrom: 20,
  moodWaryBelow: -8,
  moodHostileBelow: -30,
  /** A conversation is cut short by the NPC when the opinion falls to this. */
  cutOffAtOrBelow: -40,
} as const;

/** Kinship contribution to the base opinion: what `of` feels for the relative `about` (label = what `about` is to `of`). */
export const KIN_OPINION: Record<string, number> = {
  wife: 30, husband: 30, son: 25, daughter: 25, father: 20, mother: 22,
  brother: 14, sister: 14, grandson: 14, granddaughter: 14, grandfather: 12, grandmother: 12,
  uncle: 9, aunt: 9, nephew: 10, niece: 10, cousin: 6,
  'father-in-law': 5, 'mother-in-law': 5, 'son-in-law': 6, 'daughter-in-law': 6, 'brother-in-law': 5, 'sister-in-law': 5,
};

/** Reputation facet weights on how others see you (per point of reputation). */
export const REP_WEIGHT = { honour: 0.2, generosity: 0.12, piety: 0.1, cruelty: -0.22, valour: 0.1 } as const;

/** Small talk and gifts: positive gains shrink with each topic already used with this person today. */
export const RAPPORT = {
  /** Gain multiplier = max(0, 1 − perUse × uses today). */
  perUse: 0.22,
  /** Gifts to the same person on one day. */
  giftPerUse: 0.45,
};

/** Courtship. */
export const COURT = {
  minAge: 14,
  /** Youngest age at which a wedding (or the player's own proposal) is allowed. */
  marryAge: 16,
  /** Progress that may be gained by one person in one day. */
  dailyCap: 0.22,
  /** Their opinion of you must reach this before the courtship can pass 0.6. */
  loveFrom: 26,
  /** Days without contact before progress starts to fade, and how much per day. */
  coolAfterDays: 6,
  coolPerDay: 0.02,
  /** Largest age gap, man older (+) / younger (−) than the woman. */
  maxGapOlder: 22,
  maxGapYounger: 8,
  /** Largest rank-tier difference courtship allows. */
  maxTierGap: 2,
  /** Adults at or above this need a living father's consent if they are noble (tier ≥ 5). */
  minorUntil: 18,
};

export const BARK = {
  /** Minimum days between two barks of the same speaker (≈ 9 s at 1×). */
  cooldownDays: 0.15,
  /** Most barks allowed in one `windowDays` across everyone (≈ 3 s at 1×). */
  windowDays: 0.05,
  windowMax: 3,
};

export const NEWS = {
  /** How fast news travels between settlements (metres per game day). */
  spreadPerDay: 900,
  /** Items older than this are stale (game days; a year is 16). */
  lifetimeDays: 10,
  /** News only travels this far. */
  reach: 6500,
  /** Recorded rumours kept in the save. */
  maxRumours: 40,
  maxTold: 60,
};

export const MEMORY = {
  /** Most memory records kept in the save, and per (who, about). */
  max: 140,
  perPair: 5,
};

export const DEBT = {
  max: 12,
  /** Most a friend lends, as a share of what the lender carries. */
  lendShare: 0.35,
};
