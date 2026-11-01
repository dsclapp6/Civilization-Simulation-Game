// The wound model, the same for everyone (SPEC §14): where a blow lands, what armour does to it, what is
// left of it, and how the wound then bleeds, mends, festers or cripples. Pure rolls (`rollLocation`,
// `absorb`, `shapeWound`) are separate from the book-keeping (`WoundBook`), which keeps each hurt person's
// wounds in `state.ext['combat']` and mirrors them onto `Person.health` (hp fraction, an 'injury'
// condition, the `lame` / `scarred` traits).
//
// Time: bleeding runs in simulated seconds (a day is 60 s). People in the detail zone are advanced every
// sub-step, everybody else by the hour (2.5 s of bleeding per hour), so a bad wound left alone kills in
// about a game day and a bound one is survivable. Healing runs in game days.
import type { Rng } from '../core/rng';
import { clamp } from '../core/math';
import type { SimContext } from '../sim/context';
import type { GameState, Person, PersonId } from '../sim/state';
import { fullName } from '../sim/state';
import type { DeathCause } from '../sim/state';
import { killPerson } from '../sim/succession';
import type { HitLocation, Wound, WoundKind } from '../sim/wave3';
import { ABSORB_QUALITY, type ArmourDef } from './weapons';
import type { Quality } from '../sim/economy/types';

export const EXT_KEY = 'combat';

export const LOCATIONS: readonly HitLocation[] = ['head', 'torso', 'arm_l', 'arm_r', 'leg_l', 'leg_r'];
export const LOCATION_NAMES: Record<HitLocation, string> = {
  head: 'head', torso: 'torso', arm_l: 'left arm', arm_r: 'right arm', leg_l: 'left leg', leg_r: 'right leg',
};

/** A wound as the book keeps it: the contract's `Wound` plus the running state. */
export interface WoundRec extends Wound {
  id: number;
  /** Blood lost per simulated second right now (fraction of the body's blood); fades as it clots. */
  rate: number;
  /** 0 untended · 1 bound · 2 skilfully tended. */
  care: number;
  /** An arrow head or splinter is still in. */
  lodged?: boolean;
  /** The blow that made it (for the story: 'sword', 'longbow'…). */
  by?: string;
  /** The worst the wound ever was: scars and lameness depend on how bad it got, not how it ended. */
  peak: number;
}

export interface HurtRec {
  /** Blood left, 1 = whole. Below `BLOOD_DEAD` the person dies, below `BLOOD_DOWN` they cannot stand. */
  blood: number;
  wounds: WoundRec[];
  /** Permanently disabled limbs (arms; legs make the person `lame`). */
  maimed?: HitLocation[];
  /** Simulated seconds of unconsciousness left (clubbed on the head). */
  stunned?: number;
  /** Seconds of life left from a mortal blow (the person is already down). */
  dying?: number;
  /** Seconds of bleeding already applied since the last hourly tick (so a person in the zone is not counted twice). */
  accounted?: number;
}

export interface CombatExt {
  v: 1;
  seq: number;
  hurt: Record<number, HurtRec>;
  /** Fighting people's outlaw marks and other small per-person facts the module keeps. */
  notes?: Record<number, { assaults?: number }>;
}

export const BLOOD_DEAD = 0.3;
export const BLOOD_DOWN = 0.5;
export const HOUR_SECONDS = 2.5;

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/** Where a blow lands on a standing man, by the way it is struck. Weights, not percentages. */
const LOCATION_WEIGHTS: Record<'slash' | 'overhead' | 'thrust' | 'arrow' | 'low', Record<HitLocation, number>> = {
  slash: { head: 11, torso: 36, arm_l: 11, arm_r: 11, leg_l: 15, leg_r: 16 },
  overhead: { head: 30, torso: 34, arm_l: 11, arm_r: 11, leg_l: 7, leg_r: 7 },
  thrust: { head: 8, torso: 56, arm_l: 8, arm_r: 8, leg_l: 10, leg_r: 10 },
  arrow: { head: 9, torso: 54, arm_l: 8, arm_r: 8, leg_l: 10.5, leg_r: 10.5 },
  low: { head: 3, torso: 20, arm_l: 4, arm_r: 4, leg_l: 34, leg_r: 35 },
};

