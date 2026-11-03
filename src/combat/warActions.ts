// The player's verbs in a storm (civilization pass, wave B; docs/WAR.md): push the ram, climb a ladder, man a station on the
// wall. They are actions on the player himself (the action wheel's "self" target, E when nothing else is in front), offered only
// while he is in a storm and near the thing. They work through the scene: the ram feels his weight, a ladder carries him up, a
// station is his. The wall-walk is above the ground: the navigation stands a body up there (src/agents/nav/walls.ts), so he
// is placed on it and walks and fights on the walk (src/combat/wallwalk.ts has the stairs); if no floor is there (a wall already
// battered down), the climb ends inside the wall at the foot of the stairs, so the player is never left standing in the stone.
import { dist } from '../core/math';
import type { ActionOption, ActionOutcome, ActionProvider, TargetRef } from '../sim/actions';
import type { SimContext } from '../sim/context';
import { TRAIN_SCALE, trainStat } from '../sim/skills';
import type { PersonId } from '../sim/state';
import { R } from './fighter';
import type { Fighter } from './fighter';
import type { SiegeScene, Station, Work } from './scene';
import type { Services } from './services';

export const WAR_PROVIDER_ID = 'war';

/** How near the player must stand to a ram, a ladder's foot, a station (m). */
const RAM_REACH = 4.8;
const LADDER_REACH = 3.6;
const STATION_REACH = 14;
const CLIMB_SPEED = 0.8;

function opt(p: Pick<ActionOption, 'id' | 'label' | 'target' | 'priority' | 'seconds'> & Partial<ActionOption>): ActionOption {
  return { provider: WAR_PROVIDER_ID, enabled: true, category: 'combat', range: 999, ...p };
}

