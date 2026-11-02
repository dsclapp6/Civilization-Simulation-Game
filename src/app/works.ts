// The works seen: people you set to a building site (build mode, Works) go there in the working hours of the day and
// are seen at it round the footings — hammering, sawing, digging, carrying — while you are near enough to see. When the
// work is done, the day ends or you go away, they are handed back to their own day.
import type { ZoneApi } from '../agents/types';
import type { AnimState, HeldItem } from '../core/view';
import type { ConstructionApi } from '../sim/construction/types';
import type { Simulation } from '../sim/sim';
import type { PersonId } from '../sim/state';
import type { PlayerApi } from '../player/types';
import { BUILDINGS } from '../content/types';

const SEE = 220;
const TASKS: ReadonlyArray<{ anim: AnimState; hand: HeldItem }> = [
  { anim: 'work_hammer', hand: 'hammer' }, { anim: 'work_saw', hand: 'saw' }, { anim: 'work_dig', hand: 'spade' },
  { anim: 'work_lift', hand: 'none' }, { anim: 'work_pick', hand: 'pick' }, { anim: 'work_axe', hand: 'axe' },
];

export class WorksView {
  /** Who is at which site now. */
  private readonly at = new Map<PersonId, number>();
  private t = 0;

  constructor(private readonly sim: Simulation, private readonly zone: ZoneApi, private readonly player: PlayerApi) {}

  /** Call every frame; it looks again every two seconds. */
  update(dt: number, suspended: boolean): void {
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 2;
    const C = this.sim.services.construction as ConstructionApi | undefined;
    const me = this.player.body();
    const hour = (this.sim.absDay % 1) * 24;
    const want = new Map<PersonId, { site: number; x: number; z: number; yaw: number; task: number }>();
    if (C && me && !suspended && hour >= 6 && hour < 19) {
      for (const s of C.sites()) {
        if (s.status !== 'working' || Math.hypot(s.x - me.x, s.z - me.z) > SEE) continue;
        const def = BUILDINGS[s.kind];
        const ring = Math.max(def.w, def.d) / 2 + 1.1;
        C.workersAt(s.id).forEach((id, i, all) => {
          const a = (i / Math.max(1, all.length)) * Math.PI * 2 + s.id;
          const x = s.x + Math.cos(a) * ring, z = s.z + Math.sin(a) * ring;
          // facing the work
          want.set(id, { site: s.id, x, z, yaw: Math.atan2(s.x - x, s.z - z), task: (i + s.id) % TASKS.length });
        });
      }
    }
    // hand back those no longer wanted
    for (const [id] of this.at) {
      if (!want.has(id)) { this.zone.dismiss?.(id); this.at.delete(id); }
    }
    // bring the rest and keep them at it
    for (const [id, w] of want) {
      if (this.at.get(id) !== w.site) { this.zone.summon?.(id, w.x, w.z, w.yaw); this.at.set(id, w.site); }
      const task = TASKS[w.task];
      this.zone.command(id, { kind: 'perform', anim: task.anim, mainHand: task.hand, seconds: 2.5 });
    }
  }

  /** Everyone back to their day (leaving the game, a new character). */
  clear(): void {
    for (const [id] of this.at) this.zone.dismiss?.(id);
    this.at.clear();
  }
}
