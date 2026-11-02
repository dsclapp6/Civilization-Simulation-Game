// The field plan and the works share (docs/CIV.md §6.3): which crop each field of a manor sows, and how much of the manor's
// week-work goes to the lord's building sites instead of his demesne. Stored here, read by the economy (`cropPlan`, when it sows)
// and by construction (`worksShare`, when it counts the labour of the serfs).
//
// A field's life in the three-field rotation (src/sim/farming.ts): winter corn is sown in autumn on the field that lay fallow, is
// harvested the next summer, and that year's autumn leaves the field to a spring crop sown the spring after. So a field has two
// sowings, a winter one and a spring one, and the plan names a crop for each. `cropPlan(settlement)[field]` answers with the crop
// for the field's *next* sowing (winter in autumn, spring in spring), or 'fallow' when none is named, which means "the usual
// rotation decides".
import type { CropKind } from '../../core/domain';
import { CALENDAR, CROPS, SPRING_CROP_LIST, WINTER_CROPS, dayOfYearF, fieldRole, yearIndexOf } from '../farming';
import { mayCommand } from './rule';
import type { FieldPlan, PlanRec, Rlm } from './store';
import type { CropPlanLine, Result } from './types';

export type Sowing = 'winter' | 'spring';

const fail = (reason: string): Result => ({ ok: false, reason });
const FIELDS: ReadonlyArray<0 | 1 | 2> = [0, 1, 2];

const uniq = (list: readonly CropKind[]): CropKind[] => [...new Set(list)];
export const WINTER_OPTIONS: readonly CropKind[] = uniq(WINTER_CROPS);
export const SPRING_OPTIONS: readonly CropKind[] = uniq(SPRING_CROP_LIST);

/** The role of a field this year: 0 winter corn, 1 spring crop, 2 fallow. */
export function roleName(field: number, absDay: number): CropPlanLine['role'] {
  const r = fieldRole(field, yearIndexOf(absDay));
  return r === 0 ? 'winter' : r === 1 ? 'spring' : 'fallow';
}

/** Which sowing a field is due next: a spring-crop field before the end of the spring sowing, then the autumn after; a fallow one before the end of the autumn sowing, then the spring after; a field of winter corn waits for spring. */
export function nextSowing(field: number, absDay: number): Sowing {
  const role = fieldRole(field, yearIndexOf(absDay));
  const d = dayOfYearF(absDay);
  if (role === 1) return d <= CALENDAR.springSow[1] ? 'spring' : 'winter';
  if (role === 2) return d <= CALENDAR.winterSow[1] ? 'winter' : 'spring';
  return 'spring';
}

function planOf(R: Rlm, settlement: number): PlanRec | undefined { return R.data.plans[String(settlement)]; }

function planFor(R: Rlm, settlement: number): PlanRec {
  const key = String(settlement);
  let p = R.data.plans[key];
  if (!p) { p = { w: 0, f: [{}, {}, {}] }; R.data.plans[key] = p; }
  return p;
}

/** Drops a plan that says nothing (no works share, no crops named). */
function tidy(R: Rlm, settlement: number): void {
  const p = planOf(R, settlement);
  if (p && p.w === 0 && p.f.every((f) => !f.win && !f.spr)) delete R.data.plans[String(settlement)];
}

export function cropPlan(R: Rlm, settlement: number): Readonly<Record<0 | 1 | 2, CropKind | 'fallow'>> {
  const out: Record<0 | 1 | 2, CropKind | 'fallow'> = { 0: 'fallow', 1: 'fallow', 2: 'fallow' };
  const p = planOf(R, settlement);
  if (!p) return out;
  for (const f of FIELDS) {
    const slot: FieldPlan = p.f[f];
    out[f] = (nextSowing(f, R.day) === 'winter' ? slot.win : slot.spr) ?? 'fallow';
  }
  return out;
}

export function cropPlanView(R: Rlm, settlement: number): CropPlanLine[] {
  const p = planOf(R, settlement);
  return FIELDS.map((f) => {
    const next = nextSowing(f, R.day);
    const slot: FieldPlan = p ? p.f[f] : {};
    return {
      field: f, role: roleName(f, R.day), next,
      planned: (next === 'winter' ? slot.win : slot.spr) ?? 'fallow',
      winter: slot.win ?? 'fallow', spring: slot.spr ?? 'fallow',
      options: { winter: WINTER_OPTIONS, spring: SPRING_OPTIONS },
    };
  });
}

/** Names a crop for a field's sowing of that season ('fallow' clears the field's plan: the usual rotation decides again). */
export function setCropPlan(R: Rlm, personId: number, settlement: number, field: 0 | 1 | 2, crop: CropKind): Result {
  if (!R.settlementById.has(settlement)) return fail('There is no such place');
  if (!mayCommand(R, personId, 'plan', settlement)) return fail('Only the lord of the manor, his steward or the reeve plans its fields');
  if (field !== 0 && field !== 1 && field !== 2) return fail('A manor has three fields');
  if (crop === 'fallow') {
    const p = planOf(R, settlement);
    if (p) { p.f[field] = {}; tidy(R, settlement); R.touch(); }
    return { ok: true };
  }
  const season = CROPS[crop]?.season;
  if (!season) return fail('That is no crop for a field');
  const options = season === 'winter' ? WINTER_OPTIONS : SPRING_OPTIONS;
  if (!options.includes(crop)) return fail(`${crop[0].toUpperCase()}${crop.slice(1)} is not grown in the open fields`);
  const p = planFor(R, settlement);
  if (season === 'winter') p.f[field].win = crop; else p.f[field].spr = crop;
  R.touch();
  return { ok: true };
}

export function worksShare(R: Rlm, settlement: number): number {
  return planOf(R, settlement)?.w ?? 0;
}

export function setWorksShare(R: Rlm, personId: number, settlement: number, share: number): Result {
  if (!R.settlementById.has(settlement)) return fail('There is no such place');
  if (!mayCommand(R, personId, 'plan', settlement)) return fail('Only the lord of the manor, his steward or the reeve shares out its labour');
  if (!Number.isFinite(share)) return fail('Name a share between none and all');
  const w = Math.round(Math.max(0, Math.min(1, share)) * 20) / 20;
  if (w === worksShare(R, settlement)) return { ok: true };
  planFor(R, settlement).w = w;
  tidy(R, settlement);
  R.touch();
  return { ok: true };
}
