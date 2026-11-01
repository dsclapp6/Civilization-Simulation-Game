// What the journal's tabs show besides the objectives: what kind of day it is and what the family is doing (Today),
// the people the player knows and where they are now (People you know), and the places worth finding (Places).
// Built from the game's read APIs (economy, social, zone, sim state); pure functions, no DOM.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { SEASON_NAMES, daylight, toDate } from '../../core/time';
import { dayOfWeek, isHolyDay, isMarketDay, marketDayOf } from '../../sim/calendar';
import { roleLabel } from '../../sim/careers';
import type { HouseholdTask } from '../../sim/economy/types';
import { fullName, ageYears, type PersonId } from '../../sim/state';
import { settlementCard } from '../../sim/api';
import { clockText, dueText, relativeDay } from './format';
import type { IconName } from './icons';
import { where } from './nav';
import type { GameServices } from '../types';

// ---------------------------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------------------------

const TASK_WORDS: Record<HouseholdTask, string> = {
  fields: 'in the fields', garden: 'in the garden', livestock: 'with the animals', craft: 'at the craft', brew: 'brewing', spin: 'spinning and weaving',
  market: 'at market', wood: 'gathering wood', service: 'in service', school: 'at lessons', play: 'at play', rest: 'resting', auto: 'wherever needed',
};

export function taskWords(t: HouseholdTask): string { return TASK_WORDS[t] ?? t; }

export interface TodayModel {
  /** "Day 2 of 4 · Spring, Year 1" */
  dateLine: string;
  /** "Market day at Dromore" */
  headline: string;
  /** What that means. */
  blurb: string;
  sunrise: string;
  sunset: string;
  plan: Array<{ id: PersonId; name: string; task: string; set: boolean; you: boolean; head: boolean }>;
  strips: Array<{ id: number; label: string; note: string; work: number; x: number; z: number }>;
  open: Array<{ icon: IconName; label: string; value: string; good: boolean }>;
  dues: Array<{ label: string; when: string; overdue: boolean }>;
}

const STRIP_WORDS: Record<string, string> = {
  bare: 'bare', ploughed: 'ploughed', sown: 'sown', growing: 'growing', ripe: 'ripe, ready to reap', harvested: 'harvested', stubble: 'stubble', fallow: 'fallow',
};

export function todayModel(game: GameServices, meId: PersonId): TodayModel | null {
  const sim = game.sim;
  const st = sim.state;
  const me = st.persons.get(meId);
  if (!me) return null;
  const day = sim.absDay;
  const d = toDate(day);
  const here = sim.world.settlements.find((s) => s.id === me.settlement);
  const place = here?.name ?? 'your village';
  const holy = isHolyDay(day);
  const market = !!here && here.market && isMarketDay(day, here.id);
  const dl = daylight(d.season);
  const toHoly = (4 - dayOfWeek(day) + 4) % 4;
  let headline: string, blurb: string;
  if (holy) {
    headline = 'Holy day';
    blurb = 'Everyone goes to Mass in the morning and no field work is done. Afterwards the men and youths shoot at the butts, and the alehouse fills.';
  } else if (market) {
    headline = `Market day at ${place}`;
    blurb = 'The stalls are open: a day to sell what the household can spare and to buy what it lacks. Prices are best in the morning.';
  } else {
    headline = 'A working day';
    blurb = `The household is at its chores and in the fields. The holy day is ${toHoly === 1 ? 'tomorrow' : `in ${toHoly} days`}${here && here.market ? `; ${place} keeps its market ${relativeDay(nextMarket(day, here.id), day)}` : ''}.`;
  }
  const plan: TodayModel['plan'] = [];
  const hh = st.households.get(me.household);
  if (hh) {
    for (const line of game.economy.householdPlan(hh.id)) {
      const p = st.persons.get(line.person);
      if (!p || p.death) continue;
      plan.push({ id: p.id, name: p.id === meId ? 'You' : p.first, task: taskWords(line.task), set: line.set, you: p.id === meId, head: hh.head === p.id });
    }
  }
  const strips: TodayModel['strips'] = [];
  const holding = hh ? game.economy.holding(hh.id) : null;
  if (holding) {
    holding.strips.forEach((s, i) => {
      const poly = sim.world.strips.find((q) => q.id === s.id)?.poly;
      const cx = poly ? poly.reduce((a, q) => a + q.x, 0) / poly.length : 0, cz = poly ? poly.reduce((a, q) => a + q.z, 0) / poly.length : 0;
      const crop = s.crop === 'fallow' ? 'fallow' : s.crop;
      strips.push({ id: s.id, label: `Strip ${i + 1} · ${crop}`, note: `${STRIP_WORDS[s.state] ?? s.state}${s.nextTask && s.state !== 'fallow' ? `. Next: ${s.nextTask.toLowerCase()}` : ''}`, work: s.work, x: cx, z: cz });
    });
  }
  const open: TodayModel['open'] = [];
  if (here) {
    const m = game.economy.market(here.id);
    if (m) open.push({ icon: 'market', label: `${place} market`, value: market ? (m.open ? 'open now' : 'open today, but shut at this hour') : `next on ${relativeDay(m.nextMarketDay, day)}`, good: market && m.open });
  }
  open.push({ icon: 'cross_holy', label: 'Mass', value: holy ? 'this morning' : `in ${toHoly === 1 ? '1 day' : `${toHoly} days`}`, good: holy });
  const dues: TodayModel['dues'] = [];
  for (const o of game.economy.obligations(meId).slice(0, 4)) dues.push({ label: o.label, when: dueText(o.due, day), overdue: o.overdue });
  return {
    dateLine: `Day ${d.dayOfSeason} of 4 · ${SEASON_NAMES[d.season]}, Year ${d.year}`,
    headline, blurb, sunrise: clockText(dl.sunrise), sunset: clockText(dl.sunset), plan, strips, open, dues,
  };
}

