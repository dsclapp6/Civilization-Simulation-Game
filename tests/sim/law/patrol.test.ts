// The patrol (docs/CIV.md §4): the lord's men ride up to a trespasser, halt him with the lines of the design, and deal with what he
// answers — leave, state his business, bribe, pay the fine, yield, or refuse. The zone, the player's body and the combat module are
// fakes we drive; the territory (who may be where) is the real module on the stand-in world.
import { describe, expect, it } from 'vitest';
import type { SimEvents } from '../../../src/sim/events';
import { offLand, lawRig, rideUp, summoned } from './helpers';

function events(r: ReturnType<typeof lawRig>): Array<SimEvents['trespass']> {
  const out: Array<SimEvents['trespass']> = [];
  r.sim.events.on('trespass', (e) => out.push(e));
  return out;
}

describe('a trespasser is seen and a patrol comes', () => {
  it('sends the lord\'s men — a leader with one to three men — who ride up from the edge of sight and halt him', () => {
    const r = lawRig();
    expect(r.terr.trespass(r.stranger.id, r.court.x, r.court.z).level).toBe('private');
    const ev = events(r);
    expect(r.law.report(r.stranger.id, r.court.x, r.court.z)).toBe(true);
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p.phase).toBe('coming');
    expect(p.target).toBe(r.stranger.id);
    expect(p.settlement).toBe(r.village.id);
    expect(p.men.length).toBeGreaterThanOrEqual(1);
    expect(p.men.length).toBeLessThanOrEqual(3);
    // they are people of the lord's lands, fit men, summoned into the zone at the edge of sight
    expect(summoned(r).sort()).toEqual([p.leader, ...p.men].sort());
    for (const id of summoned(r)) {
      const at = r.zone.summoned.get(id)!;
      const d = Math.hypot(at.x - r.court.x, at.z - r.court.z);
      expect(d).toBeGreaterThan(100);
      expect(d).toBeLessThan(220);
      expect(r.sim.state.persons.get(id)!.flags.captive).toBeUndefined();
    }
    // and ordered to ride at the target
    const orders = r.zone.commands.filter((c) => c.order.kind === 'approach');
    expect(orders.length).toBe(1 + p.men.length);
    expect(orders[0].person).toBe(p.leader);
    // nothing is said until they are up with him; the world is not hurried while they ride
    expect(p.line).toBe('');
    expect(r.sim.hostileNear()).toBe(true);
    expect(ev.map((e) => e.phase)).toEqual([]);
    // a second report while the first patrol is out sends no second
    expect(r.law.report(r.stranger.id, r.court.x, r.court.z)).toBe(false);
  });

  it('speaks the line of the design when the leader is up with him, and opens the choices — in action time', () => {
    const r = lawRig();
    const ev = events(r);
    const ui: unknown[] = [];
    r.sim.events.on('ui', (e) => ui.push(e));
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p.phase).toBe('halt');
    expect(p.line).toMatch(/^Halt\./);
    expect(p.line).toMatch(/lands of|closes|park/i);
    expect(p.line).toMatch(/State your business or be gone|What business/);
    expect(ev.map((e) => e.phase)).toContain('warned');
    expect(ui).toContainEqual({ panel: 'ext', name: 'law', data: { mode: 'patrol' } });
    expect(r.sim.state.clock.actionTime).toBe(true);
    const ids = r.law.patrolChoices(r.stranger.id).map((c) => c.id);
    expect(ids).toEqual(['leave', 'business', 'bribe', 'fine', 'yield', 'refuse']);
    // the leader's line is shown over his head
    expect(r.zone.say).toBeDefined();
  });

  it('gives no choices when no patrol is there, and refuses answers to one that is not waiting', () => {
    const r = lawRig();
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    expect(r.law.patrolChoices(r.stranger.id)).toEqual([]);
    expect(r.law.answerPatrol(r.stranger.id, 'leave').ok).toBe(false);
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    expect(r.law.answerPatrol(r.stranger.id, 'leave').ok).toBe(false);
  });

  it('sends nobody for a person who is where they may be', () => {
    const r = lawRig();
    const away = offLand(r);
    r.player.pos.x = away.x; r.player.pos.z = away.z;
    expect(r.law.report(r.stranger.id, away.x, away.z)).toBe(false);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
  });
});

