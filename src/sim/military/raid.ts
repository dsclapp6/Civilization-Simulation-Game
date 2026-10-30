// Raids (SPEC §13, §16): burn strips and buildings, steal herds and stores, take captives. The harsh AI's
// favourite tool — it needs only a handful of men and costs the target its harvest, its beasts and its people.
import { BUILDINGS } from '../../content/types';
import type { PersonId, Person } from '../state';
import { disband, giveOrder, nearestSettlementId, settlementPoint } from './armies';
import { defendersOf, startBattle } from './battle';
import { ransomValue, takeCaptive } from './harm';
import { fortBonus } from './siege';
import type { Mil } from './store';
import { UNIT_CHAR, type Army } from './types';

const RAID_HOURS = 20;
const SPARED: ReadonlySet<string> = new Set(['church', 'cathedral', 'abbey_church', 'chapel', 'cloister']);

function livestockKeys(M: Mil, stores: Record<string, number>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(stores)) {
    if ((stores[key] ?? 0) <= 0 || key.charCodeAt(0) === 126) continue;
    const base = key.includes('#') ? key.slice(0, key.indexOf('#')) : key;
    if (M.economy.good(base)?.category === 'livestock') out.push(key);
  }
  return out;
}

function priceOf(M: Mil, key: string): number {
  const base = key.includes('#') ? key.slice(0, key.indexOf('#')) : key;
  return M.economy.good(base)?.basePrice ?? 5;
}

export class RaidSystem {
  constructor(private readonly M: Mil) {}

  /** The raiders reach the village: the villagers' militia may stand against them, else the work begins. */
  arrive(a: Army, sid: number): void {
    const M = this.M;
    const lord = M.realm.lordHouse(sid);
    if (lord && !M.realm.hostile(a.house, lord) && !M.realm.chain(lord).includes(a.house)) M.declareFeud(a.house, lord, 24, 'raid');
    a.target = undefined;
    a.from = undefined;
    a.progress = 0;
    a.intent = 'raid';
    a.raid = { sid, hours: RAID_HOURS, burned: 0, stolen: 0, captives: 0, strips: 0, loot: 0 };
    a.task = 'raid';
    M.touch();
    // the village stands to arms
    const def = defendersOf(M, sid, lord);
    const people = def.people.filter((p) => !M.armyOfPerson.has(p.id));
    if (people.length >= 6) {
      const pt = settlementPoint(M, sid) ?? { x: a.x, z: a.z };
      const sally: Army = {
        id: M.data.nextArmy++, house: lord, commander: def.leader?.id ?? people[0].id, x: pt.x, z: pt.z, px: pt.x, pz: pt.z, task: 'garrison', intent: 'defend',
        men: people.map((p) => p.id), units: people.map((p) => UNIT_CHAR[def.kinds[def.people.indexOf(p)] ?? 'levy']).join(''), home: sid, war: 0,
        reason: 'sally', supplies: 0, morale: 0.55, funds: 0, owed: 0, since: M.day, readyDay: M.day, progress: 0, stance: 'hold', engaged: 0, orderDay: M.day, vassals: [],
      };
      M.addArmy(sally);
      startBattle(M, a, sally, { settlement: sid, fort: Math.min(1.25, fortBonus(M, sid)), fixed: true });
    }
  }

  /** After the village militia fought: the raid goes on if the raiders held the field. */
  afterBattle(a: Army, attWon: boolean): void {
    if (!a.raid || !this.M.armyById.has(a.id)) return;
    if (attWon) a.task = 'raid';
    else { a.raid = undefined; a.intent = 'return'; }
  }

