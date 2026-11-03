// The player's way up on the walls and down again (docs/WAR.md §7): the stairs in the towers, the gatehouse and along the curtain,
// and the jump from the parapet. On the walk he walks and fights like anywhere (the navigation keeps him to the floors, the arena
// puts him among the men who hold the walk: only they can strike him in melee and he them). As defender or attacker, in a storm
// or in peace; a ladder in a storm (warActions.ts) brings him up the same way.
import type { Nav } from '../agents/nav';
import type { ActionOption, ActionOutcome, ActionProvider, TargetRef } from '../sim/actions';
import type { SimContext } from '../sim/context';
import type { PersonId } from '../sim/state';
import { R } from './fighter';
import type { Services } from './services';

export const WALK_PROVIDER_ID = 'wallwalk';

/** How near the foot of a flight of stairs, and its landing, the player must stand (m). */
const FOOT_REACH = 2.6;
const TOP_REACH = 3.4;

function opt(p: Pick<ActionOption, 'id' | 'label' | 'target' | 'priority' | 'seconds'> & Partial<ActionOption>): ActionOption {
  return { provider: WALK_PROVIDER_ID, enabled: true, category: 'combat', range: 999, ...p };
}

export function createWallWalkProvider(sv: Services): ActionProvider {
  const sim = sv.sim;
  const SELF: TargetRef = { kind: 'self' };
  const nav = (): Nav | null => {
    const n = sv.zone?.nav as Nav | undefined;
    return n && n.walls ? n : null;
  };

  return {
    id: WALK_PROVIDER_ID,

    list(_ctx: SimContext, actor: PersonId, target: TargetRef, out: ActionOption[]): void {
      if (target.kind !== 'self' && target.kind !== 'person') return;
      if (actor !== sim.state.run.playerId) return;
      const n = nav(), b = sv.player?.body();
      if (!n || !b) return;
      if (b.walk) {
        const st = n.walls.stairTopNear(b.x, b.z, b.y, TOP_REACH);
        if (st) {
          out.push(opt({ id: 'down', label: 'Go down the stairs', target: SELF, priority: 41, seconds: 2.4, anim: 'climb', preview: 'Down to the ground inside the wall', data: st.building }));
        }
        out.push(opt({ id: 'jump', label: 'Jump down from the wall', target: SELF, priority: 10, seconds: 0.5, preview: 'Over the parapet to the ground: a hard landing' }));
      } else {
        const st = n.walls.stairFootNear(b.x, b.z, FOOT_REACH);
        if (st) {
          out.push(opt({ id: 'up', label: 'Climb the stairs', target: SELF, priority: 41, seconds: 2.4, anim: 'climb', preview: 'Up onto the wall-walk', data: st.building }));
        }
      }
    },

    check(_ctx: SimContext, actor: PersonId, option: ActionOption): string | null {
      const n = nav(), b = sv.player?.body();
      if (!n || !b || actor !== sim.state.run.playerId) return 'You cannot do that now.';
      if (option.id === 'up') return !b.walk && n.walls.stairFootNear(b.x, b.z, FOOT_REACH + 1) ? null : 'You are away from the stairs.';
      if (option.id === 'down') return b.walk && n.walls.stairTopNear(b.x, b.z, b.y, TOP_REACH + 1) ? null : 'You are away from the stairs.';
      if (option.id === 'jump') return b.walk ? null : 'You are on the ground.';
      return null;
    },

    complete(_ctx: SimContext, actor: PersonId, option: ActionOption): ActionOutcome {
      const n = nav(), p = sv.player, b = p?.body();
      if (!n || !p || !b) return { ok: false };
      const pf = sv.arena.player && sv.arena.player.personId === actor ? sv.arena.player : null;
      switch (option.id) {
        case 'up': {
          const st = n.walls.stairFootNear(b.x, b.z, FOOT_REACH + 1);
          if (!st) return { ok: false, message: 'The stairs are gone.' };
          p.placeAt(st.top.x, st.top.z, st.yaw + Math.PI, st.y);
          if (p.body()?.walk) { if (pf) { pf.onWall = true; pf.role = R.Wall; } return { ok: true, message: 'You climb to the wall-walk.' }; }
          return { ok: false, message: 'The stairs are choked.' };
        }
        case 'down': {
          const st = n.walls.stairTopNear(b.x, b.z, b.y, TOP_REACH + 1);
          if (!st) return { ok: false, message: 'The stairs are gone.' };
          p.placeAt(st.foot.x, st.foot.z, st.yaw);
          return { ok: true, message: 'You go down to the ground.' };
        }
        case 'jump': {
          const ground = { x: b.x, z: b.z };
          const h = b.y - sv.zone!.nav.groundY(b.x, b.z);
          // the nearest ground: over the parapet outside, or inside, whichever is nearer
          let x = b.x, z = b.z;
          if (n.groundBeside(b.x, b.z, ground)) { x = ground.x; z = ground.z; }
          p.placeAt(x, z, b.yaw);
          if (h > 2.5) sv.sim.services.combat?.harm?.(actor, Math.min(0.9, 0.12 + h * 0.045), 'a fall from the wall');
          return { ok: true, message: h > 2.5 ? 'You drop to the ground with a jolt.' : 'You drop down.' };
        }
        default: return { ok: false };
      }
    },
  };
}
