// Arrows and bolts in flight (simulated per sub-step) and the ones left standing in the ground. The arena
// tests them against bodies; this file owns the flight, the landing and the draw items.
import type { ProjectileDrawItem } from '../core/view';

const GRAVITY = 9.81;
const MAX_FLIGHT = 4.5;
const MAX_STUCK = 90;
/** Arrows in the ground are picked clean after this long (s). */
const STUCK_LIFE = 150;
const BODY_STUCK_LIFE = 25;

export interface Shot {
  id: number;
  kind: 'arrow' | 'bolt';
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Fighter key of the shooter (not hit in the first instants). */
  shooter: number;
  /** Faction side of the shooter (no friendly fire between members of a side unless it is in the way). */
  side: number;
  fight: number;
  dmg: number;
  ap: number;
  weapon: string;
  age: number;
  stuck: boolean;
  stuckAge: number;
  inBody: boolean;
  /** Where it left the string (range falloff). */
  x0: number; z0: number;
  range: number;
}

export class Projectiles {
  readonly flying: Shot[] = [];
  readonly landed: Shot[] = [];
  private seq = 1;
  private readonly drawPool = new Map<number, ProjectileDrawItem>();
  private readonly viewList: ProjectileDrawItem[] = [];

  launch(s: Omit<Shot, 'id' | 'age' | 'stuck' | 'stuckAge' | 'inBody' | 'x0' | 'z0'>): Shot {
    const shot: Shot = { ...s, id: this.seq++, age: 0, stuck: false, stuckAge: 0, inBody: false, x0: s.x, z0: s.z };
    this.flying.push(shot);
    return shot;
  }

  /** Advances the shots one step; `test` may stop one (return true) after recording the hit itself. */
  step(dt: number, groundY: (x: number, z: number) => number, blocked: ((x: number, y: number, z: number) => boolean) | null,
    test: (s: Shot, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => boolean): void {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const s = this.flying[i];
      s.age += dt;
      const x0 = s.x, y0 = s.y, z0 = s.z;
      // a little drag: a long shot arrives slower than it left
      const sp = Math.hypot(s.vx, s.vy, s.vz);
      const drag = 1 - Math.min(0.5, 0.0009 * sp * dt * 3);
      s.vx *= drag; s.vz *= drag; s.vy = s.vy * drag - GRAVITY * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      if (test(s, x0, y0, z0, s.x, s.y, s.z)) { this.land(i, true); continue; }
      const gy = groundY(s.x, s.z);
      if (s.y <= gy + 0.02) { s.y = gy + 0.03; this.land(i, false); continue; }
      if (blocked && s.y < gy + 4 && blocked(s.x, s.y, s.z)) { this.land(i, false); continue; }
      if (s.age > MAX_FLIGHT) this.flying.splice(i, 1);
    }
    for (let i = this.landed.length - 1; i >= 0; i--) {
      const s = this.landed[i];
      s.stuckAge += dt;
      if (s.stuckAge > (s.inBody ? BODY_STUCK_LIFE : STUCK_LIFE)) { this.drawPool.delete(s.id); this.landed.splice(i, 1); }
    }
  }

  /** Moves a flying shot to the ground list (hit a body or the earth). */
  land(index: number, inBody: boolean): void {
    const s = this.flying[index];
    this.flying.splice(index, 1);
    s.stuck = true;
    s.inBody = inBody;
    s.stuckAge = 0;
    this.landed.push(s);
    if (this.landed.length > MAX_STUCK) {
      const gone = this.landed.shift();
      if (gone) this.drawPool.delete(gone.id);
    }
  }

  get count(): number { return this.flying.length; }

  view(): readonly ProjectileDrawItem[] {
    const list = this.viewList;
    list.length = 0;
    const push = (s: Shot): void => {
      let d = this.drawPool.get(s.id);
      if (!d) { d = { id: s.id, kind: s.kind, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, stuck: false }; this.drawPool.set(s.id, d); }
      d.x = s.x; d.y = s.y; d.z = s.z; d.vx = s.vx; d.vy = s.vy; d.vz = s.vz; d.stuck = s.stuck;
      list.push(d);
    };
    for (const s of this.flying) push(s);
    for (const s of this.landed) push(s);
    return list;
  }

  clear(): void { this.flying.length = 0; this.landed.length = 0; this.drawPool.clear(); }
}

/** Launch pitch (rad) for an arrow of `speed` to land at horizontal `dist` and height difference `dy` (low arc). */
export function ballisticPitch(dist: number, dy: number, speed: number): number {
  const g = GRAVITY, v2 = speed * speed;
  const disc = v2 * v2 - g * (g * dist * dist + 2 * dy * v2);
  if (disc < 0) return Math.PI / 4; // out of range: lob it
  return Math.atan2(v2 - Math.sqrt(disc), g * dist);
}
