// Quest marks over people (docs/CIV.md §1; CharacterDrawItem.mark): a gold "!" over anyone who has something for the
// player, a silver "?" over the person a finished task is handed in to. Camera-facing billboards whose glyphs are drawn
// as signed distances in the fragment shader (crisp at any size, no textures): a bright face with a dark rim and a soft
// glow, bobbing gently over the head and lifted clear of the nameplate. Seen from about 90 m (fading out by 100 m) and
// never smaller than MIN_PX on screen. A second pass without the depth test draws them through crowds and thin cover
// (people, fences, foliage) at reduced strength; a building between the camera and the person dims them further.
// People indoors are not in the zone's draw list, so they get no mark (the compass and minimap still show them).
// Two draw calls in all, one shared instanced geometry, rebuilt attributes each frame (a handful of instances).
import * as THREE from 'three';
import type { CharacterDrawItem } from '../../core/view';

export const MAX_MARKS = 48;
/** Full strength to FULL_R m, gone by FADE_R m (CIV §1: visible from ~90 m). */
export const FULL_R = 85, FADE_R = 100;
/** Least glyph height on screen (px). */
export const MIN_PX = 16;
/** Glyph height when close (m). */
const BASE_H = 0.5;
/** Strength of the see-through pass, and of everything behind a building. */
const XRAY = 0.38, BEHIND_HOUSE = 0.22;

const VERT = /* glsl */`
attribute vec3 aPos;     // anchor: over the head
attribute vec4 aShape;   // x world height (m), y alpha, z kind (0 "!", 1 "?"), w see-through factor
uniform float uPixelAngle;
uniform float uTime;
uniform float uXray;
varying vec2 vUv;
varying float vAlpha;
varying float vKind;
void main() {
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  float dist = max(1.0, -mv.z);
  float px = dist * uPixelAngle;
  float h = max(aShape.x, ${MIN_PX.toFixed(1)} * px);
  // lift clear of the nameplate (≈ 34 px of name and role above the head) and bob
  float bob = sin(uTime * 2.4 + aPos.x * 1.7 + aPos.z * 0.9) * 0.07 * h / ${BASE_H.toFixed(2)};
  mv.y += max(0.3, 30.0 * px) + h * 0.5 + bob;
  // glyph quad: x -0.5..0.5 of the width (0.62 h), y -0.5..0.5 of the height
  mv.xy += position.xy * vec2(h * 0.62, h);
  vUv = position.xy + 0.5;
  vAlpha = aShape.y * mix(1.0, aShape.w, uXray);
  vKind = aShape.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform float uXray;
varying vec2 vUv;
varying float vAlpha;
varying float vKind;
float sdSeg(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a, ba = b - a;
  float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * t) - mix(ra, rb, t);
}
float sdArc(vec2 p, vec2 c, float r, float th, float a0, float a1) {
  vec2 q = p - c;
  float a = atan(q.y, q.x);
  // inside the arc's angular span: distance to the ring; else to the nearer end cap
  if (a > a0 && a < a1) return abs(length(q) - r) - th;
  vec2 e0 = c + r * vec2(cos(a0), sin(a0)), e1 = c + r * vec2(cos(a1), sin(a1));
  return min(length(p - e0), length(p - e1)) - th;
}
void main() {
  // glyph space: x -0.31..0.31, y 0..1 (aspect 0.62)
  vec2 p = vec2((vUv.x - 0.5) * 0.62, vUv.y);
  float d;
  if (vKind < 0.5) {
    // "!": a bar tapering downwards and a dot
    d = min(sdSeg(p, vec2(0.0, 0.88), vec2(0.0, 0.36), 0.105, 0.068), length(p - vec2(0.0, 0.13)) - 0.088);
  } else {
    // "?": a hook (arc from the left round over the top to the right and down), a short stem and a dot
    float hook = sdArc(p, vec2(0.0, 0.69), 0.17, 0.06, -1.15, 3.55);
    float stem = sdSeg(p, vec2(0.075, 0.535), vec2(0.0, 0.36), 0.06, 0.058);
    d = min(min(hook, stem), length(p - vec2(0.0, 0.13)) - 0.083);
  }
  float aa = fwidth(d) * 0.9 + 1e-4;
  float face = 1.0 - smoothstep(-aa, aa, d);
  float rim = 1.0 - smoothstep(0.035 - aa, 0.035 + aa, d);
  float glow = exp(-max(d, 0.0) * 18.0) * 0.55;
  vec3 hi = vKind < 0.5 ? vec3(1.0, 0.93, 0.6) : vec3(0.97, 0.98, 1.0);
  vec3 lo = vKind < 0.5 ? vec3(0.93, 0.62, 0.12) : vec3(0.62, 0.68, 0.78);
  vec3 edge = vKind < 0.5 ? vec3(0.22, 0.12, 0.02) : vec3(0.1, 0.12, 0.18);
  vec3 halo = vKind < 0.5 ? vec3(1.0, 0.78, 0.3) : vec3(0.8, 0.88, 1.0);
  vec3 fill = mix(lo, hi, smoothstep(0.1, 0.9, vUv.y));
  // a glint across the face
  fill += 0.18 * smoothstep(0.05, 0.0, abs(vUv.x - vUv.y * 0.35 - 0.28));
  vec3 col = mix(edge, fill, face);
  float a = max(rim, glow * (1.0 - uXray * 0.6));
  col = mix(halo, col, rim);
  // premultiplied
  gl_FragColor = vec4(col * a * vAlpha, a * vAlpha * (rim > 0.01 ? 1.0 : 0.6));
}`;

