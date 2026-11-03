// "Go to…" (H1; `;` and the dock's boot): the places of your lands, by what they are and who keeps them — home, your fields, your work,
// the smithy, the mill, the market and its stalls, the merchant, the landing, the church, the alehouse, the manor, your lord, the
// household at work, the fields of the farmers you know, the next villages. Choose one and the walk is skipped: the time it would take
// passes and you stand at its door. Refused places say why. `{ panel: 'ext', name: 'goto', data?: { spot?: {x,z,kind?,id?} } }` (a spot
// scrolls to and marks that place). Logic in src/app/goto.ts; nothing here changes the sim but through `game.goto.go`.
import { h } from '../core/dom';
import { icon, ICON_NAMES, type IconName } from '../core/icons';
import { distanceText } from '../core/format';
import { where } from '../core/nav';
import { button } from '../components/widgets';
import { createWindow } from '../components/window';
import { GOTO_GROUP_TITLES, spanText, type GotoGroup, type GotoPlace } from '../../app/goto';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

const PANEL_ID = 'goto';
const ORDER: GotoGroup[] = ['home', 'yours', 'village', 'people', 'lands'];

const iconOf = (n: string): IconName => ((ICON_NAMES as readonly string[]).includes(n) ? n : 'pin') as IconName;

/** The rows for a search: every word must be in the name or what it says about it. */
export function matches(p: Pick<GotoPlace, 'name' | 'sub'>, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${p.name} ${p.sub}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function gotoPanel(ctx: PanelCtx, req: { data?: unknown }): UiPanel {
  const api = ctx.game.goto;
  const win = createWindow({ title: 'Go to…', subtitle: 'Skip the walk within your lands', icon: 'signpost', size: 'md', onClose: () => ctx.close() });
  if (!api) {
    win.body.append(h('p.mu-dim.mu-ital', null, 'There is nowhere to go from here.'));
    return panelOf({ id: PANEL_ID, pauses: 'menu', backdropCloses: ctx }, win.el, {});
  }
  const spot = (req.data as { spot?: { x: number; z: number; kind?: string; id?: number } } | undefined)?.spot;
  const marked = spot ? api.find(spot)?.id ?? null : null;
  const search = h<HTMLInputElement>('input.mu-input', { type: 'search', placeholder: 'Search: the smithy, Wat, the mill, Ashburn…', 'aria-label': 'Search places', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div.mu-journal-people.mu-scroll', { style: { maxHeight: '52vh' } });
  const note = h('p.mu-small.mu-dim.mu-ital', { style: { margin: '6px 0 0' } });
  let rows: HTMLElement[] = [];

  const go = (p: GotoPlace): void => {
    const r = api.go(p);
    if (r.ok) { ctx.close(); return; }
    note.textContent = r.reason ?? 'You cannot go there now.';
    note.classList.remove('mu-dim');
  };

  const render = (): void => {
    const body = ctx.player.body();
    const all = api.places();
    const q = search.value.trim();
    const shown = all.filter((p) => !q || matches(p, q));
    rows = [];
    const out: HTMLElement[] = [];
    let first: HTMLElement | null = null;
    for (const g of ORDER) {
      const items = shown.filter((p) => p.group === g);
      if (!items.length) continue;
      out.push(h('div.mu-jhead.wide', null, GOTO_GROUP_TITLES[g]));
      for (const p of items) {
        const c = api.check(p, all);
        const how = c.ok ? `${c.mounted ? 'a ride' : 'a walk'} of ${spanText(c.seconds)}` : c.reason ?? '';
        const btn = button('Go', { size: 'small', icon: 'boot' as IconName, disabled: !c.ok, tip: c.ok ? `Skip ${how}${c.warn ? `. ${c.warn}` : ''}` : c.reason, onClick: () => go(p) });
        const row = h('div.mu-prow', { class: marked === p.id ? 'found' : '', 'data-place': p.id },
          h('span.mu-prow-ico', null, icon(iconOf(p.icon), 18)),
          h('div.mu-prow-main', null,
            h('div.mu-prow-name', null, h('b', null, p.name)),
            h('div.mu-prow-sub', null, [p.sub, body ? where(body.x, body.z, p.x, p.z) : distanceText(c.metres)].filter(Boolean).join(' · ')),
            h('div.mu-prow-sub', { class: c.ok ? 'mu-dim' : 'mu-bad', style: c.ok ? undefined : { color: 'var(--mu-vermilion, #a8321f)' } }, c.ok ? `${how}${c.warn ? ` · ${c.warn}` : ''}` : how)),
          btn);
        rows.push(row);
        out.push(row);
        if (marked === p.id) first = row;
      }
    }
    if (!out.length) out.push(h('p.mu-dim.mu-ital', null, q ? 'No place of that name that you know.' : 'You do not know the places hereabouts yet.'));
    list.replaceChildren(...out);
    if (first) (first as HTMLElement).scrollIntoView?.({ block: 'center' });
  };

  search.addEventListener('input', render);
  win.body.append(
    h('p.mu-small.mu-ink2', { style: { marginBottom: '8px' } }, 'Choose a place and the walk there passes (a short fade; the clock moves on by the time it would take, and the world goes on) and you stand at its door. Not in a fight, with the host, bound or on hostile land; not beyond your lands.'),
    search, list, note);
  win.showFoot(h('span.mu-dim.mu-small.mu-ital', null, 'Map travel (M) is for the far towns.'), h('div.mu-grow'), button('Close', { onClick: () => ctx.close() }));
  render();
  // the places move as the day goes on (the distances, the refusals); a search being typed is left alone
  ctx.interval(2000, () => { if (document.activeElement !== search) render(); });
  return panelOf({ id: PANEL_ID, pauses: 'menu', backdropCloses: ctx }, win.el, {
    key: (intent) => {
      if (intent.type === 'enter') { const first = rows.find((r) => !r.querySelector('button:disabled')); (first?.querySelector('button') as HTMLButtonElement | null)?.click(); return true; }
      return false;
    },
  });
}

registerPanel(PANEL_ID, (ctx, req) => gotoPanel(ctx, req));
