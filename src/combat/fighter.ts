// One body in a fight: person or beast. The state machine (windup → blow → recover, guard, dodge, hurt,
// down) is shared by NPCs and the player; only where the intent comes from differs (combat/ai.ts for
// NPCs, combat/playerport.ts for the player). Pure data and small helpers: the arena does the rest.
import { clamp } from '../core/math';
import type { AnimalKind } from '../core/domain';
import type { AnimState, HeldItem } from '../core/view';
import type { Person, PersonId } from '../sim/state';
import type { Gear } from './gear';
import { WEAPONS, type AttackDef, type AttackKey } from './weapons';

/** States of the body. */
export const S = {
  Idle: 0, Windup: 1, Recover: 2, Block: 3, Dodge: 4, Hit: 5, Stagger: 6, Down: 7, Dead: 8, Flee: 9, Yield: 10,
  Draw: 11, Aim: 12, Shoot: 13, Reload: 14, Gone: 15, Charge: 16,
} as const;
export type StateId = (typeof S)[keyof typeof S];

export const BEAST_KEY_BASE = 1_000_000_000;

export interface BeastInfo {
  hp: number;
  radius: number;
  height: number;
  run: number;
  walk: number;
  weapon: string;
  /** Chance to slip a blow. */
  evade: number;
  courage: number;
}
export const BEASTS: Partial<Record<AnimalKind, BeastInfo>> = {
  wolf: { hp: 38, radius: 0.32, height: 0.85, run: 6.6, walk: 2.6, weapon: 'wolf_bite', evade: 0.22, courage: 38 },
  boar: { hp: 55, radius: 0.42, height: 0.9, run: 6.2, walk: 2.0, weapon: 'boar_tusk', evade: 0.08, courage: 60 },
  dog: { hp: 25, radius: 0.28, height: 0.6, run: 6.0, walk: 2.0, weapon: 'wolf_bite', evade: 0.15, courage: 55 },
};

export class Fighter {
  readonly key: number;
  readonly person: Person | null;
  readonly personId: PersonId;
  readonly animalId: number;
  readonly animalKind: AnimalKind | null;
  isPlayer = false;
  /** The body is moved by somebody else (the player's controller). */
  external = false;
  side = 0;
  fight = 0;

  // ---- body ----
  x = 0; y = 0; z = 0; yaw = 0;
  /** Position at the previous step (extrapolation for the renderer). */
  px = 0; pz = 0;
  vx = 0; vz = 0;
  radius = 0.32;
  height = 1.75;
  /** Speed the AI asked for this step (m/s), written back as the draw item's move speed. */
  speed = 0;
  pitch = 0;

  // ---- state machine ----
  st: StateId = S.Idle;
  /** Seconds in the current state. */
  t = 0;
  /** Planned length of the state (windup, recover, hit stun…). */
  dur = 0;
  anim: AnimState = 'idle';
  animT = 0;
  attackKey: AttackKey = 'slash';
  attack: AttackDef | null = null;
  heavy = false;
  impacted = false;
  /** Charge multiplier of a mounted blow (1 = on foot). */
  charge = 1;
  /** Forward speed of a lunge during the windup (m/s). */
  lunge = 0;
  /** Added to the clip time so the visible blow lands when the damage does (seconds, can be negative). */
  animSkew = 0;
  /** Seconds the guard has been up (a fresh guard parries). */
  guardT = 0;
  /** Seconds of invulnerability left in a dodge. */
  dodgeI = 0;
  dodgeDx = 0; dodgeDz = 0;
  dodgeCd = 0;
  downT = 0;
  /** How long to lie before trying to rise. */
  riseAt = 0;
  /** Seconds to wait before the next blow. */
  cooldown = 0;
  /** Ranged: arrow nocked and drawn. */
  nocked = false;
  loaded = true;
  shotsLeft = 0;
  /** Aim of the next shot: a unit vector (set by the player's camera or by the archer's AI). */
  aimDx = 0; aimDy = 0; aimDz = 1;
  aimSet = false;
  /** Extra scatter (rad) the player's wobble adds. */
  wobble = 0;
  /** Seconds the bow has been held drawn. */
  heldDraw = 0;

