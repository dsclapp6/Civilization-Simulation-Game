// The journal (O): everything you are meant to be doing and everything you might want to find, in four tabs —
// Objectives (the tracked task, the others, their steps; Track), Today (what kind of day it is, the family's plan,
// what is open), People you know (kin, household, work, the lord; where they are now; Find) and Places (home, the
// strips, the church, the market, the smithy…; Find). "Find" puts the person or place on the compass, the minimap
// and the screen edge.
import { h, replace } from '../core/dom';
import { distanceText, plural } from '../core/format';
import { icon } from '../core/icons';
import { where } from '../core/nav';
import {
  PERSON_GROUPS, peopleRows, placeRows, todayModel, type PersonRow, type PlaceRow,
} from '../core/journalModel';
import {
  SOURCE_ICON, SOURCE_LABEL, currentStepIndex, dueLine, groupObjectives, objectiveSignature, progressFraction, progressText, sourceLine,
} from '../core/objectiveModel';
import type { JournalTab } from '../core/requests';
import { tabKeys } from '../core/tabkeys';
import { bar, button, empty, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { Objective } from '../../sim/objectives/types';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';

const TABS: ReadonlyArray<{ id: JournalTab; label: string; icon: 'scroll' | 'sun' | 'users' | 'pin' }> = [
  { id: 'objectives', label: 'Tasks', icon: 'scroll' },
  { id: 'today', label: 'Today', icon: 'sun' },
  { id: 'people', label: 'People you know', icon: 'users' },
  { id: 'places', label: 'Places', icon: 'pin' },
];

export function journalPanel(ctx: PanelCtx, start: JournalTab | undefined): UiPanel {
  const game = ctx.game;
  const api = game.objectives;
  const me = ctx.playerId;
  const win = createWindow({ title: 'Journal', subtitle: 'What to do, and where to find it', icon: 'scroll', size: 'xl', tall: true, onClose: () => ctx.close() });
  let tab: JournalTab = start ?? 'objectives';
  let selected = -1;
  const content = h('div.mu-journal-body');
  const t = tabs(TABS, tab, (id) => select(id as JournalTab));
  win.body.classList.add('flush');
  win.body.append(t.el, h('div.mu-tabbar-rule'), content);

  const dist = (x: number, z: number): string => {
    const b = ctx.player.body();
    return b ? where(b.x, b.z, x, z) : '';
  };

  // ---------------------------------------------------------------------------------------- Tasks

  const objectivesView = (): HTMLElement => {
    const list = api ? api.list() : [];
    if (!api || list.length === 0) {
      return h('div.mu-journal-empty', null, empty('Nothing has been asked of you yet. Talk to your family, walk about the village, see what the day needs.', { icon: 'scroll', title: 'No tasks' }));
    }
    const g = groupObjectives(list);
    const pick = list.find((o) => o.id === selected) ?? g.tracked ?? g.groups[0]?.items[0] ?? g.done[0];
    if (pick) selected = pick.id;
    const rows: HTMLElement[] = [];
    const row = (o: Objective, tracked: boolean): HTMLElement => {
      const frac = o.steps.length ? o.steps.filter((s) => s.done).length / o.steps.length : 0;
      return h('button.mu-jrow', { type: 'button', class: `${o.id === selected ? 'sel' : ''} ${o.state !== 'active' ? 'done' : ''}`, onclick: () => { selected = o.id; render(); } },
        h('span.mu-jrow-ico', null, icon(o.state === 'done' ? 'check' : o.state === 'active' ? SOURCE_ICON[o.source] : 'cross', 15)),
        h('span.mu-jrow-main', null, h('span.mu-jrow-title', null, o.title), h('span.mu-jrow-sub', null, sourceLine(o, ctx.nameOf), tracked ? ' · tracked' : '')),
        o.state === 'active' ? h('span.mu-jrow-bar', null, bar('gold', frac, { slim: true }).el) : null);
    };
    if (g.tracked) { rows.push(h('div.mu-jhead', null, icon('flag', 14), 'Tracked')); rows.push(row(g.tracked, true)); }
    for (const grp of g.groups) { rows.push(h('div.mu-jhead', null, icon(SOURCE_ICON[grp.source], 14), grp.label)); for (const o of grp.items) rows.push(row(o, false)); }
    if (g.done.length) { rows.push(h('div.mu-jhead', null, icon('check', 14), 'Finished')); for (const o of g.done.slice(0, 8)) rows.push(row(o, false)); }
    return h('div.mu-journal-split', null, h('div.mu-journal-list.mu-scroll', null, rows), h('div.mu-journal-detail.mu-scroll', null, pick ? detail(pick) : null));
  };

  const detail = (o: Objective): HTMLElement => {
    const cur = currentStepIndex(o);
    const steps = o.steps.map((s, i) => {
      const state = s.done ? 'done' : i === cur && o.state === 'active' ? 'now' : 'todo';
      const frac = progressFraction(s);
      return h('li.mu-jstep', { class: state },
        h('span.mu-jstep-mark', null, icon(state === 'done' ? 'check' : state === 'now' ? 'chev_right' : 'circle_o', 15)),
        h('div.mu-jstep-main', null,
          h('div.mu-jstep-text', null, s.text, progressText(s) && !s.done ? h('span.mu-dim', null, ` (${progressText(s)})`) : null),
          state === 'now' && s.hint ? h('div.mu-jstep-hint', null, s.hint) : null,
          state === 'now' && frac !== null ? bar('gold', frac, { thin: true }).el : null,
          state !== 'done' && s.target ? h('div.mu-jstep-where', null, icon('pin', 12), `${s.target.label}, ${dist(s.target.x, s.target.z)}`,
            h('button.mu-link', { type: 'button', onclick: () => find(s.target!.x, s.target!.z, s.target!.label) }, 'Show me')) : null));
    });
    const due = dueLine(o, ctx.sim.absDay);
    return h('div.mu-jdetail', null,
      h('div.mu-jdetail-src', null, icon(SOURCE_ICON[o.source], 15), sourceLine(o, ctx.nameOf)),
      h('h3.mu-jdetail-title', null, o.title),
      h('p.mu-jdetail-why', null, o.why),
      h('ol.mu-jsteps', null, steps),
      o.reward || due ? h('div.mu-jdetail-reward', null, o.reward ? [icon('star', 14), `Reward: ${o.reward}`] : null, due ? h('span.mu-dim', null, ` · ${due}`) : null) : null,
      h('div.mu-row.mu-gap-6', { style: { marginTop: '12px' } },
        o.state === 'active' ? (o.tracked
          ? button('Tracked', { size: 'small', icon: 'flag', variant: 'on', disabled: true })
          : button('Track this task', { size: 'small', icon: 'flag', variant: 'primary', onClick: () => { api?.track(o.id); ctx.say('quest', `Now tracking: ${o.title}.`); render(); } })) : null));
  };

  // ---------------------------------------------------------------------------------------- Today

  const todayView = (): HTMLElement => {
    const m = todayModel(game, me());
    if (!m) return h('div.mu-journal-empty', null, empty('There is no day to describe.'));
    return h('div.mu-journal-today.mu-scroll', null,
      h('div.mu-today-hero', null,
        h('div.mu-today-date', null, m.dateLine),
        h('h3.mu-today-head', null, m.headline),
        h('p.mu-today-blurb', null, m.blurb),
        h('div.mu-today-sun', null, icon('sunrise', 15), `Sunrise ${m.sunrise}`, h('span.mu-dim', null, ' · '), icon('moon', 14), `Sunset ${m.sunset}`)),
      h('div.mu-today-grid', null,
        card('The family’s plan', 'home', m.plan.length
          ? m.plan.map((p) => h('div.mu-today-row', null, h('b', null, p.name), p.head ? h('span.mu-chip.gold', null, 'head') : null, h('span.mu-grow'), h('span', null, p.task), p.set ? h('span.mu-dim.mu-tiny', null, ' (set)') : null))
          : [h('p.mu-dim.mu-small.mu-ital', null, 'Nobody has been given a task yet.')]),
        card('Your strips', 'farming', m.strips.length
          ? m.strips.map((s) => h('div.mu-today-row.col', null,
            h('div.mu-row.mu-between', null, h('b', null, s.label), h('button.mu-link.mu-small', { type: 'button', onclick: () => find(s.x, s.z, s.label) }, 'Show me')),
            h('div.mu-small.mu-ink2', null, s.note),
            s.work > 0 && s.work < 1 ? bar('gold', s.work, { slim: true }).el : null))
          : [h('p.mu-dim.mu-small.mu-ital', null, 'Your household holds no strips.')]),
        card('What is open', 'market', m.open.map((o) => h('div.mu-today-row', null, icon(o.icon, 15), h('b', null, o.label), h('span.mu-grow'), h('span', { class: o.good ? 'mu-good' : 'mu-dim' }, o.value)))),
        card('Due soon', 'ledger', m.dues.length
          ? m.dues.map((d) => h('div.mu-today-row', null, h('span', null, d.label), h('span.mu-grow'), h('span', { class: d.overdue ? 'mu-bad' : 'mu-dim' }, d.when)))
          : [h('p.mu-dim.mu-small.mu-ital', null, 'Nothing is owed just now.')])));
  };

  const card = (title: string, ico: Parameters<typeof icon>[0], body: HTMLElement[]): HTMLElement =>
    h('section.mu-card.mu-today-card', null, h('h4', null, icon(ico, 16), title), ...body);

  // ---------------------------------------------------------------------------------------- People and places

  const find = (x: number, z: number, label: string): void => {
    ctx.pins.set({ x, z, label });
    ctx.say('info', `${label}: ${dist(x, z)}. Look for the marker on the compass and the minimap.`);
    render();
  };

  const findPerson = (r: PersonRow): void => {
    if (game.objectives) { game.objectives.trackPerson(r.id); ctx.say('info', `Looking for ${r.name}: watch the compass.`); }
    if (r.x !== null && r.z !== null) ctx.pins.set({ x: r.x, z: r.z, label: r.name });
    else ctx.say('warn', `${r.name} is not near enough to find: ${r.where}.`);
    render();
  };

  const peopleView = (): HTMLElement => {
    const rows = peopleRows(game, me());
    if (!rows.length) return h('div.mu-journal-empty', null, empty('You do not know anyone yet.', { icon: 'users', title: 'No acquaintances' }));
    const out: HTMLElement[] = [];
    for (const grp of PERSON_GROUPS) {
      const mine = rows.filter((r) => r.group === grp.id);
      if (!mine.length) continue;
      out.push(h('div.mu-jhead.wide', null, grp.label));
      for (const r of mine) {
        out.push(h('div.mu-prow', null,
          h('div.mu-prow-main', null,
            h('div.mu-prow-name', null, h('b', null, r.name), h('span.mu-dim', null, ` · ${r.relation || 'known to you'}`)),
            h('div.mu-prow-sub', null, [r.role ? `${r.role}, ${plural(r.age, 'year')}` : plural(r.age, 'year'), r.where].filter(Boolean).join(' · '))),
          button('Find', { size: 'small', icon: 'pin', onClick: () => findPerson(r) })));
      }
    }
    return h('div.mu-journal-people.mu-scroll', null, out);
  };

  const placesView = (): HTMLElement => {
    const rows = placeRows(game, me());
    if (!rows.length) return h('div.mu-journal-empty', null, empty('You do not know the places hereabouts yet.', { icon: 'pin', title: 'No places' }));
    const out: HTMLElement[] = [];
    const section = (title: string, items: PlaceRow[]): void => {
      if (!items.length) return;
      out.push(h('div.mu-jhead.wide', null, title));
      for (const r of items) {
        out.push(h('div.mu-prow', null,
          h('span.mu-prow-ico', null, icon(r.icon, 18)),
          h('div.mu-prow-main', null, h('div.mu-prow-name', null, h('b', null, r.name)), h('div.mu-prow-sub', null, `${r.sub} · ${dist(r.x, r.z)}`)),
          button('Find', { size: 'small', icon: 'pin', onClick: () => find(r.x, r.z, r.name) })));
      }
    };
    section('Yours', rows.filter((r) => r.group === 'yours'));
    section('In the village', rows.filter((r) => r.group === 'village'));
    return h('div.mu-journal-people.mu-scroll', null, out);
  };

  // ---------------------------------------------------------------------------------------- frame

  let lastSig = '';
  let lastText = '';
  /** Draws the open page. Unless `force`d it leaves the page alone when nothing it says has changed, so a click is never lost to a redraw. */
  const render = (force = true): void => {
    t.set(tab);
    const open = ctx.pins.get();
    const body = tab === 'objectives' ? objectivesView() : tab === 'today' ? todayView() : tab === 'people' ? peopleView() : placesView();
    const pinned = open ? h('div.mu-journal-pin', null, icon('pin', 14), `Showing: ${open.label} (${distanceText(Math.hypot(open.x - (ctx.player.body()?.x ?? 0), open.z - (ctx.player.body()?.z ?? 0)))})`,
      h('button.mu-link', { type: 'button', onclick: () => { ctx.pins.set(null); render(); } }, 'Stop showing')) : null;
    const text = `${tab}|${body.textContent}|${pinned?.textContent ?? ''}`;
    if (!force && text === lastText) return;
    lastText = text;
    // keep the scroll positions of the lists across a redraw
    const tops = [...content.querySelectorAll<HTMLElement>('.mu-scroll')].map((e) => e.scrollTop);
    replace(content, body, pinned);
    const scrollers = [...content.querySelectorAll<HTMLElement>('.mu-scroll')];
    scrollers.forEach((e, i) => { if (tops[i]) e.scrollTop = tops[i]; });
  };
  const select = (id: JournalTab): void => { tab = id; lastSig = ''; lastText = ''; render(); };
  render();
  if (api) t.badge('objectives', api.list().filter((o) => o.state === 'active').length);

  win.showFoot(
    h('span.mu-small.mu-dim', null, 'O opens and closes the journal · ← → switch pages · Y asks what to do now'),
    h('div.mu-grow'),
    button('Close', { variant: 'primary', onClick: () => ctx.close() }));

  let lastRefresh = 0;
  return panelOf({ id: 'journal', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, {
    key: tabKeys(TABS.map((x) => x.id), () => tab, (id) => select(id as JournalTab), { scroller: content }),
    tick: (now) => {
      // the objectives move as events arrive; the lists of people and places as everyone walks about
      const sig = tab === 'objectives' ? (api ? api.list().map(objectiveSignature).join('~') : '') : '';
      if (sig !== lastSig && tab === 'objectives') { lastSig = sig; render(false); return; }
      if (now - lastRefresh > 1.5) { lastRefresh = now; render(false); }
    },
  });
}

void SOURCE_LABEL;
