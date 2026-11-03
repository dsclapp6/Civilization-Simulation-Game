// A run that starts as a lord (docs/PLAYING.md): the holder of a manor from the first morning, the lord's chain of first-day
// lessons, and the birth lottery still the default.
import { describe, expect, it } from 'vitest';
import { installRealm } from '../../../src/sim/realm';
import { advanceTutorial, chainOf } from '../../../src/sim/objectives/tutorial';
import { ageYears } from '../../../src/sim/state';
import { LORD_AGE_MAX, LORD_AGE_MIN } from '../../../src/sim/run';
import { active, byTitle, install, objSim, playerOf, recOf } from './helpers';

describe('starting as a lord', () => {
  it('makes the player a grown holder of a manor; the default is still the birth of a twelve-year-old', () => {
    const lord = objSim({ seed: 'lord-a', preset: 'small', start: 'lord', install: false });
    const me = playerOf(lord.sim);
    const age = ageYears(me, lord.sim.absDay);
    expect(age).toBeGreaterThanOrEqual(LORD_AGE_MIN);
    expect(age).toBeLessThanOrEqual(LORD_AGE_MAX);
    expect(lord.sim.state.titlesHeldBy(me.id).size).toBeGreaterThan(0);
    expect(lord.sim.state.run.phase).toBe('alive');
    const born = objSim({ seed: 'lord-a', preset: 'small', install: false });
    expect(Math.round(ageYears(playerOf(born.sim), born.sim.absDay))).toBe(12);
  });

  it('is deterministic (the same seed starts as the same lord)', () => {
    const a = objSim({ seed: 'lord-b', preset: 'small', start: 'lord', install: false });
    const b = objSim({ seed: 'lord-b', preset: 'small', start: 'lord', install: false });
    expect(playerOf(a.sim).id).toBe(playerOf(b.sim).id);
  });

  it('runs the lord chain, and the ruler\'s orders complete its ruling stages', () => {
    const o = objSim({ seed: 'lord1', preset: 'small', start: 'lord', install: false });
    const realm = installRealm(o.sim, o.deps);
    install(o);
    const me = playerOf(o.sim);
    expect(chainOf(o.obj.obj)).toBe('lord');
    let plan = byTitle(o, /fields and labour/i);
    for (let guard = 0; guard < 6 && !plan; guard++) {
      const live = active(o, 'tutorial')[0];
      if (live) o.obj.obj.finish(recOf(o, live.id), 'done');
      advanceTutorial(o.obj.obj);
      plan = byTitle(o, /fields and labour/i);
    }
    expect(plan, 'the plan stage is made').toBeTruthy();
    const view = realm.view(me.id)!;
    expect(realm.setWorksShare(me.id, view.settlements[0], 0.25).ok).toBe(true);
    o.obj.poll(true);
    expect(byTitle(o, /fields and labour/i)?.state).toBe('done');
  });
});
