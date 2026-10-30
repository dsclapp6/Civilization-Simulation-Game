import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig } from '../../src/render/camera/cameraRig';

// gentle hills, a 30 m tall "wall" of terrain at x > 1000
const heightAt = (x: number, z: number) => (x > 1000 ? 30 : 5 + Math.sin(z / 50));
const env = { heightAt, worldSize: 16000 };

describe('camera rig', () => {
  it('follows the focus from behind and above, never below the ground', () => {
    const rig = new CameraRig(16 / 9, env);
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
    rig.yaw = -Math.PI / 2; // camera on the +x side, inside the raised ground
    rig.pitch = 0.05;
    rig.distance = 30;
    const focus = new THREE.Vector3(990, heightAt(990, 0), 0);
    for (let i = 0; i < 30; i++) rig.update(1 / 30, focus);
    expect(rig.camera.position.distanceTo(focus)).toBeLessThan(20);
    expect(rig.camera.position.y).toBeGreaterThan(heightAt(rig.camera.position.x, rig.camera.position.z));
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
