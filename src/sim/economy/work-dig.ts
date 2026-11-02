// Digging, hewing and felling at the works that stand on the land's riches (civilization pass, docs/CIV.md §7–8): the
// quarry, the mine (iron, silver or gold by the deposit under it), the clay pit and the lumber camp. A bout takes a few
// seconds of pick, spade or axe (visible steps), brings out ore, stone, clay or logs by the richness of the deposit and the
// digger's skill, tires and wears the tool. Whose works it is decides who gets the product: the keeper's own people dig for
// themselves, a hired hand for his master (and a day's wage), anyone at a works nobody keeps gives the lord his fifth.
import type { AnimState, CarryLook, HeldItem } from '../../core/view';
import type { SkillId } from '../../core/domain';
import type { ActionOption, ActionOutcome, TargetRef } from '../actions';
import { skillLevel } from '../people';
import type { BuildingState, Household, Person } from '../state';
import type { Econ } from './core';
import { GOODS } from './data';
import { DEFAULT_RICHNESS, depositUnder, mineKind, richnessFactor } from './deposits';
import { bagAdd } from './items';
import { employmentOf } from './jobs';
import { perkSum } from './perks';
import { stepsOfPlan } from './steps';
import {
  boutDone, disabled, giveOutput, giveXp, holyDayBlock, incapable, option, payBout, round2, secondsFor, speedOf, stoch, toolFor, wearOut,
} from './workkit';

export type DigWhat = 'stone' | 'iron' | 'silver' | 'gold' | 'clay' | 'timber';

interface DigSpec {
  id: string;
  label: string;
  good: string;
  /** Units a bout brings out of a deposit of middling richness for a hand of skill 0. */
  per: number;
  tool: 'pick' | 'spade' | 'axe';
  /** Experience goes to this skill (stone also trains masonry). */
  skill: SkillId;
  plan: string;
  anim: AnimState;
  held: HeldItem;
  carry: CarryLook;
  noun: string;
  heavy: number;
  /** Words for the preview: what is dug and the skill. */
  skillName: string;
  /** Bouts of work one action stands for (a log takes longer to fell than a basket of ore to fill). */
  bouts: number;
}

const SPECS: Record<DigWhat, DigSpec> = {
  stone: { id: 'dig.stone', label: 'Quarry stone', good: 'stone', per: 1.6, tool: 'pick', skill: 'mining', plan: 'dig_stone', anim: 'work_pick', held: 'pick', carry: 'stone', noun: 'blocks of stone', heavy: 1, skillName: 'Masonry and Mining', bouts: 1 },
  iron: { id: 'dig.ore', label: 'Mine iron ore', good: 'iron_ore', per: 1.2, tool: 'pick', skill: 'mining', plan: 'dig_ore', anim: 'work_pick', held: 'pick', carry: 'none', noun: 'baskets of iron ore', heavy: 1, skillName: 'Mining', bouts: 1 },
  silver: { id: 'dig.silver', label: 'Mine silver ore', good: 'silver_ore', per: 0.06, tool: 'pick', skill: 'mining', plan: 'dig_ore', anim: 'work_pick', held: 'pick', carry: 'none', noun: 'baskets of silver ore', heavy: 1, skillName: 'Mining', bouts: 1 },
  gold: { id: 'dig.gold', label: 'Mine gold ore', good: 'gold_ore', per: 0.012, tool: 'pick', skill: 'mining', plan: 'dig_ore', anim: 'work_pick', held: 'pick', carry: 'none', noun: 'pouches of gold ore', heavy: 1, skillName: 'Mining', bouts: 1 },
  clay: { id: 'dig.clay', label: 'Dig clay', good: 'clay', per: 3, tool: 'spade', skill: 'mining', plan: 'dig_clay', anim: 'work_dig', held: 'spade', carry: 'none', noun: 'loads of clay', heavy: 0.8, skillName: 'Mining', bouts: 1 },
  timber: { id: 'dig.timber', label: 'Fell timber', good: 'timber', per: 0.8, tool: 'axe', skill: 'woodcutting', plan: 'dig_timber', anim: 'work_axe', held: 'axe', carry: 'bundle_wood', noun: 'logs', heavy: 1, skillName: 'Woodcutting', bouts: 3 },
};

