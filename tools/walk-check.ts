// Walk check (civilization pass, docs/CIV.md §3): runs a day of a settlement in the detail zone at 1x and measures how the
// people move that the player can see — the ground speeds they really have, by the animation clip they are drawn with.
//
//   npx tsx tools/walk-check.ts [--scene village|fields|holy|town|castle|all] [--seed millennia] [--season 1] [--from 0.1] [--to 0.97]
//                               [--seen 190] [--mock] [--json file] [--strict] [--quiet]
//
// A step is one sub-step of the simulation (1/20 s of play); a *sample* is a moving person in sight at one step. Their speed is the
// distance moved over the last quarter second (the instantaneous per-step figure is reported too). "In sight" is inside SEEN_RADIUS
// of the focus (the player), where nothing may be sped up or carried across the street. Acceptance (CIV §3), per scene and in total:
//   - at least 98 % of the walking movement (samples on the walk and carry-walk clips) is at 2.0 m/s or slower
//   - every faster movement is drawn with the run clip (no walk clip above 2.0 m/s)
//   - no jump above 1 m between two steps of a person in sight
// It also tells how well people keep the schedule (how far from their place they are when the schedule says they have arrived), and
// how much of the movement is running (and who runs). `--strict` exits with 1 when the acceptance is not met.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { installAgents } from '../src/agents';
import { SEEN_RADIUS } from '../src/agents/config';
import { newIntent } from '../src/agents/schedule';
import type { Zone } from '../src/agents/zone';
import { toDate, DAY_SECONDS } from '../src/core/time';
import { installEconomy } from '../src/sim/economy';
import { newProfile } from '../src/sim/legacy';
import { Simulation } from '../src/sim/sim';
import { installSocial } from '../src/sim/social';
import { createMockWorld } from '../src/sim/testing/mockWorld';
import { generateWorld } from '../src/world/generate';
import type { Settlement, WorldModel } from '../src/world/types';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const SEED = arg('seed', 'millennia');
const SCENE = arg('scene', 'all');
const SEASON = Number(arg('season', '1'));
const FROM = Number(arg('from', '0.1'));
const TO = Number(arg('to', '0.97'));
const SEEN = Number(arg('seen', String(SEEN_RADIUS)));
const QUIET = flag('quiet');
const STRICT = flag('strict');
const JSON_OUT = arg('json', '');
const WALK_CAP = 2.0;
/** Samples of the speed are the distance over this many steps. */
const WINDOW = 5;
const DT = 1 / 20;

// ---------------------------------------------------------------------------------------------------------------
// the world, the simulation and the zone
// ---------------------------------------------------------------------------------------------------------------

const t0 = performance.now();
const world: WorldModel = flag('mock') ? createMockWorld({ seed: SEED, preset: 'small' }) : generateWorld(SEED);
const sim = Simulation.newGame({ seed: SEED, difficulty: 'knight', generateWorld: () => world, profile: newProfile() });
const social = installSocial(sim);
const economy = installEconomy(sim, { social });
const zone: Zone = installAgents(sim, { economy, social });
const focus = { x: 0, z: 0 };
sim.view.setSource('focus', () => focus);
sim.view.setSource('mode', () => 'street');
zone.sched.forceWeather({ rain: 0, snow: 0, temperature: 14 });
if (!QUIET) console.log(`world and simulation ready in ${((performance.now() - t0) / 1000).toFixed(1)} s (${world.settlements.length} settlements)`);

