// Sound effects, made on the spot with the Web Audio API — no sound files. Each effect is a few oscillators and a burst
// of filtered noise shaped by a quick envelope: the swish of a scythe, the chop of an axe, a hammer's clank, coins, a
// level-up chime, the church bell, a soft click for the interface. Everything is quiet by default and follows the
// volume setting; browsers only allow sound after a click or key press, so the context wakes on the first one.
import type { SfxName } from '../core/soundModel';

type Ctx = AudioContext;

export class Sfx {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastAt = new Map<string, number>();
  /** 0..1 (the Volume setting). */
  volume = 0.7;

  /** Call from a click or key press: creates the audio context and wakes it up. */
  unlock(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch { /* no audio on this machine: the game is silent */ }
  }

  get ready(): boolean { return !!this.ctx && this.ctx.state === 'running'; }

  /** Plays an effect. `gain` 0..1 scales it; `pitch` is a frequency factor; `delay` seconds from now. */
  play(name: SfxName, gain = 1, pitch = 1, delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || ctx.state !== 'running' || this.volume <= 0.001 || gain <= 0.01) return;
    // the same effect is not stacked tighter than a few hundredths of a second
    const now = ctx.currentTime;
    const last = this.lastAt.get(name) ?? -1;
    if (now + delay - last < 0.04) return;
    this.lastAt.set(name, now + delay);
    this.master.gain.value = this.volume * this.volume * 0.55;
    const t = now + delay + 0.005;
    const g = Math.min(1, gain);
    try {
      switch (name) {
        case 'swish': this.swish(t, g, pitch); break;
        case 'chop': this.chop(t, g, pitch); break;
        case 'clank': this.clank(t, g, pitch, 880); break;
        case 'pick': this.clank(t, g, pitch, 560); break;
        case 'dig': this.dig(t, g, pitch); break;
        case 'saw': this.saw(t, g, pitch); break;
        case 'thud': this.dig(t, g * 0.8, pitch * 0.7); break;
        case 'coins': this.coins(t, g, pitch); break;
        case 'chime': this.chime(t, g, pitch); break;
        case 'ding': this.ding(t, g, pitch); break;
        case 'bell': this.bell(t, g, pitch); break;
        case 'click': this.tone(t, 1500 * pitch, 0.035, 0.12 * g, 'sine'); break;
      }
    } catch { /* a node failed: skip this sound */ }
  }

  // ---------------------------------------------------------------------------------------------

  private noiseBuffer(ctx: Ctx): AudioBuffer {
    if (!this.noise) {
      const len = Math.floor(ctx.sampleRate * 0.6);
      const b = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = b.getChannelData(0);
      // a fixed seed: the same hiss every time
      let s = 1234567;
      for (let i = 0; i < len; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = (s / 4294967296) * 2 - 1; }
      this.noise = b;
    }
    return this.noise;
  }

  private env(t: number, peak: number, attack: number, decay: number): GainNode {
    const ctx = this.ctx as Ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(this.master as GainNode);
    return g;
  }

  private tone(t: number, freq: number, dur: number, peak: number, type: OscillatorType, endFreq?: number): void {
    const ctx = this.ctx as Ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    o.connect(this.env(t, peak, 0.004, dur));
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private hiss(t: number, dur: number, peak: number, filter: BiquadFilterType, f0: number, f1: number, q = 1): void {
    const ctx = this.ctx as Ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    src.connect(f);
    f.connect(this.env(t, peak, Math.min(0.03, dur * 0.3), dur));
    src.start(t, Math.random() * 0.2);
    src.stop(t + dur + 0.05);
  }

  private swish(t: number, g: number, p: number): void { this.hiss(t, 0.26, 0.5 * g, 'bandpass', 700 * p, 2600 * p, 1.4); }

  private chop(t: number, g: number, p: number): void {
    this.hiss(t, 0.07, 0.6 * g, 'lowpass', 1800, 500);
    this.tone(t, 170 * p, 0.16, 0.7 * g, 'sine', 62 * p);
    this.tone(t + 0.012, 420 * p, 0.05, 0.2 * g, 'triangle', 220);
  }

  private clank(t: number, g: number, p: number, base: number): void {
    for (const [ratio, peak, dur] of [[1, 0.34, 0.38], [1.51, 0.26, 0.28], [2.42, 0.16, 0.18], [3.9, 0.08, 0.1]] as const) {
      this.tone(t, base * ratio * p * (1 + (Math.random() - 0.5) * 0.01), dur, peak * g, ratio < 2 ? 'triangle' : 'sine');
    }
    this.hiss(t, 0.03, 0.4 * g, 'highpass', 3000, 6000);
  }

  private dig(t: number, g: number, p: number): void {
    this.hiss(t, 0.16, 0.55 * g, 'lowpass', 420 * p, 160, 0.8);
    this.tone(t, 110 * p, 0.14, 0.5 * g, 'sine', 52 * p);
  }

  private saw(t: number, g: number, p: number): void {
    for (let i = 0; i < 3; i++) this.hiss(t + i * 0.1, 0.09, 0.22 * g, 'bandpass', 1500 * p + i * 150, 2400 * p, 3);
  }

  private coins(t: number, g: number, p: number): void {
    [1760, 2349, 2093, 2637].forEach((f, i) => this.tone(t + i * 0.065, f * p, 0.28, 0.2 * g, 'sine'));
    this.hiss(t, 0.05, 0.12 * g, 'highpass', 5000, 8000);
  }

  private chime(t: number, g: number, p: number): void {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(t + i * 0.11, f * p, 0.9, 0.22 * g, 'triangle');
      this.tone(t + i * 0.11, f * 2 * p, 0.5, 0.06 * g, 'sine');
    });
  }

  private ding(t: number, g: number, p: number): void {
    this.tone(t, 784 * p, 0.5, 0.22 * g, 'sine');
    this.tone(t + 0.12, 1175 * p, 0.7, 0.2 * g, 'sine');
  }

  private bell(t: number, g: number, p: number): void {
    // a struck bell: inharmonic partials that die away slowly, the low ones longest
    const base = 196 * p;
    for (const [ratio, peak, dur] of [[1, 0.5, 3.6], [2, 0.32, 2.8], [2.76, 0.26, 2.2], [5.4, 0.12, 1.4], [8.93, 0.06, 0.8]] as const) {
      this.tone(t, base * ratio, dur, peak * g, 'sine');
    }
    this.hiss(t, 0.05, 0.25 * g, 'bandpass', 2000, 900, 2);
  }
}
