// What the building recipes say of their insides (docs/INTERIORS.md): the blocks of the house kit, the doorways and the
// chimneys of every kind at every level, for one culture. `npx tsx tools/interiors-dump.ts [culture] [kind]`
import { BUILDINGS, type BuildingKind } from '../src/content/types';
import type { CultureId } from '../src/core/domain';
import { normalizeRequest, runRecipe } from '../src/assets/buildings/index';

const culture = (process.argv[2] ?? 'anglo') as CultureId;
const only = process.argv[3]?.startsWith('-') ? undefined : process.argv[3];
const f = (v: number): string => v.toFixed(1);
for (const kind of process.argv.includes('--plans') ? [] : Object.keys(BUILDINGS) as BuildingKind[]) {
  if (only && kind !== only) continue;
  for (let lv = 1; lv <= BUILDINGS[kind].maxLevel; lv++) {
    const n = normalizeRequest({ kind, level: lv, culture, seed: 0 });
    const { ctx } = runRecipe(n, true);
    const o = ctx.out;
    const sh = (o.shells ?? []).map((s) => `[${s.role || '-'} o(${f(s.ox)},${f(s.oy)},${f(s.oz)}) r(${f(s.rects[0].x0)},${f(s.rects[0].x1)},${f(s.rects[0].z0)},${f(s.rects[0].z1)}) st${s.hs.map(f).join('/')} ${s.walls[0]}${s.turned ? ' TURNED' : ''}${s.noFloor ? ' nf' : ''}]`).join(' ');
    const dw = (o.doorways ?? []).map((d) => `${d.kind}${d.open ? 'O' : ''}(${f(d.x)},${f(d.y)},${f(d.z)} n${d.nx.toFixed(0)},${d.nz.toFixed(0)} ${d.w}x${d.h})`).join(' ');
    console.log(`${kind}${lv} ${BUILDINGS[kind].w}x${BUILDINGS[kind].d}: ${sh}\n    doors: ${dw}  ch:${(o.chimneys ?? []).length} hints:${(o.hints ?? []).map((h) => h.kind).join(',')}`);
  }
}

// the plans and what in them is not reached (`--plans`)
if (process.argv.includes('--plans')) {
  void (async () => {
    const { interiorPlan } = await import('../src/assets/interiors/plan');
    const { validatePlan } = await import('../src/assets/interiors/validate');
    const cultures: CultureId[] = process.argv.includes('--all') ? ['anglo', 'norse', 'franc', 'teuton', 'gael', 'cymric'] : [culture];
    let bad = 0, n = 0;
    for (const c of cultures) for (const kind of Object.keys(BUILDINGS) as BuildingKind[]) {
      if (only && kind !== only) continue;
      for (let lv = 1; lv <= BUILDINGS[kind].maxLevel; lv++) {
        const p = interiorPlan(kind, lv, c, 0);
        if (!p) continue;
        n++;
        const v = validatePlan(p);
        const head = `${c} ${kind}${lv}: ${p.levels.length} levels, ${p.rooms.length} rooms (${p.rooms.map((r) => r.name).join(', ')}), ${p.doors.length} doors, ${p.stairs.length} stairs, ${p.furniture.length} things, ${p.spots.length} spots`;
        if (process.argv.includes('--map')) for (let l = 0; l < p.levels.length; l++) console.log(`level ${l} (y ${p.levels[l].y.toFixed(2)}):\n${v.ascii(l)}`);
        if (v.problems.length) { bad++; console.log(`${head}\n   ! ${v.problems.join('\n   ! ')}`); } else if (process.argv.includes('-v')) console.log(head);
      }
    }
    console.log(`${n} plans, ${bad} with problems`);
  })();
}
