// Typed access to the objectives' wording (src/content/objectives/*.json). Every file is a flat dictionary of
// strings (`key`: "text with {placeholders}"); a key may be given a class-specific variant by prefixing it with
// the chain name and a colon ("craft:work.why" beats "work.why"). Chains list the stages of a tutorial.
import choresJson from '../../content/objectives/chores.json';
import goalsJson from '../../content/objectives/goals.json';
import textJson from '../../content/objectives/text.json';
import tutorialJson from '../../content/objectives/tutorial.json';

export type Vars = Record<string, string | number>;

type Dict = Record<string, string>;

function dictOf(json: unknown): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) if (typeof v === 'string' && !k.startsWith('_')) out[k] = v;
  return out;
}

const DICTS = {
  tutorial: dictOf((tutorialJson as unknown as { text: unknown }).text),
  chores: dictOf(choresJson),
  goals: dictOf(goalsJson),
  text: dictOf(textJson),
} as const;

export type DictName = keyof typeof DICTS;

/** Chains: tutorial stage ids per birth chain. */
export const CHAINS: Readonly<Record<string, readonly string[]>> = (tutorialJson as unknown as { chains: Record<string, string[]> }).chains;

/** Tests turn this on so a missing key fails loudly; in play a missing key shows its name. */
let strict = false;
export function setStrictText(on: boolean): void { strict = on; }
/** In tests an error in a listener fails the test; in play it is logged and the game goes on. */
export function isStrict(): boolean { return strict; }

/** Fills {placeholders}; unknown ones are left as they are (tests look for them). */
export function fill(text: string, vars: Vars): string {
  return text.replace(/\{(\w+)\}/g, (_m, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

/** The text under `key` (a class variant first), filled in. */
export function T(dict: DictName, key: string, vars: Vars = {}, cls?: string): string {
  const d = DICTS[dict];
  const raw = (cls !== undefined ? d[`${cls}:${key}`] : undefined) ?? d[key];
  if (raw === undefined) {
    if (strict) throw new Error(`objectives text: no "${key}" in ${dict}`);
    return key;
  }
  return fill(raw, vars);
}

/** Does the dictionary hold this key (or its class variant)? */
export function hasText(dict: DictName, key: string, cls?: string): boolean {
  const d = DICTS[dict];
  return (cls !== undefined && d[`${cls}:${key}`] !== undefined) || d[key] !== undefined;
}

/** All keys of a dictionary (the content test walks them). */
export function textKeys(dict: DictName): string[] { return Object.keys(DICTS[dict]); }
export function rawText(dict: DictName, key: string): string | undefined { return DICTS[dict][key]; }

/** First letter capitalised. */
export function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

/** "a", "an" in front of a word. */
export function aOrAn(word: string): string { return /^[aeiouAEIOU]/.test(word) ? 'an' : 'a'; }
