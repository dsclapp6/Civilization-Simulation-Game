// Shared plumbing for the built-in topics: the per-conversation session, the context handed to a
// topic (who, what they think, ready-made speech contexts) and helpers to build options and replies.
import type { Person } from '../../state';
import type { SocialCore } from '../core';
import type { SpeechCtx } from '../speech';
import { RAPPORT } from '../tuning';
import type { Conversation, DialogueLine, DialogueOption, OptionKind, Tone, TopicReply } from '../types';

/** Transient state of one conversation (not saved). */
export interface Session {
  conv: Conversation;
  actor: Person;
  other: Person;
  /** Their opinion of the actor when the conversation began. */
  startOpinion: number;
  /** The menu page the built-in topics show. */
  page: string;
  /** How often each topic key was used in this conversation. */
  used: Map<string, number>;
  /** Free per-topic memory (lists of candidates …). */
  scratch: Map<string, unknown>;
  turns: number;
}

export interface TopicCtx {
  readonly core: SocialCore;
  readonly session: Session;
  readonly actor: Person;
  readonly other: Person;
  /** The other's opinion of the actor now. */
  readonly op: number;
  /** The NPC speaking to the actor. */
  readonly npc: SpeechCtx;
  /** The actor speaking to the NPC. */
  readonly me: SpeechCtx;
}

/** A group of related options and what choosing them does. */
export interface TopicGroup {
  /** Option ids this group owns start with `${prefix}.`. */
  readonly prefix: string;
  options(t: TopicCtx, out: DialogueOption[]): void;
  choose(t: TopicCtx, option: DialogueOption): TopicReply;
}

export interface OptionExtra {
  enabled?: boolean;
  reason?: string;
  chance?: number;
  priority?: number;
  data?: unknown;
}

export function mkOption(id: string, label: string, kind: OptionKind, extra: OptionExtra = {}): DialogueOption {
  return {
    id, provider: 'social', label, kind, enabled: extra.enabled ?? true, reason: extra.reason, chance: extra.chance,
    priority: extra.priority ?? 50, data: extra.data,
  };
}

export const NO_REPLY: TopicReply = { lines: [] };

/** The NPC's line from a pool, as a DialogueLine (or nothing). */
export function npcSays(t: TopicCtx, pool: string, tone?: Tone): DialogueLine[] {
  const l = t.core.speech.line(pool, t.npc, tone);
  return l ? [l] : [];
}

/** The actor's own spoken line from a pool. */
export function iSay(t: TopicCtx, pool: string, tone?: Tone): DialogueLine[] {
  const l = t.core.speech.line(pool, t.me, tone);
  return l ? [l] : [];
}

/** A line spoken by the NPC with ready text. */
export function npcText(t: TopicCtx, text: string, tone?: Tone): DialogueLine {
  return { speaker: t.other.id, text, tone };
}

export function myText(t: TopicCtx, text: string, tone?: Tone): DialogueLine {
  return { speaker: t.actor.id, text, tone };
}

/** How often a chatty topic has been used with this person today (saved, so a reload cannot reset it). */
export function usesToday(t: TopicCtx): number {
  const rec = t.core.store.talkRec(t.actor.id, t.other.id, t.core.day, false);
  return rec ? rec.n : 0;
}

/**
 * Pleasant talk wins goodwill, but less each time in a day. `base` is the gain for a fresh topic with
 * someone who cares about it (`interest` ≈ 0.7..1.8). Counts the use. Returns 0 once they are tired of it.
 */
export function chatGain(t: TopicCtx, base: number, interest = 1): number {
  const rec = t.core.store.talkRec(t.actor.id, t.other.id, t.core.day, true);
  if (!rec) return 0;
  const k = Math.max(0, 1 - RAPPORT.perUse * rec.n);
  rec.n++;
  t.core.store.touch();
  return Math.round(base * interest * k * 10) / 10;
}

export function isTired(t: TopicCtx): boolean {
  return usesToday(t) >= 5;
}

/** The session's count for a topic key, then bumps it. */
export function seen(t: TopicCtx, key: string): number {
  const n = t.session.used.get(key) ?? 0;
  t.session.used.set(key, n + 1);
  return n;
}

export function firstName(p: Person): string { return p.first; }
