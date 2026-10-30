// Fixtures for the combat tests: a simulation on the mock world with the placeholder economy and social,
// a fake zone that can summon people and animals (tests/player/fakes), and the combat module installed.
import { installCombat, type CombatModule } from '../../src/combat';
import type { Simulation } from '../../src/sim/sim';
import { installEconomy } from '../../src/sim/economy';
import { installSocial } from '../../src/sim/social';
import type { EconomyApi } from '../../src/sim/economy/types';
import type { SocialApi } from '../../src/sim/social/types';
import { SIM_DT } from '../../src/core/time';
import { ageYears, type Person } from '../../src/sim/state';
import { installPlayer } from '../../src/player';
import type { PlayerApi } from '../../src/player/types';
import { EMPTY_INPUT, type InputState } from '../../src/player/types';
import { FakeZone } from '../player/fakes';
import { newSim, type TestSimOptions } from '../sim/helpers';

export interface CombatRig {
  sim: Simulation;
  zone: FakeZone;
  combat: CombatModule;
  economy: EconomyApi;
  social: SocialApi;
  player?: PlayerApi;
}

export function combatRig(opts: TestSimOptions & { player?: boolean } = {}): CombatRig {
  const sim = newSim(opts);
  const zone = new FakeZone();
  zone.enableSummons();
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const player = opts.player ? installPlayer(sim, { zone, economy, social }) : undefined;
  const combat = installCombat(sim, { economy, social, zone, player });
  return { sim, zone, combat, economy, social, player };
}

/** Adult men from the mock world, not the player's household. */
export function adultMen(sim: Simulation, n: number, minAge = 18, maxAge = 40): Person[] {
  const me = sim.state.persons.get(sim.state.run.playerId)!;
  const out: Person[] = [];
  for (const p of sim.state.persons.values()) {
    if (out.length >= n) break;
    const age = ageYears(p, sim.absDay);
    if (p.death || p.sex !== 'm' || age < minAge || age > maxAge || p.household === me.household || p.estate === 'clergy') continue;
    out.push(p);
  }
  if (out.length < n) throw new Error('not enough men');
  return out;
}

/** Steps the sim for `seconds` of fixed 20 Hz time. */
export function stepFor(sim: Simulation, seconds: number): void {
  const n = Math.round(seconds / SIM_DT);
  for (let i = 0; i < n; i++) sim.step(SIM_DT);
}

export function input(over: Partial<InputState> = {}): InputState { return { ...EMPTY_INPUT, ...over }; }

export function setStats(p: Person, over: Partial<Record<'str' | 'end' | 'agi' | 'per' | 'int' | 'cha', number>>): void {
  for (const [k, v] of Object.entries(over)) { p.trained[k as 'str'] = v; p.potential[k as 'str'] = Math.max(p.potential[k as 'str'], v); }
}
