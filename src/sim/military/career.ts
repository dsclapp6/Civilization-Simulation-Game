// The player's military life (SPEC §6 "Arms", §7 command by rank): levy call-ups, enlisting, pay and drill,
// campaigns where the player marches with the army, plunder and ransom shares, promotion sergeant →
// captain → knighted for valour. Battle deeds become points through `score.award('deed', …)`.
import { Rng } from '../../core/rng';
import { setRank } from '../succession';
import { gainSkill, trainStat } from '../skills';
import { adjustOpinion, type Person, type PersonId } from '../state';
import { addMan, disband, kindAt, removeMan } from './armies';
import { applyOrder, type Fighters, type Resolution } from './battle';
import { CFG } from './config';
import { recruitTests, unitKindOf } from './forces';
import type { Mil } from './store';
import { emptyPlayerMil } from './store';
import type { SiegeRec } from './types';
import type { Army, BattleOrder, CommandLevel, PlayerService, Result } from './types';

/** Valour needed for each step up. */
const STEPS = { soldier: 5, sergeant: 12, captain: 22, knight: CFG.valour.knightAt };

export class CareerSystem {
  /** Where the army's displayed position was when the player's body last followed it. */
  private carryX = 0;
  private carryZ = 0;
  private carryArmy = 0;

  constructor(private readonly M: Mil) {}

  private get me(): Person | undefined { return this.M.alive(this.M.playerId); }

  // ---- who the player is in arms ----

  role(): PlayerService['role'] {
    const M = this.M;
    const p = this.me;
    if (!p) return 'none';
    const a = M.playerArmy();
    if (a && a.commander === p.id) return 'commander';
    if (p.career === 'knight' && p.rankTier >= 5) return a ? 'knight' : 'none';
    if (p.career === 'sergeant' && p.careerStage >= 3) return a ? 'captain' : 'soldier';
    if (p.career === 'sergeant') return a ? 'sergeant' : 'soldier';
    if (p.career === 'archer' || p.career === 'man_at_arms' || p.career === 'soldier') return a ? 'soldier' : 'soldier';
    return a ? 'levy' : 'none';
  }

  commandLevel(person?: PersonId): CommandLevel {
    const M = this.M;
    const id = person ?? M.playerId;
    const p = M.alive(id);
    const a = M.army(M.armyOfPerson.get(id) ?? 0);
    if (!p || !a) return 'self';
    if (a.commander === id) return 'army';
    if (p.career === 'knight' || (p.career === 'sergeant' && p.careerStage >= 3)) return 'company';
    if (p.career === 'sergeant') return 'squad';
    return 'self';
  }

  service(): PlayerService {
    const M = this.M;
    const pm = M.data.player;
    const role = this.role();
    const a = M.playerArmy();
    const level = this.commandLevel();
    const labels: Record<PlayerService['role'], string> = {
      none: 'Civilian', levy: 'Levy spearman', soldier: 'Soldier', sergeant: 'Sergeant', captain: 'Captain', knight: 'Knight', commander: 'Commander of the army',
    };
    const next: Record<string, [string, number]> = {
      none: ['', 0], levy: ['Soldier of the retinue', STEPS.soldier], soldier: ['Sergeant', STEPS.sergeant], sergeant: ['Captain', STEPS.captain],
      captain: ['Knight, for valour', STEPS.knight], knight: ['', 0], commander: ['', 0],
    };
    const [nextRank, nextAt] = next[role];
    const size = a ? a.men.length : 0;
    return {
      role, label: labels[role], level, army: a?.id ?? 0, house: a?.house ?? 0, valour: pm.valour, nextRank, nextAt, battles: pm.battles, earned: Math.round(pm.earned),
      served: pm.served, call: pm.call, commands: level === 'army' ? size : level === 'company' ? Math.min(40, size) : level === 'squad' ? Math.min(8, size) : 0,
    };
  }

  // ---- call-ups, joining and leaving ----

  answerCall(accept: boolean): Result {
    const M = this.M;
    const pm = M.data.player;
    const call = pm.call;
    const p = this.me;
    if (!call || !p) return { ok: false, reason: 'No one has called you' };
    const a = M.army(call.army);
    pm.call = null;
    M.touch();
    if (accept && a) return this.joinArmy(a.id);
    // refusing the lord's summons: a fine and a lord's ill will (SPEC §13: all men may be called)
    const lord = M.state.persons.get(M.state.houses.get(call.house)?.head ?? 0);
    const fine = Math.min(p.money, 24);
    p.money = Math.round((p.money - fine) * 100) / 100;
    M.state.touch(p);
    if (lord) M.social.adjustOpinion(lord.id, p.id, -12, 'ignored the levy');
    p.rep.honour = Math.max(-100, p.rep.honour - 4);
    M.notify(`You ignore the call to arms. You are fined ${fine} pence and the lord will remember.`, 'warn', p.id);
    return { ok: true };
  }

