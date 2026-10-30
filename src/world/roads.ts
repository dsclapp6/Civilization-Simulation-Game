// Stage 5: inter-settlement road network (A* on the macro grid, merged into a hierarchical graph),
// smoothing, bridges and fords, and the travel road graph.
import { MinHeap } from '../core/heap';
import { Simplex2 } from '../core/noise';
import type { P2 } from '../core/math';
import { yawTo } from '../core/math';
import { Biome as _Biome, type Bridge, type Ford, type Road, type RoadGraph, type RoadKind } from './types';
import * as G from './grid';
import { HashGrid } from './grid';
import { chaikin, resample, segSegIntersect } from './geom';
import { lap, lapReset, type GenState } from './state';

const { CELL, N, NN, D8L, D8X, D8Z } = G;
const Biome = _Biome;

/** Diagnostics: total A* node expansions (for tuning). */
export const roadStats = { expanded: 0 };

export const ROAD_WIDTH: Record<RoadKind, number> = { path: 2.4, track: 3.6, road: 5.2, highway: 7 };
const RANK_KIND: RoadKind[] = ['path', 'track', 'road', 'highway'];

interface RNode { cell: number; settlement: number; edges: number[]; }
interface REdge { a: number; b: number; cells: number[]; rank: number; dead?: boolean; }

class RoadNet {
  nodes: RNode[] = [];
  edges: REdge[] = [];
  edgeAt = new Int32Array(NN).fill(-1);
  nodeAt = new Int32Array(NN).fill(-1);
  nearNet = new Uint8Array(NN);

  onNet(k: number): boolean { return this.edgeAt[k] >= 0 || this.nodeAt[k] >= 0; }

  private markNear(k: number): void {
    const i = k % N, j = (k - i) / N;
    for (let d = 0; d < 8; d++) {
      const ii = i + D8X[d], jj = j + D8Z[d];
      if (ii >= 0 && jj >= 0 && ii < N && jj < N) this.nearNet[jj * N + ii] = 1;
    }
  }

  ensureNode(cell: number, settlement = -1): number {
    let id = this.nodeAt[cell];
    if (id >= 0) {
      if (settlement >= 0 && this.nodes[id].settlement < 0) this.nodes[id].settlement = settlement;
      return id;
    }
    const e = this.edgeAt[cell];
    id = this.nodes.length;
    this.nodes.push({ cell, settlement, edges: [] });
    this.nodeAt[cell] = id;
    if (e >= 0) {
      // split edge e at this cell
      const edge = this.edges[e];
      const idx = edge.cells.indexOf(cell);
      const second: REdge = { a: id, b: edge.b, cells: edge.cells.slice(idx), rank: edge.rank };
      edge.cells = edge.cells.slice(0, idx + 1);
      const oldB = edge.b;
      edge.b = id;
      const ne = this.edges.length;
      this.edges.push(second);
      const bn = this.nodes[oldB];
      bn.edges[bn.edges.indexOf(e)] = ne;
      this.nodes[id].edges.push(e, ne);
      for (let q = 1; q < second.cells.length - 1; q++) this.edgeAt[second.cells[q]] = ne;
      this.edgeAt[cell] = -1;
    }
    this.markNear(cell);
    return id;
  }

  private addEdge(a: number, b: number, cells: number[], rank: number): void {
    if (a === b && cells.length < 6) return;
    const id = this.edges.length;
    this.edges.push({ a, b, cells, rank });
    this.nodes[a].edges.push(id);
    this.nodes[b].edges.push(id);
    for (let q = 1; q < cells.length - 1; q++) { this.edgeAt[cells[q]] = id; this.markNear(cells[q]); }
  }

  /** Are two adjacent on-network cells already connected along the existing network? */
  private linked(p: number, c: number): boolean {
    const ep = this.edgeAt[p], ec = this.edgeAt[c];
    if (ep >= 0 && ep === ec) {
      const cells = this.edges[ep].cells;
      const i = cells.indexOf(p);
      return cells[i - 1] === c || cells[i + 1] === c;
    }
    const np = this.nodeAt[p], nc = this.nodeAt[c];
    if (np >= 0 && ec >= 0) {
      const e = this.edges[ec];
      return (e.a === np && e.cells[1] === c) || (e.b === np && e.cells[e.cells.length - 2] === c);
    }
    if (nc >= 0 && ep >= 0) {
      const e = this.edges[ep];
      return (e.a === nc && e.cells[1] === p) || (e.b === nc && e.cells[e.cells.length - 2] === p);
    }
    if (np >= 0 && nc >= 0) {
      for (const ei of this.nodes[np].edges) {
        const e = this.edges[ei];
        if (e.cells.length === 2 && ((e.a === np && e.b === nc) || (e.a === nc && e.b === np))) return true;
      }
    }
    return false;
  }

