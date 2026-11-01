// Player work on the land (SPEC §10): every task on a strip — plough, harrow, sow, weed, reap or mow,
// bind, carry — then the barn (thresh, winnow), the mill and the quern, the croft garden, meadows
// and manure. Each action is a timed bout of 5–30 seconds; its progress is kept on the strip, so
// partial work counts, and the household's own people finish whatever is left (farm.ts).
import type { CropKind } from '../../core/domain';
import type { ActionOption, ActionOutcome, ActionProvider, TargetRef } from '../actions';
import { BUILDINGS } from '../../content/types';
import {
  CALENDAR, CROPS, GARDEN_CROPS, SPRING_CROP_LIST, WINTER_CROPS, dropExtra, extraOf, gardenProgress, peekExtra, roleOn, type GardenBed,
} from '../farming';
import { skillLevel } from '../people';
import type { Person, StripState } from '../state';
import type { Econ } from './core';
import { CAREER_ECON, GOODS, TOOL_SPEED, pd } from './data';
import {
  TASK_BOUTS, TITHE, grossYield, nextTask, payTithe, seedFor, sowingNow, taskLabel, type StripTask,
} from './farm';
import { bagAdd, bagGet, bagTake, bestOf, countGood } from './items';
import { applyForJob, employmentOf } from './jobs';
import { capacityOf, carriedWeight } from './own';
import { perkSum, perkTotal } from './perks';
import {
  BOUT_DAYS, boutDone, careOf, disabled, haveOf, holyDayBlock, incapable, option, payBout, round1, round2, secondsFor, speedOf, stoch,
  toolFor, wearOut, type AccessMode, type ToolRef,
} from './workkit';
import { creditWeekWork } from './obligations';
import { keyOf } from './data';

// ---------------------------------------------------------------------------------------------
// Who may work a strip
// ---------------------------------------------------------------------------------------------

export type Access = { ok: true; mode: AccessMode; wage: number; employer?: number } | { ok: false; reason: string };

export function stripAccess(E: Econ, p: Person, st: StripState): Access {
  const hh = E.hhOf(p);
  if (hh && st.holder === hh.id) return { ok: true, mode: 'own', wage: 0 };
  const emp = employmentOf(E, p.id);
  if (st.holder === 0) {
    if (p.estate === 'unfree' && E.age(p) >= 14 && p.settlement === st.settlement) return { ok: true, mode: 'week', wage: 0 };
    if (emp && emp.terms === 'day' && emp.settlement === st.settlement) {
      const lord = E.lordOf(st.settlement);
      return { ok: true, mode: 'hired', wage: emp.wage, employer: lord?.household?.id };
    }
    return { ok: false, reason: "The lord's land: take day work from the reeve to labour here" };
  }
  const holder = E.household(st.holder);
  if (emp && holder && emp.employer && E.person(emp.employer)?.household === holder.id) return { ok: true, mode: 'hired', wage: emp.wage, employer: holder.id };
  return { ok: false, reason: 'Not your strip' };
}

// ---------------------------------------------------------------------------------------------
// Data carried by options
// ---------------------------------------------------------------------------------------------

interface StripData {
  act: 'strip';
  task: StripTask;
  strip: number;
  method: string;
  tool?: string;
  crop?: CropKind;
  fee: number;
  mult: number;
  yieldMult: number;
  access: AccessMode;
  wage: number;
  employer?: number;
  bouts: number;
}
interface BarnData { act: 'thresh' | 'winnow' | 'mill' | 'quern' | 'unload'; good?: string; building: number }
interface GardenData { act: 'garden'; step: 'dig' | 'sow' | 'weed' | 'harvest'; bed: number; crop?: string }
interface CarryData { act: 'carry'; strip: number }
interface MowData { act: 'mow'; parcel: number }
interface ManureData { act: 'manure'; strip: number }
interface JoinData { act: 'hire_on'; job: number }
type FarmData = StripData | BarnData | GardenData | CarryData | MowData | ManureData | JoinData;

const SHEAF_GOODS = ['wheat_sheaf', 'rye_sheaf', 'barley_sheaf', 'oats_sheaf', 'legume_sheaf'] as const;
const SHEAF_CROP: Record<string, string> = { wheat_sheaf: 'wheat', rye_sheaf: 'rye', barley_sheaf: 'barley', oats_sheaf: 'oats', legume_sheaf: 'peas' };
const GRAIN_GOODS = ['wheat', 'rye', 'barley', 'oats', 'peas', 'beans'] as const;
const FLOUR_PER_GALLON: Record<string, number> = { wheat: 6.8, rye: 6.4, barley: 5.6, oats: 4.4, peas: 6, beans: 6 };

const BARN_KINDS: ReadonlySet<string> = new Set(['barn', 'tithe_barn', 'granary']);
const HOME_KINDS: ReadonlySet<string> = new Set(['hovel', 'cottage', 'longhouse', 'townhouse', 'manor_house']);

function sheavesHeld(E: Econ, p: Person): Array<{ good: string; qty: number }> {
  const out: Array<{ good: string; qty: number }> = [];
  for (const g of SHEAF_GOODS) {
    const n = bagGet(p.inventory, g) + (E.hhOf(p) ? bagGet((E.hhOf(p) as { stores: Record<string, number> }).stores, g) : 0);
    if (n > 0.05) out.push({ good: g, qty: n });
  }
  return out;
}

