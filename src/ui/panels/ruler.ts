// The ruler's seat (U): the lord's side of the game (docs/CIV.md §6). What you rule and with what (treasury, stores,
// people, strength, the year's accounts), and the allocations a lord makes: the crop of each field and the share of
// labour-service sent to the works; research, paid in each branch's goods; men raised, armed and knighted; the
// steward's standing trade orders; and what neighbours and rivals are doing. Every control calls the realm module
// (`sim.services.realm`), the same API the AI lords use.
import type { CropKind } from '../../core/domain';
import type { RealmApi, RealmView, RecruitOption, ResearchOption, Result } from '../../sim/realm/types';
import type { UnitKind } from '../../sim/military/types';
import { h } from '../core/dom';
import { formatMoney, pct, plural, trim } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { button, chip, empty, heading, kv, slider, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

type Tab = 'overview' | 'fields' | 'research' | 'troops' | 'trade' | 'rivals';

const ROLE_TEXT = { holder: 'Lord', regent: 'Regent', steward: 'Steward', reeve: 'Reeve' } as const;
const UNIT_ICON: Record<UnitKind, IconName> = {
  levy: 'users', archer: 'archery', crossbow: 'archery', man_at_arms: 'shield', sergeant: 'horse', knight: 'helm', mercenary: 'coin',
};
const CROP_NAME = (c: string): string => (c === 'fallow' ? 'the usual rotation' : c);
/** Goods a steward commonly trades: the stores' own goods come first in the list. */
const COMMON_GOODS = ['wheat', 'rye', 'barley', 'oats', 'wool', 'timber', 'plank', 'stone', 'brick', 'iron', 'ale', 'cloth', 'salt', 'candle', 'vellum'];

function realmOf(ctx: PanelCtx): RealmApi | undefined {
  return (ctx.game.realm ?? (ctx.sim.services as unknown as { realm?: RealmApi }).realm);
}

function goodsText(ctx: PanelCtx, goods: Readonly<Record<string, number>>): string {
  const parts = Object.entries(goods).filter(([, n]) => n > 0).map(([g, n]) => { try { return ctx.eco.describe(g, n); } catch { return `${n} ${g}`; } });
  return parts.length ? parts.join(', ') : 'nothing';
}

/** The knights who fight for a ruler: of his House, his vassals, or in his pay. */
function knightsOf(ctx: PanelCtx, v: RealmView, paid: readonly number[]): Array<{ id: number; why: string; hurt: boolean }> {
  const st = ctx.sim.state;
  const me = st.persons.get(ctx.playerId());
  const mine = new Set([...st.titlesHeldBy(ctx.playerId())].map((t) => t.id));
  const paidSet = new Set(paid);
  const combat = ctx.sim.services.combat as unknown as { wounds?(p: number): unknown[] } | undefined;
  const out: Array<{ id: number; why: string; hurt: boolean }> = [];
  for (const p of st.persons.values()) {
    if (p.death || p.career !== 'knight' || p.id === ctx.playerId() || p.flags.captive) continue;
    const vassal = [...st.titlesHeldBy(p.id)].some((t) => mine.has(t.liege));
    const why = paidSet.has(p.id) ? 'in your pay' : vassal ? 'your vassal' : me && p.house === me.house ? 'of your House' : '';
    if (!why) continue;
    out.push({ id: p.id, why, hurt: p.health.hp < 0.5 || (combat?.wounds?.(p.id)?.length ?? 0) > 0 });
  }
  void v;
  return out.sort((a, b) => Number(a.hurt) - Number(b.hurt) || a.id - b.id);
}

export function rulerPanel(ctx: PanelCtx, startTab: Tab = 'overview'): UiPanel {
  const R = realmOf(ctx);
  const win = createWindow({ title: 'The Ruler’s Seat', subtitle: 'Your lands, your purse, your men', icon: 'castle', size: 'xl', tall: true, onClose: () => ctx.close() });
  const base = { id: 'ruler', group: 'main' as const, pauses: 'menu' as const, backdropCloses: ctx };
  if (!R) {
    win.body.append(empty('No realm is kept in this world.'));
    return panelOf(base, win.el);
  }
  let tab: Tab = startTab;
  let lastSig = '';
  let message = '';
  let settlement = -1;
  const content = h('div.mu-ruler');
  const tabsEl = tabs([
    { id: 'overview', label: 'Overview', icon: 'castle' },
    { id: 'fields', label: 'Fields & labour', icon: 'wheat' },
    { id: 'research', label: 'Research', icon: 'book' },
    { id: 'troops', label: 'Men & arms', icon: 'shield' },
    { id: 'trade', label: 'Trade orders', icon: 'market' },
    { id: 'rivals', label: 'Rivals & news', icon: 'flag' },
  ], tab, (id) => { tab = id as Tab; tabsEl.set(tab); lastSig = ''; render(); });
  win.body.classList.add('flush');
  win.body.append(tabsEl.el, h('div.mu-tabbar-rule'), content);

  const me = (): number => ctx.playerId();
  const act = (r: Result, ok: string): void => {
    message = r.ok ? ok : r.reason ?? 'That cannot be done.';
    ctx.say(r.ok ? 'info' : 'warn', message);
    lastSig = '';
    render();
  };
  const note = (): HTMLElement | null => (message ? h('p.mu-small.mu-ital.mu-ink2', { style: { margin: '0 0 8px' } }, message) : null);
  const pick = <T extends string | number>(label: string, options: ReadonlyArray<{ value: T; text: string }>, value: T, onChange: (v: T) => void): HTMLSelectElement => {
    const sel = h<HTMLSelectElement>('select.mu-input', { 'aria-label': label },
      options.map((o) => h('option', { value: String(o.value), selected: o.value === value }, o.text)));
    sel.addEventListener('change', () => {
      const raw = sel.value;
      const found = options.find((o) => String(o.value) === raw);
      if (found) onChange(found.value);
    });
    return sel;
  };

  // ---------------------------------------------------------------- overview
  const overview = (v: RealmView): HTMLElement => {
    const lines = R.accounts?.(me()) ?? [];
    const top = Object.entries(v.stores).filter(([, n]) => n >= 1).sort((a, b) => b[1] - a[1]).slice(0, 14);
    const projects = R.projects(v.house).filter((p) => p.state === 'active' || p.state === 'stalled');
    const troops = R.troops?.(me()) ?? [];
    const plan = v.settlements.map((s) => R.worksShare(s));
    return h('div.mu-col.mu-gap-12', null,
      h('div.mu-card', null,
        h('div.mu-row.mu-between.mu-top', null,
          h('div', null,
            h('div.mu-tiny.mu-dim.mu-caps', null, v.role ? ROLE_TEXT[v.role] : 'Lord'),
            h('div.mu-big.mu-bold', null, v.name),
            h('div.mu-small.mu-dim', null, `${plural(v.settlements.length, 'place')} held${v.vassalSettlements.length ? `, ${plural(v.vassalSettlements.length, 'more')} through vassals` : ''}${v.seat !== undefined ? ` · seat at ${ctx.placeName(v.seat)}` : ''}`)),
          h('div.mu-row.mu-wrap.mu-gap-6.mu-end', null,
            chip(`Treasury ${formatMoney(v.treasury)}`, 'gold', 'purse', 'The ruling household’s purse'),
            chip(`${v.population} people`, '', 'users'),
            chip(`Prosperity ${trim(v.prosperity, 2)}`, v.prosperity >= 1 ? 'green' : 'vermilion', 'trend_up'),
            chip(`Strength ${Math.round(v.strength)}`, '', 'shield'))),
        h('div.mu-grid.c2', { style: { marginTop: '10px' } },
          kv([['Income this year', formatMoney(v.income)], ['Spending this year', formatMoney(v.spending)], ['Balance', formatMoney(v.income - v.spending)]]),
          kv([['Research under way', String(projects.length)], ['Men in your pay', String(troops.length)], ['Labour to the works', plan.length ? plan.map((x) => pct(x)).join(' / ') : '—']]))),
      h('div.mu-card', null,
        h('h4', null, 'A lord’s first business'),
        h('ol.mu-small', { style: { margin: '6px 0 0 18px', lineHeight: '1.7' } },
          h('li', null, h('b', null, 'Fields & labour: '), 'name the crop for each field’s next sowing, and choose how much of your serfs’ week-work goes to your works instead of the demesne.'),
          h('li', null, h('b', null, 'Research: '), 'set a capable man to work out a technique, paid in that branch’s goods and coin.'),
          h('li', null, h('b', null, 'Men & arms: '), 'raise archers, men-at-arms and sergeants from your levy, and knight the worthy.'),
          h('li', null, h('b', null, 'Trade orders: '), 'tell your steward what to sell when the price is good, and what to keep in store.'),
          h('li', null, h('b', null, 'Yourself: '), 'you are one person too. Train at the butts and the yard, ride, and lead your men from the front.'))),
      h('div.mu-grid.c2', null,
        h('div', null, heading('Stores', 'box'),
          top.length ? kv(top.map(([g, n]) => [g, trim(n, 0)] as const)) : empty('The barns are empty.')),
        h('div', null, heading('The year’s accounts', 'ledger'),
          lines.length ? kv(lines.map((l) => [l.label, `${l.pence < 0 ? '−' : ''}${formatMoney(Math.abs(l.pence))}`] as const)) : empty('Nothing written in the books yet; they are closed each night.'))),
    );
  };

  // ---------------------------------------------------------------- fields & labour
  const fields = (v: RealmView): HTMLElement => {
    const cards = v.settlements.map((s) => {
      const lines = R.cropPlanView?.(s) ?? [];
      const share = R.worksShare(s);
      const shareLabel = h('b', null, pct(share));
      const sl = slider(0, 100, 5, Math.round(share * 100), (x) => { shareLabel.textContent = pct(x / 100); });
      sl.addEventListener('change', () => act(R.setWorksShare(me(), s, Number(sl.value) / 100), `${pct(Number(sl.value) / 100)} of the week-work at ${ctx.placeName(s)} goes to your works.`));
      return h('div.mu-card', null,
        h('h4', null, ctx.placeName(s)),
        lines.length ? h('div.mu-col.mu-gap-6', { style: { margin: '8px 0' } }, lines.map((l) => {
          const opts = l.options[l.next];
          return h('div.mu-row.mu-between.mu-gap-8', null,
            h('span.mu-small', null, h('b', null, `Field ${l.field + 1}`), ` — this year ${l.role === 'fallow' ? 'fallow' : `${l.role} corn`}; next sown in ${l.next === 'winter' ? 'autumn (winter corn)' : 'spring'}`),
            pick<string>(`Crop for field ${l.field + 1}`, [{ value: 'fallow', text: 'The usual rotation' }, ...opts.map((c) => ({ value: c, text: c }))], l.planned,
              (c) => act(R.setCropPlan(me(), s, l.field, c as CropKind), `Field ${l.field + 1} of ${ctx.placeName(s)}: ${CROP_NAME(c)}.`)));
        })) : h('p.mu-small.mu-dim', null, 'This place has no open fields of its own.'),
        h('div', null,
          h('div.mu-small', null, 'Week-work sent to your works (building) instead of the demesne: ', shareLabel),
          sl));
    });
    return h('div.mu-col.mu-gap-12', null, note(), cards.length ? cards : empty('You hold no land directly.'));
  };

  // ---------------------------------------------------------------- research
  const research = (v: RealmView): HTMLElement => {
    const projects = R.projects(v.house).filter((p) => p.state === 'active' || p.state === 'stalled');
    const opts = R.researchOptions(me());
    const choice = new Map<string, { who: number; where: number }>();
    const row = (o: ResearchOption): HTMLElement => {
      const c = { who: o.researchers[0] ?? 0, where: o.places[0] ?? 0 };
      choice.set(o.tech, c);
      const can = o.researchers.length > 0 && o.places.length > 0;
      return h('div.mu-card', { class: o.ok ? '' : 'mu-dimmed' },
        h('div.mu-row.mu-between.mu-top', null,
          h('div', null, h('h4', null, o.name), h('div.mu-small.mu-dim', null, `${o.branch} · ${goodsText(ctx, o.cost.goods)} and ${formatMoney(o.cost.pence)} · about ${plural(Math.ceil(o.days ?? o.cost.days), 'day')}`)),
          o.ok ? chip('Ready', 'green', 'check') : o.buyable ? chip(`Buy the rest: ${formatMoney(o.buyCost ?? 0)}`, 'gold', 'coin') : chip(o.reason ?? 'Not yet', 'vermilion', 'cross')),
        can ? h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '8px' } },
          pick('Researcher', o.researchers.map((id) => ({ value: id, text: `${ctx.nameOf(id)}${o.slow?.includes(id) ? ' (slow)' : ''}` })), c.who, (x) => { c.who = x; }),
          pick('Place', o.places.map((id) => ({ value: id, text: `${ctx.sim.state.buildings.get(id)?.kind.replace(/_/g, ' ') ?? 'building'} #${id}` })), c.where, (x) => { c.where = x; }),
          button('Begin', { variant: 'primary', icon: 'play', disabled: !o.ok, onClick: () => act(R.startResearch(me(), o.tech, c.who, c.where), `${ctx.nameOf(c.who)} begins work on ${o.name}.`) }),
          o.buyable && !o.ok ? button('Buy goods and begin', { icon: 'coin', onClick: () => act(R.startResearch(me(), o.tech, c.who, c.where, { buy: true }), `Goods are bought; ${ctx.nameOf(c.who)} begins on ${o.name}.`) }) : null)
          : h('p.mu-small.mu-dim', { style: { marginTop: '6px' } }, o.reason ?? 'No one in your lands could work this out yet.'));
    };
    return h('div.mu-col.mu-gap-12', null, note(),
      h('div', null, heading('Under way', 'hourglass'),
        projects.length ? h('div.mu-col.mu-gap-6', null, projects.map((p) => h('div.mu-card', null,
          h('div.mu-row.mu-between', null,
            h('div', null, h('b', null, p.name), h('div.mu-small.mu-dim', null, `${ctx.nameOf(p.researcher)} · ${pct(p.progress)} done${p.state === 'stalled' ? ` · stalled${p.note ? `: ${p.note}` : ''}` : ''}`)),
            button('Stop', { variant: 'danger', size: 'small', onClick: () => act(R.stopResearch(me(), p.id), `Work on ${p.name} is stopped.`) })))))
          : empty('Nothing is being worked out.')),
      h('div', null, heading('Techniques within reach', 'book'),
        opts.length ? h('div.mu-col.mu-gap-6', null, opts.slice(0, 24).map(row)) : empty('No technique is within reach of your House.')),
    );
  };

  // ---------------------------------------------------------------- troops
  const troops = (v: RealmView): HTMLElement => {
    if (settlement < 0 || !v.settlements.includes(settlement)) settlement = v.seat !== undefined && v.settlements.includes(v.seat) ? v.seat : v.settlements[0] ?? -1;
    const where = settlement >= 0 ? pick('Raise men at', v.settlements.map((s) => ({ value: s, text: ctx.placeName(s) })), settlement, (s) => { settlement = s; lastSig = ''; render(); }) : null;
    const opts: RecruitOption[] = settlement >= 0 ? R.recruitOptions(me(), settlement) : [];
    const row = (o: RecruitOption): HTMLElement => {
      const most = Math.max(0, Math.min(o.available, o.affordable ?? o.available));
      const n = h<HTMLInputElement>('input.mu-input', { type: 'number', min: '1', max: String(Math.max(1, most)), value: String(Math.min(5, Math.max(1, most))), style: { width: '64px' }, 'aria-label': `How many ${o.label}` });
      return h('div.mu-card', null,
        h('div.mu-row.mu-between.mu-top', null,
          h('div', null, h('h4', null, icon(UNIT_ICON[o.kind], 16), ' ', o.label),
            h('div.mu-small.mu-dim', null, `Each: ${formatMoney(o.pence)} to sign${Object.keys(o.goods).length ? `, ${goodsText(ctx, o.goods)}` : ''}${o.buy ? ` (or ${formatMoney(o.buy)} to buy the gear)` : ''}; ${formatMoney(o.upkeep)} a day`)),
          h('div.mu-row.mu-gap-6.mu-end', null, chip(`${o.available} available`, '', 'users'), o.affordable !== undefined ? chip(`${o.affordable} affordable`, o.affordable > 0 ? 'gold' : 'vermilion', 'purse') : null)),
        h('div.mu-row.mu-gap-6', { style: { marginTop: '8px' } },
          n,
          button('Raise', { variant: 'primary', icon: 'flag', disabled: !o.ok || most <= 0, tip: o.ok ? '' : o.reason ?? '',
            onClick: () => { const k = Math.max(1, Math.floor(Number(n.value) || 1)); act(R.recruit(me(), settlement, o.kind, k), `You raise ${plural(k, o.label.toLowerCase().replace(/s$/, ''), o.label.toLowerCase())}.`); } }),
          !o.ok && o.reason ? h('span.mu-small.mu-dim', null, o.reason) : null));
    };
    const men = R.troops?.(me()) ?? [];
    const dubbable = men.filter((t) => t.kind === 'man_at_arms' || t.kind === 'sergeant');
    const champions = knightsOf(ctx, v, men.map((t) => t.person));
    return h('div.mu-col.mu-gap-12', null, note(),
      h('div', null, heading('Your knights', 'helm'),
        h('p.mu-small.mu-dim', { style: { margin: '0 0 6px' } }, 'Take a knight’s place and fight on your behalf: you play him (his sword, his skill, his wounds) while your lord carries on. Press U as the knight to come back.'),
        champions.length ? h('div.mu-col.mu-gap-4', null, champions.slice(0, 20).map((k) => h('div.mu-row.mu-between.mu-small', null,
          h('span', null, icon('helm', 14), ` ${ctx.nameOf(k.id)} — ${k.why}${k.hurt ? ' · hurt' : ''}`),
          button('Fight as him', { size: 'small', variant: 'primary', icon: 'swords', disabled: k.hurt,
            tip: k.hurt ? 'He is hurt' : `Take ${ctx.nameOf(k.id)}’s place`,
            onClick: () => {
              const r = ctx.dispatch({ type: 'fightAs', personId: k.id });
              if (r.ok) { ctx.say('quest', `You are ${ctx.nameOf(k.id)}, your lord’s knight. Press U to return to your lord.`); ctx.close(); }
              else act(r, '');
            } }))))
          : empty('No knight serves you yet. Knight a man-at-arms or a sergeant below, or win a knight’s fealty.')),
      where ? h('div.mu-row.mu-gap-8', null, h('span.mu-small', null, 'Raise men at'), where) : null,
      opts.length ? h('div.mu-col.mu-gap-6', null, opts.map(row)) : empty('No men can be raised here.'),
      h('div', null, heading('Men in your pay', 'helm'),
        men.length ? h('div.mu-col.mu-gap-4', null, men.slice(0, 60).map((t) => h('div.mu-row.mu-between.mu-small', null,
          h('span', null, icon(UNIT_ICON[t.kind], 14), ` ${ctx.nameOf(t.person)} — ${t.kind.replace(/_/g, ' ')} at ${ctx.placeName(t.settlement)}, ${formatMoney(t.wage)} a day`),
          h('span.mu-row.mu-gap-4', null,
            dubbable.includes(t) ? button('Knight him', { size: 'small', icon: 'helm', onClick: () => act(R.dub(me(), t.person), `${ctx.nameOf(t.person)} kneels and rises a knight.`) }) : null,
            R.discharge ? button('Send home', { size: 'small', onClick: () => act(R.discharge!(me(), t.person), `${ctx.nameOf(t.person)} goes home.`) }) : null))))
          : empty('You pay no soldiers of your own yet.')),
    );
  };

  // ---------------------------------------------------------------- trade
  const trade = (v: RealmView): HTMLElement => {
    const orders = R.tradeOrders(me());
    const markets = (v.markets && v.markets.length ? v.markets : v.settlements);
    const goods = [...new Set([...Object.keys(v.stores).filter((g) => (v.stores[g] ?? 0) >= 1), ...COMMON_GOODS])];
    const f = { settlement: markets[0] ?? -1, good: goods[0] ?? 'wheat', side: 'sell' as 'sell' | 'buy', limit: 0, keep: 0 };
    const limit = h<HTMLInputElement>('input.mu-input', { type: 'number', min: '0', value: '0', style: { width: '70px' }, 'aria-label': 'Price limit in pence' });
    const keep = h<HTMLInputElement>('input.mu-input', { type: 'number', min: '0', value: '50', style: { width: '70px' }, 'aria-label': 'Amount to keep or stock' });
    return h('div.mu-col.mu-gap-12', null, note(),
      h('div.mu-card', null,
        h('h4', null, 'A new order to your steward'),
        markets.length ? h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '8px' } },
          pick('Side', [{ value: 'sell', text: 'Sell' }, { value: 'buy', text: 'Buy' }], f.side, (x) => { f.side = x as 'sell' | 'buy'; }),
          pick('Good', goods.map((g) => ({ value: g, text: g })), f.good, (x) => { f.good = x; }),
          h('span.mu-small', null, 'at'),
          pick('Market', markets.map((s) => ({ value: s, text: ctx.placeName(s) })), f.settlement, (x) => { f.settlement = x; }),
          h('span.mu-small', null, 'price limit (d, 0 = any)'), limit,
          h('span.mu-small', null, 'keep / stock to'), keep,
          button('Give the order', { variant: 'primary', icon: 'quill', onClick: () => act(
            R.addTradeOrder(me(), { settlement: f.settlement, good: f.good, side: f.side, limit: Math.max(0, Number(limit.value) || 0), keep: Math.max(0, Number(keep.value) || 0) }),
            `Your steward will ${f.side} ${f.good} at ${ctx.placeName(f.settlement)}.`) }))
          : empty('There is no market in your lands.')),
      h('div', null, heading('Standing orders', 'scroll'),
        orders.length ? h('div.mu-col.mu-gap-6', null, orders.map((o) => h('div.mu-card', null,
          h('div.mu-row.mu-between', null,
            h('div', null,
              h('b', null, `${o.side === 'sell' ? 'Sell' : 'Buy'} ${o.good} at ${ctx.placeName(o.settlement)}`),
              h('div.mu-small.mu-dim', null, `${o.side === 'sell' ? `above ${o.limit ? formatMoney(o.limit) : 'any price'}, keeping ${o.keep}` : `below ${o.limit ? formatMoney(o.limit) : 'any price'}, up to ${o.keep}`} · moved ${trim(o.done, 0)}${o.money ? ` for ${formatMoney(o.money)}` : ''}${o.note ? ` · ${o.note}` : ''}`)),
            button('Cancel', { size: 'small', variant: 'danger', onClick: () => act(R.removeTradeOrder(me(), o.id), 'The order is withdrawn.') })))))
          : empty('Your steward has no standing orders.')),
    );
  };

  // ---------------------------------------------------------------- rivals and news
  const rivals = (): HTMLElement => {
    const list = R.rivals(me()).slice(0, 12);
    const news = R.news(20);
    return h('div.mu-grid.c2', null,
      h('div', null, heading('Rivals', 'flag'),
        list.length ? h('div.mu-col.mu-gap-6', null, list.map((r) => h('div.mu-card', null,
          h('div.mu-row.mu-between', null, h('b', null, r.name), chip(`Threat ${pct(r.threat)}`, r.threat > 0.5 ? 'vermilion' : r.threat > 0.25 ? 'gold' : '', 'warning')),
          h('div.mu-small.mu-dim', null, `${(r.distance / 1000).toFixed(1)} km · strength ${Math.round(r.strength)} · ${r.stance} · this year: ${r.built} built, ${r.techs} techniques, ${r.recruited} men raised`)))) : empty('No rivals near you.')),
      h('div', null, heading('News', 'scroll'),
        news.length ? h('ul.mu-small', { style: { margin: '0 0 0 16px', lineHeight: '1.6' } }, news.map((n) => h('li', { class: n.threat > 0.5 ? 'mu-bad' : '' }, n.text))) : empty('No news yet.')),
    );
  };

  const render = (): void => {
    const v = R.view(me());
    const sig = `${tab}|${R.version()}|${me()}|${settlement}`;
    if (sig === lastSig) return;
    lastSig = sig;
    if (!v) {
      // a knight fighting on his lord's behalf goes back to the lord from here
      const liege = ctx.sim.state.run.liege ?? 0;
      const lord = liege ? ctx.sim.state.persons.get(liege) : undefined;
      if (lord && !lord.death) {
        content.replaceChildren(h('div.mu-pad', { style: { padding: '18px' } },
          empty(`You are fighting on behalf of ${ctx.nameOf(liege)}.`, { icon: 'helm', title: 'A knight in your lord’s service' }),
          h('div.mu-row', { style: { justifyContent: 'center', marginTop: '10px' } },
            button(`Return to ${ctx.nameOf(liege)}`, { variant: 'primary', size: 'big', icon: 'castle', onClick: () => {
              const r = ctx.dispatch({ type: 'returnToLiege' });
              if (r.ok) { ctx.say('quest', `You are ${ctx.nameOf(liege)} again.`); lastSig = ''; render(); } else act(r, '');
            } }))));
        return;
      }
      content.replaceChildren(h('div.mu-pad', null, empty('You rule nothing. Win or inherit a manor, or live as one who holds one (V on a lord), and this seat is yours.', { icon: 'castle', title: 'No lands' })));
      return;
    }
    win.setTitle('The Ruler’s Seat', `${v.name} · treasury ${formatMoney(v.treasury)}`);
    const body = tab === 'overview' ? overview(v) : tab === 'fields' ? fields(v) : tab === 'research' ? research(v) : tab === 'troops' ? troops(v) : tab === 'trade' ? trade(v) : rivals();
    content.replaceChildren(h('div.mu-pad', { style: { padding: '14px 18px' } }, body));
  };
  render();
  ctx.interval(1000, render);
  return panelOf(base, win.el);
}

registerPanel('ruler', (ctx, req) => rulerPanel(ctx, (req.data as Tab | undefined) ?? 'overview'));
