// The military (wave 3): forces of every House, levies and recruitment, armies on the map, battles, sieges,
// raids, ransom, and the player's military life. `installMilitary(sim, deps)` registers the macro systems on
// the scheduler, the map-marker wrapper, and `sim.services.military`; everything works headless (no zone,
// player, combat or politics needed — the others are looked up lazily on `sim.services`).
import { dist } from '../../core/math';
import { setRank } from '../succession';
import { ageYears, type HouseId, type PersonId } from '../state';
import type { ArmyView } from '../wave3';
import type { Wave3Deps } from '../wave3deps';
import type { Simulation } from '../sim';
import {
  armiesOf, detailOf, disband, giveOrder, nearestSettlementId, raise, removeMen, settlementPoint, upkeepDay, viewOf,
} from './armies';
import { battleInfo, checkContacts, onFightEnded, stepBattles } from './battle';
import { dailyCampaign, hourlyArmies } from './campaign';
import { CareerSystem } from './career';
import { CFG } from './config';
import { ForceCache, armsQuality, levySizeFor, recruitTests } from './forces';
import { captiveOf, captiveView, payRansom, ransomValue, tickCaptives, adoptCaptive } from './harm';
import { installMarkers } from './markers';
import { RaidSystem } from './raid';
import { Realm } from './realm';
import { SiegeSystem } from './siege';
import { Mil } from './store';
import { MusterView } from './musterview';
import { UNIT_CHAR, CHAR_UNIT, type MilitaryRuntime } from './types';

export type { MilitaryRuntime } from './types';
export * from './types';

