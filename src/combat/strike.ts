// Blows and shots: finding who a swing reaches, the defender's answer (dodge, parry, block), the roll for
// where it lands and what armour makes of it, and the reaction of the body that is hit.
import { angleDiff, clamp, yawTo } from '../core/math';
import type { HitLocation, WoundKind } from '../sim/wave3';
import { gap, type Arena } from './arena';
import { S, normAngle, type Fighter } from './fighter';
import { ballisticPitch, type Shot } from './projectiles';
import { absorb, rollLocation, shapeWound, type LocationOpts } from './wounds';
import { ATTACK_KEYS, DAMAGE_QUALITY } from './weapons';

export type BlowOutcome = 'dodged' | 'blocked' | 'parried' | 'missed' | 'hit' | 'stopped';

export interface Blow {
  kind: WoundKind;
  dmg: number;
  ap: number;
  how: LocationOpts['how'];
  /** Fixed hit location (an arrow found it), else rolled. */
  location?: HitLocation;
  weapon: string;
  /** Where the blow came from, for guard angles and the knock-back. */
  fromX: number;
  fromZ: number;
  melee: boolean;
  heightDiff: number;
  /** Extra accuracy of the attacker (0 for arrows: geometry decides). */
  accuracy: number;
}

export interface BlowResult {
  outcome: BlowOutcome;
  location: HitLocation | null;
  damage: number;
  killed: boolean;
  stagger: boolean;
}

const LOC_Y: Record<HitLocation, number> = { head: 0.94, torso: 0.7, arm_l: 0.68, arm_r: 0.68, leg_l: 0.3, leg_r: 0.3 };

/** Resolves a swing at its moment of impact: who is in reach and arc, then the blow. */
export function impact(a: Arena, f: Fighter): void {
  const atk = f.attack;
  const fight = a.fights.get(f.fight);
  if (!atk || !fight) return;
  const w = f.gear.weapon;
  const reach = w.reach * (f.charge > 1 ? 1 : 1) + 0.2;
  let best: Fighter | null = null;
  let bestScore = Infinity;
  for (let si = 0; si < fight.sides.length; si++) {
    if (si === f.side) continue;
    for (const e of fight.sides[si].members) {
      if (e.gone || e.st === S.Dead || e.st === S.Yield || e.fled && e.st === S.Gone) continue;
      if (e.st === S.Down && !(f.isPlayer || f.isAnimal || (f.person?.rep.cruelty ?? 0) > 20)) continue;
      const d = gap(f, e);
      if (d > reach) continue;
      const dd = Math.max(0.3, Math.hypot(e.x - f.x, e.z - f.z));
      const off = Math.abs(normAngle(yawTo(f.x, f.z, e.x, e.z) - f.yaw));
      if (off > atk.arc + Math.atan2(e.radius, dd) + 0.12) continue;
      const score = d + off * 1.3 - (e === f.target ? 0.5 : 0);
      if (score < bestScore) { bestScore = score; best = e; }
    }
  }
  fight.quiet = 0;
  if (!best) {
    // the blow finds nothing but air: the fighter is open for a moment
    f.cooldown += 0.15;
    return;
  }
  const dmg = baseDamage(f, atk.dmg, atk.kind === 'bite', a.rng.next());
  const blow: Blow = {
    kind: atk.kind, dmg: dmg * f.charge, ap: atk.ap, how: f.attackKey, weapon: f.gear.weapon.id, fromX: f.x, fromZ: f.z, melee: true,
    heightDiff: f.charge > 1 ? 0.9 : 0, accuracy: meleeAccuracy(f),
  };
  const r = applyBlow(a, f, best, blow);
  if (r.outcome === 'hit') { f.hitsLanded++; if (f.isPlayer) a.env.playerHit?.(f, best, false, r.killed); }
  if (r.outcome === 'parried') {
    // thrown off balance by the parry
    if (f.st !== S.Dead) { f.set(S.Stagger, 'stagger', 0.75); f.attack = null; f.impacted = false; }
  }
}

/** Damage of a blow before location and armour: weapon × quality × strength × skill × breath. */
export function baseDamage(f: Fighter, dmg: number, beast: boolean, roll: number): number {
  if (beast) return dmg * (0.85 + 0.3 * (f.beastHp / Math.max(1, f.beastMax)));
  const q = DAMAGE_QUALITY[f.gear.weaponQ] ?? 1;
  const str = clamp(1 + 0.045 * (f.str - 10), 0.6, 1.5);
  const skill = 1 + 0.012 * f.melee;
  const breath = 0.7 + 0.3 * f.breath;
  const perk = perkDamage(f);
  return dmg * q * str * skill * breath * perk * (0.92 + 0.16 * roll);
}

