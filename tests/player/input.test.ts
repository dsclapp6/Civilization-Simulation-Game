import { describe, expect, it } from 'vitest';
import { InputMapper, InteractTracker, commandRefusal, mouseLook } from '../../src/app/inputLogic';
import { readSettings, writeSettings, qualityParam } from '../../src/app/settings';
import { INTERACT_HOLD_SECONDS, KEYMAP } from '../../src/player/types';
import { newProfile } from '../../src/sim/legacy';
import { DEFAULT_SETTINGS } from '../../src/ui/types';

const keys = (down: string[] = [], pressed: string[] = [], released: string[] = []) => ({
  down: new Set(down), pressed: new Set(pressed), released: new Set(released),
});
const ctx = { cameraYaw: 0.5, attack: false, block: false };

describe('movement keys', () => {
  it('maps WASD and the arrows to forward/right and shift to sprint', () => {
    const m = new InputMapper();
    let i = m.map(keys(['KeyW']), ctx, 0.016).input;
    expect([i.forward, i.right, i.sprint]).toEqual([1, 0, false]);
    i = m.map(keys(['KeyS', 'KeyD', 'ShiftLeft']), ctx, 0.016).input;
    expect([i.forward, i.right, i.sprint]).toEqual([-1, 1, true]);
    i = m.map(keys(['ArrowUp', 'ArrowLeft']), ctx, 0.016).input;
    expect([i.forward, i.right]).toEqual([1, -1]);
    i = m.map(keys(['KeyW', 'KeyS']), ctx, 0.016).input;
    expect(i.forward).toBe(0);
    expect(i.cameraYaw).toBe(0.5);
  });

  it('toggles the slow walk with X and keeps it until toggled again', () => {
    const m = new InputMapper();
    expect(m.map(keys([]), ctx, 0.016).input.walk).toBe(false);
    expect(m.map(keys([], [KEYMAP.input.walk]), ctx, 0.016).input.walk).toBe(true);
    expect(m.map(keys(['KeyW']), ctx, 0.016).input.walk).toBe(true);
    expect(m.map(keys([], [KEYMAP.input.walk]), ctx, 0.016).input.walk).toBe(false);
  });

  it('passes mouse buttons through as attack and block', () => {
    const m = new InputMapper();
    const i = m.map(keys(), { cameraYaw: 0, attack: true, block: true }, 0.016).input;
    expect(i.attack).toBe(true);
    expect(i.block).toBe(true);
  });
});

describe('edge keys', () => {
  it('reports mount, dodge and cancel on the frame they are pressed only', () => {
    const m = new InputMapper();
    const a = m.map(keys(['KeyF'], ['KeyF', 'Space', 'KeyQ']), ctx, 0.016).input;
    expect([a.mount, a.dodge, a.cancel]).toEqual([true, true, true]);
    const b = m.map(keys(['KeyF']), ctx, 0.016).input;
    expect([b.mount, b.dodge, b.cancel]).toEqual([false, false, false]);
  });

  it('speed keys and pause become intents', () => {
    const m = new InputMapper();
    expect(m.map(keys([], ['Digit1']), ctx, 0.016).speed).toBe(1);
    expect(m.map(keys([], ['Digit2']), ctx, 0.016).speed).toBe(3);
    expect(m.map(keys([], ['Digit3']), ctx, 0.016).speed).toBe(8);
    expect(m.map(keys(), ctx, 0.016).speed).toBeNull();
    expect(m.map(keys([], ['KeyP']), ctx, 0.016).togglePause).toBe(true);
    expect(m.map(keys(), ctx, 0.016).togglePause).toBe(false);
  });
});

