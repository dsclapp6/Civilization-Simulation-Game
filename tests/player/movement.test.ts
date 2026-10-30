import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/time';
import { createBody, stepBody, type BodyEnv, type BodyState, type BodyTraits } from '../../src/player/body';
import {
  RIDE_GALLOP, RIDE_TROT, RIDE_WALK, RUN_SPEED, SPRINT_SPEED, WALK_SPEED, ageFactor, agilityFactor, footAnim, loadFactor, maxStamina, rideAnim,
  slopeFactor, stepStamina, workEffort,
} from '../../src/player/movement';
import { EMPTY_INPUT, type InputState } from '../../src/player/types';
import { FakeZone, input } from './fakes';

const traits = (over: Partial<BodyTraits> = {}): BodyTraits => ({
  agility: 10, endurance: 10, age: 25, ridingLevel: 0, weight: 0, capacity: 30, hunger: 1, rest: 1, ...over,
});

function walk(b: BodyState, zone: FakeZone, seconds: number, inp: Partial<InputState>, t = traits(), extra: Partial<BodyEnv> = {}): void {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    stepBody(b, { ...EMPTY_INPUT, ...inp }, { nav: zone.nav, traits: t, frozen: false, effort: 0, dodge: false, ...extra }, SIM_DT);
  }
}

describe('speeds and directions', () => {
  it('runs forward at about 3.2 m/s along the camera heading (+z at yaw 0)', () => {
    const zone = new FakeZone();
    const b = createBody(100, 100, 0, 10, 10);
    walk(b, zone, 3, { forward: 1 });
    expect(b.z - 100).toBeGreaterThan(3 * RUN_SPEED - 0.8);
    expect(b.z - 100).toBeLessThan(3 * RUN_SPEED + 0.01);
    expect(Math.abs(b.x - 100)).toBeLessThan(0.01);
    expect(b.speed).toBeCloseTo(RUN_SPEED, 1);
  });

  it('moves relative to the camera: yaw π/2 faces +x, right strafes to the camera\'s right', () => {
    const zone = new FakeZone();
    const a = createBody(0, 0, 0, 10, 10);
    walk(a, zone, 1, { forward: 1, cameraYaw: Math.PI / 2 });
    expect(a.x).toBeGreaterThan(2);
    expect(Math.abs(a.z)).toBeLessThan(0.05);
    // facing +z, "right" is west (-x) in this handedness
    const c = createBody(0, 0, 0, 10, 10);
    walk(c, zone, 1, { right: 1, cameraYaw: 0 });
    expect(c.x).toBeLessThan(-2);
    expect(Math.abs(c.z)).toBeLessThan(0.05);
  });

  it('does not move faster diagonally', () => {
    const zone = new FakeZone();
    const a = createBody(0, 0, 0, 10, 10);
    walk(a, zone, 2, { forward: 1, right: 1 });
    const d = Math.hypot(a.x, a.z);
    const b = createBody(0, 0, 0, 10, 10);
    walk(b, zone, 2, { forward: 1 });
    expect(d).toBeLessThan(Math.hypot(b.x, b.z) + 0.05);
  });

  it('walks slowly when walk is toggled, sprints with shift', () => {
    const zone = new FakeZone();
    const w = createBody(0, 0, 0, 10, 10);
    walk(w, zone, 2, { forward: 1, walk: true });
    expect(w.speed).toBeCloseTo(WALK_SPEED, 1);
    const s = createBody(0, 0, 0, 10, 10);
    walk(s, zone, 2, { forward: 1, sprint: true });
    expect(s.speed).toBeCloseTo(SPRINT_SPEED, 1);
    expect(s.gait).toBe('sprint');
  });

  it('turns toward the movement direction instead of snapping', () => {
    const zone = new FakeZone();
    const b = createBody(0, 0, 0, 10, 10);
    walk(b, zone, SIM_DT, { forward: 1, cameraYaw: Math.PI });
    expect(Math.abs(b.yaw)).toBeGreaterThan(0.3);
    expect(Math.abs(b.yaw)).toBeLessThan(Math.PI * 0.5);
    walk(b, zone, 0.6, { forward: 1, cameraYaw: Math.PI });
    expect(Math.abs(Math.abs(b.yaw) - Math.PI)).toBeLessThan(0.05);
  });

  it('agility, age, load, slope and wading change the pace', () => {
    expect(agilityFactor(18)).toBeCloseTo(1.12, 2);
    expect(agilityFactor(10)).toBe(1);
    expect(agilityFactor(5)).toBeCloseTo(0.9, 2);
    expect(ageFactor(6)).toBeLessThan(1);
    expect(ageFactor(12)).toBe(1);
    expect(ageFactor(30)).toBe(1);
    expect(ageFactor(70)).toBeLessThan(0.85);
    expect(loadFactor(5, 30)).toBe(1);
    expect(loadFactor(30, 30)).toBeCloseTo(0.5, 1);
    expect(slopeFactor(0.3)).toBeLessThan(0.8);
    expect(slopeFactor(0)).toBe(1);

    const zone = new FakeZone();
    const fast = createBody(0, 0, 0, 10, 10);
    walk(fast, zone, 2, { forward: 1 }, traits({ agility: 18 }));
    const slow = createBody(0, 0, 0, 10, 10);
    walk(slow, zone, 2, { forward: 1 }, traits({ agility: 6 }));
    expect(fast.z).toBeGreaterThan(slow.z * 1.1);

    const hill = new FakeZone();
    hill.heightFn = (_x, z) => 10 + z * 0.3;
    const up = createBody(0, 0, 0, 10, 10);
    walk(up, hill, 2, { forward: 1 });
    expect(up.z).toBeLessThan(slow.z + 3);
    expect(up.speed).toBeLessThan(RUN_SPEED * 0.85);

    const ford = new FakeZone();
    ford.water = [{ x0: -50, z0: -50, x1: 50, z1: 50 }];
    const wade = createBody(0, 0, 0, 10, 10);
    walk(wade, ford, 2, { forward: 1 });
    expect(wade.wading).toBe(true);
    expect(wade.speed).toBeLessThan(RUN_SPEED * 0.7);
  });
});

