// Player work with hands and tools other than the plough (SPEC §6, §11): the crafts at their workshops
// by rung (an apprentice fetches, pumps the bellows and strikes; a journeyman and a master make
// things from recipes, with quality from skill, tool and perks), the masterpiece, felling and
// gathering wood, quarrying stone and mining ore.
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
import { bagAdd, bagGet } from './items';
import { employmentOf } from './jobs';
import { capacityOf, carriedWeight, weightOf } from './own';
import { perkSum } from './perks';
import { RENT_PER_STRIP } from './macro';
import { addFine, creditWeekWork } from './obligations';
import {
  BOUT, BOUT_DAYS, boutDone, careOf, disabled, giveXp, haveOf, holyDayBlock, incapable, option, payBout, round1, round2, secondsFor, speedOf, stoch,
  toolFor, wearOut,
} from './workkit';
import type { SkillId } from '../../core/domain';
import type { Quality } from './types';

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

interface CraftData { act: 'craft'; recipe: string; building: number; source: 'own' | 'employer'; employerHh: number; toolQ: number; speed: number }
interface ApprenticeData { act: 'apprentice'; task: string; building: number }
interface MasterData { act: 'masterpiece'; recipe: string; building: number }
interface WoodData { act: 'fell' | 'gather' | 'quarry_rock'; scatter: number; kind: ScatterKind; scale: number }
interface DigData { act: 'dig'; building: number; what: 'stone' | 'ore' }
type CraftAct = CraftData | ApprenticeData | MasterData | WoodData | DigData;

const TREES: ReadonlySet<ScatterKind> = new Set<ScatterKind>(['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple']);
const DEADWOOD: ReadonlySet<ScatterKind> = new Set<ScatterKind>(['deadtree', 'stump', 'log', 'bush', 'bramble']);
const ROCKS: ReadonlySet<ScatterKind> = new Set<ScatterKind>(['rock_small', 'rock_large', 'boulder']);
const TIMBER_FACTOR: Partial<Record<ScatterKind, number>> = { oak: 1.2, beech: 1.1, pine: 1, spruce: 0.9, birch: 0.8, ash: 0.9, willow: 0.6, apple: 0.5 };

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

interface Place { ok: boolean; reason?: string; source: 'own' | 'employer'; employer?: Household; wage: number; mastery: boolean }

function placeFor(E: Econ, p: Person, b: BuildingState, r: RecipeDef | null): Place {
  const hh = E.hhOf(p);
  const emp = employmentOf(E, p.id);
  const home = BUILDINGS[b.kind].cat === 'home';
  const isOwn = !!hh && (b.household === hh.id || (home && hh.home === b.id));
  if (isOwn) return { ok: true, source: 'own', wage: 0, mastery: true };
  if (emp && emp.employer && (emp.building === b.id || E.person(emp.employer)?.household === b.household) && b.household !== 0) {
    const employerHh = E.household(E.person(emp.employer)?.household ?? 0);
    return { ok: !!employerHh, source: 'employer', employer: employerHh, wage: emp.terms === 'day' || emp.terms === 'season' || emp.terms === 'year' ? emp.wage : 0, mastery: false, reason: 'No master to work for' };
  }
  if (b.household === 0 && !home) {
    // a public facility nobody keeps: the kiln, the saw pit, the charcoal mound, the bloomery
    return { ok: true, source: 'own', wage: 0, mastery: true };
  }
  void r;
  return { ok: false, source: 'own', wage: 0, mastery: false, reason: "Not your workshop: ask the master to take you on, or rent a place" };
}

function stageOk(p: Person, r: RecipeDef, place: Place): string | null {
  if (r.stage < 0) return null;
  if (place.mastery) {
    // your own bench: the trade's skill is enough
    return null;
  }
  const craft = CAREERS[p.career].field === 'craft';
  if (!craft) return 'Only a craftsman bound to a master may work here';
  if (p.careerStage < r.stage) return r.stage === 1 ? 'Apprentices fetch and carry: only a journeyman may make this' : 'Only a master may make this';
  return null;
}

