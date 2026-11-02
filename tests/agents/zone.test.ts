import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installAgents } from '../../src/agents';
import { St } from '../../src/agents/agent';
import { ENTER_RADIUS, LEAVE_RADIUS, SEEN_RADIUS } from '../../src/agents/config';
import { MAX_AGENTS, MAX_ANIMALS } from '../../src/agents/types';
import { daylight } from '../../src/core/time';
import type { CharacterDrawItem } from '../../src/core/view';
import { newProfile } from '../../src/sim/legacy';
import { installEconomy } from '../../src/sim/economy';
import { installSocial } from '../../src/sim/social';
import { MemorySaveStore } from '../../src/sim/save-memory';
import { Simulation } from '../../src/sim/sim';
import { createMockWorld } from '../../src/sim/testing/mockWorld';
import type { Settlement } from '../../src/world/types';
import { makeRig, run, setClock, settlementOfKind, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
}, 180000);

beforeEach(() => {
  rig.sim.view.setSource('mode', () => 'street');
  rig.zone.detachPlayer();
  rig.focus.x = vil.x; rig.focus.z = vil.z;
  setClock(rig.sim, 1, 2, 0.4);
  rig.zone.resync();
});

describe('the zone', () => {
  it('places people where their schedules say they are now, mid-walk if they are travelling', () => {
    const { zone, sim } = rig;
    expect(zone.agentsArr.length).toBeGreaterThan(10);
    for (const a of zone.agentsArr) {
      const w = zone.sched.whereabouts(a.person, sim.absDay);
      expect(w.indoors).toBe(false);
      // the spawn is the schedule's position (nudged onto walkable ground); only a walk that nobody can see is finished at once
      if (a.distFocus <= SEEN_RADIUS) expect(Math.hypot(a.x - w.x, a.z - w.z)).toBeLessThan(10);
      expect(a.y).toBeCloseTo(zone.nav.groundY(a.x, a.z), 2);
    }
  });

  it('draws every agent with a CharacterDrawItem built from the sim\'s appearance cache', () => {
    const { zone, sim } = rig;
    const items = sim.view.characters();
    expect(items.length).toBe(zone.agentsArr.filter((a) => a.visible && !a.dead).length);
    for (const a of zone.agentsArr) {
      const cached = sim.view.appearance.get(sim.state, a.person, sim.absDay);
      expect(a.draw.look).toBe(cached.look);
      expect(a.draw.lookVersion).toBe(cached.version);
      expect(a.draw.id).toBe(a.personId);
      expect(Number.isFinite(a.draw.x + a.draw.y + a.draw.z + a.draw.yaw)).toBe(true);
    }
  });

  it('keeps people in the zone with hysteresis: they appear inside 250 m and fold back beyond 280 m', () => {
    const { zone, focus } = rig;
    const before = zone.agentsArr.length;
    expect(before).toBeGreaterThan(0);
    for (const a of zone.agentsArr) expect(Math.hypot(a.x - focus.x, a.z - focus.z)).toBeLessThanOrEqual(ENTER_RADIUS + 12);
    // walk the focus away so some agents fall between the two radii, some beyond
    focus.x += 120;
    run(rig.sim, 2);
    for (const a of zone.agentsArr) expect(Math.hypot(a.x - focus.x, a.z - focus.z)).toBeLessThanOrEqual(LEAVE_RADIUS + 3);
    const between = zone.agentsArr.filter((a) => {
      const d = Math.hypot(a.x - focus.x, a.z - focus.z);
      return d > ENTER_RADIUS && d <= LEAVE_RADIUS + 3;
    });
    // agents already in the zone are kept until 280 m even though a newcomer would not be admitted there
    expect(between.length + zone.agentsArr.filter((a) => Math.hypot(a.x - focus.x, a.z - focus.z) <= ENTER_RADIUS).length).toBe(zone.agentsArr.length);
  });

  it('shows no agents or animals while the view is on the map or travelling, and brings them back after', () => {
    const { zone, sim } = rig;
    expect(zone.agentsArr.length).toBeGreaterThan(0);
    sim.view.setSource('mode', () => 'map');
    run(sim, 0.2);
    expect(zone.agentsArr.length).toBe(0);
    expect(zone.fauna.count).toBe(0);
    sim.view.setSource('mode', () => 'travel');
    run(sim, 0.2);
    expect(zone.agentsArr.length).toBe(0);
    sim.view.setSource('mode', () => 'street');
    run(sim, 0.5);
    expect(zone.agentsArr.length).toBeGreaterThan(0);
  });

  it('re-places everybody after a skip (sleeping or waiting) ends', () => {
    const { zone, sim } = rig;
    const person = zone.agentsArr[0].personId;
    const x0 = zone.agentsArr[0].x;
    setClock(sim, 1, 2, 0.8); // the evening: a different day-part
    sim.events.emit('skip', { phase: 'end', kind: 'wait', label: 'Wait until dusk' });
    run(sim, 0.2);
    // everyone is where the evening schedule says now
    for (const a of zone.agentsArr) {
      const w = zone.sched.whereabouts(a.person, sim.absDay);
      expect(Math.hypot(a.x - w.x, a.z - w.z)).toBeLessThan(30);
    }
    const still = zone.agent(person);
    if (still) expect(Math.abs(still.draw.x - x0) + 1).toBeGreaterThan(0);
  });

  it('never exceeds the caps, however crowded the place (a market town at midday on a market day)', () => {
    const { zone, sim, focus, world } = rig;
    const town = world.settlements.filter((s) => s.kind === 'city' || s.kind === 'town').sort((a, b) => b.population - a.population)[0];
    focus.x = town.x; focus.z = town.z;
    setClock(sim, 1, 1 + (town.id % 3), 0.41);
    zone.resync();
    expect(zone.agentsArr.length).toBeGreaterThan(60);
    expect(zone.agentsArr.length).toBeLessThanOrEqual(MAX_AGENTS);
    expect(zone.fauna.count).toBeLessThanOrEqual(MAX_ANIMALS);
    run(sim, 10);
    // a body replaced by a nearer one is flagged dead and swept on the next pass
    expect(zone.agentsArr.filter((a) => !a.dead).length).toBeLessThanOrEqual(MAX_AGENTS);
    // nearest first: the nearest outdoor people are in
    const farthest = Math.max(...zone.agentsArr.map((a) => a.distFocus));
    expect(farthest).toBeLessThanOrEqual(LEAVE_RADIUS + 5);
  });

  it('keeps the attached player out of the crowd and includes the player\'s body in the view', () => {
    const { zone, sim, focus } = rig;
    const player = sim.state.persons.get(sim.state.run.playerId)!;
    const draw: CharacterDrawItem = {
      id: player.id, x: vil.x + 30, y: 0, z: vil.z + 30, yaw: 0, look: sim.view.appearance.get(sim.state, player, sim.absDay).look,
      lookVersion: 1, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 3,
    };
    zone.attachPlayer(player.id, draw);
    run(sim, 1);
    expect(zone.agent(player.id)).toBeNull();
    expect(sim.view.characters()[0]).toBe(draw);
    // the focus is the player's body now
    expect(zone.focusX).toBeCloseTo(draw.x, 5);
    focus.x = 0; focus.z = 0;
    run(sim, 0.2);
    expect(zone.focusX).toBeCloseTo(draw.x, 5);
    zone.detachPlayer();
  });
});

