// What an army does when its march ends, by intent: besiege, raid, garrison, or go home.
import { disband } from './armies';
import type { Mil } from './store';
import type { Army } from './types';

export function arrivalOf(M: Mil, a: Army): void {
  const t = a.target;
  const sid = t?.settlement;
  const idle = (): void => { a.task = 'garrison'; a.target = undefined; a.from = undefined; a.progress = 0; M.touch(); };
  if (a.intent === 'return') {
    idle();
    disband(M, a, 'home from the field');
    return;
  }
  if (sid === undefined) { idle(); if (a.intent === 'attack' || a.intent === 'defend') a.intent = 'none'; return; }
  const lord = M.realm.lordHouse(sid);
  const friendly = !lord || lord === a.house || M.realm.chain(a.house).includes(lord) || M.realm.chain(lord).includes(a.house);
  switch (a.intent) {
    case 'raid':
      if (friendly) { idle(); return; }
      a.target = undefined;
      M.raids.arrive(a, sid);
      return;
    case 'attack':
    case 'siege':
      if (friendly) { idle(); a.intent = 'garrison'; return; }
      if (!M.realm.hostile(a.house, lord)) M.declareFeud(a.house, lord, 24, 'attack');
      a.target = undefined;
      a.from = undefined;
      M.sieges.begin(a, sid);
      return;
    default:
      idle();
      if (a.intent === 'garrison') a.task = 'garrison';
  }
}
