// Needs of the player's character (SPEC §5): hunger falls through the day and is met by two meals,
// rest falls while awake (sleeping restores it), warmth follows clothes, weather, shelter and fire,
// mood follows food, rest, warmth, rank and what has happened. Unmet needs slow work, block training
// and finally kill. NPCs' needs stay macro: their food comes from their household's stores.
import type { HourInfo } from '../clock';
import { dayPart } from '../calendar';
import { decayStatBonus } from '../skills';
import { killPerson } from '../succession';
import type { Person } from '../state';
import type { Econ } from './core';
import { GOODS, qualityOf } from './data';
import { RATION } from './diet';
import { bagEntries, bagGet, bagTake } from './items';
import { parseItemKey, type ItemKey, type Result } from './types';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const r2 = (v: number): number => Math.round(v * 1000) / 1000;

/** Work speed multiplier from hunger, tiredness, cold and injury (1 when all is well). */
export function needsFactor(p: Person): number {
  const n = p.needs;
  let f = 1;
  if (n.hunger < 0.3) f *= n.hunger < 0.1 ? 0.6 : 0.78;
  if (n.rest < 0.3) f *= n.rest < 0.1 ? 0.6 : 0.78;
  if (n.warmth < 0.25) f *= 0.85;
  if (p.health.hp < 1) f *= 0.6 + 0.4 * p.health.hp;
  return f;
}

/** The cost of a work bout in food and strength; `heavy` is 0 (light) to 1 (ploughing, mining, felling). */
export function drainWork(E: Econ, p: Person, heavy: number): void {
  p.needs.hunger = r2(clamp01(p.needs.hunger - 0.004 - 0.012 * heavy));
  p.needs.rest = r2(clamp01(p.needs.rest - 0.006 - 0.02 * heavy));
  E.state.touch(p);
}

/** Warmth of what the character wears (0..~0.5). */
export function clothingWarmth(E: Econ, p: Person): number {
  const eq = E.save.eq[String(p.id)];
  let w = 0;
  for (const slot of ['body', 'back'] as const) {
    const key = eq?.[slot];
    if (!key || bagGet(p.inventory, key) <= 0) continue;
    const g = GOODS[parseItemKey(key).good];
    if (g?.warmth) w += g.warmth * (0.7 + 0.15 * qualityOf(key));
  }
  return w;
}

/** How well the character dresses for their station: each tier above commoner expects better clothes. */
export function clothingStatus(E: Econ, p: Person): number {
  const eq = E.save.eq[String(p.id)];
  const key = eq?.body;
  if (!key || bagGet(p.inventory, key) <= 0) return 0;
  return qualityOf(key) + (eq?.back ? 0.5 : 0);
}

export function consume(E: Econ, p: Person, key: ItemKey, qty = 1): Result {
  const g = GOODS[parseItemKey(key).good];
  if (!g || !g.food) return { ok: false, reason: 'You cannot eat that' };
  if (qty <= 0) return { ok: false, reason: 'Nothing to eat' };
  if (p.needs.hunger >= 0.97) return { ok: false, reason: 'You are not hungry' };
  if (bagGet(p.inventory, key) + 1e-6 < qty) return { ok: false, reason: `You do not have ${qty} ${g.unit}` };
  bagTake(p.inventory, key, qty);
  p.needs.hunger = r2(clamp01(p.needs.hunger + g.food * qty));
  if (g.category === 'drink') adjustMood(E, p, 0.03 * qty);
  else if (g.id === 'cheese' || g.id === 'meat' || g.id === 'honey') adjustMood(E, p, 0.02 * qty);
  E.state.touch(p);
  return { ok: true };
}

export function adjustMood(E: Econ, p: Person, delta: number): void {
  const k = String(p.id);
  const v = Math.max(-0.5, Math.min(0.5, (E.save.mood[k] ?? 0) + delta));
  if (Math.abs(v) < 0.005) delete E.save.mood[k]; else E.save.mood[k] = Math.round(v * 1000) / 1000;
  E.touchSave();
}

const warned = new Map<number, number>();

function warn(E: Econ, p: Person, kind: string, text: string, level: 'warn' | 'danger'): void {
  const day = Math.floor(E.day * 3); // once per eight hours
  const key = p.id * 10 + kind.charCodeAt(0) % 10;
  if (warned.get(key) === day) return;
  warned.set(key, day);
  if (warned.size > 200) warned.clear();
  E.notify(text, level, p.id);
}