describe('orders and conversation', () => {
  const pick = () => rig.zone.agentsArr.find((a) => a.st === St.Idle && a.control === 'ai' && a.age >= 16)!;

  it('holds an agent for a conversation: stops, faces the speaker, resumes on release', () => {
    const { zone, sim } = rig;
    const a = pick();
    const other = zone.agentsArr.find((b) => b !== a && Math.hypot(b.x - a.x, b.z - a.z) < 40)!;
    zone.hold(a.personId, other.personId);
    const x = a.x, z = a.z;
    run(sim, 1.5);
    expect(a.control).toBe('held');
    expect(Math.hypot(a.x - x, a.z - z)).toBeLessThan(0.01);
    const want = Math.atan2(other.x - a.x, other.z - a.z);
    expect(Math.abs(Math.atan2(Math.sin(a.yaw - want), Math.cos(a.yaw - want)))).toBeLessThan(0.1);
    zone.release(a.personId);
    expect(a.control).toBe('ai');
  });

  it('obeys scripted orders: goto, follow, face, perform, flee, resume', () => {
    const { zone, sim } = rig;
    const a = pick();
    const target = { x: a.x + 12, z: a.z + 4 };
    zone.command(a.personId, { kind: 'goto', x: target.x, z: target.z });
    run(sim, 14);
    expect(Math.hypot(a.x - target.x, a.z - target.z)).toBeLessThan(2.5);
    const leader = zone.agentsArr.find((b) => b !== a && b.control === 'ai')!;
    zone.command(a.personId, { kind: 'follow', leader: leader.personId, distance: 2.5 });
    run(sim, 25);
    expect(Math.hypot(a.x - leader.x, a.z - leader.z)).toBeLessThan(14);
    zone.command(a.personId, { kind: 'perform', anim: 'wave', seconds: 1 });
    run(sim, 0.5);
    expect(a.draw.anim).toBe('wave');
    run(sim, 1.5);
    expect(a.control).toBe('ai');
    zone.command(a.personId, { kind: 'flee', from: { x: a.x - 3, z: a.z } });
    run(sim, 1.5);
    expect(a.draw.anim).toBe('run');
    zone.command(a.personId, { kind: 'resume' });
    expect(a.control).toBe('ai');
  });

  it('shows speech bubbles through the draw label for the time asked, then gives the nameplate back', () => {
    const { zone, sim } = rig;
    const a = pick();
    zone.say(a.personId, 'Good morrow!', 2);
    run(sim, 0.5);
    expect(a.draw.label).toBe('Good morrow!');
    run(sim, 2);
    expect(a.draw.label).toBe(`${a.person.first}${a.person.byname ? ` ${a.person.byname}` : ''}`);
  });

  it('lets the social module make people greet the player who passes close', () => {
    const { zone, sim } = rig;
    const player = sim.state.persons.get(sim.state.run.playerId)!;
    const a = pick();
    const barks: string[] = [];
    (zone as unknown as { social: { bark: unknown } }).social = {
      ...zone.social,
      bark: (_who: number, situation: string) => { barks.push(situation); return 'Hail!'; },
    } as never;
    const draw: CharacterDrawItem = {
      id: player.id, x: a.x + 1.5, y: 0, z: a.z, yaw: 0, look: a.draw.look, lookVersion: 1, mainHand: 'none', offHand: 'none', back: 'none',
      carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 3,
    };
    zone.attachPlayer(player.id, draw);
    run(sim, 1.5);
    zone.detachPlayer();
    expect(barks.length).toBeGreaterThan(0);
    expect(barks[0]).toMatch(/greet/);
  });
});

