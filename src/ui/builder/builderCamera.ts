// Builder mode's camera: the renderer's overview camera (`setOverview`, then `orbit` / `zoom` / `pan` drive it) when the renderer
// has one, else a bird's-eye camera of our own placed with `setCameraPose` (cameraModel.ts). Which one is decided by looking:
// a renderer with an overview camera changes its camera mode or moves the picture within a third of a second of being asked;
// one without does neither (the controls hand the call to nothing).
import type { OverviewView } from '../../render/types';
import type { UiRendererControls } from '../types';
import {
  CAM_LIMITS, clampToCircle, dragged, initialCam, orbited, poseFor, stepToCentre, zoomed, type CamState,
} from './cameraModel';

export type CameraKind = 'pending' | 'overview' | 'pose';

export interface CameraPorts {
  renderer(): UiRendererControls | null;
  /** The ground height under a point (m). */
  heightAt(x: number, z: number): number;
  /** The canvas size in pixels. */
  viewport(): { w: number; h: number };
  /** Seconds of real time (monotonic). */
  clock(): number;
}

export class BuilderCamera {
  kind: CameraKind = 'pending';
  private cam: CamState;
  private readonly plan: OverviewView & { distance: number };
  private before: { mode: string | undefined; sx: number; sy: number; has: boolean } = { mode: undefined, sx: 0, sy: 0, has: false };
  private t0 = 0;
  private readonly watch: Watch = newWatch();
  private dirty = false;
  /** A point to glide to (the "jump to" of the queue and of "place for me"). */
  private goal: { x: number; z: number } | null = null;
  private left = false;

  constructor(private readonly ports: CameraPorts, plan: OverviewView & { distance: number }) {
    this.plan = plan;
    this.cam = initialCam(plan, ports.renderer()?.cameraYaw?.() ?? 0);
  }

  enter(): void {
    const r = this.ports.renderer();
    if (!r) return;
    const p = r.project(this.plan.x, this.ports.heightAt(this.plan.x, this.plan.z), this.plan.z);
    this.before = { mode: r.cameraMode?.(), sx: p?.x ?? 0, sy: p?.y ?? 0, has: !!p };
    this.t0 = this.ports.clock();
    Object.assign(this.watch, newWatch());
    this.kind = 'pending';
    r.setOverview?.({ x: this.plan.x, z: this.plan.z, radius: this.plan.radius, distance: this.plan.distance });
  }

  /** Back to the camera that was on before (the renderer glides; our own pose camera hands over to the follow camera). */
  leave(): void {
    if (this.left) return;
    this.left = true;
    const r = this.ports.renderer();
    if (!r) return;
    if (this.kind === 'pose') r.setCameraMode('follow');
    else r.setOverview?.(null);
  }

  /** Looks over a different circle of land (another settlement, an outpost's ground). */
  recentre(plan: OverviewView & { distance: number }): void {
    Object.assign(this.plan, plan);
    this.cam = { ...this.cam, x: plan.x, z: plan.z, distance: plan.distance };
    const r = this.ports.renderer();
    if (this.kind === 'pose') this.dirty = true;
    else r?.setOverview?.({ x: plan.x, z: plan.z, radius: plan.radius, distance: plan.distance });
  }

  pan(dxPx: number, dyPx: number): void {
    if (this.kind === 'pose') {
      this.cam = clampToCircle(dragged(this.cam, dxPx, dyPx, this.ports.viewport().h), this.plan, this.plan.radius);
      this.dirty = true;
    } else this.ports.renderer()?.pan?.(dxPx, dyPx);
  }

  orbit(dYaw: number, dPitch: number): void {
    if (this.kind === 'pose') { this.cam = orbited(this.cam, dYaw, dPitch); this.dirty = true; } else this.ports.renderer()?.orbit?.(dYaw, dPitch);
  }

  zoom(steps: number): void {
    if (this.kind === 'pose') { this.cam = zoomed(this.cam, steps, this.plan.radius); this.dirty = true; } else this.ports.renderer()?.zoom?.(steps);
  }

  /** Glides the look-at point to a spot. */
  panTo(x: number, z: number): void { this.goal = { x, z }; }

