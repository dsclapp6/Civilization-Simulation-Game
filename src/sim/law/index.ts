// Law (civilization pass, wave B, docs/CIV.md §4): trespass, patrols, captivity.
// PLACEHOLDER — the contract's shape with "no patrols, nobody held"; replaced by Builder B3.
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import type { LawApi } from './types';

export function installLaw(sim: Simulation, _deps: Wave3Deps): LawApi {
  const api: LawApi = {
    patrolFor: () => null,
    patrolChoices: () => [],
    answerPatrol: () => ({ ok: false, reason: 'No patrol' }),
    captivity: () => null,
    captivityChoices: () => [],
    chooseInCaptivity: () => ({ ok: false, reason: 'Not held' }),
    prisoners: () => [],
    version: () => 0,
  };
  sim.services.law = api;
  return api;
}
