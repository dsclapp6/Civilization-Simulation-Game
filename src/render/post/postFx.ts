// High-quality post chain: HDR render (MSAA) → subtle bloom → colour grade + vignette → output
// (ACES tone mapping + sRGB happen in OutputPass from the renderer settings).
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const GradeShader = {
  name: 'MillenniaGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.32 },
    uWarmth: { value: 0.0 },
    uSaturation: { value: 1.06 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uWarmth;
    uniform float uSaturation;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSaturation);
      c.rgb *= vec3(1.0 + uWarmth, 1.0, 1.0 - uWarmth);
      vec2 d = vUv - 0.5;
      float v = 1.0 - uVignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      gl_FragColor = vec4(c.rgb * v, c.a);
    }`,
};

export class PostFx {
  readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private readonly output: OutputPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
    const rt = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), 0.28, 0.55, 0.92);
    this.grade = new ShaderPass(GradeShader);
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.grade);
    this.composer.addPass(this.output);
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
  }

  update(dusk: number, night: number): void {
    this.grade.uniforms.uWarmth.value = dusk * 0.035 - night * 0.02;
    this.grade.uniforms.uSaturation.value = 1.05 + dusk * 0.06 - night * 0.08;
    this.bloom.strength = 0.22 + night * 0.25 + dusk * 0.08;
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  dispose(): void {
    this.bloom.dispose();
    this.grade.dispose?.();
    this.output.dispose();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer.dispose();
  }
}