/** How much a hit on this part hurts, after armour. */
const LOCATION_DAMAGE: Record<HitLocation, number> = { head: 1.7, torso: 1, arm_l: 0.6, arm_r: 0.6, leg_l: 0.7, leg_r: 0.7 };
const LOCATION_BLEED: Record<HitLocation, number> = { head: 1.1, torso: 1, arm_l: 0.7, arm_r: 0.7, leg_l: 0.9, leg_r: 0.9 };
const KIND_BLEED: Record<WoundKind, number> = { cut: 1, pierce: 0.65, arrow: 0.7, bite: 0.85, blunt: 0.08, burn: 0 };
const KIND_INFECT: Record<WoundKind, number> = { cut: 1, pierce: 1.25, arrow: 1.25, bite: 1.5, blunt: 0.1, burn: 1 };
/** Chance a blow of this kind to the part is a mortal one (lung, heart, brain, great vessel), per unit severity. */
const MORTAL: Record<WoundKind, Record<HitLocation, number>> = {
  pierce: { head: 0.45, torso: 0.28, arm_l: 0, arm_r: 0, leg_l: 0.03, leg_r: 0.03 },
  arrow: { head: 0.45, torso: 0.28, arm_l: 0, arm_r: 0, leg_l: 0.03, leg_r: 0.03 },
  cut: { head: 0.32, torso: 0.16, arm_l: 0, arm_r: 0, leg_l: 0.02, leg_r: 0.02 },
  blunt: { head: 0.25, torso: 0.07, arm_l: 0, arm_r: 0, leg_l: 0, leg_r: 0 },
  bite: { head: 0.3, torso: 0.15, arm_l: 0, arm_r: 0, leg_l: 0.02, leg_r: 0.02 },
  burn: { head: 0.1, torso: 0.1, arm_l: 0, arm_r: 0, leg_l: 0, leg_r: 0 },
};
const BLEED_BASE = 0.0105;
/** Clotting time constant (s) of an untended wound; shorter for light ones. */
const CLOT_TAU = 95;

// ---------------------------------------------------------------------------------------------
// Pure rolls
// ---------------------------------------------------------------------------------------------

export interface LocationOpts {
  /** How the blow comes in. Archery uses 'arrow'. */
  how: 'slash' | 'overhead' | 'thrust' | 'arrow' | 'low';
  /** Attacker's eye height minus the target's (m): a lunge from above favours the head, from a horse the same. */
  heightDiff?: number;
  /** The target is down or crouching: the head and torso are exposed, the legs less. */
  prone?: boolean;
  /** The target is blocking with a shield: the torso is covered, hits go to the limbs. */
  shielded?: boolean;
  /** Aimed shots (the player's) shift weight to a part. */
  aim?: HitLocation;
}

export function rollLocation(rng: Rng, o: LocationOpts): HitLocation {
  const base = LOCATION_WEIGHTS[o.how];
  const w = LOCATIONS.map((l) => base[l]);
  const hd = o.heightDiff ?? 0;
  if (hd > 0.25) { w[0] *= 1.5; w[4] *= 0.7; w[5] *= 0.7; }
  else if (hd < -0.25) { w[0] *= 0.6; w[4] *= 1.4; w[5] *= 1.4; }
  if (o.prone) { w[0] *= 1.8; w[1] *= 1.3; w[4] *= 0.5; w[5] *= 0.5; }
  if (o.shielded) { w[1] *= 0.55; w[2] *= 1.5; w[3] *= 1.5; }
  if (o.aim) { const i = LOCATIONS.indexOf(o.aim); w[i] *= 2.4; }
  return rng.weighted(LOCATIONS, w);
}

export interface ArmourPiece { def: ArmourDef; quality: Quality }

export interface AbsorbResult {
  /** Hit points the armour soaked. */
  absorbed: number;
  /** The blow found a gap or a seam. */
  gap: boolean;
  /** What reaches the flesh, before the part's vulnerability. */
  through: number;
}

