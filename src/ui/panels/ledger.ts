// Ledger & management (J / C): holdings, the household plan (head only), obligations with due dates,
// property for sale or rent, the recent accounts, and the authority sections that unlock with rank.
import { BUILDINGS } from '../../content/types';
import type { AnimalKind } from '../../core/domain';
import { personCard } from '../../sim/api';
import { skillLevel } from '../../sim/people';
import type { HouseholdTask, Obligation, ObligationKind, PropertyListing, StripHolding } from '../../sim/economy/types';
import { SKILLS } from '../../core/domain';
import { ageYears, fullName, type Person } from '../../sim/state';
import { h, replace } from '../core/dom';
import { dueText, formatMoney, plural, relativeDay } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { GOOD_ICON } from '../core/iconMap';
import { TASK_LABEL, TASK_ORDER, authoritySlots, obligationAmount } from '../core/ledgerModel';
import type { LedgerTab } from '../core/requests';
import { SKILL_NAMES } from '../core/text';
import { bar, button, chip, empty, heading, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';

const animalIcon = (k: AnimalKind): IconName => (k === 'horse' ? 'horse' : 'sheep');
const animalWord = (k: AnimalKind, n: number): string => (n === 1 || k === 'sheep' ? k : `${k}s`);

const STATE_LABEL: Record<StripHolding['state'], string> = {
  bare: 'Bare', ploughed: 'Ploughed', sown: 'Sown', growing: 'Growing', ripe: 'Ripe', harvested: 'Harvested', stubble: 'Stubble', fallow: 'Fallow',
};
const STATE_TONE: Record<StripHolding['state'], '' | 'gold' | 'green' | 'lapis' | 'vermilion'> = {
  bare: '', ploughed: 'lapis', sown: 'lapis', growing: 'green', ripe: 'gold', harvested: '', stubble: '', fallow: '',
};

const OB_ICON: Record<ObligationKind, IconName> = {
  rent: 'home', week_work: 'hammer', boon_work: 'wheat', tithe: 'church', merchet: 'ring', heriot: 'horse', mill_fee: 'farming',
  toll: 'signpost', tax: 'crown', fine: 'warning', debt: 'purse', wage: 'coin',
};

export function ledgerPanel(ctx: PanelCtx, startTab: LedgerTab | undefined, settlementOverride: number | undefined): UiPanel {
  const sim = ctx.sim;
  const eco = ctx.eco;
  const win = createWindow({ title: 'Ledger', subtitle: 'Land, household, dues and accounts', icon: 'ledger', size: 'xl', tall: true, onClose: () => ctx.close() });
  let tab: LedgerTab = startTab ?? 'holdings';
  const content = h('div.mu-ledger');
  const tabsEl = tabs([
    { id: 'holdings', label: 'Holdings', icon: 'wheat' },
    { id: 'household', label: 'Household', icon: 'users' },
    { id: 'obligations', label: 'Dues', icon: 'scroll' },
    { id: 'property', label: 'Property', icon: 'home' },
    { id: 'ledger', label: 'Accounts', icon: 'coin' },
    { id: 'authority', label: 'Authority', icon: 'crown' },
  ], tab, (id) => { tab = id as LedgerTab; tabsEl.set(tab); render(); });
  win.body.classList.add('flush');
  win.body.append(tabsEl.el, h('div.mu-tabbar-rule'), content);

  const me = (): Person => sim.state.persons.get(ctx.playerId()) as Person;
  const hhId = (): number => me().household;
  const isHead = (): boolean => sim.state.households.get(hhId())?.head === ctx.playerId();

  // ---------------------------------------------------------------- holdings
  const holdingsView = (): HTMLElement => {
    const hold = eco.holding(hhId());
    if (!hold) return empty('You hold no land or house of your own.');
    const home = sim.state.buildings.get(hold.home);
    const tenure: Record<string, string> = { serf: 'Villein: you hold by the lord’s leave', free: 'Free tenant', lease: 'Leaseholder', owned: 'Owner', lodger: 'Lodger', none: 'No tenure' };
    const strips = hold.strips.map((s) => {
      const g = bar('green', s.growth, { thin: true });
      const w = bar('gold', s.work, { thin: true });
      return h('tr', null,
        h('td', null, `Strip ${s.id}`), h('td.mu-dim', null, `Field ${s.field + 1}`), h('td', null, s.crop === 'fallow' ? 'Fallow' : s.crop),
        h('td', null, chip(STATE_LABEL[s.state], STATE_TONE[s.state])),
        h('td.mu-bar-cell', null, g.el), h('td.mu-bar-cell', null, w.el), h('td.mu-ink2', null, s.nextTask));
    });
    const animals = Object.entries(hold.livestock).filter(([, n]) => (n ?? 0) > 0);
    return h('div.mu-ledger-scroll.mu-scroll', null,
      h('div.mu-grid.c3', null,
        h('div.mu-card', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Tenure'), h('div.mu-bold', null, tenure[hold.tenure] ?? hold.tenure),
          h('div.mu-small.mu-dim', null, home ? `Home: a ${BUILDINGS[home.kind].name.toLowerCase()}` : 'No home of your own')),
        h('div.mu-card', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Rent and dues'),
          h('div.mu-bold', null, hold.rent > 0 ? `${formatMoney(hold.rent)} a year` : 'No money rent'),
          h('div.mu-small.mu-dim', null, hold.weekWork > 0 ? `${plural(hold.weekWork, 'day')} of week-work on the lord’s land` : 'No week-work')),
        h('div.mu-card', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Livestock'),
          animals.length ? h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '4px' } }, animals.map(([k, n]) => chip(`${n} ${animalWord(k as AnimalKind, n ?? 0)}`, '', animalIcon(k as AnimalKind))))
            : h('div.mu-dim.mu-small', null, 'None kept'))),
      heading('Open-field strips', 'farming'),
      strips.length ? h('table.mu-table', null,
        h('thead', null, h('tr', null, ['Strip', 'Field', 'Crop', 'State', 'Growth', 'Task', 'Next'].map((t) => h('th', null, t)))),
        h('tbody', null, strips)) : h('p.mu-dim.mu-ital', null, 'You hold no strips in the open fields.'),
      heading('Household stores', 'home'),
      hold.stores.length ? h('div.mu-row.mu-wrap.mu-gap-6', null, hold.stores.map((s) => chip(ctx.describe(s.key, s.qty), '', GOOD_ICON[s.good.category]))) : h('p.mu-dim.mu-ital', null, 'The stores are bare.'),
    );
  };

  // ---------------------------------------------------------------- household plan
  const householdView = (): HTMLElement => {
    const hh = sim.state.households.get(hhId());
    if (!hh) return empty('You have no household.');
    const head = isHead();
    const plan = eco.householdPlan(hh.id);
    const rows = plan.map((line) => {
      const m = sim.state.persons.get(line.person);
      if (!m) return h('span');
      const sel = h<HTMLSelectElement>('select.mu-input', { disabled: !head, 'aria-label': `Task for ${m.first}` },
        TASK_ORDER.map((t) => h('option', { value: t, selected: t === line.task }, TASK_LABEL[t])));
      sel.addEventListener('change', () => {
        const r = eco.setTask(ctx.playerId(), m.id, sel.value as HouseholdTask);
        ctx.say(r.ok ? 'info' : 'warn', r.ok ? `${m.first}: ${TASK_LABEL[sel.value as HouseholdTask].toLowerCase()}.` : r.reason ?? 'Only the head can change this.');
      });
      const employed = eco.employment(m.id);
      const mine = employed && employed.employer === ctx.playerId();
      return h('div.mu-li.mu-plan-row', null,
        h('div.mu-grow', null, h('b', null, fullName(m)), h('div.mu-small.mu-dim', null, `${Math.floor(ageYears(m, sim.absDay))} years old${m.id === hh.head ? ' · head' : ''}${mine ? ` · hired at ${formatMoney(employed.wage)} a day` : ''}`)),
        sel,
        mine ? button('Dismiss', { size: 'small', variant: 'danger', onClick: () => { const r = eco.dismiss(ctx.playerId(), m.id); ctx.say(r.ok ? 'info' : 'warn', r.ok ? `${m.first} is let go.` : r.reason ?? ''); render(); } }) : h('span'));
    });

    // hiring: unemployed adults of the settlement
    const candidates: Person[] = [];
    if (head) {
      for (const r of sim.state.residentsOf(me().settlement)) {
        if (r.household === hh.id || r.id === ctx.playerId() || ageYears(r, sim.absDay) < 14 || r.rankTier > me().rankTier + 0) continue;
        if (eco.employment(r.id)) continue;
        candidates.push(r);
        if (candidates.length >= 40) break;
      }
      candidates.sort((a, b) => b.trained.str + b.trained.end - (a.trained.str + a.trained.end));
    }
    const hire = candidates.slice(0, 6).map((c) => {
      const best = [...SKILLS].sort((a, b) => c.skills[b] - c.skills[a])[0];
      const lvl = skillLevel(c.skills[best]);
      const wage = 2;
      return h('div.mu-li', null,
        h('div.mu-grow', null, h('b', null, fullName(c)), h('div.mu-small.mu-dim', null, `${Math.floor(ageYears(c, sim.absDay))} years old${lvl > 0 ? ` · ${SKILL_NAMES[best]} ${lvl}` : ''}`)),
        h('span.mu-small.mu-dim', null, `${formatMoney(wage)} a day`),
        button('Hire', { size: 'small', variant: 'primary', icon: 'plus', onClick: () => { const r = eco.hire(ctx.playerId(), c.id, wage, 'fields'); ctx.say(r.ok ? 'gain' : 'warn', r.ok ? `${c.first} works for you.` : r.reason ?? 'They will not come.'); render(); } }));
    });

    return h('div.mu-ledger-scroll.mu-scroll', null,
      head ? null : h('div.mu-rule-note', { style: { marginBottom: '10px' } }, icon('lock', 15), h('span', null, 'Only the head of the household can change this.')),
      h('div.mu-row.mu-between', { style: { marginBottom: '4px' } }, heading('Who does what', 'users'), h('span.mu-small.mu-dim', null, `Household purse ${formatMoney(hh.purse)}`)),
      h('div.mu-list', null, rows),
      head ? h('div', { style: { marginTop: '16px' } }, heading('Hire help', 'hammer'),
        hire.length ? h('div.mu-list', null, hire) : h('p.mu-dim.mu-ital', null, 'No one in the district is looking for work.'),
        h('p.mu-tiny.mu-dim', null, 'You may hire anyone if you can pay and have work for them.')) : null,
    );
  };

  // ---------------------------------------------------------------- obligations
  const obligationsView = (): HTMLElement => {
    const list = eco.obligations(ctx.playerId()).sort((a, b) => a.due - b.due);
    const now = sim.absDay;
    const row = (o: Obligation): HTMLElement => h('div.mu-li', { class: o.overdue ? 'overdue' : '' },
      h('span.mu-ob-ico', null, icon(OB_ICON[o.kind] ?? 'scroll', 20)),
      h('div.mu-grow', null, h('b', null, o.label), h('div.mu-small.mu-dim', null, `${obligationAmount(o.amount, o.unit, formatMoney)}${o.to ? ` · owed to ${ctx.nameOf(o.to)}` : ''}`)),
      h('span.mu-small', { class: o.overdue ? 'mu-bad mu-bold' : 'mu-dim' }, dueText(o.due, now)));
    return h('div.mu-ledger-scroll.mu-scroll', null,
      list.length ? h('div.mu-list', null, list.map(row)) : empty('You owe nothing, to anyone.'),
      h('p.mu-tiny.mu-dim', { style: { marginTop: '10px' } }, 'Serfs owe week-work and boon-work, merchet when a daughter marries and heriot at a death; everyone owes the tithe, a tenth of the produce.'));
  };

  // ---------------------------------------------------------------- property
  const propertyView = (): HTMLElement => {
    const place = settlementOverride ?? me().settlement;
    const name = sim.world.settlements.find((s) => s.id === place)?.name ?? 'this place';
    const items = eco.listings(place, ctx.playerId());
    const card = (l: PropertyListing): HTMLElement => {
      const unmet = l.requirements.find((r) => !r.met);
      const buy = button(l.price !== null ? `Buy for ${formatMoney(l.price)}` : 'Not for sale', { variant: 'primary', size: 'small', disabled: l.price === null || !!unmet, tip: unmet?.label,
        onClick: () => { const r = eco.buyOrRent(ctx.playerId(), l.id, 'buy'); ctx.say(r.ok ? 'gain' : 'warn', r.ok ? `You buy ${l.label.toLowerCase()}.` : r.reason ?? 'It cannot be done.'); render(); } });
      const rent = button(l.rent !== null ? `Rent for ${formatMoney(l.rent)} a year` : 'Not to let', { size: 'small', disabled: l.rent === null || !!unmet, tip: unmet?.label,
        onClick: () => { const r = eco.buyOrRent(ctx.playerId(), l.id, 'rent'); ctx.say(r.ok ? 'gain' : 'warn', r.ok ? `You rent ${l.label.toLowerCase()}.` : r.reason ?? 'It cannot be done.'); render(); } });
      return h('div.mu-card', { class: unmet ? 'locked' : '' },
        h('div.mu-row.mu-between.mu-top', null, h('h4', null, l.label), chip(l.kind, '', 'home')),
        h('ul.mu-reqs', null, l.requirements.map((r) => h('li', { class: r.met ? 'met' : 'unmet' }, icon(r.met ? 'check' : 'cross', 14), r.label))),
        h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '8px' } }, buy, rent));
    };
    return h('div.mu-ledger-scroll.mu-scroll', null,
      heading(`For sale or to let in ${name}`, 'home'),
      items.length ? h('div.mu-grid.c2', null, items.map(card)) : empty('Nothing is offered here just now.'));
  };

  // ---------------------------------------------------------------- accounts
  const accountsView = (): HTMLElement => {
    const lines = eco.ledger(hhId()).sort((a, b) => b.day - a.day);
    const inc = lines.filter((l) => l.pence > 0).reduce((n, l) => n + l.pence, 0);
    const out = lines.filter((l) => l.pence < 0).reduce((n, l) => n - l.pence, 0);
    const hh = sim.state.households.get(hhId());
    return h('div.mu-ledger-scroll.mu-scroll', null,
      h('div.mu-grid.c4', null,
        h('div.mu-card.mu-stat', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Your purse'), h('div.mu-big.mu-bold', null, formatMoney(me().money))),
        h('div.mu-card.mu-stat', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Household purse'), h('div.mu-big.mu-bold', null, formatMoney(hh?.purse ?? 0))),
        h('div.mu-card.mu-stat', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Earned lately'), h('div.mu-big.mu-bold.mu-good', null, formatMoney(inc))),
        h('div.mu-card.mu-stat', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Spent lately'), h('div.mu-big.mu-bold.mu-bad', null, formatMoney(out)))),
      heading('Recent entries', 'ledger'),
      lines.length ? h('div.mu-list', null, lines.map((l) => h('div.mu-li', null,
        h('span.mu-small.mu-dim.mu-ledger-date', null, relativeDay(l.day, sim.absDay)),
        h('span.mu-grow', null, l.label),
        h('b.mu-num', { class: l.pence >= 0 ? 'mu-good' : 'mu-bad' }, `${l.pence >= 0 ? '+' : '−'}${formatMoney(Math.abs(l.pence))}`)))) : empty('Nothing has been written yet.'));
  };

  // ---------------------------------------------------------------- authority
  const authorityView = (): HTMLElement => {
    const card = personCard(sim, ctx.playerId());
    const p = me();
    if (!card) return empty('');
    const slots = authoritySlots(card, p);
    const held = slots.filter((s) => s.unlocked).length;
    return h('div.mu-ledger-scroll.mu-scroll', null,
      h('p.mu-small.mu-ink2', { style: { margin: '0 0 10px' } }, `Authority is earned. What you may command grows with your rank and offices; the rest is decided by whoever holds it, by their own character. You hold ${held} of ${slots.length} kinds today.`),
      h('div.mu-grid.c3', null, slots.map((s) => h('div.mu-card', { class: s.unlocked ? '' : 'locked' },
        h('div.mu-row.mu-between.mu-top', null,
          h('div.mu-row.mu-gap-8', null, h('span.mu-path-ico', null, icon(s.icon, 20)), h('h4', null, s.name)),
          s.unlocked ? chip('Yours', 'green', 'check') : chip('Locked', '', 'lock')),
        h('p.mu-small.mu-ink2', null, s.commands),
        s.unlocked ? null : h('div.mu-small.mu-dim.mu-ital', null, `Unlocked by: ${s.unlockedBy}`)))));
  };

  function render(): void {
    const view = tab === 'holdings' ? holdingsView() : tab === 'household' ? householdView() : tab === 'obligations' ? obligationsView()
      : tab === 'property' ? propertyView() : tab === 'ledger' ? accountsView() : authorityView();
    replace(content, view);
  }
  render();
  return panelOf({ id: 'ledger', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
}
