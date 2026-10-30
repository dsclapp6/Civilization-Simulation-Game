// Death and game over: the life story, the successor chooser, and the final tally.
import { RANK_NAMES, type RankTier } from '../../core/domain';
import { toDate, SEASON_NAMES } from '../../core/time';
import { runCard } from '../../sim/api';
import { append, h } from '../core/dom';
import { chronicleDate, plural, thousands, trim } from '../core/format';
import { icon } from '../core/icons';
import { STAT_ICON } from '../core/iconMap';
import { lifeStory, successorCard, type SuccessorCard } from '../core/models';
import { STAT_INFO } from '../core/text';
import { button, chip, heading } from '../components/widgets';
import { createWindow } from '../components/window';
import type { SimEvents } from '../../sim/events';
import type { PanelCtx, UiHooks, UiPanel } from '../app/panel';
import { panelOf } from './base';

export function successorEl(c: SuccessorCard, selected: boolean, onPick: () => void): HTMLElement {
  const el = h('div.mu-card.click.mu-succ', { class: selected ? 'sel' : '', role: 'radio', 'aria-checked': String(selected), tabindex: '0' },
    h('div.mu-row.mu-between.mu-top', null,
      h('div', null, h('h4', null, c.name), h('div.mu-dim.mu-small', null, `${c.relation ? `Your ${c.relation}` : 'Of your House'} · ${c.age} years old`)),
      selected ? h('span.mu-tier-check.static', null, icon('check', 16)) : null),
    h('div.mu-row.mu-wrap.mu-gap-4', null,
      chip(c.rankName, 'gold', 'shield'), chip(c.career, '', 'hammer'), chip(c.settlement, '', 'pin'),
      c.isChild ? chip('A child', 'vermilion', 'warning', 'Too young to work for the family yet') : null),
    h('div.mu-row.mu-gap-12.mu-small', null, c.top.map((s) =>
      h('span.mu-row.mu-gap-4', { tip: STAT_INFO[s.id].affects }, icon(STAT_ICON[s.id], 15), `${STAT_INFO[s.id].name} `, h('b', null, trim(s.value, 0))))),
  );
  el.addEventListener('click', onPick);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } });
  return el;
}

export function deathPanel(ctx: PanelCtx, hooks: UiHooks): UiPanel {
  const st = ctx.sim.state;
  const run = st.run;
  const pending = run.pendingSuccession;
  const last = run.lives[run.lives.length - 1];
  const deceasedId = pending?.person ?? last?.person ?? run.playerId;
  const deceased = st.persons.get(deceasedId) ?? null;
  const story = lifeStory(ctx.sim, deceasedId, run.lives.length);
  const eligible = (pending?.eligible ?? []).map((id) => successorCard(ctx.sim, deceased, id)).filter((c): c is SuccessorCard => !!c);

  const day = deceased?.death?.day ?? last?.deathDay ?? ctx.sim.absDay;
  const d = toDate(day);
  const win = createWindow({
    title: story ? `${story.first} has died` : 'A life ends', subtitle: `${SEASON_NAMES[d.season]} ${d.dayOfSeason}, Year ${d.year}`, icon: 'skull', size: 'xl',
  });

  const left = h('div.mu-death-left', null);
  if (story) {
    append(left,
      h('div.mu-birth-name', null, story.name),
      h('div.mu-birth-headline', null, `${story.ageAtDeath} years old · ${story.career || story.rankName}${story.place ? ` · ${story.place}` : ''}`),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '8px 0 10px' } },
        chip(story.rankName, 'gold', 'crown', 'Rank at death'),
        chip(`Died ${story.causeText}`, 'vermilion', 'skull'),
        story.spouse ? chip(`Wed to ${story.spouse.name}`, '', 'ring') : null,
        story.children.length ? chip(plural(story.children.length, 'child', 'children'), '', 'users') : null,
        chip(`${thousands(story.score)} points`, 'gold', 'star_f'),
      ),
      h('div.mu-prose', null, story.paragraphs.map((p, i) => h('p', { class: i === 0 ? 'mu-dropcap' : '' }, p))),
      story.deeds.length ? h('div', { style: { marginTop: '12px' } }, heading('The chronicle remembers', 'scroll'),
        h('ul.mu-deeds', null, story.deeds.slice(-5).map((t) => h('li', null, icon('dot', 8), t)))) : null,
    );
  }

  const gameOverNext = eligible.length === 0;
  let chosen: SuccessorCard | null = null;
  const confirmBtn = button('Choose who to be', { variant: 'primary', size: 'big', icon: 'user', disabled: true });
  const list = h('div.mu-col.mu-gap-8.mu-scroll.mu-succ-list');
  const setChosen = (c: SuccessorCard): void => {
    chosen = c;
    confirmBtn.disabled = false;
    confirmBtn.replaceChildren(icon('user', 20), h('span', null, `Carry on as ${c.name.split(' ')[0]}`));
    render();
  };
  const render = (): void => { list.replaceChildren(...eligible.map((c) => successorEl(c, chosen?.id === c.id, () => setChosen(c)))); };
  render();
  // the eldest able adult is the natural first choice: preselect when there is exactly one
  if (eligible.length === 1) setChosen(eligible[0]);

  const right = h('div.mu-death-right', null,
    heading('Who will you be?', 'users'),
    gameOverNext
      ? h('div.mu-card.mu-succ-none', null, icon('crown', 22), h('p', null, 'No one is left to carry on your House.'), h('p.mu-dim.mu-small', null, 'Your story ends here. The score is counted and the Legacy gold you earned is kept.'))
      : h('p.mu-small.mu-ink2', { style: { marginBottom: '8px' } }, 'Choose a living member of your family, or someone of your House of equal rank. The one you leave goes on with their life, run by the world.'),
    gameOverNext ? null : list,
  );

  win.body.append(h('div.mu-death', null, left, right));
  confirmBtn.addEventListener('click', () => {
    if (!chosen) return;
    const r = ctx.dispatch({ type: 'switchCharacter', personId: chosen.id });
    if (!r.ok) ctx.say('warn', r.reason ?? 'That cannot be done.');
  });
  win.showFoot(
    h('span.mu-dim.mu-small.mu-ital', null, gameOverNext ? 'Every run ends. What you earned stays.' : `${plural(eligible.length, 'person', 'people')} may take up your life.`),
    h('div.mu-grow'),
    gameOverNext
      ? button('Continue', { variant: 'primary', size: 'big', icon: 'chev_right', onClick: () => ctx.open({ panel: 'gameover', summary: hooks.pendingGameOver() ?? undefined }) })
      : confirmBtn,
  );
  return panelOf({ id: 'death', group: 'screen', pauses: 'always', escape: 'ignore', mode: 'screen', hidesHud: true }, win.el, {
    key: (intent) => {
      if (intent.type === 'digit' && eligible[intent.n - 1]) { setChosen(eligible[intent.n - 1]); return true; }
      if (intent.type === 'enter' && chosen) { confirmBtn.click(); return true; }
      return false;
    },
  });
}

