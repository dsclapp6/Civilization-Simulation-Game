import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../src/content/types';
import { DAYS_PER_YEAR, toDate } from '../../src/core/time';
import { PALETTE } from '../../src/assets/palette';
import { sampleWeather } from '../../src/sim/weather';
import { doorPoint } from '../../src/sim/view-impl';
import { newSim } from './helpers';

describe('SimView implementation', () => {
  const sim = newSim({ seed: 'view', preset: 'small' });
  const view = sim.view;

  it('exposes the world and a street-level mode', () => {
    expect(view.world).toBe(sim.world);
    expect(view.mode()).toBe('street');
  });

  it('reports the clock', () => {
    sim.dispatch({ type: 'setSpeed', speed: 3 });
    const c = view.clock();
    expect(c.absDay).toBe(sim.absDay);
    expect(c.speed).toBe(3);
    expect(c.paused).toBe(false);
    expect(c.calendarRate).toBe(1);
    const d = toDate(sim.absDay);
    expect(c.year).toBe(d.year);
    expect(c.season).toBe(d.season);
    expect(c.dayOfSeason).toBe(d.dayOfSeason);
    expect(c.dayFraction).toBeCloseTo(d.dayFraction, 9);
    expect(c.isNight).toBe(false); // the run starts in the morning
    sim.dispatch({ type: 'setSpeed', speed: 1 });
    sim.dispatch({ type: 'setActionTime', on: true });
    expect(view.clock().calendarRate).toBeLessThan(0.1);
    sim.dispatch({ type: 'setActionTime', on: false });
    sim.dispatch({ type: 'pause' });
    expect(view.clock().paused).toBe(true);
    sim.dispatch({ type: 'resume' });
    expect(view.clock().skipping).toBeNull();
  });

  it('puts the player at the door of their home with their household standing nearby, reusing objects', () => {
    const pv = view.player()!;
    expect(pv).not.toBeNull();
    expect(pv.personId).toBe(sim.state.run.playerId);
    expect(pv.alive).toBe(true);
    expect(pv.mounted).toBe(false);
    const player = sim.state.persons.get(pv.personId)!;
    const home = sim.state.buildings.get(sim.state.households.get(player.household)!.home);
    if (home) {
      const door = doorPoint(home, 1.4);
      expect(pv.x).toBeCloseTo(door.x, 6);
      expect(pv.z).toBeCloseTo(door.z, 6);
      // within a few metres of the building's edge
      const d = Math.hypot(pv.x - home.x, pv.z - home.z);
      expect(d).toBeGreaterThan(BUILDINGS[home.kind].d / 2);
      expect(d).toBeLessThan(BUILDINGS[home.kind].d / 2 + 3);
    }
    expect(Number.isFinite(pv.y)).toBe(true);
    const focus = view.focus();
    expect(focus.x).toBe(pv.x);
    expect(focus.z).toBe(pv.z);

    const chars = view.characters();
    expect(chars.length).toBeGreaterThanOrEqual(1);
    const me = chars.find((c) => c.id === pv.personId)!;
    expect(me.highlight).toBe(3);
    expect(me.anim).toBe('idle');
    expect(me.look.age).toBeCloseTo(12, 0);
    const members = sim.state.households.get(player.household)!.members.filter((id) => !sim.state.persons.get(id)!.death);
    expect(chars.map((c) => c.id).sort()).toEqual(members.sort());
    for (const c of chars) {
      expect(Number.isFinite(c.x + c.y + c.z + c.yaw)).toBe(true);
      expect(c.lookVersion).toBeGreaterThan(0);
    }
    // arrays and items are reused between frames
    expect(view.characters()).toBe(chars);
    expect(view.characters().find((c) => c.id === pv.personId)).toBe(me);
    expect(view.player()).toBe(pv);
  });

  it('lists every building with its simulated state and a stable version', () => {
    const b = view.buildings();
    expect(b.length).toBe(sim.world.plots.length);
    const v = view.buildingsVersion();
    expect(view.buildingsVersion()).toBe(v);
    expect(view.buildings()).toBe(b);
    const first = b[0];
    const plot = sim.world.plots[0];
    expect(first).toMatchObject({ id: plot.id, kind: plot.kind, x: plot.x, z: plot.z, rot: plot.rot, culture: plot.culture, settlement: plot.settlement });
    expect(first.construction).toBe(1);
    expect(first.damage).toBe(0);
    expect(first.onFire).toBe(false);
    // occupied homes show smoke; changes bump the version
    const occupied = b.filter((x) => x.occupied).length;
    expect(occupied).toBeGreaterThan(50);
    const target = sim.state.buildings.get(first.id)!;
    target.damage = 0.4; target.onFire = true; sim.state.touchBuilding(target);
    expect(view.buildingsVersion()).toBe(v + 1);
    expect(view.buildings().find((x) => x.id === first.id)).toMatchObject({ damage: 0.4, onFire: true });
    // houses of nobles show their colours
    expect(b.some((x) => x.ownerColor !== undefined)).toBe(true);
  });

  it('lists the open-field strips with their crop and growth, versioned by visible change', () => {
    const strips = view.strips();
    expect(strips.length).toBe(sim.world.strips.length);
    expect(strips[0].poly).toBe(sim.world.strips[0].poly);
    const v = view.stripsVersion();
    expect(view.stripsVersion()).toBe(v);
    for (const s of strips) {
      expect(s.growth).toBeGreaterThanOrEqual(0);
      expect(s.growth).toBeLessThanOrEqual(1);
    }
    // a few days of growing change what the fields look like
    sim.advanceDays(3);
    expect(view.stripsVersion()).toBeGreaterThan(v);
    const states = new Set(view.strips().map((s) => s.state));
    expect(states.size).toBeGreaterThanOrEqual(2);
  });

  it('follows the three-field rotation and the seasons: harvest in late summer, stubble after, fallow resting', () => {
    const s2 = newSim({ seed: 'fields', preset: 'tiny' });
    const seen = new Set<string>();
    for (let day = 0; day < DAYS_PER_YEAR; day++) {
      s2.advanceDays(1);
      for (const st of s2.view.strips()) seen.add(st.state);
    }
    for (const want of ['ploughed', 'sown', 'growing', 'ripe', 'harvested', 'stubble', 'fallow']) expect(seen.has(want as never), want).toBe(true);
    // each field has exactly one role per year
    const roles = new Map<number, Set<string>>();
    for (const st of s2.state.strips.values()) {
      const set = roles.get(st.field) ?? new Set<string>();
      set.add(st.crop === 'fallow' ? 'fallow' : st.crop);
      roles.set(st.field, set);
    }
    expect(roles.size).toBe(3);
  });

  it('has a seasonal weather model with day-to-day persistence', () => {
    // continuity: small steps in time give small changes
    let maxJump = 0;
    let prev = sampleWeather('persist', 0);
    for (let t = 0.05; t < 64; t += 0.05) {
      const w = sampleWeather('persist', t);
      maxJump = Math.max(maxJump, Math.abs(w.cloud - prev.cloud), Math.abs(w.temperature - prev.temperature) / 20);
      prev = { ...w };
    }
    expect(maxJump).toBeLessThan(0.2);
    // seasons: warm summers, cold winters, snow only when cold, rain only when not
    let summer = 0, winter = 0, nSummer = 0, nWinter = 0, snowOnWarm = 0, rainOnCold = 0, rainy = 0, snowy = 0;
    for (let y = 0; y < 20; y++) {
      for (let d = 0; d < 16; d += 0.25) {
        const w = sampleWeather('seasons', y * 16 + d);
        if (d >= 4 && d < 8) { summer += w.temperature; nSummer++; }
        if (d >= 12) { winter += w.temperature; nWinter++; }
        if (w.snow > 0 && w.temperature > 1.5) snowOnWarm++;
        if (w.rain > 0 && w.temperature < 0.5) rainOnCold++;
        if (w.rain > 0.3) rainy++;
        if (w.snow > 0.3) snowy++;
        for (const k of ['cloud', 'rain', 'snow', 'fog'] as const) { expect(w[k]).toBeGreaterThanOrEqual(0); expect(w[k]).toBeLessThanOrEqual(1); }
      }
    }
    expect(summer / nSummer).toBeGreaterThan(winter / nWinter + 8);
    expect(snowOnWarm).toBe(0);
    expect(rainOnCold).toBe(0);
    expect(rainy).toBeGreaterThan(20);
    expect(snowy).toBeGreaterThan(5);
    // the view reports it, adjusted for the player's altitude, and snow settles in winter
    const wv = view.weather();
    for (const k of ['cloud', 'rain', 'snow', 'fog', 'snowCover'] as const) expect(wv[k]).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(wv.temperature + wv.windX + wv.windZ)).toBe(true);
    const winterSim = newSim({ seed: 'snow', preset: 'tiny' });
    let maxCover = 0;
    for (let y = 0; y < 6; y++) {
      for (let h = 0; h < 16 * 24; h++) { winterSim.advanceHours(1); maxCover = Math.max(maxCover, winterSim.state.weather.snowCover); }
    }
    expect(maxCover).toBeGreaterThan(0.05);
    expect(winterSim.view.weather().snowCover).toBe(winterSim.state.weather.snowCover);
  });

  it('has no animals, projectiles or fx yet, a map marker for the player and a felled-scatter set', () => {
    expect(view.animals()).toEqual([]);
    expect(view.projectiles()).toEqual([]);
    expect(view.drainFx()).toEqual([]);
    const markers = view.mapMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0].kind).toBe('player');
    expect(markers[0].id).toBe(sim.state.run.playerId);
    expect(view.felled().size).toBe(0);
    const v0 = view.felledVersion();
    sim.view.markFelled(4242);
    expect(view.felled().has(4242)).toBe(true);
    expect(view.felledVersion()).toBe(v0 + 1);
    sim.view.markFelled(4242);
    expect(view.felledVersion()).toBe(v0 + 1);
    expect(sim.state.ext['felled']).toEqual([4242]);
  });

  it('uses only data from the shared palette for looks', () => {
    for (const c of view.characters()) {
      expect(PALETTE.skinTones.length).toBeGreaterThan(0);
      expect(c.look.skin).toBeGreaterThan(0);
      expect(c.look.clothing.tunic).toBeGreaterThan(0);
    }
  });
});
