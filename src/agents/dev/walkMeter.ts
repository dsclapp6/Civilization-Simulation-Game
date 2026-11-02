// Walk meter (civilization pass, docs/CIV.md §3): measures how the people in sight of the player move, step by step, as a run of the
// simulation goes on. Shared by tools/walk-check.ts (a village day, a report) and tests/agents/walkcheck.test.ts (the acceptance).
//
// A *step* is one sub-step of the simulation (1/20 s of play); a *sample* is a moving person in sight over a window of a quarter of a
// second whose steps were all seen whole and drawn with one animation clip. Their speed is the distance moved over the window. "In
// sight" is inside `seen` metres of the focus (the player), where nothing may be sped up or carried across the street. The acceptance
// of CIV §3: at least 98 % of the walking movement (samples on the walk and carry-walk clips) is at 2.0 m/s or slower, every faster
// movement is drawn with the run clip, and no person in sight moves more than a metre between two steps.
import { SEEN_RADIUS } from '../config';
import { newIntent } from '../schedule';
import type { Simulation } from '../../sim/sim';
import type { Zone } from '../zone';

export type Clip = 'walk' | 'carry_walk' | 'run' | 'other';
export const CLIPS: readonly Clip[] = ['walk', 'carry_walk', 'run', 'other'];
export const clipOf = (anim: string): Clip => (anim === 'walk' ? 'walk' : anim === 'carry_walk' ? 'carry_walk' : anim === 'run' || anim === 'sprint' ? 'run' : 'other');

/** Walking is no faster than this (m/s). */
export const WALK_CAP = 2.0;
const DT = 1 / 20;
/** Samples of the speed are the distance over this many steps. */
const WINDOW = 5;
const MODE_NAMES = ['stay', 'wander', 'errand', 'patrol', 'play', 'shoot', 'furrow'];

class Hist {
  readonly v: number[] = [];
  dist = 0;
  add(speed: number): void { this.v.push(speed); this.dist += speed * DT; }
  get n(): number { return this.v.length; }
  pct(f: number): number { if (!this.v.length) return 0; this.v.sort((a, b) => a - b); return this.v[Math.min(this.v.length - 1, Math.floor(f * this.v.length))]; }
  share(pred: (s: number) => boolean): number { return this.v.length ? this.v.filter(pred).length / this.v.length : 0; }
}

interface Track {
  x: number; z: number; step: number; n: number; late: number; body: object;
  hist: Float32Array; ok: Uint8Array; clips: Uint8Array;
}

export interface ClipStats { samples: number; seconds: number; metres: number; p50: number; p90: number; p98: number; max: number; over2: number; over24: number }

export interface WalkResult {
  steps: number; people: number; spawned: number;
  clips: Record<Clip, ClipStats>;
  instantMax: Record<Clip, number>;
  /** Share of the walk-clip movement at WALK_CAP or slower (by time and by distance); need ≥ 0.98. */
  walkShareUnder2: number; walkShareUnder2ByDistance: number;
  /** Samples faster than WALK_CAP that were not drawn with the run clip; need 0. */
  fastOffRun: number;
  walkMax: number; runMin: number; runMax: number;
  /** Steps of more than a metre in sight; need 0. */
  jumps: number; jumpList: string[]; maxStep: number; bigSteps: number; bigList: string[];
  runnersByMode: Record<string, number>; runShareOfMoving: number; runners: string[];
  lateList: string[]; arrivals: number; lateOver8s: number; lateP50: number; lateP90: number; lateMax: number;
  popsIn: number; popsOut: number; popsRespawn: number; respawnList: string[];
  zoneMs: number;
  /** By hour of the day: the average number of people in sight walking / at work (a work clip) / otherwise standing about. */
  rhythm: Array<{ walking: number; working: number; other: number }>;
}

