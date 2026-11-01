// The household's chores: set by the head at dawn from the plan, the season, the strips, the animals and the
// woodpile; fitted to age and sex; paid a little; ignored chores cost the head's good opinion.
import { describe, expect, it } from 'vitest';
import { fullName } from '../../../src/sim/state';
import { active, addDeadwood, allText, install, objSim, playObjectives, playerOf, recOf, runTo, tracked, type ObjSim } from './helpers';

/** A village child of the farm with the tutorial played out, ready for the first dawn. */
function farmDay1(seed = 's1'): ObjSim {
  const o = objSim({ seed });
  playObjectives(o, ['tutorial']);
  return o;
}

function headOf(o: ObjSim) {
  const me = playerOf(o.sim);
  const hh = o.sim.state.households.get(me.household)!;
  return o.sim.state.persons.get(hh.head)!;
}

describe('dawn chores', () => {
  it('are set at dawn by the household head: one to three, located, with a reason and a reward', () => {
    const o = farmDay1();
    const notes: string[] = [];
    o.sim.events.on('notify', (e) => notes.push(`${e.kind}:${e.text}`));
    expect(active(o, 'chore')).toHaveLength(0);
    runTo(o, 1, 5);
    const chores = active(o, 'chore');
    expect(chores.length).toBeGreaterThanOrEqual(1);
    expect(chores.length).toBeLessThanOrEqual(2); // a child of twelve
    const head = headOf(o);
    for (const c of chores) {
      expect(c.giver).toBe(head.id);
      expect(c.why.length).toBeGreaterThan(20);
      expect(c.reward).toMatch(/thanks/);
      expect(c.dueDay).toBeGreaterThan(o.sim.absDay);
      expect(c.dueDay).toBeLessThan(o.sim.absDay + 1.2);
      expect(c.steps).toHaveLength(1);
      expect(c.steps[0].target, c.title).toBeTruthy();
      expect(c.steps[0].hint, c.title).toBeTruthy();
    }
    // the head says so, by name
    expect(notes.find((n) => n.startsWith('quest:'))).toContain(head.first);
    for (const t of allText(o.obj.list())) expect(t, t).not.toMatch(/\{\w+\}/);
    // one of them is tracked: the first chore of the day (the tutorial is over)
    expect(tracked(o)?.source).toBe('chore');
  });

  it('come from the strips: the next task each strip waits for', () => {
    const o = farmDay1();
    runTo(o, 1, 5);
    const me = playerOf(o.sim);
    const holding = o.economy.holding(me.household)!;
    const waiting = holding.strips.filter((s) => /^(Plough|Harrow|Sow|Weed|Reap|Bind|Carry)/.test(s.nextTask));
    const stripChores = active(o, 'chore').filter((c) => c.steps[0].target?.kind === 'strip');
    if (waiting.length > 0) expect(stripChores.length).toBeGreaterThan(0);
    for (const c of stripChores) {
      const tgt = c.steps[0].target!;
      expect(holding.strips.some((s) => s.id === tgt.id)).toBe(true);
      expect(c.title).toMatch(/^(Plough|Harrow|Sow|Weed|Reap|Bind the sheaves on|Carry the sheaves from) the \w+ strip$/);
    }
  });

  it('are completed through real work, thank the doer and pay a little from the household purse', () => {
    const o = farmDay1();
    runTo(o, 1, 5);
    const me = playerOf(o.sim);
    const head = headOf(o);
    const hh = o.sim.state.households.get(me.household)!;
    const op0 = o.social.opinion(head.id, me.id);
    const purse0 = hh.purse;
    const notes: string[] = [];
    o.sim.events.on('notify', (e) => notes.push(`${e.kind}:${e.text}`));
    const before = active(o, 'chore').map((c) => c.title);
    const played = playObjectives(o, ['chore']);
    expect(played.stuck, played.trace.join('\n')).toBeNull();
    expect(played.titles.sort()).toEqual(before.sort());
    expect(active(o, 'chore')).toHaveLength(0);
    expect(o.social.opinion(head.id, me.id)).toBeGreaterThan(op0);
    expect(hh.purse).toBeLessThanOrEqual(purse0);
    expect(notes.some((n) => n.startsWith('social:') && n.includes(head.first))).toBe(true);
    // the finished chores are kept in the list for a while, as done
    expect(o.obj.list().filter((x) => x.source === 'chore' && x.state === 'done').length).toBe(before.length);
  });

  it('lapse at the next sunrise; one ignored altogether costs the head\'s good opinion, one begun does not', () => {
    const o = farmDay1();
    runTo(o, 1, 5);
    const me = playerOf(o.sim);
    const head = headOf(o);
    const chores = active(o, 'chore');
    expect(chores.length).toBeGreaterThanOrEqual(1);
    const op0 = o.social.opinion(head.id, me.id);
    const notes: string[] = [];
    o.sim.events.on('notify', (e) => notes.push(`${e.kind}:${e.text}`));
    // begin the first one a little (a bout counts), ignore the rest
    const first = recOf(o, chores[0].id);
    first.steps[0].progress = 1;
    runTo(o, 2, 5);
    expect(o.obj.list().find((x) => x.id === chores[0].id)?.state).toBe('expired');
    const ignored = chores.slice(1);
    if (ignored.length > 0) {
      expect(o.social.opinion(head.id, me.id)).toBeLessThan(op0);
      expect(notes.some((n) => n.startsWith('loss:') && n.includes(head.first))).toBe(true);
    } else {
      expect(o.social.opinion(head.id, me.id)).toBeGreaterThanOrEqual(op0 - 0.01);
    }
    // and the next day's work is set
    expect(active(o, 'chore').length).toBeGreaterThan(0);
    expect(active(o, 'chore').every((c) => !chores.some((p) => p.id === c.id))).toBe(true);
  });

  it('on the holy day there is no work: hear Mass', () => {
    const o = farmDay1();
    runTo(o, 3, 5); // the fourth day of the season
    const chores = active(o, 'chore');
    expect(chores.length).toBeGreaterThan(0);
    expect(chores[0].title).toBe('Hear Mass');
    expect(chores.some((c) => /strip|garden|animals/i.test(c.title))).toBe(false);
    const played = playObjectives(o, ['chore']);
    expect(played.stuck, played.trace.join('\n')).toBeNull();
  });

  it('a household plan of wood-gathering asks for firewood from the nearest fallen tree, retargeting after each load', () => {
    const o = objSim({ seed: 's1', install: false });
    const ids = addDeadwood(o);
    const me = playerOf(o.sim);
    const head = headOf(o);
    expect(o.economy.setTask(head.id, me.id, 'wood').ok).toBe(true);
    install(o);
    playObjectives(o, ['tutorial']);
    runTo(o, 1, 5);
    const wood = active(o, 'chore').find((c) => c.title === 'Gather firewood');
    expect(wood, active(o, 'chore').map((c) => c.title).join(', ')).toBeTruthy();
    const step = wood!.steps[0];
    expect(step.goal).toBe(2);
    expect(step.target?.kind).toBe('scatter');
    expect(step.target?.id).toBe(ids[0]);
    // gather one load: the beacon moves to the next fallen tree
    const r = o.sim.actions.list(me.id, { kind: 'scatter', id: ids[0] }).find((x) => x.id === 'wood.gather' && x.enabled);
    expect(r, 'gathering is possible').toBeTruthy();
    o.sim.actions.start(me.id, r!);
    for (let i = 0; i < 20 * 60 && o.sim.actions.active(me.id); i++) o.sim.step(1 / 20);
    const after = o.obj.list().find((x) => x.id === wood!.id)!;
    expect(after.steps[0].progress).toBe(1);
    expect(after.steps[0].target?.id).toBe(ids[1]);
  });

  it('are fewer for a child than for a youth', () => {
    const o = objSim({ seed: 's1', install: false });
    const me = playerOf(o.sim);
    me.birthDay = Math.round(o.sim.absDay - 15 * 16); // fifteen
    o.sim.state.touch(me);
    install(o);
    playObjectives(o, ['tutorial']);
    runTo(o, 1, 5);
    expect(active(o, 'chore').length).toBeLessThanOrEqual(3);
  });
});


