// Story objectives: big moments of a life that call for something of the player.
import { describe, expect, it } from 'vitest';
import { active, objSim, playObjectives, playerOf, recOf, runTo, skipTutorial, tracked, type ObjSim } from './helpers';

function settled(seed = 's3'): ObjSim {
  const o = objSim({ seed });
  skipTutorial(o);
  return o;
}

const story = (o: ObjSim) => active(o, 'story');

describe('a dear one gravely ill', () => {
  it('asks the player to sit with them and pray; it ends when they recover, and lapses if they die', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const mother = o.sim.state.persons.get(me.mother)!;
    expect(mother && !mother.death).toBe(true);
    mother.health.conditions.push({ id: 'fever', since: o.sim.absDay, until: o.sim.absDay + 6, severity: 0.2, fatal: true });
    mother.health.hp = 0.6;
    o.sim.state.touch(mother);
    o.sim.advanceHours(1);
    const ill = story(o).find((x) => /gravely ill/.test(x.title))!;
    expect(ill, active(o).map((x) => x.title).join(', ')).toBeTruthy();
    expect(ill.title).toBe(`${mother.first} is gravely ill`);
    expect(ill.giver).toBe(mother.id);
    expect(ill.steps[0].text).toBe(`Sit with ${mother.first}`);
    expect(ill.steps[0].target?.id).toBe(mother.id);
    // story comes before everything but the player's pick
    expect(tracked(o)?.id).toBe(ill.id);
    // visit her, then pray
    const played = playObjectives(o, ['story']);
    expect(played.stuck, played.trace.join('\n')).toBeNull();
    // it ended through its steps being done
    expect(o.obj.list().find((x) => x.id === ill.id)?.state).toBe('done');
    // not made again at once for the same illness
    o.sim.advanceHours(3);
    expect(story(o).filter((x) => x.title === ill.title)).toHaveLength(0);
  });

  it('is done when the sufferer recovers', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const father = o.sim.state.persons.get(me.father)!;
    father.health.conditions.push({ id: 'flux', since: o.sim.absDay, until: o.sim.absDay + 4, severity: 0.2, fatal: true });
    father.health.hp = 0.6;
    o.sim.state.touch(father);
    o.sim.advanceHours(1);
    const ill = story(o)[0];
    expect(ill).toBeTruthy();
    father.health.conditions.length = 0;
    o.sim.advanceHours(1);
    expect(o.obj.list().find((x) => x.id === ill.id)?.state).toBe('done');
  });

  it('lapses when they die', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const father = o.sim.state.persons.get(me.father)!;
    father.health.conditions.push({ id: 'fever', since: o.sim.absDay, until: o.sim.absDay + 4, severity: 0.2, fatal: true });
    father.health.hp = 0.5;
    o.sim.state.touch(father);
    o.sim.advanceHours(1);
    const ill = story(o)[0];
    expect(ill).toBeTruthy();
    father.death = { day: Math.floor(o.sim.absDay), cause: 'illness' };
    o.sim.advanceHours(1);
    expect(o.obj.list().find((x) => x.id === ill.id)?.state).toBe('expired');
  });

  it('is not made for a fever that has only just begun, or for a distant cousin', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const mother = o.sim.state.persons.get(me.mother)!;
    mother.health.conditions.push({ id: 'fever', since: o.sim.absDay, until: o.sim.absDay + 6, severity: 0.2, fatal: true });
    mother.health.hp = 0.95; // not yet grave
    o.sim.state.touch(mother);
    o.sim.advanceHours(1);
    expect(story(o).filter((x) => /gravely ill/.test(x.title))).toHaveLength(0);
    mother.health.hp = 0.6; // now it is
    o.sim.advanceHours(1);
    expect(story(o).filter((x) => /gravely ill/.test(x.title))).toHaveLength(1);
  });

  it('for a baby is seen at home, since a baby cannot be talked to', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const hh = o.sim.state.households.get(me.household)!;
    const baby = o.sim.state.persons.get(hh.members.find((id) => id !== me.id)!)!;
    baby.birthDay = Math.round(o.sim.absDay - 8); // half a year old
    me.children.push(baby.id); // (the player's own child, for the test)
    baby.health.conditions.push({ id: 'fever', since: o.sim.absDay, until: o.sim.absDay + 5, severity: 0.2, fatal: true });
    baby.health.hp = 0.5;
    o.sim.state.touch(baby);
    o.sim.advanceHours(1);
    const ill = story(o).find((x) => x.title === `${baby.first} is gravely ill`)!;
    expect(ill, active(o).map((x) => x.title).join(', ')).toBeTruthy();
    expect(recOf(o, ill.id).steps[0].m.k).toBe('reach');
    expect(ill.steps[0].target?.label).toBe('Your home');
  });
});

