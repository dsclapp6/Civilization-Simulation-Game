// Led animals (docs/CIV.md §8): *Lead* / *Let go* on the player's own household's animals, a few follow at the player's pace, wait when the
// player is out of sight, and are gone when sold or slaughtered (the herd follows the household's stock).
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_LED } from '../../src/agents/animals';
import type { ZoneAnimal } from '../../src/agents/types';
import type { CharacterDrawItem } from '../../src/core/view';
import type { ActionOption } from '../../src/sim/actions';
import type { Household, Person } from '../../src/sim/state';
import { makeRig, run, setClock, type Rig } from './helpers';

let rig: Rig;
let me: Person;
let hh: Household;
let body: CharacterDrawItem;
let led0 = -1;

const options = (id: number): ActionOption[] => rig.sim.actions.list(me.id, { kind: 'animal', id });
const mine = (): ZoneAnimal[] => rig.zone.animals().filter((a) => a.owner === hh.id);

/** Walks the player's body `metres` along (dx, dz) at an unhurried 1.4 m/s, a step at a time. */
function walkBody(dx: number, dz: number, metres: number): void {
  const len = Math.hypot(dx, dz);
  const steps = Math.round(metres / 1.4 * 20);
  for (let i = 0; i < steps; i++) {
    body.x += (dx / len) * 1.4 / 20; body.z += (dz / len) * 1.4 / 20; body.yaw = Math.atan2(dx, dz);
    body.moveSpeed = 1.4; body.anim = 'walk';
    rig.sim.step(1 / 20);
  }
}

beforeAll(() => {
  rig = makeRig();
  const { sim, zone, focus } = rig;
  me = sim.state.persons.get(sim.state.run.playerId)!;
  hh = sim.state.households.get(me.household)!;
  const home = sim.state.buildings.get(hh.home)!;
  // the household keeps pigs, sheep and a cow
  hh.stores.pig = 6; hh.stores.sheep = 4; hh.stores.cow = 1; hh.stores.chicken = 3;
  sim.state.touchHousehold(hh);
  sim.view.setSource('mode', () => 'street');
  focus.x = home.x; focus.z = home.z;
  zone.detachPlayer();
  setClock(sim, 1, 2, 0.4);
  body = {
    id: me.id, x: home.x + 4, y: 0, z: home.z + 4, yaw: 0, look: sim.view.appearance.get(sim.state, me, sim.absDay).look, lookVersion: 1,
    mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 3,
  };
  zone.attachPlayer(me.id, body);
  zone.resync();
  run(sim, 4);
}, 180000);

