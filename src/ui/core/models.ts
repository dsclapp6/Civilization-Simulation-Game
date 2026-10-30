// Pure read models built from the simulation for the big screens: the birth reveal and the life story
// on the death screen. No DOM; tested against real (mock-world) simulations.
import { DIFFICULTY_GOLD, RANK_NAMES, STATS, type RankTier, type StatId } from '../../core/domain';
import { toDate } from '../../core/time';
import { personCard, runCard, settlementCard, kinshipLabel, type PersonCard } from '../../sim/api';
import { CAREERS, roleLabel } from '../../sim/careers';
import type { SimContext } from '../../sim/context';
import { siblingsOf } from '../../sim/kin';
import { ageYears, fullName, type BirthClass, type DeathCause, type Person, type PersonId } from '../../sim/state';
import { BIRTH_CLASSES } from './text';
import { deathCauseText, joinList, plural, pronounPossessive, pronounSubject } from './format';

type ReadCtx = Pick<SimContext, 'state' | 'world' | 'profile' | 'absDay'>;

// ---------------------------------------------------------------------------------------------
// Birth reveal
// ---------------------------------------------------------------------------------------------

export interface KinLine { id: PersonId; name: string; age: number; relation: string; alive: boolean; occupation: string }

export interface BirthModel {
  id: PersonId;
  name: string;
  first: string;
  sex: 'm' | 'f';
  age: number;
  birthClass: BirthClass;
  className: string;
  classLabel: string;
  /** "a free peasant of Kingsbridge in Wessmark" */
  headline: string;
  settlement: { name: string; kind: string; kingdom: string; county: string; population: number; lord: string };
  parents: KinLine[];
  siblings: KinLine[];
  household: { size: number; headName: string; headRelation: string; home: string };
  rank: { tier: number; name: string; estate: string; career: string };
  stats: Array<{ id: StatId; value: number; potential: number; ranks: number }>;
  life: string;
  multiplier: { birth: number; difficulty: number; total: number; difficultyName: string };
  ranksBought: number;
}

function kinLine(ctx: ReadCtx, from: Person, to: Person): KinLine {
  return {
    id: to.id, name: fullName(to), age: Math.floor(ageYears(to, ctx.absDay)), relation: kinshipLabel(ctx.state, from, to),
    alive: !to.death, occupation: roleLabel(to.career, to.careerStage, to.sex),
  };
}

const CLASS_WORD: Record<BirthClass, string> = {
  serf: 'a serf', free: 'a free peasant', craftsman: 'a craftsman’s child', merchant: 'a merchant’s child',
  gentry: 'a child of the gentry', knightly: 'a knight’s child', baronial: 'a baron’s child',
};