export function installMilitary(sim: Simulation, deps: Wave3Deps): MilitaryRuntime {
  const M = new Mil(sim, deps);
  M.realm = new Realm(M);
  M.forces = new ForceCache(M);
  M.sieges = new SiegeSystem(M);
  M.raids = new RaidSystem(M);
  M.career = new CareerSystem(M);
  const offs: Array<() => void> = [];
  const muster = new MusterView(M);

  // ---- the combat module installs after us: hook its fight reports on first use ----
  let hooked: unknown = null;
  const ensureHooks = (): void => {
    const c = sim.services.combat;
    if (!c || hooked === c) return;
    hooked = c;
    offs.push(c.onFightEnded((r) => onFightEnded(M, r)));
  };

  // ---- systems ----
  offs.push(sim.registerSystem({
    name: 'military.hour', phase: 'hourly', order: 60,
    run: () => {
      ensureHooks();
      if (M.data.armies.length === 0 && M.data.battles.length === 0) return;
      hourlyArmies(M);
      checkContacts(M);
      M.touch();
    },
  }));
  offs.push(sim.registerSystem({
    name: 'military.day', phase: 'daily', order: 60,
    run: () => {
      ensureHooks();
      M.forces.clear();
      dailyCampaign(M);
      for (const a of M.allArmies().slice()) {
        if (!M.armyById.has(a.id)) continue;
        if (a.reason === 'sally') continue;
        upkeepDay(M, a);
      }
      M.sieges.tick();
      tickCaptives(M);
      M.career.daily();
      repairDamage(M);
      void CFG;
    },
  }));
  offs.push(sim.registerSystem({
    name: 'military.step', phase: 'perStep', order: 65,
    run: (_ctx, info) => {
      if (M.data.battles.length > 0) stepBattles(M, info.dt);
      if (M.data.armies.length > 0) { M.career.carry(); muster.step(info.dt); }
    },
  }));

  // ---- the player's world ----
  offs.push(sim.events.on('playerSwitched', () => M.career.reset()));
  offs.push(sim.events.on('captured', (e) => adoptCaptive(M, e.captive, e.captor, e.ransom)));
  const prevHostile = sim.hostileNear;
  sim.hostileNear = () => M.data.battles.some((b) => b.fight !== 0 && b.result === '') || prevHostile();
  offs.push(installMarkers(M));

  const toView = (id: number): ArmyView | undefined => { const a = M.army(id); return a ? viewOf(M, a) : undefined; };

  const api: MilitaryRuntime = {
    // ---- the cross-module surface (sim/wave3.ts) ----
    armies: () => M.allArmies().map((a) => viewOf(M, a)),
    raise: (house, reason) => raise(M, house, reason)?.men.length ?? 0,
    armyOf: (person) => M.armyOfPerson.get(person) ?? 0,

    // ---- armies ----
    armyDetail: (id) => { const a = M.army(id); return a ? detailOf(M, a) : null; },
    armiesOf: (house) => armiesOf(M, house),
    roster: (id) => {
      const a = M.army(id);
      return a ? a.men.map((p, i) => ({ person: p, kind: CHAR_UNIT[a.units[i]] ?? 'levy' })) : [];
    },
    raiseArmy: (house, reason, opts) => raise(M, house, reason, opts)?.id ?? 0,
    order: (id, order) => { const a = M.army(id); return a ? giveOrder(M, a, order) : { ok: false, reason: 'No such army' }; },
    disband: (id) => { const a = M.army(id); if (!a) return { ok: false, reason: 'No such army' }; if (a.engaged) return { ok: false, reason: 'The army is in battle' }; disband(M, a); return { ok: true }; },
    raid(house, settlement, opts) {
      const pt = settlementPoint(M, settlement);
      const lord = M.realm.lordHouse(settlement);
      if (!pt || !house || lord === house) return 0;
      M.declareFeud(house, lord, 24, 'raid');
      const a = raise(M, house, 'raid', { vassals: false, intent: 'raid', target: { x: pt.x, z: pt.z, settlement } });
      if (!a) return 0;
      const size = opts?.size ?? 60;
      if (a.men.length > size) {
        // keep the professionals, drop levy from the tail
        const drop = new Set<PersonId>();
        for (let i = a.men.length - 1; i >= 0 && a.men.length - drop.size > size; i--) if (a.units[i] === 'l' && a.men[i] !== a.commander) drop.add(a.men[i]);
        removeMen(M, a, drop);
      }
      return a.id;
    },
    declareFeud: (a, b, days, cause) => M.declareFeud(a, b, days, cause),
    hostile: (a, b) => M.realm.hostile(a, b),

    // ---- forces ----
    forces: (house) => M.forces.summary(house),
    strength: (house) => M.forces.summary(house).strength,
    levyPool: (house) => M.forces.summary(house).levyPool,
    levySize: (house, reason) => levySizeFor(M, house, reason),
    lordHouse: (settlement) => M.realm.lordHouse(settlement),
    recruitTests(person) {
      const p = M.person(person);
      if (!p) return [];
      return recruitTests(M, p, false).map((t) => ({ role: t.role, label: t.label, met: t.met, lines: t.lines }));
    },
    hireMercenaries(house, count, kind) {
      return hire(M, house, count, kind);
    },
    armsQuality: (person) => { const p = M.person(person); return p ? armsQuality(M, p) : 0; },

    // ---- battles, sieges, raids, ransom ----
    sieges: () => M.sieges.views(),
    siegeAt: (settlement) => { const r = M.sieges.recOf(settlement); return r ? M.sieges.view(r) : null; },
    battles: () => battleInfo(M),
    captives: () => M.data.captives.map((c) => captiveView(M, c)),
    captiveOf: (person) => { const c = captiveOf(M, person); return c ? captiveView(M, c) : null; },
    payRansom: (captive, payer) => payRansom(M, captive, payer),
    ransomValue: (person) => { const p = M.person(person); return p ? ransomValue(M, p) : 0; },

    // ---- the player's military life ----
    service: () => M.career.service(),
    answerCall: (accept) => M.career.answerCall(accept),
    leaveService: () => M.career.leaveService(),
    command: (order) => M.career.command(order),
    commandLevel: (person) => M.career.commandLevel(person),
    joinArmy: (army, person) => M.career.joinArmy(army, person),
    callLevy() {
      const p = M.alive(M.playerId);
      if (!p) return { ok: false, reason: 'Nobody to command' };
      const house = M.state.houses.get(p.house);
      if (!house || house.head !== p.id) return { ok: false, reason: 'Only the head of a House calls its levy' };
      if (p.rankTier < 5 && M.realm.settlementsOf(house.id).length === 0) return { ok: false, reason: 'You hold no manor to raise a levy from' };
      if (M.allArmies().some((a) => a.house === house.id && a.reason !== 'sally')) return { ok: false, reason: 'Your House already has an army in the field' };
      const a = raise(M, house.id, 'war', { commander: p.id, join: p.id });
      if (!a) return { ok: false, reason: 'There are not enough men to raise' };
      M.data.player.last = a.id;
      M.career.joinSelf(a);
      return { ok: true };
    },
  };
  void toView; void nearestSettlementId; void ageYears; void setRank; void dist; void UNIT_CHAR;
  sim.services.military = api;
  return api;
}

