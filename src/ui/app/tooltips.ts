// Delegated tooltips: any element with a `data-tip` attribute shows a parchment tip near the pointer.
// Positions are computed in the UI's own (possibly scaled) coordinate space.
import { h } from '../core/dom';

export class Tooltips {
  private readonly tip = h('div.mu-tip');
  private current: HTMLElement | null = null;
  private timer = 0;
  private scale = 1;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly root: HTMLElement, layer: HTMLElement) {
    layer.appendChild(this.tip);
    this.tip.style.display = 'none';
    const add = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void): void => {
      root.addEventListener(type, fn as EventListener, true);
      this.offs.push(() => root.removeEventListener(type, fn as EventListener, true));
    };
    add('pointerover', (e) => this.over(e));
    add('pointermove', (e) => { if (this.current) this.place(e.clientX, e.clientY); });
    add('pointerdown', () => this.hide());
    add('wheel', () => this.hide());
    add('keydown', () => this.hide());
  }

  setScale(scale: number): void { this.scale = scale; }

  private over(e: PointerEvent): void {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
    if (el === this.current) return;
    window.clearTimeout(this.timer);
    this.current = el;
    if (!el) { this.tip.style.display = 'none'; return; }
    const text = el.getAttribute('data-tip') ?? '';
    if (!text) { this.tip.style.display = 'none'; return; }
    // a short delay so tips do not flicker while the mouse crosses a toolbar
    this.timer = window.setTimeout(() => {
      this.tip.textContent = text;
      this.tip.style.display = 'block';
      this.place(e.clientX, e.clientY);
    }, 220);
  }

  private place(clientX: number, clientY: number): void {
    const s = this.scale || 1;
    const rect = this.root.getBoundingClientRect();
    const rw = this.root.clientWidth;
    const rh = this.root.clientHeight;
    let x = (clientX - rect.left) / s + 14;
    let y = (clientY - rect.top) / s + 18;
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    if (x + tw + 8 > rw) x = Math.max(8, (clientX - rect.left) / s - tw - 12);
    if (y + th + 8 > rh) y = Math.max(8, (clientY - rect.top) / s - th - 12);
    this.tip.style.left = `${Math.round(x)}px`;
    this.tip.style.top = `${Math.round(y)}px`;
  }

  hide(): void {
    window.clearTimeout(this.timer);
    this.current = null;
    this.tip.style.display = 'none';
  }

  dispose(): void {
    this.hide();
    for (const off of this.offs) off();
    this.tip.remove();
  }
}