  /** Hourly while an army raids. */
  hour(a: Army): void {
    const M = this.M;
    const r = a.raid;
    if (!r) { a.task = 'garrison'; return; }
    const rng = M.rng('military.raid');
    const st = M.state;
    const sid = r.sid;
    if (r.hours <= 0) { this.finish(a); return; }
    r.hours--;
    // fire: a few buildings an hour; churches are mostly spared
    const list = st.buildingsAt.get(sid) ?? [];
    for (let n = 0; n < 1 + Math.floor(rng.next() * 3); n++) {
      const b = list[Math.floor(rng.next() * list.length)];
      if (!b || b.onFire || b.damage > 0.8 || b.construction < 1) continue;
      const cat = BUILDINGS[b.kind].cat;
      if (cat === 'defence' || cat === 'camp') continue;
      if (SPARED.has(b.kind) && rng.next() < 0.85) continue;
      b.onFire = true;
      b.damage = Math.min(1, Math.round((b.damage + 0.35 + rng.next() * 0.25) * 100) / 100);
      st.touchBuilding(b);
      r.burned++;
    }
    // the fields: ripe grain and fresh seed burn
    const s = M.settlementById.get(sid);
    if (s) {
      for (let n = 0; n < 3; n++) {
        const id = s.strips[Math.floor(rng.next() * s.strips.length)];
        const strip = id !== undefined ? st.strips.get(id) : undefined;
        if (!strip || strip.state === 'bare' || strip.state === 'fallow') continue;
        strip.state = 'bare'; strip.crop = 'fallow'; strip.growth = 0;
        st.touchStrip(strip);
        r.strips++;
      }
    }
    // the herds: oxen, cows, sheep and pigs are driven off, goods carried away
    const hhs = st.householdList(sid);
    for (let n = 0; n < 4 && hhs.length; n++) {
      const hh = hhs[Math.floor(rng.next() * hhs.length)];
      if (hh.kind === 'monastic' && rng.next() < 0.8) continue;
      for (const key of livestockKeys(M, hh.stores)) {
        const have = hh.stores[key] ?? 0;
        const take = Math.min(have, Math.max(1, Math.round(have * (0.4 + rng.next() * 0.4))));
        if (take <= 0) continue;
        hh.stores[key] = have - take;
        r.stolen += take;
        r.loot += take * priceOf(M, key) * 0.7;
        st.touchHousehold(hh);
      }
      // a purse of coin changes hands
      const coin = Math.floor(hh.purse * (0.15 + rng.next() * 0.25));
      if (coin > 0) { hh.purse -= coin; r.loot += coin; st.touchHousehold(hh); }
      // stored food feeds the raiders
      for (const key of Object.keys(hh.stores)) {
        if (key.startsWith('wheat') || key.startsWith('rye') || key.startsWith('barley') || key.startsWith('bread') || key.startsWith('cheese')) {
          const q = hh.stores[key] ?? 0;
          if (q > 1) { const t = q * 0.4; hh.stores[key] = q - t; a.supplies += t * 2; st.touchHousehold(hh); }
        }
      }
    }
    // people: some resist and are cut down, a few are carried off for ransom
    const folk = st.residentsOf(sid);
    if (folk.length > 0 && rng.next() < 0.6) {
      const p = folk[Math.floor(rng.next() * folk.length)];
      if (p.sex === 'm' && (M.day - p.birthDay) / 16 >= 15 && p.estate !== 'clergy' && !p.flags.captive) M.harmFolk(p, 0.65, 'raid');
    }
    if (r.captives < 6 && rng.next() < 0.3) {
      const p = this.pickCaptive(sid, rng.next());
      if (p) {
        const captor = this.captorOf(a);
        const price = Math.max(12, Math.round(ransomValue(M, p) * (p.rankTier >= 3 ? 1 : 0.8)));
        if (takeCaptive(M, p, captor, 'raid', a.home, price)) r.captives++;
      }
    }
    const ss = st.settlementState(sid);
    if (ss) { ss.prosperity = Math.max(0.3, ss.prosperity - 0.012); st.touchSettlement(ss); }
    M.touch();
  }

  private captorOf(a: Army): PersonId { return a.commander; }

