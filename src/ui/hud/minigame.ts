// Work mini-games: every bout of work is played, not watched. While a timed task runs (the forge, the furrow, the
// saw, a wound to bind, the butts), a small game sits above the action bar and the keys play it:
//   rhythm  — the hammer, the saw, the axe, the pick, the hoe, the spade, the dough: strike (J) as the needle
//             crosses the gold. Forging a blade, felling a tree, digging a bed.
//   sow     — seed and cover: the furrow asks for J (drop the seed) or K (cover it) — keep up with it.
//   steady  — a wound to bind, a pot to stir, a thread to spin: hold J to lift the needle and keep it in the band
//             as it drifts.
//   aim     — the bow: hold J to draw (the aim steadies as the string comes back), let go on the mark.
// Each stroke is scored 0..1 and given to the action runner (`sim.actions.perform`): good strokes finish the bout
// sooner, and the bout's mean is the worker's hand — more experience, a better piece, a better-bound wound. Not
// playing is no worse than before. The logic (`MiniLogic`) is pure, for the tests; `MiniGameView` draws it.
import { h } from '../core/dom';
import { keycap } from '../components/widgets';

export type MiniKind = 'rhythm' | 'sow' | 'steady' | 'aim';

/** Which game a bout plays, from its option id and animation (null: nothing to play — rest, talk, waiting). */
export function miniKindOf(id: string, anim: string): MiniKind | null {
  if (!id || /^(recuperate|sleep|rest|wait|pray|talk|eat|read|wounds)/.test(id) || /\.(wait|hire_on)$/.test(id)) return null;
  if (/bow|crossbow/.test(anim) || id === 'arms.practise') return 'aim';
  if (id === 'tend' || id === 'bind' || anim === 'kneel' || anim === 'work_stir' || anim === 'work_spin') return 'steady';
  if (/(^|\.)(sow|plant|seed)/.test(id)) return 'sow';
  if (anim.startsWith('work_') || anim.startsWith('attack_')) return 'rhythm';
  return null;
}

export const MINI_TITLE: Record<MiniKind, string> = {
  rhythm: 'Strike on the gold',
  sow: 'Seed and cover',
  steady: 'Keep a steady hand',
  aim: 'Draw, aim, loose',
};

