// Who rules what, who owes service to whom, whose purse pays, and who is at war with whom.
// Derived from titles (and politics when present), cached for a game day; nothing here is saved.
import { NONE, TITLE_RANK, type Household, type HouseId, type PersonId, type Title } from '../state';
import type { WarView } from '../wave3';
import type { Mil } from './store';

interface WarSide { war: WarView; side: 'attacker' | 'defender' }

export class Realm {
  private day = -99;
  private stamp = -1;
  /** settlement → lord House. */
  private readonly lord = new Map<number, HouseId>();
  /** House → settlements it holds. */
  private readonly domain = new Map<HouseId, number[]>();
  /** Liege by titles (used when there is no politics module). */
  private readonly liegeOfHouse = new Map<HouseId, HouseId>();
  /** Noble and royal Houses (the only ones that hold men and titles of consequence). */
  private nobles: HouseId[] = [];

  constructor(private readonly M: Mil) {}

  /** Drops the cache (a title moved, a war began). */
  invalidate(): void { this.day = -99; }

  private fresh(): void {
    const now = this.M.sim.absDay;
    if (this.day > -90 && now - this.day < 1 && this.stamp === this.M.state.titles.size) return;
    this.day = now;
    this.stamp = this.M.state.titles.size;
    this.rebuild();
  }

  private holderHouse(t: Title | undefined): HouseId {
    if (!t || !t.holder) return NONE;
    const p = this.M.state.persons.get(t.holder);
    if (!p || p.death) return NONE;
    return p.house;
  }

  private rebuild(): void {
    const M = this.M;
    const st = M.state;
    this.lord.clear(); this.domain.clear(); this.liegeOfHouse.clear();
    this.nobles = [];

    // the House that sits at each castle / capital
    const seatHouse = new Map<number, HouseId>();
    for (const h of st.houses.values()) {
      if (h.extinct || (h.kind !== 'noble' && h.kind !== 'royal')) continue;
      const head = st.persons.get(h.head);
      if (!head || head.death) continue;
      const cur = seatHouse.get(h.seat);
      const curHead = cur ? st.persons.get(st.houses.get(cur)?.head ?? 0) : undefined;
      if (!curHead || head.rankTier > curHead.rankTier || (head.rankTier === curHead.rankTier && h.id < (cur ?? Infinity))) seatHouse.set(h.seat, h.id);
    }
    const countyTitleOf = new Map<number, Title>();
    for (const t of st.titles.values()) if (t.kind === 'county') countyTitleOf.set(t.place, t);

    for (const s of M.world.settlements) {
      let house = NONE;
      const t = st.titleFor('manor', s.id) ?? st.titleFor('barony', s.id) ?? st.titleFor('town', s.id) ?? st.titleFor('abbey', s.id);
      if (t) house = this.holderHouse(t);
      if (!house) house = seatHouse.get(s.id) ?? NONE;
      if (!house) house = this.holderHouse(countyTitleOf.get(s.county));
      const h = st.houses.get(house);
      if (!h || h.kind === 'church') house = NONE; // the Church's lands raise no levy
      if (!house) continue;
      this.lord.set(s.id, house);
      let list = this.domain.get(house);
      if (!list) { list = []; this.domain.set(house, list); }
      list.push(s.id);
    }

    // liege of each House by titles: the holder of the liege of its highest title (politics, when present, is asked live)
    for (const h of st.houses.values()) {
      if (h.extinct || h.kind === 'church' || (h.kind !== 'noble' && h.kind !== 'royal')) continue;
      this.nobles.push(h.id);
      let best: Title | undefined;
      for (const p of st.houseMembers.get(h.id) ?? []) {
        for (const t of st.titlesHeldBy(p.id)) if (!best || TITLE_RANK[t.kind] > TITLE_RANK[best.kind]) best = t;
      }
      let liege: HouseId = NONE;
      if (best && best.liege) liege = this.holderHouse(st.titles.get(best.liege));
      else if (!best) {
        const sh = seatHouse.get(h.seat);
        liege = sh && sh !== h.id ? sh : this.lord.get(h.seat) ?? NONE;
      }
      if (liege && liege !== h.id) this.liegeOfHouse.set(h.id, liege);
    }
    this.nobles.sort((a, b) => a - b);
  }

  lordHouse(settlement: number): HouseId { this.fresh(); return this.lord.get(settlement) ?? NONE; }
  /** Who holds the place now: a conqueror within his occupation, else its lord. */
  holderOf(settlement: number): HouseId {
    const o = this.M.data.occupied[settlement];
    if (o && o.until > this.M.sim.absDay) return o.by;
    return this.lordHouse(settlement);
  }
  settlementsOf(house: HouseId): readonly number[] { this.fresh(); return this.domain.get(house) ?? EMPTY; }
  liege(house: HouseId): HouseId {
    const pol = this.M.politics;
    if (pol) return pol.liegeOf(house);
    this.fresh();
    return this.liegeOfHouse.get(house) ?? NONE;
  }
  directVassals(house: HouseId): HouseId[] {
    this.fresh();
    const out: HouseId[] = [];
    for (const h of this.nobles) if (h !== house && this.liege(h) === house) out.push(h);
    return out;
  }

