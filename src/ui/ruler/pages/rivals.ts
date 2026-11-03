// Rivals: every House near you — strength, growth this year (buildings, techniques, troops), stance and a threat reading — and their
// news ("Avenbourg's masons are raising a curtain wall", "Lord Ralph has hired 60 crossbowmen") (CIV §6.8, §10).
import { bar, button, chip, empty, heading } from '../../components/widgets';
import { h } from '../../core/dom';
import { icon } from '../../core/icons';
import { dateText } from '../../core/format';
import { ruleOffer } from '../ruleTown';
import { growthWords, kmText, newsFor, NEWS_ICON, sortRivals, STANCE_WORDS, stanceTone, threatWords } from '../rulerModel';
import { line, type RulerEnv } from '../rulerUi';
import { planAttackButton } from './military';

interface Bag { selected: number }

export function buildRivals(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const sim = ctx.sim;
  const bag = env.state<Bag>('rivals', () => ({ selected: 0 }));
  const rivals = sortRivals(realm.rivals(me));
  const wrap = h('div.mu-rul-page.mu-rul-rivals');
  if (!rivals.length) return empty('No other House holds land within thirty kilometres.', { icon: 'shield', title: 'No rivals near' });
  if (!rivals.some((r) => r.house === bag.selected)) bag.selected = rivals[0].house;
  const news = realm.news(160);
  const maxStrength = Math.max(1, ...rivals.map((r) => r.strength));

  const list = h('div.mu-rul-rlist', null, rivals.map((r) => {
    const t = threatWords(r.threat);
    const row = h('div.mu-rul-rrow2', { class: r.house === bag.selected ? 'sel' : '' },
      h('div.mu-row.mu-between.mu-gap-8', null, h('b', null, `House ${r.name}`), chip(t.word, t.tone)),
      h('div.mu-tiny.mu-dim', null, `${r.head ? ctx.nameOf(r.head) : ''}${r.seat !== undefined ? ` · seat ${ctx.placeName(r.seat)}` : ''} · ${kmText(r.distance)} away`),
      h('div.mu-row.mu-gap-8', { style: { marginTop: '4px' } }, h('div.mu-grow', null, bar('vermilion', r.strength / maxStrength, { thin: true }).el), h('span.mu-tiny.mu-num', null, `strength ${Math.round(r.strength)}`)),
      h('div.mu-row.mu-between.mu-gap-8', { style: { marginTop: '3px' } }, h('span.mu-tiny.mu-ink2', null, growthWords(r)), chip(STANCE_WORDS[r.stance] ?? r.stance, stanceTone(r.stance))));
    row.addEventListener('click', () => { bag.selected = r.house; env.refresh(); });
    return row;
  }));

  const r = rivals.find((x) => x.house === bag.selected)!;
  const t = threatWords(r.threat);
  const theirs = newsFor(news, r.house, 14);
  const house = sim.state.houses.get(r.house);
  const offer = r.seat !== undefined ? ruleOffer(ctx.game, r.seat) : null;
  const detail = h('div.mu-card.mu-rul-rdetail', null,
    h('div.mu-row.mu-between.mu-top', null, h('div', null, h('h4', null, `House ${r.name}`), h('div.mu-small.mu-dim', null, house ? `${house.kind} · rooted at ${ctx.placeName(house.seat)}` : '')),
      h('div.mu-row.mu-gap-6', null, chip(t.word, t.tone, 'warning'), chip(STANCE_WORDS[r.stance] ?? r.stance, stanceTone(r.stance)))),
    h('div.mu-grid.c3', { style: { margin: '10px 0' } },
      stat('Strength', Math.round(r.strength).toLocaleString('en-GB'), r.share !== undefined ? `${Math.round(r.share * 100)}% of the continent’s` : ''),
      stat('Places held', r.settlements ?? '?', r.seat !== undefined ? `seat ${ctx.placeName(r.seat)}` : ''),
      stat('This year', growthWords(r), 'buildings, techniques, men')),
    h('div.mu-tiny.mu-dim.mu-caps', null, 'Threat to you'), bar(t.tone === 'vermilion' ? 'vermilion' : t.tone === 'gold' ? 'gold' : 'green', r.threat).el,
    h('div.mu-small.mu-ink2', { style: { margin: '4px 0 10px' } }, `${Math.round(r.threat * 100)} in a hundred: stance, nearness and strength against yours, and what they have been building.`),
    h('div.mu-row.mu-gap-6.mu-wrap', null,
      button('Treat with them', { icon: 'hand', variant: 'primary', onClick: () => ctx.open({ panel: 'ext', name: 'politics', data: { tab: 'houses' } }) }),
      r.seat !== undefined ? button('Show their seat', { icon: 'pin', onClick: () => { const s = sim.world.settlements.find((x) => x.id === r.seat); if (s) { ctx.pins.set({ x: s.x, z: s.z, label: ctx.placeName(s.id) }); ctx.say('info', `${ctx.placeName(s.id)} is marked on your compass.`); } } }) : null,
      (r.stance === 'hostile' || r.stance === 'war') && r.seat !== undefined ? planAttackButton(env, r.seat, `House ${r.name}`) : null,
      offer ? button(offer.label, { icon: 'crown', tip: offer.tip, onClick: () => { ctx.close(); ctx.open(offer.request); } }) : null),
    heading('What they have been doing', 'scroll'),
    theirs.length ? h('div.mu-col.mu-gap-6', null, theirs.map((n) => h('div.mu-rul-news', { class: n.threat >= 0.5 ? 'hot' : '' }, icon(NEWS_ICON[n.kind] ?? 'scroll', 15),
      h('div.mu-grow', null, h('div.mu-small', null, n.text), h('div.mu-tiny.mu-dim', null, `${dateText(n.day)} · ${ctx.placeName(n.settlement)}`))))) : line('Nothing is reported of them yet.'));

  wrap.append(h('div.mu-rul-rcols', null, list, detail));
  return wrap;
}

function stat(label: string, value: string | number, sub: string): HTMLElement {
  return h('div', null, h('div.mu-tiny.mu-dim.mu-caps', null, label), h('div.mu-bold', null, String(value)), sub ? h('div.mu-tiny.mu-dim', null, sub) : null);
}
