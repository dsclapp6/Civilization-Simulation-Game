// Static game text for the UI: difficulty tiers, stats, skills, traits, conditions, birth classes.
// Historical statements follow SPEC §4 (week-work, merchet, heriot, year and a day, apprenticeship,
// knighthood, the Assize of Arms, holy-day archery); nothing here invents facts beyond the SPEC.
import type { Difficulty, SkillId, StatId } from '../../core/domain';
import type { ConditionId, BirthClass, TraitId } from '../../sim/state';

export interface DifficultyInfo {
  id: Difficulty;
  name: string;
  /** Legacy gold multiplier (SPEC §1). */
  gold: number;
  tagline: string;
  changes: string[];
}

export const DIFFICULTIES: readonly DifficultyInfo[] = [
  {
    id: 'squire', name: 'Squire', gold: 0.5, tagline: 'A gentler road',
    changes: ['Rivals are less aggressive and slower to expand', 'Fewer plagues and famines', 'Gentler prices'],
  },
  {
    id: 'knight', name: 'Knight', gold: 1, tagline: 'The standard trial',
    changes: ['The world as designed', 'No favours, no handicaps'],
  },
  {
    id: 'lord', name: 'Lord', gold: 1.5, tagline: 'Strong rivals',
    changes: ['Rivals start stronger', 'Smarter coalitions against whoever grows', 'Disasters strike more often'],
  },
  {
    id: 'king', name: 'King', gold: 2.5, tagline: 'No mercy',
    changes: ['Ruthless rivals', 'Frequent famine and plague', 'Heavy banditry', 'Your family starts poorer'],
  },
];

export const DIFFICULTY_NOTE = 'Every change is visible. Rivals play by the same rules as you and never cheat in secret.';

export interface StatInfo { id: StatId; name: string; short: string; affects: string }

export const STAT_INFO: Record<StatId, StatInfo> = {
  str: { id: 'str', name: 'Strength', short: 'STR', affects: 'Melee damage, carrying, drawing heavy bows, heavy labour speed' },
  end: { id: 'end', name: 'Endurance', short: 'END', affects: 'Health, stamina, fatigue, resistance to disease' },
  agi: { id: 'agi', name: 'Agility', short: 'AGI', affects: 'Movement speed, attack speed, dodging, riding' },
  int: { id: 'int', name: 'Intellect', short: 'INT', affects: 'Learning speed, literacy, craft quality, management' },
  per: { id: 'per', name: 'Perception', short: 'PER', affects: 'Archery accuracy, spotting, appraising goods, hunting' },
  cha: { id: 'cha', name: 'Charisma', short: 'CHA', affects: 'Persuasion, prices, opinion gain, leadership, courtship' },
};

export const SKILL_NAMES: Record<SkillId, string> = {
  farming: 'Farming', husbandry: 'Husbandry', hunting: 'Hunting', woodcutting: 'Woodcutting', mining: 'Mining',
  smithing: 'Smithing', carpentry: 'Carpentry', masonry: 'Masonry', tailoring: 'Tailoring', brewing: 'Brewing & Cooking',
  trade: 'Trade', stewardship: 'Stewardship', leadership: 'Leadership', persuasion: 'Persuasion', melee: 'Melee',
  archery: 'Archery', riding: 'Riding', medicine: 'Medicine', letters: 'Letters', stealth: 'Stealth',
};

export const SKILL_GROUPS: ReadonlyArray<{ name: string; skills: SkillId[] }> = [
  { name: 'The land', skills: ['farming', 'husbandry', 'hunting', 'woodcutting', 'mining'] },
  { name: 'Crafts', skills: ['smithing', 'carpentry', 'masonry', 'tailoring', 'brewing'] },
  { name: 'Mind and tongue', skills: ['trade', 'stewardship', 'leadership', 'persuasion', 'letters', 'medicine'] },
  { name: 'Arms and the road', skills: ['melee', 'archery', 'riding', 'stealth'] },
];

export interface TraitInfo { name: string; text: string; good: boolean | null }

export const TRAITS: Record<TraitId, TraitInfo> = {
  quick_learner: { name: 'Quick learner', text: 'Gains skill experience faster.', good: true },
  strong_back: { name: 'Strong back', text: 'Carries more and tires less under heavy loads.', good: true },
  keen_eyed: { name: 'Keen-eyed', text: 'Spots what others miss; shoots truer.', good: true },
  sickly: { name: 'Sickly', text: 'Catches illness easily and recovers slowly.', good: false },
  brave: { name: 'Brave', text: 'Holds firm when others flee.', good: true },
  craven: { name: 'Craven', text: 'Loses nerve in danger.', good: false },
  pious: { name: 'Pious', text: 'Finds comfort in the Church; the devout think well of you.', good: null },
  greedy: { name: 'Greedy', text: 'Wants more than their share, and shows it.', good: false },
  honest: { name: 'Honest', text: 'Plain dealing earns trust and costs bargains.', good: null },
  deceitful: { name: 'Deceitful', text: 'Lies easily; is believed less when caught.', good: null },
  ambitious: { name: 'Ambitious', text: 'Strives to rise, and resents those in the way.', good: null },
  content: { name: 'Content', text: 'Happy with a quiet life; harder to unsettle.', good: null },
  hot_tempered: { name: 'Hot-tempered', text: 'Quick to anger and to blows.', good: false },
  patient: { name: 'Patient', text: 'Steady in long tasks and long quarrels.', good: true },
  comely: { name: 'Comely', text: 'Pleasing to look on; helps in courtship and bargaining.', good: true },
  scarred: { name: 'Scarred', text: 'Carries the marks of an old wound.', good: false },
  lame: { name: 'Lame', text: 'A crippled leg slows every step.', good: false },
};