function countAll(E: Econ, p: Person, good: string): number { return haveOf(E, p, good); }

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export function farmProvider(E: Econ): ActionProvider {
  return {
    id: 'farm',
    partial: true,

    list(_ctx, actor, target, out) {
      const p = E.person(actor);
      if (!p || p.death) return;
      if (target.kind === 'strip') listStrip(E, p, target.id, out);
      else if (target.kind === 'building') listBuilding(E, p, target.id, out);
      else if (target.kind === 'parcel') listParcel(E, p, target.id, out);
    },

    check(_ctx, actor, o) {
      const p = E.person(actor);
      if (!p) return 'Nobody there';
      const bad = incapable(p) ?? (o.data && (o.data as FarmData).act !== 'unload' ? holyDayBlock(E) : null);
      if (bad) return bad;
      const d = o.data as FarmData;
      if (d.act === 'strip') {
        const st = E.state.strips.get(d.strip);
        if (!st) return 'The strip is gone';
        if (nextTask(E, st) !== d.task) return 'The strip needs something else now';
        if (d.task === 'sow' && d.crop) {
          const need = seedFor(E, st, d.crop) / d.bouts;
          if (haveOf(E, p, 'seed_corn') + haveOf(E, p, CROPS[d.crop].good) < need * 0.5) return 'You have run out of seed';
        }
        if (d.fee > 0 && !E.canAfford(p, d.fee / d.bouts)) return 'You cannot pay for the plough team';
      } else if (d.act === 'thresh') {
        if (sheavesHeld(E, p).length === 0) return 'No sheaves left to thresh';
      }
      return null;
    },

    complete(_ctx, actor, o, fraction) {
      const p = E.person(actor);
      if (!p || p.death) return { ok: false };
      const d = o.data as FarmData;
      switch (d.act) {
        case 'strip': return stripBout(E, p, d, fraction);
        case 'carry': return carryTrip(E, p, d);
        case 'thresh': return threshBout(E, p, d, fraction);
        case 'winnow': return winnowBout(E, p, d, fraction);
        case 'mill': return millBout(E, p, d, fraction);
        case 'quern': return millBout(E, p, d, fraction);
        case 'unload': return unloadAll(E, p);
        case 'garden': return gardenBout(E, p, d, fraction);
        case 'mow': return mowBout(E, p, d, fraction);
        case 'manure': return spreadManure(E, p, d, fraction);
        case 'hire_on': {
          const r = applyForJob(E, p.id, d.job);
          return { ok: r.ok, message: r.ok ? 'You are taken on as a hired hand.' : r.reason };
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Listing: strips
// ---------------------------------------------------------------------------------------------

function waitReason(E: Econ, st: StripState): string {
  const ex = peekExtra(E.farm, st.id);
  switch (st.state) {
    case 'fallow': case 'bare': return 'Fallow: ploughing is in spring (spring crop) or autumn (winter corn)';
    case 'stubble': return ex && (ex.k ?? 0) > 0 ? 'Sheaves wait to be carried' : 'Stubble: ploughing is in spring or autumn';
    case 'ploughed': return 'Wait for sowing time: spring for barley, oats and pulse; autumn for wheat and rye';
    case 'sown': case 'growing': {
      const roles = roleOn(st.field, E.day);
      return roles === 1 || roles === 0 ? 'Growing: it ripens in a few days' : 'Growing';
    }
    default: return 'Nothing to do now';
  }
}

function listStrip(E: Econ, p: Person, id: number, out: ActionOption[]): void {
  const st = E.state.strips.get(id);
  if (!st) return;
  const target: TargetRef = { kind: 'strip', id };
  const acc = stripAccess(E, p, st);
  const holy = holyDayBlock(E);
  const weak = incapable(p);
  const ex = peekExtra(E.farm, id);
  const base = { target, range: 16 };
  if (!acc.ok) {
    out.push(disabled({ id: 'farm.work', label: 'Work the strip', ...base }, acc.reason));
    // a free hand without a post may ask for day work on the lord's land
    if (st.holder === 0 && p.estate !== 'unfree' && E.age(p) >= 12) {
      const emp = employmentOf(E, p.id);
      const job = E.settlementById.get(st.settlement) ? undefined : undefined;
      void job;
      const wage = E.age(p) >= 14 ? 2 : 1;
      out.push(option({
        id: 'farm.hire_on', label: `Take day work here (${pd(wage)} a day)`, seconds: 0, category: 'work', priority: 5, repeat: false, ...base,
        enabled: !emp, reason: emp ? 'You are already bound to a post' : undefined, data: { act: 'hire_on', job: -1 } as FarmData,
      }));
      const hireOn = out[out.length - 1];
      // resolve the job id lazily: the reeve's farmhand post of this settlement
      const jobs = jobIdFor(E, st.settlement, p);
      if (jobs !== null) (hireOn.data as JoinData).job = jobs; else { hireOn.enabled = false; hireOn.reason = 'The reeve has no work for you'; }
    }
    return;
  }
  const t = nextTask(E, st);
  if (!t) {
    // manure on resting land is always welcome
    if (st.state === 'fallow' || st.state === 'stubble' || st.state === 'ploughed') pushManure(E, p, st, base, out, holy ?? weak);
    out.push(disabled({ id: 'farm.wait', label: 'Check the strip', ...base }, waitReason(E, st)));
    return;
  }
  const o = taskOption(E, p, st, t, acc, base);
  if (o) {
    if (holy) { o.enabled = false; o.reason = holy; } else if (weak) { o.enabled = false; o.reason = weak; }
    out.push(o);
  }
  if (t === 'plough' || t === 'harrow' || t === 'sow') pushManure(E, p, st, base, out, holy ?? weak);
  // sowing offers one option per seed on hand
  if (t === 'sow') {
    for (const alt of sowAlternatives(E, p, st, acc, base)) { if (holy || weak) { alt.enabled = false; alt.reason = holy ?? weak ?? undefined; } out.push(alt); }
  }
  // the other tool for the harvest
  if (t === 'reap') {
    const alt = reapAlternative(E, p, st, acc, base);
    if (alt) { if (holy || weak) { alt.enabled = false; alt.reason = holy ?? weak ?? undefined; } out.push(alt); }
  }
  if (ex && (ex.k ?? 0) > 0.5 && t !== 'carry' && (st.state === 'stubble')) {
    const c = taskOption(E, p, st, 'carry', acc, base);
    if (c) out.push(c);
  }
  if ((t === 'weed') === false && (st.state === 'sown' || st.state === 'growing') && !ex?.w) {
    const w = taskOption(E, p, st, 'weed', acc, base);
    if (w) out.push(w);
  }
}

function jobIdFor(E: Econ, sid: number, p: Person): number | null {
  // the reeve's (or the lord's) farm-hand post: job kind 0 of the employer, see jobs.ts
  const reeve = E.state.residentsOf(sid).find((r) => !r.death && r.offices.some((o) => o.office === 'reeve' && o.place === sid));
  const employer = reeve?.id ?? E.lordOf(sid)?.person.id ?? 0;
  if (employer <= 0) return 1_000_000_000 + sid * 20;
  void p;
  return employer * 20;
}

function stripWork(E: Econ, st: StripState, acc: Extract<Access, { ok: true }>): { access: AccessMode; wage: number; employer?: number } {
  return { access: acc.mode, wage: acc.wage, employer: acc.employer };
}

function taskOption(E: Econ, p: Person, st: StripState, task: StripTask, acc: Extract<Access, { ok: true }>, base: { target: TargetRef; range: number }): ActionOption | null {
  const ex = peekExtra(E.farm, st.id);
  const W = TASK_BOUTS[task === 'carry' ? 'carry' : task];
  const work = stripWork(E, st, acc);
  const hh = E.hhOf(p);
  const sk = skillLevel(p.skills.farming);
  const pct = Math.round((ex?.p ?? 0) * 100);
  const common = { act: 'strip' as const, strip: st.id, bouts: W, fee: 0, mult: 1, yieldMult: 1, ...work, task };
  const prog = pct > 0 ? `${pct}% done · ` : '';
  const yieldMult = 1 + perkSum(p, 'farming', 'yield') + (hh && hh.head === p.id ? perkSum(p, 'stewardship', 'yield') : 0);
  switch (task) {
    case 'plough': {
      const plough = toolFor(E, p, 'plough');
      const oxen = hh ? bagGet(hh.stores, 'ox') : 0;
      let horses = 0;
      if (hh) for (const q of [0, 1, 2, 3, 4]) horses += bagGet(hh.stores, `horse#${q}`);
      const spade = toolFor(E, p, 'spade');
      let method: string, toolQ: number, mult: number, fee = 0, anim: ActionOption['anim'] = 'work_hoe', held: ActionOption['mainHand'] = 'staff', tool: ToolRef | null = plough;
      if (plough && (oxen >= 2 || horses >= 1)) { method = 'team'; toolQ = plough.quality; mult = 1; }
      else if (E.canAfford(p, 4)) { method = 'hire'; toolQ = 1; mult = 0.85; fee = 4; tool = null; }
      else if (spade) { method = 'spade'; toolQ = spade.quality; mult = 0.22; anim = 'work_dig'; held = 'spade'; tool = spade; }
      else return disabled({ id: 'farm.plough', label: 'Plough', ...base }, 'Needs a plough team (hire the village team for 4d) or at least a spade');
      const speed = speedOf(E, p, 'farming', 'str', toolQ) * mult;
      const how = method === 'team' ? 'your own team' : method === 'hire' ? 'the village team, 4d' : 'by hand with a spade (slow)';
      return option({
        id: 'farm.plough', label: `Plough (${method === 'team' ? 'own team' : method === 'hire' ? 'hired team' : 'spade'})`, seconds: secondsFor(1, speed), anim, mainHand: held,
        preview: `${prog}Ploughs a ridge · ${how} · Farming`, priority: 50, ...base,
        data: { ...common, method, tool: tool?.key, fee, mult, yieldMult } as FarmData,
      });
    }
    case 'harrow': {
      const harrow = toolFor(E, p, 'harrow');
      const hoe = toolFor(E, p, 'hoe');
      const method = harrow ? 'harrow' : 'village';
      const q = harrow ? harrow.quality : hoe ? Math.max(0, hoe.quality - 1) : 1;
      const speed = speedOf(E, p, 'farming', 'str', q) * (harrow ? 1 : 0.8);
      return option({
        id: 'farm.harrow', label: harrow ? 'Harrow' : 'Harrow (the village harrow)', seconds: secondsFor(1, speed), anim: 'work_hoe', mainHand: harrow ? 'staff' : 'hoe',
        preview: `${prog}Breaks the clods before sowing · Farming`, priority: 50, ...base, data: { ...common, method, tool: harrow?.key, yieldMult } as FarmData,
      });
    }
    case 'sow': {
      const sw = sowingNow(E, st);
      if (!sw) return disabled({ id: 'farm.sow', label: 'Sow', ...base }, waitReason(E, st));
      const have = haveOf(E, p, 'seed_corn') + haveOf(E, p, CROPS[sw.crop].good);
      const need = seedFor(E, st, sw.crop);
      if (have < need * 0.35) return disabled({ id: 'farm.sow', label: `Sow ${sw.crop}`, ...base }, `Needs seed corn: about ${round1(need)} gallons (buy some at the market)`);
      const speed = speedOf(E, p, 'farming', 'agi', null);
      return option({
        id: 'farm.sow', label: `Sow ${sw.crop}`, seconds: secondsFor(1, speed), anim: 'work_sow', mainHand: 'basket', carry: 'none',
        preview: `${prog}Takes ${round1(need)} gallons of seed · ${have < need ? 'a thin sowing' : 'a full sowing'} · Farming`, priority: 50, ...base,
        data: { ...common, method: 'broadcast', crop: sw.crop, yieldMult: yieldMult * (1 - perkSum(p, 'farming', 'save') * 0) } as FarmData,
      });
    }
    case 'weed': {
      const hoe = toolFor(E, p, 'hoe');
      const speed = speedOf(E, p, 'farming', 'str', hoe ? hoe.quality : 0) * (hoe ? 1 : 0.7);
      return option({
        id: 'farm.weed', label: 'Weed', seconds: secondsFor(1, speed), anim: 'work_hoe', mainHand: 'hoe', preview: `${prog}Unweeded corn yields a seventh less · Farming`, priority: ex?.w ? 5 : 40, ...base,
        data: { ...common, method: hoe ? 'hoe' : 'hand', tool: hoe?.key, yieldMult } as FarmData,
      });
    }
    case 'reap': {
      const sickle = toolFor(E, p, 'sickle');
      const scythe = toolFor(E, p, 'scythe');
      const tool = sickle ?? scythe;
      if (!tool) return disabled({ id: 'farm.reap', label: 'Reap', ...base }, 'Needs a sickle (the smith sells them)');
      const isScythe = !sickle && !!scythe;
      const speed = speedOf(E, p, 'farming', 'str', tool.quality) * (isScythe ? 1.7 : 1);
      const crop = st.crop;
      const gross = Math.round(grossYield(E, st, ex, crop, yieldMult * (isScythe ? 0.93 : 1)));
      return option({
        id: 'farm.reap', label: `Reap ${crop}`, seconds: secondsFor(1, speed), anim: isScythe ? 'work_scythe' : 'work_sickle', mainHand: isScythe ? 'scythe' : 'sickle',
        preview: `${prog}About ${gross} sheaves from the strip · ${isScythe ? 'scythe: quick but wasteful · ' : ''}Farming`, priority: 60, ...base,
        data: { ...common, method: isScythe ? 'scythe' : 'sickle', tool: tool.key, yieldMult: yieldMult * (isScythe ? 0.93 : 1) } as FarmData,
      });
    }
    case 'bind': {
      const speed = speedOf(E, p, 'farming', 'agi', null);
      const k = Math.round(ex?.k ?? 0);
      return option({
        id: 'farm.bind', label: 'Bind sheaves', seconds: secondsFor(1, speed), anim: 'work_lift', mainHand: 'none', carry: 'sheaf',
        preview: `${prog}Binds about ${k} sheaves; every tenth is the parson's tithe · Farming`, priority: 60, ...base, data: { ...common, method: 'hand', yieldMult } as FarmData,
      });
    }
    case 'carry': {
      const k = Math.round(ex?.k ?? 0);
      if (k < 1) return null;
      const free = Math.floor((capacityOf(p) - carriedWeight(p)) / 3);
      if (free < 1) return disabled({ id: 'farm.carry', label: 'Carry sheaves to the barn', ...base }, 'Your arms are full: store what you carry in the barn first');
      return option({
        id: 'farm.carry', label: `Carry sheaves to the barn (${Math.min(k, free)} of ${k})`, seconds: 6, anim: 'carry_walk', mainHand: 'none', carry: 'sheaf',
        preview: `Takes up to ${Math.min(k, free)} sheaves; then store them at the barn · Farming`, priority: 55, repeat: false, ...base,
        data: { act: 'carry', strip: st.id } as FarmData,
      });
    }
  }
  void sk;
}

function pushManure(E: Econ, p: Person, st: StripState, base: { target: TargetRef; range: number }, out: ActionOption[], block: string | null): void {
  const have = haveOf(E, p, 'manure');
  const ex = peekExtra(E.farm, st.id);
  if (have < 1 || (ex?.m ?? 0) >= 0.25) return;
  const speed = speedOf(E, p, 'farming', 'str', null);
  const o = option({
    id: 'farm.manure', label: 'Spread manure', seconds: secondsFor(1.5, speed), anim: 'work_lift', mainHand: 'pitchfork', carry: 'none',
    preview: 'A load of manure enriches the soil for the next crop · Farming', priority: 8, repeat: false, ...base, data: { act: 'manure', strip: st.id } as FarmData,
  });
  if (block) { o.enabled = false; o.reason = block; }
  out.push(o);
}

function sowAlternatives(E: Econ, p: Person, st: StripState, acc: Extract<Access, { ok: true }>, base: { target: TargetRef; range: number }): ActionOption[] {
  const sw = sowingNow(E, st);
  if (!sw) return [];
  const role = roleOn(st.field, E.day);
  const crops: CropKind[] = role === 2 ? [...WINTER_CROPS] : [...new Set(SPRING_CROP_LIST)];
  const out: ActionOption[] = [];
  for (const c of crops) {
    if (c === sw.crop) continue;
    const have = haveOf(E, p, CROPS[c].good) + haveOf(E, p, 'seed_corn');
    const need = seedFor(E, st, c);
    if (have < need * 0.35) continue;
    const speed = speedOf(E, p, 'farming', 'agi', null);
    const hh = E.hhOf(p);
    const yieldMult = 1 + perkSum(p, 'farming', 'yield') + (hh && hh.head === p.id ? perkSum(p, 'stewardship', 'yield') : 0);
    const work = stripWork(E, st, acc);
    out.push(option({
      id: `farm.sow.${c}`, label: `Sow ${c}`, seconds: secondsFor(1, speed), anim: 'work_sow', mainHand: 'basket',
      preview: `Takes ${round1(need)} gallons of seed · Farming`, priority: 30, ...base,
      data: { act: 'strip', task: 'sow', strip: st.id, bouts: TASK_BOUTS.sow, fee: 0, mult: 1, yieldMult, method: 'broadcast', crop: c, ...work } as FarmData,
    }));
  }
  return out;
}

function reapAlternative(E: Econ, p: Person, st: StripState, acc: Extract<Access, { ok: true }>, base: { target: TargetRef; range: number }): ActionOption | null {
  const sickle = toolFor(E, p, 'sickle');
  const scythe = toolFor(E, p, 'scythe');
  if (!sickle || !scythe) return null;
  const hh = E.hhOf(p);
  const yieldMult = 1 + perkSum(p, 'farming', 'yield') + (hh && hh.head === p.id ? perkSum(p, 'stewardship', 'yield') : 0);
  const speed = speedOf(E, p, 'farming', 'str', scythe.quality) * 1.7;
  const work = stripWork(E, st, acc);
  return option({
    id: 'farm.reap.scythe', label: `Mow ${st.crop} with the scythe`, seconds: secondsFor(1, speed), anim: 'work_scythe', mainHand: 'scythe',
    preview: 'Nearly twice as fast, but a little grain is shaken out · Farming', priority: 30, ...base,
    data: { act: 'strip', task: 'reap', strip: st.id, bouts: TASK_BOUTS.reap, fee: 0, mult: 1, yieldMult: yieldMult * 0.93, method: 'scythe', tool: scythe.key, ...work } as FarmData,
  });
}

// ---------------------------------------------------------------------------------------------
// One bout on a strip
// ---------------------------------------------------------------------------------------------

function takeSeed(E: Econ, p: Person, good: string, qty: number): number {
  let need = qty;
  const hh = E.hhOf(p);
  for (const [bag, owner] of [[p.inventory, 'p'], [hh?.stores, 'h']] as const) {
    if (!bag || need <= 0.001) continue;
    for (const g of ['seed_corn', good]) {
      const t = Math.min(need, bagGet(bag, g));
      if (t > 0) { bagAdd(bag, g, -t); need -= t; }
    }
    if (owner === 'p') E.state.touch(p); else if (hh) E.state.touchHousehold(hh);
  }
  return qty - need;
}

function stripBout(E: Econ, p: Person, d: StripData, f: number): ActionOutcome {
  const st = E.state.strips.get(d.strip);
  if (!st) return { ok: false, message: 'The strip is gone.' };
  if (nextTask(E, st) !== d.task) return { ok: false, message: 'The strip needs something else now.' };
  const ex = extraOf(E.farm, st.id);
  const gains: NonNullable<ActionOutcome['gains']> = [];
  const heavy = d.task === 'plough' ? 1 : d.task === 'reap' ? 0.9 : d.task === 'weed' ? 0.55 : d.task === 'harrow' ? 0.6 : d.task === 'bind' ? 0.5 : d.task === 'sow' ? 0.25 : 0.3;
  // what the bout uses up
  if (d.fee > 0) {
    if (!E.spend(p, (d.fee / d.bouts) * f, 'Hired plough team', true)) return { ok: false, message: 'You cannot pay for the team.' };
    const team = E.state.householdList(st.settlement).find((h) => (h.stores.ox ?? 0) >= 2 && h.id !== E.hhOf(p)?.id);
    if (team) E.credit(team, (d.fee / d.bouts) * f);
  }
  if (d.task === 'sow' && d.crop) {
    const need = (seedFor(E, st, d.crop) / d.bouts) * f;
    const got = takeSeed(E, p, CROPS[d.crop].good, need);
    ex.t = round2(Math.min(1, (ex.t ?? 0) + got / seedFor(E, st, d.crop)));
    if (got < need * 0.5) return { ok: false, message: 'You are out of seed.' };
  }
  const tool = d.tool ? toolFor(E, p, d.tool.split('#')[0]) : null;
  const skill = 'farming' as const;
  const toolQ = tool ? tool.quality : null;
  // progress
  ex.p = Math.round(((ex.p ?? 0) + f / d.bouts) * 1000) / 1000;
  const care = careOf(p, skill, toolQ);
  const w = 0.2 * f;
  ex.c = Math.max(0.3, Math.min(1, round2((ex.c ?? 0.5) * (1 - w) + care * w)));
  ex.a = p.id;
  boutDone(E, p, { skill, xp: d.task === 'plough' || d.task === 'reap' ? 9 : 7, heavy, bouts: f });
  wearOut(E, p, tool, (d.task === 'reap' ? 0.02 : 0.012) * f, skill);
  const employer = d.employer ? E.household(d.employer) : undefined;
  const pay = payBout(E, p, d.access, d.wage, f, employer);
  if (pay > 0) gains.push({ label: 'Wages', amount: round2(pay), ref: 'money' });
  if (d.access === 'week') gains.push({ label: "Week-work for the lord", amount: round2(BOUT_DAYS * f), ref: 'days' });
  let message = `${taskLabel(d.task, st)}: ${Math.min(100, Math.round(ex.p * 100))}%.`;
  if (ex.p >= 0.985) {
    ex.p = 0;
    const done = finishTask(E, p, st, ex, d);
    message = done.message;
    gains.push(...done.gains);
  }
  E.touchFarm();
  gains.push({ label: 'Farming', ref: 'farming' });
  return { ok: true, message, gains };
}

function finishTask(E: Econ, p: Person, st: StripState, ex: ReturnType<typeof extraOf>, d: StripData): { message: string; gains: NonNullable<ActionOutcome['gains']> } {
  const gains: NonNullable<ActionOutcome['gains']> = [];
  const now = Math.round(E.day * 100) / 100;
  switch (d.task) {
    case 'plough':
      st.state = 'ploughed'; st.crop = 'fallow'; st.growth = 0; delete ex.h;
      E.state.touchStrip(st);
      return { message: 'The strip is ploughed. Harrow it before sowing.', gains };
    case 'harrow':
      ex.h = 1;
      E.state.touchStrip(st);
      return { message: 'The strip is harrowed and ready for the seed.', gains };
    case 'sow': {
      const crop = d.crop ?? 'barley';
      st.crop = crop; st.state = 'sown'; st.growth = 0.04;
      ex.s = now; ex.t = Math.max(0.35, Math.min(1, ex.t ?? 1)); ex.y = round2(d.yieldMult);
      delete ex.w; delete ex.r; ex.k = 0;
      E.state.touchStrip(st);
      return { message: `Sown with ${crop}. It will take ${CROPS[crop].grow < 4.2 ? 'about four' : 'about five'} days of growing weather.`, gains };
    }
    case 'weed':
      ex.w = 1;
      return { message: 'The strip is weeded: the corn has room to grow.', gains };
    case 'reap': {
      const gross = Math.round(grossYield(E, st, ex, st.crop, d.yieldMult));
      ex.k = gross; ex.r = now;
      st.state = 'harvested';
      E.state.touchStrip(st);
      gains.push({ label: 'Sheaves cut', amount: gross, ref: 'sheaf' });
      return { message: `The crop is down: about ${gross} sheaves lie to be bound.`, gains };
    }
    case 'bind': {
      const k = ex.k ?? 0;
      const tithe = Math.round(k * TITHE);
      const s = E.settlementById.get(st.settlement);
      if (s && tithe > 0) payTithe(E, s, CROPS[st.crop]?.good ?? 'wheat', tithe);
      ex.k = Math.max(0, k - tithe); ex.r = now;
      st.state = 'stubble';
      E.state.touchStrip(st);
      gains.push({ label: 'Sheaves bound', amount: ex.k, ref: 'sheaf' });
      return { message: `${ex.k} sheaves stand bound; ${tithe} are the parish's tenth. Carry the rest to the barn.`, gains };
    }
    default:
      return { message: 'Done.', gains };
  }
}

function carryTrip(E: Econ, p: Person, d: CarryData): ActionOutcome {
  const st = E.state.strips.get(d.strip);
  const ex = st ? peekExtra(E.farm, st.id) : undefined;
  if (!st || !ex || (ex.k ?? 0) < 1) return { ok: false, message: 'No sheaves left there.' };
  const def = CROPS[st.crop];
  const free = Math.floor((capacityOf(p) - carriedWeight(p)) / 3);
  const n = Math.min(Math.floor(ex.k as number), free);
  if (n < 1) return { ok: false, message: 'Your arms are full.' };
  bagAdd(p.inventory, def.sheaf, n);
  E.state.touch(p);
  ex.k = round2((ex.k as number) - n);
  if ((ex.k as number) < 0.5) {
    const keep = ex.m;
    for (const k of Object.keys(ex) as Array<keyof typeof ex>) delete ex[k];
    if (keep) ex.m = keep; else dropExtra(E.farm, st.id);
  }
  boutDone(E, p, { skill: 'farming', xp: 4, heavy: 0.5, bouts: 1 });
  E.touchFarm();
  return { ok: true, message: `You carry ${n} sheaves. Take them to the barn.`, gains: [{ label: 'Sheaves', amount: n, ref: def.sheaf }] };
}

function spreadManure(E: Econ, p: Person, d: ManureData, f: number): ActionOutcome {
  const st = E.state.strips.get(d.strip);
  if (!st) return { ok: false };
  const hh = E.hhOf(p);
  let took = bagTake(p.inventory, 'manure', f) ? 'p' : '';
  if (!took && hh && bagTake(hh.stores, 'manure', f)) took = 'h';
  if (!took) return { ok: false, message: 'No manure left.' };
  const ex = extraOf(E.farm, st.id);
  ex.m = round2(Math.min(0.3, (ex.m ?? 0) + 0.12 * f));
  boutDone(E, p, { skill: 'farming', xp: 5, heavy: 0.8, bouts: f });
  E.state.touch(p);
  E.touchFarm();
  return { ok: true, message: 'The soil is richer for it.', gains: [{ label: 'Soil', ref: 'farming' }] };
}

// ---------------------------------------------------------------------------------------------
// Listing: buildings (barn, mill, home garden) and parcels
// ---------------------------------------------------------------------------------------------

function listBuilding(E: Econ, p: Person, id: number, out: ActionOption[]): void {
  const b = E.state.buildings.get(id);
  if (!b) return;
  const target: TargetRef = { kind: 'building', id };
  const hh = E.hhOf(p);
  const own = !!hh && (hh.home === id || b.household === hh.id);
  const holy = holyDayBlock(E);
  const weak = incapable(p);
  const block = holy ?? weak;
  const base = { target, range: 7 };
  const push = (o: ActionOption, free = false): void => { if (block && !free) { o.enabled = false; o.reason = block; } out.push(o); };
  const barn = BARN_KINDS.has(b.kind) || (own && HOME_KINDS.has(b.kind));

  if (barn) {
    const sheaves = sheavesHeld(E, p);
    const carried = SHEAF_GOODS.reduce((s, g) => s + bagGet(p.inventory, g), 0);
    const anyCarried = SHEAF_GOODS.some((g) => bagGet(p.inventory, g) > 0) || bagGet(p.inventory, 'manure') > 0;
    if (anyCarried && hh) push(option({ id: 'farm.unload', label: `Store ${Math.round(carried)} sheaves in the barn`, seconds: 0, anim: 'work_lift', mainHand: 'none', priority: 70, repeat: false, preview: 'Puts what you carry into the household stores', ...base, data: { act: 'unload', building: id } as FarmData }), true);
    if (sheaves.length > 0) {
      const flail = toolFor(E, p, 'flail');
      const best = sheaves.slice().sort((a, c) => c.qty - a.qty)[0];
      if (!flail) push(disabled({ id: 'farm.thresh', label: 'Thresh the sheaves', ...base }, 'Needs a flail'));
      else {
        const speed = speedOf(E, p, 'farming', 'str', flail.quality);
        push(option({
          id: 'farm.thresh', label: `Thresh ${SHEAF_CROP[best.good]} (${Math.round(best.qty)} sheaves)`, seconds: secondsFor(1, speed), anim: 'work_hammer', mainHand: 'flail', priority: 65,
          preview: 'Each bout beats out about eight sheaves into chaffy grain and straw · Farming', ...base, data: { act: 'thresh', good: best.good, building: id, tool: flail.key } as FarmData,
        }));
      }
    }
    const chaffy = GRAIN_GOODS.filter((g) => countAll(E, p, g) > 0 && (bagGet(p.inventory, `${g}#0`) + (hh ? bagGet(hh.stores, `${g}#0`) : 0)) > 0.1);
    if (chaffy.length > 0) {
      const g = chaffy[0];
      const speed = speedOf(E, p, 'farming', 'agi', null);
      push(option({
        id: 'farm.winnow', label: `Winnow ${g}`, seconds: secondsFor(1, speed), anim: 'work_lift', mainHand: 'basket', priority: 64,
        preview: 'Tosses the chaff on the wind: clean grain, worth a third more · Farming', ...base, data: { act: 'winnow', good: g, building: id } as FarmData,
      }));
    }
    // the quern, for those with no mill
    const grain = GRAIN_GOODS.map((g) => ({ g, n: hh ? bagGet(hh.stores, g) + bagGet(p.inventory, g) : bagGet(p.inventory, g) })).filter((x) => x.n > 0.5).sort((a, c) => c.n - a.n)[0];
    if (grain && own) {
      const speed = speedOf(E, p, 'farming', 'str', null) * 0.35;
      push(option({
        id: 'farm.quern', label: `Grind ${grain.g} on the quern`, seconds: secondsFor(1, speed), anim: 'work_stir', mainHand: 'none', priority: 10,
        preview: `Slow, and the lord forbids it to his tenants; no multure to pay · Farming`, ...base, data: { act: 'quern', good: grain.g, building: id } as FarmData,
      }));
    }
  }
  if (b.kind === 'watermill' || b.kind === 'windmill') {
    const grain = GRAIN_GOODS.map((g) => ({ g, n: hh ? bagGet(hh.stores, g) + bagGet(p.inventory, g) : bagGet(p.inventory, g) })).filter((x) => x.n > 0.5).sort((a, c) => c.n - a.n)[0];
    if (!grain) out.push(disabled({ id: 'farm.mill', label: 'Grind grain at the mill', ...base }, 'You have no clean grain to grind'));
    else {
      const speed = speedOf(E, p, 'farming', 'str', null);
      push(option({
        id: 'farm.mill', label: `Grind ${grain.g} at the mill`, seconds: secondsFor(1, speed), anim: 'work_lift', mainHand: 'sack', carry: 'sack', priority: 62,
        preview: `${FLOUR_PER_GALLON[grain.g]} lb of flour a gallon · the lord's miller keeps one gallon in sixteen · Farming`, ...base, data: { act: 'mill', good: grain.g, building: id } as FarmData,
      }));
    }
  }
  if (own && HOME_KINDS.has(b.kind) && hh) listGardenOptions(E, p, hh.id, b.id, out, block);
}

function listParcel(E: Econ, p: Person, id: number, out: ActionOption[]): void {
  const q = E.world.parcels.find((x) => x.id === id);
  if (!q) return;
  const target: TargetRef = { kind: 'parcel', id };
  const hh = E.hhOf(p);
  const block = holyDayBlock(E) ?? incapable(p);
  if (q.use === 'garden' && hh) { listGardenOptions(E, p, hh.id, id, out, block, target); return; }
  if (q.use === 'meadow') {
    const sea = Math.floor(E.dayOfYear / 4);
    const cap = parcelHayLeft(E, id, hh?.id ?? 0);
    const scythe = toolFor(E, p, 'scythe');
    if (sea !== 1 && sea !== 2) { out.push(disabled({ id: 'farm.mow', label: 'Mow the hay', target, range: 14 }, 'Hay is cut in summer')); return; }
    if (!scythe) { out.push(disabled({ id: 'farm.mow', label: 'Mow the hay', target, range: 14 }, 'Needs a scythe')); return; }
    if (cap < 1) { out.push(disabled({ id: 'farm.mow', label: 'Mow the hay', target, range: 14 }, 'The meadow has been mown this year')); return; }
    const speed = speedOf(E, p, 'farming', 'str', scythe.quality) * 1.5;
    const o = option({
      id: 'farm.mow', label: 'Mow the meadow', seconds: secondsFor(1, speed), anim: 'work_scythe', mainHand: 'scythe', priority: 50,
      preview: `About ${Math.min(Math.round(cap), 6)} bales a bout · Farming`, target, range: 14, data: { act: 'mow', parcel: id } as FarmData,
    });
    if (block) { o.enabled = false; o.reason = block; }
    out.push(o);
  }
}

/** Bales a meadow can still give this year to this household (the commons are shared out; a meadow of your own gives double). */
function parcelHayLeft(E: Econ, parcel: number, hhId: number): number {
  const key = `m${parcel}`;
  const rec = E.save.ww[key];
  const yr = E.yearIndex;
  const cut = rec && rec[0] === yr ? rec[1] : 0;
  const mine = E.save.parcels[String(parcel)]?.hh === hhId && hhId > 0;
  return Math.max(0, (mine ? 60 : 24) - cut);
}

function mowBout(E: Econ, p: Person, d: MowData, f: number): ActionOutcome {
  const hh = E.hhOf(p);
  const left = parcelHayLeft(E, d.parcel, hh?.id ?? 0);
  if (left < 0.5) return { ok: false, message: 'There is no more hay to cut.' };
  const scythe = toolFor(E, p, 'scythe');
  const base = 6 * f * (1 + perkSum(p, 'farming', 'yield'));
  const n = Math.min(left, Math.max(1, stoch(E, base)));
  bagAdd(p.inventory, 'hay', n);
  E.state.touch(p);
  const key = `m${d.parcel}`;
  const rec = E.save.ww[key];
  const cut = rec && rec[0] === E.yearIndex ? rec[1] : 0;
  E.save.ww[key] = [E.yearIndex, round2(cut + n)];
  E.notes.mown.set(d.parcel, { bales: round2(cut + n), day: E.day });
  E.touchSave();
  boutDone(E, p, { skill: 'farming', xp: 7, heavy: 0.9, bouts: f });
  wearOut(E, p, scythe, 0.015 * f, 'farming');
  return { ok: true, message: `You mow ${n} bales of hay.`, gains: [{ label: 'Hay', amount: n, ref: 'hay' }, { label: 'Farming', ref: 'farming' }] };
}

// ---------------------------------------------------------------------------------------------
// Barn work
// ---------------------------------------------------------------------------------------------

function unloadAll(E: Econ, p: Person): ActionOutcome {
  const hh = E.hhOf(p);
  if (!hh) return { ok: false, message: 'You have no household barn.' };
  let n = 0;
  for (const g of [...SHEAF_GOODS, 'manure', 'hay', 'straw']) {
    const q = bagGet(p.inventory, g);
    if (q > 0) { bagAdd(p.inventory, g, -q); bagAdd(hh.stores, g, q); n += q; }
  }
  E.state.touch(p);
  E.state.touchHousehold(hh);
  return { ok: n > 0, message: n > 0 ? `You store ${Math.round(n)} bundles in the barn.` : 'You carry nothing to store.' };
}

function takeFrom(E: Econ, p: Person, good: string, qty: number): number {
  let need = qty;
  const hh = E.hhOf(p);
  const t1 = Math.min(need, bagGet(p.inventory, good));
  if (t1 > 0) { bagAdd(p.inventory, good, -t1); need -= t1; E.state.touch(p); }
  if (need > 0.001 && hh) {
    const t2 = Math.min(need, bagGet(hh.stores, good));
    if (t2 > 0) { bagAdd(hh.stores, good, -t2); need -= t2; E.state.touchHousehold(hh); }
  }
  return qty - need;
}

function toStores(E: Econ, p: Person, good: string, qty: number): void {
  const hh = E.hhOf(p);
  if (hh) { bagAdd(hh.stores, good, qty); E.state.touchHousehold(hh); } else { bagAdd(p.inventory, good, qty); E.state.touch(p); }
}

function threshBout(E: Econ, p: Person, d: BarnData, f: number): ActionOutcome {
  const good = d.good as string;
  const got = takeFrom(E, p, good, 8 * f);
  if (got < 0.1) return { ok: false, message: 'No sheaves left.' };
  const crop = SHEAF_CROP[good];
  const grain = round2(got * 0.95 * (1 + perkSum(p, 'farming', 'yield') * 0.5));
  toStores(E, p, keyOf(crop, 0), grain);
  const straw = round2(got * (CROPS[crop]?.straw ?? 0.8));
  toStores(E, p, 'straw', straw);
  const tool = toolFor(E, p, 'flail');
  boutDone(E, p, { skill: 'farming', xp: 6, heavy: 0.7, bouts: f });
  wearOut(E, p, tool, 0.015 * f, 'farming');
  return { ok: true, message: `Threshed ${round1(got)} sheaves: ${round1(grain)} gallons of chaffy ${crop}.`, gains: [{ label: `Chaffy ${crop}`, amount: round1(grain), ref: crop }, { label: 'Straw', amount: round1(straw), ref: 'straw' }, { label: 'Farming', ref: 'farming' }] };
}

function winnowBout(E: Econ, p: Person, d: BarnData, f: number): ActionOutcome {
  const g = d.good as string;
  const got = takeFrom(E, p, `${g}#0`, 12 * f);
  if (got < 0.1) return { ok: false, message: 'Nothing left to winnow.' };
  const clean = round2(got * 0.96);
  toStores(E, p, g, clean);
  boutDone(E, p, { skill: 'farming', xp: 5, heavy: 0.35, bouts: f });
  return { ok: true, message: `Winnowed ${round1(got)} gallons into ${round1(clean)} of clean ${g}.`, gains: [{ label: `Clean ${g}`, amount: round1(clean), ref: g }, { label: 'Farming', ref: 'farming' }] };
}

function millBout(E: Econ, p: Person, d: BarnData, f: number): ActionOutcome {
  const g = d.good as string;
  const quern = d.act === 'quern';
  // a water- or windmill in the community grinds faster (the techniques of the millwrights)
  const got = takeFrom(E, p, g, 8 * f * (quern ? 1 : 1 + Math.max(0, E.techBonus(p.settlement, 'mill.speed'))));
  if (got < 0.1) return { ok: false, message: 'No grain left to grind.' };
  const multure = quern ? 0 : round2(got / 16);
  const flour = round2((got - multure) * FLOUR_PER_GALLON[g] * (1 + perkSum(p, 'brewing', 'yield') * 0));
  toStores(E, p, 'flour', flour);
  if (multure > 0) {
    const mill = E.state.buildings.get(d.building);
    const lord = mill ? E.lordOf(mill.settlement) : null;
    if (lord?.household) { bagAdd(lord.household.stores, g, multure); E.state.touchHousehold(lord.household); }
  }
  boutDone(E, p, { skill: 'farming', xp: 4, heavy: quern ? 0.7 : 0.3, bouts: f });
  let extra = '';
  if (quern && p.estate === 'unfree' && E.rng('quern').next() < 0.12) {
    const lord = E.lordOf(p.settlement);
    // the lord's officers break illegal querns
    E.notify(`The reeve finds your quern: a fine of 3d.`, 'warn', p.id);
    extra = ' (caught!)';
    E.spend(p, Math.min(3, p.money), 'Fine: illegal quern', false);
    if (lord?.household) E.credit(lord.household, 3);
  }
  return { ok: true, message: `Ground ${round1(got)} gallons: ${round1(flour)} lb of flour${multure > 0 ? `, ${multure} gallon to the miller` : ''}${extra}.`, gains: [{ label: 'Flour', amount: round1(flour), ref: 'flour' }, { label: 'Farming', ref: 'farming' }] };
}

// ---------------------------------------------------------------------------------------------
// The croft garden
// ---------------------------------------------------------------------------------------------

function bedsOf(E: Econ, hhId: number): GardenBed[] { return E.farm.g[String(hhId)] ?? (E.farm.g[String(hhId)] = []); }

function listGardenOptions(E: Econ, p: Person, hhId: number, buildingId: number, out: ActionOption[], block: string | null, targetOverride?: TargetRef): void {
  const target: TargetRef = targetOverride ?? { kind: 'building', id: buildingId };
  const beds = bedsOf(E, hhId);
  const now = E.day;
  const sea = Math.floor(E.dayOfYear / 4);
  const base = { target, range: 8 };
  const speed = speedOf(E, p, 'farming', 'str', toolFor(E, p, 'spade')?.quality ?? 0);
  const push = (o: ActionOption): void => { if (block) { o.enabled = false; o.reason = block; } out.push(o); };
  // the bed most in need
  let idx = -1;
  let step: GardenData['step'] | null = null;
  for (let i = 0; i < beds.length; i++) {
    const b = beds[i];
    if (b.c && gardenProgress(b.c, b.s, now) >= 1) { idx = i; step = 'harvest'; break; }
  }
  if (step === null) for (let i = 0; i < beds.length; i++) { const b = beds[i]; if (b.c && !b.w) { idx = i; step = 'weed'; break; } }
  if (step === null) for (let i = 0; i < beds.length; i++) { const b = beds[i]; if (!b.c && b.d) { idx = i; step = 'sow'; break; } }
  if (step === null) { for (let i = 0; i < beds.length; i++) { const b = beds[i]; if (!b.c && !b.d) { idx = i; step = 'dig'; break; } } }
  const maxBeds = 3 + Math.max(0, (E.state.buildings.get(E.household(hhId)?.home ?? -1)?.level ?? 1) - 1);
  if (step === null && beds.length < maxBeds) { idx = beds.length; step = 'dig'; }
  if (step === null) {
    out.push(disabled({ id: 'garden.wait', label: 'Tend the garden', ...base }, 'The beds are growing: come back when the vegetables are ready'));
    return;
  }
  const bed = beds[idx];
  if (step === 'dig') {
    push(option({
      id: 'garden.dig', label: 'Dig a garden bed', seconds: secondsFor(1, speed), anim: 'work_dig', mainHand: 'spade', priority: 40, ...base,
      preview: 'Two bouts of digging make a bed ready for sowing · Farming', data: { act: 'garden', step, bed: idx } as GardenData,
    }));
  } else if (step === 'sow') {
    if (sea === 3) { out.push(disabled({ id: 'garden.sow', label: 'Sow the bed', ...base }, 'Nothing grows in winter')); return; }
    const crops = sea === 2 ? ['turnips', 'leeks'] : ['cabbage', 'onions', 'leeks', 'turnips'];
    for (let k = 0; k < crops.length; k++) {
      const c = crops[k];
      push(option({
        id: `garden.sow.${c}`, label: `Sow ${c}`, seconds: secondsFor(1, speedOf(E, p, 'farming', 'agi', null)), anim: 'work_sow', mainHand: 'basket', priority: 40 - k, ...base,
        preview: `Ripe in ${GARDEN_CROPS[c].grow < 2.7 ? 'two' : 'three'} days · about ${GARDEN_CROPS[c].yield} lb · Farming`, data: { act: 'garden', step: 'sow', bed: idx, crop: c } as GardenData,
      }));
    }
  } else if (step === 'weed') {
    push(option({
      id: 'garden.weed', label: `Weed the ${bed.c} bed`, seconds: secondsFor(1, speedOf(E, p, 'farming', 'agi', toolFor(E, p, 'hoe')?.quality ?? 0)), anim: 'work_hoe', mainHand: 'hoe', priority: 38, ...base,
      preview: 'A clean bed gives a fifth more · Farming', data: { act: 'garden', step, bed: idx } as GardenData,
    }));
  } else {
    push(option({
      id: 'garden.harvest', label: `Gather the ${bed.c}`, seconds: secondsFor(1, speedOf(E, p, 'farming', 'agi', null)), anim: 'work_lift', mainHand: 'basket', priority: 45, ...base,
      preview: `About ${GARDEN_CROPS[bed.c]?.yield ?? 12} lb of vegetables · Farming`, data: { act: 'garden', step, bed: idx } as GardenData,
    }));
  }
}

function gardenBout(E: Econ, p: Person, d: GardenData, f: number): ActionOutcome {
  const hh = E.hhOf(p);
  if (!hh) return { ok: false };
  const beds = bedsOf(E, hh.id);
  const bed = beds[d.bed] ?? (d.step === 'dig' ? beds[beds.push({ c: '', s: 0 }) - 1] : undefined);
  if (!bed) return { ok: false, message: 'There is no such bed.' };
  const need = d.step === 'dig' ? 2 : d.step === 'harvest' ? 2 : 1;
  bed.p = Math.round(((bed.p ?? 0) + f / need) * 1000) / 1000;
  boutDone(E, p, { skill: 'farming', xp: 6, heavy: d.step === 'dig' ? 0.6 : 0.2, bouts: f });
  const tool = d.step === 'dig' ? toolFor(E, p, 'spade') : d.step === 'weed' ? toolFor(E, p, 'hoe') : null;
  wearOut(E, p, tool, 0.01 * f, 'farming');
  let message = 'You work the bed.';
  const gains: NonNullable<ActionOutcome['gains']> = [{ label: 'Farming', ref: 'farming' }];
  if ((bed.p ?? 0) >= 0.985) {
    bed.p = 0;
    switch (d.step) {
      case 'dig': bed.d = 1; message = 'The bed is dug and ready for sowing.'; break;
      case 'sow': bed.c = d.crop ?? 'cabbage'; bed.s = Math.round(E.day * 100) / 100; delete bed.w; delete bed.d; message = `Sown with ${bed.c}.`; break;
      case 'weed': bed.w = 1; message = 'The bed is weeded.'; break;
      case 'harvest': {
        const def = GARDEN_CROPS[bed.c];
        const lb = Math.max(1, stoch(E, (def?.yield ?? 12) * (bed.w ? 1.2 : 1) * (1 + perkSum(p, 'farming', 'yield')) * (0.85 + 0.03 * skillLevel(p.skills.farming))));
        bagAdd(p.inventory, 'vegetables', lb);
        E.state.touch(p);
        bed.c = ''; delete bed.w; bed.d = 1;
        message = `You gather ${lb} lb of ${def ? 'vegetables' : 'greens'}.`;
        gains.push({ label: 'Vegetables', amount: lb, ref: 'vegetables' });
        break;
      }
    }
  }
  E.touchFarm();
  return { ok: true, message, gains };
}

export { CALENDAR, BUILDINGS, CAREER_ECON, GOODS, TOOL_SPEED, countGood, bestOf, perkTotal, creditWeekWork, skillLevel };
