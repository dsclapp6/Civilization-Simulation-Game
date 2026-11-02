// Debug maps of the deposits (docs/world/RESOURCES.md): the continent with every deposit drawn as a coloured disc, optionally
// tinted by whose lands each place is (settlement lands, from src/world/lands.ts), and close-ups of single deposits.
//
//   npx tsx tests/world/depositMap.tool.ts --seed abc --out docs/world [--size 2048] [--lands] [--zoom iron,stone,clay,salt,silver,gold]
//
// (Not a test: vitest only runs *.test.ts. It reuses the renderer of tools/worldmap.ts.)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderContinent, renderZoom } from '../../tools/worldmap';
import { buildWorld } from '../../src/world/generate';
import { LandsIndex } from '../../src/world/lands';
import { RESOURCE_KINDS, WORLD_SIZE, type ResourceKind } from '../../src/world/types';

type RGB = [number, number, number];
export const DEPOSIT_COLOR: Record<ResourceKind, RGB> = {
  iron: [196, 70, 40], stone: [236, 236, 236], clay: [236, 150, 40], salt: [120, 230, 250], silver: [200, 210, 255], gold: [255, 220, 0],
};

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const seed = arg('seed', 'abc');
const out = arg('out', 'tools/out');
const size = Number(arg('size', '2048'));
const wantLands = process.argv.includes('--lands');
const zoom = arg('zoom', '').split(',').filter(Boolean) as ResourceKind[];
mkdirSync(out, { recursive: true });
const world = buildWorld(seed);
const px = size / WORLD_SIZE;

const c = renderContinent(world, size);
if (wantLands) {
  const lands = new LandsIndex(world.settlements);
  const step = 48;
  for (let z = step / 2; z < WORLD_SIZE; z += step) for (let x = step / 2; x < WORLD_SIZE; x += step) {
    if (world.macro.water[Math.floor(z / world.macro.cell) * world.macro.res + Math.floor(x / world.macro.cell)] === 1) continue;
    const id = lands.lookup(x, z);
    if (id < 0) continue;
    const h = ((id * 2654435761) >>> 0) / 4294967296;
    const col: RGB = [90 + 150 * h, 90 + 150 * ((h * 7) % 1), 90 + 150 * ((h * 13) % 1)];
    c.circle(x * px, z * px, Math.max(1, step * px * 0.6), col, 0.32);
  }
}
const legend: string[] = [];
for (const k of RESOURCE_KINDS) {
  const n = world.deposits?.filter((d) => d.kind === k).length ?? 0;
  legend.push(`${k.toUpperCase()} ${n}`);
}
for (const d of world.deposits ?? []) {
  const col = DEPOSIT_COLOR[d.kind];
  const r = d.kind === 'silver' || d.kind === 'gold' ? 7 : 5;
  c.circle(d.x * px, d.z * px, r * (size / 2048) + 1.5, [0, 0, 0]);
  c.circle(d.x * px, d.z * px, r * (size / 2048), col);
}
RESOURCE_KINDS.forEach((k, i) => {
  c.circle(26, 30 + i * 22, 7, [0, 0, 0]);
  c.circle(26, 30 + i * 22, 5.5, DEPOSIT_COLOR[k]);
  c.text(40, 26 + i * 22, legend[i], [255, 255, 255], 2);
});
const file = join(out, `deposits-${seed}.png`);
writeFileSync(file, c.png());
console.log('wrote', file, legend.join('  '));

for (const kind of zoom) {
  const list = (world.deposits ?? []).filter((d) => d.kind === kind);
  if (!list.length) continue;
  // the richest of the kind
  const d = list.slice().sort((a, b) => b.richness - a.richness)[0];
  const view = renderZoom(world, d.x, d.z, 360, 2.4);
  const ppm = 2.4, x0 = d.x - 180, z0 = d.z - 180;
  for (const o of world.deposits ?? []) {
    if (Math.abs(o.x - d.x) > 200 || Math.abs(o.z - d.z) > 200) continue;
    const col = DEPOSIT_COLOR[o.kind];
    // outline of the deposit's extent
    for (let a = 0; a < 96; a++) view.circle((o.x - x0 + Math.cos((a / 96) * Math.PI * 2) * o.radius) * ppm, (o.z - z0 + Math.sin((a / 96) * Math.PI * 2) * o.radius) * ppm, 1.4, col);
    view.circle((o.x - x0) * ppm, (o.z - z0) * ppm, 3.5, col);
  }
  view.text(10, 10, `${kind.toUpperCase()} R${d.radius} Q${d.richness}`, [255, 255, 255], 2);
  const zf = join(out, `deposit-${kind}-${seed}.png`);
  writeFileSync(zf, view.png());
  console.log('wrote', zf, `(${kind} #${d.id} at ${d.x.toFixed(0)},${d.z.toFixed(0)} radius ${d.radius} richness ${d.richness} settlement ${d.settlement})`);
}