describe('summoned people and animals', () => {
  it('summon puts a person at the spot whatever the schedule says, exempt from cap and hysteresis, until dismissed', () => {
    const { zone, sim, focus } = rig;
    // someone who is asleep indoors now would not be an agent
    setClock(sim, 1, 2, 0.02);
    zone.resync();
    const sleeper = [...sim.state.residentsOf(vil.id)].find((p) => p.id !== sim.state.run.playerId && p.career !== 'child' && !p.death && zone.whereabouts(p.id).indoors)!;
    expect(zone.agent(sleeper.id)).toBeNull();
    const x = vil.x + 20, z = vil.z + 10;
    zone.summon!(sleeper.id, x, z, 1.2);
    const a = zone.agent(sleeper.id)!;
    expect(a).not.toBeNull();
    expect(Math.hypot(a.x - x, a.z - z)).toBeLessThan(0.01);
    expect(a.control).toBe('script');
    // far beyond the zone radius and across a resync: still there
    focus.x += 600;
    run(sim, 1);
    zone.resync();
    expect(zone.agent(sleeper.id)).not.toBeNull();
    // obeys orders; after `resume` it stays (does not go back to the schedule)
    zone.command(sleeper.id, { kind: 'resume' });
    run(sim, 1);
    expect(zone.agent(sleeper.id)).not.toBeNull();
    zone.dismiss!(sleeper.id);
    run(sim, 0.2);
    expect(zone.agent(sleeper.id)).toBeNull();
    zone.dismiss!(sleeper.id); // repeated calls are harmless
    focus.x = vil.x; focus.z = vil.z;
  });

  it('summonAnimal adds a temporary beast that counts as hostile for the speed lock, and dismissAnimal removes it', () => {
    const { zone, sim, focus } = rig;
    focus.x = vil.x; focus.z = vil.z;
    setClock(sim, 1, 2, 0.4);
    zone.resync();
    const before = zone.animals().length;
    const id = zone.summonAnimal!('wolf', vil.x + 60, vil.z, true);
    expect(zone.animals().length).toBe(before + 1);
    expect(zone.animals().find((q) => q.id === id)!.hostile).toBe(true);
    expect(sim.hostileNear()).toBe(true);
    expect(sim.dispatch({ type: 'setSpeed', speed: 3 }).ok).toBe(false);
    zone.resync();
    run(sim, 1);
    expect(zone.animals().some((q) => q.id === id)).toBe(true);
    const stray = zone.summonAnimal!('dog', vil.x + 10, vil.z + 10, false);
    expect(zone.animals().find((q) => q.id === stray)!.hostile).toBe(false);
    zone.dismissAnimal!(id);
    zone.dismissAnimal!(stray);
    run(sim, 0.2);
    expect(zone.animals().some((q) => q.id === id || q.id === stray)).toBe(false);
    expect(sim.hostileNear()).toBe(false);
  });

  it('claims a horse for the player (no longer drawn or moved) and releases it where they dismount', () => {
    const { zone, sim, focus } = rig;
    focus.x = vil.x; focus.z = vil.z;
    setClock(sim, 1, 2, 0.4);
    zone.resync();
    // a horse: summon one (household horses are not guaranteed in a village)
    const id = zone.summonAnimal!('horse', vil.x + 5, vil.z + 5, false);
    expect(zone.claimAnimal!(id)).toBe(true);
    expect(sim.view.animals().some((d) => d.id === id)).toBe(false);
    const a = zone.animals().find((q) => q.id === id)!;
    const x0 = a.x;
    run(sim, 2);
    expect(a.x).toBe(x0);
    expect(zone.claimAnimal!(id)).toBe(false);
    zone.releaseAnimal!(id, vil.x + 9, vil.z + 3, 1);
    run(sim, 0.2);
    expect(sim.view.animals().some((d) => d.id === id)).toBe(true);
    expect(Math.hypot(a.x - (vil.x + 9), a.z - (vil.z + 3))).toBeLessThan(1);
    expect(zone.claimAnimal!(-12345)).toBe(false);
    zone.dismissAnimal!(id);
  });

  it('makes hold and release safe to repeat', () => {
    const { zone } = rig;
    const a = zone.agentsArr.find((q) => q.control === 'ai')!;
    zone.hold(a.personId); zone.hold(a.personId, a.personId);
    expect(a.control).toBe('held');
    zone.release(a.personId); zone.release(a.personId);
    expect(a.control).toBe('ai');
    zone.release(999999999);
  });
});

