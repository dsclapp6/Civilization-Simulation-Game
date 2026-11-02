// A debug picture of what land is what (docs/world/RESOURCES.md, "Territory"): the real continent's terrain with every point
// classed by the territory module, drawn as coloured squares. Not a test (vitest only runs *.test.ts); it reuses the renderer of
// tools/worldmap.ts.
//
//   npx tsx tests/sim/territory/landMap.tool.ts --seed abc --out docs/world --at castle|city|village|mountain [--n 0] [--size 1600] [--x 5600 --z 3800]
//        [--ppm 1] [--kinds 0] [--outlines 1] [--outpost x,z] [--name file.png]
//
// Colours: field yellow, pasture light green, meadow teal, croft garden orange, demesne magenta, forest dark green, park violet,
// town white, castle red, road brown, water blue (faint), wild grey. `--outlines 1` draws every settlement's `landsPolygon` (alternate
// colours so neighbours tell apart) and the outposts' `outpostPolygons` (orange); `--kinds 0` leaves the land classes out; `--outpost x,z`
// stands an outpost there (for the picture) belonging to the nearest settlement.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderZoom } from '../../../tools/worldmap';
import { newProfile } from '../../../src/sim/legacy';
import { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import { installTerritory } from '../../../src/sim/territory';
import type { LandKind } from '../../../src/sim/territory/types';
import { generateWorld } from '../../../src/world/generate';
import type { World } from '../../../src/world/world';

const COLORS: Record<LandKind, [number, number, number]> = {
  field: [240, 220, 60], pasture: [120, 220, 90], meadow: [60, 200, 160], garden: [255, 150, 60], demesne: [255, 60, 200], forest: [20, 120, 40],
  park: [160, 40, 220], town: [255, 255, 255], castle: [255, 40, 40], road: [150, 100, 60], water: [60, 120, 255], wild: [90, 90, 90],
};

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const seed = arg('seed', 'abc');
const out = arg('out', 'tools/out');
const at = arg('at', 'castle');
const nth = Number(arg('n', '0'));
const size = Number(arg('size', '1600'));
mkdirSync(out, { recursive: true });

const sim = Simulation.newGame({ seed, difficulty: 'knight', profile: newProfile(), generateWorld: (s) => generateWorld(s) });
const territory = installTerritory(sim, { social: installSocial(sim), economy: undefined as never });
const w = sim.world as unknown as World;
let cx = Number(arg('x', '5600')), cz = Number(arg('z', '3800'));
if (at !== 'mountain') {
  const s = w.settlements.filter((q) => q.kind === at)[nth];
  if (!s) throw new Error(`no ${at} number ${nth}`);
  cx = s.x; cz = s.z;
}
const ppm = Number(arg('ppm', '1'));
const outpostArg = arg('outpost', '');
if (outpostArg) {
  const [ox, oz] = outpostArg.split(',').map(Number);
  const near = w.settlements.reduce((a, b) => (Math.hypot(a.x - ox, a.z - oz) <= Math.hypot(b.x - ox, b.z - oz) ? a : b));
  sim.services.construction = { outposts: () => [{ id: 1, name: 'Camp', settlement: near.id, x: ox, z: oz, deposit: -1, founded: 0 }] } as never;
  territory.refresh();
}
const view = renderZoom(w, cx, cz, size, ppm, false);
const x0 = cx - size / 2, z0 = cz - size / 2, step = Number(arg('step', '4'));
if (arg('kinds', '1') !== '0') {
  for (let z = z0; z < z0 + size; z += step) {
    for (let x = x0; x < x0 + size; x += step) {
      const l = territory.landAt(x + step / 2, z + step / 2);
      view.circle((x - x0 + step / 2) * ppm, (z - z0 + step / 2) * ppm, step * ppm * 0.7, COLORS[l.kind], l.kind === 'water' ? 0.12 : 0.55);
    }
  }
}
if (arg('outlines', '0') !== '0') {
  const ring = (poly: readonly { x: number; z: number }[], color: [number, number, number], width: number): void => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      view.line((a.x - x0) * ppm, (a.z - z0) * ppm, (b.x - x0) * ppm, (b.z - z0) * ppm, width, color, 0.95);
    }
  };
  const palette: Array<[number, number, number]> = [[255, 255, 255], [20, 20, 20], [255, 230, 0], [0, 230, 230]];
  let k = 0;
  for (const s of w.settlements) {
    if (s.kind === 'castle' && s.parent !== undefined) continue; // shares its village's outline
    const poly = territory.landsPolygon(s.id);
    if (!poly.length) continue;
    ring(poly, palette[k++ % palette.length], 2);
    view.circle((s.x - x0) * ppm, (s.z - z0) * ppm, 4, [255, 0, 0], 1);
  }
  for (const o of territory.outpostPolygons()) ring(o.poly, [255, 120, 0], 3);
}
for (const s of w.settlements) if (Math.abs(s.x - cx) < size / 2 && Math.abs(s.z - cz) < size / 2) view.text((s.x - x0) * ppm + 6, (s.z - z0) * ppm - 4, `${s.name} ${s.kind}`, [0, 0, 0], 2);
const file = join(out, arg('name', `land-${at}-${seed}${arg('outlines', '0') !== '0' ? '-outlines' : ''}.png`));
writeFileSync(file, view.png());
console.log('wrote', file, `centre ${cx.toFixed(0)},${cz.toFixed(0)}`);
