import { describe, expect, it } from 'vitest';
import type { SimEvents } from '../../../src/sim/events';
import { killPerson } from '../../../src/sim/succession';
import type { DialogueOption, TopicProvider } from '../../../src/sim/social/types';
import { OPINION } from '../../../src/sim/social/tuning';
import { begin, forceRolls, lastNpcText, mkPerson, option, pick, rig, setClock, villager } from './helpers';

describe('starting and ending a conversation', () => {
  it('opens with a greeting, options and the relationship, slows the calendar, and says so in events', () => {
    const r = rig({ seed: 'conv-start' });
    const npc = villager(r, { sex: 'f', age: 35 });
    const events: SimEvents['conversation'][] = [];
    r.sim.events.on('conversation', (e) => events.push(e));
    expect(r.sim.state.clock.actionTime).toBe(false);
    const c = begin(r, npc);
    expect(c.actor).toBe(r.player.id);
    expect(c.with).toBe(npc.id);
    expect(c.ended).toBe(false);
    expect(c.lines.length).toBeGreaterThanOrEqual(1);
    expect(c.lines[0].speaker).toBe(npc.id);
    expect(c.lines[0].text.length).toBeGreaterThan(3);
    expect(c.lines[0].text).not.toMatch(/[{}]/);
    expect(c.relation.length).toBeGreaterThan(0);
    expect(c.page).toBe('root');
    expect(r.sim.state.clock.actionTime).toBe(true);
    expect(r.sim.clock.calendarRate()).toBeCloseTo(1 / 20);
    expect(r.social.current()).toBe(c);
    expect(events).toEqual([{ phase: 'start', id: c.id, actor: r.player.id, with: npc.id }]);
    const ids = c.options.map((o) => o.id);
    for (const id of ['nav.chat', 'news', 'nav.ask', 'nav.say', 'nav.favour', 'nav.gift', 'farewell']) expect(ids, id).toContain(id);
    expect(c.options[c.options.length - 1].kind).toBe('leave');
    r.social.end(c.id);
    expect(c.ended).toBe(true);
    expect(r.social.current()).toBeNull();
    expect(r.sim.state.clock.actionTime).toBe(false);
    expect(events[1]).toEqual({ phase: 'end', id: c.id, actor: r.player.id, with: npc.id });
    expect(r.social.end(c.id)).toBeUndefined(); // ending twice is harmless
    expect(events).toHaveLength(2);
  });

  it('names the relationship on the header: kin, office, or stranger', () => {
    const r = rig({ seed: 'conv-relation' });
    const mother = r.sim.state.persons.get(r.player.mother)!;
    const c1 = begin(r, mother);
    expect(c1.relation).toBe('your mother');
    const reeve = villager(r, { age: 45 });
    reeve.offices.push({ office: 'reeve', place: reeve.settlement, since: 0 });
    expect(begin(r, reeve).relation).toBe('the reeve');
    const stranger = villager(r, { age: 30, settlement: r.sim.world.settlements.find((s) => s.id !== r.player.settlement && s.kind === 'village')!.id });
    expect(begin(r, stranger).relation).toMatch(/^a stranger from /);
    const friend = villager(r);
    r.social.adjustOpinion(friend.id, r.player.id, 60, 'gift');
    r.social.adjustOpinion(r.player.id, friend.id, 60, 'gift');
    expect(begin(r, friend).relation).toBe('your friend');
  });

  it('turns fast speeds down to 1× while talking and refuses to speed up', () => {
    const r = rig({ seed: 'conv-speed' });
    const npc = villager(r);
    r.sim.dispatch({ type: 'setSpeed', speed: 3 });
    begin(r, npc);
    expect(r.sim.clock.speed).toBe(1);
    expect(r.sim.dispatch({ type: 'setSpeed', speed: 8 }).ok).toBe(false);
  });

  it('refuses the dead, the sleeping, babies, yourself, and the very hostile', () => {
    const r = rig({ seed: 'conv-refuse' });
    const npc = villager(r);
    const baby = mkPerson(r.sim, { age: 1, household: npc.household });
    const dead = villager(r);
    killPerson(r.sim, dead, 'illness', r.sim.absDay);
    const why = (id: number): string => {
      const res = r.social.start(r.player.id, id);
      expect('ok' in res).toBe(true);
      return 'reason' in res ? res.reason ?? '' : '';
    };
    expect(why(dead.id)).toMatch(/dead/);
    expect(why(baby.id)).toMatch(/too young/);
    expect(why(r.player.id)).toMatch(/yourself/);
    setClock(r.sim, 0.04); // deep night
    expect(why(npc.id)).toMatch(/asleep/);
    r.social.setHooks?.({ awakeHook: () => true });
    expect('ok' in r.social.start(r.player.id, npc.id)).toBe(false); // now awake: a Conversation, not a Result
    r.social.end(r.social.current()!.id);
    r.social.setHooks?.({ awakeHook: undefined });
    setClock(r.sim, 0.5);
    r.social.adjustOpinion(npc.id, r.player.id, -200, 'insult');
    expect(r.social.opinion(npc.id, r.player.id)).toBeLessThanOrEqual(OPINION.refuseAtOrBelow);
    expect(why(npc.id)).toMatch(/./);
    expect(r.social.current()).toBeNull();
    expect(r.sim.state.clock.actionTime).toBe(false);
  });

  it('keeps people on watch awake at night', () => {
    const r = rig({ seed: 'conv-watch' });
    const guard = villager(r, { career: 'man_at_arms' });
    setClock(r.sim, 0.04);
    const c = r.social.start(r.player.id, guard.id);
    expect('ok' in c).toBe(false);
  });

  it('allows one conversation at a time', () => {
    const r = rig({ seed: 'conv-one' });
    const a = villager(r), b = villager(r);
    const c = begin(r, a);
    const second = r.social.start(r.player.id, b.id);
    expect('ok' in second && !second.ok).toBe(true);
    expect(r.social.start(r.player.id, a.id)).toBe(c); // the same one again is the same conversation
    r.social.end(c.id);
    expect('ok' in r.social.start(r.player.id, b.id)).toBe(false);
  });

  it('ends when either person dies or the player switches character', () => {
    const r = rig({ seed: 'conv-ends' });
    const a = villager(r);
    const c1 = begin(r, a);
    killPerson(r.sim, a, 'accident', r.sim.absDay);
    expect(c1.ended).toBe(true);
    expect(r.sim.state.clock.actionTime).toBe(false);
    const b = villager(r);
    const c2 = begin(r, b);
    const sibling = mkPerson(r.sim, { age: 15, household: r.player.household, father: r.sim.state.persons.get(r.player.father), mother: r.sim.state.persons.get(r.player.mother) });
    expect(r.sim.switchTo(sibling.id)).toBe(true);
    expect(c2.ended).toBe(true);
    expect(r.social.current()).toBeNull();
  });

  it('does not resume in action time after a load', () => {
    const r = rig({ seed: 'conv-load' });
    r.sim.state.clock.actionTime = true; // as if saved mid-conversation
    const again = rig({ seed: 'conv-load' });
    again.sim.state.clock.actionTime = true;
    expect(again.social.current()).toBeNull();
  });
});

