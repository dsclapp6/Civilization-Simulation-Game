// Alert and fortifications (civilization pass, wave B; docs/CIV.md §9, docs/WAR.md): how a place stands towards war right now,
// and how its gates and walls stand. Both are *derived* — from the armies on the map, the sieges, the wars and the damage the
// buildings carry — so nothing here is saved, and a loaded game answers exactly as the one that was saved.
//
//   alertOf(settlement)  peace · watch · alarm · assault
//     watch    the lord's House is at war or in a feud, or a hostile army is within 6 km
//     alarm    a hostile army within 2 km, or a siege camp before the walls
//     assault  a storm (a battle with the place under siege) is going on
//   fortState(building)  a gatehouse: shut at night under 'watch', always from 'alarm', broken once its damage is ≥ 0.6;
//                        a wall or palisade: a breach 0..1 that grows with its damage (≥ 0.5 can be climbed through)
//
// The zone reads both (shut gates are solid, a breach is a way in, the watch is doubled, the militia musters, bells ring); the
// renderer reads the same through the `forts` / `fortsVersion` view sources, which are cheap: the list is rebuilt only when a
// building, an army, a siege, a war or the night changes, and the version moves only when the list itself differs.
import { dist } from '../../core/math';
import { isNight } from '../../core/time';
import type { FortView } from '../../core/view';
import type { BuildingState } from '../state';
import type { AlertLevel } from '../wave3';
import type { Mil } from './store';

/** The kinds of building that are walls (a breach opens in them); the gatehouse is the gate. */
export const WALL_KINDS: ReadonlySet<string> = new Set(['wall', 'palisade']);
export const GATE_KIND = 'gatehouse';

/** Distances (m) at which a hostile army puts a place on 'watch' and on 'alarm'. */
export const WATCH_RADIUS = 6000;
export const ALARM_RADIUS = 2000;
/** A gatehouse this damaged is battered in: passable, drawn broken. */
export const GATE_BROKEN_AT = 0.6;
/** Wall damage where a breach begins, and the span over which it grows to the full width of the segment. */
const BREACH_FROM = 0.3;
const BREACH_SPAN = 0.4;

/** The breach 0..1 a wall or palisade with this much damage shows (≥ 0.5 can be climbed through). */
export function breachOf(damage: number): number {
  const v = (damage - BREACH_FROM) / BREACH_SPAN;
  return v <= 0 ? 0 : v >= 1 ? 1 : Math.round(v * 100) / 100;
}

/** The gate state given its damage, the alert of its place and the hour (shut at night under 'watch', always from 'alarm'). */
export function gateOf(damage: number, alert: AlertLevel, night: boolean): 'open' | 'shut' | 'broken' {
  if (damage >= GATE_BROKEN_AT) return 'broken';
  if (alert === 'alarm' || alert === 'assault') return 'shut';
  if (alert === 'watch' && night) return 'shut';
  return 'open';
}

export class AlertSystem {
  private level = new Map<number, AlertLevel>();
  private levelStamp = -1;

  // ---- the forts view ----
  private list: FortView[] = [];
  private byBuilding = new Map<number, FortView>();
  private sig = '';
  private ver = 1;
  private seenRev = -1;
  private seenStamp = -1;
  private seenNight = false;
  /** The gatehouses, walls and palisades of the world, rescanned only when buildings are added or pulled down. */
  private fortBuildings: BuildingState[] = [];
  private shape = '';

  constructor(private readonly M: Mil) {}

  // ---------------------------------------------------------------------------------------------
  // Alert
  // ---------------------------------------------------------------------------------------------

  alertOf(settlement: number): AlertLevel {
    const M = this.M;
    if (this.levelStamp !== M.alertStamp) { this.level.clear(); this.levelStamp = M.alertStamp; }
    let v = this.level.get(settlement);
    if (v === undefined) { v = this.compute(settlement); this.level.set(settlement, v); }
    return v;
  }

  private compute(sid: number): AlertLevel {
    const M = this.M;
    const s = M.settlementById.get(sid);
    if (!s) return 'peace';
    // a storm: a battle whose siege is this place (the macro battle lives until the detail fight is settled)
    for (const b of M.data.battles) if (b.siege === sid) return 'assault';
    if (M.data.sieges.some((x) => x.settlement === sid)) return 'alarm';
    const lord = M.realm.holderOf(sid);
    if (!lord) return 'peace';
    let nearest = Infinity;
    for (const a of M.allArmies()) {
      if (a.reason === 'sally' || a.task === 'muster' || a.house === lord) continue;
      if (!M.realm.hostile(a.house, lord)) continue;
      const d = dist(a.x, a.z, s.x, s.z);
      if (d < nearest) nearest = d;
    }
    if (nearest < ALARM_RADIUS) return 'alarm';
    if (nearest < WATCH_RADIUS) return 'watch';
    if (M.realm.directEnemies(lord).size > 0 || M.realm.warsAt(lord).length > 0) return 'watch';
    return 'peace';
  }

  // ---------------------------------------------------------------------------------------------
  // Forts
  // ---------------------------------------------------------------------------------------------

  /** How the building stands: a gate that is shut or broken, a wall with a breach; null = open and whole (or not a fortification). */
  fortState(building: number): FortView | null {
    this.refresh();
    return this.byBuilding.get(building) ?? null;
  }

  /** Every gate that is not open and every breach (the `forts` view source). The array is reused until the list changes. */
  forts(): readonly FortView[] {
    this.refresh();
    return this.list;
  }

  /** Moves whenever the list changes (the `fortsVersion` view source). */
  version(): number {
    this.refresh();
    return this.ver;
  }

  private refresh(): void {
    const M = this.M;
    const st = M.state;
    const night = isNight(M.sim.absDay);
    if (this.seenRev === st.buildingRevision && this.seenStamp === M.alertStamp && this.seenNight === night) return;
    this.seenRev = st.buildingRevision;
    this.seenStamp = M.alertStamp;
    this.seenNight = night;
    const shape = `${st.buildings.size}:${st.nextBuildingId}`;
    if (shape !== this.shape) {
      this.shape = shape;
      this.fortBuildings = [];
      for (const b of st.buildings.values()) if (b.kind === GATE_KIND || WALL_KINDS.has(b.kind)) this.fortBuildings.push(b);
      this.fortBuildings.sort((a, b) => a.id - b.id);
    }
    const out: FortView[] = [];
    const map = new Map<number, FortView>();
    let sig = '';
    for (const b of this.fortBuildings) {
      if (b.construction < 1) continue;
      let fv: FortView | null = null;
      if (b.kind === GATE_KIND) {
        const gate = gateOf(b.damage, this.alertOf(b.settlement), night);
        if (gate !== 'open') fv = { building: b.id, gate, breach: 0 };
      } else {
        const breach = breachOf(b.damage);
        if (breach > 0) fv = { building: b.id, breach };
      }
      if (!fv) continue;
      out.push(fv);
      map.set(b.id, fv);
      sig += `${b.id}:${fv.gate ?? ''}:${Math.round(fv.breach * 20)};`;
    }
    // the same list again: keep the arrays the renderer may hold, and the version
    if (sig === this.sig) return;
    this.sig = sig;
    this.list = out;
    this.byBuilding = map;
    this.ver++;
  }
}
