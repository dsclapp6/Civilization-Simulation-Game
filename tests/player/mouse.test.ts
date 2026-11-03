// The mouse: it looks (pointer lock, first person); Alt / Option frees the cursor to point and click; Esc gives it back.
import { describe, expect, it } from 'vitest';
import { CLICK_SLOP, MouseModes, escapeFor, mouseLook, type MouseCtx } from '../../src/app/inputLogic';
import { cursorCss, cursorSvg } from '../../src/ui/core/cursors';
import type { CursorKind } from '../../src/player/types';

const looking: MouseCtx = { active: true, locked: true, onView: true, drawn: false };
const armed: MouseCtx = { ...looking, drawn: true };
const unlocked: MouseCtx = { ...looking, locked: false };

describe('the mouse looks', () => {
  it('starts waiting for the click the browser needs; that click takes the pointer and never acts', () => {
    const m = new MouseModes();
    expect(m.state).toBe('wait');
    const d = m.down(0, 50, 50, unlocked, 0);
    expect(d.lock).toBe(true);
    expect(m.attack).toBe(false);
    const u = m.up(0, 50, 50, unlocked, 0.1);
    expect(u.act).toBe(false);
    expect(u.click).toBeNull();
    m.gained();
    expect(m.state).toBe('look');
  });

  it('turns the view whenever the pointer is locked, with no button held', () => {
    const m = new MouseModes();
    expect(m.orbiting(looking)).toBe(true);
    expect(m.orbiting(unlocked)).toBe(false);
    expect(m.orbiting({ ...looking, active: false })).toBe(false);
  });

  it('a tap of the left button while looking is the same as E on what is under the crosshair', () => {
    const m = new MouseModes();
    m.gained();
    m.down(0, 640, 360, looking, 0);
    expect(m.attack).toBe(false);
    m.travel(40, 30, true); // a locked pointer travels freely: no drag
    expect(m.up(0, 640, 360, looking, 0.15).act).toBe(true);
    m.down(0, 640, 360, looking, 1);
    expect(m.up(0, 640, 360, looking, 2.5).act).toBe(false); // a long press is not a tap
  });

  it('with the weapon drawn the left button strikes and the right guards, and a tap acts on nothing', () => {
    const m = new MouseModes();
    m.gained();
    m.down(0, 1, 1, armed, 0);
    expect(m.attack).toBe(true);
    expect(m.up(0, 1, 1, armed, 0.1).act).toBe(false);
    expect(m.attack).toBe(false);
    m.down(2, 1, 1, armed, 1);
    expect(m.block).toBe(true);
    m.up(2, 1, 1, armed, 1.3);
    expect(m.block).toBe(false);
    // unarmed, the right button does nothing
    m.down(2, 1, 1, looking, 2);
    expect(m.block).toBe(false);
  });

  it('forgets every button when cleared (a panel opened, the window lost the focus)', () => {
    const m = new MouseModes();
    m.gained();
    m.down(0, 0, 0, armed, 0);
    m.down(2, 0, 0, armed, 0);
    m.clear();
    expect(m.attack).toBe(false);
    expect(m.block).toBe(false);
  });

  it('does nothing while a panel holds the focus or the map is open, or off the view', () => {
    const m = new MouseModes();
    m.gained();
    expect(m.down(0, 1, 1, { ...looking, active: false }, 0).act).toBe(false);
    expect(m.up(0, 1, 1, { ...looking, active: false }, 0.1).act).toBe(false);
    m.down(0, 1, 1, { ...looking, onView: false }, 0);
    expect(m.up(0, 1, 1, looking, 0.1).act).toBe(false);
  });
});

describe('Alt / Option frees the cursor', () => {
  it('toggles between looking and a free cursor', () => {
    const m = new MouseModes();
    m.gained();
    expect(m.toggle()).toBe('unlock');
    expect(m.state).toBe('free');
    m.lost(true);
    expect(m.state).toBe('free');
    expect(m.toggle()).toBe('lock');
    expect(m.state).toBe('wait');
    m.gained();
    expect(m.state).toBe('look');
  });

  it('with the cursor free a left press and release on the spot is a click on the world', () => {
    const m = new MouseModes();
    m.gained();
    m.toggle();
    expect(m.down(0, 300, 200, unlocked, 1).lock).toBe(false); // free: a click does not take the mouse
    const up = m.up(0, 300, 200, unlocked, 1.2);
    expect(up.click).toEqual({ x: 300, y: 200 });
    expect(up.act).toBe(false);
    expect(m.attack).toBe(false);
  });

  it('does not click after a drag, a long press, or off the view', () => {
    const m = new MouseModes();
    m.gained();
    m.toggle();
    m.down(0, 300, 200, unlocked, 1);
    m.travel(CLICK_SLOP, 3, false);
    expect(m.up(0, 320, 210, unlocked, 1.1).click).toBeNull();
    m.down(0, 300, 200, unlocked, 1);
    expect(m.up(0, 300, 200, unlocked, 2.5).click).toBeNull();
    m.down(0, 300, 200, { ...unlocked, onView: false }, 1);
    expect(m.up(0, 300, 200, unlocked, 1.1).click).toBeNull(); // the press never began on the view
  });

  it('never strikes or guards: the buttons only point and click', () => {
    const m = new MouseModes();
    m.gained();
    m.toggle();
    m.down(0, 10, 10, { ...unlocked, drawn: true }, 0);
    m.down(2, 10, 10, { ...unlocked, drawn: true }, 0);
    expect(m.attack).toBe(false);
    expect(m.block).toBe(false);
  });
});

describe('a page opening and the browser taking the pointer back', () => {
  it('a page frees the mouse and gives it back when it closes (wait for the key press or click); a free cursor stays free', () => {
    const m = new MouseModes();
    m.gained();
    m.suspend();
    expect(m.state).toBe('wait');
    m.lost(true);
    expect(m.state).toBe('wait');
    const f = new MouseModes();
    f.gained();
    f.toggle();
    f.suspend();
    expect(f.state).toBe('free');
  });

  it('the browser taking the pointer (Esc) leaves the cursor free, not waiting', () => {
    const m = new MouseModes();
    m.gained();
    m.lost(false);
    expect(m.state).toBe('free');
  });
});

describe('Esc and the mouse', () => {
  it('leaves mouse-look first and never opens the menu for that press', () => {
    expect(escapeFor({ locked: true, msSinceLockLost: 99999 })).toBe('leave-look');
  });

  it('ignores the key event that arrives together with the browser giving the pointer back', () => {
    expect(escapeFor({ locked: false, msSinceLockLost: 40 })).toBe('ignore');
  });

  it('is the interface\'s own once the mouse is free: close the top page, else the menu', () => {
    expect(escapeFor({ locked: false, msSinceLockLost: 4000 })).toBe('ui');
  });
});

describe('mouse look numbers', () => {
  it('caps a single huge movement (browsers deliver one when the pointer is taken)', () => {
    expect(Math.abs(mouseLook(5000, 0, 1, false).yaw)).toBeLessThan(0.6);
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