  joinArmy(armyId: number, person?: PersonId): Result {
    const M = this.M;
    const a = M.army(armyId);
    const p = M.alive(person ?? M.playerId);
    if (!a || !p) return { ok: false, reason: 'There is no such army' };
    if (a.engaged) return { ok: false, reason: 'The army is in battle' };
    if (M.armyOfPerson.has(p.id)) return { ok: false, reason: 'Already serving in an army' };
    if (p.sex !== 'm') return { ok: false, reason: 'In this land only men were mustered' };
    if (p.flags.captive) return { ok: false, reason: 'You are a prisoner' };
    const age = (M.day - p.birthDay) / 16;
    if (age < CFG.levyMinAge || age > CFG.levyMaxAge + 5) return { ok: false, reason: 'Men of fifteen to sixty serve' };
    if (M.realm.hostile(p.house, a.house)) return { ok: false, reason: 'That army is your House\'s enemy' };
    const sk = M.settlementById.get(p.settlement)?.kind;
    const kind = unitKindOf(M, p, { levy: true, town: sk === 'town' || sk === 'city', crossbows: true });
    addMan(M, a, p, kind);
    const pm = M.data.player;
    pm.last = a.id;
    pm.rank = this.role();
    pm.call = null;
    pm.drilled = M.day;
    M.touch();
    if (p.id === M.playerId) {
      this.carryArmy = a.id; this.carryX = a.x; this.carryZ = a.z;
      M.playerApi?.placeAt(a.x, a.z);
      M.notify(`You take your place in the army of ${M.houseName(a.house)} (${a.men.length} men).`, 'info', p.id);
      M.log('career', `${p.first} marched with the army of ${M.houseName(a.house)}.`, [p.id]);
    }
    return { ok: true };
  }

  /** The player-lord who raised his own host rides at its head. */
  joinSelf(a: Army): void {
    const M = this.M;
    const pm = M.data.player;
    pm.last = a.id;
    pm.rank = 'commander';
    pm.drilled = M.day;
    this.carryArmy = a.id; this.carryX = a.x; this.carryZ = a.z;
    M.playerApi?.placeAt(a.x, a.z);
    M.notify(`You raise the banners of ${M.houseName(a.house)}: ${a.men.length} men muster at ${M.placeName(a.home)}.`, 'info', M.playerId);
    M.log('muster', `${M.name(M.playerId)} raised the host of ${M.houseName(a.house)} (${a.men.length} men).`, [M.playerId]);
    M.touch();
  }

  leaveService(): Result {
    const M = this.M;
    const a = M.playerArmy();
    const p = this.me;
    if (!a || !p) return { ok: false, reason: 'You serve in no army' };
    if (a.engaged) return { ok: false, reason: 'Not in the middle of a battle' };
    if (a.commander === p.id) { disband(M, a, 'disbanded by its commander'); return { ok: true }; }
    removeMan(M, a, p.id);
    const duty = (M.day - a.since) <= CFG.levyFreeDays;
    if (duty && a.reason !== 'garrison') {
      p.rep.honour = Math.max(-100, p.rep.honour - 3);
      const lord = M.state.persons.get(M.state.houses.get(a.house)?.head ?? 0);
      if (lord) adjustOpinion(lord, p.id, -8);
      M.notify('You leave the army without leave. The lord will not forget it.', 'warn', p.id);
    } else M.notify('You are discharged from the army.', 'info', p.id);
    M.data.player.rank = this.role();
    this.carryArmy = 0;
    M.touch();
    return { ok: true };
  }

  onLeave(_a: Army): void {
    this.carryArmy = 0;
    this.M.data.player.rank = this.role();
  }

  // ---- orders ----

  command(order: BattleOrder): Result {
    const M = this.M;
    const a = M.playerArmy();
    const level = this.commandLevel();
    if (!a) return { ok: false, reason: 'You serve in no army' };
    if (level === 'self') return { ok: false, reason: 'You follow orders; only a sergeant or above commands men' };
    applyOrder(M, order, a, level);
    const names: Record<BattleOrder, string> = { hold: 'Hold the line!', advance: 'Advance!', charge: 'Charge!', loose: 'Loose!', retreat: 'Fall back!', follow: 'Follow me!' };
    const who = level === 'army' ? 'the army' : level === 'company' ? 'your company' : 'your squad';
    M.notify(`${names[order]} (${who})`, 'info');
    M.touch();
    return { ok: true };
  }

