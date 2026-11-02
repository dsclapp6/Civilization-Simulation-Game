// Research: the four branches of the House tree. A technique is worked out by a person who could (a craftsman, a clerk, a monk, a
// master) at a fitting place, and paid for in its branch's goods and coin (CIV §6.4, docs/REALM.md). Start it when the stores hold
// the goods, buy the rest and start it when the treasury can, stop a project and get half of what is unspent back.
import techsJson from '../../../content/techs.json';
import { BUILDINGS } from '../../../content/types';
import type { ResearchOption, ResearchProject } from '../../../sim/realm/types';
import { bar, button, chip, empty, heading, seg } from '../../components/widgets';
import { h, replace } from '../../core/dom';
import { icon } from '../../core/icons';
import { dateText } from '../../core/format';
import { goodIcon } from '../../builder/landsUi';
import { BRANCHES, groupResearch, projectWords, researchCostLines, startChoice } from '../rulerModel';
import { line, money, type RulerEnv } from '../rulerUi';

const DESC = new Map<string, string>((techsJson.techs as Array<{ id: string; desc: string }>).map((t) => [t.id, t.desc]));

interface Bag { branch: string; chosen: Record<string, { researcher: number; building: number }>; open: Record<string, boolean> }

export function buildResearch(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const v = env.view();
  const sim = ctx.sim;
  const may = env.may();
  const bag = env.state<Bag>('research', () => ({ branch: '', chosen: {}, open: {} }));
  const options = realm.researchOptions(me);
  const groups = groupResearch(options);
  if (!bag.branch || !groups.has(bag.branch)) bag.branch = BRANCHES.find((b) => (groups.get(b.id) ?? []).some((o) => o.ok || o.buyable))?.id ?? BRANCHES[0].id;
  const wrap = h('div.mu-rul-page.mu-rul-research');

  // ---- under way
  const projects = realm.projects(v.house).filter((p) => p.state === 'active' || p.state === 'stalled');
  const placeOf = (p: ResearchProject): string => {
    const b = sim.state.buildings.get(p.building);
    return b ? `${BUILDINGS[b.kind]?.name ?? b.kind}, ${ctx.placeName(b.settlement)}` : 'a place no longer standing';
  };
  wrap.append(heading(`Under way · ${projects.length} of 4`, 'hammer'));
  wrap.append(projects.length ? h('div.mu-grid.c2', null, projects.map((p) => {
    const w = projectWords(p, sim.absDay);
    return h('div.mu-card', null,
      h('div.mu-row.mu-between.mu-top', null, h('div', null, h('h4', null, p.name), h('div.mu-small.mu-dim', null, `${ctx.nameOf(p.researcher)} at the ${placeOf(p)}`)),
        chip(w.eta, w.tone === 'vermilion' ? 'vermilion' : 'green')),
      bar(w.tone === 'vermilion' ? 'vermilion' : 'lapis', p.progress).el,
      h('div.mu-row.mu-between.mu-tiny.mu-dim', { style: { marginTop: '3px' } }, h('span', null, w.state), h('span', null, `${Math.round(p.progress * 100)}%${p.started !== undefined ? ` · begun ${dateText(p.started)}` : ''}`)),
      p.needs && Object.keys(p.needs).length ? h('div.mu-small.mu-ink2', { style: { marginTop: '4px' } }, `Still to come: ${Object.entries(p.needs).map(([g, q]) => env.describe(g, Math.ceil(q))).join(', ')}`) : null,
      may.realm ? h('div.mu-row.mu-end', { style: { marginTop: '8px' } }, button('Stop the work', { size: 'small', variant: 'danger', icon: 'cross', onClick: () => ctx.confirm({
        title: `Stop researching ${p.name}?`, text: 'Half of the coin not yet spent comes back, with the goods already taken. The researcher goes back to his own work.', confirmLabel: 'Stop it', cancelLabel: 'Go on', danger: true,
        onConfirm: () => env.done(realm.stopResearch(me, p.id), 'The work is stopped.'),
      }) })) : null);
  })) : line('Nothing is being worked out. Pick a technique below: a researcher and a place are chosen for you unless you say otherwise.'));

  // ---- the branches
  wrap.append(heading('What could be worked out', 'book'));
  const branchSeg = seg(BRANCHES.map((b) => ({ id: b.id, label: `${b.label} (${(groups.get(b.id) ?? []).length})`, tip: `Paid in ${b.currencies}` })), bag.branch, (id) => { bag.branch = id; env.refresh(); });
  const meta = BRANCHES.find((b) => b.id === bag.branch);
  wrap.append(h('div.mu-row.mu-gap-12.mu-wrap', { style: { margin: '2px 0 10px' } }, branchSeg, meta ? h('span.mu-small.mu-dim', null, `Paid in ${meta.currencies}.`) : null));
  const list = groups.get(bag.branch) ?? [];
  wrap.append(list.length ? h('div.mu-grid.c2', null, list.map((o) => optionCard(env, o, bag))) : empty('Nothing more can be taken up in this branch yet: the techniques you do not command need others first.', { icon: 'book', title: 'All taken up, or none within reach' }));
  void line; void money;
  return wrap;
}

