// Going inside (the action "Go inside" on a house, the hall, the church, a workshop, an inn): the world is set aside and
// the renderer draws the building's room. You walk about it with W A S D, E talks to the person you face (or leaves by
// the door when you stand at it), and walking out of the door takes you back outside. The people of the household, and
// whoever's day has them in that building, are inside; they sit at the table and the benches, the lord in his chair.
// Time goes on outside; sleep (Z) works as anywhere.
import type { ActionOption, ActionProvider } from '../sim/actions';
import type { Simulation } from '../sim/sim';
import { ageYears, fullName, type BuildingState, type PersonId } from '../sim/state';
import { doorPoint } from '../sim/view-impl';
import type { CharacterDrawItem } from '../core/view';
import type { InputState, PlayerApi } from '../player/types';
import { hasInterior, roomLayout, type InteriorSpec, type RoomLayout } from '../render/interior';
import type { GameRenderer, InteriorFrame } from '../render/types';
import type { ZoneApi } from '../agents/types';
import { BUILDINGS } from '../content/types';

interface Occupant { id: PersonId; x: number; z: number; yaw: number; sit?: number }

const WALK = 1.7, RUN = 3.0;

export class InteriorMode {
  private building: BuildingState | null = null;
  private layout: RoomLayout | null = null;
  private me = { x: 0, z: 0, yaw: Math.PI, anim: 'idle' as CharacterDrawItem['anim'], t: 0, speed: 0 };
  private people: Occupant[] = [];
  private items: CharacterDrawItem[] = [];
  private readonly frameOut: InteriorFrame = { chars: [], eye: { x: 0, y: 0, z: 0 }, at: { x: 0, y: 0, z: 0 } };
  private wasInteract = false;

  constructor(private readonly sim: Simulation, private readonly renderer: GameRenderer, private readonly player: PlayerApi, private readonly zone: ZoneApi) {}

  get active(): boolean { return this.building !== null; }
  get where(): BuildingState | null { return this.building; }

  /** The "Go inside" option on a building with a room. */
  provider(): ActionProvider {
    return {
      id: 'interior',
      list: (_c, actor, target, out: ActionOption[]) => {
        if (actor !== this.sim.state.run.playerId || target.kind !== 'building' || this.active) return;
        const b = this.sim.state.buildings.get(target.id);
        if (!b || !hasInterior(b.kind)) return;
        const o: ActionOption = {
          id: 'enter', provider: 'interior', label: 'Go inside', category: 'social', target, priority: 8, enabled: true, seconds: 0,
          range: 6 + Math.max(BUILDINGS[b.kind].w, BUILDINGS[b.kind].d) / 2, preview: `Into the ${BUILDINGS[b.kind].name.toLowerCase()}`,
        };
        if (b.construction < 1) { o.enabled = false; o.reason = 'It is still being built'; }
        else if (b.onFire) { o.enabled = false; o.reason = 'It is on fire'; }
        out.push(o);
      },
      complete: (_c, _actor, option) => {
        if (option.target.kind !== 'building') return { ok: false };
        return this.enter(option.target.id) ? { ok: true } : { ok: false, message: 'You cannot go in.' };
      },
    };
  }

  enter(buildingId: number): boolean {
    const b = this.sim.state.buildings.get(buildingId);
    if (!b || !hasInterior(b.kind)) return false;
    const spec: InteriorSpec = { kind: b.kind, level: b.level, seed: b.seed };
    const L = roomLayout(spec);
    this.building = b;
    this.layout = L;
    // a step or two inside (more in a big hall), never inside the furniture
    let z0 = L.d / 2 - Math.min(2.6, Math.max(0.9, L.d * 0.25));
    const inSolid = (z: number): boolean => L.solids.some((sd) => Math.abs(sd.x) < sd.hw + 0.3 && Math.abs(z - sd.z) < sd.hd + 0.3);
    while (inSolid(z0) && z0 < L.d / 2 - 0.5) z0 += 0.2;
    this.me = { x: 0, z: z0, yaw: Math.PI, anim: 'idle', t: 0, speed: 0 };
    this.seatPeople(b, L);
    this.renderer.setInterior?.(spec, () => this.frame());
    this.sim.events.emit('notify', { kind: 'info', text: `You go into the ${BUILDINGS[b.kind].name.toLowerCase()}. W A S D to walk, E to talk; out through the door to leave.`, person: this.sim.state.run.playerId });
    return true;
  }

  exit(): void {
    const b = this.building;
    if (!b) return;
    this.building = null;
    this.layout = null;
    this.renderer.setInterior?.(null);
    // out of the door, facing the street
    const d = doorPoint(b, 1.4);
    this.player.placeAt(d.x, d.z, d.yaw);
  }

  /** The household's people at home, and whoever's day has them here. */
  private seatPeople(b: BuildingState, L: RoomLayout): void {
    const st = this.sim.state;
    const me = st.run.playerId;
    const ids = new Set<PersonId>();
    for (const hh of st.households.values()) {
      if (hh.home !== b.id) continue;
      for (const m of hh.members) {
        // at home, or about the door: they come in with you
        const a = this.zone.agent(m);
        const w = this.zone.whereabouts(m);
        if (w.building === b.id || (a && Math.hypot(a.x - b.x, a.z - b.z) < 40)) ids.add(m);
      }
    }
    for (const p of st.residentsOf(b.settlement)) {
      if (ids.size >= 10) break;
      if (p.death || p.id === me) continue;
      const w = this.zone.whereabouts(p.id);
      if (w.building === b.id) ids.add(p.id);
    }
    ids.delete(me);
    const list = [...ids].map((id) => st.persons.get(id)!).filter((p) => p && !p.death && ageYears(p, this.sim.absDay) >= 2)
      // the lord first (he takes the high seat), then by age
      .sort((a, c) => (st.titlesHeldBy(c.id).size - st.titlesHeldBy(a.id).size) || a.birthDay - c.birthDay);
    // as many as the room has places for (the rest are about the house); nobody stands in the way to the door
    this.people = list.slice(0, L.spots.length).map((p, i) => {
      const s = L.spots[i];
      return { id: p.id, x: s.x, z: s.z, yaw: s.yaw, ...(s.sit ? { sit: s.sit } : {}) };
    }).filter((o) => !(Math.abs(o.x) < 0.9 && o.z > L.d / 2 - 1.6));
  }

