// The player module's own verbs (SPEC §22, ARCHITECTURE §4b): mount and dismount the household's horse,
// sleep until dawn at the home door, rest or wait (opens the rest panel), sit down, follow a person, and
// the choices of a road encounter. Registered on `sim.actions` like any other provider.
import type { ZoneApi } from '../agents/types';
import { isNight } from '../core/time';
import type { ActionOption, ActionOutcome, ActionProvider, TargetRef } from '../sim/actions';
import type { SimContext } from '../sim/context';
import type { Simulation } from '../sim/sim';
import type { PersonId } from '../sim/state';
import type { ChoiceDef } from './encounters';

export const PROVIDER_ID = 'player';

export interface ProviderHost {
  readonly sim: Simulation;
  readonly zone: ZoneApi;
  personId(): PersonId;
  alive(): boolean;
  isMounted(): boolean;
  isSitting(): boolean;
  following(): PersonId | null;
  /** The household's building the player calls home (−1 if none) and the distance to its door. */
  home(): { id: number; distance: number } | null;
  /** A horse the player's household owns. */
  ownsHorse(animalId: number): { owned: boolean; reason?: string };
  mountAnimal(animalId: number): ActionOutcome;
  dismount(): ActionOutcome;
  sit(on: boolean): ActionOutcome;
  follow(person: PersonId | null): ActionOutcome;
  /** Open road encounter choices (empty when there is none). */
  encounterChoices(): readonly ChoiceDef[];
  resolveEncounter(choiceId: string): ActionOutcome;
}

const SELF: TargetRef = { kind: 'self' };

function opt(partial: Pick<ActionOption, 'id' | 'label' | 'category' | 'target' | 'priority'> & Partial<ActionOption>): ActionOption {
  return { provider: PROVIDER_ID, enabled: true, seconds: 0, range: 3, ...partial };
}

export function createPlayerProvider(host: ProviderHost): ActionProvider {
  return {
    id: PROVIDER_ID,

    list(ctx: SimContext, actor: PersonId, target: TargetRef, out: ActionOption[]): void {
      if (actor !== host.personId() || !host.alive()) return;

      // an open encounter takes over everything
      const choices = host.encounterChoices();
      if (choices.length > 0) {
        if (target.kind !== 'self') return;
        choices.forEach((c, i) => out.push(opt({
          id: `encounter.${c.id}`, label: c.label, category: 'travel', target: SELF, priority: 50 - i, enabled: c.enabled,
          reason: c.reason, preview: c.preview, range: 999, data: c.id,
        })));
        return;
      }

      const night = isNight(ctx.absDay);
      switch (target.kind) {
        case 'self': {
          if (host.isMounted()) out.push(opt({ id: 'dismount', label: 'Dismount', category: 'use', target, priority: 8, range: 999 }));
          out.push(opt({ id: host.isSitting() ? 'stand' : 'sit', label: host.isSitting() ? 'Stand up' : 'Sit down', category: 'rest', target, priority: 1, range: 999 }));
          out.push(opt({ id: 'rest', label: 'Rest or wait…', category: 'rest', target, priority: 2, range: 999 }));
          const home = host.home();
          if (home && home.distance < 8) {
            out.push(opt({ id: 'sleep', label: 'Sleep until dawn', category: 'rest', target, priority: night ? 9 : 4, range: 999, preview: 'Rest until sunrise' }));
          }
          break;
        }
        case 'animal': {
          const a = host.zone.animals().find((x) => x.id === target.id);
          if (a && a.kind === 'horse' && !host.isMounted()) {
            const own = host.ownsHorse(a.id);
            out.push(opt({
              id: 'mount', label: 'Mount', category: 'use', target, priority: own.owned ? 8 : 1, range: 3.2,
              enabled: own.owned, reason: own.owned ? undefined : own.reason ?? 'That horse is not yours.',
              preview: own.owned ? 'Ride: walk 1.7 · trot 4 · gallop 11 m/s' : undefined,
            }));
          }
          break;
        }
        case 'person': {
          if (target.id === actor) break;
          const f = host.following();
          out.push(opt({
            id: f === target.id ? 'unfollow' : 'follow', label: f === target.id ? 'Stop following' : 'Follow', category: 'social', target, priority: 1, range: 12,
          }));
          break;
        }
        case 'building': {
          const home = host.home();
          if (home && home.id === target.id) {
            out.push(opt({ id: 'sleep', label: 'Sleep until dawn', category: 'rest', target, priority: night ? 9 : 4, range: 6, preview: 'Rest until sunrise' }));
            out.push(opt({ id: 'rest', label: 'Rest or wait…', category: 'rest', target, priority: 2, range: 6 }));
          }
          break;
        }
        default:
          break;
      }
    },

    complete(_ctx: SimContext, _actor: PersonId, option: ActionOption): ActionOutcome {
      if (option.id.startsWith('encounter.')) return host.resolveEncounter(String(option.data ?? option.id.slice('encounter.'.length)));
      switch (option.id) {
        case 'mount': return option.target.kind === 'animal' ? host.mountAnimal(option.target.id) : { ok: false };
        case 'dismount': return host.dismount();
        case 'sit': return host.sit(true);
        case 'stand': return host.sit(false);
        case 'follow': return option.target.kind === 'person' ? host.follow(option.target.id) : { ok: false };
        case 'unfollow': return host.follow(null);
        case 'rest': return { ok: true, ui: { panel: 'rest' } };
        case 'sleep': {
          const r = host.sim.dispatch({ type: 'sleep' });
          return r.ok ? { ok: true, message: 'You lie down and sleep.' } : { ok: false, message: sleepRefusal(r.reason) };
        }
        default: return { ok: false };
      }
    },
  };
}

function sleepRefusal(reason?: string): string {
  switch (reason) {
    case 'cannot sleep with enemies near': return 'You cannot sleep with enemies near.';
    case 'not during action': return 'Not now.';
    case 'not alive': return 'You cannot sleep now.';
    default: return reason ?? 'You cannot sleep now.';
  }
}