  /** Add a routed path (cell sequence from node cell to node cell). */
  addPath(cells: number[], rank: number, fromSettlement: number, toSettlement: number): void {
    if (cells.length < 2) return;
    this.ensureNode(cells[0], fromSettlement);
    this.ensureNode(cells[cells.length - 1], toSettlement);
    let prevOn = true;
    let seg: number[] = [cells[0]];
    for (let k = 1; k < cells.length; k++) {
      const c = cells[k];
      const on = this.onNet(c);
      if (on) {
        if (!prevOn) {
          seg.push(c);
          const nb = this.ensureNode(c);
          const na = this.nodeAt[seg[0]];
          this.addEdge(na, nb, seg, rank);
          seg = [];
        } else {
          const p = cells[k - 1];
          if (this.linked(p, c)) {
            const e = this.edgeAt[c];
            if (e >= 0 && this.edges[e].rank < rank) this.edges[e].rank = rank;
          } else {
            const na = this.ensureNode(p), nb = this.ensureNode(c);
            this.addEdge(na, nb, [p, c], rank);
          }
        }
      } else {
        if (prevOn) {
          const p = cells[k - 1];
          this.ensureNode(p);
          seg = [p];
        }
        seg.push(c);
      }
      prevOn = on;
    }
  }
}

class Router {
  private g = new Float32Array(NN);
  private prev = new Int32Array(NN);
  private visit = new Int32Array(NN);
  private closed = new Int32Array(NN);
  private stamp = 0;
  private heap = new MinHeap(1 << 14);
  base = new Float32Array(NN);
  riv = new Float32Array(NN);

  constructor(private s: GenState, private net: RoadNet) {
    const { land, water, biome, forest, riverWidth, slope } = s;
    for (let k = 0; k < NN; k++) {
      if (!land[k] || water[k] === 2) { this.base[k] = 0; continue; }
      const b = biome[k];
      let c = 1;
      if (b === Biome.Marsh) c = 2.8;
      else if (b === Biome.Moor) c = 1.5;
      else if (b === Biome.Heath) c = 1.1;
      else if (b === Biome.Beach) c = 1.4;
      else if (b === Biome.Snow) c = 4;
      else if (b === Biome.Mountain) c = 1.6;
      c += 0.55 * (forest[k] / 255);
      if (slope[k] > 0.75) c = 0;
      this.base[k] = c;
      const w = riverWidth[k];
      this.riv[k] = w <= 0 ? 0 : w < 4 ? 2.5 : w < 10 ? 7 : w < 22 ? 22 : 70;
    }
  }

  route(a: number, b: number): number[] | null {
    const { g, prev, visit, closed, heap, base, riv } = this;
    const h = this.s.height;
    const net = this.net;
    const onNet = (k: number): boolean => net.edgeAt[k] >= 0 || net.nodeAt[k] >= 0;
    const stamp = ++this.stamp;
    const bi = b % N, bj = (b - bi) / N;
    const hEst = (k: number): number => {
      const i = k % N, j = (k - i) / N;
      return 0.8 * Math.hypot(i - bi, j - bj);
    };
    heap.clear();
    g[a] = 0; visit[a] = stamp; prev[a] = -1;
    heap.push(hEst(a), a);
    let expanded = 0;
    let found = false;
    while (heap.size > 0) {
      const c = heap.pop();
      if (closed[c] === stamp) continue;
      closed[c] = stamp;
      if (c === b) { found = true; break; }
      if (++expanded > 700000) break;
      roadStats.expanded++;
      const ci = c % N, cj = (c - ci) / N;
      const gc = g[c];
      const cOn = onNet(c);
      for (let d = 0; d < 8; d++) {
        const ii = ci + D8X[d], jj = cj + D8Z[d];
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const n = jj * N + ii;
        if (closed[n] === stamp) continue;
        const bn = base[n];
        if (bn === 0) continue;
        const step = D8L[d];
        const sl = Math.abs(h[n] - h[c]) / (step * CELL);
        let mult = 1 + 22 * sl * sl;
        if (sl > 0.12) mult += 120 * (sl - 0.12) * (sl - 0.12);
        const nOn = onNet(n);
        const f = nOn ? 0.35 : net.nearNet[n] ? 1.25 : 1;
        let nd = gc + step * bn * mult * f;
        if (!nOn || !cOn) nd += riv[n];
        if (visit[n] !== stamp || nd < g[n]) {
          visit[n] = stamp; g[n] = nd; prev[n] = c;
          heap.push(nd + hEst(n), n);
        }
      }
    }
    if (!found) return null;
    const path: number[] = [];
    for (let c = b; c >= 0; c = prev[c]) path.push(c);
    path.reverse();
    return path;
  }
}