function pickVillage(): Settlement {
  const s = world.settlements.find((x) => {
    if (x.kind !== 'village' || x.strips.length === 0 || x.market) return false;
    const sp = zone.places.of(x.id);
    return !!sp && !!sp.church && sp.alehouses.length > 0;
  });
  if (!s) throw new Error('no suitable village');
  return s;
}
function pickTown(): Settlement {
  return world.settlements.find((s) => s.kind === 'town' && !!zone.places.of(s.id)?.hasMarketBuildings && (zone.places.of(s.id)?.stalls.length ?? 0) >= 4)
    ?? world.settlements.find((s) => s.kind === 'town') ?? world.settlements[0];
}
function pickCastle(): Settlement {
  return world.settlements.find((s) => s.kind === 'castle' && !!zone.places.of(s.id)?.first('archery_butts')) ?? world.settlements.find((s) => s.kind === 'castle') ?? world.settlements[0];
}
/** The point where the village's field work is: the middle of its strips, so people are seen walking out to and back from them. */
function fieldsCentre(s: Settlement): { x: number; z: number } {
  let x = 0, z = 0, n = 0;
  for (const id of s.strips) { const p = world.strips[id]?.poly; if (p) { x += (p[0].x + p[2].x) / 2; z += (p[0].z + p[2].z) / 2; n++; } }
  return n ? { x: x / n, z: z / n } : { x: s.x, z: s.z };
}

interface Scene { id: string; title: string; settlement: Settlement; at: { x: number; z: number }; day: number; dow: number }
function scenes(): Scene[] {
  const v = pickVillage();
  const all: Scene[] = [
    { id: 'village', title: 'a village working day, the player at the green', settlement: v, at: { x: v.x, z: v.z }, day: SEASON * 4 + 1, dow: 2 },
    { id: 'fields', title: 'the same day, the player out among the strips', settlement: v, at: fieldsCentre(v), day: SEASON * 4 + 1, dow: 2 },
    { id: 'holy', title: 'the village on the holy day (Mass, the butts, the alehouse)', settlement: v, at: { x: v.x, z: v.z }, day: SEASON * 4 + 3, dow: 4 },
    (() => { const t = pickTown(); return { id: 'town', title: `a market town (${t.name}) on market day`, settlement: t, at: { x: t.x, z: t.z }, day: SEASON * 4 + (t.id % 3), dow: 1 + (t.id % 3) }; })(),
    (() => { const c = pickCastle(); return { id: 'castle', title: `a castle (${c.name}): garrison, drill and the walls`, settlement: c, at: { x: c.x, z: c.z }, day: SEASON * 4 + 1, dow: 2 }; })(),
  ];
  return SCENE === 'all' ? all : all.filter((s) => s.id === SCENE);
}

// ---------------------------------------------------------------------------------------------------------------
// the measurement
// ---------------------------------------------------------------------------------------------------------------

type Clip = 'walk' | 'carry_walk' | 'run' | 'other';
const clipOf = (anim: string): Clip => (anim === 'walk' ? 'walk' : anim === 'carry_walk' ? 'carry_walk' : anim === 'run' || anim === 'sprint' ? 'run' : 'other');

class Hist {
  readonly v: number[] = [];
  dist = 0;
  add(speed: number, step: number): void { this.v.push(speed); this.dist += speed * step; }
  get n(): number { return this.v.length; }
  pct(f: number): number { if (!this.v.length) return 0; this.v.sort((a, b) => a - b); return this.v[Math.min(this.v.length - 1, Math.floor(f * this.v.length))]; }
  share(pred: (s: number) => boolean): number { return this.v.length ? this.v.filter(pred).length / this.v.length : 0; }
}

interface Track { x: number; z: number; step: number; hist: Float32Array; ok: Uint8Array; n: number; late: number }

interface Result {
  id: string; title: string; settlement: string; steps: number; people: number; spawned: number;
  clips: Record<Clip, { samples: number; seconds: number; metres: number; p50: number; p90: number; p98: number; max: number; over2: number; over24: number }>;
  instantMax: Record<Clip, number>;
  walkShareUnder2: number; walkShareUnder2ByDistance: number;
  fastOffRun: number; walkMax: number; runMin: number; runMax: number;
  jumps: number; jumpList: string[]; maxStep: number; bigSteps: number; bigList: string[];
  runnersByMode: Record<string, number>; runShareOfMoving: number;
  arrivals: number; lateOver8s: number; lateP50: number; lateP90: number; lateMax: number;
  popsIn: number; popsOut: number;
  zoneMs: number;
}

