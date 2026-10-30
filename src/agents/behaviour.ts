// What an agent does each step: re-read its intention from the schedule, walk, steer around others,
// carry out the micro-behaviour at its spot (work loops with breaks, chatting, archery, play,
// errands), and react to the player (look, greet, kneel, wave). Everything here is visual: the
// macro tier stays the truth, so none of it touches simulation state or random streams.
import { angleDiff, clamp, distToSegment, hash01, smoothstep, yawTo } from '../core/math';
import type { AnimState } from '../core/view';
import { ageYears, hasFlag } from '../sim/state';
import { Agent, Ph, St } from './agent';
import { RUN_SPEED, SEEN_RADIUS, WARP_FAR, WARP_MAX, WARP_NEAR } from './config';
import { Mode, type Intent } from './schedule';
import type { Zone } from './zone';

const TURN_RATE = 7;
const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function turnToward(cur: number, target: number, maxStep: number): number {
  const d = angleDiff(cur, target);
  if (Math.abs(d) <= maxStep) return target;
  return cur + (d > 0 ? maxStep : -maxStep);
}

/** Per-agent pseudo-random in [0, 1), advancing with a counter (visual variation only). */
function rnd(a: Agent, salt: number): number { return hash01(a.personId, a.counter++, salt); }

function setAnim(a: Agent, anim: AnimState): void {
  const d = a.draw;
  if (d.anim !== anim) { d.anim = anim; d.animTime = 0; }
}

const WORK_ANIMS: ReadonlySet<AnimState> = new Set<AnimState>([
  'work_hoe', 'work_scythe', 'work_sickle', 'work_sow', 'work_hammer', 'work_axe', 'work_pick', 'work_saw', 'work_dig', 'work_stir',
  'work_lift', 'work_spin', 'work_knead', 'work_milk',
]);

function warp(dist: number): number {
  return 1 + (WARP_MAX - 1) * smoothstep(WARP_NEAR, WARP_FAR, dist);
}

// ---------------------------------------------------------------------------------------------
// planning: from the schedule's intent to a target, a look and a way of being there
// ---------------------------------------------------------------------------------------------

function signature(I: Intent): number {
  let h = I.activity.length * 131 + (I.indoors ? 7 : 0) + (I.away ? 13 : 0) + I.mode * 17;
  h = (h * 31 + Math.round(I.x * 2)) | 0;
  h = (h * 31 + Math.round(I.z * 2)) | 0;
  h = (h * 31 + I.building) | 0;
  h = (h * 31 + I.anim.length * 3 + I.anim.charCodeAt(I.anim.length - 1)) | 0;
  h = (h * 31 + I.main.length * 5 + I.main.charCodeAt(0)) | 0;
  h = (h * 31 + I.carry.length) | 0;
  h = (h * 31 + I.group) | 0;
  return h;
}

/** Reads the schedule and (re)points the agent: new target, look and behaviour when anything changed. */
export function replan(z: Zone, a: Agent, spawning: boolean): void {
  const I = z.I;
  z.sched.intent(a.person, z.now, I);
  a.replanAt = Math.min(I.until, z.now + 0.025 + 0.01 * ((a.personId * 7) % 5));
  const sig = signature(I);
  if (sig === a.sig && !spawning) return;
  const hadSpot = a.sig !== 0;
  a.sig = sig;
  a.activity = I.away ? 'travel' : I.activity;
  a.intentLabel = I.label;
  a.mode = I.mode;
  a.group = I.group;
  a.anim = I.anim === 'walk' || I.anim === 'run' || I.anim === 'carry_walk' ? 'idle' : I.anim;
  a.main = I.main; a.off = I.off; a.carry = I.carry; a.back = I.back; a.seat = I.seat;
  a.radiusWander = I.radius;
  a.facing = NaN;
  a.leg = 0; a.ph = Ph.Work; a.timer = WORK_ANIMS.has(a.anim) ? 6 + 24 * rnd(a, 3) : 2 + 8 * rnd(a, 3);
  a.bx = I.bx; a.bz = I.bz;
  a.wantIn = false; a.wantAway = false;
  a.building = I.building;
  a.tyaw = I.yaw;
  if (I.away) {
    a.wantAway = true;
    a.tx = Number.isFinite(I.exitX) ? I.exitX : I.x; a.tz = Number.isFinite(I.exitZ) ? I.exitZ : I.z;
    a.carry = I.carry;
  } else if (I.indoors && I.building >= 0) {
    a.wantIn = true;
    if (z.nav.doorInto(I.building, z.door)) { a.tx = z.door.x; a.tz = z.door.z; a.tyaw = z.door.yaw; } else { a.tx = I.x; a.tz = I.z; }
  } else {
    a.tx = I.x; a.tz = I.z;
  }
  // props now (walking agents show them too: a sack on the shoulder, a hoe in hand)
  const d = a.draw;
  d.mainHand = a.main; d.offHand = a.off; d.back = a.back;
  d.carry = a.mode === Mode.Errand ? 'none' : a.carry;
  d.seatHeight = a.anim === 'sit' ? a.seat : 0;
  if (a.wantAway && a.carry === 'none') d.carry = 'none';
  a.stuck = 0;
  const dist = Math.hypot(a.tx - a.x, a.tz - a.z);
  if (!hadSpot && !spawning) return;
  if (dist > (a.wantIn || a.wantAway ? 0.9 : 1.3)) goTo(z, a, a.tx, a.tz, 1);
  else if (a.wantIn) { a.st = St.Door; } else { a.st = St.Idle; a.timer = 1 + 5 * rnd(a, 4); }
}

