// The app host's camera pose (docs/CIV.md §2): where the camera is and what it looks at, for the glide from one body to another.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AppHost } from '../../src/app/host';
import { newProfile } from '../../src/sim/legacy';
import { MemorySaveStore } from '../../src/sim/save-memory';

function host(camera: THREE.PerspectiveCamera | null, ground = 10): AppHost {
  const h = new AppHost({ store: new MemorySaveStore(), profile: newProfile(), params: new URLSearchParams(), viewport: {} as HTMLElement });
  if (camera) h.session = { renderer: { getCamera: () => camera }, sim: { world: { heightAt: () => ground } } } as never;
  return h;
}

function cameraAt(x: number, y: number, z: number, lookX: number, lookY: number, lookZ: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(55, 16 / 9, 0.2, 5000);
  c.position.set(x, y, z);
  c.lookAt(lookX, lookY, lookZ);
  return c;
}

describe('AppHost.cameraPose', () => {
  it('has no pose without a session', () => {
    expect(host(null).cameraPose()).toBeNull();
  });

  it('reads the camera position and looks at the focus it is given', () => {
    const h = host(cameraAt(100, 14, 90, 100, 11.5, 100));
    const pose = h.cameraPose({ x: 100, y: 11.55, z: 100 })!;
    expect(pose.position.x).toBeCloseTo(100, 4);
    expect(pose.position.y).toBeCloseTo(14, 4);
    expect(pose.position.z).toBeCloseTo(90, 4);
    expect(pose.lookAt).toEqual({ x: 100, y: 11.55, z: 100 });
  });

  it('without a focus looks where the view ray meets the ground, or a short way ahead when it looks level', () => {
    // 10 m above ground 10, looking 45° down along +z: it meets the ground 10 m along
    const down = host(cameraAt(0, 20, 0, 0, 10, 10)).cameraPose()!;
    expect(down.lookAt.z).toBeCloseTo(10, 3);
    expect(down.lookAt.y).toBeCloseTo(10, 3);
    const level = host(cameraAt(0, 20, 0, 0, 20, 50)).cameraPose()!;
    expect(Math.hypot(level.lookAt.x - level.position.x, level.lookAt.y - level.position.y, level.lookAt.z - level.position.z)).toBeCloseTo(8, 3);
  });
});