const IMPORTANCE: Record<string, number> = { city: 5, town: 4, castle: 3, abbey: 3, priory: 3, nunnery: 3, village: 2, hamlet: 1 };
function rankFor(ka: string, kb: string): number {
  const a = IMPORTANCE[ka], b = IMPORTANCE[kb];
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (lo <= 1) return 0;
  if (lo >= 4) return 3;
  if (hi >= 4 && lo >= 2) return 2;
  if (lo >= 3) return 2;
  return 1;
}

export function generateRoads(s: GenState): void {
  lapReset();
  const net = new RoadNet();
  const router = new Router(s, net);
  const sites = s.sites;
  const cellOfSite = (id: number): number => Math.min(NN - 1, Math.floor(sites[id].z / CELL) * N + Math.floor(sites[id].x / CELL));
  const connected = new Set<number>();
  const links = new Set<string>();
  const key = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const dist = (a: number, b: number): number => Math.hypot(sites[a].x - sites[b].x, sites[a].z - sites[b].z);
  const link = (a: number, b: number, rank?: number): boolean => {
    if (a === b || links.has(key(a, b))) return false;
    const ka = cellOfSite(a), kb = cellOfSite(b);
    const path = router.route(ka, kb);
    if (!path) return false;
    net.addPath(path, rank ?? rankFor(sites[a].kind, sites[b].kind), a, b);
    links.add(key(a, b));
    connected.add(a); connected.add(b);
    return true;
  };

  // main landmass components: settlements not flagged as island
  const mainIds = sites.filter((st) => !st.island).map((st) => st.id);
  // 1. capitals MST
  const cities = mainIds.filter((id) => sites[id].kind === 'city');
  {
    const inTree = new Set<number>([cities[0]]);
    while (inTree.size < cities.length) {
      let best: [number, number] | null = null, bd = Infinity;
      for (const a of inTree) for (const b of cities) {
        if (inTree.has(b)) continue;
        const d = dist(a, b);
        if (d < bd) { bd = d; best = [a, b]; }
      }
      if (!best) break;
      link(best[0], best[1], 3);
      inTree.add(best[1]);
    }
  }
  if (cities.length) connected.add(cities[0]);
  const nearestConnected = (id: number, filter?: (o: number) => boolean, skip?: Set<number>): number => {
    let best = -1, bd = Infinity;
    for (const o of connected) {
      if (o === id || (filter && !filter(o)) || (skip && skip.has(o))) continue;
      const d = dist(id, o);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  };
  const connectOrdered = (ids: number[], extra: (id: number, first: number) => void): void => {
    // closest-to-network first so that the network grows outward
    const todo = ids.filter((id) => !connected.has(id));
    while (todo.length) {
      let bi = -1, bd = Infinity, bn = -1;
      for (let q = 0; q < todo.length; q++) {
        const n = nearestConnected(todo[q]);
        if (n < 0) continue;
        const d = dist(todo[q], n);
        if (d < bd) { bd = d; bi = q; bn = n; }
      }
      if (bi < 0) break;
      const id = todo.splice(bi, 1)[0];
      link(id, bn);
      extra(id, bn);
    }
  };
  // 2. towns -> highway links, second link for redundancy
  const towns = mainIds.filter((id) => sites[id].kind === 'town');
  connectOrdered(towns, (id, first) => {
    const second = nearestConnected(id, (o) => sites[o].kind === 'town' || sites[o].kind === 'city', new Set([first]));
    if (second >= 0 && dist(id, second) < 5200) link(id, second);
  });
  // 3. castles and abbeys
  connectOrdered(mainIds.filter((id) => sites[id].kind === 'castle'), (id) => {
    const p = sites[id].parent;
    if (p >= 0 && !sites[p].island) link(id, p, 1);
  });
  connectOrdered(mainIds.filter((id) => ['abbey', 'priory', 'nunnery'].includes(sites[id].kind)), () => undefined);
  // 4. villages
  connectOrdered(mainIds.filter((id) => sites[id].kind === 'village'), (id, first) => {
    const second = nearestConnected(id, (o) => sites[o].kind !== 'hamlet', new Set([first]));
    if (second >= 0 && dist(id, second) < 1.6 * dist(id, first) && dist(id, second) < 2600) {
      const a1 = Math.atan2(sites[first].z - sites[id].z, sites[first].x - sites[id].x);
      const a2 = Math.atan2(sites[second].z - sites[id].z, sites[second].x - sites[id].x);
      let da = Math.abs(a1 - a2);
      if (da > Math.PI) da = Math.PI * 2 - da;
      if (da > 0.9 && hashPick(id) < 0.55) link(id, second);
    }
  });
  // castles whose village parents exist: make sure pairs are linked
  for (const id of mainIds) {
    const st = sites[id];
    if (st.kind === 'castle' && st.parent >= 0 && !sites[st.parent].island) link(id, st.parent, 1);
  }
  // 5. hamlets
  connectOrdered(mainIds.filter((id) => sites[id].kind === 'hamlet'), () => undefined);

  // 6. redundancy: close pairs whose network detour is long
  {
    let adj = buildSettlementGraph(net, sites.length);
    const cand: [number, number][] = [];
    for (const a of mainIds) {
      const near = mainIds.filter((b) => b !== a).sort((p, q) => dist(a, p) - dist(a, q)).slice(0, 3);
      for (const b of near) if (a < b && dist(a, b) < 3200 && !links.has(key(a, b))) cand.push([a, b]);
    }
    for (const [a, b] of cand) {
      const nd = graphDistance(adj, a, b);
      const eu = dist(a, b);
      if (nd > 2.3 * eu && hashPick(a * 977 + b) < 0.8) {
        if (link(a, b)) adj = buildSettlementGraph(net, sites.length);
      }
    }
  }
  // islands: tiny local networks between island settlements of the same landmass (usually none)
  lap(s, 'r.route');

  // ---------- extract polylines ----------
  const meanderNoise = new Simplex2(s.rng.fork('road-meander'));
  const roads: Road[] = [];
  const edgeRoad = new Int32Array(net.edges.length).fill(-1);
  const nodePos = (n: RNode): P2 => {
    if (n.settlement >= 0) return { x: sites[n.settlement].x, z: sites[n.settlement].z };
    return { x: ((n.cell % N) + 0.5) * CELL, z: (Math.floor(n.cell / N) + 0.5) * CELL };
  };
  net.edges.forEach((e, ei) => {
    if (e.cells.length < 2) return;
    const na = net.nodes[e.a], nb = net.nodes[e.b];
    const pts: P2[] = e.cells.map((c) => ({ x: ((c % N) + 0.5) * CELL, z: (Math.floor(c / N) + 0.5) * CELL }));
    pts[0] = nodePos(na);
    pts[pts.length - 1] = nodePos(nb);
    let sm = pts;
    if (pts.length >= 3) sm = chaikin(pts, 2).pts;
    sm = resample(sm, 15);
    sm = relax(sm, 10);
    sm = meander(s, sm, meanderNoise, e.rank, ei);
    const rank = Math.min(3, Math.max(0, e.rank));
    const kind = RANK_KIND[rank];
    const id = roads.length;
    edgeRoad[ei] = id;
    roads.push({ id, kind, points: sm, width: ROAD_WIDTH[kind], from: na.settlement, to: nb.settlement });
  });
  s.roads = roads;
  // graph
  const graph: RoadGraph = { nodes: [], edges: [] };
  const nodeId = new Int32Array(net.nodes.length).fill(-1);
  net.nodes.forEach((n, i) => {
    if (n.edges.filter((e) => edgeRoad[e] >= 0).length === 0) return;
    const p = nodePos(n);
    nodeId[i] = graph.nodes.length;
    graph.nodes.push({ id: graph.nodes.length, x: p.x, z: p.z, settlement: n.settlement });
  });
  net.edges.forEach((e, ei) => {
    if (edgeRoad[ei] < 0) return;
    const r = roads[edgeRoad[ei]];
    let length = 0;
    for (let i = 1; i < r.points.length; i++) length += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].z - r.points[i - 1].z);
    graph.edges.push({ a: nodeId[e.a], b: nodeId[e.b], roadId: r.id, length });
  });
  s.roadGraph = graph;
  lap(s, 'r.polylines');

  findCrossings(s);
  lap(s, 'r.crossings');
}

