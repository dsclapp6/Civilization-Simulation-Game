// Dev input for the world viewer (the game's real input module comes later): mouse orbit/pan,
// wheel zoom, WASD avatar movement (or free-fly), M map, F free camera, C cinematic, click to pick.
import type { GameRenderer } from '../types';
import type { MockView, MoveInput } from './mockView';

export class DevInput {
  private readonly keys = new Set<string>();
  private dragging = false;
  private button = 0;
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  private readonly move: MoveInput = { forward: 0, right: 0, run: false, cameraYaw: 0 };
  private readonly cleanup: (() => void)[] = [];
  onPick?: (text: string) => void;

  constructor(private readonly renderer: GameRenderer, private readonly view: MockView, el: HTMLElement) {
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(el, 'contextmenu', (e) => e.preventDefault());
    on(el, 'pointerdown', (e) => {
      this.dragging = true;
      this.button = e.button;
      this.lastX = this.downX = e.clientX;
      this.lastY = this.downY = e.clientY;
      el.setPointerCapture(e.pointerId);
    });
    on(el, 'pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      this.lastX = e.clientX; this.lastY = e.clientY;
      const mode = this.renderer.getCameraMode();
      if (mode === 'map' && this.button === 0) this.renderer.pan(dx, dy);
      else this.renderer.orbit(-dx * 0.0055, (mode === 'free' ? -1 : 1) * dy * 0.0045);
    });
    on(el, 'pointerup', (e) => {
      this.dragging = false;
      if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < 4 && e.button === 0) {
        const r = this.renderer.pick(e.clientX, e.clientY);
        if (r.type === 'character' || r.type === 'animal') this.view.select(r.id ?? -1);
        else this.view.select(-1);
        const p = r.point ? ` @ ${r.point.x.toFixed(1)}, ${r.point.y.toFixed(1)}, ${r.point.z.toFixed(1)}` : '';
        this.onPick?.(`${r.type}${r.id !== undefined ? ` #${r.id}` : ''}${p}`);
      }
    });
    on(el, 'wheel', (e) => {
      e.preventDefault();
      this.renderer.zoom(Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60 + 0.5));
    }, { passive: false });
    on(window, 'keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      this.keys.add(e.code);
      if (e.code === 'KeyM') this.toggleMap();
      if (e.code === 'KeyF') this.renderer.setCameraMode(this.renderer.getCameraMode() === 'free' ? 'follow' : 'free');
      if (e.code === 'KeyC') this.renderer.setCameraMode(this.renderer.getCameraMode() === 'cinematic' ? 'follow' : 'cinematic');
      if (e.code === 'KeyT') this.view.autoTime = !this.view.autoTime;
    });
    on(window, 'keyup', (e) => this.keys.delete(e.code));
    on(window, 'blur', () => this.keys.clear());
  }

  toggleMap(): void {
    const toMap = this.renderer.getCameraMode() !== 'map';
    this.view.setMode(toMap ? 'map' : 'street');
    this.renderer.setCameraMode(toMap ? 'map' : 'follow');
  }

  /** Avatar movement for this frame (null in free camera mode, which flies instead). */
  update(dt: number): MoveInput | null {
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const u = (k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    const fast = k.has('ShiftLeft') || k.has('ShiftRight');
    const mode = this.renderer.getCameraMode();
    if (mode === 'free') {
      this.renderer.moveFree(f, r, u, dt, fast);
      return null;
    }
    if (mode === 'map') {
      if (f || r) this.renderer.pan(-r * dt * 600, f * dt * 600);
      return null;
    }
    this.move.forward = f;
    this.move.right = r;
    this.move.run = fast;
    this.move.cameraYaw = this.renderer.getCameraYaw();
    return this.move;
  }

  dispose(): void { for (const c of this.cleanup) c(); }
}
