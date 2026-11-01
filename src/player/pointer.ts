// The mouse over the world (CLARITY §5): with the cursor free, the thing under it is found (the renderer's pick for
// people, animals, buildings and the ground; the world's scatter for trees and rocks; the zone for strips and
// commons), named, matched with the action a click would do, and outlined. A left click walks there and acts.
// Logic only: the renderer is reached through `PickPort`, the controller through `PointerHost`.
import type { InteractCandidate, ZoneApi } from '../agents/types';
import { BUILDINGS } from '../content/types';
import { dist } from '../core/math';
import type { LabelTone } from '../core/view';
import { roleLabel } from '../sim/careers';
import { targetKey, type ActionOption, type TargetRef } from '../sim/actions';
import type { Simulation } from '../sim/sim';
import type { SocialApi } from '../sim/social/types';
import { fullName, type PersonId } from '../sim/state';
import { SCATTER_NAME, pickScatter } from './pickScatter';
import type { CursorKind, GoOrder, HoverInfo, HoverMark, PickPort, Result } from './types';

/** Clicking the ground (or anything) farther than this does not walk there: the road and the map are for that. */
export const CLICK_WALK_RANGE = 220;
/** The pointer is re-resolved at most this often (s) while it stays still. */
const RESOLVE_INTERVAL = 0.1;
const OPTIONS_CACHE = 0.8;

/** Seconds of real time: the pointer's rhythm does not depend on the simulation running. */
const now = (): number => performance.now() / 1000;

export interface PointerHost {
  readonly sim: Simulation;
  readonly zone: ZoneApi;
  readonly social: SocialApi;
  personId(): PersonId;
  /** The mouse may point at things now: weapon sheathed, not on the road, not dead, street camera. */
  active(): boolean;
  body(): { x: number; y: number; z: number } | null;
  goTo(order: GoOrder): Result;
}

interface Found {
  target: TargetRef;
  x: number;
  z: number;
  label: string;
  sublabel: string;
  tone?: LabelTone;
  mark: HoverMark | null;
  ring: { kind: 'person' | 'animal'; id: number } | null;
}

const CROPS: Record<string, string> = {
  wheat: 'wheat', rye: 'rye', barley: 'barley', oats: 'oats', peas: 'peas', beans: 'beans', flax: 'flax', cabbage: 'cabbages',
  onions: 'onions', leeks: 'leeks', turnips: 'turnips', fallow: 'fallow',
};

export class PointerController {
  private readonly info: HoverInfo = {
    target: { kind: 'self' }, label: '', sublabel: '', action: null, preview: '', enabled: false, category: '', cursor: 'default',
    distance: 0, x: 0, y: 0, version: 0,
  };
  private shown = false;
  private px = -1;
  private py = -1;
  private pointerValid = false;
  private lastResolve = -10;
  private lastSig = '';
  private mark: HoverMark | null = null;
  private ring: { kind: 'person' | 'animal'; id: number } | null = null;
  private readonly scratch: InteractCandidate[] = [];
  private readonly cache = new Map<string, { at: number; list: ActionOption[] }>();
  private readonly foundObj: Found = { target: { kind: 'self' }, x: 0, z: 0, label: '', sublabel: '', mark: null, ring: null };

  constructor(private readonly host: PointerHost, private readonly port: PickPort) {}

  /** The cursor moved over the world (client pixels). */
  move(x: number, y: number): void {
    this.px = x; this.py = y;
    this.pointerValid = true;
    this.info.x = x; this.info.y = y;
    if (now() - this.lastResolve >= RESOLVE_INTERVAL) this.refresh();
  }

  /** Time passes: the thing under a still cursor changes as the world moves. (Real time: it runs the same while the world is held still.) */
  tick(_dt: number): void {
    if (!this.pointerValid) return;
    if (!this.host.active()) { this.clear(); return; }
    if (now() - this.lastResolve >= RESOLVE_INTERVAL) this.refresh();
  }

  leave(): void {
    this.pointerValid = false;
    this.clear();
  }

  hover(): HoverInfo | null { return this.shown && this.host.active() ? this.info : null; }

  /** A left click: walk to what is under the cursor and act. */
  click(x: number, y: number): Result {
    if (!this.host.active()) return { ok: false };
    this.px = x; this.py = y;
    const f = this.resolve(x, y);
    if (!f) return { ok: false };
    return this.host.goTo({ target: f.target, x: f.x, z: f.z, label: f.label });
  }

  // ---------------------------------------------------------------------------------------------

  private clear(): void {
    if (this.shown) { this.shown = false; this.info.version++; }
    this.lastSig = '';
    this.applyOutline(null);
  }

