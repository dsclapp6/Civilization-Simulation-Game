// Panels about the world around you: the journey encounter, the chronicle, a building, a person.
import { BUILDINGS } from '../../content/types';
import { RANK_NAMES, type RankTier } from '../../core/domain';
import type { EncounterKind } from '../../player/types';
import { chronicle, personCard } from '../../sim/api';
import { roleLabel } from '../../sim/careers';
import { familyOf } from '../../sim/kin';
import { fullName, type ChronicleEntry, type Person, type PersonId } from '../../sim/state';
import { append, h, replace } from '../core/dom';
import { chronicleDate, plural, relativeDay } from '../core/format';
import { opinionWords } from '../core/dialogueModel';
import { icon, type IconName } from '../core/icons';
import { shield } from '../core/ornament';
import { TRAITS } from '../core/text';
import { button, chip, empty, pips } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { confirmPlayAs } from './family';
import { every, panelOf } from './base';

// ---------------------------------------------------------------------------------------------
// Encounter on the road
// ---------------------------------------------------------------------------------------------

const ENCOUNTER_ICON: Record<EncounterKind, IconName> = {
  bandits: 'swords', patrol: 'shield', travellers: 'users', merchant: 'trade', pilgrims: 'church', wolves: 'warning', army: 'castle', messenger: 'scroll',
};

export function encounterPanel(ctx: PanelCtx): UiPanel {
  const t = ctx.player.travel();
  const win = createWindow({ title: t?.encounter?.label ?? 'On the road', subtitle: t ? `Journey to ${ctx.placeName(t.to)}` : '', icon: t?.encounter ? ENCOUNTER_ICON[t.encounter.kind] : 'signpost', size: 'lg', onClose: () => ctx.close() });
  const msg = h('p.mu-bad.mu-bold.mu-small.mu-hide');
  if (!t || !t.encounter) {
    win.body.append(h('p.mu-empty', null, 'The road is quiet.'));
    win.showFoot(h('div.mu-grow'), button('Close', { onClick: () => ctx.close() }));
    return panelOf({ id: 'encounter', pauses: 'never', mode: 'dock-bottom', backdropCloses: ctx }, win.el);
  }
  const enc = t.encounter;
  const go = (id: number, text: string): void => {
    const r = ctx.player.travelTo(id);
    if (r.ok) { ctx.say('info', text); ctx.close(); } else { msg.textContent = r.reason ?? 'That is not possible now.'; msg.classList.remove('mu-hide'); }
  };
  append(win.body,
    h('div.mu-row.mu-gap-12.mu-top', null,
      h('span.mu-enc-ico', { class: enc.hostile ? 'hostile' : '' }, icon(ENCOUNTER_ICON[enc.kind], 34)),
      h('div', null,
        h('p.mu-prose.mu-dropcap', null, enc.hostile
          ? `${enc.label}. They have seen you, and they do not look friendly. You may stand and deal with them on the road, or try to leave.`
          : `${enc.label}. They have not noticed you yet, or do not care. You may speak with them, or go on.`),
        h('div.mu-row.mu-gap-6', null, chip(enc.hostile ? 'Hostile' : 'Peaceful', enc.hostile ? 'vermilion' : 'green', enc.hostile ? 'swords' : 'heart'), chip(`${Math.round(t.progress * 100)}% of the way`, '', 'signpost')))),
    msg);
  win.showFoot(
    button('Face them', { variant: 'primary', icon: 'hand', tip: 'Deal with them at street level: hold E near them for your options', onClick: () => ctx.close() }),
    button(`Press on to ${ctx.placeName(t.to)}`, { icon: 'signpost', onClick: () => go(t.to, `You press on for ${ctx.placeName(t.to)}.`) }),
    button(`Turn back to ${ctx.placeName(t.from)}`, { icon: 'door', onClick: () => go(t.from, `You turn back for ${ctx.placeName(t.from)}.`) }),
    h('div.mu-grow'),
    button('End the journey here', { variant: 'danger', onClick: () => { ctx.player.cancelTravel(); ctx.close(); } }),
  );
  return panelOf({ id: 'encounter', pauses: 'menu', mode: 'dock-bottom', backdropCloses: null }, win.el);
}

// ---------------------------------------------------------------------------------------------
// Chronicle
// ---------------------------------------------------------------------------------------------

type KindGroup = 'birth' | 'death' | 'marriage' | 'rank' | 'other';
const KIND_GROUP: Record<string, KindGroup> = { birth: 'birth', death: 'death', marriage: 'marriage', inheritance: 'rank', promotion: 'rank', rank: 'rank' };
const KIND_ICON: Record<KindGroup, IconName> = { birth: 'sparkle', death: 'skull', marriage: 'ring', rank: 'crown', other: 'scroll' };
const KIND_LABEL: Record<KindGroup, string> = { birth: 'Births', death: 'Deaths', marriage: 'Marriages', rank: 'Titles', other: 'Other' };