/** Works of the land: building kind → what it digs (the mine by its deposit). */
export const DIG_BUILDINGS: ReadonlySet<string> = new Set(['quarry', 'mine', 'clay_pit', 'lumber_camp']);

export interface DigData { act: 'dig'; building: number; what: DigWhat }

/** What a works of this kind turns out, with the richness of the ground under it. */
export function digSite(E: Econ, b: BuildingState): { what: DigWhat; richness: number } | null {
  switch (b.kind) {
    case 'quarry': return { what: 'stone', richness: depositUnder(E, b.x, b.z, ['stone'])?.richness ?? DEFAULT_RICHNESS };
    case 'clay_pit': return { what: 'clay', richness: depositUnder(E, b.x, b.z, ['clay'])?.richness ?? 0.6 };
    case 'lumber_camp': return { what: 'timber', richness: Math.max(0.2, E.world.forestAt(b.x, b.z)) };
    case 'mine': { const m = mineKind(E, b.x, b.z); return { what: m.kind === 'gold' ? 'gold' : m.kind === 'silver' ? 'silver' : 'iron', richness: m.richness }; }
    default: return null;
  }
}

/** Who may dig here, for whom the product is, and what the work pays. */
type Terms =
  | { ok: true; mode: 'own' | 'lord' | 'hired'; keeper: Household | undefined; wage: number }
  | { ok: false; reason: string };

export function digTerms(E: Econ, p: Person, b: BuildingState): Terms {
  const hh = E.hhOf(p);
  const emp = employmentOf(E, p.id);
  if (emp && emp.building === b.id) {
    const keeper = b.household ? E.household(b.household) : E.lordOf(b.settlement)?.household;
    return { ok: true, mode: 'hired', keeper, wage: emp.wage };
  }
  if (hh && b.household === hh.id) return { ok: true, mode: 'own', keeper: hh, wage: 0 };
  if (b.household === 0) return { ok: true, mode: 'lord', keeper: E.lordOf(b.settlement)?.household, wage: 0 };
  return { ok: false, reason: "It is another's works: ask for work there" };
}

/** Units a bout brings out for this hand at this works. */
export function digYield(E: Econ, p: Person, b: BuildingState, what: DigWhat, richness: number): number {
  const spec = SPECS[what];
  const lvl = skillLevel(p.skills[spec.skill]);
  const base = what === 'timber' ? spec.per + 0.5 * richness : spec.per * richnessFactor(richness);
  return base * (1 + 0.04 * lvl) * (1 + perkSum(p, spec.skill, 'yield'));
}

/** Appends the dig option(s) of a works of the land. */
export function listDig(E: Econ, p: Person, b: BuildingState, out: ActionOption[], target: TargetRef): void {
  const site = digSite(E, b);
  if (!site) return;
  const spec = SPECS[site.what];
  const base = { target, range: 7 };
  const terms = digTerms(E, p, b);
  if (!terms.ok) { out.push(disabled({ id: spec.id, label: spec.label, ...base }, terms.reason)); return; }
  const tool = toolFor(E, p, spec.tool);
  if (!tool) { out.push(disabled({ id: spec.id, label: spec.label, ...base }, `Needs ${spec.tool === 'axe' ? 'an' : 'a'} ${spec.tool}`)); return; }
  const speed = speedOf(E, p, spec.skill, 'str', tool.quality);
  const per = digYield(E, p, b, site.what, site.richness);
  const share = terms.mode === 'lord' ? 'a fifth goes to the lord' : terms.mode === 'hired' ? 'paid by the day, the product is your master\'s' : 'yours';
  const o = option({
    id: spec.id, label: spec.label, seconds: secondsFor(spec.bouts, speed), anim: spec.anim, mainHand: spec.held, carry: spec.carry,
    preview: `About ${per < 1 ? round2(per) : Math.round(per * 10) / 10} ${spec.noun} ${spec.bouts > 1 ? 'a log' : 'a bout'} · ${share} · ${spec.skillName}`,
    priority: 40, steps: stepsOfPlan(spec.plan), ...base, data: { act: 'dig', building: b.id, what: site.what } as DigData,
  });
  const block = holyDayBlock(E) ?? incapable(p);
  if (block) { o.enabled = false; o.reason = block; }
  out.push(o);
}

