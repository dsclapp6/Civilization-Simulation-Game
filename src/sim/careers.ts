// Career table for the macro simulation (SPEC §6 "Choosing a field"). A career is a job family;
// `Person.careerStage` is the rung on its ladder (apprentice → journeyman → master, novice → monk …).
// Data only: no state imports, so every sim module (and later waves) can depend on it.
import type { RankTier, SkillId, StatId, Sex } from '../core/domain';

export type CareerField =
  | 'none' | 'land' | 'husbandry' | 'brewing' | 'craft' | 'trade' | 'arms' | 'knighthood'
  | 'church' | 'service' | 'healing' | 'noble' | 'outlaw';

export type CareerId =
  | 'child' | 'none'
  | 'farmer' | 'cottar' | 'labourer' | 'yeoman' | 'woodward' | 'shepherd' | 'swineherd'
  | 'alewife' | 'tavern_keeper' | 'cook'
  | 'smith' | 'carpenter' | 'mason' | 'tanner' | 'weaver' | 'tailor' | 'baker' | 'miller' | 'butcher'
  | 'cooper' | 'cobbler' | 'potter' | 'fuller' | 'chandler' | 'wheelwright' | 'saddler' | 'fisher'
  | 'merchant' | 'peddler' | 'shopkeeper'
  | 'soldier' | 'archer' | 'man_at_arms' | 'sergeant' | 'squire' | 'page' | 'knight'
  | 'priest' | 'monk' | 'nun' | 'prior' | 'abbot' | 'bishop' | 'clerk'
  | 'servant' | 'steward' | 'bailiff'
  | 'healer' | 'midwife'
  | 'lord' | 'lady' | 'noble' | 'beggar' | 'outlaw';

export interface CareerDef {
  label: string;
  field: CareerField;
  /** Skills trained by the work; the first is the primary one. */
  skills: SkillId[];
  /** Stats this work keeps at full strength (others settle slightly lower in adults). */
  uses: StatId[];
  /** Typical rank tier per ladder stage (last entry repeats). */
  tiers: RankTier[];
  /** Historical sex restriction, if any (SPEC §6). */
  sex?: Sex;
  /** Age at which people normally begin this career. */
  startAge: number;
}

const D = (label: string, field: CareerField, skills: SkillId[], uses: StatId[], tiers: RankTier[], startAge = 14, sex?: Sex): CareerDef =>
  ({ label, field, skills, uses, tiers, startAge, sex });

