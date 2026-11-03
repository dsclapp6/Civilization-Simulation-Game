// Interiors in the world (docs/INTERIORS.md): the glue. The navigation is given the plans of insides (the building recipes) and
// the placement of the models; the renderer is told each frame which insides to draw and how far each door stands open; the
// player gets the verbs of doors — open, shut, knock, force — and "Go inside" / "Leave" for those who want them on the wheel, and
// sleeping in a bed of his own. Walking into a shut door opens it (unless it is locked, which is said), and it swings to behind.
import type { ActionOption, ActionProvider } from '../sim/actions';
import type { Simulation } from '../sim/sim';
import { fullName, type BuildingState, type PersonId } from '../sim/state';
import { interiorPlan } from '../assets/interiors/plan';
import { placedRot, placedY, WALL_PIECES, type WallPiece } from '../assets/buildings/placement';
import type { InteriorSource, Loaded } from '../agents/nav/interiors';
import { INSIDE_RADIUS } from '../agents/nav/interiors';
import type { Zone } from '../agents/zone';
import type { PlayerApi } from '../player/types';
import type { GameRenderer, InteriorsView } from '../render/types';
import { BUILDINGS } from '../content/types';

/** The plans and the placement of models, for the navigation (a pure function of the world and the buildings). */
export function interiorSource(world: Simulation['world'], buildings?: () => Iterable<WallPiece>): InteriorSource {
  return {
    plan: (kind, level, culture, seed) => interiorPlan(kind, level, culture, seed),
    place: (b) => {
      // a tower's door is not turned into a length of wall (placement.ts towerTurn): the renderer reads the same pieces
      const pieces = b.kind === 'tower' && buildings ? [...buildings()].filter((q) => WALL_PIECES.has(q.kind)) : undefined;
      const rot = placedRot(world, b, pieces);
      return { rot, y: placedY(world, b, rot) };
    },
  };
}

const FORCE_SECONDS = 4;

export class InteriorMode {
  private readonly view: InteriorsView;

  constructor(private readonly sim: Simulation, private readonly renderer: GameRenderer, private readonly player: PlayerApi, private readonly zone: Zone) {
    zone.nav.setInteriorSource(interiorSource(sim.world, () => sim.state.buildings.values()));
    const rooms: Array<{ id: number; plan: Loaded['plan']; inside: boolean; level: number }> = [];
    this.view = {
      rooms,
      doorAngle: (b, lx, lz) => zone.doors.angleAt(b, lx, lz),
    };
    renderer.setInteriors?.(() => this.frameView());
  }

  /** Inside a building now (the one whose rooms the player stands in), or null. */
  get where(): BuildingState | null {
    const r = this.zone.indoors.drawn.find((q) => q.inside);
    return r ? r.loaded.b : null;
  }
  /** Kept for the old callers: the game no longer leaves the world to go in. */
  get active(): boolean { return false; }

  private frameView(): InteriorsView {
    const rooms = this.view.rooms as Array<{ id: number; plan: Loaded['plan']; inside: boolean; level: number }>;
    rooms.length = 0;
    for (const r of this.zone.indoors.drawn) rooms.push({ id: r.id, plan: r.loaded.plan, inside: r.inside, level: r.level });
    return this.view;
  }

  /** Per frame (nothing: the player's body opens the doors it walks into, src/player/controller.ts bumpDoor). */
  update(): void { /* kept for the game loop */ }

  /** The nearest usable door of a loaded building to the player (index), within `r` metres. */
  private nearestDoor(bid: number, r: number): { l: Loaded; i: number; dist: number } | null {
    const l = this.zone.nav.interiors.loaded.get(bid);
    const b = this.player.body?.();
    if (!l || !b) return null;
    const loc = this.zone.nav.interiors.toLocal(l, b.x, b.z, { x: 0, z: 0 });
    let best = -1, bd = r;
    l.plan.doors.forEach((d, i) => {
      if (d.kind === 'small' || d.kind === 'arch' || d.open) return;
      if (Math.abs(d.y + l.y - b.y) > 1.4) return;
      const dd = Math.hypot(d.x - d.nx * d.t * 0.5 - loc.x, d.z - d.nz * d.t * 0.5 - loc.z);
      if (dd < bd) { bd = dd; best = i; }
    });
    return best >= 0 ? { l, i: best, dist: bd } : null;
  }

