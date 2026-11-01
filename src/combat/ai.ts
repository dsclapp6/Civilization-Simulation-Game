// What NPC fighters decide (SPEC §14): approach and take a flanking place, circle, strike, answer a blow with a
// guard, a roll or a step back, archers keep their distance and loose when the line is clear, beasts rush
// in and fall back, and when the odds turn morale breaks: the humble run, nobles yield for ransom.
// Thinking runs every ~0.12 s per fighter; the state machine in arena.tickShared does the timing.
import { clamp, yawTo } from '../core/math';
import { gap, type Arena, type Fight } from './arena';
import { S, normAngle, type Fighter } from './fighter';
import { absorbRate } from './aiHelpers';
import { ballisticPitch } from './projectiles';
import type { AttackKey } from './weapons';

const THINK_PERIOD = 0.11;
const FLEE_SPEED = 1.0;

export function think(a: Arena, f: Fighter, dt: number): void {
  const fight = a.fights.get(f.fight);
  if (!fight) return;
  f.think -= dt;
  switch (f.st) {
    case S.Dead: case S.Gone: case S.Down: case S.Hit: case S.Stagger: case S.Yield: case S.Shoot:
      f.wantSpeed = 0;
      if (f.st === S.Shoot && f.target) f.wantYaw = yawTo(f.x, f.z, f.target.x, f.target.z);
      return;
    case S.Windup: case S.Recover: {
      f.wantSpeed = 0;
      const t = f.target;
      if (t && f.st === S.Windup && !Number.isNaN(f.wantYaw)) f.wantYaw = yawTo(f.x, f.z, t.x, t.z);
      return;
    }
    case S.Dodge: return;
    case S.Block:
      f.wantSpeed = 0;
      if (f.t >= f.guardFor) a.toIdle(f);
      else if (f.target) f.wantYaw = yawTo(f.x, f.z, f.target.x, f.target.z);
      return;
    default: break;
  }
  const aiming = f.st === S.Aim || f.st === S.Draw;
  if (f.think > 0 && !aiming) return;
  if (!aiming) f.think = THINK_PERIOD + (f.key % 7) * 0.006;
  f.dtThink = dt;

  // ---- courage ----
  if (moraleBreaks(a, f, fight)) return;
  if (f.st === S.Flee) { fleeStep(a, f, fight); return; }

  // ---- who ----
  f.retarget -= THINK_PERIOD;
  if (!f.target || !f.target.active || f.retarget <= 0) {
    f.target = pickTarget(a, f, fight);
    f.retarget = 0.7 + (f.key % 5) * 0.15;
  }
  const t = f.target;
  if (!t) { f.wantSpeed = 0; return; }
  const g = gap(f, t);
  f.wantYaw = yawTo(f.x, f.z, t.x, t.z);

  if (f.isAnimal) { beastThink(a, f, t, g, fight); return; }
  if (f.gear.ranged && f.shotsLeft > 0 && f.preferRanged) { if (rangedThink(a, f, t, g, fight)) return; }
  meleeThink(a, f, t, g, fight);
}

// ---------------------------------------------------------------------------------------------
// Courage
// ---------------------------------------------------------------------------------------------

function moraleBreaks(a: Arena, f: Fighter, fight: Fight): boolean {
  if (f.st === S.Flee) return false;
  const limit = f.isAnimal ? 22 : 16;
  if (f.morale > limit) return false;
  const p = f.person;
  // nobles and wounded men of rank yield rather than run, when yielding is allowed and the foe is a man
  if (p && fight.yieldAllowed && p.rankTier >= 5 && enemiesArePeople(a, f, fight)) {
    f.yielded = true;
    f.set(S.Yield, 'kneel');
    f.wantSpeed = 0;
    a.env.fx.add('dust', f.x, f.y + 0.05, f.z, 0.3);
    a.env.ctx.state.log(a.absDay, 'combat', `${p.first} ${p.byname} yielded.`, [p.id]);
    return true;
  }
  if (f.isPlayer) return false;
  f.fled = true;
  f.target = null;
  f.set(S.Flee, 'run');
  return true;
}

