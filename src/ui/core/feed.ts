// The message feed and toasts: a small queue model plus pure mappers from simulation events to
// lines (gains in gold ink, warnings in vermilion…). No DOM here, so it is unit-tested.
import { RANK_NAMES, SKILLS, type RankTier, type SkillId } from '../../core/domain';
import type { ActionGain } from '../../sim/actions';
import type { SimEvents } from '../../sim/events';
import type { ChronicleEntry, PersonId } from '../../sim/state';
import { formatMoney, signed, thousands, trim } from './format';
import { SKILL_ICON } from './iconMap';
import type { IconName } from './icons';
import type { PanelRequest } from './requests';
import { SKILL_NAMES } from './text';

export type FeedKind = 'info' | 'gain' | 'loss' | 'warn' | 'danger' | 'quest' | 'social';

export interface FeedInput { kind: FeedKind; text: string; icon?: IconName }

export interface FeedLine extends FeedInput {
  id: number;
  /** Seconds (UI clock) when first shown / last repeated. */
  born: number;
  ttl: number;
  /** Identical lines in quick succession are merged: "Reaped barley ×3". */
  count: number;
}

export const FEED_TTL: Record<FeedKind, number> = { info: 7, gain: 8, loss: 8, warn: 11, danger: 15, quest: 12, social: 8 };
const FADE_SECONDS = 1.6;

export class Feed {
  private seq = 0;
  private lines: FeedLine[] = [];

  constructor(private readonly max = 6, private readonly mergeWindow = 6) {}

  push(input: FeedInput, now: number): FeedLine {
    const last = this.lines[this.lines.length - 1];
    if (last && last.kind === input.kind && last.text === input.text && now - last.born < this.mergeWindow) {
      last.count++;
      last.born = now;
      return last;
    }
    const line: FeedLine = { id: ++this.seq, kind: input.kind, text: input.text, icon: input.icon, born: now, ttl: FEED_TTL[input.kind], count: 1 };
    this.lines.push(line);
    while (this.lines.length > this.max) this.lines.shift();
    return line;
  }

  /** Drops expired lines; returns true when the list changed. */
  prune(now: number): boolean {
    const before = this.lines.length;
    this.lines = this.lines.filter((l) => now - l.born < l.ttl);
    return this.lines.length !== before;
  }

  list(): readonly FeedLine[] { return this.lines; }

  clear(): void { this.lines = []; }

  /** 1 while fresh, fading to 0 over the last second and a half. */
  opacity(line: FeedLine, now: number): number {
    const remaining = line.ttl - (now - line.born);
    if (remaining >= FADE_SECONDS) return 1;
    return Math.max(0, remaining / FADE_SECONDS);
  }
}

// ---- toasts (points, skill levels, rank) ----

export interface ToastInput {
  tone: 'gold' | 'lapis' | 'vermilion' | 'plain';
  icon: IconName;
  title: string;
  text?: string;
  ttl: number;
  /** Stable key so a repeated toast replaces the old one instead of stacking. */
  key?: string;
  action?: { label: string; request: PanelRequest };
}

export function toastForPoints(p: SimEvents['points']): ToastInput {
  return {
    tone: 'gold', icon: 'star_f', title: `+${trim(p.amount, 1)} points`, text: p.reason, ttl: 5, key: `points:${p.kind}`,
  };
}

export function toastForSkillLevel(e: SimEvents['skillLevel'], playerId: PersonId): ToastInput | null {
  if (e.person !== playerId) return null;
  const name = SKILL_NAMES[e.skill];
  if (e.perkChoice) {
    return {
      tone: 'gold', icon: 'star_f', title: `${name} ${e.level}`, text: 'A perk is waiting: choose one of two.', ttl: 9,
      key: `perk:${e.skill}`, action: { label: 'Choose a perk', request: { panel: 'perk', person: e.person, skill: e.skill } },
    };
  }
  return { tone: 'plain', icon: 'sparkle', title: `${name} ${e.level}`, text: 'Skill level gained.', ttl: 4, key: `skill:${e.skill}` };
}

export function toastForRank(e: SimEvents['rankChanged'], playerId: PersonId): ToastInput | null {
  if (e.person !== playerId || e.from === e.to) return null;
  const up = e.to > e.from;
  return {
    tone: up ? 'gold' : 'vermilion', icon: up ? 'crown' : 'warning', title: up ? 'Your station rises' : 'Your station falls',
    text: `${RANK_NAMES[e.from as RankTier]} → ${RANK_NAMES[e.to as RankTier]}`, ttl: 7, key: 'rank',
  };
}

