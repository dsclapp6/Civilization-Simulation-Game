// Hold F calls the household's horse (docs/CIV.md §9): it trots to its owner from where it stands in the zone, or comes in from the edge
// of sight when it was stabled for the night or is far off; it stands by him, answers only to its own household, and is not found when
// the household keeps none or it is out of earshot. Led animals carry their leader (the halter rope).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CALL_EDGE, CALL_REACH } from '../../src/agents/animals';
import { HORSE_TROT } from '../../src/agents/pace';
import type { CharacterDrawItem } from '../../src/core/view';
import type { Household, Person } from '../../src/sim/state';
import { makeRig, run, setClock, type Rig } from './helpers';

let rig: Rig;
let me: Person;
let hh: Household;
let body: CharacterDrawItem;
let home: { x: number; z: number };

const horses = () => rig.zone.animals().filter((a) => a.kind === 'horse' && a.owner === hh.id);
/** The household's horse in the macro description: where it stands by day (the pasture) and where it is stabled (the yard). */
const spec = () => (rig.zone.fauna as unknown as { livestockOf(h: Household, s: number): Array<{ kind: string; homeX: number; homeZ: number; grazeX: number; grazeZ: number; hasGraze: boolean }> })
  .livestockOf(hh, hh.settlement).find((s) => s.kind === 'horse')!;

beforeAll(() => {
  rig = makeRig();
  const { sim } = rig;
  me = sim.state.persons.get(sim.state.run.playerId)!;
  hh = sim.state.households.get(me.household)!;
  const b = sim.state.buildings.get(hh.home)!;
  home = { x: b.x, z: b.z };
  body = {
    id: me.id, x: b.x + 5, y: 0, z: b.z + 5, yaw: 0, look: sim.view.appearance.get(sim.state, me, sim.absDay).look, lookVersion: 1,
    mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 3,
  };
}, 180000);

beforeEach(() => {
  const { sim, zone, focus } = rig;
  hh.stores['horse#1'] = 1;
  sim.state.touchHousehold(hh);
  sim.view.setSource('mode', () => 'street');
  zone.detachPlayer();
  body.x = home.x + 5; body.z = home.z + 5; body.moveSpeed = 0;
  focus.x = home.x; focus.z = home.z;
  setClock(sim, 1, 2, 0.4);
  zone.attachPlayer(me.id, body);
  zone.resync();
  run(sim, 3);
});

