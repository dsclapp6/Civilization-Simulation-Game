// Material colours and culture styles for architecture. All colours are sRGB hex,
// authored for the nominal lighting in ARCHITECTURE §5 (sun 3.0, hemi 0.9, ACES, exposure 1).
import type { CultureId } from '../../core/domain';
import { PALETTE } from '../palette';
import type { RoofMat } from './roof';

export const COL = {
  daub: PALETTE.daub,
  daubWarm: 0xe8d6b2,
  daubPink: 0xe6c3ae,
  daubOchre: 0xe2c78e,
  limewash: 0xefe9da,
  render: 0xe5dccb,
  timber: PALETTE.timber,
  timberDark: 0x3e2a1c,
  timberRed: 0x6a2f24,
  timberGrey: 0x7a6a58,
  timberRaw: 0x8a6a46,
  thatch: PALETTE.thatch,
  thatchOld: 0xa98c55,
  heather: 0x8c7650,
  stone: PALETTE.stone,
  stoneHoney: 0xc4b089,
  stonePale: 0xd8cfba,
  stoneGrey: 0x928f88,
  stoneDark: 0x77736c,
  stoneRed: 0xaa7462,
  stoneTrim: 0xcfc6b2,
  flint: 0x6f6b66,
  rubble: 0x8e877b,
  slate: PALETTE.slate,
  slateWelsh: 0x555a6a,
  stoneSlate: 0x8d8576,
  tile: PALETTE.roofTile,
  tileBrown: 0x7f5038,
  tileTeuton: 0xa65234,
  shingle: 0x7d654c,
  shingleTar: 0x4c3d30,
  turf: 0x6c8a3a,
  soil: 0x5a4632,
  lead: 0x7e858c,
  plank: 0x7a6248,
  plankTar: 0x433326,
  weatherboard: 0x3d332c,
  weatherboardGrey: 0x857868,
  brick: 0x9a5038,
  iron: 0x2f2d2b,
  ironRust: 0x5a3b2a,
  glass: 0x1d1814,
  doorOak: 0x6b4a2c,
  doorGreen: 0x3f5a3a,
  doorRed: 0x7a3226,
  doorBlue: 0x3e5670,
  shutterBlue: 0x5c7486,
  shutterGreen: 0x587a52,
  shutterOx: 0x7a3a2a,
  earth: 0x6f5a3c,
  mud: 0x5e4a33,
  yard: 0x8f7a55,
  grass: 0x6f9440,
  grassDark: 0x5b7d36,
  straw: 0xd8bb6a,
  hay: 0xc9ad5a,
  rope: 0xb59a6a,
  ridgeGreen: 0x5d7a36,
  iris: 0x7a5aa0,
  waterDeep: 0x2f5866,
  water: 0x3f7480,
  waterMurk: 0x5a4a2c,
  canvas: 0xe8e0c8,
  canvasDark: 0xbfb393,
  red: 0xa8302a,
  blue: 0x2f4f8a,
  green: 0x3f6a3a,
  yellow: 0xd9a830,
  gold: 0xc9a23a,
  white: 0xf2efe6,
  black: 0x2a2624,
  fire: 0xff8a2a,
  ember: 0xd2481a,
  glowWindow: 0xffb057,
  soot: 0x2b2522,
  char: 0x1f1a17,
  hide: 0x9a7350,
  wool: 0xe6dfcc,
  ore: 0x8a4f35,
  coal: 0x2b2826,
  sand: 0xcdb98a,
  lime: 0xe8e4da,
  bark: 0x5b4632,
} as const;

export type WallKind = 'daub' | 'stone' | 'rubble' | 'whitewash' | 'render' | 'planks' | 'weatherboard' | 'brick' | 'wattle';
export type FrameKind = 'none' | 'box' | 'square' | 'close' | 'fachwerk' | 'cruck';

