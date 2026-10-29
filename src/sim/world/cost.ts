// Movement cost per tile (x10; 0 = impassable). Recomputed locally whenever
// a tile's contents change (tree felled, hut built, flood, fire).
import nodesJson from '../content/nodes.json';
import { B, NODE_KEYS } from '../types';
import { World } from './world';

const BIOME_COST = [0, 11, 0, 28, 20, 10, 13, 17, 10, 12, 12, 13, 24, 32];

interface NodeDefLite { tree?: boolean; adjacent?: boolean; }
const NODE_DEFS = nodesJson as Record<string, NodeDefLite>;
/** Rock-like nodes (stone, flint, ore) are solid; workers mine them from beside. */
const SOLID_NODE = NODE_KEYS.map((k) => !!NODE_DEFS[k]?.adjacent && k !== 'clay');
const TREE_NODE = NODE_KEYS.map((k) => !!NODE_DEFS[k]?.tree);

export function localSlope(world: World, i: number): number {
  const x = i % world.w, y = (i / world.w) | 0;
  const e = world.elev[i];
  let m = 0;
  if (x > 0) m = Math.max(m, Math.abs(world.elev[i - 1] - e));
  if (x < world.w - 1) m = Math.max(m, Math.abs(world.elev[i + 1] - e));
  if (y > 0) m = Math.max(m, Math.abs(world.elev[i - world.w] - e));
  if (y < world.h - 1) m = Math.max(m, Math.abs(world.elev[i + world.w] - e));
  return m;
}

export function tileCost(world: World, i: number): number {
  const b = world.biome[i];
  let c = BIOME_COST[b];
  if (c === 0) return 0;
  if (world.blocked[i]) return 0;
  const nid = world.node[i];
  if (nid >= 0) {
    const nd = world.nodes[nid];
    if (nd) {
      if (SOLID_NODE[nd.kind] && nd.amount > 0) return 0;
      if (TREE_NODE[nd.kind] && nd.growth > 0.5) c += 4;
    }
  }
  if (b !== B.RIVER) c += Math.min(30, localSlope(world, i) * 3.5);
  if (world.flood[i]) c += 18;
  if (world.fire[i]) c += 40;
  return Math.max(1, Math.min(255, Math.round(c)));
}

export function recomputeCost(world: World, i: number): void {
  world.cost[i] = tileCost(world, i);
}

export function recomputeAllCosts(world: World): void {
  for (let i = 0; i < world.n; i++) world.cost[i] = tileCost(world, i);
}
