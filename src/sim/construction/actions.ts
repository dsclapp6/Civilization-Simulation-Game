// The player's own hands on a building site (CIV §5): stand at the site and work — dig the footings, saw and raise the frame, cut
// and lay stones, thatch the roof — in bouts like any other labour (a bout is twelve seconds; the hero does about twice what a
// capable adult does in the same game hours), earning skill and a little strength, and a day's wage when the work is someone
// else's. Each bout is a short run of visible steps with its animation, tool and sound.
import { DAY_SECONDS } from '../../core/time';
import type { SkillId } from '../../core/domain';
import type { HeldItem } from '../../core/view';
import type { ActionOption, ActionOutcome, ActionProvider, ActionStep } from '../actions';
import { isHolyDay } from '../calendar';
import { skillLevel } from '../people';
import { TRAIN_SCALE, XP_SCALE, gainSkill, trainStat } from '../skills';
import type { Person } from '../state';
import type { Construction } from './core';
import { stoneWork } from './data';
import { progressOf, stageOf } from './sites';
import { capacity, putIn, wageOfSite } from './progress';
import type { SiteRec } from './save';

/** Seconds a bout takes at speed 1, as in the economy's other work (≈ half a game hour). */
const BOUT = 12;
const BOUT_HOURS = (BOUT * 24) / DAY_SECONDS;
/** The hero compresses the chores: per game hour about twice what a capable adult does. */
const HERO_FACTOR = 2;
/** Hours in a labourer's working day. */
const WORK_DAY_HOURS = 10;
/** Worker-days one bout adds to the site (0.096). */
export const BOUT_DAYS = Math.round(((BOUT_HOURS * HERO_FACTOR) / WORK_DAY_HOURS) * 1000) / 1000;
const TOOL_SPEED = [0.7, 1.0, 1.2, 1.4, 1.6];
const TOOLS = ['hammer', 'saw', 'chisel', 'pick', 'spade'];

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const r2 = (v: number): number => Math.round(v * 100) / 100;

function bestTool(C: Construction, p: Person): number {
  let best = -1;
  const scan = (bag: Record<string, number>): void => {
    for (const k of Object.keys(bag)) {
      if (!(bag[k] > 0)) continue;
      const i = k.indexOf('#');
      const good = i < 0 ? k : k.slice(0, i);
      if (!TOOLS.includes(good)) continue;
      const q = i < 0 ? 1 : Math.max(0, Math.min(4, Number(k.slice(i + 1)) || 0));
      if (q > best) best = q;
    }
  };
  scan(p.inventory);
  const hh = C.household(p.household);
  if (hh) scan(hh.stores);
  return best;
}

/** How fast this person works at the site (1 = an average hand with a common tool). */
function speedOf(C: Construction, p: Person, skill: SkillId): number {
  const lvl = skillLevel(p.skills[skill]);
  const tool = bestTool(C, p);
  const n = p.needs;
  let needs = 1;
  if (n.hunger < 0.3) needs *= n.hunger < 0.1 ? 0.6 : 0.78;
  if (n.rest < 0.3) needs *= n.rest < 0.1 ? 0.6 : 0.78;
  if (p.health.hp < 1) needs *= 0.6 + 0.4 * p.health.hp;
  const s = (0.62 + 0.035 * lvl) * (0.78 + 0.043 * p.trained.str) * (tool < 0 ? 0.85 : TOOL_SPEED[tool]) * needs;
  return Math.max(0.3, Math.min(3.2, s));
}

function stepsFor(rec: SiteRec): ActionStep[] {
  const p = progressOf(rec);
  const stage = stageOf(p);
  if (rec.work === 'demolish') {
    return [
      { share: 0.6, label: 'Pull the walls down', anim: 'work_axe', mainHand: 'axe', sfx: 'chop' },
      { share: 0.4, label: 'Stack the salvage', anim: 'work_lift', mainHand: 'none', sfx: 'dig' },
    ];
  }
  if (rec.work === 'repair') {
    return [
      { share: 0.5, label: 'Patch the damage', anim: 'work_hammer', mainHand: 'hammer', sfx: 'hammer' },
      { share: 0.5, label: 'Mend the timbers', anim: 'work_saw', mainHand: 'saw', sfx: 'saw' },
    ];
  }
  const stone = stoneWork(rec.kind, rec.level);
  if (stage === 'pegs' || stage === 'footings') {
    return [
      { share: 0.55, label: 'Dig the footings', anim: 'work_dig', mainHand: 'spade', sfx: 'dig' },
      { share: 0.45, label: stone ? 'Carry stone' : 'Fetch a beam', anim: 'work_lift', mainHand: 'none', sfx: 'dig' },
    ];
  }
  if (stage === 'frame') {
    return stone
      ? [
        { share: 0.3, label: 'Cut the stone', anim: 'work_hammer', mainHand: 'chisel', sfx: 'hammer' },
        { share: 0.25, label: 'Mix the mortar', anim: 'work_stir', mainHand: 'spade', sfx: 'stir' },
        { share: 0.45, label: 'Lay the stones', anim: 'work_lift', mainHand: 'none', sfx: 'dig' },
      ]
      : [
        { share: 0.35, label: 'Saw a beam', anim: 'work_saw', mainHand: 'saw', sfx: 'saw' },
        { share: 0.45, label: 'Raise the frame', anim: 'work_hammer', mainHand: 'hammer', sfx: 'hammer' },
        { share: 0.2, label: 'Fetch timber', anim: 'work_lift', mainHand: 'none', sfx: 'dig' },
      ];
  }
  return [
    { share: 0.5, label: stone ? 'Set the roof timbers' : 'Lay the thatch', anim: 'work_hammer', mainHand: 'hammer', sfx: 'hammer' },
    { share: 0.5, label: 'Nail the battens', anim: 'work_hammer', mainHand: 'hammer', sfx: 'hammer' },
  ];
}

