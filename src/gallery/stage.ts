// Gallery stage: renderer, nominal lighting rig (ARCHITECTURE §5), time-of-day sun/moon,
// sky dome, fog and a grass ground — so assets look as they will in game.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Season } from '../core/time';
import { daylight } from '../core/time';
import { PALETTE } from '../assets/palette';
import { Ground } from '../world/types';

export interface Lighting {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  moonDir: THREE.Vector3;
  moonIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  fog: THREE.Color;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  /** 0 day … 1 full night (drives window glow). */
  night: number;
  sunElevation: number;
}

const MAX_ELEV = [48, 62, 38, 22];

/** Nominal lighting for a day fraction and season (the renderer should match this look). */
export function computeLighting(time: number, season: Season): Lighting {
  const { sunrise, sunset } = daylight(season);
  const maxE = (MAX_ELEV[season] * Math.PI) / 180;
  // Sun angle: 0 at sunrise, PI at sunset; extend smoothly below the horizon at night.
  const day = (time - sunrise) / (sunset - sunrise);
  const phi = day * Math.PI;
  const elev = Math.sin(phi) * maxE + (day < 0 || day > 1 ? -0.25 : 0);
  const sunDir = new THREE.Vector3(Math.cos(phi) * Math.cos(elev), Math.sin(elev), Math.sin(phi) * Math.cos(elev) * 0.9 + 0.25).normalize();
  const se = Math.sin(elev);
  const dayAmt = THREE.MathUtils.smoothstep(se, -0.04, 0.22);
  const golden = 1 - THREE.MathUtils.smoothstep(se, 0.05, 0.42);
  const night = 1 - THREE.MathUtils.smoothstep(se, -0.1, 0.1);
  const sunColor = new THREE.Color(PALETTE.sun.day).lerp(new THREE.Color(PALETTE.sun.dusk), golden * 0.85);
  const sunIntensity = 3.0 * dayAmt * (0.75 + 0.25 * (1 - golden));
  const moonDir = new THREE.Vector3(-0.35, 0.7, -0.55).normalize();
  // Moonlit blue night: a cool key from the moon plus a blue sky fill (see docs/ART.md).
  const moonIntensity = 0.9 * night;
  const hemiSky = new THREE.Color(0xbfd9ef).lerp(new THREE.Color(0xe8b896), golden * dayAmt * 0.45).lerp(new THREE.Color(PALETTE.ambient.night), night);
  const hemiGround = new THREE.Color(0x6b5a3a).lerp(new THREE.Color(0x1e2433), night);
  const hemiIntensity = 0.9 * (0.3 + 0.7 * dayAmt) + 0.75 * night;
  const fog = new THREE.Color(PALETTE.fog.day).lerp(new THREE.Color(PALETTE.fog.dusk), golden * dayAmt * 0.9).lerp(new THREE.Color(PALETTE.fog.night), night);
  const skyTop = new THREE.Color(PALETTE.sky.dayTop).lerp(new THREE.Color(PALETTE.sky.duskTop), golden * dayAmt * 0.8).lerp(new THREE.Color(PALETTE.sky.nightTop), night);
  const skyHorizon = new THREE.Color(PALETTE.sky.dayHorizon).lerp(new THREE.Color(PALETTE.sky.duskHorizon), golden * dayAmt * 0.9).lerp(new THREE.Color(PALETTE.sky.nightHorizon), night);
  return { sunDir, sunColor, sunIntensity, moonDir, moonIntensity, hemiSky, hemiGround, hemiIntensity, fog, skyTop, skyHorizon, night, sunElevation: elev };
}

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  content: THREE.Group;
  sun: THREE.DirectionalLight;
  moon: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  ground: THREE.Mesh;
  /** 0..1 snow on the gallery ground. */
  setGroundSnow(v: number): void;
  applyLighting(l: Lighting): void;
  /** Fit shadow camera and fog to a bounding box of the content. */
  fit(box: THREE.Box3): void;
  resize(): void;
  dispose(): void;
}

