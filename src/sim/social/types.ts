// CONTRACT (wave 2) — conversations, opinions and relationships (SPEC §5 Social, §18 Lively NPCs).
// Implemented by src/sim/social/** (`installSocial`). Other systems add conversation options by
// registering TopicProviders (the economy adds "Ask for work", "Trade…"; politics adds proposals).
//
// A conversation runs in action time (calendar slowed 20×): starting one sets it, ending clears it.
import type { UiRequest } from '../actions';
import type { PersonId } from '../state';

export type Tone = 'neutral' | 'friendly' | 'warm' | 'flirt' | 'wary' | 'cold' | 'angry' | 'afraid' | 'pleased' | 'sad';

export interface DialogueLine {
  speaker: PersonId;
  text: string;
  tone?: Tone;
}

export type OptionKind =
  | 'chat' | 'ask' | 'news' | 'trade' | 'work' | 'learn' | 'court' | 'marry' | 'family' | 'request'
  | 'favour' | 'gift' | 'flatter' | 'insult' | 'threaten' | 'bribe' | 'persuade' | 'manage' | 'leave';

export interface DialogueOption {
  /** Unique within the conversation's current list. */
  id: string;
  /** Filled in by the social system. */
  provider: string;
  label: string;
  kind: OptionKind;
  enabled: boolean;
  reason?: string;
  /** Chance of success 0..1 when the option is a check (shown to the player). */
  chance?: number;
  /** Sort order within the list (higher first). */
  priority?: number;
  data?: unknown;
}

export interface Conversation {
  id: number;
  actor: PersonId;
  with: PersonId;
  lines: DialogueLine[];
  options: DialogueOption[];
  /** Their opinion of the actor (−100..100) and how much it moved during this conversation. */
  opinion: number;
  opinionDelta: number;
  mood: 'friendly' | 'neutral' | 'wary' | 'hostile';
  /** "your father", "the reeve", "a stranger". */
  relation: string;
  ended: boolean;
}

export interface TopicReply {
  lines: DialogueLine[];
  /** Opinion change of the other person towards the actor. */
  opinion?: number;
  end?: boolean;
  /** Open a panel (trade, jobs…) — the conversation stays open underneath unless `end`. */
  ui?: UiRequest;
}

export interface TopicProvider {
  readonly id: string;
  options(conv: Readonly<Conversation>, out: DialogueOption[]): void;
  choose(conv: Readonly<Conversation>, option: DialogueOption): TopicReply;
}

export type RelationKind =
  | 'spouse' | 'betrothed' | 'parent' | 'child' | 'sibling' | 'kin' | 'in_law' | 'friend' | 'lover' | 'rival'
  | 'enemy' | 'lord' | 'vassal' | 'employer' | 'employee' | 'master' | 'apprentice' | 'neighbour';

export interface RelationView {
  person: PersonId;
  kinds: RelationKind[];
  /** "your sister", "Wat's apprentice". */
  label: string;
  /** Their opinion of the subject and the subject's of them. */
  theirOpinion: number;
  myOpinion: number;
}

export interface Courtship {
  a: PersonId;
  b: PersonId;
  /** 0..1 how far it has gone; marriage can be proposed at 1. */
  progress: number;
  /** Families' consent needed (minors, nobles, serfs need the lord's leave — merchet). */
  needsConsentFrom: PersonId[];
}

export interface Result { ok: boolean; reason?: string }

export type BarkSituation =
  | 'greet' | 'greet_superior' | 'greet_kin' | 'busy' | 'working' | 'bump' | 'weather' | 'holy_day'
  | 'market' | 'night' | 'fear' | 'angry' | 'thanks' | 'farewell' | 'idle';

export interface SocialApi {
  // conversations
  start(actor: PersonId, other: PersonId): Conversation | Result;
  choose(conversation: number, optionId: string): Conversation;
  end(conversation: number): void;
  current(): Conversation | null;
  registerTopic(provider: TopicProvider): () => void;

  // opinions and relationships
  /** What `of` thinks of `about` (−100..100), including kinship, rank and reputation. */
  opinion(of: PersonId, about: PersonId): number;
  adjustOpinion(of: PersonId, about: PersonId, delta: number, reason: string): void;
  relations(person: PersonId): RelationView[];
  /** How `viewer` would describe `other` ("your father", "Agnes, the alewife"). */
  relationLabel(viewer: PersonId, other: PersonId): string;

  // courtship and marriage
  courtship(a: PersonId, b: PersonId): Courtship | null;
  /** Ask `b` to marry `a` (needs courtship complete and consents). */
  propose(a: PersonId, b: PersonId): Result;
  /** A household head arranges a match for a ward (child, sibling) — SPEC §15 marriage. */
  arrangeMatch(head: PersonId, ward: PersonId, partner: PersonId): Result;
  /** Suitable partners for someone, best first (age, rank, kinship, distance). */
  matchCandidates(person: PersonId, limit?: number): PersonId[];

  // flavour
  /** A short line an NPC says aloud (speech bubble), or null to stay quiet. */
  bark(speaker: PersonId, situation: BarkSituation, listener?: PersonId): string | null;
  /** Local news and rumours in a settlement (recent chronicle, prices, deaths, weddings…). */
  news(settlement: number, limit?: number): string[];
}
