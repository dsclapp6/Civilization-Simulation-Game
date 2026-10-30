// The social system's saved data: one compact JSON section, `state.ext['social']`. Created on first
// write (installing the module changes nothing in a save), rewritten whole when it changes
// (`state.touchExt`), so every list is capped. Everything else the module knows lives in existing
// fields (`Person.opinions`, `Person.rep`, `Person.money` …) or is transient (conversations, barks).
import { NONE, type GameState, type PersonId } from '../state';
import { DEBT, MEMORY, NEWS } from './tuning';

export const EXT_KEY = 'social';

/** What `o` remembers of `a` (usually the player): a deed, when, and how it moved their opinion. */
export interface MemoryRec { o: PersonId; a: PersonId; d: number; r: string; v: number }
/** Talk counters for one pair on one day: chatty topics, gifts, courting gestures, and a bitmask of one-off uses (1 lesson, 2 greeting, 4 bout). */
export interface TalkRec { a: PersonId; b: PersonId; d: number; n: number; g: number; c: number; x: number }
/** A courtship or betrothal between `a` (who courts) and `b`. */
export interface CourtRec {
  a: PersonId;
  b: PersonId;
  /** Progress 0..1. */
  p: number;
  /** Day it began, day of the last gesture, progress gained on day `td`. */
  s: number;
  l: number;
  t: number;
  td: number;
  /** Consents granted, and refusals [who, day]. */
  ok: PersonId[];
  no: Array<[PersonId, number]>;
  /** Betrothed (arranged match): the wedding follows when both are old enough. */
  be?: 1;
}
/** `to` owes `from` pence. */
export interface DebtRec { from: PersonId; to: PersonId; v: number; d: number }
/** A notable event gossip can carry: kind, day, settlement, up to two people, a short detail. */
export interface RumourRec { k: string; d: number; s: number; a: PersonId; b: PersonId; x?: string }
/** The player's devotions: last holy day Mass was heard, streak, holy days missed in a row, last holy day checked, last day prayed, last confession. */
export interface MassRec { last: number; streak: number; missed: number; checked: number; pray: number; conf: number }

export interface SocialData {
  v: 1;
  mem: MemoryRec[];
  talk: TalkRec[];
  court: CourtRec[];
  debts: DebtRec[];
  rum: RumourRec[];
  /** News keys already told to the player → day. */
  told: Record<string, number>;
  mass: MassRec;
  /** Last day opinions were decayed per settlement is not needed (decay is scheduled by id and day). */
}

export function emptyData(): SocialData {
  return { v: 1, mem: [], talk: [], court: [], debts: [], rum: [], told: {}, mass: { last: -1, streak: 0, missed: 0, checked: -1, pray: -1, conf: -99 } };
}

const EMPTY: Readonly<SocialData> = Object.freeze(emptyData());

export class SocialStore {
  constructor(private readonly state: GameState) {}

  /** Read-only view (a shared empty record when nothing was ever written). Never mutate the result. */
  read(): Readonly<SocialData> {
    const d = this.state.ext[EXT_KEY] as SocialData | undefined;
    return d && d.v === 1 ? d : EMPTY;
  }

  /** The live record, created on first use; callers must call `touch()` after changing it. */
  write(): SocialData {
    let d = this.state.ext[EXT_KEY] as SocialData | undefined;
    if (!d || d.v !== 1) {
      d = emptyData();
      this.state.ext[EXT_KEY] = d;
    }
    // sections added by later versions of the module must exist on older saves
    d.mem ??= []; d.talk ??= []; d.court ??= []; d.debts ??= []; d.rum ??= []; d.told ??= {};
    d.mass ??= { last: -1, streak: 0, missed: 0, checked: -1, pray: -1, conf: -99 };
    this.state.touchExt(EXT_KEY);
    return d;
  }

  touch(): void { this.state.touchExt(EXT_KEY); }

  // ---- memories ----

  memoriesOf(of: PersonId, about: PersonId): MemoryRec[] {
    const out: MemoryRec[] = [];
    for (const m of this.read().mem) if (m.o === of && m.a === about) out.push(m);
    return out;
  }

  addMemory(rec: MemoryRec): void {
    const d = this.write();
    d.mem.push(rec);
    // keep the strongest few per pair, then the newest overall
    let pair = 0;
    for (const m of d.mem) if (m.o === rec.o && m.a === rec.a) pair++;
    if (pair > MEMORY.perPair) {
      let weakest = -1, weakestKey = Infinity;
      for (let i = 0; i < d.mem.length - 1; i++) {
        const m = d.mem[i];
        if (m.o !== rec.o || m.a !== rec.a) continue;
        const key = Math.abs(m.v) * 10 + m.d * 0.001;
        if (key < weakestKey) { weakestKey = key; weakest = i; }
      }
      if (weakest >= 0) d.mem.splice(weakest, 1);
    }
    if (d.mem.length > MEMORY.max) d.mem.splice(0, d.mem.length - MEMORY.max);
  }

  /** Drops the bad memories `o` holds of `a` (an apology accepted). */
  forgive(o: PersonId, a: PersonId): void {
    const d = this.write();
    d.mem = d.mem.filter((m) => !(m.o === o && m.a === a && m.v < 0));
  }

  // ---- talk counters ----

  talkRec(a: PersonId, b: PersonId, day: number, create: boolean): TalkRec | null {
    const list = create ? this.write().talk : (this.read().talk as TalkRec[]);
    for (const t of list) if (t.a === a && t.b === b && t.d === day) return t;
    if (!create) return null;
    const t: TalkRec = { a, b, d: day, n: 0, g: 0, c: 0, x: 0 };
    list.push(t);
    if (list.length > 48) list.splice(0, list.length - 48);
    return t;
  }

  // ---- courtships ----

  courtOf(x: PersonId, y: PersonId): CourtRec | null {
    for (const c of this.read().court) if ((c.a === x && c.b === y) || (c.a === y && c.b === x)) return c;
    return null;
  }

  courtsInvolving(x: PersonId): CourtRec[] {
    return this.read().court.filter((c) => c.a === x || c.b === x);
  }

  removeCourt(rec: CourtRec): void {
    const d = this.write();
    const i = d.court.indexOf(rec);
    if (i >= 0) d.court.splice(i, 1);
  }

  // ---- debts ----

  debtsOwedBy(borrower: PersonId): DebtRec[] { return this.read().debts.filter((x) => x.to === borrower); }
  debtsOwedTo(lender: PersonId): DebtRec[] { return this.read().debts.filter((x) => x.from === lender); }

  addDebt(rec: DebtRec): void {
    const d = this.write();
    const same = d.debts.find((x) => x.from === rec.from && x.to === rec.to);
    if (same) { same.v += rec.v; same.d = rec.d; }
    else d.debts.push(rec);
    if (d.debts.length > DEBT.max) d.debts.splice(0, d.debts.length - DEBT.max);
  }

  // ---- rumours ----

  addRumour(rec: RumourRec): void {
    const d = this.write();
    d.rum.push(rec);
    if (d.rum.length > NEWS.maxRumours) d.rum.splice(0, d.rum.length - NEWS.maxRumours);
  }

  markTold(key: string, day: number): void {
    const d = this.write();
    d.told[key] = day;
    const keys = Object.keys(d.told);
    if (keys.length > NEWS.maxTold) {
      keys.sort((x, y) => d.told[x] - d.told[y]);
      for (let i = 0; i < keys.length - NEWS.maxTold; i++) delete d.told[keys[i]];
    }
  }
}

export function isNone(id: PersonId): boolean { return id === NONE; }
