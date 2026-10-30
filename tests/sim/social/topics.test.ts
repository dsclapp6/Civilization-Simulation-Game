import { describe, expect, it } from 'vitest';
import { formatMoney } from '../../../src/sim/money';
import { skillLevel } from '../../../src/sim/people';
import type { Person } from '../../../src/sim/state';
import { DEBT } from '../../../src/sim/social/tuning';
import type { Conversation } from '../../../src/sim/social/types';
import { begin, forceRolls, lastNpcText, mkPerson, option, pick, rig, setClock, villager, type Rig } from './helpers';

function say(r: Rig, npc: Person, ...path: string[]): Conversation {
  const c = begin(r, npc);
  return pick(r, c, ...path);
}

describe('gifts', () => {
  it('hands over money, earns goodwill with diminishing returns, and a name for generosity', () => {
    const r = rig({ seed: 'gift-money' });
    const npc = villager(r, { tier: 1, estate: 'unfree', money: 4 });
    r.player.money = 600;
    r.player.rep.generosity = 0;
    let c = begin(r, npc);
    c = pick(r, c, 'nav.gift');
    const gifts = c.options.filter((o) => o.id.startsWith('gift.money.'));
    expect(gifts.length).toBeGreaterThanOrEqual(2);
    const amounts = gifts.map((o) => Number(o.id.split('.').pop()));
    expect(amounts.every((a) => a > 0 && a <= 600)).toBe(true);
    expect(amounts).toEqual([...amounts].sort((a, b) => a - b));
    const first = gifts[0].id;
    const before = c.opinion;
    const purse = r.player.money;
    c = r.social.choose(c.id, first);
    const a1 = Number(first.split('.').pop());
    expect(r.player.money).toBe(purse - a1);
    expect(npc.money).toBe(4 + a1);
    const gain1 = c.opinion - before;
    expect(gain1).toBeGreaterThan(0);
    expect(r.player.rep.generosity).toBe(1);
    // again: less
    const mid = c.opinion;
    c = r.social.choose(c.id, first);
    const gain2 = c.opinion - mid;
    expect(gain2).toBeLessThan(gain1);
    expect(r.player.rep.generosity).toBe(1); // one alms a day is remembered
    expect(c.lines[c.lines.length - 1].speaker).toBe(npc.id);
  });

  it('gives goods too, through the economy\'s hook when it has one', () => {
    const r = rig({ seed: 'gift-item' });
    const npc = villager(r);
    r.player.inventory['wheat'] = 3;
    const seen: Array<[number, number, string, number]> = [];
    r.social.setHooks?.({
      itemInfoHook: (k) => ({ name: k === 'wheat' ? 'sack of wheat' : k, value: 20 }),
      giveHook: (from, to, key, qty) => { seen.push([from, to, key, qty]); return { ok: true }; },
    });
    let c = begin(r, npc);
    c = pick(r, c, 'nav.gift');
    const o = option(c, 'gift.item.wheat');
    expect(o.label).toBe('Give a sack of wheat');
    const before = c.opinion;
    c = r.social.choose(c.id, 'gift.item.wheat');
    expect(seen).toEqual([[r.player.id, npc.id, 'wheat', 1]]);
    expect(c.opinion).toBeGreaterThan(before);
    // without a hook the goods move between inventories directly
    r.social.setHooks?.({ giveHook: undefined });
    setClock(r.sim, 0.5, 5);
    const other = villager(r);
    let d = begin(r, other);
    d = pick(r, d, 'nav.gift', 'gift.item.wheat');
    expect(r.player.inventory['wheat']).toBe(2);
    expect(other.inventory['wheat']).toBe(1);
    expect(d.lines.length).toBeGreaterThan(1);
  });

  it('says so when the purse and hands are empty', () => {
    const r = rig({ seed: 'gift-none' });
    const npc = villager(r);
    r.player.money = 0;
    r.player.inventory = {};
    const c = say(r, npc, 'nav.gift');
    expect(c.options.some((o) => o.id === 'gift.none' && !o.enabled)).toBe(true);
  });
});

