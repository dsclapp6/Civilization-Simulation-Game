// Scenarios: practice runs set up in the ordinary game (nothing here is a separate mode — the same campaign, battle and
// command the game has when a lord plans an attack from the ruler's seat).
//
// The march on the castle: you are a knight in your lord's host of 250, marching in the afternoon on a castle of a rival
// House held by 300. Night falls short of the walls: the host camps. At first light it storms the castle, and the tactical view
// (C) sets the companies to their tasks; the retreat can be sounded at any time.
import { ageYears } from '../sim/state';
import { militaryContext } from '../sim/military';
import { planAttack } from './campaign';
import type { Session } from './session';

export function castleScenario(s: Pick<Session, 'sim' | 'campaign'>): { ok: boolean; reason?: string } {
  const sim = s.sim;
  const M = militaryContext(sim);
  const castles = sim.world.settlements.filter((x) => x.kind === 'castle');
  // a lord with a castle of his own, and the nearest castle of another line (a rival realm) to march on
  let best: { lord: number; target: number; d: number; stone: boolean } | null = null;
  for (const mine of castles) {
    const house = M.realm.holderOf(mine.id);
    const head = house ? sim.state.persons.get(sim.state.houses.get(house)?.head ?? 0) : undefined;
    if (!head || head.death || head.sex !== 'm' || ageYears(head, sim.absDay) < 20) continue;
    for (const other of castles) {
      const theirs = M.realm.holderOf(other.id);
      if (!theirs || theirs === house || M.realm.root(theirs) === M.realm.root(house)) continue;
      const d = Math.hypot(other.x - mine.x, other.z - mine.z);
      if (d < 1500) continue;

      // a castle with a curtain of stone is preferred (a raised wall-walk to come up onto by ladder, not a timber bailey of stakes)
      const stone = (sim.state.buildingsAt.get(other.id) ?? []).some((b) => b.kind === 'wall' && b.construction >= 1);
      if (!best || (stone && !best.stone) || (stone === best.stone && d < best.d)) best = { lord: head.id, target: other.id, d, stone };
    }
  }
  if (!best) return { ok: false, reason: 'No lord with a rival castle in this world' };
  // you ride as a knight of his: take his place for the setting-out, then fight as one of his knights
  const sw = sim.dispatch({ type: 'switchCharacter', personId: best.lord });
  if (!sw.ok) return { ok: false, reason: sw.reason };
  // the afternoon of the first day: the host sets out at half past three
  const day = Math.floor(sim.absDay);
  sim.state.clock.absDay = day + 15.5 / 24;
  sim.state.clock.firedHour = Math.floor(sim.state.clock.absDay * 24);
  return planAttack(sim, s.campaign, best.lord, best.target, { armyTo: 250, defendersTo: 300, asKnight: true, startAt: 600, holdDefenders: true });
}