describe('calling the horse', () => {
  it('a horse that stands in the zone trots to its owner (never faster than a trot) and stands by him', () => {
    const { zone, sim, focus } = rig;
    // by day the horse grazes on the pasture: the owner goes there, sees it, and walks off from it
    const g = spec();
    expect(g.hasGraze).toBe(true);
    body.x = g.grazeX + 6; body.z = g.grazeZ; focus.x = body.x; focus.z = body.z;
    zone.resync();
    run(sim, 3);
    const h = horses()[0];
    expect(h).toBeDefined();
    body.x = h.x + 80; body.z = h.z + 30;
    run(sim, 1);
    const far = Math.hypot(h.x - body.x, h.z - body.z);
    expect(far).toBeGreaterThan(60);
    const res = zone.callHorse!(me.id);
    expect(res.ok).toBe(true);
    expect(res.animal).toBe(h.id);
    expect(res.eta).toBeGreaterThan(10);
    let top = 0;
    let t = -1;
    for (let i = 0; i < 20 * 80; i++) {
      sim.step(1 / 20);
      top = Math.max(top, h.draw.moveSpeed);
      if (t < 0 && Math.hypot(h.x - body.x, h.z - body.z) < 3) t = i / 20;
    }
    expect(t).toBeGreaterThan(0);
    // it came at about the ETA it was promised (a path is longer than the straight line)
    expect(t).toBeLessThan(res.eta! * 2.2 + 10);
    expect(top).toBeLessThanOrEqual(HORSE_TROT * 1.25);
    expect(top).toBeGreaterThan(2.4);
    expect(Math.hypot(h.x - body.x, h.z - body.z)).toBeLessThan(3.2);
    expect(h.draw.anim).toBe('idle');
  }, 90000);

  it('a horse stabled for the night comes in from the edge of sight, after the time its ride takes', () => {
    const { zone, sim, world } = rig;
    // the owner is at the far side of the village; the horse is not in the zone (folded away at night)
    setClock(sim, 1, 2, 0.02);
    zone.resync();
    run(sim, 2);
    expect(horses().length).toBe(0);
    const stable = spec();
    body.x = stable.homeX + 300; body.z = stable.homeZ;
    focus_to(body);
    const res = zone.callHorse!(me.id);
    expect(res.ok).toBe(true);
    expect(res.eta).toBeGreaterThan(30);
    expect(res.eta).toBeLessThan(120);
    // it is not there at once; then it appears at about the edge of sight, in the direction of the stable
    run(sim, 1);
    expect(horses().length).toBe(0);
    let seenAt = -1;
    let d0 = 0;
    for (let i = 0; i < 20 * 60 && seenAt < 0; i++) {
      sim.step(1 / 20);
      const h = horses()[0];
      if (h) { seenAt = i / 20; d0 = Math.hypot(h.x - body.x, h.z - body.z); }
    }
    expect(seenAt).toBeGreaterThan(0);
    expect(d0).toBeGreaterThan(CALL_EDGE - 30);
    expect(d0).toBeLessThan(CALL_EDGE + 30);
    // and trots up
    run(sim, 70);
    expect(Math.hypot(horses()[0].x - body.x, horses()[0].z - body.z)).toBeLessThan(4);
    void world;
  }, 120000);

  it('is refused when the household keeps no horse, and when the owner is out of earshot', () => {
    const { zone, sim } = rig;
    delete hh.stores['horse#1'];
    sim.state.touchHousehold(hh);
    run(sim, 2);
    expect(zone.callHorse!(me.id)).toMatchObject({ ok: false });
    expect(zone.callHorse!(me.id).reason).toMatch(/no horse/);
    hh.stores['horse#1'] = 1;
    sim.state.touchHousehold(hh);
    setClock(sim, 1, 2, 0.02);
    zone.resync();
    run(sim, 2);
    // far from the stable: more than the whistle carries
    const stable2 = spec();
    body.x = stable2.homeX + CALL_REACH + 400; body.z = stable2.homeZ;
    focus_to(body);
    const res = zone.callHorse!(me.id);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/too far/);
  }, 60000);

  it('a horse the player mounts stops answering the call (the saddle is his now)', () => {
    const { zone, sim, focus } = rig;
    const g = spec();
    body.x = g.grazeX + 6; body.z = g.grazeZ; focus.x = body.x; focus.z = body.z;
    zone.resync();
    run(sim, 3);
    const h = horses()[0];
    expect(h).toBeDefined();
    zone.callHorse!(me.id);
    expect(zone.claimAnimal!(h.id)).toBe(true);
    run(sim, 2);
    // a claimed horse is not drawn and not simulated
    expect(sim.view.animals().some((a) => a.id === h.id)).toBe(false);
    body.x += 40;
    zone.releaseAnimal!(h.id, body.x, body.z, 0);
    run(sim, 6);
    // it stands where it was set down and grazes: it does not trot after its owner
    expect(Math.hypot(h.x - (body.x - 0), h.z - body.z)).toBeLessThan(9);
  }, 60000);
});

describe('led animals carry their leader', () => {
  it('the halter rope is drawn from the leader\'s hand: the animal\'s draw item names the leader\'s draw item', () => {
    const { zone, sim } = rig;
    hh.stores.pig = 3;
    sim.state.touchHousehold(hh);
    zone.resync();
    run(sim, 3);
    const pig = zone.animals().find((a) => a.kind === 'pig' && a.owner === hh.id)!;
    expect(pig).toBeDefined();
    expect(pig.draw.ledBy).toBeUndefined();
    const res = zone.leadAnimal!(pig.id, me.id);
    expect(res.ok).toBe(true);
    expect(pig.draw.ledBy).toBe(me.id);
    expect(body.id).toBe(me.id);
    expect(zone.releaseLed!(pig.id)).toBe(true);
    expect(pig.draw.ledBy).toBeUndefined();
    delete hh.stores.pig;
  }, 60000);
});

/** The camera and the zone's focus follow the body. */
function focus_to(b: CharacterDrawItem): void {
  rig.focus.x = b.x; rig.focus.z = b.z;
  rig.zone.resync();
  run(rig.sim, 2);
}
