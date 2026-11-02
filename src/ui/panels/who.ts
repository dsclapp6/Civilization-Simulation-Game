// "Who you are now": when you take up another life (People, V → Live as), a card says who this person is — their
// work and standing, their family and household, what they are good at, what they own — what they are doing at this
// moment, and the duties their place in the world gives them day to day.
import { BUILDINGS } from '../../content/types';
import { dutiesOf } from '../../agents/schedule';
import { roleLabel } from '../../sim/careers';
import { skillLevel } from '../../sim/people';
import type { SkillId } from '../../core/domain';
import { ageYears, fullName, type Person } from '../../sim/state';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { SKILL_NAMES, TRAITS } from '../core/text';
import { button, chip } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

const coins = (d: number): string => (d >= 240 ? `£${Math.floor(d / 240)} ${Math.floor((d % 240) / 12)}s` : d >= 12 ? `${Math.floor(d / 12)}s ${Math.round(d % 12)}d` : `${Math.round(d)}d`);

/** One line of who someone is: "Smith, 34, of Pontrhiw · married, three children". */
export function whoLine(p: Person, now: number, nameOf: (id: number) => string, place: string): string {
  const age = Math.floor(ageYears(p, now));
  const kids = p.children.length;
  const fam = [p.spouse ? `married to ${nameOf(p.spouse)}` : age >= 16 ? 'unmarried' : '', kids ? `${kids} ${kids === 1 ? 'child' : 'children'}` : ''].filter(Boolean).join(', ');
  return `${roleLabel(p.career, p.careerStage, p.sex)}, ${age}, of ${place}${fam ? ` · ${fam}` : ''}`;
}

export function whoPanel(ctx: PanelCtx, id: number): UiPanel {
  const sim = ctx.sim;
  const p = sim.state.persons.get(id);
  const win = createWindow({ title: p ? fullName(p) : 'Who you are', subtitle: 'Who you are now', icon: 'user', size: 'md', onClose: () => ctx.close() });
  const base = { id: 'who', group: 'main' as const, pauses: 'menu' as const, backdropCloses: ctx };
  if (!p) return panelOf(base, win.el);
  const now = sim.absDay;
  const place = sim.world.settlements[p.settlement]?.name ?? 'the road';
  const house = sim.state.houses.get(p.house);
  const hh = sim.state.households.get(p.household);
  const titles = [...sim.state.titlesHeldBy(p.id)].map((t) => t.name);
  // what they are doing this very moment
  const w = ctx.game.zone.whereabouts(p.id, now);
  const at = w.building >= 0 ? sim.state.buildings.get(w.building) : undefined;
  const doing = `${w.label}${at ? ` (${BUILDINGS[at.kind]?.name?.toLowerCase() ?? 'a building'})` : ''}`;
  // best skills
  const skills = (Object.keys(p.skills) as SkillId[]).map((k) => ({ k, lv: skillLevel(p.skills[k]) })).filter((x) => x.lv > 0).sort((a, b) => b.lv - a.lv).slice(0, 4);
  const duties = dutiesOf(p.career);
  win.body.append(...[
    h('p.mu-ink2', { style: { margin: '0 0 6px' } }, whoLine(p, now, (q) => ctx.nameOf(q), place)),
    titles.length || house ? h('p.mu-small.mu-dim', { style: { margin: '0 0 10px' } }, [titles.join(', '), house && house.kind !== 'peasant' ? `of the House of ${house.name}` : ''].filter(Boolean).join(' · ')) : null,
    h('div.mu-card', { style: { marginBottom: '10px' } },
      h('div.mu-small.mu-dim', null, icon('hourglass', 12), ' Right now'),
      h('b', null, doing)),
    duties.length ? h('div', { style: { marginBottom: '10px' } },
      h('div.mu-small.mu-dim', null, icon('scroll', 12), ' Their days'),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '4px' } }, duties.map((d) => chip(d, '')))) : null,
    skills.length ? h('div', { style: { marginBottom: '10px' } },
      h('div.mu-small.mu-dim', null, icon('star', 12), ' Good at'),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '4px' } }, skills.map((s) => chip(`${SKILL_NAMES[s.k]} ${s.lv}`, 'lapis')))) : null,
    p.traits.length ? h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginBottom: '10px' } }, p.traits.map((t) => chip(TRAITS[t].name, TRAITS[t].good === true ? 'green' : TRAITS[t].good === false ? 'vermilion' : '', undefined, TRAITS[t].text))) : null,
    h('p.mu-small', null, `In the purse: ${coins(p.money)}${hh ? ` · the household (${hh.members.length}) holds ${coins(hh.purse)}` : ''}${p.health.conditions.length ? ` · unwell (${p.health.conditions.length})` : ''}.`),
    h('div.mu-row', { style: { justifyContent: 'flex-end', marginTop: '8px' } }, button('Carry on', { variant: 'primary', onClick: () => ctx.close() })),
  ].filter((x): x is HTMLElement => x !== null));
  return panelOf(base, win.el);
}

registerPanel('who', (ctx, req) => whoPanel(ctx, req.id ?? ctx.playerId()));