function enemiesArePeople(_a: Arena, f: Fighter, fight: Fight): boolean {
  for (let i = 0; i < fight.sides.length; i++) {
    if (i === f.side) continue;
    for (const e of fight.sides[i].members) if (e.active && e.person) return true;
  }
  return false;
}

function fleeStep(a: Arena, f: Fighter, fight: Fight): void {
  // away from the nearest enemy, along the open ground
  const e = a.nearestEnemy(f, fight, false);
  if (!e) { f.wantSpeed = 0; return; }
  const away = yawTo(e.x, e.z, f.x, f.z);
  f.wantX = Math.sin(away); f.wantZ = Math.cos(away);
  f.wantSpeed = (f.isAnimal ? f.beastRun() : f.mounted ? 8 : 3.7) * FLEE_SPEED;
  f.wantYaw = away;
  f.anim = f.mounted ? 'ride_gallop' : 'run';
  // sidestep a wall
  if (a.nav) {
    const out = { x: 0, z: 0, blocked: false, wading: false };
    a.nav.move(f.x, f.z, f.wantX * 1.5, f.wantZ * 1.5, f.radius, out);
    if (Math.hypot(out.x - f.x, out.z - f.z) < 0.4) {
      const alt = away + (f.key % 2 === 0 ? 1.1 : -1.1);
      f.wantX = Math.sin(alt); f.wantZ = Math.cos(alt);
    }
  }
  if (Math.hypot(e.x - f.x, e.z - f.z) > 48) {
    // out of sight and out of mind: they are not part of this any more
    f.st = S.Gone;
    f.gone = true;
  }
}

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

function pickTarget(a: Arena, f: Fighter, fight: Fight): Fighter | null {
  let best: Fighter | null = null;
  let bs = Infinity;
  const mine = fight.sides[f.side].members;
  const allowDown = f.isAnimal || (f.person?.rep.cruelty ?? 0) > 25;
  for (let si = 0; si < fight.sides.length; si++) {
    if (si === f.side) continue;
    for (const e of fight.sides[si].members) {
      if (e.gone || e.fled || e.st === S.Dead || e.st === S.Yield) continue;
      const downed = e.st === S.Down;
      if (downed && !allowDown) continue;
      let s = Math.hypot(e.x - f.x, e.z - f.z) + (downed ? 25 : 0);
      let crowd = 0;
      for (const m of mine) if (m !== f && m.target === e) crowd++;
      s += crowd * 1.7;
      if (e === f.target) s -= 2.5;
      if (e.isPlayer) s -= 0.5;
      if (s < bs) { bs = s; best = e; }
    }
  }
  void a;
  return best;
}

// ---------------------------------------------------------------------------------------------
// Melee
// ---------------------------------------------------------------------------------------------

/** Speed (m/s) of a destrier at the charge; below `LANCE_MIN` the point has no weight. */
const LANCE_GALLOP = 9.5;
const LANCE_MIN = 4.5;

/** A mounted man with a lance: gallop at the foe, strike at the point, wheel away, come round again. True if it took the turn. */
function lanceThink(a: Arena, f: Fighter, t: Fighter, g: number): boolean {
  if (f.wheel > 0) {
    f.wheel -= THINK_PERIOD;
    if (f.st === S.Charge) a.toIdle(f);
    const away = yawTo(t.x, t.z, f.x, f.z) + (f.key % 2 === 0 ? 0.7 : -0.7);
    f.wantX = Math.sin(away); f.wantZ = Math.cos(away); f.wantSpeed = 6.5; f.wantYaw = away; f.anim = 'ride_gallop';
    return true;
  }
  const reach = f.gear.weapon.reach + 0.6;
  if (f.st === S.Idle || f.st === S.Block || f.st === S.Recover) f.set(S.Charge, 'ride_charge', 99);
  const off = Math.abs(normAngle(yawTo(f.x, f.z, t.x, t.z) - f.yaw));
  if (g <= reach && off < 0.38 && f.speed >= LANCE_MIN) {
    a.lanceStrike(f, t, f.speed);
    f.wheel = 1.8 + a.rng.next() * 0.8;
    a.toIdle(f);
    return true;
  }
  f.wantX = Math.sin(f.wantYaw); f.wantZ = Math.cos(f.wantYaw);
  f.wantSpeed = g > 6 ? LANCE_GALLOP : 7;
  return true;
}

