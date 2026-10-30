// The DOM input layer (the one place in the player/app side that touches events): keyboard, mouse look with
// pointer lock, wheel zoom, map panning. It records what happened, hands the pure parts to InputMapper
// and ignores everything while the UI holds the focus (`ui.capturesInput()`).
import type { GameRenderer } from '../render/types';
import { EMPTY_INPUT, type InputState } from '../player/types';
import type { Speed } from '../core/time';
import { InputMapper, mouseLook } from './inputLogic';

export interface InputHost {
  /** A panel or menu has the focus: movement and the camera must not react. */
  captured(): boolean;
  /** The game is on screen (not a menu or loading screen). */
  inGame(): boolean;
  renderer(): GameRenderer | null;
  settings(): { mouseSensitivity: number; invertY: boolean };
  /** The journey is under way: the camera follows the party, the player cannot walk. */
  travelling(): boolean;
  openWheel(): void;
  setSpeed(speed: Speed): void;
  togglePause(): void;
  /** Esc closed the pointer lock with nothing open: show the pause menu. */
  escape(): void;
}

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const GAME_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class InputLayer {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private readonly mapper = new InputMapper();
  private readonly cleanups: Array<() => void> = [];
  private attack = false;
  private block = false;
  private dragging = false;
  private dragMoved = 0;
  private locked = false;
  private weReleasedLock = false;
  private lastEscapeKey = -1000;

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
    on<WheelEvent>(surface, 'wheel', (e) => this.onWheel(e), { passive: false });
    on<Event>(surface, 'contextmenu', (e) => e.preventDefault());
    on<Event>(document, 'pointerlockchange', () => this.onLockChange());
  }

  dispose(): void {
    for (const c of this.cleanups) c();
    this.cleanups.length = 0;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get pointerLocked(): boolean { return this.locked; }

  // ---------------------------------------------------------------------------------------- per frame

  /**
   * Called once per frame before the sim steps. Returns the input for the player controller (empty while
   * a panel has the focus or the party is on the road) and performs the app-level intents.
   */
  read(dt: number): InputState {
    const r = this.host.renderer();
    if (this.host.captured() || !this.host.inGame()) {
      if (this.locked && !this.weReleasedLock) { this.weReleasedLock = true; document.exitPointerLock(); }
      this.clearHeld();
      return EMPTY_INPUT;
    }
    const mode = r ? r.getCameraMode() : 'follow';
    const mapView = mode === 'map' || this.host.travelling();
    const intent = this.mapper.map(
      { down: this.down, pressed: this.pressed, released: this.released },
      { cameraYaw: r ? r.getCameraYaw() : 0, attack: this.attack, block: this.block, aim: r && mode === 'follow' ? this.cameraRay(r) : null },
      dt,
    );
    if (intent.speed !== null) this.host.setSpeed(intent.speed);
    if (intent.togglePause) this.host.togglePause();
    if (intent.openWheel) this.host.openWheel();
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
    this.attack = false; this.block = false; this.dragging = false;
  }

  // ---------------------------------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (TYPING.has(t.tagName) || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Escape') this.lastEscapeKey = performance.now();
    if (this.host.captured() || !this.host.inGame()) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    this.down.add(e.code);
    this.pressed.add(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.down.delete(e.code)) this.released.add(e.code);
  }

  // ---------------------------------------------------------------------------------------- mouse

  private onMouseDown(e: MouseEvent): void {
    if (this.host.captured() || !this.host.inGame()) return;
    const r = this.host.renderer();
    this.dragging = true;
    this.dragMoved = 0;
    if (e.button === 0) this.attack = true;
    if (e.button === 2) this.block = true;
    if (r && r.getCameraMode() === 'follow' && !this.locked && e.button === 0) {
      // the first click takes the mouse for camera look (Esc gives it back); not on maps
      try { this.surface.requestPointerLock()?.catch?.(() => { /* denied: dragging still orbits */ }); } catch { /* old browsers throw instead */ }
    }
  }

  private onMouseUp(e: MouseEvent): void {
    if (e.button === 0) this.attack = false;
    if (e.button === 2) this.block = false;
    this.dragging = false;
  }

  private onMouseMove(e: MouseEvent): void {
    if (this.host.captured() || !this.host.inGame()) return;
    const r = this.host.renderer();
    if (!r) return;
    const dx = e.movementX, dy = e.movementY;
    if (!dx && !dy) return;
    const mode = r.getCameraMode();
    if (mode === 'map') {
      if (this.dragging && !this.host.travelling()) r.pan(dx, dy);
      return;
    }
    if (!this.locked && !this.dragging) return;
    this.dragMoved += Math.abs(dx) + Math.abs(dy);
    const s = this.host.settings();
    const look = mouseLook(dx, dy, s.mouseSensitivity, s.invertY);
    r.orbit(look.yaw, look.pitch);
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
      this.attack = false; this.block = false;
      // Esc leaves the pointer lock without delivering a key event: that is the pause menu
      const escapeKeyArrived = performance.now() - this.lastEscapeKey < 250;
      if (!byUs && !escapeKeyArrived && !this.host.captured() && this.host.inGame()) this.host.escape();
    }
  }
}