describe('loans and debts', () => {
  it('lends to a friend, records the debt, and does not lend twice', () => {
    const r = rig({ seed: 'loan' });
    const npc = villager(r, { money: 400 });
    r.social.adjustOpinion(npc.id, r.player.id, 40, 'gift');
    let c = begin(r, npc);
    c = pick(r, c, 'nav.favour');
    const loans = c.options.filter((o) => o.id.startsWith('favour.loan.'));
    expect(loans.length).toBeGreaterThanOrEqual(1);
    expect(loans[0].chance).toBeGreaterThan(0.1);
    const amount = Number(loans[0].id.split('.').pop());
    const restore = forceRolls(r, 0.0);
    const purse = r.player.money;
    c = r.social.choose(c.id, loans[0].id);
    restore();
    expect(r.player.money).toBe(purse + amount);
    expect(npc.money).toBe(400 - amount);
    expect(r.core.store.debtsOwedBy(r.player.id)).toEqual([{ from: npc.id, to: r.player.id, v: amount, d: 0 }]);
    // a second loan is closed to you until you repay
    expect(c.options.filter((o) => o.id.startsWith('favour.loan.')).every((o) => !o.enabled)).toBe(true);
    // and the lender reminds you next time
    r.social.end(c.id);
    setClock(r.sim, 0.5, 2);
    const d = begin(r, npc);
    expect(d.lines.some((l) => l.text.includes(formatMoney(amount)))).toBe(true);
  });

  it('is repaid in full or in part, mending the lender\'s trust and your name', () => {
    const r = rig({ seed: 'repay' });
    const npc = villager(r, { money: 300 });
    r.core.store.addDebt({ from: npc.id, to: r.player.id, v: 60, d: 0 });
    r.player.money = 100;
    r.player.rep.honour = 0;
    let c = begin(r, npc);
    const repay = option(c, `favour.repay.${npc.id}`);
    expect(repay.label).toMatch(/Repay what you owe/);
    const before = c.opinion;
    c = r.social.choose(c.id, repay.id);
    expect(r.player.money).toBe(40);
    expect(npc.money).toBe(360);
    expect(r.core.store.debtsOwedBy(r.player.id)).toEqual([]);
    expect(r.player.rep.honour).toBe(1);
    expect(c.opinion).toBeGreaterThan(before);
    // part payment
    r.core.store.addDebt({ from: npc.id, to: r.player.id, v: 100, d: 0 });
    r.player.money = 30;
    c = begin(r, npc);
    const part = option(c, `favour.repay.${npc.id}`);
    expect(part.label).toMatch(/what you can/);
    c = r.social.choose(c.id, part.id);
    expect(r.core.store.debtsOwedBy(r.player.id)[0].v).toBe(70);
  });

  it('sours the lender\'s regard while a debt hangs, and is forgotten if either dies', () => {
    const r = rig({ seed: 'overdue' });
    const npc = villager(r, { money: 300 });
    r.core.store.addDebt({ from: npc.id, to: r.player.id, v: 24, d: 0 });
    const start = r.social.opinion(npc.id, r.player.id);
    r.sim.advanceDays(28);
    expect(r.social.opinion(npc.id, r.player.id)).toBeLessThan(start);
    expect(r.core.store.read().debts.length).toBe(1);
    npc.death = { day: r.sim.absDay, cause: 'illness' };
    r.sim.state.markDead(npc, r.sim.absDay, 'illness');
    r.sim.events.emit('death', { person: npc.id, cause: 'illness', age: 30, wasHead: false });
    expect(r.core.store.read().debts.length).toBe(0);
    expect(DEBT.max).toBeGreaterThan(5);
  });
});

describe('other favours', () => {
  it('gives a hungry guest a meal from a friendly host', () => {
    const r = rig({ seed: 'meal' });
    const npc = villager(r);
    r.social.adjustOpinion(npc.id, r.player.id, 30, 'gift');
    r.player.needs.hunger = 0.2;
    let c = begin(r, npc);
    c = pick(r, c, 'nav.favour');
    expect(option(c, 'favour.meal').enabled).toBe(true);
    const restore = forceRolls(r, 0.0);
    r.social.choose(c.id, 'favour.meal');
    restore();
    expect(r.player.needs.hunger).toBeGreaterThan(0.55);
    // not when full
    r.player.needs.hunger = 1;
    const d = pick(r, r.social.current()!, 'nav.back', 'nav.favour');
    expect(option(d, 'favour.meal').enabled).toBe(false);
  });

  it('teaches letters, once a day, to a pupil with a willing priest', () => {
    const r = rig({ seed: 'lessons' });
    const priest = villager(r, { sex: 'm', age: 40, career: 'priest', estate: 'clergy', traits: ['patient'] });
    priest.skills.letters = 1600;
    r.social.adjustOpinion(priest.id, r.player.id, 20, 'gift');
    r.player.skills.letters = 0;
    let c = begin(r, priest);
    c = pick(r, c, 'nav.favour');
    const lessons = option(c, 'favour.lessons');
    expect(lessons.enabled).toBe(true);
    expect(lessons.chance).toBeGreaterThan(0.3);
    const restore = forceRolls(r, 0.0);
    c = r.social.choose(c.id, 'favour.lessons');
    restore();
    expect(r.player.skills.letters).toBeGreaterThan(20);
    expect(option(c, 'favour.lessons').enabled).toBe(false);
    expect(option(c, 'favour.lessons').reason).toMatch(/Not again/);
    expect(skillLevel(r.player.skills.letters)).toBeGreaterThanOrEqual(0);
    // a layman with no letters cannot teach
    const plain = villager(r);
    const d = say(r, plain, 'nav.favour');
    expect(d.options.some((o) => o.id === 'favour.lessons')).toBe(false);
  });

  it('puts in a good word with someone whose opinion matters', () => {
    const r = rig({ seed: 'vouch' });
    const friend = villager(r);
    r.social.adjustOpinion(friend.id, r.player.id, 40, 'gift');
    const priest = villager(r, { career: 'priest', estate: 'clergy', sex: 'm' });
    r.core.scene(r.player.settlement).priest = priest;
    r.social.adjustOpinion(friend.id, priest.id, 20, 'gift');
    let c = begin(r, friend);
    c = pick(r, c, 'nav.favour');
    const vouch = c.options.find((o) => o.id.startsWith('favour.vouch.'));
    expect(vouch).toBeDefined();
    const target = Number(vouch!.id.split('.').pop());
    const before = r.social.opinion(target, r.player.id);
    const restore = forceRolls(r, 0.0);
    r.social.choose(c.id, vouch!.id);
    restore();
    expect(r.social.opinion(target, r.player.id)).toBeGreaterThan(before);
  });
});

