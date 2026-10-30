// A small, fully valid WorldModel for tests and the headless tool: flat terrain, a handful of
// kingdoms, settlements of every kind with plots and open-field strips. It stands in for the real
// generator (src/world/generate.ts) — the sim must only rely on the WorldModel contract.
import type { BuildingKind } from '../../content/types';
import { CULTURES, type CultureId, type SettlementKind } from '../../core/domain';
import { dist2, yawTo } from '../../core/math';
import { Rng } from '../../core/rng';
import {
  Biome, CHUNK_SIZE, Ground, WORLD_SIZE,
  type BiomeId, type County, type GroundId, type Kingdom, type LandParcel, type MacroGrid, type Plot, type Road,
  type RoadGraph, type Settlement, type Strip, type WorldModel,
} from '../../world/types';

export interface MockWorldOptions {
  seed?: string;
  /** 'small' ≈ 12 settlements in 2 kingdoms; 'large' ≈ 132 settlements in 6 kingdoms (~12k people). */
  preset?: 'small' | 'large' | 'tiny';
  kingdoms?: number;
}

const KINGDOM_DEFS: ReadonlyArray<{ name: string; culture: CultureId; color: number }> = [
  { name: 'Wessex', culture: 'anglo', color: 0xb03a3a },
  { name: 'Normandy', culture: 'franc', color: 0x3a5ab0 },
  { name: 'Alba', culture: 'gael', color: 0x3a8a4a },
  { name: 'Gwynedd', culture: 'cymric', color: 0xc9a227 },
  { name: 'Danelaw', culture: 'norse', color: 0x7a3ab0 },
  { name: 'Franconia', culture: 'teuton', color: 0x3a9ab0 },
];

const SYLLABLES: Record<CultureId, { pre: string[]; suf: string[] }> = {
  anglo: { pre: ['Ash', 'Thorn', 'Wood', 'Mill', 'Brad', 'Ford', 'North', 'West', 'East', 'Stan', 'Wick', 'Hamp', 'King', 'Oak', 'Elm', 'Ox', 'Cam', 'Lin', 'Hart', 'Bar'], suf: ['ton', 'by', 'ham', 'ford', 'wick', 'field', 'bury', 'worth', 'stead', 'ley', 'ington', 'combe', 'well', 'burn'] },
  franc: { pre: ['Mont', 'Saint-', 'Beau', 'Vil', 'Cha', 'Mor', 'Ver', 'Roc', 'Bel', 'Fon', 'Aul', 'Bre'], suf: ['ville', 'mont', 'court', 'val', 'bourg', 'ac', 'ay', 'ois', 'lay', 'ier'] },
  gael: { pre: ['Glen', 'Inver', 'Dun', 'Ard', 'Kil', 'Bally', 'Strath', 'Loch', 'Drum', 'Ben', 'Kin', 'Tul'], suf: ['more', 'mory', 'dee', 'ness', 'nagh', 'kirk', 'lorn', 'cairn', 'ray', 'ullin'] },
  cymric: { pre: ['Aber', 'Llan', 'Pen', 'Caer', 'Dol', 'Tre', 'Rhos', 'Bryn', 'Cwm', 'Maes', 'Nant', 'Bod'], suf: ['gwyn', 'dyfi', 'ystwyth', 'bedr', 'wen', 'fach', 'fawr', 'gelli', 'coed', 'uchaf'] },
  norse: { pre: ['Thor', 'Vik', 'Sand', 'Lang', 'Stein', 'Holm', 'Eyr', 'Nes', 'Dal', 'Skog', 'Kirk', 'Brun'], suf: ['by', 'stad', 'vik', 'holm', 'fjord', 'thorpe', 'dal', 'borg', 'nes', 'gard'] },
  teuton: { pre: ['Ober', 'Nieder', 'Alt', 'Neu', 'Hohen', 'Stein', 'Wald', 'Burg', 'Rhein', 'Eich', 'Linden', 'Rosen'], suf: ['dorf', 'burg', 'heim', 'stadt', 'bach', 'feld', 'hausen', 'berg', 'tal', 'au'] },
};

const POP: Record<SettlementKind, number> = {
  hamlet: 35, village: 84, town: 200, city: 320, castle: 60, abbey: 34, priory: 16, nunnery: 24,
};