function bagOfSource(E: Econ, p: Person, place: Place): Array<Record<string, number>> {
  const bags: Array<Record<string, number>> = [];
  if (place.source === 'employer' && place.employer) bags.push(place.employer.stores);
  bags.push(p.inventory);
  const hh = E.hhOf(p);
  if (hh && place.source === 'own') bags.push(hh.stores);
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

/** Puts a product in the pack if it can be carried, else in the household's stores. */
export function giveOutput(E: Econ, p: Person, key: string, qty: number): 'pack' | 'stores' {
  const w = weightOf(key, qty);
  const hh = E.hhOf(p);
  if (carriedWeight(p) + w <= capacityOf(p) + 1e-6 || !hh) {
    bagAdd(p.inventory, key, qty);
    E.state.touch(p);
    return 'pack';
  }
  bagAdd(hh.stores, key, qty);
  E.state.touchHousehold(hh);
  return 'stores';
}

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
    check(_ctx, actor, o) {
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
  if (!b) return;
  const target: TargetRef = { kind: 'building', id };
  const base = { target, range: 7 };
  const holy = holyDayBlock(E);
  const weak = incapable(p);
  const block = holy ?? weak;
  const hh = E.hhOf(p);
  const home = BUILDINGS[b.kind].cat === 'home' && !!hh && hh.home === id;
  const emp = employmentOf(E, p.id);

  // quarry and mine
  if (b.kind === 'quarry' || b.kind === 'mine') {
    const pick = toolFor(E, p, 'pick');
    const what = b.kind === 'quarry' ? 'stone' : 'ore';
    const skill = b.kind === 'quarry' ? 'masonry' : 'mining';
    if (!pick) { out.push(disabled({ id: `dig.${what}`, label: b.kind === 'quarry' ? 'Quarry stone' : 'Mine iron ore', ...base }, 'Needs a pick')); }
    else {
      const speed = speedOf(E, p, 'mining', 'str', pick.quality);
      const o = option({
        id: `dig.${what}`, label: b.kind === 'quarry' ? 'Quarry stone' : 'Mine iron ore', seconds: secondsFor(1, speed), anim: 'work_pick', mainHand: 'pick', carry: what === 'stone' ? 'stone' : 'none',
        preview: `${what === 'stone' ? 'Blocks of stone' : 'Baskets of ore'} · ${emp && emp.building === id ? 'paid by the day' : 'a fifth goes to the lord'} · ${skill === 'masonry' ? 'Masonry and Mining' : 'Mining'}`,
        priority: 40, ...base, data: { act: 'dig', building: id, what } as CraftAct,
      });
      if (block) { o.enabled = false; o.reason = block; }
      out.push(o);
    }
  }

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

  // recipes
  const recipes = recipesAt(b.kind, home || (BUILDINGS[b.kind].cat === 'home' && b.household === (hh?.id ?? -1)));
  if (recipes.length > 0) {
    const place = placeFor(E, p, b, null);
    const lvlSkill = (r: RecipeDef): number => skillLevel(p.skills[r.skill]);
    const sorted = recipes.slice().sort((a, c) => a.level - c.level);
    let shown = 0;
    for (const r of sorted) {
      if (shown >= 14) break;
      const my = lvlSkill(r);
      let reason: string | null = null;
      if (!place.ok) reason = place.reason ?? 'Not your workshop';
      else reason = stageOk(p, r, place);
      if (!reason && my < r.level) reason = `Needs ${r.skill} ${r.level}`;
      if (!reason && my + 4 < r.level) continue; // far out of reach: not listed
      const bags = bagOfSource(E, p, place);
      const tool = r.tool ? toolFor(E, p, r.tool) : null;
      let toolQ = tool ? tool.quality : 1;
      if (!reason && r.tool && !tool) {
        // a master's workshop has its anvil, bench and loom for his men
        if (place.source === 'employer' || BUILDINGS[b.kind].cat !== 'home') toolQ = 1;
        else reason = `Needs a ${GOODS[r.tool]?.name.toLowerCase() ?? r.tool}`;
        if (r.tool === 'hammer' || r.tool === 'saw' || r.tool === 'chisel') { if (!tool && place.source === 'own' && !place.mastery) reason = `Needs a ${r.tool}`; }
        else if (!tool && place.source === 'own') reason = `Needs a ${GOODS[r.tool]?.name.toLowerCase() ?? r.tool}`;
      }
      if (!reason) {
        for (const [g, q] of Object.entries(r.inputs)) {
          const need = q * (1 - Math.min(0.5, perkSum(p, r.skill, 'save')));
          if (haveIn(bags, g) + 1e-6 < need) { reason = `Needs ${round1(need)} ${GOODS[g]?.unit ?? g}`; break; }
        }
      }
      const speed = speedOf(E, p, r.skill, 'agi', toolQ) * (r.skill === 'smithing' || r.skill === 'carpentry' || r.skill === 'masonry' ? 1 : 1);
      const outText = Object.entries(r.outputs).map(([g, q]) => `${q} ${GOODS[g]?.unit ?? g}`).join(', ');
      const o = option({
        id: `craft.${r.id}`, label: r.name, seconds: secondsFor(r.work, speed, 6, 120), anim: r.anim, mainHand: r.held,
        preview: `Makes ${outText}${r.quality ? ` · quality from your skill (${r.skill} ${my})` : ''}${place.source === 'employer' ? ' · for your master, paid by the day' : ''}`,
        priority: 30 - r.level, repeat: true, ...base,
        data: { act: 'craft', recipe: r.id, building: id, source: place.source, employerHh: place.employer?.id ?? 0, toolQ, speed } as CraftAct,
      });
      if (reason) { o.enabled = false; o.reason = reason; } else if (block) { o.enabled = false; o.reason = block; }
      out.push(o);
      shown++;
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
    preview: `The guild's masters judge it: fine work makes you a master${fee > 0 ? ` · ${pd(fee)} guild fee by redemption` : ''}`, priority: 55, repeat: false, ...base,
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
    + E.rng('quality').range(-0.45, 0.45);
  return Math.max(0, Math.min(4, Math.round(s))) as Quality;
}

function craftBatch(E: Econ, p: Person, d: CraftData): ActionOutcome {
  const r = RECIPES[d.recipe];
  const b = E.state.buildings.get(d.building);
  if (!r || !b) return { ok: false, message: 'That can no longer be made.' };
  const place = placeFor(E, p, b, r);
  if (!place.ok) return { ok: false, message: place.reason };
  const bags = bagOfSource(E, p, place);
  const save = Math.min(0.5, perkSum(p, r.skill, 'save'));
  for (const [g, q] of Object.entries(r.inputs)) if (haveIn(bags, g) + 1e-6 < q * (1 - save)) return { ok: false, message: `You are short of ${GOODS[g]?.name.toLowerCase() ?? g}.` };
  for (const [g, q] of Object.entries(r.inputs)) takeIn(bags, g, round2(q * (1 - save)));
  const tool = r.tool ? toolFor(E, p, r.tool) : null;
  const toolQ = tool ? tool.quality : d.toolQ;
  const gains: NonNullable<ActionOutcome['gains']> = [];
  const dest = place.source === 'employer' && place.employer ? place.employer : null;
  const tier = r.quality ? qualityRoll(E, p, r, toolQ) : (1 as Quality);
  for (const [g, q] of Object.entries(r.outputs)) {
    const qty = Math.max(1, stoch(E, q * (1 + perkSum(p, r.skill, 'yield'))));
    const key = r.quality && GOODS[g]?.quality ? keyOf(g, tier) : g;
    if (dest) { bagAdd(dest.stores, key, qty); E.state.touchHousehold(dest); }
    else giveOutput(E, p, key, qty);
    gains.push({ label: `${GOODS[g]?.name ?? g}${r.quality && GOODS[g]?.quality ? ` (${['crude', 'common', 'good', 'fine', 'masterwork'][tier]})` : ''}`, amount: qty, ref: key });
  }
  E.state.touch(p);
  boutDone(E, p, { skill: r.skill, xp: r.xp, heavy: r.skill === 'smithing' || r.skill === 'masonry' ? 0.7 : r.skill === 'carpentry' ? 0.55 : 0.25, bouts: Math.min(3, r.work) });
  wearOut(E, p, tool, 0.012 * r.work, r.skill);
  if (dest) {
    const pay = payBout(E, p, 'hired', place.wage, r.work, dest);
    if (pay > 0) gains.push({ label: 'Wages', amount: round2(pay), ref: 'money' });
  }
  gains.push({ label: r.skill, ref: r.skill });
  const first = gains[0];
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

function digBout(E: Econ, p: Person, d: DigData): ActionOutcome {
  const b = E.state.buildings.get(d.building);
  if (!b) return { ok: false };
  const pick = toolFor(E, p, 'pick');
  const skill = d.what === 'stone' ? 'masonry' : 'mining';
  const lvl = skillLevel(p.skills.mining);
  const yieldMult = 1 + perkSum(p, 'mining', 'yield');
  const base = d.what === 'stone' ? 1.6 : 1.2;
  let n = Math.max(1, stoch(E, base * (1 + 0.04 * lvl) * yieldMult));
  const emp = employmentOf(E, p.id);
  const employed = !!emp && emp.building === b.id;
  const gains: NonNullable<ActionOutcome['gains']> = [];
  if (!employed) {
    const lordShare = Math.max(0, Math.round(n * 0.2 * 100) / 100);
    const lord = E.lordOf(b.settlement);
    if (lord?.household && lordShare > 0) { bagAdd(lord.household.stores, d.what === 'stone' ? 'stone' : 'iron_ore', lordShare); E.state.touchHousehold(lord.household); }
    n = Math.max(1, Math.round((n - lordShare) * 100) / 100);
  } else {
    const pay = payBout(E, p, 'hired', emp.wage, 1, E.lordOf(b.settlement)?.household);
    if (pay > 0) gains.push({ label: 'Wages', amount: round2(pay), ref: 'money' });
  }
  giveOutput(E, p, d.what === 'stone' ? 'stone' : 'iron_ore', n);
  boutDone(E, p, { skill: d.what === 'stone' ? 'mining' : 'mining', xp: 8, heavy: 1, bouts: 1 });
  if (d.what === 'stone') giveXpSkill(E, p, 'masonry', 3);
  wearOut(E, p, pick, 0.025, 'mining');
  // the dark has its dangers for the careless
  if (d.what === 'ore' && lvl < 4 && E.rng('mine').next() < 0.012) {
    p.health.hp = Math.max(0.1, p.health.hp - 0.12);
    E.state.touch(p);
    E.notify('A prop gives way: you are bruised and shaken.', 'warn', p.id);
  }
  gains.unshift({ label: d.what === 'stone' ? 'Stone' : 'Iron ore', amount: n, ref: d.what === 'stone' ? 'stone' : 'iron_ore' }, { label: skill, ref: skill });
  void skill;
  return { ok: true, message: `You hew out ${n} ${d.what === 'stone' ? 'blocks of stone' : 'baskets of ore'}.`, gains };
}

export { BOUT, BOUT_DAYS, careOf, haveOf, CAREER_ECON, TOOL_SPEED, bagGet, creditWeekWork, RENT_PER_STRIP };
export type { BuildingKind };
