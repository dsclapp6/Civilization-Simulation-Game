// The zone side of the patrol (docs/CIV.md §3, §4): summoned riders are drawn on horses and move at the horse's gaits (walk 1.7, trot 3.5,
// canter 6, gallop 10 m/s), never faster, never warping; they ride up to a person who is moving, halt a few metres from him, keep his pace
// when escorting, and ride away; men afoot jog up. Nothing in sight moves faster than its gait allows.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HORSE_CANTER, HORSE_GALLOP, HORSE_TROT, HORSE_WALK, horseSpeed, rideClips } from '../../src/agents/pace';
import type { CharacterDrawItem } from '../../src/core/view';
import type { Settlement } from '../../src/world/types';
import { makeRig, run, setClock, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;
let body: CharacterDrawItem;
let meId = 0;

/** Three men of the village: the first two ride, the third is on foot. */
function men(): number[] {
  const out: number[] = [];
  for (const p of rig.sim.state.residentList(vil.id)) {
    if (p.sex !== 'm' || p.id === meId || rig.sim.absDay - p.birthDay < 16 * 20 || rig.sim.absDay - p.birthDay > 16 * 50 || p.health.hp < 0.8) continue;
    out.push(p.id);
    if (out.length === 3) break;
  }
  return out;
}

/** Places the player's body at (x, z) — the draw item the zone reads — and moves it by (dx, dz) metres each step if asked. */
function stand(x: number, z: number): void { body.x = x; body.z = z; body.moveSpeed = 0; body.anim = 'idle'; }

beforeAll(() => {
  rig = makeRig();
  const me = rig.sim.state.persons.get(rig.sim.state.run.playerId)!;
  meId = me.id;
  vil = village(rig.world, rig.zone);
  body = {
    id: me.id, x: vil.x, y: 0, z: vil.z, yaw: 0, look: rig.sim.view.appearance.get(rig.sim.state, me, rig.sim.absDay).look, lookVersion: 1,
    mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 3,
  };
}, 180000);

beforeEach(() => {
  const { sim, zone, focus } = rig;
  sim.view.setSource('mode', () => 'street');
  zone.detachPlayer();
  focus.x = vil.x; focus.z = vil.z;
  setClock(sim, 1, 2, 0.4);
  stand(vil.x, vil.z + 30);
  zone.attachPlayer(meId, body);
  zone.resync();
  run(sim, 1);
});

describe('the gaits of a horse', () => {
  it('are the design\'s: walk 1.7, trot 3.5, canter 6, gallop 10 m/s, with a clip for each', () => {
    expect([HORSE_WALK, HORSE_TROT, HORSE_CANTER, HORSE_GALLOP]).toEqual([1.7, 3.5, 6, 10]);
    expect(horseSpeed('walk')).toBe(1.7);
    expect(horseSpeed('trot')).toBe(3.5);
    expect(horseSpeed('canter')).toBe(6);
    expect(horseSpeed('gallop')).toBe(10);
    expect(rideClips(0)).toEqual({ rider: 'ride_idle', horse: 'idle' });
    expect(rideClips(1.7)).toEqual({ rider: 'ride_walk', horse: 'walk' });
    expect(rideClips(3.5)).toEqual({ rider: 'ride_trot', horse: 'trot' });
    expect(rideClips(6).rider).toBe('ride_gallop');
    expect(rideClips(10).horse).toBe('gallop');
  });
});

describe('riders', () => {
  it('are drawn on horses, ride up to a man who stands, and halt a few metres from him; men afoot jog up and halt too', () => {
    const { zone, sim } = rig;
    const [a, b, c] = men();
    const target = { x: body.x, z: body.z };
    // from 150 m away, along the open way
    const start = { x: target.x - 150, z: target.z };
    zone.summon!(a, start.x, start.z, 0, { mounted: true, coat: 0x5a3a22, main: 'lance' });
    zone.summon!(b, start.x - 2, start.z + 2, 0, { mounted: true, main: 'spear' });
    zone.summon!(c, start.x - 4, start.z - 2, 0, { main: 'spear' });
    for (const [id, d] of [[a, 3.4], [b, 5], [c, 6.2]] as const) zone.command(id, { kind: 'approach', target: meId, distance: d, gait: id === c ? 'jog' : 'gallop' });
    const A = zone.agent(a)!, B = zone.agent(b)!, C = zone.agent(c)!;
    expect(A.draw.mount).toBeDefined();
    expect(C.draw.mount).toBeUndefined();
    expect(A.draw.mainHand).toBe('lance');
    // sample the ground speed every step: never faster than the gait, never a jump in sight
    let maxA = 0, maxC = 0, jump = 0;
    let px = A.x, pz = A.z;
    let tA = -1, tC = -1;
    for (let i = 0; i < 20 * 80; i++) {
      sim.step(1 / 20);
      const d = Math.hypot(A.x - px, A.z - pz);
      jump = Math.max(jump, d);
      maxA = Math.max(maxA, d * 20);
      px = A.x; pz = A.z;
      maxC = Math.max(maxC, C.speed);
      if (tA < 0 && Math.hypot(A.x - target.x, A.z - target.z) < 3.4 + 1.5) tA = i / 20;
      if (tC < 0 && Math.hypot(C.x - target.x, C.z - target.z) < 6.2 + 1.5) tC = i / 20;
    }
    expect(maxA).toBeLessThanOrEqual(HORSE_GALLOP * 1.12 + 0.4);
    expect(maxA).toBeGreaterThan(HORSE_CANTER);
    expect(jump).toBeLessThan(0.6);
    expect(tA).toBeGreaterThan(0);
    expect(tA).toBeLessThan(40);
    // the man afoot jogs (2.8–3.6), the rider is up long before
    expect(maxC).toBeLessThanOrEqual(3.8);
    expect(tC).toBeGreaterThan(tA);
    // halted near the man, facing him
    expect(Math.hypot(A.x - target.x, A.z - target.z)).toBeLessThan(3.4 + 1.6);
    expect(Math.hypot(B.x - target.x, B.z - target.z)).toBeLessThan(5 + 2);
    expect(A.draw.anim).toBe('ride_idle');
    expect(A.draw.mount!.anim).toBe('idle');
    const want = Math.atan2(target.x - A.x, target.z - A.z);
    expect(Math.abs(Math.atan2(Math.sin(A.yaw - want), Math.cos(A.yaw - want)))).toBeLessThan(0.5);
    expect(zone.agent(a)!.draw.moveSpeed).toBeLessThan(0.2);
  }, 90000);

  it('show the gallop clip when they gallop, the trot as they close, and walk the last paces', () => {
    const { zone, sim } = rig;
    const [a] = men();
    zone.summon!(a, body.x - 120, body.z, 0, { mounted: true });
    zone.command(a, { kind: 'approach', target: meId, distance: 3, gait: 'gallop' });
    const A = zone.agent(a)!;
    const seen = new Set<string>();
    for (let i = 0; i < 20 * 40; i++) { sim.step(1 / 20); if (A.draw.mount) seen.add(`${A.draw.anim}|${A.draw.mount.anim}`); }
    expect(seen.has('ride_gallop|gallop')).toBe(true);
    expect(seen.has('ride_trot|trot')).toBe(true);
    expect(seen.has('ride_idle|idle')).toBe(true);
  }, 60000);

  it('follow a man who walks at his pace (1.4 m/s), a few metres behind, without running ahead or losing him', () => {
    const { zone, sim } = rig;
    const [a, b] = men();
    zone.summon!(a, body.x - 8, body.z, 0, { mounted: true });
    zone.summon!(b, body.x - 10, body.z + 2, 0, { mounted: true });
    zone.command(a, { kind: 'follow', leader: meId, distance: 6 });
    zone.command(b, { kind: 'follow', leader: meId, distance: 7.4 });
    const A = zone.agent(a)!;
    let top = 0;
    const gaps: number[] = [];
    for (let i = 0; i < 20 * 50; i++) {
      // the man walks east at 1.4 m/s
      body.x += 1.4 / 20; body.moveSpeed = 1.4; body.anim = 'walk'; body.yaw = Math.PI / 2;
      sim.step(1 / 20);
      if (i > 20 * 12) { top = Math.max(top, A.speed); gaps.push(Math.hypot(A.x - body.x, A.z - body.z)); }
    }
    expect(Math.max(...gaps)).toBeLessThan(12);
    expect(Math.min(...gaps)).toBeGreaterThan(2);
    // while escorting they never go faster than a walk's worth of pace and a little (never a canter)
    expect(top).toBeLessThan(HORSE_TROT);
    expect(A.draw.mount!.anim === 'walk' || A.draw.mount!.anim === 'idle' || A.draw.mount!.anim === 'trot').toBe(true);
  }, 60000);

  it('ride off and are gone when dismissed, and do not turn up at their posts in plain sight a moment later', () => {
    const { zone, sim } = rig;
    const [a] = men();
    zone.summon!(a, body.x - 40, body.z, 0, { mounted: true });
    expect(zone.agent(a)).not.toBeNull();
    zone.dismiss!(a);
    run(sim, 0.2);
    expect(zone.agent(a)).toBeNull();
    run(sim, 6);
    expect(zone.agent(a)).toBeNull();
  });

  it('a rider told to go to a point gallops there at the ordered gait and stops', () => {
    const { zone, sim } = rig;
    const [a] = men();
    zone.summon!(a, body.x + 100, body.z, 0, { mounted: true });
    zone.command(a, { kind: 'goto', x: body.x + 20, z: body.z, gait: 'canter' });
    const A = zone.agent(a)!;
    let top = 0;
    for (let i = 0; i < 20 * 40; i++) { sim.step(1 / 20); top = Math.max(top, A.speed); }
    expect(top).toBeLessThanOrEqual(HORSE_CANTER * 1.12 + 0.4);
    expect(top).toBeGreaterThan(HORSE_TROT);
    expect(Math.hypot(A.x - (body.x + 20), A.z - body.z)).toBeLessThan(3);
  }, 60000);
});
