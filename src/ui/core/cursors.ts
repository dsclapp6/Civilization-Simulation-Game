// The mouse cursors of the free-cursor scheme (CLARITY §5): the ordinary arrow with a small round badge that says
// what a click will do (talk, work, trade, go in, fight, use, walk there). Drawn here as inline SVG and handed to
// CSS as data URIs, so there are no image files. The hotspot is always the tip of the arrow.
import type { CursorKind } from '../../player/types';

const INK = '#1f1309';
const CREAM = '#fff4d6';

interface Badge { fill: string; glyph: string }

/** Glyphs sit in a 16 × 16 box whose centre is (23, 23); strokes are cream on a coloured disc. */
const BADGES: Record<Exclude<CursorKind, 'default'>, Badge> = {
  talk: { fill: '#1d418f', glyph: `<path d='M18.2 19.4h9.6v6.2h-5.2l-2.6 2.4v-2.4h-1.8z' fill='${CREAM}'/>` },
  work: {
    fill: '#946a0b',
    glyph: `<path d='M19.2 27.4 24.6 21.6' stroke='${CREAM}' stroke-width='2.2' stroke-linecap='round'/><path d='M22.2 18.4 27.6 23.4' stroke='${CREAM}' stroke-width='4' stroke-linecap='butt'/>`,
  },
  trade: {
    fill: '#386a37',
    glyph: `<circle cx='23' cy='23' r='4.4' fill='none' stroke='${CREAM}' stroke-width='1.8'/><path d='M23 20.6v4.8M21.4 22.2h3.2' stroke='${CREAM}' stroke-width='1.4'/>`,
  },
  enter: {
    fill: '#6b4a06',
    glyph: `<path d='M19.4 18.6h6v9.6h-6z' fill='none' stroke='${CREAM}' stroke-width='1.6'/><path d='M22.4 23h6M26.4 20.8 28.6 23l-2.2 2.2' fill='none' stroke='${CREAM}' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/>`,
  },
  attack: {
    fill: '#ac2818',
    glyph: `<path d='M19 19l8 8M27 19l-8 8' stroke='${CREAM}' stroke-width='2.2' stroke-linecap='round'/>`,
  },
  use: {
    fill: '#4f3924',
    glyph: `<path d='M20.6 18.6 26 23l-5.4 4.4' fill='none' stroke='${CREAM}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>`,
  },
  walk: {
    fill: '#4f3924',
    glyph: `<ellipse cx='21.4' cy='25.2' rx='1.7' ry='2.5' fill='${CREAM}'/><ellipse cx='25.4' cy='21.4' rx='1.7' ry='2.5' fill='${CREAM}'/>`,
  },
};

function svgFor(kind: Exclude<CursorKind, 'default'>): string {
  const b = BADGES[kind];
  return `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>`
    + `<path d='M3 2.2v17.6l4.6-4.2 3.2 7 3.2-1.4-3.2-6.8h6.4z' fill='${CREAM}' stroke='${INK}' stroke-width='1.5' stroke-linejoin='round'/>`
    + `<circle cx='22.8' cy='22.8' r='8.2' fill='${b.fill}' stroke='${INK}' stroke-width='1.5'/>`
    + b.glyph
    + `</svg>`;
}

const cache = new Map<string, string>();

/** The SVG source of a cursor (for the dev gallery and tests). */
export function cursorSvg(kind: CursorKind): string | null {
  return kind === 'default' ? null : svgFor(kind);
}

/** A CSS `cursor` value for the kind. The plain arrow is left to the browser. */
export function cursorCss(kind: CursorKind | 'grab'): string {
  if (kind === 'default') return '';
  if (kind === 'grab') return 'grabbing';
  let css = cache.get(kind);
  if (!css) {
    css = `url("data:image/svg+xml,${encodeURIComponent(svgFor(kind))}") 3 2, auto`;
    cache.set(kind, css);
  }
  return css;
}
