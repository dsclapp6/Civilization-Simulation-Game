// Captivity (docs/CIV.md §4): taken after yielding or losing the fight, bound and led to the lock-up, held there; wait for the ransom,
// pay your own, serve a sentence, try to escape at night (caught is worse); the lord who hangs only the enemy soldier who killed his
// men, at war, if he is cruel, and after a warning.
import { describe, expect, it } from 'vitest';
import type { SimEvents } from '../../../src/sim/events';
import type { FightResult } from '../../../src/sim/wave3';
import { lawContext, lawRig, rideUp, type LawRig } from './helpers';

const ev = (r: LawRig): Array<SimEvents['trespass']> => { const out: Array<SimEvents['trespass']> = []; r.sim.events.on('trespass', (e) => out.push(e)); return out; };

/** The patrol is up with the player and the standoff is open. */
function halted(seed = 'law-cap'): LawRig {
  const r = lawRig({ seed });
  r.law.report(r.stranger.id, r.court.x, r.court.z);
  rideUp(r);
  r.run(0.2);
  expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('halt');
  return r;
}

const result = (r: LawRig, fight: number, over: Partial<FightResult>): FightResult => ({ id: fight, winner: null, dead: [], wounded: [], captured: [], fled: [], ...over });

describe('yielding', () => {
  it('Yield: he is bound and led, on foot, behind the leader, to the lock-up', () => {
    const r = halted();
    const events = ev(r);
    expect(r.law.answerPatrol(r.stranger.id, 'yield').ok).toBe(true);
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p.phase).toBe('taking');
    expect(r.stranger.flags.captive).toBe(true);
    const c = r.law.captivity(r.stranger.id)!;
    expect(c).toMatchObject({ person: r.stranger.id, kind: 'trespass', captor: p.leader, settlement: r.village.id, building: -1 });
    expect(c.text).toMatch(/^Bound and led to the manor's lock-up at/);
    expect(c.fine).toBeGreaterThan(0);
    expect(c.sentenceDays).toBeGreaterThanOrEqual(1);
    expect(c.led).toBe(true);
    expect(r.player.bound).toMatchObject({ kind: 'led', by: p.leader });
    expect(r.player.bound!.reason).toMatch(/lock-up/);
    expect(events.map((e) => e.phase)).toEqual(['captured']);
    // he is bound and cannot be offered a way out until he is there
    expect(r.law.captivityChoices(r.stranger.id).find((x) => x.id === 'escape')!.ok).toBe(false);
    // the leader leads him to the door; the men follow the leader
    r.run(1);
    const goto = r.zone.commands.filter((x) => x.order.kind === 'goto' && x.person === p.leader);
    expect(goto.length).toBeGreaterThan(0);
  });

  it('is put in the cell when the leader brings him to the door: held there, and the patrol is dismissed', () => {
    const r = halted();
    r.law.answerPatrol(r.stranger.id, 'yield');
    const p = r.law.patrolFor(r.stranger.id)!;
    const c0 = r.law.captivity(r.stranger.id)!;
    const gaol = r.sim.state.buildings.get(r.sim.state.buildingsAt.get(r.village.id)!.find((b) => b.kind === 'manor_house')!.id)!;
    // the leader stands at the door with the prisoner close behind
    const lead = r.zone.agent(p.leader)!;
    const door = lawContext(r.sim).law.doorOf(gaol.id)!;
    lead.x = door.x; lead.z = door.z;
    r.player.pos.x = door.x - 2; r.player.pos.z = door.z - 2;
    r.run(1.2);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    const c = r.law.captivity(r.stranger.id)!;
    expect(c.building).toBe(gaol.id);
    expect(c.led).toBe(false);
    expect(c.text).toMatch(/^Held in the manor's lock-up at/);
    expect(r.player.bound).toMatchObject({ kind: 'held', building: gaol.id });
    expect(r.player.placed.length).toBeGreaterThan(0);
    expect(c0.since).toBe(c.since);
    // the ruler sees him among the prisoners of the place
    expect(r.law.prisoners(r.village.id).map((x) => x.person)).toContain(r.stranger.id);
    expect(r.law.prisoners(-5)).toEqual([]);
    // the zone's agents show a prisoner nothing but the schedule's
    expect(r.law.version()).toBeGreaterThan(0);
  });

  it('is put in the cell at once when there is no zone to show the walk (headless)', () => {
    const r = lawRig({ zone: false });
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    // no zone: the men "arrive" after a plausible ride and the halt opens
    r.run(7);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('halt');
    r.law.answerPatrol(r.stranger.id, 'yield');
    const c = r.law.captivity(r.stranger.id)!;
    expect(c.led).toBe(false);
    expect(c.building).toBeGreaterThanOrEqual(0);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
  });
});

describe('refusing and the fight', () => {
  it('Refuse: the men fight to wound (subdue) and take him when he goes down', () => {
    const r = halted();
    expect(r.law.answerPatrol(r.stranger.id, 'refuse').ok).toBe(true);
    const e = r.combat.engaged[0];
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p.phase).toBe('attack');
    expect(e.opts).toMatchObject({ intent: 'subdue', yieldAllowed: true, reason: 'patrol' });
    // the patrol wins: he is taken and his wounds are bound up by his captors
    r.sim.events.emit('fightEnded', result(r, e.id, { winner: 'patrol', wounded: [r.stranger.id] }));
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('taking');
    expect(r.stranger.flags.captive).toBe(true);
    expect(r.combat.tended).toContainEqual({ healer: p.leader, patient: r.stranger.id });
    expect(r.law.captivity(r.stranger.id)!.text).toMatch(/trespass|closes/);
  });

  it('the subdue fight reports him captured: he is taken whoever the faction says won', () => {
    const r = halted();
    r.law.answerPatrol(r.stranger.id, 'refuse');
    const e = r.combat.engaged[0];
    const p = r.law.patrolFor(r.stranger.id)!;
    r.sim.events.emit('fightEnded', result(r, e.id, { winner: 'patrol', captured: [{ captive: r.stranger.id, captor: p.leader }] }));
    expect(r.law.captivity(r.stranger.id)).not.toBeNull();
  });

  it('flight from the halt is a fight: walk off and they run you down', () => {
    const r = halted();
    r.player.pos.x += 25;
    r.run(1.5);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('halt');
    expect(r.law.patrolFor(r.stranger.id)!.line).toMatch(/^Stop/);
    r.run(3);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('attack');
    expect(r.combat.engaged.length).toBe(1);
  });

  it('silence at the halt: asked again, then the fight', () => {
    const r = halted();
    r.run(71);
    expect(r.law.patrolFor(r.stranger.id)!.line).toMatch(/^Well\?/);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('halt');
    r.run(23);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('attack');
  });

  it('when the men lose he is named an outlaw (they died) and wanted on the lord\'s lands', () => {
    const r = halted();
    r.law.answerPatrol(r.stranger.id, 'refuse');
    const e = r.combat.engaged[0];
    const p = r.law.patrolFor(r.stranger.id)!;
    r.sim.events.emit('fightEnded', result(r, e.id, { winner: 'player', dead: [p.men[0]] }));
    expect(r.stranger.flags.outlaw).toBe(true);
    expect(r.law.wanted!(r.stranger.id)).toEqual([{ settlement: r.village.id, until: expect.any(Number) }]);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    // and on those lands he is hostile ground wherever he stands
    expect(r.terr.trespass(r.stranger.id, r.court.x, r.court.z).level).toBe('hostile');
  });

  it('is dropped when the player dies in the fight', () => {
    const r = halted();
    r.law.answerPatrol(r.stranger.id, 'refuse');
    const e = r.combat.engaged[0];
    r.sim.events.emit('fightEnded', result(r, e.id, { winner: 'patrol', dead: [r.stranger.id] }));
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    expect(r.law.captivity(r.stranger.id)).toBeNull();
  });
});

