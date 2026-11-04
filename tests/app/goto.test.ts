// "Go to…" (H1): the places, the refusals, the time that passes, the arrival; and riding with the host (the march skipped).
import { describe, expect, it } from 'vitest';
import { GotoMode, GOTO_RANGE, spanText, type GotoEnv } from '../../src/app/goto';
import { DAY_SECONDS } from '../../src/core/time';
import { doorStand } from '../../src/agents/geometry';
import { newSim } from '../sim/helpers';
import { milSim } from '../sim/military/helpers';
import { CampaignMode } from '../../src/app/campaign';
import { castleScenario } from '../../src/app/scenarios';

function rig(seed = 'goto-a') {
  const sim = newSim({ seed, preset: 'small' });
  const st = sim.state;
  const me = st.persons.get(st.run.playerId)!;
  const hh = st.households.get(me.household)!;
  const home = st.buildings.get(hh.home)!;
  const body = { x: home.x + 3, y: 0, z: home.z + 3, yaw: 0 };
  const placed: Array<{ x: number; z: number; yaw?: number }> = [];
  const flags = { phase: null as string | null, mounted: false, restraint: null as unknown, travel: null as unknown };
  const env: GotoEnv = {
    sim,
    player: {
      body: () => body,
      placeAt: (x: number, z: number, yaw?: number) => { body.x = x; body.z = z; placed.push({ x, z, yaw }); },
      mounted: () => flags.mounted,
      restraint: () => flags.restraint as never,
      travel: () => flags.travel as never,
    },
    zone: { nav: { doorOf: (id: number) => { const b = st.buildings.get(id); return b ? doorStand(b, { x: 0, z: 0, yaw: 0 }) : null; } }, ledBy: () => [] },
    campaignPhase: () => flags.phase,
  };
  const goto = new GotoMode(env);
  return { sim, st, me, home, body, placed, flags, goto, env };
}

/** The sim runs on, as the game does, until the skip is over. */
function runOut(sim: ReturnType<typeof rig>['sim']): number {
  const t0 = sim.absDay;
  for (let i = 0; i < 4000 && (sim.clock.skip || i < 2); i++) sim.step(0.25);
  return sim.absDay - t0;
}

describe('go to: the places', () => {
  it('lists home first, then the places of the village by what they are, each with a door to stand at', () => {
    const t = rig();
    const places = t.goto.places();
    expect(places.length).toBeGreaterThan(3);
    expect(places[0]).toMatchObject({ group: 'home', id: `b${t.home.id}` });
    expect(places.some((p) => p.group === 'village')).toBe(true);
    for (const p of places) {
      expect(Number.isFinite(p.stand.x) && Number.isFinite(p.stand.z) && Number.isFinite(p.stand.yaw)).toBe(true);
      expect(p.name.length).toBeGreaterThan(0);
    }
    // ids are unique, and `find` gets a building by its kind and id
    expect(new Set(places.map((p) => p.id)).size).toBe(places.length);
    const some = places.find((p) => p.kind === 'building')!;
    expect(t.goto.find({ kind: 'building', id: some.ref, x: 0, z: 0 })?.id).toBe(some.id);
  });

  it('a smithy is named with its smith when one keeps it', () => {
    const t = rig('goto-smith');
    const smithy = [...t.st.buildings.values()].find((b) => b.kind === 'smithy' && b.settlement === t.me.settlement);
    if (!smithy) return; // the small world may have none in this village
    const keeper = [...t.st.persons.values()].find((p) => p.household === smithy.household && !p.death);
    const place = t.goto.places().find((p) => p.name === 'The smithy');
    expect(place).toBeTruthy();
    if (keeper && smithy.household) expect(place!.sub.length).toBeGreaterThan(0);
  });
});

