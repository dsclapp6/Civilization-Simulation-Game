// The watch over the player (docs/CIV.md §4): about twice a second the territory is asked whether the player may be where they
// stand. If not, people of the owning lands who can see them report it — a villager runs to the manor, an armed man deals with it
// himself, and on hostile land the watch reacts at once to armed men and known enemies — and a patrol comes (patrol.ts).
import { dist } from '../../core/math';
import { isNight } from '../../core/time';
import type { Person, PersonId } from '../state';
import type { TrespassCause, TrespassLevel } from '../territory/types';
import { LAW } from './config';
import type { Law } from './context';
import { PatrolSystem, armedWith } from './patrol';

/** The offence in progress: since when, whether anyone has seen it, and when the patrol is due. */
interface Case {
  settlement: number;
  level: TrespassLevel;
  cause: TrespassCause | undefined;
  reason: string;
  lord: PersonId;
  /** Sim seconds since the offence began, when it was seen (-1 not yet), when the patrol is due. */
  since: number;
  seenAt: number;
  dueAt: number;
  witness: PersonId;
  armedWitness: boolean;
  /** Seconds since the person was last on the land (the case closes when they have been off it a while). */
  quiet: number;
  attackOnSight: boolean;
  tries: number;
}

export class Watch {
  private t = 0;
  private clockS = 0;
  private cas: Case | null = null;

  constructor(private readonly L: Law, private readonly patrol: PatrolSystem) {}

  /** The case in progress (for tests and the HUD). */
  current(): Readonly<Case> | null { return this.cas; }

  reset(): void { this.cas = null; this.t = 0; }

  /** Can the watch look at the player now? A body in the street, alive, free, not asleep or on the map. */
  private active(): boolean {
    const L = this.L;
    const sim = L.sim;
    if (sim.state.run.phase !== 'alive' || !L.player?.body() || !L.territory) return false;
    if (sim.view.mode() !== 'street' || sim.clock.skip) return false;
    const me = L.person(L.playerId);
    return !!me && !me.death && !me.flags.captive;
  }

  step(dt: number): void {
    this.clockS += dt;
    this.t += dt;
    if (this.t < LAW.watchPeriod) return;
    const span = this.t;
    this.t = 0;
    const L = this.L;
    if (!this.active()) { this.cas = null; return; }
    const me = L.person(L.playerId)!;
    const body = L.player!.body()!;
    const check = this.patrol.effective(me, body.x, body.z);
    // a patrol dealing with them already: nothing to decide here; the case is kept so a second one does not start
    if (check.level === 'none') {
      if (this.cas) { this.cas.quiet += span; if (this.cas.quiet > 6) this.cas = null; }
      return;
    }
    let c = this.cas;
    if (!c || c.settlement !== check.settlement || c.level !== check.level) c = this.cas = this.newCase(me, check, false);
    c.quiet = 0;
    c.reason = check.reason; c.cause = check.cause;
    if (this.patrol.get(me.id)) return;
    if (c.seenAt < 0) {
      const w = this.witnesses(me, check.settlement, body.x, body.z, c.level === 'hostile');
      if (!w) return;
      c.seenAt = this.clockS;
      c.witness = w.person.id;
      c.armedWitness = w.armed;
      // an armed man acts himself (at once on hostile land and against a known offender); anyone else must carry the word to the manor
      const quick = w.armed || c.attackOnSight;
      const [lo, hi] = quick ? (c.level === 'hostile' || c.attackOnSight ? LAW.hostileDelay : LAW.armedDelay) : LAW.reportDelay;
      const wait = quick ? lo + (hi - lo) * 0.3 : lo + (hi - lo) * L.rng().next();
      c.dueAt = this.clockS + wait;
      L.sim.events.emit('trespass', { phase: 'seen', person: me.id, house: L.houseOf(check.settlement), settlement: check.settlement, level: c.level === 'hostile' ? 'hostile' : 'private' });
      L.store.data.stats.seen++;
      return;
    }
    if (this.clockS < c.dueAt) return;
    this.dispatch(me, c, body.x, body.z);
  }

  private dispatch(me: Person, c: Case, x: number, z: number): void {
    const L = this.L;
    c.tries++;
    const p = this.patrol.start(me, { level: c.level, cause: c.cause, reason: c.reason, lord: c.lord }, c.settlement, {
      attackOnSight: c.attackOnSight, near: c.armedWitness ? c.witness : undefined, x, z,
    });
    if (!p) { c.dueAt = this.clockS + 40; return; }
    c.dueAt = Infinity;
    // the pace of the world is theirs now: no hurrying while the lord's men ride
    if (L.sim.clock.speed > 1) L.sim.dispatch({ type: 'setSpeed', speed: 1 });
    L.notify('warn', c.level === 'hostile' ? 'Armed men are riding at you across the hostile land.' : 'Riders come: the lord\'s men are after you.');
  }