export class WalkMeter {
  private readonly hist: Record<Clip, Hist> = { walk: new Hist(), carry_walk: new Hist(), run: new Hist(), other: new Hist() };
  private readonly instantMax: Record<Clip, number> = { walk: 0, carry_walk: 0, run: 0, other: 0 };
  private readonly tracks = new Map<number, Track>();
  private readonly seenNow = new Set<number>();
  private readonly people = new Set<number>();
  private readonly I = newIntent();
  private readonly lates: number[] = [];
  private readonly lateList: Array<{ late: number; text: string }> = [];
  private readonly jumpList: string[] = [];
  private readonly bigList: string[] = [];
  private readonly respawnList: string[] = [];
  private readonly runnersByMode: Record<string, number> = {};
  private readonly runnerList = new Map<string, number>();
  private readonly rhythm = Array.from({ length: 24 }, () => ({ walking: 0, working: 0, other: 0, steps: 0 }));
  private jumps = 0; private bigSteps = 0; private maxStep = 0; private fastOffRun = 0; private walkMax = 0; private runMin = 99; private runMax = 0;
  private spawned = 0; private popsIn = 0; private popsOut = 0; private popsRespawn = 0;
  private movingSamples = 0; private runSamples = 0;
  private stepNo = 0;
  zoneMs = 0;

  constructor(
    private readonly sim: Simulation,
    private readonly zone: Zone,
    private readonly focus: { x: number; z: number },
    private readonly seen: number = SEEN_RADIUS,
  ) {}

  /** Runs one sub-step of the simulation and measures it. */
  step(): void {
    const w0 = performance.now();
    this.sim.step(DT);
    this.zoneMs += performance.now() - w0;
    this.measure(this.stepNo++);
  }

