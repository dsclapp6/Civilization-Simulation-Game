// Walking trips (clarity pass): with a ten-minute day people set out early enough to arrive on time, the schedule moves
// them continuously, and the agents near the player walk their trips instead of finishing them out of sight.
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_HURRY, SEEN_RADIUS } from '../../src/agents/config';
import { doorStand } from '../../src/agents/geometry';
import { newIntent, tripDays } from '../../src/agents/schedule';
import type { Settlement } from '../../src/world/types';
import { makeRig, setClock, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
}, 180000);

describe('trip lengths', () => {
  it('give an easy walk over the first hundred metres and a brisker one for the long ways, within bounds', () => {
    expect(tripDays(1)).toBeCloseTo(0.012, 6);
    expect(tripDays(50) * 600).toBeGreaterThan(25);
    expect(100 / (tripDays(100) * 600)).toBeGreaterThan(1.4); // not slower than a stroll
    expect(100 / (tripDays(100) * 600)).toBeLessThan(2.2);
    let prev = 0;
    for (let d = 5; d < 800; d += 25) { const t = tripDays(d); expect(t).toBeGreaterThanOrEqual(prev); expect(t).toBeLessThanOrEqual(0.3); prev = t; }
    expect(tripDays(2000)).toBe(0.3);
    // a long walk to the fields is a brisk pace, not a run
    expect(400 / (tripDays(400) * 600)).toBeLessThan(3.4);
  });
});

describe('the schedule on a ten-minute day', () => {
  it('moves people continuously: they are not carried across the village between two samples a second apart', () => {
    const { zone, sim, world } = rig;
    const I = newIntent();
    let visible = 0, pops = 0, walking = 0;
    for (const s of world.settlements.filter((x) => x.kind === 'village').slice(0, 2)) {
      for (const [season, dow] of [[1, 2], [3, 4]] as const) {
        setClock(sim, season, dow, 0);
        const day = Math.floor(sim.absDay);
        for (const p of sim.state.residentsOf(s.id).slice(0, 60)) {
          if (p.death) continue;
          let prev: { x: number; z: number } | null = null;
          for (let t = day; t < day + 1; t += 0.002) {
            zone.sched.intent(p, t, I);
            const vis = !I.away && (I.travel < 1 || !I.indoors);
            let x = I.x, z = I.z;
            if (I.travel < 1) { x = I.prevX + (I.x - I.prevX) * I.travel; z = I.prevZ + (I.z - I.prevZ) * I.travel; walking++; }
            if (vis) visible++;
            if (prev && vis && Math.hypot(x - prev.x, z - prev.z) > 8) pops++;
            prev = vis ? { x, z } : null;
          }
        }
      }
    }
    expect(walking).toBeGreaterThan(visible * 0.05); // a good share of the day is spent walking somewhere
    expect(pops).toBeLessThan(visible * 0.005);
  });

  it('has people set out early: at the moment a stretch begins they are where it says (when the way is a short one)', () => {
    const { zone, sim } = rig;
    setClock(sim, 1, 2, 0);
    const day = Math.floor(sim.absDay);
    const I = newIntent(), J = newIntent();
    let checked = 0, there = 0;
    for (const p of sim.state.residentsOf(vil.id)) {
      if (p.death) continue;
      let t = day + 0.0001;
      for (let guard = 0; guard < 30 && t < day + 1; guard++) {
        zone.sched.intent(p, t, I);
        const end = I.until;
        // just before the end of the stretch the person is on their way to the next one; at the instant it begins they are there
        zone.sched.intent(p, end + 0.0006, J);
        zone.sched.intent(p, end - 0.0006, I);
        if (!J.away && !J.indoors && J.travel >= 1 && I.travel < 1 && Math.hypot(J.x - I.x, J.z - I.z) < 400 && !I.away) {
          checked++;
          // the leg was timed to arrive: one step after the start the person has arrived (or is in the last metres of the walk)
          if (Math.hypot(J.x - (I.prevX + (I.x - I.prevX) * I.travel), J.z - (I.prevZ + (I.z - I.prevZ) * I.travel)) < 30) there++;
        }
        t = Math.max(t + 1e-4, end + 1e-4);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(there / checked).toBeGreaterThan(0.8);
  });
});

describe('agents on a ten-minute day', () => {
  it('walk their trips in sight: no one is carried across the street, and people come out of doors', () => {
    const { zone, sim, focus } = rig;
    zone.detachPlayer();
    sim.view.setSource('mode', () => 'street');
    focus.x = vil.x; focus.z = vil.z;
    setClock(sim, 1, 2, 0.2);
    zone.resync();
    const prev = new Map<number, { x: number; z: number }>();
    const seen = new Set<number>(zone.agentsArr.map((a) => a.personId));
    let jumps = 0, near = 0, atDoor = 0;
    const door = { x: 0, z: 0, yaw: 0 };
    for (let i = 0; i < 6000; i++) { // five minutes of play: from early morning to the middle of the day
      sim.step(1 / 20);
      const ids = new Set<number>();
      for (const a of zone.agentsArr) {
        ids.add(a.personId);
        const d = Math.hypot(a.x - focus.x, a.z - focus.z);
        const pp = prev.get(a.personId);
        if (pp && d < SEEN_RADIUS - 15 && Math.hypot(a.x - pp.x, a.z - pp.z) > 5) jumps++;
        prev.set(a.personId, { x: a.x, z: a.z });
        if (!seen.has(a.personId)) {
          seen.add(a.personId);
          if (d < 110) {
            near++;
            for (const b of sim.state.buildingsAt.get(vil.id) ?? []) { doorStand(b, door, 0); if (Math.hypot(door.x - a.x, door.z - a.z) < 4.5) { atDoor++; break; } }
          }
        }
      }
      for (const id of [...seen]) if (!ids.has(id)) { seen.delete(id); prev.delete(id); }
    }
    expect(jumps).toBe(0);
    expect(near).toBeGreaterThan(5);
    expect(atDoor / near).toBeGreaterThan(0.85);
  }, 120000);

  it('hurry only so much when behind, and keep their pace slow when there is time', () => {
    expect(MAX_HURRY).toBeGreaterThan(1.2);
    expect(MAX_HURRY).toBeLessThan(2.2);
  });
});
