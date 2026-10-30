// UI scale: the layouts are designed for 1280×720. Bigger screens get a gentler-than-proportional
// automatic boost (so 1080p text is comfortable and the 3D view stays the star); the player's
// "interface size" setting multiplies on top of it.

export const MIN_SCALE = 0.8;
export const MAX_SCALE = 2.2;

/** 1 at 1280×720 and below, about 1.22 at 1920×1080, 1.45 at 2560×1440 and beyond. */
export function autoScale(width: number, height: number): number {
  const ratio = Math.max(1, Math.min(2, Math.min(width / 1280, height / 720)));
  return 1 + 0.45 * (ratio - 1);
}

/** The scale actually applied: the player's setting times the automatic boost, within sane limits. */
export function effectiveScale(userScale: number, width: number, height: number): number {
  const user = Math.max(0.8, Math.min(1.4, Number.isFinite(userScale) && userScale > 0 ? userScale : 1));
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, user * autoScale(width, height)));
}