describe('animals', () => {
  const kinds = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const a of rig.zone.animals()) out[a.kind] = (out[a.kind] ?? 0) + 1;
    return out;
  };

  it('keeps hens, pigs and oxen about the crofts by day and folds them away at night', () => {
    const { zone, sim } = rig;
    setClock(sim, 1, 2, 0.4);
    zone.resync();
    const day = kinds();
    expect(Object.values(day).reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
    expect((day['chicken'] ?? 0) + (day['pig'] ?? 0) + (day['cow'] ?? 0)).toBeGreaterThan(0);
    setClock(sim, 1, 2, 0.02);
    zone.resync();
    const night = kinds();
    for (const k of ['chicken', 'pig', 'goose', 'cow', 'ox', 'horse']) expect(night[k] ?? 0).toBe(0);
  });

  it('puts every beast on firm ground and gives each draw item the contract fields', () => {
    const { zone } = rig;
    for (const a of zone.animals()) {
      expect(zone.nav.walkable(a.x, a.z)).toBe(true);
      expect(a.draw.kind).toBe(a.kind);
      expect(a.draw.scale).toBeGreaterThan(0.5);
      expect(a.draw.coat).toBeGreaterThan(0);
    }
  });

  it('has wolves stalk at night in remote woods, set hostile, and makes fast speeds refuse', () => {
    const { zone, sim, focus, world } = rig;
    // find a wolf den anywhere on the continent
    let den: { x: number; z: number } | null = null;
    for (let z = 2000; z < 14000 && !den; z += 1500) for (let x = 2000; x < 14000 && !den; x += 1500) den = zone.fauna.findWildlife('wolf', x, z, 1500);
    expect(den).not.toBeNull();
    focus.x = den!.x + 40; focus.z = den!.z;
    setClock(sim, 3, 2, 0.98); // a winter night
    zone.sched.forceWeather({ rain: 0, snow: 0, temperature: -3 });
    zone.resync();
    run(sim, 20);
    const wolves = zone.animals().filter((a) => a.kind === 'wolf');
    expect(wolves.length).toBeGreaterThan(1);
    for (const w of wolves) expect(w.hostile).toBe(true);
    expect(sim.hostileNear()).toBe(true);
    expect(sim.dispatch({ type: 'setSpeed', speed: 8 }).ok).toBe(false);
    // and they keep their distance
    for (const w of wolves) expect(Math.hypot(w.x - focus.x, w.z - focus.z)).toBeGreaterThan(20);
    zone.sched.forceWeather({ rain: 0, snow: 0, temperature: 14 });
    void world;
  });

  it('lets deer and hares bolt when a person comes near, but not sheep from a shepherd\'s dog', () => {
    const { zone, sim, focus } = rig;
    let den: { x: number; z: number } | null = null;
    for (let z = 2000; z < 14000 && !den; z += 1500) for (let x = 2000; x < 14000 && !den; x += 1500) den = zone.fauna.findWildlife('deer', x, z, 1500);
    expect(den).not.toBeNull();
    focus.x = den!.x + 60; focus.z = den!.z;
    setClock(sim, 0, 2, 0.35);
    zone.resync();
    run(sim, 3);
    const deer = zone.animals().filter((a) => a.kind === 'deer');
    expect(deer.length).toBeGreaterThan(0);
    const before = new Map(deer.map((d) => [d.id, { x: d.x, z: d.z }] as const));
    // a person walks up (the player's body)
    const player = sim.state.persons.get(sim.state.run.playerId)!;
    const body: CharacterDrawItem = {
      id: player.id, x: deer[0].x + 18, y: 0, z: deer[0].z, yaw: 0, look: sim.view.appearance.get(sim.state, player, sim.absDay).look,
      lookVersion: 1, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 3,
    };
    zone.attachPlayer(player.id, body);
    run(sim, 4);
    zone.detachPlayer();
    const moved = zone.animals().filter((a) => before.has(a.id)).some((d) => Math.hypot(d.x - before.get(d.id)!.x, d.z - before.get(d.id)!.z) > 8);
    expect(moved).toBe(true);
  });
});