/**
 * Finishes a trip nobody can see: the person is simply there. A person bound for a door goes in, one
 * leaving the settlement is gone.
 */
function teleport(z: Zone, a: Agent, tx: number, tz: number): void {
  if (a.wantIn || a.wantAway) { a.dead = true; return; }
  const out = z.tmpP;
  if (z.nav.nearestWalkable(tx, tz, 2.5, out)) { tx = out.x; tz = out.z; }
  a.x = tx; a.z = tz; a.y = z.nav.groundY(tx, tz);
  a.pathN = a.pathI = 0; a.st = St.Idle; a.stuck = 0;
  legDone(z, a);
}

/** A path that starts out of sight: the walker joins it where it comes into view (or the trip is skipped). */
function enterSeen(z: Zone, a: Agent): void {
  const fx = z.focusX, fz = z.focusZ, R = SEEN_RADIUS;
  let px = a.x, pz = a.z;
  for (let i = 0; i < a.pathN; i++) {
    const qx = a.path[i * 2], qz = a.path[i * 2 + 1];
    const dx = qx - px, dz = qz - pz;
    const ox = px - fx, oz = pz - fz;
    const A = dx * dx + dz * dz, B = 2 * (ox * dx + oz * dz), C = ox * ox + oz * oz - R * R;
    if (C <= 0) return;
    const disc = B * B - 4 * A * C;
    if (A > 1e-6 && disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t >= 0 && t <= 1) {
        a.x = px + dx * t; a.z = pz + dz * t; a.y = z.nav.groundY(a.x, a.z);
        // drop the waypoints already passed
        const keep = a.pathN - i;
        for (let k = 0; k < keep; k++) { a.path[k * 2] = a.path[(i + k) * 2]; a.path[k * 2 + 1] = a.path[(i + k) * 2 + 1]; }
        a.pathN = keep; a.pathI = 0;
        return;
      }
    }
    px = qx; pz = qz;
  }
  teleport(z, a, a.tx, a.tz);
}

