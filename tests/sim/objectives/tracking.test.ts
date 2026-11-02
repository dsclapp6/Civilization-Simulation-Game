// Which objective is tracked: the player's pick while it lives, else the most pressing; the list the HUD and the
// journal read; the change counter.
import { describe, expect, it } from 'vitest';
import { active, hearOffers, objSim, playObjectives, playerOf, recOf, runTo, skipTutorial, tracked } from './helpers';

describe('the scene-setting line', () => {
  it('names the season, the house, the place and what the household needs first', () => {
    const o = objSim({ seed: 's1' });
    const line = o.obj.intro!();
    const me = playerOf(o.sim);
    const place = o.sim.world.settlements.find((s) => s.id === me.settlement)!.name;
    expect(line).toMatch(/^Spring\. You wake in your (father|mother|family)'s [\w ]+ in /);
    expect(line).toContain(place);
    expect(line).toMatch(/; the .* (must|needs)/);
    expect(line.endsWith('.')).toBe(true);
    expect(line).not.toMatch(/\{\w+\}/);
  });

  it("is told for a lord's child too: at the castle", () => {
    const o = objSim({ seed: 's39' });
    const line = o.obj.intro!();
    expect(line).toMatch(/^Spring\. You wake in /);
    expect(line.endsWith('.')).toBe(true);
  });
});

describe('tracking', () => {
  it('exactly one objective is tracked, and it comes first in the list', () => {
    const o = objSim({ seed: 's1' });
    playObjectives(o, ['tutorial']);
    runTo(o, 1, 6);
    const list = o.obj.list();
    expect(list.filter((x) => x.tracked)).toHaveLength(1);
    expect(list[0].tracked).toBe(true);
    expect(list[0].state).toBe('active');
    // active ones first, then the finished, newest first
    const firstDone = list.findIndex((x) => x.state !== 'active');
    if (firstDone >= 0) expect(list.slice(firstDone).every((x) => x.state !== 'active')).toBe(true);
    const ended = list.filter((x) => x.state !== 'active');
    for (let i = 1; i < ended.length; i++) expect(recOf(o, ended[i - 1].id).ended!).toBeGreaterThanOrEqual(recOf(o, ended[i].id).ended!);
  });

  it('auto-tracking prefers the tutorial, then the day\'s chores over requests and goals', () => {
    const o = objSim({ seed: 's1' });
    expect(tracked(o)?.source).toBe('tutorial');
    playObjectives(o, ['tutorial']);
    runTo(o, 1, 6);
    // villagers may already have asked something of their own by now (offers are checked each daytime hour)
    const id = o.adv.happenings.offerRequest('fetch');
    o.obj.poll(true);
    hearOffers(o);
    const summary = o.adv.happenings.requests().find((r) => r.id === id)!.summary;
    expect(active(o, 'request').some((x) => x.title === summary)).toBe(true);
    expect(tracked(o)?.source).toBe('chore');
  });

  it('the player\'s pick is kept until it ends, then the most pressing takes over', () => {
    const o = objSim({ seed: 's1' });
    skipTutorial(o);
    runTo(o, 1, 6);
    const goal = active(o, 'goal')[0];
    expect(goal).toBeTruthy();
    expect(tracked(o)?.id).not.toBe(goal.id);
    const v0 = o.obj.version!();
    o.obj.track(goal.id);
    expect(tracked(o)?.id).toBe(goal.id);
    expect(o.obj.list()[0].id).toBe(goal.id);
    expect(o.obj.version!()).toBeGreaterThan(v0);
    // new chores at the next dawn do not displace the pick
    runTo(o, 2, 6);
    expect(tracked(o)?.id).toBe(goal.id);
    // it ends: the choice lapses and the day's work is tracked again
    o.obj.obj.finish(recOf(o, goal.id), 'expired');
    expect(tracked(o)?.source).toBe('chore');
    // tracking something that is over or unknown changes nothing
    const now = tracked(o)!.id;
    o.obj.track(goal.id);
    o.obj.track(99999);
    expect(tracked(o)?.id).toBe(now);
  });

  it('the version moves when something changes and holds still when nothing does', () => {
    const o = objSim({ seed: 's1' });
    const v = o.obj.version!();
    o.obj.poll(false);
    o.obj.poll(false);
    expect(o.obj.version!()).toBe(v);
    playObjectives(o, ['tutorial'], 1);
    expect(o.obj.version!()).toBeGreaterThan(v);
  });
});
