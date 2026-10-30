// "Ask a favour…" (a loan, a meal, a word put in for you, lessons in letters, repaying what you owe)
// and "Give a gift…" (coins or goods; the economy may take over the handing-over with `giveHook`).
import { CAREERS } from '../../careers';
import { formatMoney } from '../../money';
import { TIER_MONEY } from '../../people';
import { gainSkill, skillOf } from '../../skills';
import type { Person } from '../../state';
import { checkChance } from '../chance';
import type { SocialCore } from '../core';
import { clamp, round1 } from '../util';
import { RAPPORT } from '../tuning';
import type { DialogueLine, DialogueOption, Result, TopicReply } from '../types';
import { iSay, mkOption, npcSays, type TopicCtx, type TopicGroup } from './kit';

// ---- money and goods ----

const NICE = [1, 2, 3, 4, 6, 9, 12, 18, 24, 36, 48, 72, 120, 240, 480, 960, 2400, 4800, 12000];

/** The largest "round" sum not above `max` (pence), or 0. */
export function niceAmount(max: number): number {
  let best = 0;
  for (const n of NICE) if (n <= max) best = n; else break;
  return best;
}

export function itemInfo(core: SocialCore, key: string): { name: string; value: number } {
  const hook = core.hooks.itemInfoHook?.(key);
  if (hook) return hook;
  const [good, q] = key.split('#');
  const quality = q === undefined ? '' : ['crude ', '', 'good ', 'fine ', 'masterwork '][Number(q)] ?? '';
  return { name: `${quality}${good.replace(/_/g, ' ')}`, value: 2 };
}

export function transferMoney(core: SocialCore, from: Person, to: Person, amount: number): Result {
  if (amount <= 0 || from.money < amount) return { ok: false, reason: 'Not enough money.' };
  const hook = core.hooks.giveHook;
  if (hook) return hook(from.id, to.id, 'money', amount);
  from.money -= amount; to.money += amount;
  core.state.touch(from); core.state.touch(to);
  return { ok: true };
}

export function transferItem(core: SocialCore, from: Person, to: Person, key: string, qty: number): Result {
  if ((from.inventory[key] ?? 0) < qty) return { ok: false, reason: 'You do not have that.' };
  const hook = core.hooks.giveHook;
  if (hook) return hook(from.id, to.id, key, qty);
  from.inventory[key] -= qty;
  if (from.inventory[key] <= 0) delete from.inventory[key];
  to.inventory[key] = (to.inventory[key] ?? 0) + qty;
  core.state.touch(from); core.state.touch(to);
  return { ok: true };
}

/** Goodwill earned by a gift worth `value` pence: a few pence mean a lot to a poor man, little to a lord. */
export function giftGain(core: SocialCore, other: Person, value: number): number {
  const scale = Math.max(4, TIER_MONEY[other.rankTier] * 0.25);
  let g = 2.2 * Math.log(1 + value / scale);
  if (other.traits.includes('greedy')) g *= 1.4;
  else if (other.traits.includes('content')) g *= 0.8;
  if (other.career === 'beggar') g *= 1.5;
  return clamp(g, 0.5, 12);
}

// ---- the group ----