function optionCard(env: RulerEnv, o: ResearchOption, bag: Bag): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const sim = ctx.sim;
  const may = env.may();
  const choice = startChoice(o);
  const cost = researchCostLines(o);
  const pick = (bag.chosen[o.tech] ??= { researcher: 0, building: -1 });
  const open = !!bag.open[o.tech];
  const place = (id: number): string => { const b = sim.state.buildings.get(id); return b ? `${BUILDINGS[b.kind]?.name ?? b.kind}, ${ctx.placeName(b.settlement)}` : `building ${id}`; };
  const best = o.researchers[0];
  const slow = new Set(o.slow ?? []);
  const who = o.researchers.length
    ? `${o.researchers.length} could work it out${best ? `: ${ctx.nameOf(best)}${slow.has(best) ? ' (a clerk, at half pace)' : ''}` : ''}`
    : 'No one in your lands could work it out';
  const where = o.places.length ? `${o.places.length} ${o.places.length === 1 ? 'place' : 'places'}: ${place(o.places[0])}${o.places.length > 1 ? ' …' : ''}` : 'No fitting place stands in your lands';

  const picker = open ? h('div.mu-rul-pick', null,
    h('label', null, h('span.mu-small', null, 'Who'), (() => {
      const s = h<HTMLSelectElement>('select.mu-input', null, h('option', { value: '0', selected: pick.researcher === 0 }, 'The best qualified'),
        o.researchers.slice(0, 40).map((id) => h('option', { value: String(id), selected: pick.researcher === id }, `${ctx.nameOf(id)}${slow.has(id) ? ' (clerk)' : ''}`)));
      s.addEventListener('change', () => { pick.researcher = Number(s.value); });
      return s;
    })()),
    h('label', null, h('span.mu-small', null, 'Where'), (() => {
      const s = h<HTMLSelectElement>('select.mu-input', null, h('option', { value: '-1', selected: pick.building === -1 }, 'The best place'),
        o.places.slice(0, 40).map((id) => h('option', { value: String(id), selected: pick.building === id }, place(id))));
      s.addEventListener('change', () => { pick.building = Number(s.value); });
      return s;
    })())) : null;

  const start = (buy: boolean): void => {
    const r = realm.startResearch(me, o.tech, pick.researcher, pick.building, buy ? { buy: true } : undefined);
    env.done(r, buy ? `${o.name}: the goods are ordered and the work begins.` : `Work begins on ${o.name}.`);
  };
  const buttons: HTMLElement[] = [];
  if (may.realm) {
    if (choice.mode === 'start') buttons.push(button('Start', { variant: 'primary', icon: 'play', onClick: () => start(false) }));
    else if (choice.mode === 'buy') buttons.push(button(`Buy the rest and start · ${money(choice.buyCost ?? 0)}`, { variant: 'primary', icon: 'coin', tip: 'The goods you lack are bought at the nearest market and carted in; the work waits for them', onClick: () => start(true) }));
    else buttons.push(button('Start', { variant: 'primary', icon: 'play', disabled: true, tip: choice.reason }));
    buttons.push(button(open ? 'Hide' : 'Who and where', { size: 'small', icon: 'user', onClick: () => { bag.open[o.tech] = !open; env.refresh(); } }));
  } else buttons.push(h('span.mu-tiny.mu-dim', null, 'Only the holder commands research.'));

  const card = h('div.mu-card.mu-rul-opt', { class: choice.mode === 'no' ? 'locked' : '' },
    h('div.mu-row.mu-between.mu-top', null, h('h4', null, o.name), chip(`${o.days ?? o.cost.days} days`, '', 'hourglass', 'The days of a capable researcher’s work (a year is 16 days)')),
    h('div.mu-small.mu-ink2', null, DESC.get(o.tech) ?? ''),
    h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '8px 0 4px' } }, cost.filter((c) => c.kind !== 'days').map((c) => {
      if (c.kind === 'pence') return h('span.mu-good-line', null, icon('coin', 15), h('span', null, money(c.qty)));
      const short = (c.short ?? 0) > 0;
      return h('span.mu-good-line', { class: short ? 'short' : 'have', tip: short ? `${Math.ceil(c.short ?? 0)} short in your stores` : 'In your stores' }, goodIcon(ctx.eco, c.good ?? ''), h('span', null, env.describe(c.good ?? '', c.qty)));
    })),
    h('div.mu-tiny.mu-dim', null, icon('user', 12), ` ${who}`),
    h('div.mu-tiny.mu-dim', null, icon('pin', 12), ` ${where}`),
    choice.reason && choice.mode !== 'start' ? h('div.mu-small.mu-bad', { style: { marginTop: '4px' } }, choice.reason) : null,
    picker,
    h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '10px' } }, ...buttons));
  void replace;
  return card;
}
