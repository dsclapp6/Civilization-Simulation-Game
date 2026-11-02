// A walled place for the storm tests: a square ring of curtain wall with four corner towers and a gatehouse in the south wall,
// built into a combat rig's simulation (buildings in the state, footprints in the fake zone's collisions).
import type { BuildingKind } from '../../src/content/types';
import { BUILDINGS } from '../../src/content/types';
import type { BuildingState } from '../../src/sim/state';
import type { SiegeSetup } from '../../src/sim/military/war';
import { adultMen, combatRig, setStats, type CombatRig } from './helpers';

export interface Fort {
  sid: number;
  cx: number;
  cz: number;
  half: number;
  gate: BuildingState;
  walls: BuildingState[];
  towers: BuildingState[];
}

/** Builds the ring round the settlement's own position (so "away from the centre" means outwards). */
export function fortify(r: Pick<CombatRig, 'sim' | 'zone'>, kind: 'wall' | 'palisade' = 'wall', half = 36, sid?: number): Fort {
  let nextId = 700000;
  const s = (sid !== undefined ? r.sim.world.settlements.find((x) => x.id === sid) : undefined)
    ?? r.sim.world.settlements.find((x) => x.kind === 'castle') ?? r.sim.world.settlements[0];
  const st = r.sim.state;
  // the world's own gatehouse and towers would confuse the ring: take them down
  const keep = (st.buildingsAt.get(s.id) ?? []).filter((b) => !['gatehouse', 'tower', 'wall', 'palisade'].includes(b.kind));
  for (const b of st.buildingsAt.get(s.id) ?? []) if (!keep.includes(b)) st.buildings.delete(b.id);
  st.buildingsAt.set(s.id, keep);
  const make = (k: BuildingKind, x: number, z: number, rot: number, level = 1): BuildingState => {
    const b: BuildingState = {
      id: nextId++, plot: -1, kind: k, level, settlement: s.id, construction: 1, damage: 0, onFire: false, owner: 0, household: 0,
      occupied: false, x, z, rot, culture: 'anglo', seed: 1,
    };
    st.buildings.set(b.id, b);
    let list = st.buildingsAt.get(s.id);
    if (!list) { list = []; st.buildingsAt.set(s.id, list); }
    list.push(b);
    st.touchBuilding(b);
    // the footprint is solid to the fake navigation (a gatehouse is not)
    if (BUILDINGS[k].blocks) {
      const def = BUILDINGS[k];
      const c = Math.cos(rot), sn = Math.sin(rot);
      // an axis-aligned cover of the rotated footprint (rot is 0 or a right angle here)
      const hw = Math.abs(c) * def.w / 2 + Math.abs(sn) * def.d / 2, hd = Math.abs(sn) * def.w / 2 + Math.abs(c) * def.d / 2;
      r.zone.walls.push({ x0: x - hw, z0: z - hd, x1: x + hw, z1: z + hd });
    }
    return b;
  };
  const cx = s.x, cz = s.z;
  const walls: BuildingState[] = [];
  const towers: BuildingState[] = [];
  const seg = BUILDINGS[kind].w;
  const gateGap = 8;
  // south wall (z = cz + half), with the gate in the middle
  for (let x = -half + 3 + seg / 2; x < half - 3; x += seg) {
    if (Math.abs(x) < gateGap + seg / 2) continue;
    walls.push(make(kind, cx + x, cz + half, 0));
  }
  for (let x = -half + 3 + seg / 2; x < half - 3; x += seg) walls.push(make(kind, cx + x, cz - half, 0));
  for (let z = -half + 3 + seg / 2; z < half - 3; z += seg) {
    walls.push(make(kind, cx - half, cz + z, Math.PI / 2));
    walls.push(make(kind, cx + half, cz + z, Math.PI / 2));
  }
  const gate = make('gatehouse', cx, cz + half, 0, 2);
  if (kind === 'wall') for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) towers.push(make('tower', cx + sx * half, cz + sz * half, 0));
  return { sid: s.id, cx, cz, half, gate, walls, towers };
}

export interface Kits { archers: number; foot: number; horse?: number }

const BOW = { weapon: 'dagger', ranged: 'longbow', armour: [] as string[] };
const SWORD = { weapon: 'sword', shield: 'shield', armour: ['padded_armour'] };
const SPEAR = { weapon: 'spear', armour: [] as string[] };

export interface Storm {
  r: CombatRig;
  fort: Fort;
  attackers: number[];
  defenders: number[];
  id: number;
  setup: SiegeSetup;
}

/** A storm of the ring: `att` and `def` give the numbers of archers and foot on each side. */
export function storm(seed: string, att: Kits, def: Kits, over: Partial<SiegeSetup> = {}, wall: 'wall' | 'palisade' = 'wall', player?: 'attacker' | 'defender'): Storm {
  const r = combatRig({ seed, preset: 'small', player: !!player });
  const fort = fortify(r, wall);
  const na = att.archers + att.foot, nd = def.archers + def.foot;
  const men = adultMen(r.sim, na + nd, 17, 45);
  men.forEach((p) => { setStats(p, { str: 12, agi: 11, end: 12 }); p.needs.hunger = 1; p.needs.rest = 1; p.rankTier = 2; p.traits = []; });
  const A = men.slice(0, na), D = men.slice(na);
  A.forEach((p, i) => r.combat.arena.setKitOverride(p.id, i < att.foot ? (i % 2 ? SWORD : SPEAR) : BOW));
  D.forEach((p, i) => r.combat.arena.setKitOverride(p.id, i < def.foot ? (i % 2 ? SWORD : SPEAR) : BOW));
  const camp = { x: fort.cx, z: fort.cz + fort.half + 70 };
  const setup: SiegeSetup = { settlement: fort.sid, attackers: 0, defenders: 1, rams: 1, ladders: 3, engines: 0, camp, ...over };
  const pid = r.sim.state.run.playerId;
  if (player) r.player!.placeAt(player === 'attacker' ? camp.x : fort.cx, player === 'attacker' ? camp.z : fort.cz + 20, player === 'attacker' ? Math.PI : 0);
  const at = player ? { x: r.player!.body()!.x, z: r.player!.body()!.z } : camp;
  const sa = player === 'attacker' ? [pid, ...A.map((p) => p.id)] : A.map((p) => p.id);
  const sd = player === 'defender' ? [pid, ...D.map((p) => p.id)] : D.map((p) => p.id);
  const id = r.combat.engage(
    [{ faction: 'house:1', people: sa }, { faction: 'house:2', people: sd }],
    { at, reason: 'storm', siege: setup, yieldAllowed: true },
  );
  return { r, fort, attackers: A.map((p) => p.id), defenders: D.map((p) => p.id), id, setup };
}
