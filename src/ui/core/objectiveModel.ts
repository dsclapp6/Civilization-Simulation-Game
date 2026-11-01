// What the HUD and the journal say about an objective: where it came from, which step is current, how far along it
// is, when it lapses. Pure (no DOM) so it is unit-tested; the objectives module itself is in src/sim/objectives.
import { dueText } from './format';
import type { IconName } from './icons';
import type { DaySummary, Objective, ObjectiveSource, ObjectiveStep, Suggestion } from '../../sim/objectives/types';

export const SOURCE_LABEL: Record<ObjectiveSource, string> = {
  tutorial: 'First steps', chore: 'Chore', job: 'Work', request: 'Request', goal: 'Goal', career: 'Career', story: 'Story',
};

export const SOURCE_ICON: Record<ObjectiveSource, IconName> = {
  tutorial: 'book', chore: 'home', job: 'hammer', request: 'hand', goal: 'star', career: 'signpost', story: 'scroll',
};

/** Index of the step to do now: the first that is not done (the last one when all are). */
export function currentStepIndex(o: Pick<Objective, 'steps'>): number {
  const i = o.steps.findIndex((s) => !s.done);
  return i < 0 ? Math.max(0, o.steps.length - 1) : i;
}

export function currentStep(o: Pick<Objective, 'steps'>): ObjectiveStep | null {
  return o.steps[currentStepIndex(o)] ?? null;
}

export type Pip = 'done' | 'now' | 'todo';

export function stepPips(o: Pick<Objective, 'steps' | 'state'>): Pip[] {
  const cur = currentStepIndex(o);
  return o.steps.map((s, i) => (s.done ? 'done' : i === cur && o.state === 'active' ? 'now' : 'todo'));
}

/** "2 of 4" for a counted step, or null. */
export function progressText(s: Pick<ObjectiveStep, 'progress' | 'goal'> | null): string | null {
  if (!s || s.goal === undefined || s.goal <= 1) return null;
  return `${Math.min(s.goal, Math.floor(s.progress ?? 0))} of ${s.goal}`;
}

export function progressFraction(s: Pick<ObjectiveStep, 'progress' | 'goal'> | null): number | null {
  if (!s || s.goal === undefined || s.goal <= 1) return null;
  return Math.max(0, Math.min(1, (s.progress ?? 0) / s.goal));
}

/** "Chore · for Father" — the kind of task and who set it. */
export function sourceLine(o: Pick<Objective, 'source' | 'giver'>, nameOf: (id: number) => string): string {
  const base = SOURCE_LABEL[o.source];
  if (!o.giver) return base;
  const first = nameOf(o.giver).split(' ')[0] || nameOf(o.giver);
  return o.source === 'request' ? `${base} · from ${first}` : `${base} · for ${first}`;
}

/** When it lapses, in words ("due today", "due in 2 days"), or ''. */
export function dueLine(o: Pick<Objective, 'dueDay' | 'state'>, absDay: number): string {
  if (o.dueDay === undefined || o.state !== 'active') return '';
  return dueText(o.dueDay, absDay);
}

export interface Grouped { tracked: Objective | null; groups: Array<{ source: ObjectiveSource; label: string; items: Objective[] }>; done: Objective[] }

const ORDER: ObjectiveSource[] = ['tutorial', 'story', 'request', 'chore', 'job', 'career', 'goal'];

/** The journal's list: the tracked one first, the rest by kind, finished ones last. */
export function groupObjectives(list: readonly Objective[]): Grouped {
  const active = list.filter((o) => o.state === 'active');
  const tracked = active.find((o) => o.tracked) ?? null;
  const groups: Grouped['groups'] = [];
  for (const source of ORDER) {
    const items = active.filter((o) => o.source === source && o !== tracked);
    if (items.length) groups.push({ source, label: SOURCE_LABEL[source], items });
  }
  return { tracked, groups, done: list.filter((o) => o.state !== 'active') };
}

/** The same objective, written so a change shows (for "did anything move since last frame"). */
export function objectiveSignature(o: Objective | null): string {
  if (!o) return '-';
  let s = `${o.id}|${o.state}|${o.title}|`;
  for (const st of o.steps) s += `${st.done ? 1 : 0}${st.progress ?? ''}/${st.goal ?? ''}${st.text.length};`;
  return s;
}

export function suggestionSignature(list: readonly Suggestion[]): string {
  return list.map((s) => `${s.text}|${s.objective ?? ''}|${s.target ? Math.round(s.target.x) + ',' + Math.round(s.target.z) : ''}`).join('\n');
}

/** A day summary with nothing in it deserves a gentler card. */
export function summaryIsEmpty(s: DaySummary): boolean {
  return !s.work.length && !s.earned && !s.spent && !s.goods.length && !s.skills.length && !s.stats.length && !s.objectivesDone.length;
}
