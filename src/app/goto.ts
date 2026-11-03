// "Go to…" (H1): travel within your lands by skipping the walk. A list of the places of your settlement and its lands — what they are and
// who keeps them (the smithy, Wat the smith; the mill; the market and its stalls; the merchant; the fisherman's landing; the church;
// the alehouse; the manor; your fields; your work; your lord; the household at work; the fields of farmers you know; the next village).
// Choosing one: the time a walk (or a ride) there would take passes as in any skip — needs, the world and the people go on — and you
// stand at its door or edge. Refused, with the reason, in or near a fight, on the host's march or in a siege, bound or held, on the
// road of a map journey, on hostile land, when it is too far, and when the place is not one you know. Nothing here is saved: the skip is
// the sim's own `waitUntil`, the body is placed when it ends. Map travel to far settlements and the campaign's march are not this.
import type { ZoneApi } from '../agents/types';
import { doorStand } from '../agents/geometry';
import { BUILDINGS, type BuildingKind } from '../content/types';
import { DAY_SECONDS, isNight } from '../core/time';
import type { ActionOption, ActionProvider } from '../sim/actions';
import type { PlayerApi } from '../player/types';
import { ageFactor, agilityFactor, RIDE_CANTER, RUN_SPEED } from '../player/movement';
import { ageYears } from '../sim/state';
import { fullName, type PersonId } from '../sim/state';
import { roleLabel } from '../sim/careers';
import type { EconomyApi } from '../sim/economy/types';
import type { LawApi } from '../sim/law/types';
import type { Simulation } from '../sim/sim';
import type { SocialApi } from '../sim/social/types';
import type { TerritoryApi } from '../sim/territory/types';

export type GotoGroup = 'home' | 'yours' | 'village' | 'people' | 'lands';

export const GOTO_GROUP_TITLES: Record<GotoGroup, string> = {
  home: 'Home', yours: 'Yours', village: 'In the village', people: 'People you know', lands: 'Your lands and the next villages',
};

export interface GotoPlace {
  /** Stable within a run: `b12` (a building), `s7` (a strip), `p3` (a parcel), `t2` (a settlement). */
  id: string;
  name: string;
  /** Who keeps it / what it is, in a few words. */
  sub: string;
  icon: string;
  group: GotoGroup;
  /** Where the place is (for the distance and the order), and where you stand on arrival. */
  x: number;
  z: number;
  stand: { x: number; z: number; yaw: number };
  settlement: number;
  /** Objectives/finder kind, so other lists can match: 'building' | 'strip' | 'settlement' | 'place'. */
  kind: 'building' | 'strip' | 'settlement' | 'place';
  ref: number;
}

export interface GotoCheck {
  ok: boolean;
  reason?: string;
  /** A caution that does not refuse (the dark). */
  warn?: string;
  /** Seconds of body time a walk there would take (game seconds that pass). */
  seconds: number;
  metres: number;
  mounted: boolean;
}

/** What the page and the other lists use (`GameServices.goto`). */
export interface GotoApi {
  places(): GotoPlace[];
  /** `known` (the list `places()` gave) saves making it again for each row. */
  check(p: GotoPlace, known?: readonly GotoPlace[]): GotoCheck;
  go(p: GotoPlace): { ok: boolean; reason?: string };
  /** A place by the finder's/objectives' kind and id, or a bare spot (nearest listed place within a few metres). */
  find(spot: { kind?: string; id?: number; x: number; z: number }): GotoPlace | null;
  /** True while the walk is passing. */
  busy(): boolean;
}

export interface GotoEnv {
  sim: Simulation;
  player: Pick<PlayerApi, 'body' | 'placeAt'> & Partial<Pick<PlayerApi, 'mounted' | 'restraint' | 'travel'>>;
  zone: Pick<ZoneApi, 'ledBy'> & { nav: Pick<ZoneApi['nav'], 'doorOf'> };
  /** The campaign's phase ('march' | 'camp' | 'before' | 'storm') or null. */
  campaignPhase(): string | null;
  economy?: Pick<EconomyApi, 'employment' | 'holding'>;
  social?: Pick<SocialApi, 'relations'>;
}