  /** The doors' verbs, "Go inside" / "Leave", sleeping in one's bed. */
  provider(): ActionProvider {
    return {
      id: 'interior',
      list: (ctx, actor, target, out: ActionOption[]) => {
        if (actor !== this.sim.state.run.playerId) return;
        const me = this.sim.state.persons.get(actor);
        if (!me) return;
        const inside = this.where;
        if (target.kind === 'self') {
          if (inside) {
            out.push({ id: 'leave', provider: 'interior', label: 'Leave', category: 'travel', target, priority: 2, enabled: true, seconds: 0, range: 999, preview: `Out of the ${BUILDINGS[inside.kind].name.toLowerCase()}` });
            const bed = this.myBed(actor);
            if (bed) out.push({ id: 'bed', provider: 'interior', label: 'Sleep in your bed', category: 'rest', target, priority: 9, enabled: true, seconds: 0, range: 999, preview: 'Lie down and sleep until dawn' });
          }
          return;
        }
        if (target.kind !== 'building') return;
        const b = this.sim.state.buildings.get(target.id);
        if (!b) return;
        const nd = this.nearestDoor(b.id, 2.6);
        if (nd) {
          const d = nd.l.plan.doors[nd.i];
          const open = this.zone.doors.isOpen(b.id, nd.i);
          const lock = d.outer ? this.zone.doors.lockFor(me, b, nd.i) : { locked: false, why: '' };
          const label = d.outer ? (open ? 'Shut the door' : 'Open the door') : (open ? 'Shut the chamber door' : 'Open the chamber door');
          out.push({
            id: open ? 'door.shut' : 'door.open', provider: 'interior', label, category: 'use', target, priority: 9, enabled: open || !lock.locked,
            reason: !open && lock.locked ? lock.why : undefined, seconds: 0, range: 4, data: nd.i,
          });
          if (!open && lock.locked) {
            out.push({ id: 'door.knock', provider: 'interior', label: 'Knock', category: 'social', target, priority: 8, enabled: true, seconds: 1.5, range: 4, data: nd.i, preview: 'Ask to be let in' });
            out.push({ id: 'door.force', provider: 'interior', label: 'Force the door', category: 'use', target, priority: 1, enabled: true, seconds: FORCE_SECONDS, range: 4, data: nd.i, preview: 'Break in — a crime the law will hear of', anim: 'work_lift' } as ActionOption);
          }
        }
        // "Go inside" for those who want it on the wheel: through the main door, if it may be opened
        const l = this.zone.nav.interiors.loaded.get(b.id);
        if (l && l.plan.main >= 0 && !inside) {
          const lock = this.zone.doors.lockFor(me, b, l.plan.main);
          out.push({
            id: 'enter', provider: 'interior', label: 'Go inside', category: 'social', target, priority: 6, enabled: !lock.locked && b.construction >= 1 && !b.onFire,
            reason: b.construction < 1 ? 'It is still being built' : b.onFire ? 'It is on fire' : lock.locked ? lock.why : undefined,
            seconds: 0, range: 6 + Math.max(BUILDINGS[b.kind].w, BUILDINGS[b.kind].d) / 2, preview: `Into the ${BUILDINGS[b.kind].name.toLowerCase()}`,
          });
        }
        void ctx;
      },
      complete: (_ctx, actor, option) => {
        const me = this.sim.state.persons.get(actor);
        if (!me) return { ok: false };
        if (option.id === 'leave') return this.leave() ? { ok: true } : { ok: false, message: 'There is no way out from here.' };
        if (option.id === 'bed') return this.sleepInBed(actor);
        if (option.target.kind !== 'building') return { ok: false };
        const b = this.sim.state.buildings.get(option.target.id);
        if (!b) return { ok: false };
        const di = typeof option.data === 'number' ? option.data : -1;
        switch (option.id) {
          case 'door.open': this.zone.doors.set(b.id, di, true); return { ok: true };
          case 'door.shut': this.zone.doors.set(b.id, di, false); return { ok: true };
          case 'door.knock': return this.knock(me.id, b, di);
          case 'door.force': {
            this.zone.doors.force(b.id, di);
            const body = this.player.body?.();
            const occupied = this.zone.indoors.count > 0 || b.occupied;
            const law = this.sim.services.law;
            const heard = law?.breakIn?.(me.id, b.settlement, body?.x ?? b.x, body?.z ?? b.z, occupied) ?? false;
            return { ok: true, message: heard ? 'The door gives. Someone cries out — the law will hear of this.' : 'The door gives with a crack.' };
          }
          case 'enter': return this.enter(b.id) ? { ok: true } : { ok: false, message: 'You cannot go in.' };
          default: return { ok: false };
        }
      },
    };
  }

