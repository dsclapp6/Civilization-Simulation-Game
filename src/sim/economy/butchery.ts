// Slaughter and butchery by hand (civilization pass, docs/CIV.md §8). A household's own beasts are counted in its stores;
// slaughtering one removes it from the herd (the zone redraws the herd from the holding) and hangs a carcass whose quality
// follows the beast's condition (fat in autumn, lean in spring, thin after a fodder shortage) and the hand's skill. Butchering
// the carcass gives meat by the beast's weight, its hide and tallow; the meat can be salted to keep (a recipe, `craft.salt_meat`).
// A pig, a sheep, a goat or a fowl may be killed at home; a cow or an ox needs the slaughterhouse (its gear and hands), which
// anyone may use for a small fee to its keeper. Both steps show their own visible steps and train Husbandry.
import type { ActionOption, ActionOutcome, TargetRef } from '../actions';
import { skillLevel } from '../people';
import type { BuildingState, Household, Person } from '../state';
import type { Econ } from './core';
import { BEASTS, GOODS, keyOf, pd } from './data';
import { bagAdd, bagGet } from './items';
import { perkSum } from './perks';
import { stepsOfPlan } from './steps';
import type { Quality } from './types';
import { boutDone, disabled, giveOutput, holyDayBlock, incapable, option, round1, round2, secondsFor, speedOf } from './workkit';

export interface ButcherData { act: 'slaughter' | 'butcher'; animal: string; bld: number }

/** Beasts in the order they are offered. */
const ANIMALS: readonly string[] = ['pig', 'sheep', 'goat', 'chicken', 'cow', 'ox'];
/** Fatness by season (spring, summer, autumn, winter): the beasts are fattest after the summer's grazing. */
const SEASON_CONDITION = [0.88, 1.0, 1.15, 0.94] as const;
/** Meat on the carcass by its quality tier (lean … prime). */
const TIER_MEAT = [0.75, 1, 1.12, 1.25, 1.4] as const;
/** Pence a slaughterhouse asks for one beast, small and large. */
const FEE_SMALL = 0.25;
const FEE_LARGE = 0.8;

/** Condition of a household's beasts now: 0.8 (starved lean) … 1.2 (fat). */
export function conditionOf(E: Econ, hh: Household | undefined): number {
  const sea = Math.floor(E.dayOfYear / 4);
  // the spring cull reads this marker too: hay ran short in the winter
  const short = hh ? Math.min(0.15, 0.08 * (hh.stores['~f'] ?? 0)) : 0;
  return Math.max(0.8, Math.min(1.2, SEASON_CONDITION[sea] - short));
}

/** The carcass tiers of a species held in the pack and the larder, best first. */
export function carcassesHeld(E: Econ, p: Person, good: string): Array<{ key: string; quality: Quality; qty: number }> {
  const out: Array<{ key: string; quality: Quality; qty: number }> = [];
  const hh = E.hhOf(p);
  for (let q = 4; q >= 0; q--) {
    const key = keyOf(good, q as Quality);
    const n = bagGet(p.inventory, key) + (hh ? bagGet(hh.stores, key) : 0);
    if (n >= 0.99) out.push({ key, quality: q as Quality, qty: n });
  }
  return out;
}

/** The marker in a larder of the day a carcass was hung there (bookkeeping, not a good): macro.ts lets it rot after its days. */
export const hungKey = (key: string): string => `~h:${key}`;

/** Hangs a fresh carcass in the household's larder. */
function hang(E: Econ, hh: Household, key: string): void {
  if (bagGet(hh.stores, key) < 0.99) hh.stores[hungKey(key)] = Math.round(E.day * 100) / 100;
  bagAdd(hh.stores, key, 1);
  E.state.touchHousehold(hh);
}

/** Takes the best carcass of a species out of the pack or the larder; its tier, or null. */
function takeCarcass(E: Econ, p: Person, good: string): Quality | null {
  const best = carcassesHeld(E, p, good)[0];
  if (!best) return null;
  const hh = E.hhOf(p);
  if (bagGet(p.inventory, best.key) >= 0.99) { bagAdd(p.inventory, best.key, -1); E.state.touch(p); }
  else if (hh) {
    bagAdd(hh.stores, best.key, -1);
    if (bagGet(hh.stores, best.key) < 0.99) delete hh.stores[hungKey(best.key)];
    E.state.touchHousehold(hh);
  }
  return best.quality;
}

