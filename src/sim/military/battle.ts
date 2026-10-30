// Battles (SPEC §13). Macro resolution when the player is absent: numbers, unit quality, commander
// Leadership, terrain, fortifications and morale decide; casualties fall on real people through `combat.harm`
// (deaths, wounds, captures with ransom). When the player is in the line a detail battle of a representative
// subset (≤ 60 a side) runs near him through `combat.engage`, while the rest resolves macro-style.
import { dist } from '../../core/math';
import { skillLevel } from '../people';
import { adjustOpinion, type HouseId, type Person, type PersonId } from '../state';
import type { FightResult, FightSide } from '../wave3';
import { addMan, countKinds, disband, giveOrder, kindAt, nearestSettlementId, removeMen } from './armies';
import { CFG, UNIT_EXPOSURE, isMounted, isRanged } from './config';
import { fightingPower } from './forces';
import { harm, takeCaptive } from './harm';
import type { Mil } from './store';
import type { Army, BattleOrder, BattleRec, UnitKind } from './types';

// ---------------------------------------------------------------------------------------------
// Fighters
// ---------------------------------------------------------------------------------------------

export interface Fighters {
  house: HouseId;
  armies: Army[];
  people: Person[];
  kinds: UnitKind[];
  power: number[];
  total: number;
  leader: Person | undefined;
  morale: number;
  stance: BattleOrder;
  /** Multiplier on the side's defence (walls, hill, wood). */
  bonus: number;
  rangedShare: number;
  mountedShare: number;
}

function leadershipOf(p: Person | undefined): number {
  return p ? skillLevel(p.skills.leadership) + p.trained.cha * 0.5 : 5;
}

export function fightersOf(M: Mil, armies: Army[], exclude?: ReadonlySet<PersonId>): Fighters {
  const people: Person[] = [], kinds: UnitKind[] = [], power: number[] = [];
  let total = 0, ranged = 0, mounted = 0;
  for (const a of armies) {
    for (let i = 0; i < a.men.length; i++) {
      if (exclude?.has(a.men[i])) continue;
      const p = M.alive(a.men[i]);
      if (!p) continue;
      const k = kindAt(a, i);
      const w = fightingPower(M, p, k);
      people.push(p); kinds.push(k); power.push(w);
      total += w;
      if (isRanged(k)) ranged += w;
      if (isMounted(k)) mounted += w;
    }
  }
  const lead = armies[0] ? M.alive(armies[0].commander) : undefined;
  const morale = armies.length ? armies.reduce((s, a) => s + a.morale, 0) / armies.length : 0.7;
  return {
    house: armies[0]?.house ?? 0, armies, people, kinds, power, total, leader: lead, morale,
    stance: armies[0]?.stance ?? 'advance', bonus: 1, rangedShare: total > 0 ? ranged / total : 0, mountedShare: total > 0 ? mounted / total : 0,
  };
}

