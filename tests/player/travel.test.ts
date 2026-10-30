import { beforeAll, describe, expect, it } from 'vitest';
import { dist } from '../../src/core/math';
import { RouteCursor, planRoute } from '../../src/player/route';
import { ROLL_GRACE, TRAVEL_FOOT, TRAVEL_RIDE, journeyPace } from '../../src/player/travel';
import { encounterRate, encounterWeights, fleeChance, parleyChance, type DangerSample } from '../../src/player/encounters';
import type { EncounterKind } from '../../src/player/types';
import { generateWorld } from '../../src/world/generate';
import type { WorldModel } from '../../src/world/types';
import { killPerson } from '../../src/sim/succession';
import { FakeZone, input, rig, type Rig } from './fakes';

describe('route planning on the real road network', () => {
  let world: WorldModel;
  beforeAll(() => { world = generateWorld('travel-test'); }, 60000);

  function pair(): [number, number] {
    // two settlements a few kilometres apart that both sit on the road graph
    const onGraph = world.roadGraph.nodes.filter((n) => n.settlement >= 0).map((n) => world.settlements[n.settlement]);
    for (const a of onGraph) {
      for (const b of onGraph) {
        const d = dist(a.x, a.z, b.x, b.z);
        if (a.id < b.id && d > 3000 && d < 6000 && a.kingdom === b.kingdom) return [a.id, b.id];
      }
    }
    throw new Error('no pair');
  }

  it('finds a route that follows roads, starts at the party and ends at the destination', () => {
    const [a, b] = pair();
    const from = world.settlements[a], to = world.settlements[b];
    const plan = planRoute(world, { x: from.x, z: from.z }, b)!;
    expect(plan).not.toBeNull();
    expect(plan.points[0]).toEqual({ x: from.x, z: from.z });
    const last = plan.points[plan.points.length - 1];
    expect(dist(last.x, last.z, to.x, to.z)).toBeLessThan(1);
    const straight = dist(from.x, from.z, to.x, to.z);
    expect(plan.total).toBeGreaterThanOrEqual(straight - 1);
    expect(plan.total).toBeLessThan(straight * 2.6);
    expect(plan.kinds.length).toBe(plan.points.length - 1);
    expect(plan.cum.length).toBe(plan.points.length);
    for (let i = 1; i < plan.cum.length; i++) expect(plan.cum[i]).toBeGreaterThan(plan.cum[i - 1]);
    expect(plan.kinds.filter((k) => k !== 'offroad').length).toBeGreaterThan(plan.kinds.length * 0.7);
    // no teleports along the way (road polylines are sampled every ~15 m; the ends may be straight legs)
    let longest = 0;
    for (let i = 1; i < plan.points.length; i++) longest = Math.max(longest, dist(plan.points[i - 1].x, plan.points[i - 1].z, plan.points[i].x, plan.points[i].z));
    expect(longest).toBeLessThan(900);
  });

  it('is deterministic, and the way back is about as long', () => {
    const [a, b] = pair();
    const A = world.settlements[a], B = world.settlements[b];
    const p1 = planRoute(world, { x: A.x, z: A.z }, b)!;
    const p2 = planRoute(world, { x: A.x, z: A.z }, b)!;
    expect(p2.total).toBe(p1.total);
    expect(p2.points.length).toBe(p1.points.length);
    const back = planRoute(world, { x: B.x, z: B.z }, a)!;
    expect(Math.abs(back.total - p1.total)).toBeLessThan(p1.total * 0.15);
  });

  it('starts from wherever the party stands, not only from settlements', () => {
    const [a, b] = pair();
    const A = world.settlements[a];
    const plan = planRoute(world, { x: A.x + 120, z: A.z - 90 }, b)!;
    expect(plan).not.toBeNull();
    expect(plan.points[0]).toEqual({ x: A.x + 120, z: A.z - 90 });
    expect(plan.kinds[0]).toBe('offroad');
  });

  it('says no when already there or when the place is unknown', () => {
    const s = world.settlements[0];
    expect(planRoute(world, { x: s.x + 5, z: s.z }, s.id)).toBeNull();
    expect(planRoute(world, { x: 0, z: 0 }, 99999)).toBeNull();
  });

  it('reaches most places by road with reasonable detours', () => {
    const towns = world.settlements.filter((s) => s.kind === 'town' || s.kind === 'city').slice(0, 8);
    let ratioSum = 0, n = 0;
    for (let i = 0; i < towns.length; i++) {
      for (let j = i + 1; j < towns.length; j++) {
        const plan = planRoute(world, { x: towns[i].x, z: towns[i].z }, towns[j].id);
        expect(plan).not.toBeNull();
        ratioSum += plan!.total / dist(towns[i].x, towns[i].z, towns[j].x, towns[j].z);
        n++;
      }
    }
    expect(ratioSum / n).toBeLessThan(1.8);
  });
});

