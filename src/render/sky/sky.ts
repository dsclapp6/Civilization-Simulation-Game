// Sky dome (gradient, sun and moon discs, halo, procedural clouds, horizon fog band) and a star
// field. Both follow the camera and draw before everything else without writing depth.
import * as THREE from 'three';
import type { AtmosphereState } from './atmosphere';

const SKY_VERTEX = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const SKY_FRAGMENT = /* glsl */`
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunDisc;
uniform vec3 uSunHalo;
uniform vec3 uMoonColor;
uniform float uMoonPhase;
uniform float uMoonAlpha;
uniform vec3 uFogColor;
uniform vec3 uSunFog;
uniform float uSunFogExp;
uniform float uCloudCover;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec2 uCloudOffset;
uniform float uStarAlpha;
uniform float uHorizonLift;
varying vec3 vDir;

float sHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float sNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float sFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * sNoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y - uHorizonLift;
  float t = pow(clamp(h, 0.0, 1.0), 0.45);
  vec3 col = mix(uHorizon, uTop, t);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunHalo * (pow(sd, 10.0) * 0.55 + pow(sd, 90.0) * 1.4) * smoothstep(-0.12, 0.02, h);
  // sun disc
  float disc = smoothstep(0.99983, 0.99991, dot(d, uSunDir));
  col += uSunDisc * disc;
  // moon disc with phase and soft glow
  float md = dot(d, uMoonDir);
  float starMask = 1.0;
  if (md > 0.995 && uMoonAlpha > 0.0) {
    vec3 mUp = normalize(cross(cross(uMoonDir, vec3(0.0, 1.0, 0.0)), uMoonDir));
    vec3 mRight = normalize(cross(uMoonDir, mUp));
    vec2 uv = vec2(dot(d - uMoonDir, mRight), dot(d - uMoonDir, mUp)) / 0.0105;
    float r = length(uv);
    if (r < 1.0) {
      float term = cos(uMoonPhase * 6.2831853);
      float x = uv.x / sqrt(max(1.0 - uv.y * uv.y, 1e-4));
      float lit = uMoonPhase < 0.5 ? smoothstep(term - 0.08, term + 0.08, x) : smoothstep(-term - 0.08, -term + 0.08, -x);
      float crater = 0.85 + 0.15 * sNoise(uv * 3.0 + 4.0);
      col = mix(col, uMoonColor * crater * (0.06 + 0.94 * lit), smoothstep(1.0, 0.94, r) * uMoonAlpha);
      starMask = 0.0;
    }
  }
  col += uMoonColor * 0.05 * pow(max(md, 0.0), 300.0) * uMoonAlpha;
  // clouds on a virtual plane
  float cloudA = 0.0;
  if (h > -0.02 && uCloudCover > 0.01) {
    vec2 p = d.xz / (max(h, 0.0) + 0.09) * 0.55 + uCloudOffset;
    float n = sFbm(p);
    float cov = smoothstep(1.0 - uCloudCover * 0.95, 1.0 - uCloudCover * 0.95 + 0.2, n + 0.1);
    float edge = smoothstep(0.0, 0.12, h + 0.02);
    cloudA = cov * edge;
    float n2 = sFbm(p + uSunDir.xz * 0.06);
    float lightSide = clamp((n - n2) * 4.0 + 0.55, 0.0, 1.0);
    vec3 cc = mix(uCloudShade, uCloudLit, lightSide);
    cc += uSunHalo * 1.2 * pow(sd, 6.0) * (1.0 - cov * 0.6);
    col = mix(col, cc, cloudA * 0.96);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // horizon band matches the scene fog exactly (same formula, display space)
  float band = 1.0 - smoothstep(-0.015, 0.14, h);
  vec3 fogCol = uFogColor + uSunFog * pow(sd, uSunFogExp);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, band);
  // alpha = how much the stars behind are hidden (custom blending: dst * (1 - a) + src)
  gl_FragColor.a = clamp(max(max(cloudA, band), 1.0 - starMask), 0.0, 1.0);
  gl_FragColor.rgb *= 1.0;
}`;

const STAR_VERTEX = /* glsl */`
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uPixelRatio;
varying float vTw;
varying float vH;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vH = normalize(wp.xyz - cameraPosition).y;
  vTw = 0.75 + 0.25 * sin(uTime * (1.3 + aPhase) + aPhase * 17.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_PointSize = aSize * uPixelRatio;
}`;

const STAR_FRAGMENT = /* glsl */`
uniform float uAlpha;
varying float vTw;
varying float vH;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.1, length(c)) * uAlpha * vTw * smoothstep(0.0, 0.18, vH);
  gl_FragColor = vec4(vec3(0.9, 0.93, 1.0) * a * 1.4, 1.0);
  #include <colorspace_fragment>
}`;

