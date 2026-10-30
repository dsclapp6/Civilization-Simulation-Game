// Seeing an army (street level): when the player stands near a camp, muster or garrison, a company of its
// real men is summoned into the detail zone and lined up in ranks on open ground. Purely a view: the
// macro army is unchanged; the men are handed back to their routines when the player walks away.
import { dist } from '../../core/math';
import type { P2 } from '../../core/math';
import type { PersonId } from '../state';
import type { Mil } from './store';
import type { Army } from './types';

const SHOW_RADIUS = 260;
const MAX_SHOWN = 36;
const PERIOD = 1.2;

export class MusterView {
  private t = 0;
  private readonly shown = new Map<PersonId, { x: number; z: number }>();
  private armyId = 0;
  private readonly out: P2 = { x: 0, z: 0 };

  constructor(private readonly M: Mil) {}

  step(dt: number): void {
    const M = this.M;
    const zone = M.zone, api = M.playerApi;
    if (!zone || !api || !zone.summon) return;
    this.t += dt;
    if (this.t < PERIOD) return;
    this.t = 0;
    const body = api.body();
    const mode = M.sim.view.mode();
    if (!body || mode !== 'street') { this.clear(); return; }
    let best: Army | undefined, bd = SHOW_RADIUS;
    for (const a of M.allArmies()) {
      if (a.engaged || a.task === 'march' || a.task === 'battle' || a.reason === 'sally') continue;
      if (a.men.length < 6) continue;
      const d = dist(a.x, a.z, body.x, body.z);
      if (d < bd) { bd = d; best = a; }
    }
    if (!best) { this.clear(); return; }
    if (best.id !== this.armyId) { this.clear(); this.armyId = best.id; }
    this.show(best, body);
  }

  private show(a: Army, body: { x: number; z: number }): void {
    const M = this.M;
    const zone = M.zone;
    if (!zone || !zone.summon) return;
    // open ground near the army's camp, between it and the player
    const nav = zone.nav;
    let ax = a.x, az = a.z;
    const dx = body.x - ax, dz = body.z - az;
    const d = Math.hypot(dx, dz) || 1;
    if (d > 40) { ax += (dx / d) * (d - 28); az += (dz / d) * (d - 28); }
    if (!nav.walkable(ax, az) && nav.nearestWalkable(ax, az, 60, this.out)) { ax = this.out.x; az = this.out.z; }
    const yaw = Math.atan2(body.x - ax, body.z - az);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // leaders first, then an even spread through the roster
    const n = Math.min(MAX_SHOWN, a.men.length);
    const step = a.men.length / n;
    const want: PersonId[] = [];
    for (let i = 0; i < n; i++) {
      const id = a.men[Math.min(a.men.length - 1, Math.floor(i * step))];
      if (M.alive(id) && id !== M.playerId) want.push(id);
    }
    const wantSet = new Set(want);
    for (const id of [...this.shown.keys()]) {
      if (!wantSet.has(id)) { zone.dismiss?.(id); this.shown.delete(id); }
    }
    const perRank = 6;
    want.forEach((id, i) => {
      const rank = Math.floor(i / perRank), file = i % perRank;
      const x = ax + rx * (file - (perRank - 1) / 2) * 1.8 - fx * rank * 1.8;
      const z = az + rz * (file - (perRank - 1) / 2) * 1.8 - fz * rank * 1.8;
      const cur = this.shown.get(id);
      if (!cur) {
        zone.summon?.(id, x, z, yaw);
        this.shown.set(id, { x, z });
        zone.command(id, { kind: 'goto', x, z });
      } else if (Math.hypot(cur.x - x, cur.z - z) > 1.5) {
        cur.x = x; cur.z = z;
        zone.command(id, { kind: 'goto', x, z });
      }
    });
  }

  clear(): void {
    const zone = this.M.zone;
    if (zone) for (const id of this.shown.keys()) zone.dismiss?.(id);
    this.shown.clear();
    this.armyId = 0;
  }
}
