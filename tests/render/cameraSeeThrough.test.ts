// Third person: walls and roofs between the camera and the player fade (dither) instead of hiding the player; first person: the
// head is out of the camera's view but in the shadow pass. (The shaders themselves are checked in the real game; here the wiring.)
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CameraRig } from '../../src/render/camera/cameraRig';
import { SEE_THROUGH, GLSL_SEE } from '../../src/assets/core/seeThrough';
import { createOpaqueMaterial, createSharedUniforms } from '../../src/assets/core/materials';
import { SkinnedCrowd } from '../../src/assets/characters/engine/crowd';

const flat = { heightAt: () => 0, worldSize: 16000 };

describe('see-through walls', () => {
  it('is on in third person, with the eye at the camera and the focus at the player', () => {
    const rig = new CameraRig(16 / 9, flat);
    rig.setViewDistance(8);
    const p = new THREE.Vector3(500, 0, 500);
    for (let i = 0; i < 60; i++) rig.update(1 / 30, p);
    expect(SEE_THROUGH.on.value).toBe(1);
    expect(SEE_THROUGH.eye.value.distanceTo(rig.camera.position)).toBeLessThan(1e-6);
    expect(SEE_THROUGH.focus.value.x).toBeCloseTo(500, 6);
    expect(SEE_THROUGH.focus.value.y).toBeGreaterThan(0.8);
    expect(SEE_THROUGH.focus.value.y).toBeLessThan(1.6);
  });

  it('is off in first person, on the map and far out', () => {
    const rig = new CameraRig(16 / 9, flat);
    const p = new THREE.Vector3(500, 0, 500);
    rig.setEye(500, 1.6, 500);
    rig.setViewDistance(0);
    for (let i = 0; i < 60; i++) rig.update(1 / 30, p);
    expect(SEE_THROUGH.on.value).toBe(0);
    rig.setViewDistance(60);
    for (let i = 0; i < 60; i++) rig.update(1 / 30, p);
    expect(SEE_THROUGH.on.value).toBe(0);
    rig.setViewDistance(8);
    rig.setMode('map', 0.01);
    for (let i = 0; i < 5; i++) rig.update(1 / 30, p);
    expect(SEE_THROUGH.on.value).toBe(0);
  });

  it('the building shader carries it: the uniforms and the dither discard, skipped inside a cut building', () => {
    const m = createOpaqueMaterial(createSharedUniforms(), false);
    const shader = {
      uniforms: {} as Record<string, THREE.IUniform>,
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>',
    };
    m.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as never);
    expect(shader.uniforms.uSeeOn).toBe(SEE_THROUGH.on);
    expect(shader.uniforms.uSeeEye).toBe(SEE_THROUGH.eye);
    expect(shader.fragmentShader).toContain('uniform float uSeeOn;');
    expect(shader.fragmentShader).toContain(GLSL_SEE);
    expect(GLSL_SEE).toContain('uCutOn < 1.5');
    expect(GLSL_SEE).toContain('discard');
  });
});

describe('the boom and walls', () => {
  const wall = new THREE.Box3(new THREE.Vector3(480, 0, 486), new THREE.Vector3(520, 14, 489));
  const env = (inside: boolean) => {
    const hit = new THREE.Vector3();
    return { heightAt: () => 0, worldSize: 16000, insideBuilding: () => inside, raycastBuildings: (ray: THREE.Ray, max: number) => {
      const p = ray.intersectBox(wall, hit);
      const d = p ? p.distanceTo(ray.origin) : null;
      return d !== null && d <= max ? d : null;
    } };
  };
  const settle = (inside: boolean): number => {
    const rig = new CameraRig(16 / 9, env(inside));
    rig.setViewDistance(9);
    rig.yaw = 0; rig.pitch = 0.2;
    const p = new THREE.Vector3(500, 0, 492); // the wall stands 3 m behind the player, on the camera's side
    for (let i = 0; i < 120; i++) rig.update(1 / 30, p);
    return rig.camera.position.distanceTo(new THREE.Vector3(500, 1.55, 492));
  };

  it('outside, the boom goes on past the wall (which fades) instead of crowding the player', () => {
    expect(settle(false)).toBeGreaterThan(5); // (3 m to the wall + WALL_PASS)
  });

  it('inside a building the walls stop it as before', () => {
    expect(settle(true)).toBeLessThan(4);
  });
});

describe('the head in first person', () => {
  it('is left out of the camera pass only: the shadow (depth) materials do not discard it', () => {
    const crowd = new SkinnedCrowd({ name: 't' });
    const fs = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>\n#include <color_vertex>', fragmentShader: '#include <common>\n#include <clipping_planes_fragment>\n#include <opaque_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n#include <emissivemap_fragment>' };
    crowd.material.onBeforeCompile(fs as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as never);
    expect(fs.fragmentShader).toContain('if ( vCrowdHide > 0.5 ) discard;');
    const dm = (crowd.mesh.customDepthMaterial as THREE.MeshDepthMaterial);
    const ds = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: '#include <common>\n#include <begin_vertex>\n#include <color_vertex>', fragmentShader: '#include <common>' };
    dm.onBeforeCompile(ds as unknown as THREE.WebGLProgramParametersWithUniforms, undefined as never);
    expect(ds.fragmentShader).not.toContain('vCrowdHide');
    // the hide uniform: a slot and the bones of the head
    crowd.setHidden(3, 4, 20, 21);
    expect((fs.uniforms.crowdHide.value as THREE.Vector4).toArray()).toEqual([3, 1 << 4, (1 << 4) | (1 << 5), 0]);
    crowd.setHidden(-1);
    expect((fs.uniforms.crowdHide.value as THREE.Vector4).x).toBe(-1);
  });
});