/** Heads for (tx, tz): straight when close and clear, else through the path finder. */
export function goTo(z: Zone, a: Agent, tx: number, tz: number, pace: number): void {
  a.paceScale = pace;
  const dx = tx - a.x, dz = tz - a.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 0.45) { a.st = St.Idle; a.pathN = a.pathI = 0; return; }
  if (a.control === 'ai' && d > 6) {
    // out of sight and not coming into it: no need to walk
    const fx = z.focusX, fz = z.focusZ;
    if (a.distFocus > SEEN_RADIUS && Math.hypot(tx - fx, tz - fz) > SEEN_RADIUS && distToSegment(fx, fz, a.x, a.z, tx, tz) > SEEN_RADIUS) {
      teleport(z, a, tx, tz);
      return;
    }
    if (!z.nav.grid.inWindow(Math.floor(tx / 2), Math.floor(tz / 2))) { a.setDirect(tx, tz); a.st = St.Walk; return; }
  }
  if (d < 9 && z.nav.finder.lineClear(a.x, a.z, tx, tz)) { a.setDirect(tx, tz); a.st = St.Walk; return; }
  a.st = St.Wait;
  a.pathAsked = z.zoneT;
  z.nav.queue.request({
    owner: a.personId, fx: a.x, fz: a.z, tx, tz, maxLength: 0, priority: a.distFocus,
    done: (ok, buf) => {
      if (a.dead || a.st !== St.Wait) return;
      if (ok && buf.n > 0) {
        a.setPath(buf.x, buf.z, buf.n); a.st = St.Walk; a.pathFails = 0;
        if (a.control === 'ai' && a.distFocus > SEEN_RADIUS) enterSeen(z, a);
        return;
      }
      a.pathFails++;
      // no route (the goal lies beyond the navigation window, or is sealed in): walk straight at it when it is
      // close or far from the player's eyes; stuck handling folds the body back if it cannot get there
      if (d > 3 && (d < 24 || a.distFocus > 150) && a.pathFails < 4) { a.setDirect(tx, tz); a.st = St.Walk; return; }
      // nowhere to go from here: stay put and look again a little later (or just be there when unseen)
      a.st = St.Idle; a.replanAt = z.now + 0.04;
      if (a.distFocus > 90 && a.pathFails >= 2) { a.x = tx; a.z = tz; a.y = z.nav.groundY(tx, tz); }
    },
  });
}

// ---------------------------------------------------------------------------------------------
// the step
// ---------------------------------------------------------------------------------------------

export function updateAgent(z: Zone, a: Agent, dt: number): void {
  a.dx = 0; a.dz = 0; a.dy = 0;
  const x0 = a.x, z0 = a.z, y0 = a.y;
  const d = a.draw;
  d.animTime += dt * z.clockSpeed;
  if (d.animTime > 3600) d.animTime -= 3600;

  if (a.control === 'held') hold(z, a, dt);
  else if (a.control === 'script') script(z, a, dt);
  else {
    if (z.now >= a.replanAt) replan(z, a, false);
    switch (a.st) {
      case St.Wait: waiting(z, a, dt); break;
      case St.Walk: walk(z, a, dt); break;
      case St.Idle: atSpot(z, a, dt); break;
      case St.Door: atDoor(z, a, dt); break;
      case St.Ghost: ghost(z, a, dt); break;
    }
    reactions(z, a, dt);
  }
  // overlay animations (a kneel, a wave) win over the routine
  if (a.overlay !== '' && z.zoneT < a.overlayUntil) setAnim(a, a.overlay);
  else if (a.overlay !== '') a.overlay = '';

  a.dx = a.x - x0; a.dz = a.z - z0;
  if (a.dx !== 0 || a.dz !== 0) { a.y = z.nav.groundY(a.x, a.z); }
  a.dy = a.y - y0;
  const v = Math.sqrt(a.dx * a.dx + a.dz * a.dz) / dt;
  a.speed = v;
  d.moveSpeed = v * z.clockSpeed;
  // speech bubble
  if (a.speech !== null) {
    if (z.zoneT >= a.speechUntil) { a.speech = null; d.label = z.debugLabels ? a.intentLabel : undefined; } else d.label = a.speech;
  } else if (z.debugLabels) d.label = `${a.person.first}: ${a.intentLabel}`;
}

function waiting(z: Zone, a: Agent, dt: number): void {
  // keep the pose of the place while the path is being found (usually a frame or two)
  void dt;
  restLook(a);
  if (z.zoneT - a.pathAsked > 6) { a.st = St.Idle; a.replanAt = 0; }
}

function restLook(a: Agent): void {
  if (a.st === St.Walk) return;
  setAnim(a, a.ph === Ph.Break ? 'idle' : a.anim);
}

// ---------------------------------------------------------------------------------------------
// walking
// ---------------------------------------------------------------------------------------------