function meleeThink(a: Arena, f: Fighter, t: Fighter, g: number, _fight: Fight): void {
  if (f.mounted && !f.isPlayer && f.gear.weapon.mounted && lanceThink(a, f, t, g)) return;
  const w = f.gear.weapon;
  const reach = w.reach;
  // a man with a bow and a foe on top of him fights with what is at his belt
  const bearing = f.wantYaw;
  const incoming = t.st === S.Windup && t.target === f && g <= t.gear.weapon.reach + 0.6;
  if (incoming && answer(a, f, t, g)) return;

  if (g > reach + 0.2) {
    // close in, taking a place round the target rather than all queueing in one line
    const slot = ((f.key % 5) - 2) * 0.3 + f.slot;
    const toward = bearing + (g > 3 ? slot : slot * 0.4);
    f.wantX = Math.sin(toward); f.wantZ = Math.cos(toward);
    f.wantSpeed = (g > 7 ? 3.7 : g > 2.5 ? 3.0 : 1.9) * (f.mounted ? 1.9 : 1);
    f.anim = f.mounted ? (f.wantSpeed > 4 ? 'ride_trot' : 'ride_walk') : f.wantSpeed > 2.4 ? 'run' : 'walk';
    return;
  }
  // in reach
  if (reach >= 1.6 && g < reach * 0.35) {
    // too close for a pike: give ground
    const away = bearing + Math.PI;
    f.wantX = Math.sin(away); f.wantZ = Math.cos(away); f.wantSpeed = 1.8; f.anim = 'walk';
    return;
  }
  if (f.cooldown <= 0 && f.stamina > 6 && canStrike(f, t)) {
    const key = chooseAttack(a, f, t, g);
    if (a.startAttack(f, key)) {
      f.cooldown = (0.25 + a.rng.next() * 0.9) / f.aggression;
      f.wantSpeed = 0;
      return;
    }
  }
  // circle while waiting
  f.strafeT -= THINK_PERIOD;
  if (f.strafeT <= 0) { f.strafe = a.rng.next() < 0.55 ? f.strafe : -f.strafe; f.strafeT = 1.0 + a.rng.next() * 2.2; }
  const tangent = bearing + (Math.PI / 2) * f.strafe;
  const radial = g > reach * 0.9 ? 0.5 : g < reach * 0.5 ? -0.6 : 0;
  const dx = Math.sin(tangent) + Math.sin(bearing) * radial, dz = Math.cos(tangent) + Math.cos(bearing) * radial;
  const l = Math.hypot(dx, dz) || 1;
  f.wantX = dx / l; f.wantZ = dz / l;
  f.wantSpeed = 1.15;
  f.anim = 'walk';
}

function canStrike(f: Fighter, t: Fighter): boolean {
  void f; void t;
  return true;
}

/** The answer to a blow coming in: guard, roll away, or give ground. Returns true if it took the fighter's turn. */
function answer(a: Arena, f: Fighter, t: Fighter, g: number): boolean {
  if (f.answered === t && f.answeredSerial === t.serial) return false;
  const remaining = t.dur - t.t;
  if (remaining > 0.34) return false;
  f.answered = t; f.answeredSerial = t.serial;
  const rng = a.rng;
  const skill = f.melee;
  const react = clamp(0.42 + 0.035 * skill + 0.022 * (f.agi - 10) + (f.gear.shield ? 0.12 : 0) + (f.person?.traits.includes('brave') ? 0.04 : 0) - (1 - f.breath) * 0.2, 0.1, 0.9);
  if (rng.next() > react) return false;
  const canGuard = f.stamina > 8 && (f.gear.weapon.guard > 0.15 || f.gear.shield !== null) && !f.isAnimal;
  const dodgeP = f.isAnimal ? 0.55 : clamp(0.18 + 0.03 * (f.agi - 10) + (f.gear.worn > 8 ? -0.12 : 0), 0.05, 0.55);
  const r = rng.next();
  if (canGuard && r > dodgeP) {
    f.set(S.Block, 'block');
    f.guardT = 0;
    f.guardFor = Math.max(0.15, remaining + 0.3 + rng.next() * 0.3);
    f.wantSpeed = 0;
    return true;
  }
  if (f.stamina > 10 && f.dodgeCd <= 0) {
    const side = (f.key + t.serial) % 2 === 0 ? 1 : -1;
    const away = yawTo(t.x, t.z, f.x, f.z);
    const dir = away + side * 1.2;
    f.dodgeDx = Math.sin(dir); f.dodgeDz = Math.cos(dir);
    f.stamina = Math.max(0, f.stamina - 10);
    f.dodgeI = 0.3; f.dodgeCd = 1.2;
    f.set(S.Dodge, f.isAnimal ? 'walk' : 'dodge', 0.45);
    return true;
  }
  void g;
  return false;
}

