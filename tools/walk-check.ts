// Walk check (civilization pass, docs/CIV.md §3): runs a day of a settlement in the detail zone at 1x and measures how the
// people move that the player can see — the ground speeds they really have, by the animation clip they are drawn with.
//
//   npx tsx tools/walk-check.ts [--scene village|fields|holy|town|castle|all] [--seed millennia] [--season 1] [--from 0.1] [--to 0.97]
//                               [--seen 190] [--mock] [--json file] [--strict] [--quiet]
//
// The measuring is src/agents/dev/walkMeter.ts (also used by tests/agents/walkcheck.test.ts). A step is one sub-step of the simulation
// (1/20 s of play); a *sample* is a moving person in sight over a quarter of a second, drawn with one clip all along. "In sight" is
// inside SEEN_RADIUS of the focus (the player), where nothing may be sped up or carried across the street. Acceptance (CIV §3), per
// scene and in total:
//   - at least 98 % of the walking movement (samples on the walk and carry-walk clips) is at 2.0 m/s or slower
//   - every faster movement is drawn with the run clip (no walk clip above 2.0 m/s)
//   - no jump above 1 m between two steps of a person in sight
// It also tells how well people keep the schedule (how far from their place they are when the schedule says they have arrived), who
// runs, and the rhythm of the day (people in sight walking / working / standing about by hour). `--strict` exits with 1 when the
// acceptance is not met.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { installAgents } from '../src/agents';
import { SEEN_RADIUS } from '../src/agents/config';
import { CLIPS, WALK_CAP, WalkMeter, walkAcceptance, type WalkResult } from '../src/agents/dev/walkMeter';
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

interface Scene { id: string; title: string; settlement: Settlement; at: { x: number; z: number }; day: number }
function scenes(): Scene[] {
  const v = pickVillage();
  const all: Scene[] = [
    { id: 'village', title: 'a village working day, the player at the green', settlement: v, at: { x: v.x, z: v.z }, day: SEASON * 4 + 1 },
    { id: 'fields', title: 'the same day, the player out among the strips', settlement: v, at: fieldsCentre(v), day: SEASON * 4 + 1 },
    { id: 'holy', title: 'the village on the holy day (Mass, the butts, the alehouse)', settlement: v, at: { x: v.x, z: v.z }, day: SEASON * 4 + 3 },
    (() => { const t = pickTown(); return { id: 'town', title: `a market town (${t.name}) on market day`, settlement: t, at: { x: t.x, z: t.z }, day: SEASON * 4 + (t.id % 3) }; })(),
    (() => { const c = pickCastle(); return { id: 'castle', title: `a castle (${c.name}): garrison, drill and the walls`, settlement: c, at: { x: c.x, z: c.z }, day: SEASON * 4 + 1 }; })(),
  ];
  return SCENE === 'all' ? all : all.filter((s) => s.id === SCENE);
}

interface SceneResult extends WalkResult { id: string; title: string; settlement: string }

function runScene(sc: Scene): SceneResult {
  focus.x = sc.at.x; focus.z = sc.at.z;
  const abs = sc.day + FROM;
  sim.state.clock.absDay = abs;
  sim.state.clock.firedHour = Math.floor(abs * 24);
  sim.state.clock.paused = false;
  zone.needResync = true;
  zone.resync();
  const steps = Math.round(((TO - FROM) * DAY_SECONDS) / DT);
  const meter = new WalkMeter(sim, zone, focus, SEEN);
  for (let i = 0; i < steps; i++) meter.step();
  return { id: sc.id, title: sc.title, settlement: sc.settlement.name, ...meter.result(steps) };
}

// ---------------------------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------------------------

const f1 = (n: number): string => n.toFixed(2);
const pc = (n: number): string => `${(n * 100).toFixed(1)}%`;

