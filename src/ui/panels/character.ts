// The character sheet (Tab): stats (trained vs potential), skills with XP and perk dots, traits,
// reputation, health and conditions, needs, career and employment, prestige and titles.
import { STATS, STAT_CAP, type SkillId } from '../../core/domain';
import { PERK_LEVELS } from '../../sim/skills';
import { xpForLevel } from '../../sim/people';
import { personCard, type PersonCard } from '../../sim/api';
import { CAREERS, STAGE_LABELS, roleLabel } from '../../sim/careers';
import type { Person } from '../../sim/state';
import { h } from '../core/dom';
import { formatMoney, pct, plural, relativeDay, signed, thousands, trim } from '../core/format';
import { icon } from '../core/icons';
import { SKILL_ICON, STAT_ICON } from '../core/iconMap';
import { needViews } from '../core/hudModel';
import { CONDITIONS, SKILL_GROUPS, SKILL_NAMES, STAT_INFO, TRAITS } from '../core/text';
import { bar, button, chip, empty, heading, statBar } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { every, panelOf } from './base';

const REP_FACETS: ReadonlyArray<{ id: keyof Person['rep']; name: string; high: string; low: string; icon: Parameters<typeof icon>[0] }> = [
  { id: 'honour', name: 'Honour', high: 'honourable', low: 'dishonourable', icon: 'shield' },
  { id: 'generosity', name: 'Generosity', high: 'open-handed', low: 'miserly', icon: 'gift' },
  { id: 'piety', name: 'Piety', high: 'devout', low: 'impious', icon: 'church' },
  { id: 'cruelty', name: 'Mercy', high: 'merciless', low: 'merciful', icon: 'heart_o' },
  { id: 'valour', name: 'Valour', high: 'valiant', low: 'craven', icon: 'swords' },
];

function repWord(facet: (typeof REP_FACETS)[number], v: number): string {
  const a = Math.abs(v);
  if (a < 8) return 'unremarked';
  const word = v > 0 ? facet.high : facet.low;
  return a >= 40 ? `renowned as ${word}` : a >= 20 ? `known as ${word}` : `thought ${word}`;
}

function perkDots(ctx: PanelCtx, person: Person, skill: SkillId, open: number): HTMLElement {
  const chosen = person.perks.filter((id) => id.startsWith(`${skill}.`));
  const wrap = h('span.mu-perkdots');
  PERK_LEVELS.forEach((lv, i) => {
    const has = i < chosen.length;
    const isOpen = !has && i < chosen.length + open;
    const def = has ? ctx.eco.perk(chosen[i]) : undefined;
    const tip = has ? `${def?.name ?? chosen[i]}${def ? `\n${def.description}` : ''}` : isOpen ? 'A perk is waiting: click to choose one of two' : `A perk is chosen at level ${lv}`;
    const dot = h(isOpen ? 'button.mu-perkdot.open' : 'span.mu-perkdot', { class: has ? 'on' : '', tip, type: isOpen ? 'button' : undefined }, icon(has || isOpen ? 'star_f' : 'star', 11));
    if (isOpen) dot.addEventListener('click', () => ctx.open({ panel: 'perk', person: person.id, skill }));
    wrap.appendChild(dot);
  });
  return wrap;
}

function statsSection(card: PersonCard, person: Person): HTMLElement {
  return h('div.mu-char-stats', null, STATS.map((id) => {
    const s = card.stats.find((x) => x.id === id)!;
    const bonus = person.statBonus?.[id] ?? 0;
    const tip = `${STAT_INFO[id].affects}\nPotential ${s.potential} (cap ${STAT_CAP}). Trained ${trim(s.trained, 2)}${bonus > 0 ? `, of which ${trim(bonus, 2)} earned by use` : ''}.\nUse raises it toward potential; neglect lets it slip.`;
    return h('div.mu-char-stat', { tip },
      h('span.mu-char-stat-ico', null, icon(STAT_ICON[id], 18)),
      h('span.mu-char-stat-name', null, STAT_INFO[id].name),
      statBar(s.trained, s.potential),
      h('span.mu-char-stat-val.mu-num', null, h('b', null, trim(s.trained, 1)), h('span.mu-dim', null, ` / ${s.potential}`)));
  }));
}