export const favoursGroup: TopicGroup = {
  prefix: 'favour',

  options(t, out) {
    const { session, core, actor, other } = t;
    const owed = core.store.debtsOwedBy(actor.id).filter((d) => d.from === other.id);
    if (session.page === 'root') {
      for (const d of owed) {
        const pay = Math.min(d.v, actor.money);
        out.push(mkOption(`favour.repay.${d.from}`, pay >= d.v ? `Repay what you owe (${formatMoney(d.v)})` : `Repay what you can (${formatMoney(pay)} of ${formatMoney(d.v)})`, 'favour', {
          priority: 92, enabled: pay > 0, reason: pay > 0 ? undefined : 'Your purse is empty.',
        }));
      }
      out.push(mkOption('nav.favour', 'Ask a favour…', 'favour', { priority: 55 }));
      return;
    }
    if (session.page !== 'favour') return;
    // loans
    const debt = core.store.debtsOwedBy(actor.id).find((d) => d.from === other.id);
    const lend = lendAmounts(other);
    lend.forEach((amount, i) => {
      out.push(mkOption(`favour.loan.${amount}`, `Ask for a loan of ${formatMoney(amount)}`, 'favour', {
        chance: loanChance(t, amount), priority: 60 - i, enabled: !debt, reason: debt ? `You still owe ${other.first}.` : undefined,
      }));
    });
    // a meal
    const hungry = actor.needs.hunger < 0.85;
    out.push(mkOption('favour.meal', 'Ask for a bite to eat', 'favour', {
      chance: mealChance(t), priority: 50, enabled: hungry, reason: hungry ? undefined : 'You are not hungry.',
    }));
    // a word put in
    for (const third of voucherTargets(t).slice(0, 2)) {
      out.push(mkOption(`favour.vouch.${third.id}`, `Ask ${other.first} to speak for you to ${third.first}`, 'persuade', {
        chance: vouchChance(t, third), priority: 45,
      }));
    }
    // lessons
    if (canTeach(t)) {
      const rec = core.store.talkRec(actor.id, other.id, core.day, false);
      const done = !!rec && (rec.x & 1) !== 0;
      out.push(mkOption('favour.lessons', 'Ask for lessons in letters', 'learn', {
        chance: lessonChance(t), priority: 58, enabled: !done, reason: done ? 'Not again today.' : undefined,
      }));
    }
  },

  choose(t, option): TopicReply {
    const id = option.id;
    if (id.startsWith('favour.loan.')) return loan(t, Number(id.slice('favour.loan.'.length)));
    if (id === 'favour.meal') return meal(t);
    if (id.startsWith('favour.vouch.')) return vouch(t, Number(id.slice('favour.vouch.'.length)));
    if (id === 'favour.lessons') return lessons(t);
    if (id.startsWith('favour.repay.')) return repay(t);
    return { lines: [] };
  },
};

// ---- loans ----

function lendAmounts(lender: Person): number[] {
  if (lender.money < 12) return [];
  const small = Math.max(2, niceAmount(lender.money * 0.08));
  const large = niceAmount(lender.money * 0.22);
  const out = [small];
  if (large > small * 1.8) out.push(large);
  return out;
}

function loanChance(t: TopicCtx, amount: number): number {
  const { core, actor, other } = t;
  const kin = t.npc.tags.has('kin');
  const frac = amount / Math.max(1, other.money);
  return checkChance(core, actor, other, {
    base: 0.22, opinionW: 0.006, rankUp: -0.02, rankDown: 0.01,
    other: { greedy: -0.15, honest: 0.03, patient: 0.03, content: 0.02 },
    extra: (kin ? 0.25 : 0) + 0.004 * other.rep.generosity - 0.4 * frac + (t.npc.tags.has('stranger') ? -0.12 : 0),
  });
}

function loan(t: TopicCtx, amount: number): TopicReply {
  const { core, actor, other } = t;
  t.npc.vars.money = formatMoney(amount); t.me.vars.money = formatMoney(amount);
  const lines = iSay(t, 'favour.loan.ask');
  if (core.store.debtsOwedBy(actor.id).some((d) => d.from === other.id)) return { lines: [...lines, ...npcSays(t, 'favour.loan.owing', 'cold')] };
  const yes = core.rng().next() < loanChance(t, amount);
  gainSkill(core.sim, actor, 'persuasion', yes ? 5 : 3);
  if (!yes || other.money < amount) return { lines: [...lines, ...npcSays(t, 'favour.loan.no', 'wary')], opinion: -1, reason: 'asked' };
  const r = transferMoney(core, other, actor, amount);
  if (!r.ok) return { lines: [...lines, ...npcSays(t, 'favour.loan.no', 'wary')] };
  core.store.addDebt({ from: other.id, to: actor.id, v: amount, d: core.day });
  core.notify(`${other.first} lends you ${formatMoney(amount)}.`, 'gain');
  return { lines: [...lines, ...npcSays(t, 'favour.loan.yes', 'friendly')], reason: 'loan' };
}

function repay(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const d = core.store.debtsOwedBy(actor.id).find((x) => x.from === other.id);
  if (!d) return { lines: [] };
  const pay = Math.min(d.v, actor.money);
  t.npc.vars.money = formatMoney(pay); t.me.vars.money = formatMoney(pay);
  const lines: DialogueLine[] = iSay(t, 'favour.repay.ask');
  const r = transferMoney(core, actor, other, pay);
  if (!r.ok) return { lines };
  const store = core.store.write();
  d.v -= pay;
  if (d.v <= 0) store.debts.splice(store.debts.indexOf(d), 1);
  core.store.touch();
  const full = d.v <= 0;
  if (full) core.opinion.addRep(actor, 'honour', 1);
  core.notify(full ? `You repay ${other.first}.` : `You repay part of your debt to ${other.first}.`, 'social');
  return { lines: [...lines, ...npcSays(t, full ? 'favour.repay.full' : 'favour.repay.part', 'pleased')], opinion: full ? 4 : 1, reason: 'repaid' };
}

