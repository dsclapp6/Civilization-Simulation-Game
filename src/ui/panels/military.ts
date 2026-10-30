// The command panel (C): your place in arms — company, army, troops, morale, supplies, orders by rank (SPEC §7) —
// and an overview of the armies, sieges, battles, wars and prisoners of the continent.
import { dist } from '../../core/math';
import type { MilitaryRuntime, ArmyDetail, BattleOrder, CaptiveView } from '../../sim/military/types';
import { BATTLE_ORDERS } from '../../sim/military/types';
import type { Simulation } from '../../sim/sim';
import { fullName } from '../../sim/state';
import { h, replace } from '../core/dom';
import { formatMoney, plural } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { bar, button, chip, empty, heading, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { tabKeys } from '../core/tabkeys';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

type Tab = 'command' | 'armies' | 'forces';

const TROOP_LABEL: Record<string, { label: string; icon: IconName }> = {
  levy: { label: 'Levy spearmen', icon: 'users' },
  archers: { label: 'Archers', icon: 'archery' },
  crossbowmen: { label: 'Crossbowmen', icon: 'archery' },
  men_at_arms: { label: 'Men-at-arms', icon: 'shield' },
  sergeants: { label: 'Mounted sergeants', icon: 'horse' },
  knights: { label: 'Knights', icon: 'helm' },
  mercenaries: { label: 'Mercenaries', icon: 'coin' },
};

const TASK_TEXT: Record<string, string> = {
  muster: 'mustering', march: 'on the march', siege: 'besieging', raid: 'raiding', battle: 'in battle', garrison: 'in camp', disband: 'disbanding',
};

const ORDER_INFO: Record<BattleOrder, { label: string; tip: string }> = {
  hold: { label: 'Hold', tip: 'Stand fast: stronger defence, weaker attack' },
  advance: { label: 'Advance', tip: 'Press forward in good order' },
  charge: { label: 'Charge', tip: 'A fierce attack, at the price of heavier losses' },
  loose: { label: 'Loose', tip: 'Archers and crossbows shoot at will: a stronger opening volley' },
  retreat: { label: 'Fall back', tip: 'Break off and withdraw: fewer lives lost, the field given up' },
  follow: { label: 'Follow me', tip: 'The men you command follow you' },
};

const LEVEL_TEXT = { self: 'yourself', squad: 'your squad of eight', company: 'your company', army: 'the whole army' } as const;

function milOf(ctx: PanelCtx): MilitaryRuntime | undefined {
  return ctx.sim.services.military as MilitaryRuntime | undefined;
}

export function armyPanel(ctx: PanelCtx, startTab: Tab = 'command'): UiPanel {
  const sim: Simulation = ctx.sim;
  const mil = milOf(ctx);
  const win = createWindow({ title: 'Command', subtitle: 'Your place in arms, and the armies of the land', icon: 'swords', size: 'xl', tall: true, onClose: () => ctx.close() });
  if (!mil) {
    win.body.append(empty('Nobody here has raised a banner yet.'));
    return panelOf({ id: 'army', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
  }
  let tab: Tab = startTab;
  let target = -1;
  let message = '';
  let lastSig = '';
  const content = h('div.mu-army');
  const tabsEl = tabs([
    { id: 'command', label: 'Command', icon: 'swords' },
    { id: 'armies', label: 'Armies & wars', icon: 'map' },
    { id: 'forces', label: 'Forces', icon: 'shield' },
  ], tab, (id) => { tab = id as Tab; tabsEl.set(tab); lastSig = ''; render(); });
  win.body.classList.add('flush');
  win.body.append(tabsEl.el, h('div.mu-tabbar-rule'), content);

  const me = () => sim.state.persons.get(ctx.playerId());
  const act = (r: { ok: boolean; reason?: string }, ok: string): void => {
    message = r.ok ? ok : r.reason ?? 'That cannot be done.';
    ctx.say(r.ok ? 'info' : 'warn', message);
    lastSig = '';
    render();
  };

  // ---------------------------------------------------------------- command
  const troops = (a: ArmyDetail): HTMLElement =>
    h('div.mu-row.mu-wrap.mu-gap-6', null, Object.entries(a.troops).filter(([, n]) => n > 0).map(([k, n]) => {
      const t = TROOP_LABEL[k] ?? { label: k, icon: 'users' as IconName };
      return chip(`${n} ${t.label.toLowerCase()}`, '', t.icon);
    }));

  const armyCard = (a: ArmyDetail, mine: boolean): HTMLElement => {
    const morale = bar(a.morale > 0.55 ? 'green' : a.morale > 0.3 ? 'gold' : 'vermilion', a.morale, { thin: true });
    const food = bar(a.supplyDays > 4 ? 'green' : a.supplyDays > 1.5 ? 'gold' : 'vermilion', Math.min(1, a.supplyDays / 10), { thin: true });
    return h('div.mu-card', { class: mine ? 'sel' : '' },
      h('div.mu-row.mu-between.mu-top', null,
        h('div', null,
          h('h4', null, `Army of ${a.houseName}`),
          h('div.mu-small.mu-dim', null, `${plural(a.size, 'man', 'men')} · led by ${a.commanderName} · ${TASK_TEXT[a.task] ?? a.task}${a.destination ? ` → ${a.destination}` : ''}`)),
        h('div.mu-row.mu-gap-6', null,
          a.owed > 0 ? chip(`Arrears ${formatMoney(a.owed)}`, 'vermilion', 'warning', 'Wages the House could not pay: the men grumble and desert') : null,
          a.funds > 0 ? chip(`Chest ${formatMoney(a.funds)}`, 'gold', 'purse', 'Plunder and ransoms, shared out when the army disbands') : null,
          a.wounded > 0 ? chip(`${a.wounded} hurt`, 'vermilion', 'heart') : null)),
      h('div', { style: { margin: '8px 0' } }, troops(a)),
      h('div.mu-grid.c2', null,
        h('div', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Morale'), morale.el),
        h('div', null, h('div.mu-tiny.mu-dim.mu-caps', null, `Food: ${plural(a.supplyDays, "day")}`), food.el)));
  };

  const places = (a: ArmyDetail): Array<{ id: number; name: string; kind: string; d: number; hostile: boolean }> => {
    const out: Array<{ id: number; name: string; kind: string; d: number; hostile: boolean }> = [];
    for (const s of sim.world.settlements) {
      const lord = mil.lordHouse(s.id);
      out.push({ id: s.id, name: s.name, kind: s.kind, d: dist(a.x, a.z, s.x, s.z), hostile: !!lord && mil.hostile(a.house, lord) });
    }
    out.sort((p, q) => (q.hostile ? 1 : 0) - (p.hostile ? 1 : 0) || p.d - q.d);
    return out.slice(0, 40);
  };

  const orders = (a: ArmyDetail, level: 'army'): HTMLElement => {
    void level;
    const list = places(a);
    if (target < 0 || !list.some((p) => p.id === target)) target = list[0]?.id ?? -1;
    const sel = h<HTMLSelectElement>('select.mu-input', { 'aria-label': 'Destination' },
      list.map((p) => h('option', { value: p.id, selected: p.id === target }, `${p.name} (${p.kind}, ${(p.d / 1000).toFixed(1)} km)${p.hostile ? ' — enemy' : ''}`)));
    sel.addEventListener('change', () => { target = Number(sel.value); });
    const go = (kind: 'attack' | 'raid' | 'siege' | 'garrison', ok: string): (() => void) => () => act(mil.order(a.id, { kind, settlement: target }), ok);
    return h('div.mu-card', null,
      h('h4', null, 'Orders to the army'),
      h('div.mu-row.mu-gap-8', { style: { margin: '8px 0' } }, sel),
      h('div.mu-row.mu-wrap.mu-gap-6', null,
        button('Besiege', { icon: 'swords', variant: 'primary', tip: 'March there and sit down before the walls', onClick: go('siege', 'The army marches to besiege.') }),
        button('Raid', { icon: 'flame', tip: 'Burn the fields, drive off the herds, take captives', onClick: go('raid', 'The army marches to raid.') }),
        button('Garrison', { icon: 'shield', onClick: go('garrison', 'The army marches to garrison the place.') }),
        button('Hold here', { onClick: () => act(mil.order(a.id, { kind: 'hold' }), 'The army holds its ground.') }),
        button('Return home', { icon: 'home', onClick: () => act(mil.order(a.id, { kind: 'return' }), 'The army turns for home.') }),
        button('Disband', { variant: 'danger', onClick: () => ctx.confirm({
          title: 'Disband the army?', text: 'The men go home; the war chest is shared among them.', confirmLabel: 'Disband', danger: true,
          onConfirm: () => act(mil.disband(a.id), 'The army is disbanded.'),
        }) })));
  };

  const battleOrders = (level: 'squad' | 'company' | 'army'): HTMLElement =>
    h('div.mu-card', null,
      h('div.mu-row.mu-between', null, h('h4', null, 'Orders in battle'), chip(`You command ${LEVEL_TEXT[level]}`, 'lapis', 'leadership')),
      h('p.mu-small.mu-dim', { style: { margin: '4px 0 8px' } }, 'Your rank decides whom you command (yourself, a squad, a company, the army). Keys 1–6 give the orders.'),
      h('div.mu-row.mu-wrap.mu-gap-6', null, BATTLE_ORDERS.map((o, i) => button(`${i + 1}  ${ORDER_INFO[o].label}`, {
        tip: ORDER_INFO[o].tip, onClick: () => act(mil.command(o), `${ORDER_INFO[o].label}!`),
      }))));

  const callCard = (): HTMLElement | null => {
    const svc = mil.service();
    if (!svc.call) return null;
    const c = svc.call;
    return h('div.mu-card.sel', null,
      h('div.mu-row.mu-between.mu-top', null,
        h('div', null,
          h('h4', null, `${ctx.sim.state.houses.get(c.house)?.name ?? 'The lord'} calls the levy`),
          h('p.mu-small', { style: { margin: '4px 0' } }, `All men of fifteen to sixty may be called. Report to ${ctx.placeName(c.muster)} within ${Math.max(1, Math.ceil(c.due - sim.absDay))} days${c.household.length ? `; ${plural(c.household.length, 'man', 'men')} of your household are taken too` : ''}.`)),
        h('div.mu-row.mu-gap-6', null,
          button('March to the muster', { variant: 'primary', icon: 'check', onClick: () => act(mil.answerCall(true), 'You take your place in the army.') }),
          button('Refuse', { variant: 'danger', onClick: () => act(mil.answerCall(false), 'You ignore the call.') }))));
  };

  const identity = (): HTMLElement => {
    const svc = mil.service();
    const p = me();
    const prog = svc.nextAt > 0 ? Math.min(1, svc.valour / svc.nextAt) : 1;
    const v = bar('gold', prog, { thin: true });
    return h('div.mu-card', null,
      h('div.mu-row.mu-between.mu-top', null,
        h('div', null,
          h('div.mu-tiny.mu-dim.mu-caps', null, 'In arms'),
          h('div.mu-big.mu-bold', null, svc.label),
          h('div.mu-small.mu-dim', null, svc.army ? `Serving ${ctx.sim.state.houses.get(svc.house)?.name ?? 'a lord'} · you command ${svc.level === 'self' ? 'only yourself' : `${plural(svc.commands, 'man', 'men')}`}` : p ? `${fullName(p)} is not in the field` : '')),
        h('div.mu-row.mu-wrap.mu-gap-6.mu-end', null,
          chip(`${svc.battles} ${svc.battles === 1 ? 'battle' : 'battles'}`, '', 'swords'),
          chip(`Spoils ${formatMoney(svc.earned)}`, 'gold', 'purse'),
          chip(plural(Math.floor(svc.served), 'day') + ' served', '', 'calendar'))),
      svc.nextRank ? h('div', { style: { marginTop: '8px' } },
        h('div.mu-small.mu-dim', null, `Valour ${svc.valour} of ${svc.nextAt} for ${svc.nextRank}`), v.el) : null);
  };

  const recruiterTests = (): HTMLElement => {
    const tests = mil.recruitTests(ctx.playerId());
    return h('div', null, heading('The recruiter’s test', 'melee'),
      h('div.mu-col.mu-gap-8', null, tests.map((t) => h('div.mu-test-row', null, h('b', null, t.label),
        h('div.mu-row.mu-wrap.mu-gap-6', null, t.lines.map((l) => chip(l.label, l.met ? 'green' : 'vermilion', l.met ? 'check' : 'cross')))))));
  };

  const lordCard = (): HTMLElement | null => {
    const p = me();
    const house = p ? sim.state.houses.get(p.house) : undefined;
    if (!p || !house || house.head !== p.id || p.sex !== 'm') return null;
    const f = mil.forces(house.id);
    if (f.retinue + f.garrison + f.levyPool + f.militia === 0) return null;
    return h('div.mu-card', null,
      h('div.mu-row.mu-between.mu-top', null,
        h('div', null, h('h4', null, `The host of ${house.name}`),
          h('div.mu-small.mu-dim', null, 'Retinue and garrison are paid by your House; the levy owes feudal service, then wages.')),
        chip(`Strength ${Math.round(f.strength)}`, 'gold', 'shield')),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '8px 0' } },
        chip(`${f.retinue} retinue`, '', 'helm'), chip(`${f.garrison} garrison`, '', 'shield'), chip(`${f.levyPool} liable to the levy`, '', 'users'),
        chip(`${f.militia} town militia`, '', 'archery'), chip(`${f.mercenaries} mercenaries`, '', 'coin')),
      h('div.mu-row.mu-wrap.mu-gap-6', null,
        button(`Call the levy (about ${mil.levySize(house.id, 'war') + f.retinue} men)`, { variant: 'primary', icon: 'flag' as IconName, onClick: () => act(mil.callLevy(), 'You raise your banners.') }),
        button('Hire 10 men-at-arms', { icon: 'coin', tip: '12 pence each and 5 pence a day for a month', onClick: () => act({ ok: mil.hireMercenaries(house.id, 10, 'man_at_arms') > 0, reason: 'No free swords for hire nearby, or your purse is empty.' }, 'A company of free swords takes your pay.') }),
        button('Hire 10 archers', { icon: 'archery', onClick: () => act({ ok: mil.hireMercenaries(house.id, 10, 'archer') > 0, reason: 'No archers for hire nearby, or your purse is empty.' }, 'A band of archers takes your pay.') })));
  };

  const joinList = (): HTMLElement => {
    const p = me();
    const list = mil.armies().filter((a) => a.task === 'muster' || a.task === 'garrison').filter((a) => !p || !mil.hostile(p.house, a.house));
    if (!list.length) return empty('No army is mustering that would have you.');
    return h('div.mu-col.mu-gap-8', null, list.slice(0, 8).map((a) => {
      const d = mil.armyDetail(a.id);
      return h('div.mu-card', null, h('div.mu-row.mu-between', null,
        h('div', null, h('b', null, `Army of ${d?.houseName ?? 'a lord'}`), h('div.mu-small.mu-dim', null, `${d ? plural(d.size, 'man', 'men') : ''} · ${TASK_TEXT[a.task] ?? a.task}`)),
        button('Take service', { icon: 'check', onClick: () => act(mil.joinArmy(a.id), 'You take your place in the ranks.') })));
    }));
  };

  const commandView = (): HTMLElement => {
    const svc = mil.service();
    const army = svc.army ? mil.armyDetail(svc.army) : null;
    const wrap = h('div.mu-ledger-scroll.mu-scroll', null, identity());
    const call = callCard();
    if (call) wrap.append(call);
    if (army) {
      wrap.append(armyCard(army, true));
      if (svc.level !== 'self') wrap.append(battleOrders(svc.level));
      else wrap.append(h('div.mu-rule-note', null, icon('info', 15), h('span', null, 'You follow the orders of your captain. Win a name in the field and you will be given men to lead.')));
      if (svc.level === 'army') wrap.append(orders(army, 'army'));
      const siege = army.task === 'siege' ? mil.sieges().find((s) => s.army === army.id) : undefined;
      if (siege) wrap.append(h('div.mu-card', null, h('h4', null, `The siege of ${siege.name}`),
        h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '6px' } }, chip(`Food within: ${plural(siege.foodDays, "day")}`, siege.foodDays < 5 ? 'vermilion' : 'gold', 'bread'), chip(`${siege.defenders} defenders`, '', 'shield'),
          chip(`Walls ${Math.round(siege.walls * 100)}%`, '', 'masonry'), chip(`Their morale ${Math.round(siege.morale * 100)}%`, '', 'heart'),
          siege.rams ? chip(`${siege.rams} ram${siege.rams > 1 ? 's' : ''}`, 'lapis', 'hammer') : null, siege.trebuchets ? chip(`${siege.trebuchets} trebuchet${siege.trebuchets > 1 ? 's' : ''}`, 'lapis', 'hammer') : null,
          siege.mine > 0 ? chip(`Mine ${Math.round(siege.mine * 100)}%`, 'lapis', 'mining') : null)));
      if (svc.level !== 'army') wrap.append(h('div.mu-row.mu-end', null, button('Leave the army', { variant: 'danger', onClick: () => ctx.confirm({
        title: 'Leave the army?', text: 'Quitting your lord\'s host in the middle of the campaign will not be forgotten.', confirmLabel: 'Leave', danger: true, onConfirm: () => act(mil.leaveService(), 'You are discharged.'),
      }) })));
    } else {
      const lord = lordCard();
      if (lord) wrap.append(lord);
      wrap.append(heading('Armies you may join', 'users'), joinList(), recruiterTests());
    }
    if (message) wrap.append(h('p.mu-small.mu-dim.mu-ital', null, message));
    return wrap;
  };

  // ---------------------------------------------------------------- armies and wars
  const captiveRow = (c: CaptiveView): HTMLElement => {
    const mineP = c.person === ctx.playerId() || sim.state.persons.get(c.person)?.house === sim.state.run.houseId;
    return h('div.mu-li', null,
      h('div.mu-grow', null, h('b', null, c.name), h('div.mu-small.mu-dim', null, `Held by ${c.captor ? ctx.nameOf(c.captor) : 'the enemy'} at ${ctx.placeName(c.place)}`)),
      chip(`Ransom ${formatMoney(c.ransom)}`, 'gold', 'purse'),
      mineP ? button('Pay', { size: 'small', onClick: () => act(mil.payRansom(c.person), 'The ransom is paid.') }) : null);
  };

  const armiesView = (): HTMLElement => {
    const wrap = h('div.mu-ledger-scroll.mu-scroll');
    const armies = mil.armies().map((a) => mil.armyDetail(a.id)).filter((a): a is ArmyDetail => !!a);
    wrap.append(heading('Armies in the field', 'swords'));
    wrap.append(armies.length ? h('table.mu-table', null,
      h('thead', null, h('tr', null, ['House', 'Led by', 'Men', 'Doing', 'Morale', 'Food'].map((t) => h('th', null, t)))),
      h('tbody', null, armies.map((a) => h('tr', { class: a.house === sim.state.run.houseId ? 'mine' : '' },
        h('td', null, a.houseName), h('td.mu-dim', null, a.commanderName), h('td', null, String(a.size)),
        h('td', null, `${TASK_TEXT[a.task] ?? a.task}${a.destination ? ` → ${a.destination}` : ''}`),
        h('td', null, `${Math.round(a.morale * 100)}%`), h('td', null, `${a.supplyDays} d`))))) : empty('No army marches today.'));
    const sieges = mil.sieges();
    wrap.append(heading('Sieges', 'key'));
    wrap.append(sieges.length ? h('div.mu-col.mu-gap-6', null, sieges.map((s) => h('div.mu-li', null,
      h('div.mu-grow', null, h('b', null, s.name), h('div.mu-small.mu-dim', null, `Besieged by ${ctx.sim.state.houses.get(s.besieger)?.name ?? 'an enemy'} for ${Math.floor(sim.absDay - s.since)} days`)),
      chip(`Food ${s.foodDays} d`, s.foodDays < 5 ? 'vermilion' : '', 'bread'), chip(`Walls ${Math.round(s.walls * 100)}%`, '', 'masonry'), chip(`${s.defenders} defenders`, '', 'shield')))) : empty('No place is besieged.'));
    const battles = mil.battles();
    if (battles.length) {
      wrap.append(heading('Battles now', 'flame'));
      wrap.append(h('div.mu-col.mu-gap-6', null, battles.map((b) => h('div.mu-li', null, `Battle near ${ctx.placeName(b.settlement)}${b.playerPresent ? ' — you are in the line' : ''}`))));
    }
    const wars = sim.services.politics?.wars() ?? [];
    wrap.append(heading('Wars', 'crown'));
    wrap.append(wars.length ? h('div.mu-col.mu-gap-6', null, wars.map((w) => {
      const names = (ids: readonly number[]): string => ids.map((i) => sim.state.houses.get(i)?.name ?? '?').join(', ');
      const b = bar(w.score >= 0 ? 'vermilion' : 'lapis', Math.abs(w.score) / 100, { thin: true });
      return h('div.mu-card', null, h('div.mu-row.mu-between', null, h('b', null, `${names(w.attackers)} against ${names(w.defenders)}`),
        chip(w.score >= 0 ? 'attackers ahead' : 'defenders ahead', '', 'swords')), b.el);
    })) : empty('The land is at peace.'));
    const caps = mil.captives();
    wrap.append(heading('Prisoners held for ransom', 'purse'));
    wrap.append(caps.length ? h('div.mu-col.mu-gap-6', null, caps.slice(0, 14).map(captiveRow)) : empty('No one is held for ransom.'));
    return wrap;
  };

  // ---------------------------------------------------------------- forces
  const forcesView = (): HTMLElement => {
    const wrap = h('div.mu-ledger-scroll.mu-scroll');
    const rows: Array<{ id: number; name: string; f: ReturnType<MilitaryRuntime['forces']> }> = [];
    for (const house of sim.state.houses.values()) {
      if ((house.kind !== 'royal' && house.kind !== 'noble') || house.extinct) continue;
      const f = mil.forces(house.id);
      if (f.strength < 25 && house.id !== sim.state.run.houseId) continue;
      rows.push({ id: house.id, name: house.name, f });
    }
    rows.sort((a, b) => (b.id === sim.state.run.houseId ? 1 : 0) - (a.id === sim.state.run.houseId ? 1 : 0) || b.f.strength - a.f.strength);
    wrap.append(heading('Forces of the great Houses', 'shield'),
      h('p.mu-small.mu-dim', null, 'Retinue and garrison are the standing men; the levy is every man of fifteen to sixty on the lord’s manors, called in war.'),
      h('table.mu-table', null,
        h('thead', null, h('tr', null, ['House', 'Retinue', 'Garrison', 'Levy pool', 'Militia', 'Hired', 'In the field', 'Strength'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.slice(0, 16).map((r) => h('tr', { class: r.id === sim.state.run.houseId ? 'mine' : '' },
          h('td', null, r.name), h('td', null, String(r.f.retinue)), h('td', null, String(r.f.garrison)), h('td', null, String(r.f.levyPool)),
          h('td', null, String(r.f.militia)), h('td', null, String(r.f.mercenaries)), h('td', null, String(r.f.afield)), h('td', null, String(Math.round(r.f.strength))))))));
    return wrap;
  };

  // ---------------------------------------------------------------- render
  const signature = (): string => {
    const svc = mil.service();
    const army = svc.army ? mil.armyDetail(svc.army) : null;
    return [tab, svc.role, svc.valour, svc.army, svc.call ? 1 : 0, army ? `${army.size}|${Math.round(army.morale * 20)}|${army.task}|${Math.round(army.supplyDays)}|${army.funds | 0}|${army.destination}` : '', mil.armies().length, mil.sieges().length, mil.battles().length, mil.captives().length, message, Math.floor(sim.absDay)].join('~');
  };

  function render(): void {
    const sig = signature();
    if (sig === lastSig) return;
    lastSig = sig;
    const scroll = content.querySelector('.mu-scroll')?.scrollTop ?? 0;
    replace(content, tab === 'command' ? commandView() : tab === 'armies' ? armiesView() : forcesView());
    const sc = content.querySelector('.mu-scroll');
    if (sc) sc.scrollTop = scroll;
  }

  render();
  ctx.interval(600, render);
  for (const ev of ['battle', 'siege', 'raid', 'captured', 'war'] as const) ctx.listen(ev, () => { lastSig = ''; render(); });

  const switchTab = tabKeys(['command', 'armies', 'forces'], () => tab, (id) => { tab = id as Tab; tabsEl.set(tab); lastSig = ''; render(); },
    { scroller: () => content.querySelector<HTMLElement>('.mu-scroll'), digits: () => tab !== 'command' });
  return panelOf({ id: 'army', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, {
    key: (intent, e) => {
      if (intent.type === 'digit' && tab === 'command' && intent.n >= 1 && intent.n <= BATTLE_ORDERS.length) {
        const o = BATTLE_ORDERS[intent.n - 1];
        const r = mil.command(o);
        act(r, `${ORDER_INFO[o].label}!`);
        return true;
      }
      return switchTab(intent, e);
    },
  });
}

registerPanel('army', (ctx, req) => armyPanel(ctx, (req.data as { tab?: Tab } | undefined)?.tab ?? 'command'));
