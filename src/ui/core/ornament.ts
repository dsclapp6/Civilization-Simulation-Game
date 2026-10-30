// Illuminated-manuscript ornaments drawn as inline SVG: window corner flourishes, rule dividers,
// heraldic shields. No image files.
import type { Heraldry } from '../../core/view';
import { h, staticSvg, svgEl } from './dom';

const CORNER = `
<path d="M3 31V11C3 6.6 6.6 3 11 3h20" stroke="url(#mu-gold)" stroke-width="2.2"/>
<path d="M8.2 31V13.4c0-2.9 2.3-5.2 5.2-5.2H31" stroke="url(#mu-gold)" stroke-width="1" opacity=".75"/>
<path d="M13.6 13.6c3.4-.4 5.6 1.2 5.4 3.7-.2 2-2.4 3-3.9 2.1-1.3-.8-1-2.6.3-2.9" stroke="url(#mu-gold)" stroke-width="1.5"/>
<circle cx="4.6" cy="4.6" r="2.3" fill="url(#mu-gold)" stroke="#5a3d08" stroke-width=".6"/>
<path d="M20 3.2c1.6 2 .8 4-1.2 4.6M3.2 20c2 1.6 4 .8 4.6-1.2" stroke="url(#mu-gold)" stroke-width="1.2" opacity=".85"/>`;

/** One corner flourish (top-left orientation); CSS flips it for the other corners. */
export function cornerFlourish(): HTMLElement {
  const svg = svgEl('svg', { viewBox: '0 0 34 34', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const inner = staticSvg(CORNER);
  while (inner.firstChild) svg.appendChild(inner.firstChild);
  return h('i.mu-corner', null, svg);
}

export function corners(): HTMLElement[] {
  return ['tl', 'tr', 'bl', 'br'].map((pos) => {
    const el = cornerFlourish();
    el.classList.add(pos);
    return el;
  });
}

/** Hidden SVG holding the shared gold-leaf gradient the flourishes refer to. Mount once per UI root. */
export function goldDefs(): SVGElement {
  const svg = svgEl('svg', { width: '0', height: '0', style: 'position:absolute', 'aria-hidden': 'true' });
  const defs = staticSvg(`<defs>
    <linearGradient id="mu-gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7de8c"/><stop offset=".35" stop-color="#d4a431"/><stop offset=".6" stop-color="#9c6d10"/><stop offset="1" stop-color="#e2bb4e"/>
    </linearGradient>
  </defs>`);
  while (defs.firstChild) svg.appendChild(defs.firstChild);
  return svg;
}

/** A thin double rule with a small diamond in the middle. */
export function divider(): HTMLElement {
  const d = h('div.mu-divider');
  d.appendChild(staticHtmlDiamond());
  return d;
}

function staticHtmlDiamond(): SVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 12 12', width: '12', height: '12', class: 'mu-diamond' });
  const p = staticSvg('<path d="M6 .8 11.2 6 6 11.2.8 6z" fill="url(#mu-gold)" stroke="#5a3d08" stroke-width=".7"/>');
  while (p.firstChild) svg.appendChild(p.firstChild);
  return svg;
}

// ---- heraldry (the twelve designs of assets/characters/human/heraldry.ts, as SVG) ----

type UV = readonly [number, number];
const rect = (u0: number, v0: number, u1: number, v1: number): UV[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
function band(px: number, py: number, qx: number, qy: number, w: number): UV[] {
  const dx = qx - px, dy = qy - py;
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * w, ny = (dx / l) * w;
  return [[px - nx, py - ny], [qx - nx, qy - ny], [qx + nx, qy + ny], [px + nx, py + ny]];
}

export const HERALDIC_DESIGNS = ['lozenge', 'pale', 'fess', 'cross', 'saltire', 'chevron', 'bend', 'quarterly', 'chief', 'per pale', 'bordure', 'bars'] as const;

export function heraldicPolys(pattern: number): UV[][] {
  switch (((pattern % 12) + 12) % 12) {
    case 0: return [[[0, -0.5], [0.42, 0], [0, 0.5], [-0.42, 0]]];
    case 1: return [rect(-0.3, -1, 0.3, 1)];
    case 2: return [rect(-1, -0.25, 1, 0.25)];
    case 3: return [rect(-0.2, -1, 0.2, 1), rect(-1, 0.05, 1, 0.42)];
    case 4: return [band(-1.1, -1.1, 1.1, 1.1, 0.22), band(-1.1, 1.1, 1.1, -1.1, 0.22)];
    case 5: return [band(-1.15, -0.75, 0.04, 0.35, 0.22), band(-0.04, 0.35, 1.15, -0.75, 0.22)];
    case 6: return [band(-1.15, 1.15, 1.15, -1.15, 0.28)];
    case 7: return [rect(-1, 0, 0, 1), rect(0, -1, 1, 0)];
    case 8: return [rect(-1, 0.42, 1, 1)];
    case 9: return [rect(0, -1, 1, 1)];
    case 10: return [rect(-1, -1, 1, -0.78), rect(-1, 0.78, 1, 1), rect(-1, -0.78, -0.78, 0.78), rect(0.78, -0.78, 1, 0.78)];
    default: return [rect(-1, 0.18, 1, 0.48), rect(-1, -0.48, 1, -0.18)];
  }
}

const hex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
let shieldSeq = 0;

/** A heater shield in the house's colours (field + charge). With no heraldry: a plain parchment shield. */
export function shield(heraldry: Heraldry | undefined, size = 56): SVGElement {
  const id = `mu-sh${++shieldSeq}`;
  const field = heraldry ? hex(heraldry.field) : '#d9c28c';
  const charge = heraldry ? hex(heraldry.charge) : '#a88a50';
  const polys = heraldry ? heraldicPolys(heraldry.pattern) : [];
  // map u,v in [-1,1] (v up) onto the shield's body
  const px = (u: number): number => 20 + u * 15;
  const py = (v: number): number => 22 - v * 17;
  const body = 'M5 4h30v14c0 11-7 17-15 21C12 35 5 29 5 18z';
  const svg = svgEl('svg', { viewBox: '0 0 40 44', width: String(size), height: String((size * 44) / 40), class: 'mu-shield' });
  svg.appendChild(svgEl('defs', null, svgEl('clipPath', { id }, svgEl('path', { d: body }))));
  svg.appendChild(svgEl('path', { d: body, fill: field }));
  const g = svgEl('g', { 'clip-path': `url(#${id})`, fill: charge });
  for (const poly of polys) g.appendChild(svgEl('polygon', { points: poly.map(([u, v]) => `${px(u).toFixed(2)},${py(v).toFixed(2)}`).join(' ') }));
  svg.appendChild(g);
  svg.appendChild(svgEl('path', { d: 'M5 4h30v14c0 11-7 17-15 21C12 35 5 29 5 18z', fill: 'none', stroke: '#241608', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }));
  svg.appendChild(svgEl('path', { d: 'M7 6h26v12c0 9.4-5.8 14.8-13 18.4C12.800 32.800 7 27.400 7 18z', fill: 'none', stroke: 'rgba(255,240,200,.35)', 'stroke-width': '.8' }));
  return svg;
}
