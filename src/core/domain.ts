// Domain enums shared by world generation, simulation, assets, renderer and UI.
// Adding members is fine; renaming or removing breaks other modules.

export type CultureId = 'anglo' | 'franc' | 'gael' | 'cymric' | 'norse' | 'teuton';
export const CULTURES: readonly CultureId[] = ['anglo', 'franc', 'gael', 'cymric', 'norse', 'teuton'];

export type Sex = 'm' | 'f';

/** Rank tiers (SPEC §4): used for authority and for "equal rank" switching. */
export type RankTier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const RANK_NAMES = ['', 'Unfree', 'Commoner', 'Middling', 'Gentry', 'Knight', 'Baron', 'Magnate', 'Royal'] as const;

export type Estate = 'unfree' | 'free' | 'clergy' | 'noble';

export type SettlementKind = 'hamlet' | 'village' | 'town' | 'city' | 'castle' | 'abbey' | 'priory' | 'nunnery';

export type AnimalKind =
  | 'horse' | 'ox' | 'cow' | 'sheep' | 'pig' | 'goat' | 'chicken' | 'goose' | 'dog' | 'cat'
  | 'deer' | 'boar' | 'wolf' | 'fox' | 'hare';

export type CropKind =
  | 'wheat' | 'rye' | 'barley' | 'oats' | 'peas' | 'beans' | 'flax'
  | 'cabbage' | 'onions' | 'leeks' | 'turnips' | 'fallow';

export type StatId = 'str' | 'end' | 'agi' | 'int' | 'per' | 'cha';
export const STATS: readonly StatId[] = ['str', 'end', 'agi', 'int', 'per', 'cha'];
export const STAT_NAMES: Record<StatId, string> = {
  str: 'Strength', end: 'Endurance', agi: 'Agility', int: 'Intellect', per: 'Perception', cha: 'Charisma',
};
/** Natural and upgrade cap for any stat (SPEC §1, §5). */
export const STAT_CAP = 18;

export type SkillId =
  | 'farming' | 'husbandry' | 'hunting' | 'woodcutting' | 'mining' | 'smithing' | 'carpentry'
  | 'masonry' | 'tailoring' | 'brewing' | 'trade' | 'stewardship' | 'leadership' | 'persuasion'
  | 'melee' | 'archery' | 'riding' | 'medicine' | 'letters' | 'stealth';
export const SKILLS: readonly SkillId[] = [
  'farming', 'husbandry', 'hunting', 'woodcutting', 'mining', 'smithing', 'carpentry',
  'masonry', 'tailoring', 'brewing', 'trade', 'stewardship', 'leadership', 'persuasion',
  'melee', 'archery', 'riding', 'medicine', 'letters', 'stealth',
];

export type Difficulty = 'squire' | 'knight' | 'lord' | 'king';
export const DIFFICULTY_GOLD: Record<Difficulty, number> = { squire: 0.5, knight: 1, lord: 1.5, king: 2.5 };
