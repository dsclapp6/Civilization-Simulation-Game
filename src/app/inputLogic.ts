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
  /** The mount key (F) has been held long enough: call your horse (once per press; never for someone riding). Civilization pass, CIV §9. */
  callHorse: boolean;
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
  private readonly intent: FrameIntent = { input: { ...EMPTY_INPUT }, openWheel: false, speed: null, togglePause: false, callHorse: false };
  /** F: how long it has been held, whether the call went out, and whether the press found the player riding (then a hold is a slow dismount). */
  private mountHeld = 0;
  private mountFired = false;
  private ridingAtPress = false;
  private mountActive = false;

  map(raw: RawKeys, ctx: { cameraYaw: number; attack: boolean; block: boolean; aim?: InputState['aim']; riding?: boolean; faceCamera?: boolean }, dt: number): FrameIntent {
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
    // hold F to call your horse: the tap above has mounted (or dismounted) at once; a hold that began on foot and goes on without a
    // mount having happened (the horse is not here) sends for it, once
    this.intent.callHorse = false;
    if (pressed.has(KEYMAP.input.mount)) { this.mountActive = true; this.mountHeld = 0; this.mountFired = false; this.ridingAtPress = !!ctx.riding; }
    if (this.mountActive) {
      if (down.has(KEYMAP.input.mount)) {
        this.mountHeld += dt;
        if (!this.mountFired && !this.ridingAtPress && !ctx.riding && this.mountHeld >= INTERACT_HOLD_SECONDS) { this.mountFired = true; this.intent.callHorse = true; }
      } else this.mountActive = false;
    }
    i.dodge = pressed.has(KEYMAP.input.dodge);
    i.cancel = pressed.has(KEYMAP.input.cancel);
    i.attack = ctx.attack;
    i.block = ctx.block;
    i.aim = ctx.aim ?? null;
    i.faceCamera = !!ctx.faceCamera;
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
    this.intent.callHorse = false;
    this.mountActive = false;
    this.mountHeld = 0;
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

/**
 * Mouse look: pixels → radians of camera yaw and pitch (yaw turns right when the mouse moves right). A single event is
 * capped: browsers now and then deliver a huge first movement when the pointer is taken, which would spin the view.
 */
export function mouseLook(dx: number, dy: number, sensitivity: number, invertY: boolean): { yaw: number; pitch: number } {
  const k = 0.0022 * sensitivity;
  const cap = (v: number): number => Math.max(-MAX_STEP, Math.min(MAX_STEP, v));
  return { yaw: -cap(dx) * k, pitch: cap(dy) * k * (invertY ? -1 : 1) };
}
const MAX_STEP = 220;

// ---------------------------------------------------------------------------------------------------
// The mouse: it looks. The pointer is locked and moving the mouse (or a trackpad) turns the view, no button held.
// Left Alt / Option frees the cursor to point and click at the world (and the HUD); again takes the mouse back.
// Three states: 'look' (the pointer is ours), 'wait' (the mouse should look but the browser needs a click to hand over
// the pointer: the start, and after a page closed) and 'free' (the player freed it). The click that takes the mouse never acts.
// ---------------------------------------------------------------------------------------------------

export type LookState = 'look' | 'wait' | 'free';

export interface MouseCtx {
  /** In the game with the street camera and no panel holding the focus. */
  active: boolean;
  /** The pointer is locked right now. */
  locked: boolean;
  /** The event started on the 3D view, not on an interface plate. */
  onView: boolean;
  /** The weapon is drawn: the buttons strike and guard. */
  drawn: boolean;
}

export interface MouseOut {
  /** Ask the browser to lock the pointer (the mouse is taken for looking). */
  lock: boolean;
  /** A left click on the world while the cursor is free: walk there and act. */
  click: { x: number; y: number } | null;
  /** A left tap while looking, unarmed: do what E would do on the thing under the crosshair. */
  act: boolean;
}

/** A press this far (pixels of travel) or this long (s) is a drag or a hold, not a click. */
export const CLICK_SLOP = 8;
export const CLICK_SECONDS = 0.7;

export class MouseModes {
  state: LookState = 'wait';
  /** Left and right buttons as the combat module sees them (only while the pointer is locked and the weapon drawn). */
  attack = false;
  block = false;
  private left: { x: number; y: number; moved: number; t: number } | null = null;
  /** The press that took the mouse: its release is no click and no blow. */
  private swallow = false;
  private readonly out: MouseOut = { lock: false, click: null, act: false };

  private fresh(): MouseOut {
    const o = this.out;
    o.lock = false; o.click = null; o.act = false;
    return o;
  }

  down(button: number, x: number, y: number, c: MouseCtx, now: number): MouseOut {
    const o = this.fresh();
    if (!c.active || !c.onView) return o;
    if (this.state !== 'free' && !c.locked) {
      // the click that takes the mouse
      this.state = 'wait';
      o.lock = true;
      this.swallow = true;
      return o;
    }
    this.swallow = false;
    if (button === 0) {
      if (this.state !== 'free' && c.drawn) this.attack = true;
      else this.left = { x, y, moved: 0, t: now };
    } else if (button === 2 && this.state !== 'free' && c.drawn) this.block = true;
    return o;
  }

  up(button: number, x: number, y: number, c: MouseCtx, now: number): MouseOut {
    const o = this.fresh();
    if (button === 0) {
      this.attack = false;
      const l = this.left;
      this.left = null;
      if (this.swallow) { this.swallow = false; return o; }
      if (l && c.active && c.onView && l.moved <= CLICK_SLOP && now - l.t <= CLICK_SECONDS) {
        if (this.state === 'free') o.click = { x, y };
        else if (c.locked) o.act = true;
      }
    } else if (button === 2) this.block = false;
    return o;
  }

  /** Mouse travel (pixels) while a left press is pending: too much and it is a drag, not a click. A locked pointer travels freely. */
  travel(dx: number, dy: number, locked: boolean): void {
    if (this.left && !locked) this.left.moved += Math.abs(dx) + Math.abs(dy);
  }

  /** Does moving the mouse turn the view now? */
  orbiting(c: MouseCtx): boolean { return c.active && c.locked; }

  /** Alt / Option: free the cursor, or take the mouse back. Returns what to ask of the browser. */
  toggle(): 'lock' | 'unlock' {
    if (this.state === 'free') { this.state = 'wait'; return 'lock'; }
    this.state = 'free';
    this.attack = false; this.block = false; this.left = null;
    return 'unlock';
  }

  /** The pointer came to us. */
  gained(): void { this.state = 'look'; }

  /** The pointer left: `byUs` when we gave it up (a page opened, the map came), else the browser took it back (Esc): the cursor is free. */
  lost(byUs: boolean): void {
    this.attack = false; this.block = false;
    if (this.state === 'look') this.state = byUs ? 'wait' : 'free';
  }

  /** A page opened, the map came: the mouse stops looking but should look again afterwards. */
  suspend(): void {
    if (this.state === 'look') this.state = 'wait';
    this.clear();
  }

  /** The window lost the focus, a panel opened, the weapon went away: forget every button. */
  clear(): void {
    this.attack = false; this.block = false; this.left = null; this.swallow = false;
  }
}

/** What Esc does with the mouse: give it back first (it never opens the menu for that press), then the interface's own rules. */
export function escapeFor(s: { locked: boolean; msSinceLockLost: number }): 'leave-look' | 'ignore' | 'ui' {
  if (s.locked) return 'leave-look';
  // the browser took the pointer back for this very key press and the key event came along too
  if (s.msSinceLockLost < 250) return 'ignore';
  return 'ui';
}

// ---------------------------------------------------------------------------------------------------
// The wheel and the touchpad. A mouse wheel sends notches (line mode, or pixel deltas of ~100 each); a touchpad sends dozens of
// small pixel deltas for one two-finger swipe, then more of them as inertia. A notch is a step; a swipe is ONE gesture: it zooms
// smoothly (per pixel, not per event) and takes at most one step between the views (first person <-> shoulder, the farthest
// boom <-> the map), then ignores the rest of the swipe and its inertia.
// ---------------------------------------------------------------------------------------------------

/** The rig's limits (render/camera/cameraRig.ts FOLLOW_MIN / FOLLOW_MAX): where the boom runs out into the next view. */
export const BOOM_MIN = 2.4;
export const BOOM_MAX = 140;
/** A swipe that begins at or inside this boom (the shoulder view is 3.4 m) takes the step into first person. */
export const NEAR_START = 4.2;
/** Events closer together than this (ms) are one gesture (inertia events come every 8-16 ms). */
export const GESTURE_GAP_MS = 200;
/** A pixel delta this big at the start of a gesture is a mouse notch; touchpads start small and grow. */
export const NOTCH_PX = 50;
/** Pixels of swipe in one direction before a swipe takes a step between views. */
export const STAGE_PX = 26;
/** One zoom step (a factor of 1.15 of the boom) per this many pixels of swipe. */
export const PAD_PX_PER_STEP = 110;

/** Wheel event deltas to pixels (line mode ~16 px a line, page mode a screenful) and pinch (ctrl) scaled up. */
export function wheelPixels(deltaY: number, deltaMode: number, ctrlKey = false): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return ctrlKey ? px * 6 : px;
}