/** Furthest a place may be (m, straight): your lands and a few kilometres, never a journey. */
export const GOTO_RANGE = 4500;
/** A walk is this much longer than the straight line (paths, fences, the lie of the land). */
export const DETOUR = 1.3;
/** Closer than this you are there already. */
export const HERE = 14;
/** The shortest skip (s): even a few steps take a moment. */
export const MIN_SECONDS = 20;
/** The nearest-to-a-settlement-edge place for another village: this far (m) short of its middle. */
const EDGE_OFF = 0.8;

interface KindDef { kinds: readonly BuildingKind[]; name: string; icon: string; group: GotoGroup; all?: boolean; keeper?: string }

/** The buildings worth a name on the page, in the order they are listed. `all`: every one is listed, not the nearest only. */
const KINDS: readonly KindDef[] = [
  { kinds: ['smithy'], name: 'The smithy', icon: 'smithing', group: 'village' },
  { kinds: ['watermill', 'windmill'], name: 'The mill', icon: 'wheat', group: 'village' },
  { kinds: ['market_hall', 'market_cross'], name: 'The market', icon: 'market', group: 'village' },
  { kinds: ['market_stall'], name: 'A market stall', icon: 'market', group: 'village', all: true },
  { kinds: ['guildhall', 'warehouse'], name: 'The merchant', icon: 'coin', group: 'village' },
  { kinds: ['dock'], name: 'The fisherman’s landing', icon: 'drop', group: 'village' },
  { kinds: ['church', 'chapel', 'abbey_church', 'cathedral'], name: 'The church', icon: 'church', group: 'village' },
  { kinds: ['alehouse', 'tavern'], name: 'The alehouse', icon: 'cup', group: 'village' },
  { kinds: ['bakehouse'], name: 'The bakehouse', icon: 'bread', group: 'village' },
  { kinds: ['carpenter', 'sawpit'], name: 'The carpenter', icon: 'carpentry', group: 'village' },
  { kinds: ['tannery'], name: 'The tannery', icon: 'hammer', group: 'village' },
  { kinds: ['weaver'], name: 'The weaver', icon: 'tailoring', group: 'village' },
  { kinds: ['manor_house', 'great_hall', 'keep_stone', 'motte'], name: 'The manor', icon: 'crown', group: 'village' },
  { kinds: ['school', 'library'], name: 'The school', icon: 'book', group: 'village' },
  { kinds: ['archery_butts'], name: 'The archery butts', icon: 'archery', group: 'village' },
  { kinds: ['well'], name: 'The well', icon: 'pin', group: 'village' },
  { kinds: ['tithe_barn'], name: 'The tithe barn', icon: 'box', group: 'village' },
];

const FARMERS: ReadonlySet<string> = new Set(['farmer', 'cottar', 'yeoman', 'labourer']);

const dist = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

/** The public face of a settlement kind for the page. */
function townWord(kind: string): string { return kind === 'hamlet' ? 'a hamlet' : kind === 'castle' ? 'a castle' : kind === 'town' ? 'a town' : kind === 'city' ? 'a city' : kind === 'abbey' || kind === 'priory' || kind === 'nunnery' ? 'a religious house' : 'a village'; }

export function polyCentre(poly: ReadonlyArray<{ x: number; z: number }>): { x: number; z: number } {
  return { x: poly.reduce((a, q) => a + q.x, 0) / poly.length, z: poly.reduce((a, q) => a + q.z, 0) / poly.length };
}

/** The corner or edge midpoint of a field nearest to (fx, fz): you stand at the edge of a strip, not in the crop. */
function edgeOf(poly: ReadonlyArray<{ x: number; z: number }>, fx: number, fz: number): { x: number; z: number } {
  const c = polyCentre(poly);
  let best = c, bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const m = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const d = dist(m.x, m.z, fx, fz);
    if (d < bd) { bd = d; best = m; }
  }
  // a pace outside the edge, so the body is on the headland and not in the furrows
  const dx = best.x - c.x, dz = best.z - c.z, n = Math.hypot(dx, dz) || 1;
  return { x: best.x + (dx / n) * 1.5, z: best.z + (dz / n) * 1.5 };
}

export class GotoMode {
  private pending: { label: string; place: GotoPlace; led: Array<{ id: number }> } | null = null;
  private offs: Array<() => void> = [];