  /** Looks at the zone after a step of the simulation that the caller ran itself. */
  measure(i: number): void {
    const { zone, focus, seen: SEEN, tracks, seenNow, hist } = this;
    seenNow.clear();
    {
      const hour = Math.min(23, Math.floor((this.sim.absDay % 1) * 24));
      const r = this.rhythm[hour];
      r.steps++;
      for (const a of zone.agentsArr) {
        if (a.dead || Math.hypot(a.x - focus.x, a.z - focus.z) > SEEN) continue;
        if (a.st === 1 || a.draw.moveSpeed > 0.3) r.walking++;
        else if (a.draw.anim.startsWith('work_')) r.working++;
        else r.other++;
      }
    }
    for (const a of zone.agentsArr) {
      if (a.dead) continue;
      seenNow.add(a.personId);
      this.people.add(a.personId);
      const d = Math.hypot(a.x - focus.x, a.z - focus.z);
      let t = tracks.get(a.personId);
      if (!t) {
        t = { x: a.x, z: a.z, step: i, hist: new Float32Array((WINDOW + 1) * 2), ok: new Uint8Array(WINDOW + 1), clips: new Uint8Array(WINDOW + 1), n: 0, late: 0, body: a };
        tracks.set(a.personId, t);
        this.spawned++;
        if (d < SEEN - 40 && i > 5) this.popsIn++;
        t.hist[0] = a.x; t.hist[1] = a.z; t.ok[0] = 0; t.n = 1;
        continue;
      }
      if (t.body !== a) {
        // the person was taken out of the zone and put back (a new body): not a move, but a pop if it happened in sight
        if (Math.hypot(t.x - focus.x, t.z - focus.z) < SEEN - 40 && Math.hypot(a.x - t.x, a.z - t.z) > 1) {
          this.popsRespawn++;
          if (this.respawnList.length < 8) this.respawnList.push(`${a.person.first} (${a.activity}) put back ${Math.hypot(a.x - t.x, a.z - t.z).toFixed(1)} m from where the body was, ${d.toFixed(0)} m from the player`);
        }
        t.body = a; t.x = a.x; t.z = a.z; t.n = 0; t.step = i;
        continue;
      }
      const dx = a.x - t.x, dz = a.z - t.z;
      const stepLen = Math.hypot(dx, dz);
      const dPrev = Math.hypot(t.x - focus.x, t.z - focus.z);
      const inSight = d <= SEEN && dPrev <= SEEN;
      if (inSight) {
        if (stepLen > this.maxStep) this.maxStep = stepLen;
        if (stepLen > 0.4) {
          this.bigSteps++;
          if (this.bigList.length < 12) this.bigList.push(`${a.person.first} (${a.activity}/${a.draw.anim}, mode ${MODE_NAMES[a.mode]}, state ${a.st}) ${stepLen.toFixed(2)} m = ${(stepLen / DT).toFixed(1)} m/s at step ${i}, ${d.toFixed(0)} m from the player`);
        }
        if (stepLen > 1) {
          this.jumps++;
          if (this.jumpList.length < 12) this.jumpList.push(`${a.person.first} (${a.activity}/${a.draw.anim}, mode ${MODE_NAMES[a.mode]}) ${stepLen.toFixed(1)} m at step ${i}, ${d.toFixed(0)} m from the player`);
        }
      }
      // the last WINDOW steps, as a ring
      const k = t.n % (WINDOW + 1);
      const clip = clipOf(a.draw.anim);
      t.hist[k * 2] = a.x; t.hist[k * 2 + 1] = a.z; t.ok[k] = inSight && stepLen <= 1 ? 1 : 0; t.clips[k] = CLIPS.indexOf(clip); t.n++;
      // a window counts when every step of it was seen, whole and drawn with the same clip (a change of gait in the middle is no walk or run)
      let clean = t.n > WINDOW;
      for (let q = 0; clean && q <= WINDOW; q++) if (!t.ok[q] || t.clips[q] !== t.clips[k]) clean = false;
      if (clean && inSight) {
        const o = (t.n - 1 - WINDOW) % (WINDOW + 1);
        const wx = a.x - t.hist[o * 2], wz = a.z - t.hist[o * 2 + 1];
        const v = Math.hypot(wx, wz) / (WINDOW * DT);
        const vi = stepLen / DT;
        if (vi > this.instantMax[clip]) this.instantMax[clip] = vi;
        if (v >= 0.25) {
          hist[clip].add(v);
          this.movingSamples++;
          if (clip === 'run') {
            this.runSamples++;
            const m = MODE_NAMES[a.mode];
            this.runnersByMode[m] = (this.runnersByMode[m] ?? 0) + 1;
            if (a.mode !== 4) { const key = `${a.person.first} (${a.person.career}, ${a.age.toFixed(0)} y, ${a.intentLabel})`; this.runnerList.set(key, (this.runnerList.get(key) ?? 0) + 1); }
            if (v < this.runMin) this.runMin = v;
            if (v > this.runMax) this.runMax = v;
          }
          if (clip === 'walk' || clip === 'carry_walk') { if (v > this.walkMax) this.walkMax = v; if (v > WALK_CAP) this.fastOffRun++; }
          else if (clip === 'other' && v > WALK_CAP) this.fastOffRun++;
        }
      }
      t.x = a.x; t.z = a.z; t.step = i;
    }
    // people who vanished from the zone while in sight
    if (i % 20 === 0) {
      for (const [id, t] of tracks) {
        if (seenNow.has(id)) continue;
        if (Math.hypot(t.x - focus.x, t.z - focus.z) < SEEN - 40 && i - t.step < 2) this.popsOut++;
        if (i - t.step > 4) tracks.delete(id);
      }
    }
    // how well people keep the schedule: how far from their place they are when the schedule says they have arrived
    if (i % 10 === 0) {
      const I = this.I;
      for (const a of zone.agentsArr) {
        if (a.dead || a.control !== 'ai') continue;
        const t = tracks.get(a.personId);
        if (!t) continue;
        zone.sched.intent(a.person, this.sim.absDay, I);
        const travelling = I.travel < 1;
        if (t.late === 1 && !travelling && !I.away && !I.indoors && a.mode !== 2 && a.mode !== 3 && a.mode !== 1) {
          const rem = Math.hypot(a.x - I.x, a.z - I.z);
          if (Math.hypot(a.x - focus.x, a.z - focus.z) < SEEN) {
            const late = rem / Math.max(0.6, a.baseSpeed);
            this.lates.push(late);
            if (late > 20) this.lateList.push({ late, text: `${a.person.first} ${a.person.byname} (${a.person.career}, ${I.label}) ${rem.toFixed(0)} m short of ${I.activity}; walk st ${a.st}, jog ${a.jog}/${a.canRun}, base ${a.baseSpeed.toFixed(2)}, ${a.age.toFixed(0)} y` });
          }
        }
        t.late = travelling ? 1 : 0;
      }
    }
  }