// ---- a meal ----

function mealChance(t: TopicCtx): number {
  const { core, actor, other } = t;
  const near = t.npc.tags.has('kin') || (actor.household !== 0 && actor.household === other.household);
  return checkChance(core, actor, other, {
    base: 0.32, opinionW: 0.007, rankUp: -0.015, rankDown: 0.02,
    other: { greedy: -0.12, patient: 0.03 },
    extra: (near ? 0.3 : 0) + 0.004 * other.rep.generosity - (other.needs.hunger < 0.4 ? 0.12 : 0),
  });
}

function meal(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const lines = iSay(t, 'favour.meal.ask');
  const yes = core.rng().next() < mealChance(t);
  if (!yes) return { lines: [...lines, ...npcSays(t, 'favour.meal.no', 'wary')], opinion: -0.5, reason: 'asked' };
  actor.needs.hunger = round1(Math.min(1, actor.needs.hunger + 0.4)) ;
  actor.needs.mood = Math.min(1, Math.round((actor.needs.mood + 0.03) * 100) / 100);
  core.state.touch(actor);
  core.notify(`${other.first} shares a meal with you.`, 'gain');
  return { lines: [...lines, ...npcSays(t, 'favour.meal.yes', 'friendly')], opinion: t.npc.tags.has('kin') ? 0 : -0.5, reason: 'meal' };
}

// ---- a word put in ----

function voucherTargets(t: TopicCtx): Person[] {
  const { core, actor, other } = t;
  const sc = core.scene(other.settlement);
  const out: Person[] = [];
  const add = (p: Person | null | undefined): void => {
    if (p && !p.death && p.id !== other.id && p.id !== actor.id && !out.some((q) => q.id === p.id) && core.opinion.total(other, p) >= 0) out.push(p);
  };
  // the people whose good opinion matters to someone you court come first
  for (const rec of core.store.courtsInvolving(actor.id)) {
    const partner = core.person(rec.a === actor.id ? rec.b : rec.a);
    if (partner) { add(core.living(partner.father)); add(core.living(partner.mother)); }
  }
  add(sc.lord); add(sc.priest); add(sc.reeve);
  return out;
}

function vouchChance(t: TopicCtx, third: Person): number {
  return checkChance(t.core, t.actor, t.other, {
    base: 0.25, opinionW: 0.006, other: { honest: 0.02, greedy: -0.05 },
    extra: 0.003 * t.core.opinion.total(t.other, third),
  });
}

function vouch(t: TopicCtx, thirdId: number): TopicReply {
  const { core, actor, other } = t;
  const third = core.person(thirdId);
  if (!third) return { lines: [] };
  t.me.vars.third = third.first; t.npc.vars.third = third.first;
  t.npc.vars.thirdaddr = core.speech.address(other, third, true);
  const lines = iSay(t, 'favour.vouch.ask');
  const yes = core.rng().next() < vouchChance(t, third);
  gainSkill(core.sim, actor, 'persuasion', yes ? 6 : 3);
  if (!yes) return { lines: [...lines, ...npcSays(t, 'favour.vouch.no', 'wary')], opinion: -0.5, reason: 'asked' };
  core.opinion.adjust(third.id, actor.id, 4, 'vouched');
  core.notify(`${other.first} speaks well of you to ${third.first}.`, 'social');
  return { lines: [...lines, ...npcSays(t, 'favour.vouch.yes', 'friendly')], opinion: 0.5, reason: 'vouched' };
}

// ---- lessons ----

function canTeach(t: TopicCtx): boolean {
  const { actor, other, core } = t;
  const lt = skillOf(other, 'letters');
  if (lt < 3 || skillOf(actor, 'letters') >= lt - 1) return false;
  if (core.age(actor) < 7) return false;
  const teacher = other.estate === 'clergy' || other.career === 'clerk' || other.career === 'steward' || other.career === 'bailiff' || lt >= 6;
  return teacher && CAREERS[other.career] !== undefined;
}

function lessonChance(t: TopicCtx): number {
  return checkChance(t.core, t.actor, t.other, {
    base: 0.45, opinionW: 0.005, chaW: 0.01, other: { patient: 0.1, hot_tempered: -0.08, pious: 0.04 },
    extra: 0.015 * (t.actor.trained.int - 10),
  });
}

