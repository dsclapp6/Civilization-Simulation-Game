// The first-day tutorial of each birth chain: made from what is really at hand, every step located, completed by
// the scripted player through real actions, conversations, trades and sleep.
import { describe, expect, it } from 'vitest';
import { chainOf } from '../../../src/sim/objectives/tutorial';
import { dayPart } from '../../../src/sim/calendar';
import type { BirthClass } from '../../../src/sim/state';
import { active, allText, byTitle, install, objSim, playObjectives, playerOf, recOf, setTime, stepOf, tracked, type ObjSim } from './helpers';

/** One seed of the tiny world for every birth class (found by scanning: see tests/sim/objectives/README in the module). */
const SEEDS: Array<{ seed: string; cls: BirthClass; chain: string }> = [
  { seed: 's1', cls: 'serf', chain: 'farm' },
  { seed: 's9', cls: 'free', chain: 'farm' },
  { seed: 's26', cls: 'craftsman', chain: 'craft' },
  { seed: 's140', cls: 'merchant', chain: 'merchant' },
  { seed: 's4', cls: 'gentry', chain: 'noble' },
  { seed: 's119', cls: 'knightly', chain: 'noble' },
  { seed: 's39', cls: 'baronial', chain: 'baron' },
];

function checkLocated(o: ObjSim): void {
  for (const ob of active(o)) {
    for (const s of ob.steps) {
      if (ob.source !== 'tutorial') continue;
      // every tutorial step says where, or is plain (sleep) and then the objective points at home
      expect(s.hint && s.hint.length > 10, `${ob.title} / ${s.text} has a hint`).toBe(true);
      expect(s.target, `${ob.title} / ${s.text} has a target`).toBeTruthy();
    }
  }
}

