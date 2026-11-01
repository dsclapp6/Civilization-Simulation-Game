// Beacons for SimView.worldMarkers: where to go. The tracked objective (primary) stands as a tall, soft
// pillar of light in its marker colour with a slow upward shimmer, a glowing ring on the ground and a
// small floating gem with its name and distance — seen over roofs and trees from far off (it keeps a
// minimum width on screen), quiet up close (fades as the camera nears) and gone when you are standing on
// it. Secondary markers (home, work, a tracked person, a place) are short, faint shafts with a small gem.
// Three instanced draw calls (shafts, rings, gems) + one DOM label.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { WorldMarker } from '../../core/view';

const MAX = 12;
/** Pillar height (m) and width at the base for the primary and the secondary markers; least width on screen (px). */
const PRIMARY_H = 46, PRIMARY_W = 2.6, PRIMARY_PX = 12;
const SECONDARY_H = 9, SECONDARY_W = 0.9, SECONDARY_PX = 5;
/** What the player asked to find (the journal's Find: kinds 'person' and 'place'): taller than a house, so it shows over
 *  the roofs like the objective's pillar, but thinner and paler than it. */
const FIND_H = 24, FIND_W = 1.5, FIND_PX = 8;
/** The beacon is gone when the player stands within ARRIVE m, and back by ARRIVE_FULL m. */
const ARRIVE = 2.5, ARRIVE_FULL = 7;

const SHAFT_VERT = /* glsl */`
attribute vec3 aBase;
attribute vec4 aShape;   // x height, y width, z alpha, w min width in pixels
attribute vec3 aColor;
uniform float uPixelAngle;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vH;
void main() {
  vec3 toCam = cameraPosition - aBase;
  vec2 side2 = normalize(vec2(toCam.z, -toCam.x) + vec2(1e-5, 0.0));
  float dist = length(toCam);
  float width = max(aShape.y, dist * uPixelAngle * aShape.w);
  vec3 p = aBase + vec3(side2.x, 0.0, side2.y) * position.x * width + vec3(0.0, position.y * aShape.x, 0.0);
  vUv = vec2(position.x * 2.0, position.y);
  vColor = aColor;
  vAlpha = aShape.z;
  vH = aShape.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const SHAFT_FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vH;
void main() {
  float x = vUv.x;
  float core = exp(-x * x * 12.0);
  float glow = exp(-x * x * 2.6) * 0.5;
  float y = vUv.y;
  float vert = pow(1.0 - y, 1.35) * smoothstep(0.0, 0.02, y);
  // light rising up the shaft
  float bands = 0.8 + 0.2 * sin((y * vH - uTime * 2.4) * 0.55);
  float a = (core + glow) * vert * bands * vAlpha;
  // premultiplied: the core partly covers what is behind (gold on a pale sky), the glow only adds light
  float cover = core * vert * vAlpha * 0.6;
  gl_FragColor = vec4(vColor * a, cover);
}`;

const RING_VERT = /* glsl */`
attribute vec3 aBase;
attribute vec4 aShape;   // x radius, y alpha, z pulse phase, w primary
attribute vec3 aColor;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vPrimary;
void main() {
  vUv = position.xz;
  vColor = aColor;
  vAlpha = aShape.y;
  vPrimary = aShape.w;
  vec3 p = aBase + vec3(position.x * aShape.x, 0.0, position.z * aShape.x);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RING_FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vPrimary;
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float ring = exp(-pow((r - 0.78) * 9.0, 2.0));
  float disc = (1.0 - r) * 0.35;
  // a ripple running outwards
  float rip = exp(-pow((r - fract(uTime * 0.45)) * 7.0, 2.0)) * (1.0 - r) * vPrimary;
  float a = (ring + disc + rip * 0.8) * vAlpha;
  gl_FragColor = vec4(vColor * a, ring * vAlpha * 0.6);
}`;

interface Slot { marker: WorldMarker | null }

export class BeaconLayer {
  readonly root = new THREE.Group();
  /** CSS2D labels (added to the renderer's label overlay scene). */
  readonly labelScene = new THREE.Group();
  private readonly shafts: THREE.Mesh;
  private readonly rings: THREE.Mesh;
  private readonly gems: THREE.InstancedMesh;
  private readonly shaftGeo: THREE.InstancedBufferGeometry;
  private readonly ringGeo: THREE.InstancedBufferGeometry;
  private readonly shaftMat: THREE.ShaderMaterial;
  private readonly ringMat: THREE.ShaderMaterial;
  private readonly gemMat: THREE.MeshBasicMaterial;
  private readonly sBase: THREE.InstancedBufferAttribute;
  private readonly sShape: THREE.InstancedBufferAttribute;
  private readonly sColor: THREE.InstancedBufferAttribute;
  private readonly rBase: THREE.InstancedBufferAttribute;
  private readonly rShape: THREE.InstancedBufferAttribute;
  private readonly rColor: THREE.InstancedBufferAttribute;
  private readonly label: CSS2DObject | null;
  private readonly labelName: HTMLElement | null;
  private readonly labelDist: HTMLElement | null;
  private time = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private lastLabel = '';
  private lastDist = '';
  /** Markers drawn this frame (stats/tests). */
  drawn = 0;
  /** Alpha of the primary pillar this frame (tests). */
  primaryAlpha = 0;