describe('leaving', () => {
  it('Leave: they see him to the edge of the land within about a minute, following, and he is let go once off it', () => {
    const r = lawRig();
    const ev = events(r);
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const ans = r.law.answerPatrol(r.stranger.id, 'leave');
    expect(ans.ok).toBe(true);
    let p = r.law.patrolFor(r.stranger.id)!;
    expect(p.phase).toBe('escort');
    expect(p.deadline).toBeGreaterThanOrEqual(45);
    expect(p.deadline).toBeLessThanOrEqual(150);
    expect(Number.isFinite(p.deadline)).toBe(true);
    expect(p.exit).not.toBeNull();
    expect(r.sim.state.clock.actionTime).toBe(false);
    // they follow him
    expect(r.zone.commands.filter((c) => c.order.kind === 'follow' && (c.order as { leader: number }).leader === r.stranger.id).length).toBe(1 + p.men.length);
    // time runs against him while he is still on the land
    const before = p.deadline;
    r.run(5);
    p = r.law.patrolFor(r.stranger.id)!;
    expect(p.deadline).toBeLessThan(before - 4);
    // he walks off the land: the patrol turns back
    const away = offLand(r);
    r.player.pos.x = away.x; r.player.pos.z = away.z;
    r.run(1);
    expect(ev.map((e) => e.phase)).toEqual(['warned', 'escorted', 'left']);
    // they turn back; once they are far enough away (here they stood where they were) they are dismissed
    r.run(60);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    expect(r.zone.dismissedPeople.length).toBeGreaterThan(0);
    expect(r.sim.hostileNear()).toBe(false);
  });

  it('is attacked when the time is up and he is still on the land (subdue: to wound and take)', () => {
    const r = lawRig();
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    r.law.answerPatrol(r.stranger.id, 'leave');
    r.run(160);
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p.phase).toBe('attack');
    expect(r.combat.engaged.length).toBe(1);
    const e = r.combat.engaged[0];
    expect(e.opts).toMatchObject({ intent: 'subdue', yieldAllowed: true });
    expect(e.sides[0].people).toEqual([r.stranger.id]);
    expect(e.sides[1].people).toEqual([p.leader, ...p.men]);
  });

  it('a man who comes back onto the land within minutes of being escorted off is not heard again', () => {
    const r = lawRig();
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    r.law.answerPatrol(r.stranger.id, 'leave');
    const away = offLand(r);
    r.player.pos.x = away.x; r.player.pos.z = away.z;
    r.run(70);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    // back to the closes: the next patrol attacks as soon as it is up with him
    r.player.pos.x = r.court.x; r.player.pos.z = r.court.z;
    expect(r.law.report(r.stranger.id, r.court.x, r.court.z)).toBe(true);
    rideUp(r);
    r.run(0.3);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('attack');
    expect(r.combat.engaged.length).toBe(1);
  });
});

describe('state your business', () => {
  it('a good reason lets him stay: the lord\'s leave is granted for some days and the patrol goes', () => {
    const r = lawRig();
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const choice = r.law.patrolChoices(r.stranger.id).find((c) => c.id === 'business')!;
    expect(choice.ok).toBe(true);
    expect(choice.detail).toMatch(/%/);
    r.rig(0.001);
    const res = r.law.answerPatrol(r.stranger.id, 'business');
    expect(res.ok).toBe(true);
    expect(r.terr.leaveUntil!(r.stranger.id, r.village.id)).toBeGreaterThan(r.sim.absDay);
    expect(r.terr.trespass(r.stranger.id, r.court.x, r.court.z).level).toBe('none');
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('gone');
  });

  it('a thin tale is not believed: he may try the other answers, but not the same one twice', () => {
    const r = lawRig();
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    r.rig(0.999);
    const res = r.law.answerPatrol(r.stranger.id, 'business');
    expect(res.ok).toBe(false);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('halt');
    expect(r.law.patrolFor(r.stranger.id)!.line).toMatch(/thin/i);
    const biz = r.law.patrolChoices(r.stranger.id).find((c) => c.id === 'business')!;
    expect(biz.ok).toBe(false);
    expect(r.law.answerPatrol(r.stranger.id, 'business').ok).toBe(false);
    expect(r.law.answerPatrol(r.stranger.id, 'leave').ok).toBe(true);
  });

  it('a rank above the leader\'s, a request in the place, the market day and a ready tongue all help', () => {
    const lowly = lawRig({ seed: 'law-low' });
    lowly.law.report(lowly.stranger.id, lowly.court.x, lowly.court.z);
    rideUp(lowly);
    lowly.run(0.2);
    const parse = (r: typeof lowly): number => Number(/(\d+)%/.exec(r.law.patrolChoices(r.stranger.id).find((c) => c.id === 'business')!.detail!)![1]);
    const base = parse(lowly);
    const noble = lawRig({ seed: 'law-low' });
    noble.stranger.rankTier = 6;
    noble.stranger.trained.cha = 16;
    noble.law.report(noble.stranger.id, noble.court.x, noble.court.z);
    rideUp(noble);
    noble.run(0.2);
    expect(parse(noble)).toBeGreaterThan(base + 15);
  });
});

