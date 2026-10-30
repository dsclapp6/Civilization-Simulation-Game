// A simulation with social, economy, advancement and happenings installed (no zone, no player module).
import { installAdvancement, type AdvancementInstall } from '../../../src/sim/advancement';
import { installEconomy, type EconomyRuntime } from '../../../src/sim/economy';
import type { Simulation } from '../../../src/sim/sim';
import { installSocial, socialInternals } from '../../../src/sim/social';
import type { SocialCore } from '../../../src/sim/social/core';
import type { SocialApi } from '../../../src/sim/social/types';
import type { Person } from '../../../src/sim/state';
import type { Wave3Deps } from '../../../src/sim/wave3deps';
import { newSim, type TestSimOptions } from '../helpers';
import { setClock, type Rig } from '../social/helpers';

export interface AdvSim {
  sim: Simulation;
  social: SocialApi;
  economy: EconomyRuntime;
  adv: AdvancementInstall;
  /** The same simulation as a social-test rig (villager(), begin(), pick() work on it). */
  rig: Rig;
  player: Person;
}

export function advSim(opts: TestSimOptions & { zone?: Wave3Deps['zone']; noon?: boolean } = {}): AdvSim {
  const sim = newSim({ preset: 'tiny', ...opts });
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const adv = installAdvancement(sim, { economy, social, zone: opts.zone });
  const player = playerOf(sim);
  const rig: Rig = { sim, social, core: socialInternals(sim) as SocialCore, player };
  if (opts.noon !== false) setClock(sim, 0.5);
  return { sim, social, economy, adv, rig, player };
}

export function playerOf(sim: Simulation): Person {
  return sim.state.persons.get(sim.state.run.playerId) as Person;
}

/** Removes everyone's knowledge of a tech (so a test starts from nothing). */
export function forget(adv: AdvancementInstall, tech: string): void {
  for (const id of adv.holders(tech).slice()) adv.adv.removeHolder(id, tech);
  delete adv.adv.save.rec[tech];
  delete adv.adv.save.lost[tech];
}