function labelFor(rec: SiteRec, kindName: string): string {
  switch (rec.work) {
    case 'upgrade': return `Work on the ${kindName} (improving it)`;
    case 'repair': return `Work on the ${kindName} (mending it)`;
    case 'demolish': return `Help pull down the ${kindName}`;
    default: return 'Work on the building';
  }
}

function blockedFor(C: Construction, p: Person, rec: SiteRec): string | null {
  if (rec.closed !== 0) return 'The work is done';
  if (isHolyDay(C.absDay)) return 'It is the holy day: rest, go to church, or practise at the butts';
  if (p.needs.hunger <= 0.03) return 'You are too weak from hunger';
  if (p.health.hp < 0.12) return 'You are too hurt to work';
  // work may go on only as far as the materials in hand allow
  if (rec.labour - rec.done > 0.01 && capacity(rec) <= 0.01) {
    return rec.note && rec.note.startsWith('Waiting') ? rec.note : 'There is nothing to build with yet: the materials have not come';
  }
  return null;
}

export function constructionProvider(C: Construction): ActionProvider {
  return {
    id: 'construction',

    list(_ctx, actor, target, out) {
      if (target.kind !== 'building') return;
      const rec = C.openByBuilding.get(target.id);
      if (!rec) return;
      const p = C.living(actor);
      if (!p) return;
      const kindName = rec.kind.replace(/_/g, ' ');
      const skill: SkillId = stoneWork(rec.kind, rec.level) ? 'masonry' : 'carpentry';
      const speed = speedOf(C, p, skill);
      const steps = stepsFor(rec);
      const own = p.household === rec.household;
      const wage = own ? 0 : wageOfSite(rec);
      const reason = blockedFor(C, p, rec);
      const pct = Math.round(progressOf(rec) * 100);
      const o: ActionOption = {
        id: 'build.work', provider: '', label: labelFor(rec, kindName), category: 'work', target, enabled: !reason,
        seconds: Math.max(5, Math.min(60, Math.round((BOUT / speed) * 10) / 10)),
        anim: steps[0].anim, mainHand: steps[0].mainHand as HeldItem | undefined,
        preview: `${pct}% done · ${skill === 'masonry' ? 'Masonry' : 'Carpentry'}${wage > 0 ? ` · ${r2(wage)}d a day from the paying household` : ''}`,
        range: 12, priority: 36, repeat: true, steps, data: { site: rec.id, skill },
      };
      if (reason) o.reason = reason;
      out.push(o);
    },

    check(_ctx, actor, option) {
      const p = C.living(actor);
      if (!p) return 'Nobody there';
      const site = (option.data as { site?: number } | undefined)?.site;
      const rec = site ? C.sitesById.get(site) : undefined;
      if (!rec) return 'There is no work there';
      return blockedFor(C, p, rec);
    },

    complete(ctx, actor, option) {
      const p = C.living(actor);
      const d = option.data as { site?: number; skill?: SkillId } | undefined;
      const rec = d?.site ? C.sitesById.get(d.site) : undefined;
      if (!p || !rec || rec.closed !== 0) return { ok: false, message: 'The work is done.' };
      const skill: SkillId = d?.skill ?? 'carpentry';
      const heavy = skill === 'masonry' ? 0.7 : 0.55;
      const labour = putIn(C, rec, BOUT_DAYS);
      // the cost of a bout in food and strength, and what it teaches
      p.needs.hunger = r2(clamp01(p.needs.hunger - 0.002 - 0.0055 * heavy));
      p.needs.rest = r2(clamp01(p.needs.rest - 0.0025 - 0.009 * heavy));
      gainSkill(ctx, p, skill, 8 * XP_SCALE);
      trainStat(ctx, p, 'str', 0.012 * heavy * TRAIN_SCALE);
      trainStat(ctx, p, 'end', 0.01 * heavy * TRAIN_SCALE);
      ctx.state.touch(p);
      if (labour <= 0) return { ok: false, message: rec.note || 'There is nothing to work on yet.' };
      // a day's wage by the bout when it is another household's work
      let paid = 0;
      if (p.household !== rec.household) {
        const payer = C.household(rec.household);
        const pay = r2(wageOfSite(rec) * BOUT_DAYS);
        if (payer && pay > 0 && C.spend(payer, pay) >= pay - 1e-6) { p.money = r2(p.money + pay); paid = pay; ctx.state.touch(p); }
      }
      const done = rec.closed !== 0;
      const out: ActionOutcome = {
        ok: true,
        message: done ? `You put the last work into the ${rec.kind.replace(/_/g, ' ')}: it is finished.` : `You work on the ${rec.kind.replace(/_/g, ' ')}: ${Math.round(progressOf(rec) * 100)}% done.`,
        gains: [{ label: skill === 'masonry' ? 'Masonry' : 'Carpentry', ref: skill }, ...(paid > 0 ? [{ label: 'Wages', amount: paid, ref: 'money' }] : [])],
      };
      return out;
    },
  };
}
