// "Rule this town" (docs/CIV.md §2, §6): one click puts you into the person who rules a place — the holder of its manor or town
// title, the regent for a boy lord, the steward when the holder cannot act. The banner, the map's settlement card, the ruler's
// lists and the builder's "you cannot build" card all ask for it through here. The flow itself (the confirmation card, the
// camera glide, "Who you are now") is the live-as panel's (src/ui/panels, ext panel 'liveAs'); this only builds the request.
import { settlementName } from '../../sim/api';
import { fullName, type PersonId } from '../../sim/state';
import type { PanelRequest } from '../core/requests';
import type { GameServices } from '../types';

export interface RuleOffer {
  settlement: number;
  placeName: string;
  ruler: PersonId;
  rulerName: string;
  /** In what capacity the person rules it ("Lord of Dromore", "regent for the young lord"). */
  role: string;
  /** The player already is that ruler: the offer opens the seat of government instead. */
  self: boolean;
  label: string;
  tip: string;
  request: PanelRequest;
}

/** The request the live-as flow takes (B6's panel): the person to live as, and why. */
export function ruleRequest(ruler: PersonId): PanelRequest {
  return { panel: 'ext', name: 'liveAs', id: ruler, data: { reason: 'rule' } };
}

type Needs = Pick<GameServices, 'sim' | 'realm'>;

/** What ruling this place would be, or null when no one rules it, the ruler cannot be taken over, or there is no realm module. */
export function ruleOffer(game: Needs, settlement: number): RuleOffer | null {
  const realm = game.realm;
  if (!realm || settlement < 0) return null;
  const sim = game.sim;
  const ruler = realm.rulerOf(settlement);
  if (!ruler) return null;
  const person = sim.state.persons.get(ruler);
  if (!person || person.death) return null;
  const self = ruler === sim.state.run.playerId;
  if (!self && !sim.canSwitchTo(ruler)) return null;
  const placeName = settlementName(sim.world, settlement) || 'this place';
  const rule = realm.rules?.(ruler)?.find((r) => r.place === settlement);
  const title = rule ? sim.state.titles.get(rule.title) : undefined;
  let role = title?.name ?? 'ruler';
  if (rule?.role === 'regent') role = `regent for the young ${title?.name ?? 'lord'}`;
  else if (rule?.role === 'steward') role = rule.acting ? `steward, ruling for ${title?.name ?? 'the lord'}` : 'steward';
  else if (rule?.role === 'reeve') role = 'reeve';
  const rulerName = fullName(person);
  if (self) {
    return {
      settlement, placeName, ruler, rulerName, role, self, label: 'Open the seat of government',
      tip: `You rule ${placeName}: open the seat of government (U)`, request: { panel: 'ext', name: 'ruler' },
    };
  }
  return {
    settlement, placeName, ruler, rulerName, role, self, label: `Rule ${placeName}`,
    tip: `Live as ${rulerName}, ${role}, and take up the rule of ${placeName}`, request: ruleRequest(ruler),
  };
}
