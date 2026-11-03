// CONTRACT (wave 2) — Actions: the one "verb" layer between the player and every system.
//
// Systems (economy, social, agents, later military/politics) register ActionProviders. The player
// controller asks for the options on whatever the player is looking at (`list`), shows the default
// one as the interact prompt, and starts one (`start`). Instant actions resolve at once; timed actions
// run in simulated seconds (so 3×/8× speed shortens them) while the character plays `anim`, then the
// provider applies the result (`complete`). NPC work is macro (economy daily ticks); only the player
// and scripted agents use the runner.
//
// Owner: orchestrator (contract + runner). Providers live in their own modules.
import type { AnimState, CarryLook, HeldItem } from '../core/view';
import type { SimContext } from './context';
import type { PersonId } from './state';

export type TargetRef =
  | { kind: 'self' }
  | { kind: 'person'; id: PersonId }
  | { kind: 'animal'; id: number }
  | { kind: 'building'; id: number }
  | { kind: 'strip'; id: number }
  | { kind: 'parcel'; id: number }
  | { kind: 'scatter'; id: number }
  /** A loose item or pile in the world (owned by the module that dropped it). */
  | { kind: 'item'; id: number }
  | { kind: 'ground'; x: number; z: number }
  | { kind: 'settlement'; id: number };

export type ActionCategory =
  | 'work' | 'trade' | 'talk' | 'use' | 'social' | 'travel' | 'manage' | 'combat' | 'rest' | 'learn';

export interface ActionOption {
  /** Provider-scoped id, e.g. 'farm.reap'. Unique within one list. */
  id: string;
  /** Filled in by the registry. */
  provider: string;
  label: string;
  category: ActionCategory;
  target: TargetRef;
  enabled: boolean;
  /** Why it is disabled ("Needs a sickle", "Not your strip"). */
  reason?: string;
  /** Simulated seconds this actor needs (0 = instant). */
  seconds: number;
  /** Animation and props while performing a timed action. */
  anim?: AnimState;
  mainHand?: HeldItem;
  offHand?: HeldItem;
  carry?: CarryLook;
  /** Short preview of the result, e.g. "+3 sheaves · Farming". */
  preview?: string;
  /** Maximum distance (m) between actor and target to start and to keep going. */
  range: number;
  /** The highest-priority enabled option is the interact-key default. */
  priority: number;
  /**
   * Start again automatically after completing while still enabled (work bouts) — but only as long as the job lasts:
   * `bouts` bouts, or until stopped when the job is `open` (docs/WORK.md). Without either it is open-ended (the older
   * modules' practice and building work), and the action bar says so.
   */
  repeat?: boolean;
  /**
   * Work pass (docs/WORK.md): bouts the job still needs, this one included ("Dig the bed": 2). The runner starts the next
   * bout (re-listed, so it reflects the new state) until they are done, then stops — one action is one job.
   */
  bouts?: number;
  /** Open-ended work the player chose as such ("Keep working the strip"): bout after bout until stopped (Q) or no longer possible. */
  open?: boolean;
  /** Opaque provider payload. */
  data?: unknown;
  /**
   * Civilization pass (docs/CIV.md §8): the visible steps of the bout, played in order over its `seconds` (shares of the
   * whole): the forge's heat → hammer → quench, the butcher's block, the kiln. Each step may change the animation, the held
   * item and the sound cue the UI plays; the outcome still comes once, at the end. Absent = one `anim` for the whole bout.
   */
  steps?: ReadonlyArray<ActionStep>;
}

export interface ActionStep {
  /** Share of the bout (the shares sum to 1). */
  share: number;
  /** "Heat the bar", "Draw it out", "Quench". */
  label: string;
  anim?: AnimState;
  mainHand?: HeldItem;
  offHand?: HeldItem;
  /** Sound cue for the UI's effects ('bellows', 'hammer', 'quench', 'saw', 'chop', 'cut', 'dig', 'stir', 'fire'). */
  sfx?: string;
}

export interface ActionGain {
  label: string;
  amount?: number;
  /** Good / item key, skill id or 'money' (pence) — lets the UI pick an icon. */
  ref?: string;
}

/** Panels an action (or any system) can ask the UI to open. */
export type UiRequest =
  | { panel: 'dialogue'; conversation: number }
  | { panel: 'trade'; partner: TradePartnerRef }
  | { panel: 'building'; id: number }
  | { panel: 'person'; id: PersonId }
  | { panel: 'career'; person: PersonId }
  | { panel: 'property'; settlement: number }
  | { panel: 'jobs'; settlement: number }
  | { panel: 'household'; id: number }
  | { panel: 'perk'; person: PersonId; skill: string }
  | { panel: 'map' }
  /** The action wheel: every option on the player's current target (hold the interact key). */
  | { panel: 'actions' }
  /** Sleep / wait-until menu. */
  | { panel: 'rest' }
  | { panel: 'message'; title: string; text: string }
  /** A panel added by a later module (registered with `registerPanel` in src/ui/panels/registry.ts). */
  | { panel: 'ext'; name: string; id?: number; data?: unknown };

