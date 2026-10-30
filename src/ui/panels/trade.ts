// The trade panel: their wares and your goods side by side, a basket of what changes hands, a live
// quote from the economy, and confirm. Buy, sell or barter; prices show their trend.
import type { TradePartnerRef } from '../../sim/actions';
import { BUILDINGS } from '../../content/types';
import { QUALITY_NAMES, type ItemKey, type MarketLine, type MarketView, type TradeQuote } from '../../sim/economy/types';
import { fullName } from '../../sim/state';
import { h } from '../core/dom';
import { formatMoney, thousands } from '../core/format';
import { icon } from '../core/icons';
import { GOOD_ICON } from '../core/iconMap';
import { TradeBasket, settlementWords, trendLevel, trendWords } from '../core/tradeBasket';
import { button, chip, empty, heading } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { every, panelOf } from './base';

export function tradePanel(ctx: PanelCtx, partner: TradePartnerRef): UiPanel {
  const eco = ctx.eco;
  const sim = ctx.sim;
  const basket = new TradeBasket();
  const actor = ctx.playerId();
  let message = '';
  let signature = '';

  const settlementId = (): number => (partner.kind === 'market' ? partner.settlement : sim.state.persons.get(actor)?.settlement ?? 0);
  const marketView = (): MarketView | null => (partner.kind === 'market' ? eco.market(partner.settlement) : null);

  const title = (): { name: string; sub: string } => {
    if (partner.kind === 'market') {
      const m = marketView();
      return { name: m ? `${m.name} market` : 'The market', sub: m ? `${m.open ? 'Open' : 'Closed'}${m.marketDay ? ' · market day' : ''}${m.toll ? ` · stall toll ${formatMoney(m.toll)}` : ''}` : '' };
    }
    if (partner.kind === 'person') {
      const p = sim.state.persons.get(partner.id);
      return { name: p ? fullName(p) : 'A trader', sub: ctx.social.relationLabel(actor, partner.id) };
    }
    const b = sim.state.buildings.get(partner.id);
    return { name: b ? BUILDINGS[b.kind].name : 'A shop', sub: 'Trade' };
  };

  const win = createWindow({ title: title().name, subtitle: title().sub, icon: 'coin', size: 'xl', tall: true, onClose: () => ctx.close() });
  const root = h('div.mu-trade');
  win.body.append(root);
  win.body.classList.add('flush');

  const bounds = (their: Map<ItemKey, MarketLine>, key: ItemKey): { stock: number; have: number } => ({
    stock: their.get(key)?.stock ?? 0,
    have: sim.state.persons.get(actor)?.inventory[key] ?? 0,
  });

  const qtyControl = (key: ItemKey, side: 'buy' | 'sell', their: Map<ItemKey, MarketLine>, canTrade: boolean, rerender: () => void): HTMLElement => {
    const signed = basket.qty(key);
    const n = side === 'buy' ? Math.max(0, signed) : Math.max(0, -signed);
    const b = bounds(their, key);
    const limit = side === 'buy' ? b.stock : b.have;
    const step = (d: number): void => {
      basket.adjust(key, side === 'buy' ? d : -d, b);
      message = '';
      rerender();
    };
    return h('div.mu-qty', null,
      button('', { icon: 'minus', size: 'small', class: 'icon mu-qty-minus', disabled: n <= 0, onClick: (e) => step(e.shiftKey ? -5 : -1) }),
      h('span.mu-qty-n.mu-num', { class: n > 0 ? 'on' : '' }, String(n)),
      button('', { icon: 'plus', size: 'small', class: 'icon mu-qty-plus', disabled: !canTrade || n >= limit, tip: 'Shift-click for five', onClick: (e) => step(e.shiftKey ? 5 : 1) }));
  };

  const render = (): void => {
    const view = marketView();
    const lines: MarketLine[] = view ? view.lines : eco.partnerStock(partner, actor);
    const their = new Map(lines.map((l) => [l.key, l]));
    const inv = eco.inventory(actor);
    basket.prune((k) => bounds(their, k));
    const open = view ? view.open : true;
    const quote: TradeQuote | null = basket.isEmpty() ? null : eco.quote(actor, partner, basket.toLines());
    const sig = JSON.stringify([lines.map((l) => [l.key, l.stock, l.buy, l.sell]), inv.items.map((i) => [i.key, i.qty]), inv.money, basket.toLines(), message, open]);
    if (sig === signature) return;
    signature = sig;
    const t = title();
    win.setTitle(t.name, t.sub);

    const rerender = (): void => { signature = ''; render(); };

    // ---- their wares
    const wares = lines.filter((l) => l.stock > 0 || basket.qty(l.key) > 0);
    const wareRows = wares.map((l) => {
      const q = l.quality !== undefined && l.good.quality ? QUALITY_NAMES[l.quality] : '';
      const lvl = trendLevel(l.trend);
      return h('div.mu-trade-row', { class: basket.qty(l.key) > 0 ? 'in' : '' },
        h('span.mu-inv-ico', null, icon(GOOD_ICON[l.good.category], 17)),
        h('span.mu-grow.mu-trunc', { tip: l.good.unit }, h('b', null, `${q && l.quality !== 1 ? `${q} ` : ''}${l.good.name}`)),
        h('span.mu-dim.mu-small.mu-num', { tip: 'In stock' }, `${thousands(l.stock)}`),
        h('span.mu-trade-price.mu-num', { tip: trendWords(l.trend) }, formatMoney(l.buy), lvl === 'flat' ? null : icon(lvl === 'up' ? 'tri_up' : 'tri_down', 11, `mu-trend ${lvl === 'up' ? 'bad' : 'good'}`)),
        qtyControl(l.key, 'buy', their, open, rerender));
    });

    // ---- your goods
    const myRows = inv.items.map((s) => {
      const l = their.get(s.key);
      const price = l ? l.sell : partner.kind === 'market' ? eco.price(settlementId(), s.key, 'sell') : 0;
      const wanted = price > 0 && (partner.kind === 'market' || !!l);
      const lvl = l ? trendLevel(l.trend) : 'flat';
      return h('div.mu-trade-row', { class: `${basket.qty(s.key) < 0 ? 'in' : ''}${wanted ? '' : ' unwanted'}` },
        h('span.mu-inv-ico', null, icon(GOOD_ICON[s.good.category], 17)),
        h('span.mu-grow.mu-trunc', null, h('b', null, ctx.describe(s.key))),
        h('span.mu-dim.mu-small.mu-num', { tip: 'You have' }, `×${thousands(s.qty)}`),
        h('span.mu-trade-price.mu-num', { tip: wanted ? l ? trendWords(l.trend) : 'What they will pay' : 'They do not buy this' }, wanted ? formatMoney(price) : '—', wanted && lvl !== 'flat' ? icon(lvl === 'up' ? 'tri_up' : 'tri_down', 11, `mu-trend ${lvl === 'up' ? 'good' : 'bad'}`) : null),
        qtyControl(s.key, 'sell', their, open && wanted, rerender));
    });

    // ---- the basket
    const quoteLines = quote?.lines ?? [];
    const basketRows = quoteLines.map((q) => h('div.mu-basket-row', { class: q.qty > 0 ? 'buy' : 'sell' },
      h('span.mu-basket-verb', null, q.qty > 0 ? 'Buy' : 'Sell'),
      h('span.mu-grow.mu-trunc', null, ctx.describe(q.key, Math.abs(q.qty))),
      h('span.mu-num', null, formatMoney(Math.abs(q.total))),
      button('', { icon: 'cross', size: 'small', class: 'icon', tip: 'Remove', onClick: () => { basket.remove(q.key); rerender(); } })));
    const afterPurse = quote ? Math.round((inv.money - quote.money) * 2) / 2 : inv.money;
    const net = quote ? settlementWords(quote.money, formatMoney) : '';
    const ok = !!quote && quote.ok && open;
    const confirm = button(basket.isBarter() ? 'Strike the barter' : 'Confirm trade', { variant: 'primary', size: 'big', icon: 'check', disabled: !ok });
    confirm.addEventListener('click', () => {
      if (!ok) return;
      const r = eco.trade(actor, partner, basket.toLines());
      if (r.ok) { basket.clear(); message = ''; ctx.say('gain', 'The bargain is struck.'); } else message = r.reason ?? 'They will not trade on those terms.';
      rerender();
    });
    const basketCol = h('div.mu-trade-basket', null,
      heading('The bargain', 'trade', basket.isBarter() ? chip('Barter', 'lapis') : null),
      basketRows.length ? h('div.mu-basket-list', null, basketRows) : h('p.mu-dim.mu-small.mu-ital.mu-center', { style: { padding: '14px 4px' } }, open ? 'Use + and − to choose what to buy and what to sell.' : 'The stalls are shut: come back by day.'),
      h('div.mu-grow'),
      quote ? h('div.mu-basket-sum', null,
        h('div.mu-basket-net', { class: quote.money > 0 ? 'pay' : quote.money < 0 ? 'get' : '' }, net),
        h('div.mu-row.mu-between.mu-small', null, h('span', null, 'Your purse after'), h('b.mu-num', { class: afterPurse < 0 ? 'mu-bad' : '' }, formatMoney(afterPurse))),
        !quote.ok || message ? h('div.mu-bad.mu-small.mu-bold', null, message || quote.reason) : null) : null,
      h('div.mu-row.mu-gap-6', null, confirm, button('Clear', { disabled: basket.isEmpty(), onClick: () => { basket.clear(); message = ''; rerender(); } })));

    const status = !open ? h('div.mu-trade-closed', null, icon('moon', 16), ' The market is closed. Stalls open by day.') : null;
    root.replaceChildren(
      h('div.mu-trade-col.mu-trade-buy', null, heading('Their wares', 'bag'), status, h('div.mu-trade-list.mu-scroll', null, wareRows.length ? wareRows : empty('They have nothing to sell.'))),
      basketCol,
      h('div.mu-trade-col.mu-trade-sell', null, heading('Your goods', 'user', h('span.mu-chip.gold', null, icon('coin', 13), formatMoney(inv.money))), h('div.mu-trade-list.mu-scroll', null, myRows.length ? myRows : empty('You have nothing to sell.'))),
    );
  };

  ctx.listen('trade', () => { signature = ''; });
  render();
  return panelOf({ id: 'trade', group: 'trade', pauses: 'menu', backdropCloses: ctx }, win.el, {
    tick: every(0.8, render),
    key: (intent) => {
      if (intent.type === 'enter') { const c = root.querySelector<HTMLButtonElement>('.mu-trade-basket .mu-btn.primary'); if (c && !c.disabled) { c.click(); return true; } }
      return false;
    },
  });
}
