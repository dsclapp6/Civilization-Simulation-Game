// Pure helpers for the ledger / management panel: household task wording, and which management
// sections the player's authority has unlocked (SPEC §7 "Earned authority").
import type { PersonCard } from '../../sim/api';
import type { HouseholdTask } from '../../sim/economy/types';
import type { Person } from '../../sim/state';
import type { IconName } from './icons';

export const TASK_LABEL: Record<HouseholdTask, string> = {
  fields: 'Work the fields', garden: 'Tend the garden', livestock: 'Mind the animals', craft: 'Work at the craft', brew: 'Brew ale',
  spin: 'Spin and weave', market: 'Go to market', wood: 'Gather wood', service: 'Serve', school: 'Go to school', play: 'Play',
  rest: 'Rest', auto: 'Let them decide', build: 'Work on the building',
};

export const TASK_ORDER: readonly HouseholdTask[] = [
  'auto', 'fields', 'garden', 'livestock', 'wood', 'craft', 'brew', 'spin', 'market', 'service', 'school', 'play', 'rest',
];

export interface AuthoritySlot {
  id: string;
  name: string;
  icon: IconName;
  commands: string;
  unlockedBy: string;
  unlocked: boolean;
}

const has = (p: Person, office: string): boolean => p.offices.some((o) => o.office.toLowerCase().includes(office));

/** The SPEC §7 table, each row with whether this person already holds that authority. */
export function authoritySlots(card: PersonCard, p: Person): AuthoritySlot[] {
  const career = p.career;
  const titles = card.titles;
  return [
    { id: 'self', name: 'Yourself and your belongings', icon: 'user', commands: 'Your own work, goods and purse. You may hire helpers if you can pay and have work.', unlockedBy: 'Anyone', unlocked: true },
    { id: 'household', name: 'Household head', icon: 'home', commands: 'Household members’ daily work, the household purse and stores.', unlockedBy: 'Become head of your household', unlocked: card.isHead },
    {
      id: 'workshop', name: 'Master or merchant', icon: 'hammer', commands: 'A workshop or business: apprentices, journeymen, agents, caravans.',
      unlockedBy: 'Become a master craftsman (after the masterpiece) or a merchant',
      unlocked: (p.career !== 'child' && ['smith', 'carpenter', 'mason', 'tanner', 'weaver', 'tailor', 'baker', 'miller', 'butcher', 'cooper', 'cobbler', 'potter', 'fuller', 'chandler', 'wheelwright', 'saddler'].includes(career) && p.careerStage >= 2)
        || career === 'merchant' || career === 'shopkeeper' || career === 'tavern_keeper',
    },
    { id: 'reeve', name: 'Reeve', icon: 'wheat', commands: 'The village field plan, the labour-service rota and the sale of manor produce.', unlockedBy: 'Be chosen reeve for the year', unlocked: has(p, 'reeve') },
    { id: 'steward', name: 'Bailiff or steward', icon: 'key', commands: 'Rents, fines and labour services; the manor court (steward) on the lord’s behalf.', unlockedBy: 'Be appointed bailiff or steward', unlocked: career === 'bailiff' || career === 'steward' || has(p, 'bailiff') || has(p, 'steward') },
    { id: 'guild', name: 'Guild warden, alderman or mayor', icon: 'scroll', commands: 'Guild rules and quality, town council votes, market rules.', unlockedBy: 'Be elected to a guild or town office', unlocked: has(p, 'warden') || has(p, 'alderman') || has(p, 'mayor') || (CAREER_TOP.includes(career) && p.careerStage >= 3) },
    { id: 'captain', name: 'Sergeant or captain', icon: 'melee', commands: 'Your squad or company in battle.', unlockedBy: 'Rise to sergeant in the lord’s service', unlocked: career === 'sergeant' || has(p, 'captain') },
    { id: 'manor', name: 'Landed knight', icon: 'castle', commands: 'The manor: villagers’ work, buildings, rents and dues, a retinue, local justice.', unlockedBy: 'Hold a manor as a knight', unlocked: titles.some((t) => t.kind === 'manor') || card.rankTier === 5 },
    { id: 'barony', name: 'Baron', icon: 'towers', commands: 'Several manors and a castle, vassal knights, levies, alliances and private war where law allows.', unlockedBy: 'Hold a barony', unlocked: titles.some((t) => t.kind === 'barony') || card.rankTier === 6 },
    { id: 'earl', name: 'Earl or duke', icon: 'crown', commands: 'A county or duchy, vassal barons, a seat on the king’s council.', unlockedBy: 'Hold a county or duchy', unlocked: titles.some((t) => t.kind === 'county') || card.rankTier === 7 },
    { id: 'crown', name: 'King or queen', icon: 'crown', commands: 'The realm: laws, taxes, offices, war and peace, vassals.', unlockedBy: 'Wear the crown', unlocked: titles.some((t) => t.kind === 'kingdom') || card.rankTier === 8 },
    { id: 'church', name: 'Abbot, abbess or bishop', icon: 'church', commands: 'Church estates and their manors, the scriptorium, school and infirmary.', unlockedBy: 'Be elected abbot or abbess, or made bishop', unlocked: career === 'abbot' || career === 'bishop' || career === 'prior' || titles.some((t) => t.kind === 'abbey' || t.kind === 'see') },
  ];
}

const CAREER_TOP = ['smith', 'carpenter', 'mason', 'weaver', 'merchant'];

/** Days → "3 days"; pence/goods → text. Used by the obligations table. */
export function obligationAmount(amount: number, unit: 'pence' | 'days' | 'goods', formatMoney: (p: number) => string): string {
  if (unit === 'pence') return formatMoney(amount);
  if (unit === 'days') return `${amount} ${amount === 1 ? 'day' : 'days'} of labour`;
  return `${amount} ${amount === 1 ? 'measure' : 'measures'} of goods`;
}
