// Keyboard → player intent, pure (no DOM): the input layer (input.ts) feeds it the keys that are held and
// the ones pressed or released since the last frame; it answers with the InputState for the player
// controller plus the app-level intents (open the action wheel, change speed, pause). Testable in Node.
import type { Speed } from '../core/time';
import { EMPTY_INPUT, INTERACT_HOLD_SECONDS, KEYMAP, type InputState } from '../player/types';

export interface RawKeys {
  /** Keys (KeyboardEvent.code) held now. */
  down: ReadonlySet<string>;
  /** Pressed since the previous frame (even if already released again). */
  pressed: ReadonlySet<string>;
  released: ReadonlySet<string>;
}

export interface FrameIntent {
  /** For `player.setInput` (the same object is reused every frame). */
  input: InputState;
  /** The interact key has been held long enough: open the action wheel (once per press). */
  openWheel: boolean;
  /** A speed key was pressed. */
  speed: Speed | null;
  togglePause: boolean;
}

const MOVE_FORWARD = [KEYMAP.input.forward, 'ArrowUp'];
const MOVE_BACK = [KEYMAP.input.back, 'ArrowDown'];
const MOVE_LEFT = [KEYMAP.input.left, 'ArrowLeft'];
const MOVE_RIGHT = [KEYMAP.input.right, 'ArrowRight'];
const SPRINT = [KEYMAP.input.sprint, 'ShiftRight'];

function any(set: ReadonlySet<string>, codes: readonly string[]): boolean {
  for (const c of codes) if (set.has(c)) return true;
  return false;
}

/** Tap versus hold of the interact key: a tap acts, a hold of INTERACT_HOLD_SECONDS opens the wheel. */
export class InteractTracker {
  private active = false;
  private held = 0;
  private wheel = false;

  /** Advances by `dt`; returns whether a tap completed and whether the wheel should open now. */
  update(down: boolean, pressed: boolean, released: boolean, dt: number, out: { tap: boolean; openWheel: boolean; held: number }): void {
    out.tap = false;
    out.openWheel = false;
    if (pressed) { this.active = true; this.held = 0; this.wheel = false; }
    if (this.active) {
      if (down || released) this.held += dt;
      if (!this.wheel && this.held >= INTERACT_HOLD_SECONDS && (down || released)) { this.wheel = true; out.openWheel = true; }
      if (released || !down) {
        if (!this.wheel) out.tap = true;
        this.active = false;
      }
    }
    out.held = this.active ? this.held : 0;
  }

  reset(): void { this.active = false; this.held = 0; this.wheel = false; }
}

export class InputMapper {
  /** Slow-walk toggle (X). */
  walkToggle = false;
  private readonly tracker = new InteractTracker();
  private readonly tap = { tap: false, openWheel: false, held: 0 };
  private readonly intent: FrameIntent = { input: { ...EMPTY_INPUT }, openWheel: false, speed: null, togglePause: false };

  map(raw: RawKeys, ctx: { cameraYaw: number; attack: boolean; block: boolean; aim?: InputState['aim'] }, dt: number): FrameIntent {
    const { down, pressed, released } = raw;
    const i = this.intent.input;
    i.forward = (any(down, MOVE_FORWARD) ? 1 : 0) - (any(down, MOVE_BACK) ? 1 : 0);
    i.right = (any(down, MOVE_RIGHT) ? 1 : 0) - (any(down, MOVE_LEFT) ? 1 : 0);
    i.cameraYaw = ctx.cameraYaw;
    i.sprint = any(down, SPRINT);
    if (pressed.has(KEYMAP.input.walk)) this.walkToggle = !this.walkToggle;
    i.walk = this.walkToggle;
    this.tracker.update(down.has(KEYMAP.input.interact), pressed.has(KEYMAP.input.interact), released.has(KEYMAP.input.interact), dt, this.tap);
    i.interact = this.tap.tap;
    i.interactHeld = this.tap.held;
    i.mount = pressed.has(KEYMAP.input.mount);
    i.dodge = pressed.has(KEYMAP.input.dodge);
    i.cancel = pressed.has(KEYMAP.input.cancel);
    i.attack = ctx.attack;
    i.block = ctx.block;
    i.aim = ctx.aim ?? null;
    this.intent.openWheel = this.tap.openWheel;
    this.intent.speed = pressed.has(KEYMAP.input.speed1) ? 1 : pressed.has(KEYMAP.input.speed2) ? 3 : pressed.has(KEYMAP.input.speed3) ? 8 : null;
    this.intent.togglePause = pressed.has(KEYMAP.input.pause);
    return this.intent;
  }

  /** Forget everything held (a panel opened, the window lost focus). */
  clear(): void {
    this.tracker.reset();
    const i = this.intent.input;
    Object.assign(i, EMPTY_INPUT);
    i.aim = null;
    i.walk = this.walkToggle;
    this.intent.openWheel = false;
    this.intent.speed = null;
    this.intent.togglePause = false;
  }
}