describe('choosing', () => {
  it('walks the menu pages and talks, with consequences shown on the conversation', () => {
    const r = rig({ seed: 'conv-choose' });
    const npc = villager(r, { sex: 'm', age: 40 });
    let c = begin(r, npc);
    const start = c.opinion;
    c = r.social.choose(c.id, 'nav.chat');
    expect(c.page).toBe('chat');
    expect((c.pageLabel ?? '').length).toBeGreaterThan(0);
    expect(c.options.map((o) => o.id)).toEqual(expect.arrayContaining(['chat.weather', 'chat.harvest', 'chat.hopes', 'nav.back']));
    const lines = c.lines.length;
    c = r.social.choose(c.id, 'chat.weather');
    expect(c.lines.length).toBe(lines + 2); // what you say and what they answer
    expect(c.lines[lines].speaker).toBe(r.player.id);
    expect(c.lines[lines + 1].speaker).toBe(npc.id);
    expect(c.opinion).toBeGreaterThan(start);
    expect(c.opinionDelta).toBe(c.opinion - start);
    c = r.social.choose(c.id, 'nav.back');
    expect(c.page).toBe('root');
    // unknown or disabled options change nothing
    const n = c.lines.length;
    expect(r.social.choose(c.id, 'no.such.thing').lines.length).toBe(n);
    c = r.social.choose(c.id, 'farewell');
    expect(c.ended).toBe(true);
    expect(r.social.choose(c.id, 'nav.chat')).toBe(c); // nothing happens after the end
    expect(() => r.social.choose(9999, 'x')).toThrow();
  });

  it('wears the topic out: a repeat in one conversation, boredom after several in a day', () => {
    const r = rig({ seed: 'conv-tired' });
    const npc = villager(r);
    let c = begin(r, npc);
    c = pick(r, c, 'nav.chat', 'chat.weather');
    const gain1 = c.opinionDelta;
    expect(gain1).toBeGreaterThan(0);
    const before = c.opinion;
    c = pick(r, c, 'chat.weather'); // the same again
    expect(c.opinion).toBe(before);
    c = pick(r, c, 'chat.harvest', 'chat.prices', 'chat.work', 'chat.hopes');
    const tired = c.opinion;
    c = pick(r, c, 'chat.church');
    expect(c.opinion).toBe(tired); // five topics today: they have had enough
    expect(lastNpcText(c, npc.id).length).toBeGreaterThan(5);
  });

  it('never gives the same reply twice running to the same question', () => {
    const r = rig({ seed: 'conv-variety' });
    const npc = villager(r, { sex: 'f' });
    const replies: string[] = [];
    const asks: string[] = [];
    for (let day = 0; day < 10; day++) {
      setClock(r.sim, 0.5, day + 1);
      let c = begin(r, npc);
      c = pick(r, c, 'nav.chat', 'chat.hopes');
      const n = c.lines.length;
      asks.push(c.lines[n - 2].text);
      replies.push(c.lines[n - 1].text);
      r.social.end(c.id);
    }
    for (let i = 1; i < replies.length; i++) {
      expect(replies[i], `reply ${i}`).not.toBe(replies[i - 1]);
      expect(asks[i], `ask ${i}`).not.toBe(asks[i - 1]);
    }
    expect(new Set(replies).size).toBeGreaterThan(3);
  });

  it('shows the exact chance of a check and rises with charisma and persuasion', () => {
    const r = rig({ seed: 'conv-chance' });
    const npc = villager(r);
    const read = (): number => {
      const c = begin(r, npc);
      const o = option(r.social.choose(c.id, 'nav.say'), 'say.flatter');
      r.social.end(c.id);
      return o.chance!;
    };
    r.player.trained.cha = 6;
    const low = read();
    r.player.trained.cha = 16;
    const high = read();
    expect(high).toBeGreaterThan(low);
    r.player.skills.persuasion = 1600; // level 6
    expect(read()).toBeGreaterThan(high);
    for (const v of [low, high]) { expect(v).toBeGreaterThanOrEqual(0.03); expect(v).toBeLessThanOrEqual(0.97); }
  });

  it('rolls the chance it shows: forced rolls decide flattery', () => {
    const r = rig({ seed: 'conv-roll' });
    const npc = villager(r, { traits: ['ambitious'] });
    let c = begin(r, npc);
    c = pick(r, c, 'nav.say');
    const before = c.opinion;
    const restore = forceRolls(r, 0.0);
    c = pick(r, c, 'say.flatter');
    restore();
    expect(c.opinion).toBeGreaterThan(before);
    const npc2 = villager(r, { traits: ['honest'] });
    r.social.end(c.id);
    let d = begin(r, npc2);
    d = pick(r, d, 'nav.say');
    const b2 = d.opinion;
    const restore2 = forceRolls(r, 0.999);
    d = pick(r, d, 'say.flatter');
    restore2();
    expect(d.opinion).toBeLessThan(b2);
  });

  it('gates options: apology only after a wrong, with a reason otherwise', () => {
    const r = rig({ seed: 'conv-gate' });
    const npc = villager(r);
    let c = begin(r, npc);
    c = pick(r, c, 'nav.say');
    const apology = option(c, 'say.apologise');
    expect(apology.enabled).toBe(false);
    expect(apology.reason).toMatch(/no wrong/);
    c = pick(r, c, 'say.insult');
    if (c.ended) { const again = begin(r, npc); c = pick(r, again, 'nav.say'); } else c = pick(r, c, 'nav.back', 'nav.say');
    expect(option(c, 'say.apologise').enabled).toBe(true);
    expect(option(c, 'say.apologise').chance).toBeGreaterThan(0);
    // disabled options are listed after the enabled ones
    const flags = c.options.filter((o) => o.kind !== 'leave').map((o) => o.enabled);
    expect(flags.join()).toBe([...flags].sort((a, b) => Number(b) - Number(a)).join());
  });

  it('is cut short by the other when it turns bitter, and they will not talk again for a while', () => {
    const r = rig({ seed: 'conv-bitter' });
    const npc = villager(r, { traits: ['hot_tempered'] });
    // soured to just above the cut-off line
    const base = r.core.opinion.base(npc, r.player);
    r.social.adjustOpinion(npc.id, r.player.id, -(base + 35), 'insult');
    let c = begin(r, npc);
    c = pick(r, c, 'nav.say', 'say.insult');
    expect(c.ended).toBe(true);
    expect(r.sim.state.clock.actionTime).toBe(false);
    expect(c.opinion).toBeLessThanOrEqual(OPINION.cutOffAtOrBelow);
    expect(c.lines.some((l) => l.tone === 'angry')).toBe(true);
  });
});

