// Route planning for map travel (SPEC §2): A* over `world.roadGraph` from the node nearest the player
// to the node of the destination, with straight off-road legs at both ends. The result is a polyline the
// travel runner walks along.
import { MinHeap } from '../core/heap';
import { dist, type P2 } from '../core/math';
import type { RoadKind, WorldModel } from '../world/types';

export type LegKind = RoadKind | 'offroad';

/** Relative cost of a metre of each kind of way (route choice). */
const LEG_COST: Record<LegKind, number> = { highway: 0.8, road: 1, track: 1.2, path: 1.5, offroad: 2.2 };
/** How quickly the party covers each kind of way (1 = a plain road). */
export const PACE_FACTOR: Record<LegKind, number> = { highway: 1.15, road: 1, track: 0.9, path: 0.78, offroad: 0.6 };

export interface RoutePlan {
  points: P2[];
  /** Distance along the route (m) at each point. */
  cum: number[];
  total: number;
  /** Kind of way of segment i (points[i] → points[i + 1]). */
  kinds: LegKind[];
}

interface GraphIndex {
  n: number;
  /** adjacency: for node u, the edges leaving it */
  adj: Array<Array<{ to: number; edge: number; cost: number }>>;
}

const cache = new WeakMap<WorldModel, GraphIndex>();

function indexOf(world: WorldModel): GraphIndex {
  let g = cache.get(world);
  if (g) return g;
  const nodes = world.roadGraph.nodes;
  const adj: GraphIndex['adj'] = nodes.map(() => []);
  world.roadGraph.edges.forEach((e, i) => {
    if (e.a < 0 || e.b < 0 || e.a >= nodes.length || e.b >= nodes.length) return;
    const road = world.roads[e.roadId];
    const cost = e.length * LEG_COST[road ? road.kind : 'road'];
    adj[e.a].push({ to: e.b, edge: i, cost });
    adj[e.b].push({ to: e.a, edge: i, cost });
  });
  g = { n: nodes.length, adj };
  cache.set(world, g);
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

/**
 * Plans a route over the road network from `from` to a settlement. Returns null when the destination is
 * unknown or the party is already there (within 25 m of its centre).
 */
export function planRoute(world: WorldModel, from: P2, settlementId: number): RoutePlan | null {
  const dest = world.settlements.find((s) => s.id === settlementId);
  if (!dest) return null;
  const to: P2 = { x: dest.x, z: dest.z };
  if (dist(from.x, from.z, to.x, to.z) < 25) return null;
  const nodes = world.roadGraph.nodes;
  if (nodes.length === 0) return straight(from, to);

  const g = indexOf(world);
  const S = g.n, G = g.n + 1;
  const startLinks = nearestNodes(world, from, 6);
  // the destination's own node first, then the nearest few
  const endLinks = nearestNodes(world, to, 6);
  const own = nodes.find((n) => n.settlement === settlementId);
  if (own && !endLinks.some((l) => l.id === own.id)) endLinks.push({ id: own.id, d: dist(to.x, to.z, own.x, own.z) });
  const endCost = new Map<number, number>();
  for (const l of endLinks) endCost.set(l.id, l.d * LEG_COST.offroad);

  const best = new Float64Array(g.n + 2).fill(Infinity);
  const prev = new Int32Array(g.n + 2).fill(-1);
  const prevEdge = new Int32Array(g.n + 2).fill(-1);
  const heap = new MinHeap(256);
  const h = (x: number, z: number): number => dist(x, z, to.x, to.z) * LEG_COST.highway;
  best[S] = 0;
  heap.push(h(from.x, from.z), S);
  const done = new Uint8Array(g.n + 2);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === G) break;
    if (u === S) {
      for (const l of startLinks) {
        const c = l.d * LEG_COST.offroad;
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

  // walk back: G ← … ← S
  const seq: number[] = [];
  for (let v = G; v !== -1; v = prev[v]) seq.push(v);
  seq.reverse(); // S, n1, n2, …, nk, G

  const points: P2[] = [{ x: from.x, z: from.z }];
  const kinds: LegKind[] = [];
  const push = (p: P2, kind: LegKind): void => {
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
    const u = seq[i - 1];
    const nu = nodes[u];
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

/** Walks a plan by distance; positions and headings are written into `out`. */
export class RouteCursor {
  /** Distance travelled along the route (m). */
  s = 0;
  /** Index of the segment containing `s`. */
  seg = 0;
  readonly pos: P2 = { x: 0, z: 0 };
  yaw = 0;

  constructor(readonly plan: RoutePlan) { this.advance(0); }

  get done(): boolean { return this.s >= this.plan.total - 1e-6; }
  get progress(): number { return this.plan.total > 0 ? Math.min(1, this.s / this.plan.total) : 1; }
  get kind(): LegKind { return this.plan.kinds[Math.min(this.seg, this.plan.kinds.length - 1)]; }

  advance(ds: number): void {
    const { points, cum, total } = this.plan;
    this.s = Math.max(0, Math.min(total, this.s + ds));
    while (this.seg < points.length - 2 && this.s >= cum[this.seg + 1]) this.seg++;
    while (this.seg > 0 && this.s < cum[this.seg]) this.seg--;
    const a = points[this.seg], b = points[this.seg + 1];
    const len = cum[this.seg + 1] - cum[this.seg];
    const t = len > 1e-9 ? Math.min(1, Math.max(0, (this.s - cum[this.seg]) / len)) : 1;
    this.pos.x = a.x + (b.x - a.x) * t;
    this.pos.z = a.z + (b.z - a.z) * t;
    if (len > 1e-9) this.yaw = Math.atan2(b.x - a.x, b.z - a.z);
  }

  /** Jumps to the point of the route closest to the end that is still `metres` before it. */
  seek(s: number): void { this.s = 0; this.seg = 0; this.advance(s); }
}

/** At most `max` points of the route, evenly thinned, for the map (the first and last are kept). */
export function thin(points: readonly P2[], max: number): P2[] {
  if (points.length <= max) return points.map((p) => ({ x: p.x, z: p.z }));
  const out: P2[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const p = points[Math.round(i * step)];
    out.push({ x: p.x, z: p.z });
  }
  return out;
}
