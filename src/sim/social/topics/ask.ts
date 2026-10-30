// "What news?" and "Ask about…": people, places and who there is to marry.
import { dist2 } from '../../../core/math';
import { roleLabel } from '../../careers';
import { marketDayOf } from '../../calendar';
import { kinshipLabel } from '../../api';
import { fullName, type Person, type PersonId } from '../../state';
import { joinNames } from '../util';
import type { DialogueLine, TopicReply } from '../types';
import { chatGain, isTired, iSay, mkOption, npcSays, npcText, seen, type TopicCtx, type TopicGroup } from './kit';
import { interest } from './chat';

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** Compass word for the way from (ax, az) to (bx, bz); north is −z. */
export function compass(ax: number, az: number, bx: number, bz: number): string {
  const ang = Math.atan2(bx - ax, -(bz - az)); // 0 = north, + clockwise
  const idx = Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return DIRS[idx];
}

/** Walking time in words (a person walks about 4.8 km an hour). */
export function walkWord(metres: number): string {
  const minutes = metres / 80;
  if (minutes < 8) return 'a few minutes\' walk';
  if (minutes < 20) return 'a quarter of an hour\'s walk';
  if (minutes < 40) return 'half an hour\'s walk';
  if (minutes < 75) return 'an hour\'s walk';
  if (minutes < 150) return 'two hours\' walk';
  if (minutes < 240) return 'half a day\'s walk';
  return 'a day\'s walk';
}

const ROLE_TAG = (p: Person): string => (p.estate === 'clergy' ? 'cleric' : p.estate === 'noble' ? 'noble' : 'common');

export const askGroup: TopicGroup = {
  prefix: 'ask',

  options(t, out) {
    const { session, core, other, actor } = t;
    if (session.page === 'root') {
      out.push(mkOption('news', 'What news?', 'news', { priority: 85 }));
      out.push(mkOption('nav.ask', 'Ask about…', 'ask', { priority: 80 }));
      return;
    }
    if (session.page !== 'ask') return;
    // people: the lord, priest, reeve, then those they hold opinions of
    const people = knownPeople(t);
    session.scratch.set('ask.people', people.map((p) => p.id));
    people.forEach((p, i) => {
      out.push(mkOption(`ask.person.${p.id}`, `Ask about ${p.first}${roleSuffix(t, p)}`, 'ask', { priority: 70 - i }));
    });
    // places
    for (const n of core.nearby(other.settlement, 5200).slice(0, 3)) {
      out.push(mkOption(`ask.place.${n.id}`, `Ask about ${core.placeName(n.id)}`, 'ask', { priority: 50 - n.id % 3 }));
    }
    if (core.age(actor) >= 14 && !actor.spouse && core.age(other) >= 16) {
      out.push(mkOption('ask.marriageable', 'Ask who there is to marry', 'ask', { priority: 40 }));
    }
  },

  choose(t, option): TopicReply {
    const id = option.id;
    if (id === 'news') return tellNews(t);
    if (id.startsWith('ask.person.')) return aboutPerson(t, Number(id.slice('ask.person.'.length)));
    if (id.startsWith('ask.place.')) return aboutPlace(t, Number(id.slice('ask.place.'.length)));
    if (id === 'ask.marriageable') return aboutMarriageable(t);
    return { lines: [] };
  },
};

// ---------------------------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------------------------

function tellNews(t: TopicCtx): TopicReply {
  const { core, other } = t;
  const lines: DialogueLine[] = iSay(t, 'news.ask');
  if (isTired(t) || seen(t, 'news') > 1) return { lines: [...lines, ...npcSays(t, 'chat.repeat')], reason: 'chat' };
  const items = core.news.tell(other, 2);
  if (items.length === 0) return { lines: [...lines, ...npcSays(t, 'news.none')], opinion: chatGain(t, 0.5, 1), reason: 'chat' };
  lines.push(...npcSays(t, 'news.lead'));
  for (const text of items) lines.push(npcText(t, text, 'neutral'));
  const gain = chatGain(t, 1.1, interest(other, 'news'));
  return { lines, opinion: gain, reason: 'chat', mood: 0.01 };
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

function knownPeople(t: TopicCtx): Person[] {
  const { core, other, actor } = t;
  const sc = core.scene(other.settlement);
  const out: Person[] = [];
  const add = (p: Person | null | undefined): void => {
    if (p && !p.death && p.id !== other.id && p.id !== actor.id && !out.some((q) => q.id === p.id)) out.push(p);
  };
  add(sc.lord); add(sc.priest); add(sc.reeve);
  const entries = Object.keys(other.opinions).map((k) => ({ id: Number(k), v: other.opinions[Number(k)] })).sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || a.id - b.id);
  for (const e of entries) { if (out.length >= 5) break; add(core.person(e.id)); }
  if (out.length < 5) for (const id of core.relations.neighbours(other, 3)) { if (out.length >= 5) break; add(core.person(id)); }
  return out.slice(0, 5);
}

function roleSuffix(t: TopicCtx, p: Person): string {
  const noun = t.core.relations.roleNoun(p);
  return noun ? ` (${noun.replace(/^an? /, '')})` : '';
}

