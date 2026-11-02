// Living as anyone (docs/CIV.md §2), pure: who a "live as" request means, what the confirmation card says about them, what
// the "who you are now" card says once you are them, who to offer when your character dies (family and House first, people
// near, then anyone alive by search). No DOM; tested against a real simulation.
import type { Activity } from '../../agents/types';
import { personCard } from '../../sim/api';
import { roleLabel } from '../../sim/careers';
import { MIN_PLAYABLE_AGE } from '../../sim/run';
import { ageYears, fullName, type Person, type PersonId } from '../../sim/state';
import type { GameServices } from '../types';
import { plural } from './format';
import { styledName } from './titles';

/** Why the panel was opened: choosing someone from a list, or the "Rule this town" button (the ruler of a place). */
export type LiveAsReason = 'rule' | 'choose';

export function liveAsReason(data: unknown): LiveAsReason {
  return typeof data === 'object' && data !== null && (data as { reason?: unknown }).reason === 'rule' ? 'rule' : 'choose';
}

export interface LiveAsTarget { id: PersonId; via: 'given' | 'cursor' | 'front' }

/** Whom a "live as" means: the person given, else the one under the cursor, else the one in front of the player. */
export function liveAsTarget(game: Pick<GameServices, 'player'>, given?: number): LiveAsTarget | null {
  if (given && given > 0) return { id: given, via: 'given' };
  const hov = game.player.hover?.();
  if (hov && hov.target.kind === 'person') return { id: hov.target.id, via: 'cursor' };
  const t = game.player.target();
  if (t && t.target.kind === 'person') return { id: t.target.id, via: 'front' };
  return null;
}

const ACTIVITY_WORDS: Record<Activity, string> = {
  sleep: 'asleep', home: 'at home', work: 'at work', eat: 'eating', church: 'at church', market: 'at the market', alehouse: 'at the alehouse',
  walk: 'on the way somewhere', travel: 'on a journey', play: 'at play', practice: 'at practice', talk: 'talking', follow: 'following someone',
  guard: 'on guard', patrol: 'on patrol', flee: 'running from danger', fight: 'fighting', idle: 'idle', errand: 'on an errand', school: 'at lessons',
};

/** "digging the garden" from the schedule's label ("Digging the garden"), else a word for the activity. */
export function doingWords(label: string | undefined, activity: Activity | undefined): string {
  const l = (label ?? '').trim();
  if (l) return l.charAt(0).toLowerCase() + l.slice(1);
  return activity ? ACTIVITY_WORDS[activity] ?? 'about their day' : 'about their day';
}

export interface PersonSummary {
  id: PersonId;
  /** With the honorific: "Sir Godwin Smith". */
  name: string;
  first: string;
  sex: 'm' | 'f';
  age: number;
  rankName: string;
  /** "Master Smith", "Reeve", "Girl". */
  role: string;
  place: string;
  placeId: number;
  /** "the household of Wat Smith, 5 souls". */
  household: string;
  /** "House Smith", or ''. */
  house: string;
  /** What they are doing now: "digging the garden". */
  doing: string;
  /** "your father", "a stranger from Ashburn"; '' for the player. */
  relation: string;
  /** Metres from the body, or null when it is not known. */
  distance: number | null;
  alive: boolean;
  isPlayer: boolean;
}

export function personSummary(game: GameServices, id: PersonId): PersonSummary | null {
  const sim = game.sim;
  const st = sim.state;
  const p = st.persons.get(id);
  const card = p ? personCard(sim, id) : null;
  if (!p || !card) return null;
  const me = st.run.playerId;
  const hh = st.households.get(p.household);
  const head = hh ? st.persons.get(hh.head) : undefined;
  let souls = 0;
  if (hh) for (const m of hh.members) { const q = st.persons.get(m); if (q && !q.death) souls++; }
  const household = hh
    ? `${head ? (head.id === id ? 'head of the household' : `the household of ${fullName(head)}`) : 'a household'}, ${plural(Math.max(1, souls), 'soul')}`
    : 'no household';
  let doing = '';
  let x = NaN, z = NaN;
  try {
    const a = game.zone.agent(id);
    const w = game.zone.whereabouts(id);
    doing = doingWords(w.label, a?.activity ?? w.activity);
    if (a) { x = a.x; z = a.z; } else if (Number.isFinite(w.x) && Number.isFinite(w.z) && !w.indoors) { x = w.x; z = w.z; }
  } catch { doing = 'about their day'; }
  const body = game.player.body();
  const distance = body && Number.isFinite(x) && Number.isFinite(z) ? Math.hypot(x - body.x, z - body.z) : null;
  let relation = '';
  try { relation = id === me ? '' : game.social.relationLabel(me, id); } catch { relation = ''; }
  return {
    id, name: styledName(p), first: p.first, sex: p.sex, age: Math.floor(ageYears(p, sim.absDay)), rankName: card.rankName,
    role: roleLabel(p.career, p.careerStage, p.sex), place: card.settlementName, placeId: p.settlement, household,
    house: card.houseName ? `House ${card.houseName}` : '', doing, relation, distance, alive: !p.death, isPlayer: id === me,
  };
}