  // ---- daily: pay, drill, promotion, call-ups ----

  daily(): void {
    const M = this.M;
    const pm = M.data.player;
    const p = this.me;
    if (!p) return;
    const now = M.day;
    if (pm.call && now > pm.call.due) this.answerCall(false);
    const a = M.playerArmy();
    pm.rank = this.role();
    if (a && !a.engaged && (a.task === 'garrison' || a.task === 'muster' || a.task === 'siege') && pm.drilled < Math.floor(now)) {
      // drill in camp: melee for everyone, archery for archers, a little strength and endurance
      pm.drilled = Math.floor(now);
      const k = kindAt(a, a.men.indexOf(p.id));
      if (k === 'archer' || k === 'crossbow') gainSkill(M.sim, p, 'archery', 14);
      else gainSkill(M.sim, p, 'melee', 14);
      if (a.commander === p.id || k === 'sergeant' || k === 'knight') gainSkill(M.sim, p, 'leadership', 6);
      trainStat(M.sim, p, 'str', 0.02);
      trainStat(M.sim, p, 'end', 0.02);
    }
    this.checkPromotion(p);
  }

  private checkPromotion(p: Person): void {
    const M = this.M;
    const pm = M.data.player;
    const a = M.playerArmy();
    if (!a || a.engaged) return;
    const role = this.role();
    if (role === 'levy' && pm.valour >= STEPS.soldier) {
      const tests = recruitTests(M, p, true);
      const archer = tests.find((t) => t.role === 'archer' && t.met);
      const maa = tests.find((t) => t.role === 'man_at_arms' && t.met);
      if (!archer && !maa) return;
      const lord = M.state.houses.get(a.house);
      p.career = maa ? 'man_at_arms' : 'archer';
      p.careerStage = 1;
      if (lord) { M.state.setHouse(p, lord.id); if (!lord.sworn.includes(p.id)) { lord.sworn.push(p.id); M.state.touchHouse(lord); } }
      if (p.rankTier < 2) setRank(M.sim, p, 2);
      M.state.touch(p);
      a.units = a.units.slice(0, a.men.indexOf(p.id)) + (maa ? 'm' : 'a') + a.units.slice(a.men.indexOf(p.id) + 1);
      M.sim.events.emit('careerChanged', { person: p.id, from: 'none', to: p.career, stage: 1 });
      M.notify(`Your courage is noticed: you are taken into the retinue as ${maa ? 'a man-at-arms' : 'an archer'}.`, 'gain', p.id);
      M.log('career', `${p.first} was taken into the retinue of ${M.houseName(a.house)} for his courage.`, [p.id]);
      M.sim.score.award('deed', 15, 'Won a place in the retinue');
    } else if (role === 'soldier' && pm.valour >= STEPS.sergeant && (p.career === 'archer' || p.career === 'man_at_arms')) {
      p.career = 'sergeant'; p.careerStage = 2;
      if (p.rankTier < 3) setRank(M.sim, p, 3);
      M.state.touch(p);
      this.setKind(a, p, 's');
      M.sim.events.emit('careerChanged', { person: p.id, from: 'man_at_arms', to: 'sergeant', stage: 2 });
      M.notify('Promoted to sergeant: you command a squad of eight.', 'gain', p.id);
      M.log('career', `${p.first} was made sergeant for valour in the field.`, [p.id]);
      M.sim.score.award('deed', 30, 'Made sergeant');
    } else if (role === 'sergeant' && pm.valour >= STEPS.captain) {
      p.careerStage = 3;
      if (p.rankTier < 4) setRank(M.sim, p, 4);
      M.state.touch(p);
      M.sim.events.emit('careerChanged', { person: p.id, from: 'sergeant', to: 'sergeant', stage: 3 });
      M.notify('Promoted to captain: you command a company.', 'gain', p.id);
      M.log('career', `${p.first} was made captain.`, [p.id]);
      M.sim.score.award('deed', 60, 'Made captain');
    } else if (role === 'captain' && pm.valour >= STEPS.knight) {
      this.knight(p, a);
    }
  }

  private setKind(a: Army, p: Person, ch: string): void {
    const i = a.men.indexOf(p.id);
    if (i >= 0) { a.units = a.units.slice(0, i) + ch + a.units.slice(i + 1); this.M.touch(); }
  }

