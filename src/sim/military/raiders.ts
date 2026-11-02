// Raiders on the player's lands: enemies come at least once a month (a month is a third of a season, about a day and
// a third). Every six hours the reckoning is made: when the day has come, the nearest hostile
// House (or, lacking one, the nearest grasping neighbour, who picks a feud) sends a band against one of the player's
// places — mostly the outlying villages, now and then the seat itself — sized to the men who would stand against it.
// A warning goes out with the way they come, so there is time to stand to arms.
import type { HouseId } from '../state';
import { addMan, raise, removeMen, settlementPoint } from './armies';
import { freshMen } from './recruits';
import { defendersOf } from './battle';
import type { Mil } from './store';

/** Days between raids on the player: a month at most (a season is four days, a month a third of it). */
export const RAID_EVERY = { min: 0.85, max: 4 / 3 - 0.25 }; // checked every six hours, so never more than a month apart
const FIRST_RAID_DAY = 1.5;
/** How far out the band is first seen: some six hours on foot. */
const BORDER_M = 200;

/** Sends a raiding band of about `size` men of `house` against `settlement`; returns the army id (0 = none). */
export function launchRaid(M: Mil, house: HouseId, settlement: number, size = 60): number {
  const pt = settlementPoint(M, settlement);
  const lord = M.realm.lordHouse(settlement);
  if (!pt || !house || lord === house) return 0;
  M.declareFeud(house, lord, 24, 'raid');
  const a = raise(M, house, 'raid', { vassals: false, intent: 'raid', target: { x: pt.x, z: pt.z, settlement } });
  if (!a) return 0;
  if (a.men.length > size) {
    // keep the professionals, drop levy from the tail
    const drop = new Set<number>();
    for (let i = a.men.length - 1; i >= 0 && a.men.length - drop.size > size; i--) if (a.units[i] === 'l' && a.men[i] !== a.commander) drop.add(a.men[i]);
    removeMen(M, a, drop);
  }
  return a.id;
}

const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
/** The way a band comes from, as a villager would say it (world +x east, +z south). */
export function fromWhere(dx: number, dz: number): string {
  const a = Math.atan2(dz, dx);
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return COMPASS[i];
}

/** The daily reckoning: is a raid on the player's lands due, and who comes? */
export function raidersDay(M: Mil): number {
  const mine = M.state.run.houseId;
  if (!mine) return 0;
  const lands = M.realm.settlementsOf(mine);
  if (lands.length === 0) return 0;
  const now = M.day;
  if (M.data.raidNext === undefined) M.data.raidNext = Math.max(now, FIRST_RAID_DAY);
  if (now < M.data.raidNext) return 0;
  // a band still on the road to a place: the next one does not ride on the same place
  const onTheRoad = new Set(M.allArmies().filter((a) => a.intent === 'raid' && a.house !== mine && a.task !== 'raid' && a.target?.settlement !== undefined).map((a) => a.target!.settlement!));

  const rng = M.rng('military.raiders');
  // the target: mostly an outlying place, sometimes the seat
  const seat = M.state.houses.get(mine)?.seat ?? lands[0];
  const open = lands.filter((s) => !onTheRoad.has(s));
  if (open.length === 0) { M.data.raidNext = now + 0.25; return 0; }
  const outlying = open.filter((s) => s !== seat);
  const sid = outlying.length > 0 && (rng.next() < 0.75 || !open.includes(seat)) ? outlying[Math.floor(rng.next() * outlying.length)] : seat;
  const pt = settlementPoint(M, sid);
  if (!pt) return 0;

  // who comes: enemies first, else the nearest neighbour outside our own chain of fealty
  const ours = new Set<HouseId>([mine, ...M.realm.chain(mine), ...M.realm.allVassals(mine)]);
  const enemies = M.realm.directEnemies(mine);
  const cands: Array<{ h: HouseId; d: number }> = [];
  for (const h of M.state.houses.values()) {
    if (h.extinct || ours.has(h.id) || (h.kind !== 'noble' && h.kind !== 'royal' && h.kind !== 'gentry')) continue;
    if (M.realm.settlementsOf(h.id).length === 0) continue;
    const sp = settlementPoint(M, h.seat);
    if (!sp) continue;
    const d = Math.hypot(sp.x - pt.x, sp.z - pt.z) * (enemies.has(h.id) ? 0.35 : 1);
    cands.push({ h: h.id, d });
  }
  cands.sort((a, b) => a.d - b.d);
  // the band is sized to the men who would stand against it: a fair fight, not a massacre
  const def = defendersOf(M, sid, M.realm.lordHouse(sid)).people.length;
  const size = Math.max(12, Math.min(70, Math.round(def * (0.7 + rng.next() * 0.5) + 8)));
  for (const c of cands.slice(0, 4)) {
    const id = launchRaid(M, c.h, sid, size);
    if (!id) continue;
    const a = M.army(id);
    if (a) {
      // the band has gathered in secret and comes over the border, a few hours from the place
      const sp = settlementPoint(M, M.state.houses.get(c.h)?.seat ?? sid) ?? { x: a.x, z: a.z };
      const dx = sp.x - pt.x, dz = sp.z - pt.z, dd = Math.hypot(dx, dz) || 1;
      const off = Math.min(dd, BORDER_M);
      a.x = pt.x + (dx / dd) * off; a.z = pt.z + (dz / dd) * off; a.px = a.x; a.pz = a.z;
      a.readyDay = now;
      // a small House hires swords to make up the band
      const short = Math.max(0, Math.min(size, 12 + Math.round(size * 0.6)) - a.men.length);
      if (short > 0) {
        const archers = Math.round(short * 0.25);
        for (const m of freshMen(M, c.h, M.state.houses.get(c.h)?.seat ?? sid, { mercenary: short - archers, archer: archers })) addMan(M, a, m.person, m.kind);
      }
    }
    M.data.raidNext = now + RAID_EVERY.min + rng.next() * (RAID_EVERY.max - RAID_EVERY.min);
    M.data.stats.raids++;
    if (a) {
      const way = fromWhere(a.x - pt.x, a.z - pt.z);
      M.notify(`Raiders! ${a.men.length} men of ${M.houseName(c.h)} ride on ${M.placeName(sid)} from the ${way}, some ${Math.max(1, Math.round((Math.hypot(a.x - pt.x, a.z - pt.z) / 760) * 24))} hours off. Stand to arms!`, 'danger');
      M.log('raid', `${M.houseName(c.h)} sent ${a.men.length} raiders against ${M.placeName(sid)}.`, [a.commander]);
    }
    return id;
  }
  M.data.raidNext = now + 0.5;
  return 0;
}
