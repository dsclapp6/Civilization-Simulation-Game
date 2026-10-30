// Family & House (H): the family tree, the household and what each member is doing, the House
// (heraldry, titles, sworn people), and courtship / match candidates. "Play as" for eligible people.
import { RANK_NAMES, type RankTier } from '../../core/domain';
import { houseCard, householdCard, familyTree, kinshipLabel, personCard, type FamilyNode, type MemberLine } from '../../sim/api';
import { roleLabel } from '../../sim/careers';
import { ageYears, fullName, NONE, type Person, type PersonId } from '../../sim/state';
import { svgEl, h, replace } from '../core/dom';
import { deathCauseText, pct, plural, thousands } from '../core/format';
import { icon } from '../core/icons';
import { CARD_H, CARD_W, layoutFamily, type FamilyLayout, type PlacedCard } from '../core/familyLayout';
import { shield } from '../core/ornament';
import type { FamilyTab } from '../core/requests';
import { TASK_LABEL } from '../core/ledgerModel';
import { bar, button, chip, empty, heading, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';

export function confirmPlayAs(ctx: PanelCtx, id: PersonId): void {
  const target = ctx.sim.state.persons.get(id);
  const me = ctx.sim.state.persons.get(ctx.playerId());
  if (!target) return;
  ctx.confirm({
    title: `Become ${target.first}?`,
    text: `You will take up the life of ${fullName(target)}. ${me ? `${me.first} goes on with ${me.sex === 'm' ? 'his' : 'her'} own life, run by the world.` : ''}\n\nYou may switch again to any living relation, or sworn member of your House of equal rank.`,
    confirmLabel: `Become ${target.first}`, cancelLabel: 'Stay as you are',
    onConfirm: () => {
      const r = ctx.dispatch({ type: 'switchCharacter', personId: id });
      if (!r.ok) ctx.say('warn', r.reason ?? 'That cannot be done.');
    },
  });
}

export function familyPanel(ctx: PanelCtx, startTab: FamilyTab | undefined): UiPanel {
  const sim = ctx.sim;
  const win = createWindow({ title: 'Family & House', icon: 'tree', size: 'xl', tall: true, onClose: () => ctx.close() });
  let tab: 'tree' | 'household' | 'house' | 'marriage' = startTab ?? 'tree';
  let selected: PersonId = ctx.playerId();
  const content = h('div.mu-fam-content');
  const tabsEl = tabs([
    { id: 'tree', label: 'Family tree', icon: 'tree' },
    { id: 'household', label: 'Household', icon: 'home' },
    { id: 'house', label: 'The House', icon: 'shield' },
    { id: 'marriage', label: 'Marriage', icon: 'ring' },
  ], tab, (id) => { tab = id as typeof tab; tabsEl.set(tab); render(); });
  win.body.classList.add('flush');
  win.body.append(tabsEl.el, h('div.mu-tabbar-rule'), content);

  const eligible = (): Set<PersonId> => new Set(sim.eligibleSwitchTargets());

  // ---------------------------------------------------------------- shared: a person's detail card
  const detail = (id: PersonId): HTMLElement => {
    const p = sim.state.persons.get(id);
    if (!p) return h('div.mu-fam-detail', null, empty('Little is remembered of this person.'));
    const card = personCard(sim, id);
    const me = sim.state.persons.get(ctx.playerId());
    const rel = me && me.id !== id ? kinshipLabel(sim.state, me, p) : me?.id === id ? 'you' : '';
    const canSwitch = eligible().has(id);
    const alive = !p.death;
    return h('div.mu-fam-detail', null,
      h('h3.mu-fam-name', null, fullName(p)),
      h('div.mu-dim.mu-small', null, rel ? (rel === 'you' ? 'This is you' : `Your ${rel}`) : 'Not close kin'),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '8px 0' } },
        chip(alive ? `${card?.age ?? 0} years old` : `Died aged ${card?.age ?? 0}`, alive ? '' : 'vermilion', alive ? 'calendar' : 'skull'),
        chip(RANK_NAMES[p.rankTier as RankTier], 'gold', 'shield'),
        chip(roleLabel(p.career, p.careerStage, p.sex), '', 'hammer')),
      h('dl.mu-kv', null,
        h('dt', null, 'Lives in'), h('dd', null, card?.settlementName ?? '—'),
        h('dt', null, 'House'), h('dd', null, card?.houseName ?? '—'),
        h('dt', null, 'Spouse'), h('dd', null, p.spouse ? (sim.state.persons.get(p.spouse) ? fullName(sim.state.persons.get(p.spouse) as Person) : 'unknown') : 'unmarried'),
        h('dt', null, 'Children'), h('dd', null, plural(p.children.length, 'child', 'children')),
        alive ? null : h('dt', null, 'Cause'), alive ? null : h('dd', null, p.death ? deathCauseText(p.death.cause) : '')),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '10px' } },
        alive && id !== ctx.playerId() ? button('Talk', { icon: 'talk', size: 'small', onClick: () => { ctx.close(); const r = ctx.player.talkTo(id); if (!r.ok) ctx.say('warn', r.reason ?? 'They are not here.'); } }) : null,
        alive && id !== ctx.playerId()
          ? (canSwitch ? button('Play as them', { icon: 'user', size: 'small', variant: 'primary', onClick: () => confirmPlayAs(ctx, id) }) : chip('Not eligible to take over', '', 'lock', 'Only family, or sworn members of your House of equal rank, may be taken over (SPEC §8).'))
          : null));
  };

  // ---------------------------------------------------------------- tree
  const treeView = (): HTMLElement => {
    const root = familyTree(sim.state, ctx.playerId(), 2, 3);
    if (!root) return empty('No family is recorded.');
    const spouseNode = (n: FamilyNode): FamilyNode | null => {
      if (n.spouse === NONE) return null;
      const sp = sim.state.persons.get(n.spouse);
      if (!sp) return null;
      return { id: sp.id, name: fullName(sp), sex: sp.sex, born: Math.floor(sp.birthDay / 16) + 1, died: sp.death ? Math.floor(sp.death.day / 16) + 1 : null, spouse: n.id, father: sp.father, mother: sp.mother, children: [], known: true };
    };
    const layout: FamilyLayout = layoutFamily(root, spouseNode);
    const world = h('div.mu-tree-world', { style: { width: `${layout.width}px`, height: `${layout.height}px` } });
    const svg = svgEl('svg', { class: 'mu-tree-lines', width: String(layout.width), height: String(layout.height), viewBox: `0 0 ${layout.width} ${layout.height}` });
    for (const s of layout.segments) {
      svg.appendChild(svgEl('line', { x1: String(s.x1), y1: String(s.y1), x2: String(s.x2), y2: String(s.y2), class: s.kind === 'marriage' ? 'marriage' : '' }));
    }
    world.appendChild(svg);
    const el = new Map<PersonId, HTMLElement>();
    const me = ctx.playerId();
    const cardEl = (c: PlacedCard): HTMLElement => {
      const n = c.node;
      const dead = n.died !== null;
      const p = sim.state.persons.get(n.id);
      const years = !n.known ? '—' : dead ? `${n.born}–${n.died}` : p ? `${Math.floor(ageYears(p, sim.absDay))} yrs` : `b. ${n.born}`;
      const e = h('button.mu-fnode', {
        type: 'button', class: `${n.sex}${dead ? ' dead' : ''}${n.id === me ? ' me' : ''}${!n.known ? ' stub' : ''}${c.role === 'spouse' ? ' spouse' : ''}${n.id === selected ? ' sel' : ''}`,
        style: { left: `${c.x}px`, top: `${c.y}px`, width: `${CARD_W}px`, height: `${CARD_H}px` },
        tip: n.id === me ? 'You' : undefined,
      },
        h('span.mu-fnode-name', null, n.name),
        h('span.mu-fnode-years', null, dead ? icon('cross_holy', 11) : null, years));
      e.addEventListener('click', () => { selected = n.id; render(); });
      el.set(n.id, e);
      return e;
    };
    for (const c of layout.cards) world.appendChild(cardEl(c));
    const scroller = h('div.mu-tree.mu-scroll', null, world);
    const mine = layout.byId.get(me);
    window.setTimeout(() => {
      if (!mine) return;
      scroller.scrollLeft = Math.max(0, mine.x + CARD_W / 2 - scroller.clientWidth / 2);
      scroller.scrollTop = Math.max(0, mine.y + CARD_H / 2 - scroller.clientHeight / 2);
    }, 0);
    return h('div.mu-fam-split', null,
      h('div.mu-fam-main', null,
        h('div.mu-row.mu-between', { style: { padding: '0 0 8px' } },
          h('span.mu-dim.mu-small.mu-ital', null, 'Click a person to read about them. Squares show husband and wife side by side; children hang below.'),
          button('Centre on me', { size: 'small', icon: 'pin', onClick: () => { if (mine) { scroller.scrollTo({ left: Math.max(0, mine.x + CARD_W / 2 - scroller.clientWidth / 2), top: Math.max(0, mine.y - 40), behavior: 'smooth' }); } } })),
        scroller),
      detail(selected));
  };

  // ---------------------------------------------------------------- household
  const householdView = (): HTMLElement => {
    const p = sim.state.persons.get(ctx.playerId());
    const hc = p ? householdCard(sim, p.household) : null;
    if (!hc || !p) return empty('You have no household.');
    const plan = new Map(ctx.eco.householdPlan(hc.id).map((l) => [l.person, l]));
    const elig = eligible();
    const hhHead = sim.state.persons.get(hc.head);
    const rows = hc.members.map((m: MemberLine) => {
      const line = plan.get(m.id);
      return h('div.mu-li.mu-fam-member', { class: m.id === selected ? 'sel click' : 'click', onclick: () => { selected = m.id; render(); } },
        h('span.mu-fam-sexdot', { class: m.sex }),
        h('div.mu-grow', null, h('b', null, m.name), h('div.mu-small.mu-dim', null, `${m.role || 'Member'} · ${m.age} years old`)),
        h('div.mu-small', null, line ? TASK_LABEL[line.task] : '—', line && !line.set ? h('span.mu-dim', null, ' (their own choice)') : null),
        m.id === ctx.playerId() ? chip('You', 'lapis') : elig.has(m.id) ? chip('Can be played', 'gold', 'user') : null);
    });
    return h('div.mu-fam-split', null,
      h('div.mu-fam-main', null,
        h('div.mu-row.mu-between.mu-wrap', { style: { marginBottom: '8px' } },
          h('div', null, h('div.mu-big.mu-bold', null, hhHead ? `The household of ${fullName(hhHead)}` : 'Your household'),
            h('div.mu-dim.mu-small', null, `${plural(hc.members.length, 'soul')} · ${hc.settlementName} · purse ${thousands(hc.purse)}d`)),
          button('Orders & stores', { icon: 'ledger', onClick: () => ctx.open({ panel: 'ledger', tab: 'household' }) })),
        h('div.mu-list.mu-scroll', null, rows)),
      detail(selected));
  };

  // ---------------------------------------------------------------- the House
  const houseView = (): HTMLElement => {
    const p = sim.state.persons.get(ctx.playerId());
    const hc = p ? houseCard(sim, p.house) : null;
    if (!hc) return empty('You belong to no House.');
    const elig = eligible();
    const rows = hc.living.map((m) => h('div.mu-li.click', { class: m.id === selected ? 'sel' : '', onclick: () => { selected = m.id; render(); } },
      h('span.mu-fam-sexdot', { class: m.sex }),
      h('div.mu-grow', null, h('b', null, m.name), h('div.mu-small.mu-dim', null, `${m.role} · ${m.age} years old`)),
      m.id === ctx.playerId() ? chip('You', 'lapis') : elig.has(m.id) ? chip('Can be played', 'gold', 'user') : null));
    return h('div.mu-fam-split', null,
      h('div.mu-fam-main', null,
        h('div.mu-row.mu-gap-16.mu-top', { style: { marginBottom: '10px' } },
          shield(hc.heraldry, 76),
          h('div', null,
            h('div.mu-big.mu-bold', null, `House ${hc.name}`),
            h('div.mu-dim.mu-small', null, `${hc.kind[0].toUpperCase()}${hc.kind.slice(1)} · seated at ${hc.seatName || 'no fixed seat'}`),
            h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '6px' } },
              chip(plural(hc.living.length, 'living member'), '', 'users'),
              hc.extinct ? chip('Extinct', 'vermilion', 'skull') : null,
              ...hc.titles.map((t) => chip(t.name, 'gold', 'crown'))))),
        heading('Who is of the House', 'users'),
        h('div.mu-list.mu-scroll', null, rows),
        h('p.mu-tiny.mu-dim', { style: { marginTop: '8px' } }, 'The House is your family line and those sworn to it: servants, retainers, vassals. You may take over family, or House members of equal rank, at any time.')),
      detail(selected));
  };

  // ---------------------------------------------------------------- marriage
  const marriageView = (): HTMLElement => {
    const meP = sim.state.persons.get(ctx.playerId());
    if (!meP) return empty('');
    const social = ctx.social;
    const age = ageYears(meP, sim.absDay);
    const spouse = meP.spouse ? sim.state.persons.get(meP.spouse) : undefined;
    const blocks: HTMLElement[] = [];
    if (spouse && !spouse.death) {
      blocks.push(h('div.mu-card', null, h('div.mu-row.mu-gap-12', null, icon('ring', 26), h('div', null, h('div.mu-big.mu-bold', null, `Married to ${fullName(spouse)}`), h('div.mu-small.mu-dim', null, `${Math.floor(ageYears(spouse, sim.absDay))} years old · ${sim.state.households.get(spouse.household)?.settlement === meP.settlement ? 'under your roof or nearby' : 'living elsewhere'}`)))));
    } else if (age < 14) {
      blocks.push(h('div.mu-card', null, h('p', null, 'You are too young to be courted. Marriage comes after fourteen; for the unfree it also needs the lord’s leave (merchet).')));
    } else {
      const cands = social.matchCandidates(meP.id, 8);
      blocks.push(h('div', null, heading('Who might suit you', 'heart_o'),
        cands.length ? h('div.mu-col.mu-gap-8', null, cands.map((cid) => {
          const cp = sim.state.persons.get(cid);
          if (!cp) return h('span');
          const c = social.courtship(meP.id, cid);
          const prog = c?.progress ?? 0;
          const b = bar('vermilion', prog, { thin: true });
          return h('div.mu-card.mu-cand', null,
            h('div.mu-row.mu-between.mu-top', null,
              h('div', null, h('b', null, fullName(cp)), h('div.mu-small.mu-dim', null, `${Math.floor(ageYears(cp, sim.absDay))} years old · ${RANK_NAMES[cp.rankTier as RankTier]} · ${roleLabel(cp.career, cp.careerStage, cp.sex)}`)),
              h('div.mu-row.mu-gap-6', null,
                button('Talk', { size: 'small', icon: 'talk', onClick: () => { ctx.close(); ctx.player.talkTo(cid); } }),
                button('Propose', { size: 'small', variant: 'primary', icon: 'ring', disabled: prog < 1, tip: prog < 1 ? 'The courtship has not gone far enough' : 'Ask for their hand',
                  onClick: () => { const r = social.propose(meP.id, cid); ctx.say(r.ok ? 'gain' : 'warn', r.ok ? 'You have asked for their hand.' : r.reason ?? 'They will not have you.'); render(); } }))),
            h('div.mu-row.mu-gap-8', { style: { marginTop: '6px' } }, h('span.mu-small.mu-dim', null, 'Courtship'), b.el, h('span.mu-small.mu-num', null, pct(prog))),
            c && c.needsConsentFrom.length ? h('div.mu-small.mu-dim.mu-ital', { style: { marginTop: '4px' } }, `Needs the consent of ${c.needsConsentFrom.map((id) => ctx.nameOf(id)).join(' and ')}`) : null);
        })) : h('p.mu-dim.mu-ital', null, 'No suitable match lives nearby.')));
    }
    // a household head arranges matches for wards
    const hh = sim.state.households.get(meP.household);
    if (hh && hh.head === meP.id) {
      const wards = hh.members.map((id) => sim.state.persons.get(id)).filter((m): m is Person => !!m && !m.death && m.id !== meP.id && !m.spouse && ageYears(m, sim.absDay) >= 14);
      if (wards.length) {
        blocks.push(h('div', null, heading('Arrange a match for your household', 'users'),
          h('div.mu-col.mu-gap-8', null, wards.map((w) => {
            const cands = social.matchCandidates(w.id, 3);
            return h('div.mu-card', null,
              h('b', null, fullName(w)),
              h('div.mu-col.mu-gap-4', { style: { marginTop: '4px' } }, cands.length ? cands.map((cid) => {
                const cp = sim.state.persons.get(cid);
                return h('div.mu-row.mu-between', null,
                  h('span.mu-small', null, cp ? `${fullName(cp)}, ${Math.floor(ageYears(cp, sim.absDay))}` : ''),
                  button('Arrange', { size: 'small', onClick: () => { const r = social.arrangeMatch(meP.id, w.id, cid); ctx.say(r.ok ? 'gain' : 'warn', r.ok ? `A match is arranged for ${w.first}.` : r.reason ?? 'It cannot be arranged.'); render(); } }));
              }) : [h('span.mu-small.mu-dim.mu-ital', null, 'No suitable partner is known.')]));
          }))));
      }
    }
    return h('div.mu-fam-single.mu-scroll', null, blocks.length ? blocks : [empty('Nothing to arrange.')]);
  };

  function render(): void {
    const view = tab === 'tree' ? treeView() : tab === 'household' ? householdView() : tab === 'house' ? houseView() : marriageView();
    replace(content, view);
  }
  render();
  return panelOf({ id: 'family', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
}
