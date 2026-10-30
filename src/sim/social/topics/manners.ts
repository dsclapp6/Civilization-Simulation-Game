// "Speak your mind…": flatter, boast, insult, threaten, apologise. Checks use the persuasion chance
// shown on the option; outcomes move opinion, reputation (cruelty, honour) and Persuasion / Leadership XP.
import { RANK_NAMES, SKILLS, STAT_NAMES, STATS, type StatId } from '../../../core/domain';
import { CAREERS } from '../../careers';
import { TIER_MONEY } from '../../people';
import { gainSkill, skillOf } from '../../skills';
import { formatMoney } from '../../money';
import type { Person } from '../../state';
import { checkChance } from '../chance';
import { standingOf } from '../util';
import type { TopicReply } from '../types';
import { chatGain, iSay, mkOption, npcSays, type TopicCtx, type TopicGroup } from './kit';

// ---- what to praise, what to boast of ----

type PraiseKind = 'skill' | 'looks' | 'wit' | 'strength' | 'charm' | 'station' | 'piety' | 'generous' | 'bold' | 'general';

function praiseKind(t: TopicCtx): PraiseKind {
  const o = t.other;
  const field = CAREERS[o.career]?.field ?? 'none';
  const top = CAREERS[o.career]?.skills[0];
  if (top && skillOf(o, top) >= 4 && field !== 'none') return 'skill';
  if (o.traits.includes('comely')) return 'looks';
  if (o.trained.int >= 13) return 'wit';
  if (o.trained.str >= 13) return 'strength';
  if (o.trained.cha >= 13) return 'charm';
  if (o.rankTier >= 4) return 'station';
  if (o.rep.piety >= 20) return 'piety';
  if (o.rep.generosity >= 15) return 'generous';
  if (o.rep.valour >= 15) return 'bold';
  return 'general';
}

interface Boast { key: string; strength: number; vars: Record<string, string> }

const STAT_WORD: Record<StatId, string> = { str: 'strength', end: 'stamina', agi: 'quickness', int: 'wits', per: 'sharp eyes', cha: 'way with people' };

export function bestBoast(p: Person): Boast | null {
  let best: Boast | null = null;
  const consider = (b: Boast): void => { if (b.strength >= 0.15 && (!best || b.strength > best.strength)) best = b; };
  for (const s of SKILLS) {
    const lv = skillOf(p, s);
    if (lv >= 3) consider({ key: 'skill', strength: Math.min(1, lv / 12), vars: { skill: s === 'brewing' ? 'brewing' : s } });
  }
  for (const s of STATS) {
    const v = p.trained[s];
    if (v >= 13) consider({ key: 'stat', strength: Math.min(1, (v - 10) / 8), vars: { stat: STAT_WORD[s], statname: STAT_NAMES[s] } });
  }
  if (p.rankTier >= 4) consider({ key: 'rank', strength: Math.min(1, (p.rankTier - 2) / 5), vars: { rank: RANK_NAMES[p.rankTier].toLowerCase() } });
  if (p.offices.length > 0) consider({ key: 'office', strength: 0.5, vars: { office: p.offices[0].office } });
  if (p.money >= TIER_MONEY[p.rankTier] * 2 + 100) consider({ key: 'wealth', strength: 0.4, vars: {} });
  if (p.rep.valour >= 20) consider({ key: 'valour', strength: Math.min(1, p.rep.valour / 50), vars: {} });
  if (p.rep.generosity >= 20) consider({ key: 'generous', strength: Math.min(1, p.rep.generosity / 50), vars: {} });
  if (p.rep.piety >= 25) consider({ key: 'piety', strength: Math.min(1, p.rep.piety / 50), vars: {} });
  if (p.prestige >= 8) consider({ key: 'fame', strength: Math.min(1, p.prestige / 40), vars: {} });
  return best;
}

type InsultKind = 'coward' | 'liar' | 'miser' | 'hothead' | 'ugly' | 'beggar' | 'prig' | 'fool';

function insultKind(core: TopicCtx['core'], o: Person): InsultKind {
  if (o.traits.includes('craven')) return 'coward';
  if (o.traits.includes('deceitful')) return 'liar';
  if (o.traits.includes('greedy')) return 'miser';
  if (o.traits.includes('hot_tempered')) return 'hothead';
  if (o.traits.includes('scarred') || o.traits.includes('lame')) return 'ugly';
  if (core.wealthShade(o) < 0) return 'beggar';
  if (o.traits.includes('pious') && o.rep.piety >= 20) return 'prig';
  return 'fool';
}

const TARGETED: ReadonlySet<InsultKind> = new Set<InsultKind>(['coward', 'liar', 'miser', 'hothead', 'ugly', 'beggar', 'prig']);

// ---- chances ----

