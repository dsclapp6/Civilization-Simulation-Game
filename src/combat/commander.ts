// The AI commander (civilization pass, wave B; docs/WAR.md): the side's general. Every second and a half it looks at the field —
// the odds, the distance, who is engaged, how the men's hearts stand — and gives its groups the same orders the player gives his:
// advance in line, hold in a shield wall, loose the archers, charge the horse at the right moment, fall back when it is lost.
// It commands every man the player does not: the whole of the enemy's side, and the part of the player's own side that is not in
// his commanded layer (or all of it while he is down or gone).
import { dist, type P2 } from '../core/math';
import type { Arena, Fight } from './arena';
import type { Group } from './command';
import { S } from './fighter';

const THINK_EVERY = 1.6;
/** After the player's own order, the AI leaves a group alone this long (s). */
const PLAYER_ORDER_HOLD = 45;

const E = { x: 0, z: 0 } as P2;

export function commanderStep(a: Arena, fight: Fight, dt: number): void {
  const cmd = fight.cmd;
  if (!cmd) return;
  fight.cmdT -= dt;
  if (fight.cmdT > 0) return;
  fight.cmdT = THINK_EVERY;
  const pf = a.player;
  const playerActive = !!pf && pf.fight === fight.id && pf.active && pf.st !== S.Down;
  for (let s = 0; s < fight.sides.length; s++) decide(a, fight, s, playerActive);
}

function decide(a: Arena, fight: Fight, side: number, playerActive: boolean): void {
  const cmd = fight.cmd!;
  const mine: Group[] = [];
  let n = 0, theirs = 0, sx = 0, sz = 0, mor = 0, morN = 0;
  let enemyArchers = 0;
  for (const g of cmd.groups) {
    if (g.count === 0) continue;
    if (g.side === side) {
      n += g.count; sx += g.cx * g.count; sz += g.cz * g.count; mor += g.morale * g.count; morN += g.count;
      // the player's layer is the player's while he is up; the AI takes it when he is down
      if (g.layer === 1 && playerActive) continue;
      mine.push(g);
    } else {
      theirs += g.count;
      if (g.gk === 1) enemyArchers += g.count;
    }
  }
  if (n === 0 || theirs === 0 || mine.length === 0) return;
  const cx = sx / n, cz = sz / n;
  if (!cmd.enemyCentre(side, E)) return;
  const d = dist(cx, cz, E.x, E.z);
  const morale = morN > 0 ? mor / morN : 1;
  const ratio = n / theirs;
  const scene = fight.scene;
  const attacker = scene ? scene.attackerSide === side : side === 0;
  const defendingWalls = !!scene && !attacker;
  const lost = ratio < 0.32 && morale < 0.5 && d < 110 && !defendingWalls;
  const dirX = d > 0.1 ? (E.x - cx) / d : 0, dirZ = d > 0.1 ? (E.z - cz) / d : 1;

  for (const g of mine) {
    if (g.byPlayer && g.orderT < PLAYER_ORDER_HOLD) continue;
    const gd = dist(g.cx, g.cz, E.x, E.z);
    if (lost) { want(fight, g, 'retreat'); continue; }
    if (g.order === 'retreat' && morale > 0.6) { /* recovered: carry on below */ }
    if (scene) { siegeOrders(fight, g, attacker); continue; }
    switch (g.gk) {
      case 0: {
        // foot: the line
        const wall = enemyArchers > n * 0.25 && gd > 40 && ratio < 1.6;
        if (attacker) {
          if (gd > 22) want(fight, g, 'advance', { x: E.x - dirX * 9, z: E.z - dirZ * 9 }, wall ? 'shield_wall' : 'line');
          else want(fight, g, 'charge');
        } else if (gd > 24 && ratio < 1.5) {
          want(fight, g, 'hold', undefined, wall ? 'shield_wall' : 'line');
        } else want(fight, g, ratio >= 1.15 || gd < 24 ? 'charge' : 'hold', undefined, 'line');
        break;
      }
      case 1: {
        // archers: stand back, then shoot at will
        const range = 70;
        if (gd > range * 0.9) {
          if (attacker) want(fight, g, 'advance', { x: E.x - dirX * 48, z: E.z - dirZ * 48 }, 'loose');
          else want(fight, g, 'hold', undefined, 'loose');
        } else want(fight, g, 'loose', undefined, 'loose');
        break;
      }
      default: {
        // horse: wait on the flank, then ride them down when the foot are locked or the odds are good
        const footLocked = cmd.groups.some((x) => x.side === side && x.gk === 0 && x.engaged);
        const exposed = cmd.groups.some((x) => x.side !== side && x.gk === 1 && x.count > 0 && dist(x.cx, x.cz, g.cx, g.cz) < 70);
        // (a horse covers a hundred metres in ten seconds: the foot being locked is the moment, wherever the horse stood on the flank)
        const go = (footLocked && gd < 130) || (exposed && ratio > 0.7) || (gd < 30 && ratio > 1.0);
        // and a charge once begun is carried through: the horse does not draw rein because the men it rode to help have fallen
        if (go || g.order === 'charge') want(fight, g, 'charge');
        else want(fight, g, 'hold', { x: g.cx, z: g.cz }, 'line');
      }
    }
  }
}

/** Gives an order only when it is a change (a new kind, a formation, or a point that has moved), so the ranks are not re-formed every tick. */
function want(fight: Fight, g: Group, kind: Group['order'], at?: P2, formation?: Group['formation']): void {
  const cmd = fight.cmd;
  if (!cmd) return;
  if (formation && g.formation !== formation) cmd.give(g, { kind: 'formation', formation }, false);
  const same = g.order === kind && (!at || (g.at !== null && dist(g.at.x, g.at.z, at.x, at.z) < 12));
  if (same) return;
  if (kind === 'hold' && g.order === 'hold' && !at) return;
  cmd.give(g, { kind, ...(at ? { at } : {}) }, false);
}

/** Orders in a storm: the attackers close on the gate, the defenders hold behind it; the jobs (ram, ladders, stations) are the scene's. */
function siegeOrders(fight: Fight, g: Group, attacker: boolean): void {
  const scene = fight.scene!;
  if (attacker) {
    const open = scene.gateOpen();
    if (g.gk === 1) {
      // archers cover the assault from about forty metres off the walls
      const at = scene.stage(40);
      if (open) want(fight, g, 'loose');
      else want(fight, g, 'advance', at, 'loose');
    } else if (open || scene.breached()) {
      want(fight, g, 'charge');
    } else if (g.gk === 0) {
      want(fight, g, 'advance', scene.stage(16), 'shield_wall');
    } else want(fight, g, 'hold', scene.stage(55), 'line');
  } else {
    // defenders: hold the gate and the breach; archers not on a station stand behind the gate
    const at = scene.gateBack(g.gk === 1 ? 9 : 5);
    if (scene.breached() || scene.gateBroken()) want(fight, g, g.gk === 1 ? 'loose' : 'hold', at, g.gk === 1 ? 'loose' : 'shield_wall');
    else want(fight, g, 'hold', at, g.gk === 1 ? 'loose' : 'line');
  }
}