/** The tier a fresh carcass hangs at: the beast's condition and the hand's skill, with the luck of the animal. */
function carcassTier(E: Econ, p: Person, hh: Household | undefined): Quality {
  const lvl = skillLevel(p.skills.husbandry);
  const s = 1 + (conditionOf(E, hh) - 1) * 5 + (lvl / 20) * 0.9 + perkSum(p, 'husbandry', 'quality') + E.rng('beast').range(-0.45, 0.45);
  return Math.max(0, Math.min(4, Math.round(s))) as Quality;
}

const a = (animal: string): string => (animal === 'ox' ? 'an' : 'a');

/** The slaughterhouse's terms for this person: free for the keeper's household, else a small fee to the keeper (the lord, if nobody keeps it). */
function houseFee(E: Econ, p: Person, b: BuildingState, animal: string): { fee: number; keeper: Household | undefined } {
  const hh = E.hhOf(p);
  if (hh && b.household === hh.id) return { fee: 0, keeper: hh };
  const keeper = b.household ? E.household(b.household) : E.lordOf(b.settlement)?.household;
  return { fee: BEASTS[animal].kg >= 100 ? FEE_LARGE : FEE_SMALL, keeper };
}

/** Where the knife is used: the building, whether it is a slaughterhouse, which beasts are kept (and may be killed) here, and whether a block stands here. */
export interface ButcherySite { building: number; slaughterhouse?: BuildingState; keeps: (animal: string) => boolean; block: boolean }

/** Appends the slaughter options for the beasts a household keeps and the butchering of the carcasses it holds. */
export function listButchery(E: Econ, p: Person, hh: Household, target: TargetRef, range: number, out: ActionOption[], where: ButcherySite): void {
  const block = holyDayBlock(E) ?? incapable(p);
  const base = { target, range };
  const speedBase = speedOf(E, p, 'husbandry', 'str', null);
  const house = where.slaughterhouse;
  let offered = 0;
  for (const animal of ANIMALS) {
    const beast = BEASTS[animal];
    if (!beast) continue;
    const n = bagGet(hh.stores, animal);
    // slaughter: from the herd, here if the beast may be killed here
    if (n >= 1 && where.keeps(animal) && (house || beast.home)) {
      offered++;
      const terms = house ? houseFee(E, p, house, animal) : { fee: 0, keeper: undefined };
      const fat = conditionOf(E, hh);
      const dead = `${beast.carcass ? `a ${beast.carcass.replace('_carcass', '')} carcass` : 'the dressed bird'}: a ${beast.kg < 10 ? round1(beast.kg) : Math.round(beast.kg)} kg beast, about ${Math.round(beast.meat * fat)} lb of meat`;
      const o = option({
        id: `stock.slaughter.${animal}`, label: `Slaughter ${a(animal)} ${animal}${terms.fee > 0 ? ` (${pd(terms.fee)})` : ''}`, seconds: secondsFor(beast.work, speedBase, 8, 60), anim: 'work_lift', mainHand: 'dagger',
        priority: 5, repeat: false, steps: stepsOfPlan(beast.carcass ? 'slaughter' : 'wring'),
        preview: `Makes ${dead} · you lose a ${animal} from the herd · Husbandry`, ...base, data: { act: 'slaughter', animal, bld: where.building } as ButcherData,
      });
      if (terms.fee > 0 && !E.canAfford(p, terms.fee)) { o.enabled = false; o.reason = `The slaughterhouse asks ${pd(terms.fee)}`; }
      if (block) { o.enabled = false; o.reason = block; }
      out.push(o);
    }
    // butcher: the carcass in the pack or the larder, at a place with a block (a cow or an ox is jointed only at the slaughterhouse)
    if (beast.carcass && where.block && (house || beast.home)) {
      const held = carcassesHeld(E, p, beast.carcass);
      if (held.length > 0) {
        offered++;
        const q = held[0].quality;
        const meat = beast.meat * TIER_MEAT[q];
        const o = option({
          id: `stock.butcher.${animal}`, label: `Butcher the ${animal === 'cow' ? 'beef' : animal} carcass`, seconds: secondsFor(beast.cut, speedBase, 8, 90), anim: 'work_lift', mainHand: 'dagger',
          priority: 28, repeat: false, steps: stepsOfPlan('butcher'),
          preview: `About ${Math.round(meat)} lb of meat${beast.hide > 0 ? ', a hide' : ''} and ${Math.round(beast.tallow * TIER_MEAT[q])} lb of tallow · salt the meat to keep it · Husbandry`,
          ...base, data: { act: 'butcher', animal, bld: where.building } as ButcherData,
        });
        if (block) { o.enabled = false; o.reason = block; }
        out.push(o);
      }
    }
  }
  // the slaughterhouse says so when there is nothing to do there
  if (house && offered === 0) out.push(disabled({ id: 'stock.slaughter.none', label: 'Slaughter a beast', ...base }, 'Your household keeps no beasts to slaughter, and you carry no carcass'));
}

