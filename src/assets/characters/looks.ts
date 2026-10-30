// Reference look generator: period-plausible dress by rank tier (SPEC §4), sex, age and
// culture. Pure data (no three.js) so the sim can mirror it; the gallery uses it directly.
// Rank reads at a glance: undyed russet → faded earth tones → woad/madder dyes →
// rich colours with trim → heraldry over mail → fur, scarlet and gold.
import type { CultureId, RankTier, Sex } from '../../core/domain';
import type { CharacterLook, ClothingLook, Headwear, TunicStyle } from '../../core/view';
import type { Rng } from '../../core/rng';
import { PALETTE } from '../palette';

export type Role =
  | 'peasant' | 'craftsman' | 'merchant' | 'noble' | 'royal' | 'priest' | 'monk' | 'nun' | 'bishop'
  | 'soldier' | 'archer' | 'man_at_arms' | 'knight' | 'child' | 'elder';

export interface LookRequest {
  tier: RankTier;
  sex: Sex;
  age: number;
  culture: CultureId;
  role?: Role;
}

const ERMINE = 0xf4f1ea;
const LINEN = 0xece4d2;

function tone(rng: Rng, base: number, spread = 0.08): number {
  const k = 1 + (rng.next() - 0.5) * spread * 2;
  const r = Math.min(255, Math.round(((base >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((base >> 8) & 255) * k));
  const b = Math.min(255, Math.round((base & 255) * k));
  return (r << 16) | (g << 8) | b;
}

function pickDye(rng: Rng, tier: RankTier): number { return tone(rng, rng.pick(PALETTE.dyes[tier])); }

export function heraldryFor(rng: Rng): { field: number; charge: number; pattern: number } {
  const tinctures = [0xb01c24, 0x1c3f94, 0x1d6a2e, 0x111111, 0x5a1a6a];
  const metals = [0xe8c64a, 0xf2efe6];
  const field = rng.chance(0.75) ? rng.pick(tinctures) : rng.pick(metals);
  const charge = metals.includes(field) ? rng.pick(tinctures) : rng.pick(metals);
  return { field, charge, pattern: rng.int(0, 11) };
}

export function generateLook(rng: Rng, req: LookRequest): CharacterLook {
  const { tier, sex, culture } = req;
  const age = req.age;
  const child = age < 14;
  const role: Role = req.role ?? (child ? 'child' : age > 62 ? 'elder' : tier >= 8 ? 'royal' : tier >= 5 ? 'noble' : tier >= 3 ? 'craftsman' : 'peasant');
  const female = sex === 'f';
  // body
  const baseH = female ? 1.62 : 1.73;
  const childH = 1.0 + (Math.min(13, Math.max(6, age)) - 6) * 0.075;
  const height = child ? childH * (0.96 + rng.next() * 0.08) : (baseH + rng.gauss(0, 0.05)) * (tier >= 5 ? 1.02 : 1) * (age > 65 ? 0.97 : 1);
  const build = Math.max(0, Math.min(1, rng.gauss(tier >= 4 && age > 30 ? 0.6 : 0.42, 0.18)));
  const skinIdx = culture === 'norse' || culture === 'gael' ? rng.int(0, 2) : rng.int(0, 3);
  const skin = PALETTE.skinTones[skinIdx];
  const hairPool = culture === 'norse' ? [4, 5, 5, 3, 6] : culture === 'gael' || culture === 'cymric' ? [6, 3, 2, 1, 0, 4] : [0, 1, 1, 2, 2, 3, 4];
  const hair = PALETTE.hairColors[rng.pick(hairPool)];
  let hairStyle: number;
  if (female) hairStyle = child ? rng.pick([3, 4, 5]) : rng.pick([4, 5, 6, 3, 2]);
  else hairStyle = child ? rng.pick([0, 1, 1, 2]) : culture === 'norse' ? rng.pick([2, 3, 0, 5]) : rng.pick([0, 1, 1, 2, 0]);
  let beard = 0;
  if (!female && age >= 18) {
    const p = culture === 'norse' || culture === 'gael' ? 0.75 : tier >= 5 ? 0.35 : 0.5;
    if (rng.chance(p)) beard = age > 50 ? rng.int(2, 4) : rng.int(1, 3);
  }
  // clothing
  let tunicStyle: TunicStyle;
  let headwear: Headwear = 'none';
  let headColor: number | undefined;
  let cloak: number | undefined, apron: number | undefined, belt: number | undefined, trim: number | undefined;
  let shoes: ClothingLook['shoes'] = 'shoes';
  let tunic = pickDye(rng, tier);
  let legs = tone(rng, female ? 0x6a5a48 : rng.pick([0x5a4a38, 0x6a5a44, 0x4a4a3a]));
  const undyed = tone(rng, rng.pick([0x9a8a70, 0x8c7b62, 0x7a6a52, 0xa49478]));

  switch (role) {
    case 'child':
      tunicStyle = female ? 'long' : 'short';
      tunic = tier <= 2 ? undyed : pickDye(rng, tier);
      shoes = tier <= 2 && rng.chance(0.6) ? 'bare' : 'shoes';
      legs = shoes === 'bare' && !female ? skin : legs;
      if (rng.chance(0.3)) headwear = female ? 'coif' : 'hood';
      if (tier >= 5) { trim = pickDye(rng, tier); }
      belt = rng.chance(0.5) ? 0x5a3b26 : undefined;
      break;
    case 'monk':
      tunicStyle = 'habit'; tunic = rng.pick([0x2a2420, 0x6a5038, 0xd8d0bc]); headwear = rng.chance(0.4) ? 'hood' : 'none';
      headColor = tunic; hairStyle = 7; beard = 0; shoes = 'shoes';
      break;
    case 'nun':
      tunicStyle = 'habit'; tunic = rng.pick([0x1e1a18, 0x2a2420]); headwear = 'wimple'; headColor = 0x1e1a18; shoes = 'shoes';
      break;
    case 'priest':
      tunicStyle = 'robe'; tunic = rng.pick([0x1e1a18, 0x3a2a24]); headwear = rng.chance(0.5) ? 'coif' : 'none'; headColor = 0x1e1a18;
      hairStyle = 7; beard = 0; trim = 0xe8e2d2;
      break;
    case 'bishop':
      tunicStyle = 'robe'; tunic = rng.pick([0xe8e2d2, 0x8a1a2a, 0x6a1a7a]); headwear = 'mitre'; headColor = 0xf2ede2;
      cloak = 0xb8902a; trim = 0xd4af37; hairStyle = 7; shoes = 'shoes';
      break;
    case 'soldier':
      tunicStyle = 'short'; tunic = pickDye(rng, 2); headwear = 'none'; shoes = 'shoes'; belt = 0x4a3020;
      break;
    case 'archer':
      tunicStyle = 'short'; tunic = rng.pick([0x5a6a3a, 0x6a5a3a, 0x7a6a4a]); headwear = rng.chance(0.5) ? 'hood' : 'none';
      headColor = tone(rng, 0x4a5a2a); shoes = 'shoes'; belt = 0x4a3020;
      break;
    case 'man_at_arms':
      tunicStyle = rng.chance(0.5) ? 'surcoat' : 'short'; shoes = 'boots'; belt = 0x3a2618;
      break;
    case 'knight':
      tunicStyle = 'surcoat'; shoes = 'boots'; belt = 0x3a2618;
      break;
    default: {
      // civilian by tier
      if (tier === 1) {
        tunic = undyed;
        tunicStyle = female ? 'long' : rng.chance(0.25) ? 'rags' : 'short';
        legs = female ? legs : rng.chance(0.4) ? skin : tone(rng, 0x6a5a44);
        shoes = rng.chance(0.55) ? 'bare' : 'shoes';
        headwear = female ? rng.pick(['coif', 'veil', 'none'] as const) : rng.pick(['hood', 'none', 'none', 'straw_hat'] as const);
        headColor = female ? tone(rng, 0xd8ccb4) : tone(rng, 0x7a6a50);
        if (female) apron = tone(rng, 0xc8bca0);
        belt = rng.chance(0.4) ? 0x9a8460 : undefined;
      } else if (tier === 2) {
        tunicStyle = female ? 'long' : 'short';
        headwear = female ? rng.pick(['veil', 'coif', 'wimple'] as const) : rng.pick(['hood', 'hood', 'coif', 'straw_hat', 'none'] as const);
        headColor = female ? LINEN : tone(rng, rng.pick([0x8a3a2a, 0x4a5a6a, 0x6a6a3a]));
        if (female && rng.chance(0.6)) apron = tone(rng, 0xd8ccb4);
        belt = 0x5a3b26;
      } else if (tier === 3) {
        tunicStyle = female ? 'gown' : 'long';
        headwear = female ? rng.pick(['wimple', 'veil'] as const) : rng.pick(['hood', 'felt_hat', 'coif'] as const);
        headColor = female ? LINEN : pickDye(rng, 3);
        belt = 0x4a3020; shoes = rng.chance(0.4) ? 'boots' : 'shoes';
        if (rng.chance(0.3)) apron = female ? tone(rng, 0xe0d6c0) : tone(rng, 0x6a4a2a);
        if (rng.chance(0.35)) cloak = pickDye(rng, 2);
      } else if (tier === 4) {
        tunicStyle = female ? 'gown' : 'long';
        headwear = female ? rng.pick(['wimple', 'veil'] as const) : rng.pick(['felt_hat', 'hood'] as const);
        headColor = female ? LINEN : pickDye(rng, 4);
        trim = tone(rng, rng.pick([0xc8a646, 0x8a6a3a, 0xd8d0c0]));
        cloak = pickDye(rng, 4); belt = 0x3a2618; shoes = 'boots';
      } else if (tier <= 6) {
        tunicStyle = female ? 'gown' : rng.chance(0.5) ? 'robe' : 'long';
        headwear = female ? rng.pick(['wimple', 'circlet', 'veil'] as const) : rng.pick(['felt_hat', 'none', 'circlet'] as const);
        headColor = female ? LINEN : pickDye(rng, tier);
        trim = tier === 6 ? ERMINE : tone(rng, 0xd4af37, 0.03);
        cloak = pickDye(rng, tier); belt = 0x2a1a10; shoes = 'boots';
      } else if (tier === 7) {
        tunicStyle = female ? 'gown' : 'robe';
        headwear = 'circlet'; trim = ERMINE; cloak = pickDye(rng, 7); belt = 0x2a1a10; shoes = 'boots';
      } else {
        tunicStyle = female ? 'gown' : 'robe';
        tunic = rng.pick([0x6a1a7a, 0xb01c2c, 0x1a2a6a]);
        headwear = 'crown'; trim = ERMINE; cloak = rng.pick([0xb01c2c, 0x6a1a7a]); belt = 0xd4af37; shoes = 'boots';
      }
      if (role === 'elder' && tier <= 3) { tunicStyle = female ? 'long' : 'long'; if (rng.chance(0.5)) cloak = undyed; }
      break;
    }
  }
  if (role === 'nun' || role === 'monk' || role === 'bishop' || role === 'priest') { /* keep */ }
  // culture accents
  if (culture === 'norse' && !trim && tier >= 2 && rng.chance(0.6)) trim = tone(rng, rng.pick([0xc8a646, 0x8a2a2a, 0x2a4a8a]));
  if (culture === 'gael' && tier <= 3 && tunicStyle === 'long') tunic = tone(rng, 0xc89a3a); // saffron léine
  const look: CharacterLook = {
    sex, age, height, build, skin, hair, hairStyle, beard, culture,
    clothing: { tunic, tunicStyle: tunicStyle!, legs, headwear, headColor, cloak, apron, belt, trim, shoes },
    armour: 'none', helmet: 'none',
  };
  return look;
}

/** Arm a look for a military role (in place). */
export function armLook(rng: Rng, look: CharacterLook, kind: 'levy' | 'archer' | 'crossbow' | 'man_at_arms' | 'knight' | 'sergeant'): CharacterLook {
  switch (kind) {
    case 'levy': look.armour = rng.chance(0.6) ? 'padded' : 'none'; look.helmet = rng.pick(['cap', 'kettle', 'none'] as const); break;
    case 'archer': look.armour = rng.chance(0.5) ? 'padded' : 'none'; look.helmet = rng.pick(['cap', 'none', 'kettle'] as const); break;
    case 'crossbow': look.armour = 'padded'; look.helmet = rng.pick(['kettle', 'cap'] as const); break;
    case 'sergeant': look.armour = 'mail'; look.helmet = 'kettle'; look.clothing.tunicStyle = 'surcoat'; look.heraldry = look.heraldry ?? heraldryFor(rng); break;
    case 'man_at_arms': look.armour = rng.pick(['mail', 'coat_of_plates'] as const); look.helmet = rng.pick(['nasal', 'kettle', 'bascinet'] as const); break;
    case 'knight':
      look.armour = rng.pick(['mail', 'coat_of_plates', 'plate'] as const);
      look.helmet = rng.pick(['great_helm', 'bascinet'] as const);
      look.clothing.tunicStyle = 'surcoat';
      look.heraldry = look.heraldry ?? heraldryFor(rng);
      look.clothing.shoes = 'boots';
      look.clothing.cloak = undefined;
      break;
  }
  if (look.armour !== 'none' && look.clothing.headwear !== 'crown' && look.clothing.headwear !== 'circlet' && look.helmet !== 'none') look.clothing.headwear = 'none';
  return look;
}
