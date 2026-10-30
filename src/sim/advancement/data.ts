// Typed access to src/content/techs.json plus the lookup tables the yearly learning pass uses.
import techsJson from '../../content/techs.json';
import type { BranchDef, TechDef } from './types';

const raw = techsJson as unknown as { branches: BranchDef[]; techs: TechDef[] };

export const BRANCHES: readonly BranchDef[] = raw.branches;
export const TECHS: readonly TechDef[] = raw.techs;
export const TECH_BY_ID: ReadonlyMap<string, TechDef> = new Map(raw.techs.map((t) => [t.id, t]));

function index(pick: (t: TechDef) => readonly string[] | undefined): Map<string, TechDef[]> {
  const m = new Map<string, TechDef[]>();
  for (const t of TECHS) for (const k of pick(t) ?? []) {
    let list = m.get(k);
    if (!list) { list = []; m.set(k, list); }
    list.push(t);
  }
  return m;
}

/** Techs a person may discover, by the role that qualifies them (careers, career fields, titles held, estates). */
export const BY_CAREER = index((t) => t.learn.careers);
export const BY_FIELD = index((t) => t.learn.fields);
export const BY_TITLE = index((t) => t.learn.titles);
export const BY_ESTATE = index((t) => t.learn.estates);

/** Techs whose practice the player's completed actions count towards. */
export const PLAYER_ACTION_TECHS: readonly TechDef[] = TECHS.filter((t) => (t.learn.player?.actions?.length ?? 0) > 0);

/** Techs the player studies at a building kind. */
export const STUDY_BY_BUILDING = index((t) => t.learn.player?.study);

/** Does an action id match one of the patterns (exact, or a prefix ending in `*`)? */
export function actionMatches(id: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === id) return true;
    if (p.endsWith('*') && id.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/** Buildings in which books are kept (a library the scribes can write techniques into). */
export const LIBRARY_BUILDINGS: readonly string[] = ['cloister', 'abbey_church', 'cathedral', 'school'];
/** Careers of scribes. */
export const SCRIBE_CAREERS: ReadonlySet<string> = new Set(['monk', 'nun', 'clerk', 'prior', 'abbot', 'bishop', 'priest']);