function aboutPerson(t: TopicCtx, id: PersonId): TopicReply {
  const { core, other } = t;
  const lines: DialogueLine[] = [];
  const third = core.person(id);
  if (!third) return { lines: npcSays(t, 'ask.person.unknown') };
  const v = t.npc.vars;
  const pron = third.sex === 'm' ? { he: 'he', his: 'his', him: 'him', hers: 'his' } : { he: 'she', his: 'her', him: 'her', hers: 'hers' };
  v.third = third.first; v.thirdfull = fullName(third); v.he = pron.he; v.his = pron.his; v.him = pron.him;
  v.thirdaddr = core.speech.address(other, third, true);
  v.role = core.relations.roleNoun(third) || 'a neighbour';
  const words = core.speech.tables.traitWords;
  const adj: string[] = [];
  for (const tr of third.traits) { const w = words[tr]; if (w && adj.length < 2) adj.push(w); }
  if (third.rep.generosity >= 15 && adj.length < 3) adj.push(words.generous ?? 'open-handed');
  if (third.rep.cruelty >= 15 && adj.length < 3) adj.push(words.cruel ?? 'hard');
  if (third.rep.piety >= 20 && adj.length < 3) adj.push(words.devout ?? 'devout');
  v.words = adj.length > 0 ? joinNames(adj) : 'much like the rest of us';
  const kin = kinshipLabel(core.state, other, third);
  if (kin) { v.kinword = kin; t.npc.tags.add('third_kin'); }
  if (!core.knows(other, third) && other.opinions[third.id] === undefined) t.npc.tags.add('third_stranger');
  const op = core.opinion.total(other, third);
  t.npc.tags.add(op >= 30 ? 'third_loved' : op >= 10 ? 'third_liked' : op <= -30 ? 'third_hated' : op <= -10 ? 'third_disliked' : 'third_neutral');
  t.npc.tags.add(`third_${ROLE_TAG(third)}`);
  lines.push(...iSay(t, 'ask.person.ask'));
  if (t.npc.tags.has('third_stranger')) {
    lines.push(...npcSays(t, 'ask.person.unknown'));
    return { lines, reason: 'chat' };
  }
  lines.push(...npcSays(t, 'ask.person.reply'));
  lines.push(...npcSays(t, 'ask.person.feel'));
  const gain = chatGain(t, 0.9, 1.1);
  return { lines, opinion: gain, reason: 'chat' };
}

// ---------------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------------

function aboutPlace(t: TopicCtx, sid: number): TopicReply {
  const { core, other } = t;
  const place = core.settlement(sid);
  const home = core.settlement(other.settlement);
  if (!place || !home) return { lines: [...iSay(t, 'ask.place.ask'), ...npcSays(t, 'ask.place.unknown')] };
  const v = t.npc.vars;
  const d = Math.sqrt(dist2(place.x, place.z, home.x, home.z));
  v.there = place.name;
  v.dir = compass(home.x, home.z, place.x, place.z);
  v.walk = walkWord(d);
  v.kind = ({ hamlet: 'hamlet', village: 'village', town: 'market town', city: 'city', castle: 'castle', abbey: 'abbey', priory: 'priory', nunnery: 'nunnery' } as Record<string, string>)[place.kind] ?? 'place';
  const lord = core.scene(sid).lord;
  v.thereLord = lord ? core.speech.titled(lord) : 'its lord';
  if (place.market) { v.marketday = `day ${marketDayOf(sid)} of the week`; t.npc.tags.add('there_market'); }
  t.npc.tags.add(`there_${place.kind}`);
  if (place.kingdom !== home.kingdom) t.npc.tags.add('there_foreign');
  if (place.culture !== home.culture) t.npc.tags.add('there_strange');
  if (core.state.buildingsAt.get(sid)?.some((b) => b.kind === 'watermill' || b.kind === 'windmill')) t.npc.tags.add('there_mill');
  const gain = chatGain(t, 0.9, 1);
  const lines = iSay(t, 'ask.place.ask'); // after the placeholders above are filled in
  const out: DialogueLine[] = [...lines, ...npcSays(t, 'ask.place.reply')];
  const extra = npcSays(t, 'ask.place.more');
  if (extra.length > 0 && t.npc.tags.size > 0) out.push(...extra);
  return { lines: out, opinion: gain, reason: 'chat' };
}

// ---------------------------------------------------------------------------------------------
// Who is there to marry
// ---------------------------------------------------------------------------------------------

function aboutMarriageable(t: TopicCtx): TopicReply {
  const { core, other, actor } = t;
  const lines = iSay(t, 'ask.marriageable.ask');
  const known = core.courtship.matchCandidates(actor.id, 8).filter((id) => {
    const p = core.person(id);
    return !!p && (p.settlement === other.settlement || core.distance(p.settlement, other.settlement) < 3500);
  });
  const names: string[] = [];
  const chosen = known.slice(0, 3);
  for (const id of chosen) {
    const p = core.person(id);
    if (!p) continue;
    const age = Math.floor(core.age(p));
    const bits: string[] = [];
    const role = core.relations.roleNoun(p);
    const place = p.settlement !== other.settlement ? ` of ${core.placeName(p.settlement)}` : '';
    if (p.traits.includes('comely')) bits.push('fair to look on');
    if (p.rep.honour >= 15) bits.push('well spoken of');
    if (p.rep.generosity >= 15) bits.push('open-handed');
    const trade = role || roleLabel(p.career, p.careerStage, p.sex).toLowerCase();
    names.push(`${fullName(p)}${place}, ${age <= 17 ? 'barely grown' : `about ${age}`}${trade && trade !== 'householder' ? `, ${trade.replace(/^an? /, 'a ')}` : ''}${bits.length ? `, ${bits[0]}` : ''}`);
  }
  if (names.length === 0) return { lines: [...lines, ...npcSays(t, 'ask.marriageable.none')], reason: 'chat' };
  t.npc.vars.names = names.join('; ');
  t.npc.vars.first1 = core.person(chosen[0])?.first ?? '';
  const gain = chatGain(t, 0.8, 1);
  return { lines: [...lines, ...npcSays(t, 'ask.marriageable.reply')], opinion: gain, reason: 'chat' };
}

