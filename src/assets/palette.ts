// Shared colour palette (initial art direction). The art/asset owner may tune
// values; keys are part of the contract with the renderer and UI.
import { Ground } from '../world/types';
import type { Palette } from './types';

export const PALETTE: Palette = {
  ground: {
    [Ground.Grass]: 0x74a04c,
    [Ground.Meadow]: 0x8aae56,
    [Ground.Heath]: 0x86745f,
    [Ground.Moor]: 0x8b8452,
    [Ground.ForestFloor]: 0x56613a,
    [Ground.Dirt]: 0x8b6d47,
    [Ground.Mud]: 0x6b5034,
    [Ground.Sand]: 0xd8c48e,
    [Ground.Shingle]: 0xa49d8e,
    [Ground.Rock]: 0x8d8a83,
    [Ground.Snow]: 0xeef2f5,
    [Ground.Road]: 0xa38a63,
    [Ground.Path]: 0x9c8559,
    [Ground.Yard]: 0x8f7a55,
    [Ground.Field]: 0x8a6b44,
    [Ground.Marsh]: 0x5f7048,
    [Ground.Cobbles]: 0x8e8a80,
  } as Palette['ground'],
  water: { shallow: 0x4f9fb0, deep: 0x1f4f6e, foam: 0xe8f4f4 },
  sky: {
    dayTop: 0x5d8fd6, dayHorizon: 0xbfd9ef,
    duskTop: 0x4a4e8c, duskHorizon: 0xf0a868,
    nightTop: 0x0b1026, nightHorizon: 0x1d2a4a,
  },
  fog: { day: 0xc8dcea, dusk: 0xd9a98a, night: 0x1a2236 },
  sun: { day: 0xfff1d6, dusk: 0xffb070, moon: 0x9fb4d9 },
  ambient: { day: 0xb8c8d8, night: 0x3a4c80 },
  foliage: { spring: 0x9ccc65, summer: 0x6f9e3a, autumn: 0xc7883a, winter: 0x8a8f86 },
  thatch: 0xc8a35a,
  daub: 0xe6dcc3,
  timber: 0x5a3d26,
  stone: 0xa9a397,
  slate: 0x5d636b,
  roofTile: 0x9b5a3f,
  dyes: [
    [],
    [0x8c7b62, 0x7a6a52, 0x9a8a70, 0x6e5f4a],            // 1 unfree: undyed wool, russet
    [0x7f6a4f, 0x6b7a5a, 0x8a6f5a, 0x5f6b7a, 0x9b8a6a],  // 2 commoner: faded earth tones
    [0x4f6a8a, 0x6a7a3a, 0x8a5a3a, 0x7a6a8a],            // 3 middling: woad blue, green, madder brown
    [0x2f5a8a, 0x3a6a3a, 0x8a2f2f, 0x6a4a2a],            // 4 gentry
    [0x1f4a8a, 0x8a1f1f, 0x2f6a2f, 0x5a2a6a],            // 5 knight
    [0x8a1a2a, 0x1a3a7a, 0x4a1a5a, 0x1a5a3a],            // 6 baron: scarlet and deep dyes
    [0xa01c2c, 0x18306f, 0x5a1a6a, 0x0f4a2f],            // 7 magnate
    [0x6a1a7a, 0xb01c2c, 0x1a2a6a, 0xd4af37],            // 8 royal: purple, scarlet, gold trim
  ],
  skinTones: [0xf1d3c0, 0xe8c1a2, 0xd9a983, 0xc68e65, 0xa86f4c, 0x8a5636],
  hairColors: [0x2b1d14, 0x4a3020, 0x6b4428, 0x8a5a2c, 0xb07a3a, 0xd2b071, 0x9a3c1e, 0x8f8f8f, 0xd8d8d8],
};