  /** Knighted for valour (SPEC §6: commoners were sometimes knighted for valour). */
  private knight(p: Person, a: Army): void {
    const M = this.M;
    p.career = 'knight'; p.careerStage = 2; p.estate = 'noble';
    setRank(M.sim, p, 5);
    M.state.touch(p);
    this.setKind(a, p, 'k');
    M.sim.events.emit('careerChanged', { person: p.id, from: 'sergeant', to: 'knight', stage: 2 });
    M.notify(`${M.houseName(a.house)} dubs you knight on the field, for valour. Arise, Sir ${p.first}.`, 'gain', p.id);
    M.log('career', `${p.first} was knighted for valour in the service of ${M.houseName(a.house)}.`, [p.id]);
    M.sim.score.award('deed', 150, 'Knighted for valour');
    M.sim.requestSave('knighted');
  }

  // ---- deeds ----

  afterBattle(a: Army, d: Army, fa: Fighters, fd: Fighters, res: Resolution, attWon: boolean, detailBy?: '' | 'a' | 'd' | 'draw'): void {
    const M = this.M;
    const pid = M.playerId;
    const p = this.me;
    const pm = M.data.player;
    const inA = fa.people.some((x) => x.id === pid) || a.men.includes(pid);
    const inD = fd.people.some((x) => x.id === pid) || d.men.includes(pid);
    // the player fought if he was in a roster or in the detail subset
    const rec = inA ? a : inD ? d : undefined;
    void detailBy;
    if (!p || !rec) return;
    const won = (rec === a) === attWon;
    const enemy = (rec === a ? fd : fa).people.length;
    pm.battles++;
    pm.valour += CFG.valour.battle + (won ? CFG.valour.victory : 0);
    const cas = [...res.attCasualties, ...res.defCasualties].find((c) => c.person.id === pid);
    if (cas && cas.fate === 'wounded') { pm.wounds++; pm.valour += CFG.valour.wound; }
    const lead = rec.commander === pid;
    if (lead && won) pm.valour += CFG.valour.command;
    const pts = won ? Math.round((5 + enemy / 8) * (lead ? 2.5 : 1)) : 2;
    M.sim.score.award('deed', pts, won ? `Won the battle near ${M.placeName(nearest(M, rec))}` : 'Fought in a lost battle');
    p.prestige += won ? 3 : 1;
    p.rep.valour = Math.min(100, p.rep.valour + (won ? 4 : 2));
    M.state.touch(p);
    if (won) {
      // a captain's share of the field
      const share = Math.round(rec.funds * 0.05);
      void share;
    }
    M.touch();
    M.sim.requestSave('battle');
  }

  afterSiege(a: Army, _rec: SiegeRec, how: string): void {
    const M = this.M;
    const p = this.me;
    if (!p || !a.men.includes(p.id)) return;
    const pm = M.data.player;
    pm.valour += CFG.valour.siege;
    M.sim.score.award('deed', how === 'stormed' ? 25 : 15, 'Took a stronghold');
  }

  afterRaid(a: Army, loot: number): void {
    const M = this.M;
    const p = this.me;
    if (!p || !a.men.includes(p.id)) return;
    M.data.player.valour += CFG.valour.raid;
    void loot;
  }

  // ---- the body follows the army ----

  /** Every sub-step: a player in a marching army is carried with it (travel mode with the army). */
  carry(): void {
    const M = this.M;
    const api = M.playerApi;
    if (!api) return;
    const a = M.playerArmy();
    if (!a) { this.carryArmy = 0; return; }
    if (a.task === 'battle' || a.engaged) return;
    const body = api.body();
    if (!body) return;
    const frac = ((M.sim.absDay * 24) % 1 + 1) % 1;
    const x = a.px + (a.x - a.px) * frac, z = a.pz + (a.z - a.pz) * frac;
    if (this.carryArmy !== a.id) { this.carryArmy = a.id; this.carryX = x; this.carryZ = z; return; }
    const dx = x - this.carryX, dz = z - this.carryZ;
    this.carryX = x; this.carryZ = z;
    if (dx === 0 && dz === 0) return;
    // far from the column (walked off, or the army marched from under him): he is left behind
    if (Math.hypot(body.x - x, body.z - z) > 420) return;
    api.placeAt(body.x + dx, body.z + dz);
  }

  /** A new character takes over: the old one's service record does not carry over. */
  reset(): void {
    this.M.data.player = emptyPlayerMil();
    this.carryArmy = 0;
    this.M.touch();
  }
}

function nearest(M: Mil, a: Army): number {
  let best = -1, bd = Infinity;
  for (const s of M.world.settlements) {
    const d = (s.x - a.x) ** 2 + (s.z - a.z) ** 2;
    if (d < bd) { bd = d; best = s.id; }
  }
  return best;
}

export { Rng };
