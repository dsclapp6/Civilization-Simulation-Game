// The DOM input layer (the one place in the player/app side that touches events): keyboard, the mouse, the wheel.
//
// The mouse looks (first person is the default view): the pointer is locked and moving the mouse turns the view, no button
// held. The browser needs a click to hand over the pointer, so the first click in the game takes it (and never acts).
// Left Alt / Option frees the cursor to point and click at the world and the HUD; again takes the mouse back. Esc frees it
// too, and never opens the menu for that press. A page opening frees it; closing the page takes it back if it was looking.
// With the cursor free the camera stays still. LMB strikes (weapon drawn) or acts on what is under the crosshair; RMB guards.
//
// The pure parts (which button does what) are in inputLogic.ts; this file records what happened and ignores
// everything while the UI holds the focus (`ui.capturesInput()`).
import type { GameRenderer } from '../render/types';
import { EMPTY_INPUT, KEYMAP, type InputState } from '../player/types';
import type { Speed } from '../core/time';
import { InputMapper, MouseModes, WheelGesture, effectiveButton, escapeFor, mouseLook, scrollsByItself, wheelPixels, type LookState, type MouseCtx, type MouseOut } from './inputLogic';

export interface InputHost {
  /** A panel or menu has the focus: movement and the camera must not react. */
  captured(): boolean;
  /** The game is on screen (not a menu or loading screen). */
  inGame(): boolean;
  renderer(): GameRenderer | null;
  settings(): { mouseSensitivity: number; invertY: boolean };
  /** The wheel settled on a view (0 = first person, else the third-person distance): remember it. */
  rememberView?(distance: number): void;
  /** The journey is under way: the camera follows the party, the player cannot walk. */
  travelling(): boolean;
  openWheel(): void;
  setSpeed(speed: Speed): void;
  togglePause(): void;
  /** The weapon is drawn (G, or a fight began). */
  drawn(): boolean;
  /** Civilization pass: the player is riding (a hold of F is then a slow dismount, not a call). */
  mounted?(): boolean;
  /** Hold F: send for the player's horse (`PlayerApi.callHorse`). */
  callHorse?(): void;
  /** G: draw or put away the weapon. */
  toggleWeapon(): void;
  /** The free cursor is over the world at this client position, or has left it. */
  pointerMove(x: number, y: number): void;
  pointerLeave(): void;
  /** A left click on the world: walk there and act. */
  pointerClick(x: number, y: number): void;
  /** The CSS cursor the thing under the pointer asks for ('' = the plain arrow). */
  cursor(): string;
}

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class InputLayer {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly mapper = new InputMapper();
  private readonly modes = new MouseModes();
  private readonly cleanups: Array<() => void> = [];
  /** The map is open and the left button is dragging it. */
  private mapDragging = false;
  private locked = false;
  private weReleasedLock = false;
  /** The wheel moved the view: when it was (performance.now ms) and the last view saved. */
  private viewDirty = 0;
  private viewSaved = NaN;
  private unlockedAt = -1e9;
  private lockLostAt = -1e9;
  private lastLockTry = -1e9;
  private lastCursor = '';
  /** Where the cursor last was (client pixels) and whether that is the 3D view rather than an interface plate. */
  private readonly ptr = { x: 0, y: 0, onView: false, seen: false };

  constructor(private readonly host: InputHost, private readonly surface: HTMLElement) {
    const on = <T extends Event>(target: EventTarget, type: string, fn: (e: T) => void, opts?: AddEventListenerOptions): void => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on<KeyboardEvent>(window, 'keydown', (e) => this.onKeyDown(e));
    on<KeyboardEvent>(window, 'keyup', (e) => this.onKeyUp(e));
    on<Event>(window, 'blur', () => this.clearHeld());
    on<Event>(document, 'visibilitychange', () => { if (document.hidden) this.clearHeld(); });
    on<MouseEvent>(surface, 'mousedown', (e) => this.onMouseDown(e));
    on<MouseEvent>(window, 'mouseup', (e) => this.onMouseUp(e));
    on<MouseEvent>(window, 'mousemove', (e) => this.onMouseMove(e));
    on<Event>(document.documentElement, 'mouseleave', () => { this.ptr.onView = false; });
    on<WheelEvent>(surface, 'wheel', (e) => this.onWheel(e), { passive: false });
    // nothing in the game scrolls the page, zooms it by pinch or swipes it back (a touchpad's two-finger gestures): a wheel that
    // is not over a list that scrolls by itself is swallowed
    on<WheelEvent>(document, 'wheel', (e) => this.guardWheel(e), { passive: false });
    // a two-finger click, a ctrl-click or the context key never opens the browser's menu over the game (text fields keep theirs)
    on<Event>(document, 'contextmenu', (e) => this.guardContextMenu(e));
    on<Event>(document, 'pointerlockchange', () => this.onLockChange());
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    if (document.pointerLockElement) document.exitPointerLock();
    this.surface.style.cursor = '';
  }

  get pointerLocked(): boolean { return this.locked; }

  /** 'look' (the mouse turns the view), 'wait' (a click will take it) or 'free' (the cursor is free to point and click). */
  get lookState(): LookState { return this.modes.state; }

  /** The hint's click: take the mouse back (for a click or key press, so the browser allows it). */
  takeMouse(): void {
    if (this.modes.state === 'free') this.modes.toggle(); else this.modes.state = 'wait';
    this.requestLock();
  }

  /**
   * Esc, as the interface asks for it: if the mouse is looking, Esc gives it back and that is all it does (true);
   * otherwise the interface closes its top page or shows the menu (false).
   */
  releaseLook(): boolean {
    const verdict = escapeFor({ locked: this.locked, msSinceLockLost: performance.now() - this.lockLostAt });
    if (verdict === 'ignore') return true;
    if (verdict === 'ui') return false;
    this.modes.toggle(); // look -> free
    this.exitLock();
    return true;
  }

  // ---------------------------------------------------------------------------------------- per frame

  /**
   * Called once per frame before the sim steps. Returns the input for the player controller (empty while
   * a panel has the focus or the party is on the road) and performs the app-level intents.
   */
  read(dt: number): InputState {
    const r = this.host.renderer();
    if (this.host.captured() || !this.host.inGame()) {
      this.modes.suspend();
      this.exitLock();
      this.clearHeld();
      this.host.pointerLeave();
      this.setCursor('');
      return EMPTY_INPUT;
    }
    const mode = r ? r.getCameraMode() : 'follow';
    const mapView = mode === 'map' || this.host.travelling();
    // the pointer is ours only in the street view (inside a building too, the mouse keeps looking): not on the map or the road,
    // in builder mode or a cut-scene (mode 'free')
    this.keepLock(mapView || mode !== 'follow');
    if (this.viewDirty && performance.now() - this.viewDirty > 700 && r && mode === 'follow') {
      this.viewDirty = 0;
      const d = Math.round(r.getViewDistance() * 10) / 10;
      if (d !== this.viewSaved) { this.viewSaved = d; this.host.rememberView?.(d); }
    }

    const intent = this.mapper.map(
      { down: this.down, pressed: this.pressed, released: this.released },
      {
        cameraYaw: r ? r.getCameraYaw() : 0,
        // the buttons strike and guard only when the mouse is looking (never for the click that took it); with the
        // weapon drawn, J and K do the same from the keyboard alone
        attack: (this.locked && this.modes.attack) || (this.host.drawn() && this.down.has(KEYMAP.input.strike)),
        block: (this.locked && this.modes.block) || (this.host.drawn() && this.down.has(KEYMAP.input.guard)),
        aim: r && mode === 'follow' ? this.cameraRay(r) : null,
        riding: !!this.host.mounted?.(),
        faceCamera: !!r && mode === 'follow' && r.inFirstPerson(),
      },
      dt,
    );
    if (intent.speed !== null) this.host.setSpeed(intent.speed);
    if (intent.togglePause) this.host.togglePause();
    if (intent.openWheel) this.host.openWheel();
    if (intent.callHorse) this.host.callHorse?.();
    // a tap of the left button while looking, unarmed: the same as E on what is under the crosshair
    if (this.actTap) { this.actTap = false; if (!mapView && !this.host.drawn()) intent.input.interact = true; }

    // the free cursor: what is under it, and what the pointer looks like
    const free = !mapView && !this.locked && this.modes.state === 'free';
    if (free && this.ptr.seen && this.ptr.onView) {
      this.host.pointerMove(this.ptr.x, this.ptr.y);
      this.setCursor(this.host.cursor());
    } else {
      this.host.pointerLeave();
      this.setCursor('');
    }

    // on the map the movement keys pan it instead of walking
    if (mapView && r) {
      if (!this.host.travelling()) {
        const f = intent.input.forward, s = intent.input.right;
        if (f || s) r.pan(-s * dt * 600, f * dt * 600);
      }
      this.pressed.clear(); this.released.clear();
      return EMPTY_INPUT;
    }
    this.pressed.clear();
    this.released.clear();
    return intent.input;
  }

  /** Is the street camera live and the interface out of the way? */
  private active(): boolean {
    if (this.host.captured() || !this.host.inGame()) return false;
    const r = this.host.renderer();
    return !!r && r.getCameraMode() === 'follow' && !this.host.travelling();
  }

  private ctx(onView: boolean): MouseCtx {
    return { active: this.active(), drawn: this.host.drawn(), locked: this.locked, onView };
  }

  /** The pointer is ours whenever the mouse should look: after a click when the browser demands one, at once after a key press. */
  private keepLock(mapView: boolean): void {
    if (mapView) { this.modes.suspend(); this.exitLock(); return; }
    // (a lock this layer gave up itself a moment ago may be taken again without a new click or key press)
    if (this.modes.state === 'wait' && !this.locked && (recentGesture() || performance.now() - this.unlockedAt < 8000)) this.requestLock();
  }

  private requestLock(): void {
    if (this.locked) return;
    const now = performance.now();
    if (now - this.lastLockTry < 300) return;
    this.lastLockTry = now;
    try { (this.surface.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => { /* denied: dragging still turns the camera */ }); } catch { /* old browsers throw instead */ }
  }

  private exitLock(): void {
    if (!this.locked || this.weReleasedLock) return;
    this.weReleasedLock = true;
    this.unlockedAt = performance.now();
    document.exitPointerLock();
  }

  private setCursor(css: string): void {
    if (css === this.lastCursor) return;
    this.lastCursor = css;
    this.surface.style.cursor = css;
  }

  /** The camera's ray from its world matrix (position = column 3, forward = −column 2): what a bow is aimed along. */
  private cameraRay(r: GameRenderer): NonNullable<InputState['aim']> {
    const e = r.getCamera().matrixWorld.elements;
    const a = this.aimRay;
    a.x = e[12]; a.y = e[13]; a.z = e[14];
    const dx = -e[8], dy = -e[9], dz = -e[10];
    const l = Math.hypot(dx, dy, dz) || 1;
    a.dx = dx / l; a.dy = dy / l; a.dz = dz / l;
    return a;
  }
  private readonly aimRay = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1 };

  private clearHeld(): void {
    this.down.clear(); this.pressed.clear(); this.released.clear();
    this.mapper.clear();
    this.modes.clear();
    this.mapDragging = false;
  }

  // ---------------------------------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (TYPING.has(t.tagName) || t.isContentEditable)) return;
    if (e.code === 'AltLeft' || e.code === 'AltRight') { this.onAltKey(e); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.host.captured() || !this.host.inGame()) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (e.code === KEYMAP.input.weapon) { this.onWeaponKey(); return; }
    this.down.add(e.code);
    this.pressed.add(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.down.delete(e.code)) this.released.add(e.code);
  }

  /** Left Alt / Option: free the cursor to point and click, or take the mouse back (a key press is allowed to take it). */
  private onAltKey(e: KeyboardEvent): void {
    e.preventDefault();
    if (e.repeat || e.ctrlKey || e.metaKey || !this.active()) return;
    if (this.modes.toggle() === 'lock') this.requestLock(); else this.exitLock();
  }

  /** G: draw or put away. Drawing with the cursor free takes the mouse (a fight is no time to point). */
  private onWeaponKey(): void {
    if (!this.active()) return;
    this.host.toggleWeapon();
    if (this.host.drawn() && this.modes.state === 'free') { this.modes.state = 'wait'; this.requestLock(); }
  }

  // ---------------------------------------------------------------------------------------- mouse

  private onView(e: Event): boolean {
    const t = e.target as Node | null;
    return t instanceof Node && this.surface.contains(t);
  }

  private onMouseDown(e: MouseEvent): void {
    if (this.host.captured() || !this.host.inGame()) return;
    const r = this.host.renderer();
    if (r && r.getCameraMode() === 'map') {
      if (this.buttonOf(e) === 0 && !this.host.travelling()) this.mapDragging = true;
      return;
    }
    const out = this.modes.down(this.buttonOf(e), e.clientX, e.clientY, this.ctx(true), performance.now() / 1000);
    this.apply(out);
  }

  /** The button as the game sees it: a ctrl-click on a Mac is the right button, and a ctrl-click that began as one ends as one. */
  private ctrlButton = false;
  private buttonOf(e: MouseEvent, up = false): number {
    if (up) { const was = this.ctrlButton; if (e.button === 0) this.ctrlButton = false; return was && e.button === 0 ? 2 : e.button; }
    const b = effectiveButton(e.button, e.ctrlKey, isMac());
    this.ctrlButton = b === 2 && e.button === 0;
    return b;
  }

  private onMouseUp(e: MouseEvent): void {
    const button = this.buttonOf(e, true);
    if (button === 0) this.mapDragging = false;
    if (this.host.captured() || !this.host.inGame()) { this.modes.clear(); return; }
    const out = this.modes.up(button, e.clientX, e.clientY, this.ctx(this.onView(e)), performance.now() / 1000);
    this.apply(out);
  }

  private apply(out: MouseOut): void {
    if (out.lock) this.requestLock();
    if (out.act) this.actTap = true;
    if (out.click) this.host.pointerClick(out.click.x, out.click.y);
  }
  private actTap = false;

  /** When the mouse last moved (performance.now ms): fighting from the keyboard turns to the foe only while it rests. */
  lastMouseMove = -1e9;

  private onMouseMove(e: MouseEvent): void {
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) this.lastMouseMove = performance.now();
    this.ptr.x = e.clientX; this.ptr.y = e.clientY; this.ptr.onView = this.onView(e); this.ptr.seen = true;
    if (this.host.captured() || !this.host.inGame()) return;
    const r = this.host.renderer();
    if (!r) return;
    const dx = e.movementX, dy = e.movementY;
    if (!dx && !dy) return;
    if (r.getCameraMode() === 'map') {
      if (this.mapDragging && !this.host.travelling()) r.pan(dx, dy);
      return;
    }
    this.modes.travel(dx, dy, this.locked);
    if (this.modes.orbiting(this.ctx(true))) {
      const s = this.host.settings();
      const look = mouseLook(dx, dy, s.mouseSensitivity, s.invertY);
      r.orbit(look.yaw, look.pitch);
    }
  }

  private onWheel(e: WheelEvent): void {
    if (this.host.captured() || !this.host.inGame()) return;
    const r = this.host.renderer();
    if (!r) return;
    e.preventDefault();
    // first person <-> over the shoulder <-> farther out <-> the map (the rig steps between them). A mouse notch is a step; a
    // touchpad swipe (dozens of small pixel events, then inertia) zooms by its length and takes one step between views
    const steps = this.wheel.feed(wheelPixels(e.deltaY, e.deltaMode, e.ctrlKey), e.deltaMode, e.timeStamp, r.getViewDistance(), r.getCameraMode() === 'follow');
    if (steps !== 0) { r.zoom(steps); this.viewDirty = performance.now(); }
  }
  private readonly wheel = new WheelGesture();

  private guardWheel(e: WheelEvent): void {
    if (e.defaultPrevented || !this.host.inGame()) return;
    const t = e.target as Element | null;
    if (!e.ctrlKey) {
      for (let n: Element | null = t; n && n !== document.documentElement; n = n.parentElement) {
        const o = getComputedStyle(n).overflowY;
        if (scrollsByItself(o, n.scrollHeight, n.clientHeight)) return;
      }
    }
    e.preventDefault();
  }

  private guardContextMenu(e: Event): void {
    if (!this.host.inGame()) return;
    const t = e.target as HTMLElement | null;
    if (t && (TYPING.has(t.tagName) || t.isContentEditable)) return;
    e.preventDefault();
  }

  private onLockChange(): void {
    const was = this.locked;
    this.locked = document.pointerLockElement === this.surface;
    if (!was && this.locked) this.modes.gained();
    if (was && !this.locked) {
      const byUs = this.weReleasedLock;
      this.weReleasedLock = false;
      this.modes.lost(byUs);
      // the browser took the pointer back (Esc): the cursor is free until Alt, the hint or a click on it
      if (!byUs) this.lockLostAt = performance.now();
    }
  }
}

function isMac(): boolean {
  const n = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad/i.test(n.userAgentData?.platform ?? n.platform ?? '');
}

/** A key press or click happened lately enough for the browser to allow taking the pointer. */
function recentGesture(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return !!ua && ua.isActive;
}