  private refresh(): void {
    this.lastResolve = now();
    if (!this.host.active() || !this.pointerValid) { this.clear(); return; }
    const f = this.resolve(this.px, this.py);
    if (!f) { this.clear(); return; }
    this.describe(f);
    this.applyOutline(f);
  }

  /** What is under the cursor, or null (the sky, the player's own body). */
  private resolve(x: number, y: number): Found | null {
    const host = this.host;
    const me = host.personId();
    const pk = this.port.pick(x, y);
    const ray = this.port.ray(x, y);
    if (pk.type === 'character' && pk.id !== undefined) return pk.id === me ? null : this.person(pk.id);
    if (pk.type === 'animal' && pk.id !== undefined) {
      const a = this.animal(pk.id);
      if (a) return a;
    }
    const hitDist = pk.point && ray ? Math.hypot(pk.point.x - ray.x, pk.point.y - ray.y, pk.point.z - ray.z) : 90;
    if (ray) {
      const sc = pickScatter(host.sim.world, host.sim.view.felled(), ray, Math.min(hitDist, 90));
      if (sc) return this.scatter(sc.id, sc.kind, sc.x, sc.z);
    }
    if (pk.type === 'building' && pk.id !== undefined) return this.building(pk.id);
    if (pk.type === 'ground' && pk.point) return this.ground(pk.point.x, pk.point.z);
    return null;
  }

  private found(target: TargetRef, x: number, z: number, label: string, sublabel = ''): Found {
    const f = this.foundObj;
    f.target = target; f.x = x; f.z = z; f.label = label; f.sublabel = sublabel; f.tone = undefined; f.mark = null; f.ring = null;
    return f;
  }

  private person(id: PersonId): Found | null {
    const st = this.host.sim.state;
    const p = st.persons.get(id);
    if (!p || p.death) return null;
    const a = this.host.zone.agent(id);
    const f = this.found({ kind: 'person', id }, a ? a.x : 0, a ? a.z : 0, fullName(p));
    const d = a?.draw;
    let sub = d?.sublabel ?? '';
    if (!sub) {
      const rel = this.host.social.relationLabel(this.host.personId(), id);
      const role = roleLabel(p.career, p.careerStage, p.sex);
      sub = [rel, role && role.toLowerCase() !== rel.toLowerCase() ? role.toLowerCase() : ''].filter(Boolean).join(', ');
    }
    f.sublabel = sub;
    f.tone = d?.labelTone;
    f.ring = { kind: 'person', id };
    return f;
  }

  private animal(id: number): Found | null {
    const an = this.host.zone.animals().find((x) => x.id === id);
    if (!an) return null;
    const f = this.found({ kind: 'animal', id }, an.x, an.z, this.labelAt(an.x, an.z, { kind: 'animal', id }) ?? an.kind);
    f.ring = { kind: 'animal', id };
    return f;
  }

  private building(id: number): Found | null {
    const b = this.host.sim.state.buildings.get(id);
    if (!b) return null;
    const door = this.host.zone.nav.doorOf(id);
    const x = door ? door.x : b.x, z = door ? door.z : b.z;
    const label = this.labelAt(x, z, { kind: 'building', id }) ?? BUILDINGS[b.kind]?.name ?? 'Building';
    const f = this.found({ kind: 'building', id }, x, z, label);
    f.mark = { kind: 'building', id, x: b.x, z: b.z };
    return f;
  }

  private scatter(id: number, kind: string, x: number, z: number): Found {
    const label = this.labelAt(x, z, { kind: 'scatter', id }) ?? SCATTER_NAME[kind as keyof typeof SCATTER_NAME] ?? 'Tree';
    const f = this.found({ kind: 'scatter', id }, x, z, label);
    f.mark = { kind: 'scatter', id, x, z };
    return f;
  }

  /** Strips and commons under a ground point; plain ground otherwise. */
  private ground(x: number, z: number): Found {
    const list = this.host.zone.interactables(x, z, 0, 0.5, this.scratch);
    for (const c of list) {
      const k = c.target.kind;
      if (k === 'strip' || k === 'parcel') {
        const f = this.found(c.target, x, z, c.label);
        f.mark = { kind: k, id: c.target.id };
        if (k === 'strip') f.sublabel = this.stripNote(c.target.id);
        return f;
      }
      if (k === 'item') {
        const f = this.found(c.target, c.x, c.z, c.label);
        f.mark = { kind: 'item', id: c.target.id, x: c.x, z: c.z };
        return f;
      }
    }
    return this.found({ kind: 'ground', x, z }, x, z, '');
  }

  private stripNote(id: number): string {
    const s = this.host.sim.state.strips.get(id);
    if (!s) return '';
    const crop = CROPS[s.crop] ?? s.crop;
    return s.crop === 'fallow' ? '' : `${crop}, ${s.state}`;
  }