function walk(z: Zone, a: Agent, dt: number): void {
  if (a.pathI >= a.pathN) { arrive(z, a); return; }
  let wx = a.path[a.pathI * 2], wz = a.path[a.pathI * 2 + 1];
  let dx = wx - a.x, dz = wz - a.z;
  let dist = Math.sqrt(dx * dx + dz * dz);
  const last = a.pathI === a.pathN - 1;
  if (dist < (last ? 0.4 : 0.9)) {
    a.pathI++;
    if (a.pathI >= a.pathN) { arrive(z, a); return; }
    wx = a.path[a.pathI * 2]; wz = a.path[a.pathI * 2 + 1];
    dx = wx - a.x; dz = wz - a.z; dist = Math.sqrt(dx * dx + dz * dz);
  }
  if (dist < 1e-4) return;
  const lastLeg = a.pathI === a.pathN - 1;
  let v = a.baseSpeed * a.paceScale * warp(a.distFocus);
  if (lastLeg && dist < 1.8) v *= 0.5 + 0.5 * (dist / 1.8);
  // terrain: roads quick, mud slow
  if (a.counter % 6 === 0) a.tf = z.nav.speedFactor(a.x, a.z) || 0.6;
  a.counter++;
  v *= a.tf;
  // step away from others (ranks, the player) while keeping the way
  z.separation(a);
  let vx = (dx / dist) * v + z.sepX, vz = (dz / dist) * v + z.sepZ;
  const sp = Math.sqrt(vx * vx + vz * vz);
  const cap = v * 1.35 + 0.2;
  if (sp > cap) { vx *= cap / sp; vz *= cap / sp; }
  const mr = z.mr;
  z.nav.move(a.x, a.z, vx * dt, vz * dt, a.radius, mr);
  a.x = mr.x; a.z = mr.z;
  // walkers who have left the area people can see finish their trip out of sight
  if (a.control === 'ai' && a.distFocus > SEEN_RADIUS + 10 && a.pathN > 0) {
    const ex = a.path[(a.pathN - 1) * 2], ez = a.path[(a.pathN - 1) * 2 + 1];
    if (Math.hypot(ex - z.focusX, ez - z.focusZ) > SEEN_RADIUS + 10 && Math.hypot(ex - a.x, ez - a.z) > 10) { teleport(z, a, ex, ez); return; }
  }
  if (mr.wading) a.wading = true; else a.wading = false;
  // face the way of travel
  const want = Math.atan2(vx, vz);
  a.yaw = turnToward(a.yaw, want, TURN_RATE * dt);
  // animation
  const sp2 = Math.sqrt(vx * vx + vz * vz);
  if (a.overlay === '') {
    // 'run' only when the person is really running; people hurrying far from the focus (time warp) just walk
    const loaded = a.draw.carry !== 'none';
    const pace = sp2 / Math.max(0.3, warp(a.distFocus));
    setAnim(a, loaded && pace < 2.4 ? 'carry_walk' : pace > 2.35 ? 'run' : 'walk');
  }
  // stuck? (walking into something that will not give)
  a.progT += dt;
  if (a.progT >= 0.9) {
    const moved2 = Math.hypot(a.x - a.progX, a.z - a.progZ);
    a.progT = 0; a.progX = a.x; a.progZ = a.z;
    if (moved2 < 0.1 * Math.max(0.5, v)) {
      a.stuck += 0.9;
      if (a.stuck >= 1.8 && a.stuck < 2.7 || a.stuck >= 5) { goTo(z, a, a.tx, a.tz, a.paceScale); }
      if (a.stuck >= 3.6) { a.pathI = Math.min(a.pathN - 1, a.pathI + 1); }
      if (a.stuck >= 9 && a.distFocus > 25) { a.x = a.tx; a.z = a.tz; a.y = z.nav.groundY(a.x, a.z); arrive(z, a); }
      else if (a.stuck >= 14) a.dead = true;
    } else a.stuck = 0;
  }
}

function arrive(z: Zone, a: Agent): void {
  a.pathN = 0; a.pathI = 0; a.stuck = 0;
  a.st = St.Idle;
  if (a.wantAway) {
    // left the settlement (a gate, the edge of the village): fold back into the macro tier
    a.dead = true;
    return;
  }
  if (a.wantIn) { a.st = St.Door; return; }
  legDone(z, a);
}

/** What follows reaching a waypoint of the micro-behaviour. */
function legDone(z: Zone, a: Agent): void {
  switch (a.mode) {
    case Mode.Errand: case Mode.Patrol:
      // a long pause at the home end, a short one at the far end, so errand runners are not forever on the move
      if (a.leg === 1) { a.leg = 2; a.timer = a.mode === Mode.Patrol ? 3 + 5 * rnd(a, 5) : 2 + 3 * rnd(a, 5); a.draw.carry = a.mode === Mode.Errand ? a.carry : 'none'; }
      else if (a.leg === 3) { a.leg = 0; a.timer = a.mode === Mode.Patrol ? 5 + 8 * rnd(a, 6) : 8 + 22 * rnd(a, 6); a.draw.carry = 'none'; }
      else { a.leg = 0; a.timer = 2 + 8 * rnd(a, 7); }
      break;
    case Mode.Wander: a.leg = 0; a.timer = 3 + 7 * rnd(a, 8); break;
    case Mode.Play: a.timer = 0.4 + 2.2 * rnd(a, 9); setAnim(a, 'idle'); break;
    case Mode.Furrow: a.ph = Ph.Work; a.timer = 9 + 9 * rnd(a, 10); break;
    default: a.timer = 1 + 4 * rnd(a, 11); break;
  }
  a.paceScale = 1;
  void z;
}