/** What the worn pieces do to a blow of `raw` points of `kind` at `where`. Layers add up; `ap` skips a share of each. */
export function absorb(rng: Rng, pieces: readonly ArmourPiece[], where: HitLocation, kind: WoundKind, raw: number, ap: number): AbsorbResult {
  let soaked = 0;
  let gap = false;
  for (const p of pieces) {
    const cover = p.def.cover[where] ?? 0;
    if (cover <= 0) continue;
    if (rng.next() > cover) continue; // this blow reaches the part where the piece is not
    let a = p.def.absorb[kind] * ABSORB_QUALITY[p.quality];
    if (rng.next() < p.def.gap) { a *= 0.25; gap = true; }
    soaked += a * (1 - clamp(ap, 0, 0.95));
  }
  let through = Math.max(0, raw - soaked);
  // a blow that is stopped still bruises: padding and plate do not stop the shock of a mace
  if (through <= 0 && kind === 'blunt') through = raw * 0.1;
  return { absorbed: Math.min(raw, soaked), gap, through };
}

export interface Shaped {
  location: HitLocation;
  kind: WoundKind;
  /** Hit points of damage (after armour and the part's vulnerability). */
  damage: number;
  severity: number;
  bleeding: boolean;
  rate: number;
  fracture: boolean;
  /** A mortal blow: the person is already as good as dead. */
  mortal: boolean;
  /** Knocked senseless (a blow to the head). */
  stun: number;
}

export function shapeWound(rng: Rng, where: HitLocation, kind: WoundKind, through: number, maxHp: number): Shaped {
  const damage = through * LOCATION_DAMAGE[where];
  const severity = clamp(damage / (maxHp * 0.9), 0, 1);
  let rate = 0;
  if (damage > 0.5) {
    rate = BLEED_BASE * severity * KIND_BLEED[kind] * LOCATION_BLEED[where];
    if (kind === 'blunt' && severity > 0.55) rate = BLEED_BASE * severity * 0.3;
    // a great vessel opened: the inner thigh, the neck, the armpit
    if ((kind === 'cut' || kind === 'pierce' || kind === 'arrow') && severity > 0.25 && rng.next() < 0.07) rate *= 2.4;
  }
  const limb = where !== 'head' && where !== 'torso';
  let fracture = false;
  if (kind === 'blunt') fracture = rng.next() < severity * (limb ? 1.1 : 0.7);
  else if (limb && severity > 0.5 && (kind === 'cut' || kind === 'arrow')) fracture = rng.next() < 0.35;
  const mortal = damage > 4 && rng.next() < MORTAL[kind][where] * (0.3 + severity * 1.6);
  let stun = 0;
  if (where === 'head' && kind === 'blunt' && damage > 5) stun = clamp(severity * 28 + rng.range(2, 8), 0, 40);
  return { location: where, kind, damage, severity, bleeding: rate > 0.0004, rate, fracture, mortal, stun };
}

// ---------------------------------------------------------------------------------------------
// The book
// ---------------------------------------------------------------------------------------------

export function maxHpOf(p: Person): number { return Math.round(40 + 4 * p.trained.end); }

export function causeOfKind(kind: WoundKind, battle: boolean): DeathCause {
  if (battle) return 'battle';
  return kind === 'burn' ? 'accident' : 'violence';
}

export interface HitOutcome {
  wound: WoundRec | null;
  /** Hit points taken, as a fraction of the person's maximum. */
  hpLost: number;
  dead: boolean;
  down: boolean;
  mortal: boolean;
  stun: number;
}

const NO_HIT: HitOutcome = { wound: null, hpLost: 0, dead: false, down: false, mortal: false, stun: 0 };

export class WoundBook {
  private readonly state: GameState;
  /** Called when the book kills somebody (fights react: the corpse falls, the winners cheer). */
  onDeath: ((p: Person, cause: DeathCause) => void) | null = null;

  constructor(private readonly ctx: SimContext) {
    this.state = ctx.state;
  }

  ext(): CombatExt {
    let e = this.state.ext[EXT_KEY] as CombatExt | undefined;
    if (!e || e.v !== 1) {
      e = { v: 1, seq: 1, hurt: {} };
      this.state.ext[EXT_KEY] = e;
    }
    return e;
  }

  rec(id: PersonId): HurtRec | undefined { return this.ext().hurt[id]; }