describe('route cursor', () => {
  it('walks a polyline by distance, with headings, and clamps at the ends', () => {
    const plan = {
      points: [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }],
      cum: [0, 100, 200], total: 200, kinds: ['road', 'track'] as Array<'road' | 'track'>,
    };
    const c = new RouteCursor(plan);
    expect(c.pos).toEqual({ x: 0, z: 0 });
    c.advance(50);
    expect(c.pos.x).toBeCloseTo(50);
    expect(c.yaw).toBeCloseTo(Math.PI / 2);
    expect(c.kind).toBe('road');
    c.advance(100);
    expect(c.pos.x).toBeCloseTo(100);
    expect(c.pos.z).toBeCloseTo(50);
    expect(c.yaw).toBeCloseTo(0);
    expect(c.kind).toBe('track');
    expect(c.progress).toBeCloseTo(0.75);
    expect(c.done).toBe(false);
    c.advance(1000);
    expect(c.done).toBe(true);
    expect(c.pos.z).toBeCloseTo(100);
  });
});

describe('pace', () => {
  const base = { mounted: false, agility: 10, age: 25, ridingLevel: 0, weight: 0, capacity: 30, weather: { rain: 0, snowCover: 0, fog: 0 }, legFactor: 1 };
  it('is a brisk march on foot and a steady ride on a horse, slowed by weather, load and bad ways', () => {
    expect(journeyPace(base)).toBeCloseTo(TRAVEL_FOOT, 3);
    expect(journeyPace({ ...base, mounted: true })).toBeCloseTo(TRAVEL_RIDE, 3);
    expect(journeyPace({ ...base, weather: { rain: 1, snowCover: 1, fog: 0 } })).toBeLessThan(TRAVEL_FOOT * 0.8);
    expect(journeyPace({ ...base, weight: 30 })).toBeLessThan(TRAVEL_FOOT * 0.6);
    expect(journeyPace({ ...base, legFactor: 0.6 })).toBeCloseTo(TRAVEL_FOOT * 0.6, 3);
    expect(journeyPace({ ...base, agility: 18 })).toBeGreaterThan(TRAVEL_FOOT);
  });
});