// ---------------------------------------------------------------------------------------------
// at the spot
// ---------------------------------------------------------------------------------------------

function atSpot(z: Zone, a: Agent, dt: number): void {
  a.timer -= dt;
  const d = a.draw;
  a.stuck = 0;
  switch (a.mode) {
    case Mode.Wander: wander(z, a, dt); break;
    case Mode.Errand: errand(z, a, dt, false); break;
    case Mode.Patrol: errand(z, a, dt, true); break;
    case Mode.Play: play(z, a, dt); break;
    case Mode.Shoot: shoot(z, a, dt); break;
    case Mode.Furrow: furrow(z, a, dt); break;
    default: stay(z, a, dt); break;
  }
  // chatting: look at the others of the group
  if (a.group >= 0 && a.mode !== Mode.Errand) faceGroup(z, a);
  // turn to the facing
  const f = Number.isFinite(a.facing) ? a.facing : a.tyaw;
  if (a.mode !== Mode.Play || a.ph !== Ph.Run) a.yaw = turnToward(a.yaw, f, TURN_RATE * 0.6 * dt);
  // drift back to the spot when jostled
  if (a.mode === Mode.Stay || a.mode === Mode.Furrow) {
    const ex = a.tx - a.x, ez = a.tz - a.z;
    const e = Math.sqrt(ex * ex + ez * ez);
    if (e > 0.5 && a.st === St.Idle && a.overlay === '') { goTo(z, a, a.tx, a.tz, 0.6); }
  }
  void d;
}

function stay(z: Zone, a: Agent, dt: number): void {
  void z; void dt;
  const d = a.draw;
  if (WORK_ANIMS.has(a.anim)) {
    // work in bouts with a pause between: stretch, a drink, a look round
    if (a.timer <= 0) {
      if (a.ph === Ph.Work) { a.ph = Ph.Break; a.timer = 2.2 + 4 * rnd(a, 12); a.breakAnim = rnd(a, 13) < 0.3 ? 'drink' : 'idle'; }
      else { a.ph = Ph.Work; a.timer = 12 + 26 * rnd(a, 14); }
    }
    setAnim(a, a.ph === Ph.Break ? a.breakAnim : a.anim);
    d.mainHand = a.ph === Ph.Break && a.breakAnim === 'drink' ? 'none' : a.main;
    return;
  }
  setAnim(a, a.anim);
  d.carry = a.anim === 'carry_walk' ? 'none' : (a.mode === Mode.Errand ? 'none' : a.carry);
}

function wander(z: Zone, a: Agent, dt: number): void {
  void dt;
  setAnim(a, a.anim === 'carry_walk' ? 'idle' : a.anim);
  if (a.timer > 0) return;
  // drift to another point near the spot, as shoppers and loiterers do
  const ang = rnd(a, 15) * TWO_PI, r = Math.sqrt(rnd(a, 16)) * Math.max(1, a.radiusWander);
  const nx = a.tx + Math.cos(ang) * r, nz = a.tz + Math.sin(ang) * r;
  a.leg = 1;
  a.timer = 1;
  if (z.nav.walkable(nx, nz) && z.nav.finder.lineClear(a.x, a.z, nx, nz)) {
    a.setDirect(nx, nz); a.st = St.Walk; a.paceScale = 0.55;
    a.facing = NaN;
  } else a.timer = 1.5 + 3 * rnd(a, 17);
  if (a.draw.carry === 'none' && a.carry !== 'none' && a.anim === 'carry_walk') a.draw.carry = a.carry;
}