export type TradePartnerRef =
  | { kind: 'market'; settlement: number }
  | { kind: 'person'; id: PersonId }
  | { kind: 'building'; id: number };

export interface ActionOutcome {
  ok: boolean;
  /** One line for the HUD ("You reap a quarter of the strip."). */
  message?: string;
  gains?: ActionGain[];
  /** Open a panel (trade, dialogue…). */
  ui?: UiRequest;
}

export interface ActionProvider {
  readonly id: string;
  /** Append options for `actor` on `target`. Keep it cheap: called whenever the target changes. */
  list(ctx: SimContext, actor: PersonId, target: TargetRef, out: ActionOption[]): void;
  /** Re-validated on start and about once a second while running: a reason to stop, or null. */
  check?(ctx: SimContext, actor: PersonId, option: ActionOption): string | null;
  start?(ctx: SimContext, actor: PersonId, option: ActionOption): void;
  /** Apply the result. `fraction` is 1 when finished, or 0..1 when the provider allows partial work. */
  complete(ctx: SimContext, actor: PersonId, option: ActionOption, fraction: number): ActionOutcome;
  /** Called instead of `complete` when cancelled before the end and `partial` is not supported. */
  cancel?(ctx: SimContext, actor: PersonId, option: ActionOption, fraction: number): void;
  /** If true, a cancelled timed action still calls `complete` with the fraction done. */
  partial?: boolean;
}

export interface ActiveAction {
  readonly actor: PersonId;
  readonly option: ActionOption;
  /** Simulated seconds done. */
  elapsed: number;
  /** 0..1 */
  progress: number;
  readonly startedDay: number;
  /** The worker's hand in the bout's mini-game (0..1, the mean of their strokes); −1 when it was not played. */
  perf: number;
  /** Strokes played in the mini-game. */
  hits: number;
  /** The job this bout belongs to (one action the player chose; docs/WORK.md). */
  readonly job: JobState;
  /** Counts every bout started (a new bout = a new number: the mini-game resets on it). */
  readonly serial: number;
}

/** The job a running bout belongs to: which bout it is and how many the job has (null = open-ended, until stopped). */
export interface JobState {
  bout: number;
  bouts: number | null;
  /** The job's label: the label of its first bout ("Dig a garden bed"). */
  readonly label: string;
}

/** What the action bar shows of the job: its label, its bout, the time left for the whole job and how far it is. */
export interface JobView {
  label: string;
  bout: number;
  bouts: number | null;
  /** Simulated seconds left for the whole job (the bout in hand when open-ended). */
  secondsLeft: number;
  /** 0..1 of the whole job (of the bout when open-ended). */
  progress: number;
}

/** The job view of a running bout (pure: the action bar and the tests). */
export function jobViewOf(a: Pick<ActiveAction, 'option' | 'elapsed' | 'progress' | 'job'>): JobView {
  const s = Math.max(0, a.option.seconds);
  const left = Math.max(0, s - a.elapsed);
  const n = a.job.bouts;
  if (n === null) return { label: a.job.label, bout: a.job.bout, bouts: null, secondsLeft: left, progress: Math.max(0, Math.min(1, a.progress)) };
  const more = Math.max(0, n - a.job.bout);
  return {
    label: a.job.label, bout: a.job.bout, bouts: n, secondsLeft: left + more * s,
    progress: Math.max(0, Math.min(1, (a.job.bout - 1 + Math.max(0, Math.min(1, a.progress))) / Math.max(1, n))),
  };
}

/** Bouts a job of `option` has when started fresh: 1 for a one-off, its `bouts` for a counted job, null when open-ended. */
export function jobBouts(option: ActionOption): number | null {
  if (!option.repeat || option.seconds <= 0) return 1;
  if (option.open) return null;
  return option.bouts === undefined ? null : Math.max(1, Math.round(option.bouts));
}

export type ActionEvent =
  | { type: 'started'; actor: PersonId; option: ActionOption }
  /** `jobDone`: the bout was the job's last (the runner stops here). */
  | { type: 'completed'; actor: PersonId; option: ActionOption; outcome: ActionOutcome; perf?: number; jobDone?: boolean }
  | { type: 'cancelled'; actor: PersonId; option: ActionOption; reason: string };

