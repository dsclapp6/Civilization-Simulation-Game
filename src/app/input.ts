// The DOM input layer (the one place in the player/app side that touches events): keyboard, the mouse, the wheel.
//
// The mouse (CLARITY §5): the cursor is free and visible. Hovering shows what is under it and what a click does;
// a left click walks there and acts; the right button turns the camera while it is held (the pointer is locked only
// then, so the cursor comes back where it was). With the weapon drawn (G, or a fight began) — or with the setting
// "Always use mouse-look" — the mouse looks all the time: left strikes, right guards or aims. The click that takes
// the mouse never strikes. Esc leaves mouse-look first; it opens the menu only when the mouse was already free.
//
// The pure parts (which button does what) are in inputLogic.ts; this file records what happened and ignores
// everything while the UI holds the focus (`ui.capturesInput()`).
import type { GameRenderer } from '../render/types';
import { EMPTY_INPUT, KEYMAP, type InputState } from '../player/types';
import type { Speed } from '../core/time';
import { InputMapper, MouseModes, escapeFor, mouseLook, type MouseCtx, type MouseOut } from './inputLogic';

export interface InputHost {
  /** A panel or menu has the focus: movement and the camera must not react. */
  captured(): boolean;
  /** The game is on screen (not a menu or loading screen). */
  inGame(): boolean;
  renderer(): GameRenderer | null;
  settings(): { mouseSensitivity: number; invertY: boolean; alwaysLook?: boolean };
  /** The journey is under way: the camera follows the party, the player cannot walk. */
  travelling(): boolean;
  openWheel(): void;
  setSpeed(speed: Speed): void;
  togglePause(): void;
  /** The weapon is drawn (G, or a fight began). */
  drawn(): boolean;
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
  /** In mouse-look mode the player wants the mouse captured (taken by the first click or by G; Esc gives it up). */
  private combatLook = false;
  private lastCombat = false;
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
    on<Event>(surface, 'contextmenu', (e) => e.preventDefault());
    on<Event>(document, 'pointerlockchange', () => this.onLockChange());
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    if (document.pointerLockElement) document.exitPointerLock();
    this.surface.style.cursor = '';
  }

  get pointerLocked(): boolean { return this.locked; }

  /**
   * Esc, as the interface asks for it: if the mouse is looking, Esc gives it back and that is all it does (true);
   * otherwise the interface closes its top page or shows the menu (false).
   */
  releaseLook(): boolean {
    const verdict = escapeFor({ locked: this.locked, lookHeld: this.modes.lookHeld, msSinceLockLost: performance.now() - this.lockLostAt });
    if (verdict === 'ignore') return true;
    if (verdict === 'ui') return false;
    this.combatLook = false;
    this.modes.lookHeld = false;
    this.modes.attack = false; this.modes.block = false;
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
      this.exitLock();
      this.clearHeld();
      this.host.pointerLeave();
      this.setCursor('');
      return EMPTY_INPUT;
    }
    const mode = r ? r.getCameraMode() : 'follow';
    const mapView = mode === 'map' || this.host.travelling();
    const combat = this.combatMode();
    this.keepLock(combat, mapView);
    this.lastCombat = combat;

    const intent = this.mapper.map(
      { down: this.down, pressed: this.pressed, released: this.released },
      {
        cameraYaw: r ? r.getCameraYaw() : 0,
        // the buttons strike and guard only when the mouse is looking (never for the click that took it)
        attack: combat && this.locked && this.modes.attack,
        block: combat && this.locked && this.modes.block,
        aim: r && mode === 'follow' ? this.cameraRay(r) : null,
      },
      dt,
    );
    if (intent.speed !== null) this.host.setSpeed(intent.speed);
    if (intent.togglePause) this.host.togglePause();
    if (intent.openWheel) this.host.openWheel();

    // the free cursor: what is under it, and what the pointer looks like
    const free = !mapView && !combat && !this.locked && !this.modes.lookHeld;
    if (free && this.ptr.seen && this.ptr.onView) {
      this.host.pointerMove(this.ptr.x, this.ptr.y);
      this.setCursor(this.host.cursor());
    } else {
      this.host.pointerLeave();
      this.setCursor(this.modes.lookHeld && !this.locked ? 'grabbing' : '');
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

  /** The weapon is drawn, or the player prefers the old scheme where the mouse always looks. */
  private combatMode(): boolean { return this.host.drawn() || !!this.host.settings().alwaysLook; }

  /** Is the street camera live and the interface out of the way? */
  private active(): boolean {
    if (this.host.captured() || !this.host.inGame()) return false;
    const r = this.host.renderer();
    return !!r && r.getCameraMode() === 'follow' && !this.host.travelling();
  }

  private ctx(onView: boolean): MouseCtx {
    return { active: this.active(), combat: this.combatMode(), locked: this.locked, onView };
  }

  /** The pointer is locked exactly while the mouse is wanted for looking: the right button held, or mouse-look mode. */
  private keepLock(combat: boolean, mapView: boolean): void {
    if (mapView) { this.exitLock(); return; }
    if (combat) {
      // a fight drew the weapon (or a panel closed): take the mouse back if a key press or click is recent enough to allow it
      if (!this.locked && (this.combatLook || !this.lastCombat) && recentGesture()) { this.combatLook = true; this.requestLock(); }
      return;
    }
    this.combatLook = false;
    if (this.locked && !this.modes.lookHeld) this.exitLock();
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

  /** G: draw or put away. Drawing takes the mouse at once (a key press is allowed to), putting away gives it back. */
  private onWeaponKey(): void {
    if (!this.active()) return;
    this.host.toggleWeapon();
    if (this.host.drawn()) { this.combatLook = true; this.requestLock(); } else this.combatLook = false;
  }

  // ---------------------------------------------------------------------------------------- mouse

  private onView(e: Event): boolean {
    const t = e.target as Node | null;
    return !!t && this.surface.contains(t);
  }

  private onMouseDown(e: MouseEvent): void {
    if (this.host.captured() || !this.host.inGame()) return;
    const r = this.host.renderer();
    if (r && r.getCameraMode() === 'map') {
      if (e.button === 0 && !this.host.travelling()) this.mapDragging = true;
      return;
    }
    const out = this.modes.down(e.button, e.clientX, e.clientY, this.ctx(true), performance.now() / 1000);
    this.apply(out);
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.mapDragging = false;
    if (this.host.captured() || !this.host.inGame()) { this.modes.clear(); return; }
    const out = this.modes.up(e.button, e.clientX, e.clientY, this.ctx(this.onView(e)), performance.now() / 1000);
    this.apply(out);
  }

  private apply(out: MouseOut): void {
    if (out.lock) {
      if (this.combatMode()) this.combatLook = true;
      this.requestLock();
    }
    if (out.unlock) this.exitLock();
    if (out.click) this.host.pointerClick(out.click.x, out.click.y);
  }

  private onMouseMove(e: MouseEvent): void {
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
    this.modes.travel(dx, dy);
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
    // far out the follow camera becomes the map (the rig switches by itself)
    r.zoom(Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60 + 0.5));
  }

  private onLockChange(): void {
    const was = this.locked;
    this.locked = document.pointerLockElement === this.surface;
    if (was && !this.locked) {
      const byUs = this.weReleasedLock;
      this.weReleasedLock = false;
      this.modes.attack = false; this.modes.block = false;
      // the browser took the pointer back (Esc): the mouse is free again; a drawn weapon stays drawn until G or the fight ends
      if (!byUs) { this.lockLostAt = performance.now(); this.combatLook = false; }
    }
  }
}

/** A key press or click happened lately enough for the browser to allow taking the pointer. */
function recentGesture(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return !!ua && ua.isActive;
}
