// Leading animals (docs/CIV.md §8): the player's own household's animals can be taken on a halter — E on the animal says *Lead* — and
// follow at the player's pace, a few at a time, to the pasture, the market or the slaughterhouse; *Let go* lets one go (or all of them).
// An action provider on `sim.actions`; the animals themselves are looked after by the zone (animals.ts `lead`, `unlead`).
import type { ActionOption, ActionOutcome, ActionProvider, TargetRef } from '../sim/actions';
import type { SimContext } from '../sim/context';
import type { PersonId } from '../sim/state';
import { LEADABLE, MAX_LED } from './animals';
import type { Zone } from './zone';

export const LEAD_PROVIDER_ID = 'agents.lead';

const NAMES: Record<string, string> = { horse: 'horse', ox: 'ox', cow: 'cow', sheep: 'sheep', goat: 'goat', pig: 'pig' };

export function createLeadProvider(zone: Zone): ActionProvider {
  const household = (ctx: SimContext, actor: PersonId): number => ctx.state.persons.get(actor)?.household ?? 0;

  const opt = (id: string, label: string, target: TargetRef, o: Partial<ActionOption> = {}): ActionOption => ({
    id, provider: LEAD_PROVIDER_ID, label, category: 'use', target, enabled: true, seconds: 0, range: 3.2, priority: 3, ...o,
  });

  return {
    id: LEAD_PROVIDER_ID,

    list(ctx: SimContext, actor: PersonId, target: TargetRef, out: ActionOption[]): void {
      // only the player takes animals in hand
      if (actor !== ctx.state.run.playerId) return;
      if (target.kind === 'self') {
        const n = zone.fauna.ledBy(actor).length;
        if (n > 0) out.push(opt('lead.letgo.all', n === 1 ? 'Let go of the animal' : `Let go of the ${n} animals`, target, { range: 999, priority: 2 }));
        return;
      }
      if (target.kind !== 'animal') return;
      const a = zone.fauna.animal(target.id);
      if (!a || a.wild || a.hostile || a.summoned || a.claimed) return;
      const name = NAMES[a.kind] ?? a.kind;
      if (a.leader === actor) {
        out.push(opt('lead.letgo', `Let go of the ${name}`, target, { priority: 6, range: 999, preview: 'It stays here and goes back to its routine' }));
        return;
      }
      if (!LEADABLE.has(a.kind)) return;
      const why = zone.fauna.whyNotLead(a, actor, household(ctx, actor));
      // an animal of another household is not offered at all; one's own that cannot be led now says why
      if (why !== null && (a.owner !== household(ctx, actor) || a.leader)) return;
      out.push(opt('lead.start', `Lead the ${name}`, target, {
        enabled: why === null, reason: why ?? undefined, priority: a.kind === 'horse' ? 4 : 7,
        preview: `It follows you on a halter (up to ${MAX_LED} animals)`,
      }));
    },

    complete(ctx: SimContext, actor: PersonId, option: ActionOption): ActionOutcome {
      if (option.id === 'lead.letgo.all') {
        const n = zone.fauna.unleadAll(actor);
        return n > 0 ? { ok: true, message: n === 1 ? 'You let the animal go.' : `You let the ${n} animals go.` } : { ok: false };
      }
      if (option.target.kind !== 'animal') return { ok: false };
      if (option.id === 'lead.letgo') return zone.fauna.unlead(option.target.id) ? { ok: true, message: 'You let it go.' } : { ok: false };
      if (option.id === 'lead.start') {
        const a = zone.fauna.animal(option.target.id);
        const res = zone.fauna.lead(option.target.id, actor, household(ctx, actor));
        if (!res.ok) return { ok: false, message: res.reason };
        const name = NAMES[a?.kind ?? ''] ?? 'animal';
        return { ok: true, message: `You take the ${name} on a halter. It will follow you.` };
      }
      return { ok: false };
    },
  };
}