describe('go to: the refusals', () => {
  const far = (t: ReturnType<typeof rig>) => t.goto.places().find((p) => Math.hypot(p.x - t.body.x, p.z - t.body.z) > 30)!;

  it('is allowed in peace, and the page says how long the walk would take', () => {
    const t = rig();
    const p = far(t);
    const c = t.goto.check(p);
    expect(c).toMatchObject({ ok: true });
    expect(c.seconds).toBeGreaterThan(0);
    expect(spanText(c.seconds)).toMatch(/minute|hour/);
  });

  it('refuses in a fight, with the host, bound, held, on a journey, and while time is passing', () => {
    const t = rig();
    const p = far(t);
    t.sim.hostileNear = () => true;
    expect(t.goto.check(p)).toMatchObject({ ok: false, reason: expect.stringMatching(/fight|hostile/i) });
    expect(t.goto.go(p).ok).toBe(false);
    t.sim.hostileNear = () => false;
    t.flags.phase = 'march';
    expect(t.goto.check(p).reason).toMatch(/host/i);
    t.flags.phase = null;
    t.flags.restraint = { kind: 'bound' };
    expect(t.goto.check(p).reason).toMatch(/bound/i);
    t.flags.restraint = null;
    t.flags.travel = { phase: 'travelling' };
    expect(t.goto.check(p).reason).toMatch(/journey/i);
    t.flags.travel = null;
    t.sim.services.law = { captivity: () => ({}) } as never;
    expect(t.goto.check(p).reason).toMatch(/held/i);
    t.sim.services.law = undefined;
    expect(t.goto.check(p).ok).toBe(true);
    expect(t.goto.go(p).ok).toBe(true);
    expect(t.goto.check(p).reason).toMatch(/passing/i);
  });

  it('refuses a place that is too far, one you do not know, one you are standing at, and hostile land', () => {
    const t = rig();
    const p = far(t);
    expect(t.goto.check({ ...p, x: t.body.x + GOTO_RANGE + 500 }).reason).toMatch(/too far/i);
    expect(t.goto.check({ ...p, id: 'b999999', ref: 999999 }).reason).toMatch(/do not know/i);
    expect(t.goto.check({ ...p, x: t.body.x + 2, z: t.body.z }).reason).toMatch(/already/i);
    const land = (level: string) => ({ level, reason: 'the lands of House Avenel', land: {} });
    t.sim.services.territory = { trespass: (_p: number, x: number) => (x === p.stand.x ? land('hostile') : land('none')) } as never;
    expect(t.goto.check(p).reason).toMatch(/hostile land/i);
    t.sim.services.territory = { trespass: () => land('hostile') } as never;
    expect(t.goto.check(p).reason).toMatch(/hostile land/i);
  });

  it('warns, but goes, at night out of doors', () => {
    const t = rig();
    const p = far(t);
    const noon = Math.floor(t.sim.absDay) + 0.5;
    (t.sim.clock.state as { absDay: number }).absDay = noon + 0.5; // midnight
    const c = t.goto.check(p);
    expect(c.ok).toBe(true);
    expect(c.warn).toMatch(/dark/i);
  });
});