function chooseAttack(a: Arena, f: Fighter, t: Fighter, g: number): AttackKey {
  const w = f.gear.weapon;
  const rng = a.rng;
  if (f.isAnimal) return 'slash';
  // armour that turns cuts invites the point or a hammer blow
  const armoured = absorbRate(t) >= 12;
  const th = w.attacks.thrust, sl = w.attacks.slash, ov = w.attacks.overhead;
  if (w.id === 'spear' || w.id === 'dagger' && armoured) return 'thrust';
  const heavyP = (0.12 + 0.2 * f.aggression) * (f.breath > 0.55 ? 1 : 0.3) * (t.st === S.Stagger || t.st === S.Hit ? 2.2 : 1);
  if (rng.next() < heavyP) return 'overhead';
  if (armoured && (th.ap > sl.ap + 0.05 || ov.ap > sl.ap + 0.1) && rng.next() < 0.6) return th.ap >= ov.ap * 0.9 ? 'thrust' : 'overhead';
  if (g > w.reach - 0.2 && th.dmg >= sl.dmg * 0.8 && rng.next() < 0.5) return 'thrust';
  return rng.next() < 0.2 ? 'thrust' : 'slash';
}

// ---------------------------------------------------------------------------------------------
// Archers
// ---------------------------------------------------------------------------------------------

/** Returns true if the archer used the turn (loosing, drawing, moving to range); false to fight hand to hand. */
function rangedThink(a: Arena, f: Fighter, t: Fighter, g: number, fight: Fight): boolean {
  const r = f.gear.ranged!;
  // a man at the archer's throat is fought with the knife
  if (g < 2.6) { if (f.st === S.Aim || f.st === S.Draw) { a.toIdle(f); f.nocked = false; } return false; }
  const lo = 8, hi = Math.min(r.range * 0.6, 34);
  const bearing = yawTo(f.x, f.z, t.x, t.z);
  if (f.st === S.Aim) {
    f.wantSpeed = 0;
    f.heldDraw += f.dtThink;
    const err = Math.abs(normAngle(bearing - f.yaw));
    const ready = f.t >= r.aimTime * (1.15 - 0.02 * Math.min(f.archery, 10)) + (f.key % 4) * 0.12;
    if (g > r.range * 0.9 || g < 3 || !lineClear(a, f, t, fight)) { a.toIdle(f); f.nocked = false; f.cooldown = 0.3; return true; }
    if (ready && err < 0.2 && (r.type === 'bow' || f.loaded)) {
      f.set(S.Shoot, r.type === 'crossbow' ? 'shoot_crossbow' : 'shoot_bow', r.type === 'crossbow' ? 0.7 : 0.8);
      f.impacted = false;
      f.pitch = pitchTo(f, t, r.speed);
    }
    return true;
  }
  if (f.st === S.Draw) { f.wantSpeed = 0; f.wantYaw = bearing; return true; }
  if (f.st === S.Reload) {
    // reloading behind the line: back off a little
    f.wantYaw = bearing;
    if (g < lo) { f.wantX = Math.sin(bearing + Math.PI); f.wantZ = Math.cos(bearing + Math.PI); f.wantSpeed = 1.6; f.anim = 'reload_crossbow'; }
    else f.wantSpeed = 0;
    return true;
  }
  if (g < lo) {
    // keep away: back off, sidestepping if a wall is behind
    const away = bearing + Math.PI + (f.key % 2 ? 0.5 : -0.5);
    f.wantX = Math.sin(away); f.wantZ = Math.cos(away); f.wantSpeed = 2.7; f.anim = 'walk';
    return true;
  }
  if (g > hi) {
    f.wantX = Math.sin(bearing); f.wantZ = Math.cos(bearing); f.wantSpeed = 2.8; f.anim = 'walk';
    return true;
  }
  if (!lineClear(a, f, t, fight)) {
    const side = bearing + (Math.PI / 2) * f.strafe;
    f.wantX = Math.sin(side); f.wantZ = Math.cos(side); f.wantSpeed = 2; f.anim = 'walk';
    f.strafeT -= THINK_PERIOD;
    if (f.strafeT <= 0) { f.strafe = -f.strafe; f.strafeT = 1.2; }
    return true;
  }
  f.wantSpeed = 0;
  if (f.cooldown > 0) return true;
  if (r.type === 'crossbow') {
    if (!f.loaded) { f.set(S.Reload, 'reload_crossbow', r.reload * a.speedOf(f, false)); return true; }
    f.set(S.Aim, 'aim_crossbow', 99);
    f.nocked = true;
  } else f.set(S.Draw, 'draw_bow', r.drawTime * a.speedOf(f, false));
  f.cooldown = 0.2;
  return true;
}