  private recFor(id: PersonId): HurtRec {
    const e = this.ext();
    let r = e.hurt[id];
    if (!r) { r = { blood: 1, wounds: [] }; e.hurt[id] = r; }
    return r;
  }

  touch(): void { this.state.touchExt(EXT_KEY); }

  wounds(id: PersonId): readonly WoundRec[] { return this.ext().hurt[id]?.wounds ?? EMPTY; }

  isHurt(id: PersonId): boolean { return this.ext().hurt[id] !== undefined; }

  count(): number { return Object.keys(this.ext().hurt).length; }

  /** Can this person stand and fight? */
  down(id: PersonId): boolean {
    const r = this.ext().hurt[id];
    const p = this.state.persons.get(id);
    if (!r || !p) return false;
    return this.isDown(p, r);
  }

  private isDown(p: Person, r: HurtRec): boolean {
    if (r.dying !== undefined || (r.stunned ?? 0) > 0) return true;
    if (p.health.hp <= 0.18 || r.blood < BLOOD_DOWN) return true;
    for (const w of r.wounds) if ((w.location === 'leg_l' || w.location === 'leg_r') && (w.fracture || w.severity >= 0.55)) return true;
    return false;
  }

  /** Strength of the wounds' effect on a limb in 0..1 (an arm with a fracture hits weakly; a hurt leg slows). */
  limbPenalty(id: PersonId, where: 'arms' | 'legs'): number {
    const r = this.ext().hurt[id];
    if (!r) return 0;
    let pen = 0;
    for (const w of r.wounds) {
      const arm = w.location === 'arm_l' || w.location === 'arm_r';
      const leg = w.location === 'leg_l' || w.location === 'leg_r';
      if ((where === 'arms' && arm) || (where === 'legs' && leg)) pen = Math.max(pen, w.fracture ? 0.7 : w.severity * 0.8);
    }
    if (r.maimed) for (const m of r.maimed) if ((where === 'arms') === (m === 'arm_l' || m === 'arm_r')) pen = Math.max(pen, 0.5);
    return clamp(pen, 0, 0.9);
  }

  /**
   * How freely the person moves, 0.45..1: a hurt leg slows, so do serious wounds anywhere and low health
   * (a man at a tenth of his strength limps along; the same for the player and for everyone in a fight).
   */
  mobility(p: Person): number {
    let m = 1 - this.limbPenalty(p.id, 'legs') * 0.55;
    const hp = clamp(p.health.hp, 0, 1);
    if (hp < 0.6) m *= 0.6 + 0.4 * (hp / 0.6);
    const r = this.ext().hurt[p.id];
    if (r) for (const w of r.wounds) if (w.severity >= 0.6) { m *= 0.9; break; }
    return Math.max(0.45, m);
  }

  // ---- inflicting ----

  /** Records a shaped wound on a person. Returns what became of them. */
  inflict(p: Person, s: Shaped, by: string, cause: DeathCause = 'violence'): HitOutcome {
    if (p.death) return NO_HIT;
    const maxHp = maxHpOf(p);
    const hpLost = s.damage / maxHp;
    if (s.damage < 0.8 && !s.fracture) return { ...NO_HIT, hpLost: 0 };
    const rec = this.recFor(p.id);
    const e = this.ext();
    const wound: WoundRec = {
      id: e.seq++, location: s.location, kind: s.kind, severity: round3(s.severity), bleeding: s.bleeding, fracture: s.fracture,
      infected: false, since: this.ctx.absDay, rate: s.rate, care: 0, lodged: (s.kind === 'arrow' && s.severity > 0.2) || undefined, by, peak: round3(s.severity),
    };
    if (s.severity > 0.04 || s.fracture) rec.wounds.push(wound);
    if (rec.wounds.length > 14) rec.wounds.splice(0, rec.wounds.length - 14);
    p.health.hp = round3(Math.max(0, p.health.hp - hpLost));
    if (s.stun > 0) rec.stunned = Math.max(rec.stunned ?? 0, s.stun);
    this.syncCondition(p, rec);
    this.state.touch(p);
    this.touch();
    const dead = p.health.hp <= 0 || rec.blood <= BLOOD_DEAD;
    if (dead) { this.kill(p, cause); return { wound, hpLost, dead: true, down: true, mortal: s.mortal, stun: s.stun }; }
    if (s.mortal) {
      // the blow has found something vital: they go down and have seconds to live
      rec.dying = Math.min(rec.dying ?? 99, 4 + this.ctx.rng('combat').range(0, 26) * (1 - s.severity * 0.5));
    }
    return { wound, hpLost, dead: false, down: this.isDown(p, rec), mortal: s.mortal, stun: s.stun };
  }