  /** The zone's own name for a thing ("Your home", "Wat's smithy"), looked up where it stands. */
  private labelAt(x: number, z: number, target: TargetRef): string | null {
    const list = this.host.zone.interactables(x, z, 0, 3, this.scratch);
    for (const c of list) if (c.target.kind === target.kind && (c.target as { id?: number }).id === (target as { id?: number }).id) return c.label;
    return null;
  }

  private options(target: TargetRef): ActionOption[] {
    if (target.kind === 'ground') return [];
    const key = targetKey(target);
    const t = now();
    const hit = this.cache.get(key);
    if (hit && t - hit.at < OPTIONS_CACHE) return hit.list;
    const list = this.host.sim.actions.list(this.host.personId(), target);
    this.cache.set(key, { at: t, list });
    if (this.cache.size > 24) for (const [k, v] of this.cache) if (t - v.at >= OPTIONS_CACHE) this.cache.delete(k);
    return list;
  }

  /** Fills the hover info for what was found. */
  private describe(f: Found): void {
    const body = this.host.body();
    const d = body ? dist(body.x, body.z, f.x, f.z) : 0;
    const list = this.options(f.target);
    const def = list.find((o) => o.enabled) ?? null;
    const first = def ?? list[0] ?? null;
    let action: string | null = null;
    let preview = '';
    let enabled = false;
    let category = '';
    let cursor: CursorKind = f.target.kind === 'ground' ? 'walk' : 'default';
    const far = d > CLICK_WALK_RANGE;
    if (first) {
      category = first.category;
      enabled = first.enabled;
      action = first.label;
      preview = first.enabled ? first.preview ?? '' : first.reason ?? '';
      if (first.enabled) cursor = cursorFor(first);
    } else if (f.target.kind === 'ground') {
      enabled = !far;
      action = null;
    } else {
      // something nameable with nothing to do: a click still walks up to it
      enabled = !far;
    }
    if (far) {
      cursor = 'default';
      preview = `${Math.round(d)} m away: too far to walk to by clicking`;
      enabled = false;
    }
    const sig = `${f.target.kind}:${(f.target as { id?: number }).id ?? ''}|${f.label}|${f.sublabel}|${action}|${preview}|${enabled}|${cursor}|${Math.round(d / 2)}`;
    const info = this.info;
    if (!this.shown || sig !== this.lastSig) {
      this.lastSig = sig;
      info.target = f.target; info.label = f.label; info.sublabel = f.sublabel; info.tone = f.tone;
      info.action = action; info.preview = preview; info.enabled = enabled; info.category = category; info.cursor = cursor;
      info.distance = d;
      info.version++;
    }
    info.distance = d;
    this.shown = f.label !== '' || f.target.kind === 'ground';
  }

  /** Rings round people and animals, outlines on buildings, strips and trees. */
  private applyOutline(f: Found | null): void {
    const want = f?.ring ?? null;
    const cur = this.ring;
    if (cur && (!want || want.kind !== cur.kind || want.id !== cur.id)) this.setRing(cur, 0);
    if (want) this.setRing(want, 1);
    this.ring = want;
    // people and animals are ringed through the renderer too (its nameplate then stays on them)
    const wm: HoverMark | null = f?.mark ?? (f?.ring ? { kind: f.ring.kind, id: f.ring.id } : null);
    const cm = this.mark;
    if ((wm === null) !== (cm === null) || (wm && cm && (wm.kind !== cm.kind || wm.id !== cm.id))) {
      this.port.setHover?.(wm);
      this.mark = wm ? { ...wm } : null;
    }
  }

  private setRing(r: { kind: 'person' | 'animal'; id: number }, level: 0 | 1): void {
    const zone = this.host.zone;
    if (r.kind === 'person') {
      const a = zone.agent(r.id);
      if (!a) return;
      if (level === 1 && a.draw.highlight < 1) a.draw.highlight = 1;
      else if (level === 0 && a.draw.highlight === 1) a.draw.highlight = 0;
    } else {
      const a = zone.animals().find((x) => x.id === r.id);
      if (!a) return;
      if (level === 1 && a.draw.highlight < 1) a.draw.highlight = 1;
      else if (level === 0 && a.draw.highlight === 1) a.draw.highlight = 0;
    }
  }
}

/** The cursor image a default action asks for. */
export function cursorFor(o: Pick<ActionOption, 'category' | 'label'>): CursorKind {
  switch (o.category) {
    case 'talk': return 'talk';
    case 'trade': return 'trade';
    case 'work': return 'work';
    case 'combat': return 'attack';
    default: return /^(go in|enter|open|knock)/i.test(o.label) ? 'enter' : 'use';
  }
}
