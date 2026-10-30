// The world the dev viewer renders: the real continent generator (src/world/generate.ts).
import type { WorldModel } from '../../world/types';
import { generateWorld } from '../../world/generate';

export function makeWorld(seed: string): WorldModel {
  return generateWorld(seed);
}