  /** Knocking: someone at home and awake who is not ill-disposed lets you in for the evening. */
  private knock(me: PersonId, b: BuildingState, door: number): { ok: boolean; message: string } {
    const st = this.sim.state;
    let answer: PersonId = 0;
    for (const hh of st.households.values()) {
      if (hh.home !== b.id) continue;
      for (const m of hh.members) {
        const w = this.zone.whereabouts(m);
        if (w.building === b.id && w.indoors && w.activity !== 'sleep') { answer = m; break; }
      }
    }
    if (!answer) return { ok: true, message: 'You knock. Nobody comes.' };
    const p = st.persons.get(answer)!;
    const opinion = p.opinions[me] ?? 0;
    if (opinion < -10) return { ok: true, message: `${fullName(p)} calls through the door: "Go away!"` };
    this.zone.doors.invite(me, b.id, this.sim.absDay + 0.2);
    this.zone.doors.set(b.id, door, true);
    return { ok: true, message: `${fullName(p)} draws the bar and lets you in.` };
  }

  /** Into the building by its main door: the door opens, and he is a step inside it. */
  enter(buildingId: number): boolean {
    const l = this.zone.nav.interiors.loaded.get(buildingId);
    if (!l || l.plan.main < 0) return false;
    const d = l.plan.doors[l.plan.main];
    const lx = d.x - d.nx * (d.t + 0.6), lz = d.z - d.nz * (d.t + 0.6);
    const w = this.zone.nav.interiors.toWorld(l, lx, lz, { x: 0, z: 0 });
    this.zone.doors.pass(buildingId, l.plan.main, 2.4);
    this.player.placeAt(w.x, w.z, Math.atan2(-d.nx, -d.nz) + l.rot, l.y + d.y);
    return true;
  }

  /** Out of the building he is in, by the nearest outer door, a step outside it. */
  leave(): boolean {
    const b = this.where;
    const body = this.player.body?.();
    if (!b || !body) return false;
    const l = this.zone.nav.interiors.loaded.get(b.id);
    if (!l) return false;
    const loc = this.zone.nav.interiors.toLocal(l, body.x, body.z, { x: 0, z: 0 });
    let best = -1, bd = Infinity;
    l.plan.doors.forEach((d, i) => {
      if (!d.outer || d.kind === 'small') return;
      const dd = Math.hypot(d.x - loc.x, d.z - loc.z) + Math.abs(d.y + l.y - body.y) * 4;
      if (dd < bd) { bd = dd; best = i; }
    });
    if (best < 0) return false;
    const d = l.plan.doors[best];
    const w = this.zone.nav.interiors.toWorld(l, d.sx, d.sz, { x: 0, z: 0 });
    this.zone.doors.pass(b.id, best, 2.4);
    this.player.placeAt(w.x, w.z, Math.atan2(d.nx, d.nz) + l.rot, d.sy > 0.5 ? l.y + d.sy : undefined);
    return true;
  }

  /** The bed of his own household within reach in the building he is in. */
  private myBed(me: PersonId): { x: number; y: number; z: number; yaw: number } | null {
    const b = this.where;
    const body = this.player.body?.();
    if (!b || !body) return null;
    const p = this.sim.state.persons.get(me);
    let home = false;
    for (const hh of this.sim.state.households.values()) if (hh.home === b.id && hh.members.includes(me)) home = true;
    if (!home && !(p && b.household && p.household === b.household)) return null;
    const l = this.zone.nav.interiors.loaded.get(b.id);
    if (!l) return null;
    const loc = this.zone.nav.interiors.toLocal(l, body.x, body.z, { x: 0, z: 0 });
    let best: { x: number; y: number; z: number; yaw: number } | null = null, bd = 2.4;
    for (const s of l.plan.spots) {
      if (s.use !== 'sleep' || Math.abs(s.y + l.y - body.y) > 0.8) continue;
      const d = Math.hypot(s.x - loc.x, s.z - loc.z);
      if (d < bd) { bd = d; best = { x: s.x, y: s.y, z: s.z, yaw: s.yaw }; }
    }
    if (!best) return null;
    const w = this.zone.nav.interiors.toWorld(l, best.x, best.z, { x: 0, z: 0 });
    return { x: w.x, y: l.y + best.y, z: w.z, yaw: best.yaw + l.rot };
  }

  private sleepInBed(me: PersonId): { ok: boolean; message?: string } {
    const bed = this.myBed(me);
    if (!bed) return { ok: false, message: 'There is no bed of yours here.' };
    this.player.placeAt(bed.x, bed.z, bed.yaw, bed.y);
    const r = this.sim.dispatch({ type: 'sleep' });
    return r.ok ? { ok: true, message: 'You lie down in your bed and sleep.' } : { ok: false, message: r.reason ?? 'You cannot sleep now.' };
  }

  /** Leaves the building before another body is taken over (nothing to do: he is in the world). */
  exit(): void { /* the player is always in the world */ }

  dispose(): void {
    this.renderer.setInteriors?.(null);
    this.zone.nav.setInteriorSource(null);
    void INSIDE_RADIUS;
  }
}
