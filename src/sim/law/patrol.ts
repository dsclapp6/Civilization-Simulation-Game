// The patrol (docs/CIV.md §4): the lord's men ride up to a trespasser, halt him with the lines of the design and hear his answer —
// leave (and be escorted off the land), state his business (a check; a bribe), pay the fine (poaching), yield (taken prisoner) or
// refuse, flee, come back (the fight, to wound or kill, and the prisoner if he goes down or yields). The state machine is here
// (phases, lines, deadlines, the choices); the men are people in the detail zone driven through the ZoneApi's summon and orders,
// and without a zone (headless, tests) the same phases run on timers.
import type { P2 } from '../../core/math';
import { clamp, dist, hash01, yawTo } from '../../core/math';
import { DAY_SECONDS, isNight } from '../../core/time';
import { isMarketDay } from '../calendar';
import { parseItemKey } from '../economy/types';
import { formatMoney } from '../money';
import { skillOf } from '../skills';
import { adjustOpinion, hasFlag, type HouseId, type Person, type PersonId } from '../state';
import type { FightResult } from '../wave3';
import type { TrespassCause, TrespassLevel } from '../territory/types';
import { LAW } from './config';
import { seizePerson, restrainPlayer, deliver } from './captive';
import type { Law } from './context';
import { pickSquad, type Squad } from './pick';
import type { CaptiveRec } from './store';
import type { CaptivityKind, LawChoice, PatrolPhase, PatrolView, Result } from './types';

/** The faction name the patrol fights under. */
const FACTION = 'patrol';

/** Goods a poacher carries off the lord's land (the hunt's takings), and the bows that say he came to hunt. */
const GAME = /venison|game|hare|rabbit|pheasant|boar|deer|partridge|swan/;
const BOWS: ReadonlySet<string> = new Set(['shortbow', 'longbow', 'crossbow']);

export interface Patrol {
  id: number;
  target: PersonId;
  settlement: number;
  house: HouseId;
  lord: PersonId;
  level: TrespassLevel;
  cause: TrespassCause | undefined;
  reason: string;
  leader: PersonId;
  men: PersonId[];
  mounted: Set<PersonId>;
  phase: PatrolPhase;
  /** Seconds in this phase, and since the patrol was made. */
  t: number;
  age: number;
  line: string;
  /** Seconds left to be off the land (escort); Infinity otherwise. */
  deadline: number;
  skipTalk: boolean;
  poaching: boolean;
  /** Came back after being escorted off, or broke out of the gaol: no hearing. */
  attackOnSight: boolean;
  triedBusiness: boolean;
  triedBribe: boolean;
  /** Seconds the target has been out of reach at the halt, and warnings given for it. */
  strayT: number;
  warned: number;
  /** The combat module's fight, 0 before the fight and after. */
  fight: number;
  exit: P2 | null;
  /** The men are people in the zone (summoned); false when it cannot show them. */
  physical: boolean;
  /** Where they came from (and ride off to). */
  home: P2;
  /** Seconds the leader waits for the answer, once warned. */
  impatient: boolean;
  /** The ride in: where the leader stood when last looked at and when (patrol seconds), the detours ordered round a snag, and when the last ends. */
  stallAt: P2 | null;
  stallT: number;
  detours: number;
  detourUntil: number;
  /** The halt was called from a distance (the leader could get no nearer): where the man stood, so that flight is measured from there. */
  afar: P2 | null;
  /** Kind of captivity if taken, and whether blood was shed in the fight. */
  kind: CaptivityKind;
  bloodshed: boolean;
  /** Being taken away: the lock-up is far and the march is a skip of the clock. */
  marching: boolean;
  /** The cell's door, where the prisoner is led (set when he is taken). */
  cell: { x: number; z: number; yaw: number } | null;
  /** The target was left alone at the halt: phase to go to once the standoff is answered. */
  goneT: number;
  /** The standoff (action time) is on. */
  slowed: boolean;
  /** UI refresh. */
  rev: number;
}

export interface PatrolEnv {
  /** Whether the target is armed (a weapon in hand slot) — decides the talk at war. */
  armed(p: Person): boolean;
}

export class PatrolSystem {
  readonly patrols = new Map<PersonId, Patrol>();
  private nextId = 1;
  /** People escorted off the land recently: coming back is a fight. */
  readonly escorted = new Map<PersonId, { settlement: number; until: number }>();
  /** Who is busy in a patrol (not to be sent twice). */
  readonly busy = new Set<PersonId>();
  private sleepOwned = false;

  constructor(private readonly L: Law) {}

  // ---------------------------------------------------------------------------------------------
  // queries
  // ---------------------------------------------------------------------------------------------

  get(person: PersonId): Patrol | null { return this.patrols.get(person) ?? null; }
  any(): boolean { return this.patrols.size > 0; }
  /** A patrol whose men are about to deal with the player: no hurrying, no sleeping. */
  hostile(): boolean {
    for (const p of this.patrols.values()) if (p.phase !== 'gone' && !p.marching) return true;
    return false;
  }

  view(p: Patrol): PatrolView {
    const L = this.L;
    const lead = L.person(p.leader);
    return {
      id: p.id, leader: p.leader, men: p.men, house: p.house, settlement: p.settlement, target: p.target, phase: p.phase, line: p.line,
      deadline: p.deadline, level: p.level, reason: p.reason, cause: p.cause, exit: p.exit, mounted: p.mounted.size > 0,
      lord: p.level === 'hostile' ? L.houseName(p.house) : L.titled(p.lord), leaderName: lead ? `${this.rankWord(lead)} ${L.name(lead.id)}` : undefined,
      skipTalk: p.skipTalk, poaching: p.poaching,
    };
  }