/**
 * Find where roads cross rivers and decide bridge or ford. Rerunnable: it replaces `s.bridges` / `s.fords`
 * and recomputes the ford depth multipliers of the rivers (used again after layouts reshape some roads).
 */
export function findCrossings(s: GenState): void {
  const sites = s.sites;
  const roads = s.roads;
  for (const r of s.rivers) r.depthMul.fill(1);
  const bridges: Bridge[] = [];
  let fords: Ford[] = [];
  const fordSeg: number[] = [];
  const segGrid = new HashGrid(96);
  const segs: { ri: number; i: number }[] = [];
  s.rivers.forEach((r, ri) => {
    for (let i = 0; i + 1 < r.points.length; i++) {
      const a = r.points[i], b = r.points[i + 1];
      segGrid.add(segs.length, Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z));
      segs.push({ ri, i });
    }
  });
  const townNear = (x: number, z: number, r: number): boolean => sites.some((st) => (st.kind === 'town' || st.kind === 'city') && Math.hypot(st.x - x, st.z - z) < r);
  const out: number[] = [];
  for (const road of roads) {
    const lastCross = new Map<number, number>();
    let arc = 0;
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i], b = road.points[i + 1];
      const slen = Math.hypot(b.x - a.x, b.z - a.z);
      segGrid.query(Math.min(a.x, b.x) - 2, Math.min(a.z, b.z) - 2, Math.max(a.x, b.x) + 2, Math.max(a.z, b.z) + 2, out);
      const seen = new Set<number>();
      for (const q of out) {
        if (seen.has(q)) continue;
        seen.add(q);
        const { ri, i: ei } = segs[q];
        const rv = s.rivers[ri];
        const c = rv.points[ei], d = rv.points[ei + 1];
        const hit = segSegIntersect(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z);
        if (!hit) continue;
        const along = arc + hit.t * slen;
        const prevAt = lastCross.get(ri);
        if (prevAt !== undefined && Math.abs(along - prevAt) < 45) continue;
        lastCross.set(ri, along);
        const w = rv.widths[ei] + (rv.widths[ei + 1] - rv.widths[ei]) * hit.u;
        const x = a.x + (b.x - a.x) * hit.t, z = a.z + (b.z - a.z) * hit.t;
        const near = townNear(x, z, 1100);
        const bridge = (w > 8 && near) || (road.kind === 'highway' && w > 5) || w > 18 || (road.kind === 'road' && w > 11);
        if (bridge) {
          const stone = road.kind === 'highway' || w > 14 || (near && road.kind === 'road');
          bridges.push({
            id: bridges.length, roadId: road.id, riverId: ri, x, z, rot: yawTo(a.x, a.z, b.x, b.z),
            length: w + 7, width: road.width + 1.4, stone,
          });
        } else {
          fords.push({ id: fords.length, roadId: road.id, riverId: ri, x, z });
          fordSeg.push(ei);
        }
      }
      arc += slen;
    }
  }
  // a ford beside a bridge on the same road is redundant: the bridge deck spans it
  const keepFord = fords.map((f) => !bridges.some((b) => b.roadId === f.roadId && Math.hypot(b.x - f.x, b.z - f.z) < b.length / 2 + 22));
  const kept: Ford[] = [];
  fords.forEach((f, q) => {
    if (!keepFord[q]) return;
    const rv = s.rivers[f.riverId];
    const dm = rv.depthMul, ei = fordSeg[q];
    dm[ei] = Math.min(dm[ei], 0.22);
    if (ei + 1 < dm.length) dm[ei + 1] = Math.min(dm[ei + 1], 0.45);
    if (ei > 0) dm[ei - 1] = Math.min(dm[ei - 1], 0.45);
    kept.push({ ...f, id: kept.length });
  });
  fords = kept;
  s.bridges = bridges;
  s.fords = fords;
}

