// Barks: the short things people say aloud as you pass (speech bubbles, SPEC §18). Cheap and
// rate-limited — each speaker is silent for a while after speaking and the street as a whole may
// only speak so often — and most calls return null, so a crowd murmurs rather than chatters.
// Which words are chosen follows culture, rank, age, kinship, mood and weather (speech.ts).
import type { PersonId } from '../state';
import type { SocialCore } from './core';
import { BARK } from './tuning';
import type { BarkSituation } from './types';
import { noise01 } from './util';

/** Chance (per ten game-minutes of asking) that a speaker has something to say. */
const CHANCE: Record<BarkSituation, number> = {
  greet: 0.55, greet_superior: 0.6, greet_kin: 0.85, busy: 0.35, working: 0.2, bump: 0.85, weather: 0.12, holy_day: 0.3,
  market: 0.3, night: 0.15, fear: 0.95, angry: 0.75, thanks: 0.75, farewell: 0.45, idle: 0.08,
};

/** These cut through the street-wide limit (a shout of alarm is always heard). */
const URGENT: ReadonlySet<BarkSituation> = new Set<BarkSituation>(['fear', 'bump', 'angry']);

export const BARK_SITUATIONS: readonly BarkSituation[] = Object.keys(CHANCE) as BarkSituation[];

export class Barks {
  private readonly lastSpoke = new Map<PersonId, number>();
  private readonly recent: number[] = [];

  constructor(private readonly core: SocialCore) {}

  /** A line for a speech bubble, or null to stay quiet. */
  bark(speakerId: PersonId, situation: BarkSituation, listenerId?: PersonId): string | null {
    const core = this.core;
    const speaker = core.living(speakerId);
    if (!speaker || core.age(speaker) < 3) return null;
    const now = core.now;
    const last = this.lastSpoke.get(speakerId);
    if (last !== undefined && now >= last && now - last < BARK.cooldownDays) return null;
    const gate = noise01(speakerId, listenerId ?? 0, `${situation}:${Math.floor(now * 144)}`);
    if (gate >= CHANCE[situation]) return null;
    if (!URGENT.has(situation)) {
      while (this.recent.length > 0 && (now - this.recent[0] > BARK.windowDays || this.recent[0] > now)) this.recent.shift();
      if (this.recent.length >= BARK.windowMax) return null;
    }
    const text = this.say(speakerId, situation, listenerId);
    if (text === null) return null;
    this.lastSpoke.set(speakerId, now);
    this.recent.push(now);
    if (this.lastSpoke.size > 3000) {
      for (const [id, t] of this.lastSpoke) if (now - t > BARK.cooldownDays || t > now) this.lastSpoke.delete(id);
    }
    return text;
  }

  /** The words themselves, no limits (used when a person is addressed on purpose, e.g. answering a greeting). */
  say(speakerId: PersonId, situation: BarkSituation, listenerId?: PersonId): string | null {
    const core = this.core;
    const speaker = core.living(speakerId);
    if (!speaker) return null;
    const listener = listenerId !== undefined ? core.living(listenerId) ?? null : null;
    const ctx = core.speech.ctx(speaker, listener, { light: true });
    let sit = situation;
    if (listener && situation === 'greet') {
      if (ctx.tags.has('kin') && !ctx.tags.has('stranger')) sit = 'greet_kin';
      else if (ctx.rel === 'up') sit = 'greet_superior';
    }
    const text = core.speech.text(`bark.${sit}`, ctx);
    return text === '' ? null : text;
  }

  /** Forget the limits (after a load or a switch of character). */
  reset(): void {
    this.lastSpoke.clear();
    this.recent.length = 0;
  }
}
