// Objectives (clarity pass, docs/CLARITY.md §2): what the player should be doing, concrete, located and
// checkable. `installObjectives(sim, deps)` registers its listeners and one cheap per-step poll, feeds the
// world's beacons through `sim.view.setSource('worldMarkers')`, and returns the `ObjectivesApi` the HUD and the
// journal read. Everything is deterministic and saved in `state.ext['objectives']`; nothing scans the
// population per frame.
//
//   tutorial   a short chain fitted to the birth, on the first day                        (tutorial.ts)
//   chore      what the household head asks at dawn                                       (chores.ts)
//   job        the day's duty of a post, and a serf's week-work                           (work.ts)
//   goal       a path at fourteen, the archers' test, an apprenticeship, a tool, courting (goals.ts)
//   request    villagers' requests, mirrored from the happenings                          (requests.ts)
//   story      a dear one gravely ill, the wedding feast, a newborn, the levy call        (story.ts)
import type { ActionEvent } from '../actions';
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import { advanceTutorial, startTutorial } from './tutorial';
import { choreDone, expireOverdue, makeChores } from './chores';
import { Obj, type ObjRec } from './core';
import { isStrict } from './data';
import { notablePlaces } from './directory';
import { refreshGoals, retireGoals } from './goals';
import { introText } from './intro';
import { installMarkers } from './markers';
import { round, type Ev } from './match';
import { syncRequests } from './requests';
import { storyBorn, storyHourly, storyMarried } from './story';
import { closeDay, logAction, logTalk, logTrade, startLog, summaryOf } from './summary';
import { suggest } from './suggest';
import { makeJobs } from './work';
import type { Objective, ObjectivesApi, ObjectiveTarget } from './types';

export type { ObjectivesApi, Objective, ObjectiveStep, ObjectiveTarget, Suggestion, DaySummary, ObjectiveSource } from './types';

/** The API plus the runtime, for tools, tests and the dev pages. */
export interface ObjectivesRuntime extends ObjectivesApi {
  readonly obj: Obj;
  /** Makes today's work (jobs, chores, goals) now instead of at the next dawn hour (tests, tools). */
  dawn(): void;
  /** Looks at the state once (what the periodic poll does). */
  poll(slow?: boolean): void;
  dispose(): void;
}

const installed = new WeakMap<Simulation, ObjectivesRuntime>();

export function objectivesOf(sim: Simulation): ObjectivesRuntime | undefined { return installed.get(sim); }

/** Sub-steps between two looks at the state (20 per second of play). */
const POLL_STEPS = 20;
/** Every this many polls the heavier checks (strips, requests, courtship) run too. */
const SLOW_EVERY = 5;

