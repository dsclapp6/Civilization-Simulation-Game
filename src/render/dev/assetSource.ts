// The asset library the dev viewer uses. Integrator: switch this one import to the real library,
// e.g. `export { createAssetLibrary as makeAssets } from '../../assets';`
import type { AssetLibrary } from '../../assets/types';
import { createPlaceholderAssets } from './placeholderAssets';

export function makeAssets(): AssetLibrary {
  return createPlaceholderAssets();
}