function skillRow(ctx: PanelCtx, card: PersonCard, person: Person, id: SkillId): HTMLElement {
  const line = card.skills.find((s) => s.id === id)!;
  const base = xpForLevel(line.level);
  const span = Math.max(1, line.nextXp - base);
  const frac = line.level >= 20 ? 1 : (line.xp - base) / span;
  const b = bar('xp', frac, { slim: true });
  return h('div.mu-skill', { class: line.level === 0 ? 'zero' : '', tip: `${SKILL_NAMES[id]}: level ${line.level}\n${line.level >= 20 ? 'Mastered' : `${thousands(line.xp - base)} / ${thousands(span)} experience to level ${line.level + 1}`}` },
    h('span.mu-skill-ico', null, icon(SKILL_ICON[id], 16)),
    h('span.mu-skill-name', null, id === 'brewing' ? 'Brewing' : SKILL_NAMES[id]),
    h('span.mu-skill-lv.mu-num', null, String(line.level)),
    b.el,
    perkDots(ctx, person, id, line.openPerks),
  );
}

export function characterPanel(ctx: PanelCtx): UiPanel {
  const win = createWindow({ title: '', icon: 'user', size: 'xl', onClose: () => ctx.close() });
  const body = h('div.mu-char');
  win.body.append(body);
  let signature = '';

  const render = (): void => {
    const id = ctx.playerId();
    const card = personCard(ctx.sim, id);
    const person = ctx.sim.state.persons.get(id);
    if (!card || !person) { body.replaceChildren(empty('No one to describe.')); return; }
    const hud = ctx.player.hud();
    const now = ctx.sim.absDay;
    const sig = JSON.stringify([card.stats, card.skills.map((s) => [s.level, Math.floor(s.xp / 5), s.openPerks]), person.perks, card.hp, card.needs, person.rep, card.money, card.conditions.length]);
    if (sig === signature) return;
    signature = sig;
    win.setTitle(card.name, `Age ${card.age} · ${card.rankName} · ${roleLabel(person.career, person.careerStage, person.sex)}`);

    // --- left: nature
    const traits = card.traits.length
      ? h('div.mu-row.mu-wrap.mu-gap-6', null, card.traits.map((t) => {
        const info = TRAITS[t];
        return chip(info.name, info.good === true ? 'green' : info.good === false ? 'vermilion' : '', undefined, info.text);
      }))
      : h('p.mu-dim.mu-small.mu-ital', null, 'No marked traits.');

    // Person.health.hp is a 0..1 fraction; the HUD knows the hit-point scale
    const hpFrac = hud && hud.maxHp > 0 ? hud.hp / hud.maxHp : card.hp;
    const hp = bar('hp', hpFrac);
    const conds = card.conditions.length
      ? h('ul.mu-conds', null, card.conditions.map((c) => {
        const info = CONDITIONS[c.id];
        return h('li', { tip: info.text },
          h('b', { class: c.fatal ? 'mu-vermilion' : '' }, info.name),
          h('span.mu-dim.mu-small', null, c.until > now ? ` · ${c.fatal ? 'may end in death' : 'passes'} ${relativeDay(c.until, now)}` : ''));
      }))
      : h('p.mu-small.mu-good', null, 'In good health.');
    const needs = needViews(card.needs).map((n) => {
      const b = bar(n.level === 'ok' ? 'green' : n.level === 'low' ? 'gold' : 'vermilion', n.value, { thin: true });
      return h('div.mu-need-row', { tip: n.hint }, h('span', null, n.label), b.el, h('span.mu-num.mu-small.mu-dim', null, pct(n.value)));
    });

    const left = h('div.mu-char-col', null,
      heading('Nature', 'sparkle'), statsSection(card, person),
      h('div.mu-hair'),
      heading('Traits', 'star'), traits,
      heading('Health', 'heart'),
      h('div.mu-need-row', null, h('span', null, 'Hit points'), hp.el, h('span.mu-num.mu-small', null, hud ? `${Math.ceil(hud.hp)}/${hud.maxHp}` : pct(card.hp))),
      conds, h('div.mu-hair'), h('div.mu-col.mu-gap-4', null, needs));

    // --- middle: skills
    const groups = SKILL_GROUPS.map((g) => h('div.mu-skill-group', null, h('h4', null, g.name), g.skills.map((s) => skillRow(ctx, card, person, s))));
    const perksWaiting = card.skills.reduce((n, s) => n + s.openPerks, 0);
    const mid = h('div.mu-char-col', null,
      heading('Skills', 'hammer', perksWaiting ? chip(`${perksWaiting} perk${perksWaiting > 1 ? 's' : ''} to choose`, 'gold', 'star_f') : null),
      h('div.mu-skill-cols', null, [h('div.mu-col.mu-gap-12', null, groups[0], groups[1]), h('div.mu-col.mu-gap-12', null, groups[2], groups[3])]),
      h('div.mu-tiny.mu-dim', { style: { marginTop: '8px' } }, 'Skills grow by use. At levels 5, 10, 15 and 20 you choose one of two perks.'));

    // --- right: standing
    const rep = h('div.mu-col.mu-gap-6', null, REP_FACETS.map((f) => {
      const v = person.rep[f.id] ?? 0;
      const b = bar(v >= 0 ? 'gold' : 'vermilion', Math.abs(v), { thin: true });
      b.set(Math.abs(v), 50);
      return h('div.mu-rep', { tip: `${f.name}: ${signed(v)}` },
        h('span.mu-rep-name', null, icon(f.icon, 14), f.name),
        h('div.mu-rep-bar', null, h('i.mid'), h('div.mu-rep-fill', { class: v >= 0 ? 'pos' : 'neg', style: { width: `${Math.min(50, (Math.abs(v) / 50) * 50)}%` } })),
        h('span.mu-small.mu-dim.mu-rep-word', null, repWord(f, v)));
    }));

    const job = ctx.eco.employment(id);
    const ladder = STAGE_LABELS[CAREERS[person.career].field] ?? [];
    const work = job
      ? h('div.mu-col.mu-gap-4', null,
        h('div', null, h('b', null, job.title)),
        h('div.mu-small.mu-dim', null, `${job.wage > 0 ? `${formatMoney(job.wage)} a day` : 'Board and lodging, no wage'} · ${job.terms}${job.until >= 0 ? ` · ends ${relativeDay(job.until, now)}` : ''}`),
        h('div.mu-row.mu-gap-6', null, button('Leave the post', { size: 'small', variant: 'danger', onClick: () => { const r = ctx.eco.quitJob(id); ctx.say(r.ok ? 'info' : 'warn', r.ok ? 'You leave your post.' : r.reason ?? 'You cannot leave.'); signature = ''; render(); } })))
      : h('p.mu-small.mu-dim', null, card.career === 'child' ? 'Too young for steady work: help the household, run errands, mind the animals.' : 'You have no steady post.');

    const right = h('div.mu-char-col', null,
      heading('Standing', 'crown'), rep,
      h('div.mu-row.mu-between', { style: { margin: '8px 0 2px' } }, h('span.mu-bold', null, 'Prestige'), h('span.mu-num.mu-gold.mu-bold', null, thousands(card.prestige))),
      card.titles.length ? h('div.mu-col.mu-gap-2', null, card.titles.map((t) => h('div.mu-small', null, icon('crown', 13), ` ${t.name}`))) : null,
      h('div.mu-hair'),
      heading('Work', 'hammer'),
      h('div.mu-small.mu-ink2', { style: { marginBottom: '4px' } }, [card.careerLabel, ladder.length ? ladder[Math.min(card.careerStage, ladder.length - 1)] : ''].filter(Boolean).join(' · ')),
      work,
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '8px' } },
        button('Career paths', { size: 'small', icon: 'signpost', onClick: () => ctx.open({ panel: 'career', person: id }) }),
        button('Jobs here', { size: 'small', icon: 'hammer', onClick: () => ctx.open({ panel: 'jobs', settlement: person.settlement }) })),
      h('div.mu-hair'),
      h('div.mu-row.mu-between.mu-small', null, h('span', null, 'Purse'), h('b.mu-num', null, formatMoney(card.money))),
      h('div.mu-row.mu-between.mu-small', null, h('span', null, 'House'), h('b', null, card.houseName ? `${card.houseName}` : '—')),
      h('div.mu-row.mu-between.mu-small', null, h('span', null, 'Settlement'), h('b', null, card.settlementName)),
      h('div.mu-row.mu-between.mu-small', null, h('span', null, 'Children'), h('b', null, plural(card.children.length, 'child', 'children'))),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '6px' } }, button('Family & House', { size: 'small', icon: 'tree', onClick: () => ctx.open({ panel: 'family' }) })),
    );
    body.replaceChildren(left, mid, right);
  };

  render();
  const tick = every(0.5, render);
  return panelOf({ id: 'character', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, { tick });
}

