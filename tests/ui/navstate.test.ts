// The per-frame snapshot of the places to point at: the objectives module's markers first, then the church and the
// market of the place, then the pin. A spot marked twice shows once.
import { describe, expect, it } from 'vitest';
import { MockObjectives } from '../../src/ui/dev/mockObjectives';
import { PinStore } from '../../src/ui/core/pins';
import { NavState } from '../../src/ui/hud/navstate';
import type { GameServices, UiHost } from '../../src/ui/types';
import { rig } from '../player/fakes';

function setup(): { nav: NavState; game: GameServices; host: UiHost; pins: PinStore; mock: MockObjectives } {
  const r = rig({ preset: 'small' });
  const mock = new MockObjectives(r.sim, r.zone);
  const game = { sim: r.sim, economy: r.economy, social: r.social, zone: r.zone, player: r.player, objectives: mock } as unknown as GameServices;
  const host = { renderer: () => null } as unknown as UiHost;
  return { nav: new NavState(), game, host, pins: new PinStore(), mock };
}

describe('The places to point at', () => {
  it('has the tracked task as the primary marker, and home', () => {
    const { nav, game, host, pins } = setup();
    nav.update(game, host, pins);
    expect(nav.primary()).not.toBeNull();
    expect(nav.markers.some((m) => m.kind === 'home')).toBe(true);
    for (const m of nav.markers) { expect(Number.isFinite(m.dist)).toBe(true); expect(Number.isFinite(m.yaw)).toBe(true); }
  });

  it('shows a pin that is somewhere new, but not one that sits on a marker already there', () => {
    const { nav, game, host, pins } = setup();
    nav.update(game, host, pins);
    const home = nav.markers.find((m) => m.kind === 'home')!;
    pins.set({ x: home.x + 1, z: home.z - 1, label: 'On the home' });
    nav.update(game, host, pins);
    expect(nav.markers.some((m) => m.kind === 'pin')).toBe(false);
    pins.set({ x: home.x + 40, z: home.z, label: 'Elsewhere' });
    nav.update(game, host, pins);
    expect(nav.markers.filter((m) => m.kind === 'pin').length).toBe(1);
  });

  it('keeps the module’s markers over ours when both name the same place', () => {
    const { nav, game, host, pins, mock } = setup();
    nav.update(game, host, pins);
    const before = nav.markers.length;
    // the module marks the place the church is in as a found place: our own church marker is then not drawn on top of it
    const church = nav.markers.find((m) => m.kind === 'church')!;
    expect(church).toBeDefined();
    mock.trackPlace({ kind: 'building', id: 1, x: church.x, z: church.z, label: 'St Mary’s church' });
    nav.update(game, host, pins);
    expect(nav.markers.some((m) => m.kind === 'place')).toBe(true);
    expect(nav.markers.some((m) => m.kind === 'church')).toBe(false);
    expect(nav.markers.length).toBe(before);
  });

  it('never drops the primary marker, even when something else stands on it', () => {
    const { nav, game, host, pins } = setup();
    nav.update(game, host, pins);
    const p = nav.primary()!;
    pins.set({ x: p.x, z: p.z, label: 'Same' });
    nav.update(game, host, pins);
    expect(nav.primary()).not.toBeNull();
    expect(nav.markers.some((m) => m.kind === 'pin')).toBe(false);
  });
});
