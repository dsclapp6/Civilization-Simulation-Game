// Advancement and happenings (wave 3): the House tree (four branches: who knows what, what is being
// practised, what has been lost) and the journal of favours and notices (requests NPCs have made of the
// player, news of the district). Open with { panel: 'ext', name: 'techs' } or name: 'requests'.
import { dist } from '../../core/math';
import type { AdvancementRuntime, TechDef, TechView } from '../../sim/advancement/types';
import type { HappeningRec, HappeningsRuntime, RequestType, RequestView } from '../../sim/happenings/types';
import { h, replace } from '../core/dom';
import { formatMoney, plural, relativeDay } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { bar, button, chip, empty, heading, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { every, panelOf } from './base';
import { registerPanel } from './extRegistry';

const adv = (ctx: PanelCtx): AdvancementRuntime | undefined => ctx.sim.services?.advancement as AdvancementRuntime | undefined;
const hap = (ctx: PanelCtx): HappeningsRuntime | undefined => ctx.sim.services?.happenings as HappeningsRuntime | undefined;

// ---------------------------------------------------------------------------------------------
// The House tree
// ---------------------------------------------------------------------------------------------

const BRANCH_ICON: Record<string, IconName> = { economy: 'coin', military: 'swords', kinship: 'ring', knowledge: 'book' };

const EFFECT_TEXT: Record<string, (v: number) => string> = {
  'farm.yield': (v) => `fields yield ${pct(v)} more`, prosperity: (v) => `prosperity ${pct(v)} higher`, 'famine.resist': (v) => `famine ${pct(v)} less likely`,
  'mill.speed': (v) => `milling ${pct(v)} faster`, 'market.depth': (v) => `deeper markets (${pct(v)})`, fair: () => 'a yearly fair may be held',
  'fire.spread': (v) => `fires spread ${pct(-v)} less`, 'plague.fatality': (v) => `plague kills ${pct(-v)} fewer`, 'epidemic.decay': (v) => `epidemics fade ${pct(v)} sooner`,
  healing: (v) => `healing ${pct(v)} better`, 'arms.longbow': () => 'longbow drill', 'arms.crossbow': () => 'crossbows', 'arms.destrier': () => 'destriers',
  'armour.plates': () => 'coats of plates', 'armour.plate': () => 'full plate', 'defence.keep': () => 'stone keeps', 'defence.walls': () => 'curtain walls',
  'defence.concentric': () => 'concentric castles', 'siege.trebuchet': () => 'trebuchets', 'siege.bombard': () => 'bombards', 'levy.retinue': (v) => `retinues ${pct(v)} stronger`,
  'levy.archers': (v) => `levy archers ${pct(v)} better`, 'vassal.levy': (v) => `vassal levies ${pct(v)} larger`, 'marriage.dowry': (v) => `dowries ${pct(v)} firmer`,
  'ward.income': (v) => `wards bring ${pct(v)} more`, 'diplomacy.truce': () => 'truces', 'diplomacy.contact': () => 'heralds carry word', 'diplomacy.alliance': () => 'alliance treaties',
  tournament: () => 'tournaments', 'realm.council': () => 'a council of the realm', literacy: (v) => `literacy ${pct(v)} higher`, records: () => 'books keep what is known',
  'trade.margin': (v) => `trade margins ${pct(v)} wider`, 'road.risk': (v) => `roads ${pct(-v)} safer`, 'tax.efficiency': (v) => `taxes ${pct(v)} better collected`,
  'wool.price': (v) => `wool ${pct(v)} dearer`, 'cloth.value': (v) => `cloth ${pct(v)} more valuable`, 'craft.quality': (v) => `work ${pct(v)} finer`,
};
const pct = (v: number): string => `${Math.round(Math.abs(v) * 100)}%`;

const PRACTICE_TEXT: Record<string, string> = {
  'farm.plough': 'ploughing', 'farm.sow': 'sowing', 'farm.harrow': 'harrowing', 'farm.manure': 'spreading manure', 'farm.mill': 'milling grain',
  'craft.weave_cloth': 'weaving cloth', 'craft.weave_linen': 'weaving linen', 'craft.forge_plates': 'forging coats of plates', 'craft.forge_crossbow': 'forging crossbows',
  'arms.practise': 'archery at the butts', 'trade.market': 'trading at market', 'trade.person': 'trading with merchants', 'manage.household': 'managing a household',
};
const STUDY_TEXT: Record<string, string> = { school: 'the school', church: 'the church', cloister: 'a cloister', abbey_church: 'an abbey', cathedral: 'a cathedral', infirmary: 'an infirmary', guildhall: 'a guildhall' };

function effectLine(def: TechDef): string {
  return Object.entries(def.effects).map(([k, v]) => (EFFECT_TEXT[k] ? EFFECT_TEXT[k](v) : `${k} ${v > 0 ? '+' : ''}${v}`)).join('; ');
}

function practiceHint(def: TechDef): string {
  const p = def.learn.player;
  const bits: string[] = [];
  if (p?.actions?.length) bits.push(`practise ${p.actions.map((a) => PRACTICE_TEXT[a] ?? a).join(', ')}`);
  if (p?.study?.length) bits.push(`study at ${p.study.map((s) => STUDY_TEXT[s] ?? s).join(' or ')}`);
  return bits.length ? bits.join(' · ') : 'learn it from a master';
}

function statusChip(v: TechView): HTMLElement {
  if (v.mine) return chip('Yours', 'green', 'check');
  if (v.houseHas) return chip('Your House', 'green', 'users');
  if (v.state === 'known') return v.locked ? chip('Locked', '', 'lock') : chip('Known elsewhere', 'lapis', 'eye_off');
  if (v.state === 'preserved') return chip('In the books', 'gold', 'book');
  if (v.state === 'lost') return chip('Lost', 'vermilion', 'skull');
  return v.locked ? chip('Locked', '', 'lock') : chip('Undiscovered', '', 'question');
}

function techsPanel(ctx: PanelCtx): UiPanel {
  const a = adv(ctx);
  const win = createWindow({ title: 'House tree', subtitle: 'What your House knows, and who holds it', icon: 'scroll', size: 'xl', tall: true, onClose: () => ctx.close() });
  const content = h('div.mu-scroll', { style: { padding: '12px 16px', maxHeight: '100%' } });
  if (!a) {
    win.body.append(empty('The learned folk are not yet at work.'));
    return panelOf({ id: 'techs', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
  }
  let branch = a.branches()[0].id as string;
  let sig = '';
  const tabsEl = tabs(a.branches().map((b) => ({ id: b.id, label: b.name, icon: BRANCH_ICON[b.id] })), branch, (id) => { branch = id; tabsEl.set(branch); render(true); });
  win.body.classList.add('flush');
  win.body.append(tabsEl.el, h('div.mu-tabbar-rule'), content);

  const depthOf = (v: TechView, all: Map<string, TechView>, guard = 0): number => {
    let d = 0;
    for (const r of v.def.requires) { const rv = all.get(r); if (rv && rv.def.branch === v.def.branch && guard < 8) d = Math.max(d, 1 + depthOf(rv, all, guard + 1)); }
    return d;
  };

  const card = (v: TechView): HTMLElement => {
    const d = v.def;
    const needsPractice = !v.houseHas && !v.locked && v.need > 0 && v.state !== 'lost';
    const holders = v.holderIds.map((id) => {
      const b = h<HTMLButtonElement>('button.mu-chip.mu-click', { type: 'button', tip: 'See who they are' }, ctx.nameOf(id));
      b.addEventListener('click', () => ctx.open({ panel: 'person', id }));
      return b;
    });
    return h('div.mu-card', { class: v.locked ? 'locked' : '' },
      h('div.mu-row.mu-between.mu-top.mu-gap-6', null, h('h4', null, d.name), statusChip(v)),
      h('p.mu-small.mu-ink2', { style: { margin: '2px 0 6px' } }, d.desc),
      h('div.mu-tiny.mu-dim', null, `Gives: ${effectLine(d)}`),
      d.requires.length ? h('ul.mu-reqs', null, d.requires.map((r) => {
        const ok = a.houseHas(ctx.sim.state.run.houseId, r);
        return h('li', { class: ok ? 'met' : 'unmet' }, icon(ok ? 'check' : 'cross', 14), a.tech(r)?.name ?? r);
      })) : null,
      v.note ? h('div.mu-small.mu-dim.mu-ital', null, v.note) : null,
      needsPractice ? h('div', { style: { marginTop: '6px' } },
        h('div.mu-tiny.mu-dim', null, `To learn it: ${practiceHint(d)}`),
        v.progress > 0 ? h('div', { style: { marginTop: '3px' } }, bar('gold', v.progress, { thin: true }).el) : null,
        v.progress > 0 ? h('div.mu-tiny.mu-dim', null, `${Math.floor((v.progress / v.need) * 100)}% practised`) : null) : null,
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '6px' } },
        v.holders > 0 ? chip(plural(v.holders, 'holder'), '', 'users') : chip('No living holder', '', 'users'),
        holders, chip(`${d.points} points`, '', 'star')));
  };

  function render(force = false): void {
    const views = a!.tree();
    const s = views.map((v) => `${v.def.id}:${v.state}:${v.houseHas ? 1 : 0}:${v.mine ? 1 : 0}:${v.holders}:${Math.floor(v.progress)}:${v.locked ? 1 : 0}`).join('|') + branch;
    if (!force && s === sig) return;
    sig = s;
    const all = new Map(views.map((v) => [v.def.id, v]));
    const here = views.filter((v) => v.def.branch === branch);
    const cols = Math.min(4, Math.max(...here.map((v) => depthOf(v, all))) + 1);
    const columns: TechView[][] = Array.from({ length: cols }, () => []);
    for (const v of here) columns[Math.min(cols - 1, depthOf(v, all))].push(v);
    for (const b of a!.branches()) {
      const mine = views.filter((v) => v.def.branch === b.id && v.houseHas).length;
      const total = views.filter((v) => v.def.branch === b.id).length;
      tabsEl.badge(b.id, `${mine}/${total}`);
    }
    const meta = a!.branches().find((b) => b.id === branch);
    const scroll = content.scrollTop;
    replace(content,
      h('p.mu-small.mu-ink2', { style: { margin: '0 0 8px' } }, meta?.blurb ?? ''),
      h('div.mu-grid', { style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, alignItems: 'start' } },
        columns.map((col) => h('div.mu-col.mu-gap-8', null, col.map(card)))),
      h('p.mu-tiny.mu-dim', { style: { marginTop: '10px' } }, 'A technique lives in the people who know it. Masters teach apprentices and children; scribes keep what they can in the abbey’s books; when the last holder of an unrecorded art dies, it is gone.'));
    content.scrollTop = scroll;
  }
  render(true);
  return panelOf({ id: 'techs', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, { tick: every(1.5, () => render()) });
}