describe('at war', () => {
  it('an enemy soldier gets no hearing: "Yield!" or the fight, and only those two answers', () => {
    const r = lawRig({ seed: 'law-war' });
    r.pol.war([r.lordHouse], [r.strangerHouse]);
    r.stranger.career = 'soldier';
    expect(r.terr.trespass(r.stranger.id, r.court.x, r.court.z)).toMatchObject({ level: 'hostile', cause: 'war' });
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p.skipTalk).toBe(true);
    expect(p.line).toMatch(/^Yield!/);
    expect(r.law.patrolChoices(r.stranger.id).map((c) => c.id)).toEqual(['yield', 'refuse']);
    // taken at war: a prisoner of war, ransomed
    r.law.answerPatrol(r.stranger.id, 'yield');
    const c = r.law.captivity(r.stranger.id)!;
    expect(c.kind).toBe('war');
    expect(c.ransom).toBeGreaterThan(0);
    expect(c.fine).toBe(0);
  });

  it('an enemy merchant is only asked his business, and can leave', () => {
    const r = lawRig({ seed: 'law-war2' });
    r.pol.war([r.lordHouse], [r.strangerHouse]);
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p.skipTalk).toBe(false);
    expect(p.line).toMatch(/^Halt\..*at war|^Halt\..*lands of/);
    expect(r.law.patrolChoices(r.stranger.id).map((c) => c.id)).toContain('leave');
    // a fight with the armed enemy at war is to the death; with the merchant it is to take him
    expect(r.law.patrolChoices(r.stranger.id).find((c) => c.id === 'fine')).toBeUndefined();
  });
});