function perkDamage(f: Fighter): number {
  const p = f.person;
  if (!p) return 1;
  let m = 1;
  if (p.perks.includes('melee.brutal_strike') && f.heavy) m += 0.12;
  if (p.perks.includes('melee.champion')) m += 0.15;
  return m;
}

export function meleeAccuracy(f: Fighter): number {
  let acc = 0.66 + 0.022 * f.melee + 0.012 * (f.per - 10);
  if (f.person) acc -= f.gear.worn > 0 ? 0 : 0;
  return acc;
}

/** Applies one blow to one body. All the rolls come from the combat stream, in a fixed order. */
export function applyBlow(a: Arena, att: Fighter | null, v: Fighter, b: Blow): BlowResult {
  const env = a.env;
  const rng = a.rng;
  const fx = env.fx;
  const fight = a.fights.get(v.fight);
  const none: BlowResult = { outcome: 'missed', location: null, damage: 0, killed: false, stagger: false };
  if (v.st === S.Dead || v.gone) return none;
  if (fight) fight.quiet = 0;
  const hx = v.x - Math.sin(angleBetween(v, b.fromX, b.fromZ)) * 0.15, hz = v.z - Math.cos(angleBetween(v, b.fromX, b.fromZ)) * 0.15;
  v.lastBlow = 0;
  const asleep = v.st === S.Down;
  // ---- the horse takes it ----
  if (v.isPlayer && v.mounted && v.mountHp > 0 && b.melee && !asleep && rng.next() < 0.28) {
    a.horseStruck(v, b.dmg * 0.9, b.fromX, b.fromZ);
    return { ...none, outcome: 'stopped' };
  }
  // ---- dodge ----
  if (v.dodgeI > 0 && !asleep) return { ...none, outcome: 'dodged' };
  // ---- the answer: parry or block ----
  let remaining = b.dmg;
  if (v.st === S.Block && !asleep) {
    const side = v.gear.shield !== null && v.gear.weapon.hands === 1;
    const arc = b.melee ? (side ? 1.35 : 0.85) : (side ? 0.9 : 0);
    const bearing = yawTo(v.x, v.z, b.fromX, b.fromZ);
    const off = Math.abs(angleDiff(v.yaw, bearing));
    if (off <= arc) {
      const base = side ? v.gear.shield!.block : v.gear.weapon.guard;
      const skill = 0.62 + 0.38 * Math.min(1, v.melee / 12);
      const strength = clamp(base * skill, 0, 0.93) * (b.how === 'overhead' ? 0.82 : 1);
      if (v.guardT < 0.24 && b.melee) {
        // met at the moment of the blow: turned aside
        fx.add('sparks', hx, v.y + 1.2, hz, 0.8);
        v.stamina = Math.max(0, v.stamina - 2);
        v.morale += 3;
        if (att) att.morale -= 2;
        return { outcome: 'parried', location: null, damage: 0, killed: false, stagger: true };
      }
      const cost = b.dmg * 0.34;
      const broke = v.stamina < cost;
      v.stamina = Math.max(0, v.stamina - cost);
      v.staminaIdle = 0;
      remaining = b.dmg * (1 - strength);
      fx.add(side ? 'chips' : 'sparks', hx, v.y + 1.2, hz, 0.7);
      if (broke) {
        // the guard is beaten down
        remaining = b.dmg * 0.65;
        v.set(S.Stagger, 'stagger', 0.9);
      } else if (remaining < 2) {
        return { outcome: 'blocked', location: null, damage: 0, killed: false, stagger: false };
      }
    }
  }
  // ---- does it land? ----
  if (b.melee && !asleep) {
    let acc = b.accuracy - 0.012 * (v.agi - 10) - (v.st === S.Block ? 0.05 : 0);
    if (v.isAnimal) acc -= 0.15;
    if (v.person) acc -= 0.0;
    if (rng.next() > clamp(acc, 0.2, 0.97)) return { ...none, outcome: 'missed' };
  }
  // ---- where, and what the armour does ----
  const loc = b.location ?? rollLocation(rng, {
    how: b.how, heightDiff: b.heightDiff, prone: asleep, shielded: !!v.gear.shield && v.st === S.Block,
  });
  let damage = 0;
  let hpLost = 0;
  let killed = false;
  let down = false;
  let deflected = false;
  let mortal = false;
  const y = v.y + v.height * LOC_Y[loc];
  if (v.person) {
    const ab = absorb(rng, v.gear.armour, loc, b.kind, remaining, b.ap);
    deflected = ab.absorbed > 0 && ab.through <= 0.5;
    const shaped = shapeWound(rng, loc, b.kind, ab.through, v.maxHp);
    const out = env.book.inflict(v.person, shaped, b.weapon, b.melee ? 'violence' : 'violence');
    damage = shaped.damage;
    hpLost = out.hpLost;
    killed = out.dead;
    down = out.down;
    mortal = out.mortal;
    if (shaped.stun > 0 && !killed) down = true;
  } else {
    const mult = loc === 'head' ? 1.3 : loc === 'torso' ? 1 : 0.7;
    damage = remaining * mult;
    v.beastHp -= damage;
    hpLost = damage / Math.max(1, v.beastMax);
    killed = v.beastHp <= 0;
    down = killed;
  }
  // ---- effects ----
  if (damage >= 1) fx.add(b.kind === 'blunt' ? 'impact' : 'blood', hx, y, hz, clamp(damage / 14, 0.4, 2.4));
  if (deflected) fx.add('sparks', hx, y, hz, 0.6);
  v.hitsTaken++;
  v.morale -= 2 + 62 * hpLost;
  if (att) att.morale += 2;
  if (killed) {
    a.markDead(v, att);
    return { outcome: 'hit', location: loc, damage, killed: true, stagger: true };
  }
  if (damage < 0.8 && !down) return { outcome: 'stopped', location: loc, damage, killed: false, stagger: false };
  // ---- the body answers ----
  const armourSteady = v.gear.worn > 0 ? 1 + v.gear.worn * 0.02 : 1;
  if (down || mortal) {
    a.fall(v);
    fx.add('dust', v.x, v.y + 0.1, v.z, 0.7);
  } else if (hpLost * armourSteady >= 0.22) {
    interrupt(v);
    v.set(S.Stagger, 'stagger', 0.9);
    v.yaw = v.yaw; // knocked back along the blow, see integrate()
  } else if (hpLost * armourSteady >= 0.06 || damage >= 5) {
    interrupt(v);
    v.set(S.Hit, 'hit', 0.42);
  }
  return { outcome: 'hit', location: loc, damage, killed: false, stagger: false };
}

