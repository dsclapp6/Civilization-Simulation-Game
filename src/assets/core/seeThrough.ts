// Third person: walls and roofs between the camera and the player fade (a dither) so the player is never hidden behind
// a building. One shared set of values, written by the camera rig each frame (src/render/camera/cameraRig.ts) and read by
// the building shaders (materials.ts). The pattern is the same 4x4 screen-door as the LOD cross-fade: a fragment close to
// the line of sight is dropped by an ordered pattern, more of them the nearer the line it is, none beyond RADIUS.
import * as THREE from 'three';

export const SEE_THROUGH = {
  /** 1 while the third-person camera is out (and not in the cut-away of a building one stands in), else 0. */
  on: { value: 0 },
  eye: { value: new THREE.Vector3() },
  focus: { value: new THREE.Vector3() },
};

/** Metres around the line of sight in which a surface starts to thin out. */
export const SEE_RADIUS = 1.7;

export const GLSL_SEE_PARS = /* glsl */ `
uniform float uSeeOn;
uniform vec3 uSeeEye;
uniform vec3 uSeeFocus;`;

/** Needs vWPos and uCutOn (the cut-away does its own work inside a building). Place it where the cut-away discards. */
export const GLSL_SEE = /* glsl */ `
if (uSeeOn > 0.5 && uCutOn < 1.5) {
  vec3 sab = uSeeFocus - uSeeEye;
  float sL = max(length(sab), 0.5);
  float st = dot(vWPos - uSeeEye, sab) / (sL * sL);
  float sEnd = (sL - 0.6) / sL;
  if (st > 0.02 && st < sEnd) {
    float sd = length(vWPos - (uSeeEye + sab * st));
    // thin around the line of sight, whole farther out; a little more near the player than at the camera
    float keep = smoothstep(${SEE_RADIUS.toFixed(2)} * 0.3, ${SEE_RADIUS.toFixed(2)}, sd);
    vec2 sfc = mod(floor(gl_FragCoord.xy), 4.0);
    float sth = mod(sfc.x * 4.0 + sfc.y * 7.0, 16.0) / 16.0 + 1.0 / 32.0;
    if (sth > keep) discard;
  }
}`;

export function seeUniforms(s: { uniforms: Record<string, THREE.IUniform> }): void {
  s.uniforms.uSeeOn = SEE_THROUGH.on;
  s.uniforms.uSeeEye = SEE_THROUGH.eye;
  s.uniforms.uSeeFocus = SEE_THROUGH.focus;
}
