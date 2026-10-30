// The player's side of combat (SPEC §22): LMB attacks (a tap is a quick blow, holding builds a heavy
// overhead), RMB guards (with a bow: draws and aims along the camera), Space rolls. The controller hands this
// port the held buttons every frame and the body every sub-step; the port runs the same fighter state machine
// the NPCs use and answers with how the body should look and move. No hero health: the wounds are the same
// ones everybody gets.
import { clamp, yawTo } from '../core/math';
import { SIM_DT } from '../core/time';
import type { PlayerAim, PlayerCombatFrame, PlayerCombatPort, PlayerCombatPose } from '../sim/wave3';
import { gap, type Arena } from './arena';
import { S, normAngle, type Fighter } from './fighter';
import { ballisticPitch } from './projectiles';
import { absorbRate } from './aiHelpers';
import type { AttackKey } from './weapons';

const HEAVY_HOLD = 0.26;
const QUEUE_SECONDS = 0.4;
const ENGAGED_LINGER = 5;

export class PlayerPort implements PlayerCombatPort {
  private attackHeld = false;
  private blockHeld = false;
  private attackPending = false;
  private pendingFor = 0;
  private holdT = 0;
  private releaseEdge = false;
  private blockEdge = false;
  private aim: PlayerAim | null = null;
  private readonly aimBuf: PlayerAim = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1 };
  private cameraYaw = 0;
  private engagedT = 0;
  private gearT = 99;
  private personId = 0;
  private lowAmmoWarned = false;
  private aimingNow = false;
  private chargeCool = 0;

  constructor(private readonly arena: Arena) {}

  input(attack: boolean, block: boolean, aim: PlayerAim | null, cameraYaw: number): void {
    if (attack && !this.attackHeld) { this.attackPending = true; this.pendingFor = 0; this.holdT = 0; }
    if (!attack && this.attackHeld) this.releaseEdge = true;
    if (block && !this.blockHeld) this.blockEdge = true;
    this.attackHeld = attack;
    this.blockHeld = block;
    this.cameraYaw = cameraYaw;
    if (aim) {
      const b = this.aimBuf;
      b.x = aim.x; b.y = aim.y; b.z = aim.z; b.dx = aim.dx; b.dy = aim.dy; b.dz = aim.dz;
      this.aim = b;
    } else this.aim = null;
  }

  reset(): void {
    this.attackHeld = this.blockHeld = this.attackPending = this.releaseEdge = this.blockEdge = false;
    this.engagedT = 0;
    this.personId = 0;
    this.arena.dropPlayer();
  }

  dodge(): boolean {
    const pf = this.arena.player;
    if (!pf) return true;
    switch (pf.st) {
      case S.Idle: case S.Block: case S.Recover: case S.Aim: case S.Draw: case S.Reload: case S.Charge: break;
      default: return false;
    }
    if (pf.dodgeCd > 0) return false;
    pf.nocked = false;
    pf.dodgeCd = 0.8;
    pf.set(S.Dodge, 'dodge', 0.42);
    return true;
  }

  step(fr: PlayerCombatFrame, out: PlayerCombatPose): void {
    const a = this.arena;
    out.engaged = false; out.anim = null; out.animTime = 0; out.mainHand = null; out.offHand = null; out.moveScale = 1; out.faceYaw = null;
    out.aimPitch = null; out.staminaCost = 0; out.effort = 0; out.noSprint = false; out.aiming = false; out.unhorse = false;
    out.armour = null; out.helmet = null;
    const p = a.env.ctx.state.persons.get(fr.person);
    if (!p || p.death) return;
    if (this.personId !== fr.person) {
      if (this.personId !== 0) a.dropPlayer();
      this.personId = fr.person;
      this.gearT = 99;
    }
    const pf = a.ensurePlayer(fr.person);
    if (!pf) return;

    // ---- the body as the controller has it ----
    pf.px = pf.x; pf.pz = pf.z;
    pf.x = fr.x; pf.y = fr.y; pf.z = fr.z; pf.yaw = fr.yaw;
    pf.vx = (pf.x - pf.px) / SIM_DT; pf.vz = (pf.z - pf.pz) / SIM_DT;
    pf.speed = fr.speed;
    pf.stamina = fr.stamina; pf.staminaMax = fr.staminaMax;
    pf.mounted = fr.mounted;
    if (fr.mounted && pf.mountHp <= 0) pf.mountHp = 110;
    else if (!fr.mounted) pf.mountHp = 0;
    pf.moving = fr.speed > 0.3;
    this.gearT += fr.dt;
    if (this.gearT > 1.2) this.refreshGear(pf);
    out.armour = armourLook(pf, 'armour'); out.helmet = armourLook(pf, 'helmet');

    const inFight = pf.fight !== 0;
    const w = pf.gear.weapon;
    const hasBow = pf.gear.ranged !== null && pf.preferRanged;
    if (fr.busy && pf.st !== S.Hit && pf.st !== S.Stagger && pf.st !== S.Down) {
      if (pf.st === S.Block || pf.st === S.Aim || pf.st === S.Draw) a.toIdle(pf);
      this.attackPending = false; this.blockEdge = false; this.releaseEdge = false;
      this.finish(pf, out, fr, inFight);
      return;
    }
    // the body is knocked or hurt: no intent
    const helpless = pf.st === S.Down || pf.st === S.Stagger || pf.st === S.Hit;
    if (!helpless) {
      // ---- the dodge roll's invulnerable middle ----
      if (pf.st === S.Dodge) pf.dodgeI = fr.dodgeT > 0.07 && fr.dodgeT < 0.37 ? 0.1 : 0;
      else if (hasBow) this.rangedIntent(pf, fr, p.id);
      else if (fr.mounted && w.mounted) this.chargeIntent(pf, fr);
      else this.meleeIntent(pf, fr);
    } else {
      this.attackPending = false;
      if (pf.st === S.Down) pf.dodgeI = 0;
    }
    if (pf.st !== S.Down || helpless) a.tickShared(pf, fr.dt);
    this.attackPending = this.attackPending && this.pendingFor < QUEUE_SECONDS;
    this.releaseEdge = false; this.blockEdge = false;
    this.finish(pf, out, fr, inFight);
  }

  private refreshGear(pf: Fighter): void {
    const a = this.arena;
    const p = pf.person;
    if (!p) return;
    this.gearT = 0;
    const g = a.gearFor(p);
    pf.gear = g;
    pf.preferRanged = g.rangedMain && !!g.ranged;
    pf.shotsLeft = g.ammo;
    a.refreshStats(pf);
  }

  // ---- melee ----

  private meleeIntent(pf: Fighter, fr: PlayerCombatFrame): void {
    const a = this.arena;
    const idleLike = pf.st === S.Idle || pf.st === S.Block || pf.st === S.Recover;
    if (this.attackPending) {
      this.pendingFor += fr.dt;
      if (this.attackHeld) this.holdT += fr.dt;
      const heavy = this.attackHeld && this.holdT >= HEAVY_HOLD;
      const quick = this.releaseEdge && !heavy;
      if ((heavy || quick) && (pf.st === S.Idle || pf.st === S.Block || (pf.st === S.Recover && pf.t > pf.dur * 0.55))) {
        if (pf.st === S.Recover) a.toIdle(pf);
        const key = this.pick(pf, heavy);
        this.aimMelee(pf);
        if (a.startAttack(pf, key)) { this.attackPending = false; this.engagedT = ENGAGED_LINGER; pf.cooldown = 0.05; }
      }
    }
    // guard
    if (this.blockHeld && (pf.st === S.Idle || (pf.st === S.Recover && pf.t > pf.dur * 0.6))) {
      if (pf.st === S.Recover) a.toIdle(pf);
      if (pf.stamina > 4 && w(pf).guard > 0.05 || pf.gear.shield) {
        pf.set(S.Block, 'block', 99);
        pf.guardT = 0;
        this.engagedT = ENGAGED_LINGER;
      }
    } else if (!this.blockHeld && pf.st === S.Block) a.toIdle(pf);
    void idleLike;
  }

  private pick(pf: Fighter, heavy: boolean): AttackKey {
    if (heavy) return 'overhead';
    const w = pf.gear.weapon;
    const t = pf.target;
    if (w.id === 'spear' || w.id === 'lance') return 'thrust';
    if (t && absorbRate(t) >= 12 && w.attacks.thrust.ap > w.attacks.slash.ap + 0.1) return 'thrust';
    return 'slash';
  }

  /** Picks who the blow is aimed at: the enemy nearest the line of the camera within reach. */
  private aimMelee(pf: Fighter): void {
    const a = this.arena;
    const fight = a.fights.get(pf.fight);
    pf.target = null;
    if (!fight) return;
    let best: Fighter | null = null;
    let bs = Infinity;
    const reach = pf.gear.weapon.reach + 2.2;
    for (let si = 0; si < fight.sides.length; si++) {
      if (si === pf.side) continue;
      for (const e of fight.sides[si].members) {
        if (e.gone || e.st === S.Dead || e.st === S.Yield) continue;
        const g = gap(pf, e);
        if (g > reach) continue;
        const off = Math.abs(normAngle(yawTo(pf.x, pf.z, e.x, e.z) - this.cameraYaw));
        if (off > 1.25 && g > 1.2) continue;
        const s = off * 1.6 + g * 0.5 + (e.st === S.Down ? 1.5 : 0);
        if (s < bs) { bs = s; best = e; }
      }
    }
    pf.target = best;
  }

  // ---- bows ----

  private rangedIntent(pf: Fighter, fr: PlayerCombatFrame, personId: number): void {
    const a = this.arena;
    const r = pf.gear.ranged!;
    const wantAim = this.blockHeld || this.attackHeld;
    const rmb = this.blockHeld;
    const fire = rmb ? this.attackPending : this.releaseEdge;
    switch (pf.st) {
      case S.Idle: case S.Recover:
        if (wantAim && pf.st === S.Idle) {
          if (pf.gear.ammo <= 0) {
            if (!this.lowAmmoWarned) { a.env.notify('warn', `You have no ${r.ammo}s.`, personId); this.lowAmmoWarned = true; }
          } else if (r.type === 'crossbow') {
            if (pf.loaded) { pf.set(S.Aim, 'aim_crossbow', 99); pf.nocked = true; }
            else pf.set(S.Reload, 'reload_crossbow', r.reload * a.speedOf(pf, false));
          } else pf.set(S.Draw, 'draw_bow', r.drawTime * a.speedOf(pf, false));
          this.engagedT = ENGAGED_LINGER;
        }
        if (!wantAim) this.lowAmmoWarned = false;
        break;
      case S.Draw:
        if (!wantAim) a.toIdle(pf);
        break;
      case S.Aim:
        pf.heldDraw += fr.dt;
        // the arm tires: after a few seconds the point wanders
        pf.wobble = clamp((pf.heldDraw - 4) * 0.006, 0, 0.05) + (1 - pf.breath) * 0.012;
        if (fire && pf.heldDraw >= 0.15) {
          this.attackPending = false;
          pf.set(S.Shoot, r.type === 'crossbow' ? 'shoot_crossbow' : 'shoot_bow', r.type === 'crossbow' ? 0.7 : 0.8);
          pf.impacted = false;
        } else if (!wantAim) { a.toIdle(pf); pf.nocked = false; pf.heldDraw = 0; }
        break;
      default: break;
    }
    if (pf.st === S.Draw || pf.st === S.Aim || pf.st === S.Shoot) this.aimShot(pf);
    else pf.aimSet = false;
    this.aimingNow = pf.st === S.Draw || pf.st === S.Aim || pf.st === S.Shoot;
  }

  /** The shot leaves along the camera's ray: at the first body on it if there is one, else far down the line. */
  private aimShot(pf: Fighter): void {
    const a = this.arena;
    const ray = this.aim;
    const r = pf.gear.ranged;
    if (!ray || !r) { pf.aimSet = false; return; }
    let bestT = 70;
    let aimY = 0;
    let found = false;
    for (const e of a.fighters) {
      if (e === pf || e.gone || e.st === S.Dead) continue;
      const cx = e.x - ray.x, cy = e.y + e.height * 0.65 - ray.y, cz = e.z - ray.z;
      const t = cx * ray.dx + cy * ray.dy + cz * ray.dz;
      if (t < 3 || t >= bestT) continue;
      const perp2 = cx * cx + cy * cy + cz * cz - t * t;
      const rr = e.radius + 0.4;
      if (perp2 < rr * rr) { bestT = t; found = true; aimY = ray.y + ray.dy * t; }
    }
    const tx = ray.x + ray.dx * bestT, ty = found ? aimY : ray.y + ray.dy * bestT, tz = ray.z + ray.dz * bestT;
    const ox = pf.x + Math.sin(pf.yaw) * 0.35, oz = pf.z + Math.cos(pf.yaw) * 0.35, oy = pf.y + pf.height * 0.82;
    let dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const horiz = Math.hypot(dx, dz) || 1;
    if (found) {
      // the arrow drops over a long shot: raise the point to compensate (a practised eye knows)
      const pitch = ballisticPitch(horiz, dy, r.speed);
      const comp = 0.5 + 0.03 * Math.min(pf.archery, 14);
      const flat = Math.atan2(dy, horiz);
      const use = flat + (pitch - flat) * comp;
      dy = Math.tan(use) * horiz;
    }
    const l = Math.hypot(dx, dy, dz) || 1;
    pf.aimDx = dx / l; pf.aimDy = dy / l; pf.aimDz = dz / l;
    pf.aimSet = true;
    pf.pitch = Math.asin(clamp(pf.aimDy, -1, 1));
  }

  // ---- the couched lance ----

  private chargeIntent(pf: Fighter, fr: PlayerCombatFrame): void {
    const a = this.arena;
    this.chargeCool -= fr.dt;
    const fight = a.fights.get(pf.fight);
    const couching = this.attackHeld && fr.speed >= 4.5;
    if (couching) {
      if (pf.st !== S.Charge && (pf.st === S.Idle || pf.st === S.Block)) pf.set(S.Charge, 'ride_charge', 99);
    } else if (pf.st === S.Charge) a.toIdle(pf);
    this.engagedT = couching ? ENGAGED_LINGER : this.engagedT;
    if (pf.st !== S.Charge || !fight || this.chargeCool > 0) return;
    // the point meets whoever is ahead within the lance's length
    const reach = pf.gear.weapon.reach + 0.6;
    for (let si = 0; si < fight.sides.length; si++) {
      if (si === pf.side) continue;
      for (const e of fight.sides[si].members) {
        if (e.gone || e.st === S.Dead || e.st === S.Yield) continue;
        const g = gap(pf, e);
        if (g > reach) continue;
        const off = Math.abs(normAngle(yawTo(pf.x, pf.z, e.x, e.z) - pf.yaw));
        if (off > 0.38) continue;
        a.lanceStrike(pf, e, fr.speed);
        this.chargeCool = 1.4;
        return;
      }
    }
  }

  // ---- the answer ----

  private finish(pf: Fighter, out: PlayerCombatPose, fr: PlayerCombatFrame, inFight: boolean): void {
    this.engagedT = Math.max(0, this.engagedT - fr.dt);
    const hostile = inFight && pf.fight !== 0;
    const engaged = hostile || this.engagedT > 0 || this.aimingNow || pf.st !== S.Idle;
    out.engaged = engaged;
    const stt = pf.st;
    // what the body does
    switch (stt) {
      case S.Windup: case S.Recover: out.anim = pf.anim; out.animTime = this.arena.clipTime(pf, fr.dt); break;
      case S.Block: out.anim = 'block'; out.animTime = this.arena.clipTime(pf, fr.dt); break;
      case S.Hit: out.anim = 'hit'; out.animTime = pf.t; break;
      case S.Stagger: out.anim = 'stagger'; out.animTime = pf.t; break;
      case S.Down: out.anim = pf.t < 1.3 ? 'fall' : 'dead'; out.animTime = pf.t < 1.3 ? pf.t : pf.t - 1.3; break;
      case S.Draw: case S.Aim: case S.Shoot: case S.Reload: out.anim = pf.anim; out.animTime = pf.animT; break;
      case S.Charge: out.anim = 'ride_charge'; out.animTime = pf.animT; break;
      default: break;
    }
    const h = pf.hands();
    if (engaged || stt === S.Aim) { out.mainHand = h.main; out.offHand = h.off; }
    // how it moves
    let scale = 1;
    switch (stt) {
      case S.Windup: scale = 0.25; break;
      case S.Recover: scale = 0.45; break;
      case S.Block: scale = 0.45; break;
      case S.Hit: scale = 0.5; break;
      case S.Stagger: case S.Down: scale = 0; break;
      case S.Draw: case S.Aim: scale = 0.4; break;
      case S.Shoot: scale = 0.15; break;
      case S.Reload: scale = 0.6; break;
      case S.Dodge: scale = 1; break;
      default: scale = hostile && fr.speed < 4 && !fr.mounted ? 0.62 : 1;
    }
    scale *= 1 - this.arena.env.book.limbPenalty(fr.person, 'legs') * 0.5;
    out.moveScale = scale;
    out.noSprint = stt === S.Windup || stt === S.Recover || stt === S.Block || stt === S.Aim || stt === S.Draw || stt === S.Shoot || stt === S.Reload;
    out.aiming = this.aimingNow && (stt === S.Aim || stt === S.Draw || stt === S.Shoot);
    out.effort = stt === S.Block ? 1.4 : stt === S.Aim ? 0.9 : stt === S.Draw ? 2.4 : 0;
    // facing
    if (stt === S.Windup || stt === S.Recover) {
      const t = pf.target;
      out.faceYaw = t && gap(pf, t) < 4 ? yawTo(pf.x, pf.z, t.x, t.z) : this.cameraYaw;
    } else if (stt === S.Draw || stt === S.Aim || stt === S.Shoot) {
      out.faceYaw = pf.aimSet ? Math.atan2(pf.aimDx, pf.aimDz) : this.cameraYaw;
      out.aimPitch = pf.pitch;
    } else if (stt === S.Block) {
      const e = this.nearestHostile(pf, 6);
      out.faceYaw = e ? yawTo(pf.x, pf.z, e.x, e.z) : this.cameraYaw;
    } else if (hostile && fr.speed < 4 && !fr.mounted && stt === S.Idle) {
      const e = this.nearestHostile(pf, 9);
      if (e) out.faceYaw = yawTo(pf.x, pf.z, e.x, e.z);
    }
    if (pf.unhorse) { out.unhorse = true; pf.unhorse = false; }
  }

  private nearestHostile(pf: Fighter, within: number): Fighter | null {
    const a = this.arena;
    const fight = a.fights.get(pf.fight);
    if (!fight) return null;
    let best: Fighter | null = null;
    let bd = within;
    for (let si = 0; si < fight.sides.length; si++) {
      if (si === pf.side) continue;
      for (const e of fight.sides[si].members) {
        if (!e.active) continue;
        const d = Math.hypot(e.x - pf.x, e.z - pf.z);
        if (d < bd) { bd = d; best = e; }
      }
    }
    return best;
  }
}

function w(pf: Fighter): { guard: number } { return pf.gear.weapon; }

function armourLook(pf: Fighter, slot: 'armour' | 'helmet'): string | null {
  for (const p of pf.gear.armour) if (p.def.slot === slot) return p.def.look;
  return null;
}