/** A tiny deterministic generator (the game's look, not the simulation: no sim RNG is touched). */
function lcg(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export interface Stroke { score: number; word: string }

/** The pure state of one bout's game. `update` and the key calls return the strokes made (to hand to the runner). */
export class MiniLogic {
  t = 0;
  /** rhythm: the needle 0..1 and the gold band's centre and half-width. */
  needle = 0;
  dir = 1;
  band = 0.5;
  half = 0.09;
  /** sow: the key asked for and how long it has been asked. */
  want: 'J' | 'K' = 'J';
  asked = 0;
  /** steady: the needle (held up by J) and the drifting band. */
  level = 0.5;
  held = false;
  tick = 0;
  /** aim: how far the string is drawn and the reticle's offset from the mark. */
  draw = 0;
  aimX = 0;
  aimY = 0;
  last: Stroke | null = null;
  strokes = 0;
  total = 0;
  private readonly rnd: () => number;

  constructor(readonly kind: MiniKind, seed = 1, readonly speed = 1) {
    this.rnd = lcg(seed);
    this.band = 0.2 + this.rnd() * 0.6;
    this.want = this.rnd() < 0.5 ? 'J' : 'K';
  }

  /** The mean of the strokes so far (−1 before the first). */
  get mean(): number { return this.strokes ? this.total / this.strokes : -1; }

  private stroke(score: number): Stroke {
    const s = Math.max(0, Math.min(1, score));
    const word = s >= 0.95 ? 'Perfect!' : s >= 0.6 ? 'Good' : s > 0.2 ? 'Rough' : 'Miss';
    this.last = { score: s, word };
    this.strokes++; this.total += s;
    return this.last;
  }

  /** The steady band's centre at time `t` (two slow waves: it wanders, it does not jump). */
  steadyBand(t = this.t): number { return 0.5 + 0.28 * Math.sin(t * 0.9 * this.speed) + 0.12 * Math.sin(t * 2.3 * this.speed + 1.3); }

  update(dt: number): Stroke[] {
    const out: Stroke[] = [];
    this.t += dt;
    switch (this.kind) {
      case 'rhythm': {
        // the needle sweeps there and back in about 1.4 s (faster for the practised hand)
        this.needle += this.dir * dt * 1.45 * this.speed;
        if (this.needle >= 1) { this.needle = 2 - this.needle; this.dir = -1; }
        if (this.needle <= 0) { this.needle = -this.needle; this.dir = 1; }
        break;
      }
      case 'sow': {
        this.asked += dt;
        if (this.asked > 1.6 / this.speed) { out.push(this.stroke(0)); this.next(); }
        break;
      }
      case 'steady': {
        this.level = Math.max(0, Math.min(1, this.level + (this.held ? 0.55 : -0.5) * dt));
        this.tick += dt;
        if (this.tick >= 0.5) {
          this.tick -= 0.5;
          const off = Math.abs(this.level - this.steadyBand());
          out.push(this.stroke(off <= 0.1 ? 1 : Math.max(0, 1 - (off - 0.1) * 4)));
        }
        break;
      }
      case 'aim': {
        if (this.held) this.draw = Math.min(1, this.draw + dt * 1.1);
        // the reticle sways less the further the string is drawn, and less again with a steady eye
        const sway = 0.55 - 0.35 * this.draw;
        this.aimX = sway * Math.sin(this.t * 1.7 * this.speed);
        this.aimY = sway * 0.7 * Math.sin(this.t * 2.6 * this.speed + 0.8);
        break;
      }
    }
    return out;
  }

  private next(): void { this.want = this.rnd() < 0.5 ? 'J' : 'K'; this.asked = 0; }

  /** A key goes down ('J' the stroke, 'K' the second key). */
  press(key: 'J' | 'K'): Stroke[] {
    switch (this.kind) {
      case 'rhythm': {
        if (key !== 'J') return [];
        const off = Math.abs(this.needle - this.band);
        const s = this.stroke(off <= 0.03 ? 1 : off <= this.half ? 0.75 : off <= this.half * 1.8 ? 0.3 : 0);
        this.band = 0.15 + this.rnd() * 0.7;
        return [s];
      }
      case 'sow': {
        const s = this.stroke(key === this.want ? Math.max(0.5, 1 - this.asked * 0.35) : 0);
        this.next();
        return [s];
      }
      case 'steady': if (key === 'J') this.held = true; return [];
      case 'aim': if (key === 'J') this.held = true; return [];
    }
  }

  /** A key comes up: the steady hand drops, the bow looses. */
  release(key: 'J' | 'K'): Stroke[] {
    if (key !== 'J') return [];
    if (this.kind === 'steady') { this.held = false; return []; }
    if (this.kind === 'aim' && this.held) {
      this.held = false;
      const d = Math.hypot(this.aimX, this.aimY);
      const drawn = this.draw;
      this.draw = 0;
      // an underdrawn shaft falls short; a full draw on the mark is the gold
      return [this.stroke(drawn < 0.6 ? 0.1 : Math.max(0, 1 - d / 0.4) * (0.6 + 0.4 * drawn))];
    }
    return [];
  }
}

/** The mini-game card above the action bar. */
export class MiniGameView {
  readonly el = h('div.mu-mini.mu-hide');
  private readonly title = h('div.mu-mini-title');
  private readonly stage = h('div.mu-mini-stage');
  private readonly word = h('div.mu-mini-word');
  private readonly help = h('div.mu-mini-help');
  private logic: MiniLogic | null = null;
  private key = '';
  private wordTtl = 0;
  // parts of the stage (made once per kind)
  private needleEl: HTMLElement | null = null;
  private bandEl: HTMLElement | null = null;
  private keyEl: HTMLElement | null = null;
  private timerEl: HTMLElement | null = null;
  private reticleEl: HTMLElement | null = null;
  private drawEl: HTMLElement | null = null;

  constructor(private readonly onStroke: (score: number) => void) {
    this.el.append(this.title, this.stage, this.word, this.help);
    // the card can be played with the mouse too: press and release on it
    this.el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.press('J'); });
    this.el.addEventListener('pointerup', (e) => { e.preventDefault(); e.stopPropagation(); this.release('J'); });
  }

  get active(): boolean { return this.logic !== null; }
  get mean(): number { return this.logic?.mean ?? -1; }

  /** Each frame: the bout running (or null), the time step, the worker's skill level (0..20: a practised hand gets a faster game). */
  update(action: { id?: string; anim?: string; label: string; step?: { label: string } } | null, dt: number, level = 0): void {
    const kind = action ? miniKindOf(action.id ?? '', action.anim ?? '') : null;
    const key = action && kind ? `${action.id}|${kind}` : '';
    if (key !== this.key) {
      this.key = key;
      this.logic = kind ? new MiniLogic(kind, hashStr(key) + Math.floor(performance.now()), 0.85 + Math.min(20, level) * 0.02) : null;
      this.el.classList.toggle('mu-hide', !kind);
      if (kind) this.build(kind);
    }
    const L = this.logic;
    if (!L) return;
    this.title.textContent = `${MINI_TITLE[L.kind]}${action?.step ? ` — ${action.step.label}` : ''}`;
    for (const s of L.update(Math.min(0.1, dt))) this.give(s);
    this.draw(L);
    if (this.wordTtl > 0) { this.wordTtl -= dt; if (this.wordTtl <= 0) this.word.textContent = ''; }
  }

  press(key: 'J' | 'K'): boolean {
    if (!this.logic) return false;
    for (const s of this.logic.press(key)) this.give(s);
    return true;
  }

  release(key: 'J' | 'K'): boolean {
    if (!this.logic) return false;
    for (const s of this.logic.release(key)) this.give(s);
    return true;
  }

  private give(s: Stroke): void {
    this.onStroke(s.score);
    // the steady hand scores every half second: only a slip is worth a word
    if (this.logic?.kind === 'steady' && s.score >= 0.6) return;
    this.word.textContent = s.word;
    this.word.className = `mu-mini-word ${s.score >= 0.95 ? 'perfect' : s.score >= 0.6 ? 'good' : 'miss'}`;
    this.wordTtl = 0.8;
  }

  private build(kind: MiniKind): void {
    this.needleEl = this.bandEl = this.keyEl = this.timerEl = this.reticleEl = this.drawEl = null;
    this.stage.className = `mu-mini-stage ${kind}`;
    if (kind === 'rhythm' || kind === 'steady') {
      this.bandEl = h('div.mu-mini-band');
      this.needleEl = h('div.mu-mini-needle');
      this.stage.replaceChildren(h('div.mu-mini-track', null, this.bandEl, this.needleEl));
      this.help.replaceChildren(kind === 'rhythm' ? keycap('J') : keycap('J'), kind === 'rhythm' ? ' strike as the needle crosses the gold' : ' hold to lift — keep it in the band');
    } else if (kind === 'sow') {
      this.keyEl = h('div.mu-mini-key');
      this.timerEl = h('div.mu-mini-timer');
      this.stage.replaceChildren(this.keyEl, h('div.mu-mini-track', null, this.timerEl));
      this.help.replaceChildren(keycap('J'), ' drop the seed · ', keycap('K'), ' cover it — as the furrow asks');
    } else {
      this.reticleEl = h('div.mu-mini-reticle');
      this.drawEl = h('div.mu-mini-draw');
      this.stage.replaceChildren(h('div.mu-mini-target', null, h('div.mu-mini-ring'), this.reticleEl), h('div.mu-mini-track', null, this.drawEl));
      this.help.replaceChildren(keycap('J'), ' hold to draw, let go on the mark');
    }
    this.word.textContent = '';
  }

  private draw(L: MiniLogic): void {
    const pc = (v: number): string => `${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%`;
    if (L.kind === 'rhythm' && this.bandEl && this.needleEl) {
      this.bandEl.style.left = pc(L.band - L.half); this.bandEl.style.width = pc(L.half * 2);
      this.needleEl.style.left = pc(L.needle);
    } else if (L.kind === 'steady' && this.bandEl && this.needleEl) {
      const c = L.steadyBand();
      this.bandEl.style.left = pc(c - 0.1); this.bandEl.style.width = pc(0.2);
      this.needleEl.style.left = pc(L.level);
    } else if (L.kind === 'sow' && this.keyEl && this.timerEl) {
      this.keyEl.textContent = L.want === 'J' ? 'J · seed' : 'K · cover';
      this.timerEl.style.width = pc(1 - L.asked / (1.6 / L.speed));
    } else if (L.kind === 'aim' && this.reticleEl && this.drawEl) {
      this.reticleEl.style.transform = `translate(${(L.aimX * 60).toFixed(1)}px, ${(L.aimY * 60).toFixed(1)}px)`;
      this.drawEl.style.width = pc(L.draw);
    }
  }
}

function hashStr(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x >>> 0;
}