export class WheelGesture {
  private last = -1e9;
  private pad = false;
  private acc = 0;
  private swallow = false;
  private startDist = 0;

  /**
   * One wheel event -> how many zoom steps to give the camera (positive out, negative in). `viewDist` is the camera's view
   * (0 = first person, else the boom length), `follow` whether the street camera is the one on show.
   */
  feed(px: number, deltaMode: number, now: number, viewDist: number, follow: boolean): number {
    const gap = now - this.last;
    this.last = now;
    if (gap > GESTURE_GAP_MS || (this.pad && this.acc * px < 0 && Math.abs(this.acc) > STAGE_PX && Math.abs(px) > 6)) {
      this.pad = deltaMode === 0 && Math.abs(px) < NOTCH_PX;
      this.acc = 0; this.swallow = false; this.startDist = viewDist;
    }
    if (!this.pad) return Math.max(-3, Math.min(3, px / 70));
    this.acc += px;
    if (this.swallow) return 0;
    if (!follow) return Math.max(-2, Math.min(2, px / PAD_PX_PER_STEP));
    if (viewDist <= 0) {
      // first person: only a real swipe outward steps to the shoulder, once
      if (this.acc >= STAGE_PX) { this.swallow = true; return 1; }
      return 0;
    }
    // a swipe that began at the near boom (the shoulder view) goes in to first person at once; one that began at the far end goes out to the map
    if (this.startDist <= NEAR_START && -this.acc >= STAGE_PX) { this.swallow = true; return Math.min(-0.5, Math.log((BOOM_MIN * 0.9) / viewDist) / Math.log(1.15)); }
    if (this.startDist >= BOOM_MAX * 0.7 && this.acc >= STAGE_PX) { this.swallow = true; return Math.max(0.5, Math.log((BOOM_MAX * 1.05) / viewDist) / Math.log(1.15)); }
    let steps = Math.max(-2, Math.min(2, px / PAD_PX_PER_STEP));
    const f = Math.pow(1.15, steps);
    // anywhere between, the boom stops at its ends: the swipe does not run through the stages
    if (viewDist * f < BOOM_MIN) steps = viewDist > BOOM_MIN * 1.01 ? Math.log((BOOM_MIN * 1.01) / viewDist) / Math.log(1.15) : 0;
    else if (viewDist * f > BOOM_MAX) steps = viewDist < BOOM_MAX * 0.99 ? Math.log((BOOM_MAX * 0.99) / viewDist) / Math.log(1.15) : 0;
    return steps;
  }

  reset(): void { this.last = -1e9; this.acc = 0; this.swallow = false; }
}

/** On a Mac a ctrl-click is the secondary click (the browser sends button 0 with ctrlKey, then contextmenu): the right button. */
export function effectiveButton(button: number, ctrlKey: boolean, mac: boolean): number {
  return mac && ctrlKey && button === 0 ? 2 : button;
}

/** Does this element scroll by itself (a list in a panel)? Then the wheel over it belongs to it, not to the game or the page. */
export function scrollsByItself(overflowY: string, scrollHeight: number, clientHeight: number): boolean {
  return (overflowY === 'auto' || overflowY === 'scroll') && scrollHeight > clientHeight + 1;
}
