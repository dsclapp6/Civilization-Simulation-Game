// The compass ribbon (top centre): which way you face, and where the things worth finding are — the tracked
// objective first, then a pinned place, a tracked person, home, work, the church and the market — each with its
// distance. Marks beyond the edge of the ribbon sit at the edge with a chevron, so "turn left" reads at a glance.
import { h } from '../core/dom';
import { distanceText } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { relativeYaw, ribbonSpot, ribbonTicks, hex } from '../core/nav';
import type { NavMarker, NavState } from './navstate';

const SPAN = (200 * Math.PI) / 180;
const MAX_MARKS = 6;

const KIND_ICON: Record<NavMarker['kind'], IconName> = {
  objective: 'flag', home: 'home', work: 'hammer', person: 'user', place: 'pin', church: 'church', market: 'market', pin: 'pin',
};

const PRIORITY: Record<NavMarker['kind'], number> = { objective: 0, pin: 1, person: 2, work: 3, home: 4, place: 5, church: 6, market: 7 };

interface Slot { el: HTMLElement; ico: HTMLElement; dist: HTMLElement; kind: string; side: number }

export class Compass {
  readonly el = h('div.mu-compass.mu-hide');
  private readonly canvas = h<HTMLCanvasElement>('canvas.mu-compass-ticks');
  private readonly marks = h('div.mu-compass-marks');
  private readonly slots: Slot[] = [];
  private ctx2d: CanvasRenderingContext2D | null = null;
  private width = 0;
  private height = 30;
  private lastYaw = NaN;
  private lastSig = '';
  private readonly accepted: Array<{ m: NavMarker; x: number; inside: boolean; side: -1 | 0 | 1 }> = [];

  constructor() {
    this.el.append(this.canvas, this.marks, h('div.mu-compass-notch'));
  }

  /** The layout size changed (window or interface scale): measure again on the next update. */
  resize(): void { this.width = 0; this.lastYaw = NaN; }

  setVisible(v: boolean): void { this.el.classList.toggle('mu-hide', !v); }

  update(nav: NavState): void {
    if (!this.width) {
      const w = this.el.clientWidth;
      if (!w) return;
      this.width = w;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${this.height}px`;
      this.ctx2d = this.canvas.getContext('2d');
      this.ctx2d?.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.lastYaw = NaN;
    }
    // marks, in order of importance, without piling on top of each other
    const acc = this.accepted;
    acc.length = 0;
    const order = nav.markers.slice().sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.dist - b.dist);
    for (const m of order) {
      if (acc.length >= MAX_MARKS) break;
      if (m.dist < 4) continue;
      const spot = ribbonSpot(relativeYaw(m.yaw, nav.camYaw), this.width, SPAN, 22);
      // off the ribbon: only the things that matter most are pinned to the edge
      if (!spot.inside && PRIORITY[m.kind] > 2) continue;
      if (acc.some((a) => Math.abs(a.x - spot.x) < 30 && (a.inside || spot.inside || a.side === spot.side))) continue;
      acc.push({ m, x: spot.x, inside: spot.inside, side: spot.side });
    }
    let sig = '';
    for (const a of acc) sig += `${a.m.id}:${Math.round(a.x)}:${Math.round(a.m.dist / 5)};`;
    if (!(Math.abs(nav.camYaw - this.lastYaw) <= 0.004)) { this.lastYaw = nav.camYaw; this.drawTicks(nav.camYaw); }
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.paintMarks();
    }
  }

  private drawTicks(yaw: number): void {
    const g = this.ctx2d;
    if (!g) return;
    const w = this.width, hgt = this.height;
    g.clearRect(0, 0, w, hgt);
    const ticks = ribbonTicks(yaw, w, SPAN);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    for (const t of ticks) {
      // fade towards the edges
      const edge = Math.min(1, Math.min(t.x, w - t.x) / 46);
      g.globalAlpha = 0.25 + 0.75 * edge;
      g.strokeStyle = '#4f3924';
      g.lineWidth = t.major ? 1.6 : 1;
      g.beginPath();
      g.moveTo(t.x + 0.5, hgt - 3);
      g.lineTo(t.x + 0.5, hgt - (t.letter ? 11 : 7));
      g.stroke();
      if (t.letter) {
        g.font = t.major ? '700 14px "Iowan Old Style", Palatino, Georgia, serif' : '600 11px "Iowan Old Style", Palatino, Georgia, serif';
        g.fillStyle = t.letter === 'N' ? '#ac2818' : '#2a1b0f';
        g.fillText(t.letter, t.x, hgt - (t.major ? 14 : 14));
      }
    }
    g.globalAlpha = 1;
  }

  private paintMarks(): void {
    const acc = this.accepted;
    while (this.slots.length < acc.length) this.slots.push(this.makeSlot());
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const a = acc[i];
      if (!a) { s.el.classList.add('mu-hide'); continue; }
      s.el.classList.remove('mu-hide');
      s.el.style.left = `${Math.round(a.x)}px`;
      s.el.classList.toggle('primary', a.m.primary);
      s.el.classList.toggle('edge', !a.inside);
      s.el.dataset.side = String(a.side);
      s.el.style.setProperty('--c', hex(a.m.color));
      s.el.setAttribute('data-tip', `${a.m.label} · ${distanceText(a.m.dist)}`);
      if (s.kind !== a.m.kind) { s.kind = a.m.kind; s.ico.replaceChildren(icon(KIND_ICON[a.m.kind], 15)); }
      s.dist.textContent = distanceText(a.m.dist);
    }
  }

  private makeSlot(): Slot {
    const ico = h('span.mu-compass-ico');
    const dist = h('span.mu-compass-dist');
    const el = h('div.mu-compass-mark', null, ico, dist);
    this.marks.appendChild(el);
    return { el, ico, dist, kind: '', side: 0 };
  }
}
