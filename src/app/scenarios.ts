// Scenarios: practice runs set up in the ordinary game (nothing here is a separate mode — the same campaign, battle and
// command the game has when you plan an attack from the ruler's seat).
//
// The march on the castle: you are a knight in your lord's host of 250, marching in the afternoon on a castle of a rival
// House held by 300. Night falls short of the walls: the host camps. At first light it storms the castle, and the battle
// command (the red button) sets the companies to their tasks.
import { DAYS_PER_YEAR } from '../core/time';
import type { RealmApi } from '../sim/realm/types';
import { planAttack } from './campaign';
import type { Session } from './session';

export function castleScenario(s: Session): { ok: boolean; reason?: string } {
  const sim = s.sim;
  const me = sim.state.run.playerId;
  const R = sim.services.realm as RealmApi | undefined;
  const v = R?.view(me);
  if (!v || v.seat === undefined) return { ok: false, reason: 'The lord holds no seat' };
  const seat = sim.world.settlements[v.seat];
  const mine = new Set([...v.settlements, ...v.vassalSettlements]);
  // the nearest castle of another House
  const castle = sim.world.settlements
    .filter((x) => x.kind === 'castle' && !mine.has(x.id))
    .map((x) => ({ x, d: Math.hypot(x.x - seat.x, x.z - seat.z) }))
    .sort((a, b) => a.d - b.d)[0]?.x;
  if (!castle) return { ok: false, reason: 'No castle of another House in this world' };
  // the afternoon of the first day: the host sets out at half past three
  const day = Math.floor(sim.absDay);
  sim.state.clock.absDay = day + 15.5 / 24;
  sim.state.clock.firedHour = Math.floor(sim.state.clock.absDay * 24);
  void DAYS_PER_YEAR;
  return planAttack(sim, s.campaign, me, castle.id, { armyTo: 250, defendersTo: 300, asKnight: true, startAt: 600, holdDefenders: true });
}
