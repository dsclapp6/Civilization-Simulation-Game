// Shared runtime of the objectives module: the persisted section (`state.ext.objectives`), the records
// objectives are kept in, and the small helpers every part uses (adding, finishing and tracking objectives,
// rewards, notices). Nothing here is hidden state: whatever influences the simulation lives in the saved
// section; the caches (views, places) are pure functions of it and of the world.
import type { SkillId, StatId } from '../../core/domain';
import type { Rng } from '../../core/rng';
import { daylight, toDate } from '../../core/time';
import type { Settlement, WorldModel } from '../../world/types';
import type { Simulation } from '../sim';
import { formatMoney } from '../money';
import { gainSkill } from '../skills';
import { ageYears, fullName, type GameState, type Person, type PersonId } from '../state';
import type { Wave3Deps } from '../wave3deps';
import { T } from './data';
import { awayFromHome } from './places';
import type { DaySummary, Objective, ObjectiveSource, ObjectiveStep, ObjectiveTarget } from './types';

export const OBJ_KEY = 'objectives';

// ---------------------------------------------------------------------------------------------
// Step matchers (plain data: they are saved with the objective)
// ---------------------------------------------------------------------------------------------

/** How a step is completed. Event-based kinds count events as they happen; state-based kinds look at the world. */
export type Match =
  /** A conversation with `who` begins (0 = anyone). */
  | { k: 'talk'; who: number }
  /** Conversations with `need` different people (not the ones listed, which are remembered in `seen`). */
  | { k: 'talkAny'; need: number; not: number[]; seen: number[] }
  /** `need` completed actions whose option id matches a pattern (`farm.*` or an exact id), optionally on one target. */
  | { k: 'act'; ids: string[]; at?: { kind: string; id: number }; need: number; re?: 'deadwood' }
  /** A strip's current task is finished (state-based: also true when someone else did it). */
  | { k: 'strip'; strip: number; task: string; need: number }
  /** The player stands within `r` metres of a point, or on a strip (`strip`), inside the window [from, to] of absolute days if given. */
  | { k: 'reach'; x: number; z: number; r: number; strip?: number; from?: number; to?: number }
  /** `need` trade lines with the player buying, selling or either. */
  | { k: 'trade'; dir: 'buy' | 'sell' | 'any'; need: number; item?: string }
  /** The player carries (or, with `hh`, the household stores hold) at least `qty` of a good. */
  | { k: 'have'; good: string; qty: number; hh?: boolean }
  /** The player begins to sleep. */
  | { k: 'sleep' }
  | { k: 'skill'; skill: SkillId; level: number }
  | { k: 'stat'; stat: StatId; value: number }
  /** The player's purse (and, for the head of a household, its purse; with `family`, the family's purse whoever holds it). */
  | { k: 'money'; pence: number; family?: boolean }
  /** The player's career becomes `to` (any change when omitted), or they take a post (`post`). */
  | { k: 'career'; to?: string; post?: boolean }
  /** A request of the happenings module reaches a state. */
  | { k: 'req'; id: number; at: 'accepted' | 'done'; type?: string }
  /** Request work (jobs done, hours watched …): progress read from the request record. */
  | { k: 'reqwork'; id: number; field: 'done' | 'watched' }
  | { k: 'wait'; until: number }
  | { k: 'age'; years: number }
  | { k: 'court'; with: number; progress: number }
  | { k: 'flag'; name: string };

export interface StepRec extends ObjectiveStep {
  m: Match;
  /** The step is a hand-in: the person it points at is the one to report to ("?" over their head once what it needs is gathered). */
  turnin?: true;
}

/** What an objective really brings when it is done (the `reward` text only describes it). */
export interface Reward {
  /** Paid by the giver's household if it can afford it. */
  pence?: number;
  /** The giver's opinion of the player. */
  opinion?: number;
  skill?: SkillId;
  xp?: number;
  points?: number;
}

export interface ObjRec {
  id: number;
  source: ObjectiveSource;
  title: string;
  giver?: PersonId;
  why: string;
  steps: StepRec[];
  reward?: string;
  dueDay?: number;
  state: Objective['state'];
  tracked: boolean;
  /** Dedupe key: one live objective per key. */
  key: string;
  born: number;
  ended?: number;
  pay?: Reward;
  /** Opinion lost with the giver when the objective lapses untouched (a chore ignored). */
  fine?: number;
  /** Tutorial stage index within its chain. */
  tut?: number;
  /** Kind-specific numbers (request id, strip id …). */
  data?: Record<string, number | string>;
}