function errand(z: Zone, a: Agent, dt: number, patrol: boolean): void {
  void dt;
  const d = a.draw;
  // idle at either end of the route, then go the other way
  if (a.leg === 0 || a.leg === 2) {
    setAnim(a, patrol ? 'idle' : (a.leg === 2 ? 'work_lift' : (WORK_ANIMS.has(a.anim) ? a.anim : 'idle')));
    d.carry = a.leg === 2 && !patrol ? a.carry : 'none';
    if (a.timer > 0) return;
    if (a.leg === 0) { a.leg = 1; goTo(z, a, a.bx, a.bz, patrol ? 0.8 : 0.95); }
    else { a.leg = 3; goTo(z, a, a.tx, a.tz, patrol ? 0.8 : 0.95); }
    d.carry = a.mode === Mode.Errand ? a.carry : 'none';
  }
}

function play(z: Zone, a: Agent, dt: number): void {
  void dt;
  a.ph = Ph.Run;
  if (a.timer > 0) { setAnim(a, 'idle'); return; }
  // chase or flee from another child, or race to a spot on the green
  let tx: number, tz: number;
  let pace = 0.9 + 0.5 * rnd(a, 18);
  const n = z.grid.query(a.x, a.z, 11, z.nbuf);
  let mate: Agent | null = null;
  if (n > 1 && rnd(a, 19) < 0.5) {
    for (let k = 0; k < n; k++) {
      const b = z.agentsArr[z.nbuf[k]];
      if (b !== a && !b.dead && b.mode === Mode.Play && b.st === St.Idle) { mate = b; break; }
    }
  }
  if (mate) {
    const ang = rnd(a, 20) * TWO_PI;
    tx = mate.x + Math.cos(ang) * 1.1; tz = mate.z + Math.sin(ang) * 1.1;
    mate.timer = Math.min(mate.timer, 0.25);
    pace = 1.1;
  } else {
    const ang = rnd(a, 21) * TWO_PI, r = (0.3 + 0.7 * rnd(a, 22)) * Math.max(3, a.radiusWander);
    tx = a.tx + Math.cos(ang) * r; tz = a.tz + Math.sin(ang) * r;
  }
  if (!z.nav.walkable(tx, tz)) { a.timer = 0.8; return; }
  a.runPace = true;
  a.paceScale = pace * (RUN_SPEED / a.baseSpeed) * 0.75;
  if (z.nav.finder.lineClear(a.x, a.z, tx, tz)) { a.setDirect(tx, tz); a.st = St.Walk; } else { a.timer = 0.8; }
}

function shoot(z: Zone, a: Agent, dt: number): void {
  void z; void dt;
  const d = a.draw;
  d.mainHand = 'longbow'; d.back = 'quiver';
  // draw, aim, loose, then a pause to fetch an arrow
  if (a.timer <= 0) {
    switch (a.ph) {
      case Ph.Draw: a.ph = Ph.Aim; a.timer = 0.9 + 1.6 * rnd(a, 23); break;
      case Ph.Aim: a.ph = Ph.Loose; a.timer = 0.75; break;
      case Ph.Loose: a.ph = Ph.Rest; a.timer = 1.8 + 3.5 * rnd(a, 24); break;
      default: a.ph = Ph.Draw; a.timer = 1.15; break;
    }
  }
  setAnim(a, a.ph === Ph.Draw ? 'draw_bow' : a.ph === Ph.Aim ? 'aim_bow' : a.ph === Ph.Loose ? 'shoot_bow' : 'idle');
  a.facing = a.tyaw;
}

function furrow(z: Zone, a: Agent, dt: number): void {
  void dt;
  if (a.ph === Ph.Break) {
    setAnim(a, a.breakAnim);
    if (a.timer <= 0) { a.ph = Ph.Work; a.timer = 8 + 10 * rnd(a, 25); }
    return;
  }
  setAnim(a, a.anim);
  a.draw.mainHand = a.main;
  if (a.timer > 0) return;
  if (rnd(a, 26) < 0.2) { a.ph = Ph.Break; a.timer = 2 + 3.5 * rnd(a, 27); a.breakAnim = rnd(a, 28) < 0.4 ? 'drink' : 'idle'; a.draw.mainHand = a.breakAnim === 'drink' ? 'none' : a.main; return; }
  // a pace or two along the strip, turning at the ends
  a.stepsDone++;
  if (a.stepsDone > 7) { a.stepsDone = 0; a.stepDir = -a.stepDir; }
  const step = 1.1 * a.stepDir;
  const nx = a.tx + Math.sin(a.tyaw) * step, nz = a.tz + Math.cos(a.tyaw) * step;
  if (z.nav.walkable(nx, nz)) { a.tx = nx; a.tz = nz; a.setDirect(nx, nz); a.st = St.Walk; a.paceScale = 0.45; a.leg = 1; a.facing = a.tyaw; }
  else { a.stepDir = -a.stepDir; a.timer = 3; }
}