function interrupt(v: Fighter): void {
  v.attack = null;
  v.impacted = false;
  v.nocked = false;
}

function angleBetween(v: Fighter, x: number, z: number): number { return yawTo(v.x, v.z, x, z); }

// ---------------------------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------------------------

/** The arrow leaves the string (called at the release frame of `shoot_bow`). */
export function releaseShot(a: Arena, f: Fighter): void {
  const r = f.gear.ranged;
  if (!r) return;
  const env = a.env;
  const rng = a.rng;
  // aim: the camera's ray for the player, the lead on the target for archers
  let dx: number, dy: number, dz: number;
  const ox = f.x + Math.sin(f.yaw) * 0.35, oz = f.z + Math.cos(f.yaw) * 0.35, oy = f.y + f.height * 0.82;
  if (f.aimSet) { dx = f.aimDx; dy = f.aimDy; dz = f.aimDz; }
  else {
    const t = f.target;
    if (!t) { dx = Math.sin(f.yaw); dz = Math.cos(f.yaw); dy = 0.05; }
    else {
      const sp = r.speed;
      let tx = t.x, tz = t.z;
      for (let i = 0; i < 2; i++) {
        const d = Math.hypot(tx - ox, tz - oz);
        const tt = d / (sp * 0.92);
        tx = t.x + t.vx * tt; tz = t.z + t.vz * tt;
      }
      const d = Math.max(1, Math.hypot(tx - ox, tz - oz));
      const ty = t.y + t.height * (t.st === S.Down ? 0.2 : 0.62);
      const pitch = ballisticPitch(d, ty - oy, sp);
      const yaw = Math.atan2(tx - ox, tz - oz);
      dx = Math.sin(yaw) * Math.cos(pitch); dz = Math.cos(yaw) * Math.cos(pitch); dy = Math.sin(pitch);
    }
  }
  // scatter: skill, perception, breath, motion, wounds, a drawn arm that has begun to shake
  const sigma = scatterOf(f, r.id === 'crossbow' ? 0.6 : 1) + f.wobble;
  const wind = env.wind();
  const yaw = Math.atan2(dx, dz) + rng.gauss(0, sigma) + (wind.x * Math.cos(Math.atan2(dx, dz)) - wind.z * Math.sin(Math.atan2(dx, dz))) * 0.0016;
  const pitch = Math.asin(clamp(dy, -1, 1)) + rng.gauss(0, sigma * 0.8);
  const cp = Math.cos(pitch);
  const strRatio = clamp(f.str / r.strReq, 0.6, 1.25);
  const speed = r.speed * (0.82 + 0.18 * Math.min(1, strRatio));
  const skill = 1 + 0.01 * f.archery;
  const dmg = r.dmg * (DAMAGE_QUALITY[f.gear.rangedQ] ?? 1) * clamp(0.75 + 0.25 * strRatio, 0.7, 1.15) * skill * archerPerk(f);
  env.proj.launch({
    kind: r.type === 'crossbow' ? 'bolt' : 'arrow', x: ox, y: oy, z: oz,
    vx: Math.sin(yaw) * cp * speed, vy: Math.sin(pitch) * speed, vz: Math.cos(yaw) * cp * speed,
    shooter: f.key, side: f.side, fight: f.fight, dmg, ap: r.ap, weapon: r.id, range: r.range,
  });
  f.stamina = Math.max(0, f.stamina - (r.type === 'bow' ? 5 + r.drawWeight / 40 : 2));
  f.shotsLeft = Math.max(0, f.shotsLeft - 1);
  f.gear.ammo = Math.max(0, f.gear.ammo - 1);
  const p = f.person;
  if (p && f.gear.ammoKey) {
    const left = (p.inventory[f.gear.ammoKey] ?? 0) - 1;
    if (left > 0) p.inventory[f.gear.ammoKey] = left; else { delete p.inventory[f.gear.ammoKey]; f.gear.ammoKey = null; }
    a.env.ctx.state.touch(p);
  }
  f.heldDraw = 0;
  f.wobble = 0;
  const fight = a.fights.get(f.fight);
  if (fight) fight.quiet = 0;
}