export interface NewObjective {
  source: ObjectiveSource;
  key: string;
  title: string;
  why: string;
  giver?: PersonId;
  steps: Array<{ text: string; hint?: string; target?: ObjectiveTarget; m: Match; goal?: number; progress?: number; turnin?: boolean }>;
  reward?: string;
  pay?: Reward;
  fine?: number;
  dueDay?: number;
  tut?: number;
  data?: Record<string, number | string>;
}

// ---------------------------------------------------------------------------------------------
// The day's log (the summary is built from it)
// ---------------------------------------------------------------------------------------------

export interface WorkTally { verb: string; at: string; n: number; fin: number }

export interface DayLog {
  day: number;
  money0: number;
  skills0: Record<string, number>;
  stats0: Record<string, number>;
  work: Record<string, WorkTally>;
  goods: Record<string, number>;
  /** Money seen coming in and going out through events (the rest is reconciled against the purse). */
  inc: number;
  out: number;
  done: string[];
  failed: string[];
  trades: number;
  talks: number;
}

export interface ObjSave {
  v: 1;
  next: number;
  /** Whose objectives these are (a change of character starts afresh). */
  person: PersonId;
  list: ObjRec[];
  /** The tracked objective (0 = none) and whether the player picked it. */
  tracked: number;
  pinned: boolean;
  foundPerson: PersonId;
  foundPlace: ObjectiveTarget | null;
  tut: { cls: string; stage: number; done: boolean; since: number };
  choresDay: number;
  jobsDay: number;
  goalsDay: number;
  log: DayLog;
  sums: DaySummary[];
  /** Last day for which `dayEnd` was emitted. */
  closed: number;
  /** Cooldowns and one-shot marks: key → absolute day. */
  seen: Record<string, number>;
  n: { added: number; done: number; failed: number; expired: number };
}

export function newLog(day: number): DayLog {
  return { day, money0: 0, skills0: {}, stats0: {}, work: {}, goods: {}, inc: 0, out: 0, done: [], failed: [], trades: 0, talks: 0 };
}

export function newObjSave(): ObjSave {
  return {
    v: 1, next: 1, person: 0, list: [], tracked: 0, pinned: false, foundPerson: 0, foundPlace: null,
    tut: { cls: '', stage: 0, done: false, since: 0 }, choresDay: -1, jobsDay: -1, goalsDay: -1, log: newLog(0), sums: [], closed: -1,
    seen: {}, n: { added: 0, done: 0, failed: 0, expired: 0 },
  };
}

/** Auto-tracking order: what the player most needs to see first. */
const SOURCE_RANK: Record<ObjectiveSource, number> = { story: 0, tutorial: 1, job: 2, chore: 3, request: 4, career: 5, goal: 6 };
/** How long finished objectives stay in the list (days). */
const KEEP_FINISHED = 3;
const MAX_LIST = 48;

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

export class Obj {
  readonly sim: Simulation;
  readonly state: GameState;
  readonly world: WorldModel;
  readonly deps: Wave3Deps;
  save: ObjSave;
  /** Bumps whenever something the HUD shows may have changed (cheap change detection). */
  version = 0;
  readonly settlementById = new Map<number, Settlement>();
  private viewList: Objective[] | null = null;
  private viewVersion = -1;
  /** Called after any change to an objective's steps (the quest-giver marks follow). */
  onChange: (() => void) | null = null;
  /** Called when an objective ends (the next tutorial stage, the head's reaction, cooldowns of goals). */
  onFinished: ((o: ObjRec, state: 'done' | 'failed' | 'expired') => void) | null = null;

  constructor(sim: Simulation, deps: Wave3Deps) {
    this.sim = sim;
    this.state = sim.state;
    this.world = sim.world;
    this.deps = deps;
    const cur = sim.state.ext[OBJ_KEY] as ObjSave | undefined;
    if (cur && typeof cur === 'object') this.save = cur;
    else { this.save = newObjSave(); sim.state.ext[OBJ_KEY] = this.save; sim.state.touchExt(OBJ_KEY); }
    // fill what a save from an older build may lack
    const base = newObjSave() as unknown as Record<string, unknown>;
    const s = this.save as unknown as Record<string, unknown>;
    for (const k of Object.keys(base)) if (s[k] === undefined) s[k] = base[k];
    for (const st of sim.world.settlements) this.settlementById.set(st.id, st);
  }

  // ---- time and people ----

  get day(): number { return this.sim.absDay; }
  get dayNo(): number { return Math.floor(this.sim.absDay); }
  get playerId(): PersonId { return this.state.run.playerId; }
  /** The living player character, if any. */
  get me(): Person | undefined {
    const p = this.state.persons.get(this.state.run.playerId);
    return p && !p.death && this.state.run.phase === 'alive' ? p : undefined;
  }
  rng(): Rng { return this.sim.rng('objectives'); }
  age(p: Person): number { return ageYears(p, this.sim.absDay); }
  name(id: PersonId): string { const p = this.state.persons.get(id); return p ? fullName(p) : 'someone'; }
  first(id: PersonId): string { return this.state.persons.get(id)?.first ?? 'someone'; }

