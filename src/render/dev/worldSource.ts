// The world the dev viewer renders. Integrator: switch this one import to the real generator,
// e.g. `export { generateWorld as makeWorld } from '../../world/generate';`
import type { WorldModel } from '../../world/types';
import { createStubWorld } from './stubWorld';

export function makeWorld(seed: string): WorldModel {
  return createStubWorld(seed);
}