export function installObjectives(sim: Simulation, deps: Wave3Deps): ObjectivesRuntime {
  const existing = installed.get(sim);
  if (existing) return existing;
  const O = new Obj(sim, deps);
  const markers = installMarkers(O);
  const offs: Array<() => void> = [];

  // ---- starting (or carrying on) ----
  /** Sets up for the player: the first day's tutorial for a new run, plain goals and chores for a switch. */
  const begin = (newRun: boolean): void => {
    const me = O.me;
    if (!me) return;
    O.save.person = O.playerId;
    startLog(O);
    O.save.jobsDay = O.dayNo;
    if (newRun) {
      O.save.choresDay = O.dayNo;
      startTutorial(O);
    } else {
      O.save.tut.done = true;
    }
    refreshGoals(O);
    syncRequests(O);
    round(O, null);
    O.touch();
  };

  const dawn = (): void => {
    const me = O.me;
    if (!me) return;
    makeJobs(O);
    makeChores(O);
    refreshGoals(O);
    round(O, null);
  };

  const follow = (): void => { markers.refresh(); };
  O.onChange = follow;
  O.onFinished = (o: ObjRec, state) => {
    if (o.source === 'tutorial') {
      advanceTutorial(O);
      round(O, null);
    } else if (o.source === 'chore' && state === 'done') {
      choreDone(O, o.title, o.giver);
    } else if (o.source === 'goal') {
      O.save.seen[o.key] = O.dayNo;
      if (state === 'done') refreshGoals(O);
    }
    follow();
  };

  if (O.me) {
    if (O.save.person === 0) begin(O.day < 1.5);
    else if (O.save.person !== O.playerId) { O.reset(); begin(false); }
  }

  // ---- events ----
  // a fault in the objectives must never stop the simulation or the frame: it is logged, and the game goes on
  const safe = <A extends unknown[]>(fn: (...a: A) => void): ((...a: A) => void) => (...a: A): void => {
    try { fn(...a); } catch (err) {
      if (isStrict()) throw err;
      console.error('objectives:', err);
    }
  };
  const on: Simulation['events']['on'] = (type, fn) => sim.events.on(type, safe(fn as (...a: unknown[]) => void) as never);
  const feed = (ev: Ev): void => { round(O, ev); follow(); };

  offs.push(on('action', (e: ActionEvent) => {
    if (e.type !== 'completed' || e.actor !== O.playerId) return;
    logAction(O, e);
    feed({ t: 'action', id: e.option.id, target: e.option.target, ok: e.outcome.ok });
    syncRequests(O);
  }));
  offs.push(on('conversation', (e) => {
    if (e.actor !== O.playerId) return;
    if (e.phase === 'end') {
      // requests are heard, accepted, declined and handed over in conversation
      syncRequests(O);
      follow();
      return;
    }
    logTalk(O);
    feed({ t: 'talk', who: e.with });
  }));
  offs.push(on('trade', (e) => {
    const me = O.playerId;
    if (e.buyer !== me && e.seller !== me) return;
    logTrade(O, e.buyer, e.seller, e.pence);
    feed({ t: 'trade', buy: e.buyer === me, item: e.item });
  }));
  offs.push(on('skip', (e) => {
    if (e.kind !== 'sleep') return;
    if (e.phase === 'start') { feed({ t: 'sleep' }); closeDay(O, false); }
    else round(O, null);
  }));
  offs.push(on('skillLevel', (e) => { if (e.person === O.playerId) feed({ t: 'flag', name: 'skill' }); }));
  offs.push(on('careerChanged', (e) => {
    if (e.person !== O.playerId) return;
    feed({ t: 'career', to: e.to });
    retireGoals(O);
    refreshGoals(O);
  }));
  offs.push(on('marriage', (e) => {
    const me = O.playerId;
    if (e.a !== me && e.b !== me) return;
    storyMarried(O, e.a === me ? e.b : e.a);
    feed({ t: 'flag', name: 'married' });
    retireGoals(O);
  }));
  offs.push(on('birth', (e) => storyBorn(O, e.person, e.mother, e.father)));
  offs.push(on('request', () => { syncRequests(O); follow(); }));
  offs.push(on('notify', (e) => { if (e.ref && e.ref.startsWith('request:')) { syncRequests(O); follow(); } }));
  offs.push(on('dayStarted', () => { closeDay(O, true); }));
  offs.push(on('hourStarted', (info) => {
    const me = O.me;
    if (!me) return;
    if (O.save.person !== O.playerId) { O.reset(); begin(false); }
    expireOverdue(O);
    advanceTutorial(O);
    if (info.day > O.save.choresDay && info.hour >= O.dawnHour(info.day) && info.hour <= 20) dawn();
    else if (info.day > O.save.jobsDay && info.hour >= O.dawnHour(info.day) && info.hour <= 20) { makeJobs(O); }
    storyHourly(O);
    syncRequests(O);
    if (info.hour % 6 === 0) { retireGoals(O); if (info.day > O.save.goalsDay) refreshGoals(O); }
    round(O, { t: 'poll', slow: true });
    follow();
  }));
  offs.push(on('playerSwitched', () => { O.reset(); begin(false); markers.invalidate(); follow(); }));
  offs.push(on('playerDied', () => { O.touch(); }));

  // ---- the periodic look (cheap: only the current step of each live objective) ----
  let polls = 0;
  const poll = (slow = false): void => {
    if (!O.me) return;
    if (slow) syncRequests(O);
    round(O, { t: 'poll', slow });
    markers.refresh();
  };
  offs.push(sim.registerSystem({
    name: 'objectives.poll', phase: 'perStep', order: 90,
    run: safe((_ctx, info) => { if (info.step % POLL_STEPS === 0) poll(++polls % SLOW_EVERY === 0); }),
  }));

  // ---- what the world and the HUD read ----
  const noMarkers: readonly never[] = [];
  sim.view.setSource('worldMarkers', () => {
    try { return markers.source(); } catch (err) {
      if (isStrict()) throw err;
      console.error('objectives:', err);
      return noMarkers;
    }
  });

  const api: ObjectivesRuntime = {
    obj: O,
    dawn,
    poll,
    list: () => O.list(),
    tracked: (): Objective | null => O.save.list.find((o) => o.id === O.save.tracked && o.state === 'active') ?? null,
    track: (id) => { O.track(id); follow(); },
    suggestions: (limit) => suggest(O, limit),
    daySummary: (day) => summaryOf(O, day),
    trackPerson: (person) => { O.save.foundPerson = person > 0 ? person : 0; O.touch(); markers.invalidate(); follow(); },
    trackPlace: (target: ObjectiveTarget | null) => { O.save.foundPlace = target ? { ...target } : null; O.touch(); follow(); },
    found: () => ({ person: O.save.foundPerson, place: O.save.foundPlace }),
    places: () => { const me = O.me; return me ? notablePlaces(O, me) : []; },
    version: () => O.version,
    intro: () => introText(O),
    dispose() {
      for (const off of offs.splice(0)) off();
      sim.view.setSource('worldMarkers', undefined);
      installed.delete(sim);
    },
  };
  installed.set(sim, api);
  return api;
}
