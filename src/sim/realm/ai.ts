// The AI rulers (docs/CIV.md §10, docs/REALM.md "The AI rulers"): every House that rules land runs the player's own loop with the
// same calls, costs and labour - plan works, set the works share, research, recruit and dub, trade, plan the fields, found
// outposts at deposits its lands lack - once a week (a four-day season), the rulers dealt over the 96 hours of the week so that about
// one is due each hour, each round cut into four shards (sense and book-keeping, works, arms, learning and outposts) so that no call
// is long. `installRealm` installs it (`installRealm(sim, deps, { ai: false })` leaves it out). No cheats: a ruler's purse, stores,
// men and the techniques his House commands are the only things he has, and what he asks of the builder, the markets and the realm
// he asks as any lord may. The player's own House is never run (the player is its ruler).
//
// State: `state.ext['realm.ai']` holds only what a ruler must remember to behave the same after a load: what failed and until
// when, what he has told the neighbours, when he last did a thing, and the works he started (for the yearly table). Everything
// else is read from the world each round, so save -> load -> continue gives the same state hash.
import { DAYS_PER_YEAR } from '../../core/time';
import type { HourInfo } from '../clock';
import type { HouseId, PersonId } from '../state';
import type { PoliticsRuntime } from '../politics/types';
import { AI } from './aiConfig';
import { armsRound } from './aiMilitary';
import { researchRound } from './aiResearch';
import { outpostChoose, outpostAct, type OutpostPending } from './aiOutpost';
import { senseOf, unitsOf, type AiUnit, type Sense } from './aiSense';
import { bookkeeping } from './aiTrade';
import { worksAct, worksChoose, type Pending } from './aiWorks';
import { yearCounts } from './news';
import type { Rlm } from './store';

export const AI_EXT = 'realm.ai';

/**
 * The stages of a round, one per shard of the hourly system: 0 the look round and the book-keeping (fields, orders), 1 the choice of
 * what to build, 2 the building of it, 3 arms, 4 learning and the choice of an outpost, 5 the founding of it. The dear calls (looking
 * for a spot, staking out a site, the market's census after it) fall in different shards so that no call is long.
 */
export const SHARDS = 6;

/** What a House's rulers remember. */
export interface AiHouseRec {
  /** Things that did not work, until this absolute day ("w:47:cottage": no room; "r:watermill": refused; "m:812": no mending). */
  no: Record<string, number>;
  /** How many times in a row each failed (the wait doubles each time, up to eightfold). */
  nf: Record<string, number>;
  /** Day the House last told the neighbours something, by key (so the news is not a stream). */
  said: Record<string, number>;
  /** Day a thing was last done: research, recruit, dub, outpost, orders. */
  at: Record<string, number>;
  /** Outposts founded by the House's rulers. */
  outs: number;
  /** Works staked out this game year: [year, works, of them homes]. */
  yr: [number, number, number];
}

/** The yearly table: what the rulers did in a game year. */
export interface YearStats {
  /** Works staked out by the rulers (new buildings, improvements and mending), and the new buildings among them. */
  placed: number;
  built: number;
  upgrades: number;
  repairs: number;
  /** Homes, and defence works (palisade, wall, tower, gatehouse, motte, keep), staked out. */
  homes: number;
  defence: number;
  /** Works of the rulers that were finished, and given up. */
  done: number;
  cancelled: number;
  /** Outposts founded. */
  outposts: number;
  /** Research started and techniques worked out. */
  research: number;
  techs: number;
  /** Men taken on, knights dubbed. */
  recruits: number;
  knights: number;
  /** Trade orders given, fields planned. */
  orders: number;
  crops: number;
}

export function emptyYear(): YearStats {
  return { placed: 0, built: 0, upgrades: 0, repairs: 0, homes: 0, defence: 0, done: 0, cancelled: 0, outposts: 0, research: 0, techs: 0, recruits: 0, knights: 0, orders: 0, crops: 0 };
}

export interface AiSave {
  v: 1;
  h: Record<string, AiHouseRec>;
  y: Record<string, YearStats>;
  /** The rulers' open works: [site, day staked out, kind, work, place, House]. */
  s: Array<[number, number, string, string, number, number]>;
  /** Research the rulers started: project ids. */
  r: number[];
  /** How far each open work had got when it last moved: site -> [progress, day it last moved]. */
  g: Record<string, [number, number]>;
}

export function emptyAiSave(): AiSave { return { v: 1, h: {}, y: {}, s: [], r: [], g: {} }; }

