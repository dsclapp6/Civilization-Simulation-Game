// Camera modes: third-person follow (orbit, zoom, terrain + building collision), free fly (dev),
// strategic map (pan/zoom, north-up, tilted) and cinematic orbit. Mode switches blend smoothly:
// positions interpolate with altitude in log space (a natural rise from street to map), rotations
// slerp.
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../../core/math';
import type { CameraMode, OverviewView } from '../types';

export interface CameraEnv {
  heightAt(x: number, z: number): number;
  /** Distance along the ray to the first building box, or null. */
  raycastBuildings?(ray: THREE.Ray, maxDist: number, pad?: number): number | null;
  worldSize: number;
}

interface Pose { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number }

const FOLLOW_MIN = 2.4;
/** First person (the default view): the camera sits at the eyes; the wheel steps out to the shoulder and back. */
const TP_NEAR = 3.4, FP_FOV = 68, FP_NEAR = 0.07, STAGE_COOLDOWN = 0.45;
/** First-person look: pitch is positive looking DOWN (as the orbit boom is positive above), so this is the whole sky and the whole ground. */
const FP_PITCH = 1.5;
/** Eaves, bulging thatch and jetties overhang a building's footprint box by this much (m); the boom keeps clear of it. */
const EAVE_PAD = 0.6;
const FOLLOW_MAX = 140;
const MAP_MIN = 450;
/** Aiming: shoulder offset to the right (m) and boom length. */
const AIM_SHOULDER = 0.62;
const AIM_DISTANCE = 3.2;
const MAP_MAX = 30000;
/** Overview camera (builder mode, tactical view): default pitch (~55°), its range, and the glide in and out (s). */
const OV_PITCH = 0.96, OV_PITCH_MIN = 0.62, OV_PITCH_MAX = 1.36, OV_GLIDE = 0.8;

