// Stage 4: kingdoms (grown from capital cities), counties and settlement siting with names.
import { MinHeap } from '../core/heap';
import type { CultureId, SettlementKind } from '../core/domain';
import { hash01 as _hash01 } from '../core/math';
import { smoothstep as _smoothstep } from '../core/noise';
import { Biome as _Biome, type County, type Kingdom, type Settlement } from './types';
import * as G from './grid';
import { boxBlur, distanceTransform, labelComponents, shareThreshold } from './grid';
import { KINGDOM_COLORS, assignCultures, fillLabels, growRegions } from './politics';
import { kingdomName, countyName, settlementName } from './names';
import { lap, lapReset, type GenState, type SettlementSite } from './state';

// Local copies of imported bindings (cheap in hot loops under any module loader).
const { CELL, N, NN, D8L, D8X, D8Z } = G;
const hash01 = _hash01, smoothstep = _smoothstep, Biome = _Biome;

function cxOf(k: number): number { return ((k % N) + 0.5) * CELL; }
function czOf(k: number): number { return (Math.floor(k / N) + 0.5) * CELL; }

const POP: Record<SettlementKind, [number, number]> = {
  hamlet: [14, 34], village: [66, 152], town: [135, 235], city: [245, 440], castle: [28, 70], abbey: [30, 60], priory: [14, 30], nunnery: [16, 36],
};

