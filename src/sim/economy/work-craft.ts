// Player work with hands and tools other than the plough (SPEC §6, §11, docs/CIV.md §8): the crafts at their workshops,
// open to everyone (a recipe may be attempted at any works one may use — one's own, an employer's, or a master's bench
// hired for a fee — and the ladders of career and stage stay for jobs and the masterpiece only), the apprentice's
// fetching and striking, the masterpiece, felling and gathering wood in the open, and the works of the land (work-dig.ts).
// Quality comes from skill, tool and perks; a novice wastes material and may spoil the work, and learns from it either way.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { CHUNKS_PER_SIDE, type ScatterItem, type ScatterKind } from '../../world/types';
import type { ActionOption, ActionOutcome, ActionProvider, TargetRef } from '../actions';
import { CAREERS } from '../careers';
import { foundHouse } from '../family';
import { skillLevel } from '../people';
import { pickHome, setRank } from '../succession';
import type { BuildingState, Household, Person } from '../state';
import type { Econ } from './core';
import { APPRENTICE_TASKS, CAREER_ECON, GOODS, RECIPES, TOOL_SPEED, careerEcon, keyOf, recipesAt, type RecipeDef, pd } from './data';
import { DEFAULT_RICHNESS, depositUnder, richnessFactor } from './deposits';
import { bagAdd, bagGet } from './items';
import { employmentOf } from './jobs';
import { perkSum } from './perks';
import { RENT_PER_STRIP } from './macro';
import { addFine, creditWeekWork } from './obligations';
import { stepsFor } from './steps';
import { DIG_BUILDINGS, digBout, listDig, type DigData } from './work-dig';
import {
  BOUT, BOUT_DAYS, boutDone, careOf, disabled, giveOutput, giveXp, haveOf, holyDayBlock, incapable, option, payBout, round1, round2, secondsFor, speedOf, stoch,
  toolFor, wearOut, type ToolRef,
} from './workkit';
import type { SkillId } from '../../core/domain';
import type { Quality } from './types';

export { giveOutput };

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

type Source = 'own' | 'employer' | 'hired';
interface CraftData { act: 'craft'; recipe: string; building: number; source: Source; employerHh: number; toolQ: number; speed: number }
interface ApprenticeData { act: 'apprentice'; task: string; building: number }
interface MasterData { act: 'masterpiece'; recipe: string; building: number }
interface WoodData { act: 'fell' | 'gather' | 'quarry_rock'; scatter: number; kind: ScatterKind; scale: number }
type CraftAct = CraftData | ApprenticeData | MasterData | WoodData | DigData;

const TREES: ReadonlySet<ScatterKind> = new Set<ScatterKind>(['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple']);
const DEADWOOD: ReadonlySet<ScatterKind> = new Set<ScatterKind>(['deadtree', 'stump', 'log', 'bush', 'bramble']);
const ROCKS: ReadonlySet<ScatterKind> = new Set<ScatterKind>(['rock_small', 'rock_large', 'boulder']);
const TIMBER_FACTOR: Partial<Record<ScatterKind, number>> = { oak: 1.2, beech: 1.1, pine: 1, spruce: 0.9, birch: 0.8, ash: 0.9, willow: 0.6, apple: 0.5 };

/** Levels beyond a person's skill at which a recipe is still within their reach (to try, and very likely to spoil). */
export const REACH = 6;
/** Recipes shown at one bench (the ones nearest the person's skill first). */
const SHOWN = 24;
/** Small personal tools the workshop does not lend. */
const PERSONAL_TOOLS: ReadonlySet<string> = new Set(['needle', 'distaff']);