export function createStage(container: HTMLElement): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.3, 6000);
  camera.position.set(18, 11, 22);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(0, 2, 0);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);
  const moon = new THREE.DirectionalLight(PALETTE.sun.moon, 0);
  scene.add(moon, moon.target);
  const hemi = new THREE.HemisphereLight(0xbfd9ef, 0x6b5a3a, 0.9);
  scene.add(hemi);

  // Sky dome
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() }, uNight: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSun; uniform vec3 uSunCol; uniform float uNight; varying vec3 vDir;
      float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float t = pow(clamp(d.y, 0.0, 1.0), 0.55);
        vec3 c = mix(uHorizon, uTop, t);
        float s = max(dot(d, normalize(uSun)), 0.0);
        c += uSunCol * (pow(s, 600.0) * 6.0 + pow(s, 12.0) * 0.18) * (1.0 - uNight);
        if (d.y > 0.0 && uNight > 0.3) { vec3 q = floor(d * 400.0); float st = step(0.9975, h(q)); c += vec3(st) * uNight * 0.8 * t; }
        if (d.y < 0.0) c = mix(uHorizon, uHorizon * 0.8, clamp(-d.y * 4.0, 0.0, 1.0));
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(3000, 32, 16), skyMat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  scene.fog = new THREE.Fog(PALETTE.fog.day, 150, 1400);

  // Ground: grass disc with gentle colour noise.
  const gGeo = new THREE.CircleGeometry(1500, 96, 0, Math.PI * 2);
  gGeo.rotateX(-Math.PI / 2);
  const pos = gGeo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(PALETTE.ground[Ground.Grass]);
  const alt = new THREE.Color(PALETTE.ground[Ground.Meadow]);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const n = Math.sin(x * 0.031 + Math.cos(z * 0.027) * 2) * 0.5 + 0.5;
    tmp.copy(base).lerp(alt, n * 0.5);
    colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
  }
  gGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const groundMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const groundSnow = { value: 0 };
  groundMat.onBeforeCompile = (sh) => {
    sh.uniforms.uSnow = groundSnow;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vGXZ;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvGXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSnow;\nvarying vec2 vGXZ;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n{ float n = sin(vGXZ.x * 0.37 + sin(vGXZ.y * 0.21) * 2.0) * 0.5 + 0.5; diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.92, 0.95), smoothstep(n * 0.3, n * 0.3 + 0.25, uSnow)); }');
  };
  const ground = new THREE.Mesh(gGeo, groundMat);
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  const content = new THREE.Group();
  scene.add(content);

  const stage: Stage = {
    renderer, scene, camera, controls, content, sun, moon, hemi, ground,
    setGroundSnow(v: number): void { groundSnow.value = v; },
    applyLighting(l: Lighting): void {
      sun.color.copy(l.sunColor);
      sun.intensity = l.sunIntensity;
      sun.visible = l.sunIntensity > 0.01;
      moon.intensity = l.moonIntensity;
      moon.visible = l.moonIntensity > 0.01;
      hemi.color.copy(l.hemiSky);
      hemi.groundColor.copy(l.hemiGround);
      hemi.intensity = l.hemiIntensity;
      (scene.fog as THREE.Fog).color.copy(l.fog);
      skyMat.uniforms.uTop.value.copy(l.skyTop);
      skyMat.uniforms.uHorizon.value.copy(l.skyHorizon);
      skyMat.uniforms.uSun.value.copy(l.sunDir);
      skyMat.uniforms.uSunCol.value.copy(l.sunColor);
      skyMat.uniforms.uNight.value = l.night;
      const t = controls.target;
      sun.position.copy(t).addScaledVector(l.sunDir, 400);
      sun.target.position.copy(t);
      moon.position.copy(t).addScaledVector(l.moonDir, 400);
      moon.target.position.copy(t);
    },
    fit(box: THREE.Box3): void {
      const size = box.getSize(new THREE.Vector3());
      const r = Math.max(8, size.length() * 0.6);
      const cam = sun.shadow.camera;
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = 1; cam.far = 1200;
      cam.updateProjectionMatrix();
      sun.shadow.normalBias = 0.02 + r * 0.0006;
      const f = scene.fog as THREE.Fog;
      f.near = Math.max(120, r * 3);
      f.far = Math.max(1200, r * 14);
    },
    resize(): void {
      const w = container.clientWidth || window.innerWidth, h = container.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
    dispose(): void {
      renderer.dispose();
      gGeo.dispose(); groundMat.dispose(); skyMat.dispose(); sky.geometry.dispose();
    },
  };
  stage.resize();
  return stage;
}