describe('encounter odds', () => {
  const calm: DangerSample = { forest: 0.1, wild: false, border: false, nearSettlement: false, night: false, winter: false, holyDay: false, leg: 'road' };
  it('rise in forest, on borders, at night and with difficulty; fall near settlements', () => {
    const r = (s: Partial<DangerSample>, d: 'knight' | 'king' | 'squire' = 'knight'): number => encounterRate({ ...calm, ...s }, d);
    expect(r({ forest: 0.9 })).toBeGreaterThan(r({ forest: 0.1 }) * 1.5);
    expect(r({ border: true })).toBeGreaterThan(r({}));
    expect(r({ night: true })).toBeGreaterThan(r({}) * 1.5);
    expect(r({ nearSettlement: true })).toBeLessThan(r({}) * 0.2);
    expect(r({}, 'king')).toBeGreaterThan(r({}, 'knight'));
    expect(r({}, 'squire')).toBeLessThan(r({}, 'knight'));
    expect(r({ leg: 'highway' })).toBeLessThan(r({ leg: 'path' }));
  });

  it('favour bandits in the woods and at night, wolves in winter forest, patrols on borders', () => {
    const w = (s: Partial<DangerSample>, d: 'knight' | 'king' = 'knight'): Record<string, number> =>
      Object.fromEntries(encounterWeights({ ...calm, ...s }, d)) as Record<string, number>;
    expect(w({ forest: 0.9 }).bandits).toBeGreaterThan(w({ forest: 0.1 }).bandits);
    expect(w({ night: true }).bandits).toBeGreaterThan(w({}).bandits);
    expect(w({ forest: 0.8, winter: true }).wolves).toBeGreaterThan(w({ forest: 0.8 }).wolves * 2);
    expect(w({ forest: 0, wild: false }).wolves).toBeLessThan(0.1);
    expect(w({ border: true }).patrol).toBeGreaterThan(w({}).patrol);
    expect(w({}, 'king').bandits).toBeGreaterThan(w({}, 'knight').bandits);
    expect(w({ night: true }).merchant).toBeLessThan(w({}).merchant);
  });

  it('fleeing and parleying depend on the character', () => {
    const r = rig();
    const p = r.sim.state.persons.get(r.pid)!;
    const base = fleeChance(p, false, 1, 3, 0);
    expect(fleeChance(p, true, 1, 3, 0)).toBeGreaterThan(base + 0.2);
    expect(fleeChance(p, false, 0, 3, 0)).toBeLessThan(base);
    expect(fleeChance(p, false, 1, 6, 0)).toBeLessThan(base);
    p.trained.cha = 16;
    const hi = parleyChance(p, 0.12);
    p.trained.cha = 6;
    expect(parleyChance(p, 0.12)).toBeLessThan(hi);
    expect(hi).toBeLessThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------------------------
// Journeys inside a simulation
// ---------------------------------------------------------------------------------------------

function farthestFrom(r: Rig, min: number, max: number): number {
  const b = r.player.body()!;
  const cands = r.sim.world.settlements.filter((s) => dist(s.x, s.z, b.x, b.z) > min && dist(s.x, s.z, b.x, b.z) < max);
  expect(cands.length).toBeGreaterThan(0);
  return cands[0].id;
}

/** Settles an open encounter with the first safe choice that lets the journey go on. */
function settleEncounter(r: Rig): void {
  const prefer = ['pass', 'pay', 'go', 'walk', 'news', 'trade', 'flee', 'fire', 'stand', 'parley'];
  const opts = r.player.options().filter((o) => o.enabled);
  for (const id of prefer) {
    const o = opts.find((x) => x.id === `encounter.${id}`);
    if (o) { r.player.perform(o); return; }
  }
  r.player.perform(opts[0]);
}

/** Steps real time at 8× until `done()` or the limit (seconds of real time). */
function advance(r: Rig, done: () => boolean, limit = 1500, dt = 0.05): number {
  let t = 0;
  while (!done() && t < limit) {
    r.player.setInput(input());
    r.sim.step(dt);
    r.player.frame!(dt);
    t += dt;
  }
  return t;
}

describe('a journey', () => {
  it('forces 8× speed, switches to the travel view, moves the party along the road and arrives', () => {
    const r = rig({ preset: 'small' });
    const dest = farthestFrom(r, 1500, 9000);
    const events: string[] = [];
    r.sim.events.on('travel', (e) => events.push(e.phase));
    r.sim.dispatch({ type: 'setSpeed', speed: 3 });
    const start = { ...r.player.body()! };
    expect(r.player.travelTo(dest).ok).toBe(true);
    expect(r.sim.clock.speed).toBe(8);
    expect(r.sim.view.mode()).toBe('travel');
    const t0 = r.player.travel()!;
    expect(t0.phase).toBe('travelling');
    expect(t0.to).toBe(dest);
    expect(t0.route.length).toBeGreaterThan(1);
    expect(t0.daysLeft).toBeGreaterThan(1);
    expect(r.player.hud()!.travel).toBe(t0);
    expect(r.player.mapFocus!()).not.toBeNull();
    expect(r.sim.view.mapMarkers()[0].kind).toBe('party');

    // run until something other than plain travelling happens (the road may offer an encounter)
    r.sim.state.persons.get(r.pid)!.money = 900;
    advance(r, () => {
      const t = r.player.travel();
      if (t?.phase === 'encounter') settleEncounter(r);
      return t === null || t.phase === 'arrived';
    });
    const end = r.player.travel();
    expect(end?.phase).toBe('arrived');
    expect(end!.progress).toBe(1);
    expect(events[0]).toBe('start');
    expect(events).toContain('arrive');
    expect(r.sim.clock.speed).toBe(3); // back to what it was
    expect(r.sim.view.mode()).toBe('street');
    const s = r.sim.world.settlements.find((x) => x.id === dest)!;
    const now = r.player.body()!;
    expect(dist(now.x, now.z, s.x, s.z)).toBeLessThan(s.radius + 100);
    expect(dist(now.x, now.z, start.x, start.z)).toBeGreaterThan(1000);
    expect(r.zone.resyncCount).toBeGreaterThan(1);
    // the arrived card goes away after a few seconds
    advance(r, () => r.player.travel() === null, 30);
    expect(r.player.travel()).toBeNull();
  });

  it('cancelling stops where the party is and gives the speed back', () => {
    const r = rig({ preset: 'small' });
    const dest = farthestFrom(r, 2500, 9000);
    expect(r.player.travelTo(dest).ok).toBe(true);
    advance(r, () => (r.player.travel()?.progress ?? 1) > 0.15 || r.player.travel()?.phase === 'encounter', 600);
    if (r.player.travel()?.phase === 'encounter') settleEncounter(r);
    const at = { ...r.player.body()! };
    const events: string[] = [];
    r.sim.events.on('travel', (e) => events.push(e.phase));
    r.player.cancelTravel();
    expect(r.player.travel()).toBeNull();
    expect(events).toEqual(['cancel']);
    expect(r.sim.clock.speed).toBe(1);
    expect(r.sim.view.mode()).toBe('street');
    expect(dist(r.player.body()!.x, r.player.body()!.z, at.x, at.z)).toBeLessThan(2);
  });

  it('is refused with a hostile near, and when already there', () => {
    const r = rig({ preset: 'small' });
    const dest = farthestFrom(r, 1500, 9000);
    r.sim.hostileNear = () => true;
    const res = r.player.travelTo(dest);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/dangerous/i);
    expect(r.player.travel()).toBeNull();
    r.sim.hostileNear = () => false;
    const home = r.sim.world.nearestSettlement(r.player.body()!.x, r.player.body()!.z);
    r.player.placeAt(home.x + 5, home.z, 0);
    expect(r.player.travelTo(home.id).ok).toBe(false);
    expect(r.player.travelTo(424242).ok).toBe(false);
  });

  it('rides faster than it walks', () => {
    const progressAfter = (mounted: boolean): number => {
      const r = rig({ preset: 'small', seed: 'pace' });
      if (mounted) r.player.debug!.forceMount();
      for (let i = 0; i < 60; i++) { r.sim.step(0.05); r.player.frame!(0.05); } // the mount clip plays out
      r.player.travelTo(farthestFrom(r, 2500, 9000));
      for (let i = 0; i < 100; i++) { r.sim.step(0.05); r.player.frame!(0.05); } // 5 s real = 40 s of marching: no encounter rolls yet
      return r.player.travel()?.progress ?? 1;
    };
    const ride = progressAfter(true), foot = progressAfter(false);
    expect(foot).toBeGreaterThan(0.002);
    expect(ride / foot).toBeGreaterThan(2.2);
    expect(ride / foot).toBeLessThan(3.3);
  });

  it('is deterministic: the same seed meets the same people at the same places', () => {
    const journey = (seed: string): string[] => {
      const r = rig({ preset: 'large', seed, difficulty: 'king' });
      r.sim.state.persons.get(r.pid)!.money = 900;
      const b = r.player.body()!;
      const cands = r.sim.world.settlements.filter((s) => dist(s.x, s.z, b.x, b.z) > 4000 && dist(s.x, s.z, b.x, b.z) < 12000);
      r.player.travelTo(cands[0].id);
      const log: string[] = [];
      advance(r, () => {
        const t = r.player.travel();
        if (t?.phase === 'encounter') {
          log.push(`${t.encounter!.kind}@${Math.round(r.player.body()!.x)},${Math.round(r.player.body()!.z)}`);
          settleEncounter(r);
        }
        return t === null || t.phase === 'arrived';
      }, 6000);
      return log;
    };
    const a = journey('enc-1'), b = journey('enc-1'), c = journey('enc-2');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toEqual(c);
  }, 60000);
});

describe('encounters', () => {
  function onTheRoad(seed = 'enc'): Rig {
    const r = rig({ preset: 'small', seed });
    const dest = farthestFrom(r, 2500, 9000);
    expect(r.player.travelTo(dest).ok).toBe(true);
    for (let i = 0; i < 40; i++) { r.player.setInput(input()); r.sim.step(0.05); r.player.frame!(0.05); }
    return r;
  }

  const KINDS: EncounterKind[] = ['bandits', 'patrol', 'travellers', 'merchant', 'pilgrims', 'wolves', 'messenger'];

  it('drops to street level on the spot, slows the world, blocks hurrying and lists the choices', () => {
    const r = onTheRoad();
    r.player.debug!.forceEncounter('bandits');
    const t = r.player.travel()!;
    expect(t.phase).toBe('encounter');
    expect(t.encounter!.kind).toBe('bandits');
    expect(t.encounter!.hostile).toBe(true);
    expect(t.encounter!.text).toMatch(/purse|outlaw|rough/i);
    expect(t.encounter!.choices!.length).toBeGreaterThanOrEqual(3);
    expect(r.sim.view.mode()).toBe('street');
    expect(r.sim.state.clock.actionTime).toBe(true);
    expect(r.sim.clock.speed).toBe(1);
    expect(r.sim.dispatch({ type: 'setSpeed', speed: 3 }).ok).toBe(false);
    expect(r.sim.dispatch({ type: 'sleep' }).ok).toBe(false);
    expect(r.player.options().map((o) => o.id).every((id) => id.startsWith('encounter.'))).toBe(true);
    expect(r.player.target()).toBeNull();
    expect(r.player.hud()!.prompt).toBeNull();
    // the body stays put while the standoff lasts
    const at = { ...r.player.body()! };
    r.player.setInput(input({ forward: 1 }));
    for (let i = 0; i < 20; i++) r.sim.step(0.05);
    expect(dist(r.player.body()!.x, r.player.body()!.z, at.x, at.z)).toBeLessThan(0.01);
    // other modules' actions (eating, resting…) are refused until it is settled
    const others = r.sim.actions.list(r.pid, { kind: 'self' }).filter((o) => !o.id.startsWith('encounter.'));
    for (const o of others) expect(r.player.perform(o).ok).toBe(false);
  }, 120000);

  it('paying bandits costs the demand and the journey resumes at 8×', () => {
    const r = onTheRoad();
    const p = r.sim.state.persons.get(r.pid)!;
    p.money = 200;
    r.player.debug!.forceEncounter('bandits');
    const pay = r.player.options().find((o) => o.id === 'encounter.pay')!;
    expect(pay.label).toMatch(/Hand over 5s 10d|Hand over/);
    const out = r.player.perform(pay);
    expect(out.ok).toBe(true);
    expect(p.money).toBeLessThan(200);
    expect(p.money).toBeGreaterThanOrEqual(200 - 70);
    expect(r.player.travel()!.phase).toBe('travelling');
    expect(r.player.travel()!.encounter).toBeUndefined();
    expect(r.sim.clock.speed).toBe(8);
    expect(r.sim.state.clock.actionTime).toBe(false);
    expect(r.sim.view.mode()).toBe('travel');
    expect(r.sim.hostileNear()).toBe(false);
  });

  it('fleeing either gets away or costs goods, coin and a wound; both go on', () => {
    const outcomes = new Set<boolean>();
    for (let i = 0; i < 30 && outcomes.size < 2; i++) {
      const r = onTheRoad(`flee-${i}`);
      const p = r.sim.state.persons.get(r.pid)!;
      p.money = 100;
      p.inventory['wheat'] = 10;
      const hp = p.health.hp;
      r.player.debug!.forceEncounter('bandits');
      const flee = r.player.options().find((o) => o.id === 'encounter.flee')!;
      expect(flee.preview).toMatch(/%/);
      const out = r.player.perform(flee);
      outcomes.add(out.ok);
      expect(r.player.travel()!.phase).toBe('travelling');
      if (!out.ok) {
        expect(p.money).toBeLessThan(100);
        expect(p.inventory['wheat']).toBeLessThan(10);
        expect(p.health.hp).toBeLessThan(hp);
        expect(p.health.conditions.some((c) => c.id === 'injury')).toBe(true);
      } else {
        expect(p.money).toBe(100);
        expect(p.health.hp).toBe(hp);
      }
    }
    expect(outcomes.size).toBe(2);
  });

  it('every kind of encounter offers something to do and can be settled', () => {
    for (const kind of KINDS) {
      const r = onTheRoad(`kind-${kind}`);
      r.sim.state.persons.get(r.pid)!.money = 300;
      r.player.debug!.forceEncounter(kind);
      const t = r.player.travel()!;
      expect(t.phase, kind).toBe('encounter');
      const enabled = r.player.options().filter((o) => o.enabled);
      expect(enabled.length, kind).toBeGreaterThan(0);
      const out = r.player.perform(enabled[0]);
      expect(out.message, kind).toBeTruthy();
      const after = r.player.travel();
      expect(after === null || after.phase === 'travelling', kind).toBe(true);
    }
  });

  it('a merchant opens the market, a patrol can send you back, wolves need a flame', () => {
    const m = onTheRoad();
    m.player.debug!.forceEncounter('merchant');
    const ui: unknown[] = [];
    m.sim.events.on('ui', (u) => ui.push(u));
    const trade = m.player.options().find((o) => o.id === 'encounter.trade')!;
    const out = m.player.perform(trade);
    expect(out.ui?.panel).toBe('trade');
    expect(ui.length).toBe(1);
    expect((ui[0] as { partner: { kind: string } }).partner.kind).toBe('market');

    const p = onTheRoad();
    p.player.debug!.forceEncounter('patrol');
    p.sim.state.persons.get(p.pid)!.money = 500;
    const turn = p.player.options().find((o) => o.id === 'encounter.turn')!;
    p.player.perform(turn);
    expect(p.player.travel()).toBeNull();
    expect(p.sim.clock.speed).toBe(1);
    expect(p.sim.state.clock.actionTime).toBe(false);

    const w = onTheRoad();
    w.sim.state.persons.get(w.pid)!.inventory = {};
    w.player.debug!.forceEncounter('wolves');
    const fire = w.player.options().find((o) => o.id === 'encounter.fire')!;
    expect(fire.enabled).toBe(false);
    expect(fire.reason).toMatch(/fire/);
    expect(w.player.perform(fire).ok).toBe(false);
    w.player.perform(w.player.options().find((o) => o.id === 'encounter.flee')!);

    const w2 = onTheRoad();
    w2.sim.state.persons.get(w2.pid)!.inventory = { torch: 2 };
    w2.player.debug!.forceEncounter('wolves');
    const fire2 = w2.player.options().find((o) => o.id === 'encounter.fire')!;
    expect(fire2.enabled).toBe(true);
    w2.player.perform(fire2);
    expect(w2.sim.state.persons.get(w2.pid)!.inventory['torch']).toBe(1);
  });

  it('chooseEncounter resolves by choice id and refuses unknown ones', () => {
    const r = onTheRoad();
    r.player.debug!.forceEncounter('travellers');
    expect(r.player.chooseEncounter!('nonsense').ok).toBe(false);
    expect(r.player.chooseEncounter!('go').ok).toBe(true);
    expect(r.player.travel()!.phase).toBe('travelling');
  });

  it('lets a panel that only knows travelTo and cancelTravel settle an encounter (the UI\'s journey panel)', () => {
    // press on: the same destination again. Past outlaws that is a dash, and the journey goes on either way
    const a = onTheRoad('panel-1');
    const dest = a.player.travel()!.to;
    a.player.debug!.forceEncounter('bandits');
    expect(a.player.travelTo(dest).ok).toBe(true);
    expect(a.player.travel()!.phase).toBe('travelling');
    expect(a.player.travel()!.encounter).toBeUndefined();
    expect(a.sim.state.clock.actionTime).toBe(false);
    expect(a.sim.clock.speed).toBe(8);

    // turn back: another destination, and the journey is re-planned from where the party stands
    const b = onTheRoad('panel-2');
    const here = b.player.body()!;
    const elsewhere = b.sim.world.settlements.find((s) => s.id !== b.player.travel()!.to && dist(s.x, s.z, here.x, here.z) > 1500)!.id;
    b.player.debug!.forceEncounter('travellers');
    expect(b.player.travelTo(elsewhere).ok).toBe(true);
    expect(b.player.travel()!.to).toBe(elsewhere);
    expect(b.player.travel()!.phase).toBe('travelling');

    // a patrol will not be passed by walking on without the toll: a poor traveller is turned back
    const c = onTheRoad('panel-3');
    c.sim.state.persons.get(c.pid)!.money = 0;
    c.player.debug!.forceEncounter('patrol');
    const res = c.player.travelTo(c.player.travel()!.to);
    expect(res.ok === false || c.player.travel() === null || c.player.travel()!.phase === 'travelling').toBe(true);

    // ending the journey in front of wolves means turning and running: the encounter ends with the journey
    const d = onTheRoad('panel-4');
    d.player.debug!.forceEncounter('wolves');
    d.player.cancelTravel();
    expect(d.player.travel()).toBeNull();
    expect(d.sim.hostileNear()).toBe(false);
    expect(d.sim.state.clock.actionTime).toBe(false);
    expect(d.sim.clock.speed).toBe(1);
  });

  it('E during an encounter asks the UI for the wheel that lists the choices', () => {
    const r = onTheRoad('wheel');
    r.player.debug!.forceEncounter('merchant');
    const asked: unknown[] = [];
    r.sim.events.on('ui', (u) => asked.push(u));
    r.player.setInput(input({ interact: true }));
    r.sim.step(0.05);
    expect(asked).toEqual([{ panel: 'actions' }]);
    expect(r.player.options().length).toBeGreaterThan(1);
  });

  it('stays out of the first stretch of a journey', () => {
    expect(ROLL_GRACE).toBeGreaterThan(100);
  });

  it('a lone fake zone can start a standoff without any journey', () => {
    const r = rig({ preset: 'small' });
    r.player.debug!.forceEncounter('travellers');
    expect(r.player.travel()?.phase).toBe('encounter');
    void FakeZone;
  });
});

describe('encounters in the 3D view', () => {
  function road(kind: EncounterKind, seed = 'sum'): Rig {
    const r = rig({ preset: 'small', seed, zone: (z) => z.enableSummons() });
    expect(r.player.travelTo(farthestFrom(r, 2500, 9000)).ok).toBe(true);
    for (let i = 0; i < 40; i++) { r.player.setInput(input()); r.sim.step(0.05); r.player.frame!(0.05); }
    r.player.debug!.forceEncounter(kind);
    return r;
  }

  it('shows real people from nearby settlements, facing the player, and dismisses them when it is settled', () => {
    for (const kind of ['bandits', 'patrol', 'travellers', 'pilgrims', 'merchant', 'messenger'] as EncounterKind[]) {
      const r = road(kind, `sum-${kind}`);
      expect(r.zone.summoned.size, kind).toBeGreaterThan(0);
      const me = r.player.body()!;
      for (const [id, at] of r.zone.summoned) {
        const person = r.sim.state.persons.get(id)!;
        expect(person && !person.death, kind).toBe(true);
        expect(id).not.toBe(r.pid);
        expect(person.household).not.toBe(r.sim.state.persons.get(r.pid)!.household);
        expect(Math.hypot(at.x - me.x, at.z - me.z)).toBeGreaterThan(5);
        expect(Math.hypot(at.x - me.x, at.z - me.z)).toBeLessThan(20);
      }
      const opts = r.player.options().filter((o) => o.enabled);
      r.player.perform(opts[0]);
      expect(r.zone.summoned.size, kind).toBe(0);
      expect(r.zone.dismissedPeople.length, kind).toBeGreaterThan(0);
    }
  });

  it('bandits are poor young men, a patrol is soldiers or commoners', () => {
    const r = road('bandits', 'sum-b');
    for (const id of r.zone.summoned.keys()) {
      const p = r.sim.state.persons.get(id)!;
      expect(p.sex).toBe('m');
      expect(p.rankTier).toBeLessThanOrEqual(2);
    }
  });

  it('wolves are summoned as hostile animals and dismissed', () => {
    const r = road('wolves', 'sum-w');
    expect(r.zone.summonedAnimals.size).toBeGreaterThanOrEqual(2);
    for (const a of r.zone.summonedAnimals.values()) { expect(a.kind).toBe('wolf'); expect(a.hostile).toBe(true); }
    expect(r.zone.summoned.size).toBe(0);
    r.player.cancelTravel();
    expect(r.zone.summonedAnimals.size).toBe(0);
  });

  it('dismisses everyone when the journey ends another way (turning back, death)', () => {
    const r = road('patrol', 'sum-end');
    r.sim.state.persons.get(r.pid)!.money = 0;
    const turn = r.player.options().find((o) => o.id === 'encounter.turn');
    if (turn) r.player.perform(turn); else r.player.cancelTravel();
    expect(r.zone.summoned.size).toBe(0);
    const d = road('bandits', 'sum-dead');
    killPerson(d.sim, d.sim.state.persons.get(d.pid)!, 'accident', d.sim.absDay);
    expect(d.zone.summoned.size).toBe(0);
  });

  it('works without the hooks: the choices alone carry the encounter', () => {
    const r = rig({ preset: 'small', seed: 'nosum' });
    r.player.travelTo(farthestFrom(r, 2500, 9000));
    for (let i = 0; i < 40; i++) { r.player.setInput(input()); r.sim.step(0.05); }
    r.player.debug!.forceEncounter('bandits');
    expect(r.player.options().length).toBeGreaterThan(1);
  });
});

describe('the view mode and the renderer\'s camera', () => {
  /** A stand-in for the renderer: it follows `view.mode()` only when that changes, like the real one. */
  function withCamera() {
    let cam = 'follow';
    let last: string | null = null;
    const r = rig({ preset: 'small', seed: 'cam', cameraMode: () => cam });
    const map: Record<string, string> = { street: 'follow', map: 'map', travel: 'map', cinematic: 'cinematic' };
    const render = (): string => {
      const vm = r.sim.view.mode();
      if (vm !== last) { if (last !== null) cam = map[vm]; last = vm; }
      return vm;
    };
    return { r, render, setCam: (c: string) => { cam = c; }, cam: () => cam };
  }

  function destination(r: Rig): number { return farthestFrom(r, 2500, 9000); }

  it('comes down to street level when an encounter starts, when the journey is cancelled and on arrival', () => {
    const c = withCamera();
    c.render();
    expect(c.r.player.travelTo(destination(c.r)).ok).toBe(true);
    expect(c.render()).toBe('travel');
    expect(c.cam()).toBe('map');
    c.r.player.debug!.forceEncounter('travellers');
    expect(c.render()).toBe('street');
    expect(c.cam()).toBe('follow');
    expect(c.render()).toBe('street'); // and it stays down
    c.r.player.perform(c.r.player.options().find((o) => o.enabled)!);
    expect(c.render()).toBe('travel');
    expect(c.cam()).toBe('map');
    c.r.player.cancelTravel();
    expect(c.render()).toBe('street');
    expect(c.cam()).toBe('follow');
    expect(c.render()).toBe('street');
  });

  it('comes down after a character switch (the camera rises to the map and descends onto the new body)', () => {
    const c = withCamera();
    c.render();
    killPersonNow(c.r);
    const heir = c.r.sim.state.run.pendingSuccession!.eligible[0];
    c.r.sim.dispatch({ type: 'switchCharacter', personId: heir });
    expect(c.render()).toBe('map');
    expect(c.cam()).toBe('map');
    for (let i = 0; i < 30; i++) { c.r.player.frame!(0.1); c.render(); }
    expect(c.r.sim.view.mode()).toBe('street');
    expect(c.cam()).toBe('follow');
  });

  it('still reports the map when the UI opens it, and street when the UI closes it', () => {
    const c = withCamera();
    c.render();
    c.setCam('map'); // the map panel
    expect(c.r.sim.view.mode()).toBe('map');
    c.setCam('follow');
    expect(c.r.sim.view.mode()).toBe('street');
  });
});

function killPersonNow(r: Rig): void {
  killPerson(r.sim, r.sim.state.persons.get(r.pid)!, 'accident', r.sim.absDay);
}