export function flatterChance(t: TopicCtx): number {
  return checkChance(t.core, t.actor, t.other, {
    base: 0.5, rankUp: -0.02, rankDown: 0.03,
    other: { honest: -0.12, deceitful: -0.08, ambitious: 0.12, greedy: 0.05, content: -0.05, pious: -0.04, hot_tempered: -0.03 },
    actor: { deceitful: 0.08, honest: -0.03, comely: 0.05 },
  });
}

export function boastChance(t: TopicCtx): number {
  const b = bestBoast(t.actor);
  return checkChance(t.core, t.actor, t.other, {
    base: 0.3 + 0.4 * (b?.strength ?? 0), rankUp: -0.04, rankDown: 0.02, skillW: 0.006,
    other: { content: -0.05, hot_tempered: -0.05, ambitious: 0.05, patient: -0.02 },
    actor: { honest: 0.05 },
    extra: t.op < -10 ? -0.2 : 0,
  });
}

export function threatenChance(t: TopicCtx): number {
  const { actor, other, core } = t;
  const age = core.age(other);
  return checkChance(core, actor, other, {
    base: 0.28, skill: 'leadership', skillW: 0.015, opinionW: 0, chaW: 0.005, rankUp: -0.12, rankDown: 0.04,
    other: { brave: -0.15, craven: 0.2, hot_tempered: -0.05, patient: -0.03 },
    actor: { brave: 0.04, scarred: 0.05 },
    extra: 0.03 * (actor.trained.str - other.trained.str) + (age < 12 ? 0.2 : age >= 55 ? 0.1 : 0) + (actor.rep.cruelty >= 20 ? 0.08 : 0) + (actor.rep.valour >= 20 ? 0.04 : 0),
  });
}

/** What the other has against the actor that an apology could mend (recent bad memories, souring). */
export function grievance(t: TopicCtx): { harm: number; memory: number } {
  const { core, actor, other } = t;
  let harm = 0;
  for (const m of core.store.memoriesOf(other.id, actor.id)) if (m.v < 0 && core.day - m.d <= 48) harm += -m.v;
  return { harm, memory: other.opinions[actor.id] ?? 0 };
}

export function apologyChance(t: TopicCtx): number {
  const g = grievance(t);
  return checkChance(t.core, t.actor, t.other, {
    base: 0.5, rankUp: -0.01, rankDown: 0.01,
    other: { patient: 0.15, hot_tempered: -0.12, honest: 0.05, pious: 0.05 },
    actor: { honest: 0.05 },
    extra: -0.01 * Math.min(30, g.harm) + (t.core.age(t.other) < 12 ? 0.1 : 0),
  });
}

// ---- the group ----

export const mannersGroup: TopicGroup = {
  prefix: 'say',

  options(t, out) {
    const { session, other } = t;
    if (session.page === 'root') {
      out.push(mkOption('nav.say', 'Speak your mind…', 'persuade', { priority: 60 }));
      return;
    }
    if (session.page !== 'say') return;
    out.push(mkOption('say.flatter', `Flatter ${other.first}`, 'flatter', { chance: flatterChance(t), priority: 60 }));
    const b = bestBoast(t.actor);
    out.push(mkOption('say.boast', 'Boast of your deeds', 'persuade', { chance: boastChance(t), priority: 55, reason: b ? undefined : 'You have little to boast of yet.' }));
    out.push(mkOption('say.insult', `Insult ${other.first}`, 'insult', { priority: 40 }));
    out.push(mkOption('say.threaten', `Threaten ${other.first}`, 'threaten', { chance: threatenChance(t), priority: 35 }));
    const g = grievance(t);
    const wronged = g.harm > 0 || g.memory < -4;
    out.push(mkOption('say.apologise', 'Apologise', 'persuade', {
      enabled: wronged, reason: wronged ? undefined : `You have done ${other.first} no wrong.`,
      chance: wronged ? apologyChance(t) : undefined, priority: wronged ? 70 : 20,
    }));
  },

  choose(t, option): TopicReply {
    switch (option.id) {
      case 'say.flatter': return flatter(t);
      case 'say.boast': return boast(t);
      case 'say.insult': return insult(t);
      case 'say.threaten': return threaten(t);
      case 'say.apologise': return apologise(t);
      default: return { lines: [] };
    }
  },
};

function xp(t: TopicCtx, skill: 'persuasion' | 'leadership', amount: number): void {
  gainSkill(t.core.sim, t.actor, skill, amount);
}

