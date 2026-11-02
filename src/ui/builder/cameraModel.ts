// Builder mode's own overhead camera, pure: used when the renderer has no overview camera (`setOverview`), so builder mode still
// has a bird's-eye view over the land through `setCameraPose`. It also holds the small pieces both ways of moving the camera
// share: what the movement keys ask for, how far to drag the ground to bring a point to the middle of the screen.
//
// Conventions (docs/ARCHITECTURE.md §5): metres, x east, z south, y up; yaw 0 looks toward +z and turning right lowers it.

export interface CamState {
  /** The ground point the camera looks at. */
  x: number;
  z: number;
  yaw: number;
  /** Elevation of the camera above the horizontal as seen from the target (radians). */
  pitch: number;
  /** Distance from the target (m). */
  distance: number;
}

export interface Pose {
  position: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
}

export const CAM_LIMITS = { minDistance: 20, maxDistanceFactor: 2.2, minPitch: 0.35, maxPitch: 1.35, defaultPitch: (55 * Math.PI) / 180, fov: (50 * Math.PI) / 180 } as const;

export function initialCam(plan: { x: number; z: number; distance: number }, yaw: number): CamState {
  return { x: plan.x, z: plan.z, yaw, pitch: CAM_LIMITS.defaultPitch, distance: plan.distance };
}

/** Where the camera stands and what it looks at, given the height of the ground under the target. */
export function poseFor(cam: CamState, groundY: number): Pose {
  const fx = Math.sin(cam.yaw), fz = Math.cos(cam.yaw);
  const horizontal = Math.cos(cam.pitch) * cam.distance;
  return {
    position: { x: cam.x - fx * horizontal, y: groundY + Math.sin(cam.pitch) * cam.distance, z: cam.z - fz * horizontal },
    lookAt: { x: cam.x, y: groundY, z: cam.z },
  };
}

/** Keeps the target inside the circle the overview is allowed over. */
export function clampToCircle(cam: CamState, centre: { x: number; z: number }, radius: number): CamState {
  const dx = cam.x - centre.x, dz = cam.z - centre.z;
  const d = Math.hypot(dx, dz);
  if (d <= radius || d === 0) return cam;
  const k = radius / d;
  return { ...cam, x: centre.x + dx * k, z: centre.z + dz * k };
}

export function zoomed(cam: CamState, steps: number, radius: number): CamState {
  const max = Math.max(CAM_LIMITS.minDistance * 2, radius * CAM_LIMITS.maxDistanceFactor);
  const d = cam.distance * Math.pow(1.16, steps);
  return { ...cam, distance: Math.max(CAM_LIMITS.minDistance, Math.min(max, d)) };
}

export function orbited(cam: CamState, dYaw: number, dPitch: number): CamState {
  let yaw = cam.yaw + dYaw;
  while (yaw > Math.PI) yaw -= Math.PI * 2;
  while (yaw <= -Math.PI) yaw += Math.PI * 2;
  return { ...cam, yaw, pitch: Math.max(CAM_LIMITS.minPitch, Math.min(CAM_LIMITS.maxPitch, cam.pitch + dPitch)) };
}

/**
 * Drags the ground by screen pixels (`pan` of the renderer: dragging right moves the land right, so the camera moves left;
 * dragging down moves the camera forward). `viewportHeight` is the canvas height in pixels.
 */
export function dragged(cam: CamState, dxPx: number, dyPx: number, viewportHeight: number): CamState {
  const metresPerPixel = (2 * cam.distance * Math.tan(CAM_LIMITS.fov / 2)) / Math.max(200, viewportHeight);
  const fx = Math.sin(cam.yaw), fz = Math.cos(cam.yaw);
  // right of the camera on the ground: forward rotated a quarter turn to the right (toward −x when facing +z)
  const rx = -fz, rz = fx;
  const forward = (dyPx * metresPerPixel) / Math.max(0.35, Math.sin(cam.pitch));
  const right = -dxPx * metresPerPixel;
  return { ...cam, x: cam.x + fx * forward + rx * right, z: cam.z + fz * forward + rz * right };
}

/** The pan the movement keys ask for, in the pixels per second `pan` takes (W = forward = the ground drags down). */
export const KEY_PAN_PIXELS_PER_SECOND = 600;

export function keyPanPixels(forward: number, right: number, dt: number): { dx: number; dy: number } {
  return { dx: -right * dt * KEY_PAN_PIXELS_PER_SECOND, dy: forward * dt * KEY_PAN_PIXELS_PER_SECOND };
}

/** Which way each movement key pushes: [forward, right]. */
export const PAN_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [1, 0], ArrowUp: [1, 0], KeyS: [-1, 0], ArrowDown: [-1, 0], KeyD: [0, 1], ArrowRight: [0, 1], KeyA: [0, -1], ArrowLeft: [0, -1],
};

/** The combined push of the keys held now. */
export function heldPan(down: ReadonlySet<string>): { forward: number; right: number } {
  let forward = 0, right = 0;
  for (const code of down) {
    const k = PAN_KEYS[code];
    if (k) { forward += k[0]; right += k[1]; }
  }
  return { forward: Math.max(-1, Math.min(1, forward)), right: Math.max(-1, Math.min(1, right)) };
}

/**
 * How many pixels to drag the ground, this frame, to bring a point that now shows at (`sx`, `sy`) toward the middle of a screen of
 * (`w`, `h`): a share of the way each frame so it glides, with a minimum step so it arrives; null once it is within `tolerance`.
 */
export function stepToCentre(sx: number, sy: number, w: number, h: number, tolerance = 6, share = 0.22): { dx: number; dy: number } | null {
  const ox = w / 2 - sx, oy = h / 2 - sy;
  const d = Math.hypot(ox, oy);
  if (d <= tolerance) return null;
  const move = Math.max(Math.min(d, 6), d * share);
  return { dx: (ox / d) * move, dy: (oy / d) * move };
}
