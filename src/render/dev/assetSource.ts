// The asset library the dev viewer uses: the real procedural library (src/assets/library.ts).
import type { AssetLibrary } from '../../assets/types';
import { createAssetLibrary } from '../../assets/library';

export function makeAssets(): AssetLibrary {
  return createAssetLibrary();
}