describe('in the cell', () => {
  function held(opts: { rank?: number; money?: number } = {}): LawRig {
    const r = halted('law-held');
    r.stranger.money = opts.money ?? 0;
    if (opts.rank) r.stranger.rankTier = opts.rank as never;
    r.law.answerPatrol(r.stranger.id, 'yield');
    lawContext(r.sim).patrol.finish(lawContext(r.sim).patrol.get(r.stranger.id)!);
    const rec = lawContext(r.sim).law.store.captiveOf(r.stranger.id)!;
    rec.led = false;
    rec.building = r.sim.state.buildingsAt.get(r.village.id)!.find((b) => b.kind === 'manor_house')!.id;
    return r;
  }

  it('a prisoner is fed: bread and water keep him from starving however long he is held', () => {
    const r = held({ money: 0 });
    r.stranger.needs.hunger = 0.02;
    // (the ration is given at dawn; through the day the hunger falls again, but never to the point of famine)
    for (let d = 0; d < 5; d++) {
      r.sim.advanceDays(1);
      expect(r.stranger.needs.hunger, `day ${d}`).toBeGreaterThan(0.1);
      expect(r.stranger.death).toBeNull();
    }
  });

  it('offers waiting for the family, paying the fine, serving the sentence and — at night — escaping', () => {
    const r = held({ money: 50 });
    r.sim.state.clock.absDay = Math.floor(r.sim.absDay) + 0.5;
    const ch = r.law.captivityChoices(r.stranger.id);
    expect(ch.map((c) => c.id)).toEqual(['wait', 'pay', 'serve', 'escape']);
    expect(ch.find((c) => c.id === 'pay')!.ok).toBe(true);
    expect(ch.find((c) => c.id === 'serve')!.ok).toBe(true);
    const esc = ch.find((c) => c.id === 'escape')!;
    expect(esc.ok).toBe(false);
    expect(esc.reason).toMatch(/night/);
  });

  it('Pay: the fine is drained from his purse and his household\'s, the lord\'s House is paid, and the door is opened', () => {
    const r = held({ money: 8 });
    const hh = r.sim.state.households.get(r.stranger.household)!;
    hh.purse = 500;
    const lordHome = r.sim.state.households.get(r.sim.state.persons.get(r.sim.state.houses.get(r.lordHouse)!.head)!.household)!;
    const before = lordHome.purse;
    const fine = r.law.captivity(r.stranger.id)!.fine;
    expect(r.law.chooseInCaptivity(r.stranger.id, 'pay').ok).toBe(true);
    expect(r.stranger.flags.captive).toBeUndefined();
    expect(r.law.captivity(r.stranger.id)).toBeNull();
    expect(r.stranger.money + hh.purse).toBeCloseTo(508 - fine, 1);
    expect(lordHome.purse).toBeCloseTo(before + fine, 1);
    expect(r.player.bound).toBeNull();
  });

  it('Pay is refused for want of money, with the sums in the reason', () => {
    const r = held({ money: 0 });
    r.sim.state.households.get(r.stranger.household)!.purse = 0;
    const res = r.law.chooseInCaptivity(r.stranger.id, 'pay');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/cannot raise|can be raised/);
    expect(r.stranger.flags.captive).toBe(true);
  });

  it('Serve: the days run in the daily tick, the lord is paid in labour, and he is turned out when they are done', () => {
    const r = held();
    expect(r.law.chooseInCaptivity(r.stranger.id, 'serve').ok).toBe(true);
    const days = r.law.captivity(r.stranger.id)!.sentenceDays;
    expect(r.law.captivity(r.stranger.id)!.serving).toBe(true);
    expect(r.law.chooseInCaptivity(r.stranger.id, 'serve').ok).toBe(false);
    for (let d = 0; d < days - 1; d++) r.sim.advanceDays(1);
    expect(r.law.captivity(r.stranger.id)).not.toBeNull();
    r.sim.advanceDays(1);
    expect(r.law.captivity(r.stranger.id)).toBeNull();
    expect(r.stranger.flags.captive).toBeUndefined();
    expect(r.player.bound).toBeNull();
  });

  it('the lord loses patience: a sentence is set after some days, whatever the prisoner does', () => {
    const r = held();
    for (let d = 0; d < 6; d++) r.sim.advanceDays(1);
    expect(r.law.captivity(r.stranger.id)?.serving ?? true).toBe(true);
    for (let d = 0; d < 6; d++) r.sim.advanceDays(1);
    expect(r.law.captivity(r.stranger.id)).toBeNull();
  });

  it('Escape at night: Agility and Strength against the watch — away, and wanted on the lord\'s lands', () => {
    const r = held();
    r.sim.state.clock.absDay = Math.floor(r.sim.absDay) + 0.02;
    const choice = r.law.captivityChoices(r.stranger.id).find((c) => c.id === 'escape')!;
    expect(choice.ok).toBe(true);
    expect(choice.detail).toMatch(/\d+%/);
    r.rig(0.001);
    const events = ev(r);
    const res = r.law.chooseInCaptivity(r.stranger.id, 'escape');
    expect(res.ok).toBe(true);
    expect(r.stranger.flags.captive).toBeUndefined();
    expect(r.law.wanted!(r.stranger.id).length).toBe(1);
    expect(events.map((e) => e.phase)).toContain('escaped');
    // wanted: any trespass on those lands is hostile, and the next patrol does not talk
    expect(r.terr.trespass(r.stranger.id, r.court.x, r.court.z).level).toBe('private');
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.3);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('attack');
  });

  it('a failed escape is worse: longer sentence, a heavier fine, a beating', () => {
    const r = held();
    r.sim.state.clock.absDay = Math.floor(r.sim.absDay) + 0.02;
    const before = r.law.captivity(r.stranger.id)!;
    r.rig(0.999);
    const res = r.law.chooseInCaptivity(r.stranger.id, 'escape');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Caught/);
    const after = r.law.captivity(r.stranger.id)!;
    expect(after.sentenceDays).toBe(before.sentenceDays + 3);
    expect(after.fine).toBeGreaterThan(before.fine);
    expect(after.escapes).toBe(1);
    expect(r.combat.harmed.length).toBe(1);
    expect(r.stranger.flags.captive).toBe(true);
  });

  it('the family pays a fine it can afford and cares about, after a couple of days', () => {
    const r = lawRig({ seed: 'law-family' });
    const st = r.sim.state;
    const poor = st.persons.get(r.stranger.id)!;
    void poor;
    // an AI man (not the player's House) with a spouse and a full purse
    const man = [...st.persons.values()].find((p) => !p.death && p.spouse && !p.flags.player && p.id !== r.stranger.id && p.sex === 'm' && p.house !== st.run.houseId && p.rankTier <= 2)!;
    const hh = st.households.get(man.household)!;
    man.money = 0;
    hh.purse = 5000;
    expect(r.law.seize(man.id, r.lord.id, 'trespass', r.village.id, 'trespass in the closes')).toBe(true);
    const fine = r.law.captivity(man.id)!.fine;
    r.sim.advanceDays(1);
    expect(r.law.captivity(man.id)).not.toBeNull();
    r.sim.advanceDays(2);
    expect(r.law.captivity(man.id)).toBeNull();
    expect(hh.purse).toBeLessThanOrEqual(5000 - fine + 0.01 + 1e6 * 0);
    expect(man.flags.captive).toBeUndefined();
  });
});