  kill(p: Person, cause: DeathCause): void {
    if (p.death) return;
    delete this.ext().hurt[p.id];
    this.touch();
    killPerson(this.ctx, p, cause, this.ctx.absDay);
    this.onDeath?.(p, cause);
  }

  // ---- time: bleeding by the second, healing by the day ----

  /** Advances bleeding, clotting and blood recovery by `seconds` of simulated time. Returns false if the person died. */
  advance(p: Person, seconds: number, cause: DeathCause = 'violence'): boolean {
    const rec = this.ext().hurt[p.id];
    if (!rec || p.death) return !p.death;
    rec.accounted = (rec.accounted ?? 0) + seconds;
    let lost = 0;
    let open = 0;
    for (const w of rec.wounds) {
      if (w.rate <= 0) continue;
      const tau = (CLOT_TAU * (1.25 - 0.5 * w.severity)) / (w.care === 0 ? 1 : w.care === 1 ? 3.5 : 6);
      const carefactor = w.care === 0 ? 1 : w.care === 1 ? 0.18 : 0.06;
      const k = Math.exp(-seconds / tau);
      // integral of rate × e^(−t/τ) over the span
      lost += w.rate * carefactor * tau * (1 - k);
      w.rate *= k;
      if (w.rate < 0.0003) { w.rate = 0; w.bleeding = false; } else open++;
    }
    if (lost > 0) {
      rec.blood = round3(rec.blood - lost);
      p.health.hp = round3(Math.max(0, p.health.hp - lost * 0.55));
    } else if (rec.blood < 1 && open === 0) {
      // the body makes good the blood slowly (better fed, faster)
      rec.blood = round3(Math.min(1, rec.blood + seconds * 0.0026 * (0.4 + 0.6 * p.needs.hunger)));
    }
    if (rec.stunned !== undefined) { rec.stunned -= seconds; if (rec.stunned <= 0) delete rec.stunned; }
    if (rec.dying !== undefined) {
      rec.dying -= seconds;
      if (rec.dying <= 0) { this.kill(p, cause); return false; }
    }
    if (rec.blood <= BLOOD_DEAD || p.health.hp <= 0) { this.kill(p, cause); return false; }
    this.state.touch(p);
    this.touch();
    return true;
  }

  /** The hourly tick for everyone hurt: bleeding for those not in the detail zone, then clean up. */
  hour(inZone: (id: PersonId) => boolean): void {
    const e = this.ext();
    for (const key of Object.keys(e.hurt)) {
      const id = +key;
      const p = this.state.persons.get(id);
      if (!p || p.death) { delete e.hurt[id]; continue; }
      const rec = e.hurt[id];
      const done = rec.accounted ?? 0;
      rec.accounted = 0;
      const remaining = inZone(id) ? 0 : Math.max(0, HOUR_SECONDS - done);
      if (remaining > 0) this.advance(p, remaining);
      if (rec.accounted) rec.accounted = 0;
    }
  }

  // ---- healing, infection, crippling (daily) ----

  /** One game day of healing for everyone hurt. */
  day(dayNow: number, healerSkill: (id: PersonId) => number = () => 0): void {
    const e = this.ext();
    const rng = this.ctx.rng('combat');
    for (const key of Object.keys(e.hurt)) {
      const id = +key;
      const p = this.state.persons.get(id);
      if (!p || p.death) { delete e.hurt[id]; continue; }
      const rec = e.hurt[id];
      this.healDay(p, rec, dayNow, rng, healerSkill(id));
    }
    this.touch();
  }

