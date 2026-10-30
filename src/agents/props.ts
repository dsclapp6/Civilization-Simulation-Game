// What a person holds and carries for an activity (the routine's props, shared with the player).
import type { CarryLook, HeldItem } from '../core/view';
import { isNight } from '../core/time';
import type { Person } from '../sim/state';
import { workProps } from './schedule';
import type { Activity } from './types';

export function propsFor(p: Person | undefined, activity: Activity, absDay = 0): { mainHand: HeldItem; offHand: HeldItem; carry: CarryLook } {
  const none = { mainHand: 'none' as HeldItem, offHand: 'none' as HeldItem, carry: 'none' as CarryLook };
  switch (activity) {
    case 'work': {
      if (!p) return none;
      const w = workProps(p.career);
      return { mainHand: w.main, offHand: w.off, carry: w.carry };
    }
    case 'market': return { mainHand: 'none', offHand: 'none', carry: 'basket' };
    case 'practice': return { mainHand: p && (p.career === 'squire' || p.career === 'knight') ? 'sword' : 'longbow', offHand: 'none', carry: 'none' };
    case 'guard': return { mainHand: 'spear', offHand: 'none', carry: 'none' };
    case 'patrol': return { mainHand: isNight(absDay) ? 'torch' : 'spear', offHand: 'none', carry: 'none' };
    case 'alehouse': return { mainHand: 'cup', offHand: 'none', carry: 'none' };
    case 'errand': return { mainHand: 'none', offHand: 'none', carry: 'bucket' };
    case 'fight': return { mainHand: 'sword', offHand: 'none', carry: 'none' };
    case 'travel': return { mainHand: 'staff', offHand: 'none', carry: 'sack' };
    default: return none;
  }
}
