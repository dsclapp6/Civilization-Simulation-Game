// Hands-on work you can watch (docs/CIV.md §8, civilization pass): a bout is a few steps (`ActionOption.steps`, shares of its seconds); the
// body plays each step's animation and holds its items, and the work throws what it throws — the quenched blade steams, the hammer
// strikes sparks from hot iron or chips from stone and wood, the saw and the axe make chips, the pick and the spade raise dust, the fire
// burns and smokes. The sound cue of a step (`sfx`) is the UI's. Pure functions plus a small queue that feeds the view's FX.
import type { FxEvent, SimView } from '../core/view';
import type { ActionStep } from '../sim/actions';

/** Which step a bout is in at a progress (0..1), or null for a bout without steps. */
export function stepAt(steps: readonly ActionStep[] | undefined, progress: number): { index: number; step: ActionStep } | null {
  if (!steps || steps.length === 0) return null;
  const p = Math.max(0, Math.min(0.99999, progress));
  let acc = 0;
  for (let i = 0; i < steps.length; i++) {
    acc += steps[i].share;
    if (p < acc) return { index: i, step: steps[i] };
  }
  return { index: steps.length - 1, step: steps[steps.length - 1] };
}

export interface StepFx {
  kind: FxEvent['kind'];
  intensity: number;
  /** Seconds between puffs while the step lasts (the first is on entering it). */
  every: number;
  /** Metres above the feet the effect starts at. */
  height: number;
}

/** What a step throws up. */
export function fxOf(step: ActionStep): StepFx[] {
  const hot = step.mainHand === 'tongs' || step.offHand === 'tongs';
  switch (step.sfx) {
    case 'quench': return [{ kind: 'steam', intensity: 1, every: 0.55, height: 1.0 }];
    case 'hammer':
      return hot ? [{ kind: 'sparks', intensity: 0.9, every: 0.5, height: 1.0 }] : [{ kind: 'chips', intensity: 0.5, every: 0.7, height: 1.0 }];
    case 'bellows': return [{ kind: 'sparks', intensity: 0.4, every: 0.9, height: 0.9 }, { kind: 'smoke', intensity: 0.5, every: 1.2, height: 1.1 }];
    case 'fire': return [{ kind: 'fire', intensity: 0.7, every: 1.1, height: 0.8 }, { kind: 'smoke', intensity: 0.6, every: 1.3, height: 1.2 }];
    case 'grind': return [{ kind: 'sparks', intensity: 0.5, every: 0.45, height: 1.0 }];
    case 'dig': return [{ kind: 'dust', intensity: 0.8, every: 0.75, height: 0.15 }];
    case 'saw': case 'chop': return [{ kind: 'chips', intensity: 0.7, every: 0.6, height: 0.9 }];
    default: return [];
  }
}

const MAX_FX = 80;

/** A bounded queue of FX events the view hands to the renderer once a frame (the same way the combat module's queue does). */
export class StepFxQueue {
  private readonly items: FxEvent[] = [];

  add(kind: FxEvent['kind'], x: number, y: number, z: number, intensity: number): void {
    if (this.items.length >= MAX_FX) this.items.shift();
    this.items.push({ kind, x, y, z, intensity });
  }

  drain(into: FxEvent[]): void {
    for (const e of this.items) into.push(e);
    this.items.length = 0;
  }

  get size(): number { return this.items.length; }
}

/** Appends this queue to whatever already feeds the view's `drainFx` (other modules chain the same way: wrapping twice composes). */
export function chainStepFx(view: SimView, queue: StepFxQueue): void {
  const prev = view.drainFx.bind(view);
  const merged: FxEvent[] = [];
  view.drainFx = (): readonly FxEvent[] => {
    const base = prev();
    if (queue.size === 0) return base;
    merged.length = 0;
    for (let i = 0; i < base.length; i++) merged.push(base[i]);
    queue.drain(merged);
    return merged;
  };
}