function faceGroup(z: Zone, a: Agent): void {
  if (a.counter % 30 !== 0) { a.counter++; return; }
  a.counter++;
  const n = z.grid.query(a.x, a.z, 4.5, z.nbuf);
  let best: Agent | null = null, bd = 1e9;
  for (let k = 0; k < n; k++) {
    const b = z.agentsArr[z.nbuf[k]];
    if (b === a || b.dead || b.group !== a.group || b.st !== St.Idle) continue;
    const dd = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
    if (dd < bd) { bd = dd; best = b; }
  }
  if (best) { a.facing = yawTo(a.x, a.z, best.x, best.z); setAnim(a, 'talk'); }
  else if (a.anim === 'talk') { a.facing = NaN; setAnim(a, 'idle'); }
}

// ---------------------------------------------------------------------------------------------
// doors
// ---------------------------------------------------------------------------------------------

function atDoor(z: Zone, a: Agent, dt: number): void {
  void dt;
  setAnim(a, 'idle');
  a.draw.carry = a.carry === 'child' ? 'child' : a.draw.carry;
  if (a.building < 0) { a.dead = true; return; }
  a.yaw = turnToward(a.yaw, a.tyaw + Math.PI, TURN_RATE * 0.5 * dt);
  const free = z.doorNext.get(a.building) ?? 0;
  if (z.zoneT < free) return;
  z.doorNext.set(a.building, z.zoneT + 0.7);
  // step through the door: one metre towards the building, then gone
  a.st = St.Ghost;
  a.ghostX = a.x - Math.sin(a.tyaw) * 1.5; a.ghostZ = a.z - Math.cos(a.tyaw) * 1.5;
}

function ghost(z: Zone, a: Agent, dt: number): void {
  const dx = a.ghostX - a.x, dz = a.ghostZ - a.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const v = 1.5 * dt;
  setAnim(a, a.draw.carry !== 'none' ? 'carry_walk' : 'walk');
  a.draw.moveSpeed = 1.5 * z.clockSpeed;
  a.yaw = turnToward(a.yaw, Math.atan2(dx, dz), TURN_RATE * dt);
  if (d <= v) { a.x = a.ghostX; a.z = a.ghostZ; a.dead = true; return; }
  a.x += (dx / d) * v; a.z += (dz / d) * v;
}

// ---------------------------------------------------------------------------------------------
// held and scripted
// ---------------------------------------------------------------------------------------------

function hold(z: Zone, a: Agent, dt: number): void {
  setAnim(a, a.heldFace ? 'talk' : 'idle');
  const other = a.heldFace ? z.positionOf(a.heldFace) : null;
  if (other) a.yaw = turnToward(a.yaw, yawTo(a.x, a.z, other.x, other.z), TURN_RATE * dt);
  a.draw.carry = 'none';
  if (z.zoneT > a.heldUntil) { a.control = 'ai'; a.replanAt = 0; }
}