export interface ConditionInfo { name: string; text: string }

export const CONDITIONS: Record<ConditionId, ConditionInfo> = {
  fever: { name: 'Fever', text: 'Hot and shaking; rest, warmth and food help.' },
  flux: { name: 'The flux', text: 'A bloody flux; weakens quickly without care.' },
  consumption: { name: 'Consumption', text: 'A slow wasting cough; often fatal.' },
  plague: { name: 'Plague', text: 'The pestilence. Few recover.' },
  wasting: { name: 'Wasting', text: 'Flesh and strength falling away.' },
  frailty: { name: 'Frailty', text: 'The weakness of great age.' },
  injury: { name: 'Wounded', text: 'A wound that needs rest and care to heal.' },
  childbed: { name: 'Childbed', text: 'Recovering from a birth.' },
  lame: { name: 'Lame', text: 'A permanent injury to the leg.' },
};

export interface BirthClassInfo {
  /** "serf stock" style phrase after "born of …" */
  label: string;
  /** What the class is called in menus. */
  name: string;
  /** What life holds (SPEC §4, §6). */
  life: string;
  /** Short rank/estate line. */
  estate: string;
}

export const BIRTH_CLASSES: Record<BirthClass, BirthClassInfo> = {
  serf: {
    name: 'Serf', label: 'serf stock', estate: 'Unfree — a villein bound to the manor',
    life: 'You are bound to your lord’s manor. You will owe week-work on his land, two or three days in a week and more in summer, and boon-work at ploughing and harvest. Merchet is due when a daughter marries, and heriot, the best beast, when the head of the house dies. Yet a serf who lives a year and a day in a chartered town without being claimed may go free.',
  },
  free: {
    name: 'Free peasant', label: 'free peasant stock', estate: 'Free — a tenant of the open fields',
    life: 'You are free: you rent your strips, owe no week-work, and may marry, move and bargain as you please. Freemen must keep arms according to their wealth for the lord’s levy, and on holy days able men practise at the butts. Land, a trade or a good marriage can lift a free family a long way.',
  },
  craftsman: {
    name: 'Craftsman', label: 'a craftsman’s family', estate: 'Free — a family with a trade',
    life: 'Your family has a trade. At fourteen a master may take you as an apprentice — about seven years of service — then you are a paid journeyman until a masterpiece, judged by the guild’s masters, makes you a master with a shop of your own. Freedom of the town comes by apprenticeship, patrimony or a fee.',
  },
  merchant: {
    name: 'Merchant', label: 'a merchant family', estate: 'Free — townsfolk of means',
    life: 'Your family deals in goods. Buy low, sell high between markets, mind the tolls and the bandits on the road, and keep your credit good: lending to lords is a merchant’s road to power. Capital is the key that opens everything.',
  },
  gentry: {
    name: 'Gentry', label: 'the gentry', estate: 'Gentry — esquires, stewards, great merchants',
    life: 'You are of the gentry. Letters and good connections open doors: a place in a great household, a steward’s office, a rich marriage — and, if horse and armour can be found, a knight’s spurs.',
  },
  knightly: {
    name: 'Knightly', label: 'a knightly house', estate: 'Noble — a knight’s child',
    life: 'You are born to a knightly house. A page learns riding and arms in a lord’s household, a squire from fourteen serves a knight, and at eighteen to twenty-one you may be knighted — if the horse and armour can be afforded, or a patron will pay.',
  },
  baronial: {
    name: 'Baronial', label: 'a great house', estate: 'Noble — a baron’s child',
    life: 'You are born to a great house: a baron holds several manors and a castle, with vassal knights and levies to call on. Much will be asked of you, and friends and rivals alike will be watching what you do with it.',
  },
};

export const BIRTH_CLASS_ORDER: readonly BirthClass[] = ['serf', 'free', 'craftsman', 'merchant', 'gentry', 'knightly', 'baronial'];

/** Short hints shown on the loading screen. */
export const LOADING_TIPS: readonly string[] = [
  'A year lasts sixteen days. A day lasts a minute, and the fourth day of every season is a holy day.',
  'Your family can carry on after you: when you die, you choose who to be next.',
  'Serfs who live a year and a day in a chartered town, unclaimed, may go free.',
  'Prices differ from market to market, and from season to season. Carry goods and profit by the road.',
  'Nothing is hidden: rivals play by the same rules as you, and wounds are the same for everyone.',
  'Perks are chosen at skill levels 5, 10, 15 and 20: one of two.',
  'Hunger blocks training. Eat well to grow strong.',
  'Fast speeds are refused while an enemy is near. Pause is always allowed.',
  'A master takes an apprentice for about seven years, and a fee.',
  'On holy days, able men practise at the butts. Archery makes a yeoman.',
];

export const UI_HINTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'Tab', label: 'Character' },
  { key: 'I', label: 'Inventory' },
  { key: 'H', label: 'Family' },
  { key: 'J', label: 'Ledger' },
  { key: 'M', label: 'Map' },
  { key: 'L', label: 'Chronicle' },
  { key: 'Z', label: 'Rest' },
  { key: 'Esc', label: 'Menu' },
];