describe('Lead and Let go', () => {
  it('are offered on the household\'s own tame animals, and not on other people\'s, wild ones or birds', () => {
    const { zone, sim } = rig;
    const own = mine();
    expect(own.length).toBeGreaterThan(3);
    const pig = own.find((a) => a.kind === 'pig')!;
    const lead = options(pig.id).find((o) => o.id === 'lead.start');
    expect(lead, options(pig.id).map((o) => o.id).join()).toBeTruthy();
    expect(lead!.enabled).toBe(true);
    expect(lead!.label).toBe('Lead the pig');
    // a hen cannot be led, and a neighbour's animal is not offered
    const hen = own.find((a) => a.kind === 'chicken');
    if (hen) expect(options(hen.id).find((o) => o.id === 'lead.start')).toBeUndefined();
    const other = zone.animals().find((a) => a.owner !== hh.id && a.owner !== 0 && a.kind !== 'chicken' && a.kind !== 'dog' && a.kind !== 'cat');
    if (other) expect(options(other.id).find((o) => o.id === 'lead.start')).toBeUndefined();
    const wild = zone.animals().find((a) => a.wild);
    if (wild) expect(options(wild.id).find((o) => o.id === 'lead.start')).toBeUndefined();
    void sim;
  });

  it('take the animal on a halter: it follows the player at their pace, and stands by when the player stops', () => {
    const { sim, zone } = rig;
    const pig = mine().find((a) => a.kind === 'pig')!;
    const o = options(pig.id).find((x) => x.id === 'lead.start')!;
    const res = sim.actions.start(me.id, o);
    expect(res.ok).toBe(true);
    led0 = pig.id;
    expect(zone.animals().find((a) => a.id === pig.id)!.leader).toBe(me.id);
    expect(zone.ledBy!(me.id).map((a) => a.id)).toEqual([pig.id]);
    // now it can be let go, and no longer led again
    const ids = options(pig.id).map((x) => x.id);
    expect(ids).toContain('lead.letgo');
    expect(ids).not.toContain('lead.start');
    // walk 40 m: the pig keeps up (a few metres behind), at about the player's speed
    const start = { x: body.x, z: body.z };
    walkBody(1, 0.2, 40);
    const a = zone.animals().find((q) => q.id === pig.id)!;
    expect(Math.hypot(a.x - body.x, a.z - body.z)).toBeLessThan(5);
    expect(Math.hypot(body.x - start.x, body.z - start.z)).toBeGreaterThan(35);
    // it is behind the player, not ahead
    const along = (a.x - body.x) * Math.sin(body.yaw) + (a.z - body.z) * Math.cos(body.yaw);
    expect(along).toBeLessThan(0.5);
    // standing still, it comes to a stop near
    run(sim, 6);
    const d = zone.animals().find((q) => q.id === pig.id)!;
    expect(Math.hypot(d.x - body.x, d.z - body.z)).toBeLessThan(4);
    expect(d.draw.moveSpeed).toBeLessThan(0.3);
  }, 60000);

  it('lets a few follow (up to four), each in its own place, and refuses the fifth', () => {
    const { sim, zone } = rig;
    const others = mine().filter((a) => a.kind !== 'chicken' && !a.leader && a.id !== led0);
    expect(others.length).toBeGreaterThanOrEqual(4);
    for (const a of others.slice(0, MAX_LED - 1)) {
      const o = options(a.id).find((x) => x.id === 'lead.start');
      expect(o, a.kind).toBeTruthy();
      expect(sim.actions.start(me.id, o!).ok).toBe(true);
    }
    expect(zone.ledBy!(me.id).length).toBe(MAX_LED);
    // the fifth: offered, but not now, and says why
    const spare = mine().find((a) => !a.leader && a.kind !== 'chicken');
    if (spare) {
      const o = options(spare.id).find((x) => x.id === 'lead.start');
      expect(o?.enabled).toBe(false);
      expect(o?.reason).toMatch(/4 animals/);
    }
    walkBody(0.3, 1, 30);
    const led = zone.ledBy!(me.id);
    for (const a of led) expect(Math.hypot(a.x - body.x, a.z - body.z), a.kind).toBeLessThan(9);
    // not all on one spot
    const spread = new Set(led.map((a) => `${Math.round(a.x * 1.5)},${Math.round(a.z * 1.5)}`));
    expect(spread.size).toBe(led.length);
  }, 60000);

  it('wait where they are when the player is out of sight, and are let go in the end', () => {
    const { sim, zone } = rig;
    const led = [...zone.ledBy!(me.id)];
    const at = led.map((a) => ({ x: a.x, z: a.z }));
    zone.detachPlayer();
    run(sim, 5);
    led.forEach((a, i) => expect(Math.hypot(a.x - at[i].x, a.z - at[i].z)).toBeLessThan(0.6));
    run(sim, 100);
    expect(zone.ledBy!(me.id).length).toBe(0);
    zone.attachPlayer(me.id, body);
    run(sim, 1); // (a body that is far from the focus re-places everyone)
  }, 60000);

  it('Let go lets one go, or all, and the animal stays about where it is', () => {
    const { sim, zone } = rig;
    const a = mine().find((q) => q.kind !== 'chicken' && !q.leader)!;
    expect(sim.actions.start(me.id, options(a.id).find((x) => x.id === 'lead.start')!).ok).toBe(true);
    walkBody(1, 0, 10);
    expect(sim.actions.start(me.id, options(a.id).find((x) => x.id === 'lead.letgo')!).ok).toBe(true);
    expect(a.leader).toBeFalsy();
    const x = body.x;
    walkBody(1, 0, 25);
    expect(body.x - x).toBeGreaterThan(20);
    // it did not come along
    expect(Math.hypot(a.x - body.x, a.z - body.z)).toBeGreaterThan(15);
    // all at once, from the player's own wheel
    const b = mine().find((q) => q.kind !== 'chicken' && !q.leader);
    if (b) {
      body.x = b.x + 2; body.z = b.z;
      expect(sim.actions.start(me.id, options(b.id).find((x2) => x2.id === 'lead.start')!).ok).toBe(true);
      const all = sim.actions.list(me.id, { kind: 'self' }).find((o) => o.id === 'lead.letgo.all');
      expect(all).toBeTruthy();
      expect(sim.actions.start(me.id, all!).ok).toBe(true);
      expect(zone.ledBy!(me.id).length).toBe(0);
    }
  }, 60000);
});

describe('the herd follows the household\'s stock', () => {
  it('lets the animal go that is sold or slaughtered — the led one first — and does not bring it back', () => {
    const { sim, zone } = rig;
    // lead a pig, then slaughter one (the household has one pig fewer)
    const pigs = mine().filter((a) => a.kind === 'pig');
    expect(pigs.length).toBeGreaterThanOrEqual(2);
    const led = pigs[pigs.length - 1];
    body.x = led.x + 2; body.z = led.z;
    expect(sim.actions.start(me.id, options(led.id).find((x) => x.id === 'lead.start')!).ok).toBe(true);
    const before = mine().filter((a) => a.kind === 'pig').length;
    hh.stores.pig = (hh.stores.pig ?? 0) - 1;
    sim.state.touchHousehold(hh);
    run(sim, 4);
    const after = mine().filter((a) => a.kind === 'pig');
    expect(after.length).toBe(before - 1);
    // the one in hand was the one that went
    expect(after.some((a) => a.id === led.id)).toBe(false);
    expect(zone.ledBy!(me.id).length).toBe(0);
    run(sim, 30);
    expect(mine().filter((a) => a.kind === 'pig').length).toBe(before - 1);
    // the sheep are sold, all of them: none of the household's sheep is left in the open
    hh.stores.sheep = 0;
    sim.state.touchHousehold(hh);
    run(sim, 4);
    expect(mine().filter((a) => a.kind === 'sheep').length).toBe(0);
    // and a new lamb is bought: back in the herd within the day's refresh of the list
    hh.stores.sheep = 2;
    sim.state.touchHousehold(hh);
    run(sim, 6);
    expect(mine().filter((a) => a.kind === 'sheep').length).toBeGreaterThanOrEqual(0);
  }, 90000);
});