function flatter(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const kind = praiseKind(t);
  const lines = iSay(t, `say.flatter.ask.${kind}`);
  const chance = flatterChance(t);
  const yes = core.rng().next() < chance;
  if (yes) {
    const vanity = other.traits.includes('ambitious') ? 1.3 : other.traits.includes('content') ? 0.8 : other.traits.includes('greedy') ? 1.1 : 1;
    const gain = chatGain(t, Math.max(1.5, (3 + 0.25 * (actor.trained.cha - 10)) * vanity), 1);
    xp(t, 'persuasion', 8);
    return { lines: [...lines, ...npcSays(t, 'say.flatter.win', 'pleased')], opinion: Math.max(gain, 0.5), reason: 'flattery', mood: 0.02 };
  }
  xp(t, 'persuasion', 4);
  return { lines: [...lines, ...npcSays(t, 'say.flatter.lose', 'wary')], opinion: other.traits.includes('honest') ? -3 : -2, reason: 'flattery_failed' };
}

function boast(t: TopicCtx): TopicReply {
  const { core, actor } = t;
  const b = bestBoast(actor);
  if (b) for (const [k, v] of Object.entries(b.vars)) t.me.vars[k] = v;
  const lines = iSay(t, b ? `say.boast.ask.${b.key}` : 'say.boast.ask.empty');
  const chance = boastChance(t);
  const yes = core.rng().next() < chance;
  if (yes) {
    xp(t, 'persuasion', 6);
    const gain = chatGain(t, 1.5 + 3 * (b?.strength ?? 0), 1);
    return { lines: [...lines, ...npcSays(t, 'say.boast.win', 'pleased')], opinion: Math.max(gain, 0.5), reason: 'boast' };
  }
  xp(t, 'persuasion', 3);
  return { lines: [...lines, ...npcSays(t, 'say.boast.lose', 'cold')], opinion: -2, reason: 'boast_failed' };
}

function insult(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const kind = insultKind(core, other);
  const lines = iSay(t, `say.insult.ask.${kind}`);
  const gap = standingOf(other) - standingOf(actor);
  let hit = 8 * (TARGETED.has(kind) ? 1.3 : 1) * (1 + Math.max(0, gap) * 0.25);
  if (other.traits.includes('hot_tempered')) hit *= 1.4;
  else if (other.traits.includes('patient') || other.traits.includes('content')) hit *= 0.7;
  hit = Math.round(hit * 10) / 10;
  core.opinion.addRep(actor, 'honour', -1);
  if (gap <= -1) core.opinion.addRep(actor, 'cruelty', 1);
  if (other.rankTier >= 3 || gap > 0) core.news.rumour('insult', other.settlement, actor.id, other.id);
  const angry = other.traits.includes('hot_tempered') || gap >= 2;
  const pool = gap >= 2 ? 'say.insult.noble' : angry ? 'say.insult.angry' : 'say.insult.reply';
  return { lines: [...lines, ...npcSays(t, pool, 'angry')], opinion: -hit, reason: 'insult', mood: -0.04, end: gap >= 2 };
}

function threaten(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const lines = iSay(t, 'say.threaten.ask');
  const chance = threatenChance(t);
  const yes = core.rng().next() < chance;
  core.opinion.addRep(actor, 'cruelty', other.trained.str < actor.trained.str || core.age(other) < 14 ? 2 : 1);
  core.opinion.addRep(actor, 'honour', -1);
  if (yes) {
    xp(t, 'leadership', 7);
    const take = Math.min(other.money, Math.max(2, Math.round(TIER_MONEY[other.rankTier] * 0.12)));
    if (take >= 2) {
      other.money -= take; actor.money += take;
      core.state.touch(other); core.state.touch(actor);
      t.npc.vars.money = formatMoney(take);
      t.npc.tags.add('paid');
    }
    core.news.rumour('threat', other.settlement, actor.id, other.id);
    return { lines: [...lines, ...npcSays(t, 'say.threaten.win', 'afraid')], opinion: -7, reason: 'threat', mood: -0.05 };
  }
  xp(t, 'leadership', 2);
  const gap = standingOf(other) - standingOf(actor);
  t.npc.tags.add(gap >= 1 ? 'above' : 'equal');
  return { lines: [...lines, ...npcSays(t, 'say.threaten.lose', 'angry')], opinion: gap >= 2 ? -18 : -10, reason: 'threat_failed', mood: -0.05, end: gap >= 2 };
}

function apologise(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const g = grievance(t);
  const lines = iSay(t, 'say.apologise.ask');
  const chance = apologyChance(t);
  const yes = core.rng().next() < chance;
  if (yes) {
    const restore = Math.min(18, Math.max(4, Math.max(g.harm, -g.memory) * 0.6));
    core.store.forgive(other.id, actor.id);
    core.opinion.addRep(actor, 'honour', 1);
    xp(t, 'persuasion', 5);
    return { lines: [...lines, ...npcSays(t, 'say.apologise.win', 'warm')], opinion: Math.round(restore * 10) / 10, reason: 'apology', mood: 0.03 };
  }
  xp(t, 'persuasion', 2);
  return { lines: [...lines, ...npcSays(t, 'say.apologise.lose', 'cold')], opinion: -1.5, reason: 'apology_failed' };
}