  /**
   * Someone of the owning lands who can see the player: the nearest, by day within 80 m (26 at night, 48 beside a torch; less in rain
   * and fog), behind no building or wall. An armed man near acts at once (`armed`). Null when nobody sees.
   */
  witnesses(me: Person, settlement: number, x: number, z: number, hostile: boolean): { person: Person; armed: boolean } | null {
    const L = this.L;
    const zone = L.zone;
    if (!zone) return null;
    const w = L.sim.view.weather();
    const murk = Math.max(0.45, 1 - 0.3 * w.rain - 0.4 * w.fog);
    const night = isNight(L.day);
    const land = L.territory!.landAt(x, z);
    const house = land.house;
    const cands: Array<{ p: Person; d: number; armed: boolean; sees: number }> = [];
    for (const a of zone.agents()) {
      if (a.personId === me.id || !a.visible) continue;
      const p = L.person(a.personId);
      if (!p || p.death || p.flags.captive) continue;
      const mine = p.settlement === settlement || (house !== 0 && p.house === house);
      if (!mine && !(hostile && house !== 0 && p.house === house)) continue;
      const age = L.age(p);
      if (age < 11) continue;
      const d = dist(a.x, a.z, x, z);
      const sees = (night ? (a.draw.mainHand === 'torch' ? LAW.sightTorch : LAW.sightNight) : LAW.sightDay) * murk;
      if (d > sees) continue;
      cands.push({ p, d, armed: L.armed(p) && age < 60 && d <= LAW.armedNear * murk, sees });
    }
    if (cands.length === 0) return null;
    cands.sort((a, b) => Number(b.armed) - Number(a.armed) || a.d - b.d || a.p.id - b.p.id);
    const nav = zone.nav as typeof zone.nav & { lineClear?(x0: number, z0: number, x1: number, z1: number): boolean };
    for (const c of cands.slice(0, 10)) {
      const a = zone.agent(c.p.id);
      if (!a) continue;
      if (nav.lineClear && c.d > 6 && !nav.lineClear(a.x, a.z, x, z)) continue;
      return { person: c.p, armed: c.armed };
    }
    return null;
  }

  /** A new case for an offence: a man escorted off these lands lately, or wanted on them, is not heard again. */
  private newCase(me: Person, check: { settlement: number; level: TrespassLevel; cause?: TrespassCause; reason: string; lord?: PersonId }, seen: boolean): Case {
    const L = this.L;
    const back = this.patrol.escorted.get(me.id);
    return {
      settlement: check.settlement, level: check.level, cause: check.cause, reason: check.reason, lord: check.lord ?? 0, since: this.clockS,
      seenAt: seen ? this.clockS : -1, dueAt: seen ? this.clockS : Infinity, witness: 0, armedWitness: false, quiet: 0,
      attackOnSight: (!!back && back.settlement === check.settlement && back.until > L.day) || L.store.wantedOn(me.id, check.settlement, L.day),
      tries: 0,
    };
  }

  /** Reports the person as seen at once (tests, tools): starts the patrol without waiting for the report. False when nothing comes of it. */
  /** A door forced (interiors): witnessed by the household inside or someone of the place, the patrol comes for a crime. */
  breakIn(me: Person, settlement: number, x: number, z: number, occupied: boolean): boolean {
    if (this.patrol.get(me.id)) return true;
    const w = this.witnesses(me, settlement, x, z, false);
    if (!w && !occupied) return false;
    const c = this.cas = this.newCase(me, { settlement, level: 'private', reason: 'breaking into a house of the place' }, true);
    c.attackOnSight = false;
    this.L.sim.events.emit('trespass', { phase: 'seen', person: me.id, house: this.L.houseOf(settlement), settlement, level: 'private' });
    this.dispatch(me, c, x, z);
    return true;
  }

  report(me: Person, x: number, z: number): boolean {
    if (this.patrol.get(me.id)) return false;
    const check = this.patrol.effective(me, x, z);
    if (check.level === 'none') return false;
    const c = this.cas = this.newCase(me, check, true);
    this.dispatch(me, c, x, z);
    return !!this.patrol.get(me.id);
  }
}

void armedWith;