  /** One frame of the player inside: walking, talking, leaving. */
  step(input: InputState, dt: number): void {
    const L = this.layout;
    if (!L || !this.building) return;
    const m = this.me;
    const speed = input.sprint ? RUN : WALK;
    // the camera looks into the room from the door: forward is −z, right is +x
    let dx = input.right * speed * dt, dz = -input.forward * speed * dt;
    const moving = Math.abs(dx) + Math.abs(dz) > 1e-4;
    if (moving) {
      m.yaw = Math.atan2(dx, dz);
      const nx = m.x + dx, nz = m.z + dz;
      const hw = L.w / 2 - 0.35, hd = L.d / 2 - 0.35;
      // out through the door
      if (nz > hd && Math.abs(nx) < 0.65) { this.exit(); return; }
      const blocked = (x: number, z: number): boolean => Math.abs(x) > hw || Math.abs(z) > hd
        || L.solids.some((s) => Math.abs(x - s.x) < s.hw + 0.3 && Math.abs(z - s.z) < s.hd + 0.3)
        || this.people.some((p) => Math.hypot(p.x - x, p.z - z) < 0.55);
      if (!blocked(nx, nz)) { m.x = nx; m.z = nz; }
      else if (!blocked(nx, m.z)) m.x = nx;
      else if (!blocked(m.x, nz)) m.z = nz;
      else { dx = 0; dz = 0; }
    }
    m.speed = moving ? speed : 0;
    const anim = moving ? (speed > 2.4 ? 'run' : 'walk') : 'idle';
    if (anim !== m.anim) { m.anim = anim; m.t = 0; } else m.t += dt;
    // E: talk to the one you face, or leave by the door
    const pressed = input.interact && !this.wasInteract;
    this.wasInteract = input.interact;
    if (pressed) {
      const near = this.facing();
      if (near) this.player.talkTo(near.id);
      else if (m.z > L.d / 2 - 1.4 && Math.abs(m.x) < 1.2) this.exit();
    }
  }

  /** The person in front of the player within reach. */
  private facing(): Occupant | null {
    let best: Occupant | null = null, bd = 2.2;
    for (const p of this.people) {
      const d = Math.hypot(p.x - this.me.x, p.z - this.me.z);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** What the HUD prompt says inside. */
  prompt(): { label: string; targetLabel: string; enabled: boolean } | null {
    if (!this.layout) return null;
    const f = this.facing();
    if (f) { const p = this.sim.state.persons.get(f.id); return { label: 'Talk', targetLabel: p ? fullName(p) : '', enabled: true }; }
    if (this.me.z > this.layout.d / 2 - 1.4 && Math.abs(this.me.x) < 1.2) return { label: 'Go out', targetLabel: 'the door', enabled: true };
    return null;
  }

  private frame(): InteriorFrame {
    const st = this.sim.state;
    const view = this.sim.view;
    const L = this.layout!;
    const items = this.items;
    items.length = 0;
    const meP = st.persons.get(st.run.playerId);
    const mine = view.characters().find((c) => c.id === st.run.playerId);
    if (meP) {
      const base = mine ?? this.drawOf(meP.id, 0, 0, 0)!;
      items.push({ ...base, x: this.me.x, y: 0, z: this.me.z, yaw: this.me.yaw, anim: this.me.anim, animTime: this.me.t, moveSpeed: this.me.speed, highlight: 0, mount: undefined, label: undefined });
    }
    for (const o of this.people) {
      const it = this.drawOf(o.id, o.x, o.z, o.yaw, o.sit);
      if (it) items.push(it);
    }
    this.frameOut.chars = items;
    // from just inside the door, at the height of a tall man's eye and a little above, across the room to the far wall
    const big = Math.max(L.w, L.d);
    const eyeY = big > 12 ? 3.6 : 2.4;
    this.frameOut.eye = { x: this.me.x * 0.35, y: eyeY, z: L.d / 2 - 0.3 };
    this.frameOut.at = { x: this.me.x * 0.6, y: 1.0, z: Math.min(this.me.z - 2.5, -L.d / 4) };
    return this.frameOut;
  }

  private drawOf(id: PersonId, x: number, z: number, yaw: number, sit?: number): CharacterDrawItem | null {
    const p = this.sim.state.persons.get(id);
    if (!p) return null;
    const look = this.sim.view.appearance.get(this.sim.state, p, this.sim.absDay);
    return {
      id, x, y: 0, z, yaw, look: look.look, lookVersion: look.version, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none',
      anim: sit ? 'sit' : 'idle', animTime: (id % 17) * 0.3, moveSpeed: 0, highlight: this.facing()?.id === id ? 1 : 0,
      ...(sit ? { seatHeight: sit } : {}),
    } as CharacterDrawItem;
  }
}