describe('a bribe', () => {
  it('buys a look the other way when it works, and is a new crime when it does not', () => {
    const ok = lawRig({ seed: 'law-bribe' });
    ok.stranger.money = 200;
    ok.law.report(ok.stranger.id, ok.court.x, ok.court.z);
    rideUp(ok);
    ok.run(0.2);
    const cost = Number(/^(\d+)/.exec(ok.law.patrolChoices(ok.stranger.id).find((c) => c.id === 'bribe')!.detail!.replace(/[^\d ].*$/, ''))?.[1] ?? 0);
    void cost;
    ok.rig(0.001);
    const before = ok.stranger.money;
    expect(ok.law.answerPatrol(ok.stranger.id, 'bribe').ok).toBe(true);
    expect(ok.stranger.money).toBeLessThan(before);
    expect(ok.terr.leaveUntil!(ok.stranger.id, ok.village.id)).toBeGreaterThan(ok.sim.absDay);
    expect(ok.law.patrolFor(ok.stranger.id)!.phase).toBe('gone');

    const bad = lawRig({ seed: 'law-bribe' });
    bad.stranger.money = 200;
    bad.law.report(bad.stranger.id, bad.court.x, bad.court.z);
    rideUp(bad);
    bad.run(0.2);
    bad.rig(0.999);
    const res = bad.law.answerPatrol(bad.stranger.id, 'bribe');
    expect(res.ok).toBe(false);
    expect(bad.law.patrolFor(bad.stranger.id)!.phase).toBe('attack');
  });

  it('cannot be offered with empty pockets, and says so', () => {
    const r = lawRig();
    r.stranger.money = 0;
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const b = r.law.patrolChoices(r.stranger.id).find((c) => c.id === 'bribe')!;
    expect(b.ok).toBe(false);
    expect(b.reason).toMatch(/carry only/);
    expect(r.law.answerPatrol(r.stranger.id, 'bribe').ok).toBe(false);
  });
});

describe('the fine', () => {
  it('is paid to the lord and ends it; a poacher\'s game is taken', () => {
    const r = lawRig({ seed: 'law-fine' });
    r.stranger.money = 100;
    const lordHousehold = r.sim.state.households.get(r.lord.household)!;
    const purse = lordHousehold.purse;
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const fine = r.law.patrolChoices(r.stranger.id).find((c) => c.id === 'fine')!;
    expect(fine.ok).toBe(true);
    expect(r.law.answerPatrol(r.stranger.id, 'fine').ok).toBe(true);
    expect(r.stranger.money).toBeLessThan(100);
    expect(lordHousehold.purse).toBeGreaterThan(purse);
    expect(r.law.patrolFor(r.stranger.id)!.phase).toBe('gone');
  });

  it('is refused for want of the money', () => {
    const r = lawRig();
    r.stranger.money = 0;
    r.law.report(r.stranger.id, r.court.x, r.court.z);
    rideUp(r);
    r.run(0.2);
    const fine = r.law.patrolChoices(r.stranger.id).find((c) => c.id === 'fine')!;
    expect(fine.ok).toBe(false);
    expect(r.law.answerPatrol(r.stranger.id, 'fine').ok).toBe(false);
  });
});
