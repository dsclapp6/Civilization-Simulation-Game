// The day summary card: when the player sleeps (or the day ends) the objectives module has written up the day — the
// work done, what came in and went out, the skills and strength gained, the tasks finished, how the household fared and
// what tomorrow holds. This is the visible answer to "did my work matter?".
import { SEASON_NAMES, toDate } from '../../core/time';
import type { DaySummary } from '../../sim/objectives/types';
import { formatMoney } from '../../sim/money';
import { h } from '../core/dom';
import { plural, signed, trim } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { summaryIsEmpty } from '../core/objectiveModel';
import { button } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';

export function summaryCard(s: DaySummary): HTMLElement {
  const sec = (ico: IconName, title: string, body: Array<HTMLElement | null>, cls = ''): HTMLElement =>
    h('section.mu-day-sec', { class: cls }, h('h4', null, icon(ico, 15), title), ...body);
  const line = (text: string, good = false): HTMLElement => h('div.mu-day-line', { class: good ? 'good' : '' }, icon(good ? 'check' : 'dot', good ? 14 : 8), h('span', null, text));
  if (summaryIsEmpty(s)) {
    return h('div.mu-day-empty', null, h('p.mu-ital.mu-dim', null, 'A quiet day: no real work was done, nothing earned, nothing learned. Tomorrow is another.'),
      s.household.length || s.tomorrow.length ? h('div.mu-day-grid', null,
        s.household.length ? sec('home', 'At home', s.household.map((t) => line(t))) : null,
        s.tomorrow.length ? sec('sunrise', 'Tomorrow', s.tomorrow.map((t) => line(t)), 'gold') : null) : null);
  }
  const purse: HTMLElement[] = [];
  if (s.earned) purse.push(h('div.mu-day-line.gain', null, icon('coin', 14), h('span', null, `Earned ${formatMoney(s.earned)}`)));
  if (s.spent) purse.push(h('div.mu-day-line.loss', null, icon('purse', 14), h('span', null, `Spent ${formatMoney(s.spent)}`)));
  for (const g of s.goods) purse.push(h('div.mu-day-line', null, icon('box', 14), h('span', null, `${g.amount > 0 ? '+' : ''}${g.amount} ${g.label}`)));
  const grow: HTMLElement[] = [];
  for (const k of s.skills) grow.push(h('div.mu-day-line', null, icon('star', 14), h('span', null, `${k.skill} +${trim(k.xp, 0)}`, k.level !== undefined ? h('span.mu-dim', null, ` (level ${k.level})`) : null)));
  for (const k of s.stats) grow.push(h('div.mu-day-line', null, icon('bolt', 14), h('span', null, `${k.stat} ${trim(k.from, 1)} to ${trim(k.to, 1)} `, h('span.mu-good', null, `(${signed(k.to - k.from, 1)})`))));
  return h('div.mu-day-grid', null,
    s.work.length ? sec('hammer', 'Work', s.work.map((t) => line(t))) : null,
    purse.length ? sec('coin', 'Purse and goods', purse) : null,
    grow.length ? sec('sparkle', 'You grew', grow) : null,
    s.objectivesDone.length ? sec('flag', plural(s.objectivesDone.length, 'task') + ' finished', s.objectivesDone.map((t) => line(t, true))) : null,
    s.household.length ? sec('home', 'At home', s.household.map((t) => line(t))) : null,
    s.tomorrow.length ? sec('sunrise', 'Tomorrow', s.tomorrow.map((t) => line(t)), 'gold') : null);
}

export function daySummaryPanel(ctx: PanelCtx, day: number | undefined): UiPanel {
  const s = ctx.game.objectives?.daySummary(day) ?? null;
  const d = toDate(s ? s.day : ctx.sim.absDay - 1);
  const win = createWindow({
    title: s ? `Day ${d.dayOfSeason} of ${SEASON_NAMES[d.season]}` : 'The day', subtitle: s ? 'What you did, and what comes next' : '', icon: 'sunrise', size: 'md', tall: false,
    onClose: () => ctx.close(),
  });
  win.el.classList.add('mu-day-win');
  win.body.append(s ? summaryCard(s) : h('p.mu-dim.mu-ital', null, 'No day has been written up yet. Sleep at home, and the day is summed up when you wake.'));
  win.showFoot(h('span.mu-small.mu-dim', null, 'The journal (O) keeps what is still to do.'), h('div.mu-grow'),
    button('Begin the new day', { variant: 'primary', size: 'big', icon: 'sun', onClick: () => ctx.close() }));
  return panelOf({ id: 'daysummary', group: 'screen', pauses: 'always', backdropCloses: ctx }, win.el, {
    key: (intent) => { if (intent.type === 'enter') { ctx.close(); return true; } return false; },
  });
}
