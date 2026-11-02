// The small map of your lands (ruler's Overview): the outline of each place you rule (the territory's `landsPolygon`), the land your
// vassals hold, the claims of your outposts, the deposits inside the picture, your own position. SVG, drawn once per rebuild.
import type { P2 } from '../../core/math';
import { settlementName } from '../../sim/api';
import type { PanelCtx } from '../app/panel';
import { svgEl } from '../core/dom';
import { DEPOSIT_COLOR, DEPOSIT_NAME, cssColor, richnessWords, type DepositKind } from '../core/mapModel';
import { boxOf, fitBox, polyPath } from './rulerModel';

export interface LandsMapOptions {
  width: number;
  height: number;
  /** Places the person rules directly, and the places their vassals hold. */
  direct: readonly number[];
  vassal: readonly number[];
  /** The House whose outposts are drawn. */
  house: number;
}

const SETTLEMENT_R: Record<string, number> = { hamlet: 2.6, village: 3.4, town: 4.4, city: 5.6, castle: 4.2, abbey: 3.8, priory: 3.2, nunnery: 3.2 };

/** A circle of 24 points, for a settlement the territory service has no outline for. */
function circle(x: number, z: number, r: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; out.push({ x: x + Math.cos(a) * r, z: z + Math.sin(a) * r }); }
  return out;
}

export function landsMap(ctx: PanelCtx, o: LandsMapOptions): SVGElement {
  const sim = ctx.sim;
  const world = sim.world;
  const terr = ctx.game.territory;
  const svg = svgEl('svg', { viewBox: `0 0 ${o.width} ${o.height}`, class: 'mu-rul-map', role: 'img', 'aria-label': 'Your lands' });
  const at = (id: number): { x: number; z: number; kind: string } | undefined => world.settlements.find((s) => s.id === id);
  const outline = (id: number): readonly P2[] => {
    const s = at(id);
    if (!s) return [];
    const poly = terr?.landsPolygon?.(id);
    return poly && poly.length > 2 ? poly : circle(s.x, s.z, terr?.landsRadius(id) ?? 1200);
  };
  const ruled = [...o.direct, ...o.vassal];
  const directPolys = o.direct.map(outline).filter((p) => p.length);
  const vassalPolys = o.vassal.map(outline).filter((p) => p.length);
  const outposts = (ctx.game.construction?.outposts() ?? []).filter((p) => p.house === o.house || ruled.includes(p.settlement));
  const claims = (terr?.outpostPolygons?.() ?? []).filter((c) => outposts.some((p) => p.id === c.outpost) && c.poly.length > 2);
  const points: P2[] = [];
  for (const id of ruled) { const s = at(id); if (s) points.push({ x: s.x, z: s.z }); }
  for (const p of outposts) points.push({ x: p.x, z: p.z });
  const box = boxOf([...directPolys, ...vassalPolys, ...claims.map((c) => c.poly)], points, 0.06);
  if (!box) return svg;
  const fit = fitBox(box, o.width, o.height);
  const inBox = (x: number, z: number): boolean => x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;

  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: o.width, height: o.height, fill: 'rgba(120, 150, 100, 0.12)' }));
  // the land of the others in the picture, faint: so the borders have something to be borders of
  for (const s of world.settlements) {
    if (ruled.includes(s.id) || !inBox(s.x, s.z)) continue;
    svg.appendChild(svgEl('circle', { cx: fit.x(s.x).toFixed(1), cy: fit.y(s.z).toFixed(1), r: 1.8, fill: 'rgba(60, 40, 20, 0.35)' }));
  }
  for (const poly of vassalPolys) svg.appendChild(svgEl('path', { d: polyPath(poly, fit), fill: 'rgba(29, 65, 143, 0.14)', stroke: 'rgba(29, 65, 143, 0.65)', 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }));
  for (const poly of directPolys) svg.appendChild(svgEl('path', { d: polyPath(poly, fit), fill: 'rgba(214, 170, 70, 0.3)', stroke: '#946a0b', 'stroke-width': 1.8 }));
  for (const c of claims) svg.appendChild(svgEl('path', { d: polyPath(c.poly, fit), fill: 'rgba(210, 110, 50, 0.22)', stroke: '#b4561c', 'stroke-width': 1.3, 'stroke-dasharray': '2 2' }));
  // deposits
  for (const d of world.deposits ?? []) {
    if (!inBox(d.x, d.z)) continue;
    const dot = svgEl('circle', { cx: fit.x(d.x).toFixed(1), cy: fit.y(d.z).toFixed(1), r: 3, fill: cssColor(DEPOSIT_COLOR[d.kind as DepositKind]), stroke: '#2a1b0f', 'stroke-width': 0.8 });
    dot.appendChild(svgEl('title', null, `${DEPOSIT_NAME[d.kind as DepositKind]}: ${richnessWords(d.richness)}`));
    svg.appendChild(dot);
  }
  // places and names
  const halo = 'paint-order: stroke; stroke: #f4e7c2; stroke-width: 3px; stroke-linejoin: round;';
  for (const id of ruled) {
    const s = at(id);
    if (!s) continue;
    const direct = o.direct.includes(id);
    const r = SETTLEMENT_R[s.kind] ?? 3;
    const g = svgEl('g', null);
    g.appendChild(svgEl('circle', { cx: fit.x(s.x).toFixed(1), cy: fit.y(s.z).toFixed(1), r: r + 1.2, fill: direct ? '#6f4f0b' : '#1d418f' }));
    g.appendChild(svgEl('circle', { cx: fit.x(s.x).toFixed(1), cy: fit.y(s.z).toFixed(1), r, fill: '#f6ead0' }));
    if (direct || ruled.length <= 8) {
      g.appendChild(svgEl('text', { x: (fit.x(s.x) + r + 3).toFixed(1), y: (fit.y(s.z) + 4).toFixed(1), 'font-size': direct ? 12 : 10.5, 'font-weight': direct ? 700 : 400, fill: direct ? '#2a1b0f' : '#33415f', style: halo }, settlementName(world, id)));
    }
    svg.appendChild(g);
  }
  for (const p of outposts) {
    const x = fit.x(p.x), y = fit.y(p.z);
    svg.appendChild(svgEl('path', { d: `M${x},${y - 5}L${x + 5},${y}L${x},${y + 5}L${x - 5},${y}Z`, fill: '#e39a45', stroke: '#2a1b0f', 'stroke-width': 1 }));
    svg.appendChild(svgEl('text', { x: (x + 8).toFixed(1), y: (y + 4).toFixed(1), 'font-size': 10.5, fill: '#7a3a10', style: halo }, p.name));
  }
  const body = ctx.player.body();
  if (body && inBox(body.x, body.z)) {
    svg.appendChild(svgEl('circle', { cx: fit.x(body.x).toFixed(1), cy: fit.y(body.z).toFixed(1), r: 5, fill: 'none', stroke: '#1d418f', 'stroke-width': 2 }));
    svg.appendChild(svgEl('circle', { cx: fit.x(body.x).toFixed(1), cy: fit.y(body.z).toFixed(1), r: 1.8, fill: '#1d418f' }));
  }
  return svg;
}