describe('speaking your mind', () => {
  it('an insult costs goodwill, honour and is remembered; an apology mends part of it', () => {
    const r = rig({ seed: 'insult' });
    const npc = villager(r, { traits: ['patient'] });
    r.player.rep.honour = 0;
    let c = say(r, npc, 'nav.say');
    const before = c.opinion;
    c = pick(r, c, 'say.insult');
    expect(c.opinion).toBeLessThan(before - 4);
    expect(r.player.rep.honour).toBe(-1);
    expect(r.core.store.memoriesOf(npc.id, r.player.id).some((m) => m.r === 'insult' && m.v < 0)).toBe(true);
    if (c.ended) { c = begin(r, npc); }
    c = pick(r, c, 'nav.say');
    const low = c.opinion;
    const restore = forceRolls(r, 0.0);
    c = pick(r, c, 'say.apologise');
    restore();
    expect(c.opinion).toBeGreaterThan(low + 2);
    expect(r.core.store.memoriesOf(npc.id, r.player.id).some((m) => m.v < 0)).toBe(false);
    expect(r.player.rep.honour).toBe(0);
  });

  it('a threat can take a purse from the weak, and be the end of the talk with the strong', () => {
    const r = rig({ seed: 'threat' });
    const weak = villager(r, { traits: ['craven'], money: 50, age: 14 });
    weak.trained.str = 3;
    r.player.trained.str = 14;
    r.player.rep.cruelty = 0;
    let c = say(r, weak, 'nav.say');
    expect(option(c, 'say.threaten').chance).toBeGreaterThan(0.4);
    const purse = r.player.money;
    const restore = forceRolls(r, 0.0);
    c = pick(r, c, 'say.threaten');
    restore();
    expect(r.player.money).toBeGreaterThan(purse);
    expect(weak.money).toBeLessThan(50);
    expect(r.player.rep.cruelty).toBe(2);
    expect(r.player.skills.leadership).toBeGreaterThan(0);

    const lord = villager(r, { tier: 5, estate: 'noble', career: 'knight', traits: ['brave'] });
    let d = say(r, lord, 'nav.say');
    expect(option(d, 'say.threaten').chance).toBeLessThan(0.25);
    const restore2 = forceRolls(r, 0.999);
    d = pick(r, d, 'say.threaten');
    restore2();
    expect(d.ended).toBe(true);
  });

  it('boasting needs something to boast of, and is judged by what is true', () => {
    const r = rig({ seed: 'boast' });
    const npc = villager(r);
    r.player.skills.farming = 0; r.player.skills.archery = 0;
    for (const k of Object.keys(r.player.skills)) (r.player.skills as Record<string, number>)[k] = 0;
    r.player.trained.str = 9; r.player.trained.cha = 9; r.player.trained.end = 9; r.player.trained.int = 9;
    r.player.rankTier = 2; r.player.prestige = 0; r.player.money = 5;
    const poor = option(say(r, npc, 'nav.say'), 'say.boast');
    expect(poor.reason).toMatch(/little to boast/);
    r.social.end(r.social.current()!.id);
    r.player.skills.archery = 4000; // level 10
    setClock(r.sim, 0.5, 3);
    const rich = option(say(r, npc, 'nav.say'), 'say.boast');
    expect(rich.reason).toBeUndefined();
    expect(rich.chance!).toBeGreaterThan(poor.chance!);
    const c = r.social.current()!;
    const restore = forceRolls(r, 0.0);
    const after = r.social.choose(c.id, 'say.boast');
    restore();
    expect(after.lines.some((l) => /archery/.test(l.text))).toBe(true);
  });

  it('flatters according to what the other is proud of', () => {
    const r = rig({ seed: 'flatter' });
    const smith = villager(r, { career: 'smith', sex: 'm' });
    smith.skills.smithing = 3000;
    const c = say(r, smith, 'nav.say', 'say.flatter');
    const mine = c.lines.find((l) => l.speaker === r.player.id)!;
    expect(mine.text).toMatch(/best|craft|trade|born|hand|work|smith/i);
  });
});