export function gameOverPanel(ctx: PanelCtx, hooks: UiHooks, summary: SimEvents['gameOver'] | undefined): UiPanel {
  const card = runCard(ctx.sim);
  const score = summary?.score ?? card.score;
  const best = summary?.bestScore ?? card.bestScore;
  const pctNow = card.continentPct;
  const bestPct = summary?.bestContinentPct ?? card.bestContinentPct;
  const gold = summary?.legacyGold ?? card.legacyGold;
  const reason = summary?.reason ?? ctx.sim.state.run.endedReason ?? 'extinct';
  const record = score >= best && score > 0;
  const win = createWindow({ title: reason === 'extinct' ? 'Your House has fallen' : 'The run is over', subtitle: reason === 'extinct' ? 'No one is left to carry on' : 'You walked away', icon: 'crown', size: 'md' });

  const row = (label: string, value: string, note?: string, gold_ = false): HTMLElement =>
    h('div.mu-over-row', null, h('span', null, label), h('b.mu-num', { class: gold_ ? 'mu-gold' : '' }, value), h('span.mu-dim.mu-small', null, note ?? ''));

  win.body.append(
    h('div.mu-over-score', null,
      h('div.mu-over-label', null, 'Final score'),
      h('div.mu-over-num', null, thousands(score)),
      record ? chip('A new best!', 'gold', 'star_f') : h('div.mu-dim.mu-small', null, `Best: ${thousands(best)}`)),
    h('div.mu-rule'),
    h('div.mu-over-rows', null,
      row('Continent ruled', `${trim(pctNow, 1)}%`, `best ${trim(bestPct, 1)}%`),
      row('Legacy gold earned this run', thousands(card.goldThisRun), '', true),
      row('Legacy gold in all', thousands(gold), 'kept for your next birth', true),
      row('Lives lived', thousands(card.lives), card.switches ? plural(card.switches, 'switch', 'switches') : ''),
      row('Years played', thousands(card.yearsPlayed), `to Year ${card.year}`),
      row('Highest station', RANK_NAMES[Math.max(card.maxTier, 1) as RankTier], chronicleDate(ctx.sim.absDay)),
    ),
  );
  win.showFoot(
    button('Main menu', { icon: 'door', onClick: () => hooks.quitToMenu() }),
    h('div.mu-grow'),
    button('New run', { variant: 'primary', size: 'big', icon: 'sparkle', onClick: () => hooks.newRun() }),
  );
  return panelOf({ id: 'gameover', group: 'screen', pauses: 'always', escape: 'ignore', mode: 'screen', hidesHud: true }, win.el, {
    key: (intent) => { if (intent.type === 'enter') { hooks.newRun(); return true; } return false; },
  });
}
