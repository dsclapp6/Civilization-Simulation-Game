// Versioned serialization of GameState into independent JSON records (chunks of entities plus a
// meta record), so a save can rewrite only what changed. The WorldModel is not saved: it is
// regenerated from the seed on load and the dynamic state is laid over it.
//
// Record keys:  meta · p:<n> persons · hh:<n> households · hs:<n> houses · t:<n> titles ·
//               b:<n> buildings · st:<n> strips · s:<n> settlements · x:<name> ext sections
import type { BuildingKind } from '../content/types';
import type { CultureId, Difficulty, Estate, RankTier, SkillId } from '../core/domain';
import { SKILLS, STATS } from '../core/domain';
import type { StripState as StripStage } from '../core/view';
import type { WorldModel } from '../world/types';
import type { CareerId } from './careers';
import { refreshStrips } from './farming';
import { emptySkills, emptyStats } from './people';
import {
  CHUNK_SHIFT, GameState, NONE,
  type BuildingState, type ChronicleEntry, type Condition, type DeathCause, type DemographyState, type DirtyKind,
  type FlagId, type Genes, type House, type HouseKind, type Household, type HouseholdKind, type OfficeHold, type Person,
  type Pregnancy, type RunState, type ScoreState, type SettlementState, type StripState, type Title, type TitleKind,
  type TraitId, type WeatherState, type ClockState, type PersonFlags,
} from './state';

export const SAVE_VERSION = 1;

// ---------------------------------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------------------------------

interface PersonRec {
  i: number; f: string; b: string; x: 0 | 1; c: CultureId; bd: number;
  dd?: number; dc?: DeathCause;
  fa?: number; mo?: number; sp?: number; ch?: number[];
  hh?: number; ho?: number; se: number;
  es: Estate; rt: RankTier; ca: CareerId; cs?: number;
  of?: OfficeHold[];
  po: number[]; tr: number[];
  sk?: Partial<Record<SkillId, number>>;
  pk?: string[]; tt?: TraitId[];
  nd: number[]; hp: number; cd?: Condition[];
  mn?: number; inv?: Record<string, number>; pr?: number; rp: number[]; op?: Record<number, number>;
  am: string; fl?: FlagId[]; ge: number[]; pg?: Pregnancy; lb?: number; md?: number;
}

interface HouseholdRec { i: number; k: HouseholdKind; hd: number; m: number[]; h?: number; s: number; p?: number; st?: Record<string, number>; t?: number; hs?: number }
interface HouseRec { i: number; n: string; c: CultureId; k: HouseKind; hr?: House['heraldry']; s: number; fo: number; hd: number; sw?: number[]; ex?: 1 }
interface TitleRec { i: number; k: TitleKind; n: string; pl: number; ho?: number; li?: number; co?: number[]; rg?: number }
interface BuildingRec {
  i: number; lv: number; cn?: number; dm?: number; fr?: 1; ow?: number; hh?: number; oc?: 1;
  // only for buildings raised in play (no world plot)
  kd?: BuildingKind; se?: number; x?: number; z?: number; r?: number; cu?: CultureId; sd?: number;
}
interface StripRec { i: number; c: StripState['crop']; s: StripStage; h?: number }
interface SettlementRec { i: number; t: number; p: number; e?: number; sh: number[] }

interface MetaRec {
  v: number;
  seed: string;
  difficulty: Difficulty;
  clock: ClockState;
  rngs: Record<string, number[]>;
  run: RunState;
  score: ScoreState;
  weather: WeatherState;
  stats: DemographyState;
  chronicle: ChronicleEntry[];
  next: { person: number; household: number; house: number; title: number; building: number };
  ext: string[];
}