const CHECK_INTERVAL = 1;

/** Provider registry + runner for timed actions. One instance per Simulation (`sim.actions`). */
export class ActionRegistry {
  private readonly providers: ActionProvider[] = [];
  private readonly running = new Map<PersonId, ActiveAction & { sinceCheck: number }>();
  private readonly listeners: Array<(e: ActionEvent) => void> = [];
  private readonly scratch: ActionOption[] = [];
  /** The bout being completed and the hand it was done with (read by providers through `performance`). */
  private finishing: { actor: PersonId; perf: number } | null = null;
  private serials = 0;

  constructor(private readonly ctx: SimContext) {}

  register(p: ActionProvider): () => void {
    if (this.providers.some((x) => x.id === p.id)) throw new Error(`Action provider already registered: ${p.id}`);
    this.providers.push(p);
    return () => {
      const i = this.providers.indexOf(p);
      if (i >= 0) this.providers.splice(i, 1);
    };
  }

  onEvent(fn: (e: ActionEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** All options for `actor` on `target`: enabled first, then by priority (stable). */
  list(actor: PersonId, target: TargetRef): ActionOption[] {
    const out: ActionOption[] = [];
    for (const p of this.providers) {
      const from = out.length;
      try {
        p.list(this.ctx, actor, target, out);
      } catch (err) {
        out.length = from;
        console.error(`action provider ${p.id} failed`, err);
        continue;
      }
      for (let i = from; i < out.length; i++) out[i].provider = p.id;
    }
    // a prisoner does not work, trade, manage or travel until he is ransomed
    if (this.ctx.state.persons.get(actor)?.flags.captive) {
      for (const o of out) {
        if (o.enabled && (o.category === 'work' || o.category === 'trade' || o.category === 'manage' || o.category === 'travel')) { o.enabled = false; o.reason = 'You are a prisoner.'; }
      }
    }
    return out
      .map((o, i) => ({ o, i }))
      .sort((a, b) => Number(b.o.enabled) - Number(a.o.enabled) || b.o.priority - a.o.priority || a.i - b.i)
      .map((x) => x.o);
  }

  /** The interact-key default, or null. */
  defaultFor(actor: PersonId, target: TargetRef): ActionOption | null {
    this.scratch.length = 0;
    const list = this.list(actor, target);
    return list.length > 0 && list[0].enabled ? list[0] : null;
  }

  active(actor: PersonId): ActiveAction | null { return this.running.get(actor) ?? null; }

  /** The job of the bout `actor` is running (the action bar), or null. */
  job(actor: PersonId): JobView | null {
    const a = this.running.get(actor);
    return a ? jobViewOf(a) : null;
  }

  /** Starts `option` (from `list`): a new job. Instant actions complete immediately. Replaces a running action. */
  start(actor: PersonId, option: ActionOption): ActionOutcome {
    return this.begin(actor, option, { bout: 1, bouts: jobBouts(option), label: option.label });
  }

  private begin(actor: PersonId, option: ActionOption, job: JobState): ActionOutcome {
    const p = this.provider(option.provider);
    if (!p) return { ok: false, message: 'That can no longer be done.' };
    if (!option.enabled) return { ok: false, message: option.reason ?? 'You cannot do that now.' };
    const why = p.check?.(this.ctx, actor, option) ?? null;
    if (why) return { ok: false, message: why };
    if (this.running.has(actor)) this.cancel(actor, 'replaced');
    p.start?.(this.ctx, actor, option);
    this.emit({ type: 'started', actor, option });
    if (option.seconds <= 0) return this.finish(actor, option, p, 1, -1, job);
    this.running.set(actor, { actor, option, elapsed: 0, progress: 0, startedDay: this.ctx.absDay, sinceCheck: 0, perf: -1, hits: 0, job, serial: ++this.serials });
    return { ok: true };
  }

  /**
   * A stroke of the bout's mini-game (the forge's hammer on the beat, the seed in the furrow, the steady hand on a
   * wound): `score` 0 (a miss) .. 1 (perfect). Good strokes bring the end of the bout nearer; the mean is the worker's
   * hand, which the providers read when the bout is done (`performance`): more experience, a better piece.
   */
  perform(actor: PersonId, score: number): void {
    const a = this.running.get(actor);
    if (!a) return;
    const s = Math.max(0, Math.min(1, score));
    a.perf = a.hits === 0 ? s : (a.perf * a.hits + s) / (a.hits + 1);
    a.hits++;
    a.elapsed = Math.min(a.option.seconds * 0.98, a.elapsed + a.option.seconds * 0.045 * s);
    a.progress = Math.min(1, a.elapsed / a.option.seconds);
  }

  /** The worker's hand in the bout being finished (or running): 0..1, −1 when no mini-game was played. */
  performance(actor: PersonId): number {
    if (this.finishing && this.finishing.actor === actor) return this.finishing.perf;
    return this.running.get(actor)?.perf ?? -1;
  }

  cancel(actor: PersonId, reason = 'cancelled'): void {
    const a = this.running.get(actor);
    if (!a) return;
    this.running.delete(actor);
    const p = this.provider(a.option.provider);
    if (p) {
      if (p.partial && a.progress > 0) {
        const outcome = this.safeComplete(p, actor, a.option, a.progress);
        this.emit({ type: 'completed', actor, option: a.option, outcome });
      } else {
        p.cancel?.(this.ctx, actor, a.option, a.progress);
      }
    }
    this.emit({ type: 'cancelled', actor, option: a.option, reason });
  }

  /** Advance running actions by `dt` simulated seconds (registered as a perStep system). */
  tick(dt: number): void {
    if (this.running.size === 0) return;
    for (const a of [...this.running.values()]) {
      const p = this.provider(a.option.provider);
      if (!p) { this.running.delete(a.actor); continue; }
      a.elapsed += dt;
      a.sinceCheck += dt;
      a.progress = Math.min(1, a.elapsed / a.option.seconds);
      if (a.sinceCheck >= CHECK_INTERVAL) {
        a.sinceCheck = 0;
        const why = p.check?.(this.ctx, a.actor, a.option) ?? null;
        if (why) { this.cancel(a.actor, why); continue; }
      }
      if (a.progress >= 1) {
        this.running.delete(a.actor);
        this.finish(a.actor, a.option, p, 1, a.perf, a.job);
      }
    }
  }

  private finish(actor: PersonId, option: ActionOption, p: ActionProvider, fraction: number, perf: number, job: JobState): ActionOutcome {
    this.finishing = { actor, perf };
    let outcome: ActionOutcome;
    try { outcome = this.safeComplete(p, actor, option, fraction); } finally { this.finishing = null; }
    if (perf >= 0 && outcome.ok && outcome.message) outcome.message = `${outcome.message} ${perf >= 0.85 ? '(Masterly work.)' : perf >= 0.6 ? '(Good work.)' : perf >= 0.35 ? '' : '(Clumsy work.)'}`.trim();
    // one action is one job (docs/WORK.md): the next bout starts only while the job lasts — its counted bouts, or until
    // stopped when it is open-ended — and is re-listed so it reflects the new state (strip progress, tool wear…)
    let next: ActionOption | undefined;
    if (outcome.ok && option.repeat && option.seconds > 0 && (job.bouts === null || job.bout < job.bouts)) {
      next = this.list(actor, option.target).find((o) => o.id === option.id && o.provider === option.provider);
      if (next && !(next.enabled && next.repeat && next.seconds > 0 && (next.bouts === undefined || next.bouts > 0))) next = undefined;
    }
    const jobDone = !next && option.seconds > 0;
    this.emit(perf >= 0 ? { type: 'completed', actor, option, outcome, perf, jobDone } : { type: 'completed', actor, option, outcome, jobDone });
    if (next) {
      // the job's bouts follow the state: a bout that did more than expected shortens it, never lengthens it
      const bouts = job.bouts === null ? null : Math.min(job.bouts, job.bout + (next.bouts ?? job.bouts - job.bout));
      this.begin(actor, next, { bout: job.bout + 1, bouts, label: job.label });
    }
    return outcome;
  }

  private safeComplete(p: ActionProvider, actor: PersonId, option: ActionOption, fraction: number): ActionOutcome {
    try {
      return p.complete(this.ctx, actor, option, fraction);
    } catch (err) {
      console.error(`action ${option.provider}/${option.id} failed`, err);
      return { ok: false, message: 'Something went wrong.' };
    }
  }

  private provider(id: string): ActionProvider | undefined { return this.providers.find((p) => p.id === id); }

  private emit(e: ActionEvent): void { for (const fn of this.listeners) fn(e); }
}

/** Stable string key for a target (memoising prompts, comparing targets). */
export function targetKey(t: TargetRef): string {
  switch (t.kind) {
    case 'self': return 'self';
    case 'ground': return `ground:${Math.round(t.x)}:${Math.round(t.z)}`;
    default: return `${t.kind}:${t.id}`;
  }
}

export function sameTarget(a: TargetRef | null, b: TargetRef | null): boolean {
  if (!a || !b) return a === b;
  return targetKey(a) === targetKey(b);
}
