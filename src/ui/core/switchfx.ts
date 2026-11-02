// The way from one body to another (CIV §2), pure: the follow-camera pose behind the new body for the glide, and the clock of the
// screen fade used when the new body is far. The UI app runs it on its own clock, so it moves the same under a test harness.
import { clamp } from './format';
import type { CameraPose } from '../types';
import { FADE_HOLD_SECONDS, FADE_IN_SECONDS, FADE_OUT_SECONDS, GLIDE_SECONDS, type SwitchKind } from './liveAsModel';

/** The height of the head the follow camera looks at above the feet (src/render/camera/cameraRig.ts). */
const HEAD = 1.55;
/** A boom longer than this is not a street camera (the strategic map): fade instead of gliding. */
const STREET_BOOM_MAX = 150;
const BOOM_MIN = 2.2;
const PITCH_MIN = -0.35;
const PITCH_MAX = 1.45;

export interface BodyAt { x: number; y: number; z: number }

/**
 * Where the follow camera will sit behind a new body: the same boom (distance and pitch) as the camera has now, turned to look
 * along `yaw` (the camera yaw once the camera has been aligned with the body). Null when the camera is not a street camera.
 * The old camera's look-at point stands for the old head; the boom is the vector from it to the camera.
 */
export function followPoseBehind(current: CameraPose, body: BodyAt, yaw: number): CameraPose | null {
  const ox = current.position.x - current.lookAt.x, oy = current.position.y - current.lookAt.y, oz = current.position.z - current.lookAt.z;
  const d0 = Math.hypot(ox, oy, oz);
  if (!Number.isFinite(d0) || d0 > STREET_BOOM_MAX || ![body.x, body.y, body.z, yaw].every(Number.isFinite)) return null;
  const d = Math.max(BOOM_MIN, d0);
  const pitch = clamp(Math.asin(clamp(oy / (d0 || 1), -1, 1)), PITCH_MIN, PITCH_MAX);
  const cp = Math.cos(pitch);
  const head = { x: body.x, y: body.y + HEAD, z: body.z };
  return {
    position: { x: head.x - Math.sin(yaw) * cp * d, y: head.y + Math.sin(pitch) * d, z: head.z - Math.cos(yaw) * cp * d },
    lookAt: head,
  };
}

export type FxPhase = 'idle' | 'out' | 'hold' | 'in' | 'glide';
export type FxEvent = 'cut' | 'done';

/**
 * The clock of a switch. A fade runs out (the veil closes) → cut (the caller switches the character) → hold → in (the veil opens);
 * a glide runs for its seconds after the caller has switched. `step` returns the events that fell inside the step.
 */
export class SwitchFx {
  phase: FxPhase = 'idle';
  kind: SwitchKind | null = null;
  private t = 0;

  get active(): boolean { return this.phase !== 'idle'; }

  /** Starts a fade (the caller cuts when `step` says so) or a glide (the caller has cut already). */
  start(kind: SwitchKind): void {
    this.kind = kind;
    this.t = 0;
    this.phase = kind === 'fade' ? 'out' : 'glide';
  }

  /** The switch has happened already (nobody faded out first): start from black, holding, and open the veil. */
  blackOut(): void { this.kind = 'fade'; this.phase = 'hold'; this.t = 0; }

  cancel(): void { this.phase = 'idle'; this.kind = null; this.t = 0; }

  /** 0 clear … 1 black. */
  get veil(): number {
    switch (this.phase) {
      case 'out': return ease(this.t / FADE_OUT_SECONDS);
      case 'hold': return 1;
      case 'in': return 1 - ease(this.t / FADE_IN_SECONDS);
      default: return 0;
    }
  }

  /** Advances by `dt` seconds; returns what happened ('cut' at the end of the fade-out, 'done' at the very end). */
  step(dt: number): FxEvent[] {
    const out: FxEvent[] = [];
    if (this.phase === 'idle') return out;
    this.t += Math.max(0, dt);
    for (let guard = 0; guard < 4; guard++) {
      if (this.phase === 'out' && this.t >= FADE_OUT_SECONDS) { this.t -= FADE_OUT_SECONDS; this.phase = 'hold'; out.push('cut'); continue; }
      if (this.phase === 'hold' && this.t >= FADE_HOLD_SECONDS) { this.t -= FADE_HOLD_SECONDS; this.phase = 'in'; continue; }
      if (this.phase === 'in' && this.t >= FADE_IN_SECONDS) { this.cancel(); out.push('done'); break; }
      if (this.phase === 'glide' && this.t >= GLIDE_SECONDS) { this.cancel(); out.push('done'); break; }
      break;
    }
    return out;
  }
}

function ease(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * The player module raises the camera to the strategic map and brings it down again for about two seconds whenever the character
 * changes (and the zone sends everyone home meanwhile, `view.mode()` being 'map'). The glide and the fade replace that, so the
 * module's own clock is advanced past it: `PlayerApi.frame` with a long step ends the effect at once. A module without the effect
 * only smooths its draw position one more time.
 */
export function skipPlayerSwitchEffect(player: { frame?(dt: number): void }): void {
  try { player.frame?.(2); } catch (err) { console.error('could not skip the switch effect', err); }
}