  /** The ground point at the middle of the screen, or null. */
  centre(): { x: number; z: number } | null {
    if (this.kind === 'pose') return { x: this.cam.x, z: this.cam.z };
    const { w, h } = this.ports.viewport();
    return this.ports.renderer()?.screenToGround(w / 2, h / 2) ?? null;
  }

  tick(): void {
    const r = this.ports.renderer();
    if (!r || this.left) return;
    if (this.kind === 'pending') this.probe(r);
    // our own camera was handed back to the follow camera by someone else (a page that closed): lay it again
    if (this.kind === 'pose' && !this.dirty && r.cameraMode?.() === 'follow') this.applyPose(r, 0.5);
    if (this.goal) this.glide(r);
    if (this.kind === 'pose' && this.dirty) {
      this.dirty = false;
      this.applyPose(r, 0);
    }
  }

  private probe(r: UiRendererControls): void {
    const mode = r.cameraMode?.();
    const p = r.project(this.plan.x, this.ports.heightAt(this.plan.x, this.plan.z), this.plan.z);
    const verdict = cameraVerdict(this.watch, mode, this.before.mode, p, this.before.has ? { x: this.before.sx, y: this.before.sy } : null, this.ports.clock() - this.t0);
    if (verdict === 'overview') { this.kind = 'overview'; return; }
    if (verdict === 'none') {
      // no overview camera: place our own, starting where the player's camera looks
      this.kind = 'pose';
      this.cam = { ...this.cam, yaw: r.cameraYaw?.() ?? this.cam.yaw };
      this.applyPose(r, 0.7);
    }
  }

  private glide(r: UiRendererControls): void {
    const g = this.goal;
    if (!g) return;
    if (this.kind === 'pose') {
      const dx = g.x - this.cam.x, dz = g.z - this.cam.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.5) { this.goal = null; return; }
      const step = Math.max(Math.min(d, 2), d * 0.18);
      this.cam = clampToCircle({ ...this.cam, x: this.cam.x + (dx / d) * step, z: this.cam.z + (dz / d) * step }, this.plan, this.plan.radius);
      this.dirty = true;
      return;
    }
    if (this.kind !== 'overview') return;
    const p = r.project(g.x, this.ports.heightAt(g.x, g.z), g.z);
    const { w, h } = this.ports.viewport();
    if (!p) { this.goal = null; return; }
    const s = stepToCentre(p.x, p.y, w, h);
    if (!s) { this.goal = null; return; }
    r.pan?.(s.dx, s.dy);
  }

  private applyPose(r: UiRendererControls, seconds: number): void {
    const pose = poseFor(this.cam, this.ports.heightAt(this.cam.x, this.cam.z));
    r.setCameraPose?.(pose.position, pose.lookAt, seconds);
  }

  /** For tests and tools: our own camera's state. */
  state(): Readonly<CamState> { return this.cam; }
}

/** What the probe has seen of the picture since the overview was asked for. */
export interface Watch { last: { x: number; y: number } | null; still: number; frames: number }

export function newWatch(): Watch { return { last: null, still: 0, frames: 0 }; }

/**
 * Did the renderer's overview camera take over? Judged by looking, one frame at a time, and biased toward "yes" (a renderer that
 * has the camera must not have ours laid over it): its camera mode changed, or the picture moved (a glide to a bird's-eye view
 * moves it; a camera that has nothing to do stands perfectly still). Only a picture that has not moved for a dozen frames and half
 * a second says 'none'. 'wait' while it is not yet clear.
 */
export function cameraVerdict(
  w: Watch, modeNow: string | undefined, modeBefore: string | undefined,
  now: { x: number; y: number } | null, before: { x: number; y: number } | null, seconds: number,
): 'overview' | 'none' | 'wait' {
  w.frames++;
  if (modeNow !== undefined && modeNow !== modeBefore) return 'overview';
  const ref = w.last ?? before;
  const step = ref && now ? Math.hypot(now.x - ref.x, now.y - ref.y) : ref || now ? 99 : 0;
  w.last = now;
  if (step > 4) { w.still = 0; return 'overview'; }
  if (step < 1.2) w.still++;
  if (w.still >= 12 && seconds >= 0.5) return 'none';
  return 'wait';
}

export { CAM_LIMITS };
