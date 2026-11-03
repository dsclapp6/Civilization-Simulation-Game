// The input layer's pure parts that the civilization pass added (docs/CIV.md §9): hold F to call your horse. A tap still mounts at once.
import { describe, expect, it } from 'vitest';
import { InputMapper } from '../../src/app/inputLogic';
import { INTERACT_HOLD_SECONDS, KEYMAP } from '../../src/player/types';

const keys = (down: string[] = [], pressed: string[] = [], released: string[] = []) => ({
  down: new Set(down), pressed: new Set(pressed), released: new Set(released),
});
const ctx = (riding = false) => ({ cameraYaw: 0, attack: false, block: false, riding });
const F = KEYMAP.input.mount;

describe('F: tap to mount, hold to call your horse', () => {
  it('a tap mounts on the frame it is pressed and never calls the horse', () => {
    const m = new InputMapper();
    const a = m.map(keys([F], [F]), ctx(), 0.016);
    expect(a.input.mount).toBe(true);
    expect(a.callHorse).toBe(false);
    const b = m.map(keys([], [], [F]), ctx(), 0.016);
    expect(b.input.mount).toBe(false);
    expect(b.callHorse).toBe(false);
  });

  it('holding it for the hold time calls the horse once', () => {
    const m = new InputMapper();
    const calls: number[] = [];
    let t = 0;
    for (let i = 0; i < 60; i++) {
      const out = m.map(keys([F], i === 0 ? [F] : []), ctx(), 0.02);
      t += 0.02;
      if (out.callHorse) calls.push(t);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(INTERACT_HOLD_SECONDS - 1e-9);
    expect(calls[0]).toBeLessThan(INTERACT_HOLD_SECONDS + 0.05);
  });

  it('calls again for the next hold, not while the key stays down', () => {
    const m = new InputMapper();
    let n = 0;
    const hold = (seconds: number): void => {
      for (let i = 0; i < seconds * 50; i++) if (m.map(keys([F], i === 0 ? [F] : []), ctx(), 0.02).callHorse) n++;
      m.map(keys([], [], [F]), ctx(), 0.02);
    };
    hold(1.2);
    expect(n).toBe(1);
    hold(0.2);
    expect(n).toBe(1);
    hold(0.6);
    expect(n).toBe(2);
  });

  it('does not call the horse for someone already riding, nor for a dismounting hold', () => {
    const m = new InputMapper();
    let calls = 0;
    // riding when F went down: the hold is a (slow) dismount, not a call
    for (let i = 0; i < 40; i++) if (m.map(keys([F], i === 0 ? [F] : []), ctx(true), 0.02).callHorse) calls++;
    // and one that has just mounted (the press mounted, riding from then on)
    m.map(keys([], [], [F]), ctx(false), 0.02);
    for (let i = 0; i < 40; i++) if (m.map(keys([F], i === 0 ? [F] : []), i === 0 ? ctx(false) : ctx(true), 0.02).callHorse) calls++;
    expect(calls).toBe(0);
  });

  it('forgets a hold when the keys are cleared (a panel opened, the window lost focus)', () => {
    const m = new InputMapper();
    for (let i = 0; i < 10; i++) m.map(keys([F], i === 0 ? [F] : []), ctx(), 0.02);
    m.clear();
    let calls = 0;
    // the key is still "down" in the browser but the mapper was cleared: a new press is needed
    for (let i = 0; i < 30; i++) if (m.map(keys([], [], []), ctx(), 0.02).callHorse) calls++;
    expect(calls).toBe(0);
  });
});

describe('first person facing', () => {
  it('passes the first-person flag through to the player input, and clears it', () => {
    const m = new InputMapper();
    expect(m.map(keys(), { ...ctx(), faceCamera: true }, 0.016).input.faceCamera).toBe(true);
    expect(m.map(keys(), ctx(), 0.016).input.faceCamera).toBe(false);
  });
});
