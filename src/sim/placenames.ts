// Names for the things the player can look at (clarity pass): "Your home", "Wat's smithy", "St Mary's church",
// "The Bell (alehouse)", "Your family's east strip · barley, ripe", "Common pasture", "Oak". Pure functions of the
// sim state and the world: the same building always gets the same saint or inn sign (a hash of its settlement and id).
// One source for every place name the player reads: the zone's hover and E prompts (src/agents) and the objectives'
// steps, tracker, journal and markers (src/sim/objectives) all name a building or strip through these functions.
import { BUILDINGS, type BuildingKind } from '../content/types';
import { hash01 } from '../core/math';
import type { BuildingState, GameState, Person, StripState } from './state';
import type { LandParcel, Strip, WorldModel } from '../world/types';

const SAINTS = [
  'Mary', 'Peter', 'Michael', 'Nicholas', 'Giles', 'Andrew', 'Oswald', 'Cuthbert', 'Margaret', 'Helen', 'Botolph', 'Swithun',
  'Edmund', 'Martin', 'Leonard', 'Lawrence', 'Bartholomew', 'Wilfrid', 'Aidan', 'Hilda', 'Alban', 'Dunstan', 'Ethelburga', 'George',
] as const;

const SIGNS = [
  'Bell', 'Plough', 'Swan', 'Crown', 'Red Lion', 'White Hart', 'Green Man', 'Fleece', 'Wheatsheaf', 'Anchor', 'Falcon', 'Mitre',
  'Three Tuns', 'Black Bull', 'Rose', 'Hand and Shears', 'Ram', 'Cock', 'Fox', 'Saracen\'s Head',
] as const;

/** Buildings named after the person who keeps them: "Wat's smithy". */
const KEPT: ReadonlySet<BuildingKind> = new Set<BuildingKind>([
  'smithy', 'carpenter', 'sawpit', 'tannery', 'weaver', 'fulling_mill', 'bakehouse', 'brewhouse', 'watermill', 'windmill', 'kiln',
  'barn', 'granary', 'cowshed', 'stable', 'sheepfold', 'pigsty', 'henhouse', 'dovecote', 'warehouse', 'bloomery', 'charcoal_mound',
]);
const HOMES: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['hovel', 'cottage', 'longhouse', 'townhouse']);

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

export interface NameContext { state: GameState; world: WorldModel }

function placeOf(c: NameContext, settlement: number): string {
  return c.world.settlements.find((s) => s.id === settlement)?.name ?? '';
}

function headOf(c: NameContext, b: BuildingState): Person | null {
  if (!b.household) return null;
  const hh = c.state.households.get(b.household);
  const head = hh ? c.state.persons.get(hh.head) : undefined;
  return head && !head.death ? head : null;
}

function playerHousehold(c: NameContext): number {
  return c.state.persons.get(c.state.run.playerId)?.household ?? 0;
}

const possessive = (first: string): string => `${first}'s`;

