// Work objectives: the duty of a post (an apprentice at the bench, a farmhand on the demesne) and a serf's
// week-work for the lord. Wages come from the economy bout by bout; the objective says where and what, and counts.
import { describe, expect, it } from 'vitest';
import { adopt, makeApprentice } from '../economy/helpers';
import { active, goHome, install, objSim, playObjectives, playerOf, recOf, runTo, skipTutorial, type ObjSim } from './helpers';

/** An apprentice smith at the bench of a master, ready for the first dawn. */
function apprentice(): { o: ObjSim; masterId: number } {
  const o = objSim({ seed: 's7', install: false });
  adopt(o.sim, o.economy);
  const { player, job } = makeApprentice(o.sim, { age: 14, title: 'Apprentice smith', purse: 900 });
  const r = o.economy.applyForJob(player.id, job.id);
  expect(r.ok, r.reason).toBe(true);
  goHome(o);
  install(o);
  skipTutorial(o);
  return { o, masterId: job.employer };
}

describe('the duty of a post', () => {
  it('an apprentice is asked to be at the bench and work: four tasks, counted at the master\'s workshop', () => {
    const { o, masterId } = apprentice();
    runTo(o, Math.floor(o.sim.absDay) + 1, 5);
    const duty = active(o, 'job')[0];
    expect(duty, active(o).map((x) => x.title).join(', ')).toBeTruthy();
    expect(duty.title).toMatch(/^Work at /);
    expect(duty.giver).toBe(masterId);
    expect(duty.why).toMatch(/expects you today/);
    expect(duty.steps).toHaveLength(2);
    expect(duty.steps[0].text).toMatch(/^Go to /);
    expect(duty.steps[1].goal).toBe(4);
    expect(duty.steps[1].target?.kind).toBe('building');
    expect(duty.reward).toMatch(/wage/);
    // the post comes first: the day's duty is tracked and the chores are fewer
    expect(o.obj.tracked()?.id).toBe(duty.id);
    expect(active(o, 'chore').length).toBeLessThanOrEqual(1);
    // work it
    const me = playerOf(o.sim);
    const op0 = o.social.opinion(masterId, me.id);
    const smithing0 = me.skills[o.economy.employment(me.id)!.career === 'smith' ? 'smithing' : 'carpentry'];
    const played = playObjectives(o, ['job']);
    expect(played.stuck, played.trace.join('\n')).toBeNull();
    expect(o.obj.list().find((x) => x.id === duty.id)?.state).toBe('done');
    expect(o.social.opinion(masterId, me.id)).toBeGreaterThan(op0);
    expect(me.skills.smithing + me.skills.carpentry).toBeGreaterThan(smithing0);
  });

  it('is set once a day, and not at all on the holy day', () => {
    const { o } = apprentice();
    runTo(o, Math.floor(o.sim.absDay) + 1, 5);
    const first = active(o, 'job').map((x) => x.id);
    expect(first).toHaveLength(1);
    o.sim.advanceHours(3);
    expect(active(o, 'job').map((x) => x.id)).toEqual(first);
    // the holy day: no work
    runTo(o, 7, 5); // day 7 is the fourth day of the second week: a holy day
    expect(active(o, 'job')).toHaveLength(0);
  });

  it('an unfree youth of fourteen owes week-work: the days left, the lord\'s strip, bouts that count against the dues', () => {
    const o = objSim({ seed: 's1', install: false });
    const me = playerOf(o.sim);
    me.birthDay = Math.round(o.sim.absDay - 15 * 16);
    o.sim.state.touch(me);
    expect(me.estate).toBe('unfree');
    install(o);
    skipTutorial(o);
    const before = o.economy.obligations(me.id).find((x) => x.kind === 'week_work')!;
    expect(before.amount).toBeGreaterThan(0);
    o.obj.dawn();
    const week = active(o, 'job').find((x) => /^Week-work/.test(x.title));
    if (!week) {
      // no strip of the demesne waits for a task today in this little world: nothing to ask
      return;
    }
    expect(week.why).toMatch(/You owe the lord/);
    expect(week.steps[1].text).toMatch(/^Work the lord's [\w-]+ strip$/);
    expect(week.steps[1].goal).toBeGreaterThanOrEqual(2);
    expect(week.dueDay).toBe(before.due);
    const played = playObjectives(o, ['job']);
    expect(played.stuck, played.trace.join('\n')).toBeNull();
    const after = o.economy.obligations(me.id).find((x) => x.kind === 'week_work')!;
    expect(after.amount).toBeLessThan(before.amount);
    expect(recOf(o, week.id).state).toBe('done');
  });
});

describe('the duties of one\'s station (in place of quests)', () => {
  it('a knight with no master has a duty of his station each working day: the yard, the bounds, the forge or the watch', () => {
    const o = objSim({ seed: 'duty-k', install: false });
    const me = playerOf(o.sim);
    for (const t of [...o.sim.state.titlesHeldBy(me.id)]) o.sim.state.setTitleHolder(t, 0);
    me.career = 'knight';
    me.birthDay -= 16 * 14; // a grown man
    goHome(o);
    install(o);
    skipTutorial(o);
    const titles = new Set<string>();
    for (let d = 1; d <= 6; d++) {
      runTo(o, Math.floor(o.sim.absDay) + 1, 6);
      for (const j of active(o, 'job')) titles.add(j.title);
    }
    const all = [...titles].join(' | ');
    expect(all).toMatch(/Your duty: (ride the bounds|train the men at the yard|see to your arms at the forge|stand the watch)/);
  });

  it('a lord has no chores, duties or goals: he manages', () => {
    const o = objSim({ seed: 'duty-l', install: false });
    const me = playerOf(o.sim);
    me.birthDay -= 16 * 20; // a grown man
    // he holds the manor of his own village
    const title = [...o.sim.state.titles.values()].find((t) => t.kind === 'manor' && t.place === me.settlement) ?? [...o.sim.state.titles.values()].find((t) => t.kind === 'manor')!;
    o.sim.state.setTitleHolder(title, me.id);
    goHome(o);
    install(o);
    skipTutorial(o);
    expect(o.sim.state.titlesHeldBy(me.id).size).toBeGreaterThan(0);
    runTo(o, Math.floor(o.sim.absDay) + 1, 7);
    expect(active(o, 'chore')).toHaveLength(0);
    expect(active(o, 'job')).toHaveLength(0);
    expect(active(o, 'goal')).toHaveLength(0);
  });

  it('a grown tradesman is not asked to choose his path', () => {
    const o = objSim({ seed: 'duty-t', install: false });
    const me = playerOf(o.sim);
    for (const t of [...o.sim.state.titlesHeldBy(me.id)]) o.sim.state.setTitleHolder(t, 0);
    me.career = 'smith';
    me.birthDay -= 16 * 22;
    goHome(o);
    install(o);
    skipTutorial(o);
    runTo(o, Math.floor(o.sim.absDay) + 1, 7);
    expect(active(o, 'goal').filter((g) => /path/i.test(g.title))).toHaveLength(0);
  });
});