function hashPick(n: number): number {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return ((h >>> 0) % 10000) / 10000;
}

/** Gentle lateral wander so long roads do not run in dead-straight octilinear lines. Never pushes a road into water. */
function meander(s: GenState, pts: P2[], noise: Simplex2, rank: number, salt: number): P2[] {
  if (pts.length < 8) return pts;
  const amp = [14, 22, 30, 36][Math.min(3, Math.max(0, rank))];
  const out = pts.map((p) => ({ x: p.x, z: p.z }));
  let arc = 0;
  const total = pts.reduce((a, p, i) => (i ? a + Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) : 0), 0);
  for (let i = 1; i < pts.length - 1; i++) {
    arc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    const env = Math.min(1, arc / 140, (total - arc) / 140);
    if (env <= 0) continue;
    const a = pts[i - 1], b = pts[i + 1];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const off = amp * env * (noise.noise(arc / 420, salt * 3.17) + 0.4 * noise.noise(arc / 130, salt * 1.7 + 9));
    const x = pts[i].x - tz * off, z = pts[i].z + tx * off;
    const k = Math.min(NN - 1, Math.max(0, Math.floor(z / CELL) * N + Math.floor(x / CELL)));
    if (!s.land[k] || s.water[k] === 2 || s.waterDist[k] < 70 || s.slope[k] > 0.4) continue;
    out[i].x = x; out[i].z = z;
  }
  return relax(out, 2);
}

