// News and rivals (docs/CIV.md §6.8, §10): what neighbours and rivals do - raise walls, work out techniques, hire troops, march
// armies, make war and peace, starve - kept in a ring buffer with a threat reading for the player's House, and a rolling count
// of each House's year (buildings raised, techniques gained, men recruited).
import { dist } from '../../core/math';
import { DAYS_PER_YEAR } from '../../core/time';
import type { HouseId, PersonId } from '../state';
import { NEWS } from './config';
import { scopeOf, titleAtSettlement, titlePlace } from './rule';
import type { Rlm } from './store';
import type { NewsItem, NewsKind, RivalView } from './types';

export interface NewsDraft {
  kind: NewsKind;
  house: HouseId;
  settlement: number;
  text: string;
  /** How much this kind of thing matters to a neighbour's safety, 0..1 (an army on the march 0.9, a new barn 0.1). */
  weight: number;
  tech?: string;
}

// ---------------------------------------------------------------------------------------------
// Counters: a House's year, rolling
// ---------------------------------------------------------------------------------------------

/** 0 = buildings raised, 1 = techniques gained, 2 = men recruited. */
export function bump(R: Rlm, house: HouseId, which: 0 | 1 | 2, n = 1): void {
  if (!house) return;
  const key = String(house);
  let c = R.data.ctr[key];
  if (!c) { c = [0, 0, 0, 0, 0, 0]; R.data.ctr[key] = c; }
  c[which] += n;
  R.touch();
}