export class QuestMarks {
  readonly root = new THREE.Group();
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aShape: THREE.InstancedBufferAttribute;
  private readonly front: THREE.Mesh;
  private readonly xray: THREE.Mesh;
  private readonly frontMat: THREE.ShaderMaterial;
  private readonly xrayMat: THREE.ShaderMaterial;
  private readonly uniforms = { uPixelAngle: { value: 0.0015 }, uTime: { value: 0 } };
  private readonly occ = new Map<number, { f: number; v: boolean }>();
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private frame = 0;
  /** Marks drawn this frame (stats/tests). */
  drawn = 0;
  /** True when something solid stands between the camera and the point (the renderer's building boxes). */
  occluded?: (from: THREE.Vector3, to: THREE.Vector3) => boolean;

  constructor() {
    this.root.name = 'quest-marks';
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry().copy(quad as unknown as THREE.InstancedBufferGeometry);
    quad.dispose();
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKS * 3), 3);
    this.aShape = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKS * 4), 4);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aShape.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aPos', this.aPos);
    this.geo.setAttribute('aShape', this.aShape);
    this.geo.instanceCount = 0;
    const common = {
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, premultipliedAlpha: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      fog: false, toneMapped: false, side: THREE.DoubleSide,
    } as const;
    this.frontMat = new THREE.ShaderMaterial({ ...common, uniforms: { ...this.uniforms, uXray: { value: 0 } } });
    this.xrayMat = new THREE.ShaderMaterial({ ...common, depthTest: false, uniforms: { ...this.uniforms, uXray: { value: 1 } } });
    this.front = new THREE.Mesh(this.geo, this.frontMat);
    this.xray = new THREE.Mesh(this.geo, this.xrayMat);
    for (const m of [this.front, this.xray]) { m.frustumCulled = false; m.visible = false; }
    this.xray.renderOrder = 12;
    this.front.renderOrder = 13;
    this.front.name = 'quest-marks';
    this.xray.name = 'quest-marks-through';
    this.root.add(this.xray, this.front);
  }

  /** Strength of a mark at a camera distance (1 within FULL_R, 0 beyond FADE_R). */
  static strength(d: number): number {
    if (d <= FULL_R) return 1;
    if (d >= FADE_R) return 0;
    const t = (FADE_R - d) / (FADE_R - FULL_R);
    return t * t * (3 - 2 * t);
  }

  update(chars: readonly CharacterDrawItem[], camera: THREE.PerspectiveCamera, viewportHeight: number, dt: number, show: boolean): void {
    this.frame++;
    this.uniforms.uTime.value += dt;
    this.uniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight);
    const cp = camera.position;
    let n = 0;
    if (show) {
      for (const it of chars) {
        if (n >= MAX_MARKS) break;
        const kind = it.mark === 'quest' ? 0 : it.mark === 'turnin' ? 1 : -1;
        if (kind < 0 || it.highlight === 3) continue;
        const top = it.y + it.look.height + (it.mount ? 1.25 : 0);
        const d = Math.hypot(it.x - cp.x, top - cp.y, it.z - cp.z);
        const a = QuestMarks.strength(d);
        if (a <= 0.003) continue;
        // a house in the way: only a faint mark (cached per person for a few frames: each test is a ray)
        let behind = false;
        if (this.occluded) {
          const c = this.occ.get(it.id);
          if (c && this.frame - c.f < 6) behind = c.v;
          else {
            behind = this.occluded(this.from.copy(cp), this.to.set(it.x, top + 0.3, it.z));
            if (c) { c.f = this.frame; c.v = behind; } else this.occ.set(it.id, { f: this.frame - (it.id % 6), v: behind });
          }
        }
        this.aPos.setXYZ(n, it.x, top + 0.12, it.z);
        // w: the strength of the see-through pass (the depth-tested pass hides what is behind a wall by itself)
        this.aShape.setXYZW(n, BASE_H, a, kind, behind ? BEHIND_HOUSE : XRAY);
        n++;
      }
    }
    if (this.occ.size > 300) this.occ.clear();
    this.geo.instanceCount = n;
    this.front.visible = this.xray.visible = n > 0;
    this.aPos.needsUpdate = true;
    this.aShape.needsUpdate = true;
    this.drawn = n;
  }

  dispose(): void {
    this.geo.dispose();
    this.frontMat.dispose();
    this.xrayMat.dispose();
    this.root.clear();
  }
}