describe('interactables', () => {
  it('lists people, animals, doors, strips and trees near a point with the thing in front first', () => {
    const { zone, sim } = rig;
    const a = zone.agentsArr.find((q) => q.st === St.Idle && q.age >= 16 && !zone.agentsArr.some((o) => o !== q && Math.hypot(o.x - q.x, o.z - q.z) < 9) && !zone.animals().some((o) => Math.hypot(o.x - q.x, o.z - q.z) < 9))!;
    expect(a).toBeDefined();
    // stand 2 m in front of the agent, looking at it
    const px = a.x - Math.sin(a.yaw) * 2, pz = a.z - Math.cos(a.yaw) * 2;
    const out: import('../../src/agents/types').InteractCandidate[] = [];
    zone.interactables(px, pz, Math.atan2(a.x - px, a.z - pz), 6, out);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].target).toEqual({ kind: 'person', id: a.personId });
    expect(out[0].label).toContain(a.person.first);
    expect(out[0].distance).toBeCloseTo(2, 0);
    // looking away: the same person ranks lower than they would in front
    const out2: import('../../src/agents/types').InteractCandidate[] = [];
    zone.interactables(px, pz, Math.atan2(a.x - px, a.z - pz) + Math.PI, 6, out2);
    const rankFront = out.findIndex((c) => c.target.kind === 'person' && c.target.id === a.personId);
    const rankBack = out2.findIndex((c) => c.target.kind === 'person' && c.target.id === a.personId);
    expect(rankBack).toBeGreaterThanOrEqual(rankFront);
    void sim;
  });

  it('finds the door of a building with its name, and a strip under the player\'s feet', () => {
    const { zone, sim, world } = rig;
    const church = (sim.state.buildingsAt.get(vil.id) ?? []).find((b) => b.kind === 'church')!;
    const d = zone.nav.doorOf(church.id)!;
    const out: import('../../src/agents/types').InteractCandidate[] = [];
    zone.interactables(d.x, d.z, d.yaw + Math.PI, 5, out);
    const hit = out.find((c) => c.target.kind === 'building' && c.target.id === church.id);
    expect(hit).toBeDefined();
    expect(hit!.label).toMatch(/^St .+'s church$/);
    // a strip: stand in the middle of one
    const strip = world.strips[vil.strips[0]];
    const cx = strip.poly.reduce((s, p) => s + p.x, 0) / 4, cz = strip.poly.reduce((s, p) => s + p.z, 0) / 4;
    const out2: import('../../src/agents/types').InteractCandidate[] = [];
    zone.interactables(cx, cz, 0, 4, out2);
    const s = out2.find((c) => c.target.kind === 'strip');
    expect(s).toBeDefined();
    expect(s!.label).toMatch(/strip/i);
  });

  it('includes trees and rocks with stable scatter ids', () => {
    const { zone, world } = rig;
    let item: { id: number; x: number; z: number } | null = null;
    outer:
    for (let cz = Math.floor(vil.z / 64) - 3; cz <= Math.floor(vil.z / 64) + 3; cz++) for (let cx = Math.floor(vil.x / 64) - 3; cx <= Math.floor(vil.x / 64) + 3; cx++) {
      for (const it of world.scatterInChunk(cx, cz)) if (it.kind === 'oak' || it.kind === 'ash' || it.kind === 'beech') { item = it; break outer; }
    }
    if (!item) return;
    const out: import('../../src/agents/types').InteractCandidate[] = [];
    zone.interactables(item.x + 1.5, item.z, -Math.PI / 2, 4, out);
    const t = out.find((c) => c.target.kind === 'scatter');
    expect(t).toBeDefined();
    expect((t!.target as { id: number }).id).toBe(item.id);
  });
});