  /** Absolute day of today's sunrise, and the hour of the day it falls in. */
  sunrise(day = this.dayNo): number {
    const season = toDate(day).season;
    return day + daylight(season).sunrise;
  }
  dawnHour(day = this.dayNo): number { return Math.ceil(daylight(toDate(day).season).sunrise * 24); }

  // ---- persistence ----

  touch(): void {
    this.state.touchExt(OBJ_KEY);
    this.version++;
    this.viewList = null;
  }

  // ---- notices ----

  notify(text: string, kind: 'info' | 'gain' | 'loss' | 'warn' | 'danger' | 'quest' | 'social', person?: PersonId, ref?: string): void {
    const payload: { kind: typeof kind; text: string; person?: PersonId; ref?: string } = { kind, text };
    if (person !== undefined) payload.person = person;
    if (ref) payload.ref = ref;
    this.sim.events.emit('notify', payload);
  }

  // ---- the objectives ----

  /** Live objectives (state active). */
  active(): ObjRec[] { return this.save.list.filter((o) => o.state === 'active'); }
  byKey(key: string): ObjRec | undefined { return this.save.list.find((o) => o.key === key && o.state === 'active'); }
  byId(id: number): ObjRec | undefined { return this.save.list.find((o) => o.id === id); }
  /** The first step not yet done (undefined when all are). */
  current(o: ObjRec): StepRec | undefined { return o.steps.find((s) => !s.done); }

  /** Adds an objective unless one with the same key is live. Returns it, or null when it is a duplicate. */
  add(spec: NewObjective): ObjRec | null {
    if (this.byKey(spec.key)) return null;
    const rec: ObjRec = {
      id: this.save.next++, source: spec.source, title: spec.title, why: spec.why, steps: [], state: 'active', tracked: false,
      key: spec.key, born: this.dayNo,
    };
    if (spec.giver) rec.giver = spec.giver;
    if (spec.reward) rec.reward = spec.reward;
    if (spec.pay) rec.pay = spec.pay;
    if (spec.fine) rec.fine = spec.fine;
    if (spec.dueDay !== undefined) rec.dueDay = Math.round(spec.dueDay * 1000) / 1000;
    if (spec.tut !== undefined) rec.tut = spec.tut;
    if (spec.data) rec.data = spec.data;
    for (const s of spec.steps) {
      const st: StepRec = { text: s.text, done: false, m: s.m };
      if (s.hint) st.hint = s.hint;
      if (s.target) st.target = s.target;
      if (s.turnin) st.turnin = true;
      if (s.goal !== undefined) { st.goal = s.goal; st.progress = s.progress ?? 0; }
      rec.steps.push(st);
    }
    this.save.list.push(rec);
    this.save.n.added++;
    this.trim();
    this.retrack();
    this.touch();
    this.sim.events.emit('objective', { phase: 'added', id: rec.id, title: rec.title });
    return rec;
  }

  /** Removes the oldest finished objectives beyond the keeping time and the list cap. */
  private trim(): void {
    const now = this.dayNo;
    const list = this.save.list;
    let keep = list.filter((o) => o.state === 'active' || (o.ended ?? now) >= now - KEEP_FINISHED);
    if (keep.length > MAX_LIST) {
      const finished = keep.filter((o) => o.state !== 'active').sort((a, b) => (a.ended ?? 0) - (b.ended ?? 0) || a.id - b.id);
      const drop = new Set(finished.slice(0, keep.length - MAX_LIST).map((o) => o.id));
      keep = keep.filter((o) => !drop.has(o.id));
    }
    if (keep.length !== list.length) this.save.list = keep;
  }

  /** Ends an objective. Done pays its reward, a lapse untouched costs the giver's good opinion. */
  finish(o: ObjRec, state: 'done' | 'failed' | 'expired', note?: string): void {
    if (o.state !== 'active') return;
    o.state = state;
    o.ended = this.dayNo;
    if (state === 'done') {
      for (const s of o.steps) {
        s.done = true;
        if (s.goal !== undefined) s.progress = s.goal;
      }
      this.save.n.done++;
      this.save.log.done.push(o.title);
      this.payReward(o);
    } else {
      if (state === 'failed') this.save.n.failed++; else this.save.n.expired++;
      if (state === 'failed') this.save.log.failed.push(o.title);
      this.lapse(o, state, note);
    }
    this.retrack();
    this.touch();
    this.sim.events.emit('objective', { phase: state, id: o.id, title: o.title });
    this.onFinished?.(o, state);
  }

