// The law in the real detail zone (docs/CIV.md §4, docs/LAW.md): the real zone, the real territory and the real law, with a body we move
// for the player and a combat module that only records. A trespasser on the lord's closes is reported, riders appear at the edge of sight
// and gallop up (never faster than a gallop, never warping), halt him, see him off the land at his own pace (or lead him, bound, to the
// lock-up), and go home. This is where the pieces meet: the fakes of tests/sim/law cannot show a wrong order, a bad spawn point or a rider
// that gets stuck in the village.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HORSE_GALLOP } from '../../src/agents/pace';
import { BUILDINGS } from '../../src/content/types';
import type { ZoneAgent } from '../../src/agents/types';
import type { CharacterDrawItem } from '../../src/core/view';
import type { PlayerApi, Restraint } from '../../src/player/types';
import { installLaw, lawContext } from '../../src/sim/law';
import { LAW } from '../../src/sim/law/config';
import type { LawRuntime } from '../../src/sim/law/types';
import type { SimEvents } from '../../src/sim/events';
import { installTerritory } from '../../src/sim/territory';
import type { TerritoryRuntime } from '../../src/sim/territory/types';
import type { Settlement } from '../../src/world/types';
import { FakeCombat } from '../sim/law/helpers';
import { makeRig, setClock, type Rig } from './helpers';

/** The player's body for the law: the draw item the zone reads, moved by the test; the restraint is what the law set. */
class BodyPlayer {
  bound: Restraint | null = null;
  constructor(readonly draw: CharacterDrawItem) {}
  body(): CharacterDrawItem { return this.draw; }
  restrain(r: Restraint | null): void { this.bound = r; }
  restraint(): Restraint | null { return this.bound; }
  placeAt(x: number, z: number, yaw?: number): void { this.draw.x = x; this.draw.z = z; if (yaw !== undefined) this.draw.yaw = yaw; }
}

let rig: Rig;
let terr: TerritoryRuntime;
let law: LawRuntime;
let player: BodyPlayer;
let combat: FakeCombat;
let me = 0;
let vil: Settlement;
let spot: { x: number; z: number };
const events: Array<SimEvents['trespass']> = [];

/** A village with a manor court and a lord of another House, and a point of the lord's closes where the player is a trespasser. */
function findStage(): { vil: Settlement; spot: { x: number; z: number } } {
  const { sim, world, zone } = rig;
  for (const s of world.settlements) {
    if (s.kind !== 'village' || !zone.places.of(s.id)) continue;
    const manor = (sim.state.buildingsAt.get(s.id) ?? []).find((b) => b.kind === 'manor_house' && b.construction >= 1);
    if (!manor) continue;
    for (let r = 10; r <= 70; r += 10) {
      for (let a = 0; a < 16; a++) {
        const x = manor.x + Math.sin(a * 0.39) * r, z = manor.z + Math.cos(a * 0.39) * r;
        if (terr.trespass(me, x, z).level === 'private' && zone.nav.walkable(x, z)) return { vil: s, spot: { x, z } };
      }
    }
  }
  throw new Error('no stage for the law');
}

beforeAll(() => {
  rig = makeRig();
  const { sim, zone, social, economy } = rig;
  me = sim.state.run.playerId;
  terr = installTerritory(sim, { social, economy });
  combat = new FakeCombat();
  sim.services.combat = combat;
  const person = sim.state.persons.get(me)!;
  const draw: CharacterDrawItem = {
    id: me, x: 0, y: 0, z: 0, yaw: 0, look: sim.view.appearance.get(sim.state, person, sim.absDay).look, lookVersion: 1,
    mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 3,
  };
  player = new BodyPlayer(draw);
  law = installLaw(sim, { economy, social, zone, player: player as unknown as PlayerApi });
  sim.events.on('trespass', (e) => events.push(e));
  ({ vil, spot } = findStage());
  // the player is a stranger to the lord's land and has no business on it
  person.money = 200;
}, 240000);

