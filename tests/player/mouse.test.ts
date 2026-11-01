// The mouse (CLARITY §5): a free cursor, the right button for the camera, a click to act; mouse-look with the weapon drawn.
import { describe, expect, it } from 'vitest';
import { CLICK_SLOP, MouseModes, escapeFor, type MouseCtx } from '../../src/app/inputLogic';
import { cursorCss, cursorSvg } from '../../src/ui/core/cursors';
import type { CursorKind } from '../../src/player/types';

const free: MouseCtx = { active: true, combat: false, locked: false, onView: true };
const drawn: MouseCtx = { active: true, combat: true, locked: false, onView: true };

describe('the free cursor', () => {
  it('turns a left press and release on the spot into a click on the world', () => {
    const m = new MouseModes();
    expect(m.down(0, 300, 200, free, 1).click).toBeNull();
    const up = m.up(0, 300, 200, free, 1.2);
    expect(up.click).toEqual({ x: 300, y: 200 });
    expect(m.attack).toBe(false);
  });

  it('does not click after a drag, a long press, or off the view', () => {
    const m = new MouseModes();
    m.down(0, 300, 200, free, 1);
    m.travel(CLICK_SLOP, 3);
    expect(m.up(0, 320, 210, free, 1.1).click).toBeNull();
    m.down(0, 300, 200, free, 1);
    expect(m.up(0, 300, 200, free, 2.5).click).toBeNull();
    m.down(0, 300, 200, free, 1);
    expect(m.up(0, 300, 200, { ...free, onView: false }, 1.1).click).toBeNull();
    expect(m.down(0, 1, 1, { ...free, onView: false }, 1).click).toBeNull();
    expect(m.up(0, 1, 1, free, 1.1).click).toBeNull(); // the press never began on the view
  });

  it('never strikes: the buttons are not an attack or a guard in the free scheme', () => {
    const m = new MouseModes();
    m.down(0, 10, 10, free, 0);
    expect(m.attack).toBe(false);
    m.down(2, 10, 10, free, 0);
    expect(m.block).toBe(false);
  });

  it('turns the camera while the right button is held, and gives the pointer back when it goes up', () => {
    const m = new MouseModes();
    const d = m.down(2, 10, 10, free, 0);
    expect(d.lock).toBe(true);
    expect(m.lookHeld).toBe(true);
    expect(m.orbiting({ ...free, locked: true })).toBe(true);
    const u = m.up(2, 10, 10, { ...free, locked: true }, 0.4);
    expect(u.unlock).toBe(true);
    expect(m.lookHeld).toBe(false);
    expect(m.orbiting({ ...free, locked: false })).toBe(false);
  });

  it('turns the camera by hand when the browser refuses the pointer lock', () => {
    const m = new MouseModes();
    m.down(2, 10, 10, free, 0);
    expect(m.orbiting({ ...free, locked: false })).toBe(true);
    expect(m.up(2, 10, 10, free, 1).unlock).toBe(false);
  });

  it('a left click during a right-drag is no click', () => {
    const m = new MouseModes();
    m.down(0, 5, 5, free, 0);
    m.down(2, 5, 5, free, 0.1);
    expect(m.up(0, 5, 5, free, 0.2).click).toBeNull();
  });

  it('does nothing while a panel holds the focus or the map is open', () => {
    const m = new MouseModes();
    const off: MouseCtx = { ...free, active: false };
    expect(m.down(0, 1, 1, off, 0).click).toBeNull();
    expect(m.down(2, 1, 1, off, 0).lock).toBe(false);
    expect(m.lookHeld).toBe(false);
    expect(m.up(0, 1, 1, off, 0.1).click).toBeNull();
  });
});

describe('mouse-look with the weapon drawn', () => {
  it('the first press only takes the mouse; it is never a blow', () => {
    const m = new MouseModes();
    const first = m.down(0, 50, 50, drawn, 0);
    expect(first.lock).toBe(true);
    expect(m.attack).toBe(false);
    m.up(0, 50, 50, drawn, 0.1);
    const second = m.down(0, 50, 50, { ...drawn, locked: true }, 1);
    expect(second.lock).toBe(false);
    expect(m.attack).toBe(true);
    m.up(0, 50, 50, { ...drawn, locked: true }, 1.2);
    expect(m.attack).toBe(false);
  });

  it('the right button guards or aims once the mouse is taken, and is not a camera drag', () => {
    const m = new MouseModes();
    expect(m.down(2, 0, 0, drawn, 0).lock).toBe(true);
    expect(m.block).toBe(false);
    m.up(2, 0, 0, drawn, 0.1);
    expect(m.down(2, 0, 0, { ...drawn, locked: true }, 1).lock).toBe(false);
    expect(m.block).toBe(true);
    expect(m.lookHeld).toBe(false);
    m.up(2, 0, 0, { ...drawn, locked: true }, 1.4);
    expect(m.block).toBe(false);
  });

  it('a left click is a blow, never a walk', () => {
    const m = new MouseModes();
    const c: MouseCtx = { ...drawn, locked: true };
    m.down(0, 9, 9, c, 0);
    expect(m.up(0, 9, 9, c, 0.1).click).toBeNull();
  });

  it('the mouse turns the camera whenever it is locked', () => {
    const m = new MouseModes();
    expect(m.orbiting({ ...drawn, locked: true })).toBe(true);
    expect(m.orbiting(drawn)).toBe(false);
  });

  it('forgets every button when cleared (a panel opened, the window lost the focus)', () => {
    const m = new MouseModes();
    m.down(0, 0, 0, { ...drawn, locked: true }, 0);
    m.down(2, 0, 0, { ...drawn, locked: true }, 0);
    m.clear();
    expect(m.attack).toBe(false);
    expect(m.block).toBe(false);
  });
});

describe('Esc and the mouse', () => {
  it('leaves mouse-look first and never opens the menu for that press', () => {
    expect(escapeFor({ locked: true, lookHeld: false, msSinceLockLost: 99999 })).toBe('leave-look');
    expect(escapeFor({ locked: false, lookHeld: true, msSinceLockLost: 99999 })).toBe('leave-look');
  });

  it('ignores the key event that arrives together with the browser giving the pointer back', () => {
    expect(escapeFor({ locked: false, lookHeld: false, msSinceLockLost: 40 })).toBe('ignore');
  });

  it('is the interface\'s own once the mouse is free: close the top page, else the menu', () => {
    expect(escapeFor({ locked: false, lookHeld: false, msSinceLockLost: 4000 })).toBe('ui');
  });
});

describe('cursor images', () => {
  const kinds: CursorKind[] = ['walk', 'talk', 'work', 'trade', 'enter', 'attack', 'use'];

  it('leaves the plain arrow to the browser and draws one image per action kind', () => {
    expect(cursorCss('default')).toBe('');
    expect(cursorCss('grab')).toBe('grabbing');
    for (const k of kinds) {
      const css = cursorCss(k);
      expect(css, k).toMatch(/^url\("data:image\/svg\+xml,/);
      expect(css, k).toMatch(/ 3 2, auto$/);
      const svg = cursorSvg(k)!;
      expect(svg, k).toContain('<svg');
      expect(svg.length, k).toBeLessThan(1500);
    }
    expect(new Set(kinds.map((k) => cursorSvg(k))).size).toBe(kinds.length);
  });
});