export function generateSites(s: GenState): void {
  lapReset();
  const rng = s.rng.fork('sites');
  const K = Math.max(2, Math.min(8, Math.round(s.opts.kingdoms)));
  const sparse = s.opts.sparse;
  const { land, mainland, height, slope, water, biome } = s;

  // ---------- helper fields ----------
  const hBlur = boxBlur(height, 8);
  const prom = new Float32Array(NN);
  for (let k = 0; k < NN; k++) prom[k] = height[k] - hBlur[k];
  const riverNear = new Float32Array(NN); // widest river within ~4 cells
  {
    const R = 4;
    const rw = s.riverWidth;
    for (let k = 0; k < NN; k++) {
      const w = rw[k];
      if (w <= 0) continue;
      const i = k % N, j = (k - i) / N;
      for (let dj = -R; dj <= R; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= N) continue;
        for (let di = -R; di <= R; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= N) continue;
          if (riverNear[jj * N + ii] < w) riverNear[jj * N + ii] = w;
        }
      }
    }
  }
  const fert = (k: number): number => s.fertility[k] / 255;
  const forestOf = (k: number): number => s.forest[k] / 255;
  const wNear = (k: number): number => smoothstep(30, 90, s.waterDist[k]) * (1 - smoothstep(380, 800, s.waterDist[k]));
  const buildable = new Uint8Array(NN);
  for (let k = 0; k < NN; k++) {
    const b = biome[k];
    buildable[k] = land[k] && water[k] === 0 && slope[k] < 0.12 && b !== Biome.Marsh && b !== Biome.Beach && b !== Biome.Mountain && b !== Biome.Snow && b !== Biome.Lake && b !== Biome.Moor && s.waterDist[k] > 55 ? 1 : 0;
  }
  const coast = s.coastDist;
  lap(s, 's.helpers');

  // ---------- capitals ----------
  const cityScore = (k: number): number => {
    let sc = fert(k) * 1.0 + 0.5 * wNear(k) + 0.3 * smoothstep(120, 500, coast[k]) * (1 - smoothstep(900, 2200, coast[k]))
      - 4 * smoothstep(0.02, 0.09, slope[k]) - 0.9 * forestOf(k) - 0.7 * smoothstep(120, 260, height[k]) + 0.12 * hash01(k, 7, 3);
    if (riverNear[k] > 8) sc += 0.25;
    return sc;
  };
  let sx = 0, sz = 0, sn = 0;
  for (let k = 0; k < NN; k++) if (mainland[k]) { sx += cxOf(k); sz += czOf(k); sn++; }
  const centre = { x: sx / sn, z: sz / sn };
  const cityCand: number[] = [];
  for (let k = 0; k < NN; k += 1) if ((k & 1) === 0 && ((k / N) & 1) === 0 && mainland[k] && buildable[k] && coast[k] > 350 && forestOf(k) < 0.5 && height[k] < 260) cityCand.push(k);
  const candArr = new Float32Array(NN);
  const candMask = new Uint8Array(NN);
  for (const k of cityCand) { candArr[k] = cityScore(k); candMask[k] = 1; }
  const scoreCut = shareThreshold(candArr, candMask, 0.75);
  const strong = cityCand.filter((k) => candArr[k] >= scoreCut);
  const candScore = { get: (k: number): number => candArr[k] };
  const capCells: number[] = [];
  {
    // Balanced seeds: k-means over the mainland (so regions start comparable in size), then each centre
    // snaps to the best city site nearby. The seed nearest the middle of the land is placed first.
    const pts: number[] = [];
    for (let k = 0; k < NN; k += 1) if ((k & 7) === 0 && ((k / N) & 7) === 0 && mainland[k] && height[k] < 900) pts.push(k);
    const centres: { x: number; z: number }[] = [];
    let first = pts[0], bd0 = Infinity;
    for (const k of pts) { const d = Math.hypot(cxOf(k) - centre.x, czOf(k) - centre.z); if (d < bd0) { bd0 = d; first = k; } }
    centres.push({ x: cxOf(first), z: czOf(first) });
    while (centres.length < K) {
      let bk = pts[0], bmd = -1;
      for (const k of pts) {
        let md = Infinity;
        for (const c of centres) { const d = Math.hypot(cxOf(k) - c.x, czOf(k) - c.z); if (d < md) md = d; }
        if (md > bmd) { bmd = md; bk = k; }
      }
      centres.push({ x: cxOf(bk), z: czOf(bk) });
    }
    for (let it = 0; it < 8; it++) {
      const sx = new Float64Array(K), sz = new Float64Array(K), cnt = new Float64Array(K);
      for (const k of pts) {
        const x = cxOf(k), z = czOf(k);
        let bi = 0, bd = Infinity;
        for (let q = 0; q < K; q++) { const d = (x - centres[q].x) ** 2 + (z - centres[q].z) ** 2; if (d < bd) { bd = d; bi = q; } }
        sx[bi] += x; sz[bi] += z; cnt[bi]++;
      }
      for (let q = 1; q < K; q++) if (cnt[q] > 0) centres[q] = { x: sx[q] / cnt[q], z: sz[q] / cnt[q] };
    }
    // first seed stays the central one; snap every centre to a good nearby city site
    const used: number[] = [];
    centres.forEach((c, qi) => {
      let best = -1, bs = -Infinity;
      for (const k of strong) {
        const d = Math.hypot(cxOf(k) - c.x, czOf(k) - c.z);
        if (d > 3200) continue;
        let tooClose = false;
        for (const u of used) if (Math.hypot(cxOf(k) - cxOf(u), czOf(k) - czOf(u)) < 3000) { tooClose = true; break; }
        if (tooClose) continue;
        const sc = candScore.get(k) - d / 3000;
        if (sc > bs) { bs = sc; best = k; }
      }
      if (best < 0) {
        // widen the search over all candidates
        for (const k of cityCand) {
          const d = Math.hypot(cxOf(k) - c.x, czOf(k) - c.z);
          let tooClose = false;
          for (const u of used) if (Math.hypot(cxOf(k) - cxOf(u), czOf(k) - czOf(u)) < 2200) { tooClose = true; break; }
          if (tooClose) continue;
          const sc = candScore.get(k) - d / 1500;
          if (sc > bs) { bs = sc; best = k; }
        }
      }
      void qi;
      capCells.push(best);
      used.push(best);
    });
  }
  const capPos = capCells.map((k) => ({ x: cxOf(k) + (hash01(k, 1, 1) - 0.5) * 30, z: czOf(k) + (hash01(k, 2, 1) - 0.5) * 30 }));

  lap(s, 's.capitals');
  // ---------- kingdoms ----------
  let labels = growRegions(s, capCells, true);
  lap(s, 's.grow');
  labels = fillLabels(s, labels);
  s.kingdomGrid = labels;
  const cultures = assignCultures(K, capPos, centre, s.mountainDir, rng.fork('cultures'));
  const usedNames = new Set<string>();
  const nameRng = rng.fork('names');
  const colorOrder = rng.fork('colors').shuffle(KINGDOM_COLORS.slice(1));
  const kingdoms: Kingdom[] = [];
  const nCounties: number[] = [];
  for (let i = 0; i < K; i++) {
    const culture = cultures[i];
    const color = culture === 'anglo' && i === cultures.indexOf('anglo') ? KINGDOM_COLORS[0] : colorOrder[i % colorOrder.length];
    kingdoms.push({ id: i, name: kingdomName(culture, nameRng, usedNames), culture, capital: i, color, counties: [] });
    nCounties.push(rng.weighted([3, 4, 5, 6], [0.42, 0.35, 0.18, 0.05]));
  }
  // each county seat but the capital is a castle: cap the total so that castles stay a modest share of ~135 settlements
  for (let guard = 0; guard < 40 && nCounties.reduce((a, b) => a + b, 0) > Math.round(K * 4.7); guard++) {
    let bi = 0;
    for (let i = 1; i < K; i++) if (nCounties[i] > nCounties[bi]) bi = i;
    if (nCounties[bi] <= 3) break;
    nCounties[bi]--;
  }
  // ensure distinct colours for kingdoms: replace duplicates
  {
    const seen = new Set<number>();
    for (const kd of kingdoms) {
      if (seen.has(kd.color)) kd.color = KINGDOM_COLORS.find((c) => !seen.has(c)) ?? kd.color;
      seen.add(kd.color);
    }
  }
  s.kingdoms = kingdoms;
  lap(s, 's.kingdoms');

  // ---------- site bookkeeping ----------
  const sites: SettlementSite[] = [];
  const addSite = (kind: SettlementKind, x: number, z: number, parent = -1, tags: string[] = []): SettlementSite => {
    const k = Math.min(NN - 1, Math.floor(z / CELL) * N + Math.floor(x / CELL));
    const kingdom = Math.max(0, (s.kingdomGrid[k] || 1) - 1);
    const [lo, hi] = POP[kind];
    const site: SettlementSite = {
      id: sites.length, kind, x, z, kingdom, culture: kingdoms[kingdom].culture,
      island: !mainland[k], parent, importance: 0, population: Math.round(lo + (hi - lo) * Math.pow(rng.next(), 1.2)), territory: 700, tags,
    };
    sites.push(site);
    return site;
  };
  for (let i = 0; i < K; i++) { const c = addSite('city', capPos[i].x, capPos[i].z); c.kingdom = i; c.culture = kingdoms[i].culture; c.tags.push('capital'); }
  const minDistTo = (x: number, z: number, pred?: (st: SettlementSite) => boolean): number => {
    let md = Infinity;
    for (const st of sites) {
      if (pred && !pred(st)) continue;
      const d = Math.hypot(st.x - x, st.z - z);
      if (d < md) md = d;
    }
    return md;
  };
  const spacingOk = (x: number, z: number, req: (o: SettlementSite) => number): boolean => {
    for (const st of sites) {
      const dx = st.x - x, dz = st.z - z;
      const r = req(st);
      if (dx * dx + dz * dz < r * r) return false;
    }
    return true;
  };

  // border distance for castle siting
  const borderMask = new Uint8Array(NN);
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    const l = s.kingdomGrid[k];
    if (!l) continue;
    for (let d = 0; d < 4; d++) {
      const l2 = s.kingdomGrid[k + D8Z[d] * N + D8X[d]];
      if (l2 && l2 !== l) { borderMask[k] = 1; break; }
    }
  }
  const borderDist = distanceTransform(borderMask);

  const pickBest = (cells: number[], score: (k: number) => number, ok: (x: number, z: number, k: number) => boolean, jitter = 0.08): number => {
    let best = -1, bs = -Infinity;
    for (const k of cells) {
      const sc = score(k) + jitter * hash01(k, 5, 9);
      if (sc <= bs) continue;
      if (!ok(cxOf(k), czOf(k), k)) continue;
      bs = sc; best = k;
    }
    return best;
  };
  const cellsByKingdom: number[][] = Array.from({ length: K }, () => []);
  const softCells: number[][] = Array.from({ length: K }, () => []);
  for (let k = 0; k < NN; k++) {
    if ((k & 1) !== 0 || ((k / N) & 1) !== 0 || !mainland[k] || !s.kingdomGrid[k]) continue; // 62 m lattice
    if (buildable[k]) cellsByKingdom[s.kingdomGrid[k] - 1].push(k);
    else if (water[k] === 0 && slope[k] < 0.2 && biome[k] !== Biome.Marsh && biome[k] !== Biome.Snow && biome[k] !== Biome.Beach && s.waterDist[k] > 40) softCells[s.kingdomGrid[k] - 1].push(k);
  }

  // ---------- towns ----------
  const townTarget = sparse ? 3 : Math.round(K * 1.3);
  const townScore = (k: number): number => {
    let sc = 0.55 * fert(k) + 0.6 * smoothstep(5, 14, riverNear[k]) * (1 - smoothstep(30, 60, riverNear[k]))
      + 0.5 * smoothstep(80, 400, coast[k]) * (1 - smoothstep(600, 1400, coast[k])) - 3.5 * smoothstep(0.02, 0.08, slope[k]) - 0.9 * forestOf(k) - 0.5 * smoothstep(100, 220, height[k]) + 0.3 * wNear(k);
    if (s.waterDist[k] < 160 && s.waterDist[k] > 70) sc += 0.2;
    return sc;
  };
  for (let round = 0; sites.filter((x) => x.kind === 'town').length < townTarget && round < townTarget * 3; round++) {
    const kingdom = round % K;
    const k = pickBest(cellsByKingdom[kingdom], townScore, (x, z) =>
      spacingOk(x, z, (o) => o.kind === 'town' ? 2700 : o.kind === 'city' ? 2300 : 1100) && s.kingdomGrid[Math.floor(z / CELL) * N + Math.floor(x / CELL)] === kingdom + 1);
    if (k < 0) continue;
    const st = addSite('town', cxOf(k), czOf(k));
    if (riverNear[k] > 8) st.tags.push('river');
    if (coast[k] < 900) st.tags.push('coast');
  }
  lap(s, 's.towns');

  // ---------- castles: county seats (n-1 per kingdom) + a few border forts ----------
  const castleScore = (k: number): number => 0.65 * smoothstep(6, 38, prom[k]) + 0.35 * smoothstep(5, 12, riverNear[k]) * (1 - smoothstep(30, 60, riverNear[k]))
    + 0.5 * (1 - smoothstep(600, 2600, borderDist[k])) + 0.35 * fert(k) - 3 * smoothstep(0.07, 0.15, slope[k]) - 0.8 * forestOf(k) - 0.4 * smoothstep(180, 320, height[k]);
  const seatCastles: number[][] = Array.from({ length: K }, () => []);
  for (let kd = 0; kd < K; kd++) {
    const need = nCounties[kd] - 1;
    const own = cellsByKingdom[kd];
    for (let q = 0; q < need; q++) {
      let k = -1;
      for (let attempt = 0; attempt < 4 && k < 0; attempt++) {
        const relax = 1 - 0.18 * attempt;
        const pool = attempt >= 2 ? own.concat(softCells[kd]) : own;
        k = pickBest(pool, (kk) => {
          const x = cxOf(kk), z = czOf(kk);
          const md = minDistTo(x, z, (o) => o.kingdom === kd && (o.kind === 'castle' || o.kind === 'city'));
          return castleScore(kk) + 0.45 * Math.min(md, 6000) / 3000;
        }, (x, z) => spacingOk(x, z, (o) => (o.kind === 'castle' ? 2400 : o.kind === 'city' ? 2600 : o.kind === 'town' ? 700 : 600) * relax), 0.1);
      }
      if (k < 0) continue;
      const st = addSite('castle', cxOf(k), czOf(k), -1, ['seat']);
      seatCastles[kd].push(st.id);
      if (prom[k] > 12) st.tags.push('hill');
    }
  }
  const extraForts = sparse ? 0 : Math.round(K * 0.3);
  for (let q = 0; q < extraForts; q++) {
    const kd = rng.int(0, K - 1);
    const k = pickBest(cellsByKingdom[kd], (kk) => castleScore(kk) + 0.6 * (1 - smoothstep(300, 1200, borderDist[kk])), (x, z) => spacingOk(x, z, (o) => o.kind === 'castle' ? 2000 : 900), 0.1);
    if (k < 0) continue;
    addSite('castle', cxOf(k), czOf(k), -1, ['fort']);
  }
  lap(s, 's.castles');

  // ---------- monasteries ----------
  const abbeyTarget = sparse ? 2 : Math.max(K, 7);
  const townMask = new Uint8Array(NN);
  for (const st of sites) if (st.kind === 'town' || st.kind === 'city') townMask[Math.floor(st.z / CELL) * N + Math.floor(st.x / CELL)] = 1;
  const townDist = distanceTransform(townMask);
  const abbeyScore = (k: number): number => 0.7 * fert(k) + 0.5 * wNear(k) + 0.3 * (prom[k] < -2 ? 1 : 0) - 4 * smoothstep(0.02, 0.08, slope[k]) - 0.5 * forestOf(k)
    + 0.4 * smoothstep(1500, 3500, townDist[k]) + 0.1 * (1 - smoothstep(60, 300, s.waterDist[k]));
  for (let q = 0; q < abbeyTarget; q++) {
    const kd = q % K;
    let k = pickBest(cellsByKingdom[kd], abbeyScore, (x, z) => spacingOk(x, z, (o) => (o.kind === 'abbey' || o.kind === 'priory' || o.kind === 'nunnery' ? 2400 : o.kind === 'castle' ? 1000 : 1500)), 0.15);
    if (k < 0) k = pickBest(cellsByKingdom[kd].concat(softCells[kd]), abbeyScore, (x, z) => spacingOk(x, z, (o) => (o.kind === 'abbey' || o.kind === 'priory' || o.kind === 'nunnery' ? 1600 : 800)), 0.15);
    if (k < 0) continue;
    const kind: SettlementKind = (['abbey', 'priory', 'abbey', 'nunnery', 'abbey', 'priory', 'nunnery', 'abbey'] as SettlementKind[])[q % 8];
    addSite(kind, cxOf(k), czOf(k));
  }
  lap(s, 's.abbeys');

  // ---------- villages ----------
  const villageScore = (k: number): number => fert(k) + 0.35 * wNear(k) + 0.25 * smoothstep(100, 400, coast[k]) * (1 - smoothstep(500, 900, coast[k]))
    - 3.2 * smoothstep(0.03, 0.11, slope[k]) - 0.55 * forestOf(k) - 0.55 * smoothstep(140, 320, height[k]) - 0.9 * s.floodplain[k] * (1 - smoothstep(60, 120, s.waterDist[k])) + 0.1 * hash01(k, 3, 3);
  // fewer hamlets when many castles already fill the non-village share
  const hamletTarget = sparse ? 3 : Math.max(4, Math.min(8, 54 - (sites.length + 1)));
  // villages are 60-65 % of all settlements (the total stays near 135 unless many castles push the minimum share up)
  const nonVillageExpected = sites.length + hamletTarget + 1;
  const villageTarget = sparse ? 16 : Math.max(Math.round(1.5 * nonVillageExpected), Math.min(Math.round(1.8 * nonVillageExpected), 138 - nonVillageExpected));
  const nonVillageCount = (): number => sites.length;
  void nonVillageCount;
  // castle villages first
  for (const castle of sites.slice()) {
    if (castle.kind !== 'castle' || castle.tags.includes('fort') && rng.chance(0.5)) continue;
    // an existing town close by?
    const near = sites.find((o) => (o.kind === 'town' || o.kind === 'village') && Math.hypot(o.x - castle.x, o.z - castle.z) < 700);
    if (near) { castle.parent = near.id; continue; }
    // otherwise found a village beside the castle, 260-560 m away, preferring low ground near water
    const cells: number[] = [];
    const ci = Math.floor(castle.x / CELL), cj = Math.floor(castle.z / CELL);
    for (let dj = -20; dj <= 20; dj++) for (let di = -20; di <= 20; di++) {
      const k = (cj + dj) * N + ci + di;
      if (k < 0 || k >= NN || !buildable[k]) continue;
      const d = Math.hypot(cxOf(k) - castle.x, czOf(k) - castle.z);
      if (d >= 240 && d <= 620) cells.push(k);
    }
    const k = pickBest(cells, (kk) => villageScore(kk) - Math.max(0, prom[kk] - 4) * 0.05, (x, z) => spacingOk(x, z, (o) => o === castle ? 0 : o.kind === 'village' ? 650 : 400), 0.05);
    if (k < 0) continue;
    const v = addSite('village', cxOf(k), czOf(k), -1, ['castle_village']);
    castle.parent = v.id;
  }
  const villageCells: number[] = [];
  for (let k = 0; k < NN; k += 1) if ((k & 1) === 0 && ((k / N) & 1) === 0 && mainland[k] && buildable[k] && fert(k) > 0.18) villageCells.push(k);
  const vArr = new Float32Array(NN);
  for (const k of villageCells) vArr[k] = villageScore(k);
  const vScore = { get: (k: number): number => vArr[k] };
  villageCells.sort((a, b) => vArr[b] - vArr[a]);
  let nVillages = sites.filter((x) => x.kind === 'village').length;
  let spacing = sparse ? 1900 : 1050;
  for (let pass = 0; pass < 6 && nVillages < villageTarget; pass++) {
    for (const k of villageCells) {
      if (nVillages >= villageTarget) break;
      if (vScore.get(k) < (pass < 3 ? 0.1 : -0.3)) break;
      const x = cxOf(k) + (hash01(k, 11, 2) - 0.5) * 24, z = czOf(k) + (hash01(k, 12, 2) - 0.5) * 24;
      const sp = spacing * (0.9 + 0.3 * hash01(k, 13, 2));
      if (!spacingOk(x, z, (o) => o.kind === 'village' ? sp : o.kind === 'town' ? 900 : o.kind === 'city' ? 1100 : o.kind === 'castle' ? 520 : 800)) continue;
      const st = addSite('village', x, z);
      if (coast[k] < 700) st.tags.push('coast');
      nVillages++;
    }
    spacing *= 0.88;
  }
  lap(s, 's.villages');

  // ---------- hamlets ----------
  const hamletCells: number[] = [];
  for (let k = 0; k < NN; k++) {
    if ((k & 1) !== 0 || ((k / N) & 1) !== 0 || !land[k] || water[k] !== 0 || slope[k] > 0.14 || s.waterDist[k] < 45) continue;
    const b = biome[k];
    if (b === Biome.Marsh || b === Biome.Mountain || b === Biome.Snow || b === Biome.Lake || b === Biome.Beach) continue;
    if (!mainland[k]) continue;
    hamletCells.push(k);
  }
  const siteMask = new Uint8Array(NN);
  for (const st of sites) siteMask[Math.floor(st.z / CELL) * N + Math.floor(st.x / CELL)] = 1;
  const siteDist = distanceTransform(siteMask);
  const hScore = (k: number): number => 0.5 * fert(k) + 0.25 * wNear(k) + 0.2 * smoothstep(0.1, 0.5, forestOf(k)) * (1 - smoothstep(0.6, 0.9, forestOf(k))) - 2 * smoothstep(0.05, 0.14, slope[k])
    + 0.35 * smoothstep(900, 1500, siteDist[k]);
  for (let q = 0; q < hamletTarget; q++) {
    const k = pickBest(hamletCells.filter((kk, idx) => idx % 3 === q % 3), hScore, (x, z) => spacingOk(x, z, () => 750), 0.12);
    if (k < 0) continue;
    addSite('hamlet', cxOf(k), czOf(k));
  }

  // ---------- island settlements ----------
  {
    const { labels: cl, sizes } = labelComponents(land);
    const mainLabel = (() => { for (let k = 0; k < NN; k++) if (mainland[k]) return cl[k]; return 0; })();
    for (let c = 1; c < sizes.length; c++) {
      if (c === mainLabel || sizes[c] < 60 || sites.filter((x) => x.island).length >= 4) continue;
      let best = -1, bs = -Infinity, bestFlat = 0;
      for (let k = 0; k < NN; k++) {
        if (cl[k] !== c || slope[k] > 0.1 || biome[k] === Biome.Beach || biome[k] === Biome.Marsh || coast[k] < 60) continue;
        // houses need level ground round the site, not just at it (an island can be a steep cone)
        const ci = k % N, cj = (k / N) | 0;
        let flat = 0;
        for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const kk = jj * N + ii;
          if (cl[kk] === c && slope[kk] < 0.08 && biome[kk] !== Biome.Beach && biome[kk] !== Biome.Marsh && coast[kk] > 30) flat++;
        }
        if (flat < 8) continue;
        const sc = fert(k) + 0.4 * smoothstep(100, 300, coast[k]) * (1 - smoothstep(400, 900, coast[k])) + 0.1 * hash01(k, 2, 5) + 0.02 * flat;
        if (sc > bs) { bs = sc; best = k; bestFlat = flat; }
      }
      if (best < 0) continue;
      const kind: SettlementKind = sizes[c] > 380 && bestFlat >= 26 ? 'village' : 'hamlet';
      const st = addSite(kind, cxOf(best), czOf(best), -1, ['island', 'coast']);
      st.island = true;
    }
  }
  lap(s, 's.hamlets');

  // ---------- counties ----------
  const seats: { site: number; kingdom: number }[] = [];
  for (let kd = 0; kd < K; kd++) { seats.push({ site: kd, kingdom: kd }); for (const id of seatCastles[kd]) seats.push({ site: id, kingdom: kd }); }
  const countyLabels = new Uint16Array(NN);
  {
    const heap = new MinHeap(1 << 14);
    const dist = new Float32Array(NN).fill(Infinity);
    seats.forEach((seat, ci) => {
      const st = sites[seat.site];
      let k = Math.floor(st.z / CELL) * N + Math.floor(st.x / CELL);
      if (s.kingdomGrid[k] !== seat.kingdom + 1) {
        // seat sits on a lake/border cell: find the nearest cell of its kingdom
        let bd = Infinity;
        const ci0 = Math.floor(st.x / CELL), cj0 = Math.floor(st.z / CELL);
        for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
          const kk = (cj0 + dj) * N + ci0 + di;
          if (kk >= 0 && kk < NN && s.kingdomGrid[kk] === seat.kingdom + 1 && di * di + dj * dj < bd) { bd = di * di + dj * dj; k = kk; }
        }
      }
      countyLabels[k] = ci + 1; dist[k] = 0; heap.push(0, k);
    });
    while (heap.size > 0) {
      const c = heap.pop();
      const d = heap.lastKey;
      if (d > dist[c]) continue;
      const i = c % N, j = (c - i) / N;
      for (let q = 0; q < 8; q++) {
        const ii = i + D8X[q], jj = j + D8Z[q];
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const n = jj * N + ii;
        if (s.kingdomGrid[n] !== s.kingdomGrid[c]) continue;
        const nd = d + D8L[q] * (1 + 3 * s.slope[n] + (s.riverWidth[n] > 0 ? 1.5 : 0));
        if (nd < dist[n]) { dist[n] = nd; countyLabels[n] = countyLabels[c]; heap.push(nd, n); }
      }
    }
    // stragglers (disconnected parts): nearest labelled neighbour of the same kingdom
    for (let pass = 0; pass < 60; pass++) {
      let changed = 0;
      for (let k = 0; k < NN; k++) {
        if (countyLabels[k] || !s.kingdomGrid[k]) continue;
        const i = k % N, j = (k - i) / N;
        for (let q = 0; q < 8; q++) {
          const ii = i + D8X[q], jj = j + D8Z[q];
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const n = jj * N + ii;
          if (countyLabels[n] && s.kingdomGrid[n] === s.kingdomGrid[k]) { countyLabels[k] = countyLabels[n]; changed++; break; }
        }
      }
      if (!changed) break;
    }
  }
  // cells the flood could not reach (islands, enclosed pockets): nearest seat of the same kingdom
  {
    const seatXY = seats.map((st) => ({ x: sites[st.site].x, z: sites[st.site].z, kd: st.kingdom }));
    for (let k = 0; k < NN; k++) {
      if (countyLabels[k] || !s.kingdomGrid[k]) continue;
      const x = cxOf(k), z = czOf(k);
      let bi = -1, bd = Infinity;
      seatXY.forEach((q, qi) => { if (q.kd !== s.kingdomGrid[k] - 1) return; const d = (q.x - x) ** 2 + (q.z - z) ** 2; if (d < bd) { bd = d; bi = qi; } });
      if (bi >= 0) countyLabels[k] = bi + 1;
    }
  }
  s.countyGrid = countyLabels;
  const counties: County[] = seats.map((seat, ci) => ({ id: ci, name: '', kingdom: seat.kingdom, seat: seat.site, settlements: [] }));
  for (const c of counties) kingdoms[c.kingdom].counties.push(c.id);
  s.counties = counties;

  // ---------- final settlement objects ----------
  const settlements: Settlement[] = [];
  const nameRng2 = rng.fork('settlement-names');
  for (const st of sites) {
    const k = Math.min(NN - 1, Math.floor(st.z / CELL) * N + Math.floor(st.x / CELL));
    let county = (countyLabels[k] || 0) - 1;
    if (county < 0) {
      let bd = Infinity;
      for (const c of counties) { const seat = sites[c.seat]; if (c.kingdom !== st.kingdom) continue; const d = Math.hypot(seat.x - st.x, seat.z - st.z); if (d < bd) { bd = d; county = c.id; } }
      if (county < 0) county = kingdoms[st.kingdom].counties[0];
    }
    const near = st.kind === 'village' || st.kind === 'town' || st.kind === 'city';
    const port = coast[k] < 450 && near || riverNear[k] > 14 && (st.kind === 'town' || st.kind === 'city');
    const market = st.kind === 'town' || st.kind === 'city' || (st.kind === 'village' && rng.chance(0.14));
    const radius = st.kind === 'city' ? 300 : st.kind === 'town' ? 170 : st.kind === 'village' ? 120 : st.kind === 'castle' ? 70 : st.kind === 'hamlet' ? 55 : 90;
    settlements.push({
      id: st.id, name: settlementName(st.culture, st.kind, nameRng2, usedNames), kind: st.kind, x: st.x, z: st.z, radius,
      kingdom: st.kingdom, county, culture: st.culture, population: st.population, plots: [], strips: [], parcels: [],
      parent: st.parent >= 0 ? st.parent : undefined, market, port,
    });
    counties[county].settlements.push(st.id);
  }
  // county names
  const cn = rng.fork('county-names');
  for (const c of counties) c.name = countyName(kingdoms[c.kingdom].culture, cn, usedNames);
  // abbeys take the nearest town as parent
  for (const st of sites) {
    if (st.kind !== 'abbey' && st.kind !== 'priory' && st.kind !== 'nunnery') continue;
    let bd = Infinity, bi = -1;
    for (const o of sites) { if (o.kind !== 'town' && o.kind !== 'city') continue; const d = Math.hypot(o.x - st.x, o.z - st.z); if (d < bd) { bd = d; bi = o.id; } }
    if (bi >= 0) { st.parent = bi; settlements[st.id].parent = bi; }
  }
  s.sites = sites;
  s.settlements = settlements;
  void (null as unknown as CultureId);
  lap(s, 's.final');
}
