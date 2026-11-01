// Strip work for the view (clarity pass): which strips are being ploughed, sown, reaped… right now, and how far the task
// has got (0..1). Two sources:
//   - a task somebody is in the middle of (the player's bouts, a task left half done): its saved progress, exactly;
//   - the household farm's work, which the macro model lands in one step when the settlement's day is run (farm.ts
//     macroPlan): the strips it is about to work show the work through the day before, from the start of the working
//     day to the hour the step lands, so a village is seen working its land instead of finding it changed.
// Pure reading of the state (nothing is written, no random stream), computed only for settlements near the focus and
// only when the hour, the farm or the focus changes; `version` moves when what is shown changes visibly.
import { hash01 } from '../../core/math';
import { daylight, toDate, type Season } from '../../core/time';
import type { StripTask } from '../../core/view';
import { peekExtra } from '../farming';
import { macroPlan, nextTask, farmEff, type MacroAct } from './farm';
import type { Econ } from './core';
import { partsOf } from './macro';
import { slotOf } from './systems';

export interface StripActivity {
  id: number;
  task: StripTask;
  /** 0..1 of the task done. */
  work: number;
}

/** Settlements this near the focus (metres from their middle, less their radius) are looked at. */
const NEAR = 420;
/** Work is shown in steps of this much (fewer, larger visible changes). */
const STEP = 1 / 12;

interface Predicted { id: number; task: StripTask; from: number; to: number }

const TASK_OF: Record<MacroAct, StripTask | null> = {
  harvest: 'reap', harvest_cut: 'bind', carry: 'carry', plough: 'plough', sow: 'sow', fallow: null,
};

/** The hours people work the land on `day`: from a little after sunrise to a little before the evening meal's end. */
export function workingHours(day: number): { from: number; to: number } {
  const season = toDate(day + 0.5).season as Season;
  const { sunrise, sunset } = daylight(season);
  return { from: day + sunrise + 0.04, to: day + sunset - 0.09 };
}

/** When the work that lands at `flip` is seen being done: [from, to] in absolute days. */
export function workWindow(flip: number): { from: number; to: number } {
  const day = Math.floor(flip);
  const today = workingHours(day);
  if (flip >= today.to) return today; // lands after the day's work: the whole working day
  if (flip > today.from + 0.05) return { from: today.from, to: flip }; // lands in the middle of it
  return workingHours(day - 1); // lands in the night or at dawn: it was done the day before
}

export class StripFeed {
  private readonly items: StripActivity[] = [];
  private ver = 0;
  private predicted: Predicted[] = [];
  private inProgress: Array<{ id: number; task: StripTask; p: number }> = [];
  private lastKey = '';
  private lastSig = '';

  constructor(private readonly E: Econ) {}

  /** Moves when what the view should show changes (members or their quantised work). */
  version(): number { this.refresh(); return this.ver; }

  list(): readonly StripActivity[] { this.refresh(); return this.items; }

  private refresh(): void {
    const E = this.E;
    const now = E.sim.absDay;
    const focus = E.sim.view.focus();
    // candidates are looked for again when the hour, the farm, the strips or the focus change
    const key = `${Math.floor(now * 24)}:${E.farmRev}:${E.state.stripRevision}:${Math.round(focus.x / 60)}:${Math.round(focus.z / 60)}`;
    if (key !== this.lastKey) { this.lastKey = key; this.findPredicted(now, focus.x, focus.z); }
    const items = this.items;
    items.length = 0;
    const seen = new Set<number>();
    // work somebody is in the middle of
    for (const w of this.inProgress) { items.push({ id: w.id, task: w.task, work: Math.round(w.p * 100) / 100 }); seen.add(w.id); }
    // the household farm's work, spread over the day before it lands
    for (const pr of this.predicted) {
      if (seen.has(pr.id) || now < pr.from) continue;
      const w = quantise(Math.min(1, (now - pr.from) / Math.max(0.01, pr.to - pr.from)));
      if (w <= 0) continue;
      items.push({ id: pr.id, task: pr.task, work: w });
    }
    let sig = '';
    for (const it of items) sig += `${it.id}:${it.task}:${it.work.toFixed(3)},`;
    if (sig !== this.lastSig) { this.lastSig = sig; this.ver++; }
  }

  private nearFocus(stripId: number, fx: number, fz: number): boolean {
    const c = this.E.stripCentre.get(stripId);
    return !!c && Math.abs(c.x - fx) < NEAR + 120 && Math.abs(c.z - fz) < NEAR + 120;
  }

  /** The strips of nearby settlements that the household farm will work at the next run of their day. */
  private findPredicted(now: number, fx: number, fz: number): void {
    const E = this.E;
    this.predicted = [];
    this.inProgress = [];
    for (const [sid, ex] of Object.entries(E.farm.s)) {
      const p = ex.p ?? 0;
      if (p <= 0.001) continue;
      const id = Number(sid);
      const st = E.state.strips.get(id);
      const task = st ? nextTask(E, st) : null;
      if (task && this.nearFocus(id, fx, fz)) this.inProgress.push({ id, task, p });
    }
    for (const s of E.world.settlements) {
      if (s.strips.length === 0) continue;
      if (Math.hypot(s.x - fx, s.z - fz) - s.radius > NEAR + 200) continue;
      const parts = partsOf(s);
      const cache = new Map<number, number>();
      const effOf = (hid: number): number => {
        let v = cache.get(hid);
        if (v !== undefined) return v;
        if (hid === 0) v = 0.9;
        else {
          const hh = E.state.households.get(hid);
          let n = 0;
          for (const id of s.strips) if (E.state.strips.get(id)?.holder === hid) n++;
          v = hh ? farmEff(E, hh, n) : 0.5;
        }
        cache.set(hid, v);
        return v;
      };
      for (const id of s.strips) {
        const st = E.state.strips.get(id);
        if (!st) continue;
        const ex = peekExtra(E.farm, id);
        if ((ex?.p ?? 0) > 0.001) continue;
        // the settlement's day runs in `parts` slices on consecutive hours from its own slot; this strip is dealt to one
        const hour = (slotOf(s.id) + (id % parts)) % 24;
        let flip = Math.floor(now) + hour / 24 + 1e-4;
        if (flip <= now) flip += 1;
        const act = macroPlan(E, st, effOf, flip);
        const task = act ? TASK_OF[act] : null;
        if (!task) continue;
        const w = workWindow(flip);
        // the strips of a village are not all started at once: each begins a little way into the window and lands with the step
        const late = hash01(id, 11, 3) * 0.5 * (w.to - w.from);
        this.predicted.push({ id, task, from: w.from + late, to: w.to });
      }
    }
  }
}

function quantise(w: number): number { return Math.min(1, Math.max(0, Math.round(w / STEP) * STEP)); }