/** Plain words for the sim's refusal reasons of speed and sleep commands. */
export function commandRefusal(reason: string | undefined): string {
  switch (reason) {
    case 'too dangerous to hurry': return 'Too dangerous to hurry: an enemy is near.';
    case 'not during action': return 'Not now: you are in the middle of something.';
    case 'choose a successor first': return 'Choose who carries on first.';
    case 'the run is over': return 'The run is over.';
    case 'cannot sleep with enemies near': return 'You cannot sleep with enemies near.';
    default: return reason ?? 'Not now.';
  }
}

/** Mouse look: pixels → radians of camera yaw and pitch (yaw turns right when the mouse moves right). */
export function mouseLook(dx: number, dy: number, sensitivity: number, invertY: boolean): { yaw: number; pitch: number } {
  const k = 0.0022 * sensitivity;
  return { yaw: -dx * k, pitch: dy * k * (invertY ? -1 : 1) };
}

// ---------------------------------------------------------------------------------------------------
// The mouse (CLARITY §5): a free cursor by default, the right button turns the camera while held, a left click
// walks to the thing and acts; with the weapon drawn (or the old "always mouse-look" scheme) the mouse looks and
// the buttons strike and guard. The click that takes the mouse never strikes.
// ---------------------------------------------------------------------------------------------------

export interface MouseCtx {
  /** In the game with the street camera and no panel holding the focus. */
  active: boolean;
  /** Mouse-look mode: the weapon is drawn, or the player chose "always mouse-look". */
  combat: boolean;
  /** The pointer is locked right now. */
  locked: boolean;
  /** The event started on the 3D view, not on an interface plate. */
  onView: boolean;
}

export interface MouseOut {
  /** Ask the browser to lock the pointer (the mouse is taken for looking). */
  lock: boolean;
  /** Give the pointer back (the right button went up). */
  unlock: boolean;
  /** A left click on the world at this client position (walk there and act). */
  click: { x: number; y: number } | null;
}

/** A press this far (pixels of travel) or this long (s) is a drag or a hold, not a click. */
export const CLICK_SLOP = 8;
export const CLICK_SECONDS = 0.7;

export class MouseModes {
  /** Left and right buttons as the combat module sees them (only in mouse-look mode, with the pointer locked). */
  attack = false;
  block = false;
  /** The right button is down in free mode: moving the mouse turns the camera. */
  lookHeld = false;
  private left: { x: number; y: number; moved: number; t: number } | null = null;
  private readonly out: MouseOut = { lock: false, unlock: false, click: null };

  private fresh(): MouseOut {
    const o = this.out;
    o.lock = false; o.unlock = false; o.click = null;
    return o;
  }

  down(button: number, x: number, y: number, c: MouseCtx, now: number): MouseOut {
    const o = this.fresh();
    if (!c.active || !c.onView) return o;
    if (button === 0) {
      if (c.combat) {
        if (!c.locked) o.lock = true; // the click that takes the mouse is not a blow
        else this.attack = true;
      } else this.left = { x, y, moved: 0, t: now };
    } else if (button === 2) {
      if (c.combat) {
        if (!c.locked) o.lock = true;
        else this.block = true;
      } else {
        this.lookHeld = true;
        o.lock = true;
      }
    }
    return o;
  }

  up(button: number, x: number, y: number, c: MouseCtx, now: number): MouseOut {
    const o = this.fresh();
    if (button === 0) {
      this.attack = false;
      const l = this.left;
      this.left = null;
      if (l && c.active && c.onView && !c.combat && l.moved <= CLICK_SLOP && now - l.t <= CLICK_SECONDS && !this.lookHeld) o.click = { x, y };
    } else if (button === 2) {
      this.block = false;
      if (this.lookHeld) {
        this.lookHeld = false;
        if (c.locked && !c.combat) o.unlock = true;
      }
    }
    return o;
  }

  /** Mouse travel (pixels) while a left press is pending: too much and it is a drag, not a click. */
  travel(dx: number, dy: number): void {
    if (this.left) this.left.moved += Math.abs(dx) + Math.abs(dy);
  }

  /** Does moving the mouse turn the camera now? */
  orbiting(c: MouseCtx): boolean { return c.active && (c.locked || this.lookHeld); }

  /** The window lost the focus, a panel opened, the weapon went away: forget every button. */
  clear(): void {
    this.attack = false; this.block = false; this.lookHeld = false; this.left = null;
  }
}

/** What Esc does with the mouse: leave mouse-look first (it never opens the menu), then the interface's own rules. */
export function escapeFor(s: { locked: boolean; lookHeld: boolean; msSinceLockLost: number }): 'leave-look' | 'ignore' | 'ui' {
  if (s.locked || s.lookHeld) return 'leave-look';
  // the browser took the pointer back for this very key press and the key event came along too
  if (s.msSinceLockLost < 250) return 'ignore';
  return 'ui';
}