export interface CultureStyle {
  id: CultureId;
  /** Walls of vernacular homes by level (1..3). */
  homeWall: [WallKind, WallKind, WallKind];
  homeFrame: [FrameKind, FrameKind, FrameKind];
  homeRoof: [RoofMat, RoofMat, RoofMat];
  /** Roof for wealthy/stone buildings (manor, guildhall, hall). */
  richRoof: RoofMat;
  churchRoof: RoofMat;
  farmRoof: RoofMat;
  /** Pitch in degrees for vernacular and church roofs. */
  pitch: number;
  churchPitch: number;
  /** Roof shape for small homes. */
  homeRoofShape: 'gable' | 'hip' | 'halfhip';
  daub: number;
  timber: number;
  stone: number;
  stoneTrim: number;
  plinth: number;
  thatch: number;
  /** Doors / shutters palettes. */
  doors: number[];
  shutters: number[];
  /** Gael blackhouse look: rounded, low, roped thatch. */
  roped: boolean;
  /** Norse crossed gable boards. */
  crossedGables: boolean;
  /** Franc iris-planted thatch ridge. */
  ridgeFlowers: boolean;
  /** Gael crow-stepped stone gables. */
  crowSteps: boolean;
  /** Wall-tower / keep turret roofs. */
  towerShape: 'square' | 'round';
  towerRoof: 'none' | 'cone' | 'pyramid';
  /** Church tower crown at the top level. */
  spire: 'none' | 'stone' | 'helm' | 'timber' | 'roundtower';
  bellcote: 'single' | 'double';
}

export const STYLES: Record<CultureId, CultureStyle> = {
  anglo: {
    id: 'anglo',
    homeWall: ['daub', 'daub', 'daub'],
    homeFrame: ['cruck', 'box', 'close'],
    homeRoof: ['thatch', 'thatch', 'tile'],
    richRoof: 'tile', churchRoof: 'lead', farmRoof: 'thatch',
    pitch: 50, churchPitch: 48, homeRoofShape: 'halfhip',
    daub: COL.daub, timber: COL.timber, stone: COL.stoneHoney, stoneTrim: 0xd6c8a6, plinth: COL.rubble, thatch: COL.thatch,
    doors: [COL.doorOak, COL.doorGreen, COL.doorOak, COL.doorRed], shutters: [COL.doorOak, COL.shutterGreen, COL.timber],
    roped: false, crossedGables: false, ridgeFlowers: false, crowSteps: false,
    towerShape: 'square', towerRoof: 'none', spire: 'none', bellcote: 'single',
  },
  franc: {
    id: 'franc',
    homeWall: ['render', 'daub', 'stone'],
    homeFrame: ['none', 'close', 'close'],
    homeRoof: ['thatch', 'tile', 'slate'],
    richRoof: 'slate', churchRoof: 'slate', farmRoof: 'tile',
    pitch: 57, churchPitch: 56, homeRoofShape: 'gable',
    daub: 0xebe3d1, timber: 0x5e4029, stone: COL.stonePale, stoneTrim: 0xe3dccb, plinth: 0xb9ae98, thatch: 0xc2a05c,
    doors: [COL.doorBlue, COL.doorOak, COL.shutterBlue], shutters: [COL.shutterBlue, COL.shutterGreen, 0x6f8a96],
    roped: false, crossedGables: false, ridgeFlowers: true, crowSteps: false,
    towerShape: 'round', towerRoof: 'cone', spire: 'stone', bellcote: 'single',
  },
  teuton: {
    id: 'teuton',
    homeWall: ['daub', 'daub', 'daub'],
    homeFrame: ['fachwerk', 'fachwerk', 'fachwerk'],
    homeRoof: ['thatch', 'tile', 'tile'],
    richRoof: 'tile', churchRoof: 'slate', farmRoof: 'tile',
    pitch: 55, churchPitch: 55, homeRoofShape: 'gable',
    daub: 0xefe6d2, timber: COL.timberRed, stone: COL.stoneRed, stoneTrim: 0xc79a86, plinth: 0x9a7a6a, thatch: 0xbf9d58,
    doors: [COL.timberRed, COL.doorGreen, COL.doorOak], shutters: [COL.doorGreen, COL.shutterOx, 0x4f6a4a],
    roped: false, crossedGables: false, ridgeFlowers: false, crowSteps: false,
    towerShape: 'square', towerRoof: 'pyramid', spire: 'helm', bellcote: 'single',
  },
  norse: {
    id: 'norse',
    homeWall: ['planks', 'planks', 'planks'],
    homeFrame: ['none', 'none', 'none'],
    homeRoof: ['turf', 'turf', 'shingle'],
    richRoof: 'shingle', churchRoof: 'shingle', farmRoof: 'turf',
    pitch: 40, churchPitch: 52, homeRoofShape: 'gable',
    daub: COL.plankTar, timber: 0x3b2b1f, stone: 0x8b8a85, stoneTrim: 0xa3a19b, plinth: 0x7d7b75, thatch: COL.thatchOld,
    doors: [0x4a3424, COL.doorRed, 0x3d4a5a], shutters: [0x4a3424, COL.doorRed],
    roped: false, crossedGables: true, ridgeFlowers: false, crowSteps: false,
    towerShape: 'square', towerRoof: 'pyramid', spire: 'timber', bellcote: 'single',
  },
  gael: {
    id: 'gael',
    homeWall: ['rubble', 'rubble', 'whitewash'],
    homeFrame: ['none', 'none', 'none'],
    homeRoof: ['heather', 'heather', 'slate'],
    richRoof: 'slate', churchRoof: 'stoneslate', farmRoof: 'heather',
    pitch: 46, churchPitch: 50, homeRoofShape: 'hip',
    daub: 0xe4e0d6, timber: 0x4a3a2a, stone: COL.stoneGrey, stoneTrim: 0xa8a49a, plinth: 0x7f7b73, thatch: COL.heather,
    doors: [COL.doorRed, 0x4a3a2a, COL.doorBlue], shutters: [0x4a3a2a, COL.doorRed],
    roped: true, crossedGables: false, ridgeFlowers: false, crowSteps: true,
    towerShape: 'round', towerRoof: 'none', spire: 'roundtower', bellcote: 'single',
  },
  cymric: {
    id: 'cymric',
    homeWall: ['whitewash', 'whitewash', 'whitewash'],
    homeFrame: ['none', 'none', 'none'],
    homeRoof: ['thatch', 'slate', 'slate'],
    richRoof: 'slate', churchRoof: 'slate', farmRoof: 'slate',
    pitch: 45, churchPitch: 48, homeRoofShape: 'gable',
    daub: COL.limewash, timber: 0x4a3626, stone: 0x9c978c, stoneTrim: 0xb5b0a4, plinth: 0x8a857a, thatch: 0xbf9f5c,
    doors: [COL.doorRed, COL.doorGreen, COL.doorBlue, 0x2f3a4a], shutters: [COL.doorGreen, COL.doorRed],
    roped: false, crossedGables: false, ridgeFlowers: false, crowSteps: false,
    towerShape: 'round', towerRoof: 'none', spire: 'none', bellcote: 'double',
  },
};