export class Sky {
  readonly dome: THREE.Mesh;
  readonly stars: THREE.Points;
  private readonly domeMat: THREE.ShaderMaterial;
  private readonly starMat: THREE.ShaderMaterial;
  private readonly radius: number;
  private cloudX = 0;
  private cloudZ = 0;

  constructor(radius: number) {
    this.radius = radius;
    this.domeMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      transparent: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3() }, uMoonDir: { value: new THREE.Vector3() },
        uSunDisc: { value: new THREE.Color() }, uSunHalo: { value: new THREE.Color() },
        uMoonColor: { value: new THREE.Color() }, uMoonPhase: { value: 0.5 }, uMoonAlpha: { value: 0 },
        uFogColor: { value: new THREE.Vector3() }, uSunFog: { value: new THREE.Vector3() }, uSunFogExp: { value: 8 },
        uCloudCover: { value: 0.3 }, uCloudLit: { value: new THREE.Color() }, uCloudShade: { value: new THREE.Color() },
        uCloudOffset: { value: new THREE.Vector2() }, uStarAlpha: { value: 0 }, uHorizonLift: { value: 0 },
      },
    });
    const geo = new THREE.SphereGeometry(1, 48, 24);
    this.dome = new THREE.Mesh(geo, this.domeMat);
    this.dome.scale.setScalar(radius);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.name = 'sky';

    // stars: deterministic positions on the unit sphere
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const phase = new Float32Array(n);
    let s = 1234567;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      pos[i * 3] = r * Math.cos(a); pos[i * 3 + 1] = u; pos[i * 3 + 2] = r * Math.sin(a);
      const m = rnd();
      size[i] = 1.0 + m * m * m * 2.6;
      phase[i] = rnd() * 3;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT.replace('varying vec3 vColor;', ''),
      uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 }, uPixelRatio: { value: 1 } },
      depthWrite: false, depthTest: false, transparent: false, blending: THREE.AdditiveBlending, fog: false,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.scale.setScalar(radius * 0.98);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1001;
    this.stars.name = 'stars';
  }

  /**
   * @param fogColorOut fog colour in the same space the scene fog uses this frame
   * @param sunFogOut   sun in-scatter colour in that space
   */
  update(atmo: AtmosphereState, camera: THREE.Camera, time: number, absDay: number, wind: THREE.Vector2,
    fogColorOut: THREE.Color, sunFogOut: THREE.Color, dt: number, pixelRatio: number): void {
    const u = this.domeMat.uniforms;
    // palette sky colours are display intents; scale before ACES so the zenith reads deep blue
    u.uTop.value.copy(atmo.skyTop).multiplyScalar(0.58);
    u.uHorizon.value.copy(atmo.skyHorizon).multiplyScalar(0.62);
    u.uSunDir.value.copy(atmo.sunDir);
    u.uMoonDir.value.copy(atmo.moonDir);
    u.uSunDisc.value.copy(atmo.sunDisc);
    u.uSunHalo.value.copy(atmo.sunHalo);
    u.uMoonColor.value.copy(atmo.moonColor);
    u.uMoonPhase.value = atmo.moonPhase;
    u.uMoonAlpha.value = atmo.moonAlpha;
    u.uFogColor.value.set(fogColorOut.r, fogColorOut.g, fogColorOut.b);
    u.uSunFog.value.set(sunFogOut.r, sunFogOut.g, sunFogOut.b);
    u.uSunFogExp.value = atmo.sunFogExponent;
    u.uCloudCover.value = atmo.cloudCover;
    u.uCloudLit.value.copy(atmo.cloudLit);
    u.uCloudShade.value.copy(atmo.cloudShade);
    this.cloudX += (wind.x * 0.00006 + 0.00002) * dt * 60;
    this.cloudZ += (wind.y * 0.00006 + 0.00001) * dt * 60;
    u.uCloudOffset.value.set(this.cloudX, this.cloudZ);
    u.uStarAlpha.value = atmo.starAlpha;
    // keep the horizon at eye level when the camera is very high (map view)
    const camY = camera.position.y;
    u.uHorizonLift.value = -Math.min(0.25, Math.max(0, camY - 300) / 60000);
    this.dome.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    this.stars.rotation.set(-0.9, 0, 0);
    this.stars.rotateY(absDay * Math.PI * 2);
    this.starMat.uniforms.uAlpha.value = atmo.starAlpha;
    this.starMat.uniforms.uTime.value = time;
    this.starMat.uniforms.uPixelRatio.value = pixelRatio;
    this.stars.visible = atmo.starAlpha > 0.002;
    void this.radius;
  }

  /** Cloud drift offset, shared with the ground cloud-shadow uniform. */
  cloudOffsetMetres(out: THREE.Vector2): THREE.Vector2 {
    return out.set(this.cloudX * 1400 / 0.55, this.cloudZ * 1400 / 0.55);
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    this.stars.geometry.dispose();
    this.starMat.dispose();
  }
}
