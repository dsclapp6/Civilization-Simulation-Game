// One snapshot per frame of "where am I and what is around me" that the compass ribbon, the minimap, the edge
// arrows and the objective tracker all read: the body and the camera, and the places to point at (the objectives
// module's world markers, home and work, the church and market of the place, the pinned place).
import type { WorldMarker } from '../../core/view';
import type { Settlement } from '../../world/types';
import { yawBetween } from '../core/nav';
import type { PinStore } from '../core/pins';
import type { GameServices, UiHost } from '../types';

export interface NavMarker {
  id: string;
  kind: WorldMarker['kind'] | 'church' | 'market' | 'pin';
  x: number;
  z: number;
  /** Height for projecting to the screen. */
  y: number;
  label: string;
  color: number;
  primary: boolean;
  dist: number;
  /** Yaw from the body to the marker. */
  yaw: number;
}

export const COLOR = { objective: 0xf2c14e, home: 0x6fbf73, work: 0x6fa8dc, person: 0xe0705a, place: 0xb7a6e8, church: 0xf4efe0, market: 0xe6a35a, pin: 0x7fd0d8 };

const CHURCHES = new Set(['church', 'abbey_church', 'cathedral', 'chapel']);
const MARKETS = ['market_cross', 'market_hall', 'market_stall'];

export class NavState {
  /** The body (or the settlement when none) and where it faces. */
  x = 0;
  z = 0;
  bodyYaw = 0;
  /** The camera's heading. */
  camYaw = 0;
  /** Street camera on the world (the compass and arrows only make sense then). */
  street = true;
  readonly markers: NavMarker[] = [];
  /** The settlement the body stands in, or −1. */
  settlementId = -1;
  private pool: NavMarker[] = [];
  private used = 0;
  private placesFor = -2;
  private places: Array<{ kind: 'church' | 'market'; x: number; z: number; label: string }> = [];

  update(game: GameServices, host: UiHost, pins: PinStore): void {
    const sim = game.sim;
    const body = game.player.body();
    if (body) { this.x = body.x; this.z = body.z; this.bodyYaw = body.yaw; }
    const r = host.renderer();
    this.camYaw = r?.cameraYaw?.() ?? this.bodyYaw;
    this.street = (r?.cameraMode?.() ?? 'follow') === 'follow' && !game.player.travel();
    const here = sim.world.settlementAt(this.x, this.z);
    this.settlementId = here ? here.id : -1;

    this.used = 0;
    let haveHome = false, haveWork = false;
    const src = sim.view.worldMarkers?.();
    if (src) {
      for (const m of src) {
        this.push(`m${m.id}`, m.kind, m.x, m.z, sim.world.heightAt(m.x, m.z) + (m.y ?? 2.5), m.label, m.color, !!m.primary);
        if (m.kind === 'home') haveHome = true;
        if (m.kind === 'work') haveWork = true;
      }
    }
    if (!haveHome || !haveWork) {
      // without the objectives module's markers, the map markers still know the way home and to work
      for (const m of sim.view.mapMarkers()) {
        if (m.kind === 'home' && !haveHome && m.size > 0) this.push('home', 'home', m.x, m.z, sim.world.heightAt(m.x, m.z) + 3, 'Home', COLOR.home, false);
        if (m.kind === 'work' && !haveWork && m.size > 0) this.push('work', 'work', m.x, m.z, sim.world.heightAt(m.x, m.z) + 3, 'Work', COLOR.work, false);
      }
    }
    // the church and the market of the place the body is in (or nearest)
    const near = here ?? sim.world.nearestSettlement(this.x, this.z);
    if (near.id !== this.placesFor) this.findPlaces(game, near);
    for (const p of this.places) this.push(p.kind, p.kind, p.x, p.z, sim.world.heightAt(p.x, p.z) + 6, p.label, p.kind === 'church' ? COLOR.church : COLOR.market, false);
    const pin = pins.get();
    if (pin) this.push('pin', 'pin', pin.x, pin.z, sim.world.heightAt(pin.x, pin.z) + 3, pin.label, COLOR.pin, false);

    // the same spot marked twice (the church the task points at, and the church we mark anyway; a pin on the home) is
    // shown once, as the first of them: the objectives module's markers come first
    let n = 0;
    for (let i = 0; i < this.used; i++) {
      const m = this.pool[i];
      let again = false;
      if (!m.primary) for (let j = 0; j < n; j++) { const o = this.pool[j]; if (Math.abs(o.x - m.x) < 3 && Math.abs(o.z - m.z) < 3) { again = true; break; } }
      if (again) continue;
      if (n !== i) { this.pool[i] = this.pool[n]; this.pool[n] = m; }
      n++;
    }
    this.used = n;
    this.markers.length = this.used;
    for (let i = 0; i < this.used; i++) this.markers[i] = this.pool[i];
    for (const m of this.markers) {
      m.dist = Math.hypot(m.x - this.x, m.z - this.z);
      m.yaw = yawBetween(this.x, this.z, m.x, m.z);
    }
  }

  /** The tracked objective's marker, if the module has set one. */
  primary(): NavMarker | null {
    for (const m of this.markers) if (m.primary) return m;
    return null;
  }

  private push(id: string, kind: NavMarker['kind'], x: number, z: number, y: number, label: string, color: number, primary: boolean): void {
    let m = this.pool[this.used];
    if (!m) { m = { id, kind, x, z, y, label, color, primary, dist: 0, yaw: 0 }; this.pool[this.used] = m; }
    else { m.id = id; m.kind = kind; m.x = x; m.z = z; m.y = y; m.label = label; m.color = color; m.primary = primary; }
    this.used++;
  }

  private findPlaces(game: GameServices, s: Settlement): void {
    this.placesFor = s.id;
    this.places = [];
    const st = game.sim.state;
    const list = st.buildingsAt.get(s.id) ?? [];
    const church = list.find((b) => CHURCHES.has(b.kind) && b.kind !== 'chapel') ?? list.find((b) => CHURCHES.has(b.kind));
    if (church) this.places.push({ kind: 'church', x: church.x, z: church.z, label: church.kind === 'church' ? 'Church' : church.kind === 'cathedral' ? 'Cathedral' : 'Chapel' });
    if (s.market) {
      for (const k of MARKETS) {
        const b = list.find((x) => x.kind === k);
        if (b) { this.places.push({ kind: 'market', x: b.x, z: b.z, label: 'Market' }); break; }
      }
    }
  }
}
