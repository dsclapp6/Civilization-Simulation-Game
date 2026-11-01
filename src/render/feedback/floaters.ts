// Floating texts (SimView.drainFloaters): gains, losses, skill points and opinion changes rise from the
// work spot and fade ("+3 sheaves", "Farming +6", "−4d", "♥ +3"); a level-up ("Farming 3!") is bigger and
// lingers. Each text is drawn once into a small canvas and shown as a screen-sized sprite in an overlay
// pass after the scene (crisp tone colours with a dark outline, readable on sky, field or wall, never
// fogged, bloomed or hidden behind the body that earned it). Texts spawned at the same spot queue up so
// they rise one after another instead of piling on top of each other.
import * as THREE from 'three';
import type { FloatText } from '../../core/view';

const POOL = 24;
const CANVAS_W = 512;
const CANVAS_H = 96;
/** Screen height of an ordinary floater's canvas (px; the glyphs are about half of it). */
const PX = 46;
const PX_BIG = 64;
const LIFE = 2.3;
const LIFE_BIG = 3.4;
/** Rise over a lifetime (m). */
const RISE = 1.35;
/** Texts from one spot within this many seconds form a stack (one line above the other, popping in turn). */
const GROUP_S = 0.7;
const STAGGER = 0.14;
/** Line spacing of a stack, in sprite heights. */
const LINE = 0.58;
const MAX_DIST = 90;

interface Tone { fill: string; stroke: string; glow?: string }
const TONES: Record<FloatText['tone'] | 'heart' | 'heartLoss' | 'level', Tone> = {
  gain: { fill: '#ffd76e', stroke: '#2b1a06' },
  loss: { fill: '#ff8f7a', stroke: '#2e0b06' },
  skill: { fill: '#bfe3ff', stroke: '#0b1828' },
  info: { fill: '#f6ecd2', stroke: '#1d150c' },
  heart: { fill: '#ffa3b8', stroke: '#2e0812' },
  heartLoss: { fill: '#d97a8c', stroke: '#24060c' },
  level: { fill: '#ffe08a', stroke: '#2b1a06', glow: 'rgba(255, 196, 64, 0.85)' },
};

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Floater {
  sprite: THREE.Sprite;
  ctx: Ctx2D | null;
  tex: THREE.Texture;
  mat: THREE.SpriteMaterial;
  x: number; y: number; z: number;
  /** Seconds since spawn (negative while queued). */
  age: number;
  life: number;
  big: boolean;
  active: boolean;
  /** Line in its stack (0 = bottom). */
  line: number;
}

/** A canvas texture to draw a text into (none in a headless test: the layout logic still runs). */
function makeTexture(): { tex: THREE.Texture; ctx: Ctx2D | null } {
  let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = CANVAS_W; c.height = CANVAS_H;
    canvas = c;
  } else if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
  const ctx = canvas ? (canvas.getContext('2d') as Ctx2D | null) : null;
  const tex = canvas && ctx ? new THREE.CanvasTexture(canvas as HTMLCanvasElement) : new THREE.Texture();
  return { tex, ctx };
}

/** Pick the look of a floater from its tone and text. */
export function floaterStyle(f: Pick<FloatText, 'text' | 'tone'>): { tone: Tone; big: boolean } {
  const big = /!\s*$/.test(f.text);
  if (big) return { tone: TONES.level, big };
  if (f.text.includes('♥')) return { tone: f.tone === 'loss' ? TONES.heartLoss : TONES.heart, big };
  return { tone: TONES[f.tone] ?? TONES.info, big };
}

export class FloaterLayer {
  /** Drawn in an overlay pass after the scene (see GameRenderer). */
  readonly scene = new THREE.Scene();
  private readonly pool: Floater[] = [];
  private readonly recent: { x: number; y: number; z: number; t: number }[] = [];
  private time = 0;
  /** Active floaters this frame (stats/tests). */
  active = 0;
  /** CPU time of the last update (ms). */
  lastMs = 0;

