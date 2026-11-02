// Hands-on work (docs/CIV.md §8), pure: a bout of work is a short sequence of steps ("Heat the bar", "Draw it out", "Quench"),
// their shares of the bout adding to 1. Which step the bout is in, and which sound cues fall due as it moves from one to the next.
import type { ActionStep } from '../../sim/actions';
import { cueSound, type CueSound } from './soundModel';

export interface StepView {
  /** 0-based index of the step the bout is in. */
  index: number;
  count: number;
  step: ActionStep;
  label: string;
  /** Fractions of the bout at which this step begins and ends. */
  from: number;
  to: number;
  /** 0..1 within this step. */
  within: number;
}

/** The step a bout is in at `progress` (0..1). Shares are cumulative and read as proportions (a sum other than 1 is scaled). */
export function stepAt(steps: readonly ActionStep[] | undefined, progress: number): StepView | null {
  if (!steps || steps.length === 0) return null;
  const weights = steps.map((s) => (Number.isFinite(s.share) ? Math.max(0, s.share) : 0));
  let total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) { weights.fill(1); total = steps.length; }
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  let acc = 0;
  for (let i = 0; i < steps.length; i++) {
    const to = i === steps.length - 1 ? 1 : acc + weights[i] / total;
    if (p < to - 1e-9 || i === steps.length - 1) {
      return { index: i, count: steps.length, step: steps[i], label: steps[i].label, from: acc, to, within: to > acc ? Math.min(1, Math.max(0, (p - acc) / (to - acc))) : 1 };
    }
    acc = to;
  }
  return null;
}

/** Where each step ends as a fraction of the bout (the last is 1): the ticks on the progress bar. */
export function stepEnds(steps: readonly ActionStep[]): number[] {
  const weights = steps.map((s) => (Number.isFinite(s.share) ? Math.max(0, s.share) : 0));
  let total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) { weights.fill(1); total = steps.length; }
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < steps.length; i++) { acc += weights[i] / total; out.push(i === steps.length - 1 ? 1 : acc); }
  return out;
}

/** "Heat the bar · step 1 of 3" for the action bar. */
export function stepLine(v: StepView): string {
  return v.count > 1 ? `${v.label} · step ${v.index + 1} of ${v.count}` : v.label;
}

/**
 * Plays the cue of each step once as the bout enters it, and the strokes of the rhythmic ones (hammer, saw, chop…) while the step
 * lasts. Feed it every frame with the running option's id, its steps, the progress and a steady clock (seconds); it fills `out` with
 * the cues to sound now.
 */
export class CueScheduler {
  private key = '';
  private index = -1;
  private last = 0;
  private nextStroke = Infinity;
  private current: CueSound | null = null;

  reset(): void { this.key = ''; this.index = -1; this.last = 0; this.nextStroke = Infinity; this.current = null; }

  update(key: string, steps: readonly ActionStep[] | undefined, progress: number, now: number, out: CueSound[]): void {
    out.length = 0;
    const v = stepAt(steps, progress);
    if (!v) { this.reset(); return; }
    if (key !== this.key) { this.reset(); this.key = key; }
    // a bout that repeats starts again from the top: the progress falls back
    const restarted = progress < this.last - 0.4;
    this.last = progress;
    if (v.index !== this.index || restarted) {
      // entering a step
      this.index = v.index;
      this.current = cueSound(v.step.sfx);
      if (this.current) {
        out.push(this.current);
        this.nextStroke = this.current.period ? now + this.current.period : Infinity;
      } else this.nextStroke = Infinity;
      return;
    }
    if (this.current?.period && now >= this.nextStroke) {
      out.push(this.current);
      this.nextStroke = now + this.current.period;
    }
  }
}