function pitchTo(f: Fighter, t: Fighter, speed: number): number {
  const d = Math.hypot(t.x - f.x, t.z - f.z);
  return ballisticPitch(d, (t.y + t.height * 0.6) - (f.y + f.height * 0.82), speed);
}

/** No friend (or neutral) body stands within 0.8 m of the line of fire. */
function lineClear(a: Arena, f: Fighter, t: Fighter, fight: Fight): boolean {
  const dx = t.x - f.x, dz = t.z - f.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1) return true;
  for (const side of fight.sides) for (const m of side.members) {
    if (m === f || m === t || !m.alive) continue;
    if (m.side !== f.side && m.st !== S.Down) continue; // other enemies in the way are just as good a target
    const u = ((m.x - f.x) * dx + (m.z - f.z) * dz) / len2;
    if (u <= 0.05 || u >= 0.95) continue;
    const px = f.x + dx * u, pz = f.z + dz * u;
    if ((m.x - px) * (m.x - px) + (m.z - pz) * (m.z - pz) < 0.64) return false;
  }
  void a;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Beasts
// ---------------------------------------------------------------------------------------------

function beastThink(a: Arena, f: Fighter, t: Fighter, g: number, fight: Fight): void {
  const reach = f.gear.weapon.reach;
  const bearing = f.wantYaw;
  const run = f.beastRun();
  const incoming = t.st === S.Windup && t.target === f && g <= t.gear.weapon.reach + 0.6;
  if (incoming && f.person === null && answer(a, f, t, g)) return;
  if (g > reach + 0.1) {
    // wolves come in from the flank, hunting as a pack
    const flank = f.animalKind === 'wolf' ? ((f.key % 3) - 1) * 0.9 : 0;
    const toward = bearing + (g > 4 ? flank : flank * 0.3);
    f.wantX = Math.sin(toward); f.wantZ = Math.cos(toward);
    f.wantSpeed = g > 10 ? run : g > 3 ? run * 0.85 : run * 0.6;
    return;
  }
  if (f.cooldown <= 0 && f.stamina > 3) {
    if (a.startAttack(f, 'slash')) {
      f.cooldown = 1.3 + a.rng.next() * 1.8;
      return;
    }
  }
  // snap and fall back: circle at arm's length
  f.strafeT -= THINK_PERIOD;
  if (f.strafeT <= 0) { f.strafe = -f.strafe; f.strafeT = 0.8 + a.rng.next() * 1.5; }
  const tangent = bearing + (Math.PI / 2) * f.strafe;
  const radial = g < reach * 0.8 ? -0.8 : 0.4;
  const dx = Math.sin(tangent) + Math.sin(bearing) * radial, dz = Math.cos(tangent) + Math.cos(bearing) * radial;
  const l = Math.hypot(dx, dz) || 1;
  f.wantX = dx / l; f.wantZ = dz / l;
  f.wantSpeed = 2.9;
  void fight;
}