/** Every hour: the player's needs move, and what they cost in health. */
export function playerHour(E: Econ, info: HourInfo): void {
  const p = E.person(E.playerId);
  if (!p || p.death || E.state.run.phase !== 'alive') return;
  const n = p.needs;
  const sleeping = E.sim.clock.skip?.kind === 'sleep';
  const part = dayPart(E.day);
  const night = part === 'night';

  n.hunger = r2(clamp01(n.hunger - (sleeping ? 0.01 : 0.026)));
  if (!sleeping) n.rest = r2(clamp01(n.rest - 0.036 - (night ? 0.01 : 0)));
  else n.rest = r2(clamp01(n.rest + 0.12));

  // two meals a day at the household table, charged to the household by the macro tick (macro.ts): board and lodging,
  // the family's supper. Away from the home village there is no table: carry bread or buy a meal.
  if ((info.hour === 7 || info.hour === 18) && n.hunger < 0.8 && E.save.last.board === 1) {
    const hh = E.hhOf(p);
    if (hh && hh.settlement === p.settlement) n.hunger = r2(Math.max(n.hunger, 0.92));
  }
  autoEat(E, p);

  // warmth: weather against clothes, shelter and fire
  const w = E.sim.view.weather();
  const cold = Math.max(0, 11 - w.temperature) / 22;
  const wet = w.rain * 0.18 + w.snow * 0.22;
  const hh = E.hhOf(p);
  const fire = hh && (bagGet(hh.stores, 'firewood') > 0.2) ? 0.15 : 0;
  const shelter = night || sleeping ? 0.28 : 0;
  const target = clamp01(0.95 - cold - wet * (shelter > 0 ? 0.3 : 1) + clothingWarmth(E, p) + shelter + fire - 0.15);
  n.warmth = r2(clamp01(n.warmth + (target - n.warmth) * 0.25));

  // mood
  const boost = E.save.mood[String(p.id)] ?? 0;
  const status = Math.min(0.12, 0.03 * (p.rankTier - 1)) + 0.04 * Math.min(2, Math.max(0, clothingStatus(E, p) - 0.5));
  const moodTarget = clamp01(0.3 + 0.22 * n.hunger + 0.12 * n.rest + 0.1 * n.warmth + status + 0.2 * p.health.hp + boost);
  n.mood = r2(clamp01(n.mood + (moodTarget - n.mood) * 0.1));
  if (boost !== 0) {
    const nb = boost * 0.93;
    if (Math.abs(nb) < 0.01) delete E.save.mood[String(p.id)]; else E.save.mood[String(p.id)] = Math.round(nb * 1000) / 1000;
    E.touchSave();
  }

  // health
  let hp = p.health.hp;
  const ill = p.health.conditions.length > 0;
  if (n.hunger <= 0.03) {
    hp -= 0.012;
    warn(E, p, 'starve', 'You are starving.', 'danger');
  } else if (n.hunger < 0.2) warn(E, p, 'hungry', 'You are very hungry.', 'warn');
  if (n.warmth <= 0.1) {
    hp -= 0.015;
    warn(E, p, 'cold', 'You are freezing.', 'danger');
  } else if (n.warmth < 0.25) warn(E, p, 'chill', 'You are cold.', 'warn');
  if (n.rest < 0.12) warn(E, p, 'tired', 'You are exhausted: sleep.', 'warn');
  if (!ill && hp < 1 && n.hunger > 0.4 && n.warmth > 0.4 && n.rest > 0.25) hp += 0.006;
  hp = Math.max(0, Math.min(1, hp));
  if (hp !== p.health.hp) { p.health.hp = r2(hp); }
  E.state.touch(p);
  if (p.health.hp <= 0.02 && !ill) {
    const cause = n.hunger <= 0.03 ? 'famine' : 'exposure';
    killPerson(E.sim, p, cause, E.day);
  }
}

/** Grain, pulses and flour make a pottage when the larder holds nothing prepared. */
export const POTTAGE = ['flour', 'rye', 'barley', 'oats', 'wheat', 'peas', 'beans'];