  private healDay(p: Person, rec: HurtRec, dayNow: number, rng: Rng, medicine: number): void {
    const rest = 0.6 + 0.4 * p.needs.rest;
    const food = 0.45 + 0.55 * p.needs.hunger;
    const warm = 0.7 + 0.3 * p.needs.warmth;
    const base = 0.16 * rest * food * warm * (1 + 0.04 * (p.trained.end - 10)) * (1 + 0.02 * Math.min(20, medicine));
    let died = false;
    for (let i = rec.wounds.length - 1; i >= 0 && !died; i--) {
      const w = rec.wounds[i];
      const age = dayNow - w.since;
      const careMul = w.care === 0 ? 1 : w.care === 1 ? 1.4 : 1.8;
      // open wounds fester
      const open = w.kind !== 'blunt' || w.severity > 0.55;
      if (open && !w.infected && age >= 0.2) {
        const p0 = 0.075 * w.severity * KIND_INFECT[w.kind] * (w.care === 0 ? 1 : w.care === 1 ? 0.45 : 0.18) * (w.lodged ? 1.8 : 1) * (p.needs.hunger < 0.3 ? 1.4 : 1);
        if (rng.next() < p0) w.infected = true;
      }
      if (w.infected) {
        // fever: the wound worsens unless it is tended; good care and a strong body beat it
        const fight = (w.care >= 2 ? 0.4 : w.care === 1 ? 0.12 : 0) + 0.02 * (p.trained.end - 10) + 0.03 * medicine + 0.06 * food;
        if (rng.next() < clamp(0.12 + fight, 0.05, 0.85)) w.infected = false;
        else {
          w.severity = round3(clamp(w.severity + 0.05, 0, 1));
          w.peak = Math.max(w.peak, w.severity);
          p.health.hp = round3(Math.max(0, p.health.hp - 0.03 - 0.05 * w.severity));
          if (rng.next() < 0.05 * w.severity * (w.care === 0 ? 1 : 0.5) * (1 - clamp(fight, 0, 0.8))) { this.kill(p, 'illness'); died = true; continue; }
        }
        continue;
      }
      // mending
      const step = base * careMul * (w.lodged ? 0.3 : 1) * (w.fracture ? 0.5 : 1);
      w.severity = round3(w.severity - step * (0.5 + w.severity));
      if (w.severity <= 0.03 && !(w.fracture && age < 6)) {
        this.scar(p, rec, w);
        rec.wounds.splice(i, 1);
      } else if (w.fracture && age >= 7 + 6 * w.severity) {
        w.fracture = false;
        if (w.severity > 0.35 && rng.next() < 0.4) this.scar(p, rec, w);
      }
    }
    if (died) return;
    // blood and hit points come back as the wounds close
    if (rec.blood < 1 && !rec.wounds.some((w) => w.rate > 0)) rec.blood = round3(Math.min(1, rec.blood + 0.12 * food));
    const load = rec.wounds.reduce((s, w) => s + w.severity * (w.location === 'torso' || w.location === 'head' ? 0.6 : 0.35), 0);
    const ceiling = clamp(1 - load, 0.05, 1) * clamp(0.5 + 0.5 * (rec.blood / 0.9), 0, 1);
    if (p.health.hp < ceiling) p.health.hp = round3(Math.min(ceiling, p.health.hp + base * 1.3));
    else if (p.health.hp > ceiling + 0.02) p.health.hp = round3(p.health.hp - 0.02);
    if (rec.wounds.length === 0 && rec.blood >= 0.99 && rec.stunned === undefined) {
      delete this.ext().hurt[p.id];
      this.dropCondition(p);
      p.health.hp = round3(Math.max(p.health.hp, 0.9));
    } else this.syncCondition(p, rec);
    this.state.touch(p);
  }

  /** A healed wound leaves its mark. */
  private scar(p: Person, rec: HurtRec, w: WoundRec): void {
    const leg = w.location === 'leg_l' || w.location === 'leg_r';
    const arm = w.location === 'arm_l' || w.location === 'arm_r';
    const rng = this.ctx.rng('combat');
    const bad = w.peak;
    if (leg && bad >= 0.5 && rng.next() < 0.55) this.addTrait(p, 'lame');
    else if (arm && bad >= 0.55 && rng.next() < 0.45) {
      rec.maimed ??= [];
      if (!rec.maimed.includes(w.location)) rec.maimed.push(w.location);
      this.addTrait(p, 'scarred');
    } else if (bad >= 0.4 && w.kind !== 'blunt' && rng.next() < 0.6) this.addTrait(p, 'scarred');
    else if (w.location === 'head' && bad >= 0.3 && rng.next() < 0.5) this.addTrait(p, 'scarred');
  }

