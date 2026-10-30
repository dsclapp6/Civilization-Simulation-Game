// The politics runtime's shared context: saved data, the daily snapshot of who holds what (Houses,
// titles, lieges, strength) and small helpers every part of the module uses.
//
// Snapshot rule: everything derived here is a pure function of the persisted state (titles, persons,
// settlements) plus the military's armies, so a loaded game decides exactly as the live one did.
// Sums are integers on purpose (floating point sums depend on iteration order, and Set order differs
// between a live game and a loaded one).
import { dist2 } from '../../core/math';
import type { Rng } from '../../core/rng';
import { DAYS_PER_YEAR } from '../../core/time';
import type { Settlement, WorldModel } from '../../world/types';
import type { Simulation } from '../sim';
import type { EconomyApi } from '../economy/types';
import type { SocialApi } from '../social/types';
import {
  ageYears, fullName, TITLE_RANK, type GameState, type House, type HouseId, type Person, type PersonId, type Title, type TitleId,
} from '../state';
import type { Stance } from '../wave3';
import type { AiMind, ManorPolicy, Personality, PoliticsSave, RealmLaws, Tie, War } from './types';

export const EXT_KEY = 'politics';
export const YEAR = DAYS_PER_YEAR;

/** Realm law defaults by culture: England's crown reined its barons in early; elsewhere private war lasted. */
const PRIVATE_WAR_BY_CULTURE: Record<string, boolean> = {
  anglo: false, franc: true, gael: true, cymric: true, norse: true, teuton: true,
};

export function newSave(): PoliticsSave {
  return {
    v: 1,
    seq: { war: 1, coalition: 1, proposal: 1, petition: 1, revolt: 1, band: 1 },
    ties: {}, wars: [], history: [], coalitions: [], ai: {}, laws: {}, manors: {}, unrest: {}, oaths: {}, deposed: {},
    inbox: [], petitions: [], offices: {}, candidacies: [], pending: {}, revolts: [], bands: [],
    stats: { warsDeclared: 0, titlesMoved: 0, coalitions: 0, revolts: 0, marriages: 0, independence: 0, lastWarDay: -1 },
    diffApplied: false,
  };
}

export const emptyTie = (): Tie => ({ truce: 0, trade: 0, alliance: 0, kin: 0, grievance: 0 });
export const tieKey = (a: HouseId, b: HouseId): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
export const defaultPolicy = (): ManorPolicy => ({ rent: 0, labour: 0, justice: 'fair', focus: 'fields' });
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Demesne troop weights (integers: x10). */
const LEVY_PER_HEAD = 1.4; // tenths of a man per resident (about 14% of the people can be called up and armed)
const KIND_BONUS: Record<string, number> = { castle: 250, city: 120, town: 60, abbey: 0, priory: 0, nunnery: 0, village: 0, hamlet: 0 };
const CAREER_WEIGHT: Record<string, number> = {
  knight: 60, squire: 25, man_at_arms: 30, sergeant: 30, archer: 20, soldier: 15, lord: 40,
};

export interface Snapshot {
  day: number;
  rev: number;
  /** Titles by the House of their holder, highest rank first. */
  titlesOf: Map<HouseId, Title[]>;
  /** Political actors: Houses that hold a secular title. */
  actors: HouseId[];
  actorSet: Set<HouseId>;
  liege: Map<HouseId, HouseId>;
  vassals: Map<HouseId, HouseId[]>;
  top: Map<HouseId, HouseId>;
  /** Own demesne and retinue, in tenths of a man. */
  own: Map<HouseId, number>;
  /** Own plus vassals (80% of theirs), in tenths of a man. */
  strength: Map<HouseId, number>;
  /** Sum of the strength of every realm leader. */
  total: number;
  neighbours: Map<HouseId, HouseId[]>;
  /** Per-snapshot cache for derived values (weakness, claims, demesnes…). */
  memo: Map<string, unknown>;
  pts: Map<HouseId, number[]>;
  dem: Map<HouseId, number[]>;
  pers: Map<HouseId, Personality>;
}