describe('a household with nothing to do at home', () => {
  for (const seed of ['s15', 's18', 's33']) {
    it(`a town child (${seed}) is not left without direction: an errand, or the board where work is asked about`, () => {
      const o = objSim({ seed });
      playObjectives(o, ['tutorial']);
      runTo(o, 1, 6);
      const chores = active(o, 'chore');
      expect(chores.length, `chores of ${seed}`).toBeGreaterThan(0);
      for (const c of chores) {
        expect(c.steps[0].target, c.title).toBeTruthy();
        expect(c.why.length).toBeGreaterThan(15);
      }
      const played = playObjectives(o, ['chore']);
      expect(played.stuck, played.trace.join('\n')).toBeNull();
    });
  }
});

describe('who the chores are for', () => {
  it('a household head sets his own work: no giver, no fine', () => {
    const o = objSim({ seed: 's1', install: false });
    const me = playerOf(o.sim);
    const hh = o.sim.state.households.get(me.household)!;
    o.sim.state.setHead(hh, me);
    install(o);
    playObjectives(o, ['tutorial']);
    runTo(o, 1, 5);
    for (const c of active(o, 'chore')) {
      expect(c.giver).toBeUndefined();
      expect(c.title, fullName(me)).toBeTruthy();
    }
  });
});
