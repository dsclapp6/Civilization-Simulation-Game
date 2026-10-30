// Placeholder (wave 2 AGENTS replaces this file): an empty detail zone over bare terrain.
import type { P2 } from '../core/math';
import type { CharacterDrawItem } from '../core/view';
import type { EconomyApi } from '../sim/economy/types';
import type { Simulation } from '../sim/sim';
import type { SocialApi } from '../sim/social/types';
import type { MoveResult, NavApi, ZoneApi } from './types';

export interface AgentsDeps { economy: EconomyApi; social: SocialApi }

export function installAgents(sim: Simulation, _deps: AgentsDeps): ZoneApi {
  const world = sim.world;
  let player: CharacterDrawItem | null = null;
  const list: CharacterDrawItem[] = [];
  const nav: NavApi = {
    groundY: (x, z) => Math.max(world.heightAt(x, z), world.waterSurfaceAt(x, z) ?? -Infinity),
    walkable: (x, z) => Number.isFinite(world.walkCostAt(x, z)),
    speedFactor: (x, z) => 1 / Math.max(0.5, Math.min(3, world.walkCostAt(x, z))),
    move(x, z, dx, dz, _r, out: MoveResult) {
      const nx = x + dx, nz = z + dz;
      const ok = Number.isFinite(world.walkCostAt(nx, nz));
      out.x = ok ? nx : x; out.z = ok ? nz : z; out.blocked = !ok; out.wading = (world.waterSurfaceAt(out.x, out.z) ?? -Infinity) > world.heightAt(out.x, out.z);
      return out;
    },
    findPath: (from: P2, to: P2) => [{ x: from.x, z: from.z }, { x: to.x, z: to.z }],
    nearestWalkable: (x, z, _d, out) => { out.x = x; out.z = z; return true; },
    doorOf: () => null,
  };
  const zone: ZoneApi = {
    nav,
    agents: () => [],
    agent: () => null,
    animals: () => [],
    whereabouts: (person) => {
      const p = sim.state.persons.get(person);
      const s = world.settlements.find((x) => x.id === p?.settlement);
      return { activity: 'home', settlement: s?.id ?? -1, building: -1, indoors: false, x: s?.x ?? 0, z: s?.z ?? 0, label: 'At home' };
    },
    interactables: (_x, _z, _yaw, _r, out) => { out.length = 0; return out; },
    hold: () => {},
    release: () => {},
    command: () => {},
    say: () => {},
    attachPlayer: (_person, draw) => { player = draw; },
    detachPlayer: () => { player = null; },
    resync: () => {},
    propsFor: () => ({ mainHand: 'none', offHand: 'none', carry: 'none' }),
  };
  sim.view.setSource('characters', () => {
    list.length = 0;
    if (player) list.push(player);
    return list;
  });
  return zone;
}