  private rankWord(p: Person): string {
    switch (p.career) {
      case 'knight': return 'Sir';
      case 'sergeant': return 'Sergeant';
      case 'man_at_arms': return 'Man-at-arms';
      case 'soldier': return 'Soldier';
      case 'archer': return 'Archer';
      case 'bailiff': return 'Bailiff';
      case 'steward': return 'Steward';
      default: return '';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // starting
  // ---------------------------------------------------------------------------------------------

  /**
   * Sends a patrol after the person for an offence on `settlement`'s lands. `from` is where it appears (a witness who leads it where
   * he stands, else the edge of sight); returns null when there is nobody to send.
   */
  start(
    target: Person, check: { level: TrespassLevel; cause?: TrespassCause; reason: string; lord?: PersonId }, settlement: number, opts: { attackOnSight?: boolean; near?: PersonId; x: number; z: number },
  ): Patrol | null {
    const L = this.L;
    if (this.patrols.has(target.id) || this.patrols.size >= LAW.maxPatrols) return null;
    const house = L.houseOf(settlement) || L.territory?.landAt(opts.x, opts.z).house || 0;
    const hostile = check.level === 'hostile';
    const seed = (L.store.data.stats.patrols + 1) * 7919 + target.id;
    const squad = pickSquad(L, settlement, house, { seed, hostile, busy: this.busy, near: opts.near });
    if (!squad) return null;
    const lord = check.lord ?? L.lordOf(settlement);
    const armed = L.economy ? armedWith(L, target) : false;
    const poaching = !hostile && (check.cause === 'park' || check.cause === 'demesne') && poachingEvidence(L, target, check.cause);
    const skipTalk = hostile && (check.cause === 'war' || check.cause === 'feud' || check.cause === 'outlaw' || check.cause === 'enemy')
      && (armed || target.rankTier >= 4 || L.armed(target) || check.cause === 'outlaw' || check.cause === 'enemy');
    const p: Patrol = {
      id: this.nextId++, target: target.id, settlement, house, lord, level: check.level, cause: check.cause, reason: check.reason,
      leader: squad.leader, men: squad.men, mounted: new Set(squad.mounted), phase: 'coming', t: 0, age: 0, line: '', deadline: Infinity,
      skipTalk, poaching, attackOnSight: !!opts.attackOnSight, triedBusiness: false, triedBribe: false, strayT: 0, warned: 0, fight: 0, exit: null,
      physical: false, home: { x: opts.x, z: opts.z }, impatient: false, stallAt: null, stallT: 0, detours: 0, detourUntil: 0, afar: null,
      kind: 'trespass', bloodshed: false, marching: false, cell: null, goneT: 0, slowed: false, rev: 0,
    };
    p.kind = this.kindOf(p, target);
    this.patrols.set(target.id, p);
    for (const id of [p.leader, ...p.men]) this.busy.add(id);
    L.store.data.stats.patrols++;
    L.store.bump();
    // they appear at the edge of sight (or where the witness stands) and ride up
    this.spawn(p, target, opts.x, opts.z, opts.near === squad.leader);
    return p;
  }

  private kindOf(p: Patrol, target: Person): CaptivityKind {
    if (p.level === 'hostile' && (p.cause === 'war' || p.cause === 'feud' || p.cause === 'hostile')) return 'war';
    if (p.cause === 'outlaw' || p.cause === 'enemy' || p.attackOnSight || hasFlag(target, 'outlaw')) return 'crime';
    return p.poaching ? 'poaching' : 'trespass';
  }

  /** Puts the men in the zone, at the edge of sight along the way from the seat, or where the leader already stands. */
  private spawn(p: Patrol, target: Person, wx: number, wz: number, leaderIsWitness: boolean): void {
    const L = this.L;
    const z = L.zone;
    const body = L.player?.body() ?? null;
    if (!z?.summon || !body) { p.physical = false; return; }
    p.physical = true;
    // the direction they come from: the lord's seat, else the way the witness is
    const seat = this.seatOf(p.settlement);
    const base = seat ? yawTo(body.x, body.z, seat.x, seat.z) : yawTo(body.x, body.z, wx, wz);
    let place: P2 | null = null;
    if (leaderIsWitness && z.agent(p.leader)) { const a = z.agent(p.leader)!; place = { x: a.x, z: a.z }; }
    if (!place) place = this.edgeOfSight(body, base);
    p.home = { x: place.x, z: place.z };
    const yaw = yawTo(place.x, place.z, body.x, body.z);
    const all = [p.leader, ...p.men];
    all.forEach((id, i) => {
      const m = L.person(id);
      // a column, the leader in front: each a body and a half behind the last, abreast of the road
      const back = i * 2.2, side = (i % 2 === 0 ? 1 : -1) * Math.min(1.4, i * 0.55);
      const x = place!.x - Math.sin(yaw) * back + Math.cos(yaw) * side, zz = place!.z - Math.cos(yaw) * back - Math.sin(yaw) * side;
      const riding = p.mounted.has(id);
      z.summon!(id, i === 0 && leaderIsWitness ? place!.x : x, i === 0 && leaderIsWitness ? place!.z : zz, yaw, {
        mounted: riding, coat: 0x4a3626 + (hash01(id, 5) * 4 | 0) * 0x101010, main: m && (riding || m.career === 'knight') ? 'lance' : 'spear',
        off: m && m.career !== 'archer' ? 'shield_heater' : 'none', torch: isNight(L.day) && !riding,
      });
    });
    this.order(p);
  }

  /** Where the lord's men come from: his hall, keep or manor in the settlement, or the settlement itself. */
  private seatOf(settlement: number): P2 | null {
    const L = this.L;
    const b = L.finished(settlement, ['keep_stone', 'motte', 'manor_house', 'great_hall', 'barracks']);
    if (b) return { x: b.x, z: b.z };
    const s = L.world.settlements.find((q) => q.id === settlement);
    return s ? { x: s.x, z: s.z } : null;
  }

  /** A walkable point at the edge of sight in a direction (the zone's navigation finds ground near the ring). */
  private edgeOfSight(body: { x: number; z: number }, yaw: number): P2 {
    const L = this.L;
    const nav = L.zone!.nav;
    const out = { x: 0, z: 0 };
    for (let k = 0; k < 9; k++) {
      // the way in, then to either side in turn
      const a = yaw + (k === 0 ? 0 : (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 0.35);
      for (const r of [LAW.spawnRadius, LAW.spawnRadius - LAW.spawnSlack, LAW.spawnRadius + LAW.spawnSlack]) {
        const x = body.x + Math.sin(a) * r, zz = body.z + Math.cos(a) * r;
        if (nav.walkable(x, zz)) return { x, z: zz };
        if (nav.nearestWalkable(x, zz, 12, out)) return { x: out.x, z: out.z };
      }
    }
    return { x: body.x + Math.sin(yaw) * LAW.spawnRadius, z: body.z + Math.cos(yaw) * LAW.spawnRadius };
  }

  // ---------------------------------------------------------------------------------------------
  // orders to the men
  // ---------------------------------------------------------------------------------------------

  /** (Re)issues the orders the phase calls for. */
  private order(p: Patrol): void {
    const L = this.L;
    const z = L.zone;
    if (!z || !p.physical) return;
    const all = [p.leader, ...p.men];
    const gait = (id: PersonId): 'gallop' | 'jog' => (p.mounted.has(id) ? 'gallop' : 'jog');
    switch (p.phase) {
      case 'coming':
        all.forEach((id, i) => z.command(id, { kind: 'approach', target: p.target, distance: i === 0 ? LAW.haltDistance : 4.6 + (i - 1) * 1.15, gait: gait(id), side: i === 0 ? 0 : (i % 2 === 0 ? 1 : -1) }));
        break;
      case 'halt':
        for (const id of all) z.command(id, { kind: 'face', target: p.target });
        break;
      case 'escort':
        all.forEach((id, i) => z.command(id, { kind: 'follow', leader: p.target, distance: LAW.escortGap + i * 1.4 }));
        break;
      case 'taking':
        z.command(p.leader, { kind: 'face', target: p.target });
        p.men.forEach((id, i) => z.command(id, { kind: 'follow', leader: p.leader, distance: 2.4 + i * 1.3 }));
        break;
      case 'gone':
        all.forEach((id) => z.command(id, { kind: 'goto', x: p.home.x, z: p.home.z, run: false, gait: p.mounted.has(id) ? 'canter' : 'jog' }));
        break;
      default: break;
    }
  }

  /** The ride in has stopped short: round by another bearing (three times), then call out from where he is if he can be seen, else give up. */
  private detour(p: Patrol, lp: P2, body: P2, d: number): void {
    const L = this.L;
    const z = L.zone;
    if (!z) return;
    p.detours++;
    if (p.detours > 3) {
      const nav = z.nav as typeof z.nav & { lineClear?(x0: number, z0: number, x1: number, z1: number): boolean };
      if (d <= 70 && nav.lineClear && nav.lineClear(lp.x, lp.z, body.x, body.z)) { this.halt(p); return; }
      this.finish(p);
      return;
    }
    // a point on the other side of the snag: the same ring about him, turned a little more each time
    const ang = Math.atan2(lp.x - body.x, lp.z - body.z) + (p.detours % 2 === 1 ? 1 : -1) * Math.ceil(p.detours / 2) * 0.9;
    const r = clamp(d * 0.8, 22, 60);
    let x = body.x + Math.sin(ang) * r, zz = body.z + Math.cos(ang) * r;
    const out = { x: 0, z: 0 };
    if (!z.nav.walkable(x, zz) && z.nav.nearestWalkable(x, zz, 14, out)) { x = out.x; zz = out.z; }
    for (const id of [p.leader, ...p.men]) z.command(id, { kind: 'goto', x, z: zz, run: false, gait: p.mounted.has(id) ? 'canter' : 'jog' });
    p.detourUntil = p.t + 7;
  }

  private say(p: Patrol, text: string, seconds = 6): void {
    p.line = text;
    p.rev++;
    this.L.store.bump();
    this.L.zone?.say(p.leader, text, seconds);
  }

  // ---------------------------------------------------------------------------------------------
  // the lines
  // ---------------------------------------------------------------------------------------------

  private lordWord(p: Patrol): string {
    return p.level === 'hostile' ? this.L.houseName(p.house) : this.L.titled(p.lord);
  }

  private haltLine(p: Patrol): string {
    const lord = this.lordWord(p);
    // when the lord rides himself it is his own land he speaks of
    const mine = p.level !== 'hostile' && p.leader === p.lord;
    const lands = mine ? 'my lands' : `the lands of ${lord}`;
    const park = mine ? 'my park' : `${lord}'s park`;
    const closes = mine ? 'my closes' : `${lord}'s closes`;
    if (p.attackOnSight) return p.cause === 'outlaw' || p.kind === 'crime' ? 'There he is! Take him!' : 'I told you to keep off! Take him!';
    if (p.skipTalk) {
      if (p.cause === 'outlaw') return 'An outlaw! Yield, or we cut you down!';
      if (p.cause === 'enemy') return `${lord} will not have you here. Yield, or be taken!`;
      return `Yield! You are on the lands of ${lord}, at war with you!`;
    }
    if (p.level === 'hostile') return `Halt. You are on the lands of ${lord}. State your business or be gone.`;
    if (p.poaching) return `Poaching in ${park}! You'll answer for this.`;
    switch (p.cause) {
      case 'park': return `Halt! This is ${park}. What business have you here?`;
      case 'castle': return `Halt. The castle is shut. State your business or be gone.`;
      case 'demesne': return `Halt. These are ${closes}. State your business or be gone.`;
      default: return `Halt. You are on ${lands}. State your business or be gone.`;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // the step
  // ---------------------------------------------------------------------------------------------

  step(dt: number): void {
    for (const p of [...this.patrols.values()]) this.stepPatrol(p, dt);
    // escorted-off memory runs out
    if (this.escorted.size) {
      const now = this.L.day;
      for (const [id, e] of this.escorted) if (e.until < now) this.escorted.delete(id);
    }
  }

  private target(p: Patrol): Person | undefined { return this.L.alive(p.target); }

  private leaderPos(p: Patrol): P2 | null {
    const a = this.L.zone?.agent(p.leader);
    return a ? { x: a.x, z: a.z } : null;
  }

  private stepPatrol(p: Patrol, dt: number): void {
    const L = this.L;
    p.t += dt; p.age += dt;
    const me = this.target(p);
    if (!me) { this.finish(p); return; }
    const body = L.player?.body() ?? null;
    switch (p.phase) {
      case 'coming': {
        const lp = this.leaderPos(p);
        let d = Infinity;
        if (p.physical && lp && body) d = dist(lp.x, lp.z, body.x, body.z);
        // without a zone the men "arrive" after a plausible ride; with one, when the leader is up with the target
        const arrived = p.physical ? d <= LAW.haltDistance + 2.4 : p.t >= 6;
        // a leader who cannot get there (stuck, or gone from the zone) is given up on after a while
        if (p.physical && p.t > 160 && !arrived) { this.finish(p); return; }
        if (p.physical && p.t > 1.5 && !lp) { this.finish(p); return; }
        if (arrived) { this.halt(p); break; }
        // a leader who makes no headway (a pond's edge, a hedge, a gap too narrow for a horse) is sent round another way, and in the end calls out
        // from where he is when he can see the man, or gives up
        if (p.physical && lp && body && p.t >= p.detourUntil && d > 15) {
          if (!p.stallAt) { p.stallAt = { x: lp.x, z: lp.z }; p.stallT = p.t; }
          else if (p.t - p.stallT >= 6) {
            // six seconds and he has gone less than a walking man would: he is held up
            const moved = dist(lp.x, lp.z, p.stallAt.x, p.stallAt.z);
            p.stallAt = { x: lp.x, z: lp.z }; p.stallT = p.t;
            if (moved < 6) { this.detour(p, lp, body, d); if (!this.patrols.has(p.target) || p.phase !== 'coming') break; }
          }
        }
        if (p.physical && p.t >= p.detourUntil && Math.floor(p.t * 2) !== Math.floor((p.t - dt) * 2) && p.t % 2 < dt) this.order(p);
        break;
      }
      case 'halt': this.stepHalt(p, me, dt, body); break;
      case 'escort': this.stepEscort(p, me, dt, body); break;
      case 'attack': this.stepAttack(p, me); break;
      case 'taking': this.stepTaking(p, me, dt, body); break;
      case 'gone': {
        p.goneT += dt;
        const lp = this.leaderPos(p);
        const far = !p.physical || !lp || !body || dist(lp.x, lp.z, body.x, body.z) > LAW.goneDistance;
        if (far || p.goneT > 50) this.finish(p);
        break;
      }
    }
  }

  private setPhase(p: Patrol, phase: PatrolPhase): void {
    p.phase = phase; p.t = 0; p.rev++;
    this.L.store.bump();
  }

  private halt(p: Patrol): void {
    const L = this.L;
    this.setPhase(p, 'halt');
    p.strayT = 0; p.warned = 0;
    // called out from afar: flight is walking off from where he stood, not from a leader who cannot come nearer
    const lp0 = this.leaderPos(p), b0 = L.player?.body();
    p.afar = lp0 && b0 && dist(lp0.x, lp0.z, b0.x, b0.z) > LAW.haltStray ? { x: b0.x, z: b0.z } : null;
    this.say(p, this.haltLine(p), 9);
    this.order(p);
    // the standoff runs in action time, as a conversation does
    if (!L.state.clock.actionTime) { L.sim.dispatch({ type: 'setActionTime', on: true }); p.slowed = true; }
    L.sim.events.emit('trespass', { phase: 'warned', person: p.target, house: p.house, settlement: p.settlement, level: p.level === 'hostile' ? 'hostile' : 'private' });
    L.store.data.stats.seen++;
    if (p.target === L.playerId) L.sim.events.emit('ui', { panel: 'ext', name: 'law', data: { mode: 'patrol' } });
    // no hearing for one who was warned, or an enemy at war: straight to the fight when he is armed and refuses nothing — the card says so
    if (p.attackOnSight) {
      this.say(p, this.haltLine(p), 5);
      this.attack(p, 'That is the end of talking.');
    }
  }

  private releaseSlow(p: Patrol): void {
    if (!p.slowed) return;
    p.slowed = false;
    if (!this.L.combat?.anyFight?.() && this.L.state.clock.actionTime && !this.L.social?.current()) this.L.sim.dispatch({ type: 'setActionTime', on: false });
  }

  private stepHalt(p: Patrol, me: Person, dt: number, body: { x: number; z: number } | null): void {
    const L = this.L;
    // walking off from the halt is flight; so is running at the men
    const lp = this.leaderPos(p);
    if (body && lp && p.physical) {
      const d = p.afar ? dist(p.afar.x, p.afar.z, body.x, body.z) : dist(lp.x, lp.z, body.x, body.z);
      if (d > (p.afar ? 14 : LAW.haltStray)) {
        p.strayT += dt;
        if (p.warned === 0 && p.strayT > 1.2) { p.warned = 1; this.say(p, 'Stop! Stand where you are!', 4); this.order(p); }
        else if (p.warned >= 1 && p.strayT > 3.4) { this.attack(p, 'Run, would you? Take him!'); return; }
      } else p.strayT = Math.max(0, p.strayT - dt * 2);
    }
    // patience: asked once more, then the fight
    const wait = p.impatient ? 22 : LAW.patience;
    if (p.t > wait) {
      if (!p.impatient) { p.impatient = true; p.t = 0; this.say(p, 'Well? Speak, or be taken!', 6); }
      else this.attack(p, 'Enough. Take him!');
    }
    void me;
  }

  private stepEscort(p: Patrol, me: Person, dt: number, body: { x: number; z: number } | null): void {
    const L = this.L;
    p.deadline = Math.max(0, p.deadline - dt);
    // off the land at last?
    const t = L.territory;
    if (t && body) {
      const here = this.effective(me, body.x, body.z);
      if (here.level === 'none') { this.left(p, me); return; }
      if (p.t > 1 && Math.floor(p.t) !== Math.floor(p.t - dt)) p.exit = t.exitFrom?.(me.id, body.x, body.z) ?? p.exit;
    } else if (!t && p.t > 6) { this.left(p, me); return; }
    if (p.deadline <= 0) { this.attack(p, 'Your time is up. Take him!'); return; }
    // the men keep close behind; the orders hold, reissued now and then
    if (p.physical && Math.floor(p.t / 3) !== Math.floor((p.t - dt) / 3)) this.order(p);
    if (p.deadline < 12 && Math.floor(p.deadline) !== Math.floor(p.deadline + dt) && p.deadline > 0 && p.warned < 2) {
      p.warned = 2; this.say(p, 'Quickly now, or we help you along!', 4);
    }
  }

  /** The territory's answer, with the lord's wanted list: an escaped prisoner is hostile ground wherever his lands run. */
  effective(me: Person, x: number, z: number): { level: TrespassLevel; cause?: TrespassCause; reason: string; lord?: PersonId; settlement: number } {
    const L = this.L;
    const t = L.territory;
    if (!t) return { level: 'none', reason: '', settlement: -1 };
    const c = t.trespass(me.id, x, z);
    if (c.level !== 'none') return { level: c.level, cause: c.cause, reason: c.reason, lord: c.lord, settlement: c.land.settlement };
    const s = c.land.settlement;
    if (s >= 0 && L.store.wantedOn(me.id, s, L.day)) {
      return { level: 'hostile', cause: 'outlaw', reason: `the lands of ${L.titled(L.lordOf(s))}, where you are wanted`, lord: L.lordOf(s), settlement: s };
    }
    return { level: 'none', reason: '', settlement: s };
  }

  private left(p: Patrol, me: Person): void {
    const L = this.L;
    L.sim.events.emit('trespass', { phase: 'left', person: me.id, house: p.house, settlement: p.settlement, level: p.level === 'hostile' ? 'hostile' : 'private' });
    L.store.data.stats.left++;
    this.escorted.set(me.id, { settlement: p.settlement, until: L.day + LAW.comeBack / DAY_SECONDS });
    if (me.id === L.playerId) L.notify('info', 'You are off the lord\'s land. The riders turn back.');
    this.say(p, 'And stay off.', 4);
    this.goAway(p);
  }

  private goAway(p: Patrol): void {
    this.releaseSlow(p);
    p.deadline = Infinity;
    this.setPhase(p, 'gone');
    p.goneT = 0;
    this.order(p);
    if (!p.physical) this.finish(p);
  }

  /** Ends the patrol: the men go back to their lives. */
  finish(p: Patrol): void {
    const L = this.L;
    this.releaseSlow(p);
    this.patrols.delete(p.target);
    for (const id of [p.leader, ...p.men]) {
      this.busy.delete(id);
      L.zone?.dismiss?.(id);
    }
    L.store.bump();
  }

  // ---------------------------------------------------------------------------------------------
  // the fight
  // ---------------------------------------------------------------------------------------------

  /** Orders the fight: the men strike to wound (and kill at war); the combat module settles it and tells `fought`. */
  attack(p: Patrol, shout?: string): void {
    const L = this.L;
    if (p.phase === 'attack') return;
    this.releaseSlow(p);
    if (shout) this.say(p, shout, 4);
    this.setPhase(p, 'attack');
    L.store.data.stats.attacked++;
    L.sim.events.emit('trespass', { phase: 'attacked', person: p.target, house: p.house, settlement: p.settlement, level: p.level === 'hostile' ? 'hostile' : 'private' });
    const c = L.combat;
    const me = this.target(p);
    const body = L.player?.body() ?? null;
    if (!c || !me) { this.settleWithoutFight(p); return; }
    const at = body ? { x: body.x, z: body.z } : undefined;
    // a man who is a soldier of the enemy, at war, may be killed; everyone else is to be taken alive
    const kill = p.level === 'hostile' && p.skipTalk && (armedWith(L, me) || L.armed(me)) && p.cause !== 'outlaw';
    const id = c.engage(
      [{ faction: 'player', people: [me.id] }, { faction: FACTION, people: [p.leader, ...p.men], mounted: [...p.mounted] }],
      { at, yieldAllowed: true, reason: 'patrol', intent: kill ? 'kill' : 'subdue' },
    );
    p.fight = id;
    if (id === 0) this.settleWithoutFight(p);
  }

  /** No fight could be made (no combat module, nobody to fight): the men simply take him, as they would a man who gives up. */
  private settleWithoutFight(p: Patrol): void {
    if (p.target === this.L.playerId && this.L.combat) {
      // the fight could not start (the men are busy): try the talk again
      this.setPhase(p, 'halt');
      this.say(p, 'Yield, or we take you!', 5);
      return;
    }
    this.take(p, 'caught at last');
  }

  /** The combat module reports a fight over: the patrol's, if it is ours. */
  fought(r: FightResult): void {
    const L = this.L;
    for (const p of [...this.patrols.values()]) {
      if (p.fight === 0 || p.fight !== r.id) continue;
      p.fight = 0;
      const me = this.target(p);
      const ours = new Set([p.leader, ...p.men]);
      const lost = r.dead.filter((id) => ours.has(id)).length;
      p.bloodshed = lost > 0;
      if (!me) { this.finish(p); continue; }
      const taken = r.captured.some((c) => c.captive === me.id);
      const beaten = r.winner === FACTION && !r.dead.includes(me.id);
      if (taken || beaten) { this.take(p, p.bloodshed ? 'raising his hand against the lord\'s men' : this.causeText(p)); continue; }
      if (r.dead.includes(me.id)) { this.finish(p); continue; }
      // the patrol lost, or the fight broke up with the trespasser away: he is wanted on these lands
      if (lost > 0) {
        if (!hasFlag(me, 'outlaw')) { me.flags.outlaw = true; L.state.touch(me); }
        if (me.id === L.playerId) L.notify('danger', 'You have killed the lord\'s men. You are named an outlaw.');
        L.log('crime', `${L.name(me.id)} killed men of ${L.houseName(p.house)} and is named an outlaw.`, [me.id]);
      }
      L.store.makeWanted(me.id, p.settlement, L.day + LAW.wantedDays);
      if (p.target === L.playerId) L.notify('warn', 'The lord\'s men will take you at sight on these lands.');
      this.finish(p);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // taking him
  // ---------------------------------------------------------------------------------------------

  causeText(p: Patrol): string {
    const r = p.reason.replace(/^the /, '');
    if (p.kind === 'war') return `being found on the lands of ${this.L.houseName(p.house)}`;
    if (p.kind === 'crime') return p.attackOnSight ? 'breaking the lord\'s peace again' : 'defying the lord\'s men';
    if (p.poaching) return `poaching in the lord's ${/park/.test(p.reason) ? 'park' : 'closes'}`;
    return `trespass in the ${r}`;
  }

  /** The target is taken: bound, and led to the lock-up (the walk, or the march when it is far). */
  take(p: Patrol, cause: string): void {
    const L = this.L;
    const me = this.target(p);
    if (!me) { this.finish(p); return; }
    this.releaseSlow(p);
    const rec = seizePerson(L, me, p.leader, p.kind, p.settlement, cause, { led: p.physical && me.id === L.playerId, bloodshed: p.bloodshed, level: p.level === 'hostile' ? 'hostile' : 'private' });
    if (!rec) { this.finish(p); return; }
    // a wounded prisoner is bound up by his captors (the combat module's care)
    L.combat?.tend?.(p.leader, me.id);
    if (!rec.led) {
      this.finish(p);
      if (me.id === L.playerId) { restrainPlayer(L, rec); L.sim.events.emit('ui', { panel: 'ext', name: 'law', data: { mode: 'captive' } }); }
      return;
    }
    this.setPhase(p, 'taking');
    this.say(p, 'Bind his hands. Into the gaol with him.', 5);
    restrainPlayer(L, rec);
    // where he is led: the door of the cell
    const place = L.holdingPlace(rec.settlement, rec.house);
    const door = place.building ? L.doorOf(place.building.id) : null;
    const s = L.world.settlements.find((q) => q.id === place.settlement);
    p.cell = { x: door?.x ?? (s?.x ?? 0) + 5, z: door?.z ?? (s?.z ?? 0) + 5, yaw: door?.yaw ?? 0 };
    const body = L.player?.body();
    p.marching = !!body && dist(body.x, body.z, p.cell.x, p.cell.z) > LAW.marchDistance;
    this.order(p);
    if (p.marching) this.march(p, rec);
  }

  /** Too far to walk in the open: the walk begins in sight, the rest is the clock (hours pass) and the prisoner is put in the cell. */
  private march(p: Patrol, rec: CaptiveRec): void {
    const L = this.L;
    const body = L.player?.body();
    if (!body || !p.cell) return;
    const metres = dist(body.x, body.z, p.cell.x, p.cell.z) * 1.15;
    const hours = clamp(metres / 1.25 / DAY_SECONDS * 24, 0.5, 14); // the walk takes real seconds; they are this many game hours
    const where = L.holdingPlace(rec.settlement, rec.house).text;
    this.say(p, `It is a long road to ${L.placeName(rec.settlement)}. Move!`, 5);
    L.notify('warn', `You are marched to ${where}: about ${Math.max(1, Math.round(hours))} ${Math.round(hours) <= 1 ? 'hour' : 'hours'} on the road.`);
    p.marching = true;
    const until = L.sim.absDay + hours / 24;
    const off = L.sim.events.on('skip', (e) => {
      if (e.phase === 'start') return;
      off();
      this.arrived(p, rec);
    });
    const r = L.sim.dispatch({ type: 'waitUntil', until });
    if (!r.ok) { off(); this.arrived(p, rec); }
  }

  private arrived(p: Patrol, rec: CaptiveRec): void {
    const L = this.L;
    p.marching = false;
    deliver(L, rec);
    if (p.cell) L.player?.placeAt?.(p.cell.x, p.cell.z, p.cell.yaw + Math.PI);
    this.finish(p);
  }

  /** The fight is the combat module's; its result arrives in `fought`. A fight that never reports (lost with the module) is given up. */
  private stepAttack(p: Patrol, me: Person): void {
    void me;
    if (p.t > 900) { this.finish(p); return; }
    // the module is gone or the fight never began: the men take him as they would one who gives up
    if (p.fight === 0 && p.t > 2) this.take(p, this.causeText(p));
  }

  private stepTaking(p: Patrol, me: Person, dt: number, body: { x: number; z: number } | null): void {
    const L = this.L;
    const rec = L.store.captiveOf(me.id);
    if (!rec) { this.finish(p); return; }
    if (p.marching) return;
    if (!rec.led || !p.physical || !body || !p.cell) { deliver(L, rec); this.finish(p); return; }
    const lp = this.leaderPos(p);
    if (!lp) { deliver(L, rec); this.finish(p); return; }
    const gap = dist(lp.x, lp.z, body.x, body.z);
    const toDoor = dist(lp.x, lp.z, p.cell.x, p.cell.z);
    // the leader waits when the prisoner lags, walks on when he has caught up
    if (Math.floor(p.t * 2) !== Math.floor((p.t - dt) * 2)) {
      if (toDoor < 2.6) {
        if (gap < LAW.ledGap + 1) { deliver(L, rec); this.finish(p); return; }
        L.zone?.command(p.leader, { kind: 'face', target: p.target });
      } else if (gap > LAW.ledGap) {
        L.zone?.command(p.leader, { kind: 'face', target: p.target });
      } else {
        L.zone?.command(p.leader, { kind: 'goto', x: p.cell.x, z: p.cell.z, run: false, gait: 'walk' });
      }
    }
    if (p.t > 420) { deliver(L, rec); this.finish(p); }
  }

  // ---------------------------------------------------------------------------------------------
  // the choices
  // ---------------------------------------------------------------------------------------------

  /** Chance of the talk working, with the reasons in words. */
  businessChance(p: Patrol, me: Person): { chance: number; reason: string } {
    const L = this.L;
    const lead = L.person(p.leader);
    let c = 0.34;
    const why: string[] = [];
    // a reason to be here: work for the lord's people, a request, a post, the market
    const open = (L.sim.services.happenings as unknown as { openRequests?: () => ReadonlyArray<{ from: PersonId }> } | undefined)?.openRequests?.() ?? [];
    const asked = open.some((r) => L.person(r.from)?.settlement === p.settlement);
    const employed = L.economy?.employment(me.id);
    const emp = employed?.building !== undefined ? L.state.buildings.get(employed.building)?.settlement === p.settlement : false;
    if (asked || emp) { c += 0.3; why.push(asked ? 'a request here' : 'work here'); }
    const st = L.world.settlements.find((s) => s.id === p.settlement);
    if (st?.market && isMarketDay(L.day, p.settlement) && !isNight(L.day)) { c += 0.2; why.push('the market'); }
    if (lead) {
      const dr = me.rankTier - lead.rankTier;
      c += clamp(dr * 0.11, -0.25, 0.42);
      if (dr > 0) why.push('your rank');
    }
    c += (me.trained.cha - 10) * 0.025 + skillOf(me, 'persuasion') * 0.012;
    if (p.level === 'hostile') c -= 0.25;
    if (p.poaching) c -= 0.3;
    const offences = L.store.offencesOf(me.id, p.settlement, L.day);
    c -= 0.15 * Math.min(3, offences);
    if (lead?.traits.includes('honest')) c -= 0.04;
    if (me.rep.honour > 30) c += 0.06;
    c = clamp(c, 0.05, 0.92);
    return { chance: c, reason: why.join(', ') };
  }

  private bribeCost(p: Patrol, me: Person): number {
    const lead = this.L.person(p.leader);
    const tier = lead ? lead.rankTier : 2;
    return Math.max(LAW.bribeMin, Math.round(LAW.bribePerTier * tier * (p.level === 'hostile' ? 1.8 : 1) * (1 + 0.2 * Math.max(0, me.rankTier - 2))));
  }

  private bribeChance(p: Patrol, me: Person): number {
    const lead = this.L.person(p.leader);
    let c = 0.58 + 0.03 * (me.trained.cha - 10);
    if (lead?.traits.includes('honest')) c -= 0.38;
    if (lead?.traits.includes('greedy')) c += 0.22;
    if (p.level === 'hostile') c -= 0.18;
    if (p.poaching) c -= 0.12;
    return clamp(c, 0.04, 0.9);
  }

  fineAmount(p: Patrol, me: Person): number {
    const L = this.L;
    const base = p.cause === 'castle' ? LAW.fineBase.castle : p.cause === 'park' ? LAW.fineBase.park : LAW.fineBase.demesne;
    const off = L.store.offencesOf(me.id, p.settlement, L.day);
    return Math.max(2, Math.round(base * (p.poaching ? LAW.poachFactor : 1) * (1 + 0.25 * Math.max(0, me.rankTier - 2)) * (1 + 0.4 * off)));
  }

  choices(person: PersonId): LawChoice[] {
    const L = this.L;
    const p = this.patrols.get(person);
    const me = L.alive(person);
    if (!p || !me) return [];
    if (p.phase !== 'halt') return [];
    const out: LawChoice[] = [];
    const exitD = this.exitDistance(p, me);
    const secs = this.escortSeconds(exitD);
    if (!p.skipTalk) {
      out.push({
        id: 'leave', label: 'Leave', detail: exitD > 0 ? `They see you off the land: about ${Math.round(exitD)} m, ${Math.round(secs)} s` : `You have about ${Math.round(secs)} s to be off the land`,
        ok: true,
      });
      const bc = this.businessChance(p, me);
      out.push({
        id: 'business', label: 'State your business',
        detail: `${chanceWord(bc.chance)} (about ${Math.round(bc.chance * 100)}%)${bc.reason ? ` — ${bc.reason}` : ''}`,
        ok: !p.triedBusiness, reason: p.triedBusiness ? 'They have heard your tale' : undefined,
      });
      const cost = this.bribeCost(p, me);
      const rich = me.money + 1e-6 >= cost;
      out.push({
        id: 'bribe', label: 'Offer a bribe', detail: `${formatMoney(cost)} to look the other way — ${chanceWord(this.bribeChance(p, me))}`,
        ok: !p.triedBribe && rich, reason: p.triedBribe ? 'They have had their say on that' : rich ? undefined : `You carry only ${formatMoney(Math.floor(me.money))}`,
      });
      if (p.level === 'private') {
        const fine = this.fineAmount(p, me);
        const can = me.money + 1e-6 >= fine;
        out.push({
          id: 'fine', label: 'Pay the fine', detail: p.poaching ? `${formatMoney(fine)} — the game is taken` : `${formatMoney(fine)} and be gone`,
          ok: can, reason: can ? undefined : `You carry only ${formatMoney(Math.floor(me.money))}`,
        });
      }
    }
    out.push({ id: 'yield', label: 'Yield', detail: 'Give yourself up: you are bound and taken to the gaol', ok: true });
    out.push({ id: 'refuse', label: 'Refuse', detail: 'Stand your ground — the lord\'s men will use force', ok: true });
    return out;
  }

  private exitDistance(p: Patrol, me: Person): number {
    const body = this.L.player?.body();
    if (!body) return 0;
    const e = this.L.territory?.exitFrom?.(me.id, body.x, body.z) ?? p.exit;
    if (!e) return 0;
    p.exit = e;
    return dist(body.x, body.z, e.x, e.z);
  }

  private escortSeconds(distance: number): number {
    return clamp(distance / LAW.escortPace + LAW.escortBase, LAW.escortMin, LAW.escortMax);
  }

  answer(person: PersonId, choice: string): Result {
    const L = this.L;
    const p = this.patrols.get(person);
    const me = L.alive(person);
    if (!p || !me) return { ok: false, reason: 'No patrol' };
    if (p.phase !== 'halt') return { ok: false, reason: 'They are not waiting for an answer' };
    const opt = this.choices(person).find((c) => c.id === choice);
    if (!opt) return { ok: false, reason: 'That is not offered' };
    if (!opt.ok) return { ok: false, reason: opt.reason ?? 'Not now' };
    switch (choice) {
      case 'leave': return this.leave(p, me);
      case 'business': return this.business(p, me);
      case 'bribe': return this.bribe(p, me);
      case 'fine': return this.fine(p, me);
      case 'yield': this.take(p, this.causeText(p)); return { ok: true, message: 'You give yourself up.' };
      case 'refuse': this.attack(p, 'Then we will take you by force!'); return { ok: true, message: 'You will not go.' };
      default: return { ok: false, reason: 'That is not offered' };
    }
  }

  private leave(p: Patrol, me: Person): Result {
    const L = this.L;
    const d = this.exitDistance(p, me);
    p.deadline = this.escortSeconds(d);
    this.releaseSlow(p);
    this.setPhase(p, 'escort');
    p.warned = 0;
    L.store.data.stats.escorted++;
    L.store.noteOffence(me.id, p.settlement, L.day);
    L.sim.events.emit('trespass', { phase: 'escorted', person: me.id, house: p.house, settlement: p.settlement, level: p.level === 'hostile' ? 'hostile' : 'private' });
    this.say(p, 'Then off with you, and quickly. We will see you to the boundary.', 6);
    this.order(p);
    if (!p.physical) p.t = 0;
    return { ok: true, message: `You have about ${Math.round(p.deadline)} seconds to be off the land.` };
  }

  private business(p: Patrol, me: Person): Result {
    const L = this.L;
    p.triedBusiness = true;
    const { chance, reason } = this.businessChance(p, me);
    if (L.rng().next() < chance) {
      const days = reason.includes('request') || reason.includes('work') ? LAW.leaveDays.request : reason.includes('market') ? LAW.leaveDays.market : reason.includes('rank') ? LAW.leaveDays.rank : LAW.leaveDays.charm;
      L.territory?.grantLeave?.(me.id, p.settlement, days);
      this.releaseSlow(p);
      this.say(p, 'Very well. Keep to the paths, and mind you do no harm.', 5);
      L.sim.events.emit('trespass', { phase: 'warned', person: me.id, house: p.house, settlement: p.settlement, level: p.level === 'hostile' ? 'hostile' : 'private' });
      this.goAway(p);
      return { ok: true, message: 'They accept your business and let you pass.' };
    }
    this.say(p, 'A thin tale. Be gone, or be taken.', 5);
    p.t = 0;
    return { ok: false, reason: 'They do not believe you', message: 'They do not believe you.' };
  }

  private bribe(p: Patrol, me: Person): Result {
    const L = this.L;
    p.triedBribe = true;
    const cost = this.bribeCost(p, me);
    me.money = Math.round((me.money - cost) * 100) / 100;
    L.state.touch(me);
    const lead = L.person(p.leader);
    if (lead) { lead.money = Math.round((lead.money + cost) * 100) / 100; L.state.touch(lead); }
    if (L.rng().next() < this.bribeChance(p, me)) {
      L.territory?.grantLeave?.(me.id, p.settlement, LAW.leaveDays.bribe);
      this.releaseSlow(p);
      this.say(p, 'I saw nothing. Go.', 4);
      this.goAway(p);
      return { ok: true, message: 'The coin disappears and so do they.' };
    }
    this.say(p, 'Bribing the lord\'s men! Take him!', 4);
    this.attack(p);
    return { ok: false, reason: 'They take your coin and your bribe is refused', message: 'They take your coin — and then your freedom.' };
  }

  private fine(p: Patrol, me: Person): Result {
    const L = this.L;
    const amount = this.fineAmount(p, me);
    me.money = Math.round((me.money - amount) * 100) / 100;
    L.state.touch(me);
    const lord = L.person(p.lord);
    const hh = lord ? L.state.households.get(lord.household) : undefined;
    if (hh) { hh.purse = Math.round((hh.purse + amount) * 100) / 100; L.state.touchHousehold(hh); }
    L.store.data.stats.fines++;
    L.store.noteOffence(me.id, p.settlement, L.day);
    let taken = 0;
    if (p.poaching) taken = this.takeGame(me, p.leader);
    L.territory?.grantLeave?.(me.id, p.settlement, LAW.leaveDays.fine);
    this.releaseSlow(p);
    this.say(p, p.poaching ? 'The game is the lord\'s. Now get out of his park.' : 'Paid. Now be gone.', 5);
    this.goAway(p);
    return { ok: true, message: `You pay ${formatMoney(amount)}${taken > 0 ? ' and they take the game' : ''}.` };
  }

  /** The hunt's takings go to the lord's man. Returns the number of items. */
  private takeGame(me: Person, to: PersonId): number {
    const L = this.L;
    const eco = L.economy;
    if (!eco) return 0;
    let n = 0;
    for (const [key, qty] of Object.entries(me.inventory)) {
      if (qty <= 0 || !GAME.test(parseItemKey(key).good)) continue;
      const r = eco.give(me.id, to, key, qty);
      if (r.ok) n += qty;
    }
    return n;
  }

  // ---------------------------------------------------------------------------------------------
  // the player gone or changed
  // ---------------------------------------------------------------------------------------------

  /** The player's body changed hands or died: any patrol after them is over. */
  dropFor(person: PersonId): void {
    const p = this.patrols.get(person);
    if (!p) return;
    this.finish(p);
  }

  clear(): void {
    for (const p of [...this.patrols.values()]) this.finish(p);
  }
}

// ---------------------------------------------------------------------------------------------
// small helpers shared with the watcher
// ---------------------------------------------------------------------------------------------

function chanceWord(c: number): string {
  return c >= 0.8 ? 'a sure thing' : c >= 0.6 ? 'a good chance' : c >= 0.4 ? 'a fair chance' : c >= 0.2 ? 'a poor chance' : 'hopeless';
}

/** Is the person armed (a weapon in the hand slot)? */
export function armedWith(L: Law, p: Person): boolean {
  const eco = L.economy;
  if (!eco) return false;
  try {
    const main = eco.inventory(p.id).equipment.main;
    if (!main) return false;
    return eco.good(parseItemKey(main).good)?.category === 'weapon';
  } catch { return false; }
}

/** Game in the pack, or a bow in the lord's park: the evidence of a poacher. */
export function poachingEvidence(L: Law, p: Person, cause: TrespassCause | undefined): boolean {
  if (cause !== 'park') return false;
  for (const key of Object.keys(p.inventory)) {
    if ((p.inventory[key] ?? 0) > 0 && GAME.test(parseItemKey(key).good)) return true;
  }
  const eco = L.economy;
  if (!eco) return false;
  try {
    const main = eco.inventory(p.id).equipment.main;
    return !!main && BOWS.has(parseItemKey(main).good);
  } catch { return false; }
}

void adjustOpinion;