describe('interact: tap versus hold', () => {
  const out = { tap: false, openWheel: false, held: 0 };

  it('a quick press and release is a tap; the wheel stays shut', () => {
    const t = new InteractTracker();
    t.update(true, true, false, 0.016, out);
    expect(out.tap).toBe(false);
    expect(out.held).toBeCloseTo(0.016);
    t.update(false, false, true, 0.016, out);
    expect(out.tap).toBe(true);
    expect(out.openWheel).toBe(false);
    expect(out.held).toBe(0);
  });

  it('a press and release between two frames is still a tap', () => {
    const t = new InteractTracker();
    t.update(false, true, true, 0.016, out);
    expect(out.tap).toBe(true);
  });

  it(`holding for ${INTERACT_HOLD_SECONDS} s opens the wheel once and releasing then does not tap`, () => {
    const t = new InteractTracker();
    t.update(true, true, false, 0.016, out);
    let opened = 0;
    let time = 0.016;
    while (time < 1) {
      t.update(true, false, false, 0.016, out);
      time += 0.016;
      if (out.openWheel) { opened++; expect(time).toBeGreaterThanOrEqual(INTERACT_HOLD_SECONDS); }
      expect(out.tap).toBe(false);
    }
    expect(opened).toBe(1);
    expect(out.held).toBeGreaterThan(0.9);
    t.update(false, false, true, 0.016, out);
    expect(out.tap).toBe(false);
  });

  it('is armed again after a hold, and forgets everything on reset', () => {
    const t = new InteractTracker();
    t.update(true, true, false, 0.5, out);
    expect(out.openWheel).toBe(true);
    t.update(true, false, false, 0.5, out);
    expect(out.openWheel).toBe(false);
    t.update(false, false, true, 0.016, out);
    t.update(false, true, true, 0.016, out);
    expect(out.tap).toBe(true);
    t.update(true, true, false, 0.2, out);
    t.reset();
    t.update(false, false, true, 0.016, out);
    expect(out.tap).toBe(false);
  });

  it('feeds interactHeld to the player through the mapper', () => {
    const m = new InputMapper();
    let r = m.map(keys(['KeyE'], ['KeyE']), ctx, 0.2);
    expect(r.input.interactHeld).toBeCloseTo(0.2);
    r = m.map(keys(['KeyE']), ctx, 0.2);
    expect(r.openWheel).toBe(true);
    expect(r.input.interactHeld).toBeGreaterThanOrEqual(INTERACT_HOLD_SECONDS);
    expect(r.input.interact).toBe(false);
    r = m.map(keys([], [], ['KeyE']), ctx, 0.016);
    expect(r.input.interact).toBe(false);
    r = m.map(keys(['KeyE'], ['KeyE'], ['KeyE']), ctx, 0.016);
    expect(r.input.interact).toBe(true);
  });

  it('clear drops held state', () => {
    const m = new InputMapper();
    m.map(keys(['KeyE'], ['KeyE']), ctx, 0.2);
    m.clear();
    const r = m.map(keys([], [], ['KeyE']), ctx, 0.016);
    expect(r.input.interact).toBe(false);
  });
});

describe('mouse look and refusals', () => {
  it('turns right when the mouse moves right and pitches with the mouse, invertible', () => {
    const l = mouseLook(100, 50, 1, false);
    expect(l.yaw).toBeLessThan(0);
    expect(l.pitch).toBeGreaterThan(0);
    expect(mouseLook(100, 50, 1, true).pitch).toBeLessThan(0);
    expect(Math.abs(mouseLook(100, 0, 2, false).yaw)).toBeCloseTo(Math.abs(l.yaw) * 2, 6);
  });

  it('puts the sim\'s refusals in plain words', () => {
    expect(commandRefusal('too dangerous to hurry')).toMatch(/enemy is near/);
    expect(commandRefusal('not during action')).toMatch(/middle of something/);
    expect(commandRefusal('something odd')).toBe('something odd');
    expect(commandRefusal(undefined)).toBe('Not now.');
  });
});

describe('settings persistence', () => {
  it('reads defaults from an empty profile and validates what is stored', () => {
    const p = newProfile();
    expect(readSettings(p)).toEqual(DEFAULT_SETTINGS);
    p.settings = { quality: 'ultra', mouseSensitivity: 99, invertY: 'yes', volume: -3, labels: false, uiScale: 1.2, unknown: 5 };
    const s = readSettings(p);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.mouseSensitivity).toBe(4);
    expect(s.invertY).toBe(DEFAULT_SETTINGS.invertY);
    expect(s.volume).toBe(0);
    expect(s.labels).toBe(false);
    expect(s.uiScale).toBe(1.2);
  });

  it('writes settings next to the other profile data and round-trips them', () => {
    const p = newProfile();
    p.settings = { somethingElse: 1 };
    const s = { ...DEFAULT_SETTINGS, quality: 'high' as const, invertY: true, mouseSensitivity: 1.7 };
    writeSettings(p, s);
    expect(p.settings.somethingElse).toBe(1);
    const back = readSettings(JSON.parse(JSON.stringify(p)));
    expect(back).toEqual(s);
  });

  it('accepts only valid quality parameters', () => {
    expect(qualityParam('low')).toBe('low');
    expect(qualityParam('ultra')).toBeNull();
    expect(qualityParam(null)).toBeNull();
  });
});