// ---------------------------------------------------------------------------------------------
// Favours and notices
// ---------------------------------------------------------------------------------------------

const TYPE_ICON: Record<RequestType, IconName> = {
  fetch: 'bag', loan: 'purse', work: 'hammer', message: 'scroll', lost_animal: 'sheep', watch: 'shield', godparent: 'church', marriage: 'ring',
};
const STATE_CHIP: Record<RequestView['state'], [string, '' | 'gold' | 'green' | 'lapis' | 'vermilion']> = {
  offered: ['Asked', 'gold'], accepted: ['Promised', 'lapis'], done: ['Done', 'green'], failed: ['Failed', 'vermilion'], declined: ['Declined', ''], expired: ['Unanswered', ''],
};

function requestsPanel(ctx: PanelCtx): UiPanel {
  const H = hap(ctx);
  const win = createWindow({ title: 'Favours & notices', subtitle: 'What is asked of you, and what is happening near by', icon: 'quill', size: 'lg', tall: true, onClose: () => ctx.close() });
  const content = h('div.mu-scroll', { style: { padding: '12px 16px', maxHeight: '100%' } });
  if (!H) {
    win.body.append(empty('Nobody has anything to ask of you yet.'));
    return panelOf({ id: 'requests', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
  }
  let tab = 'requests';
  let sig = '';
  const tabsEl = tabs([{ id: 'requests', label: 'Requests', icon: 'hand' }, { id: 'notices', label: 'Notices', icon: 'bell' }], tab, (id) => { tab = id; tabsEl.set(tab); render(true); });
  win.body.classList.add('flush');
  win.body.append(tabsEl.el, h('div.mu-tabbar-rule'), content);

  const progressText = (r: RequestView): string => {
    if (r.state !== 'accepted') return '';
    if (r.type === 'work') return `${r.data.done ?? 0} of ${r.data.count ?? 0} jobs done`;
    if (r.type === 'watch') return `${r.data.watched ?? 0} of ${r.data.hours ?? 0} night hours kept`;
    if (r.type === 'fetch') return `${ctx.describe(r.data.good ?? '', r.data.qty ?? 1)} wanted`;
    if (r.type === 'loan') return `${formatMoney(r.reward.pence)} due back`;
    return '';
  };

  const requestCard = (r: RequestView): HTMLElement => {
    const open = r.state === 'offered' || r.state === 'accepted';
    const [label, tone] = STATE_CHIP[r.state];
    const who = h<HTMLButtonElement>('button.mu-chip.mu-click', { type: 'button', tip: 'Who is this?' }, icon('user', 13), r.fromName);
    who.addEventListener('click', () => ctx.open({ panel: 'person', id: r.from }));
    const money = ctx.sim.state.persons.get(ctx.playerId())?.money ?? 0;
    const poor = r.type === 'loan' && money < (r.data.pence ?? 0);
    return h('div.mu-card', { class: open ? '' : 'locked' },
      h('div.mu-row.mu-between.mu-top.mu-gap-6', null,
        h('div.mu-row.mu-gap-8', null, icon(TYPE_ICON[r.type], 20), h('h4', null, r.summary)),
        chip(label, tone)),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '2px 0 6px' } }, who, chip(r.placeName, '', 'pin'), open ? chip(r.daysLeft <= 0 ? 'lapsing today' : `${plural(r.daysLeft, 'day')} left`, r.daysLeft <= 1 ? 'vermilion' : '', 'hourglass') : chip(relativeDay(r.resolved ?? r.offered, ctx.sim.absDay), '', 'calendar')),
      open ? h('p.mu-small.mu-ink2.mu-ital', { style: { margin: '0 0 6px' } }, `“${r.text}”`) : r.note ? h('p.mu-small.mu-dim', null, r.note) : null,
      progressText(r) ? h('div.mu-small.mu-bold', null, progressText(r)) : null,
      open ? h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '4px' } },
        r.reward.pence > 0 ? chip(`${formatMoney(r.reward.pence)} ${r.type === 'loan' ? 'back with interest' : 'reward'}`, 'gold', 'coin') : null,
        chip(`+${r.reward.opinion} regard`, '', 'heart'), r.reward.points > 0 ? chip(plural(r.reward.points, 'point'), '', 'star') : null) : null,
      r.state === 'offered' ? h('div.mu-row.mu-gap-6', { style: { marginTop: '8px' } },
        button('Agree', { variant: 'primary', icon: 'check', size: 'small', disabled: poor, tip: poor ? 'You cannot afford it' : 'Promise to do this', onClick: () => { const res = H.acceptRequest(r.id); ctx.say(res.ok ? 'quest' : 'warn', res.ok ? `You promise: ${r.summary}.` : res.reason ?? 'It cannot be done.'); render(true); } }),
        button('Decline', { size: 'small', icon: 'cross', onClick: () => { H.declineRequest(r.id); render(true); } })) : null,
      r.state === 'accepted' ? h('div.mu-tiny.mu-dim', { style: { marginTop: '6px' } }, hint(r)) : null);
  };

  const hint = (r: RequestView): string => {
    switch (r.type) {
      case 'fetch': return `Bring it to ${r.fromName} and speak to them.`;
      case 'message': return `Find ${ctx.nameOf(r.data.target ?? 0)} in ${ctx.placeName(r.data.place ?? 0)} and speak to them.`;
      case 'work': return 'Any honest labour in their village counts: ploughing, reaping, tending beasts, crafting.';
      case 'lost_animal': return 'Search the pasture and woods out from the village; you will know it when you are close.';
      case 'watch': return 'Stay in the village through the night hours.';
      case 'godparent': return 'Be in the village on the day of the christening.';
      case 'loan': return 'They will repay when the time comes.';
      default: return '';
    }
  };

  const near = (r: HappeningRec): boolean => {
    const p = ctx.sim.state.persons.get(ctx.playerId());
    if (!p) return false;
    if (r.settlement < 0) return r.kingdom < 0 || ctx.sim.world.settlements.find((s) => s.id === p.settlement)?.kingdom === r.kingdom;
    const a = ctx.sim.world.settlements.find((s) => s.id === r.settlement), b = ctx.sim.world.settlements.find((s) => s.id === p.settlement);
    return !!a && !!b && dist(a.x, a.z, b.x, b.z) <= 5000;
  };

  const noticeRow = (r: HappeningRec, active: boolean): HTMLElement => h('div.mu-li', null,
    h('span.mu-ob-ico', null, icon(active ? 'bell' : 'scroll', 20)),
    h('div.mu-grow', null, h('b', null, r.text), h('div.mu-small.mu-dim', null, `${r.settlement >= 0 ? ctx.placeName(r.settlement) : 'The realm'} · ${active ? 'now' : relativeDay(r.end, ctx.sim.absDay)}`)));

  function render(force = false): void {
    const reqs = H!.requests();
    const act = H!.active().filter(near);
    const s = `${tab}|${reqs.map((r) => `${r.id}:${r.state}:${r.data.done ?? 0}:${r.data.watched ?? 0}:${r.daysLeft}`).join(',')}|${act.map((r) => r.id).join(',')}`;
    if (!force && s === sig) return;
    sig = s;
    const open = reqs.filter((r) => r.state === 'offered' || r.state === 'accepted');
    tabsEl.badge('requests', open.length || null);
    tabsEl.badge('notices', act.length || null);
    const scroll = content.scrollTop;
    if (tab === 'requests') {
      const past = reqs.filter((r) => r.state !== 'offered' && r.state !== 'accepted').slice(0, 8);
      replace(content,
        heading('Asked of you', 'hand'),
        open.length ? h('div.mu-col.mu-gap-8', null, open.map(requestCard)) : empty('Nobody has asked anything of you just now. Speak with your neighbours: they may need a hand.'),
        past.length ? heading('Settled', 'ledger') : null,
        past.length ? h('div.mu-col.mu-gap-8', null, past.map(requestCard)) : null,
        h('p.mu-tiny.mu-dim', { style: { marginTop: '10px' } }, 'Promises kept are remembered; promises broken are remembered longer. Talk to the person who asked to hear them out, agree, and bring what they need.'));
    } else {
      const recent = H!.recent(8).filter(near);
      replace(content,
        heading('Happening near you', 'bell'),
        act.length ? h('div.mu-list', null, act.map((r) => noticeRow(r, true))) : empty('All is quiet in the district.'),
        recent.length ? heading('Lately', 'scroll') : null,
        recent.length ? h('div.mu-list', null, recent.map((r) => noticeRow(r, false))) : null);
    }
    content.scrollTop = scroll;
  }
  render(true);
  return panelOf({ id: 'requests', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, { tick: every(1.2, () => render()) });
}

registerPanel('techs', (ctx) => techsPanel(ctx));
registerPanel('requests', (ctx) => requestsPanel(ctx));