/** Colour for a wall kind given a culture style. */
export function wallColor(kind: WallKind, s: CultureStyle): number {
  switch (kind) {
    case 'daub': return s.daub;
    case 'stone': return s.stone;
    case 'rubble': return s.id === 'gael' ? COL.stoneGrey : COL.rubble;
    case 'whitewash': return s.id === 'gael' ? 0xe2ded4 : COL.limewash;
    case 'render': return s.id === 'franc' ? 0xebe3d1 : COL.render;
    case 'planks': return s.id === 'norse' ? COL.plankTar : COL.plank;
    case 'weatherboard': return COL.weatherboard;
    case 'brick': return COL.brick;
    case 'wattle': return 0x8a6e4a;
  }
}

export function roofTint(mat: RoofMat, s: CultureStyle): number | undefined {
  if (mat === 'thatch') return s.thatch;
  if (mat === 'tile') return s.id === 'teuton' ? COL.tileTeuton : s.id === 'franc' ? 0x9a5a3e : COL.tile;
  if (mat === 'slate') return s.id === 'cymric' ? COL.slateWelsh : s.id === 'gael' ? 0x5a6066 : COL.slate;
  if (mat === 'shingle') return s.id === 'norse' ? COL.shingleTar : COL.shingle;
  return undefined;
}