/** One bout at a works of the land. */
export function digBout(E: Econ, p: Person, d: DigData): ActionOutcome {
  const b = E.state.buildings.get(d.building);
  if (!b || b.construction < 1) return { ok: false, message: 'There is nothing to dig there yet.' };
  const site = digSite(E, b);
  if (!site) return { ok: false };
  const spec = SPECS[site.what];
  const terms = digTerms(E, p, b);
  if (!terms.ok) return { ok: false, message: terms.reason };
  const tool = toolFor(E, p, spec.tool);
  const lvl = skillLevel(p.skills[spec.skill]);
  const per = digYield(E, p, b, site.what, site.richness);
  // whole units of the common goods, fractions of the rare ones
  let n = site.what === 'silver' || site.what === 'gold' ? round2(per * (0.8 + 0.4 * E.rng('roll').next())) : Math.max(1, stoch(E, per));
  const gains: NonNullable<ActionOutcome['gains']> = [];
  let kept = n;
  if (terms.mode === 'lord') {
    const lordShare = round2(n * 0.2);
    const lordHH = terms.keeper;
    if (lordHH && lordShare > 0) { bagAdd(lordHH.stores, spec.good, lordShare); E.state.touchHousehold(lordHH); }
    kept = Math.max(site.what === 'silver' || site.what === 'gold' ? 0 : 1, round2(n - lordShare));
  }
  if (terms.mode === 'hired') {
    // the master's bag, and a day's wage for the hour
    const keeper = terms.keeper;
    if (keeper) { bagAdd(keeper.stores, spec.good, n); E.state.touchHousehold(keeper); }
    const pay = payBout(E, p, 'hired', terms.wage, 1, keeper);
    if (pay > 0) gains.push({ label: 'Wages', amount: round2(pay), ref: 'money' });
    kept = 0;
  } else if (kept > 0) giveOutput(E, p, spec.good, kept);
  if (site.what === 'timber') {
    const wood = Math.max(2, stoch(E, 4));
    if (terms.mode === 'hired' && terms.keeper) { bagAdd(terms.keeper.stores, 'firewood', wood); E.state.touchHousehold(terms.keeper); }
    else giveOutput(E, p, 'firewood', wood);
    if (terms.mode !== 'hired') gains.push({ label: 'Firewood', amount: wood, ref: 'firewood' });
  }
  if (site.what === 'stone') { const was = E.notes.dug.get(b.id); E.notes.dug.set(b.id, { blocks: (was && E.day - was.day < 2 ? was.blocks : 0) + n, day: E.day }); E.notes.rev++; }
  boutDone(E, p, { skill: spec.skill, xp: 8, heavy: spec.heavy, bouts: spec.bouts });
  if (site.what === 'stone') giveXp(E, p, 'masonry', 3, 1);
  wearOut(E, p, tool, 0.025 * spec.bouts, spec.skill);
  // the dark has its dangers for the careless
  if (b.kind === 'mine' && lvl < 4 && E.rng('mine').next() < 0.012) {
    p.health.hp = Math.max(0.1, p.health.hp - 0.12);
    E.state.touch(p);
    E.notify('A prop gives way: you are bruised and shaken.', 'warn', p.id);
  }
  if (terms.mode !== 'hired') gains.unshift({ label: GOODS[spec.good]?.name ?? spec.good, amount: kept, ref: spec.good });
  else gains.unshift({ label: GOODS[spec.good]?.name ?? spec.good, amount: n, ref: spec.good });
  gains.push({ label: spec.skill, ref: spec.skill });
  if (site.what === 'stone') gains.push({ label: 'masonry', ref: 'masonry' });
  n = terms.mode === 'hired' ? n : kept;
  return { ok: true, message: `You bring out ${n < 1 ? round2(n) : n} ${spec.noun}.`, gains };
}