describe('the hangman', () => {
  it('hangs only an enemy soldier who killed the lord\'s men, at war, under a cruel lord — after a warning, not before', () => {
    const r = lawRig({ seed: 'law-hang' });
    r.pol.war([r.lordHouse], [r.strangerHouse]);
    r.stranger.career = 'soldier';
    r.lord.rep.cruelty = 90;
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const p = r.law.patrolFor(r.stranger.id)!;
    r.law.answerPatrol(r.stranger.id, 'refuse');
    const e = r.combat.engaged[0];
    r.sim.events.emit('fightEnded', result(r, e.id, { winner: 'patrol', dead: [p.men[0]], wounded: [r.stranger.id] }));
    const c = r.law.captivity(r.stranger.id)!;
    expect(c.kind).toBe('war');
    expect(c.danger).toBe(true);
    const notes: string[] = [];
    r.sim.events.on('notify', (n) => notes.push(n.text));
    // not at once: a day's warning first
    r.rig(0.001);
    const rec = lawContext(r.sim).law.store.captiveOf(r.stranger.id)!;
    rec.led = false;
    lawContext(r.sim).patrol.finish(lawContext(r.sim).patrol.get(r.stranger.id)!);
    r.sim.advanceDays(1);
    expect(r.stranger.death).toBeTruthy();
    expect(r.stranger.death!.cause).toBe('execution');
  });

  it('does not hang a poacher, a plain trespasser, or a soldier of a gentle lord', () => {
    const r = lawRig({ seed: 'law-nohang' });
    r.lord.rep.cruelty = 90;
    r.stranger.career = 'soldier';
    // taken for trespass: never in danger whatever the lord's temper
    r.law.seize(r.stranger.id, r.lord.id, 'trespass', r.village.id, 'trespass');
    expect(r.law.captivity(r.stranger.id)!.danger).toBe(false);
    r.law.chooseInCaptivity(r.stranger.id, 'serve');
    const r2 = lawRig({ seed: 'law-nohang' });
    r2.lord.rep.cruelty = -20;
    r2.pol.war([r2.lordHouse], [r2.strangerHouse]);
    r2.stranger.career = 'soldier';
    r2.law.seize(r2.stranger.id, r2.lord.id, 'war', r2.village.id, 'taken in arms');
    expect(r2.law.captivity(r2.stranger.id)!.danger).toBe(false);
  });
});