  constructor(private readonly env: GotoEnv) {
    const { sim } = env;
    this.offs.push(
      sim.events.on('skip', (e) => {
        const p = this.pending;
        if (!p || e.label !== p.label) return;
        if (e.phase === 'start') return;
        this.pending = null;
        if (e.phase === 'cancel') { this.say('You change your mind and stay where you are.'); return; }
        this.arrive(p.place, p.led);
      }),
    );
  }

  dispose(): void { for (const off of this.offs) off(); this.offs = []; }

  busy(): boolean { return this.pending !== null; }

  private get pid(): PersonId { return this.env.sim.state.run.playerId; }
  private say(text: string, kind: 'info' | 'warn' = 'info'): void { this.env.sim.events.emit('notify', { kind, text, person: this.pid }); }

  // ---- the places ----

  places(): GotoPlace[] {
    const { sim, economy, social } = this.env;
    const st = sim.state;
    const me = st.persons.get(this.pid);
    const body = this.env.player.body();
    if (!me || !body) return [];
    const out: GotoPlace[] = [];
    const seen = new Set<string>();
    const add = (p: GotoPlace | null): void => { if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); } };
    const hh = st.households.get(me.household);
    const home = hh ? st.buildings.get(hh.home) : undefined;
    const homeSpot = home ?? body;
    // keepers: the head of the household that lives or works in a building
    const keeperOf = (b: { household: number }): string => {
      const h = b.household ? st.households.get(b.household) : undefined;
      const p = h ? st.persons.get(h.head) : undefined;
      if (!p || p.death) return '';
      return `${fullName(p)}, ${roleLabel(p.career, p.careerStage, p.sex).toLowerCase()}`;
    };
    const settlementName = (id: number): string => sim.world.settlements.find((s) => s.id === id)?.name ?? '';

    if (home) add(this.building(home.id, 'Home', hh && hh.members.length > 1 ? `Your household, ${settlementName(home.settlement)}` : settlementName(home.settlement), 'home', 'home'));

    // yours: the work, the fields, the garden, the lord, the household at work
    const emp = economy?.employment(this.pid);
    if (emp?.building !== undefined) {
      const wb = st.buildings.get(emp.building);
      if (wb && wb.id !== home?.id) add(this.building(wb.id, `Your work: ${BUILDINGS[wb.kind].name.toLowerCase()}`, emp.title, 'hammer', 'yours'));
    }
    const holding = hh && economy ? economy.holding(hh.id) : null;
    if (holding) {
      holding.strips.slice(0, 8).forEach((s, i) => add(this.strip(s.id, `Your field ${i + 1}`, s.crop === 'fallow' ? 'lying fallow' : String(s.crop), 'yours', homeSpot)));
      const garden = sim.world.parcels.find((q) => q.id === holding.gardenParcel);
      if (garden) {
        const c = polyCentre(garden.poly), e = edgeOf(garden.poly, homeSpot.x, homeSpot.z);
        add({ id: `p${garden.id}`, name: 'Your garden', sub: 'Behind the house', icon: 'farming', group: 'yours', x: c.x, z: c.z, stand: { x: e.x, z: e.z, yaw: Math.atan2(c.x - e.x, c.z - e.z) }, settlement: garden.settlement, kind: 'place', ref: garden.id });
      }
    }
    const lord = this.lordOf(me.settlement);
    if (lord) {
      const lh = st.households.get(lord.household);
      const lb = lh ? st.buildings.get(lh.home) : undefined;
      if (lb) add(this.building(lb.id, `Your lord: ${fullName(lord)}`, `${BUILDINGS[lb.kind].name}, ${settlementName(lb.settlement)}`, 'crown', 'yours'));
    }
    if (hh && economy) {
      for (const m of hh.members) {
        if (m === this.pid) continue;
        const p = st.persons.get(m);
        const e = economy.employment(m);
        const b = e?.building !== undefined ? st.buildings.get(e.building) : undefined;
        if (p && !p.death && b && b.id !== home?.id) add(this.building(b.id, `${p.first} at work`, `${e!.title}, ${BUILDINGS[b.kind].name.toLowerCase()}`, 'user', 'yours', `w${m}`));
      }
    }

    // the village: each sort of building near your home (the nearest of its kind; every stall)
    const list = st.buildingsAt.get(me.settlement) ?? [];
    for (const def of KINDS) {
      const cands = list.filter((b) => def.kinds.includes(b.kind) && b.construction >= 1);
      if (!cands.length) continue;
      cands.sort((a, b) => dist(a.x, a.z, homeSpot.x, homeSpot.z) - dist(b.x, b.z, homeSpot.x, homeSpot.z));
      for (const b of def.all ? cands.slice(0, 6) : cands.slice(0, 1)) {
        if (b.id === home?.id) continue;
        const k = keeperOf(b);
        add(this.building(b.id, def.all && k ? `${def.name}: ${k.split(',')[0]}` : def.name, k || BUILDINGS[b.kind].name, def.icon, def.group));
      }
    }
    // the merchant: the man himself, at his place of work or his door, when no hall of the guild stands
    if (!out.some((p) => p.name === 'The merchant')) {
      const m = this.personWith(me.settlement, ['merchant', 'peddler', 'shopkeeper']);
      const b = m ? this.workplaceOf(m) : undefined;
      if (m && b) add(this.building(b.id, 'The merchant', `${fullName(m)}, ${roleLabel(m.career, m.careerStage, m.sex).toLowerCase()}`, 'coin', 'village', `m${m.id}`));
    }

    // people you know: farmers' fields
    if (social && economy) {
      let n = 0;
      for (const r of social.relations(this.pid)) {
        if (n >= 5) break;
        const p = st.persons.get(r.person);
        if (!p || p.death || p.household === me.household || p.settlement !== me.settlement || !FARMERS.has(p.career)) continue;
        const h = economy.holding(p.household);
        const s = h?.strips[0];
        if (!s) continue;
        add(this.strip(s.id, `${p.first}’s field`, `${fullName(p)}, ${roleLabel(p.career, p.careerStage, p.sex).toLowerCase()}`, 'people', homeSpot));
        n++;
      }
    }

    // your lands and the next villages within a few kilometres
    const nearby = sim.world.settlements
      .filter((s) => s.id !== me.settlement && dist(s.x, s.z, homeSpot.x, homeSpot.z) <= GOTO_RANGE)
      .filter((s) => (lord && s.id === lord.settlement) || s.kind === 'village' || s.kind === 'hamlet' || s.kind === 'town')
      .sort((a, b) => dist(a.x, a.z, homeSpot.x, homeSpot.z) - dist(b.x, b.z, homeSpot.x, homeSpot.z))
      .slice(0, 8);
    for (const s of nearby) {
      const d = dist(s.x, s.z, homeSpot.x, homeSpot.z);
      // the road in from your side: a short way inside the edge
      const dx = homeSpot.x - s.x, dz = homeSpot.z - s.z, n = Math.hypot(dx, dz) || 1;
      const r = Math.max(30, s.radius * EDGE_OFF);
      const sx = s.x + (dx / n) * r, sz = s.z + (dz / n) * r;
      add({ id: `t${s.id}`, name: s.name, sub: `${townWord(s.kind)}, ${(d / 1000).toFixed(1)} km`, icon: 'pin', group: 'lands', x: s.x, z: s.z, stand: { x: sx, z: sz, yaw: Math.atan2(s.x - sx, s.z - sz) }, settlement: s.id, kind: 'settlement', ref: s.id });
    }

    const order: GotoGroup[] = ['home', 'yours', 'village', 'people', 'lands'];
    return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || dist(a.x, a.z, body.x, body.z) - dist(b.x, b.z, body.x, body.z));
  }

  private lordOf(settlement: number) {
    const t = this.env.sim.services.territory as TerritoryApi | undefined;
    const id = t?.ownerOf?.(settlement)?.lord ?? 0;
    const p = id ? this.env.sim.state.persons.get(id) : undefined;
    return p && !p.death && id !== this.pid ? p : undefined;
  }

  private personWith(settlement: number, careers: string[]) {
    for (const p of this.env.sim.state.persons.values()) if (!p.death && p.settlement === settlement && careers.includes(p.career) && p.id !== this.pid) return p;
    return undefined;
  }

  private workplaceOf(p: { id: number; household: number }) {
    const st = this.env.sim.state;
    const e = this.env.economy?.employment(p.id);
    if (e?.building !== undefined) { const b = st.buildings.get(e.building); if (b) return b; }
    const h = st.households.get(p.household);
    return h ? st.buildings.get(h.home) : undefined;
  }

  private building(id: number, name: string, sub: string, icon: string, group: GotoGroup, key?: string): GotoPlace | null {
    const b = this.env.sim.state.buildings.get(id);
    if (!b) return null;
    const d = this.env.zone.nav.doorOf(id) ?? doorStand(b, { x: 0, z: 0, yaw: 0 });
    return { id: key ?? `b${id}`, name, sub, icon, group, x: b.x, z: b.z, stand: { x: d.x, z: d.z, yaw: d.yaw + Math.PI }, settlement: b.settlement, kind: 'building', ref: id };
  }

  private strip(id: number, name: string, sub: string, group: GotoGroup, from: { x: number; z: number }): GotoPlace | null {
    const poly = this.env.sim.world.strips.find((q) => q.id === id)?.poly;
    if (!poly) return null;
    const c = polyCentre(poly), e = edgeOf(poly, from.x, from.z);
    return { id: `s${id}`, name, sub, icon: 'farming', group, x: c.x, z: c.z, stand: { x: e.x, z: e.z, yaw: Math.atan2(c.x - e.x, c.z - e.z) }, settlement: this.env.sim.world.strips.find((q) => q.id === id)!.settlement, kind: 'strip', ref: id };
  }

  find(spot: { kind?: string; id?: number; x: number; z: number }): GotoPlace | null {
    const all = this.places();
    if (spot.id !== undefined && spot.id >= 0 && spot.kind) {
      const key = spot.kind === 'building' ? `b${spot.id}` : spot.kind === 'strip' ? `s${spot.id}` : spot.kind === 'settlement' ? `t${spot.id}` : '';
      const hit = all.find((p) => p.id === key || (p.kind === spot.kind && p.ref === spot.id));
      if (hit) return hit;
    }
    let best: GotoPlace | null = null, bd = 40;
    for (const p of all) { const d = dist(p.x, p.z, spot.x, spot.z); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  // ---- the time and the refusals ----

  /** Game seconds a walk (or a ride) to the place would take. */
  private seconds(metres: number, mounted: boolean): number {
    const p = this.env.sim.state.persons.get(this.pid);
    let v = mounted ? RIDE_CANTER : RUN_SPEED;
    if (p) v *= agilityFactor(p.trained.agi) * ageFactor(ageYears(p, this.env.sim.absDay));
    return Math.max(MIN_SECONDS, (metres * DETOUR) / Math.max(0.5, v));
  }

  check(place: GotoPlace, known?: readonly GotoPlace[]): GotoCheck {
    const { sim, player } = this.env;
    const body = player.body();
    const mounted = !!player.mounted?.();
    const bad = (reason: string, metres = 0): GotoCheck => ({ ok: false, reason, seconds: 0, metres, mounted });
    const me = sim.state.persons.get(this.pid);
    if (!body || !me || me.death || sim.state.run.phase === 'over') return bad('You are not in a state to go anywhere.');
    const metres = dist(body.x, body.z, place.x, place.z);
    const phase = this.env.campaignPhase();
    if (phase) return bad('You are with the host: ride on with it, or leave it first.', metres);
    if (sim.hostileNear()) return bad('Not with a fight or hostile men near.', metres);
    if (player.travel?.()) return bad('You are on a journey: finish or turn back from it first.', metres);
    if (player.restraint?.()) return bad('You are bound; you cannot go where you please.', metres);
    const law = sim.services.law as LawApi | undefined;
    if (law?.captivity(this.pid)) return bad('You are held; you cannot go where you please.', metres);
    if (sim.clock.skip || this.pending) return bad('Time is passing already.', metres);
    if (sim.state.clock.actionTime) return bad('Not in the middle of the action.', metres);
    if (metres < HERE) return bad('You are there already.', metres);
    if (metres > GOTO_RANGE) return bad(`Too far: ${(metres / 1000).toFixed(1)} km. Keep to the roads, or use the map.`, metres);
    if (!(known ?? this.places()).some((p) => p.id === place.id)) return bad('You do not know that place.', metres);
    const terr = sim.services.territory as TerritoryApi | undefined;
    if (terr) {
      const here = terr.trespass(this.pid, body.x, body.z);
      if (here.level === 'hostile') return bad(`You are on hostile land (${here.reason}): get out of it on foot.`, metres);
      const there = terr.trespass(this.pid, place.stand.x, place.stand.z);
      if (there.level === 'hostile') return bad(`${place.name} lies on hostile land (${there.reason}).`, metres);
    }
    const seconds = this.seconds(metres, mounted);
    const out: GotoCheck = { ok: true, seconds, metres, mounted };
    if (isNight(sim.absDay)) out.warn = 'It is dark out of doors: you will arrive in the dark.';
    return out;
  }

  go(place: GotoPlace): { ok: boolean; reason?: string } {
    const c = this.check(place);
    if (!c.ok) return { ok: false, reason: c.reason };
    const { sim } = this.env;
    const label = `${c.mounted ? 'Riding' : 'Walking'} to ${place.name.replace(/^The /, 'the ')}…`;
    const led = this.env.zone.ledBy?.(this.pid)?.map((a) => ({ id: a.id })) ?? [];
    this.pending = { label, place, led };
    const until = sim.absDay + c.seconds / DAY_SECONDS;
    const r = sim.dispatch({ type: 'waitUntil', until: { test: () => sim.absDay >= until - 1e-6, label, maxDays: 2 } });
    if (!r.ok) { this.pending = null; return { ok: false, reason: r.reason ?? 'You cannot go now.' }; }
    return { ok: true };
  }

  /** The skip is over: stand at the door (the horse comes with the body; the led animals are brought up behind). */
  private arrive(place: GotoPlace, led: Array<{ id: number }>): void {
    const { player, zone } = this.env;
    player.placeAt(place.stand.x, place.stand.z, place.stand.yaw);
    const body = player.body();
    for (const l of led) {
      const a = zone.ledBy?.(this.pid)?.find((q) => q.id === l.id);
      if (a && body) { a.x = body.x - Math.sin(body.yaw) * 2; a.z = body.z - Math.cos(body.yaw) * 2; }
    }
    this.say(`You are at ${place.name.replace(/^The /, 'the ')}.`);
  }

  /** "Go there now" on a building under the cursor or in the action wheel. */
  provider(): ActionProvider {
    return {
      id: 'goto',
      list: (_c, actor, target, out: ActionOption[]) => {
        if (actor !== this.pid || target.kind !== 'building') return;
        const body = this.env.player.body();
        const b = this.env.sim.state.buildings.get(target.id);
        if (!b || !body || dist(b.x, b.z, body.x, body.z) < 60) return;
        const place = this.places().find((p) => p.kind === 'building' && p.ref === b.id);
        if (!place) return;
        const c = this.check(place);
        const o: ActionOption = {
          id: 'goto', provider: 'goto', label: 'Go there now', category: 'social', target, priority: 2, enabled: c.ok, seconds: 0, range: 600,
          preview: c.ok ? `Skip the walk (${spanText(c.seconds)})` : undefined,
        };
        if (!c.ok) o.reason = c.reason;
        out.push(o);
      },
      complete: (_c, _actor, option) => {
        if (option.target.kind !== 'building') return { ok: false };
        const place = this.places().find((p) => p.kind === 'building' && p.ref === (option.target as { id: number }).id);
        if (!place) return { ok: false, message: 'You do not know that place.' };
        const r = this.go(place);
        return r.ok ? { ok: true } : { ok: false, message: r.reason };
      },
    };
  }

  api(): GotoApi {
    return { places: () => this.places(), check: (p, known) => this.check(p, known), go: (p) => this.go(p), find: (s) => this.find(s), busy: () => this.busy() };
  }
}

/** "40 minutes", "1 hour 10 min" of the game's clock for a span of body seconds (a day is DAY_SECONDS of them). */
export function spanText(seconds: number): string {
  const m = Math.max(1, Math.round((seconds / DAY_SECONDS) * 24 * 60));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60), r = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${r ? ` ${r} min` : ''}`;
}
