// Tunables of the law (docs/CIV.md §4, docs/LAW.md). Distances in metres, times in simulated seconds unless a name says days.
// A game day is ten minutes at 1×, so "a day" below is long: sentences are a few days, fines are pence.

export const LAW = {
  // ---- being seen ----
  /** How often the watch looks at the player (s). */
  watchPeriod: 0.5,
  /** How far a person of the land sees a stranger (m): by day, at night, with a torch about, and what rain and fog take off. */
  sightDay: 80,
  sightNight: 26,
  sightTorch: 48,
  /** An armed man of the land who sees a trespasser acts at once when he is this near (m). */
  armedNear: 55,
  /** Seconds between being seen and a patrol being on its way when nobody armed is near (the report goes to the castle or manor). */
  reportDelay: [7, 16] as const,
  /** An armed man of the land who sees a trespasser on private land whistles up the others: seconds of delay. */
  armedDelay: [3, 8] as const,
  /** On hostile land the watch reacts at once to armed men and known enemies: seconds of delay. */
  hostileDelay: [0.5, 3] as const,

  // ---- the patrol ----
  /** Where a patrol appears when it rides in from the edge of sight (m from the player; just inside the zone's "seen" radius, so nobody is hurried). */
  spawnRadius: 168,
  /** The spawn point may be this much nearer or farther (m) to find walkable ground. */
  spawnSlack: 14,
  /** Nearest an arriving patrol halts to the player (m), and how far a halted player may stray before it is flight. */
  haltDistance: 3.4,
  haltStray: 10,
  /** Seconds the leader waits for an answer at the halt before he loses patience (warning, then the fight). */
  patience: 70,
  /** How far behind the escorted trespasser the patrol follows (m). */
  escortGap: 6,
  /** The escort's time to be off the land: `exit distance / pace + base`, clamped (s). */
  escortPace: 2.0,
  escortBase: 18,
  escortMin: 45,
  escortMax: 150,
  /** A trespasser who comes back onto the land within this many seconds of being escorted off it is attacked. */
  comeBack: 240,
  /** The patrol leaves when nothing has happened for this long (s), and the men have to be this far away to be dismissed (m). */
  goneDistance: 150,
  /** A leader farther than this from his prisoner (m) waits for him when leading him. */
  ledGap: 5.5,
  /** Farther than this (m) from the cell, the walk is a march: it begins in sight and the clock carries the rest. */
  marchDistance: 240,
  /** Men with the leader: 1–3 (one more at war). */
  menMin: 1,
  menMax: 3,
  /** Most trespassers a settlement will have patrols after at once. */
  maxPatrols: 1,

  // ---- business, bribes and fines ----
  /** Days of leave a granted business gives (from the quality of the reason). */
  leaveDays: { request: 2, market: 1, rank: 1.5, bribe: 0.5, charm: 0.75, fine: 0.2 },
  /** Base pence of the fines by kind of land, and the multiplier for poaching. */
  fineBase: { demesne: 3, park: 6, castle: 9 } as const,
  poachFactor: 2.2,
  /** A bribe is this many pence per rank tier of the leader (at least `bribeMin`). */
  bribePerTier: 6,
  bribeMin: 8,

  // ---- captivity ----
  /** Days a captive is kept before the lord loses patience and sets a sentence. */
  patienceDays: 6,
  /** Sentence in days by kind, [min, max]. */
  sentence: { trespass: [1, 2], poaching: [2, 3], crime: [3, 6], war: [0, 0] } as const,
  /** Fine in pence by kind (before the lord's temper and the captive's rank). */
  fine: { trespass: [6, 12], poaching: [12, 24], crime: [30, 60], war: [0, 0] } as const,
  /** A day of serving a sentence is worth this many pence to the lord's works. */
  labourDayValue: 3,
  /** Days after being taken before a cruel lord may hang a man he warned, and the chance per dawn after that. */
  hangAfterDays: 1,
  hangChance: 0.35,
  /** Cruelty (reputation, -100..100) a lord needs to hang. */
  cruelLord: 40,
  /** Days an escaped prisoner is wanted on the lord's lands. */
  wantedDays: 8,
  /** Extra days of sentence and fine for a failed escape. */
  escapePenaltyDays: 3,
  /** Chance of the family paying a fine or ransom each day once it has the money and cares (after `payAfterDays`). */
  payAfterDays: 2,

  // ---- AI cases handled off-screen (daily, cheap) ----
  /** Settlements looked at per day, and the most prisoners the law holds at once. */
  daily: 6,
  maxHeld: 36,
  /** Chance per looked-at settlement per day that a poacher tries (before desperation and the park's size), and of a bandit being caught. */
  poachRate: 0.12,
  banditRate: 0.2,
  scoutRate: 0.1,
} as const;

/** Careers that are the lord's armed men (leaders and patrol men come from them). */
export const ARMED_CAREERS: ReadonlySet<string> = new Set(['knight', 'sergeant', 'man_at_arms', 'soldier', 'archer', 'squire']);
/** Careers that give orders: patrol leaders by preference. */
export const LEADER_ORDER: readonly string[] = ['knight', 'sergeant', 'man_at_arms', 'soldier', 'archer', 'squire'];
/** Offices that send men after a trespasser when the lord keeps no soldiers. */
export const LAW_OFFICES: ReadonlySet<string> = new Set(['sheriff', 'bailiff', 'reeve', 'steward', 'marshal']);

/** Save format of `state.ext['law']`. */
export const LAW_VERSION = 1;
export const EXT_KEY = 'law';