export interface LiveAsCard extends PersonSummary {
  reason: LiveAsReason;
  canSwitch: boolean;
  /** Why not (when `canSwitch` is false). */
  why: string;
  /** "rules Dromore", "rules Dromore for the lord, who is held captive", or '' (for 'rule'). */
  ruleLine: string;
  /** For 'rule': this person rules something (ruler mode opens for them). */
  canRule: boolean;
}

/** What the confirmation card says. Null when there is no such person. */
export function liveAsCard(game: GameServices, id: PersonId, reason: LiveAsReason): LiveAsCard | null {
  const s = personSummary(game, id);
  if (!s) return null;
  const sim = game.sim;
  const realm = sim.services.realm ?? game.realm;
  let canRule = false;
  let ruleLine = '';
  if (realm) {
    try {
      canRule = realm.canRule(id);
      const v = canRule ? realm.view(id) : null;
      if (v) {
        const role = v.role ?? 'holder';
        const holder = realm.rules?.(id)?.[0]?.holder;
        const holderName = holder && holder !== id ? fullName(sim.state.persons.get(holder) ?? { first: 'the lord', byname: '' }) : '';
        ruleLine = role === 'steward' ? `keeps ${v.name}${holderName ? ` for ${holderName}` : ''}`
          : role === 'regent' ? `rules ${v.name} for ${holderName || 'the young heir'}`
            : role === 'reeve' ? `is reeve of ${v.name}`
              : `rules ${v.name}`;
      }
    } catch { /* the realm is mid-change: no line */ }
  }
  let why = '';
  if (s.isPlayer) why = `You are ${s.first} already.`;
  else if (!s.alive) why = `${s.first} has died.`;
  else if (!sim.canSwitchTo(id)) why = sim.state.run.phase === 'over' ? 'The run is over.' : `${s.first} cannot be taken up now.`;
  else if (reason === 'rule' && realm && !canRule) why = `${s.first} rules nothing.`;
  return { ...s, reason, canSwitch: why === '', why, ruleLine, canRule };
}

// ---------------------------------------------------------------------------------------------
// "Who you are now"
// ---------------------------------------------------------------------------------------------

export interface WhoNowTask { title: string; step: string; tracked: boolean }

export interface WhoNowCard {
  id: PersonId;
  name: string;
  first: string;
  age: number;
  rankName: string;
  role: string;
  place: string;
  household: string;
  house: string;
  /** What they were doing when you took them up. */
  doing: string;
  /** Their tasks as the objectives module has set them up (active ones, tracked first). */
  tasks: WhoNowTask[];
}