export const CAREERS: Record<CareerId, CareerDef> = {
  child: D('Child', 'none', [], [], [1], 0),
  none: D('Householder', 'none', [], [], [1], 14),
  farmer: D('Farmer', 'land', ['farming', 'husbandry'], ['str', 'end'], [1, 1, 2, 3], 12),
  cottar: D('Cottar', 'land', ['farming', 'woodcutting'], ['str', 'end'], [1], 12),
  labourer: D('Labourer', 'land', ['farming', 'woodcutting'], ['str', 'end'], [2], 12),
  yeoman: D('Yeoman', 'land', ['farming', 'husbandry', 'archery'], ['str', 'end'], [3], 14),
  woodward: D('Woodward', 'land', ['woodcutting', 'hunting'], ['str', 'per'], [2], 16),
  shepherd: D('Shepherd', 'husbandry', ['husbandry', 'medicine'], ['end', 'per'], [1, 2], 12),
  swineherd: D('Swineherd', 'husbandry', ['husbandry', 'hunting'], ['end', 'per'], [1], 12),
  alewife: D('Alewife', 'brewing', ['brewing', 'trade'], ['int', 'cha'], [2, 2, 3], 18),
  tavern_keeper: D('Tavern keeper', 'brewing', ['brewing', 'trade', 'persuasion'], ['int', 'cha'], [3], 20),
  cook: D('Cook', 'brewing', ['brewing'], ['end'], [1, 2], 14),
  smith: D('Smith', 'craft', ['smithing', 'mining'], ['str', 'end'], [2, 2, 3, 4], 13, 'm'),
  carpenter: D('Carpenter', 'craft', ['carpentry', 'woodcutting'], ['str', 'agi'], [2, 2, 3, 4], 13, 'm'),
  mason: D('Mason', 'craft', ['masonry', 'mining'], ['str', 'end'], [2, 2, 3, 4], 13, 'm'),
  tanner: D('Tanner', 'craft', ['tailoring', 'trade'], ['str', 'end'], [2, 2, 3, 4], 13, 'm'),
  weaver: D('Weaver', 'craft', ['tailoring', 'trade'], ['agi', 'per'], [2, 2, 3, 4], 12),
  tailor: D('Tailor', 'craft', ['tailoring', 'trade'], ['agi', 'per'], [2, 2, 3, 4], 13),
  baker: D('Baker', 'craft', ['brewing', 'trade'], ['str', 'end'], [2, 2, 3, 4], 13),
  miller: D('Miller', 'craft', ['farming', 'trade', 'stewardship'], ['str', 'int'], [2, 2, 3, 4], 14, 'm'),
  butcher: D('Butcher', 'craft', ['husbandry', 'trade'], ['str', 'end'], [2, 2, 3, 4], 13, 'm'),
  cooper: D('Cooper', 'craft', ['carpentry', 'woodcutting'], ['str', 'agi'], [2, 2, 3, 4], 13, 'm'),
  cobbler: D('Cobbler', 'craft', ['tailoring', 'trade'], ['agi', 'per'], [2, 2, 3, 4], 13, 'm'),
  potter: D('Potter', 'craft', ['masonry', 'trade'], ['agi', 'per'], [2, 2, 3, 4], 13),
  fuller: D('Fuller', 'craft', ['tailoring', 'trade'], ['str', 'end'], [2, 2, 3, 4], 13, 'm'),
  chandler: D('Chandler', 'craft', ['brewing', 'trade'], ['int', 'per'], [2, 2, 3, 4], 13),
  wheelwright: D('Wheelwright', 'craft', ['carpentry', 'smithing'], ['str', 'agi'], [2, 2, 3, 4], 13, 'm'),
  saddler: D('Saddler', 'craft', ['tailoring', 'riding'], ['agi', 'per'], [2, 2, 3, 4], 13, 'm'),
  fisher: D('Fisher', 'husbandry', ['hunting', 'trade'], ['end', 'per'], [1, 2], 12),
  merchant: D('Merchant', 'trade', ['trade', 'persuasion', 'letters'], ['int', 'cha'], [2, 3, 3, 4], 16),
  peddler: D('Peddler', 'trade', ['trade', 'persuasion'], ['end', 'cha'], [2], 16),
  shopkeeper: D('Shopkeeper', 'trade', ['trade', 'persuasion'], ['int', 'cha'], [2, 3], 16),
  soldier: D('Soldier', 'arms', ['melee', 'archery'], ['str', 'end'], [2], 16, 'm'),
  archer: D('Archer', 'arms', ['archery', 'melee'], ['str', 'per'], [2], 15, 'm'),
  man_at_arms: D('Man-at-arms', 'arms', ['melee', 'riding'], ['str', 'end'], [2, 2, 3], 16, 'm'),
  sergeant: D('Sergeant', 'arms', ['melee', 'leadership', 'riding'], ['str', 'end'], [3], 20, 'm'),
  squire: D('Squire', 'knighthood', ['melee', 'riding', 'leadership'], ['str', 'agi'], [4], 14, 'm'),
  page: D('Page', 'knighthood', ['riding', 'melee'], ['agi'], [4], 7, 'm'),
  knight: D('Knight', 'knighthood', ['melee', 'riding', 'leadership', 'stewardship'], ['str', 'end'], [5], 18, 'm'),
  priest: D('Priest', 'church', ['letters', 'persuasion', 'medicine'], ['int', 'cha'], [2], 20, 'm'),
  monk: D('Monk', 'church', ['letters', 'brewing', 'medicine'], ['int', 'end'], [2, 3, 4, 6], 16, 'm'),
  nun: D('Nun', 'church', ['letters', 'medicine', 'tailoring'], ['int', 'end'], [2, 2, 4, 6], 16, 'f'),
  prior: D('Prior', 'church', ['letters', 'stewardship', 'leadership'], ['int', 'cha'], [4], 30),
  abbot: D('Abbot', 'church', ['letters', 'stewardship', 'leadership'], ['int', 'cha'], [6], 35),
  bishop: D('Bishop', 'church', ['letters', 'persuasion', 'stewardship'], ['int', 'cha'], [6], 35, 'm'),
  clerk: D('Clerk', 'service', ['letters', 'stewardship'], ['int'], [3], 16),
  servant: D('Servant', 'service', ['brewing', 'tailoring'], ['end'], [1], 11),
  steward: D('Steward', 'service', ['stewardship', 'letters', 'leadership'], ['int', 'cha'], [4], 25),
  bailiff: D('Bailiff', 'service', ['stewardship', 'persuasion'], ['int', 'cha'], [3, 4], 22),
  healer: D('Healer', 'healing', ['medicine', 'letters'], ['int', 'per'], [2, 3, 4], 16),
  midwife: D('Midwife', 'healing', ['medicine'], ['int', 'per'], [2], 25, 'f'),
  lord: D('Lord', 'noble', ['leadership', 'stewardship', 'melee', 'riding'], ['str', 'cha'], [5, 6, 7, 8], 18, 'm'),
  lady: D('Lady', 'noble', ['stewardship', 'persuasion', 'tailoring'], ['int', 'cha'], [5, 6, 7, 8], 16, 'f'),
  noble: D('Noble', 'noble', ['riding', 'persuasion', 'letters'], ['cha'], [4, 5, 6, 7, 8], 14),
  beggar: D('Beggar', 'none', ['persuasion'], ['end'], [1], 14),
  outlaw: D('Outlaw', 'outlaw', ['stealth', 'archery', 'hunting'], ['agi', 'per'], [1], 16),
};