describe('the tutorial chains', () => {
  for (const { seed, cls, chain } of SEEDS) {
    it(`${cls} (${seed}): ${chain} chain is made, tracked first, located, and completes through real play`, () => {
      const o = objSim({ seed, install: false });
      const events: string[] = [];
      o.sim.events.on('objective', (e) => events.push(`${e.phase}:${e.title}`));
      install(o);
      expect(o.sim.state.run.birthClass).toBe(cls);
      expect(chainOf(o.obj.obj)).toBe(chain);

      // the very first thing: meet the family, tracked, with a person to find
      const first = tracked(o);
      expect(first?.source).toBe('tutorial');
      expect(first?.title).toBe('Meet your family');
      const step = stepOf(first);
      expect(step?.target?.kind).toBe('person');
      expect(step?.hint).toMatch(/E/);
      const head = o.sim.state.persons.get(step!.target!.id)!;
      expect(head.household).toBe(playerOf(o.sim).household);
      expect(first!.giver).toBe(head.id);
      expect(first!.reward).toBeTruthy();
      checkLocated(o);

      const money0 = playerOf(o.sim).money;
      const played = playObjectives(o);
      expect(played.stuck, played.trace.join('\n')).toBeNull();
      expect(played.titles.length, played.titles.join(', ')).toBeGreaterThanOrEqual(3);
      expect(played.titles[0]).toBe('Meet your family');
      expect(played.titles[played.titles.length - 1]).toBe('Home before dark');
      // each stage was announced and finished, in order
      for (const t of played.titles) {
        expect(events).toContain(`added:${t}`);
        expect(events).toContain(`done:${t}`);
      }
      expect(o.obj.obj.save.tut.done).toBe(true);
      expect(active(o, 'tutorial')).toHaveLength(0);
      expect(playerOf(o.sim).money).toBeGreaterThanOrEqual(0);
      void money0;
      // no unfilled placeholder in anything the player could read
      for (const t of allText(o.obj.list())) expect(t, t).not.toMatch(/\{\w+\}/);
    });
  }

  it('the farm chain teaches work on a strip: walk to it, then bouts counted against the strip itself', () => {
    const o = objSim({ seed: 's1' });
    playObjectives(o, ['tutorial'], 1); // meet your family
    const work = byTitle(o, /family's land/);
    expect(work, active(o).map((x) => x.title).join(', ')).toBeTruthy();
    const [walk, task] = work!.steps;
    expect(walk.text).toMatch(/^Walk to your family's [\w-]+ strip$/);
    expect(walk.target?.kind).toBe('strip');
    expect(task.text).toMatch(/^(Plough|Harrow|Sow|Weed|Reap|Bind the sheaves on|Carry the sheaves from) your family's [\w-]+ strip/);
    expect(task.goal).toBeGreaterThanOrEqual(2);
    expect(task.hint).toMatch(/E/);
    expect(work!.reward).toMatch(/thanks/);
    // the beacon of the tracked objective points at the strip until the walk is done
    expect(tracked(o)!.id).toBe(work!.id);
    expect(stepOf(tracked(o))!.target!.id).toBe(walk.target!.id);
  });

  it('pays the real rewards: coins from the head\'s purse, the head\'s good opinion, a little experience', () => {
    const o = objSim({ seed: 's1' });
    const me = playerOf(o.sim);
    const hh = o.sim.state.households.get(me.household)!;
    const head = o.sim.state.persons.get(hh.head)!;
    const op0 = o.social.opinion(head.id, me.id);
    const purse0 = hh.purse;
    const money0 = me.money;
    const farming0 = me.skills.farming;
    playObjectives(o, ['tutorial'], 2); // meet, then the strip
    expect(o.social.opinion(head.id, me.id)).toBeGreaterThan(op0);
    expect(me.skills.farming).toBeGreaterThan(farming0);
    // the household paid what it promised, and no more than half its purse
    const paid = me.money - money0;
    expect(paid).toBeGreaterThanOrEqual(0);
    expect(purse0 - hh.purse).toBeCloseTo(paid, 1);
    expect(purse0 - hh.purse).toBeLessThanOrEqual(purse0 * 0.5 + 1e-6);
  });

  it('keeps the evening stage back until the evening, then asks for home and sleep', () => {
    const o = objSim({ seed: 's1' });
    const played = playObjectives(o, ['tutorial'], 4); // up to but not including the evening: meet, strip, errand, trade
    expect(played.titles).not.toContain('Home before dark');
    expect(dayPart(o.sim.absDay)).not.toBe('evening');
    expect(o.obj.obj.save.tut.done).toBe(false);
    expect(active(o, 'tutorial')).toHaveLength(0);
    // evening comes
    setTime(o.sim, 0.83);
    o.sim.advanceHours(1);
    const night = tracked(o);
    expect(night?.title).toBe('Home before dark');
    expect(night!.steps.map((s) => s.text)).toEqual(['Go home', 'Sleep until dawn']);
    expect(night!.steps[0].target?.label).toBe('Your home');
  });

  it('skips a stage that cannot be made today (no errands on a holy day) and goes on to the next', () => {
    const o = objSim({ seed: 's1' });
    // the fourth day of the season is the holy day: the stages after "meet" are made then
    setTime(o.sim, 0.3, 3);
    o.obj.obj.finish(recOf(o, tracked(o)!.id), 'done');
    const played = playObjectives(o, ['tutorial'], 8);
    expect(played.titles).not.toContain("A neighbour's errand");
    expect(played.titles.length).toBeGreaterThan(0);
    expect(o.obj.obj.save.tut.stage).toBeGreaterThan(1);
  });

  it('lets the tutorial lapse after three days if the player never gets to it', () => {
    const o = objSim({ seed: 's1' });
    expect(tracked(o)?.source).toBe('tutorial');
    o.sim.advanceDays(5);
    expect(o.obj.obj.save.tut.done).toBe(true);
    expect(active(o, 'tutorial')).toHaveLength(0);
    const ended = o.obj.list().filter((x) => x.source === 'tutorial' && x.state === 'expired');
    expect(ended.length).toBeGreaterThan(0);
    // no one is punished for it
    expect(tracked(o)?.source).not.toBe('tutorial');
  });

  it('does not hold a stage that is already done: a strip that needs nothing else counts as finished', () => {
    const o = objSim({ seed: 's1' });
    playObjectives(o, ['tutorial'], 1);
    const work = byTitle(o, /family's land/)!;
    const rec = recOf(o, work.id);
    const strip = rec.steps[1].m;
    expect(strip.k).toBe('strip');
    // somebody else (the household) does the task: the step is done by itself
    if (strip.k === 'strip') {
      const st = o.sim.state.strips.get(strip.strip)!;
      st.state = 'ripe'; // whatever it waited for, it now waits for something else
      st.crop = 'barley';
      o.sim.state.touchStrip(st);
      o.obj.poll(true);
      expect(rec.steps[1].done || rec.steps[0].done).toBe(true);
    }
  });
});