describe('collisions and ground', () => {
  it('stops at a wall, never ends inside it, and the legs stop too', () => {
    const zone = new FakeZone();
    zone.walls = [{ x0: -5, z0: 10, x1: 5, z1: 12 }];
    const b = createBody(0, 0, 0, 10, 10);
    walk(b, zone, 6, { forward: 1 });
    expect(b.z).toBeLessThanOrEqual(10 - 0.35 + 0.01);
    expect(b.z).toBeGreaterThan(9);
    expect(b.speed).toBeLessThan(0.5);
    expect(b.blocked).toBe(true);
  });

  it('slides along a wall when walking diagonally into it', () => {
    const zone = new FakeZone();
    zone.walls = [{ x0: -5, z0: 10, x1: 50, z1: 12 }];
    const b = createBody(0, 9, 0, 10, 10);
    walk(b, zone, 2, { forward: 1, right: -1, cameraYaw: 0 }); // forward + left: +z and +x
    expect(b.x).toBeGreaterThan(2);
    expect(b.z).toBeLessThanOrEqual(10);
  });

  it('follows the ground height', () => {
    const zone = new FakeZone();
    zone.heightFn = (x) => 5 + x * 0.1;
    const b = createBody(0, 0, 0, 5, 10);
    walk(b, zone, 2, { forward: 1, cameraYaw: Math.PI / 2 });
    expect(b.y).toBeCloseTo(5 + b.x * 0.1, 3);
  });
});

describe('stamina', () => {
  it('sets the pool by endurance', () => {
    expect(maxStamina(10)).toBe(100);
    expect(maxStamina(18)).toBeGreaterThan(maxStamina(8));
  });

  it('drains while sprinting, forces a walk when exhausted, and recovers at rest', () => {
    const zone = new FakeZone();
    const b = createBody(0, 0, 0, 10, 10);
    walk(b, zone, 4, { forward: 1, sprint: true });
    expect(b.stamina.value).toBeLessThan(100 - 12 * 3.5);
    expect(b.stamina.exhausted).toBe(false);
    walk(b, zone, 6, { forward: 1, sprint: true });
    expect(b.stamina.exhausted).toBe(true);
    expect(b.stamina.value).toBeLessThan(25);
    expect(b.gait).toBe('walk');
    expect(b.speed).toBeLessThan(WALK_SPEED + 0.05);
    // stand still: out of breath until a quarter of the pool is back
    walk(b, zone, 2, {});
    expect(b.stamina.value).toBeGreaterThan(10);
    walk(b, zone, 1.5, {});
    expect(b.stamina.exhausted).toBe(false);
    walk(b, zone, 12, {});
    expect(b.stamina.value).toBe(100);
  });

  it('hunger slows recovery and heavy work drains the pool', () => {
    const fed = { value: 0, max: 100, exhausted: true };
    const hungry = { value: 0, max: 100, exhausted: true };
    stepStamina(fed, { dt: 1, sprinting: false, galloping: false, moving: false, sitting: false, effort: 0, hunger: 1, rest: 1 });
    stepStamina(hungry, { dt: 1, sprinting: false, galloping: false, moving: false, sitting: false, effort: 0, hunger: 0.1, rest: 1 });
    expect(hungry.value).toBeLessThan(fed.value);
    const worker = { value: 50, max: 100, exhausted: false };
    stepStamina(worker, { dt: 10, sprinting: false, galloping: false, moving: false, sitting: false, effort: workEffort('work_hoe'), hunger: 1, rest: 1 });
    expect(worker.value).toBeCloseTo(50 - 9, 3);
    expect(workEffort('talk')).toBe(0);
  });
});