export function createWarProvider(sv: Services): ActionProvider {
  const sim = sv.sim;
  const SELF: TargetRef = { kind: 'self' };

  const stormOf = (actor: PersonId): { pf: Fighter; scene: SiegeScene } | null => {
    if (actor !== sim.state.run.playerId) return null;
    const pf = sv.arena.player;
    if (!pf || pf.person?.id !== actor || !pf.active || pf.fight === 0) return null;
    const scene = sv.arena.fights.get(pf.fight)?.scene;
    return scene ? { pf, scene } : null;
  };

  return {
    id: WAR_PROVIDER_ID,

    list(_ctx: SimContext, actor: PersonId, target: TargetRef, out: ActionOption[]): void {
      // "E with nothing in front" is the player himself; in a storm there is always a man in front (a comrade, an enemy), so the
      // verbs are offered under a person too — they act on the player, whoever he is looking at
      if (target.kind !== 'self' && target.kind !== 'person') return;
      const s = stormOf(actor);
      if (!s) return;
      const { pf, scene } = s;
      if (pf.side === scene.attackerSide) {
        const ram = scene.ramNear(pf.x, pf.z, RAM_REACH);
        if (ram) {
          out.push(opt({
            id: 'push', label: 'Push the ram', target: SELF, priority: 44, seconds: 3.2, anim: 'push', repeat: true,
            preview: 'Your weight on the beam: the gate gives sooner', data: ram.id,
          }));
        }
        const lad = scene.ladderNear(pf.x, pf.z, LADDER_REACH);
        if (lad) {
          out.push(opt({
            id: 'climb', label: 'Climb the ladder', target: SELF, priority: 46, seconds: Math.max(4, lad.length / CLIMB_SPEED), anim: 'climb',
            preview: 'Up to the wall-walk, into the defenders', data: lad.id,
          }));
        }
      } else {
        const st = scene.stationNear(pf.x, pf.z, STATION_REACH);
        if (st && !pf.onWall) {
          out.push(opt({
            id: 'man', label: 'Man the wall', target: SELF, priority: 40, seconds: 4, anim: 'climb',
            preview: 'Up the stairs to a place on the wall, to shoot from the height', data: st.id,
          }));
        }
      }
    },

    check(_ctx: SimContext, actor: PersonId, option: ActionOption): string | null {
      const s = stormOf(actor);
      if (!s) return 'The fight is over.';
      const { pf, scene } = s;
      if (option.id === 'push') {
        const ram = scene.ramNear(pf.x, pf.z, RAM_REACH + 1.5);
        return ram ? null : 'You are away from the ram.';
      }
      if (option.id === 'climb') {
        const lad = scene.workById(Number(option.data));
        if (!lad || lad.phase !== 'up') return 'The ladder is down.';
        return dist(pf.x, pf.z, lad.footX, lad.footZ) < LADDER_REACH + 1.5 ? null : 'You are away from the ladder.';
      }
      if (option.id === 'man') {
        const st = scene.stationById(Number(option.data));
        return st && (!st.holder || !st.holder.active) ? null : 'That place is taken.';
      }
      return null;
    },

    start(_ctx: SimContext, actor: PersonId, option: ActionOption): void {
      const s = stormOf(actor);
      if (!s) return;
      if (option.id === 'push') s.scene.pushers.add(s.pf);
      if (option.id === 'climb') { const w = s.scene.workById(Number(option.data)); if (w) w.playerBusy = true; }
    },

    cancel(_ctx: SimContext, actor: PersonId, option: ActionOption): void {
      const s = stormOf(actor);
      if (!s) return;
      s.scene.pushers.delete(s.pf);
      const w = option.id === 'climb' ? s.scene.workById(Number(option.data)) : null;
      if (w) w.playerBusy = false;
    },

    complete(ctx: SimContext, actor: PersonId, option: ActionOption): ActionOutcome {
      const s = stormOf(actor);
      if (!s) return { ok: false, message: 'The fight is over.' };
      const { pf, scene } = s;
      const me = ctx.state.persons.get(actor);
      switch (option.id) {
        case 'push':
          // stays in the crew while the action repeats; leaves it when it is stopped (cancel)
          if (me) trainStat(sim, me, 'str', 0.003 * TRAIN_SCALE);
          return { ok: true, message: 'You put your shoulder to the ram.' };
        case 'climb': {
          const w = scene.workById(Number(option.data));
          if (!w || !w.station) return { ok: false, message: 'The ladder is gone.' };
          w.playerBusy = false;
          const up = raiseTo(sv, pf, scene, w.station);
          w.landed++;
          return { ok: true, message: up ? 'You come over the parapet onto the wall-walk!' : 'You scale the wall and drop down on the inside, at the foot of the stairs.' };
        }
        case 'man': {
          const st = scene.stationById(Number(option.data));
          if (!st || (st.holder && st.holder.active)) return { ok: false, message: 'That place is taken.' };
          const up = raiseTo(sv, pf, scene, st);
          if (!up) return { ok: false, message: 'There is no way up here: the stairs are choked. You hold the foot of the wall.' };
          st.holder = pf;
          return { ok: true, message: 'You take a place on the wall.' };
        }
        default: return { ok: false };
      }
    },
  };
}

/**
 * Puts the player on the wall-walk at a station if the navigation can stand a body at that height; otherwise inside the wall at
 * the foot of the stairs. Returns whether he is up on the wall.
 */
function raiseTo(sv: Services, pf: Fighter, scene: SiegeScene, st: Station): boolean {
  const player = sv.player;
  if (!player) return false;
  const yawIn = Math.atan2(-Math.sin(st.yaw), -Math.cos(st.yaw));
  player.placeAt(st.x, st.z, st.yaw, st.y);
  const b = player.body();
  if (b && Math.abs(b.y - st.y) < 1.4) {
    pf.onWall = true;
    pf.station = st;
    pf.role = R.Wall;
    scene.pushers.delete(pf);
    return true;
  }
  player.placeAt(st.inx, st.inz, yawIn);
  pf.onWall = false;
  pf.station = null;
  return false;
}
