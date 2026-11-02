// The accolade (docs/CIV.md §9): the scene card when someone is made a knight — the player (by their liege, by a lord, for valour on
// the field), or one of the player's men dubbed by their hand (ruler mode's *Dub a knight*). A vigil in the church, then the sword on the
// shoulders; "Sir …" from then on in the HUD. `{ panel: 'ext', name: 'accolade', id: knight, data: { kind, by } }`.
import { h, svgEl } from '../core/dom';
import { accoladeScene, type AccoladeData } from '../core/accolade';
import { shield } from '../core/ornament';
import { button } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';
import { messagePanel } from './system';

/** A sword laid point-down over a shield, in the gold of the window corners. */
function art(heraldry: Parameters<typeof shield>[0]): HTMLElement {
  const sword = svgEl('svg', { viewBox: '0 0 40 120', width: '44', height: '132', class: 'mu-accolade-sword', 'aria-hidden': 'true' },
    svgEl('path', { d: 'M20 4l3 6v62h-6V10z', fill: '#e9e2cf', stroke: '#2a1b0f', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }),
    svgEl('path', { d: 'M20 10v62', stroke: 'rgba(42,27,15,.35)', 'stroke-width': '1' }),
    svgEl('path', { d: 'M6 72h28v5H6z', fill: 'url(#mu-gold)', stroke: '#5a3d08', 'stroke-width': '1.3' }),
    svgEl('path', { d: 'M17 77h6v22h-6z', fill: '#4a2f12', stroke: '#2a1b0f', 'stroke-width': '1.2' }),
    svgEl('circle', { cx: '20', cy: '104', r: '5.2', fill: 'url(#mu-gold)', stroke: '#5a3d08', 'stroke-width': '1.3' }));
  return h('div.mu-accolade-art', null, h('div.mu-accolade-shield', null, shield(heraldry, 96)), sword);
}

export function accoladePanel(ctx: PanelCtx, req: { id?: number; data?: unknown }): UiPanel {
  const d = (req.data ?? {}) as Partial<AccoladeData>;
  const data: AccoladeData = { kind: d.kind ?? 'lord', knight: req.id ?? d.knight ?? ctx.playerId(), by: d.by ?? 0 };
  const scene = accoladeScene(ctx.sim, data);
  if (!scene) return messagePanel(ctx, 'The accolade', 'Nobody is there to be knighted.');
  const win = createWindow({ title: scene.title, subtitle: `${scene.place}`, icon: 'crown', size: 'md', onClose: () => ctx.close() });
  const p = ctx.sim.state.persons.get(scene.knight);
  const house = ctx.sim.state.houses.get(p?.house ?? 0);
  win.body.append(
    h('div.mu-accolade', null,
      art(house?.heraldry),
      h('div.mu-accolade-text', null,
        ...scene.beats.map((b, i) => h('p.mu-accolade-beat', { style: { animationDelay: `${0.3 + i * 1.5}s` } }, b)),
        h('div.mu-accolade-arise', { style: { animationDelay: `${0.3 + scene.beats.length * 1.5}s` } }, scene.arise))),
  );
  win.showFoot(h('div.mu-grow'), button(scene.kind === 'player' ? 'Well done' : 'Rise', { variant: 'primary', size: 'big', icon: 'crown', onClick: () => ctx.close() }));
  // no group: the scene stacks over whatever is open (ruler mode's *Dub a knight* must not lose its page)
  return panelOf({ id: 'accolade', pauses: 'always', backdropCloses: null }, win.el, {
    key: (intent) => { if (intent.type === 'enter') { ctx.close(); return true; } return false; },
  });
}

registerPanel('accolade', (ctx, req) => accoladePanel(ctx, req));
