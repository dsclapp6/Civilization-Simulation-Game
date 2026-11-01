// System scheduler: systems register for a phase and run in a deterministic order
// (explicit `order`, then registration order). Phases map onto the clock's hooks, plus the
// per-step phase used by detailed agents (wave 2).
import type { DayInfo, HourInfo, SeasonInfo, YearInfo } from './clock';
import type { SimContext } from './context';

export type Phase = 'perStep' | 'hourly' | 'daily' | 'seasonal' | 'yearly';

export interface StepInfo {
  /** Fixed simulated seconds of this sub-step (core/time SIM_DT). */
  dt: number;
  /** Monotonic sub-step counter. */
  step: number;
}

export interface PhaseInfo {
  perStep: StepInfo;
  hourly: HourInfo;
  daily: DayInfo;
  seasonal: SeasonInfo;
  yearly: YearInfo;
}

export interface System<P extends Phase = Phase> {
  /** Unique name (also the key in profiling output). */
  name: string;
  phase: P;
  /** Lower runs first within a phase. Default 100. */
  order?: number;
  /**
   * A heavy system can be cut into this many shards: `run` is then called once per shard (0..shards-1, in that
   * order) and the live game may pause between two shards to keep a frame short. The shards together do exactly
   * what one call would, so the order of everything stays fixed.
   */
  shards?: number;
  run(ctx: SimContext, info: PhaseInfo[P], shard?: number): void;
}

export interface SystemProfile { calls: number; totalMs: number; maxMs: number; /** Calls that took longer than `SLOW_MS`. */ slow: number }

/** A call longer than this (ms) is counted as slow in the profile (a frame budget is 16 ms; one system should not take half). */
export const SLOW_MS = 8;

const PHASES: readonly Phase[] = ['perStep', 'hourly', 'daily', 'seasonal', 'yearly'];

interface Entry { sys: System; seq: number; order: number }
/** One resumable unit of a phase: a system, or one shard of it. */
interface Step { sys: System; shard: number }

export class Scheduler {
  private readonly byPhase: Record<Phase, Entry[]> = { perStep: [], hourly: [], daily: [], seasonal: [], yearly: [] };
  private readonly steps: Record<Phase, Step[]> = { perStep: [], hourly: [], daily: [], seasonal: [], yearly: [] };
  private readonly names = new Set<string>();
  private seq = 0;
  /** When true, per-system wall time is recorded in `profile`. */
  profiling = false;
  /** Clock for the profile (ms). Tools running a busy machine swap in CPU time so other processes do not inflate the numbers. */
  clock: () => number = () => performance.now();
  readonly profile = new Map<string, SystemProfile>();
  /** Tools: told every profiled call (name, ms) so spikes can be traced to the hour they happen in. */
  onCall: ((name: string, ms: number) => void) | null = null;

  register<P extends Phase>(sys: System<P>): () => void {
    if (this.names.has(sys.name)) throw new Error(`System already registered: ${sys.name}`);
    this.names.add(sys.name);
    const list = this.byPhase[sys.phase];
    const entry: Entry = { sys: sys as unknown as System, seq: this.seq++, order: sys.order ?? 100 };
    list.push(entry);
    list.sort((a, b) => a.order - b.order || a.seq - b.seq);
    this.rebuild(sys.phase);
    return () => this.unregister(sys.name);
  }

  unregister(name: string): void {
    if (!this.names.delete(name)) return;
    for (const p of PHASES) {
      const list = this.byPhase[p];
      const i = list.findIndex((e) => e.sys.name === name);
      if (i >= 0) { list.splice(i, 1); this.rebuild(p); }
    }
  }

  private rebuild(phase: Phase): void {
    const steps: Step[] = [];
    for (const e of this.byPhase[phase]) for (let k = 0, n = Math.max(1, e.sys.shards ?? 1); k < n; k++) steps.push({ sys: e.sys, shard: k });
    this.steps[phase] = steps;
  }

  /** Systems of a phase in execution order. */
  list(phase: Phase): readonly System[] { return this.byPhase[phase].map((e) => e.sys); }

  /**
   * Runs the steps (systems, or shards of them) of a phase starting at step `from`, stopping once `deadline` (on
   * this scheduler's clock) has passed after at least one step. Returns the step to resume from, or -1 when the
   * phase is complete. Order and results are identical to `run`; only the frame changes.
   */
  runFrom<P extends Phase>(phase: P, ctx: SimContext, info: PhaseInfo[P], from: number, deadline: number): number {
    const steps = this.steps[phase];
    for (let i = from; i < steps.length; i++) {
      if (i > from && this.clock() >= deadline) return i;
      this.runStep(steps[i], ctx, info);
    }
    return -1;
  }

  private runStep<P extends Phase>(st: Step, ctx: SimContext, info: PhaseInfo[P]): void {
    const sys = st.sys as System<P>;
    if (!this.profiling) { sys.run(ctx, info, st.shard); return; }
    const t0 = this.clock();
    sys.run(ctx, info, st.shard);
    this.record(sys.name, this.clock() - t0);
  }

  private record(name: string, dt: number): void {
    let p = this.profile.get(name);
    if (!p) { p = { calls: 0, totalMs: 0, maxMs: 0, slow: 0 }; this.profile.set(name, p); }
    p.calls++;
    p.totalMs += dt;
    if (dt > p.maxMs) p.maxMs = dt;
    if (dt > SLOW_MS) p.slow++;
    this.onCall?.(name, dt);
  }

  run<P extends Phase>(phase: P, ctx: SimContext, info: PhaseInfo[P]): void {
    const steps = this.steps[phase];
    for (let i = 0; i < steps.length; i++) this.runStep(steps[i], ctx, info);
  }
}