/** The module's surface for tests, tools and the dev pages. */
export interface RealmAi {
  readonly data: AiSave;
  /** Turn the rulers off or on (tests that want the world to themselves). */
  enabled: boolean;
  /** The yearly table so far, oldest first. */
  table(): Array<{ year: number } & YearStats>;
  /** The groups of places that rulers hold; the i-th is due in hour i of the week (96 hours), the 97th again in hour 0. */
  units(): AiUnit[];
  /** The rulers whose round falls in the hour (an hour index of the clock). */
  dueAt(hourIndex: number): AiUnit[];
  /** What a ruler sees now (null for a House the player runs). */
  sense(ruler: PersonId): Sense | null;
  /** Runs one ruler's whole round now (tests and tools; the hourly system does the same in four shards). */
  runRound(ruler: PersonId): void;
  dispose(): void;
}

export class Ai implements RealmAi {
  data: AiSave;
  enabled = true;
  private cache = new Map<PersonId, Sense | null>();
  /** What a ruler's round chose to do with the builder this hour, for the next shard to do (nothing is kept longer than the hour). */
  private pending = new Map<PersonId, Pending>();
  private outposts = new Map<PersonId, OutpostPending>();
  private unitsAt = -1;
  private cachedUnits: AiUnit[] = [];
  private dueHour = -1;
  private due: AiUnit[] = [];
  private offs: Array<() => void> = [];

