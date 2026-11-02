// Builder mode's camera: the renderer's overview camera (`setOverview`, then `orbit` / `zoom` / `pan` drive it) when the renderer
// has one, else a bird's-eye camera of our own placed with `setCameraPose` (cameraModel.ts). Which one is decided by looking:
// a renderer with an overview camera ends up looking down on a wide stretch of ground (the middle half of the screen spans
// scores of metres); one without goes on showing what the player's own camera showed — a few metres across, still or moving
// with the player (the controls hand the call to nothing).
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
  private before: Sight = { point: null, span: 0 };
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
    this.before = this.sight(r);
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

  /** What the camera shows now: where the middle of the land lies on the screen and how much ground the middle of the screen spans. */
  private sight(r: UiRendererControls): Sight {
    const { w, h } = this.ports.viewport();
    const a = r.screenToGround(w * 0.25, h * 0.55);
    const b = r.screenToGround(w * 0.75, h * 0.55);
    return {
      point: r.project(this.plan.x, this.ports.heightAt(this.plan.x, this.plan.z), this.plan.z),
      span: a && b ? Math.hypot(a.x - b.x, a.z - b.z) : 0,
    };
  }

  private probe(r: UiRendererControls): void {
    const verdict = cameraVerdict(this.watch, this.sight(r), this.before, this.plan.distance, this.ports.clock() - this.t0);
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

/** What the camera shows at one moment: the screen position of the middle of the land and the metres of ground the middle half of the screen spans. */
export interface Sight { point: { x: number; y: number } | null; span: number }

/** What the probe has seen since the overview was asked for. */
export interface Watch { last: { x: number; y: number } | null; still: number; wide: number; frames: number }

export function newWatch(): Watch { return { last: null, still: 0, wide: 0, frames: 0 }; }

/** Frames that look wide before the overview camera is believed; frames of an unmoved picture (and seconds) before 'none'; and the longest wait. */
export const VERDICT = { wideFrames: 3, stillFrames: 12, stillSeconds: 0.5, lateFrames: 60, lateSeconds: 1.3 } as const;

/** How much ground the middle half of the screen must span for a camera to be a bird's-eye one (the player's own shows a dozen metres). */
export function wideSpan(distance: number): number { return Math.max(24, Math.min(60, distance * 0.3)); }

/**
 * Did the renderer's overview camera take over? Judged by looking, one frame at a time. A bird's-eye camera sees scores of metres
 * across the middle of the screen, a good deal more than the camera it replaced, and it keeps seeing them: that is 'overview'. A
 * picture that has not moved for a dozen frames and half a second says 'none' (the call went to nothing); so does a picture that
 * goes on moving as the player's camera does while he walks, once the glide of an overview camera (under a second) has surely
 * been and gone. 'wait' while it is not yet clear. (A camera that is merely moving is not taken for an overview camera.)
 */
export function cameraVerdict(w: Watch, seen: Sight, before: Sight | null, distance: number, seconds: number): 'overview' | 'none' | 'wait' {
  w.frames++;
  const ref = w.last ?? before?.point ?? null;
  const step = ref && seen.point ? Math.hypot(seen.point.x - ref.x, seen.point.y - ref.y) : ref || seen.point ? 99 : 0;
  w.last = seen.point;
  if (seen.span >= wideSpan(distance) && seen.span >= (before?.span ?? 0) * 1.5) w.wide++;
  else w.wide = 0;
  if (w.wide >= VERDICT.wideFrames) return 'overview';
  if (step < 1.2) w.still++;
  else w.still = 0;
  if (w.still >= VERDICT.stillFrames && seconds >= VERDICT.stillSeconds) return 'none';
  if (w.frames >= VERDICT.lateFrames && seconds >= VERDICT.lateSeconds) return 'none';
  return 'wait';
}

export { CAM_LIMITS };