/** Ladder stage names by field (index = careerStage). */
export const STAGE_LABELS: Record<CareerField, readonly string[]> = {
  none: [''],
  land: ['Farmhand', 'Tenant', 'Free tenant', 'Yeoman'],
  husbandry: ['Herd', 'Shepherd', 'Flockmaster'],
  brewing: ['Brewer', 'Alewife', 'Alehouse keeper'],
  craft: ['Apprentice', 'Journeyman', 'Master', 'Guild warden'],
  trade: ['Peddler', 'Merchant', 'Great merchant', 'Alderman'],
  arms: ['Levy', 'Man-at-arms', 'Sergeant', 'Captain'],
  knighthood: ['Page', 'Squire', 'Knight'],
  church: ['Novice', 'Brother', 'Prior', 'Abbot'],
  service: ['Servant', 'Clerk', 'Bailiff', 'Steward'],
  healing: ['Herbalist', 'Healer', 'Physician'],
  noble: ['Noble', 'Noble', 'Noble', 'Noble', 'Noble'],
  outlaw: ['Poacher', 'Outlaw', 'Band leader'],
};

export function careerDef(id: CareerId): CareerDef { return CAREERS[id]; }

export function tierForStage(id: CareerId, stage: number): RankTier {
  const t = CAREERS[id].tiers;
  return t[Math.min(stage, t.length - 1)];
}

/** Human-readable role, e.g. "Master Smith", "Apprentice Baker", "Abbess". */
export function roleLabel(career: CareerId, stage: number, sex: Sex): string {
  const def = CAREERS[career];
  if (career === 'child') return sex === 'm' ? 'Boy' : 'Girl';
  if (career === 'abbot') return sex === 'f' ? 'Abbess' : 'Abbot';
  if (career === 'prior') return sex === 'f' ? 'Prioress' : 'Prior';
  if (career === 'monk') return sex === 'f' ? 'Nun' : stage === 0 ? 'Novice' : 'Monk';
  if (career === 'nun') return stage === 0 ? 'Novice' : 'Nun';
  if (career === 'lady') return 'Lady';
  if (career === 'noble') return sex === 'f' ? 'Gentlewoman' : 'Gentleman';
  if (career === 'lord') return sex === 'f' ? 'Lady' : 'Lord';
  if (def.field === 'craft') {
    const st = ['Apprentice', 'Journeyman', 'Master', 'Warden'][Math.min(stage, 3)];
    return `${st} ${def.label}`;
  }
  if (def.field === 'land') return STAGE_LABELS.land[Math.min(stage, 3)];
  return def.label;
}

/** Careers by field, used when assigning jobs to coming-of-age children. */
export const CRAFT_CAREERS: readonly CareerId[] = [
  'smith', 'carpenter', 'mason', 'tanner', 'weaver', 'tailor', 'baker', 'miller', 'butcher', 'cooper',
  'cobbler', 'potter', 'fuller', 'chandler', 'wheelwright', 'saddler',
];
/** Crafts that appear in villages (the rest are town trades). */
export const VILLAGE_CRAFTS: readonly CareerId[] = ['smith', 'carpenter', 'weaver', 'cobbler', 'wheelwright', 'baker'];
