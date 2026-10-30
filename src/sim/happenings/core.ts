// Shared runtime of the happenings module: the persisted section (`state.ext.happenings`) and the small
// helpers every part uses (difficulty scaling, "does this concern the player", starting and ending
// events, messages). Randomness comes from the named stream 'happenings'.
import { dist, dist2 } from '../../core/math';
import type { Rng } from '../../core/rng';
import { DAYS_PER_YEAR, toDate } from '../../core/time';
import type { Settlement, WorldModel } from '../../world/types';
import type { Simulation } from '../sim';
import { type GameState, type PersonId } from '../state';
import type { Wave3Deps } from '../wave3deps';
import type { AdvancementRuntime } from '../advancement/types';
import { DATA, fill } from './data';
import type { HappeningKind, HappeningRec, RequestRec } from './types';

export const HAP_KEY = 'happenings';
const RECENT_CAP = 40;
const REQUEST_CAP = 40;

export interface QueuedGathering { at: number; kind: HappeningKind; settlement: number; persons: number[]; name: string }

export interface HapSave {
  v: 1;
  nextId: number;
  active: HappeningRec[];
  recent: HappeningRec[];
  /** Plague waves: strength and day of the outbreak. */
  waves: Array<{ id: number; strength: number; start: number }>;
  nextWave: number;
  /** Buildings on fire: building id -> day the fire began. */
  fires: Record<string, number>;
  /** Last day a kind (or kind:settlement) ended, so events do not repeat at once. */
  cool: Record<string, number>;
  /** Gatherings waiting for their hour (weddings, funerals, christenings). */
  queue: QueuedGathering[];
  /** Buildings damaged by fire or flood that the neighbours are mending. */
  repair: number[];
  reqs: RequestRec[];
  nextReq: number;
  lastOffer: number;
  stats: { started: Record<string, number>; requests: Record<string, number> };
  /** Last year the yearly hazards were drawn. */
  year: number;
}

export function newHapSave(): HapSave {
  return {
    v: 1, nextId: 1, active: [], recent: [], waves: [], nextWave: 1, fires: {}, cool: {}, queue: [], repair: [], reqs: [], nextReq: 1, lastOffer: -99,
    stats: { started: {}, requests: {} }, year: -1,
  };
}

export class Hap {
  readonly sim: Simulation;
  readonly state: GameState;
  readonly world: WorldModel;
  readonly deps: Wave3Deps;
  save: HapSave;
  readonly settlementById = new Map<number, Settlement>();
  /** Settlement id -> neighbours along the roads with the length of the road between them. */
  readonly roads = new Map<number, Array<{ to: number; len: number }>>();
  /** Settlements by river or sea (floods). */
  readonly wet: number[] = [];
  /** Wolves summoned into the detail zone this winter night (not saved: the zone forgets them on load). */
  readonly wolves: number[] = [];
  /** Requesters currently walking up to the player in the detail zone: request id -> step at which they go back to their routine. */
  readonly approach = new Map<number, number>();
  readonly approached = new Set<number>();
  private activeCache: { rev: number; day: number; map: Map<number, string[]> } | null = null;
  private rev = 0;

  constructor(sim: Simulation, deps: Wave3Deps) {
    this.sim = sim;
    this.state = sim.state;
    this.world = sim.world;
    this.deps = deps;
    const cur = sim.state.ext[HAP_KEY] as HapSave | undefined;
    if (cur && typeof cur === 'object') this.save = cur;
    else { this.save = newHapSave(); sim.state.ext[HAP_KEY] = this.save; sim.state.touchExt(HAP_KEY); }
    const base = newHapSave();
    for (const k of Object.keys(base) as Array<keyof HapSave>) {
      if ((this.save as unknown as Record<string, unknown>)[k] === undefined) (this.save as unknown as Record<string, unknown>)[k] = (base as unknown as Record<string, unknown>)[k];
    }
    for (const s of sim.world.settlements) this.settlementById.set(s.id, s);
    this.buildRoads();
    this.findWet();
  }

  get day(): number { return this.sim.absDay; }
  get dayOfYear(): number { return toDate(this.sim.absDay).dayOfYear; }
  get playerId(): PersonId { return this.state.run.playerId; }
  get adv(): AdvancementRuntime | undefined { return this.sim.services.advancement as AdvancementRuntime | undefined; }
  rng(): Rng { return this.sim.rng('happenings'); }
  touch(): void { this.state.touchExt(HAP_KEY); this.rev++; }
  /** Difficulty multiplier of a family of events. */
  diff(kind: 'plague' | 'famine' | 'disaster' | 'bandits' | 'revolt' | 'requests'): number {
    return DATA.difficulty[this.state.difficulty][kind];
  }

