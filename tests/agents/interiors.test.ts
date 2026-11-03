// Interiors in the world (docs/INTERIORS.md): a body walks in at a door that opens before it, up a stair to the floor above, is
// stopped by a door locked for the night, and the people whose day has them inside are there.
import { describe, expect, it } from 'vitest';
import { installAgents } from '../../src/agents';
import type { Zone } from '../../src/agents/zone';
import { interiorSource } from '../../src/app/interior';
import { installEconomy } from '../../src/sim/economy';
import { installSocial } from '../../src/sim/social';
import { installPlayer } from '../../src/player';
import { EMPTY_INPUT, type InputState, type PlayerApi } from '../../src/player/types';
import type { BuildingKind } from '../../src/content/types';
import type { Simulation } from '../../src/sim/sim';
import { newSim } from '../sim/helpers';

interface Rig { sim: Simulation; zone: Zone; player: PlayerApi }

function rig(time = 0.45): Rig {
  const sim = newSim({ preset: 'small', seed: 'interiors' });
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const zone = installAgents(sim, { economy, social });
  const player = installPlayer(sim, { zone, economy, social });
  zone.nav.setInteriorSource(interiorSource(sim.world));
  sim.state.clock.absDay = Math.floor(sim.absDay) + time;
  sim.step(0.05);
  return { sim, zone, player };
}

function building(r: Rig, kinds: BuildingKind[]): number {
  for (const b of r.sim.state.buildings.values()) {
    if (!kinds.includes(b.kind) || b.construction < 1) continue;
    const l = r.zone.nav.interiors.placed(b);
    if (l && l.plan.main >= 0) return b.id;
  }
  return -1;
}

/** Stand `back` m out from a building's main door facing in; returns the yaw to walk. */
function atDoor(r: Rig, id: number, back = 1.6): number {
  const b = r.sim.state.buildings.get(id)!;
  const l = r.zone.nav.interiors.placed(b)!;
  const d = l.plan.doors[l.plan.main];
  const w = r.zone.nav.interiors.toWorld(l, d.x + d.nx * back, d.z + d.nz * back, { x: 0, z: 0 });
  const yaw = Math.atan2(-d.nx, -d.nz) + l.rot;
  r.player.placeAt(w.x, w.z, yaw, d.sy > 0.5 ? l.y + d.sy : undefined);
  r.sim.step(0.05);
  return yaw;
}

function walk(r: Rig, yaw: number, seconds: number): void {
  const input: InputState = { ...EMPTY_INPUT, forward: 1, cameraYaw: yaw };
  for (let t = 0; t < seconds; t += 0.05) { r.player.setInput(input); r.sim.step(0.05); }
  r.player.setInput(EMPTY_INPUT);
}

function where(r: Rig): { inside: number; level: number; y: number } {
  const b = r.player.body()!;
  const out = { level: -1 };
  const inside = r.zone.nav.interiorAt!(b.x, b.z, b.y, out);
  return { inside, level: out.level, y: b.y };
}

describe('interiors in the world', () => {
  it('walks in at the door of a cottage, a church and a workshop (the door opens before him)', () => {
    const r = rig();
    for (const kinds of [['cottage', 'hovel'], ['church', 'chapel'], ['smithy', 'carpenter', 'bakehouse', 'weaver']] as BuildingKind[][]) {
      const id = building(r, kinds);
      if (id < 0) continue;
      const yaw = atDoor(r, id);
      walk(r, yaw, 3);
      expect(where(r).inside, kinds.join('/')).toBe(id);
    }
  });

  it('goes up the stair of a townhouse to the floor above', () => {
    const r = rig();
    const id = building(r, ['townhouse']);
    expect(id).toBeGreaterThanOrEqual(0);
    const b = r.sim.state.buildings.get(id)!;
    const l = r.zone.nav.interiors.placed(b)!;
    const st = l.plan.stairs.find((s) => s.from === 0)!;
    const fx = st.axis === 'x' ? (st.dir > 0 ? st.x0 - 0.4 : st.x1 + 0.4) : (st.x0 + st.x1) / 2;
    const fz = st.axis === 'z' ? (st.dir > 0 ? st.z0 - 0.4 : st.z1 + 0.4) : (st.z0 + st.z1) / 2;
    const w = r.zone.nav.interiors.toWorld(l, fx, fz, { x: 0, z: 0 });
    const lyaw = st.axis === 'x' ? (st.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (st.dir > 0 ? 0 : Math.PI);
    r.player.placeAt(w.x, w.z, lyaw + l.rot, l.y + l.plan.levels[0].y);
    r.sim.step(0.05);
    expect(where(r).inside).toBe(id);
    walk(r, lyaw + l.rot, 4);
    const at = where(r);
    expect(at.inside).toBe(id);
    expect(at.level).toBe(st.to);
    expect(at.y).toBeGreaterThan(l.y + l.plan.levels[st.to].y - 0.2);
  });

  it('a home is barred to a stranger at night', () => {
    const r = rig(0.95);
    const me = r.sim.state.persons.get(r.sim.state.run.playerId)!;
    let id = -1;
    for (const b of r.sim.state.buildings.values()) {
      if (b.kind !== 'cottage' || b.household === me.household) continue;
      const l = r.zone.nav.interiors.placed(b);
      if (l && l.plan.main >= 0 && !r.zone.doors.mayPass(me, b)) { id = b.id; break; }
    }
    expect(id).toBeGreaterThanOrEqual(0);
    const yaw = atDoor(r, id);
    walk(r, yaw, 3);
    expect(where(r).inside).toBe(-1);
    // let in, he goes in
    r.zone.doors.invite(me.id, id, r.sim.absDay + 0.2);
    walk(r, yaw, 3);
    expect(where(r).inside).toBe(id);
  });
});
