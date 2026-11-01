// Placeholder (clarity pass: the objectives builder replaces this file): no objectives yet.
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import type { ObjectivesApi } from './types';

export function installObjectives(_sim: Simulation, _deps: Wave3Deps): ObjectivesApi {
  return {
    list: () => [],
    tracked: () => null,
    track: () => {},
    suggestions: () => [],
    daySummary: () => null,
    trackPerson: () => {},
  };
}