function layoutFor(preset: 'tiny' | 'small' | 'large'): SettlementKind[][] {
  if (preset === 'tiny') {
    // One kingdom-sized slice: enough to exercise every code path in a few hundred people.
    return [['city', 'town', 'castle', 'abbey', 'nunnery', 'village', 'village', 'village', 'hamlet']];
  }
  if (preset === 'small') {
    return [
      ['city', 'town', 'castle', 'abbey', 'village', 'hamlet'],
      ['city', 'town', 'castle', 'nunnery', 'village', 'priory'],
    ];
  }
  const one: SettlementKind[] = [
    'city', 'town', 'castle', 'castle', 'abbey', 'priory', 'nunnery', 'hamlet', 'hamlet', 'hamlet',
    'village', 'village', 'village', 'village', 'village', 'village', 'village', 'village', 'village', 'village', 'village', 'village',
  ];
  return [one, one, one, one, one, one];
}

interface Rect { x0: number; z0: number; x1: number; z1: number }

export function createMockWorld(opts: MockWorldOptions = {}): WorldModel {
  const seed = opts.seed ?? 'mock';
  const preset = opts.preset ?? 'small';
  const rng = new Rng(`mockworld:${seed}`);
  const layout = layoutFor(preset);
  const nK = Math.max(1, Math.min(opts.kingdoms ?? layout.length, KINGDOM_DEFS.length, layout.length));

  // kingdom regions
  const cols = nK <= 2 ? nK : 3;
  const rows = Math.ceil(nK / cols);
  const regions: Rect[] = [];
  for (let k = 0; k < nK; k++) {
    const cx = k % cols, cz = Math.floor(k / cols);
    regions.push({
      x0: (cx * WORLD_SIZE) / cols, z0: (cz * WORLD_SIZE) / rows,
      x1: ((cx + 1) * WORLD_SIZE) / cols, z1: ((cz + 1) * WORLD_SIZE) / rows,
    });
  }

  const kingdoms: Kingdom[] = [];
  const counties: County[] = [];
  const settlements: Settlement[] = [];
  const plots: Plot[] = [];
  const strips: Strip[] = [];
  const parcels: LandParcel[] = [];
  const usedNames = new Set<string>();

  const uniqueName = (culture: CultureId): string => {
    const syl = SYLLABLES[culture];
    for (let i = 0; i < 50; i++) {
      const n = rng.pick(syl.pre) + rng.pick(syl.suf);
      const name = n.charAt(0).toUpperCase() + n.slice(1);
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
    }
    const name = `${rng.pick(syl.pre)}${rng.pick(syl.suf)} ${usedNames.size}`;
    usedNames.add(name);
    return name;
  };

  const addPlot = (settlement: number, culture: CultureId, kind: BuildingKind, x: number, z: number, cx: number, cz: number, role?: string, level = 1): number => {
    const id = plots.length;
    plots.push({
      id, kind, level, x, z, rot: yawTo(x, z, cx, cz), settlement, culture, seed: rng.int(1, 1 << 30), role,
    });
    return id;
  };

  for (let k = 0; k < nK; k++) {
    const def = KINGDOM_DEFS[k % KINGDOM_DEFS.length];
    const region = regions[k];
    const kinds = layout[k].slice();
    // grid cells for placement
    const n = kinds.length;
    const gc = Math.ceil(Math.sqrt((n * (region.x1 - region.x0)) / (region.z1 - region.z0)));
    const gr = Math.ceil(n / gc);
    const cellW = (region.x1 - region.x0) / gc, cellH = (region.z1 - region.z0) / gr;
    const cells: number[] = [];
    for (let i = 0; i < gc * gr; i++) cells.push(i);
    rng.shuffle(cells);
    // city goes to the most central cell
    const centre = cells.reduce((best, c) => {
      const ccx = region.x0 + ((c % gc) + 0.5) * cellW, ccz = region.z0 + (Math.floor(c / gc) + 0.5) * cellH;
      const bx = region.x0 + ((best % gc) + 0.5) * cellW, bz = region.z0 + (Math.floor(best / gc) + 0.5) * cellH;
      const mx = (region.x0 + region.x1) / 2, mz = (region.z0 + region.z1) / 2;
      return dist2(ccx, ccz, mx, mz) < dist2(bx, bz, mx, mz) ? c : best;
    }, cells[0]);
    cells.splice(cells.indexOf(centre), 1);
    cells.unshift(centre);

    const firstSettlement = settlements.length;
    const kingdomId = k;
    for (let i = 0; i < n; i++) {
      const kind = kinds[i];
      const c = cells[i];
      const x = region.x0 + ((c % gc) + 0.5 + rng.range(-0.28, 0.28)) * cellW;
      const z = region.z0 + (Math.floor(c / gc) + 0.5 + rng.range(-0.28, 0.28)) * cellH;
      const id = settlements.length;
      const pop = Math.max(8, Math.round(POP[kind] * rng.range(0.85, 1.15)));
      const radius = kind === 'city' ? 520 : kind === 'town' ? 300 : kind === 'village' ? 150 : kind === 'hamlet' ? 80
        : kind === 'castle' ? 110 : 140;
      const s: Settlement = {
        id, name: uniqueName(def.culture), kind, x, z, radius, kingdom: kingdomId, county: -1,
        culture: def.culture, population: pop, plots: [], strips: [], parcels: [],
        market: kind === 'town' || kind === 'city' || (kind === 'village' && rng.chance(0.15)),
        port: false,
      };
      settlements.push(s);
    }

    // counties: seats are the city and the castles
    const seats = settlements.slice(firstSettlement).filter((s) => s.kind === 'city' || s.kind === 'castle');
    const kCounties: County[] = seats.map((seat, ci) => {
      const county: County = {
        id: counties.length + ci, name: `${seat.name}shire`, kingdom: kingdomId, seat: seat.id, settlements: [],
      };
      return county;
    });
    counties.push(...kCounties);
    for (let i = firstSettlement; i < settlements.length; i++) {
      const s = settlements[i];
      let best = kCounties[0], bd = Infinity;
      for (const c of kCounties) {
        const seat = settlements[c.seat];
        const d = dist2(s.x, s.z, seat.x, seat.z);
        if (d < bd) { bd = d; best = c; }
      }
      s.county = best.id;
      best.settlements.push(s.id);
    }
    const capital = settlements.slice(firstSettlement).find((s) => s.kind === 'city') ?? settlements[firstSettlement];
    kingdoms.push({
      id: kingdomId, name: def.name, culture: def.culture, capital: capital.id, color: def.color,
      counties: kCounties.map((c) => c.id),
    });
  }

  // parents: castle → nearest village/town; abbey/priory/nunnery → nearest town
  for (const s of settlements) {
    if (s.kind !== 'castle' && s.kind !== 'abbey' && s.kind !== 'priory' && s.kind !== 'nunnery') continue;
    let best = -1, bd = Infinity;
    for (const o of settlements) {
      if (o.kingdom !== s.kingdom || o.id === s.id) continue;
      const ok = s.kind === 'castle' ? (o.kind === 'village' || o.kind === 'town') : o.kind === 'town';
      if (!ok) continue;
      const d = dist2(s.x, s.z, o.x, o.z);
      if (d < bd) { bd = d; best = o.id; }
    }
    if (best >= 0) s.parent = best;
  }

  // plots, strips, parcels
  for (const s of settlements) {
    const cx = s.x, cz = s.z;
    const c = s.culture;
    const place = (kind: BuildingKind, ring: number, role?: string, level = 1): void => {
      const a = rng.range(0, Math.PI * 2);
      const r = s.radius * ring * rng.range(0.85, 1.1);
      s.plots.push(addPlot(s.id, c, kind, cx + Math.cos(a) * r, cz + Math.sin(a) * r, cx, cz, role, level));
    };
    const homes = (count: number, kinds: BuildingKind[], weights: number[], maxRing: number): void => {
      for (let i = 0; i < count; i++) {
        const kind = rng.weighted(kinds, weights);
        const a = (i / Math.max(1, count)) * Math.PI * 2 * 7 + rng.range(-0.2, 0.2);
        const r = s.radius * (0.18 + maxRing * Math.sqrt((i + 1) / (count + 1)));
        s.plots.push(addPlot(s.id, c, kind, cx + Math.cos(a) * r, cz + Math.sin(a) * r, cx, cz, 'home', rng.chance(0.2) ? 2 : 1));
      }
    };
    switch (s.kind) {
      case 'hamlet':
      case 'village': {
        const nHomes = Math.max(3, Math.ceil(s.population / 4.6));
        homes(nHomes, ['cottage', 'hovel', 'longhouse'], [0.6, 0.25, 0.15], 0.75);
        place('church', 0.12, 'parish');
        if (s.kind === 'village' && rng.chance(0.55)) place('manor_house', 0.3, 'lord_seat', 2);
        if (rng.chance(0.55) && s.kind === 'village') place(rng.chance(0.6) ? 'watermill' : 'windmill', 0.8, 'mill');
        if (s.kind === 'village' && rng.chance(0.7)) place('smithy', 0.45, 'smith');
        if (s.kind === 'village' && rng.chance(0.6)) place('alehouse', 0.4, 'alehouse');
        place('barn', 0.55); place('well', 0.2); place('granary', 0.5);
        if (s.kind === 'village') { place('tithe_barn', 0.35); place('archery_butts', 0.95); place('stocks', 0.15); }
        break;
      }
      case 'town':
      case 'city': {
        const nHomes = Math.max(10, Math.ceil(s.population / 5.2));
        homes(nHomes, ['townhouse', 'cottage', 'hovel'], [0.7, 0.2, 0.1], 0.85);
        place('church', 0.1, 'parish'); place('market_hall', 0.05, 'market'); place('guildhall', 0.15);
        for (let i = 0; i < (s.kind === 'city' ? 4 : 2); i++) place('tavern', 0.3);
        for (let i = 0; i < (s.kind === 'city' ? 5 : 2); i++) place('smithy', 0.5);
        place('bakehouse', 0.3); place('brewhouse', 0.35); place('weaver', 0.4); place('carpenter', 0.45);
        place('tannery', 0.75); place('warehouse', 0.6); place('well', 0.12); place('well', 0.4);
        place('school', 0.2);
        if (s.kind === 'city') {
          place('cathedral', 0.14, 'parish', 2); place('keep_stone', 0.6, 'lord_seat', 2); place('great_hall', 0.55);
          place('church', 0.3); place('church', 0.45); place('infirmary', 0.35);
        }
        const wr = s.radius * 1.15;
        s.walls = Array.from({ length: 12 }, (_, i) => ({ x: cx + Math.cos((i / 12) * Math.PI * 2) * wr, z: cz + Math.sin((i / 12) * Math.PI * 2) * wr }));
        s.gates = [s.walls[0], s.walls[6]];
        break;
      }
      case 'castle': {
        place('keep_stone', 0.05, 'lord_seat', 2); place('great_hall', 0.2); place('barracks', 0.35);
        place('stable', 0.4); place('smithy', 0.45); place('chapel', 0.3); place('well', 0.15);
        place('gatehouse', 0.8); place('tower', 0.85); place('tower', 0.85);
        homes(Math.max(4, Math.ceil(s.population / 9)), ['hovel', 'cottage'], [0.7, 0.3], 0.6);
        break;
      }
      case 'abbey':
      case 'priory':
      case 'nunnery': {
        place(s.kind === 'abbey' ? 'abbey_church' : 'church', 0.1, 'parish', 2);
        place('cloister', 0.2, 'cloister'); place('infirmary', 0.35); place('barn', 0.55);
        place('brewhouse', 0.45); place('bakehouse', 0.4); place('well', 0.15); place('gatehouse', 0.85);
        homes(Math.max(3, Math.ceil(s.population / 12)), ['hovel', 'cottage'], [0.6, 0.4], 0.6);
        break;
      }
    }

    // open fields: three blocks of strips around the settlement
    if (s.kind === 'village' || s.kind === 'hamlet' || s.kind === 'abbey') {
      const nStrips = Math.max(9, Math.round(s.population / 2.2));
      const perField = Math.ceil(nStrips / 3);
      for (let f = 0; f < 3; f++) {
        const ang = (f / 3) * Math.PI * 2 + 0.6;
        const bx = cx + Math.cos(ang) * (s.radius + 140);
        const bz = cz + Math.sin(ang) * (s.radius + 140);
        for (let i = 0; i < perField; i++) {
          const x0 = bx - (perField * 9) / 2 + i * 9, z0 = bz - 60;
          const id = strips.length;
          strips.push({
            id, settlement: s.id, field: f as 0 | 1 | 2,
            poly: [{ x: x0, z: z0 }, { x: x0 + 8, z: z0 }, { x: x0 + 8, z: z0 + 120 }, { x: x0, z: z0 + 120 }],
            area: 8 * 120,
          });
          s.strips.push(id);
        }
      }
    }
    // a pasture parcel
    if (s.kind === 'village' || s.kind === 'hamlet') {
      const id = parcels.length;
      parcels.push({
        id, settlement: s.id, use: 'pasture',
        poly: [{ x: cx - 80, z: cz + s.radius + 30 }, { x: cx + 80, z: cz + s.radius + 30 }, { x: cx + 80, z: cz + s.radius + 110 }, { x: cx - 80, z: cz + s.radius + 110 }],
      });
      s.parcels.push(id);
    }
  }

  // roads: each settlement to its two nearest neighbours
  const roads: Road[] = [];
  const edges: RoadGraph['edges'] = [];
  const seen = new Set<string>();
  for (const s of settlements) {
    const order = settlements.filter((o) => o.id !== s.id).sort((a, b) => dist2(s.x, s.z, a.x, a.z) - dist2(s.x, s.z, b.x, b.z)).slice(0, 2);
    for (const o of order) {
      const key = s.id < o.id ? `${s.id}-${o.id}` : `${o.id}-${s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = roads.length;
      roads.push({ id, kind: 'road', points: [{ x: s.x, z: s.z }, { x: o.x, z: o.z }], width: 5, from: s.id, to: o.id });
      edges.push({ a: s.id, b: o.id, roadId: id, length: Math.sqrt(dist2(s.x, s.z, o.x, o.z)) });
    }
  }
  const roadGraph: RoadGraph = { nodes: settlements.map((s) => ({ id: s.id, x: s.x, z: s.z, settlement: s.id })), edges };

  // coarse macro grid (res 16) — enough for kingdom/county area queries
  const res = 16;
  const cell = WORLD_SIZE / res;
  const macro: MacroGrid = {
    res, cell,
    height: new Float32Array(res * res).fill(10),
    biome: new Uint8Array(res * res).fill(Biome.Meadow),
    water: new Uint8Array(res * res),
    forest: new Uint8Array(res * res).fill(40),
    fertility: new Uint8Array(res * res).fill(160),
    kingdom: new Uint8Array(res * res),
    county: new Uint16Array(res * res),
  };
  const nearestIdx = (x: number, z: number): number => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < settlements.length; i++) {
      const d = dist2(x, z, settlements[i].x, settlements[i].z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const s = settlements[nearestIdx((i + 0.5) * cell, (j + 0.5) * cell)];
      macro.kingdom[j * res + i] = s.kingdom + 1;
      macro.county[j * res + i] = s.county + 1;
    }
  }

  const world: WorldModel = {
    seed,
    size: WORLD_SIZE,
    macro,
    rivers: [], lakes: [], roads, bridges: [], fords: [], roadGraph,
    kingdoms, counties, settlements, plots, strips, parcels,
    heightAt: () => 10,
    waterSurfaceAt: () => null,
    biomeAt: (): BiomeId => Biome.Meadow,
    groundAt: (): GroundId => Ground.Grass,
    forestAt: () => 0.2,
    walkCostAt: () => 1,
    scatterInChunk: () => [],
    settlementAt: (x, z) => {
      const s = settlements[nearestIdx(x, z)];
      return dist2(x, z, s.x, s.z) <= s.radius * s.radius ? s : null;
    },
    nearestSettlement: (x, z) => settlements[nearestIdx(x, z)],
    kingdomAt: (x, z) => kingdoms[settlements[nearestIdx(x, z)].kingdom] ?? null,
    countyAt: (x, z) => counties[settlements[nearestIdx(x, z)].county] ?? null,
  };
  void CHUNK_SIZE; void CULTURES;
  return world;
}