function script(z: Zone, a: Agent, dt: number): void {
  const o = a.order;
  if (!o) {
    setAnim(a, 'idle');
    // unordered summoned people face the player
    const p = z.player;
    if (p && a.summoned) a.yaw = turnToward(a.yaw, yawTo(a.x, a.z, p.x, p.z), TURN_RATE * 0.5 * dt);
    return;
  }
  a.orderT += dt;
  switch (o.kind) {
    case 'goto':
      if (a.st === St.Walk) { walk(z, a, dt); return; }
      if (a.st === St.Wait) { waiting(z, a, dt); return; }
      if (a.orderT < dt * 1.5) { goTo(z, a, o.x, o.z, o.run ? 2.2 : 1.1); return; }
      a.order = null; setAnim(a, 'idle');
      return;
    case 'follow': {
      const lead = z.positionOf(o.leader);
      if (!lead) { setAnim(a, 'idle'); return; }
      const dist = Math.hypot(lead.x - a.x, lead.z - a.z);
      const want = o.distance ?? 2.2;
      if (a.st === St.Walk) {
        // keep to the leader's pace
        a.paceScale = clamp(0.8 + (dist - want) / 5, 0.7, 2.4);
        walk(z, a, dt);
        if (dist < want + 0.3) { a.st = St.Idle; a.pathN = a.pathI = 0; }
        return;
      }
      if (a.st === St.Wait) { waiting(z, a, dt); return; }
      setAnim(a, 'idle');
      a.yaw = turnToward(a.yaw, yawTo(a.x, a.z, lead.x, lead.z), TURN_RATE * 0.5 * dt);
      if (dist > want + 1.6) goTo(z, a, lead.x, lead.z, clamp(0.9 + (dist - want) / 6, 0.9, 2.3));
      return;
    }
    case 'face': {
      const t = z.positionOf(o.target);
      setAnim(a, 'idle');
      if (t) a.yaw = turnToward(a.yaw, yawTo(a.x, a.z, t.x, t.z), TURN_RATE * dt);
      return;
    }
    case 'perform':
      setAnim(a, o.anim);
      if (o.mainHand) a.draw.mainHand = o.mainHand;
      if (a.orderT >= o.seconds) endOrder(a);
      return;
    case 'flee': {
      const dx = a.x - o.from.x, dz = a.z - o.from.z;
      const d = Math.hypot(dx, dz) || 1;
      const sp = a.baseSpeed * 2.3;
      z.nav.move(a.x, a.z, (dx / d) * sp * dt, (dz / d) * sp * dt, a.radius, z.mr);
      a.x = z.mr.x; a.z = z.mr.z;
      a.yaw = turnToward(a.yaw, Math.atan2(dx, dz), TURN_RATE * dt);
      setAnim(a, 'run');
      if (a.orderT > 7 || d > 60) endOrder(a);
      return;
    }
    case 'resume': endOrder(a); return;
  }
}

/** An order is over: back to the routine, except for summoned people, who stay put until dismissed. */
export function endOrder(a: Agent): void {
  a.order = null;
  if (a.summoned) { a.st = St.Idle; return; }
  a.control = 'ai'; a.replanAt = 0; a.sig = 0;
}

// ---------------------------------------------------------------------------------------------
// reactions to the player
// ---------------------------------------------------------------------------------------------

function reactions(z: Zone, a: Agent, dt: number): void {
  const p = z.player;
  const d = a.draw;
  if (!p) { d.lookYaw = 0; return; }
  const dx = p.x - a.x, dz = p.z - a.z;
  const dist2 = dx * dx + dz * dz;
  if (dist2 > 100) {
    if (a.lookYaw !== 0) { a.lookYaw *= 0.9; if (Math.abs(a.lookYaw) < 0.01) a.lookYaw = 0; d.lookYaw = a.lookYaw; }
    return;
  }
  const dist = Math.sqrt(dist2);
  // glance at the player when they are near and roughly in front
  const rel = angleDiff(a.yaw, Math.atan2(dx, dz));
  const target = Math.abs(rel) < 2.0 && dist < 8 ? clamp(rel, -1.1, 1.1) : 0;
  a.lookYaw += (target - a.lookYaw) * Math.min(1, dt * 4);
  d.lookYaw = a.lookYaw;
  if (a.greetCool > 0) a.greetCool -= dt;
  if (a.overlay !== '' || a.st === St.Door || a.st === St.Ghost) return;
  if (dist > 3.4 || a.speech !== null) return;
  const playerTier = p.tier;
  // a lord passes: peasants kneel briefly (rarely all at once), kin wave, others greet
  if (a.greetCool <= 0) {
    if (z.canGreet()) {
      const kin = z.isKin(a, p.who);
      const sit: 'greet' | 'greet_superior' | 'greet_kin' = kin ? 'greet_kin' : playerTier >= a.tier + 2 ? 'greet_superior' : 'greet';
      if (playerTier >= 5 && a.tier <= 2 && a.st === St.Idle && a.anim !== 'sit' && hash01(a.personId, Math.floor(z.now), 41) < 0.35) {
        a.overlay = 'kneel'; a.overlayUntil = z.zoneT + 2.6;
      } else if (kin && dist > 1.2) {
        a.overlay = 'wave'; a.overlayUntil = z.zoneT + 1.9;
      }
      z.greet(a, sit);
      a.greetCool = 50 + 70 * hash01(a.personId, Math.floor(z.zoneT / 10), 42);
    }
  }
}

/** Is the person someone to step aside for (rank)? */
export function ageOf(z: Zone, a: Agent): number { return ageYears(a.person, z.now); }
export { hasFlag };