function runScene(sc: Scene): Result {
  focus.x = sc.at.x; focus.z = sc.at.z;
  const abs = sc.day + FROM;
  sim.state.clock.absDay = abs;
  sim.state.clock.firedHour = Math.floor(abs * 24);
  sim.state.clock.paused = false;
  zone.needResync = true;
  zone.resync();
  const steps = Math.round(((TO - FROM) * DAY_SECONDS) / DT);

  const hist: Record<Clip, Hist> = { walk: new Hist(), carry_walk: new Hist(), run: new Hist(), other: new Hist() };
  const instantMax: Record<Clip, number> = { walk: 0, carry_walk: 0, run: 0, other: 0 };
  const tracks = new Map<number, Track>();
  const seenNow = new Set<number>();
  let jumps = 0, bigSteps = 0, maxStep = 0, fastOffRun = 0, walkMax = 0, runMin = 99, runMax = 0, spawned = 0, popsIn = 0, popsOut = 0;
  const jumpList: string[] = [];
  const bigList: string[] = [];
  const runnersByMode: Record<string, number> = {};
  let movingSamples = 0, runSamples = 0;
  const people = new Set<number>();
  const I = newIntent();
  const lates: number[] = [];
  let zoneMs = 0;
  const modeName = ['stay', 'wander', 'errand', 'patrol', 'play', 'shoot', 'furrow'];

  for (let i = 0; i < steps; i++) {
    const w0 = performance.now();
    sim.step(DT);
    zoneMs += performance.now() - w0;
    seenNow.clear();
    for (const a of zone.agentsArr) {
      if (a.dead) continue;
      seenNow.add(a.personId);
      people.add(a.personId);
      const d = Math.hypot(a.x - focus.x, a.z - focus.z);
      let t = tracks.get(a.personId);
      if (!t) {
        t = { x: a.x, z: a.z, step: i, hist: new Float32Array((WINDOW + 1) * 2), ok: new Uint8Array(WINDOW + 1), n: 0, late: 0 };
        tracks.set(a.personId, t);
        spawned++;
        if (d < SEEN - 40 && i > 5) popsIn++;
        t.hist[0] = a.x; t.hist[1] = a.z; t.ok[0] = 0; t.n = 1;
        continue;
      }
      const dx = a.x - t.x, dz = a.z - t.z;
      const stepLen = Math.hypot(dx, dz);
      const dPrev = Math.hypot(t.x - focus.x, t.z - focus.z);
      const inSight = d <= SEEN && dPrev <= SEEN;
      if (inSight) {
        if (stepLen > maxStep) maxStep = stepLen;
        if (stepLen > 0.4) {
          bigSteps++;
          if (bigList.length < 12) bigList.push(`${a.person.first} (${a.activity}/${a.draw.anim}, mode ${modeName[a.mode]}, state ${a.st}) ${stepLen.toFixed(2)} m = ${(stepLen / DT).toFixed(1)} m/s at step ${i}, ${d.toFixed(0)} m from the player`);
        }
        if (stepLen > 1) {
          jumps++;
          if (jumpList.length < 12) jumpList.push(`${a.person.first} (${a.activity}/${a.draw.anim}, mode ${modeName[a.mode]}) ${stepLen.toFixed(1)} m at step ${i}, ${d.toFixed(0)} m from the player`);
        }
      }
      // the last WINDOW steps, as a ring
      const k = t.n % (WINDOW + 1);
      t.hist[k * 2] = a.x; t.hist[k * 2 + 1] = a.z; t.ok[k] = inSight && stepLen <= 1 ? 1 : 0; t.n++;
      let clean = t.n > WINDOW;
      for (let q = 0; clean && q <= WINDOW; q++) if (!t.ok[q]) clean = false;
      if (clean && inSight) {
        const o = (t.n - 1 - WINDOW) % (WINDOW + 1);
        const wx = a.x - t.hist[o * 2], wz = a.z - t.hist[o * 2 + 1];
        const v = Math.hypot(wx, wz) / (WINDOW * DT);
        const vi = stepLen / DT;
        const clip = clipOf(a.draw.anim);
        if (vi > instantMax[clip]) instantMax[clip] = vi;
        if (v >= 0.25) {
          hist[clip].add(v, DT);
          movingSamples++;
          if (clip === 'run') { runSamples++; const m = modeName[a.mode]; runnersByMode[m] = (runnersByMode[m] ?? 0) + 1; if (v < runMin) runMin = v; if (v > runMax) runMax = v; }
          if ((clip === 'walk' || clip === 'carry_walk')) { if (v > walkMax) walkMax = v; if (v > WALK_CAP) fastOffRun++; }
          else if (clip === 'other' && v > WALK_CAP) fastOffRun++;
        }
      }
      t.x = a.x; t.z = a.z; t.step = i;
    }
    // people who vanished from the zone while in sight
    if (i % 20 === 0) {
      for (const [id, t] of tracks) {
        if (seenNow.has(id)) continue;
        if (Math.hypot(t.x - focus.x, t.z - focus.z) < SEEN - 40 && i - t.step < 2) popsOut++;
        if (i - t.step > 4) tracks.delete(id);
      }
    }
    // how well people keep the schedule: how far from the place they should be at when the schedule says they have arrived
    if (i % 10 === 0) {
      for (const a of zone.agentsArr) {
        if (a.dead || a.control !== 'ai') continue;
        const t = tracks.get(a.personId);
        if (!t) continue;
        zone.sched.intent(a.person, sim.absDay, I);
        const travelling = I.travel < 1;
        if (t.late === 1 && !travelling && !I.away && !I.indoors) {
          const rem = Math.hypot(a.x - I.x, a.z - I.z);
          if (Math.hypot(a.x - focus.x, a.z - focus.z) < SEEN) lates.push(rem / Math.max(0.6, a.baseSpeed));
        }
        t.late = travelling ? 1 : 0;
      }
    }
  }
  const clips = {} as Result['clips'];
  for (const c of ['walk', 'carry_walk', 'run', 'other'] as Clip[]) {
    const h = hist[c];
    clips[c] = {
      samples: h.n, seconds: h.n * DT, metres: h.dist, p50: h.pct(0.5), p90: h.pct(0.9), p98: h.pct(0.98), max: h.pct(1),
      over2: h.share((s) => s > WALK_CAP), over24: h.share((s) => s > 2.4),
    };
  }
  const walkN = hist.walk.n + hist.carry_walk.n;
  const walkOk = hist.walk.v.filter((s) => s <= WALK_CAP).length + hist.carry_walk.v.filter((s) => s <= WALK_CAP).length;
  const walkDist = hist.walk.dist + hist.carry_walk.dist;
  const walkDistOk = hist.walk.v.filter((s) => s <= WALK_CAP).reduce((s, v) => s + v * DT, 0) + hist.carry_walk.v.filter((s) => s <= WALK_CAP).reduce((s, v) => s + v * DT, 0);
  lates.sort((a, b) => a - b);
  return {
    id: sc.id, title: sc.title, settlement: sc.settlement.name, steps, people: people.size, spawned,
    clips, instantMax,
    walkShareUnder2: walkN ? walkOk / walkN : 1, walkShareUnder2ByDistance: walkDist ? walkDistOk / walkDist : 1,
    fastOffRun, walkMax, runMin: runMin === 99 ? 0 : runMin, runMax,
    jumps, jumpList, maxStep, bigSteps, bigList,
    runnersByMode, runShareOfMoving: movingSamples ? runSamples / movingSamples : 0,
    arrivals: lates.length, lateOver8s: lates.filter((s) => s > 8).length,
    lateP50: lates[Math.floor(lates.length * 0.5)] ?? 0, lateP90: lates[Math.floor(lates.length * 0.9)] ?? 0, lateMax: lates[lates.length - 1] ?? 0,
    popsIn, popsOut, zoneMs: zoneMs / steps,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------------------

const f1 = (n: number): string => n.toFixed(2);
const pc = (n: number): string => `${(n * 100).toFixed(1)}%`;

function report(r: Result): void {
  console.log(`\n== ${r.id}: ${r.title}`);
  const d = toDate(sim.absDay);
  console.log(`   ${r.settlement}, ${r.steps} steps (${(r.steps * DT).toFixed(0)} s of play), ends ${(d.dayFraction * 24).toFixed(1)} h; ${r.people} different people were agents, ${r.spawned} appearances; ${r.zoneMs.toFixed(2)} ms per simulation step`);
  console.log('   clip          seconds   metres    p50    p90    p98    max   >2.0   >2.4   (speeds in m/s, people in sight and moving)');
  for (const c of ['walk', 'carry_walk', 'run', 'other'] as Clip[]) {
    const x = r.clips[c];
    if (x.samples === 0) { console.log(`   ${c.padEnd(12)} ${'-'.padStart(8)}`); continue; }
    console.log(`   ${c.padEnd(12)} ${x.seconds.toFixed(0).padStart(8)} ${x.metres.toFixed(0).padStart(8)} ${f1(x.p50).padStart(6)} ${f1(x.p90).padStart(6)} ${f1(x.p98).padStart(6)} ${f1(x.max).padStart(6)} ${pc(x.over2).padStart(6)} ${pc(x.over24).padStart(6)}`);
  }
  console.log(`   per-step (instantaneous) maxima: walk ${f1(r.instantMax.walk)}, carry ${f1(r.instantMax.carry_walk)}, run ${f1(r.instantMax.run)}, other clips ${f1(r.instantMax.other)}`);
  console.log(`   running: ${pc(r.runShareOfMoving)} of the movement${r.runMin ? ` (speeds ${f1(r.runMin)}–${f1(r.runMax)})` : ''}; by mode ${JSON.stringify(r.runnersByMode)}`);
  console.log(`   keeping the schedule: ${r.arrivals} arrivals in sight; ${r.lateOver8s} more than 8 s from their place when the schedule said arrived; seconds late p50 ${r.lateP50.toFixed(1)} p90 ${r.lateP90.toFixed(1)} max ${r.lateMax.toFixed(0)}`);
  console.log(`   pop-ins/outs in sight (info): ${r.popsIn} appeared, ${r.popsOut} vanished`);
  console.log(`   ACCEPT walking ≤ 2.0 m/s: ${pc(r.walkShareUnder2)} of walk-clip movement by time (${pc(r.walkShareUnder2ByDistance)} by distance), need ≥ 98%  ${r.walkShareUnder2 >= 0.98 ? 'ok' : 'FAIL'}`);
  console.log(`   ACCEPT fast movement off the run clip: ${r.fastOffRun} samples (max walk-clip speed ${f1(r.walkMax)}), need 0  ${r.fastOffRun === 0 ? 'ok' : 'FAIL'}`);
  console.log(`   ACCEPT jumps > 1 m in sight: ${r.jumps} (largest step ${r.maxStep.toFixed(2)} m), need 0  ${r.jumps === 0 ? 'ok' : 'FAIL'}`);
  for (const j of r.jumpList) console.log(`      jump: ${j}`);
  console.log(`   (info) steps above 0.4 m (8 m/s) in sight: ${r.bigSteps}`);
  for (const j of r.bigList) console.log(`      step: ${j}`);
}

const results: Result[] = [];
for (const sc of scenes()) {
  const w = performance.now();
  const r = runScene(sc);
  results.push(r);
  if (!QUIET) report(r);
  if (!QUIET) console.log(`   (${((performance.now() - w) / 1000).toFixed(1)} s)`);
}

// ---- totals ----
const tot = { walk: 0, ok: 0, fast: 0, jumps: 0 };
for (const r of results) {
  const n = r.clips.walk.samples + r.clips.carry_walk.samples;
  tot.walk += n; tot.ok += n * r.walkShareUnder2; tot.fast += r.fastOffRun; tot.jumps += r.jumps;
}
const share = tot.walk ? tot.ok / tot.walk : 1;
const pass = share >= 0.98 && tot.fast === 0 && tot.jumps === 0;
console.log(`\nTOTAL over ${results.length} scene(s): walk-clip movement ≤ 2.0 m/s ${pc(share)} (need ≥ 98%) · fast movement off the run clip ${tot.fast} (need 0) · jumps > 1 m in sight ${tot.jumps} (need 0)  =>  ${pass ? 'PASS' : 'FAIL'}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ seed: SEED, from: FROM, to: TO, seen: SEEN, results, share, pass }, null, 2));
if (STRICT && !pass) process.exit(1);