/** This year so far plus the part of last year that still falls in the last 16 days. */
export function yearCounts(R: Rlm, house: HouseId): { built: number; techs: number; recruited: number } {
  const c = R.data.ctr[String(house)];
  if (!c) return { built: 0, techs: 0, recruited: 0 };
  const frac = ((R.day % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR / DAYS_PER_YEAR;
  const mix = (cur: number, prev: number): number => Math.round(cur + prev * (1 - frac));
  return { built: mix(c[0], c[3]), techs: mix(c[1], c[4]), recruited: mix(c[2], c[5]) };
}

// ---------------------------------------------------------------------------------------------
// Threat
// ---------------------------------------------------------------------------------------------

const STANCE_THREAT: Readonly<Record<string, number>> = {
  war: 1, hostile: 0.85, neutral: 0.5, truce: 0.3, trade: 0.25, vassal: 0.2, kin: 0.15, liege: 0.1, alliance: 0.05,
};

/** Where the player's realm lies (its settlements, or the home place of a commoner). */
function myPlaces(R: Rlm): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const p = R.alive(R.playerId);
  const sc = p ? scopeOf(R, p.id) : null;
  const ids = sc && sc.direct.length ? sc.direct : p ? [p.settlement] : [];
  for (const id of ids) { const s = R.settlementById.get(id); if (s) out.push({ x: s.x, z: s.z }); }
  return out;
}

function strengthOf(R: Rlm, house: HouseId): number {
  return R.military?.strength?.(house) ?? R.politics?.strength(house) ?? 0;
}

/**
 * How much a deed of `house` at `settlement` threatens the player's House, 0..1: the kind of deed (`weight`), whether the House is
 * at war, near, and strong beside the player's. A House's own deeds threaten it not at all.
 */
export function threatOf(R: Rlm, house: HouseId, settlement: number, weight: number): number {
  const mine = R.playerHouse;
  if (!house || house === mine || weight <= 0) return 0;
  const s = settlement >= 0 ? R.settlementById.get(settlement) : R.settlementById.get(R.state.houses.get(house)?.seat ?? -1);
  const places = myPlaces(R);
  let d = 16000;
  if (s) for (const q of places) d = Math.min(d, dist(s.x, s.z, q.x, q.z));
  const prox = Math.max(0.05, Math.min(1, 1 - d / 12000));
  const stance = STANCE_THREAT[R.politics?.stance(mine, house) ?? 'neutral'] ?? 0.5;
  const theirs = strengthOf(R, house), ours = strengthOf(R, mine);
  const rel = Math.max(0, Math.min(1, theirs / Math.max(1, ours) / 2));
  return Math.round(Math.max(0, Math.min(1, weight * (0.45 * stance + 0.25 * prox + 0.3 * rel))) * 100) / 100;
}

// ---------------------------------------------------------------------------------------------
// The ring buffer
// ---------------------------------------------------------------------------------------------

export function addNews(R: Rlm, d: NewsDraft): NewsItem {
  const item: NewsItem = {
    id: R.data.seq.news++, day: Math.floor(R.day), kind: d.kind, house: d.house, settlement: d.settlement, text: d.text,
    threat: threatOf(R, d.house, d.settlement, d.weight),
  };
  R.data.news.push(item);
  if (R.data.news.length > NEWS.cap) R.data.news.splice(0, R.data.news.length - NEWS.cap);
  R.touch();
  R.sim.events.emit('news', { id: item.id, kind: item.kind, house: item.house, settlement: item.settlement, text: item.text, threat: item.threat });
  return item;
}

/** The newest items first. */
export function newsList(R: Rlm, limit = 40): readonly NewsItem[] {
  const n = R.data.news;
  const out: NewsItem[] = [];
  for (let i = n.length - 1; i >= 0 && out.length < limit; i--) out.push(n[i]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// What the events tell
// ---------------------------------------------------------------------------------------------

/** Buildings worth a line when a neighbour finishes one, and how much they matter to their safety. */
const BUILD_WEIGHT: Readonly<Record<string, number>> = {
  wall: 0.7, tower: 0.65, gatehouse: 0.65, keep_stone: 0.75, motte: 0.5, palisade: 0.45, barracks: 0.6, training_yard: 0.5, archery_butts: 0.35,
  stable: 0.35, smithy: 0.3, bloomery: 0.3, watermill: 0.2, windmill: 0.2, market_hall: 0.2, guildhall: 0.2, warehouse: 0.15, church: 0.15,
  abbey_church: 0.15, cathedral: 0.2, school: 0.15, infirmary: 0.1, mine: 0.3, quarry: 0.2, clay_pit: 0.1, salt_pan: 0.1, lumber_camp: 0.1,
  kiln: 0.1, manor_house: 0.2, great_hall: 0.2, tannery: 0.1,
};

const kindName = (k: string): string => k.replace(/_/g, ' ');

const houseOfSettlement = (R: Rlm, sid: number): HouseId => {
  const t = titleAtSettlement(R, sid);
  const h = t && t.holder ? R.person(t.holder) : undefined;
  return h ? h.house : 0;
};

function sides(R: Rlm, ids: readonly number[]): string {
  const names = ids.map((i) => R.houseName(i));
  return names.length <= 1 ? (names[0] ?? 'someone') : `${names[0]} and ${names.length - 1} more`;
}

/** Installs the listeners that turn events into news; returns the function that removes them. */
export function installNews(R: Rlm): () => void {
  const ev = R.sim.events;
  const offs: Array<() => void> = [];

  offs.push(ev.on('construction', (e) => {
    if (e.phase !== 'done' || (e.work !== 'build' && e.work !== 'upgrade') || !e.house) return;
    bump(R, e.house, 0);
    const w = BUILD_WEIGHT[e.kind];
    const mine = R.isPlayersHouse(e.house);
    if (w === undefined && !mine) return;
    addNews(R, {
      kind: 'built', house: e.house, settlement: e.settlement, weight: w ?? 0.1,
      text: `${R.houseName(e.house)} has ${e.work === 'upgrade' ? 'improved' : 'raised'} a ${kindName(e.kind)} at ${R.placeName(e.settlement)}`,
    });
  }));

  offs.push(ev.on('tech', (e) => {
    bump(R, e.house, 1);
    // a technique that came of the House's own research is already told by the research
    const today = Math.floor(R.day);
    if (R.data.projects.some((p) => p.tech === e.tech && p.house === e.house && p.state === 'done' && p.ended === today)) return;
    const def = R.tech?.tech(e.tech);
    if (!def || R.isPlayersHouse(e.house)) return;
    const w = def.branch === 'military' ? 0.55 : def.points >= 35 ? 0.25 : 0;
    if (w <= 0) return;
    addNews(R, { kind: 'research', house: e.house, settlement: R.state.houses.get(e.house)?.seat ?? -1, weight: w, tech: e.tech, text: `${R.houseName(e.house)} now has ${def.name.toLowerCase()}` });
  }));

  offs.push(ev.on('war', (e) => {
    const a = e.attackers[0] ?? 0, d = e.defenders[0] ?? 0;
    const seat = R.state.houses.get(d || a)?.seat ?? -1;
    const involved = [...e.attackers, ...e.defenders].includes(R.playerHouse);
    if (e.phase === 'declared') {
      addNews(R, { kind: 'war', house: a, settlement: seat, weight: involved ? 1 : 0.6, text: `${sides(R, e.attackers)} has declared war on ${sides(R, e.defenders)}` });
    } else {
      const text = e.winner === 'white_peace' || !e.winner ? `${sides(R, e.attackers)} and ${sides(R, e.defenders)} have made peace` : `${sides(R, e.winner === 'attackers' ? e.attackers : e.defenders)} has won the war against ${sides(R, e.winner === 'attackers' ? e.defenders : e.attackers)}`;
      addNews(R, { kind: 'peace', house: a, settlement: seat, weight: involved ? 0.5 : 0.2, text });
    }
  }));

  offs.push(ev.on('siege', (e) => {
    const target = houseOfSettlement(R, e.settlement);
    const where = R.placeName(e.settlement);
    const mine = target === R.playerHouse || e.besieger === R.playerHouse;
    if (e.phase === 'start') addNews(R, { kind: 'war', house: e.besieger, settlement: e.settlement, weight: mine ? 1 : 0.7, text: `${R.houseName(e.besieger)} has laid siege to ${where}` });
    else if (e.phase === 'fell') addNews(R, { kind: 'fell', house: e.besieger, settlement: e.settlement, weight: mine ? 1 : 0.7, text: `${where} has fallen to ${R.houseName(e.besieger)}` });
    else addNews(R, { kind: 'peace', house: e.besieger, settlement: e.settlement, weight: 0.2, text: `The siege of ${where} is lifted` });
  }));

  offs.push(ev.on('raid', (e) => {
    const raider = R.military ? (R.military.armies().find((a) => a.id === e.raider)?.house ?? 0) : 0;
    addNews(R, {
      kind: 'war', house: raider, settlement: e.settlement, weight: 0.7,
      text: `Raiders have fallen on ${R.placeName(e.settlement)}: ${e.burned} burned, ${e.stolen} head of stock taken, ${e.captives} carried off`,
    });
  }));

  offs.push(ev.on('happening', (e) => {
    if (e.phase !== 'start' || (e.kind !== 'famine' && e.kind !== 'plague')) return;
    addNews(R, { kind: e.kind === 'famine' ? 'famine' : 'other', house: houseOfSettlement(R, e.settlement), settlement: e.settlement, weight: 0.3, text: e.text });
  }));

  offs.push(ev.on('inheritance', (e) => {
    const t = R.state.titles.get(e.title);
    if (!t || (t.kind !== 'kingdom' && t.kind !== 'county' && t.kind !== 'barony')) return;
    const heir = R.person(e.to);
    if (!heir) return;
    addNews(R, { kind: 'other', house: heir.house, settlement: titlePlace(R, t), weight: 0.25, text: `${R.name(e.to)} succeeds ${R.name(e.from)} as lord of ${t.name}` });
  }));

  offs.push(ev.on('stance', (e) => {
    if (e.stance !== 'alliance' && e.stance !== 'truce' && e.stance !== 'kin') return;
    // the same pact is announced from both sides: tell it once
    if (e.a > e.b) return;
    const word = e.stance === 'alliance' ? 'have sworn an alliance' : e.stance === 'kin' ? 'are joined by marriage' : 'have made a truce';
    addNews(R, { kind: 'peace', house: e.a, settlement: R.state.houses.get(e.a)?.seat ?? -1, weight: e.stance === 'alliance' ? 0.35 : 0.1, text: `${R.houseName(e.a)} and ${R.houseName(e.b)} ${word}` });
  }));

  return () => { for (const off of offs.splice(0)) off(); };
}

// ---------------------------------------------------------------------------------------------
// Daily and yearly
// ---------------------------------------------------------------------------------------------

/** Armies raised since yesterday are news (the military module raises them without an event). */
export function newsDaily(R: Rlm): void {
  const mil = R.military;
  if (!mil) return;
  const seen = new Set(R.data.seen);
  const now = mil.armies();
  const live = new Set<number>();
  let changed = false;
  for (const a of now) {
    live.add(a.id);
    if (seen.has(a.id)) continue;
    changed = true;
    let men = 0;
    for (const k of Object.keys(a.troops)) men += a.troops[k];
    if (men < 12) continue;
    const where = R.state.houses.get(a.house)?.seat ?? -1;
    const cmd = R.person(a.commander);
    addNews(R, {
      kind: 'army', house: a.house, settlement: where, weight: 0.9,
      text: `${R.houseName(a.house)} has raised ${men} men${cmd ? ` under ${R.name(cmd.id)}` : ''}${a.target?.settlement !== undefined ? `, marching on ${R.placeName(a.target.settlement)}` : ''}`,
    });
  }
  // remember only the armies still in the field (ids are never reused)
  const keep = [...live].sort((a, b) => a - b);
  if (changed || keep.length !== R.data.seen.length) { R.data.seen = keep; R.touch(); }
}

/** The turn of the year: this year's counts become last year's, and towns that grew are news. */
export function newsYearly(R: Rlm): void {
  for (const key of Object.keys(R.data.ctr)) {
    const c = R.data.ctr[key];
    c[3] = c[0]; c[4] = c[1]; c[5] = c[2];
    c[0] = 0; c[1] = 0; c[2] = 0;
    if (c.every((v) => v === 0)) delete R.data.ctr[key];
  }
  for (const s of R.world.settlements) {
    const pop = R.state.residentsOf(s.id).length;
    const key = String(s.id);
    const before = R.data.pop[key];
    R.data.pop[key] = pop;
    if (before === undefined || before < 40) continue;
    if (pop >= before * 1.18 && (s.kind === 'town' || s.kind === 'city' || s.kind === 'castle')) {
      const house = houseOfSettlement(R, s.id);
      addNews(R, { kind: 'grew', house, settlement: s.id, weight: 0.2, text: `${s.name} has grown to ${pop} souls` });
    }
  }
  R.touch();
}

// ---------------------------------------------------------------------------------------------
// Rivals
// ---------------------------------------------------------------------------------------------

/** The Houses that hold land (most of them nobles), with the settlements they hold directly. */
function landedHouses(R: Rlm): Map<HouseId, number[]> {
  const out = new Map<HouseId, number[]>();
  const titles = [...R.state.titles.values()].sort((a, b) => a.id - b.id);
  for (const t of titles) {
    if (!t.holder || t.kind === 'abbey' || t.kind === 'see') continue;
    const h = R.person(t.holder);
    if (!h || h.death || !h.house) continue;
    const house = R.state.houses.get(h.house);
    if (!house || house.extinct || house.kind === 'church') continue;
    const place = titlePlace(R, t);
    let l = out.get(h.house);
    if (!l) { l = []; out.set(h.house, l); }
    if (place >= 0 && !l.includes(place)) l.push(place);
  }
  return out;
}

export function rivalsOf(R: Rlm, personId: PersonId): RivalView[] {
  const p = R.alive(personId);
  if (!p) return [];
  const sc = scopeOf(R, personId);
  const mine = sc ? sc.house : p.house;
  const myPts: Array<{ x: number; z: number }> = [];
  for (const id of sc && sc.direct.length ? sc.direct : [p.settlement]) { const s = R.settlementById.get(id); if (s) myPts.push({ x: s.x, z: s.z }); }
  const landed = landedHouses(R);
  const ours = strengthOf(R, mine);
  const rows: RivalView[] = [];
  let total = ours;
  const strengths = new Map<HouseId, number>();
  for (const h of [...landed.keys()].sort((a, b) => a - b)) {
    if (h === mine) continue;
    const st = strengthOf(R, h);
    strengths.set(h, st);
    total += st;
  }
  for (const [h, places] of [...landed.entries()].sort((a, b) => a[0] - b[0])) {
    if (h === mine) continue;
    const house = R.state.houses.get(h);
    if (!house) continue;
    let d = 99999, seat = places[0] ?? house.seat;
    for (const sid of places) {
      const s = R.settlementById.get(sid);
      if (!s) continue;
      for (const q of myPts) { const dd = dist(s.x, s.z, q.x, q.z); if (dd < d) { d = dd; seat = sid; } }
    }
    if (d > 30000) continue;
    const stance = R.politics?.stance(mine, h) ?? 'neutral';
    const c = yearCounts(R, h);
    const theirs = strengths.get(h) ?? 0;
    const prox = Math.max(0.05, Math.min(1, 1 - d / 12000));
    const rel = Math.max(0, Math.min(1, theirs / Math.max(1, ours) / 2));
    const grow = Math.min(0.15, c.built * 0.01 + c.techs * 0.02 + c.recruited * 0.002);
    const threat = Math.round(Math.max(0, Math.min(1, 0.45 * (STANCE_THREAT[stance] ?? 0.5) + 0.25 * prox + 0.3 * rel + grow)) * 100) / 100;
    rows.push({
      house: h, name: house.name, distance: Math.round(d === 99999 ? 0 : d), strength: Math.round(theirs * 10) / 10,
      built: c.built, techs: c.techs, recruited: c.recruited, stance, threat,
      head: house.head, seat, settlements: places.length, share: total > 0 ? Math.round((theirs / total) * 1000) / 1000 : 0,
    });
  }
  rows.sort((a, b) => b.threat - a.threat || a.distance - b.distance || a.house - b.house);
  return rows.slice(0, 40);
}