export function whoNowCard(game: GameServices, id: PersonId, doing?: string): WhoNowCard | null {
  const s = personSummary(game, id);
  if (!s) return null;
  const tasks: WhoNowTask[] = [];
  try {
    for (const o of game.objectives?.list() ?? []) {
      if (o.state !== 'active') continue;
      const step = o.steps.find((st) => !st.done) ?? o.steps[o.steps.length - 1];
      tasks.push({ title: o.title, step: step?.text ?? '', tracked: o.tracked });
    }
  } catch { /* the objectives are mid-change */ }
  tasks.sort((a, b) => Number(b.tracked) - Number(a.tracked));
  return {
    id, name: s.name, first: s.first, age: s.age, rankName: s.rankName, role: s.role, place: s.place, household: s.household, house: s.house,
    doing: doing ?? s.doing, tasks: tasks.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------------------------
// The death screen: who to go on as
// ---------------------------------------------------------------------------------------------

export interface PersonHit {
  id: PersonId;
  name: string;
  first: string;
  age: number;
  sex: 'm' | 'f';
  rankName: string;
  rankTier: number;
  role: string;
  place: string;
  placeId: number;
}

function hitOf(game: Pick<GameServices, 'sim'>, p: Person, place: string, rankName: string): PersonHit {
  return {
    id: p.id, name: styledName(p), first: p.first, age: Math.floor(ageYears(p, game.sim.absDay)), sex: p.sex, rankName, rankTier: p.rankTier,
    role: roleLabel(p.career, p.careerStage, p.sex), place, placeId: p.settlement,
  };
}

interface IndexRow { id: PersonId; hay: string; first: string; by: string; tier: number; place: number }

/**
 * A search over everyone alive by name, place and role. The index of lowercase strings is built on the first query and kept
 * while the panel that owns it is open (a population of ten thousand is a few milliseconds to build, a fraction of that to scan).
 */
export class PeopleIndex {
  private rows: IndexRow[] | null = null;
  private placeNames = new Map<number, string>();

  constructor(private readonly game: Pick<GameServices, 'sim'>) {}

  private build(): IndexRow[] {
    const sim = this.game.sim;
    for (const s of sim.world.settlements) this.placeNames.set(s.id, s.name);
    const rows: IndexRow[] = [];
    for (const p of sim.state.persons.values()) {
      if (p.death) continue;
      const place = this.placeNames.get(p.settlement) ?? '';
      const hay = `${fullName(p)} ${place} ${roleLabel(p.career, p.careerStage, p.sex)}${p.career === 'knight' ? ' sir knight' : ''}`.toLowerCase();
      rows.push({ id: p.id, hay, first: p.first.toLowerCase(), by: p.byname.toLowerCase(), tier: p.rankTier, place: p.settlement });
    }
    this.rows = rows;
    return rows;
  }

  get size(): number { return (this.rows ?? this.build()).length; }

  /** Everyone alive whose name, place or role contains every word of the query; names that start with a word first, then those
   *  of the `near` settlement, then the highest in rank. An empty query finds nobody. */
  search(query: string, limit = 12, opts: { exclude?: ReadonlySet<PersonId>; near?: number } = {}): PersonHit[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const rows = this.rows ?? this.build();
    const hits: Array<{ r: IndexRow; score: number }> = [];
    for (const r of rows) {
      if (opts.exclude?.has(r.id)) continue;
      let score = 0;
      let ok = true;
      for (const w of words) {
        if (!r.hay.includes(w)) { ok = false; break; }
        score += r.first.startsWith(w) ? 0 : r.by.startsWith(w) ? 1 : 3;
      }
      if (!ok) continue;
      if (opts.near !== undefined && r.place !== opts.near) score += 2;
      hits.push({ r, score: score * 10 - r.tier });
    }
    hits.sort((a, b) => a.score - b.score || a.r.id - b.r.id);
    const out: PersonHit[] = [];
    const persons = this.game.sim.state.persons;
    for (const h of hits.slice(0, limit)) {
      const p = persons.get(h.r.id);
      if (!p) continue;
      out.push(hitOf(this.game, p, this.placeNames.get(p.settlement) ?? '', personCard(this.game.sim, p.id)?.rankName ?? ''));
    }
    return out;
  }
}

/** People close to where the player fell: those the zone shows nearest the focus first, then the residents of the place. */
export function nearbyPeople(game: GameServices, around: { x: number; z: number } | null, settlement: number, limit = 6, exclude: ReadonlySet<PersonId> = new Set()): PersonHit[] {
  const sim = game.sim;
  const persons = sim.state.persons;
  const found: Person[] = [];
  const seen = new Set<PersonId>(exclude);
  const take = (p: Person | undefined): void => {
    if (!p || p.death || seen.has(p.id) || ageYears(p, sim.absDay) < MIN_PLAYABLE_AGE) return;
    seen.add(p.id);
    found.push(p);
  };
  if (around) {
    const near = [...game.zone.agents()]
      .map((a) => ({ id: a.personId, d: Math.hypot(a.x - around.x, a.z - around.z) }))
      .filter((e) => e.d < 120)
      .sort((a, b) => a.d - b.d || a.id - b.id);
    for (const e of near) { if (found.length >= limit) break; take(persons.get(e.id)); }
  }
  if (found.length < limit) {
    // the notable first: lords, officers, masters, then the rest by rank
    const here = (sim.state.residents.get(settlement) ?? []).filter((p) => !p.death && ageYears(p, sim.absDay) >= 14);
    here.sort((a, b) => b.rankTier - a.rankTier || b.offices.length - a.offices.length || a.id - b.id);
    for (const p of here) { if (found.length >= limit) break; take(p); }
  }
  const names = new Map<number, string>();
  for (const s of sim.world.settlements) names.set(s.id, s.name);
  return found.map((p) => hitOf(game, p, names.get(p.settlement) ?? '', personCard(sim, p.id)?.rankName ?? ''));
}

// ---------------------------------------------------------------------------------------------
// The way across: a glide of the camera when the new body is near, a fade when it is far
// ---------------------------------------------------------------------------------------------

/** The new body is this near (m) and the camera glides to it; beyond, the screen fades. */
export const GLIDE_MAX_DISTANCE = 300;
export const GLIDE_SECONDS = 1.2;
export const FADE_OUT_SECONDS = 0.32;
export const FADE_HOLD_SECONDS = 0.14;
export const FADE_IN_SECONDS = 0.7;

export type SwitchKind = 'glide' | 'fade';

/** A glide when the new body is within 300 m and the camera can be posed by the UI, else a fade. */
export function switchKind(distance: number | null, canGlide: boolean): SwitchKind {
  return canGlide && distance !== null && Number.isFinite(distance) && distance <= GLIDE_MAX_DISTANCE ? 'glide' : 'fade';
}
