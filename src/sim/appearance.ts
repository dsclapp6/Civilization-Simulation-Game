// Person → CharacterLook (core/view.ts). A look is stable per person: it is cached and its
// `lookVersion` only changes when something visible changes (a birthday, a change of rank or
// career, marriage, greying, a shift in wealth). Clothing follows rank, estate, sex, culture and
// wealth (SPEC §24: serfs in undyed russet and rags, rich dyes and trim for nobles, heraldic
// surcoats for knights, habits for monks and nuns, robes for clergy and scholars).
import { PALETTE } from '../assets/palette';
import type { Palette } from '../assets/types';
import type { CultureId } from '../core/domain';
import { clamp, hash01, hash3 } from '../core/math';
import type { ArmourLook, CharacterLook, ClothingLook, Headwear, HelmetLook, TunicStyle } from '../core/view';
import { CAREERS } from './careers';
import { TIER_MONEY, TIER_PURSE } from './people';
import { ageYears, type GameState, type Person } from './state';

// ---------------------------------------------------------------------------------------------
// colour helpers
// ---------------------------------------------------------------------------------------------

export function mixColour(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

const GROWTH: ReadonlyArray<readonly [number, number]> = [
  [0, 0.3], [1, 0.42], [2, 0.5], [3, 0.54], [4, 0.57], [6, 0.6], [8, 0.68], [10, 0.76], [12, 0.84], [14, 0.91], [16, 0.97], [18, 1],
];

function growth(age: number): number {
  if (age >= 18) return 1;
  for (let i = 1; i < GROWTH.length; i++) {
    if (age <= GROWTH[i][0]) {
      const t = (age - GROWTH[i - 1][0]) / (GROWTH[i][0] - GROWTH[i - 1][0]);
      return GROWTH[i - 1][1] + (GROWTH[i][1] - GROWTH[i - 1][1]) * t;
    }
  }
  return 1;
}

const GREY = 0x8f8f8f;
const WHITE = 0xd8d8d8;
const ERMINE = 0xe8e0d0;
const GOLD = 0xd4af37;

/** 0 poor … 3 rich for the person's rank. */
function wealthBand(state: GameState, p: Person): number {
  const hh = state.households.get(p.household);
  const share = hh ? hh.purse / Math.max(1, hh.members.length) : 0;
  const typical = TIER_MONEY[p.rankTier] + TIER_PURSE[p.rankTier] / 5 + 10;
  const ratio = (p.money + share) / typical;
  return ratio < 0.4 ? 0 : ratio < 1.6 ? 1 : ratio < 4 ? 2 : 3;
}

function greyStage(p: Person, age: number): number {
  const start = 32 + (1 - p.genes.grey) * 24;
  return age < start ? 0 : age < start + 22 ? 1 : 2;
}

function isRuler(state: GameState, p: Person): 'king' | 'queen' | null {
  for (const t of state.titlesHeldBy(p.id)) if (t.kind === 'kingdom') return 'king';
  if (p.spouse) for (const t of state.titlesHeldBy(p.spouse)) if (t.kind === 'kingdom') return 'queen';
  return null;
}

/** Everything that changes the look, folded into one number. */
function signature(state: GameState, p: Person, age: number): number {
  const ruler = isRuler(state, p);
  const widow = p.sex === 'f' && p.spouse === 0 && p.children.length > 0 ? 1 : 0;
  const a = hash3(Math.floor(age), p.rankTier, p.career.length * 31 + p.careerStage);
  const b = hash3(p.spouse ? 1 : 0, widow, wealthBand(state, p) * 7 + greyStage(p, age));
  const c = hash3(ruler === 'king' ? 2 : ruler === 'queen' ? 3 : 0, p.estate.length, p.offices.length);
  return hash3(a, b, c);
}

// ---------------------------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------------------------

const BEARD_FACTOR: Record<CultureId, number> = { anglo: 0.7, franc: 0.6, gael: 0.9, cymric: 0.8, norse: 1, teuton: 0.8 };

export function buildLook(state: GameState, p: Person, absDay: number, palette: Palette = PALETTE): CharacterLook {
  const age = ageYears(p, absDay);
  const sex = p.sex;
  const tier = p.rankTier;
  const wealth = wealthBand(state, p);
  const h = (salt: number): number => hash01(p.id, salt);

  // body
  const adultH = sex === 'm' ? 1.7 + 0.055 * p.genes.height : 1.585 + 0.05 * p.genes.height;
  let height = adultH * growth(age);
  if (age > 60) height *= Math.max(0.93, 1 - 0.0025 * (age - 60));
  let build = 0.42 + 0.05 * p.genes.build + 0.012 * (p.trained.str - 10) + 0.01 * (p.trained.end - 10) + (wealth - 1) * 0.07;
  if (age < 12) build -= 0.15;
  if (age > 40) build += Math.min(0.1, (age - 40) * 0.004);
  build = clamp(build, 0.05, 0.95);

  // skin and hair
  const tones = palette.skinTones;
  const si = clamp(p.genes.skin, 0, 1) * (tones.length - 1);
  const s0 = Math.floor(si);
  const skin = mixColour(tones[s0], tones[Math.min(tones.length - 1, s0 + 1)], si - s0);
  const natural = palette.hairColors[clamp(Math.round(p.genes.hair), 0, Math.min(6, palette.hairColors.length - 1))];
  let hair = natural;
  const gs = greyStage(p, age);
  if (gs > 0) {
    const start = 32 + (1 - p.genes.grey) * 24;
    hair = gs === 1 ? mixColour(natural, GREY, clamp((age - start) / 14, 0, 1)) : mixColour(GREY, WHITE, clamp((age - start - 22) / 12, 0, 1));
  }
  const clergy = p.estate === 'clergy';
  const beard = sex === 'm' && age >= 17 && !clergy
    ? Math.min(4, Math.round(p.genes.beard * BEARD_FACTOR[p.culture] * (age >= 25 ? 1 : 0.5)))
    : 0;

  const married = p.spouse !== 0;
  const widow = sex === 'f' && !married && p.children.length > 0;
  const ruler = isRuler(state, p);
  const house = state.houses.get(p.house);
  const heraldry = house?.heraldry && tier >= 5 ? house.heraldry : undefined;
  const dyes = palette.dyes[clamp(tier, 1, 8)] ?? palette.dyes[1];
  const dye = dyes[Math.floor(h(1) * dyes.length)];
  const dye2 = dyes[Math.floor(h(2) * dyes.length)];
  const darker = (c: number, t: number): number => mixColour(c, 0x2a2018, t);

  let style: TunicStyle = sex === 'm' ? 'short' : 'long';
  let tunic = dye;
  let legs = darker(dye2, 0.5);
  let headwear: Headwear = 'none';
  let headColor: number | undefined;
  let cloak: number | undefined;
  let apron: number | undefined;
  let belt: number | undefined = tier >= 3 ? 0x4a3420 : undefined;
  let trim: number | undefined;
  let shoes: ClothingLook['shoes'] = tier <= 1 && h(3) < 0.5 ? 'bare' : 'shoes';
  let armour: ArmourLook = 'none';
  let helmet: HelmetLook = 'none';

  const menHat = (): Headwear => {
    const r = h(4);
    if (age > 55 && r < 0.2) return 'coif';
    if (tier >= 3) return r < 0.4 ? 'felt_hat' : r < 0.7 ? 'hood' : 'none';
    const farm = CAREERS[p.career].field === 'land' || CAREERS[p.career].field === 'husbandry';
    return r < 0.3 ? 'hood' : r < 0.55 && farm ? 'straw_hat' : r < 0.7 ? 'felt_hat' : 'none';
  };
  const womenHat = (): Headwear => {
    if (age < 14 && !married) return 'none';
    if (!married && !widow) return tier >= 5 && h(5) < 0.3 ? 'circlet' : 'none';
    if (widow || age > 55) return 'wimple';
    if (tier >= 5) return h(5) < 0.5 ? 'veil' : 'wimple';
    return tier >= 4 ? 'veil' : 'coif';
  };

  if (age < 12) {
    // children
    style = tier <= 1 && wealth === 0 && h(6) < 0.4 ? 'rags' : sex === 'm' ? 'short' : 'long';
    shoes = age < 9 && tier <= 2 ? 'bare' : shoes;
    if (tier >= 5) { style = sex === 'm' ? 'short' : 'gown'; trim = tier >= 7 ? GOLD : undefined; shoes = 'shoes'; }
  } else if (clergy && (p.career === 'monk' || p.career === 'nun' || p.career === 'abbot' || p.career === 'prior')) {
    style = 'habit';
    const order = hash3(p.settlement, 17) % 3;
    tunic = order === 0 ? 0x2b2622 : order === 1 ? 0xe6e2d6 : 0x6b4f35;
    legs = tunic;
    belt = 0x9a8a60;
    shoes = 'shoes';
    headwear = sex === 'f' ? (p.career === 'abbot' ? 'wimple' : p.careerStage === 0 ? 'wimple' : 'veil') : 'hood';
    if (p.career === 'abbot' && sex === 'm' && h(7) < 0.5) headwear = 'mitre';
    headColor = headwear === 'veil' || headwear === 'wimple' ? (order === 1 ? 0xf2efe6 : 0x1c1814) : undefined;
  } else if (clergy && p.career === 'bishop') {
    style = 'robe'; tunic = 0x6a1a7a; legs = tunic; trim = GOLD; headwear = 'mitre'; headColor = 0xf2efe6; cloak = 0x8a1f1f; shoes = 'shoes';
  } else if (clergy) {
    style = 'robe';
    tunic = h(8) < 0.5 ? 0x23232a : 0x34343c; legs = tunic; shoes = 'shoes'; headwear = age > 50 ? 'coif' : 'none'; belt = 0x4a3420;
  } else if (tier >= 5 || p.estate === 'noble') {
    const male = sex === 'm';
    shoes = male ? 'boots' : 'shoes';
    trim = tier >= 7 ? ERMINE : tier >= 6 ? GOLD : h(9) < 0.5 ? GOLD : undefined;
    if (male) {
      style = tier >= 8 || ruler === 'king' ? 'robe' : tier >= 5 && heraldry && age >= 14 ? 'surcoat' : tier >= 7 ? 'surcoat' : 'long';
      tunic = style === 'surcoat' && heraldry ? heraldry.field : dye;
      legs = darker(dye2, 0.3);
      cloak = tier >= 6 ? dye2 : undefined;
      headwear = ruler === 'king' ? 'crown' : state.titlesHeldBy(p.id).size > 0 && tier >= 7 ? 'circlet' : tier >= 6 ? (h(10) < 0.5 ? 'felt_hat' : 'none') : menHat();
      if (ruler !== 'king' && tier === 8 && age >= 8) headwear = 'circlet';
      belt = 0x6a4a2a;
    } else {
      style = 'gown';
      tunic = dye;
      headwear = ruler === 'queen' ? 'crown' : womenHat();
      if (tier >= 8 && headwear === 'none' && age >= 8) headwear = 'circlet';
      if (tier >= 7 && state.titlesHeldBy(p.id).size > 0) headwear = 'circlet';
      cloak = tier >= 6 ? dye2 : undefined;
    }
    headColor = headwear === 'crown' || headwear === 'circlet' ? GOLD : headwear === 'veil' || headwear === 'wimple' ? 0xf2efe6 : undefined;
  } else if (p.career === 'steward' || p.career === 'clerk' || p.career === 'healer' || p.career === 'bailiff') {
    style = 'robe'; tunic = darker(dye, 0.15); legs = darker(dye, 0.3); headwear = sex === 'f' ? womenHat() : (h(11) < 0.4 ? 'felt_hat' : 'none');
    shoes = 'shoes'; cloak = tier >= 4 ? dye2 : undefined;
  } else {
    // commoners, townsfolk, gentry
    if (sex === 'm') {
      style = tier >= 3 ? 'long' : 'short';
      headwear = menHat();
    } else {
      style = tier >= 3 ? 'gown' : 'long';
      headwear = womenHat();
    }
    if (tier <= 1 && wealth === 0 && h(6) < 0.45) { style = 'rags'; shoes = 'bare'; }
    if (tier >= 4) { trim = h(12) < 0.5 ? GOLD : undefined; cloak = dye2; shoes = 'shoes'; }
    else if (tier >= 2 && h(13) < 0.25) cloak = darker(dye2, 0.2);
    if (tier >= 3 && wealth >= 2 && !trim && h(14) < 0.5) trim = mixColour(dye, 0xffffff, 0.4);
    const field = CAREERS[p.career].field;
    if ((field === 'craft' || field === 'brewing') && age >= 13) apron = h(15) < 0.5 ? 0xe8e4d4 : 0x6b4a2a;
    if (p.career === 'smith') { apron = 0x4a3420; headwear = 'none'; }
  }

  // arms-bearers
  if (p.career === 'man_at_arms') { armour = h(16) < 0.35 ? 'padded' : 'mail'; helmet = 'kettle'; shoes = 'boots'; }
  else if (p.career === 'sergeant') { armour = 'mail'; helmet = 'bascinet'; shoes = 'boots'; }
  else if (p.career === 'soldier' || p.career === 'archer') { armour = 'padded'; helmet = 'cap'; }
  if (helmet !== 'none') headwear = 'none';

  const clothing: ClothingLook = { tunic, tunicStyle: style, legs, headwear, shoes };
  if (headColor !== undefined) clothing.headColor = headColor;
  if (cloak !== undefined) clothing.cloak = cloak;
  if (apron !== undefined) clothing.apron = apron;
  if (belt !== undefined && style !== 'rags') clothing.belt = belt;
  if (trim !== undefined) clothing.trim = trim;

  const look: CharacterLook = {
    sex, age, height, build, skin, hair, hairStyle: p.genes.hairStyle, beard, culture: p.culture,
    clothing, armour, helmet,
  };
  if (heraldry) look.heraldry = heraldry;
  return look;
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

export interface CachedLook { look: CharacterLook; version: number }

/** Stable looks per person with a version that bumps only when the look really changes. */
export class AppearanceCache {
  private readonly entries = new Map<number, { sig: number; value: CachedLook }>();

  constructor(private readonly palette: Palette = PALETTE) {}

  get(state: GameState, p: Person, absDay: number): CachedLook {
    const age = ageYears(p, absDay);
    const sig = signature(state, p, age);
    const e = this.entries.get(p.id);
    if (e && e.sig === sig) return e.value;
    const value: CachedLook = { look: buildLook(state, p, absDay, this.palette), version: e ? e.value.version + 1 : 1 };
    this.entries.set(p.id, { sig, value });
    return value;
  }

  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

