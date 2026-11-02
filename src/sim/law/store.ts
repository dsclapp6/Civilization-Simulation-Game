// What the law remembers across saves (state.ext['law']): who is held and why, who is wanted on whose lands, and who has been
// warned before (a repeat offender is not heard twice). Patrols in progress are not saved: they are people in the detail zone,
// and a game loaded in the middle of one finds the player where they stood and the case unresolved — the watch finds them again.
import type { GameState, HouseId, PersonId } from '../state';
import { EXT_KEY, LAW_VERSION } from './config';
import type { CaptivityKind } from './types';

export interface CaptiveRec {
  person: PersonId;
  kind: CaptivityKind;
  captor: PersonId;
  /** The House that holds them. */
  house: HouseId;
  /** Where they are held (settlement id) and in which building (-1 while being led there). */
  settlement: number;
  building: number;
  /** Absolute day taken. */
  since: number;
  /** Pence asked (a prisoner of war's ransom is the military's; this is its copy), the fine owed, days of sentence. */
  ransom: number;
  fine: number;
  sentence: number;
  /** Serving the sentence now: free when `sentence` days are out. */
  serving: boolean;
  /** Under threat of hanging (warned), and the absolute day the warning was given (-1 none). */
  danger: boolean;
  dangerSince: number;
  /** The offence in a few words: "poaching the lord's deer", "trespass in the lord's closes", "raising his hand against the lord's men". */
  cause: string;
  /** Being led, bound, to the gaol (the walk is on). */
  led: boolean;
  /** Blood was shed: men of the captor's House died in the fight that led to the capture. */
  bloodshed: boolean;
  /** Failed escapes. */
  escapes: number;
  /** The military module keeps this prisoner's ransom (a prisoner of war, or taken through `military.takeCaptive`). */
  military: boolean;
}

export interface WantedRec { person: PersonId; settlement: number; until: number }
export interface OffenceRec { person: PersonId; settlement: number; count: number; last: number }

export interface LawData {
  v: number;
  captives: CaptiveRec[];
  wanted: WantedRec[];
  offences: OffenceRec[];
  stats: { patrols: number; seen: number; escorted: number; left: number; attacked: number; taken: number; released: number; escaped: number; hanged: number; fines: number; finesPaid: number };
}

export function emptyData(): LawData {
  return { v: LAW_VERSION, captives: [], wanted: [], offences: [], stats: { patrols: 0, seen: 0, escorted: 0, left: 0, attacked: 0, taken: 0, released: 0, escaped: 0, hanged: 0, fines: 0, finesPaid: 0 } };
}

/** The saved section with a version counter the API's `version()` reads. */
export class LawStore {
  data: LawData;
  /** Bumped on every change a UI should redraw for (patrol phase, captive records). */
  rev = 0;

  constructor(private readonly state: GameState) {
    const saved = state.ext[EXT_KEY] as LawData | undefined;
    this.data = saved && saved.v === LAW_VERSION && Array.isArray(saved.captives) ? saved : emptyData();
    if (!this.data.wanted) this.data.wanted = [];
    if (!this.data.offences) this.data.offences = [];
    if (!this.data.stats) this.data.stats = emptyData().stats;
    state.ext[EXT_KEY] = this.data;
  }

  /** Marks the saved section changed. */
  touch(): void {
    this.state.ext[EXT_KEY] = this.data;
    this.state.touchExt(EXT_KEY);
    this.rev++;
  }

  bump(): void { this.rev++; }

  captiveOf(person: PersonId): CaptiveRec | undefined {
    const c = this.data.captives;
    for (let i = 0; i < c.length; i++) if (c[i].person === person) return c[i];
    return undefined;
  }

  remove(rec: CaptiveRec): void {
    const i = this.data.captives.indexOf(rec);
    if (i >= 0) this.data.captives.splice(i, 1);
  }

  // ---- wanted ----

  wantedOn(person: PersonId, settlement: number, day: number): boolean {
    for (const w of this.data.wanted) if (w.person === person && w.settlement === settlement && w.until > day) return true;
    return false;
  }

  makeWanted(person: PersonId, settlement: number, until: number): void {
    const hit = this.data.wanted.find((w) => w.person === person && w.settlement === settlement);
    if (hit) hit.until = Math.max(hit.until, until);
    else this.data.wanted.push({ person, settlement, until });
    this.touch();
  }

  /** Drops expired entries; true when something went. */
  expireWanted(day: number): boolean {
    const n = this.data.wanted.length;
    if (n === 0) return false;
    this.data.wanted = this.data.wanted.filter((w) => w.until > day);
    return this.data.wanted.length !== n;
  }

  // ---- offences ----

  offencesOf(person: PersonId, settlement: number, day: number, window = 16): number {
    let n = 0;
    for (const o of this.data.offences) if (o.person === person && o.settlement === settlement && day - o.last <= window) n += o.count;
    return n;
  }

  noteOffence(person: PersonId, settlement: number, day: number): void {
    const hit = this.data.offences.find((o) => o.person === person && o.settlement === settlement);
    if (hit) { hit.count = day - hit.last > 16 ? 1 : hit.count + 1; hit.last = day; }
    else this.data.offences.push({ person, settlement, count: 1, last: day });
    if (this.data.offences.length > 80) this.data.offences = this.data.offences.filter((o) => day - o.last <= 16).slice(-60);
    this.touch();
  }
}