  constructor(private readonly heightAt: (x: number, z: number) => number, labels: boolean) {
    this.root.name = 'beacons';
    // a vertical quad x -0.5..0.5, y 0..1 (billboarded round the vertical axis in the shader)
    const quad = new THREE.PlaneGeometry(1, 1, 1, 8).translate(0, 0.5, 0);
    this.shaftGeo = new THREE.InstancedBufferGeometry().copy(quad as unknown as THREE.InstancedBufferGeometry);
    quad.dispose();
    this.sBase = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.sShape = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.sColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.shaftGeo.setAttribute('aBase', this.sBase);
    this.shaftGeo.setAttribute('aShape', this.sShape);
    this.shaftGeo.setAttribute('aColor', this.sColor);
    this.shaftGeo.instanceCount = 0;
    const common = { transparent: true, depthWrite: false, blending: THREE.NormalBlending, premultipliedAlpha: true, fog: false, toneMapped: false };
    this.shaftMat = new THREE.ShaderMaterial({
      ...common, side: THREE.DoubleSide, vertexShader: SHAFT_VERT, fragmentShader: SHAFT_FRAG,
      uniforms: { uTime: { value: 0 }, uPixelAngle: { value: 0.001 } },
    });
    this.shafts = new THREE.Mesh(this.shaftGeo, this.shaftMat);
    this.shafts.frustumCulled = false;
    this.shafts.renderOrder = 8;
    this.shafts.name = 'beacon-shafts';

    const disc = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.ringGeo = new THREE.InstancedBufferGeometry().copy(disc as unknown as THREE.InstancedBufferGeometry);
    disc.dispose();
    this.rBase = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.rShape = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.rColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.ringGeo.setAttribute('aBase', this.rBase);
    this.ringGeo.setAttribute('aShape', this.rShape);
    this.ringGeo.setAttribute('aColor', this.rColor);
    this.ringGeo.instanceCount = 0;
    this.ringMat = new THREE.ShaderMaterial({
      ...common, vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms: { uTime: { value: 0 } },
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    });
    this.rings = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 7;
    this.rings.name = 'beacon-rings';

    // a faceted gem: an elongated octahedron
    const gem = new THREE.OctahedronGeometry(0.5, 0).scale(0.75, 1.25, 0.75);
    this.gemMat = new THREE.MeshBasicMaterial({ fog: false, toneMapped: false, transparent: true, opacity: 0.95 });
    this.gems = new THREE.InstancedMesh(gem, this.gemMat, MAX);
    this.gems.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.gems.count = 0;
    this.gems.frustumCulled = false;
    this.gems.renderOrder = 9;
    this.gems.name = 'beacon-gems';
    this.root.add(this.rings, this.shafts, this.gems);

    if (labels && typeof document !== 'undefined') {
      const el = document.createElement('div');
      el.className = 'mil-beacon-label';
      el.style.cssText = 'font: italic 600 14px Georgia, "Palatino Linotype", "Times New Roman", serif; color: #fff1c8; text-shadow: 0 1px 1px #000, 0 0 4px rgba(0,0,0,0.9), 0 0 9px rgba(0,0,0,0.55); white-space: nowrap; pointer-events: none; text-align: center; letter-spacing: 0.02em;';
      const name = document.createElement('div');
      const dist = document.createElement('div');
      dist.style.cssText = 'font: 700 12px Georgia, serif; font-style: normal; color: #ffd76a; letter-spacing: 0.04em;';
      el.append(name, dist);
      this.label = new CSS2DObject(el);
      this.label.center.set(0.5, 1);
      this.label.visible = false;
      this.labelName = name;
      this.labelDist = dist;
      this.labelScene.add(this.label);
    } else {
      this.label = null; this.labelName = null; this.labelDist = null;
    }
  }

