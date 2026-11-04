// Nothing leads nowhere (docs/INTERIORS.md): the inside of every kind of building, at every level, in every culture, is walked from
// its doors — every floor, doorway, stair head and place where someone sits, sleeps or works is reached. And the inside fits the
// outside: its doorways are the model's.
import { describe, expect, it } from 'vitest';
import { BUILDINGS, type BuildingKind } from '../../src/content/types';
import type { CultureId } from '../../src/core/domain';
import { interiorPlan } from '../../src/assets/interiors/plan';
import { validatePlan } from '../../src/assets/interiors/validate';
import { buildInterior } from '../../src/assets/interiors/model';
import { generateBuilding, normalizeRequest } from '../../src/assets/buildings/index';

const CULTURES: CultureId[] = ['anglo', 'norse', 'franc', 'teuton', 'gael', 'cymric'];

describe('interior plans', () => {
  it('every inside is reached from its doors', () => {
    const bad: string[] = [];
    let n = 0;
    for (const c of CULTURES) for (const kind of Object.keys(BUILDINGS) as BuildingKind[]) {
      for (let lv = 1; lv <= BUILDINGS[kind].maxLevel; lv++) {
        const p = interiorPlan(kind, lv, c, 0);
        if (!p) continue;
        n++;
        const v = validatePlan(p);
        if (v.problems.length) bad.push(`${c} ${kind}${lv}: ${v.problems.slice(0, 3).join('; ')}`);
      }
    }
    expect(n).toBeGreaterThan(450);
    expect(bad).toEqual([]);
  }, 300000);

  it('the doorways of the plan are the doorways of the model, and the model of the inside is made', () => {
    for (const kind of ['cottage', 'townhouse', 'manor_house', 'church', 'smithy', 'keep_stone', 'tower'] as BuildingKind[]) {
      const p = interiorPlan(kind, BUILDINGS[kind].maxLevel, 'anglo', 0)!;
      expect(p, kind).toBeTruthy();
      const model = generateBuilding(normalizeRequest({ kind, level: BUILDINGS[kind].maxLevel, culture: 'anglo', seed: 0, doorLeaves: false }));
      for (const d of model.doorways) {
        if (d.w < 0.55 || d.h < 1.2) continue;
        expect(p.doors.some((q) => Math.hypot(q.x - d.x, q.z - d.z) < 0.05), `${kind} door at ${d.x.toFixed(1)},${d.z.toFixed(1)}`).toBe(true);
      }
      const m = buildInterior(p);
      expect(m.body.triCount).toBeGreaterThan(100);
      // a storey above one's head has its stair
      if (p.levels.length > 1) expect(p.stairs.length).toBeGreaterThan(0);
    }
  });

  it('the room over a gatehouse passage is reached by a door from the tower stair, and is furnished (the winch room)', () => {
    for (const c of CULTURES) for (const lv of [1, 2]) {
      const p = interiorPlan('gatehouse', lv, c, 0)!;
      const winch = p.rooms.find((r) => r.name === 'the winch room');
      expect(winch, `${c} gatehouse${lv} rooms: ${p.rooms.map((r) => r.name).join()}`).toBeTruthy();
      // a door at the winch room's level joins it to the tower, and the winch's wheel stands in it
      expect(p.doors.some((d) => !d.outer && d.level === winch!.level), `${c} gatehouse${lv} door`).toBe(true);
      expect(p.furniture.some((f) => f.kind === 'gearwheel'), `${c} gatehouse${lv} winch`).toBe(true);
      expect(p.spots.some((s) => s.room === p.rooms.indexOf(winch!) && s.use === 'work'), `${c} gatehouse${lv} spot`).toBe(true);
      expect(validatePlan(p).problems).toEqual([]);
    }
  });

  it('the tall planks towers of the norse abbey church and cathedral are reached to the top', () => {
    for (const [kind, lv] of [['abbey_church', 2], ['cathedral', 1], ['cathedral', 2]] as Array<[BuildingKind, number]>) {
      const p = interiorPlan(kind, lv, 'norse', 0)!;
      expect(p.levels.length, kind).toBeGreaterThan(4);
      expect(validatePlan(p).problems, `${kind}${lv}`).toEqual([]);
    }
  });

  it('a one-storey cottage has no stair; a townhouse goes up', () => {
    expect(interiorPlan('cottage', 1, 'anglo', 0)!.stairs.length).toBe(0);
    expect(interiorPlan('townhouse', 2, 'anglo', 0)!.stairs.length).toBeGreaterThan(1);
  });
});