function report(r: SceneResult): void {
  console.log(`\n== ${r.id}: ${r.title}`);
  const d = toDate(sim.absDay);
  console.log(`   ${r.settlement}, ${r.steps} steps (${(r.steps * DT).toFixed(0)} s of play), ends ${(d.dayFraction * 24).toFixed(1)} h; ${r.people} different people were agents, ${r.spawned} appearances; ${r.zoneMs.toFixed(2)} ms per simulation step`);
  console.log('   clip          seconds   metres    p50    p90    p98    max   >2.0   >2.4   (speeds in m/s, people in sight and moving)');
  for (const c of CLIPS) {
    const x = r.clips[c];
    if (x.samples === 0) { console.log(`   ${c.padEnd(12)} ${'-'.padStart(8)}`); continue; }
    console.log(`   ${c.padEnd(12)} ${x.seconds.toFixed(0).padStart(8)} ${x.metres.toFixed(0).padStart(8)} ${f1(x.p50).padStart(6)} ${f1(x.p90).padStart(6)} ${f1(x.p98).padStart(6)} ${f1(x.max).padStart(6)} ${pc(x.over2).padStart(6)} ${pc(x.over24).padStart(6)}`);
  }
  console.log(`   per-step (instantaneous) maxima: walk ${f1(r.instantMax.walk)}, carry ${f1(r.instantMax.carry_walk)}, run ${f1(r.instantMax.run)}, other clips ${f1(r.instantMax.other)}`);
  for (const l of r.runners) console.log(`      runs (not at play): ${l}`);
  console.log(`   running: ${pc(r.runShareOfMoving)} of the movement${r.runMin ? ` (speeds ${f1(r.runMin)}–${f1(r.runMax)})` : ''}; by mode ${JSON.stringify(r.runnersByMode)}`);
  for (const l of r.lateList) console.log(`      late: ${l}`);
  console.log(`   keeping the schedule: ${r.arrivals} arrivals in sight; ${r.lateOver8s} more than 8 s from their place when the schedule said arrived; seconds late p50 ${r.lateP50.toFixed(1)} p90 ${r.lateP90.toFixed(1)} max ${r.lateMax.toFixed(0)}`);
  const hrs = r.rhythm.map((x, h) => ({ h, ...x })).filter((x) => x.walking + x.working + x.other > 0.01);
  if (hrs.length) {
    console.log('   people in sight by hour of the day (average walking / working / standing about):');
    console.log('   ' + hrs.map((x) => `${String(x.h).padStart(2, '0')}h ${x.walking.toFixed(0).padStart(3)}/${x.working.toFixed(0).padStart(2)}/${x.other.toFixed(0).padStart(3)}`).join(' | '));
  }
  console.log(`   pop-ins/outs in sight (info): ${r.popsIn} appeared, ${r.popsOut} vanished, ${r.popsRespawn} taken out and put back elsewhere`);
  for (const j of r.respawnList) console.log(`      respawn: ${j}`);
  const acc = walkAcceptance(r);
  console.log(`   ACCEPT walking ≤ ${WALK_CAP.toFixed(1)} m/s: ${pc(r.walkShareUnder2)} of walk-clip movement by time (${pc(r.walkShareUnder2ByDistance)} by distance), need ≥ 98%  ${acc.walkShare ? 'ok' : 'FAIL'}`);
  console.log(`   ACCEPT fast movement off the run clip: ${r.fastOffRun} samples (max walk-clip speed ${f1(r.walkMax)}), need 0  ${acc.runClip ? 'ok' : 'FAIL'}`);
  console.log(`   ACCEPT jumps > 1 m in sight: ${r.jumps} (largest step ${r.maxStep.toFixed(2)} m), need 0  ${acc.noJumps ? 'ok' : 'FAIL'}`);
  for (const j of r.jumpList) console.log(`      jump: ${j}`);
  console.log(`   (info) steps above 0.4 m (8 m/s) in sight: ${r.bigSteps}`);
  for (const j of r.bigList) console.log(`      step: ${j}`);
}

const results: SceneResult[] = [];
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
console.log(`\nTOTAL over ${results.length} scene(s): walk-clip movement ≤ ${WALK_CAP.toFixed(1)} m/s ${pc(share)} (need ≥ 98%) · fast movement off the run clip ${tot.fast} (need 0) · jumps > 1 m in sight ${tot.jumps} (need 0)  =>  ${pass ? 'PASS' : 'FAIL'}`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ seed: SEED, from: FROM, to: TO, seen: SEEN, results, share, pass }, null, 2));
if (STRICT && !pass) process.exit(1);