/** Slaughters one beast of the household's herd. */
export function slaughter(E: Econ, p: Person, d: ButcherData): ActionOutcome {
  const beast = BEASTS[d.animal];
  const hh = E.hhOf(p);
  if (!beast || !hh) return { ok: false, message: 'There is no such beast.' };
  if (bagGet(hh.stores, d.animal) < 1) return { ok: false, message: 'There is no such beast.' };
  const b = E.state.buildings.get(d.bld);
  const gains: NonNullable<ActionOutcome['gains']> = [{ label: 'Husbandry', ref: 'husbandry' }];
  if (b && b.kind === 'slaughterhouse') {
    if (b.construction < 1) return { ok: false, message: 'The slaughterhouse is not finished.' };
    const t = houseFee(E, p, b, d.animal);
    if (t.fee > 0) {
      if (!E.spend(p, t.fee, 'The slaughterhouse', true)) return { ok: false, message: `The slaughterhouse asks ${pd(t.fee)}.` };
      E.credit(t.keeper, t.fee);
      gains.push({ label: 'Slaughterhouse', amount: -t.fee, ref: 'money' });
    }
  } else if (!beast.home) return { ok: false, message: `A ${d.animal} is too big to kill here: take it to a slaughterhouse.` };
  bagAdd(hh.stores, d.animal, -1);
  E.state.touchHousehold(hh);
  boutDone(E, p, { skill: 'husbandry', xp: 8, heavy: 0.5, bouts: Math.min(2, beast.work) });
  if (!beast.carcass) {
    // a fowl is dressed in one go
    const meat = round2(beast.meat * conditionOf(E, hh) * (1 + perkSum(p, 'husbandry', 'yield')));
    giveOutput(E, p, 'meat', meat);
    gains.unshift({ label: 'Meat', amount: meat, ref: 'meat' });
    return { ok: true, message: `The ${d.animal} is plucked and dressed: ${meat} lb of meat.`, gains };
  }
  const tier = carcassTier(E, p, hh);
  const key = keyOf(beast.carcass, tier);
  hang(E, hh, key);
  gains.unshift({ label: `${['Lean', 'Fair', 'Fat', 'Fine', 'Prime'][tier]} ${GOODS[beast.carcass].name.toLowerCase()}`, amount: 1, ref: key });
  return { ok: true, message: `You slaughter the ${d.animal}: a ${['lean', 'fair', 'fat', 'fine', 'prime'][tier]} carcass hangs ready to joint.`, gains };
}

/** Joints a carcass: meat by the beast's weight and condition, its hide, its fat rendered to tallow. */
export function butcher(E: Econ, p: Person, d: ButcherData): ActionOutcome {
  const beast = BEASTS[d.animal];
  if (!beast || !beast.carcass) return { ok: false };
  const tier = takeCarcass(E, p, beast.carcass);
  if (tier === null) return { ok: false, message: `You have no ${d.animal} carcass.` };
  const lvl = skillLevel(p.skills.husbandry);
  const cut = Math.min(1.14, 0.9 + 0.012 * lvl) * (1 + perkSum(p, 'husbandry', 'yield'));
  const meat = round2(beast.meat * TIER_MEAT[tier] * cut);
  const tallow = round2(beast.tallow * TIER_MEAT[tier] * cut);
  const hide = round2(beast.hide * (0.9 + 0.01 * lvl));
  giveOutput(E, p, 'meat', meat);
  if (tallow > 0) giveOutput(E, p, 'tallow', tallow);
  if (hide > 0) giveOutput(E, p, 'hide', hide);
  boutDone(E, p, { skill: 'husbandry', xp: 8, heavy: 0.5, bouts: Math.min(3, beast.cut) });
  const gains: NonNullable<ActionOutcome['gains']> = [{ label: 'Meat', amount: meat, ref: 'meat' }];
  if (tallow > 0) gains.push({ label: 'Tallow', amount: tallow, ref: 'tallow' });
  if (hide > 0) gains.push({ label: 'Hide', amount: hide, ref: 'hide' });
  gains.push({ label: 'Husbandry', ref: 'husbandry' });
  E.state.touch(p);
  return { ok: true, message: `You joint the ${d.animal}: ${meat} lb of meat${hide > 0 ? `, ${hide >= 1 ? 'a hide' : 'a pelt'}` : ''} and ${tallow} lb of tallow.`, gains };
}