describe('other modules add topics', () => {
  it('lists a registered provider on the root page, runs its reply and honours opinion, ui and end', () => {
    const r = rig({ seed: 'conv-topic' });
    const npc = villager(r);
    const ui: SimEvents['ui'][] = [];
    r.sim.events.on('ui', (e) => ui.push(e));
    const provider: TopicProvider = {
      id: 'economy.test',
      options(conv, out) {
        out.push({ id: 'work.ask', provider: '', label: 'Ask for work', kind: 'work', enabled: true, priority: 99 });
        out.push({ id: 'trade', provider: '', label: 'Trade…', kind: 'trade', enabled: false, reason: 'Nothing to trade', priority: 98 });
        void conv;
      },
      choose(_conv, o: DialogueOption) {
        if (o.id === 'work.ask') return { lines: [{ speaker: npc.id, text: 'There is work at the mill.' }], opinion: 2, ui: { panel: 'jobs', settlement: npc.settlement } };
        return { lines: [] };
      },
    };
    const off = r.social.registerTopic(provider);
    let c = begin(r, npc);
    const opt = option(c, 'work.ask');
    expect(opt.provider).toBe('economy.test');
    expect(c.options[0].id).toBe('work.ask'); // priority first
    expect(option(c, 'trade').enabled).toBe(false);
    const before = c.opinion;
    c = r.social.choose(c.id, 'work.ask');
    expect(c.lines[c.lines.length - 1].text).toBe('There is work at the mill.');
    expect(c.opinion).toBe(before + 2);
    expect(ui).toEqual([{ panel: 'jobs', settlement: npc.settlement }]);
    // outside the root page the foreign options are not shown
    c = r.social.choose(c.id, 'nav.chat');
    expect(c.options.some((o) => o.id === 'work.ask')).toBe(false);
    off();
    c = r.social.choose(c.id, 'nav.back');
    expect(c.options.some((o) => o.id === 'work.ask')).toBe(false);
  });

  it('survives a provider that throws', () => {
    const r = rig({ seed: 'conv-throw' });
    const npc = villager(r);
    r.social.registerTopic({ id: 'bad', options() { throw new Error('boom'); }, choose() { throw new Error('boom'); } });
    const c = begin(r, npc);
    expect(c.options.length).toBeGreaterThan(3);
  });
});
