// The real military and combat modules together, with the player controller on a fake zone: for the tests where a siege's
// storm is fought in the detail zone (the player is in the line).
import { installCombat, type CombatModule } from '../../../src/combat';
import { installEconomy } from '../../../src/sim/economy';
import { installMilitary, militaryContext } from '../../../src/sim/military';
import type { MilitaryRuntime } from '../../../src/sim/military/types';
import { installPlayer } from '../../../src/player';
import { installSocial } from '../../../src/sim/social';
import type { Simulation } from '../../../src/sim/sim';
import type { Person } from '../../../src/sim/state';
import { FakeZone } from '../../player/fakes';
import { makePlayer } from '../builders';
import { autoSuccessor, newSim } from '../helpers';
import { declareWar, fakePolitics } from './helpers';
import { fortify, type Fort } from '../../combat/stormHelpers';

export interface StormRig {
  sim: Simulation;
  mil: MilitaryRuntime;
  combat: CombatModule;
  zone: FakeZone;
  player: Person;
  fort: Fort;
  ka: number;
  kb: number;
  castleId: number;
  armyId: number;
}

/** A siege of a fortified castle of House `kb` by an army of `ka` that the player has joined (or leads). */
export function stormRig(seed: string, opts: { asDefender?: boolean; asCommander?: boolean; store?: import('../../../src/sim/save-memory').MemorySaveStore } = {}): StormRig {
  const sim = newSim({ preset: 'small', seed, store: opts.store, autosave: opts.store ? { intervalMs: 0 } : undefined });
  const zone = new FakeZone();
  zone.enableSummons();
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const player = installPlayer(sim, { zone, economy, social });
  const w3 = { economy, social, zone, player };
  const mil = installMilitary(sim, w3);
  const combat = installCombat(sim, w3);
  autoSuccessor(sim);
  const pol = fakePolitics(sim);
  const M = militaryContext(sim);
  const royals = [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
  const [ka, kb] = royals;
  const castle = sim.world.settlements.find((s) => s.kind === 'castle' && M.realm.root(M.realm.lordHouse(s.id)) === kb)!;
  const fort = fortify({ sim, zone }, 'wall', 36, castle.id);
  const war = declareWar(pol, sim, [ka], [kb]);
  M.realm.invalidateEnmity();
  for (const h of sim.state.houses.values()) { M.data.think[`r${h.id}`] = sim.absDay + 999; M.data.think[`d${h.id}`] = sim.absDay + 999; }
  M.data.wars[String(war.id)] = Math.floor(sim.absDay);
  const armyId = mil.raiseArmy(ka, 'war', { vassals: true, war: war.id });
  mil.order(armyId, { kind: 'hold' });
  sim.advanceDays(6);
  const A = M.army(armyId)!;
  // the player: a man of the besieged place (a defender), the commander of the host, or one of its soldiers
  const grown = (p: Person): boolean => !p.death && p.sex === 'm' && p.estate !== 'clergy' && (sim.absDay - p.birthDay) / 16 >= 18 && (sim.absDay - p.birthDay) / 16 <= 45 && p.health.hp > 0.7;
  const me = opts.asDefender
    ? sim.state.residentsOf(castle.id).find((p) => grown(p) && !M.armyOfPerson.has(p.id))!
    : opts.asCommander ? sim.state.persons.get(A.commander)!
      : A.men.map((id) => sim.state.persons.get(id)!).find((p) => grown(p) && p.id !== A.commander)!;
  makePlayer(sim, me);
  A.x = castle.x + fort.half + 130; A.z = castle.z; A.px = A.x; A.pz = A.z;
  A.supplies = A.men.length * 200;
  A.morale = 1;
  return { sim, mil, combat, zone, player: me, fort, ka, kb, castleId: castle.id, armyId };
}
