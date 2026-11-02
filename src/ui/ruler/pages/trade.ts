// Trade: what your lands yield and what they lack, and the steward's standing orders — sell the surplus when the price is right, buy
// what the works need, keep so much in store (CIV §6.6). The profit is the realm's gold.
import type { TradeOrder } from '../../../sim/realm/types';
import { button, chip, empty, heading, seg } from '../../components/widgets';
import { h } from '../../core/dom';
import { icon } from '../../core/icons';
import { goodIcon } from '../../builder/landsUi';
import { formatMoney } from '../../../sim/money';
import { dateText } from '../../core/format';
import { amountText, lackHints, orderFormProblem, orderWords, TRADE_GOODS, tradeProfile, YIELD_NAME, type OrderForm } from '../rulerModel';
import { line, money, section, type RulerEnv } from '../rulerUi';
import { whoseLands } from '../../core/mapModel';

interface Bag { form: OrderForm }

export function buildTrade(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const v = env.view();
  const sim = ctx.sim;
  const may = env.may();
  const terr = ctx.game.territory;
  const bag = env.state<Bag>('trade', () => ({ form: { good: 'wheat', side: 'sell', limit: 0, keep: 300, settlement: v.markets?.[0] ?? v.seat ?? -1 } }));
  const wrap = h('div.mu-rul-page.mu-rul-trade');

  // ---- what the lands yield and lack
  const all = [...v.settlements, ...v.vassalSettlements];
  const profiles = all.map((id) => terr?.resources(id)).filter((p): p is NonNullable<typeof p> => !!p);
  const prof = tradeProfile(profiles);
  const seat = sim.world.settlements.find((s) => s.id === (v.seat ?? v.settlements[0]));
  const owner = (d: { x: number; z: number; settlement: number }): string => {
    if (d.settlement < 0) return whoseLands(null, null);
    const o = terr?.ownerOf?.(d.settlement);
    return whoseLands(ctx.placeName(d.settlement), o ? sim.state.houses.get(o.house)?.name ?? null : null);
  };
  const hints = lackHints(prof.lacks, seat ? { x: seat.x, z: seat.z } : { x: 0, z: 0 }, sim.world.deposits ?? [], (d) => owner(d).replace(/^In the lands of /, 'the lands of ').replace(/^In the wild.*$/, 'in the wild'));
  const yieldGoods = (g: string): string => (g === 'grain' ? 'wheat' : g === 'fish' ? 'herring' : g);
  wrap.append(h('div.mu-grid.c2', null,
    section('Your lands yield', 'wheat', prof.yields.length ? h('div.mu-row.mu-wrap.mu-gap-6', null, prof.yields.map((g) => h('span.mu-good-line.have', null, goodIcon(ctx.eco, yieldGoods(g)), h('span', null, YIELD_NAME[g] ?? g)))) : line('Your lands are not known to yield anything; the territory module is not installed.')),
    section('Your lands lack', 'warning', hints.length ? h('ul.mu-rul-lacks', null, hints.map((x) => h('li', null, goodIcon(ctx.eco, yieldGoods(x.good)), h('span', null, x.text)))) : h('p.mu-small.mu-good', null, 'Everything a land can yield, yours yield.'))));

  // ---- the standing orders
  const orders = realm.tradeOrders(me);
  wrap.append(heading(`Standing orders · ${orders.length}`, 'ledger'));
  const placeWord = (o: TradeOrder): string => (o.settlement < 0 ? 'the treasury’s own market' : ctx.placeName(o.settlement));
  wrap.append(orders.length ? h('div.mu-list', null, orders.map((o) => {
    const name = ctx.eco.good(o.good)?.name.toLowerCase() ?? o.good;
    return h('div.mu-li.mu-rul-order', null,
      h('span.mu-chip', { class: o.side === 'sell' ? 'gold' : 'lapis' }, o.side === 'sell' ? 'Sell' : 'Buy'),
      goodIcon(ctx.eco, o.good, 17),
      h('div.mu-grow', null, h('b', null, orderWords(o, name, placeWord(o))),
        h('div.mu-tiny.mu-dim', null, `${o.note ?? 'Not yet tried'}${o.last !== undefined && o.last >= 0 ? ` · ${dateText(o.last)}` : ''}`)),
      h('div.mu-small.mu-right', null, h('div', null, `${amountText(o.done)} moved`), o.money ? h('div.mu-dim', null, `${o.side === 'sell' ? 'earned' : 'paid'} ${money(o.money)}`) : null,
        (o.transit ?? 0) > 0 ? h('div.mu-dim', null, `${amountText(o.transit ?? 0)} on the road`) : null),
      may.trade ? button('', { icon: 'cross', size: 'small', variant: 'danger', tip: 'Remove the order', onClick: () => env.done(realm.removeTradeOrder(me, o.id), 'The order is withdrawn.') }) : null);
  })) : line('No standing order is given. Add one below: the steward carries them out once a day, between ten and three.'));

  // ---- a new order
  if (may.trade) {
    const f = bag.form;
    const goods = TRADE_GOODS.filter((g) => ctx.eco.good(g));
    const goodSel = h<HTMLSelectElement>('select.mu-input', { 'aria-label': 'Good' }, goods.map((g) => h('option', { value: g, selected: g === f.good }, ctx.eco.good(g)?.name ?? g)));
    const placeSel = h<HTMLSelectElement>('select.mu-input', { 'aria-label': 'Market' },
      ...(v.markets ?? []).map((id) => h('option', { value: String(id), selected: id === f.settlement }, `${ctx.placeName(id)} market`)),
      h('option', { value: '-1', selected: f.settlement === -1 }, 'The treasury’s own market'));
    const limit = h<HTMLInputElement>('input.mu-input.mu-rul-num', { type: 'number', min: '0', step: '0.5', value: String(f.limit), 'aria-label': 'Price limit in pence' });
    const keep = h<HTMLInputElement>('input.mu-input.mu-rul-num', { type: 'number', min: '0', step: '10', value: String(f.keep), 'aria-label': 'Amount to keep in store' });
    const priceEl = h('div.mu-tiny.mu-dim');
    const sideSeg = seg([{ id: 'sell' as const, label: 'Sell the surplus' }, { id: 'buy' as const, label: 'Buy up to' }], f.side, (s) => { f.side = s; read(); });
    function read(): void {
      f.good = goodSel.value; f.settlement = Number(placeSel.value); f.limit = Number(limit.value); f.keep = Number(keep.value);
      const market = f.settlement >= 0 ? f.settlement : v.markets?.[0] ?? -1;
      const p = market >= 0 ? safe(() => ctx.eco.price(market, f.good, f.side)) : null;
      priceEl.textContent = p !== null ? `Now at ${ctx.placeName(market)}: ${formatMoney(p)} each${f.side === 'sell' ? ' if you sell' : ' if you buy'}.` : '';
    }
    for (const el of [goodSel, placeSel]) el.addEventListener('change', read);
    for (const el of [limit, keep]) el.addEventListener('input', read);
    read();
    const add = (): void => {
      read();
      const problem = orderFormProblem(f);
      if (problem) { env.notice(problem, 'bad'); return; }
      env.done(realm.addTradeOrder(me, { settlement: f.settlement, good: f.good, side: f.side, limit: f.limit, keep: f.keep }), 'The steward has his orders.');
    };
    wrap.append(h('div.mu-card.mu-rul-neworder', null, h('h4', null, 'A new order'),
      h('div.mu-rul-form', null,
        sideSeg,
        h('label', null, h('span.mu-small', null, 'Good'), goodSel),
        h('label', null, h('span.mu-small', null, 'At'), placeSel),
        h('label', null, h('span.mu-small', null, f.side === 'sell' ? 'Not below (pence, 0 = any)' : 'Not above (pence, 0 = any)'), limit),
        h('label', null, h('span.mu-small', null, f.side === 'sell' ? 'Keep in store' : 'Stock up to'), keep)),
      priceEl,
      h('div.mu-row.mu-gap-8', { style: { marginTop: '8px' } }, button('Give the order', { variant: 'primary', icon: 'check', onClick: add }), chip(`${orders.length} of 24 orders`, '')),
      h('p.mu-tiny.mu-dim', { style: { marginTop: '6px' } }, 'A sale moves at most 400 a day, and only what the treasury’s own stores hold; a purchase spends at most a quarter of the purse a day.')));
  } else wrap.append(line('Only the holder or his steward gives trade orders.'));
  void empty; void icon;
  return wrap;
}

function safe<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}
