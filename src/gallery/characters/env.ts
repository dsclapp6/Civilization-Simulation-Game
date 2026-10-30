// Gallery stage: renderer with the nominal lighting the assets are authored for
// (ARCHITECTURE §5: sun ≈ 3.0, hemisphere ≈ 0.9, ACES filmic, sRGB), soft shadows,
// a grass ground plane, sky/fog and a time-of-day control.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PALETTE } from '../../assets/palette';

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  setTimeOfDay(f: number): void;
  setShadowFocus(x: number, z: number, radius: number): void;
  resize(): void;
}

function mixColor(a: number, b: number, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

export function createStage(container: HTMLElement, pixelRatio = Math.min(2, window.devicePixelRatio || 1)): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky.dayHorizon);
  scene.fog = new THREE.Fog(PALETTE.fog.day, 60, 260);

  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 600);
  camera.position.set(0, 2.2, 9);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.495;

  const hemi = new THREE.HemisphereLight(0xbfd9ef, 0x6b5a3a, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(PALETTE.sun.day, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);

  // ground: grass with gentle colour variation (flat-shaded facets)
  const size = 400, seg = 120;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const g0 = new THREE.Color(PALETTE.ground[0]), g1 = new THREE.Color(PALETTE.ground[1]), g2 = new THREE.Color(0x6f9448);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const n = Math.sin(x * 0.21 + Math.cos(z * 0.17) * 2) * 0.5 + Math.sin(z * 0.13 - x * 0.07) * 0.5;
    const m = Math.sin(x * 1.7 + z * 2.3) * 0.5 + 0.5;
    // THREE.Color stores linear values already (colour management on)
    c.copy(g0).lerp(g1, Math.max(0, n) * 0.6).lerp(g2, m * 0.25);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    // tiny undulation away from the stage so the horizon is not ruler-flat
    const r = Math.hypot(x, z);
    if (r > 40) pos.setY(i, Math.sin(x * 0.05) * Math.cos(z * 0.045) * Math.min(3, (r - 40) * 0.05));
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }));
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  let focusX = 0, focusZ = 0, focusR = 14;
  let tod = 0.42;
  function placeSun(): void {
    // day fraction → sun arc; low winter-ish morning by default for long readable shadows
    const ang = (tod - 0.25) * Math.PI * 2; // 0 at sunrise (0.25), PI at sunset (0.75)
    const elev = Math.sin(ang);
    const day = Math.max(0, elev);
    const azim = -0.6 + ang * 0.55;
    const dist = 60;
    const night = elev < 0;
    const e = night ? Math.max(0.35, -elev) : Math.max(0.12, elev);
    sun.position.set(focusX + Math.cos(azim) * dist * Math.sqrt(1 - e * e), dist * e, focusZ + Math.sin(azim) * dist * Math.sqrt(1 - e * e) + 20);
    sun.target.position.set(focusX, 0, focusZ);
    const dusk = 1 - Math.min(1, day * 3.2);
    if (night) {
      sun.color.set(PALETTE.sun.moon);
      sun.intensity = 0.35;
      hemi.color.set(PALETTE.ambient.night); hemi.groundColor.set(0x1a1a24); hemi.intensity = 0.5;
      (scene.background as THREE.Color).set(PALETTE.sky.nightHorizon);
      (scene.fog as THREE.Fog).color.set(PALETTE.fog.night);
    } else {
      sun.color.copy(mixColor(PALETTE.sun.day, PALETTE.sun.dusk, dusk));
      sun.intensity = 3.0 * (0.35 + 0.65 * Math.min(1, day * 2.2));
      hemi.color.copy(mixColor(0xbfd9ef, 0xd8b8a0, dusk * 0.6)); hemi.groundColor.set(0x6b5a3a); hemi.intensity = 0.9 * (0.55 + 0.45 * Math.min(1, day * 2.5));
      (scene.background as THREE.Color).copy(mixColor(PALETTE.sky.dayHorizon, PALETTE.sky.duskHorizon, dusk));
      (scene.fog as THREE.Fog).color.copy(mixColor(PALETTE.fog.day, PALETTE.fog.dusk, dusk));
    }
    const cam = sun.shadow.camera;
    cam.left = -focusR; cam.right = focusR; cam.top = focusR; cam.bottom = -focusR;
    cam.near = 1; cam.far = 160;
    cam.updateProjectionMatrix();
  }
  placeSun();

  function resize(): void {
    const w = container.clientWidth || window.innerWidth, h = container.clientHeight || window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  return {
    renderer, scene, camera, controls, sun, hemi,
    setTimeOfDay(f: number) { tod = f; placeSun(); },
    setShadowFocus(x: number, z: number, radius: number) { focusX = x; focusZ = z; focusR = radius; placeSun(); },
    resize,
  };
}