beforeEach(() => {
  const { sim, zone, focus } = rig;
  sim.view.setSource('mode', () => 'street');
  zone.detachPlayer();
  const C = lawContext(sim);
  for (const rec of [...C.law.store.data.captives]) C.law.store.remove(rec);
  C.patrol.clear();
  C.patrol.escorted.clear();
  C.law.store.data.wanted.length = 0;
  C.law.store.data.offences.length = 0;
  C.watch.reset();
  sim.state.persons.get(me)!.flags.captive = undefined as never;
  delete sim.state.persons.get(me)!.flags.captive;
  player.bound = null;
  events.length = 0;
  setClock(sim, 1, 2, 0.45);
  player.draw.x = spot.x; player.draw.z = spot.z; player.draw.moveSpeed = 0; player.draw.anim = 'idle';
  focus.x = spot.x; focus.z = spot.z;
  zone.attachPlayer(me, player.draw);
  zone.resync();
  for (let i = 0; i < 40; i++) sim.step(1 / 20);
});

/** One 20 Hz step, with the speeds and displacements of everyone the law sent recorded. */
function stepper(): { step(): void; top: number; jump: number; riders: Set<number> } {
  const last = new Map<number, { x: number; z: number }>();
  const o = { top: 0, jump: 0, riders: new Set<number>() } as { top: number; jump: number; riders: Set<number>; step(): void };
  o.step = () => {
    rig.sim.step(1 / 20);
    const p = law.patrolFor(me);
    if (!p) return;
    for (const id of [p.leader, ...p.men]) {
      const a = rig.zone.agent(id);
      if (!a) { last.delete(id); continue; }
      o.riders.add(id);
      const was = last.get(id);
      if (was) {
        const d = Math.hypot(a.x - was.x, a.z - was.z);
        o.jump = Math.max(o.jump, d);
        o.top = Math.max(o.top, d * 20);
      }
      last.set(id, { x: a.x, z: a.z });
    }
  };
  return o;
}

