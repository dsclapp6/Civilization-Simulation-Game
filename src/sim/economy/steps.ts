// The visible steps of a bout of hands-on work (civilization pass, docs/CIV.md §8): the forge heats the bar, draws it
// out, quenches and grinds; the kiln is loaded, fired and drawn; the tannery soaks and scrapes; the butcher's block hangs,
// skins and joints. A plan is content (recipes.json `plans`); a recipe takes its own (`plan`), else its building's
// (`buildingPlans`), else a plain "get ready, work, finish". The shares of a plan add up to 1 and play out in order over the
// seconds of the bout (`ActionOption.steps`; the outcome still comes once, at the end).
import type { ActionStep } from '../actions';
import type { AnimState, HeldItem } from '../../core/view';
import { BUILDING_PLANS, STEP_PLANS, type RecipeDef, type StepDef } from './data';

const cache = new Map<string, readonly ActionStep[]>();

function toStep(d: StepDef): ActionStep {
  const s: ActionStep = { share: d.share, label: d.label, anim: d.anim, mainHand: d.held };
  if (d.off) s.offHand = d.off;
  if (d.sfx) s.sfx = d.sfx;
  return s;
}

/** The steps of a named plan (shared, read-only). An unknown plan gives the plain three. */
export function planSteps(plan: string): readonly ActionStep[] {
  let steps = cache.get(plan);
  if (!steps) {
    steps = (STEP_PLANS[plan] ?? STEP_PLANS.generic).map(toStep);
    cache.set(plan, steps);
  }
  return steps;
}

/** The plan a recipe follows at a kind of building. */
export function planOf(r: Pick<RecipeDef, 'plan'> | null, buildingKind: string): string {
  return r?.plan ?? BUILDING_PLANS[buildingKind] ?? 'generic';
}

/**
 * The steps of one batch of a recipe at a building: the plan's own, except that a plain job shows what the recipe's body
 * does (its animation and the tool in hand) in the middle step.
 */
export function stepsFor(r: RecipeDef, buildingKind: string): readonly ActionStep[] {
  const plan = planOf(r, buildingKind);
  if (plan !== 'generic') return planSteps(plan);
  const key = `generic:${r.anim}:${r.held}`;
  let steps = cache.get(key);
  if (!steps) {
    steps = planSteps('generic').map((s, i) => (i === 1 ? { ...s, anim: r.anim as AnimState, mainHand: r.held as HeldItem, label: r.name } : s));
    cache.set(key, steps);
  }
  return steps;
}

/** The steps of a dig, a felling or any other bout that names its plan directly. */
export function stepsOfPlan(plan: string): readonly ActionStep[] { return planSteps(plan); }
