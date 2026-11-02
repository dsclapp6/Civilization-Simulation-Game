// Wave 3 COMBAT: one wound model for everyone, melee and archery in the detail zone, an AI for fighters, the
// player's controls and the training yard. `installCombat` registers `sim.services.combat` (src/sim/wave3.ts)
// and chains its corpses, arrows and sparks onto the view.
import type { P2 } from '../core/math';
import { dist } from '../core/math';
import { isNight } from '../core/time';
import type { ActionOutcome } from '../sim/actions';
import { gainSkill, skillOf } from '../sim/skills';
import type { Simulation } from '../sim/sim';
import { adjustOpinion, ageYears, fullName, type PersonId } from '../sim/state';
import type { Wave3Deps } from '../sim/wave3deps';
import type { CombatApi, FightResult, FightSide, HarmResult, Wound } from '../sim/wave3';
import { createCombatProvider, PROVIDER_ID } from './actions';
import { Arena, type ArenaEnv, type Fight, type KitOverride } from './arena';
import { S, type Fighter } from './fighter';
import { chainAnimals, chainCharacters, chainFx, chainProjectiles, FxQueue } from './fx';
import type { GearEnv } from './gear';
import { Healers, dailyCare, harmPerson } from './macro';
import { PlayerPort } from './playerport';
import { Projectiles } from './projectiles';
import type { Services } from './services';
import { WoundBook } from './wounds';

export interface CombatModule extends CombatApi {
  readonly arena: Arena;
  readonly book: WoundBook;
  readonly port: PlayerPort;
  /** Test and dev hooks. */
  debug: CombatDebug;
  dispose(): void;
}

export interface CombatDebug {
  /** Starts a fight between the player and `count` outlaws or wolves a few metres ahead; returns the fight id. */
  skirmish(kind: 'bandits' | 'wolves', count: number): number;
  /** Makes the person carry exactly this kit in fights (until the next load). */
  giveKit(person: PersonId, kit: KitOverride): void;
}

const AMBUSH_RADIUS = 85;

