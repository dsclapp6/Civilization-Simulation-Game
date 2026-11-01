// What the tracker and the journal say about an objective, and the sounds that go with the work.
import { describe, expect, it } from 'vitest';
import type { DaySummary, Objective } from '../../src/sim/objectives/types';
import {
  currentStep, currentStepIndex, dueLine, groupObjectives, objectiveSignature, progressFraction, progressText, sourceLine, stepPips,
  suggestionSignature, summaryIsEmpty,
} from '../../src/ui/core/objectiveModel';
import { MASS_BELL_AFTER_SUNRISE, carry, massBellDay, workSound } from '../../src/ui/core/soundModel';
import { daylight } from '../../src/core/time';

const obj = (over: Partial<Objective> = {}): Objective => ({
  id: 1, source: 'tutorial', title: 'Your first day', why: 'Learn how things are done.', state: 'active', tracked: true,
  steps: [
    { text: 'Meet your family', done: true },
    { text: 'Fetch water', hint: 'Click the well', done: false, target: { kind: 'building', id: 4, x: 10, z: 20, label: 'The well' } },
    { text: 'Help on the strip', done: false, progress: 1, goal: 4 },
    { text: 'Sleep', done: false },
  ],
  ...over,
});

describe('steps and progress', () => {
  it('names the first undone step as the current one, and the last when everything is done', () => {
    expect(currentStepIndex(obj())).toBe(1);
    expect(currentStep(obj())?.text).toBe('Fetch water');
    const all = obj({ steps: [{ text: 'a', done: true }, { text: 'b', done: true }] });
    expect(currentStepIndex(all)).toBe(1);
  });

  it('draws one pip per step: done, now, to do (and no "now" once the task is over)', () => {
    expect(stepPips(obj())).toEqual(['done', 'now', 'todo', 'todo']);
    expect(stepPips(obj({ state: 'done' }))).toEqual(['done', 'todo', 'todo', 'todo']);
  });

  it('reports counted steps as "n of m" and a fraction, and leaves the others alone', () => {
    const counted = obj().steps[2];
    expect(progressText(counted)).toBe('1 of 4');
    expect(progressFraction(counted)).toBeCloseTo(0.25);
    expect(progressText(obj().steps[1])).toBeNull();
    expect(progressFraction({ progress: 9, goal: 4 })).toBe(1);
    expect(progressText(null)).toBeNull();
  });
});

describe('where it came from', () => {
  it('says the kind of task and who set it', () => {
    const name = (id: number): string => (id === 7 ? 'Eoghan McMurchad' : 'someone');
    expect(sourceLine(obj({ giver: 7 }), name)).toBe('First steps · for Eoghan');
    expect(sourceLine(obj({ source: 'request', giver: 7 }), name)).toBe('Request · from Eoghan');
    expect(sourceLine(obj({ source: 'job' }), name)).toBe('Work');
  });

  it('says when it lapses', () => {
    expect(dueLine(obj({ dueDay: 12 }), 12.4)).toBe('due today');
    expect(dueLine(obj({ dueDay: 13 }), 12.4)).toBe('due tomorrow');
    expect(dueLine(obj({ dueDay: 13, state: 'done' }), 12.4)).toBe('');
    expect(dueLine(obj(), 12.4)).toBe('');
  });
});

describe('the journal list', () => {
  it('puts the tracked task first, groups the rest by kind and sets finished ones apart', () => {
    const list = [
      obj({ id: 1 }),
      obj({ id: 2, source: 'chore', title: 'Firewood', tracked: false }),
      obj({ id: 3, source: 'goal', title: 'Archers', tracked: false }),
      obj({ id: 4, source: 'chore', title: 'Feed the pigs', tracked: false }),
      obj({ id: 5, source: 'request', title: 'Agnes asks', tracked: false, state: 'done' }),
    ];
    const g = groupObjectives(list);
    expect(g.tracked?.id).toBe(1);
    expect(g.groups.map((x) => x.source)).toEqual(['chore', 'goal']);
    expect(g.groups[0].items.map((o) => o.id)).toEqual([2, 4]);
    expect(g.done.map((o) => o.id)).toEqual([5]);
  });

  it('changes its signature when a step moves, and only then', () => {
    const a = obj();
    const before = objectiveSignature(a);
    expect(objectiveSignature(obj())).toBe(before);
    a.steps[2].progress = 2;
    expect(objectiveSignature(a)).not.toBe(before);
    expect(objectiveSignature(null)).toBe('-');
    expect(suggestionSignature([{ text: 'Go home' }])).not.toBe(suggestionSignature([{ text: 'Go home', target: { kind: 'place', id: -1, x: 1, z: 2, label: 'x' } }]));
  });

  it('knows an empty day when it sees one', () => {
    const empty: DaySummary = { day: 1, work: [], earned: 0, spent: 0, goods: [], skills: [], stats: [], objectivesDone: [], household: ['fed'], tomorrow: [] };
    expect(summaryIsEmpty(empty)).toBe(true);
    expect(summaryIsEmpty({ ...empty, earned: 4 })).toBe(false);
    expect(summaryIsEmpty({ ...empty, skills: [{ skill: 'Farming', xp: 5 }] })).toBe(false);
  });
});

describe('sound', () => {
  it('keys the work sounds to the animation of the action', () => {
    expect(workSound('work_axe')?.sfx).toBe('chop');
    expect(workSound('work_scythe')?.sfx).toBe('swish');
    expect(workSound('work_sickle')?.sfx).toBe('swish');
    expect(workSound('work_hammer')?.sfx).toBe('clank');
    expect(workSound('work_hoe')?.sfx).toBe('dig');
    expect(workSound('work_pick')?.sfx).toBe('pick');
    expect(workSound('work_stir')).toBeNull();
    expect(workSound('idle')).toBeNull();
    expect(workSound(undefined)).toBeNull();
    for (const a of ['work_hoe', 'work_scythe', 'work_sickle', 'work_axe', 'work_hammer', 'work_pick', 'work_saw', 'work_dig', 'work_sow'] as const) {
      const w = workSound(a)!;
      expect(w.period).toBeGreaterThan(0.5);
      expect(w.period).toBeLessThan(2);
    }
  });

  it('rings the church bell once, a little after dawn on a holy day', () => {
    const season = 0;
    const at = daylight(season).sunrise + MASS_BELL_AFTER_SUNRISE;
    const day = 3; // the fourth day of the season
    expect(massBellDay(day + at + 0.002, true)).toBe(day);
    expect(massBellDay(day + at - 0.01, true)).toBe(-1);
    expect(massBellDay(day + at + 0.05, true)).toBe(-1);
    expect(massBellDay(day + at + 0.002, false)).toBe(-1);
  });

  it('carries a sound further the closer you are, and not at all beyond its reach', () => {
    expect(carry(0, 500)).toBeCloseTo(1, 1);
    expect(carry(250, 500)).toBeLessThan(carry(100, 500));
    expect(carry(500, 500)).toBe(0);
    expect(carry(900, 500)).toBe(0);
  });
});