/** A settlement's own defenders: garrison households, the lord's household men there, and the townsfolk's militia. */
export function defendersOf(M: Mil, sid: number, house: HouseId): Fighters {
  const st = M.state;
  const people: Person[] = [], kinds: UnitKind[] = [], power: number[] = [];
  let total = 0, ranged = 0;
  const seen = new Set<PersonId>();
  const add = (p: Person, k: UnitKind): void => {
    if (seen.has(p.id) || M.armyOfPerson.has(p.id) && M.army(M.armyOfPerson.get(p.id) ?? 0)?.task !== 'garrison') return;
    seen.add(p.id);
    const w = fightingPower(M, p, k);
    people.push(p); kinds.push(k); power.push(w);
    total += w;
    if (isRanged(k)) ranged += w;
  };
  for (const hh of st.householdsIn(sid)) {
    if (hh.kind !== 'garrison') continue;
    for (const id of hh.members) {
      const p = M.alive(id);
      if (p && p.sex === 'm' && p.health.hp > 0.4) add(p, p.career === 'sergeant' ? 'sergeant' : p.career === 'archer' ? 'archer' : 'man_at_arms');
    }
  }
  const lord = house ? M.state.houses.get(house) : undefined;
  if (lord) {
    for (const p of st.houseMemberList(house)) {
      if (p.settlement !== sid || p.sex !== 'm' || p.health.hp < 0.4) continue;
      const age = (M.day - p.birthDay) / 16;
      if (age < 17 || age > 58 || p.estate === 'clergy') continue;
      if (p.career === 'knight' || p.career === 'man_at_arms' || p.career === 'sergeant' || p.career === 'archer' || p.career === 'squire') {
        add(p, p.career === 'knight' ? 'knight' : p.career === 'sergeant' ? 'sergeant' : p.career === 'archer' ? 'archer' : 'man_at_arms');
      }
    }
  }
  const s = M.settlementById.get(sid);
  const town = s && (s.kind === 'town' || s.kind === 'city');
  // townsfolk and villagers: a tenth to a sixth of the able men take up what arms they have
  const share = town ? 0.14 : 0.08;
  let n = 0;
  for (const p of st.residentsOf(sid)) {
    if (p.sex !== 'm' || p.estate === 'clergy' || seen.has(p.id)) continue;
    const age = (M.day - p.birthDay) / 16;
    if (age < 15 || age > 60 || p.health.hp < 0.55) continue;
    if (((p.id * 2654435761) >>> 0) % 1000 >= share * 1000) continue;
    if (++n > 140) break;
    add(p, town && p.rankTier >= 2 ? 'crossbow' : 'levy');
  }
  const garrisonedArmies = M.allArmies().filter((a) => a.task === 'garrison' && dist(a.x, a.z, s?.x ?? 0, s?.z ?? 0) < CFG.arriveRadius * 2 && (a.house === house || M.realm.chain(a.house).includes(house)));
  const f = fightersOf(M, garrisonedArmies);
  for (let i = 0; i < f.people.length; i++) {
    if (seen.has(f.people[i].id)) continue;
    seen.add(f.people[i].id);
    people.push(f.people[i]); kinds.push(f.kinds[i]); power.push(f.power[i]);
    total += f.power[i];
    if (isRanged(f.kinds[i])) ranged += f.power[i];
  }
  const leader = lord ? M.alive(lord.head) : undefined;
  return {
    house, armies: garrisonedArmies, people, kinds, power, total, leader: leader && people.includes(leader) ? leader : people.find((p) => p.rankTier >= 4),
    morale: 0.7, stance: 'hold', bonus: 1, rangedShare: total > 0 ? ranged / total : 0, mountedShare: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// The macro model
// ---------------------------------------------------------------------------------------------

export interface Casualty { person: Person; kind: UnitKind; fate: 'dead' | 'wounded' | 'captured' | 'unhurt' }

export interface Resolution {
  /** The first side (attacker) won. */
  attWon: boolean;
  attLoss: number;
  defLoss: number;
  /** Strength left as a share of the start. */
  attLeft: number;
  defLeft: number;
  routed: 'att' | 'def' | 'none';
  attCasualties: Casualty[];
  defCasualties: Casualty[];
  /** Margin of victory 0..1 (how decisive). */
  margin: number;
}

function terrainBonus(M: Mil, x: number, z: number, defX: number, defZ: number): { def: number; horse: number } {
  const w = M.world;
  let def = 1, horse = 1;
  try {
    const hd = w.heightAt(defX, defZ) - w.heightAt(x, z);
    if (hd > 6) def += Math.min(0.18, hd * 0.01);
    if (w.forestAt(defX, defZ) > 0.5) { def += 0.08; horse = 0.8; }
    if (w.walkCostAt(defX, defZ) > 2.2) { def += 0.05; horse = Math.min(horse, 0.85); }
  } catch { /* a world without those queries (tests) */ }
  return { def, horse };
}

function stanceFactors(stance: BattleOrder): { att: number; def: number; loss: number } {
  switch (stance) {
    case 'charge': return { att: 1.15, def: 0.9, loss: 1.2 };
    case 'hold': return { att: 0.9, def: 1.12, loss: 0.9 };
    case 'loose': return { att: 1.0, def: 1.0, loss: 1.0 };
    case 'retreat': return { att: 0.5, def: 0.7, loss: 0.8 };
    default: return { att: 1, def: 1, loss: 1 };
  }
}

/** Runs the battle model on two sets of fighters. `rng` is the module's stream. */
export function resolve(M: Mil, att: Fighters, def: Fighters, terrain: { x: number; z: number }): Resolution {
  const rng = M.rng('military.battle');
  const t = terrainBonus(M, terrain.x, terrain.z, terrain.x, terrain.z);
  const sa = stanceFactors(att.stance), sd = stanceFactors(def.stance);
  const lead = (f: Fighters): number => Math.max(0.88, Math.min(1.3, 1 + 0.012 * (leadershipOf(f.leader) - 8)));
  const morale = (f: Fighters): number => 0.75 + 0.5 * f.morale;
  // the fortune of the day: ground, surprise, who was ready — lognormal luck on each side
  const luckA = Math.exp(rng.gauss(0, 0.22)), luckD = Math.exp(rng.gauss(0, 0.22));
  const pa = att.total * luckA * lead(att) * morale(att) * (1 - att.mountedShare * (1 - t.horse) * 0.5);
  const pd = def.total * luckD * lead(def) * morale(def) * def.bonus * t.def * (1 - def.mountedShare * (1 - t.horse) * 0.5);
  const result: Resolution = { attWon: false, attLoss: 0, defLoss: 0, attLeft: 1, defLeft: 1, routed: 'none', attCasualties: [], defCasualties: [], margin: 0 };
  if (att.total <= 0 && def.total <= 0) return result;
  if (att.total <= 0) { result.attLeft = 0; result.attLoss = 1; result.routed = 'att'; return result; }
  if (def.total <= 0) { result.attWon = true; result.defLeft = 0; result.defLoss = 1; result.routed = 'def'; result.margin = 1; return result; }

  let fa = 1, fd = 1;
  const breakA = Math.max(0.26, Math.min(0.58, 0.58 - 0.3 * att.morale + (att.stance === 'retreat' ? 0.5 : 0)));
  const breakD = Math.max(0.26, Math.min(0.58, 0.58 - 0.3 * def.morale + (def.stance === 'retreat' ? 0.5 : 0)));
  let routed: Resolution['routed'] = 'none';
  const rate = CFG.battleRate;
  for (let r = 1; r <= CFG.battleRounds; r++) {
    const early = r <= 3;
    const ra = early ? 1 + att.rangedShare * (att.stance === 'loose' ? 0.8 : 0.45) : 1;
    const rd = early ? 1 + def.rangedShare * (def.stance === 'loose' ? 0.8 : 0.45) * 1.1 : 1;
    const na = 0.85 + rng.next() * 0.3, nd = 0.85 + rng.next() * 0.3;
    const dd = rate * (pa * fa * ra * sa.att) / (pd * sd.def) * na;
    const da = rate * (pd * fd * rd * sd.att) / (pa * sa.def) * nd;
    fd = Math.max(0, fd - dd * sd.loss);
    fa = Math.max(0, fa - da * sa.loss);
    if (fa < breakA && fd < breakD) { routed = fa / breakA < fd / breakD ? 'att' : 'def'; break; }
    if (fa < breakA) { routed = 'att'; break; }
    if (fd < breakD) { routed = 'def'; break; }
  }
  if (routed === 'none') routed = fa * pa >= fd * pd ? 'def' : 'att';
  const decided = routed === 'def' ? fd < breakD : fa < breakA;
  result.attWon = routed === 'def';
  result.attLeft = fa; result.defLeft = fd;
  result.routed = routed;
  result.margin = Math.min(1, Math.abs(fa * pa - fd * pd) / Math.max(1, fa * pa + fd * pd));
  // pursuit cuts down the beaten side
  const winnerMounted = routed === 'def' ? att.mountedShare : def.mountedShare;
  const pursuit = decided ? (0.08 + 0.3 * winnerMounted) * (routed === 'def' ? fd : fa) : 0.02;
  const lossA = Math.min(0.92, (1 - fa) * 0.78 + (routed === 'att' ? pursuit : 0));
  const lossD = Math.min(0.92, (1 - fd) * 0.78 + (routed === 'def' ? pursuit : 0));
  result.attLoss = lossA; result.defLoss = lossD;
  return result;
}

/** Picks who is hit: exposure-weighted without replacement. */
function pickCasualties(M: Mil, f: Fighters, frac: number, exclude?: ReadonlySet<PersonId>): number[] {
  const n = f.people.length;
  const rng = M.rng('military.battle');
  const k = Math.min(n, Math.floor(n * frac + rng.next()));
  if (k <= 0) return [];
  const keyed: Array<{ i: number; key: number }> = [];
  for (let i = 0; i < n; i++) {
    if (exclude?.has(f.people[i].id)) continue;
    let w = UNIT_EXPOSURE[f.kinds[i]];
    if (f.people[i] === f.leader) w *= 0.6;
    keyed.push({ i, key: -Math.log(Math.max(1e-9, rng.next())) / w });
  }
  keyed.sort((a, b) => a.key - b.key);
  return keyed.slice(0, k).map((x) => x.i);
}

/** Applies the casualties of one side to real people; returns what happened to each. */
function applyCasualties(
  M: Mil, f: Fighters, frac: number, winner: Fighters, loser: boolean, place: number, exclude?: ReadonlySet<PersonId>,
): Casualty[] {
  const out: Casualty[] = [];
  const rng = M.rng('military.battle');
  const idx = pickCasualties(M, f, frac, exclude);
  const captors = winner.people.filter((_, i) => winner.kinds[i] !== 'levy').slice(0, 40);
  for (const i of idx) {
    const p = f.people[i];
    const kind = f.kinds[i];
    const nobleish = p.rankTier >= 4 || kind === 'knight' || (kind === 'sergeant' && p.rankTier >= 3);
    // yielded nobles are worth keeping: the captor holds the ransom right (SPEC §13)
    if (loser && nobleish && rng.next() < 0.6 && captors.length) {
      const captor = captors[Math.floor(rng.next() * captors.length)];
      const rec = takeCaptive(M, p, captor.id, 'battle', place);
      if (rec) { out.push({ person: p, kind, fate: 'captured' }); continue; }
    }
    const intensity = Math.min(1, (loser ? 0.4 : 0.3) + rng.next() * 0.5);
    const r = harm(M, p, intensity, 'battle');
    if (r === 'dead') out.push({ person: p, kind, fate: 'dead' });
    else if (r === 'yielded' || r === 'captured') {
      const captor = captors.length ? captors[Math.floor(rng.next() * captors.length)] : undefined;
      if (captor && takeCaptive(M, p, captor.id, 'battle', place)) out.push({ person: p, kind, fate: 'captured' });
      else out.push({ person: p, kind, fate: 'wounded' });
    } else if (r === 'unhurt') out.push({ person: p, kind, fate: 'unhurt' });
    else out.push({ person: p, kind, fate: 'wounded' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Armies meeting
// ---------------------------------------------------------------------------------------------

/** Which army attacks: the one that came to fight; the one at home (or standing) defends. */
function sidesOf(M: Mil, a: Army, b: Army): [Army, Army] {
  const aGoing = a.target !== undefined && (a.intent === 'attack' || a.intent === 'raid' || a.intent === 'siege');
  const bGoing = b.target !== undefined && (b.intent === 'attack' || b.intent === 'raid' || b.intent === 'siege');
  if (aGoing !== bGoing) return aGoing ? [a, b] : [b, a];
  const near = nearestSettlementId(M, (a.x + b.x) / 2, (a.z + b.z) / 2);
  const lord = M.realm.lordHouse(near);
  const aHome = !!lord && M.realm.chain(a.house).includes(lord);
  const bHome = !!lord && M.realm.chain(b.house).includes(lord);
  if (aHome !== bHome) return aHome ? [b, a] : [a, b];
  return a.id < b.id ? [a, b] : [b, a];
}

/** Hourly: hostile armies in contact fight. Returns the battle started, if any. */
export function checkContacts(M: Mil): void {
  const armies = M.allArmies();
  if (armies.length < 2) return;
  for (let i = 0; i < armies.length; i++) {
    const a = armies[i];
    if (a.engaged || a.task === 'muster') continue;
    for (let j = i + 1; j < armies.length; j++) {
      const b = armies[j];
      if (b.engaged || b.task === 'muster' || a.house === b.house) continue;
      if (Math.abs(a.x - b.x) > CFG.battleRadius || Math.abs(a.z - b.z) > CFG.battleRadius) continue;
      if (dist(a.x, a.z, b.x, b.z) > CFG.battleRadius) continue;
      if (!M.realm.hostile(a.house, b.house)) continue;
      startBattle(M, a, b);
      return; // one battle per hour keeps the frame cost flat
    }
  }
}

function playerIn(M: Mil, a: Army): boolean { return a.men.includes(M.playerId) && !!M.alive(M.playerId); }

export function startBattle(M: Mil, x: Army, y: Army, extra?: { settlement?: number; fort?: number; siege?: number; fixed?: boolean }): BattleRec {
  const [a, d] = extra?.fixed ? [x, y] : sidesOf(M, x, y);
  const rec: BattleRec = {
    id: M.data.nextBattle++, x: (a.x + d.x) / 2, z: (a.z + d.z) / 2, a: a.id, d: d.id, settlement: extra?.settlement ?? nearestSettlementId(M, (a.x + d.x) / 2, (a.z + d.z) / 2),
    war: M.realm.warBetween(a.house, d.house).war, startedDay: M.day, fight: 0, detailA: [], detailD: [], playerArmy: 0, clock: 0, result: '',
    fort: extra?.fort ?? 1, siege: extra?.siege ?? -1,
  };
  a.engaged = rec.id; d.engaged = rec.id;
  const prevA = a.task, prevD = d.task;
  a.task = 'battle'; d.task = 'battle';
  void prevA; void prevD;
  const playerArmy = playerIn(M, a) ? a : playerIn(M, d) ? d : undefined;
  if (playerArmy && M.combat && M.zone && M.playerApi) {
    rec.playerArmy = playerArmy.id;
    M.data.battles.push(rec);
    M.touch();
    beginDetail(M, rec, a, d, playerArmy);
    return rec;
  }
  if (playerArmy) rec.playerArmy = playerArmy.id;
  M.data.battles.push(rec);
  finishMacro(M, rec, a, d);
  return rec;
}

// ---------------------------------------------------------------------------------------------
// Resolution and aftermath
// ---------------------------------------------------------------------------------------------

function fieldFighters(M: Mil, rec: BattleRec, a: Army, d: Army, exclude?: ReadonlySet<PersonId>): [Fighters, Fighters] {
  const fa = fightersOf(M, [a], exclude), fd = fightersOf(M, [d], exclude);
  fa.stance = a.stance; fd.stance = d.stance;
  fd.bonus = rec.fort;
  return [fa, fd];
}

/** Whole battle by the macro model (no player in the line, or no combat module to run the detail). */
function finishMacro(M: Mil, rec: BattleRec, a: Army, d: Army): void {
  const [fa, fd] = fieldFighters(M, rec, a, d);
  const res = resolve(M, fa, fd, { x: rec.x, z: rec.z });
  conclude(M, rec, a, d, fa, fd, res, undefined);
}

/** Applies a resolution: casualties, captives, morale, retreats, spoils, politics, events, player's deeds. */
function conclude(
  M: Mil, rec: BattleRec, a: Army, d: Army, fa: Fighters, fd: Fighters, res: Resolution, detail: { excluded: ReadonlySet<PersonId>; result: FightResult | undefined; wonBy: '' | 'a' | 'd' | 'draw' } | undefined,
): void {
  const excluded = detail?.excluded;
  const winner = res.attWon ? fa : fd;
  const attCas = applyCasualties(M, fa, res.attLoss, fd, !res.attWon, rec.settlement, excluded);
  const defCas = applyCasualties(M, fd, res.defLoss, fa, res.attWon, rec.settlement, excluded);
  void winner;
  res.attCasualties = attCas; res.defCasualties = defCas;

  // remove the fallen, the wounded (they go home) and the captured from the rosters
  const hit = (cs: Casualty[]): Set<PersonId> => new Set(cs.filter((c) => c.fate !== 'unhurt').map((c) => c.person.id));
  const gone = hit(attCas), goneD = hit(defCas);
  if (detail?.result) {
    for (const id of [...detail.result.dead, ...detail.result.wounded, ...detail.result.fled]) { gone.add(id); goneD.add(id); }
    for (const c of detail.result.captured) { gone.add(c.captive); goneD.add(c.captive); }
  }
  removeMen(M, a, gone);
  removeMen(M, d, goneD);
  const deadA = attCas.filter((c) => c.fate === 'dead').length + (detail?.result?.dead.filter((id) => a.men.includes(id) || fa.people.some((p) => p.id === id)).length ?? 0);
  const deadD = defCas.filter((c) => c.fate === 'dead').length + (detail?.result?.dead.filter((id) => fd.people.some((p) => p.id === id)).length ?? 0);
  const dead = deadA + deadD;
  M.data.stats.battles++;
  M.data.stats.dead += 0; // deaths are counted where they happen (harm)

  const attWon = res.attWon;
  const won = attWon ? a : d, lost = attWon ? d : a;
  const wonCas = attWon ? attCas : defCas, lostCas = attWon ? defCas : attCas;
  void wonCas;
  // spoils: the victor takes the beaten army's chest and baggage, and strips the field
  won.funds += lost.funds * 0.8 + lostCas.length * 3;
  lost.funds *= 0.2;
  won.supplies += lost.supplies * 0.5;
  lost.supplies *= 0.5;
  won.morale = Math.min(1, won.morale + 0.12);
  lost.morale = Math.max(0.1, lost.morale - 0.35);
  won.engaged = 0; lost.engaged = 0;
  won.task = won.target ? 'march' : 'garrison';
  lost.task = lost.target ? 'march' : 'garrison';
  M.data.battles.splice(M.data.battles.indexOf(rec), 1);
  M.touch();

  // the beaten army falls back towards home, or breaks up
  if (lost.men.length < CFG.armyMin || lost.morale < 0.16) disband(M, lost, 'scattered in defeat');
  else if (res.routed !== 'none') giveOrder(M, lost, { kind: 'return' });
  if (!M.armyById.has(won.id)) { /* the winner was destroyed too */ } else if (won.men.length < CFG.armyMin) disband(M, won, 'too few to carry on');
  else if (won.intent === 'attack' || won.intent === 'siege' || won.intent === 'raid') {
    // carry on to the objective
    if (won.target) { won.from = { x: won.x, z: won.z }; won.progress = 0; won.task = 'march'; }
  } else if (won.intent === 'defend') won.task = 'garrison';

  // politics: the war moves on
  const pol = M.politics;
  if (pol && rec.war) {
    const { aAttacks } = M.realm.warBetween(a.house, d.house);
    const attackerSideWon = attWon === aAttacks;
    const weight = Math.max(0.5, Math.min(5, (fa.people.length + fd.people.length) / 90 + dead / 40 + res.margin));
    pol.reportBattle(rec.war, attackerSideWon, weight);
  }

  const near = M.placeName(rec.settlement);
  const playerPresent = rec.playerArmy !== 0;
  M.sim.events.emit('battle', { war: rec.war, x: rec.x, z: rec.z, settlement: rec.settlement, attacker: a.house, defender: d.house, attackerWon: attWon, dead, playerPresent });
  const n = fa.people.length + fd.people.length;
  if (n >= 30 || M.concernsPlayer(a.house, d.house) || playerPresent) {
    M.log('battle', `${M.houseName(won.house)} defeated ${M.houseName(lost.house)} near ${near}: ${dead} dead among ${n} men${lostCas.some((c) => c.fate === 'captured') ? `, ${lostCas.filter((c) => c.fate === 'captured').length} taken for ransom` : ''}.`, [won.commander, lost.commander]);
    if (M.concernsPlayer(a.house, d.house)) M.notify(`Battle near ${near}: ${M.houseName(won.house)} wins (${dead} dead).`, won.house === M.state.run.houseId ? 'gain' : 'danger');
  }
  M.career.afterBattle(a, d, fa, fd, res, attWon, detail?.wonBy);
  if (rec.siege >= 0) M.sieges.afterAssault(rec, a, d, attWon);
}

// ---------------------------------------------------------------------------------------------
// Detail battle (the player is in the line)
// ---------------------------------------------------------------------------------------------

function subsetOf(M: Mil, army: Army, f: Fighters, nearIndex: number, cap: number, mustHave: PersonId[]): Person[] {
  const out: Person[] = [];
  const seen = new Set<PersonId>();
  for (const id of mustHave) { const p = M.alive(id); if (p && !seen.has(id)) { seen.add(id); out.push(p); } }
  // his own company first (the men near him in the roster), then a spread of the rest
  const idxs = f.people.map((p, i) => ({ p, i }));
  const mine = army.men.indexOf(nearIndex);
  const centre = mine >= 0 ? mine : Math.floor(idxs.length / 2);
  const ordered = idxs.slice().sort((x, y) => Math.abs(army.men.indexOf(x.p.id) - centre) - Math.abs(army.men.indexOf(y.p.id) - centre));
  for (const { p } of ordered) {
    if (out.length >= cap) break;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

function beginDetail(M: Mil, rec: BattleRec, a: Army, d: Army, mine: Army): void {
  const combat = M.combat;
  const pid = M.playerId;
  if (!combat) { finishMacro(M, rec, a, d); return; }
  const [fa, fd] = fieldFighters(M, rec, a, d);
  const cap = CFG.detailMax;
  const detailMine = subsetOf(M, mine, mine === a ? fa : fd, pid, cap, [pid]);
  const otherF = mine === a ? fd : fa;
  const other = mine === a ? d : a;
  // a spread of the enemy line facing him: professionals first
  const order = otherF.people.map((p, i) => ({ p, k: otherF.kinds[i] })).sort((x, y) => (x.k === 'levy' ? 1 : 0) - (y.k === 'levy' ? 1 : 0) || x.p.id - y.p.id);
  const detailOther = order.slice(0, Math.min(cap, Math.max(8, Math.round(detailMine.length * 1.0)))).map((x) => x.p);
  void other;
  const detA = mine === a ? detailMine : detailOther;
  const detD = mine === a ? detailOther : detailMine;
  rec.detailA = detA.map((p) => p.id);
  rec.detailD = detD.map((p) => p.id);
  rec.clock = CFG.detailSeconds;

  // the line forms around the player
  const body = M.playerApi?.body();
  const at = body ? { x: body.x, z: body.z } : { x: rec.x, z: rec.z };
  const sides: FightSide[] = [
    { faction: `house:${a.house}`, people: rec.detailA.slice() },
    { faction: `house:${d.house}`, people: rec.detailD.slice() },
  ];
  rec.fight = combat.engage(sides, { at, yieldAllowed: true, reason: 'battle' });
  M.notify(`Battle is joined at ${M.placeName(rec.settlement)}! ${M.houseName(a.house)} against ${M.houseName(d.house)}.`, 'danger', pid);
  M.sim.events.emit('ui', { panel: 'ext', name: 'army' });
  M.touch();
}

/** The combat module reports a finished fight: remember who won so the battle can conclude. */
export function onFightEnded(M: Mil, r: FightResult): void {
  const rec = M.data.battles.find((b) => b.fight === r.id && b.fight !== 0);
  if (!rec) return;
  const winner = r.winner;
  const a = M.army(rec.a), d = M.army(rec.d);
  rec.result = winner === `house:${a?.house}` ? 'a' : winner === `house:${d?.house}` ? 'd' : 'draw';
  M.detailResults.set(rec.id, r);
  M.touch();
}

/** Every sub-step while a detail battle runs: counts down the clock; concludes finished or overlong ones. */
export function stepBattles(M: Mil, dt: number): void {
  if (M.data.battles.length === 0) return;
  for (const rec of M.data.battles.slice()) {
    if (!rec.fight && rec.detailA.length === 0) { // a battle restored from a save without its fight
      const a = M.army(rec.a), d = M.army(rec.d);
      if (a && d) finishMacro(M, rec, a, d); else dropBattle(M, rec);
      continue;
    }
    rec.clock -= dt;
    const over = rec.result !== '' || rec.clock <= 0 || (M.combat && rec.fight && !M.combat.isFighting(M.playerId) && rec.clock < CFG.detailSeconds - 15 && M.data.battles.length > 0 && detailEnded(M, rec));
    if (over) concludeDetail(M, rec);
  }
}

function detailEnded(M: Mil, rec: BattleRec): boolean {
  const c = M.combat;
  if (!c) return true;
  // the fight is over when none of the people we sent in is still fighting
  for (const id of rec.detailA) if (c.isFighting(id)) return false;
  for (const id of rec.detailD) if (c.isFighting(id)) return false;
  return true;
}

function dropBattle(M: Mil, rec: BattleRec): void {
  const i = M.data.battles.indexOf(rec);
  if (i >= 0) M.data.battles.splice(i, 1);
  for (const id of [rec.a, rec.d]) { const x = M.army(id); if (x) { x.engaged = 0; if (x.task === 'battle') x.task = x.target ? 'march' : 'garrison'; } }
  M.touch();
}

function concludeDetail(M: Mil, rec: BattleRec): void {
  const a = M.army(rec.a), d = M.army(rec.d);
  const fr = M.detailResults.get(rec.id);
  M.detailResults.delete(rec.id);
  if (!a || !d) { dropBattle(M, rec); return; }
  const exclude = new Set<PersonId>([...rec.detailA, ...rec.detailD]);
  const [fa, fd] = fieldFighters(M, rec, a, d, exclude);
  const res = resolve(M, fa, fd, { x: rec.x, z: rec.z });
  // the fight in the line swings an even day; a clear macro result stands
  const detailWon = rec.result === 'a' || rec.result === 'd' ? rec.result : '';
  if (detailWon && res.margin < 0.25) res.attWon = detailWon === 'a';
  else if (detailWon && ((detailWon === 'a') !== res.attWon) && res.margin < 0.5 && M.rng('military.battle').next() < 0.5) res.attWon = detailWon === 'a';
  if (!fa.people.length && !fd.people.length) res.attWon = detailWon ? detailWon === 'a' : res.attWon;
  conclude(M, rec, a, d, fa, fd, res, { excluded: exclude, result: fr, wonBy: rec.result });
}

// ---------------------------------------------------------------------------------------------
// Player orders in battle (by rank)
// ---------------------------------------------------------------------------------------------

/** The player's orders to the men he commands: macro stance for an army, `zone.command` for the squad in the detail. */
export function applyOrder(M: Mil, order: BattleOrder, army: Army, level: 'squad' | 'company' | 'army'): void {
  if (level === 'army') army.stance = order;
  const rec = M.data.battles.find((b) => b.a === army.id || b.d === army.id);
  const zone = M.zone;
  if (!zone) return;
  const mineIsA = rec ? rec.a === army.id : true;
  const mine = rec ? (mineIsA ? rec.detailA : rec.detailD) : [];
  const theirs = rec ? (mineIsA ? rec.detailD : rec.detailA) : [];
  const me = M.playerApi?.body();
  const enemyAt = ((): { x: number; z: number } => {
    let sx = 0, sz = 0, n = 0;
    for (const id of theirs) { const ag = zone.agent(id); if (ag) { sx += ag.x; sz += ag.z; n++; } }
    return n ? { x: sx / n, z: sz / n } : me ? { x: me.x + Math.sin(me.yaw) * 20, z: me.z + Math.cos(me.yaw) * 20 } : { x: army.x, z: army.z };
  })();
  const span = level === 'squad' ? 8 : level === 'company' ? 30 : 60;
  let n = 0;
  for (const id of mine) {
    if (id === M.playerId) continue;
    if (n++ >= span) break;
    const ag = zone.agent(id);
    if (!ag) continue;
    switch (order) {
      case 'hold': zone.command(id, { kind: 'goto', x: ag.x, z: ag.z }); break;
      case 'advance': zone.command(id, { kind: 'goto', x: (ag.x + enemyAt.x) / 2, z: (ag.z + enemyAt.z) / 2 }); break;
      case 'charge': zone.command(id, { kind: 'goto', x: enemyAt.x, z: enemyAt.z, run: true }); break;
      case 'retreat': zone.command(id, { kind: 'flee', from: enemyAt }); break;
      case 'follow': zone.command(id, { kind: 'follow', leader: M.playerId, distance: 3 }); break;
      case 'loose': zone.command(id, { kind: 'resume' }); break;
    }
  }
}

export function battleInfo(M: Mil): Array<{ id: number; x: number; z: number; a: number; d: number; settlement: number; playerPresent: boolean }> {
  return M.data.battles.map((b) => ({ id: b.id, x: b.x, z: b.z, a: b.a, d: b.d, settlement: b.settlement, playerPresent: b.playerArmy !== 0 }));
}

export { addMan, countKinds, adjustOpinion };
