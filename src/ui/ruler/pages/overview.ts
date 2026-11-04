// Overview: your lands on a small map, the treasury and its year, the books, the stores, population, prosperity, strength, the works
// in progress, research, troops, the threats and the news of your neighbours and rivals (CIV §6.1).
import type { MilitaryRuntime } from '../../../sim/military/types';
import { bar, button, chip, empty } from '../../components/widgets';
import { h } from '../../core/dom';
import { icon } from '../../core/icons';
import { GOOD_ICON } from '../../core/iconMap';
import { siteTitle, STATUS_TONE } from '../../builder/builderModel';
import { dateText } from '../../core/format';
import { landsMap } from '../landsMap';
import {
  amountText, kindName, newsFor, NEWS_ICON, projectWords, prosperityWord, sortRivals, splitBooks, storeRows, threatWords, troopCounts, yearWords,
} from '../rulerModel';
import { line, money, section, signedMoney, statCard, type RulerEnv } from '../rulerUi';

export function buildOverview(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const v = env.view();
  const me = env.me();
  const sim = ctx.sim;
  const year = yearWords(v.income, v.spending);
  const all = [...v.settlements, ...v.vassalSettlements];

  const stats = h('div.mu-grid.mu-rul-stats', null,
    statCard('Treasury', money(v.treasury), v.treasury < 0 ? 'in debt' : 'in the strongbox', v.treasury < 0 ? 'bad' : 'gold', 'purse', 'The ruling household’s purse'),
    statCard('A year in', money(v.income), 'rents, dues, tolls, sales', '', 'trend_up'),
    statCard('A year out', money(v.spending), 'wages, upkeep, works, research', '', 'trend_down'),
    statCard('The year', signedMoney(year.net), year.word, year.tone === 'green' ? 'good' : year.tone === 'vermilion' ? 'bad' : '', 'ledger'),
    statCard('People', v.population.toLocaleString('en-GB'), `in ${all.length} ${all.length === 1 ? 'place' : 'places'}`, '', 'users'),
    statCard('Prosperity', prosperityWord(v.prosperity), `${v.prosperity.toFixed(2)} (1 is normal)`, v.prosperity < 0.8 ? 'bad' : v.prosperity >= 1.1 ? 'good' : '', 'wheat'),
    statCard('Strength', Math.round(v.strength).toLocaleString('en-GB'), 'the House’s fighting weight', '', 'shield'));

  // ---- the map of your lands
  const mapCard = section('Your lands', 'map',
    h('div.mu-rul-mapwrap', null, landsMap(ctx, { width: 560, height: 380, direct: v.settlements, vassal: v.vassalSettlements, house: v.house })),
    h('div.mu-row.mu-wrap.mu-gap-12.mu-tiny.mu-dim', { style: { marginTop: '6px' } },
      h('span', null, h('i.mu-swatch.gold'), ' held by you'), v.vassalSettlements.length ? h('span', null, h('i.mu-swatch.lapis'), ' held from you') : null,
      h('span', null, h('i.mu-swatch.orange'), ' outposts'), h('span', null, icon('pin', 12), ' deposits by colour')));

  // ---- the books
  const books = splitBooks(realm.accounts?.(me) ?? []);
  const bookRows = (rows: Array<{ label: string; pence: number }>): HTMLElement => h('div.mu-col', null, rows.slice(0, 7).map((r) => h('div.mu-row.mu-between.mu-small', null, h('span.mu-trunc', null, r.label), h('span.mu-num', null, money(r.pence)))));
  const booksCard = section('The books', 'ledger',
    books.in.length || books.out.length
      ? h('div.mu-grid.c2', null,
        h('div', null, h('div.mu-tiny.mu-dim.mu-caps', null, `Came in · ${money(books.totalIn)}`), bookRows(books.in)),
        h('div', null, h('div.mu-tiny.mu-dim.mu-caps', null, `Went out · ${money(books.totalOut)}`), bookRows(books.out)))
      : line('The books close at the end of each day; the year shows once a day or two has been written.'));

  // ---- the stores
  const rows = storeRows(v.stores, (g) => { const d = ctx.eco.good(g); return d ? { name: d.name, category: d.category } : undefined; });
  const storesCard = section('Stores', 'bag', rows.length
    ? h('div.mu-rul-stores.mu-scroll', null, rows.map((r) => h('div.mu-rul-store', { tip: ctx.eco.good(r.good)?.unit ?? '' },
      icon(ctx.eco.good(r.good) ? GOOD_ICON[ctx.eco.good(r.good)!.category] : 'box', 15), h('span.mu-grow.mu-trunc', null, r.name), h('b.mu-num', null, amountText(r.qty)))))
    : line('The barns and warehouses of your House hold nothing now.'));

  // ---- works in progress
  const cons = ctx.game.construction;
  const mine = (cons?.sites() ?? []).filter((s) => all.includes(s.settlement)).sort((a, b) => a.priority - b.priority || a.id - b.id);
  const worksCard = section(`Works in progress · ${mine.length}`, 'hammer',
    mine.length ? h('div.mu-col.mu-gap-6', null, mine.slice(0, 5).map((s) => {
      const b = bar(s.status === 'stalled' ? 'vermilion' : s.status === 'waiting' ? 'gold' : 'green', s.progress, { thin: true });
      return h('div', null, h('div.mu-row.mu-between.mu-gap-6.mu-small', null, h('b.mu-trunc', null, siteTitle(s)), chip(s.status === 'working' ? 'at work' : s.status, STATUS_TONE[s.status])),
        h('div.mu-tiny.mu-dim.mu-trunc', null, ctx.placeName(s.settlement)), b.el);
    })) : line('Nothing is being built. Open builder mode (B) to raise something.'),
    h('div.mu-row.mu-gap-6', { style: { marginTop: '8px' } }, button('Lands & works', { size: 'small', icon: 'castle', onClick: () => env.go('lands') }),
      button('Builder mode', { size: 'small', icon: 'hammer', tip: 'Lift the camera over your land (B)', onClick: () => ctx.open({ panel: 'ext', name: 'builder' }) })));

  // ---- research
  const projects = realm.projects(v.house).filter((p) => p.state === 'active' || p.state === 'stalled');
  const researchCard = section(`Research · ${projects.length}`, 'book',
    projects.length ? h('div.mu-col.mu-gap-6', null, projects.slice(0, 4).map((p) => {
      const w = projectWords(p, sim.absDay);
      return h('div', null, h('div.mu-row.mu-between.mu-gap-6.mu-small', null, h('b.mu-trunc', null, p.name), h('span.mu-dim', null, w.eta)), bar(w.tone === 'vermilion' ? 'vermilion' : 'lapis', p.progress, { thin: true }).el);
    })) : line('No technique is being worked out. A clerk, a monk or a master could be put to it.'),
    h('div.mu-row.mu-gap-6', { style: { marginTop: '8px' } }, button('Research', { size: 'small', icon: 'book', onClick: () => env.go('research') })));

  // ---- troops
  const troops = realm.troops?.(me) ?? [];
  const counts = troopCounts(troops);
  const forces = (sim.services.military as MilitaryRuntime | undefined)?.forces?.(v.house);
  const troopsCard = section('Forces', 'swords',
    h('div.mu-row.mu-wrap.mu-gap-6', null,
      forces ? [chip(`${forces.retinue} retinue`, '', 'helm'), chip(`${forces.knights} knights`, '', 'helm'), chip(`${forces.garrison} garrison`, '', 'shield'), chip(`${forces.levyPool} liable to the levy`, '', 'users'), chip(`${forces.militia} militia`, '', 'archery'), forces.mercenaries ? chip(`${forces.mercenaries} hired`, '', 'coin') : null, forces.afield ? chip(`${forces.afield} afield`, 'lapis', 'flag') : null] : null,
      counts.map((c) => chip(`${c.n} ${kindName(c.kind, c.n)} on your pay`, 'gold'))),
    !forces && !counts.length ? line('No men are on your pay.') : null,
    h('div.mu-row.mu-gap-6', { style: { marginTop: '8px' } }, button('Military', { size: 'small', icon: 'swords', onClick: () => env.go('military') })));

  // ---- threats and news
  const rivals = sortRivals(realm.rivals(me)).slice(0, 3);
  const threatsCard = section('Threats', 'warning', rivals.length ? h('div.mu-col.mu-gap-6', null, rivals.map((r) => {
    const t = threatWords(r.threat);
    return h('div', null, h('div.mu-row.mu-between.mu-gap-6.mu-small', null, h('b', null, `House ${r.name}`), chip(t.word, t.tone)), bar(t.tone === 'vermilion' ? 'vermilion' : t.tone === 'gold' ? 'gold' : 'green', r.threat, { thin: true }).el);
  })) : line('No other House is near enough to threaten you.'),
    h('div.mu-row.mu-gap-6', { style: { marginTop: '8px' } }, button('Rivals', { size: 'small', icon: 'shield', onClick: () => env.go('rivals') })));

  const news = newsFor(realm.news(40), null, 7);
  const newsCard = section('News of the neighbours', 'scroll', news.length ? h('div.mu-col.mu-gap-4', null, news.map((n) => h('div.mu-rul-news', { class: n.threat >= 0.5 ? 'hot' : '' },
    icon(NEWS_ICON[n.kind] ?? 'scroll', 15), h('div.mu-grow', null, h('div.mu-small', null, n.text), h('div.mu-tiny.mu-dim', null, `${dateText(n.day)} · ${ctx.placeName(n.settlement)}`)),
    n.threat >= 0.3 ? chip(threatWords(n.threat).word, threatWords(n.threat).tone) : null))) : line('No news yet: neighbours’ buildings, techniques, troops and wars are reported here as they happen.'));

  if (!all.length) return empty('You rule no place now.');
  return h('div.mu-rul-page.mu-rul-overview', null, stats,
    h('div.mu-rul-cols', null,
      h('div.mu-rul-col', null, mapCard, booksCard, storesCard),
      h('div.mu-rul-col', null, worksCard, researchCard, troopsCard, threatsCard, newsCard)));
}