  // ---- gear and numbers ----
  gear: Gear;
  str = 10; agi = 10; end = 10; per = 10;
  melee = 0; archery = 0;
  maxHp = 80;
  /** Hit points of a beast (people's are Person.health.hp). */
  beastHp = 0;
  beastMax = 0;
  stamina = 100;
  staminaMax = 100;
  staminaIdle = 0;
  /** Breath the player has lost to blows since the port last passed it to the controller. */
  staminaDebt = 0;

  // ---- mind ----
  target: Fighter | null = null;
  retarget = 0;
  think = 0;
  dtThink = 0.05;
  strafe = 1;
  strafeT = 0;
  aggression = 0.6;
  morale = 60;
  moraleBase = 60;
  fled = false;
  yielded = false;
  /** Seconds since the last time this fighter was struck or struck a blow. */
  lastBlow = 99;
  /** The attacker's windup this fighter has already decided how to answer. */
  answered: Fighter | null = null;
  answeredSerial = -1;
  /** Counts the blows this fighter has started (an opponent answers each only once). */
  serial = 0;
  /** Seconds the guard stays up in a deliberate block (NPCs). */
  guardFor = 0;
  goalX = 0; goalZ = 0; hasGoal = false;
  /** Intent for this step: a unit direction, a speed (m/s) and where to face (NaN = leave it). */
  wantX = 0; wantZ = 0; wantSpeed = 0; wantYaw = NaN;
  slot = 0;
  aimJitter = 0;
  moving = false;

  // ---- mounted (the player's horse) ----
  mounted = false;
  mountHp = 0;
  unhorse = false;

  // ---- tallies ----
  hitsLanded = 0;
  hitsTaken = 0;
  kills = 0;
  killedBy: number | null = null;
  /** Summoned into the zone by the arena (dismissed when the fight ends). */
  summonedByUs = false;
  /** Left the arena (fled out of sight or the fight ended for them). */
  gone = false;
  corpseAt = 0;
  faction = '';

  constructor(opts: { person?: Person | null; animalId?: number; animalKind?: AnimalKind | null; gear: Gear }) {
    this.person = opts.person ?? null;
    this.personId = opts.person ? opts.person.id : 0;
    this.animalId = opts.animalId ?? 0;
    this.animalKind = opts.animalKind ?? null;
    this.key = opts.person ? opts.person.id : BEAST_KEY_BASE + this.animalId;
    this.gear = opts.gear;
  }

  get isAnimal(): boolean { return this.person === null; }

  /** A beast's running speed (m/s). */
  beastRun(): number { return (this.animalKind && BEASTS[this.animalKind]?.run) || 6; }

  get alive(): boolean { return this.st !== S.Dead && this.st !== S.Gone; }

  /** In the fight: standing or at least able to act. */
  get active(): boolean {
    return this.st !== S.Dead && this.st !== S.Gone && this.st !== S.Down && this.st !== S.Yield && !this.fled;
  }

  set(st: StateId, anim: AnimState, dur = 0): void {
    this.st = st;
    this.t = 0;
    this.dur = dur;
    if (this.anim !== anim) { this.anim = anim; this.animT = 0; }
  }

  /** Hands as they should be drawn. */
  hands(): { main: HeldItem; off: HeldItem } {
    const g = this.gear;
    if (this.animalKind) return { main: 'none', off: 'none' };
    if (this.yielded) return { main: 'none', off: 'none' };
    if (g.ranged && this.rangedOut()) return { main: g.ranged.held, off: 'none' };
    return { main: g.weapon === WEAPONS.fists ? 'none' : g.weapon.held, off: g.shield && g.weapon.hands === 1 ? g.shield.held : 'none' };
  }

  /** The bow is the weapon in hand (drawn, aiming or reloading). */
  rangedOut(): boolean {
    return this.st === S.Draw || this.st === S.Aim || this.st === S.Shoot || this.st === S.Reload || (this.gear.ranged !== null && this.preferRanged);
  }
  preferRanged = false;

  /** Stamina fraction 0..1. */
  get breath(): number { return this.staminaMax > 0 ? clamp(this.stamina / this.staminaMax, 0, 1) : 0; }
}

export function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function turnTo(cur: number, target: number, maxStep: number): number {
  const d = normAngle(target - cur);
  if (Math.abs(d) <= maxStep) return target;
  return cur + (d > 0 ? maxStep : -maxStep);
}
