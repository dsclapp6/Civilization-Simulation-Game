// Where things are, as the player needs to read it: bearings against the camera, the compass ribbon, the arrow
// on the screen edge for something out of sight, and plain words for distance and direction. Pure (no DOM).
//
// Angles follow the world: yaw 0 faces +z (south on the map), π/2 faces +x (east), so a larger yaw turns LEFT
// on the screen when the camera looks along the yaw. North is −z, i.e. yaw π.
import { wrapAngle } from '../../core/math';
import { distanceText } from './format';

export const TAU = Math.PI * 2;

/** Yaw (radians) of the direction from one point to another. */
export function yawBetween(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

/** Where a yaw lies relative to the camera heading, −π..π; positive = to the left on the screen. */
export function relativeYaw(yaw: number, cameraYaw: number): number { return wrapAngle(yaw - cameraYaw); }

const CARDINALS: ReadonlyArray<{ yaw: number; letter: string; major: boolean }> = [
  { yaw: Math.PI, letter: 'N', major: true },
  { yaw: (3 * Math.PI) / 4, letter: 'NE', major: false },
  { yaw: Math.PI / 2, letter: 'E', major: true },
  { yaw: Math.PI / 4, letter: 'SE', major: false },
  { yaw: 0, letter: 'S', major: true },
  { yaw: -Math.PI / 4, letter: 'SW', major: false },
  { yaw: -Math.PI / 2, letter: 'W', major: true },
  { yaw: (-3 * Math.PI) / 4, letter: 'NW', major: false },
];

export interface RibbonTick { x: number; letter: string | null; major: boolean; minor: boolean }

/**
 * The ticks and compass letters on a ribbon `width` px wide that shows `span` radians centred on the camera heading.
 * `x` is in px from the left edge of the ribbon; ticks every 15°, letters on the eight winds.
 */
export function ribbonTicks(cameraYaw: number, width: number, span: number): RibbonTick[] {
  const out: RibbonTick[] = [];
  const perRad = width / span;
  const step = Math.PI / 12; // 15°
  for (let k = 0; k < 24; k++) {
    const yaw = -Math.PI + k * step;
    const rel = relativeYaw(yaw, cameraYaw);
    if (Math.abs(rel) > span / 2 + 0.02) continue;
    const card = CARDINALS.find((c) => Math.abs(wrapAngle(c.yaw - yaw)) < 1e-6);
    out.push({ x: width / 2 - rel * perRad, letter: card ? card.letter : null, major: !!card && card.major, minor: !card });
  }
  return out;
}

export interface RibbonSpot {
  /** px from the ribbon's left edge. */
  x: number;
  /** In sight on the ribbon; otherwise `x` is pinned at the edge on the side it lies. */
  inside: boolean;
  side: -1 | 0 | 1;
}

export function ribbonSpot(rel: number, width: number, span: number, pad = 14): RibbonSpot {
  const perRad = width / span;
  const x = width / 2 - rel * perRad;
  if (x < pad) return { x: pad, inside: false, side: -1 };
  if (x > width - pad) return { x: width - pad, inside: false, side: 1 };
  return { x, inside: true, side: 0 };
}

export interface EdgeArrow {
  /** Pixel position of the arrow's centre in a `w × h` screen. */
  x: number;
  y: number;
  /** CSS rotation (radians clockwise from "up") of an upward-pointing arrow. */
  angle: number;
}

/**
 * Where to put an arrow for something that is off the screen: on the edge of the screen (inset by `margin`),
 * in the direction it lies. `rel` is the yaw relative to the camera (positive = left); `screenOf` is where the
 * thing projects, or null when it is behind the camera. Returns null when it is in view.
 */
export function edgeArrow(
  rel: number, screenOf: { x: number; y: number } | null, w: number, h: number, margin: number | { l: number; r: number; t: number; b: number },
): EdgeArrow | null {
  const m = typeof margin === 'number' ? { l: margin, r: margin, t: margin, b: margin } : margin;
  if (screenOf && screenOf.x >= m.l && screenOf.x <= w - m.r && screenOf.y >= m.t && screenOf.y <= h - m.b) return null;
  // direction on the screen: ahead is up, left is −x
  let dx: number, dy: number;
  const cx = (m.l + (w - m.r)) / 2, cy = (m.t + (h - m.b)) / 2;
  if (screenOf) {
    dx = screenOf.x - cx;
    dy = screenOf.y - cy;
  } else {
    // behind the camera (no projection): ahead is up, left is −x, so straight behind is the bottom edge
    dx = -Math.sin(rel);
    dy = -Math.cos(rel);
    if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) return null;
  }
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  dx /= len; dy /= len;
  const hx = (w - m.l - m.r) / 2, hy = (h - m.t - m.b) / 2;
  const t = Math.min(dx !== 0 ? hx / Math.abs(dx) : Infinity, dy !== 0 ? hy / Math.abs(dy) : Infinity);
  return { x: cx + dx * t, y: cy + dy * t, angle: Math.atan2(dx, -dy) };
}

const WORDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** "north-east" for a yaw. */
export function windWord(yaw: number): string {
  // yaw π is north; index 0 = north, then clockwise on the map
  const fromNorth = wrapAngle(yaw - Math.PI);
  const idx = Math.round((((-fromNorth) % TAU) + TAU) % TAU / (Math.PI / 4)) % 8;
  return WORDS[idx];
}

/** "86 m north-east" between two points. */
export function where(fromX: number, fromZ: number, toX: number, toZ: number): string {
  const d = Math.hypot(toX - fromX, toZ - fromZ);
  if (d < 6) return 'right here';
  return `${distanceText(d)} ${windWord(yawBetween(fromX, fromZ, toX, toZ))}`;
}

/** A looser phrase for the HUD: "ahead", "to your left", "behind you", from the yaw relative to the camera. */
export function sideWord(rel: number): string {
  const a = Math.abs(rel);
  if (a < 0.4) return 'ahead';
  if (a > 2.6) return 'behind you';
  if (a > 1.9) return rel > 0 ? 'behind you, to the left' : 'behind you, to the right';
  return rel > 0 ? 'to your left' : 'to your right';
}

export function hex(color: number): string { return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`; }
