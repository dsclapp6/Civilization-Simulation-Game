// The crosshair (first person and the mouse looking): a small mark in the middle of the view; what is under it within
// reach is named below it with what E does there. With the cursor free, or waiting for the click that takes the mouse,
// a one-line hint says how to look around again; clicking it does.
import { h } from '../core/dom';
import { keycap } from '../components/widgets';
import type { GameServices, UiHost } from '../types';

interface Prompt { label: string; targetLabel: string; enabled: boolean; reason?: string }

export class Crosshair {
  readonly el = h('div.mu-look');
  private readonly mark = h('div.mu-xhair.mu-hide', null, h('i.dot'), h('i.t'), h('i.b'), h('i.l'), h('i.r'));
  private readonly label = h('div.mu-xhair-label.mu-hide');
  private readonly hint = h('button.mu-look-hint.mu-hide', { type: 'button' });
  private hintKey = '';
  private labelKey = '';

  constructor(private readonly host: UiHost) {
    this.hint.addEventListener('click', (e) => { e.stopPropagation(); this.host.takeMouse?.(); });
    // the hint is not the world: a press on it must not reach the view underneath
    this.hint.addEventListener('mousedown', (e) => e.stopPropagation());
    this.el.append(this.mark, this.label, this.hint);
  }

  /** `show`: the HUD is up and no page is open. */
  update(game: GameServices | null, show: boolean): void {
    const state = show && this.host.renderer()?.cameraMode?.() === 'follow' ? this.host.mouseState?.() ?? null : null;
    this.mark.classList.toggle('mu-hide', state !== 'look');
    document.body.classList.toggle('mu-looking', state === 'look');
    // what is under the crosshair
    let p: Prompt | null = null;
    if (state === 'look' && game) {
      const hud = game.player.hud();
      if (hud && hud.combat?.state !== 'down') p = hud.prompt;
    }
    if (p) {
      const key = `${p.label}|${p.targetLabel}|${p.enabled ? 1 : 0}|${p.reason ?? ''}`;
      if (key !== this.labelKey) {
        this.labelKey = key;
        this.label.replaceChildren(
          h('div.mu-xhair-name', null, p.targetLabel),
          h('div.mu-xhair-do', null, keycap('E', true), ' ', p.label),
          ...(p.reason && !p.enabled ? [h('div.mu-xhair-why', null, p.reason)] : []));
        this.label.classList.toggle('off', !p.enabled);
      }
    } else this.labelKey = '';
    this.label.classList.toggle('mu-hide', !p);
    // the hint
    const hk = state === 'wait' ? 'wait' : state === 'free' ? 'free' : '';
    if (hk !== this.hintKey) {
      this.hintKey = hk;
      this.hint.classList.toggle('mu-hide', !hk);
      if (hk === 'wait') this.hint.replaceChildren('Click to look around');
      else if (hk === 'free') this.hint.replaceChildren('Cursor free · ', keycap('Alt', true), ' or click here to look around');
    }
  }
}
