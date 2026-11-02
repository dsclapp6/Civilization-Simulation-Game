// Whose land a settlement's lands are: the title held over them (manor, barony, town, abbey, else the county or kingdom
// that holds the place) and the House of the person holding it. Mirrors how the military module finds a place's lord,
// so a place's lord and the House that fights for it agree.
import type { Settlement, WorldModel } from '../../world/types';
import { ageYears, type GameState, type HouseId, type PersonId, type Title, type TitleId } from '../state';
import { TERRITORY } from './config';

export interface Owner {
  /** House of the title's holder (0 = nobody holds it). */
  house: HouseId;
  /** The title the land is held under (0 = none). */
  title: TitleId;
  /** The titled person who holds it (0 = none). */
  holder: PersonId;
  /** The person who acts for the title: the holder, or his regent while he is a child or a captive (0 = none). */
  lord: PersonId;
}

export const NO_OWNER: Owner = { house: 0, title: 0, holder: 0, lord: 0 };

/** The title a settlement's lands are held under, before looking at who holds it. */
export function titleOfSettlement(state: GameState, world: WorldModel, s: Settlement): Title | undefined {
  const direct = state.titleFor('manor', s.id) ?? state.titleFor('barony', s.id) ?? state.titleFor('town', s.id) ?? state.titleFor('abbey', s.id);
  if (direct) return direct;
  // a county seat that is no barony (the earl's own castle), then the county and the kingdom
  const seatOf = world.counties.find((c) => c.seat === s.id);
  return (seatOf ? state.titleFor('county', seatOf.id) : undefined) ?? state.titleFor('county', s.county) ?? state.titleFor('kingdom', s.kingdom);
}

/** Resolves a title to its owner: a vacant or dead holder's lands are kept by his liege until the title is filled. */
export function resolveOwner(state: GameState, title: Title | undefined, absDay: number): Owner {
  if (!title) return NO_OWNER;
  let t: Title | undefined = title;
  for (let i = 0; t && i < 5; i++) {
    const p = state.persons.get(t.holder);
    if (p && !p.death) {
      let lord = p.id;
      if (ageYears(p, absDay) < TERRITORY.adultAge || p.flags.captive) {
        const regent = state.persons.get(t.regent);
        if (regent && !regent.death) lord = regent.id;
      }
      return { house: p.house, title: title.id, holder: p.id, lord };
    }
    t = t.liege ? state.titles.get(t.liege) : undefined;
  }
  return { house: 0, title: title.id, holder: 0, lord: 0 };
}