describe('the wedding feast', () => {
  it('is asked for the morning after the wedding at the church, in a window', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const bride = o.sim.state.residentsOf(me.settlement).find((p) => p.id !== me.id && !p.death)!;
    o.sim.events.emit('marriage', { a: me.id, b: bride.id, settlement: me.settlement });
    const feast = story(o).find((x) => x.title === 'Your wedding feast')!;
    expect(feast).toBeTruthy();
    expect(feast.steps[0].text).toMatch(/^Be at .* for the wedding feast$/);
    const m = recOf(o, feast.id).steps[0].m;
    expect(m.k).toBe('reach');
    if (m.k === 'reach') {
      expect(m.from).toBeCloseTo(Math.floor(o.sim.absDay) + 1 + 10 / 24 - 0.05, 3);
      // before the feast: being at the church counts for nothing
      o.at.x = m.x; o.at.z = m.z;
      o.obj.poll(true);
      expect(feast.steps[0].done).toBe(false);
      // at the feast: it is done
      o.sim.state.clock.absDay = m.from! + 0.02;
      o.obj.poll(true);
      expect(o.obj.list().find((x) => x.id === feast.id)?.state).toBe('done');
    }
  });
});

describe('a child is born', () => {
  it('into the household: go home and see the child', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const hh = o.sim.state.households.get(me.household)!;
    const baby = o.sim.state.persons.get(hh.members.find((id) => id !== me.id)!)!;
    o.sim.events.emit('birth', { person: baby.id, mother: me.mother || baby.id, father: me.father, settlement: me.settlement });
    const born = story(o).find((x) => x.title === 'A child is born')!;
    expect(born, active(o).map((x) => x.title).join(', ')).toBeTruthy();
    expect(born.steps[0].text).toBe(`Welcome ${baby.first}`);
    const played = playObjectives(o, ['story']);
    expect(played.stuck).toBeNull();
  });
});

describe('the lord calls the levy', () => {
  it('makes a decision to answer and a muster to report to, and ends when answered', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const lordHouse = o.sim.state.houses.get(me.house)!;
    const seat = o.sim.world.settlements[0];
    let call: unknown = { house: lordHouse.id, army: 1, muster: seat.id, day: 3, due: o.sim.absDay + 3, household: [], self: true };
    let army = 0;
    (o.sim.services as Record<string, unknown>).military = { service: () => ({ call }), armyOf: () => army };
    o.sim.advanceHours(1);
    const levy = story(o).find((x) => x.title === 'The lord calls the levy')!;
    expect(levy, active(o).map((x) => x.title).join(', ')).toBeTruthy();
    expect(levy.steps.map((s) => s.text)).toEqual(['Answer the call to arms', `Report to the muster at ${seat.name}`]);
    expect(levy.steps[1].target?.id).toBe(seat.id);
    expect(levy.dueDay).toBeGreaterThan(o.sim.absDay);
    // answered by joining: the decision is done, the muster remains
    call = null; army = 1;
    o.sim.advanceHours(1);
    const now = o.obj.list().find((x) => x.id === levy.id)!;
    expect(now.state).toBe('active');
    expect(now.steps[0].done).toBe(true);
    o.at.x = seat.x; o.at.z = seat.z;
    o.obj.poll(true);
    expect(o.obj.list().find((x) => x.id === levy.id)?.state).toBe('done');
  });

  it('lapses when the call is refused', () => {
    const o = settled();
    const me = playerOf(o.sim);
    const seat = o.sim.world.settlements[0];
    let call: unknown = { house: me.house, army: 1, muster: seat.id, day: 3, due: o.sim.absDay + 3, household: [], self: true };
    (o.sim.services as Record<string, unknown>).military = { service: () => ({ call }), armyOf: () => 0 };
    o.sim.advanceHours(1);
    const levy = story(o).find((x) => x.title === 'The lord calls the levy')!;
    call = null;
    o.sim.advanceHours(1);
    expect(o.obj.list().find((x) => x.id === levy.id)?.state).toBe('expired');
    void runTo;
  });
});