  // ---- geography ----

  private buildRoads(): void {
    const g = this.world.roadGraph;
    const settlementOfNode = new Map<number, number>();
    for (const n of g.nodes) if (n.settlement >= 0) settlementOfNode.set(n.id, n.settlement);
    const add = (a: number, b: number, len: number): void => {
      if (a === b) return;
      let list = this.roads.get(a);
      if (!list) { list = []; this.roads.set(a, list); }
      const hit = list.find((x) => x.to === b);
      if (hit) hit.len = Math.min(hit.len, len);
      else list.push({ to: b, len });
    };
    for (const e of g.edges) {
      const a = settlementOfNode.get(e.a), b = settlementOfNode.get(e.b);
      if (a !== undefined && b !== undefined) { add(a, b, e.length); add(b, a, e.length); }
    }
    // junction nodes (settlement -1) join the settlements on either side
    const via = new Map<number, Array<{ s: number; len: number }>>();
    for (const e of g.edges) {
      const a = settlementOfNode.get(e.a), b = settlementOfNode.get(e.b);
      for (const [junction, other, len] of [[e.a, b, e.length], [e.b, a, e.length]] as Array<[number, number | undefined, number]>) {
        if (settlementOfNode.has(junction) || other === undefined) continue;
        let l = via.get(junction);
        if (!l) { l = []; via.set(junction, l); }
        l.push({ s: other, len });
      }
    }
    for (const list of via.values()) {
      for (const x of list) for (const y of list) add(x.s, y.s, x.len + y.len);
    }
    // keep each list sorted for determinism
    for (const list of this.roads.values()) list.sort((p, q) => p.to - q.to);
  }

  private findWet(): void {
    for (const s of this.world.settlements) {
      if (s.port) { this.wet.push(s.id); continue; }
      let near = false;
      for (const r of this.world.rivers) {
        for (let i = 0; i < r.points.length && !near; i += 2) near = dist2(r.points[i].x, r.points[i].z, s.x, s.z) < 220 * 220;
        if (near) break;
      }
      if (near) this.wet.push(s.id);
    }
  }

  distance(a: number, b: number): number {
    const sa = this.settlementById.get(a), sb = this.settlementById.get(b);
    return sa && sb ? dist(sa.x, sa.z, sb.x, sb.z) : Infinity;
  }

  playerSettlement(): number {
    const p = this.state.persons.get(this.playerId);
    return p && !p.death ? p.settlement : -1;
  }

  playerKingdom(): number {
    const sid = this.playerSettlement();
    return this.settlementById.get(sid)?.kingdom ?? -1;
  }

  /** Is the settlement within `radius` metres of where the player lives? */
  nearPlayer(settlement: number, radius = 3000): boolean {
    const ps = this.playerSettlement();
    if (ps < 0 || settlement < 0) return false;
    return ps === settlement || this.distance(ps, settlement) <= radius;
  }

  /** Weight for picking a place: places near the player come up more often (the world is lively where you are). */
  nearWeight(settlement: number): number {
    return this.nearPlayer(settlement, 3000) ? 3 : 1;
  }

  kingdomOf(settlement: number): number { return this.settlementById.get(settlement)?.kingdom ?? -1; }
  kingdomName(id: number): string { return this.world.kingdoms.find((k) => k.id === id)?.name ?? 'the realm'; }
  placeName(id: number): string { return this.settlementById.get(id)?.name ?? 'the countryside'; }

  // ---- queries ----

  recordsAt(settlement: number): readonly string[] {
    const day = Math.floor(this.day);
    if (!this.activeCache || this.activeCache.rev !== this.rev || this.activeCache.day !== day) this.activeCache = { rev: this.rev, day, map: new Map() };
    const hit = this.activeCache.map.get(settlement);
    if (hit) return hit;
    const k = this.kingdomOf(settlement);
    const out: string[] = [];
    for (const r of this.save.active) {
      if (r.settlement === settlement || (r.settlement < 0 && (r.kingdom < 0 || r.kingdom === k))) if (!out.includes(r.kind)) out.push(r.kind);
    }
    this.activeCache.map.set(settlement, out);
    return out;
  }

  activeOf(kind: HappeningKind): HappeningRec[] { return this.save.active.filter((r) => r.kind === kind); }
  activeAtOf(kind: HappeningKind, settlement: number): HappeningRec | undefined {
    return this.save.active.find((r) => r.kind === kind && r.settlement === settlement);
  }
  cooling(key: string, days: number): boolean {
    const t = this.save.cool[key];
    return t !== undefined && this.day - t < days;
  }