describe('asking about people, places, marriage and the news', () => {
  it('tells of the lord, the priest and neighbours by name, and of places by distance and direction', () => {
    const r = rig({ seed: 'ask', preset: 'small' });
    const npc = villager(r, { age: 45, traits: ['honest'] });
    let c = begin(r, npc);
    c = pick(r, c, 'nav.ask');
    const people = c.options.filter((o) => o.id.startsWith('ask.person.'));
    const places = c.options.filter((o) => o.id.startsWith('ask.place.'));
    expect(people.length).toBeGreaterThan(0);
    expect(places.length).toBeGreaterThan(0);
    const n = c.lines.length;
    c = r.social.choose(c.id, people[0].id);
    expect(c.lines.length).toBeGreaterThan(n + 1);
    expect(c.lines.slice(n).every((l) => !/[{}]/.test(l.text))).toBe(true);
    const m = c.lines.length;
    c = r.social.choose(c.id, places[0].id);
    const text = c.lines.slice(m).map((l) => l.text).join(' ');
    expect(text).toMatch(/north|south|east|west/);
    expect(text).toMatch(/walk/);
  });

  it('names who there is to marry for someone of an age to wed', () => {
    const r = rig({ seed: 'ask-marry' });
    const adult = mkPerson(r.sim, { age: 20, sex: 'm', household: r.player.household, settlement: r.player.settlement });
    r.sim.switchTo(adult.id);
    const npc = villager(r, { age: 45 });
    let c = begin({ ...r, player: adult }, npc);
    c = pick(r, c, 'nav.ask');
    const o = option(c, 'ask.marriageable');
    c = r.social.choose(c.id, o.id);
    const reply = lastNpcText(c, npc.id);
    expect(reply.length).toBeGreaterThan(10);
    expect(reply).not.toMatch(/[{}]/);
  });

  it('tells the news once, and then something else', () => {
    const r = rig({ seed: 'news' });
    const npc = villager(r, { age: 50 });
    // plenty of recent happenings to talk of
    for (let i = 0; i < 4; i++) {
      const mother = villager(r, { sex: 'f', age: 25 });
      const child = mkPerson(r.sim, { age: 0, sex: i % 2 ? 'f' : 'm', household: mother.household, mother, settlement: mother.settlement });
      child.birthDay = Math.floor(r.sim.absDay) - 1 - i;
    }
    const c1 = say(r, npc, 'news');
    const first = c1.lines.filter((l) => l.speaker === npc.id).map((l) => l.text);
    expect(first.length).toBeGreaterThanOrEqual(2);
    r.social.end(c1.id);
    setClock(r.sim, 0.5, 1);
    const c2 = say(r, npc, 'news');
    const second = c2.lines.filter((l) => l.speaker === npc.id).map((l) => l.text);
    const shared = second.filter((t) => first.includes(t) && t.length > 40);
    expect(shared.length).toBe(0);
  });

  it('talks of small things without ever leaving a placeholder', () => {
    const r = rig({ seed: 'smalltalk', preset: 'small' });
    const bad: string[] = [];
    const people = [...r.sim.state.persons.values()].filter((p) => !p.death && r.core.age(p) >= 8 && p.id % 11 === 0).slice(0, 30);
    for (const p of people) {
      for (const day of [1, 2]) {
        setClock(r.sim, 0.5, day);
        const c0 = r.social.start(r.player.id, p.id);
        if ('ok' in c0) continue;
        let c = pick(r, c0, 'nav.chat');
        for (const t of ['weather', 'harvest', 'prices', 'family', 'lord', 'church', 'work', 'hopes']) {
          if (!c.options.some((o) => o.id === `chat.${t}`)) continue;
          c = r.social.choose(c.id, `chat.${t}`);
          if (c.ended) break;
        }
        for (const l of c.lines) if (/[{}]|undefined|NaN/.test(l.text) || l.text.trim().length === 0) bad.push(`${p.first}: "${l.text}"`);
        if (!c.ended) r.social.end(c.id);
      }
    }
    expect(bad).toEqual([]);
    expect([...r.core.speech.unknownVars]).toEqual([]);
  });
});
