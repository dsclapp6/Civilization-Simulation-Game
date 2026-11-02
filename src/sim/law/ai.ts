// The AI's trespassers (docs/CIV.md §4): poachers in the lord's park, outlaws on the roads, enemy scouts on hostile lands are caught
// and held the same way as the player — off-screen, once a day, cheaply: a few settlements are looked at each day and at most a
// handful of cases made, so the world has its prisoners without the law ever costing a frame.
import { hash01 } from '../../core/math';
import type { HouseId, Person } from '../state';
import { seizePerson } from './captive';
import { LAW } from './config';
import type { Law } from './context';

const DESPERATE_PURSE = 45;

/** Looks at a few settlements today and makes the cases they bring: a poacher caught, a bandit taken, a scout held. */
export function dailyCases(L: Law): void {
  const held = L.store.data.captives.length;
  if (held >= LAW.maxHeld) return;
  const places = L.world.settlements;
  const n = places.length;
  if (n === 0) return;
  const day = Math.floor(L.day);
  // a window that walks round the continent: every place is looked at every n / daily days
  const start = (day * LAW.daily) % n;
  let made = 0;
  for (let k = 0; k < LAW.daily && made < 2 && held + made < LAW.maxHeld; k++) {
    const s = places[(start + k) % n];
    const owner = L.territory?.ownerOf?.(s.id);
    if (!owner || !owner.holder || !owner.house) continue;
    if (poacher(L, s.id, owner.house, day)) { made++; continue; }
    if (bandit(L, s.id, owner.house, day)) { made++; continue; }
    if (scout(L, s.id, owner.house, day)) made++;
  }
}

/** The lord's armed men in a settlement: the strength of his watch. */
function watchOf(L: Law, settlement: number): Person[] {
  const out: Person[] = [];
  for (const p of L.state.residentsOf(settlement)) if (L.armed(p) && L.age(p) >= 17 && !p.flags.captive) out.push(p);
  return out;
}

/** The man who takes them: the best of the watch, else the lord's reeve. */
function captorOf(L: Law, settlement: number, watch: Person[]): number {
  const lead = [...watch].sort((a, b) => b.rankTier - a.rankTier || a.id - b.id)[0];
  return lead?.id ?? L.lordOf(settlement);
}

function poacher(L: Law, settlement: number, house: HouseId, day: number): boolean {
  const res = L.territory?.resources(settlement);
  const forest = res?.forest ?? 0.25;
  if (forest < 0.12) return false;
  const rate = LAW.poachRate * (0.55 + forest);
  if (L.rng().next() >= rate) return false;
  // a poor man from this place or the next: hunger sends them
  const from = L.world.settlements.find((s) => s.id === settlement);
  if (!from) return false;
  const places = [settlement, ...L.world.settlements
    .filter((s) => s.id !== settlement && Math.hypot(s.x - from.x, s.z - from.z) < 3600)
    .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z) || a.id - b.id)
    .slice(0, 2).map((s) => s.id)];
  const pool: Person[] = [];
  for (const id of places) {
    for (const p of L.state.residentsOf(id)) {
      if (p.sex !== 'm' || p.estate === 'clergy' || p.flags.captive || p.flags.player || p.id === L.playerId) continue;
      const age = L.age(p);
      if (age < 16 || age > 50 || L.armed(p) || p.rankTier > 2 || p.house === house) continue;
      const hh = L.state.households.get(p.household);
      if ((hh?.purse ?? 0) > DESPERATE_PURSE + 100 * hash01(p.id, day)) continue;
      pool.push(p);
    }
  }
  if (pool.length === 0) return false;
  const who = pool[Math.floor(L.rng().next() * pool.length) % pool.length];
  const watch = watchOf(L, settlement);
  // the watch has to see him: a strong watch and a small park
  if (L.rng().next() >= Math.min(0.85, 0.22 + 0.08 * watch.length)) return false;
  return !!seizePerson(L, who, captorOf(L, settlement, watch), 'poaching', settlement, "poaching the lord's deer", { level: 'private' });
}

function bandit(L: Law, settlement: number, house: HouseId, day: number): boolean {
  void house;
  let outlaw: Person | undefined;
  for (const p of L.state.residentsOf(settlement)) {
    if (!p.flags.outlaw || p.flags.captive || p.id === L.playerId) continue;
    if (!outlaw || hash01(p.id, day, 5) > hash01(outlaw.id, day, 5)) outlaw = p;
  }
  if (!outlaw) return false;
  if (L.rng().next() >= LAW.banditRate) return false;
  const watch = watchOf(L, settlement);
  if (L.rng().next() >= Math.min(0.8, 0.25 + 0.08 * watch.length)) return false;
  const blood = L.rng().next() < 0.45;
  return !!seizePerson(L, outlaw, captorOf(L, settlement, watch), 'crime', settlement, blood ? "robbery and the death of the lord's man" : 'robbery on the lord\'s roads', { bloodshed: blood, level: 'hostile' });
}

function scout(L: Law, settlement: number, house: HouseId, day: number): boolean {
  const pol = L.politics;
  if (!pol) return false;
  const wars = pol.warsOf(house);
  if (wars.length === 0) return false;
  if (L.rng().next() >= LAW.scoutRate) return false;
  const enemies = new Set<HouseId>();
  for (const w of wars) for (const h of w.attackers.includes(house) ? w.defenders : w.attackers) enemies.add(h);
  const pool: Person[] = [];
  for (const h of [...enemies].sort((a, b) => a - b)) {
    for (const p of L.state.houseMemberList(h)) {
      if (p.sex !== 'm' || p.flags.captive || p.flags.player || p.id === L.playerId) continue;
      if (p.career !== 'knight' && p.career !== 'sergeant' && p.career !== 'man_at_arms' && p.career !== 'squire') continue;
      if (L.military?.armyOf(p.id)) continue;
      const age = L.age(p);
      if (age < 17 || age > 55) continue;
      pool.push(p);
    }
  }
  if (pool.length === 0) return false;
  const who = pool[Math.floor(hash01(day, settlement, 9) * pool.length) % pool.length];
  const watch = watchOf(L, settlement);
  if (L.rng().next() >= Math.min(0.7, 0.18 + 0.07 * watch.length)) return false;
  return !!seizePerson(L, who, captorOf(L, settlement, watch), 'war', settlement, 'scouting the lord\'s lands', { level: 'hostile' });
}