export function birthModel(ctx: ReadCtx): BirthModel | null {
  const run = runCard(ctx);
  const me = ctx.state.persons.get(run.player);
  if (!me) return null;
  const card = personCard(ctx, me.id);
  if (!card) return null;
  const place = settlementCard(ctx, me.settlement);
  const cls = ctx.state.run.birthClass;
  const info = BIRTH_CLASSES[cls];
  const parents: KinLine[] = [];
  for (const id of [me.father, me.mother]) {
    const p = id ? ctx.state.persons.get(id) : undefined;
    if (p) parents.push(kinLine(ctx, me, p));
  }
  const siblings = siblingsOf(ctx.state, me).map((s) => kinLine(ctx, me, s)).sort((a, b) => b.age - a.age);
  const hh = ctx.state.households.get(me.household);
  const head = hh ? ctx.state.persons.get(hh.head) : undefined;
  const home = hh ? ctx.state.buildings.get(hh.home) : undefined;
  const diffMult = DIFFICULTY_GOLD[ctx.state.difficulty];
  const bought = ctx.state.run.statUpgrades;
  const place_ = place?.name ?? 'the countryside';
  const kingdom = place?.kingdom ?? '';
  return {
    id: me.id, name: card.name, first: card.first, sex: me.sex, age: card.age,
    birthClass: cls, className: info.name, classLabel: info.label,
    headline: `${CLASS_WORD[cls]} of ${place_}${kingdom ? ` in ${kingdom}` : ''}`,
    settlement: {
      name: place_, kind: place?.kind ?? 'village', kingdom, county: place?.county ?? '', population: place?.population ?? 0,
      lord: place && place.lord ? fullName(ctx.state.persons.get(place.lord) ?? { first: '', byname: '' }) : '',
    },
    parents, siblings,
    household: {
      size: hh ? hh.members.length : 1, headName: head ? fullName(head) : '', headRelation: head && head.id !== me.id ? kinshipLabel(ctx.state, me, head) : 'yourself',
      home: home ? `a ${home.kind.replace('_', ' ')}` : 'a home',
    },
    rank: { tier: me.rankTier, name: card.rankName, estate: info.estate, career: CAREERS[me.career].label },
    stats: STATS.map((id) => ({ id, value: me.trained[id], potential: me.potential[id], ranks: bought[id] ?? 0 })),
    life: info.life,
    multiplier: { birth: run.multiplier, difficulty: diffMult, total: Math.round(run.multiplier * diffMult * 100) / 100, difficultyName: run.difficulty },
    ranksBought: STATS.reduce((n, s) => n + (bought[s] ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Death: the life story and the people who could carry on
// ---------------------------------------------------------------------------------------------

export interface SuccessorCard {
  id: PersonId;
  name: string;
  age: number;
  relation: string;
  rankName: string;
  rankTier: number;
  career: string;
  settlement: string;
  top: Array<{ id: StatId; value: number }>;
  sex: 'm' | 'f';
  /** Dependants of working age (the player decides with this in mind). */
  isChild: boolean;
}

export interface LifeStory {
  name: string;
  first: string;
  sex: 'm' | 'f';
  ageAtDeath: number;
  birthYear: number;
  deathYear: number;
  cause: DeathCause;
  causeText: string;
  rankName: string;
  career: string;
  place: string;
  spouse: { name: string; alive: boolean; year: number } | null;
  children: Array<{ name: string; alive: boolean; age: number }>;
  deeds: string[];
  paragraphs: string[];
  score: number;
  lifeNumber: number;
}

export function successorCard(ctx: ReadCtx, deceased: Person | null, id: PersonId): SuccessorCard | null {
  const c: PersonCard | null = personCard(ctx, id);
  const p = ctx.state.persons.get(id);
  if (!c || !p) return null;
  const top = [...c.stats].sort((a, b) => b.trained - a.trained).slice(0, 2).map((s) => ({ id: s.id, value: s.trained }));
  return {
    id, name: c.name, age: c.age, sex: c.sex, relation: deceased ? kinshipLabel(ctx.state, deceased, p) || 'of your House' : '',
    rankName: c.rankName, rankTier: c.rankTier, career: roleLabel(p.career, p.careerStage, p.sex), settlement: c.settlementName,
    top, isChild: c.age < 14,
  };
}

export function lifeStory(ctx: ReadCtx, deceasedId: PersonId, lifeNumber = 1): LifeStory | null {
  const st = ctx.state;
  const p = st.persons.get(deceasedId);
  const record = st.run.lives.find((l) => l.person === deceasedId);
  if (!p && !record) return null;
  const name = p ? fullName(p) : record!.name;
  const sex = p?.sex ?? 'm';
  const deathDay = p?.death?.day ?? record?.deathDay ?? ctx.absDay;
  const birthDay = p?.birthDay ?? record?.birthDay ?? 0;
  const age = Math.floor((deathDay - birthDay) / 16);
  const cause: DeathCause = p?.death?.cause ?? record?.cause ?? 'unknown';
  const tier = p?.rankTier ?? record?.tier ?? 1;
  const place = p ? (settlementCard(ctx, p.settlement)?.name ?? '') : '';
  const spouseP = p && p.spouse ? st.persons.get(p.spouse) : undefined;
  const children = p
    ? p.children.map((id) => st.persons.get(id)).filter((c): c is Person => !!c)
      .map((c) => ({ name: fullName(c), alive: !c.death, age: Math.floor(ageYears(c, c.death ? c.death.day : ctx.absDay)) }))
    : [];
  const deeds = st.chronicle
    .filter((e) => e.persons.includes(deceasedId) && e.kind !== 'switch' && e.kind !== 'gameover' && !(e.kind === 'death' && e.persons[0] === deceasedId))
    .slice(-8)
    .map((e) => e.text);
  const first = p?.first ?? name.split(' ')[0];
  const they = pronounSubject(sex);
  const their = pronounPossessive(sex);
  const rankName = RANK_NAMES[tier as RankTier] ?? '';

  const paras: string[] = [];
  const by = toDate(birthDay).year;
  const dy = toDate(deathDay).year;
  const career = p ? CAREERS[p.career].label.toLowerCase() : 'person';
  const born = by >= 1 ? `was born in Year ${by}` : 'was born long before this chronicle began';
  paras.push(`${name} ${born}${place ? ` and lived in ${place}` : ''}. ${capital(they)} ${p ? `worked as a ${career}` : 'made a life'} and ${tier >= 3 ? `rose to the ${rankName.toLowerCase()} station` : `lived as one of the ${rankName.toLowerCase()}`}.`);
  if (spouseP && p) {
    const kids = children.length;
    paras.push(`${capital(they)} married ${fullName(spouseP)} in Year ${toDate(p.marriedDay >= 0 ? p.marriedDay : deathDay).year}${kids ? ` and was ${sex === 'm' ? 'father' : 'mother'} to ${plural(kids, 'child', 'children')}: ${joinList(children.slice(0, 4).map((c) => c.name.split(' ')[0]))}${kids > 4 ? ' and more' : ''}.` : '.'}`);
  } else if (children.length) {
    paras.push(`${capital(they)} had ${plural(children.length, 'child', 'children')}: ${joinList(children.slice(0, 4).map((c) => c.name.split(' ')[0]))}.`);
  }
  if (deeds.length > 1) paras.push(`The chronicle remembers ${their} house: ${deeds.slice(0, 3).map((d) => d.replace(/\.$/, '')).join('; ')}.`);
  paras.push(`${first} died ${deathCauseText(cause)} in Year ${dy}, aged ${age}. ${age < 20 ? 'It was a short life.' : age < 45 ? 'There was more to do.' : 'It was a full one.'}`);

  return {
    name, first, sex, ageAtDeath: age, birthYear: by, deathYear: dy, cause, causeText: deathCauseText(cause), rankName,
    career: p ? roleLabel(p.career, p.careerStage, p.sex) : '', place,
    spouse: spouseP ? { name: fullName(spouseP), alive: !spouseP.death, year: toDate(p!.marriedDay >= 0 ? p!.marriedDay : deathDay).year } : null,
    children, deeds, paragraphs: paras, score: runCard(ctx).score, lifeNumber,
  };
}

function capital(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