describe('go to: the time passes and you arrive', () => {
  it('the real walking time passes, then you stand at the door; the people and the needs go on', () => {
    const t = rig();
    const p = t.goto.places().filter((q) => q.kind === 'building').sort((a, b) => Math.hypot(b.x - t.body.x, b.z - t.body.z) - Math.hypot(a.x - t.body.x, a.z - t.body.z))[0];
    const c = t.goto.check(p);
    expect(c.ok).toBe(true);
    const hunger = t.me.needs.hunger;
    const t0 = t.sim.absDay;
    expect(t.goto.go(p).ok).toBe(true);
    expect(t.goto.busy()).toBe(true);
    // nothing has moved yet: the skip is the sim's own
    expect(t.placed.length).toBe(0);
    const passed = runOut(t.sim);
    expect(passed * DAY_SECONDS).toBeGreaterThanOrEqual(c.seconds - 1);
    expect(passed * DAY_SECONDS).toBeLessThan(c.seconds + 3); // to the minute, not to the next hour
    expect(t.sim.absDay - t0).toBeCloseTo(passed, 6);
    expect(t.goto.busy()).toBe(false);
    expect(t.placed.length).toBe(1);
    expect(t.placed[0].x).toBeCloseTo(p.stand.x, 5);
    expect(t.placed[0].z).toBeCloseTo(p.stand.z, 5);
    expect(t.me.needs.hunger).toBeLessThanOrEqual(hunger + 1e-9);
  });

  it('a ride is quicker than a walk; the old and slow take longer', () => {
    const t = rig();
    const p = t.goto.places().filter((q) => q.kind === 'building').sort((a, b) => Math.hypot(b.x - t.body.x, b.z - t.body.z) - Math.hypot(a.x - t.body.x, a.z - t.body.z))[0];
    const foot = t.goto.check(p).seconds;
    t.flags.mounted = true;
    const ride = t.goto.check(p);
    expect(ride.mounted).toBe(true);
    expect(ride.seconds).toBeLessThan(foot);
  });

  it('waking from the skip cancels the walk: you stay where you are', () => {
    const t = rig();
    const p = t.goto.places().filter((q) => q.kind === 'building').sort((a, b) => Math.hypot(b.x - t.body.x, b.z - t.body.z) - Math.hypot(a.x - t.body.x, a.z - t.body.z))[0];
    expect(t.goto.go(p).ok).toBe(true);
    t.sim.step(0.1);
    t.sim.dispatch({ type: 'cancelSkip' });
    expect(t.goto.busy()).toBe(false);
    runOut(t.sim);
    expect(t.placed.length).toBe(0);
  });
});

describe('go to: followers, what you know, short hops', () => {
  it('a short hop takes the walk\'s own time, not a floor', () => {
    const t = rig('goto-hop');
    const near = t.goto.places().find((q) => q.kind === 'building' && Math.hypot(q.x - t.body.x, q.z - t.body.z) > 20)!;
    const c = t.goto.check({ ...near, x: t.body.x + 30, z: t.body.z });
    expect(c.ok).toBe(true);
    // 30 m at a run is about 12 s of body time: a few game minutes, not the old 20 s floor (16 minutes)
    expect(c.seconds).toBeLessThan(16);
    expect(c.seconds).toBeGreaterThan(8);
  });

  it('settlements beyond your neighbours are not known until you have been there or been told; the record is saved', () => {
    const t = rig('goto-know');
    const far = t.sim.world.settlements.filter((s) => s.id !== t.me.settlement && (s.kind === 'village' || s.kind === 'hamlet' || s.kind === 'town'))
      .map((s) => ({ s, d: Math.hypot(s.x - t.body.x, s.z - t.body.z) })).filter((q) => q.d > 1700 && q.d < 4400).sort((a, b) => a.d - b.d)[0];
    if (!far) return;
    const named = () => t.goto.places().some((p) => p.id === `t${far.s.id}`);
    expect(named()).toBe(false);
    t.goto.told(far.s.id);
    expect(named()).toBe(true);
    expect((t.st.ext.goto as { seen: number[] }).seen).toContain(far.s.id);
    // a new mode over the same state (a load) remembers
    const again = new GotoMode(t.env);
    expect(again.places().some((p) => p.id === `t${far.s.id}`)).toBe(true);
    again.dispose();
  });

  it('walking into a settlement is going there: it is known afterwards', () => {
    const t = rig('goto-visit');
    const far = t.sim.world.settlements.filter((s) => s.id !== t.me.settlement).map((s) => ({ s, d: Math.hypot(s.x - t.body.x, s.z - t.body.z) })).filter((q) => q.d > 1700).sort((a, b) => a.d - b.d)[0];
    if (!far) return;
    expect(t.goto.knows(far.s.id)).toBe(false);
    t.body.x = far.s.x; t.body.z = far.s.z;
    t.sim.events.emit('hourStarted', {} as never);
    expect(t.goto.knows(far.s.id)).toBe(true);
  });

  it('any building of a place you know can be gone to from the wheel; the followers and the led animals come along', () => {
    const t = rig('goto-follow');
    const listed = new Set(t.goto.places().map((p) => p.ref));
    const other = [...t.st.buildings.values()].find((b) => b.settlement === t.me.settlement && b.construction >= 1 && !listed.has(b.id) && Math.hypot(b.x - t.body.x, b.z - t.body.z) > 80);
    expect(other).toBeTruthy();
    const opts: Array<{ id: string; enabled: boolean }> = [];
    t.goto.provider().list({} as never, t.st.run.playerId, { kind: 'building', id: other!.id } as never, opts as never);
    expect(opts.length).toBe(1);
    expect(opts[0].enabled).toBe(true);
    // a follower and a led animal
    const folk = [...t.st.persons.values()].find((p) => !p.death && p.id !== t.me.id)!;
    const summoned: Array<{ id: number; x: number; z: number }> = [];
    const commanded: Array<{ id: number; order: unknown }> = [];
    const animal = { id: 7, x: 0, z: 0 };
    const order = { kind: 'follow', leader: t.me.id, distance: 3 };
    Object.assign(t.env.zone, {
      agents: () => [{ personId: folk.id, order, mounted: false, person: folk }, { personId: 99999, order: { kind: 'follow', leader: 123456 }, person: {} }],
      summon: (id: number, x: number, z: number) => { summoned.push({ id, x, z }); },
      command: (id: number, o: unknown) => { commanded.push({ id, order: o }); },
      ledBy: () => [animal],
    });
    const place = t.goto.places().find((q) => q.kind === 'building' && Math.hypot(q.x - t.body.x, q.z - t.body.z) > 60)!;
    expect(t.goto.go(place).ok).toBe(true);
    runOut(t.sim);
    expect(summoned.map((q) => q.id)).toEqual([folk.id]);
    expect(commanded).toEqual([{ id: folk.id, order }]);
    expect(Math.hypot(summoned[0].x - t.body.x, summoned[0].z - t.body.z)).toBeLessThan(6);
    expect(Math.hypot(animal.x - t.body.x, animal.z - t.body.z)).toBeLessThan(6);
  });
});