// ---- feed lines ----

const NOTIFY_ICON: Partial<Record<SimEvents['notify']['kind'], IconName>> = {
  warn: 'warning', danger: 'swords', quest: 'scroll', social: 'talk',
};

/** Lines about the player only; notes about other people are dropped. */
export function feedForNotify(n: SimEvents['notify'], playerId: PersonId): FeedInput | null {
  if (n.person !== undefined && n.person !== playerId) return null;
  if (!n.text) return null;
  return { kind: n.kind, text: n.text, icon: NOTIFY_ICON[n.kind] };
}

export function feedForTrade(e: SimEvents['trade'], playerId: PersonId, describe: (item: string, qty: number) => string): FeedInput | null {
  const what = describe(e.item, e.qty);
  if (e.buyer === playerId) return { kind: 'info', icon: 'coin', text: `Bought ${what} for ${formatMoney(e.pence)}.` };
  if (e.seller === playerId) return { kind: 'gain', icon: 'coin', text: `Sold ${what} for ${formatMoney(e.pence)}.` };
  return null;
}

export function feedForOpinion(e: SimEvents['opinion'], playerId: PersonId, nameOf: (id: PersonId) => string): FeedInput | null {
  if (e.about !== playerId || Math.abs(e.delta) < 2) return null;
  const who = nameOf(e.of);
  const better = e.delta > 0;
  const why = e.reason ? ` — ${e.reason}` : '';
  return { kind: 'social', icon: 'talk', text: `${who} thinks ${better ? 'better' : 'less'} of you (${signed(e.delta)})${why}` };
}

export function feedForTravel(e: SimEvents['travel'], placeName: (id: number) => string): FeedInput | null {
  switch (e.phase) {
    case 'start': return { kind: 'info', icon: 'signpost', text: `You set out for ${placeName(e.to)}.` };
    case 'arrive': return { kind: 'gain', icon: 'signpost', text: `You arrive at ${placeName(e.to)}.` };
    case 'encounter': return { kind: 'warn', icon: 'warning', text: `On the road: ${e.encounter ?? 'an encounter'}.` };
    case 'cancel': return { kind: 'info', icon: 'signpost', text: 'You abandon the journey.' };
    default: return null;
  }
}

export function feedForSkip(e: SimEvents['skip']): FeedInput | null {
  switch (e.phase) {
    case 'end': return { kind: 'info', icon: e.kind === 'sleep' ? 'bed' : 'hourglass', text: e.kind === 'sleep' ? 'You wake, rested.' : `${e.label || 'The wait'} is over.` };
    case 'timeout': return { kind: 'warn', icon: 'hourglass', text: 'You have waited as long as you can.' };
    case 'cancel': return { kind: 'info', icon: 'hourglass', text: 'You stir and get up.' };
    default: return null;
  }
}

const CHRONICLE_KINDS: Readonly<Record<string, FeedKind>> = { death: 'loss', birth: 'gain', marriage: 'social', inheritance: 'info', promotion: 'gain', rank: 'gain' };

/** Family news only: entries that mention someone in `family`. */
export function feedForChronicle(e: ChronicleEntry, family: ReadonlySet<PersonId>): FeedInput | null {
  const kind = CHRONICLE_KINDS[e.kind];
  if (!kind) return null;
  if (!e.persons.some((id) => family.has(id))) return null;
  return { kind, icon: 'scroll', text: e.text };
}

// ---- action gains ("+3 sheaves", "+12 Farming") ----

export interface GainChip { text: string; icon: IconName }

export function gainChip(g: ActionGain, goodIcon: (ref: string) => IconName | undefined): GainChip {
  const ref = g.ref ?? '';
  let icon: IconName = 'sparkle';
  let text = g.label;
  if (ref === 'money') {
    icon = 'coin';
    text = g.amount !== undefined ? `${g.amount < 0 ? '' : '+'}${formatMoney(g.amount)}` : g.label;
  } else {
    if ((SKILLS as readonly string[]).includes(ref)) icon = SKILL_ICON[ref as SkillId];
    else icon = goodIcon(ref) ?? 'box';
    if (g.amount !== undefined) text = `${signed(g.amount, Number.isInteger(g.amount) ? 0 : 1)} ${g.label}`;
  }
  return { text, icon };
}
