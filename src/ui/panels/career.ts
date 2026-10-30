// Career paths (SPEC §6 field table as cards) and the jobs board of a settlement.
import type { CareerField } from '../../sim/careers';
import { CAREERS } from '../../sim/careers';
import type { CareerPath, EntryTest, JobOffer, Requirement } from '../../sim/economy/types';
import { skillLevel } from '../../sim/people';
import { ageYears, fullName, type PersonId } from '../../sim/state';
import { append, h } from '../core/dom';
import { formatMoney, relativeDay } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { SKILL_ICON, STAT_ICON } from '../core/iconMap';
import { SKILL_NAMES, STAT_INFO } from '../core/text';
import { button, chip, empty, heading } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';

const FIELD_ICON: Record<CareerField, IconName> = {
  none: 'signpost', land: 'farming', husbandry: 'husbandry', brewing: 'brewing', craft: 'hammer', trade: 'trade', arms: 'archery',
  knighthood: 'shield', church: 'church', service: 'key', healing: 'medicine', noble: 'crown', outlaw: 'stealth',
};

function requirementList(reqs: readonly Requirement[]): HTMLElement {
  return h('ul.mu-reqs', null, reqs.map((r) =>
    h('li', { class: r.met ? 'met' : 'unmet' }, icon(r.met ? 'check' : 'cross', 14), r.label)));
}

function ladder(labels: readonly string[], stage: number): HTMLElement {
  const els = labels.filter(Boolean).map((l, i) => h('li', { class: stage < 0 ? '' : i < stage ? 'done' : i === stage ? 'here' : '' }, h('i'), h('span', null, l)));
  return h('ol.mu-ladder', null, els);
}

function pathCard(ctx: PanelCtx, p: CareerPath): HTMLElement {
  const here = p.stage >= 0;
  const state = here ? chip('You are here', 'lapis', 'pin') : p.open ? chip('Open to you', 'green', 'check') : chip('Not yet', 'vermilion', 'lock');
  const closedBySex = !p.open && !!p.sexRule;
  void ctx;
  return h('div.mu-card.mu-path', { class: `${here ? 'sel' : ''}${p.open || here ? '' : ' locked'}` },
    h('div.mu-row.mu-between.mu-top', null,
      h('div.mu-row.mu-gap-8', null, h('span.mu-path-ico', null, icon(FIELD_ICON[p.field], 22)), h('h4', null, p.label)),
      state),
    h('p.mu-small.mu-ink2', null, p.entry),
    p.ladder.some(Boolean) ? ladder(p.ladder, p.stage) : null,
    requirementList(p.requirements),
    closedBySex ? h('div.mu-rule-note', null, icon('info', 15), h('span', null, p.sexRule)) : null,
  );
}

function testRow(ctx: PanelCtx, t: EntryTest): HTMLElement {
  const me = ctx.sim.state.persons.get(ctx.playerId());
  const age = me ? ageYears(me, ctx.sim.absDay) : 0;
  const stats = Object.entries(t.stats).map(([k, v]) => {
    const id = k as keyof typeof STAT_INFO;
    const have = me?.trained[id] ?? 0;
    return { label: `${STAT_INFO[id].name} ${v}`, met: have >= (v ?? 0), icon: STAT_ICON[id] };
  });
  const skills = Object.entries(t.skills).map(([k, v]) => {
    const id = k as keyof typeof SKILL_NAMES;
    return { label: `${SKILL_NAMES[id]} ${v}`, met: skillLevel(me?.skills[id] ?? 0) >= (v ?? 0), icon: SKILL_ICON[id] };
  });
  const sex = t.sex && me && me.sex !== t.sex ? [{ label: `${t.sex === 'm' ? 'Men' : 'Women'} only`, met: false, icon: 'user' as IconName }] : [];
  const ageReq = [{ label: `Aged ${t.minAge}${t.maxAge ? `–${t.maxAge}` : '+'}`, met: age >= t.minAge && (!t.maxAge || age <= t.maxAge), icon: 'calendar' as IconName }];
  const kit = t.kit.map((k) => ({ label: `Own ${k}`, met: false, icon: 'box' as IconName }));
  return h('div.mu-test-row', null,
    h('b', null, t.label),
    h('div.mu-row.mu-wrap.mu-gap-6', null, [...stats, ...skills, ...ageReq, ...sex, ...kit].map((r) => chip(r.label, r.met ? 'green' : 'vermilion', r.met ? 'check' : 'cross'))));
}