/** Laplacian relaxation keeping end points; removes octilinear artefacts of grid paths. */
function relax(pts: P2[], iterations: number): P2[] {
  if (pts.length < 4) return pts;
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const next = cur.map((p) => ({ x: p.x, z: p.z }));
    for (let i = 1; i < cur.length - 1; i++) {
      next[i].x = cur[i].x * 0.5 + (cur[i - 1].x + cur[i + 1].x) * 0.25;
      next[i].z = cur[i].z * 0.5 + (cur[i - 1].z + cur[i + 1].z) * 0.25;
    }
    cur = next;
  }
  return cur;
}

interface GEdge { to: number; len: number; }
function buildSettlementGraph(net: RoadNet, nSettlements: number): GEdge[][] {
  // collapse junction nodes: use net nodes directly, but key settlement nodes by settlement id
  const adj: GEdge[][] = Array.from({ length: nSettlements + net.nodes.length }, () => []);
  const idOf = (ni: number): number => (net.nodes[ni].settlement >= 0 ? net.nodes[ni].settlement : nSettlements + ni);
  for (const e of net.edges) {
    if (e.cells.length < 2) continue;
    const a = idOf(e.a), b = idOf(e.b);
    const len = e.cells.length * CELL;
    adj[a].push({ to: b, len }); adj[b].push({ to: a, len });
  }
  return adj;
}
function graphDistance(adj: GEdge[][], a: number, b: number): number {
  const dist = new Map<number, number>();
  const heap = new MinHeap(256);
  // ids may be large (junction nodes); map to compact indices
  const ids = new Map<number, number>();
  const rev: number[] = [];
  const idx = (n: number): number => { let v = ids.get(n); if (v === undefined) { v = rev.length; ids.set(n, v); rev.push(n); } return v; };
  dist.set(a, 0); heap.push(0, idx(a));
  while (heap.size > 0) {
    const ci = heap.pop(); const d = heap.lastKey; const c = rev[ci];
    if (c === b) return d;
    if (d > (dist.get(c) ?? Infinity)) continue;
    for (const e of adj[c] ?? []) {
      const nd = d + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); heap.push(nd, idx(e.to)); }
    }
  }
  return Infinity;
}