const dist = (a: ZoneAgent, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

describe('a trespasser on the lord\'s closes, in the real zone', () => {
  it('is on private land to begin with, and a patrol rides in from the edge of sight and halts him within a minute', () => {
    expect(terr.trespass(me, spot.x, spot.z).level).toBe('private');
    expect(law.report(me, spot.x, spot.z)).toBe(true);
    const p0 = law.patrolFor(me)!;
    expect(p0.phase).toBe('coming');
    const s = stepper();
    s.step();
    // they are in the zone, at the edge of sight, inside the no-warp radius
    const lead0 = rig.zone.agent(p0.leader)!;
    expect(lead0).toBeTruthy();
    const d0 = dist(lead0, player.draw);
    expect(d0).toBeGreaterThan(110);
    expect(d0).toBeLessThan(200);
    let t = 0;
    while (t < 90 && law.patrolFor(me)!.phase === 'coming') { s.step(); t += 1 / 20; }
    const p = law.patrolFor(me)!;
    expect(p.phase).toBe('halt');
    // a gallop is 10 m/s, a jog 3 m/s: it can take a minute over broken ground, but not much more
    expect(t).toBeLessThan(60);
    const lead = rig.zone.agent(p.leader)!;
    expect(dist(lead, player.draw)).toBeLessThan(LAW.haltDistance + 2.4);
    // nobody went faster than the horse allows, nobody warped
    expect(s.top).toBeLessThanOrEqual(HORSE_GALLOP * 1.12);
    expect(s.jump).toBeLessThan(0.85);
    // the words are the design's, said by the leader
    expect(p.line).toMatch(/^Halt\./);
    expect(rig.sim.state.clock.actionTime).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(['warned']);
    // and the men stand about him, none inside him
    for (const id of p.men) expect(dist(rig.zone.agent(id)!, player.draw)).toBeGreaterThan(1.0);
  }, 120000);

  it('Leave: they follow him at his pace to the edge of the land, he is let go there, and they ride home and are gone', () => {
    law.report(me, spot.x, spot.z);
    const s = stepper();
    while (law.patrolFor(me)!.phase === 'coming') s.step();
    expect(law.answerPatrol(me, 'leave').ok).toBe(true);
    const p = law.patrolFor(me)!;
    expect(p.phase).toBe('escort');
    expect(p.exit).not.toBeNull();
    const startDeadline = p.deadline;
    expect(startDeadline).toBeGreaterThanOrEqual(45);
    // he walks to the exit at 1.4 m/s; the men keep behind him
    let widest = 0;
    let t = 0;
    while (law.patrolFor(me)?.phase === 'escort' && t < startDeadline + 5) {
      const q = law.patrolFor(me)!;
      const ex = q.exit ?? p.exit!;
      const dx = ex.x - player.draw.x, dz = ex.z - player.draw.z;
      const d = Math.hypot(dx, dz);
      const v = 1.4 / 20;
      if (d > 0.5) {
        const nx = player.draw.x + (dx / d) * Math.min(v, d), nz = player.draw.z + (dz / d) * Math.min(v, d);
        if (rig.zone.nav.walkable(nx, nz)) { player.draw.x = nx; player.draw.z = nz; } else { player.draw.x += (dz / d) * v; player.draw.z -= (dx / d) * v; }
        player.draw.yaw = Math.atan2(dx, dz); player.draw.moveSpeed = 1.4; player.draw.anim = 'walk';
      }
      rig.focus.x = player.draw.x; rig.focus.z = player.draw.z;
      s.step();
      t += 1 / 20;
      const lead = rig.zone.agent(q.leader);
      if (lead) widest = Math.max(widest, dist(lead, player.draw));
    }
    expect(events.map((e) => e.phase)).toContain('left');
    // the patrol turned back as he stepped off the land
    expect(terr.trespass(me, player.draw.x, player.draw.z).level).toBe('none');
    expect(law.patrolFor(me)?.phase === 'attack').toBe(false);
    expect(combat.engaged.length).toBe(0);
    // they kept close: a few metres, never lost him (a rider holds back to his pace)
    expect(widest).toBeLessThan(30);
    expect(s.top).toBeLessThanOrEqual(HORSE_GALLOP * 1.12);
    expect(s.jump).toBeLessThan(0.85);
    // they ride home and the patrol is over
    let g = 0;
    while (law.patrolFor(me) && g < 120) { s.step(); g += 1 / 20; }
    expect(law.patrolFor(me)).toBeNull();
    expect(rig.sim.hostileNear()).toBe(false);
  }, 240000);

  it('Yield: he is bound and led on foot behind the leader to the manor\'s lock-up, and held there', () => {
    law.report(me, spot.x, spot.z);
    const s = stepper();
    while (law.patrolFor(me)!.phase === 'coming') s.step();
    expect(law.answerPatrol(me, 'yield').ok).toBe(true);
    const p = law.patrolFor(me)!;
    expect(p.phase).toBe('taking');
    expect(player.bound?.kind).toBe('led');
    const leader = p.leader;
    // the controller's part: a body led walks behind its captor at a walking pace
    let t = 0;
    let top = 0;
    while (law.patrolFor(me) && t < 400) {
      const lead = rig.zone.agent(leader);
      if (lead && player.bound?.kind === 'led') {
        const dx = lead.x - player.draw.x, dz = lead.z - player.draw.z;
        const d = Math.hypot(dx, dz);
        if (d > 2.2) {
          const v = Math.min(1.3, d) / 20;
          const nx = player.draw.x + (dx / d) * v, nz = player.draw.z + (dz / d) * v;
          if (rig.zone.nav.walkable(nx, nz)) { player.draw.x = nx; player.draw.z = nz; }
          player.draw.yaw = Math.atan2(dx, dz); player.draw.moveSpeed = 1.3; player.draw.anim = 'bound_walk';
        } else player.draw.moveSpeed = 0;
        rig.focus.x = player.draw.x; rig.focus.z = player.draw.z;
      }
      s.step();
      top = Math.max(top, s.top);
      t += 1 / 20;
    }
    // delivered: held in a cell of the land, the patrol dismissed
    const c = law.captivity(me)!;
    expect(c).not.toBeNull();
    expect(c.led).toBeFalsy();
    expect(c.building).toBeGreaterThanOrEqual(0);
    expect(player.bound?.kind).toBe('held');
    expect(law.patrolFor(me)).toBeNull();
    expect(c.kind === 'trespass' || c.kind === 'poaching').toBe(true);
    expect(rig.sim.state.persons.get(me)!.flags.captive).toBe(true);
    expect(events.map((e) => e.phase)).toEqual(['warned', 'captured']);
    // leading a prisoner is not a gallop: the leader waited for him and walked
    expect(t).toBeLessThan(400);
    void vil;
  }, 240000);

  it('the watch itself finds him: a villager who sees him carries the word, and the patrol comes (no report from the test)', () => {
    const { zone, sim } = rig;
    // a grown man of the village stands at the edge of the lord's close, in sight of him
    const witness = sim.state.residentList(vil.id).find((q) => q.sex === 'm' && q.id !== me && !q.death && sim.absDay - q.birthDay > 16 * 20 && sim.absDay - q.birthDay < 16 * 45 && q.career !== 'knight' && q.career !== 'sergeant' && q.career !== 'man_at_arms' && q.career !== 'soldier')!;
    // (a place in plain sight of him: nothing between)
    let at: { x: number; z: number } | null = null;
    for (let r = 14; r <= 40 && !at; r += 6) {
      for (let k = 0; k < 16 && !at; k++) {
        const x = spot.x + Math.sin(k * 0.39) * r, z = spot.z + Math.cos(k * 0.39) * r;
        if (zone.nav.walkable(x, z) && zone.nav.lineClear!(x, z, spot.x, spot.z)) at = { x, z };
      }
    }
    expect(at).not.toBeNull();
    zone.summon!(witness.id, at!.x, at!.z, 0);
    expect(zone.agent(witness.id)).toBeTruthy();
    expect(law.patrolFor(me)).toBeNull();
    let t = 0;
    while (t < 60 && !law.patrolFor(me)) { sim.step(1 / 20); t += 1 / 20; }
    const p = law.patrolFor(me);
    expect(p).not.toBeNull();
    // the report took the time of a report (seven to sixteen seconds), not a moment
    expect(t).toBeGreaterThan(5);
    expect(events.map((e) => e.phase)).toContain('seen');
    expect(lawContext(sim).watch.current()?.witness).toBe(witness.id);
    zone.dismiss!(witness.id);
  }, 120000);

  it('the navigation\'s sight test: a building between two people hides them, a few metres of open ground does not', () => {
    const { sim, zone } = rig;
    const manor = (sim.state.buildingsAt.get(vil.id) ?? []).find((b) => b.kind === 'manor_house' && b.construction >= 1)!;
    const def = BUILDINGS[manor.kind];
    const k = def.d / 2 + 6;
    const front = { x: manor.x + Math.sin(manor.rot) * k, z: manor.z + Math.cos(manor.rot) * k };
    const back = { x: manor.x - Math.sin(manor.rot) * k, z: manor.z - Math.cos(manor.rot) * k };
    expect(zone.nav.lineClear!(front.x, front.z, back.x, back.z)).toBe(false);
    expect(zone.nav.lineClear!(front.x, front.z, front.x + 2, front.z + 1)).toBe(true);
    // the same line seen from a point beside the wall (a man leaning on it): the standing place does not count
    expect(zone.nav.lineClear!(front.x, front.z, front.x, front.z)).toBe(true);
  });
});
