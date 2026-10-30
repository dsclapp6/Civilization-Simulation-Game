// The action wheel (hold E): every option on what the player is facing, grouped by category, with
// number keys, arrows + Enter, and the reason on anything disabled.
import type { ActionCategory, ActionOption } from '../../sim/actions';
import { h } from '../core/dom';
import { secondsText } from '../core/hudModel';
import { icon } from '../core/icons';
import { CATEGORY_ICON, CATEGORY_LABEL, CATEGORY_ORDER } from '../core/iconMap';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';

export function actionsPanel(ctx: PanelCtx): UiPanel {
  const target = ctx.player.target();
  const options = ctx.player.options();
  const win = createWindow({ title: target?.label ?? 'Actions', subtitle: options.length ? 'What will you do?' : '', icon: 'hand', size: 'sm', onClose: () => ctx.close() });

  // display order: by category, enabled first within it (the registry already orders enabled first)
  const byCat = new Map<ActionCategory, ActionOption[]>();
  for (const o of options) {
    const list = byCat.get(o.category) ?? [];
    list.push(o);
    byCat.set(o.category, list);
  }
  const ordered: ActionOption[] = [];
  for (const cat of CATEGORY_ORDER) for (const o of byCat.get(cat) ?? []) ordered.push(o);

  let active = Math.max(0, ordered.findIndex((o) => o.enabled));
  const rows: HTMLElement[] = [];

  const run = (o: ActionOption): void => {
    if (!o.enabled) { ctx.say('warn', o.reason ?? 'You cannot do that now.'); return; }
    ctx.close();
    const outcome = ctx.player.perform(o);
    if (!outcome.ok && outcome.message) ctx.say('warn', outcome.message);
  };

  const setActive = (i: number): void => {
    active = Math.max(0, Math.min(ordered.length - 1, i));
    rows.forEach((r, k) => r.classList.toggle('active', k === active));
    rows[active]?.scrollIntoView({ block: 'nearest' });
  };

  const list = h('div.mu-wheel');
  if (!ordered.length) list.append(h('p.mu-empty', null, 'There is nothing to do here.'));
  let n = 0;
  for (const cat of CATEGORY_ORDER) {
    const group = byCat.get(cat);
    if (!group?.length) continue;
    list.append(h('div.mu-wheel-cat', null, icon(CATEGORY_ICON[cat], 15), CATEGORY_LABEL[cat]));
    for (const o of group) {
      const idx = n++;
      const row = h('button.mu-wheel-opt', { type: 'button', class: o.enabled ? '' : 'is-disabled' },
        h('span.mu-key', { class: idx < 9 ? '' : 'mu-hide' }, String(idx + 1)),
        h('span.mu-wheel-main', null,
          h('span.mu-wheel-label', null, o.label),
          o.preview ? h('span.mu-wheel-prev', null, o.preview) : null,
          !o.enabled && o.reason ? h('span.mu-wheel-reason', null, o.reason) : null),
        h('span.mu-wheel-time.mu-num', null, o.seconds > 0 ? secondsText(o.seconds) : ''));
      row.addEventListener('click', () => run(o));
      row.addEventListener('mouseenter', () => setActive(idx));
      rows.push(row);
      list.append(row);
    }
  }
  win.body.append(list);
  win.body.classList.add('flush');
  win.showFoot(h('span.mu-dim.mu-small', null, 'Number keys choose · ↑ ↓ and Enter · Esc closes'));
  setActive(active);

  return panelOf({ id: 'actions', group: 'main', pauses: 'never', mode: 'dock-right', backdropCloses: ctx }, win.el, {
    key: (intent) => {
      if (intent.type === 'digit' && ordered[intent.n - 1]) { run(ordered[intent.n - 1]); return true; }
      if (intent.type === 'arrow' && (intent.dir === 'up' || intent.dir === 'down')) { setActive(active + (intent.dir === 'down' ? 1 : -1)); return true; }
      if (intent.type === 'enter' && ordered[active]) { run(ordered[active]); return true; }
      return false;
    },
  });
}