function nextMarket(day: number, settlement: number): number {
  const dow = marketDayOf(settlement);
  const cur = dayOfWeek(day);
  return Math.floor(day) + ((dow - cur + 4) % 4 || 4);
}

// ---------------------------------------------------------------------------------------------
// People you know
// ---------------------------------------------------------------------------------------------

export type PersonGroup = 'family' | 'household' | 'work' | 'lord' | 'friends' | 'neighbours';
export const PERSON_GROUPS: ReadonlyArray<{ id: PersonGroup; label: string }> = [
  { id: 'family', label: 'Family' }, { id: 'household', label: 'Under your roof' }, { id: 'work', label: 'Work' },
  { id: 'lord', label: 'Your lord' }, { id: 'friends', label: 'Friends and rivals' }, { id: 'neighbours', label: 'Neighbours' },
];

export interface PersonRow {
  id: PersonId;
  name: string;
  age: number;
  relation: string;
  role: string;
  group: PersonGroup;
  /** "at the well, 40 m north-east" / "in Ashburn" / "away". */
  where: string;
  inZone: boolean;
  x: number | null;
  z: number | null;
  opinion: number;
}

export function peopleRows(game: GameServices, meId: PersonId, limit = 60): PersonRow[] {
  const sim = game.sim;
  const st = sim.state;
  const me = st.persons.get(meId);
  if (!me) return [];
  const rows = new Map<PersonId, PersonRow>();
  const nav = game.player.body() ?? { x: 0, z: 0 };
  const add = (id: PersonId, group: PersonGroup, relation?: string, opinion = 0): void => {
    if (id === meId || rows.has(id)) return;
    const p = st.persons.get(id);
    if (!p || p.death) return;
    const w = game.zone.whereabouts(id);
    const a = game.zone.agent(id);
    const x = a ? a.x : w.x, z = a ? a.z : w.z;
    const sameHere = w.settlement === me.settlement || !!a;
    const near = sameHere && Number.isFinite(x) && Number.isFinite(z);
    const doing = w.label ? w.label.charAt(0).toLowerCase() + w.label.slice(1) : '';
    const whereText = a ? `${doing || 'close by'}, ${where(nav.x, nav.z, x, z)}`
      : w.indoors ? `${doing || 'indoors'}${sameHere ? ' in the village' : ''}`
        : sameHere ? `${doing || 'about the village'}${near ? `, ${where(nav.x, nav.z, x, z)}` : ''}`
          : `away, in ${sim.world.settlements.find((s) => s.id === w.settlement)?.name ?? 'another place'}`;
    rows.set(id, {
      id, name: fullName(p), age: Math.floor(ageYears(p, sim.absDay)), relation: relation ?? game.social.relationLabel(meId, id),
      role: roleLabel(p.career, p.careerStage, p.sex).toLowerCase(), group, where: whereText, inZone: !!a,
      x: near ? x : null, z: near ? z : null, opinion: opinion || game.social.opinion(id, meId),
    });
  };
  // household first, then the family beyond it
  const hh = st.households.get(me.household);
  if (hh) for (const m of hh.members) add(m, 'household');
  for (const r of game.social.relations(meId)) {
    const kin = r.kinds.some((k) => ['spouse', 'parent', 'child', 'sibling', 'kin', 'in_law', 'betrothed'].includes(k));
    const group: PersonGroup = kin ? 'family'
      : r.kinds.some((k) => ['employer', 'employee', 'master', 'apprentice'].includes(k)) ? 'work'
        : r.kinds.some((k) => ['lord', 'vassal'].includes(k)) ? 'lord'
          : r.kinds.some((k) => ['friend', 'lover', 'rival', 'enemy'].includes(k)) ? 'friends' : 'neighbours';
    const existing = rows.get(r.person);
    if (existing) { existing.relation = r.label || existing.relation; if (group === 'family') existing.group = 'family'; continue; }
    add(r.person, group, group === 'neighbours' && /stranger/.test(r.label) ? 'a neighbour' : r.label, r.theirOpinion);
  }
  // the people the household lives among and under
  const emp = game.economy.employment(meId);
  if (emp && emp.employer) add(emp.employer, 'work');
  const card = settlementCard(sim, me.settlement);
  if (card && card.lord) add(card.lord, 'lord', `your lord, ${card.lordTitle.toLowerCase()}`);
  // household members who are kin are listed under family
  for (const row of rows.values()) if (row.group === 'household' && (row.relation.includes('father') || row.relation.includes('mother') || row.relation.includes('brother') || row.relation.includes('sister') || row.relation.includes('son') || row.relation.includes('daughter') || row.relation.includes('husband') || row.relation.includes('wife'))) row.group = 'family';
  const order = new Map(PERSON_GROUPS.map((g, i) => [g.id, i]));
  return [...rows.values()].sort((a, b) => (order.get(a.group) ?? 9) - (order.get(b.group) ?? 9) || Number(b.inZone) - Number(a.inZone) || b.opinion - a.opinion || a.name.localeCompare(b.name, 'en')).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------------

export interface PlaceRow { id: string; name: string; sub: string; icon: IconName; x: number; z: number; group: 'yours' | 'village' }

const PLACE_KINDS: ReadonlyArray<{ kinds: readonly BuildingKind[]; name: string; icon: IconName }> = [
  { kinds: ['church', 'abbey_church', 'cathedral', 'chapel'], name: 'The church', icon: 'church' },
  { kinds: ['market_cross', 'market_hall', 'market_stall'], name: 'The market', icon: 'market' },
  { kinds: ['well'], name: 'The well', icon: 'drop' },
  { kinds: ['smithy'], name: 'The smithy', icon: 'smithing' },
  { kinds: ['watermill', 'windmill'], name: 'The mill', icon: 'wheat' },
  { kinds: ['alehouse', 'tavern'], name: 'The alehouse', icon: 'cup' },
  { kinds: ['bakehouse'], name: 'The bakehouse', icon: 'bread' },
  { kinds: ['carpenter', 'sawpit'], name: 'The carpenter', icon: 'carpentry' },
  { kinds: ['manor_house', 'great_hall', 'keep_stone', 'motte'], name: 'The manor', icon: 'crown' },
  { kinds: ['archery_butts'], name: 'The archery butts', icon: 'archery' },
  { kinds: ['school'], name: 'The school', icon: 'book' },
  { kinds: ['tithe_barn'], name: 'The tithe barn', icon: 'box' },
];

export function placeRows(game: GameServices, meId: PersonId): PlaceRow[] {
  const sim = game.sim;
  const st = sim.state;
  const me = st.persons.get(meId);
  if (!me) return [];
  const out: PlaceRow[] = [];
  const hh = st.households.get(me.household);
  const home = hh ? st.buildings.get(hh.home) : undefined;
  if (home) out.push({ id: `b${home.id}`, name: 'Your home', sub: BUILDINGS[home.kind]?.name ?? 'Home', icon: 'home', x: home.x, z: home.z, group: 'yours' });
  const emp = game.economy.employment(meId);
  const wb = emp && emp.building !== undefined ? st.buildings.get(emp.building) : undefined;
  if (wb) out.push({ id: `b${wb.id}`, name: 'Your workplace', sub: `${BUILDINGS[wb.kind]?.name ?? 'Workshop'}${emp ? `, ${emp.title.toLowerCase()}` : ''}`, icon: 'hammer', x: wb.x, z: wb.z, group: 'yours' });
  const holding = hh ? game.economy.holding(hh.id) : null;
  if (holding) {
    holding.strips.forEach((s, i) => {
      const poly = sim.world.strips.find((q) => q.id === s.id)?.poly;
      if (!poly) return;
      const cx = poly.reduce((a, q) => a + q.x, 0) / poly.length, cz = poly.reduce((a, q) => a + q.z, 0) / poly.length;
      out.push({ id: `s${s.id}`, name: `Your family’s strip ${i + 1}`, sub: `${s.crop}, ${STRIP_WORDS[s.state] ?? s.state}`, icon: 'farming', x: cx, z: cz, group: 'yours' });
    });
  }
  const list = st.buildingsAt.get(me.settlement) ?? [];
  const settlementName = sim.world.settlements.find((s) => s.id === me.settlement)?.name ?? '';
  const at = game.player.body() ?? (home ?? { x: 0, z: 0 });
  for (const def of PLACE_KINDS) {
    let best: { id: number; x: number; z: number; kind: BuildingKind } | null = null;
    let bd = Infinity;
    for (const b of list) {
      if (!def.kinds.includes(b.kind)) continue;
      const dd = Math.hypot(b.x - at.x, b.z - at.z);
      if (dd < bd) { bd = dd; best = b; }
    }
    if (best) out.push({ id: `b${best.id}`, name: def.name, sub: `${BUILDINGS[best.kind].name}${settlementName ? `, ${settlementName}` : ''}`, icon: def.icon, x: best.x, z: best.z, group: 'village' });
  }
  return out;
}
