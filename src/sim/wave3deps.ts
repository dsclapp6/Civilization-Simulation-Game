// What every wave 3 installer receives (sim/wave3.ts explains how the modules find each other).
import type { ZoneApi } from '../agents/types';
import type { PlayerApi } from '../player/types';
import type { EconomyApi } from './economy/types';
import type { SocialApi } from './social/types';

export interface Wave3Deps {
  economy: EconomyApi;
  social: SocialApi;
  /** Absent in headless runs and most tests. */
  zone?: ZoneApi;
  player?: PlayerApi;
}