  /** The real reward: coins from the giver's household, their good opinion, a little experience, points. */
  private payReward(o: ObjRec): void {
    const p = this.me;
    const pay = o.pay;
    if (!p || !pay) return;
    const giver = o.giver ? this.state.persons.get(o.giver) : undefined;
    let paid = 0;
    if (pay.pence && pay.pence > 0) {
      const hh = giver && giver.id !== p.id ? this.state.households.get(giver.household) : undefined;
      // the household pays what it can spare: never more than half its purse
      const can = hh ? Math.min(pay.pence, Math.floor(hh.purse * 0.5 * 100) / 100) : 0;
      if (hh && can > 0) {
        hh.purse = Math.round((hh.purse - can) * 100) / 100;
        p.money = Math.round((p.money + can) * 100) / 100;
        this.state.touchHousehold(hh);
        this.state.touch(p);
        paid = can;
        this.save.log.inc += can;
        this.notify(`${giver?.first ?? 'The household'} gives you ${formatMoney(can)} for your trouble.`, 'gain', giver?.id);
      }
    }
    if (pay.opinion && giver && giver.id !== p.id) this.deps.social.adjustOpinion(giver.id, p.id, pay.opinion, 'helped');
    if (pay.skill && pay.xp) gainSkill(this.sim, p, pay.skill, pay.xp);
    if (pay.points) this.sim.score.award('deed', pay.points, o.title);
    void paid;
  }

  private lapse(o: ObjRec, state: 'failed' | 'expired', note?: string): void {
    const p = this.me;
    const giver = o.giver ? this.state.persons.get(o.giver) : undefined;
    if (!p || !giver || giver.id === p.id || !o.fine) return;
    // only a chore left wholly untouched, by someone who was at hand (not on the road), costs the head's good opinion
    const untouched = !o.steps.some((s) => s.done || (s.progress ?? 0) > 0);
    if (!untouched || p.settlement !== giver.settlement || awayFromHome(this, p)) return;
    this.deps.social.adjustOpinion(giver.id, p.id, -o.fine, 'left chores');
    this.notify(note ?? T('chores', 'say.late', { head: giver.first, title: o.title }), 'loss', giver.id);
  }

  // ---- tracking ----

  /** Chooses the tracked objective: the player's pick while it lives, else the most pressing. */
  retrack(): void {
    const s = this.save;
    const act = s.list.filter((o) => o.state === 'active');
    let pick: ObjRec | undefined;
    if (s.pinned) pick = act.find((o) => o.id === s.tracked);
    if (!pick) {
      s.pinned = false;
      pick = act.slice().sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.dueDay ?? 1e9) - (b.dueDay ?? 1e9) || a.id - b.id)[0];
    }
    const id = pick ? pick.id : 0;
    if (id !== s.tracked) s.tracked = id;
    for (const o of s.list) o.tracked = o.id === id;
  }

  track(id: number): void {
    const o = this.byId(id);
    if (!o || o.state !== 'active') return;
    this.save.tracked = id;
    this.save.pinned = true;
    this.retrack();
    this.touch();
  }

  // ---- views ----

  /** Active objectives (tracked first), then the recently finished, newest first. */
  list(): readonly Objective[] {
    if (this.viewList && this.viewVersion === this.version) return this.viewList;
    const act = this.save.list.filter((o) => o.state === 'active')
      .sort((a, b) => Number(b.tracked) - Number(a.tracked) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.id - b.id);
    const fin = this.save.list.filter((o) => o.state !== 'active').sort((a, b) => (b.ended ?? 0) - (a.ended ?? 0) || b.id - a.id);
    this.viewList = [...act, ...fin];
    this.viewVersion = this.version;
    return this.viewList;
  }

  /** A short note that the tracked step's text changed (HUD change detection). */
  changed(): void {
    this.version++;
    this.viewList = null;
    this.onChange?.();
  }

  progressed(o: ObjRec): void {
    this.touch();
    this.sim.events.emit('objective', { phase: 'progress', id: o.id, title: o.title });
    this.onChange?.();
  }

  /** Forgets everything of the previous character (a succession or a switch) but keeps the daily summaries' history. */
  reset(): void {
    const s = this.save;
    s.list = [];
    s.tracked = 0;
    s.pinned = false;
    s.foundPerson = 0;
    s.foundPlace = null;
    s.tut = { cls: '', stage: 0, done: true, since: this.dayNo };
    s.choresDay = -1;
    s.jobsDay = -1;
    s.goalsDay = -1;
    s.seen = {};
    s.person = this.playerId;
    this.touch();
  }
}

/** Stat and skill ids as the `Match` kinds use them, for text. */
export const STAT_TITLE: Record<StatId, string> = { str: 'Strength', end: 'Endurance', agi: 'Agility', int: 'Intellect', per: 'Perception', cha: 'Charisma' };
