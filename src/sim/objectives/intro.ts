// The scene-setting line for the first minutes (docs/CLARITY.md §6): "Spring. You wake in your father's cottage in
// Dromore; the barley must go in." Built from where the player lives and what the household needs first, so the
// card the UI shows after the birth reveal already points at the tutorial.
import { BUILDINGS } from '../../content/types';
import { SEASON_NAMES, toDate } from '../../core/time';
import { pickWork } from './choices';
import type { Obj } from './core';
import { homeOf } from './places';
import { headOf } from './roles';

/** What the household needs first, as a clause: "the barley must go in". */
function needClause(O: Obj): string {
  const me = O.me;
  if (!me) return '';
  const w = pickWork(O, me);
  if (!w) return '';
  const crop = /^(?:Sow|Reap)\s+(\w+)/i.exec(w.label)?.[1];
  switch (w.kind) {
    case 'strip':
      switch (w.strip?.task) {
        case 'plough': return 'the ground must be ploughed';
        case 'harrow': return 'the ground must be harrowed';
        case 'sow': return crop ? `the ${crop} must go in` : 'the seed must go in';
        case 'weed': return 'the corn needs weeding';
        case 'reap': return crop ? `the ${crop} is ripe and must be cut` : 'the crop is ripe and must be cut';
        case 'bind': return 'the cut corn must be bound before the rain';
        case 'carry': return 'the sheaves must be carried in';
        default: return '';
      }
    case 'stock': case 'herd': return 'the animals need seeing to';
    case 'garden': return 'the garden needs digging';
    case 'craft': return 'there is work waiting at the bench';
    case 'barn': return 'the harvest waits in the barn to be threshed';
    case 'dig': return 'the quarry is open';
  }
}

/** "Spring. You wake in your father's cottage in Dromore; the barley must go in." */
export function introText(O: Obj): string {
  const me = O.me;
  if (!me) return '';
  const season = SEASON_NAMES[toDate(O.day).season];
  const home = homeOf(O, me);
  const place = O.settlementById.get(me.settlement)?.name ?? 'the village';
  const head = headOf(O, me);
  const rel = head ? O.deps.social.relationLabel(me.id, head.id) : '';
  const owner = /^your (father|mother|uncle|aunt|grandfather|grandmother|brother|sister|lord|master)$/.test(rel) ? `${rel}'s` : 'your family\'s';
  const house = home ? BUILDINGS[home.kind].name.toLowerCase() : 'home';
  const noble = O.state.run.birthClass === 'gentry' || O.state.run.birthClass === 'knightly' || O.state.run.birthClass === 'baronial';
  const where = noble && home && (home.kind === 'keep_stone' || home.kind === 'manor_house' || home.kind === 'great_hall')
    ? `You wake in ${owner} ${house} at ${place}` : `You wake in ${owner} ${house} in ${place}`;
  const need = needClause(O);
  return `${season}. ${where}${need ? `; ${need}` : ''}.`;
}