  private pickCaptive(sid: number, u: number): Person | undefined {
    const M = this.M;
    const folk = M.state.residentsOf(sid);
    const n = folk.length;
    for (let k = 0; k < 12 && n > 0; k++) {
      const p = folk[Math.floor(((u + k * 0.6180339) % 1) * n)];
      const age = (M.day - p.birthDay) / 16;
      if (!p.death && !p.flags.captive && age >= 14 && age <= 45 && p.estate !== 'clergy' && p.id !== M.playerId) return p;
    }
    return undefined;
  }

  private finish(a: Army): void {
    const M = this.M;
    const r = a.raid;
    if (!r) return;
    const sid = r.sid;
    for (const b of M.state.buildingsAt.get(sid) ?? []) if (b.onFire) { b.onFire = false; M.state.touchBuilding(b); }
    a.funds += r.loot;
    a.raid = undefined;
    M.data.stats.raids++;
    M.sim.events.emit('raid', { settlement: sid, raider: a.house, burned: r.burned, stolen: r.stolen, captives: r.captives });
    const lord = M.realm.lordHouse(sid);
    M.log('raid', `Raiders of ${M.houseName(a.house)} burned ${r.burned} buildings and ${r.strips} strips at ${M.placeName(sid)}, drove off ${r.stolen} beasts and took ${r.captives} captives.`, [a.commander]);
    if (M.concernsPlayer(lord, a.house) || M.state.persons.get(M.playerId)?.settlement === sid) {
      M.notify(`${M.placeName(sid)} was raided: ${r.burned} buildings burned, ${r.stolen} beasts taken.`, M.concernsPlayer(lord) || M.state.persons.get(M.playerId)?.settlement === sid ? 'danger' : 'info');
    }
    M.career.afterRaid(a, r.loot);
    const intent = a.intent;
    void intent;
    // home with the plunder
    if (M.armyById.has(a.id)) {
      const res = giveOrder(M, a, { kind: 'return' });
      if (!res.ok) disband(M, a, 'home from the raid');
    }
    M.touch();
  }

  /** The sack of a stormed place (SPEC §13): fire, loot and captives, in proportion to `intensity`. */
  sack(a: Army, sid: number, intensity: number): void {
    const M = this.M;
    const rng = M.rng('military.raid');
    const st = M.state;
    let burned = 0, loot = 0, stolen = 0, captives = 0;
    for (const b of st.buildingsAt.get(sid) ?? []) {
      const cat = BUILDINGS[b.kind].cat;
      if (cat === 'defence' || cat === 'camp' || b.damage > 0.9) continue;
      if (SPARED.has(b.kind) && rng.next() < 0.8) continue;
      if (rng.next() > intensity * 0.35) continue;
      b.onFire = true;
      b.damage = Math.min(1, b.damage + 0.4 + rng.next() * 0.3);
      st.touchBuilding(b);
      burned++;
    }
    for (const hh of st.householdList(sid)) {
      const coin = Math.floor(hh.purse * intensity * 0.6);
      if (coin > 0) { hh.purse -= coin; loot += coin; st.touchHousehold(hh); }
      for (const key of livestockKeys(M, hh.stores)) {
        const have = hh.stores[key] ?? 0;
        const take = Math.round(have * intensity * 0.8);
        if (take > 0) { hh.stores[key] = have - take; stolen += take; loot += take * priceOf(M, key) * 0.7; st.touchHousehold(hh); }
      }
    }
    for (let i = 0; i < 8; i++) {
      const p = this.pickCaptive(sid, rng.next());
      if (!p) continue;
      if (takeCaptive(M, p, a.commander, 'sack', a.home, Math.max(12, ransomValue(M, p)))) captives++;
    }
    a.funds += loot;
    for (const b of st.buildingsAt.get(sid) ?? []) if (b.onFire) { b.onFire = false; st.touchBuilding(b); }
    M.sim.events.emit('raid', { settlement: sid, raider: a.house, burned, stolen, captives });
    void nearestSettlementId;
  }
}
