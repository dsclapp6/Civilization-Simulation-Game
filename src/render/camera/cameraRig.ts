// Camera modes: third-person follow (orbit, zoom, terrain + building collision), free fly (dev),
// strategic map (pan/zoom, north-up, tilted) and cinematic orbit. Mode switches blend smoothly:
// positions interpolate with altitude in log space (a natural rise from street to map), rotations
// slerp.
import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../../core/math';
import type { CameraMode } from '../types';

export interface CameraEnv {
  heightAt(x: number, z: number): number;
  /** Distance along the ray to the first building box, or null. */
  raycastBuildings?(ray: THREE.Ray, maxDist: number): number | null;
  worldSize: number;
}

interface Pose { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number }

const FOLLOW_MIN = 2.2;
const FOLLOW_MAX = 140;
const MAP_MIN = 450;
const MAP_MAX = 30000;

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

  constructor(aspect: number, private readonly env: CameraEnv) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.2, 60000);
    this.camera.position.set(8000, 300, 8000);
    this.mapCentre.set(env.worldSize / 2, env.worldSize / 2);
  }

  setMode(mode: CameraMode, transition = 1.4): void {
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
        this.pitch = clamp(this.pitch + dPitch, -0.35, 1.45);
    }
  }

  zoom(steps: number): void {
    const f = Math.pow(1.15, steps);
    if (this.mode === 'map') {
      const next = this.mapAlt * f;
      if (next < MAP_MIN && this.autoMapZoom && steps < 0) { this.setMode('follow'); this.distance = 40; return; }
      this.mapAlt = clamp(next, MAP_MIN, MAP_MAX);
    } else if (this.mode === 'follow' || this.mode === 'cinematic') {
      const next = this.distance * f;
      if (next > FOLLOW_MAX && this.autoMapZoom && steps > 0 && this.mode === 'follow') { this.mapAlt = 2600; this.setMode('map'); return; }
      this.distance = clamp(next, FOLLOW_MIN, FOLLOW_MAX);
    } else {
      // free: zoom moves forward
      const d = this.camera.getWorldDirection(this.tmp);
      const ground = this.env.heightAt(this.freePos.x, this.freePos.z);
      this.freePos.addScaledVector(d, -steps * Math.max(4, (this.freePos.y - ground) * 0.15));
    }
  }

  pan(dx: number, dy: number, viewportHeight: number): void {
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

  setPose(position: { x: number; y: number; z: number }, lookAt: { x: number; y: number; z: number }, transition: number): void {
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

  /** Jump to the end of any running mode transition. */
  skipTransition(): void { this.transFrom = null; }

  focusMap(x: number, z: number, altitude?: number): void {
    this.mapCentre.set(x, z);
    if (altitude !== undefined) this.mapAlt = clamp(altitude, MAP_MIN, MAP_MAX);
  }

  /** Current yaw the camera faces (0 = +z). */
  getYaw(): number {
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

  private computeFollow(out: Pose, focus: THREE.Vector3, dt: number): void {
    if (!this.targetValid) { this.target.copy(focus); this.targetValid = true; }
    const k = 1 - Math.exp(-dt * 14);
    this.target.lerp(focus, k);
    if (this.target.distanceTo(focus) > 40) this.target.copy(focus);
    const head = this.tmp2.copy(this.target);
    head.y += 1.55;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const dir = this.tmp.set(-Math.sin(this.yaw) * cp, sp, -Math.cos(this.yaw) * cp);
    // collision: terrain along the boom (bisected to the first obstruction) and buildings
    let allowed = this.distance;
    const blocked = (d: number) => {
      const x = head.x + dir.x * d, y = head.y + dir.y * d, z = head.z + dir.z * d;
      return y < this.env.heightAt(clamp(x, 0, this.env.worldSize), clamp(z, 0, this.env.worldSize)) + 0.45;
    };
    let prev = 0;
    for (let i = 1; i <= 12; i++) {
      const d = (i / 12) * this.distance;
      if (blocked(d)) {
        let a = prev, b = d;
        for (let k = 0; k < 6; k++) { const m = (a + b) / 2; if (blocked(m)) b = m; else a = m; }
        allowed = Math.max(FOLLOW_MIN * 0.5, a - 0.35);
        break;
      }
      prev = d;
    }
    if (this.env.raycastBuildings && this.distance > 1.5) {
      this.ray.origin.copy(head);
      this.ray.direction.copy(dir);
      const hit = this.env.raycastBuildings(this.ray, this.distance);
      if (hit !== null) allowed = Math.min(allowed, Math.max(1.2, hit - 0.4));
    }
    if (allowed < this.curDistance) this.curDistance = allowed;
    else this.curDistance += (allowed - this.curDistance) * (1 - Math.exp(-dt * 3));
    const pos = this.tmp.set(head.x + dir.x * this.curDistance, head.y + dir.y * this.curDistance, head.z + dir.z * this.curDistance);
    const ground = this.env.heightAt(clamp(pos.x, 0, this.env.worldSize), clamp(pos.z, 0, this.env.worldSize));
    if (pos.y < ground + 0.45) pos.y = ground + 0.45;
    const look = this.tmp2.set(head.x, head.y + Math.max(0, (0.2 - this.pitch)) * 0.8, head.z);
    this.lookPose(out, pos, look, 55);
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
    switch (this.mode) {
      case 'follow': this.computeFollow(live, f, dt); break;
      case 'map': this.computeMap(live); break;
      case 'free': this.computeFree(live); break;
      case 'cinematic': this.computeCinematic(live, f, dt); break;
    }
    if (this.mode !== 'follow' && focus) {
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
    cam.near = clamp(above * 0.012, 0.15, 60);
    cam.far = Math.max(42000, cam.position.y * 6 + 30000);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
