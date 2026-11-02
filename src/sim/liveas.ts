// "Live as …" on anyone (docs/CIV.md §2): the action wheel (hold E) on a person offers to take them over. The one you
// leave goes on with their life under the AI. The People page (V) offers the same for everyone of your town.
import type { ActionOption, ActionProvider, TargetRef } from './actions';
import type { SimContext } from './context';
import { canSwitchTo, switchTo } from './run';
import { ageYears } from './state';

export const LIVE_AS_PROVIDER = 'liveas';

export function createLiveAsProvider(ctx: SimContext): ActionProvider {
  return {
    id: LIVE_AS_PROVIDER,
    list(_c, actor, target: TargetRef, out: ActionOption[]): void {
      if (actor !== ctx.state.run.playerId || target.kind !== 'person' || target.id === actor) return;
      const q = ctx.state.persons.get(target.id);
      if (!q || q.death) return;
      const o: ActionOption = {
        id: 'liveas', provider: LIVE_AS_PROVIDER, label: `Live as ${q.first}`, category: 'social', target, priority: -30,
        enabled: true, seconds: 0, range: 999, preview: 'Take over this person; the one you leave goes on with their life',
      };
      if (!canSwitchTo(ctx.state, q.id)) { o.enabled = false; o.reason = 'Not now'; }
      else if (ageYears(q, ctx.absDay) < 6) { o.enabled = false; o.reason = 'Too young'; }
      out.push(o);
    },
    complete(_c, _actor, option: ActionOption) {
      if (option.target.kind !== 'person') return { ok: false };
      const ok = switchTo(ctx, option.target.id);
      return ok ? { ok: true } : { ok: false, message: 'You cannot take them over now.' };
    },
  };
}