export interface RawSave {
  meta: MetaRec;
  /** Parsed chunk arrays keyed by record key. */
  chunks: Record<string, unknown[]>;
  ext: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Entity ⇄ record
// ---------------------------------------------------------------------------------------------

function personToRec(p: Person): PersonRec {
  const r: PersonRec = {
    i: p.id, f: p.first, b: p.byname, x: p.sex === 'm' ? 0 : 1, c: p.culture, bd: p.birthDay,
    se: p.settlement, es: p.estate, rt: p.rankTier, ca: p.career,
    po: [p.potential.str, p.potential.end, p.potential.agi, p.potential.int, p.potential.per, p.potential.cha],
    tr: [p.trained.str, p.trained.end, p.trained.agi, p.trained.int, p.trained.per, p.trained.cha],
    nd: [p.needs.hunger, p.needs.rest, p.needs.warmth, p.needs.mood], hp: p.health.hp,
    rp: [p.rep.honour, p.rep.generosity, p.rep.piety, p.rep.cruelty, p.rep.valour],
    am: p.ambition,
    ge: [p.genes.skin, p.genes.hair, p.genes.hairStyle, p.genes.beard, p.genes.height, p.genes.build, p.genes.grey],
  };
  if (p.death) { r.dd = p.death.day; r.dc = p.death.cause; }
  if (p.father) r.fa = p.father;
  if (p.mother) r.mo = p.mother;
  if (p.spouse) r.sp = p.spouse;
  if (p.children.length) r.ch = p.children;
  if (p.household) r.hh = p.household;
  if (p.house) r.ho = p.house;
  if (p.careerStage) r.cs = p.careerStage;
  if (p.offices.length) r.of = p.offices;
  let sk: Partial<Record<SkillId, number>> | undefined;
  for (const k of SKILLS) if (p.skills[k]) { (sk ??= {})[k] = p.skills[k]; }
  if (sk) r.sk = sk;
  if (p.perks.length) r.pk = p.perks;
  if (p.traits.length) r.tt = p.traits;
  if (p.health.conditions.length) r.cd = p.health.conditions;
  if (p.money) r.mn = p.money;
  if (Object.keys(p.inventory).length) r.inv = p.inventory;
  if (p.prestige) r.pr = p.prestige;
  if (Object.keys(p.opinions).length) r.op = p.opinions;
  const fl = Object.keys(p.flags) as FlagId[];
  if (fl.length) r.fl = fl;
  if (p.pregnancy) r.pg = p.pregnancy;
  if (p.lastBirth !== -99999) r.lb = p.lastBirth;
  if (p.marriedDay !== -1) r.md = p.marriedDay;
  return r;
}

function recToPerson(r: PersonRec): Person {
  const potential = emptyStats();
  const trained = emptyStats();
  STATS.forEach((s, i) => { potential[s] = r.po[i]; trained[s] = r.tr[i]; });
  const skills = emptySkills();
  if (r.sk) for (const k of Object.keys(r.sk) as SkillId[]) skills[k] = r.sk[k] as number;
  const flags: PersonFlags = {};
  if (r.fl) for (const f of r.fl) flags[f] = true;
  const genes: Genes = { skin: r.ge[0], hair: r.ge[1], hairStyle: r.ge[2], beard: r.ge[3], height: r.ge[4], build: r.ge[5], grey: r.ge[6] };
  return {
    id: r.i, first: r.f, byname: r.b, sex: r.x === 0 ? 'm' : 'f', culture: r.c, birthDay: r.bd,
    death: r.dd !== undefined ? { day: r.dd, cause: r.dc ?? 'unknown' } : null,
    father: r.fa ?? NONE, mother: r.mo ?? NONE, spouse: r.sp ?? NONE, children: r.ch ?? [],
    household: r.hh ?? NONE, house: r.ho ?? NONE, settlement: r.se, estate: r.es, rankTier: r.rt,
    career: r.ca, careerStage: r.cs ?? 0, offices: r.of ?? [], potential, trained, skills,
    perks: r.pk ?? [], traits: r.tt ?? [],
    needs: { hunger: r.nd[0], rest: r.nd[1], warmth: r.nd[2], mood: r.nd[3] },
    health: { hp: r.hp, conditions: r.cd ?? [] },
    money: r.mn ?? 0, inventory: r.inv ?? {}, prestige: r.pr ?? 0,
    rep: { honour: r.rp[0], generosity: r.rp[1], piety: r.rp[2], cruelty: r.rp[3], valour: r.rp[4] },
    opinions: r.op ?? {}, ambition: r.am, flags, genes,
    pregnancy: r.pg ?? null, lastBirth: r.lb ?? -99999, marriedDay: r.md ?? -1,
  };
}

function householdToRec(h: Household): HouseholdRec {
  const r: HouseholdRec = { i: h.id, k: h.kind, hd: h.head, m: h.members, s: h.settlement };
  if (h.home !== -1) r.h = h.home;
  if (h.purse) r.p = h.purse;
  if (Object.keys(h.stores).length) r.st = h.stores;
  if (h.target !== undefined) r.t = h.target;
  if (h.house) r.hs = h.house;
  return r;
}
function recToHousehold(r: HouseholdRec): Household {
  const h: Household = { id: r.i, kind: r.k, head: r.hd, members: r.m, home: r.h ?? -1, settlement: r.s, purse: r.p ?? 0, stores: r.st ?? {} };
  if (r.t !== undefined) h.target = r.t;
  if (r.hs) h.house = r.hs;
  return h;
}

function houseToRec(h: House): HouseRec {
  const r: HouseRec = { i: h.id, n: h.name, c: h.culture, k: h.kind, s: h.seat, fo: h.founder, hd: h.head };
  if (h.heraldry) r.hr = h.heraldry;
  if (h.sworn.length) r.sw = h.sworn;
  if (h.extinct) r.ex = 1;
  return r;
}
function recToHouse(r: HouseRec): House {
  const h: House = { id: r.i, name: r.n, culture: r.c, kind: r.k, seat: r.s, founder: r.fo, head: r.hd, sworn: r.sw ?? [], extinct: r.ex === 1 };
  if (r.hr) h.heraldry = r.hr;
  return h;
}

function titleToRec(t: Title): TitleRec {
  const r: TitleRec = { i: t.id, k: t.kind, n: t.name, pl: t.place };
  if (t.holder) r.ho = t.holder;
  if (t.liege) r.li = t.liege;
  if (t.coholders.length) r.co = t.coholders;
  if (t.regent) r.rg = t.regent;
  return r;
}
function recToTitle(r: TitleRec): Title {
  return { id: r.i, kind: r.k, name: r.n, place: r.pl, holder: r.ho ?? NONE, liege: r.li ?? NONE, coholders: r.co ?? [], regent: r.rg ?? NONE };
}

function buildingToRec(b: BuildingState): BuildingRec {
  const r: BuildingRec = { i: b.id, lv: b.level };
  if (b.construction !== 1) r.cn = b.construction;
  if (b.damage) r.dm = b.damage;
  if (b.onFire) r.fr = 1;
  if (b.owner) r.ow = b.owner;
  if (b.household) r.hh = b.household;
  if (b.occupied) r.oc = 1;
  if (b.plot < 0) { r.kd = b.kind; r.se = b.settlement; r.x = b.x; r.z = b.z; r.r = b.rot; r.cu = b.culture; r.sd = b.seed; }
  return r;
}

function stripToRec(s: StripState): StripRec {
  const r: StripRec = { i: s.id, c: s.crop, s: s.state };
  if (s.holder) r.h = s.holder;
  return r;
}

function settlementToRec(s: SettlementState): SettlementRec {
  const r: SettlementRec = { i: s.id, t: s.target, p: s.prosperity, sh: s.shares };
  if (s.epidemic) r.e = s.epidemic;
  return r;
}

// ---------------------------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------------------------

export const CHUNK_PREFIX: Record<DirtyKind, string> = {
  persons: 'p', households: 'hh', houses: 'hs', titles: 't', buildings: 'b', strips: 'st', settlements: 's',
};
const PREFIX_KIND = Object.fromEntries(Object.entries(CHUNK_PREFIX).map(([k, v]) => [v, k as DirtyKind])) as Record<string, DirtyKind>;

export function chunkKey(kind: DirtyKind, chunk: number): string { return `${CHUNK_PREFIX[kind]}:${chunk}`; }

/** JSON of one chunk of entities, or null if the chunk is empty (its record should be deleted). */
export function serializeChunk(state: GameState, kind: DirtyKind, chunk: number): string | null {
  const shift = CHUNK_SHIFT[kind];
  const lo = chunk << shift;
  const hi = (chunk + 1) << shift;
  const out: unknown[] = [];
  switch (kind) {
    case 'persons': for (let id = lo; id < hi; id++) { const e = state.persons.get(id); if (e) out.push(personToRec(e)); } break;
    case 'households': for (let id = lo; id < hi; id++) { const e = state.households.get(id); if (e) out.push(householdToRec(e)); } break;
    case 'houses': for (let id = lo; id < hi; id++) { const e = state.houses.get(id); if (e) out.push(houseToRec(e)); } break;
    case 'titles': for (let id = lo; id < hi; id++) { const e = state.titles.get(id); if (e) out.push(titleToRec(e)); } break;
    case 'buildings': for (let id = lo; id < hi; id++) { const e = state.buildings.get(id); if (e) out.push(buildingToRec(e)); } break;
    case 'strips': for (let id = lo; id < hi; id++) { const e = state.strips.get(id); if (e) out.push(stripToRec(e)); } break;
    case 'settlements': for (let id = lo; id < hi; id++) { const e = state.settlements.get(id); if (e) out.push(settlementToRec(e)); } break;
  }
  return out.length ? JSON.stringify(out) : null;
}

export function serializeMeta(state: GameState): string {
  const rngs: Record<string, number[]> = {};
  for (const [name, r] of state.rngs) rngs[name] = r.getState();
  const meta: MetaRec = {
    v: SAVE_VERSION,
    seed: state.seed,
    difficulty: state.difficulty,
    clock: state.clock,
    rngs,
    run: state.run,
    score: state.score,
    weather: state.weather,
    stats: state.stats,
    chronicle: state.chronicle,
    next: {
      person: state.persons.nextId, household: state.households.nextId, house: state.houses.nextId,
      title: state.titles.nextId, building: state.nextBuildingId,
    },
    ext: Object.keys(state.ext).sort(),
  };
  return JSON.stringify(meta);
}

export function serializeExt(state: GameState, name: string): string | null {
  return name in state.ext ? JSON.stringify(state.ext[name]) : null;
}

/** All chunk keys of every kind that currently has entities. */
export function allChunkKeys(state: GameState): Array<{ kind: DirtyKind; chunk: number }> {
  const out: Array<{ kind: DirtyKind; chunk: number }> = [];
  const add = (kind: DirtyKind, ids: Iterable<number>): void => {
    const seen = new Set<number>();
    for (const id of ids) seen.add(id >> CHUNK_SHIFT[kind]);
    for (const c of [...seen].sort((a, b) => a - b)) out.push({ kind, chunk: c });
  };
  add('persons', mapKeys(state.persons.entries()));
  add('households', mapKeys(state.households.entries()));
  add('houses', mapKeys(state.houses.entries()));
  add('titles', mapKeys(state.titles.entries()));
  add('buildings', state.buildings.keys());
  add('strips', state.strips.keys());
  add('settlements', state.settlements.keys());
  return out;
}

function* mapKeys<T>(it: IterableIterator<[number, T]>): Generator<number> { for (const [k] of it) yield k; }

/** Every record of the run as {key → json}, in deterministic key order. */
export function serializeAll(state: GameState): Map<string, string> {
  const out = new Map<string, string>();
  for (const { kind, chunk } of allChunkKeys(state)) {
    const json = serializeChunk(state, kind, chunk);
    if (json !== null) out.set(chunkKey(kind, chunk), json);
  }
  for (const name of Object.keys(state.ext).sort()) {
    const json = serializeExt(state, name);
    if (json !== null) out.set(`x:${name}`, json);
  }
  out.set('meta', serializeMeta(state));
  return out;
}

/** 53-bit string hash (cyrb53). */
export function hashString53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Order-stable hash of the whole persisted state (used by determinism and round-trip tests). */
export function hashState(state: GameState): string {
  let h = 0;
  for (const [key, json] of serializeAll(state)) {
    h = hashString53(key + '\u0001' + json, h % 4294967296);
  }
  return h.toString(36);
}

// ---------------------------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------------------------

/** Upgrades raw saves one version at a time: MIGRATIONS[n] turns version n into n + 1. */
export type Migration = (raw: RawSave) => RawSave;
export const MIGRATIONS: Record<number, Migration> = {};

export function parseRecords(records: Record<string, string>): RawSave {
  const metaJson = records['meta'];
  if (!metaJson) throw new Error('save has no meta record');
  const meta = JSON.parse(metaJson) as MetaRec;
  const chunks: Record<string, unknown[]> = {};
  const ext: Record<string, unknown> = {};
  for (const [key, json] of Object.entries(records)) {
    if (key === 'meta') continue;
    if (key.startsWith('x:')) ext[key.slice(2)] = JSON.parse(json);
    else chunks[key] = JSON.parse(json) as unknown[];
  }
  return { meta, chunks, ext };
}

export function migrate(raw: RawSave, table: Record<number, Migration> = MIGRATIONS, target = SAVE_VERSION): RawSave {
  let cur = raw;
  while (cur.meta.v < target) {
    const step = table[cur.meta.v];
    if (!step) throw new Error(`no migration from save version ${cur.meta.v}`);
    const from = cur.meta.v;
    cur = step(cur);
    cur.meta.v = from + 1;
  }
  if (cur.meta.v > target) throw new Error(`save version ${cur.meta.v} is newer than this build (${target})`);
  return cur;
}

export function rawToState(raw: RawSave, world: WorldModel): GameState {
  const meta = raw.meta;
  const state = GameState.fromWorld(world, meta.seed, meta.difficulty);
  state.clock = meta.clock;
  state.run = meta.run;
  state.score = meta.score;
  state.weather = meta.weather;
  state.stats = meta.stats;
  state.chronicle = meta.chronicle;
  for (const [name, st] of Object.entries(meta.rngs)) state.rng(name).setState(st);
  for (const [name, value] of Object.entries(raw.ext)) state.ext[name] = value;

  const chunkOrder = (k: string): number => Number(k.slice(k.indexOf(':') + 1));
  const keys = Object.keys(raw.chunks).sort((a, b) => (a.slice(0, a.indexOf(':')) < b.slice(0, b.indexOf(':')) ? -1 : a.slice(0, a.indexOf(':')) > b.slice(0, b.indexOf(':')) ? 1 : chunkOrder(a) - chunkOrder(b)));
  for (const key of keys) {
    const arr = raw.chunks[key];
    const prefix = key.slice(0, key.indexOf(':'));
    const kind = PREFIX_KIND[prefix];
    if (!kind) continue;
    switch (kind) {
      case 'persons': for (const r of arr as PersonRec[]) state.persons.add(recToPerson(r)); break;
      case 'households': for (const r of arr as HouseholdRec[]) state.households.add(recToHousehold(r)); break;
      case 'houses': for (const r of arr as HouseRec[]) state.houses.add(recToHouse(r)); break;
      case 'titles': for (const r of arr as TitleRec[]) state.titles.add(recToTitle(r)); break;
      case 'buildings':
        for (const r of arr as BuildingRec[]) {
          let b = state.buildings.get(r.i);
          if (!b) {
            b = {
              id: r.i, plot: -1, kind: r.kd as BuildingKind, level: r.lv, settlement: r.se ?? -1, construction: 1, damage: 0,
              onFire: false, owner: NONE, household: NONE, occupied: false, x: r.x ?? 0, z: r.z ?? 0, rot: r.r ?? 0,
              culture: r.cu ?? 'anglo', seed: r.sd ?? 0,
            };
            state.buildings.set(b.id, b);
          }
          b.level = r.lv; b.construction = r.cn ?? 1; b.damage = r.dm ?? 0; b.onFire = r.fr === 1;
          b.owner = r.ow ?? NONE; b.household = r.hh ?? NONE; b.occupied = r.oc === 1;
        }
        break;
      case 'strips':
        for (const r of arr as StripRec[]) {
          const s = state.strips.get(r.i);
          if (s) { s.crop = r.c; s.state = r.s; s.holder = r.h ?? NONE; }
        }
        break;
      case 'settlements':
        for (const r of arr as SettlementRec[]) {
          const s = state.settlements.get(r.i);
          if (s) { s.target = r.t; s.prosperity = r.p; s.epidemic = r.e ?? 0; s.shares = r.sh; }
        }
        break;
    }
  }
  state.persons.nextId = Math.max(state.persons.nextId, meta.next.person);
  state.households.nextId = Math.max(state.households.nextId, meta.next.household);
  state.houses.nextId = Math.max(state.houses.nextId, meta.next.house);
  state.titles.nextId = Math.max(state.titles.nextId, meta.next.title);
  state.nextBuildingId = Math.max(state.nextBuildingId, meta.next.building);
  // brand-new buildings (raised in play) may have been appended
  state.rebuildIndexes();
  repair(state);
  refreshStrips(state, state.clock.absDay);
  state.dirty.clear();
  state.dirty.meta = false;
  return state;
}

/** Makes cross references consistent. A save is written in slices, and entities of the same
 *  household or marriage may come from slightly different moments; trust the persons. */
export function repair(state: GameState): number {
  let fixes = 0;
  // household membership follows the persons; keep the saved order when it is already consistent
  const actual = new Map<number, Set<number>>();
  for (const p of state.persons.values()) {
    if (p.death) continue;
    if (p.household !== NONE && !state.households.has(p.household)) { p.household = NONE; fixes++; continue; }
    if (p.household === NONE) continue;
    let set = actual.get(p.household);
    if (!set) { set = new Set(); actual.set(p.household, set); }
    set.add(p.id);
  }
  for (const hh of state.households.values()) {
    const want = actual.get(hh.id) ?? new Set<number>();
    const kept = hh.members.filter((id, i) => want.has(id) && hh.members.indexOf(id) === i);
    if (kept.length !== want.size || kept.length !== hh.members.length) {
      for (const id of want) if (!kept.includes(id)) kept.push(id);
      hh.members = kept;
      fixes++;
    }
    const head = state.persons.get(hh.head);
    if (!head || head.death || head.household !== hh.id) {
      const next = hh.members.map((id) => state.persons.get(id)).filter((m): m is Person => !!m)
        .sort((a, b) => a.birthDay - b.birthDay)[0];
      hh.head = next ? next.id : NONE;
      fixes++;
    }
  }
  for (const p of state.persons.values()) {
    if (p.death) continue;
    if (p.spouse) {
      const sp = state.persons.get(p.spouse);
      if (!sp || sp.death || sp.spouse !== p.id) { p.spouse = NONE; p.marriedDay = -1; fixes++; }
    }
  }
  return fixes;
}
