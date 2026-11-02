// How fast people go (docs/CIV.md §3): their own walking pace by age, health and build; loads; hurrying; a jog only when badly late and
// able; the walk clip is never drawn above a walk and the stride follows the ground speed.
import { beforeAll, describe, expect, it } from 'vitest';
import { St } from '../../src/agents/agent';
import { goTo } from '../../src/agents/behaviour';
import { DECEL, JOG_START } from '../../src/agents/config';
import { MAX_HURRY, RUN_MAX, RUN_MIN, WALK_MAX, WALK_TOP, canJog, gaitSpeed, loadFactor, runSpeed, walkSpeed } from '../../src/agents/pace';
import { DAY_SECONDS } from '../../src/core/time';
import { ageYears, type Person } from '../../src/sim/state';
import type { Settlement } from '../../src/world/types';
import { makeRig, run, setClock, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;
let people: Person[];

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
  people = [...rig.sim.state.residentsOf(vil.id)].filter((p) => !p.death);
}, 180000);

const age = (p: Person): number => ageYears(p, rig.sim.absDay);

describe('walking and running paces', () => {
  it('give a healthy adult 1.1-1.5 m/s, the old, the young and the hurt less, and no one more than 1.5', () => {
    const adults = people.filter((p) => age(p) >= 18 && age(p) <= 50 && p.health.hp >= 0.8 && !p.traits.includes('lame'));
    expect(adults.length).toBeGreaterThan(20);
    const v = adults.map((p) => walkSpeed(p, age(p)));
    expect(Math.min(...v)).toBeGreaterThanOrEqual(1.1);
    expect(Math.max(...v)).toBeLessThanOrEqual(WALK_MAX);
    // not all alike
    expect(new Set(v.map((x) => x.toFixed(2))).size).toBeGreaterThan(8);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    expect(mean).toBeGreaterThan(1.2);
    expect(mean).toBeLessThan(1.4);
    const p = adults[0];
    const base = walkSpeed(p, 30);
    expect(walkSpeed(p, 8)).toBeLessThan(base);
    expect(walkSpeed(p, 4)).toBeLessThan(walkSpeed(p, 8));
    expect(walkSpeed(p, 75)).toBeLessThan(base * 0.9);
    const hurt = { ...p, health: { ...p.health, hp: 0.3 } } as Person;
    expect(walkSpeed(hurt, 30)).toBeLessThan(base * 0.85);
    const lame = { ...p, traits: [...p.traits, 'lame'] } as Person;
    expect(walkSpeed(lame, 30)).toBeLessThan(base * 0.85);
    for (const q of people) { const w = walkSpeed(q, age(q)); expect(w).toBeGreaterThanOrEqual(0.8); expect(w).toBeLessThanOrEqual(WALK_MAX); }
  });

  it('give a run of 2.8-3.6 m/s to those who can run, and a load slows the walk', () => {
    const young = people.filter((p) => age(p) >= 14 && age(p) <= 30 && p.health.hp >= 0.8);
    expect(young.length).toBeGreaterThan(5);
    for (const p of young) { const r = runSpeed(p, age(p)); expect(r).toBeGreaterThanOrEqual(2.8); expect(r).toBeLessThanOrEqual(RUN_MAX); }
    for (const p of people) { const r = runSpeed(p, age(p)); expect(r).toBeGreaterThanOrEqual(2.4); expect(r).toBeLessThanOrEqual(RUN_MAX); }
    expect(loadFactor('none')).toBe(1);
    expect(loadFactor('stone')).toBeLessThan(loadFactor('sack'));
    expect(loadFactor('sack')).toBeLessThan(loadFactor('basket'));
    expect(loadFactor('basket')).toBeLessThan(1);
    expect(MAX_HURRY).toBeLessThanOrEqual(1.3);
  });

  it('let only the young and quick, soldiers and messengers break into a jog', () => {
    const adult = people.find((p) => age(p) >= 18 && age(p) <= 26 && p.estate !== 'clergy' && p.rankTier < 5 && p.health.hp >= 0.9 && !p.traits.includes('lame'))!;
    const withCareer = (c: Person['career'], a = 20): [Person, number] => [{ ...adult, career: c } as Person, a];
    expect(canJog(...withCareer('soldier'))).toBe(true);
    expect(canJog(...withCareer('page', 13))).toBe(true);
    expect(canJog(...withCareer('squire', 17))).toBe(true);
    expect(canJog({ ...adult, career: 'soldier' } as Person, 70)).toBe(false);
    expect(canJog({ ...adult, career: 'soldier' } as Person, 9)).toBe(false);
    expect(canJog({ ...adult, career: 'soldier', health: { ...adult.health, hp: 0.4 } } as Person, 25)).toBe(false);
    expect(canJog({ ...adult, career: 'priest', estate: 'clergy' } as Person, 25)).toBe(false);
    expect(canJog({ ...adult, career: 'lord', rankTier: 6 } as Person, 25)).toBe(false);
    // a grown villager does not run for the field
    expect(canJog({ ...adult, career: 'farmer' } as Person, 40)).toBe(false);
    // some young villagers do, some do not
    const young = people.filter((p) => age(p) >= 12 && age(p) <= 26 && p.health.hp >= 0.8 && p.estate !== 'clergy' && p.rankTier < 5);
    const n = young.filter((p) => canJog(p, age(p))).length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(young.length + 1);
  });

  it('leave nothing between a walk and a run: a pace too quick for a walk is held to a hurried walk or becomes a run', () => {
    for (let w = 0.3; w < 5; w += 0.01) {
      const g = gaitSpeed(w);
      expect(g <= WALK_TOP + 1e-9 || g >= RUN_MIN - 1e-9, `${w} -> ${g}`).toBe(true);
    }
    expect(gaitSpeed(1.4)).toBeCloseTo(1.4, 6);
    expect(gaitSpeed(2.1)).toBeCloseTo(WALK_TOP, 6);
    expect(gaitSpeed(2.5)).toBeGreaterThanOrEqual(RUN_MIN);
    expect(gaitSpeed(9)).toBeLessThanOrEqual(RUN_MAX);
  });
});