  constructor() {
    this.scene.name = 'floaters';
    for (let i = 0; i < POOL; i++) {
      const { tex, ctx } = makeTexture();
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.anisotropy = 2;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false, sizeAttenuation: false });
      const sprite = new THREE.Sprite(mat);
      sprite.center.set(0.5, 0);
      sprite.visible = false;
      sprite.renderOrder = 20;
      sprite.frustumCulled = false;
      this.scene.add(sprite);
      this.pool.push({ sprite, ctx, tex, mat, x: 0, y: 0, z: 0, age: 0, life: LIFE, big: false, active: false, line: 0 });
    }
  }

  /** Queue new texts (from view.drainFloaters()). Too far from the camera = dropped. */
  spawn(list: readonly FloatText[], camera: THREE.Camera): void {
    const cp = camera.position;
    for (const f of list) {
      if (!f.text) continue;
      if ((f.x - cp.x) ** 2 + (f.y - cp.y) ** 2 + (f.z - cp.z) ** 2 > MAX_DIST * MAX_DIST) continue;
      let slot = this.pool.find((p) => !p.active);
      if (!slot) {
        // recycle the oldest
        slot = this.pool.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
      }
      // texts from one spot stack up, one line above the other, popping in turn; the stack rises as one
      let line = 0, anchor: { x: number; y: number; z: number; t: number } | null = null;
      for (const r of this.recent) {
        if ((r.x - f.x) ** 2 + (r.z - f.z) ** 2 < 2.5 * 2.5 && this.time - r.t < GROUP_S) {
          line++;
          anchor ??= r;
        }
      }
      if (!anchor) this.recent.push({ x: f.x, y: f.y, z: f.z, t: this.time });
      else this.recent.push({ ...anchor });
      const { tone, big } = floaterStyle(f);
      this.draw(slot, f.text, tone, big);
      const at = anchor ?? f;
      slot.x = at.x; slot.y = at.y; slot.z = at.z;
      slot.age = -line * STAGGER;
      // the whole stack fades out together, on the first line's clock
      slot.life = (big ? LIFE_BIG : LIFE) - line * STAGGER;
      slot.big = big;
      slot.line = line;
      slot.active = true;
      slot.sprite.visible = false;
    }
  }

  private draw(p: Floater, text: string, tone: Tone, big: boolean): void {
    const ctx = p.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    const size = big ? 58 : 50;
    ctx.font = `600 ${size}px Georgia, "Palatino Linotype", "Times New Roman", serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let w = ctx.measureText(text).width;
    // shrink long texts to fit the canvas
    const maxW = CANVAS_W - 28;
    if (w > maxW) {
      const s = size * (maxW / w);
      ctx.font = `600 ${s.toFixed(1)}px Georgia, "Palatino Linotype", "Times New Roman", serif`;
      w = maxW;
    }
    const cx = CANVAS_W / 2, cy = CANVAS_H / 2 + 2;
    if (tone.glow) {
      ctx.shadowColor = tone.glow;
      ctx.shadowBlur = 18;
      ctx.fillStyle = tone.fill;
      ctx.fillText(text, cx, cy);
      ctx.shadowBlur = 0;
    }
    ctx.lineJoin = 'round';
    ctx.lineWidth = big ? 11 : 10;
    ctx.strokeStyle = tone.stroke;
    ctx.globalAlpha = 0.9;
    ctx.strokeText(text, cx, cy);
    ctx.globalAlpha = 1;
    ctx.fillStyle = tone.fill;
    ctx.fillText(text, cx, cy);
    p.tex.needsUpdate = true;
  }

  /** Advance, place and fade. `viewportHeight` in CSS px, camera fov drives the screen-size scale. */
  update(dt: number, camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    const t0 = performance.now();
    this.time += dt;
    for (let i = this.recent.length - 1; i >= 0; i--) if (this.time - this.recent[i].t > GROUP_S) this.recent.splice(i, 1);
    const k = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight);
    let n = 0;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) { p.active = false; p.sprite.visible = false; continue; }
      if (p.age < 0) { p.sprite.visible = false; continue; }
      n++;
      // the stack rises together: each line keeps to the clock of the stack's first text
      const t = p.age + p.line * STAGGER;
      const u = Math.min(1, t / (p.big ? LIFE_BIG : LIFE));
      // ease out: quick lift, slow drift; fade in fast, hold, fade out
      const rise = RISE * (1 - Math.pow(1 - u, 2.2)) * (p.big ? 1.15 : 1);
      p.sprite.position.set(p.x, p.y + 0.15 + rise, p.z);
      // lines above the first: a screen-space offset in sprite heights
      p.sprite.center.y = -p.line * LINE * (p.big ? 0.75 : 1);
      const fadeIn = Math.min(1, p.age / 0.12);
      const fadeOut = 1 - Math.max(0, (u - 0.62) / 0.38);
      p.mat.opacity = fadeIn * fadeOut * fadeOut;
      // pop: a level-up swells a little as it appears
      const pop = p.big ? 1 + 0.25 * Math.max(0, 1 - p.age / 0.25) : 1 + 0.12 * Math.max(0, 1 - p.age / 0.15);
      const h = (p.big ? PX_BIG : PX) * k * pop;
      p.sprite.scale.set(h * (CANVAS_W / CANVAS_H), h, 1);
      p.sprite.visible = true;
    }
    this.active = n;
    this.lastMs = performance.now() - t0;
  }

  clear(): void {
    for (const p of this.pool) { p.active = false; p.sprite.visible = false; }
    this.recent.length = 0;
  }

  dispose(): void {
    for (const p of this.pool) { p.tex.dispose(); p.mat.dispose(); }
    this.scene.clear();
  }
}
