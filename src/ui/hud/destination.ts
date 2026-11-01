// Where a click-to-act walk is heading: a small ring on the ground at the destination with the thing's name, so the
// click visibly "took". It goes when you arrive or take over with a key.
import { h } from '../core/dom';
import { icon } from '../core/icons';
import type { GameServices, UiHost } from '../types';

export class Destination {
  readonly el = h('div.mu-dest.mu-hide');
  private readonly label = h('span.mu-dest-label');
  private shown = false;
  private text = '';

  constructor() {
    this.el.append(h('span.mu-dest-ring'), h('span.mu-dest-tag', null, icon('boot', 13), this.label));
  }

  update(game: GameServices, host: UiHost, scale: number): void {
    const going = game.player.hud()?.going ?? null;
    const r = host.renderer();
    const scr = going && r ? r.project(going.x, game.sim.world.heightAt(going.x, going.z) + 0.1, going.z) : null;
    if (!going || !scr) {
      if (this.shown) { this.shown = false; this.el.classList.add('mu-hide'); }
      return;
    }
    if (!this.shown) { this.shown = true; this.el.classList.remove('mu-hide'); }
    const text = going.action ? `${going.action}${going.label ? ` · ${going.label}` : ''}` : going.label || 'Walking here';
    if (text !== this.text) { this.text = text; this.label.textContent = text; }
    this.el.style.transform = `translate(${Math.round(scr.x / scale)}px, ${Math.round(scr.y / scale)}px)`;
  }
}
