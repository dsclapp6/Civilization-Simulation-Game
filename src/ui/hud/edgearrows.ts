// Arrows on the screen edge for the places the player is meant to find that are out of sight: the tracked objective
// first, then a pinned place. When the place is on the screen the beacon in the world speaks for it and the arrow
// goes away; when it is off to a side or behind you the arrow sits on that edge and points the way, with the distance.
import { h, svgEl } from '../core/dom';
import { distanceText } from '../core/format';
import { edgeArrow, hex, relativeYaw } from '../core/nav';
import type { UiHost } from '../types';
import type { NavMarker, NavState } from './navstate';

/** The arrows keep clear of the plates in the corners, the compass above and the prompt below. */
function margins(w: number, h: number, scale: number): { l: number; r: number; t: number; b: number } {
  // the columns of plates at the sides are 292 interface pixels wide (plus a gutter), the compass 74 high
  const side = Math.max(120, Math.min(w * 0.36, 336 * scale));
  return { l: side, r: side, t: 94 * scale, b: Math.min(150, h * 0.2) };
}

interface Item { el: HTMLElement; arrow: HTMLElement; label: HTMLElement; shown: boolean }

export class EdgeArrows {
  readonly el = h('div.mu-edge');
  private readonly items: Item[] = [];

  /** `scale` is the interface scale: screen pixels per interface pixel. */
  update(nav: NavState, host: UiHost, scale: number): void {
    const r = host.renderer();
    const want: NavMarker[] = [];
    if (nav.street && r) {
      const primary = nav.primary();
      if (primary) want.push(primary);
      for (const m of nav.markers) if (m.kind === 'pin' || (m.kind === 'person' && !m.primary)) want.push(m);
    }
    const w = window.innerWidth, hgt = window.innerHeight;
    let n = 0;
    for (const m of want) {
      if (n >= 2 || !r) break;
      if (m.dist < 8) continue;
      const scr = r.project(m.x, m.y, m.z);
      const a = edgeArrow(relativeYaw(m.yaw, nav.camYaw), scr, w, hgt, margins(w, hgt, scale));
      if (!a) continue;
      const it = this.item(n++);
      it.shown = true;
      it.el.classList.remove('mu-hide');
      it.el.style.setProperty('--c', hex(m.color));
      it.el.classList.toggle('primary', m.primary);
      it.el.style.transform = `translate(${Math.round(a.x / scale)}px, ${Math.round(a.y / scale)}px)`;
      it.arrow.style.transform = `rotate(${a.angle.toFixed(3)}rad)`;
      // the label goes on the side of the arrow that faces the middle of the screen
      it.el.dataset.v = a.y < 130 ? 'top' : a.y > hgt - 190 ? 'bottom' : 'mid';
      it.el.dataset.h = a.x < w / 2 ? 'left' : 'right';
      const text = `${m.label || 'Here'} · ${distanceText(m.dist)}`;
      if (it.label.textContent !== text) it.label.textContent = text;
    }
    for (let i = n; i < this.items.length; i++) {
      if (this.items[i].shown) { this.items[i].shown = false; this.items[i].el.classList.add('mu-hide'); }
    }
  }

  private item(i: number): Item {
    let it = this.items[i];
    if (!it) {
      const arrow = h('span.mu-edge-arrow', null, svgEl('svg', { viewBox: '0 0 24 24', width: 28, height: 28, 'aria-hidden': 'true' },
        svgEl('path', { d: 'M12 2.4 20.6 20.4 12 15.8 3.4 20.4z', fill: 'currentColor', stroke: '#2a1b0f', 'stroke-width': 1.7, 'stroke-linejoin': 'round' })));
      const label = h('span.mu-edge-label');
      const el = h('div.mu-edge-item.mu-hide', null, arrow, label);
      this.el.appendChild(el);
      it = { el, arrow, label, shown: false };
      this.items[i] = it;
    }
    return it;
  }
}