function lessons(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const lines = iSay(t, 'favour.lessons.ask');
  const rec = core.store.talkRec(actor.id, other.id, core.day, true);
  if (rec && (rec.x & 1) !== 0) return { lines: [...lines, ...npcSays(t, 'chat.repeat')] };
  const yes = core.rng().next() < lessonChance(t);
  if (!yes) return { lines: [...lines, ...npcSays(t, 'favour.lessons.no', 'wary')], reason: 'asked' };
  if (rec) { rec.x |= 1; core.store.touch(); }
  const before = skillOf(actor, 'letters');
  gainSkill(core.sim, actor, 'letters', 40);
  const after = skillOf(actor, 'letters');
  core.notify(after > before ? `${other.first}'s lessons raise your Letters to ${after}.` : `You learn a little of letters from ${other.first}.`, 'gain');
  return { lines: [...lines, ...npcSays(t, 'favour.lessons.yes', 'friendly')], opinion: 1, reason: 'lesson' };
}

// ---------------------------------------------------------------------------------------------
// Gifts
// ---------------------------------------------------------------------------------------------

export const giftsGroup: TopicGroup = {
  prefix: 'gift',

  options(t, out) {
    const { session, core, actor } = t;
    if (session.page === 'root') {
      out.push(mkOption('nav.gift', 'Give a gift…', 'gift', { priority: 50 }));
      return;
    }
    if (session.page !== 'gift') return;
    const amounts = new Set<number>();
    for (const f of [0.04, 0.15, 0.4]) { const a = niceAmount(actor.money * f); if (a > 0) amounts.add(a); }
    let i = 0;
    for (const a of [...amounts].sort((x, y) => x - y)) {
      out.push(mkOption(`gift.money.${a}`, `Give ${formatMoney(a)}`, 'gift', { priority: 60 - i++ }));
    }
    const items = Object.keys(actor.inventory).filter((k) => actor.inventory[k] > 0)
      .map((k) => ({ k, v: itemInfo(core, k).value }))
      .sort((a, b) => b.v - a.v || (a.k < b.k ? -1 : 1)).slice(0, 3);
    for (const it of items) {
      out.push(mkOption(`gift.item.${it.k}`, `Give a ${itemInfo(core, it.k).name}`, 'gift', { priority: 50 - i++ }));
    }
    if (out.length === 0 || (amounts.size === 0 && items.length === 0)) {
      out.push(mkOption('gift.none', 'You have nothing to give', 'gift', { enabled: false, reason: 'Your purse and hands are empty.', priority: 10 }));
    }
  },

  choose(t, option): TopicReply {
    const { core, actor, other } = t;
    let value = 0;
    let r: Result;
    if (option.id.startsWith('gift.money.')) {
      const amount = Number(option.id.slice('gift.money.'.length));
      t.npc.vars.money = formatMoney(amount);
      t.me.vars.money = formatMoney(amount);
      r = transferMoney(core, actor, other, amount);
      value = amount;
    } else if (option.id.startsWith('gift.item.')) {
      const key = option.id.slice('gift.item.'.length);
      const info = itemInfo(core, key);
      t.npc.vars.item = info.name; t.me.vars.item = info.name;
      r = transferItem(core, actor, other, key, 1);
      value = info.value;
    } else return { lines: [] };
    if (!r.ok) return { lines: [{ speaker: actor.id, text: r.reason ?? 'You cannot give that.' }] };
    const lines = iSay(t, 'gift.give');
    const rec = core.store.talkRec(actor.id, other.id, core.day, true);
    const nth = rec ? rec.g : 0;
    if (rec) { rec.g++; core.store.touch(); }
    const gain = Math.round(giftGain(core, other, value) * Math.max(0, 1 - RAPPORT.giftPerUse * nth) * 10) / 10;
    const poor = other.rankTier <= 2 || other.career === 'beggar';
    if (nth === 0 && value >= 3 && value >= actor.money * 0.04 && poor) core.opinion.addRep(actor, 'generosity', 1);
    if (value >= 24 && poor) core.news.rumour('alms', other.settlement, actor.id, other.id);
    const suspicious = t.op < -15;
    const pool = other.career === 'beggar' ? 'gift.beggar' : suspicious ? 'gift.suspicious' : 'gift.thanks';
    return { lines: [...lines, ...npcSays(t, pool, suspicious ? 'wary' : 'pleased')], opinion: suspicious ? gain * 0.5 : gain, reason: 'gift', mood: 0.02 };
  },
};

export type { DialogueOption };
