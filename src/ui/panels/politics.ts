// Realm & politics (action wheel on yourself → "Realm, offices and politics"): where your House stands
// among the others, the letters that reach you, wars and peace, claims, the posts of your place and
// the elections for them, and the management your rank allows (SPEC §7, §15). Sections the player has
// not earned stay locked and say how to unlock them. Everything goes through the politics API.
import { TITLE_RANK, fullName, type HouseId, type Person } from '../../sim/state';
import type { PoliticsRuntime, ProposalKind, WarCause } from '../../sim/politics/types';
import type { Stance } from '../../sim/wave3';
import { h, replace } from '../core/dom';
import { dateText, formatMoney, plural } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { bar, button, chip, empty, heading, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

type Tab = 'standing' | 'houses' | 'wars' | 'claims' | 'offices' | 'manage' | 'petitions';

const STANCE_TONE: Record<Stance, '' | 'gold' | 'lapis' | 'vermilion' | 'green' | 'ink'> = {
  war: 'vermilion', hostile: 'vermilion', neutral: '', truce: 'lapis', trade: 'green', kin: 'gold', alliance: 'green', vassal: 'ink', liege: 'ink',
};
const STANCE_WORD: Record<Stance, string> = {
  war: 'At war', hostile: 'Bitter', neutral: 'No ties', truce: 'Truce', trade: 'Trade', kin: 'Kin by marriage', alliance: 'Allies', vassal: 'Your liege', liege: 'Your vassal',
};
const STEP_LABEL: Partial<Record<ProposalKind, string>> = { truce: 'Propose a truce', trade: 'Open trade', marriage: 'Seek a marriage', alliance: 'Propose an alliance' };
const STEP_ICON: Partial<Record<ProposalKind, IconName>> = { truce: 'hand', trade: 'trade', marriage: 'ring', alliance: 'shield' };
const OFFICE_NAME: Record<string, string> = {
  reeve: 'Reeve', bailiff: 'Bailiff', steward: 'Steward', sheriff: 'Sheriff', marshal: 'Marshal', chancellor: 'Chancellor', warden: 'Guild warden', alderman: 'Alderman', mayor: 'Mayor',
};
const CAUSE_LABEL: Record<WarCause, string> = {
  claim: 'press a claim', conquest: 'conquer', independence: 'throw off the oath', punitive: 'punish a vassal', raid: 'raid', submission: 'force homage', coalition: 'league war',
};

export function politicsRuntime(ctx: PanelCtx): PoliticsRuntime | null {
  const api = ctx.sim.services.politics as unknown;
  return api && typeof (api as { actors?: unknown }).actors === 'function' ? (api as PoliticsRuntime) : null;
}

export function politicsPanel(ctx: PanelCtx, startTab: Tab | undefined): UiPanel {
  const sim = ctx.sim;
  const rt = politicsRuntime(ctx);
  const win = createWindow({ title: 'Realm and politics', subtitle: 'Houses, wars, claims, offices and what you may command', icon: 'crown', size: 'xl', tall: true, onClose: () => ctx.close() });
  const content = h('div.mu-ledger');
  win.body.classList.add('flush');
  if (!rt) {
    win.body.append(h('div.mu-ledger-scroll.mu-scroll', null, empty('No politics is being played in this run.')));
    return panelOf({ id: 'politics', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
  }
  const api: PoliticsRuntime = rt;
  let tab: Tab = startTab ?? 'standing';
  const tabsEl = tabs([
    { id: 'standing', label: 'Standing', icon: 'crown' },
    { id: 'houses', label: 'Houses', icon: 'shield' },
    { id: 'wars', label: 'Wars', icon: 'swords' },
    { id: 'claims', label: 'Claims', icon: 'scroll' },
    { id: 'offices', label: 'Offices', icon: 'key' },
    { id: 'manage', label: 'Command', icon: 'ledger' },
    { id: 'petitions', label: 'Petitions', icon: 'quill' },
  ], tab, (id) => { tab = id as Tab; tabsEl.set(tab); render(); });
  win.body.append(tabsEl.el, h('div.mu-tabbar-rule'), content);

  const me = (): Person => sim.state.persons.get(ctx.playerId()) as Person;
  const myHouse = (): HouseId => me().house;
  const houseName = (id: HouseId): string => sim.state.houses.get(id)?.name ?? '?';
  const say = (ok: boolean, good: string, bad?: string): void => ctx.say(ok ? 'gain' : 'warn', ok ? good : bad ?? 'It cannot be done.');
  const scroll = (...kids: Array<HTMLElement | null>): HTMLElement => h('div.mu-ledger-scroll.mu-scroll', null, kids);
  const lock = (text: string): HTMLElement => h('div.mu-rule-note', { style: { marginBottom: '10px' } }, icon('lock', 15), h('span', null, text));

  // ---------------------------------------------------------------- standing
  const standing = (): HTMLElement => {
    const hv = api.houseView(myHouse());
    const letters = api.inbox().filter((p) => p.to === myHouse());
    const cards: HTMLElement[] = [];
    if (!hv) {
      return scroll(
        lock('Your House holds no title. Land makes a House a power: win a manor, a barony, a county or the crown and the others will notice you — as friends, and as prey.'),
        letters.length ? heading('Letters', 'quill') : null,
        letters.length ? lettersView(letters) : null,
      );
    }
    const liege = hv.liege ? api.houseView(hv.liege) : null;
    cards.push(h('div.mu-card', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Your House'), h('div.mu-bold', null, `House ${hv.name}`),
      h('div.mu-small.mu-dim', null, hv.titles.length ? hv.titles.map((t) => t.name).join(' · ') : 'No title')));
    cards.push(h('div.mu-card', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Overlord'), h('div.mu-bold', null, liege ? `House ${liege.name}` : 'None: you answer to no one'),
      h('div.mu-small.mu-dim', null, liege ? `${liege.headName} · strength ${liege.strength}` : `${plural(hv.vassals, 'vassal House')} swear to you`)));
    cards.push(h('div.mu-card', null, h('div.mu-tiny.mu-dim.mu-caps', null, 'Strength'), h('div.mu-bold', null, `${hv.strength} men`),
      h('div.mu-small.mu-dim', null, `${Math.round(api.realmShare(myHouse()))}% of all the strength in the land`)));
    const wars = api.warsOf(myHouse());
    const co = api.coalitions().filter((c) => c.target === myHouse() || c.target === api.realmLeader(myHouse()));
    const notes: HTMLElement[] = [];
    if (wars.length) notes.push(h('div.mu-rule-note', null, icon('swords', 15), h('span', null, `${plural(wars.length, 'war')} under way — see the Wars page.`)));
    for (const c of co) notes.push(h('div.mu-rule-note', null, icon('warning', 15), h('span', null, `${plural(c.members.length, 'House')} have leagued against ${c.target === myHouse() ? 'you' : `your realm`}: ${c.members.slice(0, 4).map((m) => `House ${houseName(m)}`).join(', ')}.`)));
    const stats = api.stats();
    return scroll(
      h('div.mu-grid.c3', null, cards),
      h('div', { style: { display: 'grid', gap: '8px', margin: '12px 0' } }, notes),
      letters.length ? heading('Letters', 'quill') : null,
      letters.length ? lettersView(letters) : h('p.mu-dim.mu-ital', null, 'No letters wait for an answer.'),
      heading('The great Houses', 'crown'),
      greatHouses(),
      h('p.mu-tiny.mu-dim', { style: { marginTop: '8px' } }, `Since the start: ${plural(stats.warsDeclared, 'war')}, ${plural(stats.titlesMoved, 'title')} changed hands, ${plural(stats.revolts, 'peasant revolt')}.`),
    );
  };

  const greatHouses = (): HTMLElement => {
    const top = api.actors().filter((a) => api.realmLeader(a) === a).slice(0, 8);
    return h('div.mu-list', null, top.map((a) => {
      const v = api.houseView(a, myHouse());
      if (!v) return h('span');
      const st = v.isPlayer ? 'You' : STANCE_WORD[v.stance];
      return h('div.mu-li', null,
        h('div.mu-grow', null, h('b', null, `House ${v.name}`), h('div.mu-small.mu-dim', null, `${v.headName} · ${v.titles[0]?.name ?? ''} · ${plural(v.vassals, 'vassal House')}`)),
        h('span.mu-small.mu-dim', null, `strength ${v.strength}`), chip(st, v.isPlayer ? 'gold' : STANCE_TONE[v.stance]), v.atWar ? chip('at war', 'vermilion', 'swords') : null);
    }));
  };

  const lettersView = (letters: readonly { id: number; text: string; kind: ProposalKind | 'peace'; expires: number }[]): HTMLElement => h('div.mu-list', null, letters.map((p) => h('div.mu-li', null,
    h('div.mu-grow', null, h('b', null, p.text), h('div.mu-small.mu-dim', null, `Answer by ${dateText(p.expires)}`)),
    button(p.kind === 'submit' ? 'Kneel' : 'Accept', { size: 'small', variant: p.kind === 'submit' ? 'danger' : 'primary', icon: 'check', onClick: () => { const r = api.answer(p.id, true); say(r.ok, 'Agreed.', r.reason); render(); } }),
    button(p.kind === 'submit' ? 'Defy' : 'Decline', { size: 'small', icon: 'cross', onClick: () => { api.answer(p.id, false); ctx.say('info', 'You decline.'); render(); } }))));

  // ---------------------------------------------------------------- houses
  const housesView = (): HTMLElement => {
    const mine = myHouse();
    const isActor = !!api.houseView(mine)?.titles.length;
    if (!isActor) return scroll(lock('Only a House that holds land treats with other Houses. Win a manor and the doors of the great will open.'));
    const leaders = api.actors().filter((a) => api.realmLeader(a) === a && a !== mine);
    const seen = new Set<HouseId>();
    const near = [...api.neighbours(mine), ...leaders].filter((o) => {
      const st = api.stance(mine, o);
      if (seen.has(o) || st === 'vassal' || st === 'liege') return false;
      seen.add(o);
      return true;
    }).slice(0, 14);
    const mineVassals = api.vassalsOf(mine).length;
    const rows = near.map((o) => {
      const v = api.houseView(o, mine);
      if (!v) return h('span');
      const step = api.ladderStep(mine, o);
      const actions: HTMLElement[] = [];
      if (step) {
        const chance = api.acceptChance(mine, o, step);
        actions.push(button(STEP_LABEL[step] ?? step, { size: 'small', variant: 'primary', icon: STEP_ICON[step] ?? 'hand', tip: `They agree about ${Math.round(chance * 100)} times in a hundred`,
          onClick: () => { const r = api.propose(mine, o, step); say(r.ok, r.reason === 'sent' ? 'Your letter is sent.' : 'Agreed.', r.reason); render(); } }));
      }
      const claimCause: WarCause = api.claimsOf(mine).some((c) => v.titles.some((t) => t.id === c.title)) ? 'claim' : 'conquest';
      const legal = api.canDeclare(mine, o, claimCause);
      actions.push(button('War', { size: 'small', variant: 'danger', icon: 'swords', disabled: !legal.ok, tip: legal.ok ? `Make war to ${CAUSE_LABEL[claimCause]}` : legal.reason,
        onClick: () => ctx.confirm({ title: 'Declare war', text: `Make war on House ${v.name} to ${CAUSE_LABEL[claimCause]}? Their allies and overlord will answer, and your people will pay for it.`, confirmLabel: 'Declare war', danger: true, onConfirm: () => { const r = api.declareWar(mine, o, { cause: claimCause }); say(r.ok, 'War!', r.reason); render(); } }) }));
      return h('div.mu-li', null,
        h('div.mu-grow', null, h('b', null, `House ${v.name}`), h('div.mu-small.mu-dim', null, `${v.headName} · ${v.titles[0]?.name ?? ''} · strength ${v.strength}${v.pacts.length ? ` · ${v.pacts.join(', ')}` : ''}`)),
        chip(STANCE_WORD[v.stance], STANCE_TONE[v.stance]), ...actions);
    });
    return scroll(heading('Neighbours, kin and rival realms', 'shield'), rows.length ? h('div.mu-list', null, rows) : empty('No other House lies within reach.'),
      mineVassals ? h('p.mu-small.mu-dim', { style: { marginTop: '8px' } }, `${plural(mineVassals, 'vassal House')} swear to you; they follow you to war and bring their levies.`) : null,
      h('p.mu-tiny.mu-dim', { style: { marginTop: '8px' } }, 'The ladder: contact, truce, trade, marriage ties, alliance — then union by inheritance, or conquest and vassalage.'));
  };

  // ---------------------------------------------------------------- wars
  const warsView = (): HTMLElement => {
    const mine = myHouse();
    const wars = api.wars().slice().sort((a, b) => Number(b.attackers.includes(mine) || b.defenders.includes(mine)) - Number(a.attackers.includes(mine) || a.defenders.includes(mine)) || a.id - b.id);
    if (!wars.length) return scroll(empty('The land is at peace.'), historyView());
    const rows = wars.slice(0, 10).map((w) => {
      const side = w.attackers.includes(mine) ? 'attackers' : w.defenders.includes(mine) ? 'defenders' : null;
      const goal = sim.state.titles.get(w.goal);
      const opts = side ? api.peaceOptions(w.id, side) : [];
      const b = bar(w.score >= 0 ? 'vermilion' : 'lapis', Math.abs(w.score) / 100, { thin: true });
      return h('div.mu-card', null,
        h('div.mu-row.mu-between.mu-top', null,
          h('h4', null, `House ${houseName(w.attackers[0])} against House ${houseName(w.defenders[0])}`),
          chip(goal ? goal.name : 'a raid', 'gold', 'castle')),
        h('div.mu-small.mu-dim', null, `${plural(w.attackers.length, 'House')} against ${plural(w.defenders.length, 'House')} · since ${dateText(w.since)} · ${w.score >= 0 ? 'the attackers lead' : 'the defenders lead'} (${Math.abs(w.score)})`),
        b.el,
        side ? h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '8px' } }, opts.map((o) => button(`${o.label} (${Math.round(o.chance * 100)}%)`, { size: 'small', variant: o.terms === 'white' ? '' : 'primary',
          onClick: () => { const r = api.makePeace(w.id, side, o.terms); say(r.ok, 'Peace is made.', r.reason); render(); } }))) : null);
    });
    return scroll(heading('Wars', 'swords'), h('div.mu-grid.c2', null, rows), historyView());
  };

  const historyView = (): HTMLElement => {
    const hist = api.history().slice(-6).reverse();
    if (!hist.length) return h('span');
    return h('div', { style: { marginTop: '14px' } }, heading('Recent peace', 'scroll'), h('div.mu-list', null, hist.map((x) => h('div.mu-li', null,
      h('div.mu-grow', null, `House ${houseName(x.attackers[0])} and House ${houseName(x.defenders[0])}`),
      h('span.mu-small.mu-dim', null, `${x.winner === 'white_peace' ? 'white peace' : x.winner === 'attackers' ? 'attackers won' : 'defenders won'} · ${x.terms}`),
      h('span.mu-small.mu-dim', null, dateText(x.end))))));
  };

  // ---------------------------------------------------------------- claims
  const claimsView = (): HTMLElement => {
    const mine = myHouse();
    const my = api.claimsOf(mine);
    const mineTitles = api.houseView(mine)?.titles ?? [];
    const against = mineTitles.flatMap((t) => api.claimsOn(t.id).map((c) => ({ c, t })));
    const strengthWord = (n: number): string => (n >= 3 ? 'strong' : n === 2 ? 'fair' : 'weak');
    const rowsMy = my.map((c) => {
      const t = sim.state.titles.get(c.title);
      const holder = t ? sim.state.persons.get(t.holder) : undefined;
      const target = holder?.house ?? 0;
      const legal = target ? api.canDeclare(mine, target, 'claim') : { ok: false, reason: 'No holder.' };
      return h('div.mu-li', null,
        h('div.mu-grow', null, h('b', null, t?.name ?? '?'), h('div.mu-small.mu-dim', null, `held by ${holder ? fullName(holder) : 'no one'} · by ${c.kind === 'marriage' ? 'marriage' : c.kind === 'deposed' ? 'a title lost' : 'blood'} through ${ctx.nameOf(c.person)}`)),
        chip(`${strengthWord(c.strength)} claim`, c.strength >= 3 ? 'gold' : ''),
        button('Press it', { size: 'small', variant: 'danger', icon: 'swords', disabled: !legal.ok, tip: legal.ok ? undefined : legal.reason,
          onClick: () => ctx.confirm({ title: 'Press your claim', text: `Go to war for ${t?.name}?`, confirmLabel: 'Declare war', danger: true, onConfirm: () => { const r = api.declareWar(mine, target, { cause: 'claim', goal: c.title, claimant: c.person }); say(r.ok, 'War!', r.reason); render(); } }) }));
    });
    const rowsAgainst = against.map(({ c, t }) => h('div.mu-li', null,
      h('div.mu-grow', null, h('b', null, `House ${houseName(c.house)} on ${t.name}`), h('div.mu-small.mu-dim', null, `through ${ctx.nameOf(c.person)} · by ${c.kind === 'marriage' ? 'marriage' : c.kind === 'deposed' ? 'a title lost' : 'blood'}`)),
      chip(`${strengthWord(c.strength)} claim`, c.strength >= 3 ? 'vermilion' : '')));
    return scroll(
      heading('Your claims on others', 'scroll'), rowsMy.length ? h('div.mu-list', null, rowsMy) : h('p.mu-dim.mu-ital', null, 'You press no claim. Claims come by blood and by marriage: a daughter wed into a House, a title lost.'),
      heading('Claims on your titles', 'shield'), rowsAgainst.length ? h('div.mu-list', null, rowsAgainst) : h('p.mu-dim.mu-ital', null, 'No House has a claim on you — yet.'));
  };

  // ---------------------------------------------------------------- offices
  const officesView = (): HTMLElement => {
    const p = me();
    const seats = api.officeSeats(p.settlement);
    const elections = api.elections();
    const rows = seats.map((s) => {
      const holder = s.holder ? sim.state.persons.get(s.holder) : undefined;
      const label = OFFICE_NAME[s.office] ?? s.office;
      const mineSeat = s.holder === p.id;
      const actions: HTMLElement[] = [];
      if (s.mode === 'elected') {
        const e = elections.find((x) => x.office === s.office && x.place === s.place);
        const standing = !!e?.candidates.find((c) => c.you);
        const can = api.canStand(p.id, s.office, s.place);
        const cy = standing;
        if (cy) {
          actions.push(button('Give ale (6d)', { size: 'small', icon: 'cup', tip: 'A little generosity moves votes — and invites talk', onClick: () => { const r = api.bribe(p.id, s.office, s.place, 6); say(r.ok, 'The ale flows; the electors remember.', r.reason); render(); } }));
          actions.push(button('Withdraw', { size: 'small', onClick: () => { api.withdraw(p.id, s.office, s.place); render(); } }));
        } else actions.push(button('Stand for it', { size: 'small', variant: 'primary', icon: 'hand', disabled: !can.ok, tip: can.ok ? undefined : can.reason, onClick: () => { const r = api.stand(p.id, s.office, s.place); say(r.ok, 'You are a candidate.', r.reason); render(); } }));
      } else if (s.patron === p.id) {
        // the lord names the holder himself
        const e2 = elections.find((x) => x.office === s.office && x.place === s.place);
        for (const c of (e2?.candidates ?? []).filter((x) => !x.you && x.person !== s.holder).slice(0, 3)) {
          actions.push(button(`Appoint ${c.name.split(' ')[0]}`, { size: 'small', variant: 'primary', icon: 'key',
            onClick: () => { const r = api.appoint(p.id, s.office, s.place, c.person); say(r.ok, `${c.name} is appointed.`, r.reason); render(); } }));
        }
      } else if (!s.holder || s.holder !== p.id) {
        const chance = s.holder ? 0 : api.petitionChance(p.id, s.office, s.place);
        actions.push(button('Petition the lord', { size: 'small', variant: 'primary', icon: 'quill', disabled: !!s.holder || chance <= 0, tip: s.holder ? 'The post is filled' : `About ${Math.round(chance * 100)} in a hundred`,
          onClick: () => { const r = api.petitionOffice(p.id, s.office, s.place); say(r.ok, 'The post is yours!', r.reason); render(); } }));
      }
      const e = elections.find((x) => x.office === s.office && x.place === s.place);
      return h('div.mu-li', null,
        h('div.mu-grow', null, h('b', null, `${label} of ${s.placeName}`),
          h('div.mu-small.mu-dim', null, `${holder ? (mineSeat ? 'you hold it' : fullName(holder)) : 'vacant'} · ${s.mode === 'elected' ? 'chosen by the electors' : s.patron ? `given by ${ctx.nameOf(s.patron)}` : 'no patron'} · ${s.mode === 'elected' ? 'vote' : 'review'} ${dateText(s.next)}`),
          e && e.candidates.length ? h('div.mu-tiny.mu-dim', null, `${s.mode === 'elected' ? 'Candidates (votes if held today)' : 'Fit for the post'}: ${e.candidates.map((c) => `${c.you ? 'you' : c.name}${s.mode === 'elected' ? ` (${c.standing})` : ''}`).join(', ')}`) : null),
        mineSeat ? chip('yours', 'green', 'check') : null, ...actions);
    });
    const held = p.offices.filter((o) => OFFICE_NAME[o.office]);
    return scroll(
      held.length ? h('div.mu-rule-note', { style: { marginBottom: '10px' } }, icon('key', 15), h('span', null, `You hold: ${held.map((o) => `${OFFICE_NAME[o.office]} of ${ctx.placeName(o.place)}`).join(', ')}.`)) : null,
      heading(`Posts of ${ctx.placeName(p.settlement)}`, 'key'),
      rows.length ? h('div.mu-list', null, rows) : empty('No posts are filled here.'),
      h('p.mu-tiny.mu-dim', { style: { marginTop: '8px' } }, 'Reeves are chosen yearly — elected by the villagers in some manors, named by the lord in others. Votes follow opinion: be liked, canvass in conversation, or pay for the ale.'));
  };

  // ---------------------------------------------------------------- command (management by authority)
  const manageView = (): HTMLElement => {
    const p = me();
    const a = api.authority(p.id);
    const blocks: HTMLElement[] = [];
    // manor
    if (a.manors.length) {
      for (const tid of a.manors.slice(0, 4)) {
        const t = sim.state.titles.get(tid);
        if (!t || t.kind === 'abbey') continue;
        const place = t.place;
        const pol = api.manorPolicy(place);
        const u = api.unrest(place);
        const sel = (label: string, value: number, set: (v: -1 | 0 | 1 | 2) => void): HTMLElement => {
          const s = h<HTMLSelectElement>('select.mu-input', { 'aria-label': label },
            [[-1, 'Relief'], [0, 'Customary'], [1, 'Heavy'], [2, 'Harsh']].map(([v, l]) => h('option', { value: String(v), selected: v === value }, String(l))));
          s.addEventListener('change', () => { set(Number(s.value) as -1 | 0 | 1 | 2); });
          return h('label.mu-row.mu-gap-8', null, h('span.mu-small', { style: { width: '120px' } }, label), s);
        };
        const justice = h<HTMLSelectElement>('select.mu-input', { 'aria-label': 'Justice' }, [['lenient', 'Lenient'], ['fair', 'Fair'], ['harsh', 'Harsh']].map(([v, l]) => h('option', { value: v, selected: v === pol.justice }, l)));
        justice.addEventListener('change', () => { const r = api.setManorPolicy(p.id, place, { justice: justice.value as 'lenient' | 'fair' | 'harsh' }); say(r.ok, 'Justice is set.', r.reason); render(); });
        const apply = (change: Partial<{ rent: -1 | 0 | 1 | 2; labour: -1 | 0 | 1 | 2 }>): void => { const r = api.setManorPolicy(p.id, place, change); say(r.ok, 'It is ordered.', r.reason); render(); };
        const ub = bar(u > 60 ? 'vermilion' : u > 30 ? 'gold' : 'green', u / 100, { thin: true });
        blocks.push(h('div.mu-card', null,
          h('div.mu-row.mu-between.mu-top', null, h('h4', null, `Manor of ${ctx.placeName(place)}`), chip(`unrest ${Math.round(u)}`, u > 60 ? 'vermilion' : u > 30 ? 'gold' : 'green', 'warning')), ub.el,
          h('div', { style: { display: 'grid', gap: '6px', marginTop: '8px' } },
            sel('Rents and dues', pol.rent, (v) => apply({ rent: v })), sel('Labour services', pol.labour, (v) => apply({ labour: v })),
            h('label.mu-row.mu-gap-8', null, h('span.mu-small', { style: { width: '120px' } }, 'Local justice'), justice)),
          h('p.mu-tiny.mu-dim', { style: { marginTop: '6px' } }, 'Harsh dues enrich you and stir the villagers; famine and cruelty do the rest. A village that rises may force terms — or hang for it.')));
      }
    } else blocks.push(lock('Manor: villagers’ work, rents and dues, local justice. Unlocked by: hold a manor as a knight.'));
    // barony
    if (a.baronies.length || a.counties.length || a.kingdoms.length) {
      const vassalTitles = [...sim.state.titles.values()].filter((t) => { const above = t.liege ? sim.state.titles.get(t.liege) : undefined; return above && above.holder === p.id && t.holder !== p.id; }).slice(0, 8);
      blocks.push(h('div.mu-card', null, h('h4', null, 'Vassals'),
        vassalTitles.length ? h('div.mu-list', null, vassalTitles.map((t) => {
          const holder = sim.state.persons.get(t.holder);
          return h('div.mu-li', null, h('div.mu-grow', null, h('b', null, t.name), h('div.mu-small.mu-dim', null, holder ? `held by ${fullName(holder)}` : 'vacant')),
            button('Revoke', { size: 'small', variant: 'danger', icon: 'cross', disabled: t.kind === 'county' || t.kind === 'kingdom', tip: 'Strip him of the fief. His kin will remember.',
              onClick: () => ctx.confirm({ title: 'Revoke a fief', text: `Take ${t.name} from ${holder ? fullName(holder) : 'its holder'}? Your other vassals will take note.`, confirmLabel: 'Revoke', danger: true, onConfirm: () => { const r = api.revokeTitle(p.id, t.id); say(r.ok, 'The fief is yours again.', r.reason); render(); } }) }));
        })) : h('p.mu-dim.mu-ital', null, 'No one holds land from you yet.'),
        h('p.mu-tiny.mu-dim', null, 'Barons and earls keep vassal knights, levies, alliances and — where the law allows — private war. Grant fiefs through conversation with a worthy knight.')));
    } else blocks.push(lock('Barony and county: vassal knights, levies, alliances and private war. Unlocked by: hold a barony or a county.'));
    // realm
    if (a.kingdoms.length) {
      for (const tid of a.kingdoms) {
        const t = sim.state.titles.get(tid);
        if (!t) continue;
        const laws = api.realmLaws(t.place);
        const tax = h<HTMLSelectElement>('select.mu-input', { 'aria-label': 'Tax' }, [[0, 'None'], [1, 'Light'], [2, 'Standard'], [3, 'Heavy']].map(([v, l]) => h('option', { value: String(v), selected: v === laws.tax }, String(l))));
        tax.addEventListener('change', () => { const r = api.setRealmLaw(p.id, t.place, { tax: Number(tax.value) as 0 | 1 | 2 | 3 }); say(r.ok, 'The tax is set.', r.reason); render(); });
        blocks.push(h('div.mu-card', null, h('h4', null, t.name),
          h('div', { style: { display: 'grid', gap: '6px' } },
            h('label.mu-row.mu-gap-8', null, h('span.mu-small', { style: { width: '160px' } }, 'Private war'),
              button(laws.privateWar ? 'Allowed' : 'Forbidden', { size: 'small', variant: laws.privateWar ? 'danger' : 'primary', onClick: () => { const r = api.setRealmLaw(p.id, t.place, { privateWar: !laws.privateWar }); say(r.ok, 'The law is changed.', r.reason); render(); } })),
            h('label.mu-row.mu-gap-8', null, h('span.mu-small', { style: { width: '160px' } }, 'Taxes and aids'), tax)),
          h('p.mu-tiny.mu-dim', { style: { marginTop: '6px' } }, 'A crown that forbids private war keeps its barons at heel — and a baron who has leave to fight will. Taxes feed your treasury and your vassals’ discontent.')));
      }
    } else blocks.push(lock('Realm: laws, taxes, offices, war and peace. Unlocked by: wear the crown.'));
    return scroll(h('p.mu-small.mu-ink2', { style: { margin: '0 0 10px' } }, 'You command exactly what your titles give you; everyone else decides by their own character.'), h('div.mu-grid.c2', null, blocks));
  };

  // ---------------------------------------------------------------- petitions
  const petitionsView = (): HTMLElement => {
    const list = api.petitions(ctx.playerId());
    if (!list.length) return scroll(empty('No one waits at your door. Lords hear petitions from their villagers; hold a manor and they will come.'));
    return scroll(heading('Petitions', 'quill'), h('div.mu-list', null, list.map((pt) => h('div.mu-li', null,
      h('div.mu-grow', null, h('b', null, pt.text), h('div.mu-small.mu-dim', null, `${ctx.placeName(pt.place)} · asked ${dateText(pt.day)}${pt.amount ? ` · ${formatMoney(pt.amount)} at stake` : ''}`)),
      button('Grant', { size: 'small', variant: 'primary', icon: 'check', onClick: () => { const r = api.resolvePetition(pt.id, 'grant'); say(r.ok, 'Granted.', r.reason); render(); } }),
      button('Compromise', { size: 'small', icon: 'hand', onClick: () => { const r = api.resolvePetition(pt.id, 'compromise'); say(r.ok, 'A middle way is found.', r.reason); render(); } }),
      button('Refuse', { size: 'small', variant: 'danger', icon: 'cross', onClick: () => { const r = api.resolvePetition(pt.id, 'refuse'); say(r.ok, 'Refused.', r.reason); render(); } })))));
  };

  function render(): void {
    const view = tab === 'standing' ? standing() : tab === 'houses' ? housesView() : tab === 'wars' ? warsView() : tab === 'claims' ? claimsView()
      : tab === 'offices' ? officesView() : tab === 'manage' ? manageView() : petitionsView();
    replace(content, view);
    const n = api.petitions(ctx.playerId()).length;
    tabsEl.badge('petitions', n);
    tabsEl.badge('standing', api.inbox().filter((x) => x.to === myHouse()).length);
  }
  for (const ev of ['war', 'stance', 'office', 'request'] as const) ctx.listen(ev, () => render());
  render();
  void TITLE_RANK;
  return panelOf({ id: 'politics', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
}

registerPanel('politics', (ctx, req) => politicsPanel(ctx, (req.data as { tab?: Tab } | undefined)?.tab));
