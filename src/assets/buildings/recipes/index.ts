// Recipe registry: one function per building kind in content/buildings.json.
import type { BuildingDef, BuildingKind } from '../../../content/types';
import type { Ctx } from '../parts';
import { cottage, hovel, longhouse, manorHouse, townhouse } from './homes';
import { barn, cowshed, dovecote, granary, henhouse, pigsty, sheepfold, stable, titheBarn } from './farm';
import {
  bakehouse, bloomery, brewhouse, carpenter, charcoalMound, dock, fullingMill, kiln, mine, quarry, sawpit, smithy,
  tannery, watermill, weaver, windmill,
} from './work';
import { alehouse, guildhall, marketCross, marketHall, marketStall, tavern, warehouse } from './social';
import { abbeyChurch, cathedral, chapel, church, cloister, infirmary } from './church';
import { gallows, library, school, stocks, well } from './civic';
import { clayPit, gaol, lumberCamp, saltPan, slaughterhouse } from './civ';
import { archeryButts, barracks, curtainWall, gatehouse, greatHall, keepStone, motte, palisade, tent, trainingYard, wallTower } from './defence';

export type Recipe = (ctx: Ctx, def: BuildingDef) => void;

export const RECIPES: Record<BuildingKind, Recipe> = {
  hovel, cottage, longhouse, townhouse, manor_house: manorHouse,
  barn, tithe_barn: titheBarn, granary, cowshed, stable, sheepfold, pigsty, henhouse, dovecote,
  watermill: (c, d) => watermill(c, d), windmill, smithy, carpenter, sawpit, tannery, weaver, fulling_mill: fullingMill,
  bakehouse, brewhouse, kiln, charcoal_mound: charcoalMound, bloomery, quarry, mine, dock,
  alehouse, tavern,
  market_stall: marketStall, market_cross: marketCross, market_hall: marketHall, guildhall, warehouse,
  chapel, church, abbey_church: abbeyChurch, cloister, cathedral, infirmary,
  well, stocks, gallows, school,
  palisade, wall: curtainWall, tower: wallTower, gatehouse, motte, keep_stone: keepStone,
  great_hall: greatHall, barracks, archery_butts: archeryButts, training_yard: trainingYard, tent,
  // civilization pass (docs/CIV.md §5, §7, §8): the new works and the lock-up
  slaughterhouse, clay_pit: clayPit, salt_pan: saltPan, lumber_camp: lumberCamp, gaol,
  // the library: a stone hall of books with a reading room built on
  library,
};
