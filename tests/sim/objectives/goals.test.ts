// Goals: choosing a path at fourteen, the archers' test (stats, skill, a bow, the recruiter), an apprenticeship,
// saving for a better tool, courting. Progress is simply what the player has become.
import { describe, expect, it } from 'vitest';
import { adopt, makeApprentice } from '../economy/helpers';
import { active, doAction, goHome, install, objSim, playerOf, recOf, skipTutorial, talkTo, type ObjSim } from './helpers';

function ageTo(o: ObjSim, years: number): void {
  const me = playerOf(o.sim);
  me.birthDay = Math.round(o.sim.absDay - years * 16);
  o.sim.state.touch(me);
}

const goal = (o: ObjSim, re: RegExp) => active(o, 'goal').find((g) => re.test(g.title));

describe('goals', () => {
  it('a child is told to choose a path at fourteen: the years to go, then the career page', () => {
    const o = objSim({ seed: 's1' });
    const g = goal(o, /^Choose your path/)!;
    expect(g).toBeTruthy();
    expect(g.steps).toHaveLength(2);
    expect(g.steps[0].text).toMatch(/^Grow to fourteen: (2 years|a year|a few months) to go$/);
    expect(g.steps[0].goal).toBe(14);
    expect(g.steps[0].progress).toBeCloseTo(12, 0);
    expect(g.steps[1].text).toBe('Think about your career');
    // at fourteen the waiting is over; thinking about it (the self action) finishes the goal
    ageTo(o, 14.1);
    o.obj.poll(true);
    expect(recOf(o, g.id).steps[0].done).toBe(true);
    const r = doAction(o, { kind: 'self' }, /^manage\.career/);
    expect(r.ok).toBe(true);
    expect(o.obj.list().find((x) => x.id === g.id)?.state).toBe('done');
    // and it does not come back
    o.sim.advanceDays(2);
    expect(goal(o, /^Choose your path/)).toBeUndefined();
  });

  it("the archers' test lists what is lacking and follows the player: strength, archery, a bow, the oath", () => {
    const o = objSim({ seed: 's9', install: false }); // a free boy or girl of a village
    const me = playerOf(o.sim);
    me.sex = 'm';
    o.sim.state.touch(me);
    install(o);
    const g = goal(o, /^Join the archers/)!;
    expect(g, active(o, 'goal').map((x) => x.title).join(', ')).toBeTruthy();
    expect(g.steps.map((s) => s.text)).toEqual([
      'Build your Strength to 10', 'Reach Archery 3', 'Own a bow', expect.stringMatching(/^Take the archers' oath: speak to /),
    ]);
    expect(g.reward).toMatch(/archers/);
    const rec = recOf(o, g.id);
    // the numbers move with the person
    me.trained.str = 8.9;
    o.obj.poll(true);
    expect(rec.steps[0].progress).toBe(8.9);
    expect(rec.steps[0].goal).toBe(10);
    me.trained.str = 10.2;
    o.obj.poll(true);
    expect(rec.steps[0].done).toBe(true);
    me.skills.archery = 3 * 3 * 40;
    o.obj.poll(true);
    expect(rec.steps[1].done).toBe(true);
    me.inventory.shortbow = 1;
    o.obj.poll(true);
    expect(rec.steps[2].done).toBe(true);
    expect(rec.steps[3].done).toBe(false);
    // the oath: taking the post
    o.sim.events.emit('careerChanged', { person: me.id, from: me.career, to: 'archer', stage: 1 });
    expect(o.obj.list().find((x) => x.id === g.id)?.state).toBe('done');
  });

  it('is not offered to a girl', () => {
    const o = objSim({ seed: 's9', install: false });
    const me = playerOf(o.sim);
    me.sex = 'f';
    o.sim.state.touch(me);
    install(o);
    expect(goal(o, /archers/)).toBeUndefined();
  });

  it('saving for a good tool: the price, the shop, and the purchase that ends it', () => {
    const o = objSim({ seed: 's1' });
    const me = playerOf(o.sim);
    const g = goal(o, /^Save for a good sickle/)!;
    expect(g, active(o, 'goal').map((x) => x.title).join(', ')).toBeTruthy();
    expect(g.why).toMatch(/^A good sickle works about \d+% faster/);
    expect(g.steps[0].text).toMatch(/^Save .* for a good sickle$/);
    expect(g.steps[1].text).toMatch(/^Buy a good sickle at /);
    const price = g.steps[0].goal!;
    me.money = Math.floor(price / 2);
    o.obj.poll(true);
    expect(recOf(o, g.id).steps[0].progress).toBe(Math.floor(price / 2));
    me.money = price + 5;
    o.obj.poll(true);
    expect(recOf(o, g.id).steps[0].done).toBe(true);
    // buy it at the smithy
    const smithy = g.steps[1].target!;
    const r = o.economy.trade(me.id, { kind: 'building', id: smithy.id }, [{ key: 'sickle#2', qty: 1 }]);
    expect(r.ok, r.reason).toBe(true);
    expect(o.obj.list().find((x) => x.id === g.id)?.state).toBe('done');
    expect(goal(o, /^Save for a good sickle/)).toBeUndefined();
  });

  it('courting at sixteen: get to know someone, win their heart, ask for their hand', () => {
    const o = objSim({ seed: 's1', install: false });
    ageTo(o, 17);
    install(o);
    skipTutorial(o);
    const g = goal(o, /^Find someone to love/)!;
    expect(g, active(o, 'goal').map((x) => x.title).join(', ')).toBeTruthy();
    expect(g.steps).toHaveLength(3);
    expect(g.steps[0].text).toMatch(/^Get to know /);
    expect(g.steps[1].goal).toBe(0.5);
    expect(g.steps[2].text).toMatch(/^Ask \w+ to marry you$/);
    const rec = recOf(o, g.id);
    const m0 = rec.steps[0].m;
    const who = m0.k === 'talk' ? m0.who : 0;
    expect(who).toBeGreaterThan(0);
    expect(g.steps[0].target?.id).toBe(who);
    // talk: the first step; the courtship's progress follows the social module
    expect(talkTo(o, who)).toBe(true);
    expect(rec.steps[0].done).toBe(true);
    const me = playerOf(o.sim);
    o.social.adjustOpinion(who, me.id, 30, 'test');
    // the wedding closes the goal
    me.spouse = who;
    o.sim.events.emit('marriage', { a: me.id, b: who, settlement: me.settlement });
    expect(o.obj.list().find((x) => x.id === g.id)?.state).toBe('done');
  });

  it('a youth is offered an apprenticeship where a master takes boys: the premium to save, the master to see, the indenture', () => {
    const o = objSim({ seed: 's7', install: false });
    adopt(o.sim, o.economy);
    const { player } = makeApprentice(o.sim, { age: 14, title: 'Apprentice smith', purse: 5 });
    player.money = 0;
    goHome(o);
    install(o);
    skipTutorial(o);
    const g = goal(o, /^Win an apprenticeship/)!;
    expect(g, active(o, 'goal').map((x) => x.title).join(', ')).toBeTruthy();
    const rec = recOf(o, g.id);
    const talkStep = rec.steps.find((s) => s.m.k === 'talk')!;
    const masterId = talkStep.m.k === 'talk' ? talkStep.m.who : 0;
    const master = o.sim.state.persons.get(masterId)!;
    expect(g.title).toContain(master.first);
    const job = o.economy.jobs(player.settlement, player.id).find((j) => j.employer === masterId && j.terms === 'apprenticeship')!;
    expect(job).toBeTruthy();
    if ((job.premium ?? 0) > 0) {
      expect(g.steps[0].text).toMatch(/^Save .* for the premium$/);
      expect(g.steps[0].done).toBe(false);
      o.sim.state.households.get(player.household)!.purse = 900;
      o.obj.poll(true);
      expect(recOf(o, g.id).steps[0].done).toBe(true);
    }
    expect(talkTo(o, master.id)).toBe(true);
    const res = o.economy.applyForJob(player.id, job.id);
    expect(res.ok, res.reason).toBe(true);
    expect(o.obj.list().find((x) => x.id === g.id)?.state).toBe('done');
    expect(o.economy.employment(player.id)?.terms).toBe('apprenticeship');
  });
});