  /** Vassals down the chain (depth-limited), nearest first. */
  allVassals(house: HouseId, depth = 3): HouseId[] {
    const out: HouseId[] = [];
    let level: HouseId[] = [house];
    const seen = new Set<HouseId>([house]);
    for (let d = 0; d < depth; d++) {
      const next: HouseId[] = [];
      for (const h of level) for (const v of this.directVassals(h)) if (!seen.has(v)) { seen.add(v); next.push(v); out.push(v); }
      level = next;
    }
    return out;
  }

  /** The House and its lieges up to the realm's head. */
  chain(house: HouseId): HouseId[] {
    const out = [house];
    let cur = house;
    for (let i = 0; i < 4; i++) {
      const l = this.liege(cur);
      if (!l || out.includes(l)) break;
      out.push(l);
      cur = l;
    }
    return out;
  }

  /** The head of the realm the House belongs to. */
  root(house: HouseId): HouseId { const c = this.chain(house); return c[c.length - 1]; }

  // ---- purses ----
  householdOf(house: HouseId): Household | undefined {
    const h = this.M.state.houses.get(house);
    if (!h) return undefined;
    const head = this.M.state.persons.get(h.head);
    return head ? this.M.state.households.get(head.household) : undefined;
  }
  purse(house: HouseId): number { return this.householdOf(house)?.purse ?? 0; }
  /** Takes up to `pence` from the House's purse; returns what was paid. */
  debit(house: HouseId, pence: number): number {
    const hh = this.householdOf(house);
    if (!hh || pence <= 0) return 0;
    const pay = Math.min(hh.purse, pence);
    hh.purse = Math.round((hh.purse - pay) * 100) / 100;
    this.M.state.touchHousehold(hh);
    return pay;
  }
  credit(house: HouseId, pence: number): void {
    const hh = this.householdOf(house);
    if (!hh || pence <= 0) return;
    hh.purse = Math.round((hh.purse + pence) * 100) / 100;
    this.M.state.touchHousehold(hh);
  }
  headOf(house: HouseId): PersonId { return this.M.state.houses.get(house)?.head ?? NONE; }

  // ---- war and enmity ----
  private warsOf(house: HouseId): WarSide[] {
    const pol = this.M.politics;
    if (!pol) return [];
    const out: WarSide[] = [];
    for (const w of pol.warsOf(house)) out.push({ war: w, side: w.attackers.includes(house) ? 'attacker' : 'defender' });
    return out;
  }

  /** Houses at war with `house` directly (politics wars) or in a feud. */
  directEnemies(house: HouseId): Set<HouseId> {
    const s = new Set<HouseId>();
    for (const { war, side } of this.warsOf(house)) for (const e of side === 'attacker' ? war.defenders : war.attackers) s.add(e);
    const now = this.M.sim.absDay;
    for (const f of this.M.data.feuds) {
      if (f.until < now) continue;
      if (f.a === house) s.add(f.b);
      else if (f.b === house) s.add(f.a);
    }
    return s;
  }

  /** Two Houses (or their lieges) are at war or in a feud. */
  hostile(a: HouseId, b: HouseId): boolean {
    if (!a || !b || a === b) return false;
    const ca = this.chain(a), cb = this.chain(b);
    if (ca.some((x) => cb.includes(x))) return false;
    for (const x of ca) {
      const en = this.directEnemies(x);
      if (en.size === 0) continue;
      for (const y of cb) if (en.has(y)) return true;
    }
    for (const y of cb) {
      const en = this.directEnemies(y);
      if (en.size === 0) continue;
      for (const x of ca) if (en.has(x)) return true;
    }
    const pol = this.M.politics;
    return pol ? pol.stance(a, b) === 'war' : false;
  }

  /** The war between the two Houses' sides: its id, and whether `a`'s side attacks. */
  warBetween(a: HouseId, b: HouseId): { war: number; aAttacks: boolean } {
    const pol = this.M.politics;
    if (!pol) return { war: 0, aAttacks: true };
    const ca = this.chain(a), cb = this.chain(b);
    for (const w of pol.wars()) {
      const aAtt = ca.some((x) => w.attackers.includes(x)), aDef = ca.some((x) => w.defenders.includes(x));
      const bAtt = cb.some((x) => w.attackers.includes(x)), bDef = cb.some((x) => w.defenders.includes(x));
      if (aAtt && bDef) return { war: w.id, aAttacks: true };
      if (aDef && bAtt) return { war: w.id, aAttacks: false };
    }
    return { war: 0, aAttacks: true };
  }

  /** Wars the House's realm fights now (of its own or its lieges'). */
  warsAt(house: HouseId): WarView[] {
    const pol = this.M.politics;
    if (!pol) return [];
    const seen = new Map<number, WarView>();
    for (const h of this.chain(house)) for (const w of pol.warsOf(h)) seen.set(w.id, w);
    return [...seen.values()];
  }
}

const EMPTY: readonly number[] = [];
