// The ten settlement site types (content/sites.json) and how a location is
// classified from the terrain around it.
import sitesJson from '../content/sites.json';
import { B } from '../types';
import { World } from './world';

export interface SiteDef {
  id: string;
  name: string;
  icon: string;
  pros: string;
  cons: string;
  mods: Record<string, number>;
}
export const SITES: SiteDef[] = sitesJson as SiteDef[];
export const SITE_BY_ID: Record<string, SiteDef> = Object.fromEntries(SITES.map((s) => [s.id, s]));

export interface SiteCandidate { type: string; x: number; y: number; score: number; }

export interface SiteReading {
  type: string;
  score: number;
  counts: { ocean: number; lake: number; river: number; land: number; biomes: number[] };
}

/** Classify the ground around (cx, cy) into one of the ten site types. */
export function classifySite(world: World, cx: number, cy: number, radius = 7): SiteReading {
  const biomes = new Array(14).fill(0);
  let ocean = 0, lake = 0, river = 0, land = 0;
  world.forRadius(cx + 0.5, cy + 0.5, radius, (_x, _y, i) => {
    const b = world.biome[i];
    biomes[b]++;
    if (b === B.OCEAN) ocean++;
    else if (b === B.LAKE) lake++;
    else if (b === B.RIVER) river++;
    else land++;
  });
  const total = Math.max(1, land);
  const f = (b: number) => biomes[b] / total;
  const centre = world.biome[world.idx(cx, cy)];
  const scores: Record<string, number> = {};
  if (ocean >= 10) scores.coast = 0.62 + ocean / 160;
  if (lake >= 8) scores.lakeshore = 0.58 + lake / 160;
  if (f(B.MARSH) >= 0.22) scores.marsh = 0.5 + f(B.MARSH);
  if (f(B.JUNGLE) >= 0.2) scores.jungle = 0.5 + f(B.JUNGLE);
  const mtn = f(B.MOUNTAIN) + f(B.SNOW);
  if (mtn >= 0.22 && centre !== B.MOUNTAIN && centre !== B.SNOW) scores.mountainPass = 0.5 + mtn;
  if (f(B.HILLS) >= 0.35) scores.highlands = 0.4 + f(B.HILLS);
  if (river >= 4) scores.riverValley = 0.45 + Math.min(0.4, river / 50) + 0.2 * (f(B.GRASS) + f(B.FOREST));
  if (f(B.FOREST) >= 0.45) scores.forest = 0.36 + f(B.FOREST);
  const dry = f(B.STEPPE) + f(B.DESERT);
  if (dry >= 0.35) scores.steppe = 0.36 + dry;
  if (f(B.GRASS) >= 0.35) scores.plains = 0.3 + f(B.GRASS);
  let best = 'plains', bestScore = -1;
  for (const k in scores) if (scores[k] > bestScore) { best = k; bestScore = scores[k]; }
  if (bestScore < 0) {
    // Nothing qualified strongly: fall back to the dominant land cover.
    const options: [string, number][] = [
      ['forest', f(B.FOREST) + f(B.JUNGLE) * 0.5], ['plains', f(B.GRASS)], ['steppe', dry + f(B.TUNDRA)],
      ['highlands', f(B.HILLS) + mtn], ['marsh', f(B.MARSH)],
    ];
    options.sort((a, b) => b[1] - a[1]);
    best = options[0][0]; bestScore = options[0][1] * 0.5;
  }
  return { type: best, score: bestScore, counts: { ocean, lake, river, land, biomes } };
}

/** Find good example sites of every type inside a rectangle. */
export function findSiteCandidates(world: World, rect = world.bounds, perType = 4, spacing = 18): SiteCandidate[] {
  const all: SiteCandidate[] = [];
  for (let y = rect.y0 + 4; y <= rect.y1 - 4; y += 3) {
    for (let x = rect.x0 + 4; x <= rect.x1 - 4; x += 3) {
      const i = world.idx(x, y);
      if (!world.passable(i) || world.isWater(i)) continue;
      const b = world.biome[i];
      if (b === B.MOUNTAIN || b === B.SNOW) continue;
      const r = classifySite(world, x, y);
      all.push({ type: r.type, x, y, score: r.score });
    }
  }
  all.sort((a, b) => b.score - a.score);
  const chosen: SiteCandidate[] = [];
  const perCount: Record<string, number> = {};
  for (const c of all) {
    if ((perCount[c.type] ?? 0) >= perType) continue;
    let ok = true;
    for (const o of chosen) {
      if (o.type === c.type && (o.x - c.x) ** 2 + (o.y - c.y) ** 2 < spacing * spacing) { ok = false; break; }
    }
    if (!ok) continue;
    chosen.push(c);
    perCount[c.type] = (perCount[c.type] ?? 0) + 1;
  }
  return chosen;
}