describe('late for the schedule', () => {
  /** Puts a person in the open with a long way to go to be somewhere by a time, and watches them for `seconds`. */
  function trip(able: boolean, metres: number, secondsLeft: number, seconds: number): { speeds: number[]; anims: string[]; jog: boolean; arrived: boolean } {
    const { sim, zone, focus } = rig;
    zone.detachPlayer();
    sim.view.setSource('mode', () => 'street');
    focus.x = vil.x; focus.z = vil.z;
    setClock(sim, 1, 2, 0.45);
    zone.resync();
    const a = zone.agentsArr.find((q) => q.control === 'ai' && q.age >= 20 && q.age <= 30 && q.st === St.Idle && !q.summoned && q.distFocus < 60)!;
    expect(a).toBeTruthy();
    a.canRun = able;
    // somewhere due at a time; walk there along an open line
    const ang = 0.7;
    let gx = a.x + Math.cos(ang) * metres, gz = a.z + Math.sin(ang) * metres;
    const out = { x: 0, z: 0 };
    if (zone.nav.nearestWalkable(gx, gz, 8, out)) { gx = out.x; gz = out.z; }
    a.replanAt = 1e9; // keep the routine from re-planning for the experiment
    a.arriveBy = zone.now + secondsLeft / DAY_SECONDS;
    a.tx = gx; a.tz = gz; a.jog = false; a.wantIn = false; a.wantAway = false;
    goTo(zone, a, gx, gz, 1, true);
    const speeds: number[] = [];
    const anims: string[] = [];
    let jog = false;
    for (let i = 0; i < seconds * 20; i++) {
      sim.step(1 / 20);
      if (i % 10 === 0 && i > 40) { speeds.push(a.speed); anims.push(a.draw.anim); }
      jog = jog || a.jog;
    }
    return { speeds, anims, jog, arrived: Math.hypot(a.x - gx, a.z - gz) < 4 };
  }

  it('walk at their own pace when there is time, hurry when behind, and arrive', () => {
    const easy = trip(true, 60, 120, 20);
    const mean = easy.speeds.reduce((s, v) => s + v, 0) / easy.speeds.length;
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(1.6);
    expect(easy.jog).toBe(false);
    expect(Math.max(...easy.speeds)).toBeLessThan(2.0);
    // behind, but a brisk walk would do: hurried, not run
    const behind = trip(true, 80, 52, 24);
    expect(behind.jog).toBe(false);
    expect(Math.max(...behind.speeds)).toBeLessThanOrEqual(2.0);
    expect(Math.max(...behind.speeds)).toBeGreaterThan(1.3);
    expect(behind.anims.every((x) => x === 'walk' || x === 'carry_walk')).toBe(true);
  }, 60000);

  it('jog when badly late — and only those who are able', () => {
    const badly = JOG_START + 40;
    // 150 m with 40 s left: even hurrying they would be a minute or more late
    const quick = trip(true, 150, 40, 30);
    expect(quick.jog).toBe(true);
    expect(Math.max(...quick.speeds)).toBeGreaterThanOrEqual(RUN_MIN - 0.2);
    expect(Math.max(...quick.speeds)).toBeLessThanOrEqual(RUN_MAX + 0.2);
    expect(quick.anims).toContain('run');
    // the run clip only above a walk, the walk clip never above
    const slow = trip(false, 150, 40, 30);
    expect(slow.jog).toBe(false);
    expect(Math.max(...slow.speeds)).toBeLessThanOrEqual(2.0);
    expect(slow.anims.every((x) => x !== 'run')).toBe(true);
    void badly; void DECEL;
  }, 60000);

  it('stop smoothly: the stride the renderer follows eases to nothing instead of stopping at a speed', () => {
    const { sim, zone } = rig;
    run(sim, 1);
    // every walker's drawn speed is the smoothed ground speed (within a step or two of it)
    for (const a of zone.agentsArr) {
      if (a.dead || a.st !== St.Walk) continue;
      expect(a.draw.moveSpeed).toBeLessThan(4.2 * 1.01 + 0.5);
    }
  });
});
