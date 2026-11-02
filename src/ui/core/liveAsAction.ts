// "Live as Godwin" in the action wheel (docs/CIV.md §2): an option on every other living person that opens the confirmation card
// (`ui` outcome → `{ panel: 'ext', name: 'liveAs', id }`). It changes nothing in the simulation itself, so the UI may register it
// on `sim.actions` while a game is bound. Never the default: E and a click do what they always did.
import { roleLabel } from '../../sim/careers';
import type { ActionOption, ActionProvider } from '../../sim/actions';
import { canSwitchTo } from '../../sim/run';
import { ageYears } from '../../sim/state';
import { styledFirst } from './titles';

export const LIVE_AS_PROVIDER_ID = 'ui.liveAs';
export const LIVE_AS_OPTION_ID = 'live.as';

export function liveAsProvider(): ActionProvider {
  return {
    id: LIVE_AS_PROVIDER_ID,

    list(ctx, actor, target, out): void {
      if (target.kind !== 'person') return;
      const st = ctx.state;
      if (actor !== st.run.playerId || target.id === actor) return;
      const p = st.persons.get(target.id);
      if (!p || p.death) return;
      const can = canSwitchTo(st, target.id);
      const o: ActionOption = {
        id: LIVE_AS_OPTION_ID, provider: LIVE_AS_PROVIDER_ID, label: `Live as ${styledFirst(p)}`, category: 'social', target, enabled: can,
        seconds: 0, range: 80, priority: -20,
        preview: `Take up their life: ${roleLabel(p.career, p.careerStage, p.sex).toLowerCase()}, ${Math.floor(ageYears(p, ctx.absDay))}`,
      };
      if (!can) o.reason = st.run.phase === 'over' ? 'The run is over' : 'They cannot be taken up now';
      out.push(o);
    },

    complete(_ctx, _actor, option) {
      if (option.target.kind !== 'person') return { ok: false };
      return { ok: true, ui: { panel: 'ext', name: 'liveAs', id: option.target.id, data: { reason: 'choose' } } };
    },
  };
}