/** A meal from the household's stores: prepared food first, otherwise a pottage of flour or grain. */
export function eatAtHome(E: Econ, p: Person): { ok: boolean; message: string } {
  const hh = E.hhOf(p);
  if (!hh) return { ok: false, message: 'You have no household.' };
  const foods = bagEntries(hh.stores).filter(([k]) => GOODS[parseItemKey(k).good]?.food && GOODS[parseItemKey(k).good].category !== 'livestock');
  // bread or flat cakes first, then cheese, vegetables and a little ale
  const order = ['bread', 'cheese', 'eggs', 'vegetables', 'meat', 'fish', 'ale', 'honey'];
  foods.sort((a, b) => order.indexOf(parseItemKey(a[0]).good) - order.indexOf(parseItemKey(b[0]).good));
  let ate = 0;
  for (const [k, have] of foods) {
    if (p.needs.hunger >= 0.9) break;
    const g = GOODS[parseItemKey(k).good];
    const need = (0.92 - p.needs.hunger) / (g.food ?? 0.2);
    const unit = g.category === 'drink' ? 0.25 : 1;
    const qty = Math.min(have, Math.max(unit, Math.ceil(need / unit) * unit), g.category === 'drink' ? 0.5 : 3);
    bagTake(hh.stores, k, qty);
    p.needs.hunger = Math.min(1, Math.round((p.needs.hunger + (g.food ?? 0.2) * qty) * 1000) / 1000);
    ate++;
    if (ate >= 3) break;
  }
  if (ate === 0) {
    for (const g of POTTAGE) {
      // a gallon of grain is 3 to 4 days of rations (diet.ts); a ration is about 0.55 of the hunger bar
      const per = g === 'flour' ? 0.06 : (RATION[g] ?? 3) * 0.55;
      const have = bagGet(hh.stores, g);
      if (have <= 0.1) continue;
      const want = Math.max(0, 0.92 - p.needs.hunger) / per;
      const qty = Math.min(have, Math.max(0.05, Math.ceil(want * 20) / 20), g === 'flour' ? 12 : 0.6);
      bagTake(hh.stores, g, qty);
      p.needs.hunger = Math.round(Math.min(1, p.needs.hunger + per * qty) * 1000) / 1000;
      ate++;
      break;
    }
  }
  E.state.touchHousehold(hh);
  E.state.touch(p);
  return ate > 0 ? { ok: true, message: 'You eat at the family table.' } : { ok: false, message: 'There is nothing to eat.' };
}

/** A hungry character with food in the pack, or at the family table in the home village, eats without being told: nobody should have to click a loaf twice a day. */
function autoEat(E: Econ, p: Person): void {
  if (p.needs.hunger >= 0.3) return;
  const foods = Object.keys(p.inventory).filter((k) => k.charCodeAt(0) !== 126 && GOODS[parseItemKey(k).good]?.food && GOODS[parseItemKey(k).good].category !== 'livestock');
  if (foods.length === 0) {
    // nothing in the pack: in the home village the family table is not far
    const hh = E.hhOf(p);
    if (hh && hh.settlement === p.settlement && eatAtHome(E, p).ok) E.notify('You eat at the family table.', 'info', p.id);
    return;
  }
  // bread and cheese before ale and vegetables
  const order = ['bread', 'cheese', 'meat', 'fish', 'eggs', 'vegetables', 'honey', 'ale'];
  foods.sort((a, b) => order.indexOf(parseItemKey(a).good) - order.indexOf(parseItemKey(b).good));
  let ate = 0;
  for (const k of foods) {
    if (p.needs.hunger >= 0.7) break;
    const g = GOODS[parseItemKey(k).good];
    const have = bagGet(p.inventory, k);
    const unit = g.category === 'drink' ? 0.25 : 1;
    const qty = Math.min(have, Math.max(unit, Math.ceil(((0.8 - p.needs.hunger) / (g.food ?? 0.2)) / unit) * unit));
    if (consume(E, p, k, qty).ok) ate++;
    if (ate >= 3) break;
  }
  if (ate > 0) E.notify('You eat from your pack.', 'info', p.id);
}

/** Every season the training bonus of the player fades a little unless exercised (sim/skills.ts asks for a call). */
export function seasonalNeeds(E: Econ): void {
  const p = E.person(E.playerId);
  if (p && !p.death) { decayStatBonus(p, 0.04); E.state.touch(p); }
}