  constructor(readonly R: Rlm) {
    const cur = R.state.ext[AI_EXT] as AiSave | undefined;
    if (cur && typeof cur === 'object' && cur.v === 1) {
      this.data = cur;
      const base = emptyAiSave() as unknown as Record<string, unknown>;
      const d = cur as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(base)) if (d[k] === undefined) d[k] = v;
    } else {
      this.data = emptyAiSave();
    }
  }

  // ---- time ----
  get day(): number { return this.R.day; }
  get yearIndex(): number { return Math.floor(this.R.day / DAYS_PER_YEAR); }

  // ---- saved records ----
  /** Marks the section changed (and creates it in the state on first use). */
  touch(): void {
    const st = this.R.state;
    if (st.ext[AI_EXT] !== this.data) st.ext[AI_EXT] = this.data;
    st.touchExt(AI_EXT);
  }

  rec(house: HouseId): AiHouseRec {
    const k = String(house);
    let r = this.data.h[k];
    if (!r) { r = { no: {}, nf: {}, said: {}, at: {}, outs: 0, yr: [-1, 0, 0] }; this.data.h[k] = r; }
    return r;
  }

  /** Is this thing put off for the House? */
  blocked(house: HouseId, key: string): boolean {
    const r = this.data.h[String(house)];
    const until = r?.no[key];
    return until !== undefined && until > this.day;
  }

  /** Puts a thing off for `days` days (the entry is dropped when it lapses). */
  block(house: HouseId, key: string, days: number): void {
    const r = this.rec(house);
    r.no[key] = Math.floor(this.day) + days;
    // lapsed entries go when the record grows
    const keys = Object.keys(r.no);
    if (keys.length > 60) for (const k of keys) if (r.no[k] <= this.day) { delete r.no[k]; delete r.nf[k]; }
    this.touch();
  }

  /** A thing that failed again: put off for `days`, twice as long each time it fails in a row (up to eight times as long). */
  fail(house: HouseId, key: string, days: number): void {
    const r = this.rec(house);
    const n = Math.min(3, r.nf[key] ?? 0);
    r.nf[key] = n + 1;
    this.block(house, key, days * (1 << n));
  }

  /** A thing that worked: its failures are forgotten. */
  worked(house: HouseId, key: string): void {
    const r = this.data.h[String(house)];
    if (r && r.nf[key] !== undefined) { delete r.nf[key]; this.touch(); }
  }

  /** Tools and tests: when set, the rounds write down why they did not do what they weighed. */
  trace: string[] | null = null;
  note(text: string): void { if (this.trace && this.trace.length < 4000) this.trace.push(`d${Math.floor(this.day)} ${text}`); }

  /** Has the House said this within `days`? */
  said(house: HouseId, key: string, days: number): boolean {
    const t = this.data.h[String(house)]?.said[key];
    return t !== undefined && this.day - t < days;
  }

  say(house: HouseId, key: string): void {
    const r = this.rec(house);
    r.said[key] = Math.floor(this.day);
    const keys = Object.keys(r.said);
    if (keys.length > 40) for (const k of keys) if (this.day - r.said[k] > 64) delete r.said[k];
    this.touch();
  }

  /** Works (and, among them, homes) the House has staked out in this game year. */
  placedThisYear(house: HouseId): { works: number; homes: number } {
    const y = this.data.h[String(house)]?.yr;
    return y && y[0] === this.yearIndex ? { works: y[1], homes: y[2] } : { works: 0, homes: 0 };
  }

  lastAt(house: HouseId, key: string): number { return this.data.h[String(house)]?.at[key] ?? -999; }
  mark(house: HouseId, key: string): void { this.rec(house).at[key] = Math.floor(this.day); this.touch(); }

  // ---- the yearly table ----
  year(): YearStats {
    const k = String(this.yearIndex);
    let y = this.data.y[k];
    if (!y) {
      y = emptyYear();
      this.data.y[k] = y;
      // the table keeps the last forty years
      const keys = Object.keys(this.data.y).map(Number).sort((a, b) => a - b);
      for (const old of keys.slice(0, Math.max(0, keys.length - 40))) delete this.data.y[String(old)];
    }
    return y;
  }

  table(): Array<{ year: number } & YearStats> {
    return Object.keys(this.data.y).map(Number).sort((a, b) => a - b).map((y) => ({ year: y + 1, ...this.data.y[String(y)] }));
  }

  // ---- works the rulers started ----
  sitePlaced(house: HouseId, site: number, kind: string, place: number, work: 'build' | 'upgrade' | 'repair' = 'build'): void {
    this.data.s.push([site, Math.floor(this.day), kind, work, place, house]);
    if (work !== 'repair') {
      const r = this.rec(house);
      if (r.yr[0] !== this.yearIndex) r.yr = [this.yearIndex, 0, 0];
      r.yr[1]++;
      if (work === 'build' && (kind === 'cottage' || kind === 'hovel' || kind === 'longhouse' || kind === 'townhouse')) r.yr[2]++;
    }
    if (this.data.s.length > 400) for (const old of this.data.s.splice(0, this.data.s.length - 400)) delete this.data.g[String(old[0])];
    const y = this.year();
    y.placed++;
    if (work === 'build') {
      y.built++;
      if (kind === 'cottage' || kind === 'hovel' || kind === 'longhouse' || kind === 'townhouse') y.homes++;
      if (kind === 'palisade' || kind === 'wall' || kind === 'tower' || kind === 'gatehouse' || kind === 'motte' || kind === 'keep_stone') y.defence++;
    } else if (work === 'upgrade') y.upgrades++;
    else y.repairs++;
    this.touch();
  }

  /** Age in days of one of the rulers' works (0 when it is not theirs). */
  siteAge(site: number): number {
    const e = this.data.s.find((x) => x[0] === site);
    return e ? this.day - e[1] : 0;
  }

  /** Notes how far a work has got (the day is kept only when it has moved). */
  watch(site: number, progress: number): void {
    const k = String(site);
    const m = this.data.g[k];
    if (m && Math.abs(progress - m[0]) <= 0.0005) return;
    this.data.g[k] = [Math.round(progress * 10000) / 10000, Math.floor(this.day)];
    this.touch();
  }

  /** Has the work stood still at its last step for so long that it is no longer counted among the open ones? */
  deadSite(site: number, progress: number): boolean {
    const m = this.data.g[String(site)];
    return !!m && progress >= 0.9 && Math.abs(progress - m[0]) <= 0.0005 && this.day - m[1] >= AI.deadDays;
  }

  siteGone(site: number, how: 'done' | 'cancelled'): void {
    delete this.data.g[String(site)];
    const i = this.data.s.findIndex((x) => x[0] === site);
    if (i < 0) return;
    this.data.s.splice(i, 1);
    const y = this.year();
    if (how === 'done') y.done++; else y.cancelled++;
    this.touch();
  }

  // ---- prices (the market's census is dear to rebuild after any building event: ask once an hour) ----
  private priceMemo = new Map<string, number>();
  private priceHour = -1;

  /** How dear a material is at the place's market, against its usual price (1 = usual); memoised for the hour. */
  priceRatio(place: number, good: string): number {
    const hour = Math.floor(this.R.day * 24 + 1e-6);
    if (hour !== this.priceHour) { this.priceMemo.clear(); this.priceHour = hour; }
    const key = `${place}:${good}`;
    let v = this.priceMemo.get(key);
    if (v === undefined) {
      const base = this.R.economy.good(good)?.basePrice ?? 1;
      const price = this.R.economy.price(place, good, 'buy');
      v = price > 0 && base > 0 ? price / base : 1.4;
      this.priceMemo.set(key, v);
    }
    return v;
  }

  private stockMemo = new Map<string, number>();
  private stockHour = -1;

  /** Units of a material in the market of a place; memoised for the hour (the market's census is dear to rebuild after a building event). */
  stockAt(place: number, good: string): number {
    const hour = Math.floor(this.R.day * 24 + 1e-6);
    if (hour !== this.stockHour) { this.stockMemo.clear(); this.stockHour = hour; }
    const key = `${place}:${good}`;
    let v = this.stockMemo.get(key);
    if (v === undefined) { v = this.R.economy.stockAt?.(place, good) ?? 0; this.stockMemo.set(key, v); }
    return v;
  }

  // ---- who is due ----
  units(): AiUnit[] {
    const hour = Math.floor(this.R.day * 24 + 1e-6);
    if (this.unitsAt !== hour) { this.cachedUnits = unitsOf(this.R); this.unitsAt = hour; }
    return this.cachedUnits;
  }

  dueAt(hourIndex: number): AiUnit[] {
    const slot = ((hourIndex % AI.periodHours) + AI.periodHours) % AI.periodHours;
    return this.units().filter((_, i) => i % AI.periodHours === slot);
  }

  sense(ruler: PersonId): Sense | null {
    const u = this.units().find((x) => x.ruler === ruler);
    return u ? senseOf(this, u) : null;
  }

  private senseCached(u: AiUnit): Sense | null {
    if (this.cache.has(u.ruler)) return this.cache.get(u.ruler) ?? null;
    const s = senseOf(this, u);
    this.cache.set(u.ruler, s);
    return s;
  }

  runRound(ruler: PersonId): void {
    const u = this.units().find((x) => x.ruler === ruler);
    if (!u) return;
    this.cache.clear();
    this.pending.clear();
    this.outposts.clear();
    for (let stage = 0; stage < SHARDS; stage++) this.stage(u, stage);
  }

  /** Tools: per-stage wall time (ms) of the rounds, when a tool sets it (stage 0 is the sense and the book-keeping). */
  timings: Array<{ n: number; ms: number; max: number }> | null = null;

  private stage(u: AiUnit, stage: number): void {
    const t0 = this.timings ? performance.now() : 0;
    const S = this.senseCached(u);
    if (S) {
      switch (stage) {
        case 0: bookkeeping(this, S); break;
        case 1: { const w = worksChoose(this, S); if (w) this.pending.set(u.ruler, w); break; }
        case 2: { const w = this.pending.get(u.ruler); if (w) { this.pending.delete(u.ruler); worksAct(this, S, w); } break; }
        case 3: armsRound(this, S); break;
        case 4: {
          if ((Math.floor(this.R.day / 4) + u.key) % 2 === 0) researchRound(this, S);
          const o = outpostChoose(this, S);
          if (o) this.outposts.set(u.ruler, o);
          break;
        }
        default: { const o = this.outposts.get(u.ruler); if (o) { this.outposts.delete(u.ruler); outpostAct(this, S, o); } break; }
      }
    }
    if (this.timings) {
      const dt = performance.now() - t0;
      const t = this.timings[stage] ?? (this.timings[stage] = { n: 0, ms: 0, max: 0 });
      t.n++; t.ms += dt; if (dt > t.max) t.max = dt;
    }
  }

  /** Tells the rival AI (politics) how much each House has grown this year, for its wars: "a strong neighbour that out-builds you comes for your lands". */
  private fed: PoliticsRuntime | null = null;
  private feedPolitics(): void {
    const pol = this.R.politics as unknown as PoliticsRuntime | undefined;
    if (!pol?.setGrowthSource || this.fed === pol) return;
    pol.setGrowthSource((house) => {
      const c = yearCounts(this.R, house);
      return c.built + 0.5 * c.techs + 0.25 * c.recruited;
    });
    this.fed = pol;
  }

  /** The hourly system: shard 0 finds who is due this hour, shard k does stage k for each. */
  hourly(info: HourInfo, shard: number): void {
    if (!this.enabled) return;
    if (shard === 0) this.feedPolitics();
    if (this.dueHour !== info.hourIndex) {
      this.cache.clear();
      this.pending.clear();
      this.outposts.clear();
      this.due = this.dueAt(info.hourIndex);
      this.dueHour = info.hourIndex;
    }
    for (const u of this.due) this.stage(u, shard);
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
    this.fed?.setGrowthSource?.(null);
    this.fed = null;
  }

  /** Registers the system and the listeners; returns the remover. */
  install(): () => void {
    const R = this.R;
    this.touch();
    this.offs.push(R.sim.registerSystem({
      name: 'realm.ai', phase: 'hourly', order: 85, shards: SHARDS,
      run: (_ctx, info, shard = 0) => this.hourly(info, shard),
    }));
    this.offs.push(R.sim.events.on('construction', (e) => {
      if (e.phase === 'done') this.siteGone(e.site, 'done');
      else if (e.phase === 'cancelled') this.siteGone(e.site, 'cancelled');
    }));
    this.offs.push(R.sim.events.on('research', (e) => {
      if (e.phase !== 'done') return;
      const i = this.data.r.indexOf(e.project);
      if (i < 0) return;
      this.data.r.splice(i, 1);
      this.year().techs++;
      this.touch();
    }));
    return () => this.dispose();
  }
}

/** Installs the AI rulers on a realm. */
export function installAi(R: Rlm): Ai {
  const A = new Ai(R);
  A.install();
  return A;
}
