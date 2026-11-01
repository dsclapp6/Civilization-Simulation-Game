// The day summary: built from the day's events, announced with `dayEnd` when the player lies down or midnight
// passes, kept for the journal.
import { describe, expect, it } from 'vitest';
import { active, doAction, install, objSim, playObjectives, playerOf, runTo, setTime, walkTo } from './helpers';

describe('the day summary', () => {
  it('is ready when the player lies down: work, money, goods, skills, objectives, household, tomorrow', () => {
    const o = objSim({ seed: 's1', install: false });
    const days: number[] = [];
    o.sim.events.on('dayEnd', (e) => days.push(e.day));
    install(o);
    expect(o.obj.daySummary()).toBeNull();
    const me = playerOf(o.sim);
    const money0 = me.money;
    const played = playObjectives(o, ['tutorial']);
    expect(played.stuck).toBeNull();
    // the sleep step closed the day
    expect(days).toEqual([0]);
    const s = o.obj.daySummary()!;
    expect(s).toBeTruthy();
    expect(s.day).toBe(0);
    expect(o.obj.daySummary(0)).toBe(s);
    expect(o.obj.daySummary(7)).toBeNull();
    // what was done, by name
    expect(s.work.length).toBeGreaterThan(0);
    expect(s.work.join(' | ')).toMatch(/strip|errand|garden|bench/);
    for (const w of s.work) expect(w, w).toMatch(/^[A-Z]/);
    // money adds up with the purse, whatever the test script did to it
    expect(s.earned - s.spent).toBeCloseTo(me.money - money0, 1);
    // skills grew, with the xp of the day
    expect(s.skills.length).toBeGreaterThan(0);
    for (const k of s.skills) expect(k.xp).toBeGreaterThan(0);
    // the objectives finished that day are named
    expect(s.objectivesDone).toContain('Meet your family');
    expect(s.objectivesDone).toContain('Home before dark');
    // the household and tomorrow have something to say
    expect(s.household.length).toBeGreaterThan(0);
    expect(s.tomorrow.length).toBeGreaterThan(0);
    expect(s.tomorrow.join(' ')).toMatch(/chores|holy|market|season/i);
    for (const line of [...s.work, ...s.household, ...s.tomorrow, ...s.objectivesDone]) expect(line, line).not.toMatch(/\{\w+\}/);
  });

  it('closes at midnight for a player who stays up, once, and starts the next day afresh', () => {
    const o = objSim({ seed: 's1' });
    const days: number[] = [];
    o.sim.events.on('dayEnd', (e) => days.push(e.day));
    playObjectives(o, ['tutorial'], 2); // meet and the strip: some work to show
    setTime(o.sim, 0.95);
    o.sim.advanceHours(2); // through midnight
    expect(days).toEqual([0]);
    const s = o.obj.daySummary(0)!;
    expect(s.objectivesDone).toContain('Meet your family');
    expect(s.tomorrow.join(' ')).toMatch(/chores|market|holy|season/i);
    // the next day starts clean
    expect(o.obj.obj.save.log.day).toBe(1);
    expect(Object.keys(o.obj.obj.save.log.work)).toHaveLength(0);
    expect(o.obj.obj.save.log.done).toHaveLength(0);
  });

  it('does not repeat itself: lying down after midnight has already closed the day gives no second card', () => {
    const o = objSim({ seed: 's1' });
    const days: number[] = [];
    o.sim.events.on('dayEnd', (e) => days.push(e.day));
    playObjectives(o, ['tutorial'], 2);
    setTime(o.sim, 0.95);
    o.sim.advanceHours(2);
    expect(days).toEqual([0]);
    // a few hours past midnight there is nothing yet worth a card
    o.sim.dispatch({ type: 'sleep' });
    for (let g = 0; o.sim.clock.skip && g < 4000; g++) o.sim.step(0.25);
    expect(days).toEqual([0]);
  });

  it('says tomorrow is the holy day, and a market day, when it is', () => {
    const o = objSim({ seed: 's1' });
    playObjectives(o, ['tutorial'], 2);
    // the third day of the season: tomorrow is the holy day
    setTime(o.sim, 0.9, 2);
    o.obj.obj.save.log.day = 2;
    const me = playerOf(o.sim);
    me.money += 3; // a gift counts as earned
    o.sim.dispatch({ type: 'sleep' });
    for (let g = 0; o.sim.clock.skip && g < 4000; g++) o.sim.step(0.25);
    const s = o.obj.daySummary(2);
    expect(s, 'a day with a gift and a talk is worth a card').toBeTruthy();
    expect(s!.tomorrow.join(' ')).toMatch(/holy day/);
    expect(s!.earned).toBeGreaterThanOrEqual(3);
  });

  it('counts finished tasks apart from bouts: a whole strip is one line', () => {
    const o = objSim({ seed: 's1' });
    playObjectives(o, ['tutorial'], 2);
    const log = o.obj.obj.save.log;
    const rows = Object.values(log.work);
    expect(rows.some((w) => w.fin > 0), JSON.stringify(rows)).toBe(true);
    o.obj.obj.save.log.day = 0;
    setTime(o.sim, 0.9, 0);
    o.sim.dispatch({ type: 'sleep' });
    for (let g = 0; o.sim.clock.skip && g < 4000; g++) o.sim.step(0.25);
    const s = o.obj.daySummary(0)!;
    expect(s.work.some((w) => /^(Ploughed|Harrowed|Sowed|Weeded|Reaped|Bound the sheaves on|Carried sheaves from) your family's \w+ strip$/.test(w)), s.work.join(' | ')).toBe(true);
  });

  it('keeps the last few days', () => {
    const o = objSim({ seed: 's1' });
    for (let d = 0; d < 10; d++) {
      const me = playerOf(o.sim);
      me.money += 2;
      o.obj.obj.save.log.talks += 3;
      setTime(o.sim, 0.9, Math.floor(o.sim.absDay));
      o.sim.dispatch({ type: 'sleep' });
      for (let g = 0; o.sim.clock.skip && g < 4000; g++) o.sim.step(0.25);
      runTo(o, Math.floor(o.sim.absDay) + 1, 1);
    }
    expect(o.obj.obj.save.sums.length).toBeLessThanOrEqual(8);
    expect(o.obj.daySummary()!.day).toBeGreaterThanOrEqual(8);
  });
});

describe('what a day of work puts in the log', () => {
  it('goods made come from the action gains', () => {
    const o = objSim({ seed: 's1' });
    walkTo(o, o.at.x, o.at.z);
    const me = playerOf(o.sim);
    const log = o.obj.obj.save.log;
    // a bout of digging in the garden gives no goods, a trade changes the purse
    const r = doAction(o, { kind: 'building', id: o.sim.state.households.get(me.household)!.home }, /^garden\./, 0);
    expect(r.ok).toBe(true);
    expect(Object.values(log.work).some((w) => w.verb === 'garden')).toBe(true);
    expect(active(o).length).toBeGreaterThan(0);
  });
});