export function careerPanel(ctx: PanelCtx, person: PersonId): UiPanel {
  const eco = ctx.eco;
  const p = ctx.sim.state.persons.get(person);
  const win = createWindow({ title: 'Careers', subtitle: p ? `Where ${p.id === ctx.playerId() ? 'life' : fullName(p)} can lead` : '', icon: 'signpost', size: 'xl', tall: true, onClose: () => ctx.close() });
  const job = eco.employment(person);
  const paths = eco.careerPaths(person);
  const tests = eco.entryTests();
  const now = ctx.sim.absDay;

  const present = h('div.mu-card.mu-present', null,
    h('div.mu-row.mu-between', null,
      h('div', null,
        h('div.mu-tiny.mu-dim.mu-caps', null, 'Your present work'),
        h('div.mu-big.mu-bold', null, job ? job.title : p ? CAREERS[p.career].label : '—'),
        h('div.mu-small.mu-dim', null, job
          ? `${job.wage > 0 ? `${formatMoney(job.wage)} a day` : 'Board and lodging, no wage'} · ${job.terms}${job.until >= 0 ? ` · until ${relativeDay(job.until, now)}` : ''}`
          : 'No steady post. Hire on at the jobs board, or follow one of the paths below.')),
      h('div.mu-row.mu-gap-6', null,
        button('Jobs board', { icon: 'hammer', onClick: () => ctx.open({ panel: 'jobs', settlement: p?.settlement ?? 0 }) }),
        job ? button('Leave the post', { variant: 'danger', onClick: () => { const r = eco.quitJob(person); ctx.say(r.ok ? 'info' : 'warn', r.ok ? 'You leave your post.' : r.reason ?? ''); ctx.close(); } }) : null)));

  append(win.body,
    present,
    h('div', { style: { height: '14px' } }),
    h('div.mu-grid.auto.mu-paths', null, paths.map((x) => pathCard(ctx, x))),
    tests.length ? h('div', { style: { marginTop: '18px' } }, heading('The recruiter’s test', 'melee'),
      h('p.mu-small.mu-dim', { style: { margin: '0 0 8px' } }, 'All men of fifteen to sixty may be called to the levy. These posts ask for more.'),
      h('div.mu-col.mu-gap-8', null, tests.map((t) => testRow(ctx, t)))) : null,
    !paths.length ? empty('No paths are known.') : null,
  );
  return panelOf({ id: 'career', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
}

// ---------------------------------------------------------------------------------------------

const TERMS: Record<JobOffer['terms'], string> = {
  day: 'By the day', season: 'For the season', year: 'For the year', apprenticeship: 'Apprenticeship', service: 'In service',
};

function institutionFor(kind: string): string {
  switch (kind) {
    case 'town': case 'city': return 'the town';
    case 'abbey': case 'priory': case 'nunnery': return 'the house';
    case 'castle': return 'the castle';
    default: return 'the manor';
  }
}

export function jobsPanel(ctx: PanelCtx, settlement: number): UiPanel {
  const eco = ctx.eco;
  const person = ctx.playerId();
  const me = ctx.sim.state.persons.get(person);
  const place = ctx.sim.world.settlements.find((s) => s.id === settlement);
  const win = createWindow({ title: `Work in ${place?.name ?? 'the district'}`, subtitle: 'Posts you may apply for', icon: 'hammer', size: 'lg', tall: true, onClose: () => ctx.close() });
  const msg = h('p.mu-bad.mu-bold.mu-small.mu-hide');
  const list = h('div.mu-col.mu-gap-10');
  win.body.append(msg, list);

  const render = (): void => {
    const jobs = eco.jobs(settlement, person);
    const rank = (j: JobOffer): number => (j.requirements.every((r) => r.met) ? 0 : 1);
    jobs.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title, 'en'));
    list.replaceChildren(...(jobs.length ? jobs.map((j) => {
      const employer = j.employer ? ctx.nameOf(j.employer) : institutionFor(place?.kind ?? 'village');
      const sexBar = j.sex && me && me.sex !== j.sex;
      const ok = j.requirements.every((r) => r.met) && !sexBar;
      const apply = button(ok ? 'Apply' : 'Cannot apply yet', { variant: ok ? 'primary' : '', icon: 'check', disabled: !ok, onClick: () => {
        const r = eco.applyForJob(person, j.id);
        if (r.ok) { ctx.toast({ tone: 'gold', icon: 'hammer', title: j.title, text: 'You are taken on.', ttl: 5, key: 'job' }); ctx.close(); }
        else { msg.textContent = r.reason ?? 'They will not have you.'; msg.classList.remove('mu-hide'); }
      } });
      return h('div.mu-card.mu-job', { class: ok ? '' : 'locked' },
        h('div.mu-row.mu-between.mu-top', null,
          h('div', null, h('h4', null, j.title), h('div.mu-small.mu-dim', null, `Hiring: ${employer}`)),
          h('div.mu-row.mu-wrap.mu-gap-6.mu-end', null,
            chip(TERMS[j.terms], 'lapis', 'calendar'),
            chip(j.wage > 0 ? `${formatMoney(j.wage)} a day` : 'Board and lodging', 'gold', 'coin'),
            j.premium ? chip(`Premium ${formatMoney(j.premium)}`, 'vermilion', 'coin', 'Paid by your family to the master (SPEC: apprenticeship premium)') : null)),
        h('div.mu-row.mu-between.mu-top', { style: { marginTop: '8px' } },
          requirementList(j.requirements),
          h('div.mu-col.mu-gap-6.mu-end', { style: { alignItems: 'flex-end' } }, apply)),
        sexBar ? h('div.mu-rule-note', null, icon('info', 15), h('span', null, `In this land only ${j.sex === 'm' ? 'men' : 'women'} were taken on for such posts.`)) : null);
    }) : [empty('No one is hiring here today.')]));
  };
  render();
  return panelOf({ id: 'jobs', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
}