describe('ride with the host: the march skipped', () => {
  function host(seed: string) {
    const ctx = milSim({ seed, body: true });
    const { sim } = ctx;
    const zone = { nav: { walkable: () => true, nearestWalkable: () => false }, agent: () => null, agents: () => [], command: () => undefined, summon: () => undefined, dismiss: () => undefined } as never;
    const player = { body: () => ({ x: ctx.body.x, y: 0, z: ctx.body.z, yaw: 0 }), placeAt: (x: number, z: number) => { ctx.body.x = x; ctx.body.z = z; } } as never;
    const campaign = new CampaignMode(sim, zone, player);
    // a host is set marching on a place by the scenario's own step, without the campaign beginning (a dummy takes `begin`)
    const dummy = { phase: null, begin: () => undefined } as unknown as CampaignMode;
    const r = castleScenario({ sim, campaign: dummy }) as { ok: boolean; army?: number };
    return { ...ctx, campaign, army: r.army!, ok: r.ok };
  }

  it('refuses what is not marching on a place; then the days pass in one go, camp at night on the road is slept through, and you take over before the walls', () => {
    const t = host('ride-a');
    expect(t.ok).toBe(true);
    expect(t.campaign.phase).toBeNull();
    expect(t.campaign.rideWith(t.army + 999).ok).toBe(false);
    const day0 = t.sim.absDay;
    const r = t.campaign.rideWith(t.army);
    expect(r).toMatchObject({ ok: true });
    expect(t.campaign.phase).toBe('march');
    expect(t.campaign.rideWith(t.army).reason).toMatch(/already/i);
    const seen = new Set<string>();
    for (let i = 0; i < 20000 && !seen.has('storm'); i++) {
      t.sim.step(0.25); t.campaign.update(0.25);
      if (t.campaign.phase) seen.add(t.campaign.phase);
    }
    expect(seen.has('storm')).toBe(true);
    // days passed (the march and the night), without the player stepping a pace of it
    expect(t.sim.absDay - day0).toBeGreaterThan(0.2);
    // and the player stands before the walls
    const tgt = t.sim.world.settlements[t.campaign.target]!;
    expect(Math.hypot(t.body.x - tgt.x, t.body.z - tgt.z)).toBeLessThan(400);
  });
});
