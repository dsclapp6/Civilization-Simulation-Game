// Lands & works: each settlement and outpost you hold — what stands there, what it makes, the jobs, the stores — and the construction
// queue with its priorities, cancelling, and "open builder mode here" (CIV §6.2).
import { BUILDINGS } from '../../../content/types';
import { bar, button, chip, empty, heading } from '../../components/widgets';
import { h } from '../../core/dom';
import { icon } from '../../core/icons';
import { SETTLEMENT_ICON } from '../../core/iconMap';
import { prosperityWords } from '../../core/mapModel';
import { DEPOSIT_NAME, type DepositKind } from '../../core/mapModel';
import { settlementCard } from '../../../sim/api';
import { CATEGORY_ICON, CATEGORY_LABEL, CATEGORY_ORDER, etaWords, priorityFor, queueRows, STATUS_TONE } from '../../builder/builderModel';
import { goodIcon } from '../../builder/landsUi';
import { ruleOffer } from '../ruleTown';
import { amountText, YIELD_NAME } from '../rulerModel';
import { line, type RulerEnv } from '../rulerUi';

type Cat = (typeof CATEGORY_ORDER)[number];

export function buildLands(env: RulerEnv): HTMLElement {
  const { ctx } = env;
  const sim = ctx.sim;
  const v = env.view();
  const cons = ctx.game.construction;
  const me = env.me();
  const places = [...v.settlements];
  const wrap = h('div.mu-rul-page.mu-rul-lands');

  // what category each kind of building is in: the construction catalogue knows
  const catOf = new Map<string, Cat>();
  for (const o of cons?.catalogue(me, v.seat ?? places[0] ?? 0) ?? []) catOf.set(o.kind, o.category);

  const holdings = (id: number): HTMLElement => {
    const card = settlementCard(sim, id);
    const s = sim.world.settlements.find((x) => x.id === id);
    if (!card || !s) return h('span');
    const list = (sim.state.buildingsAt.get(id) ?? []).filter((b) => b.construction >= 1);
    const byCat = new Map<Cat, number>();
    const work = new Map<string, number>();
    for (const b of list) {
      const c = catOf.get(b.kind);
      if (c) byCat.set(c, (byCat.get(c) ?? 0) + 1);
      if (c === 'craft' || c === 'food' || c === 'resource') work.set(b.kind, (work.get(b.kind) ?? 0) + 1);
    }
    const jobs = ctx.eco.jobs?.(id, me) ?? [];
    const yields = ctx.game.territory?.resources(id)?.yields ?? [];
    // the stores of the House's own households there: the lord's, the garrison's, the staff's
    const stores = new Map<string, number>();
    for (const hh of sim.state.householdsIn(id)) {
      if (hh.kind === 'family' || (hh.house !== v.house && hh.id !== v.household)) continue;
      for (const [key, q] of Object.entries(hh.stores)) {
        // (a good with quality tiers is kept as "horse#2": the tiers are one good here)
        const g = key.split('#')[0];
        if (q > 0 && ctx.eco.good(g)?.category !== 'livestock') stores.set(g, (stores.get(g) ?? 0) + q);
      }
    }
    const topStores = [...stores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const sites = (cons?.sites(id) ?? []).length;
    const offer = places.includes(id) ? null : ruleOffer(ctx.game, id);
    return h('div.mu-card.mu-rul-place', null,
      h('div.mu-row.mu-between.mu-top', null,
        h('div.mu-row.mu-gap-8', null, h('span.mu-map-kind', null, icon(SETTLEMENT_ICON[s.kind], 26)),
          h('div', null, h('h4', null, card.name), h('div.mu-small.mu-dim', null, `${s.kind} · ${card.population.toLocaleString('en-GB')} people · ${prosperityWords(card.prosperity)}`))),
        h('div.mu-row.mu-gap-6', null, sites ? chip(`${sites} works`, 'gold', 'hammer') : null, s.market ? chip('market', 'lapis', 'market') : null)),
      h('div.mu-row.mu-wrap.mu-gap-4', { style: { margin: '8px 0 4px' } }, CATEGORY_ORDER.filter((c) => byCat.get(c)).map((c) => chip(`${CATEGORY_LABEL[c]} ${byCat.get(c)}`, '', CATEGORY_ICON[c]))),
      work.size ? h('div.mu-small.mu-ink2', null, h('span.mu-dim', null, 'Works: '), [...work.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, n]) => `${n > 1 ? `${n} ` : ''}${(BUILDINGS[k as keyof typeof BUILDINGS]?.name ?? k).toLowerCase()}`).join(', ')) : null,
      yields.length ? h('div.mu-small.mu-ink2', null, h('span.mu-dim', null, 'Its land yields: '), yields.map((y) => YIELD_NAME[y] ?? y).join(', ')) : null,
      h('div.mu-small.mu-ink2', null, h('span.mu-dim', null, 'Jobs open: '), String(jobs.length)),
      topStores.length ? h('div.mu-row.mu-wrap.mu-gap-4', { style: { marginTop: '6px' } }, topStores.map(([g, q]) => h('span.mu-good-line', { tip: 'In the House’s stores here' }, goodIcon(ctx.eco, g), h('span', null, `${amountText(q)} ${ctx.eco.good(g)?.name.toLowerCase() ?? g}`)))) : null,
      h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '10px' } },
        button('Builder mode here', { size: 'small', icon: 'hammer', variant: 'primary', tip: 'Lift the camera over this place and raise something', onClick: () => ctx.open({ panel: 'ext', name: 'builder', data: { settlement: id } }) }),
        offer ? button(offer.label, { size: 'small', icon: 'crown', tip: offer.tip, onClick: () => { ctx.close(); ctx.open(offer.request); } }) : null));
  };

  wrap.append(h('div.mu-grid.mu-rul-grid2', null, places.map(holdings)));

  // places held from you (your vassals'): a short list with a way to be their ruler
  if (v.vassalSettlements.length) {
    wrap.append(heading(`Held from you · ${v.vassalSettlements.length}`, 'shield'),
      h('div.mu-list', null, v.vassalSettlements.slice(0, 24).map((id) => {
        const offer = ruleOffer(ctx.game, id);
        const card = settlementCard(sim, id);
        return h('div.mu-li', null, h('div.mu-grow', null, h('b', null, ctx.placeName(id)), h('div.mu-small.mu-dim', null, card ? `${card.population.toLocaleString('en-GB')} people · ${prosperityWords(card.prosperity)}${card.lord ? ` · ${ctx.nameOf(card.lord)}` : ''}` : '')),
          offer ? button(offer.label, { size: 'small', icon: 'crown', tip: offer.tip, onClick: () => { ctx.close(); ctx.open(offer.request); } }) : null);
      })));
  }

  // outposts of the House
  const outposts = (cons?.outposts() ?? []).filter((o) => o.house === v.house || places.includes(o.settlement));
  if (outposts.length) {
    wrap.append(heading(`Outposts · ${outposts.length}`, 'flag'),
      h('div.mu-grid.mu-rul-grid2', null, outposts.map((o) => {
        const dep = sim.world.deposits?.[o.deposit];
        const works = (sim.state.buildingsAt.get(o.settlement) ?? []).filter((b) => Math.hypot(b.x - o.x, b.z - o.z) < 650 && b.plot < 0).length;
        return h('div.mu-card', null, h('div.mu-row.mu-between.mu-top', null,
          h('div', null, h('h4', null, o.name), h('div.mu-small.mu-dim', null, `of ${ctx.placeName(o.settlement)}${dep ? ` · ${DEPOSIT_NAME[dep.kind as DepositKind]}` : ' · in the wild'}`)),
          chip(`${works} works`, 'gold', 'hammer')),
          h('div.mu-row.mu-gap-6', { style: { marginTop: '8px' } }, button('Builder mode here', { size: 'small', icon: 'hammer', onClick: () => ctx.open({ panel: 'ext', name: 'builder', data: { at: { x: o.x, z: o.z } } }) })));
      })));
  }

  // the construction queue
  if (cons) {
    const all = new Set<number>([...v.settlements, ...v.vassalSettlements]);
    const sites = cons.sites().filter((s) => all.has(s.settlement) || outposts.some((o) => o.settlement === s.settlement));
    const rows = queueRows(sites, (id) => cons.canManage?.(me, id) ?? false, sim.absDay, (id) => ctx.placeName(id));
    wrap.append(heading(`The construction queue · ${rows.length}`, 'hammer'));
    if (!rows.length) wrap.append(line('No work is under way in your lands.'));
    else {
      wrap.append(h('div.mu-list', null, rows.slice(0, 40).map((r, i) => {
        const site = sites.find((s) => s.id === r.id);
        const b = bar(r.status === 'stalled' ? 'vermilion' : r.status === 'waiting' ? 'gold' : 'green', r.progress, { thin: true });
        return h('div.mu-li.mu-rul-qrow', { class: r.mine ? '' : 'dis' },
          h('span.mu-bld-qn', null, String(i + 1)),
          h('div.mu-grow', null, h('div.mu-row.mu-between.mu-gap-6', null, h('b.mu-trunc', null, r.title), chip(r.statusWord, STATUS_TONE[r.status])),
            h('div.mu-tiny.mu-dim.mu-trunc', null, `${r.place} · ${r.line}${site ? ` · ${etaWords(site.eta, sim.absDay, site.status)}` : ''}`), b.el),
          r.mine ? h('div.mu-row.mu-gap-4', null,
            button('', { icon: 'arrow_up', size: 'small', tip: 'Work this first', onClick: () => env.done(cons.setPriority(me, r.id, priorityFor(rows, 'first'))) }),
            button('', { icon: 'arrow_down', size: 'small', tip: 'Work it last', onClick: () => env.done(cons.setPriority(me, r.id, priorityFor(rows, 'last'))) }),
            button('', { icon: 'pin', size: 'small', tip: 'Open builder mode here', onClick: () => ctx.open({ panel: 'ext', name: 'builder', data: { at: { x: r.x, z: r.z } } }) }),
            button('', { icon: 'cross', size: 'small', variant: 'danger', tip: 'Cancel the work', onClick: () => ctx.confirm({
              title: 'Cancel this work?', text: 'Most of the materials delivered come back to your stores (70 %); the labour already put in is lost.', confirmLabel: 'Cancel the work', cancelLabel: 'Keep it', danger: true,
              onConfirm: () => env.done(cons.cancel(me, r.id), 'The work is cancelled.'),
            }) })) : h('span.mu-tiny.mu-dim', null, 'not yours to order'));
      })));
    }
  } else wrap.append(empty('No one raises buildings in this run.'));
  return wrap;
}
