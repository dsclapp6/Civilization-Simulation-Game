// Inventory (I): what you carry (with weight and value), equipment slots, eat / drink / equip /
// drop / stash, and the household stores.
import type { EconomyUiExtras } from '../types';
import { QUALITY_NAMES, parseItemKey, type EquipSlot, type InventoryView, type ItemStack } from '../../sim/economy/types';
import { h } from '../core/dom';
import { formatMoney, thousands, trim, weightText } from '../core/format';
import { icon } from '../core/icons';
import { GOOD_CATEGORY_LABEL, GOOD_ICON, SLOT_ICON, SLOT_LABEL, SLOT_ORDER } from '../core/iconMap';
import { bar, button, chip, empty, heading, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { every, panelOf } from './base';

type View = 'carried' | 'stores';

export function inventoryPanel(ctx: PanelCtx): UiPanel {
  const win = createWindow({ title: 'Inventory', icon: 'bag', size: 'xl', tall: true, onClose: () => ctx.close() });
  const state: { view: View; selected: string | null; qty: number; signature: string } = { view: 'carried', selected: null, qty: 1, signature: '' };
  const root = h('div.mu-inv');
  win.body.append(root);
  win.body.classList.add('flush');

  const equippedKeys = (inv: InventoryView): Map<string, EquipSlot> => {
    const m = new Map<string, EquipSlot>();
    for (const [slot, key] of Object.entries(inv.equipment)) if (key) m.set(key, slot as EquipSlot);
    return m;
  };

  const report = (r: { ok: boolean; reason?: string }, ok: string): void => {
    ctx.say(r.ok ? 'info' : 'warn', r.ok ? ok : r.reason ?? 'That cannot be done.');
    state.signature = '';
    render();
  };

  const render = (): void => {
    const id = ctx.playerId();
    const inv = ctx.eco.inventory(id);
    const person = ctx.sim.state.persons.get(id);
    const hh = person ? ctx.sim.state.households.get(person.household) : undefined;
    const stores = hh ? ctx.eco.stores(hh.id) : [];
    const sig = JSON.stringify([inv.items.map((i) => [i.key, i.qty]), inv.money, inv.equipment, stores.map((s) => [s.key, s.qty]), state.view, state.selected, state.qty]);
    if (sig === state.signature) return;
    state.signature = sig;

    const items: ItemStack[] = state.view === 'carried' ? inv.items : stores;
    const worn = equippedKeys(inv);
    const sel = items.find((i) => i.key === state.selected) ?? null;
    if (!sel) state.selected = null;
    win.setTitle('Inventory', `${weightText(inv.weight)} of ${weightText(inv.capacity)} carried · ${formatMoney(inv.money)} in your purse`);

    // ---- left: equipment and load
    const load = bar(inv.weight > inv.capacity ? 'vermilion' : inv.weight > inv.capacity * 0.85 ? 'gold' : 'green', inv.weight / Math.max(1, inv.capacity));
    const slots = h('div.mu-slots', null, SLOT_ORDER.map((slot) => {
      const key = inv.equipment[slot];
      const stack = key ? inv.items.find((i) => i.key === key) : undefined;
      const el = h('div.mu-slot', { class: `${key ? 'filled' : ''}${state.selected === key && key ? ' sel' : ''}`, tip: key ? 'Click to select' : `${SLOT_LABEL[slot]}: nothing` },
        h('span.mu-slot-ico', null, icon(SLOT_ICON[slot], 20)),
        h('span.mu-slot-main', null, h('span.mu-tiny.mu-dim', null, SLOT_LABEL[slot]), h('span.mu-slot-name', null, key ? ctx.describe(key) : '—')),
        stack ? h('span.mu-dim.mu-small', null, weightText(stack.good.weight)) : null);
      if (key) el.addEventListener('click', () => { state.view = 'carried'; state.selected = key; state.signature = ''; render(); });
      return el;
    }));
    const left = h('div.mu-inv-left', null,
      heading('Worn and wielded', 'user'), slots,
      h('div.mu-hair'),
      h('div.mu-row.mu-between.mu-small', null, h('span', null, 'Load'), h('span.mu-num', null, `${weightText(inv.weight)} / ${weightText(inv.capacity)}`)),
      load.el,
      inv.weight > inv.capacity ? h('div.mu-vermilion.mu-small.mu-bold', null, 'Overloaded: you move slowly.') : null,
      h('div.mu-hair'),
      h('div.mu-row.mu-between', null, h('span.mu-row.mu-gap-6', null, icon('coin', 18), 'Purse'), h('b.mu-num.mu-big', null, formatMoney(inv.money))),
    );

    // ---- right: list
    const viewTabs = tabs([
      { id: 'carried', label: 'Carried', icon: 'bag', badge: inv.items.length },
      { id: 'stores', label: 'Household stores', icon: 'home', badge: stores.length },
    ], state.view, (v) => { state.view = v as View; state.selected = null; state.qty = 1; state.signature = ''; render(); });

    const total = items.reduce((n, i) => n + i.value, 0);
    const rows = items.map((s) => {
      const slot = worn.get(s.key);
      const row = h('div.mu-inv-item.mu-li.click', { class: s.key === state.selected ? 'sel' : '' },
        h('span.mu-inv-ico', null, icon(GOOD_ICON[s.good.category], 18)),
        h('span.mu-grow.mu-row.mu-gap-8', null, h('b', null, ctx.describe(s.key)), slot ? chip(SLOT_LABEL[slot], 'lapis') : null),
        h('span.mu-inv-qty.mu-num', null, `× ${thousands(s.qty)}`),
        h('span.mu-inv-w.mu-num.mu-dim', null, weightText(s.good.weight * s.qty)),
        h('span.mu-inv-v.mu-num.mu-gold', { tip: 'Estimated worth at the nearest market' }, formatMoney(s.value)));
      row.addEventListener('click', () => { state.selected = s.key; state.qty = 1; state.signature = ''; render(); });
      return row;
    });

    const detail = sel ? detailPane(sel, worn.get(sel.key)) : h('p.mu-dim.mu-small.mu-ital.mu-center', null, items.length ? 'Select something to see what you can do with it.' : '');
    const right = h('div.mu-inv-right', null, viewTabs.el, h('div.mu-tabbar-rule'),
      h('div.mu-inv-list.mu-scroll', null, rows.length ? rows : empty(state.view === 'carried' ? 'You carry nothing but your clothes.' : 'The household stores are empty.')),
      h('div.mu-inv-foot', null, h('span.mu-dim.mu-small', null, `${items.length} kinds · worth about ${formatMoney(total)}`)),
      h('div.mu-inv-detail', null, detail));
    root.replaceChildren(left, right);
  };

  const detailPane = (s: ItemStack, slot: EquipSlot | undefined): HTMLElement => {
    const id = ctx.playerId();
    const g = s.good;
    const parsed = parseItemKey(s.key);
    const maxQty = s.qty;
    state.qty = Math.max(1, Math.min(maxQty, state.qty));
    const qtyCtl = maxQty > 1 ? h('div.mu-qty', null,
      button('', { icon: 'minus', size: 'small', class: 'icon', disabled: state.qty <= 1, onClick: () => { state.qty--; state.signature = ''; render(); } }),
      h('span.mu-qty-n.mu-num', null, String(state.qty)),
      button('', { icon: 'plus', size: 'small', class: 'icon', disabled: state.qty >= maxQty, onClick: () => { state.qty++; state.signature = ''; render(); } }),
      button('All', { size: 'small', onClick: () => { state.qty = maxQty; state.signature = ''; render(); } })) : null;
    const food = g.food !== undefined;
    const acts: HTMLElement[] = [];
    if (state.view === 'carried') {
      if (food) acts.push(button(g.category === 'drink' ? 'Drink' : 'Eat', { icon: g.category === 'drink' ? 'cup' : 'bread', variant: 'primary', onClick: () => report(ctx.eco.consume(id, s.key, state.qty), `You ${g.category === 'drink' ? 'drink' : 'eat'} ${ctx.describe(s.key, state.qty)}.`) }));
      if (g.slot && slot === undefined) acts.push(button(g.slot === 'main' || g.slot === 'off' ? 'Wield' : 'Wear', { icon: SLOT_ICON[g.slot], variant: food ? '' : 'primary', onClick: () => report(ctx.eco.equip(id, g.slot as EquipSlot, s.key), `You equip the ${ctx.describe(s.key)}.`) }));
      if (slot !== undefined) acts.push(button('Take off', { icon: SLOT_ICON[slot], onClick: () => report(ctx.eco.equip(id, slot, null), `You put away the ${ctx.describe(s.key)}.`) }));
      acts.push(button('Stash at home', { icon: 'home', tip: 'Move to the household stores', onClick: () => report(ctx.eco.stash(id, s.key, state.qty), `${ctx.describe(s.key, state.qty)} goes into the stores.`) }));
      acts.push(button('Drop', { icon: 'arrow_down', variant: 'danger', tip: 'Leave it on the ground', onClick: () => {
        const drop = (ctx.eco as unknown as EconomyUiExtras).drop;
        const r = drop ? drop.call(ctx.eco, id, s.key, state.qty) : ctx.eco.give(id, 0, s.key, state.qty);
        report(r, `You drop ${ctx.describe(s.key, state.qty)}.`);
      } }));
    } else {
      acts.push(button('Take out', { icon: 'bag', variant: 'primary', onClick: () => report(ctx.eco.stash(id, s.key, -state.qty), `You take ${ctx.describe(s.key, state.qty)} from the stores.`) }));
    }
    return h('div.mu-col.mu-gap-6', null,
      h('div.mu-row.mu-gap-8', null, h('h4', { style: { margin: 0 } }, ctx.describe(s.key)), chip(GOOD_CATEGORY_LABEL[g.category], ''), parsed.quality !== undefined && g.quality ? chip(QUALITY_NAMES[parsed.quality], 'gold') : null),
      h('div.mu-small.mu-dim', null,
        `${trim(g.weight, 1)} kg each · about ${formatMoney(Math.round(s.value / Math.max(1, s.qty) * 2) / 2)} each`,
        food ? ` · fills ${Math.round((g.food ?? 0) * 100)}% of a day's hunger` : '', g.spoilDays ? ` · keeps about ${g.spoilDays} days` : ''),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '2px' } }, qtyCtl ? h("div.mu-row", { style: { marginRight: "10px" } }, qtyCtl) : null, acts));
  };

  render();
  return panelOf({ id: 'inventory', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, {
    tick: every(0.6, render),
  });
}
