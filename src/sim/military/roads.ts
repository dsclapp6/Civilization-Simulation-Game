// Marching routes (SPEC §13: armies march along `world.roadGraph`). A* over the road graph from the node
// nearest the army to the node of the destination, off-road legs at both ends; the result is a polyline
// with the pace of each leg. The sim cannot import the player's planner (dependency rules), so this is
// the same idea in a smaller form.
import { MinHeap } from '../../core/heap';
import { dist, type P2 } from '../../core/math';
import type { RoadKind, WorldModel } from '../../world/types';

type Way = RoadKind | 'offroad';
const COST: Record<Way, number> = { highway: 0.8, road: 1, track: 1.2, path: 1.5, offroad: 2.4 };
/** How fast an army moves on each kind of way (1 = a plain road). */
export const PACE: Record<Way, number> = { highway: 1.15, road: 1, track: 0.9, path: 0.8, offroad: 0.55 };

export interface RoutePlan {
  points: P2[];
  /** Distance along the route at each point (m). */
  cum: number[];
  total: number;
  kinds: Way[];
}

interface GraphIndex { adj: Array<Array<{ to: number; edge: number; cost: number }>> }
const graphs = new WeakMap<WorldModel, GraphIndex>();

function indexOf(world: WorldModel): GraphIndex {
  let g = graphs.get(world);
  if (g) return g;
  const nodes = world.roadGraph.nodes;
  const adj: GraphIndex['adj'] = nodes.map(() => []);
  world.roadGraph.edges.forEach((e, i) => {
    if (e.a < 0 || e.b < 0 || e.a >= nodes.length || e.b >= nodes.length) return;
    const road = world.roads[e.roadId];
    const cost = e.length * COST[road ? road.kind : 'road'];
    adj[e.a].push({ to: e.b, edge: i, cost });
    adj[e.b].push({ to: e.a, edge: i, cost });
  });
  g = { adj };
  graphs.set(world, g);
  return g;
}

function nearestNodes(world: WorldModel, p: P2, k: number): Array<{ id: number; d: number }> {
  const best: Array<{ id: number; d: number }> = [];
  for (const n of world.roadGraph.nodes) {
    const d = dist(p.x, p.z, n.x, n.z);
    if (best.length < k || d < best[best.length - 1].d) {
      best.push({ id: n.id, d });
      best.sort((a, b) => a.d - b.d);
      if (best.length > k) best.pop();
    }
  }
  return best;
}

function straight(from: P2, to: P2): RoutePlan {
  const d = dist(from.x, from.z, to.x, to.z);
  return { points: [{ x: from.x, z: from.z }, { x: to.x, z: to.z }], cum: [0, d], total: d, kinds: ['offroad'] };
}

/** Plans a route over the roads from a point to a point (`settlement` helps pick the destination's own node). */
export function planMarch(world: WorldModel, from: P2, to: P2, settlement?: number): RoutePlan {
  const nodes = world.roadGraph.nodes;
  if (nodes.length === 0 || dist(from.x, from.z, to.x, to.z) < 30) return straight(from, to);
  const g = indexOf(world);
  const S = nodes.length, G = nodes.length + 1;
  const startLinks = nearestNodes(world, from, 5);
  const endLinks = nearestNodes(world, to, 5);
  if (settlement !== undefined) {
    const own = nodes.find((n) => n.settlement === settlement);
    if (own && !endLinks.some((l) => l.id === own.id)) endLinks.push({ id: own.id, d: dist(to.x, to.z, own.x, own.z) });
  }
  const endCost = new Map<number, number>();
  for (const l of endLinks) endCost.set(l.id, l.d * COST.offroad);

  const best = new Float64Array(nodes.length + 2).fill(Infinity);
  const prev = new Int32Array(nodes.length + 2).fill(-1);
  const prevEdge = new Int32Array(nodes.length + 2).fill(-1);
  const done = new Uint8Array(nodes.length + 2);
  const heap = new MinHeap(256);
  const h = (x: number, z: number): number => dist(x, z, to.x, to.z) * COST.highway;
  best[S] = 0;
  heap.push(h(from.x, from.z), S);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === G) break;
    if (u === S) {
      for (const l of startLinks) {
        const c = l.d * COST.offroad;
        if (c < best[l.id]) { best[l.id] = c; prev[l.id] = S; prevEdge[l.id] = -1; heap.push(c + h(nodes[l.id].x, nodes[l.id].z), l.id); }
      }
      continue;
    }
    const ec = endCost.get(u);
    if (ec !== undefined && best[u] + ec < best[G]) {
      best[G] = best[u] + ec; prev[G] = u; prevEdge[G] = -1;
      heap.push(best[G], G);
    }
    for (const e of g.adj[u]) {
      const c = best[u] + e.cost;
      if (c < best[e.to]) {
        best[e.to] = c; prev[e.to] = u; prevEdge[e.to] = e.edge;
        heap.push(c + h(nodes[e.to].x, nodes[e.to].z), e.to);
      }
    }
  }
  if (!Number.isFinite(best[G])) return straight(from, to);

  const seq: number[] = [];
  for (let v = G; v !== -1; v = prev[v]) seq.push(v);
  seq.reverse();

  const points: P2[] = [{ x: from.x, z: from.z }];
  const kinds: Way[] = [];
  const push = (p: P2, kind: Way): void => {
    const last = points[points.length - 1];
    if (dist(last.x, last.z, p.x, p.z) < 0.5) return;
    points.push({ x: p.x, z: p.z });
    kinds.push(kind);
  };
  for (let i = 1; i < seq.length; i++) {
    const v = seq[i];
    if (v === G) { push(to, 'offroad'); break; }
    const nv = nodes[v];
    const ei = prevEdge[v];
    if (ei < 0) { push(nv, 'offroad'); continue; }
    const edge = world.roadGraph.edges[ei];
    const road = world.roads[edge.roadId];
    const nu = nodes[seq[i - 1]];
    if (!road || road.points.length < 2) { push(nv, 'road'); continue; }
    const pts = road.points;
    const forward = dist(pts[0].x, pts[0].z, nu.x, nu.z) <= dist(pts[pts.length - 1].x, pts[pts.length - 1].z, nu.x, nu.z);
    if (forward) for (let k = 0; k < pts.length; k++) push(pts[k], road.kind);
    else for (let k = pts.length - 1; k >= 0; k--) push(pts[k], road.kind);
    push(nv, road.kind);
  }
  if (points.length < 2) return straight(from, to);
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1].x, points[i - 1].z, points[i].x, points[i].z));
  return { points, cum, total: cum[cum.length - 1], kinds };
}

/** Position and pace at distance `s` along a plan. */
export function sampleRoute(plan: RoutePlan, s: number, out: { x: number; z: number; pace: number }): void {
  const { points, cum, total } = plan;
  const d = Math.max(0, Math.min(total, s));
  let lo = 0, hi = points.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid - 1;
  }
  const a = points[lo], b = points[lo + 1];
  const len = cum[lo + 1] - cum[lo];
  const t = len > 1e-9 ? Math.min(1, Math.max(0, (d - cum[lo]) / len)) : 1;
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.pace = PACE[plan.kinds[Math.min(lo, plan.kinds.length - 1)] ?? 'road'];
}

/** Distance from a point to the nearest point of the road network is not needed: armies stay on the plan. */
export function routeLength(world: WorldModel, from: P2, to: P2, settlement?: number): number {
  return planMarch(world, from, to, settlement).total;
}
