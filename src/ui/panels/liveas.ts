// "Live as" (V; docs/CIV.md §2): the confirmation card for taking up another life. `{ panel: 'ext', name: 'liveAs', id?, data?: { reason } }`
// — `id` is the person, else the one under the cursor (`player.hover`) or in front (`player.target`); `data.reason` is 'choose' (a
// person picked from a list: the journal, the family, the map, the action wheel) or 'rule' (the "Rule this town" button: `id` is the
// town's ruler). The card names who they are, where they live, what they were doing; confirming hands over to `ctx.liveAs`, which
// runs the glide or the fade and shows the "who you are now" card. A setting turns the card off ("Ask before living as someone").
import { h } from '../core/dom';
import { distanceText } from '../core/format';
import { icon } from '../core/icons';
import { liveAsCard, liveAsReason, liveAsTarget, type LiveAsCard } from '../core/liveAsModel';
import { shield } from '../core/ornament';
import { button, chip, kv, toggle } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiHooks, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

const PANEL_ID = 'liveAs';

export function liveAsPanel(ctx: PanelCtx, req: { id?: number; data?: unknown }): UiPanel {
  const reason = liveAsReason(req.data);
  const found = liveAsTarget(ctx.game, req.id);
  const card = found ? liveAsCard(ctx.game, found.id, reason) : null;

  // nobody to speak of: say how to choose
  if (!card) return noOnePanel(ctx, found === null);

  const rule = reason === 'rule';
  const title = rule ? `Rule through ${card.first}` : `Live as ${card.first}?`;
  const win = createWindow({ title, subtitle: rule ? 'Rule this town' : 'Take up another life', icon: 'user', size: 'md', onClose: () => ctx.close() });
  const msg = h('p.mu-small.mu-bad.mu-bold.mu-hide');

  const house = ctx.sim.state.houses.get(ctx.sim.state.persons.get(card.id)?.house ?? 0);
  const facts: Array<[string, string]> = [
    ['Lives in', card.place || '—'],
    ['Household', card.household],
    ['House', card.house || '—'],
    ['Doing now', card.doing],
  ];
  if (card.relation) facts.push(['To you', card.relation]);
  if (card.distance !== null) facts.push(['Where', card.distance < 6 ? 'right beside you' : `${distanceText(card.distance)} away`]);

  const me = ctx.sim.state.persons.get(ctx.playerId());
  const leaves = me ? me.first : 'You';
  win.body.append(
    h('div.mu-liveas', null,
      h('div.mu-liveas-head', null,
        shield(house?.heraldry, 62),
        h('div.mu-liveas-names', null,
          h('div.mu-liveas-name', null, card.name),
          h('div.mu-dim', null, `${card.age} years old · ${card.role}`),
          h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '6px' } }, chip(card.rankName, 'gold', 'shield'), card.canRule ? chip('Rules', 'lapis', 'crown', card.ruleLine || 'Rules a place') : null))),
      rule && card.ruleLine ? h('p.mu-liveas-rule', null, icon('crown', 15), `${card.first} ${card.ruleLine}. Live as them and the seat of government (U) is yours.`) : null,
      kv(facts),
      card.canSwitch
        ? h('p.mu-small.mu-ink2.mu-ital', null, ctx.sim.state.run.phase === 'choosing'
          ? `${card.first} goes on with ${card.sex === 'm' ? 'his' : 'her'} own life from here, run by the world.`
          : `${leaves} goes on with ${me?.sex === 'f' ? 'her' : 'his'} own life, run by the world. You may switch to anyone, any time (V).`)
        : h('p.mu-small.mu-bad.mu-bold', null, card.why),
      msg,
      h('label.mu-liveas-ask', null,
        toggle(ctx.settings().askBeforeLiveAs !== false, (v) => ctx.host.setSettings({ askBeforeLiveAs: v }), 'Ask before living as someone'),
        h('span', null, 'Ask before living as someone'),
        h('span.mu-dim.mu-tiny', null, '(also in the settings)'))),
  );

  const go = (): void => {
    if (!card.canSwitch) { msg.textContent = card.why; msg.classList.remove('mu-hide'); return; }
    const r = ctx.liveAs(card.id, { reason });
    if (!r.ok) { msg.textContent = r.reason ?? 'That cannot be done now.'; msg.classList.remove('mu-hide'); return; }
    ctx.close();
  };
  const confirmBtn = button(rule ? `Rule as ${card.first}` : `Live as ${card.first}`, { variant: 'primary', size: 'big', icon: 'user', disabled: !card.canSwitch, onClick: go });
  win.showFoot(
    card.canRule && card.isPlayer ? button('Open the seat of government', { icon: 'crown', onClick: () => { ctx.close(); ctx.open({ panel: 'ext', name: 'ruler' }); } }) : null,
    h('div.mu-grow'),
    button('Stay as you are', { onClick: () => ctx.close() }),
    confirmBtn,
  );
  // the setting asks for no card at all: go straight in (the first frame, so the panel stack is settled)
  const skip = ctx.settings().askBeforeLiveAs === false && card.canSwitch;
  return panelOf({ id: PANEL_ID, pauses: skip ? 'never' : 'menu', backdropCloses: ctx }, win.el, {
    mount: skip ? () => queueMicrotask(go) : undefined,
    key: (intent) => { if (intent.type === 'enter') { go(); return true; } return false; },
  });
}

/** V with nobody in front of you: how to choose someone. */
function noOnePanel(ctx: PanelCtx, nobody: boolean): UiPanel {
  const win = createWindow({ title: 'Live as someone', subtitle: 'Take up another life', icon: 'user', size: 'sm', onClose: () => ctx.close() });
  win.body.append(
    h('div.mu-prose', null,
      h('p', null, nobody
        ? 'Nobody is close enough to choose. Look at a person and press V (or hold E and choose Live as…).'
        : 'That person cannot be found.'),
      h('p.mu-small.mu-dim', null, 'You may live as anyone alive, at any time: the people you know in the journal, your family, or a settlement’s people on the map.')),
  );
  win.showFoot(
    button('People you know', { icon: 'users', onClick: () => { ctx.close(); ctx.open({ panel: 'journal', tab: 'people' }); } }),
    button('Family & House', { icon: 'tree', onClick: () => { ctx.close(); ctx.open({ panel: 'family' }); } }),
    button('Map', { icon: 'map', onClick: () => { ctx.close(); ctx.open({ panel: 'map' }); } }),
    h('div.mu-grow'),
    button('Close', { onClick: () => ctx.close() }),
  );
  return panelOf({ id: PANEL_ID, pauses: 'menu', backdropCloses: ctx }, win.el);
}

registerPanel(PANEL_ID, (ctx, req, _hooks: UiHooks) => liveAsPanel(ctx, req));

export type { LiveAsCard };