/** Mercenary companies for hire (SPEC §13): free swords taken on at a signing fee and a daily wage. */
function hire(M: Mil, house: HouseId, count: number, kind: 'archer' | 'man_at_arms' | 'crossbow' = 'man_at_arms'): number {
  const h = M.state.houses.get(house);
  if (!h || count <= 0) return 0;
  const seat = M.settlementById.get(h.seat);
  if (!seat) return 0;
  const taken = new Set(Object.keys(M.data.hired).map(Number));
  const cands: Array<{ p: ReturnType<Mil['person']> & object; score: number }> = [];
  for (const s of M.world.settlements) {
    if (dist(s.x, s.z, seat.x, seat.z) > 5500) continue;
    for (const p of M.state.residentsOf(s.id)) {
      if (p.sex !== 'm' || p.estate === 'clergy' || p.flags.captive || taken.has(p.id) || M.armyOfPerson.has(p.id)) continue;
      const age = ageYears(p, M.day);
      if (age < 18 || age > 42 || p.health.hp < 0.8) continue;
      if (p.house === house || p.id === M.playerId) continue;
      const free = p.career === 'labourer' || p.career === 'soldier' || p.career === 'cottar' || p.career === 'none' || p.career === 'outlaw' || p.career === 'archer' || p.career === 'man_at_arms';
      if (!free) continue;
      const score = p.trained.str + p.trained.end + (kind === 'archer' || kind === 'crossbow' ? (p.skills.archery / 40) : (p.skills.melee / 40)) + (p.career === 'soldier' ? 6 : 0) + (p.id % 7) * 0.01;
      cands.push({ p, score });
    }
  }
  cands.sort((a, b) => b.score - a.score || a.p.id - b.p.id);
  const fee = 12;
  const wage = kind === 'man_at_arms' ? 5 : 3.5;
  let n = 0;
  for (const c of cands) {
    if (n >= count) break;
    if (M.realm.debit(house, fee) < fee - 0.01) break;
    c.p.money = Math.round((c.p.money + fee) * 100) / 100;
    M.state.touch(c.p);
    M.data.hired[c.p.id] = { h: house, w: wage, u: M.day + 32, k: kind === 'archer' ? 'a' : kind === 'crossbow' ? 'x' : 'm' };
    n++;
  }
  if (n > 0) {
    // they go straight to a mustering army of the House, if there is one
    const a = M.allArmies().find((x) => x.house === house && (x.task === 'muster' || x.task === 'garrison') && x.reason !== 'sally');
    if (a) {
      for (const c of cands) {
        const rec = M.data.hired[c.p.id];
        if (!rec || rec.h !== house || M.armyOfPerson.has(c.p.id)) continue;
        a.men.push(c.p.id);
        a.units += rec.k === 'a' ? 'a' : rec.k === 'x' ? 'x' : 'c';
        M.armyOfPerson.set(c.p.id, a.id);
      }
    }
    M.touch();
    M.log('muster', `${M.houseName(house)} hired ${n} mercenaries.`);
  }
  return n;
}

/** Buildings damaged by raids and sieges are repaired slowly by the settlement's carpenters and masons. */
function repairDamage(M: Mil): void {
  const day = Math.floor(M.day);
  if (day % 4 !== 0) return;
  const besieged = new Set(M.data.sieges.map((s) => s.settlement));
  for (const b of M.state.buildings.values()) {
    if (b.damage <= 0 || b.onFire || besieged.has(b.settlement)) continue;
    b.damage = Math.max(0, Math.round((b.damage - 0.05) * 1000) / 1000);
    M.state.touchBuilding(b);
  }
}
