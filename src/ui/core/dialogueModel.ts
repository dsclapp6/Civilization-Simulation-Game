// Pure helpers for the dialogue panel: option ordering, chance bands, opinion and mood words.
import type { Conversation, DialogueOption } from '../../sim/social/types';

/** Enabled options first (by priority, high first), disabled ones after, "leave" always last. */
export function orderOptions(options: readonly DialogueOption[]): DialogueOption[] {
  const rank = (o: DialogueOption): number => (o.kind === 'leave' ? -1e6 : (o.enabled ? 0 : -1000) + (o.priority ?? 0));
  return options.map((o, i) => ({ o, i })).sort((a, b) => rank(b.o) - rank(a.o) || a.i - b.i).map((x) => x.o);
}

export type ChanceBand = 'good' | 'fair' | 'poor';

export function chanceBand(chance: number): ChanceBand {
  return chance >= 0.6 ? 'good' : chance >= 0.35 ? 'fair' : 'poor';
}

export function opinionWords(opinion: number, name: string): string {
  if (opinion >= 60) return `${name} holds you dear`;
  if (opinion >= 30) return `${name} thinks well of you`;
  if (opinion >= 10) return `${name} likes you well enough`;
  if (opinion > -10) return `${name} has no strong feelings about you`;
  if (opinion > -30) return `${name} is wary of you`;
  if (opinion > -60) return `${name} dislikes you`;
  return `${name} despises you`;
}

export const MOOD_LABEL: Record<Conversation['mood'], string> = { friendly: 'Friendly', neutral: 'Neutral', wary: 'Wary', hostile: 'Hostile' };

export function moodTone(mood: Conversation['mood']): 'green' | '' | 'gold' | 'vermilion' {
  return mood === 'friendly' ? 'green' : mood === 'wary' ? 'gold' : mood === 'hostile' ? 'vermilion' : '';
}

/** Where on a −100..100 meter an opinion sits, as a 0..1 fraction. */
export function opinionFraction(opinion: number): number {
  return Math.max(0, Math.min(1, (opinion + 100) / 200));
}