describe('riding', () => {
  it('rides at walk, trot (default) and gallop speeds', () => {
    const zone = new FakeZone();
    const mk = (): BodyState => { const b = createBody(0, 0, 0, 10, 10); b.mounted = { animal: 1, coat: 0x7a5032, claimed: true }; return b; };
    const w = mk(); walk(w, zone, 4, { forward: 1, walk: true });
    expect(w.speed).toBeCloseTo(RIDE_WALK, 1);
    const t = mk(); walk(t, zone, 4, { forward: 1 });
    expect(t.speed).toBeCloseTo(RIDE_TROT, 1);
    const g = mk(); walk(g, zone, 8, { forward: 1, sprint: true });
    expect(g.speed).toBeCloseTo(RIDE_GALLOP, 0);
    expect(g.gait).toBe('gallop');
  });

  it('turns on a wide circle and cannot strafe', () => {
    const zone = new FakeZone();
    const b = createBody(0, 0, 0, 10, 10);
    b.mounted = { animal: 1, coat: 0, claimed: true };
    walk(b, zone, 3, { forward: 1 });
    const y0 = b.yaw;
    walk(b, zone, SIM_DT * 2, { forward: 1, cameraYaw: Math.PI });
    expect(Math.abs(b.yaw - y0)).toBeLessThan(0.5);
  });

  it('holds the rider still while the mount clip plays', () => {
    const zone = new FakeZone();
    const b = createBody(0, 0, 0, 10, 10);
    b.mounted = { animal: 1, coat: 0, claimed: true };
    b.lock = { kind: 'mount', t: 0, dur: 1.7 };
    walk(b, zone, 1, { forward: 1 });
    expect(b.z).toBe(0);
    walk(b, zone, 1, { forward: 1 });
    expect(b.lock).toBeNull();
    expect(b.z).toBeGreaterThan(0);
  });
});

describe('dodge and animation choice', () => {
  it('rolls a couple of metres, costs stamina and has a cooldown', () => {
    const zone = new FakeZone();
    const b = createBody(0, 0, 0, 10, 10);
    stepBody(b, input({ forward: 1 }), { nav: zone.nav, traits: traits(), frozen: false, effort: 0, dodge: true }, SIM_DT);
    expect(b.dodgeT).toBeGreaterThan(0);
    walk(b, zone, 0.6, { forward: 1 });
    expect(b.z).toBeGreaterThan(1.2);
    expect(b.stamina.value).toBeLessThan(100);
    const z = b.z;
    stepBody(b, input({ forward: 1 }), { nav: zone.nav, traits: traits(), frozen: false, effort: 0, dodge: true }, SIM_DT);
    expect(b.dodgeT).toBe(0);
    expect(b.z - z).toBeLessThan(0.3);
  });

  it('picks locomotion clips from the speed', () => {
    expect(footAnim(0, false)).toBe('idle');
    expect(footAnim(1.4, false)).toBe('walk');
    expect(footAnim(1.4, true)).toBe('carry_walk');
    expect(footAnim(3.2, false)).toBe('run');
    expect(footAnim(5.5, false)).toBe('sprint');
    expect(rideAnim(0).horse).toBe('idle');
    expect(rideAnim(1.7).horse).toBe('walk');
    expect(rideAnim(4).horse).toBe('trot');
    expect(rideAnim(11).horse).toBe('gallop');
  });
});