interface Overview { cx: number; cz: number; radius: number; lx: number; lz: number; dist: number; yaw: number; pitch: number;
  /** Smoothed values the camera actually shows. */
  sx: number; sz: number; sdist: number; syaw: number; spitch: number }

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'follow';
  autoMapZoom = true;
  // follow / cinematic
  private readonly target = new THREE.Vector3();
  private targetValid = false;
  yaw = Math.PI * 0.85;
  pitch = 0.3;
  distance = 9;
  private curDistance = 9;
  // map
  private readonly mapCentre = new THREE.Vector2(8000, 8000);
  private mapAlt = 11000;
  private readonly mapPitch = 1.18;
  private mapYaw = Math.PI;
  // free
  readonly freePos = new THREE.Vector3(8000, 200, 8000);
  freeYaw = 0;
  freePitch = -0.25;
  // cinematic
  private cineAngle = 0;
  // transition
  private transFrom: Pose | null = null;
  private transT = 0;
  private transDur = 1.4;
  private readonly live: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 55 };
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly m = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly focusTmp = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private readonly probe2 = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  /** The boom's reach as the camera shows it: it eases in when something comes between and out again only after the way has stayed clear (no jumps). */
  private reachSm = 99;
  private clearT = 0;
  /** First person: wanted (the wheel's choice), how far the blend to the eyes has got (0 boom … 1 eyes), the eyes (set each frame by the renderer) and the head bob. */
  firstPerson = true;
  private fpK = 0;
  private readonly eye = new THREE.Vector3();
  private eyeValid = false;
  private eyeY = 0;
  private eyeBob = 0;
  private lastEyeX = NaN; private lastEyeZ = NaN;
  private bobSpeed = 0;
  private bobPhase = 0;
  /** The "head bob" setting. */
  bobbing = true;
  /** After a step between first person and the shoulder the wheel waits a moment (animation time or real time, whichever is over first), so one flick of a trackpad is one step. */
  private stageCool = 0;
  private stageAtMs = -1e9;
  private readonly fpPose: Pose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: FP_FOV };
  /** Over-the-shoulder aim blend (0 normal follow … 1 aiming a bow or crossbow) and its target. */
  private aimK = 0;
  private aimWant = false;
  /** The overview camera while it is on, and the mode it returns to. */
  private ov: Overview | null = null;
  private ovPrev: CameraMode = 'follow';

  constructor(aspect: number, private readonly env: CameraEnv) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.2, 60000);
    this.pitch = 0.05;
    this.camera.position.set(8000, 300, 8000);
    this.mapCentre.set(env.worldSize / 2, env.worldSize / 2);
  }

  setMode(mode: CameraMode, transition = 1.4): void {
    if (this.ov) {
      // an explicit mode change ends the overview (with the same glide)
      this.ov = null;
      this.transFrom = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov };
      this.transT = 0;
      this.transDur = Math.max(0.01, transition);
      if (mode === this.mode) return;
    }
    if (mode === this.mode) return;
    this.transFrom = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov };
    this.transT = 0;
    this.transDur = Math.max(0.01, transition);
    if (mode === 'map') {
      const ref = this.targetValid ? this.target : this.camera.position;
      this.mapCentre.set(ref.x, ref.z);
      this.mapAlt = clamp(this.mapAlt, 2500, MAP_MAX);
      this.mapYaw = Math.PI;
    }
    if (mode === 'free' && this.mode !== 'free') {
      this.freePos.copy(this.camera.position);
      const d = this.camera.getWorldDirection(this.tmp);
      this.freeYaw = Math.atan2(d.x, d.z);
      this.freePitch = Math.asin(clamp(d.y, -1, 1));
    }
    if (mode === 'follow' && this.mode === 'map') {
      this.distance = clamp(this.distance, 6, 30);
    }
    this.mode = mode;
  }

  orbit(dYaw: number, dPitch: number): void {
    if (this.ov) {
      this.ov.yaw += dYaw;
      this.ov.pitch = clamp(this.ov.pitch + dPitch, OV_PITCH_MIN, OV_PITCH_MAX);
      return;
    }
    switch (this.mode) {
      case 'free':
        this.freeYaw += dYaw;
        this.freePitch = clamp(this.freePitch + dPitch, -1.5, 1.5);
        break;
      case 'map':
        this.mapYaw += dYaw;
        break;
      default:
        this.yaw += dYaw;
        this.pitch = clamp(this.pitch + dPitch, this.firstPerson ? -FP_PITCH : -0.35, this.firstPerson ? FP_PITCH : 1.45);
    }
  }

  zoom(steps: number): void {
    const f = Math.pow(1.15, steps);
    if (this.ov) {
      this.ov.dist = clamp(this.ov.dist * f, 20, Math.max(20, 2.2 * this.ov.radius));
      return;
    }
    if (this.mode === 'map') {
      const next = this.mapAlt * f;
      if (next < MAP_MIN && this.autoMapZoom && steps < 0) { this.setMode('follow'); this.distance = 40; return; }
      this.mapAlt = clamp(next, MAP_MIN, MAP_MAX);
    } else if (this.mode === 'follow' && this.firstPerson) {
      // the wheel out of first person: over the shoulder (one step at a time, not a slide through the stages)
      if (steps > 0 && this.stageReady() && this.eyeValid) this.setViewDistance(TP_NEAR);
    } else if (this.mode === 'follow' || this.mode === 'cinematic') {
      const next = this.distance * f;
      if (this.mode === 'follow' && steps < 0 && next < FOLLOW_MIN && this.eyeValid) {
        if (this.stageReady()) this.setViewDistance(0);
        return;
      }
      if (next > FOLLOW_MAX && this.autoMapZoom && steps > 0 && this.mode === 'follow') { this.mapAlt = 2600; this.setMode('map'); return; }
      this.distance = clamp(next, FOLLOW_MIN, FOLLOW_MAX);
    } else {
      // free: zoom moves forward
      const d = this.camera.getWorldDirection(this.tmp);
      const ground = this.env.heightAt(this.freePos.x, this.freePos.z);
      this.freePos.addScaledVector(d, -steps * Math.max(4, (this.freePos.y - ground) * 0.15));
    }
  }

  /** 0 = first person, else the third-person boom length (m). The wheel and the saved choice both come through here. */
  setViewDistance(d: number): void {
    if (d <= 0) {
      if (!this.firstPerson) this.pitch = 0.05;
      this.firstPerson = true;
    } else {
      if (this.firstPerson) this.pitch = Math.max(0.25, this.pitch);
      this.firstPerson = false;
      this.distance = clamp(d, FOLLOW_MIN, FOLLOW_MAX);
    }
    this.stageCool = STAGE_COOLDOWN;
    this.stageAtMs = performance.now();
  }
  private stageReady(): boolean { return this.stageCool <= 0 || performance.now() - this.stageAtMs > STAGE_COOLDOWN * 1500; }
  getViewDistance(): number { return this.firstPerson ? 0 : this.distance; }
  /** The camera is (or is settling) at the eyes: the renderer hides the head and the input aims along the look. */
  get inFirstPerson(): boolean { return this.mode === 'follow' && !this.ov && this.firstPerson && this.eyeValid; }
  /** The player's eyes this frame (world metres), and how much of the stride shows as head bob (0 on a horse). Null: no body to look out of. */
  setEye(x: number, y: number, z: number, bob = 1): void {
    if (!this.eyeValid) { this.eyeY = y; this.lastEyeX = x; this.lastEyeZ = z; }
    this.eye.set(x, y, z);
    this.eyeBob = bob;
    this.eyeValid = true;
  }
  clearEye(): void { this.eyeValid = false; this.lastEyeX = NaN; }

  pan(dx: number, dy: number, viewportHeight: number): void {
    if (this.ov) {
      // drag the land under the cursor: screen right / up in metres at the look-at point
      const o = this.ov;
      const mpp = (2 * o.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(1, viewportHeight);
      const s = Math.sin(o.yaw), c = Math.cos(o.yaw);
      // forward on the ground = (sin yaw, cos yaw), right = (-cos yaw, sin yaw); like the map, the look-at point moves by
      // (-right · dx + forward · dy) — the land follows a dragging cursor, W (dy > 0) goes forward, D (dx < 0) right
      const k = 1 / Math.max(0.35, Math.sin(o.pitch));
      o.lx += (dx * c + dy * s * k) * mpp;
      o.lz += (-dx * s + dy * c * k) * mpp;
      this.clampOverview();
      return;
    }
    if (this.mode === 'map') {
      const metresPerPixel = (2 * this.mapAlt * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(1, viewportHeight);
      const s = Math.sin(this.mapYaw), c = Math.cos(this.mapYaw);
      // screen right = (-c, s) in xz for camera yaw; screen up = forward
      this.mapCentre.x += (-dx * c - dy * s) * metresPerPixel * -1;
      this.mapCentre.y += (dx * s - dy * c) * metresPerPixel * -1;
      this.mapCentre.x = clamp(this.mapCentre.x, -2000, this.env.worldSize + 2000);
      this.mapCentre.y = clamp(this.mapCentre.y, -2000, this.env.worldSize + 2000);
    } else if (this.mode === 'free') {
      const right = this.tmp.set(-Math.cos(this.freeYaw), 0, Math.sin(this.freeYaw));
      const ground = this.env.heightAt(this.freePos.x, this.freePos.z);
      const k = Math.max(0.05, (this.freePos.y - ground) * 0.002);
      this.freePos.addScaledVector(right, -dx * k);
      this.freePos.y += dy * k;
    }
  }

  moveFree(forward: number, right: number, up: number, dt: number, fast = false): void {
    if (this.mode !== 'free') return;
    const ground = this.env.heightAt(this.freePos.x, this.freePos.z);
    const speed = clamp((this.freePos.y - ground) * 1.2, 10, 3000) * (fast ? 4 : 1);
    const fx = Math.sin(this.freeYaw), fz = Math.cos(this.freeYaw);
    this.freePos.x += (fx * forward - fz * right) * speed * dt;
    this.freePos.z += (fz * forward + fx * right) * speed * dt;
    this.freePos.y += up * speed * dt;
  }

  /**
   * Builder mode and the tactical view (GameRenderer.setOverview): an overhead camera at ~55° over a circle of land,
   * gliding in from wherever the camera is (~0.8 s). orbit / zoom / pan drive it; null glides back to the mode that was
   * active before (an explicit setMode or setPose also ends it).
   */
  setOverview(v: OverviewView | null, glide = OV_GLIDE): void {
    this.transFrom = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov };
    this.transT = 0;
    this.transDur = Math.max(0.01, glide);
    if (!v) {
      if (!this.ov) { this.transFrom = null; return; }
      this.ov = null;
      this.mode = this.ovPrev;
      return;
    }
    if (!this.ov) this.ovPrev = this.mode;
    const radius = Math.max(10, Number.isFinite(v.radius) ? v.radius : 200);
    const yaw = v.yaw ?? this.getYaw();
    const dist = clamp(v.distance ?? Math.min(2.2 * radius, Math.max(60, radius * 0.9)), 20, Math.max(20, 2.2 * radius));
    const keep = this.ov;
    this.ov = {
      cx: v.x, cz: v.z, radius, lx: v.x, lz: v.z, dist, yaw, pitch: keep?.pitch ?? OV_PITCH,
      sx: v.x, sz: v.z, sdist: dist, syaw: yaw, spitch: keep?.pitch ?? OV_PITCH,
    };
  }

  /** Is the overview camera on? */
  get overviewOn(): boolean { return this.ov !== null; }
  /** The camera mode reported to the outside: 'free' while the overview is on (it is not the follow camera). */
  get reportedMode(): CameraMode { return this.ov ? 'free' : this.mode; }
  /** The mode the overview returns to (the sim's view mode may change meanwhile). */
  setOverviewReturn(mode: CameraMode): void { this.ovPrev = mode; }

  private clampOverview(): void {
    const o = this.ov!;
    const dx = o.lx - o.cx, dz = o.lz - o.cz, d = Math.hypot(dx, dz);
    if (d > o.radius) { o.lx = o.cx + (dx / d) * o.radius; o.lz = o.cz + (dz / d) * o.radius; }
  }

  private computeOverview(out: Pose, dt: number): void {
    const o = this.ov!;
    const k = dt > 0 ? 1 - Math.exp(-dt * 10) : 1;
    o.sx += (o.lx - o.sx) * k; o.sz += (o.lz - o.sz) * k;
    o.sdist += (o.dist - o.sdist) * k;
    let dy = o.yaw - o.syaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    o.syaw += dy * k;
    o.spitch += (o.pitch - o.spitch) * k;
    const ws = this.env.worldSize;
    const ground = Math.max(0, this.env.heightAt(clamp(o.sx, 0, ws), clamp(o.sz, 0, ws)));
    const look = this.tmp2.set(o.sx, ground, o.sz);
    const cp = Math.cos(o.spitch), sp = Math.sin(o.spitch);
    const pos = this.tmp.set(look.x - Math.sin(o.syaw) * cp * o.sdist, ground + sp * o.sdist, look.z - Math.cos(o.syaw) * cp * o.sdist);
    // never inside a hill between the camera and the land
    const under = this.env.heightAt(clamp(pos.x, 0, ws), clamp(pos.z, 0, ws));
    if (pos.y < under + 6) pos.y = under + 6;
    this.lookPose(out, pos, look, 50);
  }

  setPose(position: { x: number; y: number; z: number }, lookAt: { x: number; y: number; z: number }, transition: number): void {
    this.ov = null;
    if (transition > 0 || this.mode !== 'free') {
      this.transFrom = { pos: this.camera.position.clone(), quat: this.camera.quaternion.clone(), fov: this.camera.fov };
      this.transT = 0;
      this.transDur = Math.max(0.001, transition);
      if (transition <= 0) this.transFrom = null;
    }
    this.mode = 'free';
    this.freePos.set(position.x, position.y, position.z);
    const dx = lookAt.x - position.x, dy = lookAt.y - position.y, dz = lookAt.z - position.z;
    this.freeYaw = Math.atan2(dx, dz);
    this.freePitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  /**
   * Aiming a bow or crossbow: the follow camera eases in over the right shoulder, so the
   * character stands left of the screen centre (the reticle) and the target is in clear view.
   */
  setAim(on: boolean, heldSeconds = 0): void { this.aimWant = on; this.aimHeld = on ? heldSeconds : 0; }
  private aimHeld = 0;

  /** Jump to the end of any running mode transition. */
  skipTransition(): void { this.transFrom = null; }

  focusMap(x: number, z: number, altitude?: number): void {
    this.mapCentre.set(x, z);
    if (altitude !== undefined) this.mapAlt = clamp(altitude, MAP_MIN, MAP_MAX);
  }

  /** Current yaw the camera faces (0 = +z). */
  getYaw(): number {
    if (this.ov) return this.ov.syaw;
    if (this.mode === 'free') return this.freeYaw;
    if (this.mode === 'map') return this.mapYaw;
    return this.yaw;
  }

  /** 0 at street level … 1 high above (strategic view). */
  mapBlend(): number {
    const ground = this.env.heightAt(clamp(this.camera.position.x, 0, this.env.worldSize), clamp(this.camera.position.z, 0, this.env.worldSize));
    return smoothstep(700, 2600, this.camera.position.y - Math.max(0, ground));
  }

  heightAboveGround(): number {
    const p = this.camera.position;
    return p.y - Math.max(0, this.env.heightAt(clamp(p.x, 0, this.env.worldSize), clamp(p.z, 0, this.env.worldSize)));
  }

  private lookPose(out: Pose, pos: THREE.Vector3, look: THREE.Vector3, fov: number): void {
    out.pos.copy(pos);
    this.m.lookAt(pos, look, this.up);
    out.quat.setFromRotationMatrix(this.m);
    out.fov = fov;
  }

  /**
   * How far the boom can reach from `head` along `dir` before terrain or a building gets in the
   * way (terrain bisected along the boom; buildings probed with a small bundle of parallel rays
   * so the near plane does not slice into a wall the centre ray just misses).
   */
  private boomReach(head: THREE.Vector3, dir: THREE.Vector3, want: number): number {
    const ws = this.env.worldSize;
    let allowed = want;
    const blocked = (d: number) => {
      const x = head.x + dir.x * d, y = head.y + dir.y * d, z = head.z + dir.z * d;
      return y < this.env.heightAt(clamp(x, 0, ws), clamp(z, 0, ws)) + 0.45;
    };
    let prev = 0;
    for (let i = 1; i <= 12; i++) {
      const d = (i / 12) * want;
      if (blocked(d)) {
        let a = prev, b = d;
        for (let k = 0; k < 6; k++) { const m = (a + b) / 2; if (blocked(m)) b = m; else a = m; }
        allowed = Math.max(FOLLOW_MIN * 0.5, a - 0.35);
        break;
      }
      prev = d;
    }
    if (this.env.raycastBuildings && want > 1.5) {
      // centre, left, right and above: the camera's near plane is ~0.3 m wide at its distance
      const side = this.side.set(-dir.z, 0, dir.x);
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0); else side.normalize();
      for (let k = 0; k < 4; k++) {
        const o = this.probe.copy(head);
        if (k === 1) o.addScaledVector(side, 0.35);
        else if (k === 2) o.addScaledVector(side, -0.35);
        else if (k === 3) o.y += 0.3;
        this.ray.origin.copy(o);
        this.ray.direction.copy(dir);
        const hit = this.env.raycastBuildings(this.ray, want, EAVE_PAD);
        if (hit !== null) allowed = Math.min(allowed, Math.max(1.2, hit - 0.45));
      }
    }
    return allowed;
  }

  private boomDir(pitch: number, out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    return out.set(-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp);
  }

  /** First person: the eyes (with a gentle bob that follows the stride) looking along yaw and pitch. */
  private computeEyes(out: Pose, dt: number): void {
    const e = this.eye;
    // the speed the eyes are moving at drives the bob; the height settles instead of copying every step of the animation
    if (dt > 0 && Number.isFinite(this.lastEyeX)) {
      const sp = Math.hypot(e.x - this.lastEyeX, e.z - this.lastEyeZ) / dt;
      this.bobSpeed += (Math.min(sp, 9) - this.bobSpeed) * (1 - Math.exp(-dt * 8));
    } else if (dt > 0) this.bobSpeed = 0;
    this.lastEyeX = e.x; this.lastEyeZ = e.z;
    this.eyeY += (e.y - this.eyeY) * (dt > 0 ? 1 - Math.exp(-dt * 7) : 1);
    if (Math.abs(this.eyeY - e.y) > 1.5) this.eyeY = e.y;
    let bx = 0, by = 0;
    if (this.bobbing && this.eyeBob > 0 && dt > 0) {
      this.bobPhase += this.bobSpeed * dt * 7.2;
      const k = Math.min(1, this.bobSpeed / 2.2) * this.eyeBob;
      by = Math.sin(this.bobPhase * 2) * 0.028 * k;
      bx = Math.cos(this.bobPhase) * 0.018 * k;
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const pos = this.probe.set(e.x + cy * bx, this.eyeY + by, e.z - sy * bx);
    const cp = Math.cos(this.pitch);
    const look = this.probe2.set(pos.x + sy * cp, pos.y - Math.sin(this.pitch), pos.z + cy * cp);
    this.lookPose(out, pos, look, FP_FOV);
  }

  private computeFollow(out: Pose, focus: THREE.Vector3, dt: number): void {
    if (!this.targetValid) { this.target.copy(focus); this.targetValid = true; }
    const k = 1 - Math.exp(-dt * 14);
    this.target.lerp(focus, k);
    if (this.target.distanceTo(focus) > 40) this.target.copy(focus);
    this.stageCool = Math.max(0, this.stageCool - dt);
    // first person ⇄ over the shoulder: the camera glides between the eyes and the boom
    const fpWant = this.firstPerson && this.eyeValid ? 1 : 0;
    this.fpK += (fpWant - this.fpK) * (dt > 0 ? 1 - Math.exp(-dt * 9) : 1);
    if (Math.abs(this.fpK - fpWant) < 0.002) this.fpK = fpWant;
    if (this.fpK > 0) this.computeEyes(this.fpPose, dt);
    if (this.fpK >= 1) { out.pos.copy(this.fpPose.pos); out.quat.copy(this.fpPose.quat); out.fov = this.fpPose.fov; return; }
    const head = this.tmp2.copy(this.target);
    head.y += 1.55;
    // over-the-shoulder aim: shift the boom origin (and the look point with it) to the right
    const aimT = this.aimWant ? 1 : 0;
    this.aimK += (aimT - this.aimK) * (dt > 0 ? 1 - Math.exp(-dt * 7) : 1);
    // keyed to how long the aim has been held (simulation time), so it is in place even when
    // frames are few (screenshots, slow machines)
    if (this.aimWant) this.aimK = Math.max(this.aimK, Math.min(1, this.aimHeld * 3.5));
    // close in the camera rides over the right shoulder, so the character is not a wall in front of the view
    const shoulder = Math.max(this.aimK * AIM_SHOULDER, AIM_SHOULDER * 0.7 * smoothstep(9, 3.6, this.distance));
    head.x += -Math.cos(this.yaw) * shoulder;
    head.z += Math.sin(this.yaw) * shoulder;
    head.y += 0.1 * this.aimK;
    const want = this.distance + (Math.min(this.distance, AIM_DISTANCE) - this.distance) * this.aimK;
    const dir = this.boomDir(this.pitch, this.tmp);
    // Buildings never shove the camera round: it only gets closer when something really is in the way, eases there, and
    // lets go again slowly once the way has stayed clear (no jitter walking along a wall or through a door).
    const raw = this.boomReach(head, dir, want);
    if (dt === 0 || this.reachSm > 90) { this.reachSm = raw; this.clearT = 0; }
    else if (raw < this.reachSm) { this.clearT = 0; this.reachSm += (raw - this.reachSm) * (1 - Math.exp(-dt * 16)); }
    else { this.clearT += dt; if (this.clearT > 0.45) this.reachSm += (raw - this.reachSm) * (1 - Math.exp(-dt * 1.6)); }
    const allowed = Math.min(this.reachSm, want);
    this.curDistance = allowed;
    const fl = Math.hypot(dir.x, dir.z) || 1;
    const fwdX = -dir.x / fl, fwdZ = -dir.z / fl;
    const pos = this.tmp.set(head.x + dir.x * allowed, head.y + dir.y * allowed, head.z + dir.z * allowed);
    const ground = this.env.heightAt(clamp(pos.x, 0, this.env.worldSize), clamp(pos.z, 0, this.env.worldSize));
    if (pos.y < ground + 0.45) pos.y = ground + 0.45;
    // pulled in close by a wall: look over the character's head down the way ahead instead of
    // filling the screen with the back of it
    const close = want > 4 ? smoothstep(4.5, 1.6, allowed) : 0;
    pos.y += close * 0.15;
    const look = this.tmp2.set(head.x + fwdX * close * 1.1, head.y + Math.max(0, (0.2 - this.pitch)) * 0.8, head.z + fwdZ * close * 1.1);
    this.lookPose(out, pos, look, 55);
    if (this.fpK > 0) {
      const e = this.fpK * this.fpK * (3 - 2 * this.fpK);
      out.pos.lerp(this.fpPose.pos, e);
      out.quat.slerp(this.fpPose.quat, e);
      out.fov = lerp(out.fov, FP_FOV, e);
    }
  }

  private computeMap(out: Pose): void {
    const ground = Math.max(0, this.env.heightAt(clamp(this.mapCentre.x, 0, this.env.worldSize), clamp(this.mapCentre.y, 0, this.env.worldSize)));
    const look = this.tmp2.set(this.mapCentre.x, ground, this.mapCentre.y);
    const back = this.mapAlt / Math.tan(this.mapPitch);
    const pos = this.tmp.set(look.x - Math.sin(this.mapYaw) * back, ground + this.mapAlt, look.z - Math.cos(this.mapYaw) * back);
    this.lookPose(out, pos, look, 42);
  }

  private computeFree(out: Pose): void {
    const g = this.env.heightAt(clamp(this.freePos.x, 0, this.env.worldSize), clamp(this.freePos.z, 0, this.env.worldSize));
    if (this.freePos.y < Math.max(g, 0) + 0.6) this.freePos.y = Math.max(g, 0) + 0.6;
    const cp = Math.cos(this.freePitch);
    const look = this.tmp2.set(
      this.freePos.x + Math.sin(this.freeYaw) * cp, this.freePos.y + Math.sin(this.freePitch), this.freePos.z + Math.cos(this.freeYaw) * cp);
    this.lookPose(out, this.freePos, look, 55);
  }

  private computeCinematic(out: Pose, focus: THREE.Vector3, dt: number): void {
    this.cineAngle += dt * 0.07;
    const r = Math.max(30, this.distance * 3);
    const pos = this.tmp.set(focus.x + Math.sin(this.cineAngle) * r, 0, focus.z + Math.cos(this.cineAngle) * r);
    const g = this.env.heightAt(clamp(pos.x, 0, this.env.worldSize), clamp(pos.z, 0, this.env.worldSize));
    pos.y = Math.max(g, focus.y) + r * 0.35 + Math.sin(this.cineAngle * 2.3) * 3;
    const look = this.tmp2.set(focus.x, focus.y + 3, focus.z);
    this.lookPose(out, pos, look, 50);
  }

  update(dt: number, focus: THREE.Vector3 | null): void {
    const f = this.focusTmp.copy(focus ?? this.target);
    const live = this.live;
    if (this.ov) this.computeOverview(live, dt);
    else switch (this.mode) {
      case 'follow': this.computeFollow(live, f, dt); break;
      case 'map': this.computeMap(live); break;
      case 'free': this.computeFree(live); break;
      case 'cinematic': this.computeCinematic(live, f, dt); break;
    }
    if ((this.mode !== 'follow' || this.ov) && focus) {
      // keep the follow target warm so returning to follow is smooth
      this.target.copy(focus);
      this.targetValid = true;
    }
    const cam = this.camera;
    if (this.transFrom) {
      this.transT += dt;
      const t = clamp(this.transT / this.transDur, 0, 1);
      const e = t * t * (3 - 2 * t);
      const from = this.transFrom;
      const g0 = Math.max(0, this.env.heightAt(clamp(from.pos.x, 0, this.env.worldSize), clamp(from.pos.z, 0, this.env.worldSize)));
      const g1 = Math.max(0, this.env.heightAt(clamp(live.pos.x, 0, this.env.worldSize), clamp(live.pos.z, 0, this.env.worldSize)));
      const h0 = Math.max(1, from.pos.y - g0), h1 = Math.max(1, live.pos.y - g1);
      const h = Math.exp(lerp(Math.log(h0), Math.log(h1), e));
      cam.position.set(lerp(from.pos.x, live.pos.x, e), lerp(g0, g1, e) + h, lerp(from.pos.z, live.pos.z, e));
      cam.quaternion.slerpQuaternions(from.quat, live.quat, e);
      cam.fov = lerp(from.fov, live.fov, e);
      if (t >= 1) this.transFrom = null;
    } else {
      cam.position.copy(live.pos);
      cam.quaternion.copy(live.quat);
      cam.fov = live.fov;
    }
    // clip planes scale with altitude for depth precision
    const above = Math.max(0.5, this.heightAboveGround());
    cam.near = this.mode === 'follow' && this.fpK > 0.5 ? FP_NEAR : clamp(above * 0.012, 0.15, 60);
    cam.far = Math.max(42000, cam.position.y * 6 + 30000);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
