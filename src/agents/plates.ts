// Nameplate data (clarity pass): what the renderer needs to show who somebody is. The full name goes on the first
// line; the second says who they are to the player and what they do ("your father · farmer", "the reeve",
// "Lord of Dromore"); the colour family follows the relationship; kin, household, people with a task for the player
// and the tracked person show their plate from further away (≈ 40 m, others ≈ 15 m). Pure reading of the sim state
// and the social module: no state is written and no random stream is used.
import { roleLabel } from '../sim/careers';
import { kinshipLabel } from '../sim/api';
import type { SocialApi } from '../sim/social/types';
import { fullName, type GameState, type Person, type PersonId } from '../sim/state';
import type { LabelTone } from '../core/view';
import type { WorldModel } from '../world/types';

/** How far a plate shows (metres): people the player cares about, and everyone else. */
export const PLATE_RANGE_NEAR = 40;
export const PLATE_RANGE_FAR = 15;
const PLATE_RANGE_WARY = 30;

export interface Plate {
  name: string;
  sub: string;
  tone: LabelTone;
  range: number;
  mark: 'quest' | 'track' | undefined;
}

export interface PlateContext {
  state: GameState;
  world: WorldModel;
  social: SocialApi;
}

const FRIEND_AT = 28;
const RIVAL_AT = -28;
const ENEMY_AT = -50;

const TITLE_WORDS: Record<string, readonly [string, string]> = {
  kingdom: ['King', 'Queen'], county: ['Earl', 'Countess'], barony: ['Baron', 'Baroness'], abbey: ['Abbot', 'Abbess'],
  see: ['Bishop', 'Bishop'], town: ['Lord', 'Lady'], manor: ['Lord', 'Lady'],
};
const TITLE_ORDER = ['manor', 'town', 'abbey', 'barony', 'see', 'county', 'kingdom'];

const placeName = (c: PlateContext, id: number): string => c.world.settlements.find((s) => s.id === id)?.name ?? 'the realm';

/** Office or title of a person, as a heading: "the reeve", "Lord of Dromore", "Bishop of Winchester", or ''. */
export function officeLine(c: PlateContext, p: Person): string {
  const held = c.state.titlesHeldBy(p.id);
  if (held.size > 0) {
    let best: { kind: string; name: string; rank: number } | null = null;
    for (const t of held) {
      const rank = TITLE_ORDER.indexOf(t.kind);
      if (!best || rank > best.rank) best = { kind: t.kind, name: t.name, rank };
    }
    if (best) {
      const w = TITLE_WORDS[best.kind] ?? TITLE_WORDS.manor;
      const word = p.sex === 'f' ? w[1] : w[0];
      const place = best.kind === 'manor' || best.kind === 'town' || best.kind === 'abbey' ? placeName(c, p.settlement) : best.name;
      return `${word} of ${place}`;
    }
  }
  for (const off of p.offices) {
    if (off.office === 'reeve') return 'the reeve';
    if (off.office === 'mayor') return `Mayor of ${placeName(c, off.place)}`;
    if (off.office === 'alderman') return 'an alderman';
    if (off.office === 'king') return p.sex === 'f' ? 'the queen' : 'the king';
  }
  switch (p.career) {
    case 'priest': return 'the priest';
    case 'abbot': return p.sex === 'f' ? 'the abbess' : 'the abbot';
    case 'prior': return p.sex === 'f' ? 'the prioress' : 'the prior';
    case 'bishop': return 'the bishop';
    case 'bailiff': return 'the bailiff';
    case 'steward': return 'the steward';
    default: return '';
  }
}

/** What a person does for a living, lower case: "farmer", "master smith", "man-at-arms", "boy"; '' for householders without a trade. */
export function trade(p: Person): string {
  if (p.career === 'none') return '';
  return roleLabel(p.career, p.careerStage, p.sex).toLowerCase();
}