export function installCombat(sim: Simulation, deps: Wave3Deps): CombatModule {
  const { zone, economy, social, player } = deps;
  const book = new WoundBook(sim);
  const fx = new FxQueue();
  const proj = new Projectiles();
  const gearEnv: GearEnv = {
    state: sim.state, appearance: sim.view.appearance, economy, get absDay() { return sim.absDay; },
  };
  const healers = new Healers();
  const notify = (kind: Parameters<ArenaEnv['notify']>[0], text: string, person?: PersonId): void => {
    sim.events.emit('notify', { kind, text, person: person ?? sim.state.run.playerId });
  };

  // ---- the arena ----
  let actionTimeOwned = false;
  const syncFightState = (): void => {
    const want = arena.fightNearPlayer();
    if (want) {
      if (!sim.state.clock.actionTime) sim.dispatch({ type: 'setActionTime', on: true });
      actionTimeOwned = true;
    } else if (actionTimeOwned) {
      actionTimeOwned = false;
      if (!social?.current()) sim.dispatch({ type: 'setActionTime', on: false });
    }
  };
  const env: ArenaEnv = {
    ctx: sim, book, zone, economy, social, gearEnv, fx, proj,
    playerBody: () => (player ? player.body() : null),
    notify,
    wind: () => { const w = sim.view.weather(); return { x: w.windX, z: w.windZ }; },
    fightsChanged: () => syncFightState(),
    onKill: (killer, victim) => onKill(killer, victim),
    fightEnded: (fight, result) => onFightEnd(fight, result),
    playerHit: (f, victim, ranged, killed) => {
      const p = f.person;
      if (!p) return;
      gainSkill(sim, p, ranged ? 'archery' : 'melee', killed ? 5 : ranged ? 1.4 : 1.2);
      if (!ranged) { sim.state.touch(p); }
      void victim;
    },
  };
  const arena = new Arena(env);
  const port = new PlayerPort(arena);
  book.onDeath = () => { /* the arena notices through Person.death */ };

  // ---- consequences ----
  const assaults = new Map<number, { victim: PersonId; witnessed: boolean }>();

  function onKill(killer: Fighter | null, victim: Fighter): void {
    const state = sim.state;
    const vp = victim.person;
    if (!vp) return;
    const kp = killer?.person ?? null;
    // the dead man's own people do not forget
    if (social) {
      const kin = new Set<PersonId>([vp.spouse, vp.father, vp.mother, ...vp.children]);
      for (const k of kin) {
        if (!k || !kp || k === kp.id) continue;
        const kk = state.persons.get(k);
        if (kk && !kk.death) social.adjustOpinion(k, kp.id, -45, 'killed my kin');
      }
    }
    const playerInvolved = (killer?.isPlayer ?? false) || victim.isPlayer;
    if (playerInvolved || vp.rankTier >= 3 || vp.house === state.run.houseId) {
      const who = kp ? fullName(kp) : 'a beast';
      state.log(sim.absDay, 'combat', `${fullName(vp)} was slain by ${who}.`, kp ? [vp.id, kp.id] : [vp.id]);
    }
    if (killer?.isPlayer && kp) {
      const fight = arena.fights.get(killer.fight);
      const assault = fight && assaults.has(fight.id);
      kp.rep.valour = Math.max(-100, Math.min(100, kp.rep.valour + (assault ? 0 : 1)));
      if (assault) { kp.rep.cruelty = Math.min(100, kp.rep.cruelty + 8); kp.rep.honour = Math.max(-100, kp.rep.honour - 12); }
      state.touch(kp);
    }
    if (victim.isPlayer) notify('danger', 'You have been slain.', vp.id);
  }

  function onFightEnd(fight: Fight, result: FightResult): void {
    const state = sim.state;
    const pid = state.run.playerId;
    const duel = duels.get(fight.id);
    if (duel) {
      duels.delete(fight.id);
      const a = state.persons.get(duel.a), b = state.persons.get(duel.b);
      const down = (id: PersonId): boolean => result.wounded.includes(id) && (book.isHurt(id) || !!state.persons.get(id)?.death);
      const aLost = !a || a.death || (down(duel.a) && !down(duel.b));
      const bLost = !b || b.death || (down(duel.b) && !down(duel.a));
      const winner = aLost && !bLost ? b : bLost && !aLost ? a : undefined;
      const loser = winner === a ? b : winner === b ? a : undefined;
      if (winner && loser) {
        winner.rep.valour = Math.min(100, winner.rep.valour + 3);
        winner.prestige += 2;
        state.touch(winner);
        social?.adjustOpinion(loser.id, winner.id, 4, 'beat me fairly');
        state.log(sim.absDay, 'combat', `${fullName(winner)} bested ${fullName(loser)} in single combat.`, [winner.id, loser.id]);
        notify(winner.id === pid ? 'gain' : 'warn', winner.id === pid ? `${loser.first} yields. The duel is yours.` : `You yield to ${winner.first}.`, pid);
      }
    }
    const a = assaults.get(fight.id);
    if (a) {
      assaults.delete(fight.id);
      const victim = state.persons.get(a.victim);
      const me = state.persons.get(pid);
      if (me && victim && a.witnessed && (victim.death || book.isHurt(a.victim) || result.wounded.includes(a.victim))) {
        me.flags.outlaw = true;
        state.touch(me);
        state.log(sim.absDay, 'crime', `${fullName(me)} was seen attacking ${fullName(victim)} and is named an outlaw.`, [me.id, victim.id]);
        notify('danger', 'You were seen. You are named an outlaw.', pid);
      }
    }
    if (fight.playerIn && !result.dead.includes(pid)) {
      const me = state.persons.get(pid);
      if (me && result.winner === 'player') {
        me.rep.valour = Math.max(-100, Math.min(100, me.rep.valour + 1));
        me.prestige += 1;
        state.touch(me);
      }
    }
    if (fight.playerIn) sim.requestSave('fight ended');
  }

  // ---- peaceful people struck by the player ----
  function assault(actor: PersonId, victimId: PersonId): ActionOutcome {
    const state = sim.state;
    const me = state.persons.get(actor);
    const victim = state.persons.get(victimId);
    if (!me || !victim || victim.death) return { ok: false, message: 'They are not there.' };
    if (arena.inFight(victimId)) return { ok: false, message: 'They are already fighting.' };
    // their people take their part: kin and household within shouting distance
    const defenders: PersonId[] = [victimId];
    const witnesses: PersonId[] = [];
    const where = zone?.agent(victimId);
    if (zone && where) {
      for (const ag of zone.agents()) {
        if (ag.personId === victimId || ag.personId === actor) continue;
        const d = dist(ag.x, ag.z, where.x, where.z);
        if (d > 30) continue;
        const q = state.persons.get(ag.personId);
        if (!q || q.death) continue;
        const age = ageYears(q, sim.absDay);
        if (age < 14 || q.flags.player) continue;
        const kin = q.household === victim.household || q.spouse === victimId || q.father === victimId || q.mother === victimId || victim.children.includes(q.id)
          || (social ? social.opinion(q.id, victimId) >= 40 : false);
        if (kin && d < 20 && q.sex === 'm' && age < 60 && defenders.length < 4 && !arena.inFight(q.id)) defenders.push(q.id);
        else witnesses.push(q.id);
      }
    }
    const at: P2 = where ? { x: where.x, z: where.z } : (player?.body() ?? { x: 0, z: 0 });
    const id = arena.engage(
      [{ faction: 'player', people: [actor] }, { faction: 'defenders', people: defenders }],
      { at, yieldAllowed: false, reason: 'assault' },
    );
    if (id === 0) return { ok: false, message: 'Nothing comes of it.' };
    // the victim's side starts the fight afraid unless it is armed and angry
    for (const w of witnesses) {
      social?.adjustOpinion(w, actor, -22, 'saw you attack someone');
      zone?.say(w, 'Murder! Stop him!', 3);
    }
    social?.adjustOpinion(victimId, actor, -50, 'attacked me');
    assaults.set(id, { victim: victimId, witnessed: witnesses.length > 0 || defenders.length > 1 });
    zone?.say(victimId, 'You dog!', 2.5);
    return { ok: true, message: `You strike at ${victim.first}!` };
  }

  /** A challenge to single combat, to yielding: honourable, no crime, nobody else joins in. The challenged man
   *  accepts unless he is hurt, or holds the challenger in contempt and is the weaker. */
  const duels = new Map<number, { a: PersonId; b: PersonId }>();
  function challenge(actor: PersonId, otherId: PersonId): ActionOutcome {
    const state = sim.state;
    const me = state.persons.get(actor);
    const other = state.persons.get(otherId);
    if (!me || !other || other.death) return { ok: false, message: 'They are not there.' };
    if (arena.inFight(otherId)) return { ok: false, message: 'They are already fighting.' };
    if (book.isHurt(otherId)) { zone?.say(otherId, 'Not while I bleed.', 2.5); return { ok: false, message: `${other.first} is hurt and will not fight.` }; }
    armForFight(actor);
    const where = zone?.agent(otherId);
    const at: P2 = where ? { x: where.x, z: where.z } : (player?.body() ?? { x: 0, z: 0 });
    const id = arena.engage([{ faction: 'player', people: [actor] }, { faction: 'challenged', people: [otherId] }], { at, yieldAllowed: true, reason: 'duel' });
    if (id === 0) return { ok: false, message: 'Nothing comes of it.' };
    duels.set(id, { a: actor, b: otherId });
    zone?.say(otherId, other.career === 'knight' ? 'So be it. Guard yourself!' : 'Have at you, then!', 2.5);
    return { ok: true, message: `You challenge ${other.first}. To the yield!` };
  }

  /** A fighting man the player controls carries his arms for real: a knight, a man-at-arms, a sergeant or a squire
   *  with nothing in his hand is given (once) the kit of his station, and it is put on. */
  const STATION_KIT: Record<string, ReadonlyArray<readonly [string, 'main' | 'off' | 'armour' | 'helmet']>> = {
    knight: [['sword', 'main'], ['shield', 'off'], ['mail_hauberk', 'armour'], ['kettle_hat', 'helmet']],
    man_at_arms: [['sword', 'main'], ['shield', 'off'], ['padded_armour', 'armour'], ['cap_helmet', 'helmet']],
    sergeant: [['sword', 'main'], ['shield', 'off'], ['padded_armour', 'armour'], ['cap_helmet', 'helmet']],
    squire: [['sword', 'main'], ['shield', 'off']],
  };
  function armForFight(person: PersonId): void {
    const p = sim.state.persons.get(person);
    if (!p || !economy) return;
    const kit = STATION_KIT[p.career];
    if (!kit || economy.inventory(person).equipment.main) return;
    for (const [good, slot] of kit) {
      if (economy.inventory(person).equipment[slot]) continue;
      if ((p.inventory[good] ?? 0) < 1) p.inventory[good] = (p.inventory[good] ?? 0) + 1;
      economy.equip(person, slot, good);
    }
    sim.state.touch(p);
  }

  const services: Services = { sim, arena, book, economy, social, zone, player, assault, challenge };
  sim.actions.register(createCombatProvider(services));

  // ---- the API ----
  const listeners = arena.endListeners;
  const api: CombatModule = {
    arena, book, port,
    engage: (sides: FightSide[], opts) => arena.engage(sides, opts),
    isFighting: (person) => arena.inFight(person),
    harm: (person, intensity, cause): HarmResult => {
      const p = sim.state.persons.get(person);
      if (!p) return 'dead';
      return harmPerson(gearEnv, book, sim.rng('combat'), p, intensity, cause);
    },
    wounds: (person): readonly Wound[] => book.wounds(person),
    onFightEnded: (fn) => {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
    fightOf: (person) => arena.fighterOf(person)?.fight ?? 0,
    disperse: (id) => { const f = arena.fights.get(id); if (f) arena.endFight(f, 'dispersed'); },
    anyFight: () => arena.anyFight(),
    blood: (person) => book.rec(person)?.blood ?? 1,
    tend: (healer, patient) => {
      const h = sim.state.persons.get(healer);
      const q = sim.state.persons.get(patient);
      if (!h || !q) return { ok: false, message: 'No one to tend.' };
      const r = book.tend(q, skillOf(h, 'medicine'), sim.rng('combat'));
      return { ok: r.tended > 0, message: r.message };
    },
    player: port,
    debug: {
      skirmish: (kind, count) => debugSkirmish(kind, count),
      giveKit: () => { /* replaced below */ },
    },
    dispose: () => { for (const off of offs.splice(0)) off(); },
  };
  sim.services.combat = api;
  // a game saved in the middle of a fight loads with the fight gone: its action time must not stay on
  if (sim.state.clock.actionTime) sim.dispatch({ type: 'setActionTime', on: false });

  // ---- systems ----
  const offs: Array<() => void> = [];
  offs.push(sim.registerSystem({
    name: 'combat.step', phase: 'perStep', order: 65,
    run: (_c, info) => {
      try {
        arena.step(info.dt);
        ambush(info.dt);
      } catch (err) {
        // a fight must never take the simulation down with it: break everything off and carry on
        console.error('[combat] step failed, fights dispersed', err);
        arena.reset();
      }
      checkT -= info.dt;
      if (checkT <= 0) { checkT = 1; if (arena.fightNearPlayer() !== actionTimeOwned) syncFightState(); }
    },
  }));
  let checkT = 1;
  offs.push(sim.registerSystem({
    name: 'combat.hour', phase: 'hourly', order: 40,
    run: () => { book.hour((id) => arena.byKey.has(id)); },
  }));
  offs.push(sim.registerSystem({
    name: 'combat.day', phase: 'daily', order: 40,
    run: (_c, info) => {
      dailyCare(sim.state, book, healers, sim.rng('combat'), info.absDay);
      book.day(info.absDay, (id) => { const p = sim.state.persons.get(id); return p ? healers.skillIn(sim.state, p.settlement, info.absDay) : 0; });
    },
  }));

  // ---- the view ----
  chainCharacters(sim.view, () => arena.corpseDraws());
  chainAnimals(sim.view, () => arena.beastCorpseDraws());
  chainFx(sim.view, (into) => fx.drain(into));
  chainProjectiles(sim.view, () => proj.view());

  // ---- the world around the fights ----
  const prevHostile = sim.hostileNear;
  sim.hostileNear = () => arena.fightNearPlayer() || prevHostile();

  const ev = sim.events;
  offs.push(
    ev.on('playerSwitched', (e) => { port.reset(); armForFight(e.to); }),
    ev.on('playerDied', () => { arena.dropPlayer(); }),
    ev.on('gameOver', () => { arena.reset(); }),
    ev.on('death', (e) => { book.forget(e.person); arena.onDeath(e.person); }),
  );
  // the lord (or whoever the run is played as) carries the arms of his station from the first morning
  armForFight(sim.state.run.playerId);

  // ---- wolves close in on a lone traveller ----
  let circled = 0;
  let ambushAt = 30;
  let ambushClock = 0;
  function ambush(dt: number): void {
    ambushClock += dt;
    if (ambushClock < 1 || !zone) return;
    const span = ambushClock;
    ambushClock = 0;
    const pid = sim.state.run.playerId;
    const body = player?.body();
    if (!body || arena.fighterOf(pid)?.fight) { circled = 0; return; }
    const night = isNight(sim.absDay);
    const wolves = zone.animals().filter((an) => an.kind === 'wolf' && an.hostile && !arena.byKey.has(1_000_000_000 + an.id) && dist(an.x, an.z, body.x, body.z) < AMBUSH_RADIUS);
    if (wolves.length === 0) { circled = Math.max(0, circled - span * 2); return; }
    const s = sim.world.nearestSettlement(body.x, body.z);
    const remote = dist(s.x, s.z, body.x, body.z) - s.radius > 140;
    if (!remote || (!night && sim.view.weather().snowCover < 0.3)) { circled = 0; return; }
    circled += span;
    if (circled === span) ambushAt = 22 + sim.rng('combat').next() * 25;
    if (circled < ambushAt) return;
    circled = 0;
    const picked = wolves.sort((x, y) => dist(x.x, x.z, body.x, body.z) - dist(y.x, y.z, body.x, body.z)).slice(0, 4).map((an) => an.id);
    const id = arena.engage([{ faction: 'player', people: [pid] }, { faction: 'wolves', people: [], animals: picked }], { at: body, reason: 'wolves' });
    if (id) notify('danger', 'The wolves are closing in!', pid);
  }

  // ---- dev hooks ----
  function debugSkirmish(kind: 'bandits' | 'wolves', count: number): number {
    const body = player?.body();
    const pid = sim.state.run.playerId;
    if (!body) return 0;
    const ahead = (r: number, spread: number): P2 => ({ x: body.x + Math.sin(body.yaw + spread) * r, z: body.z + Math.cos(body.yaw + spread) * r });
    // what the scene summoned goes when the fight is over
    const tidy = (fightId: number, people: PersonId[], animals: number[]): number => {
      if (fightId === 0) { for (const id of people) zone?.dismiss?.(id); for (const id of animals) zone?.dismissAnimal?.(id); return 0; }
      const off = api.onFightEnded((r) => {
        if (r.id !== fightId) return;
        off();
        for (const id of people) zone?.dismiss?.(id);
        for (const id of animals) zone?.dismissAnimal?.(id);
      });
      return fightId;
    };
    if (kind === 'wolves' && zone?.summonAnimal) {
      const ids: number[] = [];
      for (let i = 0; i < count; i++) { const at = ahead(14 + i * 1.2, (i - (count - 1) / 2) * 0.5); ids.push(zone.summonAnimal('wolf', at.x, at.z, true)); }
      return tidy(arena.engage([{ faction: 'player', people: [pid] }, { faction: 'wolves', people: [], animals: ids }], { at: body, reason: 'wolves' }), [], ids);
    }
    const people: PersonId[] = [];
    const me = sim.state.persons.get(pid);
    if (!me) return 0;
    for (const r of sim.state.residentsOf(me.settlement)) {
      if (people.length >= count) break;
      if (r.id === pid || r.sex !== 'm' || r.household === me.household || ageYears(r, sim.absDay) < 16 || ageYears(r, sim.absDay) > 45 || arena.inFight(r.id)) continue;
      if (zone?.summon) { const at = ahead(11 + people.length * 0.8, (people.length - (count - 1) / 2) * 0.55); zone.summon(r.id, at.x, at.z, body.yaw + Math.PI); }
      people.push(r.id);
    }
    return tidy(arena.engage([{ faction: 'player', people: [pid] }, { faction: 'bandits', people }], { at: body, reason: 'bandits' }), people, []);
  }
  api.debug.giveKit = (person, kit) => arena.setKitOverride(person, kit);

  void PROVIDER_ID;
  return api;
}
void adjustOpinion; void S;