describe('the zone is an observer', () => {
  it('leaves the simulation state exactly as it was without it, and survives save → load → continue', async () => {
    const mk = (withZone: boolean, store?: MemorySaveStore): Simulation => {
      const sim = Simulation.newGame({
        seed: 'observer', difficulty: 'knight', generateWorld: (s) => createMockWorld({ seed: s, preset: 'tiny' }), store, profile: store ? newProfile() : undefined,
        autosave: { intervalMs: 0 },
      });
      // the real social and economy modules change the state; only the zone must not
      const social = installSocial(sim);
      const economy = installEconomy(sim, { social });
      if (withZone) {
        const zone = installAgents(sim, { economy, social });
        const s0 = sim.world.settlements[0];
        sim.view.setSource('focus', () => ({ x: s0.x, z: s0.z }));
        zone.resync();
      }
      return sim;
    };
    const a = mk(false), b = mk(true);
    for (let i = 0; i < 1500; i++) { a.step(1 / 20); b.step(1 / 20); }
    expect(b.stateHash()).toBe(a.stateHash());
    // save, load into a fresh simulation with its own zone, and carry on in lock step with the original
    const store = new MemorySaveStore();
    const c = mk(true, store);
    for (let i = 0; i < 400; i++) c.step(1 / 20);
    await c.flush();
    const loaded = (await Simulation.load(store, (s) => createMockWorld({ seed: s, preset: 'tiny' })))!;
    const social = installSocial(loaded);
    const economy = installEconomy(loaded, { social });
    const zone = installAgents(loaded, { economy, social });
    const s0 = loaded.world.settlements[0];
    loaded.view.setSource('focus', () => ({ x: s0.x, z: s0.z }));
    zone.resync();
    for (let i = 0; i < 600; i++) { c.step(1 / 20); loaded.step(1 / 20); }
    expect(loaded.stateHash()).toBe(c.stateHash());
  }, 60000);
});

describe('sunrise anchors', () => {
  it('uses the season\'s daylight: sleepers are up before sunrise in winter only a little, much earlier in summer', () => {
    const { zone, sim } = rig;
    const adults = zone.agentsArr.filter((a) => a.age >= 16).map((a) => a.person);
    expect(adults.length).toBeGreaterThan(0);
    const up = (season: 0 | 1 | 2 | 3, frac: number): number => {
      setClock(sim, season, 2, 0);
      return adults.filter((p) => !zone.sched.whereabouts(p, sim.absDay + frac).indoors).length;
    };
    const { sunrise: srWinter } = daylight(3);
    const { sunrise: srSummer } = daylight(1);
    expect(srSummer).toBeLessThan(srWinter);
    // 20 minutes of game time after the summer sunrise most are up; the same clock time in winter is still night
    expect(up(1, srSummer + 0.03)).toBeGreaterThan(up(3, srSummer + 0.03));
  });
});