  update(markers: readonly WorldMarker[], camera: THREE.PerspectiveCamera, player: { x: number; z: number } | null, dt: number, viewportHeight: number, show: boolean): void {
    this.time += dt;
    this.shaftMat.uniforms.uTime.value = this.time;
    this.ringMat.uniforms.uTime.value = this.time;
    this.shaftMat.uniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight);
    const cp = camera.position;
    let n = 0;
    let primary: { m: WorldMarker; y: number; d: number; a: number; arrive: number } | null = null;
    this.primaryAlpha = 0;
    // primary first so it always gets a slot
    const list = show ? markers : [];
    for (let pass = 0; pass < 2; pass++) {
      for (const mk of list) {
        if ((pass === 0) !== !!mk.primary || n >= MAX) continue;
        const ground = this.heightAt(mk.x, mk.z);
        const lift = mk.y ?? 0;
        const camD = Math.hypot(mk.x - cp.x, mk.z - cp.z);
        // arrived: the beacon gives way when the player stands on the spot
        const pd = player ? Math.hypot(mk.x - player.x, mk.z - player.z) : Infinity;
        const arrive = smooth(ARRIVE, ARRIVE_FULL, pd);
        // quiet up close, full from ~60 m
        const near = 0.32 + 0.68 * smooth(8, 60, camD);
        const isP = !!mk.primary;
        const isFind = !isP && (mk.kind === 'person' || mk.kind === 'place');
        const alpha = (isP ? 0.95 : isFind ? 0.7 : 0.4) * arrive * near;
        if (alpha < 0.01) continue;
        if (isP) { primary = { m: mk, y: ground + lift, d: camD, a: alpha, arrive }; this.primaryAlpha = alpha; }
        this.c.setHex(mk.color);
        // shaft
        this.sBase.setXYZ(n, mk.x, ground + (isP ? 0 : lift), mk.z);
        if (isP) this.sShape.setXYZW(n, PRIMARY_H + Math.min(160, camD * 0.08), PRIMARY_W, alpha, PRIMARY_PX);
        else if (isFind) this.sShape.setXYZW(n, FIND_H + Math.min(90, camD * 0.05), FIND_W, alpha, FIND_PX);
        else this.sShape.setXYZW(n, SECONDARY_H, SECONDARY_W, alpha, SECONDARY_PX);
        this.sColor.setXYZ(n, this.c.r, this.c.g, this.c.b);
        // ground ring (people markers float over the head: no ring)
        const ringR = isP ? 2.4 + 0.15 * Math.sin(this.time * 2.2) : 1.1;
        this.rBase.setXYZ(n, mk.x, ground + 0.12, mk.z);
        this.rShape.setXYZW(n, ringR, lift > 0.5 ? 0 : alpha * (isP ? 1 : 0.7), 0, isP ? 1 : 0);
        this.rColor.setXYZ(n, this.c.r, this.c.g, this.c.b);
        // floating gem over the spot (or the head), screen size kept readable far off
        const bob = Math.sin(this.time * 2.0 + mk.id) * 0.12;
        const gy = ground + Math.max(lift + 0.6, isP ? 3.2 : 2.4) + bob;
        const gs = Math.max(isP ? 0.8 : 0.5, camD * (isP ? 0.012 : 0.008));
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), this.time * 1.3 + mk.id);
        this.m.compose(this.v.set(mk.x, gy, mk.z), this.q, this.sc.set(gs, gs, gs));
        this.gems.setMatrixAt(n, this.m);
        this.gems.setColorAt(n, this.c.multiplyScalar(0.6 + 0.6 * Math.min(1, alpha * 1.4)));
        if (isP && primary) primary.y = gy + gs * 0.8;
        n++;
      }
    }
    this.shaftGeo.instanceCount = n;
    this.ringGeo.instanceCount = n;
    this.gems.count = n;
    this.shafts.visible = this.rings.visible = this.gems.visible = n > 0;
    for (const a of [this.sBase, this.sShape, this.sColor, this.rBase, this.rShape, this.rColor]) a.needsUpdate = true;
    this.gems.instanceMatrix.needsUpdate = true;
    if (this.gems.instanceColor) this.gems.instanceColor.needsUpdate = true;
    this.drawn = n;

    // label over the primary gem: what and how far
    if (this.label) {
      const show2 = !!primary && primary.d > 6 && primary.arrive > 0.1;
      this.label.visible = show2;
      if (show2 && primary) {
        this.label.position.set(primary.m.x, primary.y + 0.3, primary.m.z);
        const name = primary.m.label;
        const pd = player ? Math.hypot(primary.m.x - player.x, primary.m.z - player.z) : primary.d;
        const dist = pd >= 1000 ? `${(pd / 1000).toFixed(1)} km` : `${Math.round(pd)} m`;
        if (name !== this.lastLabel && this.labelName) { this.labelName.textContent = name; this.lastLabel = name; }
        if (dist !== this.lastDist && this.labelDist) { this.labelDist.textContent = dist; this.lastDist = dist; }
        const el = this.label.element;
        const op = Math.min(1, primary.arrive).toFixed(2);
        if (el.style.opacity !== op) el.style.opacity = op;
      }
    }
  }

  dispose(): void {
    this.shaftGeo.dispose(); this.ringGeo.dispose(); this.gems.geometry.dispose(); this.gems.dispose();
    this.shaftMat.dispose(); this.ringMat.dispose(); this.gemMat.dispose();
    this.label?.element.remove();
    this.root.clear();
    this.labelScene.clear();
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