  private addTrait(p: Person, trait: 'lame' | 'scarred'): void {
    if (!p.traits.includes(trait)) { p.traits.push(trait); this.state.touch(p); }
  }

  /** Keeps the person's 'injury' condition in step with the wounds so other systems (beds, sickness, UI) see them. */
  syncCondition(p: Person, rec: HurtRec): void {
    const now = this.ctx.absDay;
    let worst = 0;
    let until = now;
    for (const w of rec.wounds) {
      worst = Math.max(worst, w.severity);
      until = Math.max(until, now + 1.5 + w.severity * 8 + (w.fracture ? 4 : 0));
    }
    if (rec.wounds.length === 0 && rec.blood >= 0.99) { this.dropCondition(p); return; }
    let c = p.health.conditions.find((x) => x.id === 'injury');
    if (!c) { c = { id: 'injury', since: now, until, severity: worst }; p.health.conditions.push(c); }
    c.until = Math.max(until, now + 1);
    c.severity = round3(worst);
    if (rec.wounds.some((w) => w.infected)) {
      if (!p.health.conditions.some((x) => x.id === 'fever')) p.health.conditions.push({ id: 'fever', since: now, until: now + 3, severity: 0.5 });
      else p.health.conditions.find((x) => x.id === 'fever')!.until = now + 3;
    } else {
      const i = p.health.conditions.findIndex((x) => x.id === 'fever' && !x.fatal);
      if (i >= 0 && rec.wounds.length > 0) p.health.conditions.splice(i, 1);
    }
  }

  private dropCondition(p: Person): void {
    const cs = p.health.conditions;
    for (let i = cs.length - 1; i >= 0; i--) if (cs[i].id === 'injury' || (cs[i].id === 'fever' && !cs[i].fatal)) cs.splice(i, 1);
  }

  // ---- care ----

  /**
   * Binds and cleans the patient's wounds (a healer, a friend, oneself). `skill` is the carer's Medicine level.
   * Returns how many wounds were tended and whether bleeding was checked.
   */
  tend(patient: Person, skill: number, rng: Rng): { tended: number; stopped: number; extracted: number; message: string } {
    const rec = this.ext().hurt[patient.id];
    if (!rec || rec.wounds.length === 0) return { tended: 0, stopped: 0, extracted: 0, message: `${patient.first} has no wounds to tend.` };
    let tended = 0, stopped = 0, extracted = 0;
    for (const w of rec.wounds) {
      const want = skill >= 5 ? 2 : 1;
      if (w.care >= want) continue;
      w.care = want as 1 | 2;
      tended++;
      if (w.rate > 0) stopped++;
      if (w.lodged && rng.next() < 0.45 + 0.05 * skill) { w.lodged = undefined; extracted++; }
      if (w.infected && rng.next() < 0.2 + 0.06 * skill) w.infected = false;
    }
    this.syncCondition(patient, rec);
    this.state.touch(patient);
    this.touch();
    const name = patient.first;
    const message = tended === 0
      ? `${name}'s wounds are already as well tended as you can make them.`
      : `You bind ${name}'s ${tended === 1 ? 'wound' : 'wounds'}${stopped > 0 ? ' and slow the bleeding' : ''}${extracted > 0 ? ', drawing out the splinters' : ''}.`;
    return { tended, stopped, extracted, message };
  }

  /** Death or removal: forget the record. */
  forget(id: PersonId): void {
    const e = this.ext();
    if (e.hurt[id]) { delete e.hurt[id]; this.touch(); }
  }

  describe(p: Person): string {
    const r = this.rec(p.id);
    if (!r || r.wounds.length === 0) return `${fullName(p)} is unhurt.`;
    return r.wounds.map((w) => `${LOCATION_NAMES[w.location]} (${w.kind})`).join(', ');
  }
}

const EMPTY: readonly WoundRec[] = [];

function round3(v: number): number { return Math.round(v * 1000) / 1000; }