function archerPerk(f: Fighter): number {
  const p = f.person;
  if (!p) return 1;
  let m = 1;
  if (p.perks.includes('archery.heavy_draw')) m += 0.1;
  if (p.perks.includes('archery.armour_piercer')) m += 0.15;
  if (p.perks.includes('archery.master_bowman')) m += 0.1;
  return m;
}

/** Aim scatter (rad, one standard deviation). */
export function scatterOf(f: Fighter, kindFactor = 1): number {
  const skill = 0.075 - 0.0033 * Math.min(f.archery, 20);
  let s = skill * (1 - 0.018 * (f.per - 10));
  s += (1 - f.breath) * 0.02;
  s += Math.min(0.03, f.speed * 0.006);
  if (f.person) s += f.str < 8 ? 0.01 : 0;
  return Math.max(0.006, s) * kindFactor;
}

/** What an arrow does when its flight finds a body. Returns true: the arrow stops here. */
export function arrowStrike(a: Arena, s: Shot, shooter: Fighter | null, v: Fighter, hitY: number): boolean {
  const rel = (hitY - v.y) / Math.max(0.5, v.height);
  let loc: HitLocation;
  if (v.st === S.Down) loc = rel > 0.35 ? 'torso' : 'leg_l';
  else if (rel > 0.86) loc = 'head';
  else if (rel > 0.5) {
    // lateral offset from the body's axis picks an arm
    const c = Math.cos(v.yaw), sn = Math.sin(v.yaw);
    const lat = (s.x - v.x) * c - (s.z - v.z) * sn;
    loc = Math.abs(lat) > 0.2 ? (lat > 0 ? 'arm_l' : 'arm_r') : 'torso';
  } else loc = (s.x - v.x) * Math.cos(v.yaw) - (s.z - v.z) * Math.sin(v.yaw) > 0 ? 'leg_l' : 'leg_r';
  const flown = Math.hypot(s.x - s.x0, s.z - s.z0);
  const fall = clamp(1 - 0.45 * (flown / s.range) * (flown / s.range), 0.4, 1);
  const blow: Blow = {
    kind: 'arrow', dmg: s.dmg * fall * (0.92 + 0.16 * a.rng.next()), ap: s.ap, how: 'arrow', location: loc, weapon: s.weapon,
    fromX: s.x - s.vx * 0.2, fromZ: s.z - s.vz * 0.2, melee: false, heightDiff: 0, accuracy: 1,
  };
  const r = applyBlow(a, shooter, v, blow);
  if (r.outcome === 'dodged' || r.outcome === 'missed') return false;
  if (r.outcome === 'hit' && shooter) { shooter.hitsLanded++; if (shooter.isPlayer) a.env.playerHit?.(shooter, v, true, r.killed); }
  return true;
}

void ATTACK_KEYS;
