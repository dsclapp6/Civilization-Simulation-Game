import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from '../../src/render/camera/cameraRig';

// gentle hills, a 30 m tall "wall" of terrain at x > 1000
const heightAt = (x: number, z: number) => (x > 1000 ? 30 : 5 + Math.sin(z / 50));
const env = { heightAt, worldSize: 16000 };

describe('camera rig', () => {
  it('follows the focus from behind and above, never below the ground', () => {
    const rig = new CameraRig(16 / 9, env);
    rig.setViewDistance(9);
    const focus = new THREE.Vector3(500, heightAt(500, 500), 500);
    for (let i = 0; i < 60; i++) rig.update(1 / 60, focus);
    const cam = rig.camera;
    const d = cam.position.distanceTo(focus);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(15);
    expect(cam.position.y).toBeGreaterThan(heightAt(cam.position.x, cam.position.z));
    // looking roughly at the character
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const toFocus = focus.clone().add(new THREE.Vector3(0, 1.5, 0)).sub(cam.position).normalize();
    expect(dir.dot(toFocus)).toBeGreaterThan(0.95);
  });

  it('pulls the boom in when terrain blocks it', () => {
    const rig = new CameraRig(16 / 9, env);
    rig.setViewDistance(9);
    rig.yaw = -Math.PI / 2; // camera on the +x side, inside the raised ground
    rig.pitch = 0.05;
    rig.distance = 30;
    const focus = new THREE.Vector3(990, heightAt(990, 0), 0);
    for (let i = 0; i < 30; i++) rig.update(1 / 30, focus);
    expect(rig.camera.position.distanceTo(focus)).toBeLessThan(20);
    expect(rig.camera.position.y).toBeGreaterThan(heightAt(rig.camera.position.x, rig.camera.position.z));
  });

  const boxEnv = (box: THREE.Box3) => {
    const hit = new THREE.Vector3();
    return { heightAt: () => 0, worldSize: 16000, raycastBuildings: (ray: THREE.Ray, max: number) => {
      const p = ray.intersectBox(box, hit);
      const d = p ? p.distanceTo(ray.origin) : null;
      return d !== null && d <= max ? d : null;
    } };
  };

  it('a building behind the character eases the boom in and never swings or lifts the camera', () => {
    // a tall wall 3 m behind the character (the camera side is -z for yaw 0)
    const box = new THREE.Box3(new THREE.Vector3(480, 0, 486), new THREE.Vector3(520, 14, 496));
    const rig = new CameraRig(16 / 9, boxEnv(box));
    rig.setViewDistance(9);
    rig.yaw = 0; rig.pitch = 0.3;
    const open = new THREE.Vector3(500, 0, 520);
    for (let i = 0; i < 60; i++) rig.update(1 / 30, open);
    const before = rig.camera.position.distanceTo(new THREE.Vector3(500, 1.55, 520));
    expect(before).toBeGreaterThan(7);
    // walk towards the wall: the camera stays on the boom line (same yaw, same pitch) and only comes closer, a little at a time
    let prev = before;
    let maxStep = 0;
    for (let i = 0; i < 90; i++) {
      const f = new THREE.Vector3(500, 0, 520 - i * 0.2);
      rig.update(1 / 30, f);
      const d = rig.camera.position.distanceTo(new THREE.Vector3(500, 1.55, f.z));
      maxStep = Math.max(maxStep, Math.abs(d - prev));
      prev = d;
      expect(Math.abs(rig.camera.position.x - 500)).toBeLessThan(0.9); // never swings round (only the shoulder offset)
      expect(box.containsPoint(rig.camera.position)).toBe(false);
    }
    expect(rig.getYaw()).toBe(0);
    expect(prev).toBeLessThan(before - 2);
    expect(maxStep).toBeLessThan(0.5);
    // out in the open it lets go slowly, not at once
    const free = new THREE.Vector3(800, 0, 800);
    rig.update(1 / 30, free);
    rig.update(1 / 30, free);
    const d0 = rig.camera.position.distanceTo(new THREE.Vector3(800, 1.55, 800));
    for (let i = 0; i < 300; i++) rig.update(1 / 30, free);
    expect(rig.camera.position.distanceTo(new THREE.Vector3(800, 1.55, 800))).toBeGreaterThan(d0 + 1);
  });

  it('does not jitter walking along a wall: a gap in it does not make the camera jump', () => {
    // a long wall 2.5 m to the side of the path with a doorway-wide gap
    const wallA = new THREE.Box3(new THREE.Vector3(502, 0, 400), new THREE.Vector3(504, 6, 498));
    const wallB = new THREE.Box3(new THREE.Vector3(502, 0, 500), new THREE.Vector3(504, 6, 600));
    const hit = new THREE.Vector3();
    const env2 = { heightAt: () => 0, worldSize: 16000, raycastBuildings: (ray: THREE.Ray, max: number) => {
      let best: number | null = null;
      for (const box of [wallA, wallB]) {
        const p = ray.intersectBox(box, hit);
        const d = p ? p.distanceTo(ray.origin) : null;
        if (d !== null && d <= max && (best === null || d < best)) best = d;
      }
      return best;
    } };
    const rig = new CameraRig(16 / 9, env2);
    rig.setViewDistance(6);
    rig.yaw = -Math.PI / 2 + 0.5; rig.pitch = 0.25; // the camera sits to the wall side, behind
    let prev: THREE.Vector3 | null = null;
    let worst = 0;
    for (let i = 0; i < 360; i++) {
      const f = new THREE.Vector3(500, 0, 420 + i * 0.25);
      rig.update(1 / 60, f);
      if (prev) worst = Math.max(worst, rig.camera.position.distanceTo(prev));
      prev = rig.camera.position.clone();
    }
    // the character moves 0.25 per frame; the camera never moves much more than that in a frame
    expect(worst).toBeLessThan(0.6);
  });

  it('is at the eyes in first person, looks where yaw and pitch say, and the wheel steps out to the shoulder and back', () => {
    const flat = { heightAt: () => 0, worldSize: 16000 };
    const rig = new CameraRig(16 / 9, flat);
    const focus = new THREE.Vector3(500, 0, 500);
    rig.setEye(500, 1.6, 500, 0);
    rig.setViewDistance(0);
    rig.yaw = 0; rig.pitch = 0;
    for (let i = 0; i < 30; i++) rig.update(1 / 30, focus);
    expect(rig.inFirstPerson).toBe(true);
    expect(rig.camera.position.x).toBeCloseTo(500, 3);
    expect(rig.camera.position.y).toBeCloseTo(1.6, 3);
    expect(rig.camera.position.z).toBeCloseTo(500, 3);
    const dir = rig.camera.getWorldDirection(new THREE.Vector3());
    expect(dir.z).toBeGreaterThan(0.99);
    // the mouse turns it: to the right, and up (negative pitch looks up)
    rig.orbit(-0.5, -0.4);
    rig.update(1 / 30, focus);
    const d2 = rig.camera.getWorldDirection(new THREE.Vector3());
    expect(d2.x).toBeLessThan(-0.3); // turning right (the body's right is -x when facing +z)
    expect(d2.y).toBeGreaterThan(0.2);
    expect(rig.getYaw()).toBeCloseTo(-0.5, 6);
    // the look is wide: all the way down and all the way up
    rig.orbit(0, 9);
    expect(rig.pitch).toBeGreaterThan(1.4);
    rig.orbit(0, -9);
    expect(rig.pitch).toBeLessThan(-1.4);
    // the wheel out: over the shoulder, once per flick
    for (let i = 0; i < 30; i++) rig.update(1 / 30, focus);
    rig.zoom(1);
    expect(rig.getViewDistance()).toBeGreaterThan(2.5);
    expect(rig.getViewDistance()).toBeLessThan(5);
    rig.zoom(-12); // straight back in during the cooldown: no sliding through the stages
    expect(rig.getViewDistance()).toBeGreaterThan(2.3);
    for (let i = 0; i < 30; i++) rig.update(1 / 30, focus);
    expect(rig.inFirstPerson).toBe(false);
    expect(rig.camera.position.distanceTo(new THREE.Vector3(500, 1.6, 500))).toBeGreaterThan(2.5);
    // the wheel in: back to the eyes
    rig.zoom(-3);
    expect(rig.getViewDistance()).toBe(0);
    for (let i = 0; i < 40; i++) rig.update(1 / 30, focus);
    expect(rig.camera.position.distanceTo(new THREE.Vector3(500, 1.6, 500))).toBeLessThan(0.05);
  });

  it('bobs gently with the stride, and not at all when told not to', () => {
    const flat = { heightAt: () => 0, worldSize: 16000 };
    const run = (bob: boolean): number => {
      const rig = new CameraRig(16 / 9, flat);
      rig.bobbing = bob;
      rig.setViewDistance(0);
      let lo = 9, hi = -9;
      for (let i = 0; i < 180; i++) {
        const z = 500 + i * (1.6 / 60);
        rig.setEye(500, 1.6, z, 1);
        rig.update(1 / 60, new THREE.Vector3(500, 0, z));
        if (i > 90) { lo = Math.min(lo, rig.camera.position.y); hi = Math.max(hi, rig.camera.position.y); }
      }
      return hi - lo;
    };
    expect(run(true)).toBeGreaterThan(0.02);
    expect(run(true)).toBeLessThan(0.1);
    expect(run(false)).toBeLessThan(1e-6);
  });

  it('moves over the right shoulder while aiming, so the screen centre is clear of the head', () => {
    const flat = { heightAt: () => 0, worldSize: 16000 };
    const rig = new CameraRig(16 / 9, flat);
    rig.setViewDistance(9);
    rig.yaw = 0; rig.pitch = 0.2; rig.distance = 9;
    const focus = new THREE.Vector3(500, 0, 500);
    for (let i = 0; i < 60; i++) rig.update(1 / 30, focus);
    const head = new THREE.Vector3(500, 1.55, 500);
    const rayHits = () => {
      const dir = rig.camera.getWorldDirection(new THREE.Vector3());
      const ray = new THREE.Ray(rig.camera.position.clone(), dir);
      return ray.distanceToPoint(head);
    };
    expect(rayHits()).toBeLessThan(0.35);
    rig.setAim(true);
    for (let i = 0; i < 60; i++) rig.update(1 / 30, focus);
    // closer, beside the head: the view ray passes clear of it
    expect(rig.camera.position.distanceTo(head)).toBeLessThan(4.5);
    expect(rayHits()).toBeGreaterThan(0.45);
    rig.setAim(false);
    for (let i = 0; i < 90; i++) rig.update(1 / 30, focus);
    expect(rayHits()).toBeLessThan(0.35);
  });

  it('rises smoothly to the map and back, with altitude interpolated in log space', () => {
    const rig = new CameraRig(16 / 9, env);
    const focus = new THREE.Vector3(4000, 5, 4000);
    for (let i = 0; i < 30; i++) rig.update(1 / 30, focus);
    rig.focusMap(4000, 4000, 12000);
    rig.setMode('map', 1.0);
    const heights: number[] = [];
    for (let i = 0; i < 40; i++) { rig.update(1 / 30, focus); heights.push(rig.camera.position.y); }
    for (let i = 1; i < heights.length; i++) expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1] - 1e-6);
    // halfway through the transition the camera is far below the linear midpoint (log-space rise)
    expect(heights[15]).toBeLessThan(6000);
    expect(rig.mapBlend()).toBeGreaterThan(0.9);
    rig.setMode('follow', 0.5);
    for (let i = 0; i < 30; i++) rig.update(1 / 30, focus);
    expect(rig.camera.position.y).toBeLessThan(100);
    expect(rig.mapBlend()).toBe(0);
  });

  it('orbits in cinematic mode and flies in free mode', () => {
    const rig = new CameraRig(16 / 9, env);
    const focus = new THREE.Vector3(2000, 5, 2000);
    rig.setMode('cinematic', 0);
    rig.update(0.1, focus);
    const a = rig.camera.position.clone();
    for (let i = 0; i < 100; i++) rig.update(0.1, focus);
    expect(rig.camera.position.distanceTo(a)).toBeGreaterThan(5);
    expect(rig.camera.position.distanceTo(focus)).toBeGreaterThan(20);
    rig.setPose({ x: 100, y: 50, z: 100 }, { x: 200, y: 40, z: 100 }, 0);
    expect(rig.mode).toBe('free');
    rig.update(0.016, focus);
    rig.moveFree(1, 0, 0, 1);
    rig.update(0.016, focus);
    expect(rig.camera.position.x).toBeGreaterThan(110);
    expect(Math.abs(rig.getYaw() - Math.PI / 2)).toBeLessThan(1e-6);
  });
});