export function chroniclePanel(ctx: PanelCtx): UiPanel {
  const sim = ctx.sim;
  const win = createWindow({ title: 'Chronicle', subtitle: 'The record of the age', icon: 'scroll', size: 'lg', tall: true, onClose: () => ctx.close() });
  let familyOnly = false;
  const kinds = new Set<KindGroup>(['birth', 'death', 'marriage', 'rank', 'other']);
  const filters = h('div.mu-row.mu-wrap.mu-gap-6', { style: { padding: '0 0 8px' } });
  const list = h('div.mu-scroll.mu-chron');
  win.body.classList.add('flush');
  win.body.append(h('div.mu-chron-top', null, filters), list);
  let sig = '';

  const render = (force = false): void => {
    const st = sim.state;
    const last = st.chronicle[st.chronicle.length - 1];
    const s = `${st.chronicle.length}:${last?.day}:${last?.text}:${familyOnly}:${[...kinds].join()}`;
    if (!force && s === sig) return;
    sig = s;
    const player = st.persons.get(ctx.playerId());
    const fam: ReadonlySet<PersonId> | undefined = familyOnly && player ? new Set(familyOf(st, player, 4).keys()) : undefined;
    const entries = chronicle(st, 300, fam).filter((e) => kinds.has(KIND_GROUP[e.kind] ?? 'other'));
    const mineSet = player ? new Set(familyOf(st, player, 2).keys()) : new Set<PersonId>();
    const row = (e: ChronicleEntry): HTMLElement => {
      const g = KIND_GROUP[e.kind] ?? 'other';
      const mine = e.persons.some((id) => mineSet.has(id));
      return h('div.mu-chron-row', { class: mine ? 'mine' : '' },
        h('span.mu-chron-date.mu-num', { tip: relativeDay(e.day, sim.absDay) }, chronicleDate(e.day)),
        h('span.mu-chron-ico', null, icon(KIND_ICON[g], 16)),
        h('span.mu-chron-text', null, e.text));
    };
    replace(list, entries.length ? entries.map(row) : [empty(familyOnly ? 'Nothing is recorded of your family yet.' : 'Nothing has been recorded yet.')]);
    replace(filters,
      h('div.mu-seg', null,
        ...(['all', 'family'] as const).map((k) => {
          const b = h<HTMLButtonElement>('button', { type: 'button', class: (k === 'family') === familyOnly ? 'on' : '' }, k === 'all' ? 'Everyone' : 'My family');
          b.addEventListener('click', () => { familyOnly = k === 'family'; render(true); });
          return b;
        })),
      ...(Object.keys(KIND_LABEL) as KindGroup[]).map((g) => {
        const b = h<HTMLButtonElement>('button.mu-chip.mu-click', { type: 'button', class: kinds.has(g) ? 'lapis' : '' }, icon(KIND_ICON[g], 13), KIND_LABEL[g]);
        b.addEventListener('click', () => { if (kinds.has(g)) kinds.delete(g); else kinds.add(g); render(true); });
        return b;
      }),
      h('span.mu-grow'), h('span.mu-small.mu-dim', null, `${plural(entries.length, 'entry', 'entries')}`));
  };
  render(true);
  return panelOf({ id: 'chronicle', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, { tick: every(1, () => render()) });
}

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

const CAT_TEXT: Record<string, string> = {
  home: 'A dwelling.', farm: 'A farm building, for beasts, stores or the harvest.', work: 'A place of work: raw goods go in, finished goods come out.',
  social: 'Where people meet, drink and talk.', trade: 'A place of trade and markets.', church: 'The Church’s house.', civic: 'Common to the whole community.',
  defence: 'A work of defence.', camp: 'A temporary shelter.',
};

export function buildingPanel(ctx: PanelCtx, id: number): UiPanel {
  const sim = ctx.sim;
  const b = sim.state.buildings.get(id);
  const def = b ? BUILDINGS[b.kind] : undefined;
  const win = createWindow({ title: def?.name ?? 'A building', subtitle: b ? ctx.placeName(b.settlement) : '', icon: 'home', size: 'md', onClose: () => ctx.close() });
  if (!b || !def) {
    win.body.append(empty('Nothing is known of this place.'));
    return panelOf({ id: 'building', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
  }
  const hh = b.household ? sim.state.households.get(b.household) : undefined;
  const head = hh ? sim.state.persons.get(hh.head) : undefined;
  const owner = b.owner ? sim.state.houses.get(b.owner) : undefined;
  const jobs = ctx.eco.jobs(b.settlement, ctx.playerId()).filter((j) => j.building === b.id || j.building === undefined).length;
  append(win.body,
    h('div.mu-row.mu-gap-16.mu-top', null,
      owner?.heraldry ? shield(owner.heraldry, 54) : h('span.mu-path-ico.big', null, icon('home', 30)),
      h('div.mu-grow', null,
        h('p.mu-prose', null, CAT_TEXT[def.cat] ?? ''),
        h('div.mu-row.mu-wrap.mu-gap-6', null,
          chip(def.cat, '', 'home'),
          b.construction < 1 ? chip(`${Math.round(b.construction * 100)}% built`, 'gold', 'hammer') : chip('Complete', 'green', 'check'),
          b.damage > 0.05 ? chip(`${Math.round(b.damage * 100)}% damaged`, 'vermilion', 'warning') : null,
          b.onFire ? chip('On fire!', 'vermilion', 'flame') : null))),
    h('div.mu-rule'),
    h('dl.mu-kv', null,
      h('dt', null, 'Size'), h('dd', null, `${def.w} × ${def.d} paces`),
      h('dt', null, 'Level'), h('dd', null, h('span.mu-row.mu-end.mu-gap-6', null, pips(b.level, def.maxLevel), h('span.mu-small.mu-dim', null, `${b.level} of ${def.maxLevel}`))),
      h('dt', null, 'Lives or works here'), h('dd', null, hh && head ? `${fullName(head)}’s household (${plural(hh.members.length, 'soul')})` : b.occupied ? 'Occupied' : 'No one'),
      h('dt', null, 'Belongs to'), h('dd', null, owner ? `House ${owner.name}` : 'The community')),
  );
  win.showFoot(
    jobs ? button('Work here', { icon: 'hammer', onClick: () => ctx.open({ panel: 'jobs', settlement: b.settlement }) }) : null,
    def.cat === 'trade' ? button('Trade', { icon: 'coin', onClick: () => ctx.open({ panel: 'trade', partner: { kind: 'building', id: b.id } }) }) : null,
    h('div.mu-grow'),
    button('Close', { variant: 'primary', onClick: () => ctx.close() }),
  );
  return panelOf({ id: 'building', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
}

// ---------------------------------------------------------------------------------------------
// Person
// ---------------------------------------------------------------------------------------------

export function personPanel(ctx: PanelCtx, id: PersonId): UiPanel {
  const sim = ctx.sim;
  const p: Person | undefined = sim.state.persons.get(id);
  const card = p ? personCard(sim, id) : null;
  const win = createWindow({ title: card?.name ?? 'Someone', subtitle: card ? `${card.age} years old` : '', icon: 'user', size: 'sm', onClose: () => ctx.close() });
  if (!p || !card) {
    win.body.append(empty('Nothing is known of this person.'));
    return panelOf({ id: 'person', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
  }
  const me = ctx.playerId();
  const opinion = id === me ? 0 : ctx.social.opinion(id, me);
  const relation = id === me ? 'You' : ctx.social.relationLabel(me, id);
  const house = p.house ? sim.state.houses.get(p.house) : undefined;
  const canSwitch = id !== me && sim.eligibleSwitchTargets().includes(id);
  append(win.body,
    h('div.mu-row.mu-gap-16.mu-top', null,
      shield(house?.heraldry, 52),
      h('div.mu-grow', null,
        h('div.mu-dim.mu-small', null, relation),
        h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '6px 0' } },
          chip(RANK_NAMES[p.rankTier as RankTier], 'gold', 'shield'), chip(roleLabel(p.career, p.careerStage, p.sex), '', 'hammer'), chip(card.settlementName, '', 'pin')),
        id !== me ? h('div.mu-small.mu-ink2', null, `${opinionWords(opinion, p.first)}.`) : null)),
    p.traits.length ? h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '10px' } }, p.traits.map((t) => chip(TRAITS[t].name, TRAITS[t].good === true ? 'green' : TRAITS[t].good === false ? 'vermilion' : '', undefined, TRAITS[t].text))) : null,
    house ? h('p.mu-small.mu-dim', { style: { marginTop: '8px' } }, `House ${house.name}`) : null,
  );
  win.showFoot(
    id !== me && !p.death ? button('Talk', { icon: 'talk', variant: 'primary', onClick: () => { ctx.close(); const r = ctx.player.talkTo(id); if (!r.ok) ctx.say('warn', r.reason ?? 'They are not here.'); } }) : null,
    canSwitch ? button('Play as them', { icon: 'user', onClick: () => confirmPlayAs(ctx, id) }) : null,
    h('div.mu-grow'),
    button('Close', { onClick: () => ctx.close() }),
  );
  return panelOf({ id: 'person', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
}