  /** Does this event concern the player (their place, a neighbour, their realm)? */
  relevant(settlement: number, kingdom: number): boolean {
    if (this.playerSettlement() < 0) return false;
    if (settlement >= 0) return this.nearPlayer(settlement, 3500);
    return kingdom < 0 || kingdom === this.playerKingdom();
  }

  // ---- starting and ending ----

  text(kind: HappeningKind, phase: 'start' | 'end', vars: Record<string, string | number>): string {
    const pool = DATA.text[kind]?.[phase] ?? [];
    if (pool.length === 0) return '';
    return fill(this.rng().pick(pool), vars);
  }

  begin(kind: HappeningKind, o: { settlement: number; kingdom?: number; days: number; level?: number; vars?: Record<string, string | number>; data?: HappeningRec['data']; quiet?: boolean; important?: boolean }): HappeningRec {
    const kingdom = o.kingdom ?? (o.settlement >= 0 ? this.kingdomOf(o.settlement) : -1);
    const vars = { place: o.settlement >= 0 ? this.placeName(o.settlement) : this.kingdomName(kingdom), kingdom: this.kingdomName(kingdom), ...o.vars };
    const text = this.text(kind, 'start', vars);
    const rec: HappeningRec = {
      id: this.save.nextId++, kind, settlement: o.settlement, kingdom, start: this.day, end: this.day + o.days,
      level: Math.round((o.level ?? 0.5) * 100) / 100, text,
    };
    if (o.data) rec.data = o.data;
    this.save.active.push(rec);
    this.save.stats.started[kind] = (this.save.stats.started[kind] ?? 0) + 1;
    this.touch();
    this.sim.events.emit('happening', { phase: 'start', id: rec.id, kind, settlement: o.settlement, text });
    if (!o.quiet && this.relevant(o.settlement, kingdom)) {
      const danger = kind === 'plague' || kind === 'famine' || kind === 'fire' || kind === 'flood' || kind === 'bandits' || kind === 'revolt';
      this.sim.events.emit('notify', { kind: danger ? 'danger' : 'info', text, ref: `happening:${rec.id}` });
      this.state.log(this.day, 'happening', text, [this.playerId]);
    } else if (o.important) {
      this.state.log(this.day, 'happening', text, []);
    }
    return rec;
  }

  end(rec: HappeningRec, vars: Record<string, string | number> = {}, quiet = false): void {
    const i = this.save.active.indexOf(rec);
    if (i < 0) return;
    this.save.active.splice(i, 1);
    rec.end = Math.min(rec.end, this.day);
    this.save.recent.unshift(rec);
    if (this.save.recent.length > RECENT_CAP) this.save.recent.length = RECENT_CAP;
    this.save.cool[rec.kind] = this.day;
    if (rec.settlement >= 0) this.save.cool[`${rec.kind}:${rec.settlement}`] = this.day;
    this.touch();
    const text = this.text(rec.kind, 'end', { place: rec.settlement >= 0 ? this.placeName(rec.settlement) : this.kingdomName(rec.kingdom), kingdom: this.kingdomName(rec.kingdom), ...vars });
    this.sim.events.emit('happening', { phase: 'end', id: rec.id, kind: rec.kind, settlement: rec.settlement, text });
    if (!quiet && text && this.relevant(rec.settlement, rec.kingdom) && ['plague', 'famine', 'fire', 'flood', 'drought', 'winter', 'bandits', 'revolt'].includes(rec.kind)) {
      this.sim.events.emit('notify', { kind: 'info', text });
    }
  }

  notifyPlayer(text: string, kind: 'info' | 'gain' | 'loss' | 'warn' | 'danger' | 'quest' | 'social' = 'info', ref?: string): void {
    this.sim.events.emit('notify', ref ? { kind, text, ref } : { kind, text });
  }

  bump(counter: 'requests', key: string): void {
    this.save.stats[counter][key] = (this.save.stats[counter][key] ?? 0) + 1;
  }

  /** Keeps the request journal to a sensible size: open ones stay, the oldest settled ones go. */
  trimRequests(): void {
    const r = this.save.reqs;
    if (r.length <= REQUEST_CAP) return;
    const closed = r.filter((x) => x.state !== 'offered' && x.state !== 'accepted');
    const drop = new Set(closed.slice(0, r.length - REQUEST_CAP));
    this.save.reqs = r.filter((x) => !drop.has(x));
  }

  get yearIndex(): number { return Math.floor(this.day / DAYS_PER_YEAR); }
}
