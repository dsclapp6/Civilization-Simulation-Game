// "You are born …": the reveal shown at the start of a run. Who you are, where, to whom, with what
// stats, what life holds for your class, and what your points are multiplied by.
import { STAT_CAP } from '../../core/domain';
import { h } from '../core/dom';
import { dateText, trim } from '../core/format';
import { icon } from '../core/icons';
import { STAT_ICON } from '../core/iconMap';
import { birthModel, type BirthModel, type KinLine } from '../core/models';
import { STAT_INFO } from '../core/text';
import { button, chip, heading, statBar } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';

function kinRow(k: KinLine): HTMLElement {
  return h('li.mu-kin-row', { class: k.alive ? '' : 'dead' },
    h('span.mu-kin-name', null, k.name),
    h('span.mu-dim.mu-small', null, `${k.relation}${k.alive ? '' : ' (deceased)'}`),
    h('span.mu-kin-age.mu-num', null, `${k.age}`),
    h('span.mu-dim.mu-small.mu-trunc', null, k.occupation));
}

export function birthPanel(ctx: PanelCtx): UiPanel {
  const m: BirthModel | null = birthModel(ctx.sim);
  const win = createWindow({ title: 'You are born…', subtitle: m ? dateText(ctx.sim.absDay) : '', icon: 'crown', size: 'xl' });
  if (!m) {
    win.body.append(h('p.mu-empty', null, 'No one is born yet.'));
    win.showFoot(h('div.mu-grow'), button('Close', { onClick: () => ctx.close() }));
    return panelOf({ id: 'birth', group: 'screen', pauses: 'always', escape: 'close', mode: 'screen', hidesHud: true }, win.el);
  }

  const stats = h('div.mu-birth-stats', null, m.stats.map((s) =>
    h('div.mu-birth-stat', { tip: `${STAT_INFO[s.id].affects}\nPotential ${s.potential}${s.ranks ? ` (including ${s.ranks} bought rank${s.ranks > 1 ? 's' : ''})` : ''}; the cap is ${STAT_CAP}.` },
      h('span.mu-birth-stat-ico', null, icon(STAT_ICON[s.id], 18)),
      h('span.mu-birth-stat-name', null, STAT_INFO[s.id].name),
      statBar(s.value, s.potential),
      h('span.mu-birth-stat-val.mu-num', null, h('b', null, trim(s.value, 1)), h('span.mu-dim', null, ` / ${s.potential}`)),
      s.ranks > 0 ? chip(`+${s.ranks}`, 'gold', 'coin', 'Ranks bought with Legacy gold') : h('span')),
  ));

  const family = h('div.mu-col.mu-gap-6', null,
    m.parents.length ? h('ul.mu-kin', null, m.parents.map(kinRow)) : h('p.mu-dim.mu-small.mu-ital', null, 'Your parents are long dead or unknown.'),
    m.siblings.length ? h('ul.mu-kin', null, m.siblings.slice(0, 5).map(kinRow)) : h('p.mu-dim.mu-small.mu-ital', null, 'You have no brothers or sisters.'),
    m.siblings.length > 5 ? h('div.mu-dim.mu-small', null, `…and ${m.siblings.length - 5} more`) : null,
  );

  const left = h('div.mu-birth-left', null,
    h('div.mu-reveal', { style: { '--i': 0 } }, h('div.mu-birth-name', null, m.name),
      h('div.mu-birth-headline', null, `${m.age === 12 ? 'A twelve-year-old' : `A ${m.age}-year-old`} ${m.sex === 'm' ? 'boy' : 'girl'}, ${m.headline}`)),
    h('div.mu-row.mu-wrap.mu-gap-6.mu-reveal', { style: { '--i': 1 } },
      chip(m.rank.name, 'gold', 'shield'), chip(`Aged ${m.age}`, '', 'calendar'), m.rank.career !== 'Child' ? chip(m.rank.career, '', 'hammer') : null,
      chip(m.settlement.kind, '', 'pin'), m.settlement.lord ? chip(`Lord: ${m.settlement.lord}`, '', 'crown') : null),
    h('p.mu-prose.mu-dropcap.mu-birth-life.mu-reveal', { style: { '--i': 2 } }, m.life),
    h('div.mu-birth-mult.mu-reveal', { style: { '--i': 3 } },
      h('div.mu-birth-mult-big', null, icon('star_f', 18), `Points ×${trim(m.multiplier.total, 2)}`),
      h('div.mu-small.mu-ink2', null,
        `${m.className} birth ×${trim(m.multiplier.birth, 2)} · ${m.multiplier.difficultyName[0].toUpperCase()}${m.multiplier.difficultyName.slice(1)} ×${trim(m.multiplier.difficulty, 2)}. `,
        'Harder births earn more; every point becomes Legacy gold, one for each ten.')),
  );

  const right = h('div.mu-birth-right', null,
    h('div.mu-reveal', { style: { '--i': 1 } }, heading('Your nature', 'sparkle', m.ranksBought ? chip(`${m.ranksBought} ranks bought`, 'gold') : null), stats,
      h('div.mu-tiny.mu-dim', null, `Bars show your strength now and, pale, the potential it can grow toward (cap ${STAT_CAP}).`)),
    h('div.mu-reveal', { style: { '--i': 2 } }, heading('Your family', 'users'), family),
    h('div.mu-reveal', { style: { '--i': 3 } }, heading('Your household', 'home'),
      h('p.mu-small', null,
        `${m.household.size} ${m.household.size === 1 ? 'soul lives' : 'souls live'} under one roof, in ${m.household.home}`,
        m.household.headName ? `, headed by ${m.household.headRelation === 'yourself' ? 'you' : `your ${m.household.headRelation}, ${m.household.headName}`}` : '', '. ',
        `${m.settlement.name} is a ${m.settlement.kind} of about ${m.settlement.population} people${m.settlement.county ? `, in ${m.settlement.county}` : ''}.`)),
  );

  win.body.append(h('div.mu-birth', null, left, right));
  win.showFoot(
    h('span.mu-dim.mu-small.mu-ital', null, 'You begin at twelve, with your family, your hands and your name.'),
    h('div.mu-grow'),
    button('Begin your life', { variant: 'primary', size: 'big', icon: 'play', onClick: () => ctx.close() }),
  );
  return panelOf({ id: 'birth', group: 'screen', pauses: 'always', escape: 'ignore', mode: 'screen', hidesHud: true }, win.el, {
    key: (intent) => { if (intent.type === 'enter') { ctx.close(); return true; } return false; },
  });
}
