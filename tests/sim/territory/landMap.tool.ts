// A debug picture of what land is what (docs/world/RESOURCES.md, "Territory"): the real continent's terrain with every point
// classed by the territory module, drawn as coloured squares. Not a test (vitest only runs *.test.ts); it reuses the renderer of
// tools/worldmap.ts.
//
//   npx tsx tests/sim/territory/landMap.tool.ts --seed abc --out docs/world --at castle|city|village|mountain [--n 0] [--size 1600] [--x 5600 --z 3800]
//
// Colours: field yellow, pasture light green, meadow teal, croft garden orange, demesne magenta, forest dark green, park violet,
// town white, castle red, road brown, water blue (faint), wild grey.
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
const ppm = 1;
const view = renderZoom(w, cx, cz, size, ppm, false);
const x0 = cx - size / 2, z0 = cz - size / 2, step = 4;
for (let z = z0; z < z0 + size; z += step) {
  for (let x = x0; x < x0 + size; x += step) {
    const l = territory.landAt(x + step / 2, z + step / 2);
    view.circle((x - x0 + step / 2) * ppm, (z - z0 + step / 2) * ppm, step * ppm * 0.7, COLORS[l.kind], l.kind === 'water' ? 0.12 : 0.55);
  }
}
for (const s of w.settlements) if (Math.abs(s.x - cx) < size / 2 && Math.abs(s.z - cz) < size / 2) view.text((s.x - x0) * ppm + 6, (s.z - z0) * ppm - 4, `${s.name} ${s.kind}`, [0, 0, 0], 2);
const file = join(out, `land-${at}-${seed}.png`);
writeFileSync(file, view.png());
console.log('wrote', file, `centre ${cx.toFixed(0)},${cz.toFixed(0)}`);