  result(steps = this.stepNo): WalkResult {
    const hist = this.hist;
    const clips = {} as Record<Clip, ClipStats>;
    for (const c of CLIPS) {
      const h = hist[c];
      clips[c] = {
        samples: h.n, seconds: h.n * DT, metres: h.dist, p50: h.pct(0.5), p90: h.pct(0.9), p98: h.pct(0.98), max: h.pct(1),
        over2: h.share((s) => s > WALK_CAP), over24: h.share((s) => s > 2.4),
      };
    }
    const walkN = hist.walk.n + hist.carry_walk.n;
    const ok = (h: Hist): number => h.v.filter((s) => s <= WALK_CAP).length;
    const okDist = (h: Hist): number => h.v.filter((s) => s <= WALK_CAP).reduce((sum, v) => sum + v * DT, 0);
    const walkDist = hist.walk.dist + hist.carry_walk.dist;
    const lates = this.lates.slice().sort((a, b) => a - b);
    return {
      steps, people: this.people.size, spawned: this.spawned,
      clips, instantMax: this.instantMax,
      walkShareUnder2: walkN ? (ok(hist.walk) + ok(hist.carry_walk)) / walkN : 1,
      walkShareUnder2ByDistance: walkDist ? (okDist(hist.walk) + okDist(hist.carry_walk)) / walkDist : 1,
      fastOffRun: this.fastOffRun, walkMax: this.walkMax, runMin: this.runMin === 99 ? 0 : this.runMin, runMax: this.runMax,
      jumps: this.jumps, jumpList: this.jumpList, maxStep: this.maxStep, bigSteps: this.bigSteps, bigList: this.bigList,
      runnersByMode: this.runnersByMode, runShareOfMoving: this.movingSamples ? this.runSamples / this.movingSamples : 0,
      runners: [...this.runnerList.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => `${(n * DT).toFixed(0)} s: ${k}`),
      lateList: this.lateList.sort((x, y) => y.late - x.late).slice(0, 8).map((x) => `${x.late.toFixed(0)} s: ${x.text}`),
      arrivals: lates.length, lateOver8s: lates.filter((s) => s > 8).length,
      lateP50: lates[Math.floor(lates.length * 0.5)] ?? 0, lateP90: lates[Math.floor(lates.length * 0.9)] ?? 0, lateMax: lates[lates.length - 1] ?? 0,
      popsIn: this.popsIn, popsOut: this.popsOut, popsRespawn: this.popsRespawn, respawnList: this.respawnList,
      zoneMs: steps ? this.zoneMs / steps : 0,
      rhythm: this.rhythm.map((r) => ({ walking: r.steps ? r.walking / r.steps : 0, working: r.steps ? r.working / r.steps : 0, other: r.steps ? r.other / r.steps : 0 })),
    };
  }
}

/** Does a result meet the acceptance of CIV §3? */
export function walkAcceptance(r: Pick<WalkResult, 'walkShareUnder2' | 'fastOffRun' | 'jumps'>): { ok: boolean; walkShare: boolean; runClip: boolean; noJumps: boolean } {
  const walkShare = r.walkShareUnder2 >= 0.98, runClip = r.fastOffRun === 0, noJumps = r.jumps === 0;
  return { ok: walkShare && runClip && noJumps, walkShare, runClip, noJumps };
}
