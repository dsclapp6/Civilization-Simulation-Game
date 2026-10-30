// Which icon stands for which game concept (skills, stats, action categories, goods, slots…).
import type { SettlementKind, SkillId, StatId } from '../../core/domain';
import type { ActionCategory } from '../../sim/actions';
import type { EquipSlot, GoodCategory } from '../../sim/economy/types';
import type { OptionKind } from '../../sim/social/types';
import type { IconName } from './icons';

export const SKILL_ICON: Record<SkillId, IconName> = {
  farming: 'farming', husbandry: 'husbandry', hunting: 'hunting', woodcutting: 'woodcutting', mining: 'mining',
  smithing: 'smithing', carpentry: 'carpentry', masonry: 'masonry', tailoring: 'tailoring', brewing: 'brewing',
  trade: 'trade', stewardship: 'stewardship', leadership: 'leadership', persuasion: 'persuasion', melee: 'melee',
  archery: 'archery', riding: 'riding', medicine: 'medicine', letters: 'letters', stealth: 'stealth',
};

export const STAT_ICON: Record<StatId, IconName> = { str: 'str', end: 'end', agi: 'agi', int: 'int', per: 'per', cha: 'cha' };

export const CATEGORY_ICON: Record<ActionCategory, IconName> = {
  work: 'hammer', trade: 'trade', talk: 'talk', use: 'hand', social: 'users', travel: 'signpost', manage: 'key',
  combat: 'swords', rest: 'bed', learn: 'book',
};

export const CATEGORY_LABEL: Record<ActionCategory, string> = {
  work: 'Work', trade: 'Trade', talk: 'Talk', use: 'Use', social: 'Social', travel: 'Travel', manage: 'Manage',
  combat: 'Combat', rest: 'Rest', learn: 'Learn',
};

export const CATEGORY_ORDER: readonly ActionCategory[] = [
  'talk', 'trade', 'work', 'use', 'social', 'learn', 'manage', 'travel', 'rest', 'combat',
];

export const GOOD_ICON: Record<GoodCategory, IconName> = {
  grain: 'wheat', food: 'bread', drink: 'cup', produce: 'apple', material: 'log', textile: 'tailoring', fuel: 'flame',
  metal: 'ingot', tool: 'hammer', weapon: 'melee', armour: 'armour', clothing: 'tunic', livestock: 'sheep', misc: 'box',
};

export const GOOD_CATEGORY_LABEL: Record<GoodCategory, string> = {
  grain: 'Grain', food: 'Food', drink: 'Drink', produce: 'Produce', material: 'Materials', textile: 'Cloth',
  fuel: 'Fuel', metal: 'Metal', tool: 'Tools', weapon: 'Weapons', armour: 'Armour', clothing: 'Clothing',
  livestock: 'Livestock', misc: 'Other',
};

export const SLOT_ICON: Record<EquipSlot, IconName> = {
  main: 'melee', off: 'shield', body: 'tunic', armour: 'armour', helmet: 'helm', back: 'quiver', mount: 'horse',
};

export const SLOT_LABEL: Record<EquipSlot, string> = {
  main: 'Main hand', off: 'Off hand', body: 'Clothing', armour: 'Armour', helmet: 'Head', back: 'Back', mount: 'Mount',
};

export const SLOT_ORDER: readonly EquipSlot[] = ['helmet', 'body', 'armour', 'main', 'off', 'back', 'mount'];

export const SETTLEMENT_ICON: Record<SettlementKind, IconName> = {
  hamlet: 'hut', village: 'village', town: 'walls', city: 'towers', castle: 'castle', abbey: 'church', priory: 'church', nunnery: 'church',
};

export const OPTION_ICON: Record<OptionKind, IconName> = {
  chat: 'talk', ask: 'question', news: 'bell', trade: 'coin', work: 'hammer', learn: 'book', court: 'heart_o', marry: 'ring',
  family: 'tree', request: 'hand', favour: 'hand', gift: 'gift', flatter: 'sparkle', insult: 'frown', threaten: 'dagger',
  bribe: 'purse', persuade: 'persuasion', manage: 'key', leave: 'door',
};

export const OPTION_LABEL: Record<OptionKind, string> = {
  chat: 'Chat', ask: 'Ask', news: 'News', trade: 'Trade', work: 'Work', learn: 'Learn', court: 'Courtship', marry: 'Marriage',
  family: 'Family', request: 'Request', favour: 'Favour', gift: 'Gift', flatter: 'Flattery', insult: 'Insult', threaten: 'Threat',
  bribe: 'Bribe', persuade: 'Persuade', manage: 'Command', leave: 'Farewell',
};