export function scatterAt(E: Econ, id: number): ScatterItem | null {
  const chunk = Math.floor(id / 4096);
  const cx = chunk % CHUNKS_PER_SIDE;
  const cz = Math.floor(chunk / CHUNKS_PER_SIDE);
  if (cx < 0 || cz < 0 || cz >= CHUNKS_PER_SIDE) return null;
  return E.world.scatterInChunk(cx, cz).find((s) => s.id === id) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Where a person may work, with what, and where the materials and the product go
// ---------------------------------------------------------------------------------------------

export interface Place {
  ok: boolean;
  reason?: string;
  source: Source;
  /** The master's household, when the work is done in his name. */
  employer?: Household;
  wage: number;
  /** On one's own account: skill alone decides, no stage gates. */
  mastery: boolean;
  /** The household that keeps the works and is paid for the use of its bench. */
  owner?: Household;
  /** The works lends its common tools (anvil, bench, loom, press). */
  provides: boolean;
}

/** The ladder rung a recipe asks of someone who works in a master's name (jobs keep their gates). */
function stageGate(p: Person, r: RecipeDef): string | null {
  if (r.stage < 0) return null;
  if (CAREERS[p.career].field !== 'craft') return 'Only a craftsman bound to a master may work in his name';
  if (p.careerStage < r.stage) return r.stage === 1 ? 'Apprentices fetch and carry: only a journeyman may work this in the master\'s name' : 'Only a master may work this in his own name';
  return null;
}

/** Pence a master's bench costs for one batch (a share of what a day's work at it earns). */
export function benchFee(r: RecipeDef, b: BuildingState): number {
  return round2(Math.max(0.2, 0.3 * r.work * (1 + 0.15 * (b.level - 1))));
}

export function placeFor(E: Econ, p: Person, b: BuildingState, r: RecipeDef | null): Place {
  if (b.construction < 1) return { ok: false, reason: 'It is still being built', source: 'own', wage: 0, mastery: false, provides: false };
  const hh = E.hhOf(p);
  const emp = employmentOf(E, p.id);
  const home = BUILDINGS[b.kind].cat === 'home';
  const isOwn = !!hh && (b.household === hh.id || (home && hh.home === b.id));
  if (isOwn) return { ok: true, source: 'own', wage: 0, mastery: true, provides: !home };
  if (home) return { ok: false, reason: "That is somebody's home", source: 'own', wage: 0, mastery: false, provides: false };
  const keeper = b.household !== 0 ? E.household(b.household) : undefined;
  // in a master's employ, at his works: the work is his, with the ladder's gates and the wage
  if (emp && emp.employer && keeper && (emp.building === b.id || E.person(emp.employer)?.household === b.household)) {
    const employerHh = E.household(E.person(emp.employer)?.household ?? 0);
    if (employerHh && (!r || !stageGate(p, r))) {
      return { ok: true, source: 'employer', employer: employerHh, wage: emp.terms === 'day' || emp.terms === 'season' || emp.terms === 'year' ? emp.wage : 0, mastery: false, provides: true };
    }
  }
  // a works nobody keeps (the kiln, the saw pit, the charcoal mound, the bloomery): anyone's
  if (!keeper) return { ok: true, source: 'own', wage: 0, mastery: true, provides: true };
  // another's workshop: hire the bench for a fee, on one's own account
  return { ok: true, source: 'hired', wage: 0, mastery: true, owner: keeper, provides: true };
}

function bagsOf(E: Econ, p: Person, place: Place): Array<Record<string, number>> {
  const bags: Array<Record<string, number>> = [];
  if (place.source === 'employer' && place.employer) bags.push(place.employer.stores);
  bags.push(p.inventory);
  const hh = E.hhOf(p);
  if (hh && place.source !== 'employer') bags.push(hh.stores);
  return bags;
}

function haveIn(bags: Array<Record<string, number>>, good: string): number {
  let n = 0;
  for (const b of bags) for (const k of Object.keys(b)) if (k.charCodeAt(0) !== 126 && (k === good || k.startsWith(`${good}#`))) n += b[k];
  return n;
}

function takeIn(bags: Array<Record<string, number>>, good: string, qty: number): number {
  let need = qty;
  for (const b of bags) {
    for (const k of Object.keys(b)) {
      if (need <= 0.001) break;
      if (k.charCodeAt(0) === 126 || !(k === good || k.startsWith(`${good}#`))) continue;
      const t = Math.min(need, b[k]);
      bagAdd(b, k, -t);
      need -= t;
    }
  }
  return qty - need;
}

/** The tool for a recipe: the one carried or kept in the house, else the works' own (a bench, an anvil, a loom), else a reason. */
function toolAt(E: Econ, p: Person, r: RecipeDef, place: Place): { tool: ToolRef | null; toolQ: number; reason: string | null } {
  if (!r.tool) return { tool: null, toolQ: 1, reason: null };
  const tool = toolFor(E, p, r.tool);
  if (tool) return { tool, toolQ: tool.quality, reason: null };
  if (place.provides && !PERSONAL_TOOLS.has(r.tool)) return { tool: null, toolQ: 1, reason: null };
  return { tool: null, toolQ: 1, reason: `Needs a ${GOODS[r.tool]?.name.toLowerCase() ?? r.tool}` };
}

/** How many levels beyond their skill the person is for a recipe (0: fit to do it). */
export function gapOf(p: Person, r: RecipeDef): number { return Math.max(0, r.level - skillLevel(p.skills[r.skill])); }
/** The chance a novice spoils a batch, by how far beyond their skill it is. */
export function spoilChance(gap: number): number { return gap <= 0 ? 0 : Math.min(0.85, 0.08 + 0.12 * gap); }
/** A novice also uses more material than a hand who knows the work. */
const wasteFactor = (gap: number): number => 1 + 0.05 * gap;

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export function craftProvider(E: Econ): ActionProvider {
  return {
    id: 'craft',
    list(_ctx, actor, target, out) {
      const p = E.person(actor);
      if (!p || p.death) return;
      if (target.kind === 'building') listBuilding(E, p, target.id, out);
      else if (target.kind === 'scatter') listScatter(E, p, target.id, out);
    },
    check(_ctx, actor) {
      const p = E.person(actor);
      if (!p) return 'Nobody there';
      return incapable(p) ?? holyDayBlock(E);
    },
    complete(_ctx, actor, o) {
      const p = E.person(actor);
      if (!p || p.death) return { ok: false };
      const d = o.data as CraftAct;
      switch (d.act) {
        case 'craft': return craftBatch(E, p, d);
        case 'apprentice': return apprenticeBout(E, p, d);
        case 'masterpiece': return masterpiece(E, p, d);
        case 'fell': case 'gather': case 'quarry_rock': return woodWork(E, p, d);
        case 'dig': return digBout(E, p, d);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------------------------

function listBuilding(E: Econ, p: Person, id: number, out: ActionOption[]): void {
  const b = E.state.buildings.get(id);
  if (!b || b.construction < 1) return;
  const target: TargetRef = { kind: 'building', id };
  const base = { target, range: 7 };
  const holy = holyDayBlock(E);
  const weak = incapable(p);
  const block = holy ?? weak;
  const hh = E.hhOf(p);
  const home = BUILDINGS[b.kind].cat === 'home' && !!hh && hh.home === id;
  const emp = employmentOf(E, p.id);

  // the quarry, the mines, the clay pit and the lumber camp
  if (DIG_BUILDINGS.has(b.kind)) listDig(E, p, b, out, target);

  // apprentices fetch, pump and strike
  if (emp?.terms === 'apprenticeship' && (emp.building === id || (b.household !== 0 && E.person(emp.employer)?.household === b.household))) {
    const tasks = APPRENTICE_TASKS[b.kind] ?? Object.values(APPRENTICE_TASKS)[0] ?? [];
    tasks.forEach((t, i) => {
      const speed = speedOf(E, p, careerEcon(p.career).skill, 'str', null);
      const o = option({
        id: `appr.${t.id}`, label: t.name, seconds: secondsFor(0.8, speed), anim: t.anim, mainHand: t.held, carry: t.anim === 'carry_walk' ? 'sack' : 'none',
        preview: `Learning the trade, with board and lodging · ${careerEcon(p.career).skill}`, priority: 45 - i, ...base, data: { act: 'apprentice', task: t.id, building: id } as CraftAct,
      });
      if (block) { o.enabled = false; o.reason = block; }
      out.push(o);
    });
  }

  // recipes: any of them, at any works one may use
  const recipes = recipesAt(b.kind, home || (BUILDINGS[b.kind].cat === 'home' && b.household === (hh?.id ?? -1)));
  if (recipes.length > 0) {
    const reachable = recipes.filter((r) => r.level - skillLevel(p.skills[r.skill]) <= REACH);
    reachable.sort((a, c) => Math.abs(a.level - skillLevel(p.skills[a.skill])) - Math.abs(c.level - skillLevel(p.skills[c.skill])) || a.level - c.level || a.id.localeCompare(c.id));
    const shown = reachable.slice(0, SHOWN).sort((a, c) => a.level - c.level || a.id.localeCompare(c.id));
    for (const r of shown) {
      const place = placeFor(E, p, b, r);
      const gap = gapOf(p, r);
      let reason: string | null = null;
      if (!place.ok) reason = place.reason ?? 'Not your workshop';
      const fee = place.source === 'hired' ? benchFee(r, b) : 0;
      const toolInfo = toolAt(E, p, r, place);
      if (!reason) reason = toolInfo.reason;
      const bags = bagsOf(E, p, place);
      if (!reason) {
        for (const [g, q] of Object.entries(r.inputs)) {
          const need = q * (1 - Math.min(0.5, perkSum(p, r.skill, 'save'))) * wasteFactor(gap);
          if (haveIn(bags, g) + 1e-6 < need) { reason = `Needs ${round1(need)} ${GOODS[g]?.unit ?? g}`; break; }
        }
      }
      if (!reason && fee > 0 && !E.canAfford(p, fee)) reason = `The bench costs ${pd(fee)} to use`;
      const speed = speedOf(E, p, r.skill, 'agi', toolInfo.toolQ);
      const outText = Object.entries(r.outputs).map(([g, q]) => `${q} ${GOODS[g]?.unit ?? g}`).join(', ');
      const terms = place.source === 'employer' ? ' · for your master, paid by the day' : place.source === 'hired' ? ` · you hire the bench for ${pd(fee)}` : '';
      const risk = gap > 0 ? ` · beyond your skill: ${Math.round(spoilChance(gap) * 100)}% the work is spoiled, and more material is used` : '';
      const o = option({
        id: `craft.${r.id}`, label: r.name, seconds: secondsFor(r.work, speed, 6, 120), anim: r.anim, mainHand: r.held,
        preview: `Makes ${outText}${r.quality ? ` · quality from your skill (${r.skill} ${skillLevel(p.skills[r.skill])})` : ''}${terms}${risk}`,
        priority: 30 - r.level - (gap > 0 ? 25 : 0), repeat: true, steps: stepsFor(r, b.kind), ...base,
        data: { act: 'craft', recipe: r.id, building: id, source: place.source, employerHh: place.employer?.id ?? 0, toolQ: toolInfo.toolQ, speed } as CraftAct,
      });
      if (reason) { o.enabled = false; o.reason = reason; } else if (block) { o.enabled = false; o.reason = block; }
      out.push(o);
    }
  }

  // the masterpiece
  maybeMasterpiece(E, p, b, out, base, block);
}

function signatureRecipe(career: string): string | null {
  switch (career) {
    case 'smith': return 'forge_saw';
    case 'carpenter': case 'cooper': case 'wheelwright': return 'make_loom';
    case 'weaver': return 'weave_cloth';
    case 'tailor': return 'sew_cloak';
    case 'tanner': case 'cobbler': case 'saddler': return 'tan_hide';
    case 'mason': return 'cut_stone';
    case 'baker': return 'bake_bread';
    case 'potter': return 'fire_pots';
    case 'chandler': return 'dip_candles';
    default: return null;
  }
}

function maybeMasterpiece(E: Econ, p: Person, b: BuildingState, out: ActionOption[], base: { target: TargetRef; range: number }, block: string | null): void {
  if (CAREERS[p.career].field !== 'craft' || p.careerStage !== 1) return;
  const sig = signatureRecipe(p.career);
  const ce = careerEcon(p.career);
  if (!sig || !ce.workplace.includes(b.kind)) return;
  const r = RECIPES[sig];
  const lvl = skillLevel(p.skills[ce.skill]);
  const bags = [p.inventory, ...(E.hhOf(p) ? [(E.hhOf(p) as Household).stores] : [])];
  let reason: string | null = null;
  if (lvl < 8) reason = `Your craft is not yet fit for the masters' eyes (${ce.skill} 8 needed, you have ${lvl})`;
  else {
    for (const [g, q] of Object.entries(r.inputs)) if (haveIn(bags, g) + 1e-6 < q * 2) { reason = `The masterpiece needs ${q * 2} ${GOODS[g]?.unit ?? g}`; break; }
  }
  const fee = guildFee(E, p);
  if (!reason && fee > 0 && !E.canAfford(p, fee)) reason = `Admission to the guild by redemption costs ${pd(fee)}`;
  const o = option({
    id: 'craft.masterpiece', label: `Make your masterpiece (${r.name.toLowerCase()})`, seconds: secondsFor(r.work * 2.5, 1, 20, 120), anim: r.anim, mainHand: r.held,
    preview: `The guild's masters judge it: fine work makes you a master${fee > 0 ? ` · ${pd(fee)} guild fee by redemption` : ''}`, priority: 55, repeat: false, steps: stepsFor(r, b.kind), ...base,
    data: { act: 'masterpiece', recipe: sig, building: b.id } as CraftAct,
  });
  if (reason) { o.enabled = false; o.reason = reason; } else if (block) { o.enabled = false; o.reason = block; }
  out.push(o);
}

/** Guild freedom is by apprenticeship, patrimony (a master father) or redemption (a fee). */
function guildFee(E: Econ, p: Person): number {
  if (E.save.deeds.includes(`app:${p.id}`)) return 0;
  const father = p.father ? E.person(p.father) : undefined;
  if (father && CAREERS[father.career].field === 'craft' && father.careerStage >= 2) return 0;
  return 60;
}

// ---------------------------------------------------------------------------------------------
// Crafting
// ---------------------------------------------------------------------------------------------

function qualityRoll(E: Econ, p: Person, r: RecipeDef, toolQ: number, bonus = 0): Quality {
  const lvl = skillLevel(p.skills[r.skill]);
  const s = (lvl / 20) * 2.4 + (toolQ - 1) * 0.45 + (p.trained.int - 10) * 0.04 + (p.trained.agi - 10) * 0.02 + perkSum(p, r.skill, 'quality') + bonus
    + E.techBonus(p.settlement, 'craft.quality') * 4 // the guild's standards (+0.05 → a fifth of a grade)
    - 0.1 * gapOf(p, r) // a novice's work shows it
    + E.rng('quality').range(-0.45, 0.45);
  return Math.max(0, Math.min(4, Math.round(s))) as Quality;
}

/** The yield multiplier of a works whose output follows its deposit (a salt pan's brine), 1 at an ordinary seam. */
function depositYield(E: Econ, b: BuildingState, r: RecipeDef): number {
  if (!r.deposit) return 1;
  const d = depositUnder(E, b.x, b.z, [r.deposit as 'salt']);
  return richnessFactor(d?.richness ?? DEFAULT_RICHNESS) / richnessFactor(DEFAULT_RICHNESS);
}

function craftBatch(E: Econ, p: Person, d: CraftData): ActionOutcome {
  const r = RECIPES[d.recipe];
  const b = E.state.buildings.get(d.building);
  if (!r || !b || b.construction < 1) return { ok: false, message: 'That can no longer be made.' };
  const place = placeFor(E, p, b, r);
  if (!place.ok) return { ok: false, message: place.reason };
  const gap = gapOf(p, r);
  if (gap > REACH) return { ok: false, message: `That is far beyond you: it needs ${r.skill} ${r.level}.` };
  const bags = bagsOf(E, p, place);
  const save = Math.min(0.5, perkSum(p, r.skill, 'save'));
  const use = (1 - save) * wasteFactor(gap);
  for (const [g, q] of Object.entries(r.inputs)) if (haveIn(bags, g) + 1e-6 < q * use) return { ok: false, message: `You are short of ${GOODS[g]?.name.toLowerCase() ?? g}.` };
  const toolInfo = toolAt(E, p, r, place);
  if (toolInfo.reason) return { ok: false, message: `${toolInfo.reason}.` };
  const gains: NonNullable<ActionOutcome['gains']> = [];
  // the master's bench is hired for the batch whether or not it comes out well
  if (place.source === 'hired' && place.owner) {
    const fee = benchFee(r, b);
    if (!E.spend(p, fee, `The bench at the ${BUILDINGS[b.kind].name.toLowerCase()}`, true)) return { ok: false, message: `The bench costs ${pd(fee)}.` };
    E.credit(place.owner, fee);
    gains.push({ label: 'Bench', amount: -fee, ref: 'money' });
  }
  const tool = toolInfo.tool;
  const toolQ = toolInfo.toolQ;
  const heavy = r.skill === 'smithing' || r.skill === 'masonry' ? 0.7 : r.skill === 'carpentry' ? 0.55 : 0.25;
  // a novice may spoil the work: most of the material is lost, and something is learnt all the same
  if (gap > 0 && E.rng('craft').next() < spoilChance(gap)) {
    const lost = 0.6 * use;
    let first = '';
    for (const [g, q] of Object.entries(r.inputs)) {
      const got = takeIn(bags, g, round2(q * lost));
      if (got > 0.005) { gains.push({ label: GOODS[g]?.name ?? g, amount: -round2(got), ref: g }); first ||= (GOODS[g]?.name ?? g).toLowerCase(); }
    }
    E.state.touch(p);
    boutDone(E, p, { skill: r.skill, xp: r.xp * 0.7, heavy, bouts: Math.min(3, r.work) });
    wearOut(E, p, tool, 0.012 * r.work, r.skill);
    gains.push({ label: r.skill, ref: r.skill });
    return { ok: true, message: `You spoil the ${r.name.toLowerCase()}: ${first || 'the material'} is wasted. A little is learnt from it.`, gains };
  }
  for (const [g, q] of Object.entries(r.inputs)) takeIn(bags, g, round2(q * use));
  const dest = place.source === 'employer' && place.employer ? place.employer : null;
  const tier = r.quality ? qualityRoll(E, p, r, toolQ) : (1 as Quality);
  const rich = depositYield(E, b, r);
  const made: NonNullable<ActionOutcome['gains']> = [];
  for (const [g, q] of Object.entries(r.outputs)) {
    const qty = Math.max(1, stoch(E, q * rich * (1 + perkSum(p, r.skill, 'yield'))));
    const key = r.quality && GOODS[g]?.quality ? keyOf(g, tier) : g;
    if (dest) { bagAdd(dest.stores, key, qty); E.state.touchHousehold(dest); }
    else giveOutput(E, p, key, qty);
    made.push({ label: `${GOODS[g]?.name ?? g}${r.quality && GOODS[g]?.quality ? ` (${['crude', 'common', 'good', 'fine', 'masterwork'][tier]})` : ''}`, amount: qty, ref: key });
  }
  gains.unshift(...made);
  E.state.touch(p);
  boutDone(E, p, { skill: r.skill, xp: r.xp, heavy, bouts: Math.min(3, r.work) });
  wearOut(E, p, tool, 0.012 * r.work, r.skill);
  if (dest) {
    const pay = payBout(E, p, 'hired', place.wage, r.work, dest);
    if (pay > 0) gains.push({ label: 'Wages', amount: round2(pay), ref: 'money' });
  }
  gains.push({ label: r.skill, ref: r.skill });
  const first = made[0];
  return { ok: true, message: `${r.name}: ${first.amount} ${first.label.toLowerCase()}.`, gains };
}

function apprenticeBout(E: Econ, p: Person, d: ApprenticeData): ActionOutcome {
  const b = E.state.buildings.get(d.building);
  const task = (APPRENTICE_TASKS[b?.kind ?? ''] ?? Object.values(APPRENTICE_TASKS)[0] ?? []).find((t) => t.id === d.task);
  if (!task) return { ok: false };
  const skill = careerEcon(p.career).skill;
  giveXpSkill(E, p, skill, 8);
  boutDone(E, p, { skill, xp: 0, heavy: Math.max(task.str, task.end), str: task.str / Math.max(task.str, task.end), end: task.end / Math.max(task.str, task.end), bouts: 0.8 });
  const gains: NonNullable<ActionOutcome['gains']> = [{ label: skill, ref: skill }];
  let message = `${task.name}: the master nods.`;
  const r = E.rng('apprentice').next();
  if (r < 0.1) { giveXpSkill(E, p, skill, 14); message = 'The master shows you a trick of the trade.'; gains.push({ label: 'A lesson', ref: skill }); }
  else if (r < 0.14) { E.earn(p, 1, 'A tip from the master'); message = 'The master tosses you a penny for a job well done.'; gains.push({ label: 'A penny', amount: 1, ref: 'money' }); }
  return { ok: true, message, gains };
}

function giveXpSkill(E: Econ, p: Person, skill: SkillId, base: number): void { giveXp(E, p, skill, base, 1); }

function masterpiece(E: Econ, p: Person, d: MasterData): ActionOutcome {
  const r = RECIPES[d.recipe];
  const ce = careerEcon(p.career);
  const bags = [p.inventory, ...(E.hhOf(p) ? [(E.hhOf(p) as Household).stores] : [])];
  for (const [g, q] of Object.entries(r.inputs)) if (haveIn(bags, g) + 1e-6 < q * 2) return { ok: false, message: 'You are short of materials for the masterpiece.' };
  const fee = guildFee(E, p);
  if (fee > 0 && !E.canAfford(p, fee)) return { ok: false, message: `The guild wants ${pd(fee)}.` };
  for (const [g, q] of Object.entries(r.inputs)) takeIn(bags, g, q * 2);
  const tool = r.tool ? toolFor(E, p, r.tool) : null;
  const tier = qualityRoll(E, p, r, tool ? tool.quality : 1, 0.35);
  giveXpSkill(E, p, ce.skill, 20);
  if (tier < 2) {
    return { ok: false, message: `The masters turn it over and shake their heads: ${['crude', 'common'][tier]} work. Practise more, then try again.` };
  }
  if (fee > 0) { E.spend(p, fee, 'Guild admission', true); }
  p.careerStage = 2;
  const emp = employmentOf(E, p.id);
  if (emp) { delete E.save.emp[String(p.id)]; E.touchSave(); }
  // out of the master's house into one of his own
  const hh = E.hhOf(p);
  if (hh && emp && hh.head !== p.id) {
    const house = E.state.houses.get(p.house);
    if (house) { const i = house.sworn.indexOf(p.id); if (i >= 0) { house.sworn.splice(i, 1); E.state.touchHouse(house); } }
    E.state.leaveHousehold(p);
    const fresh = E.state.addHousehold({ id: E.state.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement: p.settlement, purse: 0, stores: {} });
    E.state.joinHousehold(p, fresh);
    E.state.setHead(fresh, p);
    foundHouse(E.state, E.rng('house'), p, 'burgher');
    const home = pickHome(E.state, E.rng('home'), p.settlement, ['cottage', 'townhouse', 'hovel']);
    if (home) E.state.setHome(fresh, home.id);
  }
  if (p.rankTier < 3) setRank(E.sim, p, 3);
  E.state.touch(p);
  E.sim.events.emit('careerChanged', { person: p.id, from: p.career, to: p.career, stage: 2 });
  E.deed('masterpiece', 40, `Masterpiece: ${r.name}`);
  E.deed('master', 50, `Became a master ${CAREERS[p.career].label.toLowerCase()}`);
  E.state.log(E.day, 'career', `${p.first} ${p.byname} was admitted a master ${CAREERS[p.career].label.toLowerCase()} by the guild.`, [p.id]);
  return { ok: true, message: `The masters pass your work: you are a master ${CAREERS[p.career].label.toLowerCase()}.`, gains: [{ label: 'Master', ref: 'rank' }] };
}

// ---------------------------------------------------------------------------------------------
// Wood and stone in the open
// ---------------------------------------------------------------------------------------------

function listScatter(E: Econ, p: Person, id: number, out: ActionOption[]): void {
  if (E.sim.view.felled().has(id)) return;
  const it = scatterAt(E, id);
  if (!it) return;
  const target: TargetRef = { kind: 'scatter', id };
  const base = { target, range: 4 };
  const block = holyDayBlock(E) ?? incapable(p);
  const axe = toolFor(E, p, 'axe');
  const pick = toolFor(E, p, 'pick');
  if (TREES.has(it.kind)) {
    if (!axe) { out.push(disabled({ id: 'wood.fell', label: `Fell the ${it.kind}`, ...base }, 'Needs an axe')); return; }
    const speed = speedOf(E, p, 'woodcutting', 'str', axe.quality);
    const timber = Math.max(1, Math.round((1 + 2 * it.scale) * (TIMBER_FACTOR[it.kind] ?? 1)));
    const fee = stumpage(E, p, it);
    const o = option({
      id: 'wood.fell', label: `Fell the ${it.kind}`, seconds: secondsFor(3, speed, 10, 80), anim: 'work_axe', mainHand: 'axe', carry: 'bundle_wood', priority: 40, repeat: false,
      preview: `About ${timber} logs and ${Math.round(3 + 3 * it.scale)} bundles of firewood${fee > 0 ? ` · stumpage ${pd(fee)} to the lord` : ''} · Woodcutting`, ...base,
      data: { act: 'fell', scatter: id, kind: it.kind, scale: it.scale } as CraftAct,
    });
    if (block) { o.enabled = false; o.reason = block; }
    out.push(o);
  } else if (DEADWOOD.has(it.kind)) {
    const speed = speedOf(E, p, 'woodcutting', 'str', axe ? axe.quality : 0) * (axe ? 1.3 : 0.8);
    const o = option({
      id: 'wood.gather', label: `Gather firewood from the ${it.kind === 'deadtree' ? 'dead tree' : it.kind}`, seconds: secondsFor(1, speed, 5, 40), anim: 'work_lift', mainHand: 'none', carry: 'bundle_wood',
      preview: 'Fallen wood may be gathered by anyone: free · Woodcutting', priority: 35, repeat: false, ...base,
      data: { act: 'gather', scatter: id, kind: it.kind, scale: it.scale } as CraftAct,
    });
    if (block) { o.enabled = false; o.reason = block; }
    out.push(o);
  } else if (ROCKS.has(it.kind)) {
    if (!pick) { out.push(disabled({ id: 'wood.quarry', label: 'Break the rock', ...base }, 'Needs a pick')); return; }
    const speed = speedOf(E, p, 'mining', 'str', pick.quality);
    const o = option({
      id: 'wood.quarry', label: it.kind === 'boulder' ? 'Break up the boulder' : 'Break the rock', seconds: secondsFor(2, speed, 8, 60), anim: 'work_pick', mainHand: 'pick', carry: 'stone',
      preview: `About ${Math.max(1, Math.round(it.scale * 2))} blocks of stone · Mining`, priority: 30, repeat: false, ...base,
      data: { act: 'quarry_rock', scatter: id, kind: it.kind, scale: it.scale } as CraftAct,
    });
    if (block) { o.enabled = false; o.reason = block; }
    out.push(o);
  }
}

/** Stumpage: living timber belongs to the lord; the woodward, his men and holders of woodland pay nothing. */
function stumpage(E: Econ, p: Person, it: ScatterItem): number {
  if (p.career === 'woodward' || p.estate === 'noble') return 0;
  const hh = E.hhOf(p);
  if (hh && Object.values(E.save.parcels).some((q) => q.hh === hh.id)) return 0;
  const emp = employmentOf(E, p.id);
  if (emp && (emp.career === 'woodward')) return 0;
  const fee = it.scale > 1.2 ? 3 : 2;
  return Math.round(fee * (1 - Math.min(1, perkSum(p, 'woodcutting', 'fee'))) * 100) / 100;
}

function woodWork(E: Econ, p: Person, d: WoodData): ActionOutcome {
  if (E.sim.view.felled().has(d.scatter)) return { ok: false, message: 'Someone has already taken that.' };
  const gains: NonNullable<ActionOutcome['gains']> = [];
  const yieldMult = 1 + perkSum(p, 'woodcutting', 'yield');
  if (d.act === 'fell') {
    const it = scatterAt(E, d.scatter);
    const axe = toolFor(E, p, 'axe');
    const fee = it ? stumpage(E, p, it) : 0;
    let illegal = false;
    if (fee > 0) {
      if (E.spend(p, fee, 'Stumpage', true)) { const lord = E.lordOf(p.settlement); if (lord?.household) E.credit(lord.household, fee); }
      else illegal = true;
    }
    const timber = Math.max(1, stoch(E, (1 + 2 * d.scale) * (TIMBER_FACTOR[d.kind] ?? 1) * yieldMult));
    const wood = Math.max(2, stoch(E, (3 + 3 * d.scale) * yieldMult));
    giveOutput(E, p, 'timber', timber);
    giveOutput(E, p, 'firewood', wood);
    gains.push({ label: 'Timber', amount: timber, ref: 'timber' }, { label: 'Firewood', amount: wood, ref: 'firewood' });
    if (d.kind === 'apple') { const fruit = Math.max(2, stoch(E, 8 * d.scale)); giveOutput(E, p, 'vegetables', fruit); gains.push({ label: 'Apples', amount: fruit, ref: 'vegetables' }); }
    E.sim.view.markFelled(d.scatter);
    if (it) { E.notes.felled.push({ id: d.scatter, x: it.x, z: it.z, scale: it.scale, logs: timber, day: E.day }); E.notes.rev++; }
    boutDone(E, p, { skill: 'woodcutting', xp: 9, heavy: 1, bouts: 3 });
    wearOut(E, p, axe, 0.02 * 3, 'woodcutting');
    if (illegal && E.rng('woodward').next() < Math.max(0.1, 0.4 - perkSum(p, 'woodcutting', 'fine') * 0.4)) {
      E.sim.events.emit('notify', { kind: 'warn', text: 'The woodward saw you fell a tree without leave: a fine of 6d.', person: p.id });
      addFine(E, p, 6, "Felling a lord's tree without leave", E.lordOf(p.settlement)?.person.id ?? 0);
    }
    gains.push({ label: 'Woodcutting', ref: 'woodcutting' });
    return { ok: true, message: `The ${d.kind} falls: ${timber} logs and ${wood} bundles of firewood.`, gains };
  }
  if (d.act === 'gather') {
    const n = Math.max(1, stoch(E, (2 + 2 * d.scale) * yieldMult));
    giveOutput(E, p, 'firewood', n);
    E.sim.view.markFelled(d.scatter);
    boutDone(E, p, { skill: 'woodcutting', xp: 6, heavy: 0.4, bouts: 1 });
    return { ok: true, message: `You gather ${n} bundles of firewood.`, gains: [{ label: 'Firewood', amount: n, ref: 'firewood' }, { label: 'Woodcutting', ref: 'woodcutting' }] };
  }
  const n = Math.max(1, stoch(E, d.scale * 2 * (1 + perkSum(p, 'mining', 'yield'))));
  giveOutput(E, p, 'stone', n);
  E.sim.view.markFelled(d.scatter);
  const pick = toolFor(E, p, 'pick');
  boutDone(E, p, { skill: 'mining', xp: 8, heavy: 1, bouts: 2 });
  wearOut(E, p, pick, 0.03, 'mining');
  return { ok: true, message: `You break out ${n} blocks of stone.`, gains: [{ label: 'Stone', amount: n, ref: 'stone' }, { label: 'Mining', ref: 'mining' }] };
}

export { BOUT, BOUT_DAYS, careOf, haveOf, CAREER_ECON, TOOL_SPEED, bagGet, creditWeekWork, RENT_PER_STRIP };
export type { BuildingKind };