export class PoliticsCore {
  readonly sim: Simulation;
  readonly state: GameState;
  readonly world: WorldModel;
  readonly social: SocialApi;
  readonly economy: EconomyApi;
  save: PoliticsSave;
  readonly settlementById = new Map<number, Settlement>();
  /** Bumped whenever title holders or lieges change; invalidates the snapshot. */
  rev = 0;
  private snap: Snapshot | null = null;
  private readonly stanceMemo = new Map<string, Stance>();

  constructor(sim: Simulation, deps: { social: SocialApi; economy: EconomyApi }) {
    this.sim = sim;
    this.state = sim.state;
    this.world = sim.world;
    this.social = deps.social;
    this.economy = deps.economy;
    for (const s of this.world.settlements) this.settlementById.set(s.id, s);
    const cur = this.state.ext[EXT_KEY] as PoliticsSave | undefined;
    if (cur && typeof cur === 'object' && cur.v === 1) {
      this.save = cur;
      const base = newSave() as unknown as Record<string, unknown>;
      const s = cur as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(base)) if (s[k] === undefined) s[k] = v;
    } else {
      this.save = newSave();
      this.state.ext[EXT_KEY] = this.save;
      this.state.touchExt(EXT_KEY);
    }
  }

  get day(): number { return this.sim.absDay; }
  get playerId(): PersonId { return this.state.run.playerId; }
  get playerHouse(): HouseId { return this.state.run.houseId; }
  rng(name: string): Rng { return this.sim.rng(`politics.${name}`); }
  touch(): void { this.state.touchExt(EXT_KEY); }
  person(id: PersonId): Person | undefined { return this.state.persons.get(id); }
  living(id: PersonId): Person | undefined { const p = this.state.persons.get(id); return p && !p.death ? p : undefined; }
  age(p: Person): number { return ageYears(p, this.day); }
  /** The sim difficulty as an aggression factor (SPEC §1): rivals "less aggressive" … "ruthless". */
  get aggression(): number {
    switch (this.state.difficulty) { case 'squire': return 0.55; case 'knight': return 1; case 'lord': return 1.25; default: return 1.6; }
  }
  /** How well rivals coordinate coalitions (SPEC §1: "smarter coalitions" from Lord on). */
  get coordination(): number {
    switch (this.state.difficulty) { case 'squire': return 0.5; case 'knight': return 1; case 'lord': return 1.4; default: return 1.7; }
  }

  // ---- messages ----
  log(kind: string, text: string, persons: PersonId[] = []): void { this.state.log(this.day, kind, text, persons); }
  notify(text: string, kind: 'info' | 'gain' | 'loss' | 'warn' | 'danger' | 'quest' | 'social' = 'info', person?: PersonId): void {
    this.sim.events.emit('notify', person === undefined ? { kind, text } : { kind, text, person });
  }
  /** Is this House the player's (or does the person belong to it)? */
  isPlayerHouse(h: HouseId): boolean { return h !== 0 && h === this.playerHouse && this.state.run.phase !== 'over'; }
  houseName(h: HouseId): string { return this.state.houses.get(h)?.name ?? 'an unknown House'; }
  headOf(h: HouseId): Person | undefined {
    const house = this.state.houses.get(h);
    return house ? this.living(house.head) : undefined;
  }
  /** "House Falconer" with the head's name where useful. */
  houseLabel(h: HouseId): string {
    const house = this.state.houses.get(h);
    if (!house) return 'an unknown House';
    const seat = this.settlementById.get(house.seat)?.name;
    return seat && !house.name.includes(seat) ? `House ${house.name} of ${seat}` : `House ${house.name}`;
  }

  // ---- snapshot ----
  invalidate(): void { this.rev++; this.snap = null; this.stanceMemo.clear(); }

  snapshot(): Snapshot {
    const s = this.snap;
    if (s && s.day === Math.floor(this.day) && s.rev === this.rev) return s;
    return (this.snap = this.buildSnapshot());
  }

  private buildSnapshot(): Snapshot {
    const state = this.state;
    const day = Math.floor(this.day);
    const titlesOf = new Map<HouseId, Title[]>();
    for (const t of state.titles.values()) {
      if (!t.holder) continue;
      const holder = state.persons.get(t.holder);
      if (!holder || holder.death || !holder.house) continue;
      let list = titlesOf.get(holder.house);
      if (!list) { list = []; titlesOf.set(holder.house, list); }
      list.push(t);
    }
    const actors: HouseId[] = [];
    for (const [h, list] of titlesOf) {
      const house = state.houses.get(h);
      list.sort((a, b) => TITLE_RANK[b.kind] - TITLE_RANK[a.kind] || a.id - b.id);
      if (!house || house.extinct || house.kind === 'church') continue;
      if (list.some((t) => t.kind !== 'abbey' && t.kind !== 'see')) actors.push(h);
    }
    actors.sort((a, b) => a - b);

    // lieges: the first title (highest first) that is held from nobody (independent) or from another House
    const liege = new Map<HouseId, HouseId>();
    const vassals = new Map<HouseId, HouseId[]>();
    for (const h of actors) {
      let lh = 0;
      for (const t of titlesOf.get(h) ?? []) {
        if (t.kind === 'abbey' || t.kind === 'see') continue;
        if (!t.liege) break; // held from no one: the House is independent
        const lt = state.titles.get(t.liege);
        const holder = lt && lt.holder ? state.persons.get(lt.holder) : undefined;
        if (!holder || holder.death || !holder.house) break;
        if (holder.house === h) continue; // held from the House's own higher title
        lh = holder.house;
        break;
      }
      if (lh) {
        liege.set(h, lh);
        let vs = vassals.get(lh);
        if (!vs) { vs = []; vassals.set(lh, vs); }
        vs.push(h);
      }
    }
    // the feudal chain must not loop (a House cannot be its own overlord)
    const top = new Map<HouseId, HouseId>();
    for (const h of actors) {
      let cur = h;
      const seen = new Set<HouseId>([h]);
      for (let g = 0; g < 8; g++) {
        const l = liege.get(cur);
        if (!l || seen.has(l)) break;
        seen.add(l);
        cur = l;
      }
      top.set(h, cur);
    }

    // strength
    const armyWeight = new Map<HouseId, number>();
    const mil = this.sim.services.military;
    if (mil) {
      for (const a of mil.armies()) {
        let w = 0;
        for (const [k, n] of Object.entries(a.troops)) w += Math.round(n * (TROOP_WEIGHT[k] ?? 10));
        armyWeight.set(a.house, (armyWeight.get(a.house) ?? 0) + w);
      }
    }
    const own = new Map<HouseId, number>();
    for (const h of actors) {
      let w = 0;
      for (const t of titlesOf.get(h) ?? []) w += this.demesneWeight(t);
      for (const m of state.membersOfHouse(h)) {
        if (m.sex !== 'm') continue;
        const a = ageYears(m, this.day);
        if (a < 16 || a > 60) continue;
        w += CAREER_WEIGHT[m.career] ?? 4;
      }
      // deployed professional troops count half on top of the potential levy they came from
      w += Math.round((armyWeight.get(h) ?? 0) * 0.5);
      own.set(h, w);
    }
    const strength = new Map<HouseId, number>();
    const calc = (h: HouseId, depth: number): number => {
      const have = strength.get(h);
      if (have !== undefined) return have;
      let w = own.get(h) ?? 0;
      if (depth < 8) {
        for (const v of vassals.get(h) ?? []) if (v !== h) w += Math.round(calc(v, depth + 1) * 0.8);
      }
      strength.set(h, w);
      return w;
    };
    for (const h of actors) calc(h, 0);
    let total = 0;
    for (const h of actors) if (top.get(h) === h) total += strength.get(h) ?? 0;

    return { day, rev: this.rev, titlesOf, actors, actorSet: new Set(actors), liege, vassals, top, own, strength, total, neighbours: new Map(), memo: new Map(), pts: new Map(), dem: new Map(), pers: new Map() };
  }

  /** Troops a title's own land puts in the field, tenths of a man. */
  demesneWeight(t: Title): number {
    if (t.kind === 'abbey' || t.kind === 'see') return 0;
    const place = this.demesnePlace(t);
    const s = this.settlementById.get(place);
    if (!s) return 0;
    const pop = this.state.residentsOf(place).length;
    return Math.round(pop * LEVY_PER_HEAD * (t.kind === 'town' ? 0.7 : 1)) + (KIND_BONUS[s.kind] ?? 0);
  }

  /** The settlement a title is held from: its place, a county's seat, a kingdom's capital. */
  demesnePlace(t: Title): number {
    if (t.kind === 'kingdom') return this.world.kingdoms.find((k) => k.id === t.place)?.capital ?? -1;
    if (t.kind === 'county') return this.world.counties.find((c) => c.id === t.place)?.seat ?? -1;
    return t.place;
  }

  /** Kingdom (world id) a title lies in. */
  kingdomOfTitle(t: Title): number {
    if (t.kind === 'kingdom') return t.place;
    const s = this.settlementById.get(this.demesnePlace(t));
    return s ? s.kingdom : -1;
  }

  /** Caches `make()` for the life of the current snapshot (a day, or until a title moves). */
  memo<T>(key: string, make: () => T): T {
    const m = this.snapshot().memo;
    if (m.has(key)) return m.get(key) as T;
    const v = make();
    m.set(key, v);
    return v;
  }

  actors(): HouseId[] { return this.snapshot().actors; }
  isActor(h: HouseId): boolean { return this.snapshot().actorSet.has(h); }
  titlesOfHouse(h: HouseId): readonly Title[] { return this.snapshot().titlesOf.get(h) ?? EMPTY_TITLES; }
  liegeOf(h: HouseId): HouseId { return this.snapshot().liege.get(h) ?? 0; }
  vassalsOf(h: HouseId): readonly HouseId[] { return this.snapshot().vassals.get(h) ?? EMPTY_IDS; }
  realmLeader(h: HouseId): HouseId { return this.snapshot().top.get(h) ?? h; }
  strengthOf(h: HouseId): number { return (this.snapshot().strength.get(h) ?? 0) / 10; }
  ownStrength(h: HouseId): number { return (this.snapshot().own.get(h) ?? 0) / 10; }
  /** The highest secular title of a House, or undefined. */
  primaryTitle(h: HouseId): Title | undefined {
    for (const t of this.titlesOfHouse(h)) if (t.kind !== 'abbey' && t.kind !== 'see') return t;
    return undefined;
  }
  /** Is `lord` somewhere above `h` in the feudal chain? */
  isOverlord(lord: HouseId, h: HouseId): boolean {
    const snap = this.snapshot();
    let cur = h;
    for (let g = 0; g < 8; g++) {
      const l = snap.liege.get(cur);
      if (!l) return false;
      if (l === lord) return true;
      cur = l;
    }
    return false;
  }
  /** Every House below `h` in the chain (nearest first), capped. */
  allVassals(h: HouseId, cap = 60): HouseId[] {
    const out: HouseId[] = [];
    const seen = new Set<HouseId>([h]);
    let layer: HouseId[] = [h];
    while (layer.length && out.length < cap) {
      const next: HouseId[] = [];
      for (const x of layer) for (const v of this.vassalsOf(x)) if (!seen.has(v)) { seen.add(v); out.push(v); next.push(v); }
      layer = next;
    }
    return out.slice(0, cap);
  }
  /** Kingdom (world id) the House's realm sits in, from its highest title. */
  kingdomOfHouse(h: HouseId): number {
    const leader = this.realmLeader(h);
    const t = this.primaryTitle(leader) ?? this.primaryTitle(h);
    return t ? this.kingdomOfTitle(t) : -1;
  }
  realmShare(h: HouseId): number {
    const snap = this.snapshot();
    if (snap.total <= 0) return 0;
    return ((snap.strength.get(this.realmLeader(h)) ?? 0) / snap.total) * 100;
  }

  /** Settlements held directly by a House (title demesnes). */
  demesnes(h: HouseId): readonly number[] {
    const snap = this.snapshot();
    let out = snap.dem.get(h);
    if (!out) {
      out = [];
      for (const t of this.titlesOfHouse(h)) {
        const p = this.demesnePlace(t);
        if (p >= 0 && !out.includes(p)) out.push(p);
      }
      snap.dem.set(h, out);
    }
    return out;
  }

  /** Houses within reach of `h` (demesnes within 4.2 km, its lieges and vassals, kin and allies), nearest first. */
  neighbours(h: HouseId): HouseId[] {
    const snap = this.snapshot();
    const memo = snap.neighbours.get(h);
    if (memo) return memo;
    const mine = this.points(h);
    const found: Array<[HouseId, number]> = [];
    for (const o of snap.actors) {
      if (o === h) continue;
      const theirs = this.points(o);
      let best = Infinity;
      for (let i = 0; i < mine.length; i += 2) {
        for (let j = 0; j < theirs.length; j += 2) {
          const d = dist2(mine[i], mine[i + 1], theirs[j], theirs[j + 1]);
          if (d < best) best = d;
        }
      }
      if (best <= 4200 * 4200) { found.push([o, best]); continue; }
      const tie = this.save.ties[tieKey(h, o)];
      if ((tie && (tie.kin > 0 || tie.alliance > 0)) || snap.liege.get(h) === o || snap.liege.get(o) === h) found.push([o, best === Infinity ? 9e12 : best]);
    }
    found.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const out = found.slice(0, 18).map((e) => e[0]);
    snap.neighbours.set(h, out);
    return out;
  }

  /** Flat [x, z, …] of a House's demesnes. */
  private points(h: HouseId): number[] {
    const snap = this.snapshot();
    let p = snap.pts.get(h);
    if (!p) {
      p = [];
      for (const id of this.demesnes(h)) {
        const s = this.settlementById.get(id);
        if (s) p.push(s.x, s.z);
      }
      snap.pts.set(h, p);
    }
    return p;
  }

  // ---- ties and stance ----
  tie(a: HouseId, b: HouseId): Readonly<Tie> { return this.save.ties[tieKey(a, b)] ?? EMPTY_TIE; }
  /** The mutable tie record (created on demand). */
  tieRef(a: HouseId, b: HouseId): Tie {
    const k = tieKey(a, b);
    let t = this.save.ties[k];
    if (!t) { t = emptyTie(); this.save.ties[k] = t; }
    this.touch();
    return t;
  }
  dropIfEmpty(a: HouseId, b: HouseId): void {
    const k = tieKey(a, b);
    const t = this.save.ties[k];
    if (t && t.truce <= this.day && !t.trade && !t.alliance && !t.kin && t.grievance < 1) { delete this.save.ties[k]; this.touch(); }
  }

  warsOf(h: HouseId): War[] {
    const out: War[] = [];
    for (const w of this.save.wars) if (w.attackers.includes(h) || w.defenders.includes(h)) out.push(w);
    return out;
  }
  /** Active war that has the two Houses on opposite sides, if any. */
  warBetween(a: HouseId, b: HouseId): War | undefined {
    for (const w of this.save.wars) {
      if ((w.attackers.includes(a) && w.defenders.includes(b)) || (w.attackers.includes(b) && w.defenders.includes(a))) return w;
    }
    return undefined;
  }

  stance(a: HouseId, b: HouseId): Stance {
    if (a === b) return 'alliance';
    const memoKey = `${a}>${b}`;
    const hit = this.stanceMemo.get(memoKey);
    if (hit) return hit;
    const r = this.computeStance(a, b);
    this.stanceMemo.set(memoKey, r);
    return r;
  }

  private computeStance(a: HouseId, b: HouseId): Stance {
    if (this.warBetween(a, b)) return 'war';
    if (this.isOverlord(b, a)) return 'vassal';
    if (this.isOverlord(a, b)) return 'liege';
    const t = this.save.ties[tieKey(a, b)];
    if (!t) return 'neutral';
    if (t.alliance) return 'alliance';
    if (t.kin > 0) return 'kin';
    if (t.trade) return 'trade';
    if (t.truce > this.day) return 'truce';
    if (t.grievance >= 35) return 'hostile';
    return 'neutral';
  }

  /** Runs `change` on the pair's tie and emits a `stance` event for each direction that moved. */
  changeTie(a: HouseId, b: HouseId, change: (t: Tie) => void): void {
    const before = [this.stance(a, b), this.stance(b, a)];
    change(this.tieRef(a, b));
    this.stanceMemo.clear();
    this.announceStance(a, b, before);
    this.dropIfEmpty(a, b);
  }

  announceStance(a: HouseId, b: HouseId, before: Stance[]): void {
    this.stanceMemo.clear();
    const now = [this.stance(a, b), this.stance(b, a)];
    if (now[0] !== before[0]) this.sim.events.emit('stance', { a, b, stance: now[0] });
    if (now[1] !== before[1]) this.sim.events.emit('stance', { a: b, b: a, stance: now[1] });
  }

  /** Opinion of House `a`'s head about House `b`'s head (−100..100), 0 when either has none. */
  houseOpinion(a: HouseId, b: HouseId): number {
    const x = this.headOf(a), y = this.headOf(b);
    if (!x || !y) return 0;
    return this.social.opinion(x.id, y.id);
  }

  addGrievance(a: HouseId, b: HouseId, delta: number): void {
    this.changeTie(a, b, (t) => { t.grievance = clamp(t.grievance + delta, 0, 100); });
  }

  // ---- laws, policy, minds ----
  lawsFor(kingdom: number): RealmLaws {
    const k = String(kingdom);
    let l = this.save.laws[k];
    if (!l) {
      const culture = this.world.kingdoms.find((x) => x.id === kingdom)?.culture ?? 'anglo';
      l = { privateWar: PRIVATE_WAR_BY_CULTURE[culture] ?? false, tax: 1 };
      this.save.laws[k] = l;
      this.touch();
    }
    return l;
  }
  policyFor(settlement: number): ManorPolicy {
    const k = String(settlement);
    let p = this.save.manors[k];
    if (!p) { p = defaultPolicy(); this.save.manors[k] = p; this.touch(); }
    return p;
  }
  /** Policy without creating a record. */
  policyPeek(settlement: number): ManorPolicy { return this.save.manors[String(settlement)] ?? DEFAULT_POLICY; }
  mindOf(h: HouseId): AiMind {
    const k = String(h);
    let m = this.save.ai[k];
    if (!m) {
      m = { goal: 'expand', since: this.day, grudge: 0, lastWar: -999, lastProposal: -999, matched: {} };
      this.save.ai[k] = m;
      this.touch();
    }
    return m;
  }

  /** Is a coalition (forming or at war) aimed at this House or its realm leader? */
  coalitionAgainst(h: HouseId): boolean {
    const lead = this.realmLeader(h);
    return this.save.coalitions.some((c) => c.target === h || c.target === lead);
  }

  // ---- personality ----
  /** Temperament of a House, read from its head's traits, reputation and ambition (SPEC §16). */
  personality(h: HouseId): Personality {
    const snap = this.snapshot();
    let p = snap.pers.get(h);
    if (!p) { p = this.computePersonality(h); snap.pers.set(h, p); }
    return p;
  }
  private computePersonality(h: HouseId): Personality {
    const head = this.headOf(h);
    if (!head) return NEUTRAL_PERSONALITY;
    const t = head.traits;
    const has = (x: string): boolean => (t as readonly string[]).includes(x);
    const amb = head.ambition;
    return {
      ambitious: clamp(0.3 + (has('ambitious') ? 0.45 : 0) + (amb === 'rise' || amb === 'glory' || amb === 'get_land' || amb === 'wealth' ? 0.15 : 0) - (has('content') ? 0.25 : 0), 0, 1),
      cautious: clamp(0.35 + (has('craven') ? 0.3 : 0) + (has('patient') ? 0.2 : 0) + (has('content') ? 0.15 : 0) + (has('sickly') ? 0.1 : 0) - (has('brave') ? 0.25 : 0) - (has('hot_tempered') ? 0.1 : 0) - (has('ambitious') ? 0.1 : 0), 0, 1),
      greedy: clamp(0.3 + (has('greedy') ? 0.45 : 0) + (amb === 'wealth' ? 0.2 : 0) - head.rep.generosity / 200, 0, 1),
      honourable: clamp(0.45 + (has('honest') ? 0.35 : 0) - (has('deceitful') ? 0.4 : 0) + head.rep.honour / 200, 0, 1),
      cruel: clamp(0.2 + (has('hot_tempered') ? 0.25 : 0) + head.rep.cruelty / 100, 0, 1),
      pious: clamp(0.3 + (has('pious') ? 0.4 : 0) + head.rep.piety / 200 + (amb === 'piety' ? 0.15 : 0), 0, 1),
    };
  }

  /** Unrest in a settlement rises (revolts follow; see unrest.ts). */
  raiseUnrest(settlement: number, amount: number): void {
    const k = String(settlement);
    const v = clamp((this.save.unrest[k] ?? 0) + amount, 0, 100);
    if (v <= 0) delete this.save.unrest[k]; else this.save.unrest[k] = Math.round(v * 10) / 10;
    this.touch();
  }

  // ---- misc ----
  houseOf(p: Person | undefined): House | undefined { return p ? this.state.houses.get(p.house) : undefined; }
  name(id: PersonId): string { const p = this.state.persons.get(id); return p ? fullName(p) : 'someone'; }
  placeName(id: number): string { return this.settlementById.get(id)?.name ?? 'somewhere'; }
  /** Household purse of the House head (what a House "has"), pence. */
  purseOf(h: HouseId): number {
    const head = this.headOf(h);
    const hh = head ? this.state.households.get(head.household) : undefined;
    return (hh ? hh.purse : 0) + (head ? head.money : 0);
  }
  /** Moves up to `pence` from one House's head household to another's; returns what moved. */
  transferMoney(from: HouseId, to: HouseId, pence: number): number {
    const a = this.headOf(from), b = this.headOf(to);
    if (!a || !b || pence <= 0) return 0;
    const ha = this.state.households.get(a.household), hb = this.state.households.get(b.household);
    if (!ha || !hb || ha.id === hb.id) return 0;
    const take = Math.floor(Math.min(pence, Math.max(0, ha.purse)));
    if (take <= 0) return 0;
    ha.purse -= take;
    hb.purse += take;
    this.state.touchHousehold(ha);
    this.state.touchHousehold(hb);
    return take;
  }
}

export const NEUTRAL_PERSONALITY: Personality = { ambitious: 0.3, cautious: 0.4, greedy: 0.3, honourable: 0.45, cruel: 0.2, pious: 0.3 };
export const EMPTY_TITLES: readonly Title[] = [];
export const EMPTY_IDS: readonly HouseId[] = [];
export const EMPTY_TIE: Readonly<Tie> = { truce: 0, trade: 0, alliance: 0, kin: 0, grievance: 0 };
export const DEFAULT_POLICY: Readonly<ManorPolicy> = { rent: 0, labour: 0, justice: 'fair', focus: 'fields' };
/** Army weights (tenths of a man) for the strength estimate. */
export const TROOP_WEIGHT: Record<string, number> = {
  levy: 10, archers: 20, men_at_arms: 30, sergeants: 30, knights: 60, mercenaries: 25,
};
export type TitleRef = TitleId;