/** "Your home", "Wat's smithy", "St Mary's church", "The Bell (alehouse)", "The market cross". */
export function buildingName(c: NameContext, b: BuildingState): string {
  const def = BUILDINGS[b.kind];
  const mine = playerHousehold(c);
  const hh = mine !== 0 ? c.state.households.get(mine) : undefined;
  if (hh && (hh.home === b.id) ) return 'Your home';
  const own = mine !== 0 && b.household === mine;
  const plain = lower(def.name);
  const place = placeOf(c, b.settlement);
  switch (b.kind) {
    case 'church': case 'chapel': case 'abbey_church': case 'cathedral': {
      const saint = SAINTS[Math.floor(hash01(b.settlement, 17, 3) * SAINTS.length) % SAINTS.length];
      const word = b.kind === 'church' ? 'church' : b.kind === 'chapel' ? 'chapel' : b.kind === 'abbey_church' ? 'abbey church' : 'cathedral';
      return `St ${saint}'s ${word}`;
    }
    case 'alehouse': case 'tavern': {
      const sign = SIGNS[Math.floor(hash01(b.id, b.settlement, 29) * SIGNS.length) % SIGNS.length];
      return `The ${sign} (${b.kind})`;
    }
    case 'manor_house': return place ? `${place} manor` : 'The manor house';
    case 'keep_stone': case 'motte': return place ? `${place} castle` : def.name;
    case 'great_hall': return place ? `The great hall of ${place}` : 'The great hall';
    case 'market_cross': case 'market_hall': case 'well': case 'stocks': case 'gallows': case 'school': case 'guildhall': case 'infirmary':
    case 'cloister': case 'gatehouse': case 'tower': case 'barracks': case 'archery_butts': case 'training_yard': case 'dock': case 'quarry': case 'mine':
      return `The ${plain}`;
    default: break;
  }
  if (own) return b.kind === 'cottage' || b.kind === 'longhouse' || b.kind === 'hovel' || b.kind === 'townhouse' ? 'Your home' : `Your ${plain}`;
  if (HOMES.has(b.kind)) {
    const head = headOf(c, b);
    return head ? `${possessive(head.first)} ${plain}` : `Empty ${plain}`;
  }
  if (KEPT.has(b.kind)) {
    const head = headOf(c, b);
    return head ? `${possessive(head.first)} ${plain}` : `The ${plain}`;
  }
  return def.name;
}

// ---------------------------------------------------------------------------------------------
// Strips and parcels
// ---------------------------------------------------------------------------------------------

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/** Which side of the settlement a point lies on ("east"), x east and z south. */
export function compassWord(fromX: number, fromZ: number, x: number, z: number): string {
  const ang = Math.atan2(x - fromX, -(z - fromZ));
  const i = Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return COMPASS[i];
}

const CROP_WORDS: Record<string, string> = {
  wheat: 'wheat', rye: 'rye', barley: 'barley', oats: 'oats', peas: 'peas', beans: 'beans', flax: 'flax', fallow: 'fallow',
};

/** "ripe", "ploughed", "sown", "growing", "cut", "stubble"… */
export function stripStageWord(st: StripState): string {
  switch (st.state) {
    case 'bare': return 'bare';
    case 'fallow': return 'fallow';
    case 'ploughed': return 'ploughed';
    case 'sown': return 'sown';
    case 'growing': return st.growth < 0.3 ? 'sprouting' : st.growth < 0.8 ? 'growing' : 'nearly ripe';
    case 'ripe': return 'ripe';
    case 'harvested': return 'cut';
    case 'stubble': return 'stubble';
    default: return '';
  }
}

/** "Your family's east strip · barley, ripe". */
export function stripName(c: NameContext, world: Strip, st: StripState | undefined): string {
  const set = c.world.settlements.find((s) => s.id === (st?.settlement ?? -1));
  let cx = 0, cz = 0;
  for (const p of world.poly) { cx += p.x; cz += p.z; }
  const n = Math.max(1, world.poly.length);
  const dir = set ? compassWord(set.x, set.z, cx / n, cz / n) : '';
  const mine = playerHousehold(c);
  let owner: string;
  if (!st) owner = 'A';
  else if (mine !== 0 && st.holder === mine) owner = "Your family's";
  else if (st.holder === 0) owner = "The lord's";
  else {
    const hh = c.state.households.get(st.holder);
    const head = hh ? c.state.persons.get(hh.head) : undefined;
    owner = head && !head.death ? possessive(head.first) : "A neighbour's";
  }
  const what = !st ? 'fallow' : st.crop === 'fallow' || st.state === 'fallow' || st.state === 'bare' ? stripStageWord(st) || 'fallow' : `${CROP_WORDS[st.crop] ?? st.crop}, ${stripStageWord(st)}`;
  return `${owner} ${dir ? `${dir} ` : ''}strip${st ? ` · ${what}` : ''}`;
}

const PARCEL_WORDS: Record<LandParcel['use'], string> = {
  pasture: 'Common pasture', meadow: 'Common meadow', garden: 'Garden', orchard: 'Orchard', woodlot: 'Woodlot', demesne: "The lord's close",
};
export function parcelName(use: LandParcel['use']): string { return PARCEL_WORDS[use] ?? 'Land'; }