/** Who an unremarkable person is where they live: "villager", "townswoman", "of the castle". */
function commoner(c: PlateContext, p: Person): string {
  const kind = c.world.settlements.find((s) => s.id === p.settlement)?.kind;
  switch (kind) {
    case 'town': case 'city': return p.sex === 'f' ? 'townswoman' : 'townsman';
    case 'castle': return 'of the castle';
    case 'abbey': case 'priory': case 'nunnery': return 'of the house';
    default: return 'villager';
  }
}

/** The apprentice of a master of the household: "Wat's apprentice". */
function apprenticeOf(c: PlateContext, p: Person): string {
  if (p.careerStage !== 0 || p.career === 'child') return '';
  const hh = c.state.households.get(p.household);
  const head = hh ? c.state.persons.get(hh.head) : undefined;
  if (!head || head.id === p.id || head.career !== p.career || head.careerStage < 2) return '';
  return `${head.first}'s apprentice`;
}

/** Builds the plate of `p` as the player (`viewer`) sees them. */
export function makePlate(c: PlateContext, viewer: Person | null, p: Person, quest: boolean, tracked: boolean): Plate {
  const name = fullName(p);
  const office = officeLine(c, p);
  const job = trade(p);
  let tone: LabelTone = 'stranger';
  let rel = '';
  if (viewer) {
    try { rel = c.social.relationLabel(viewer.id, p.id); } catch { rel = ''; }
    if (rel.startsWith(`${p.first}, `)) rel = rel.slice(p.first.length + 2);
    const theirs = safeOpinion(c.social, p.id, viewer.id);
    const mine = safeOpinion(c.social, viewer.id, p.id);
    const kin = kinshipLabel(c.state, viewer, p) !== '';
    if (Math.min(theirs, mine) <= ENEMY_AT) tone = 'enemy';
    else if (Math.min(theirs, mine) <= RIVAL_AT) tone = 'rival';
    else if (kin) tone = 'kin';
    else if (viewer.household !== 0 && p.household === viewer.household) tone = 'household';
    else if (theirs >= FRIEND_AT && mine >= FRIEND_AT) tone = 'friend';
    else if (isLord(c, p)) tone = 'lord';
    else if (p.estate === 'clergy') tone = 'clergy';
  } else if (isLord(c, p)) tone = 'lord';
  else if (p.estate === 'clergy') tone = 'clergy';

  // the second line: the relation first when it is a personal one, then the office or trade
  let sub: string;
  const personal = rel.startsWith('your ');
  const apprentice = apprenticeOf(c, p);
  const away = viewer && viewer.settlement !== p.settlement ? placeName(c, p.settlement) : '';
  if (office && (rel === 'your lord' || rel === 'your vassal' || !personal)) sub = office;
  else if (office) sub = `${rel} · ${office}`;
  else if (apprentice && !personal) sub = apprentice;
  else if (personal && job && job !== 'boy' && job !== 'girl' && !rel.includes(job)) sub = `${rel} · ${job}`;
  else if (personal) sub = rel;
  else {
    const what = job || commoner(c, p);
    sub = away ? `${what} · from ${away}` : what;
  }

  const warm = tone === 'kin' || tone === 'household';
  const mark: Plate['mark'] = quest ? 'quest' : tracked ? 'track' : undefined;
  const range = warm || mark ? PLATE_RANGE_NEAR : tone === 'rival' || tone === 'enemy' ? PLATE_RANGE_WARY : PLATE_RANGE_FAR;
  return { name, sub, tone, range, mark };
}

function safeOpinion(social: SocialApi, of: PersonId, about: PersonId): number {
  try { return social.opinion(of, about); } catch { return 0; }
}

function isLord(c: PlateContext, p: Person): boolean {
  if (p.career === 'lord' || p.career === 'lady') return true;
  return c.state.titlesHeldBy(p.id).size > 0 && p.rankTier >= 5;
}
