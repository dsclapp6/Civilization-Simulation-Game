// Typed access to the dialogue content (src/content/dialogue.json and src/content/dialogue/*.json).
//
// A *pool* is an array of line variants; its id is the path of keys in the JSON joined by dots
// ("chat.weather.reply"). A variant is a string, or { t, tone?, if?, w? }: `if` restricts when it may
// be used (see Cond), `w` is a weight. `dialogue.json` also holds `tables` (address forms, phrases)
// that are plain data and not flattened into pools.
import type { Tone } from './types';
import root from '../../content/dialogue.json';
import barks from '../../content/dialogue/barks.json';
import greetings from '../../content/dialogue/greetings.json';
import smalltalk from '../../content/dialogue/smalltalk.json';
import ask from '../../content/dialogue/ask.json';
import news from '../../content/dialogue/news.json';
import manners from '../../content/dialogue/manners.json';
import favours from '../../content/dialogue/favours.json';
import romance from '../../content/dialogue/romance.json';
import family from '../../content/dialogue/family.json';
import actions from '../../content/dialogue/actions.json';

/** When a variant may be used; every key present must match (arrays mean "any of"). Speaker = the one talking. */
export interface Cond {
  culture?: string | string[];
  sex?: 'm' | 'f';
  /** The listener's sex and age band (when the line is addressed to someone). */
  lsex?: 'm' | 'f';
  lage?: string | string[];
  /** child < 12, youth 12–17, adult 18–49, elder 50+ */
  age?: string | string[];
  /** The speaker's rank band: low (tiers 1–2), mid (3–4), high (5+). */
  rank?: string | string[];
  /** Speaker's standing against the listener's: up (listener higher), down, peer. */
  rel?: string | string[];
  /** Speaker has any of these traits / none of these. */
  trait?: string | string[];
  not?: string | string[];
  /** Speaker's opinion of the listener: hostile, cold, neutral, warm, devoted. */
  op?: string | string[];
  part?: string | string[];
  season?: number | number[];
  weather?: string | string[];
  /** Speaker's career id, career field or class label (priest, church, craft, noble, serf …). */
  role?: string | string[];
  /** Situation tags that must all hold / none may hold (kin, holy, market, stranger, debtor …). */
  tag?: string | string[];
  notTag?: string | string[];
  /** Kind of settlement the speaker is in (village, town, city, castle, abbey …). */
  place?: string | string[];
}

export type LineDef = string | { t: string; tone?: Tone; if?: Cond; w?: number };

export interface AddressForms { m?: string[]; f?: string[]; mn?: string[]; fn?: string[]; any?: string[]; anyn?: string[] }

export interface DialogueTables {
  /** culture ('default' first) → class → forms of address. */
  address: Record<string, Record<string, AddressForms>>;
  /** ambition id → noun phrase ("a plot of my own"). */
  ambition: Record<string, string>;
  /** memory reason code → { ui: shown in the opinion pop-up, mem: how an NPC phrases it, good: polarity }. */
  reasons: Record<string, { ui: string; mem: string; good: boolean }>;
  /** career field/id → phrases about the work. */
  work: Record<string, { noun: string; verb: string; toil: string }>;
  /** trait id → adjective used when describing someone. */
  traitWords: Record<string, string>;
  /** kingdom-free place descriptions. */
  placeWords: Record<string, string>;
  /** boast facts: attribute → { min threshold, label }. */
  [key: string]: unknown;
}

export interface Pool { id: string; lines: ReadonlyArray<{ t: string; tone?: Tone; if?: Cond; w: number }> }

export interface DialogueContent {
  pools: ReadonlyMap<string, Pool>;
  tables: DialogueTables;
}

function normalise(def: LineDef): { t: string; tone?: Tone; if?: Cond; w: number } {
  if (typeof def === 'string') return { t: def, w: 1 };
  return { t: def.t, tone: def.tone, if: def.if, w: def.w ?? 1 };
}

function flatten(prefix: string, value: unknown, out: Map<string, Pool>): void {
  if (Array.isArray(value)) {
    out.set(prefix, { id: prefix, lines: (value as LineDef[]).map(normalise) });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.startsWith('_')) continue;
      flatten(prefix ? `${prefix}.${k}` : k, v, out);
    }
  }
}

let cached: DialogueContent | null = null;

export function dialogueContent(): DialogueContent {
  if (cached) return cached;
  const pools = new Map<string, Pool>();
  const files: unknown[] = [barks, greetings, smalltalk, ask, news, manners, favours, romance, family, actions];
  for (const f of files) flatten('', f, pools);
  const tables = (root as unknown as { tables: DialogueTables }).tables;
  cached = { pools, tables };
  return cached;
}
