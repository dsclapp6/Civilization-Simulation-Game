// Happenings (wave 3, SPEC §18-§21): disasters and trouble, festivals and gatherings, and requests to
// the player. Installed by `installAdvancement` (or on its own with `installHappenings`), registers
// `sim.services.happenings`. Seeded and difficulty-scaled; everything works headless.
import type { Simulation } from '../sim';
import type { Wave3Deps } from '../wave3deps';
import type { AdvancementRuntime } from '../advancement/types';
import { Hap } from './core';
import { disastersYearly, fireHourly, hazardsDaily, plagueDailyPass, trigger, wolvesHourly } from './disasters';
import { festivalsDaily, gatheringsHourly, schedule } from './festivals';
import {
  acceptRequest, allRequests, declineRequest, listenWork, offerRequest, openRequests, requestTopics, requestsDaily, requestsHourly, requestsStep,
} from './requests';
import type { HappeningsRuntime } from './types';

export type { HappeningKind, HappeningRec, HappeningsRuntime, RequestRec, RequestType, RequestView } from './types';

export type HappeningsInstall = HappeningsRuntime & { hap: Hap };

const installed = new WeakMap<Simulation, HappeningsInstall>();

export function installHappenings(sim: Simulation, deps: Wave3Deps, _adv?: AdvancementRuntime): HappeningsInstall {
  const existing = installed.get(sim);
  if (existing) return existing;
  const H = new Hap(sim, deps);

  // the daily work runs in separate hours of the night so that no single frame carries all of it
  const daily = (name: string, hour: number, fn: (day: { day: number; absDay: number }) => void): void => {
    sim.registerSystem({ name, phase: 'hourly', order: 71, run: (_ctx, info) => { if (info.hour === hour) fn({ day: info.day, absDay: info.absDay }); } });
  };
  daily('happenings.hazards', 1, (d) => hazardsDaily(H, d));
  daily('happenings.plague', 2, () => plagueDailyPass(H));
  daily('happenings.festivals', 3, (d) => festivalsDaily(H, d));
  daily('happenings.requests', 4, (d) => requestsDaily(H, d));
  sim.registerSystem({
    name: 'happenings.hourly', phase: 'hourly', order: 70,
    run: (_ctx, info) => { fireHourly(H, info); wolvesHourly(H, info); gatheringsHourly(H, info); requestsHourly(H, info); },
  });
  // after the economy has set the year's prosperity (order 20) and the techs have lifted it (25)
  sim.registerSystem({ name: 'happenings.yearly', phase: 'yearly', order: 30, run: (_ctx, info) => disastersYearly(H, info) });
  sim.registerSystem({
    name: 'happenings.step', phase: 'perStep', order: 70,
    run: (_ctx, info) => { if (info.step % 20 === 0) requestsStep(H, info.step); },
  });

  sim.events.on('marriage', (e) => schedule(H, 'wedding', [e.a, e.b], e.settlement));
  sim.events.on('death', (e) => {
    const p = H.state.persons.get(e.person);
    if (p && e.age >= 12) schedule(H, 'funeral', [e.person], p.settlement);
  });
  sim.events.on('birth', (e) => schedule(H, 'christening', [e.person], e.settlement));
  listenWork(H);
  deps.social.registerTopic(requestTopics(H));

  const api: HappeningsInstall = {
    hap: H,
    activeAt: (settlement) => H.recordsAt(settlement),
    isActive: (kind, settlement) => H.save.active.some((r) => r.kind === kind && (settlement === undefined || r.settlement === settlement || (r.settlement < 0 && (r.kingdom < 0 || r.kingdom === H.kingdomOf(settlement))))),
    trigger: (kind, settlement) => trigger(H, kind, settlement),
    active: () => H.save.active,
    recent: (limit = 10) => H.save.recent.slice(0, limit),
    requests: () => allRequests(H),
    openRequests: () => openRequests(H),
    acceptRequest: (id) => acceptRequest(H, id),
    declineRequest: (id) => declineRequest(H, id),
    offerRequest: (type, from) => offerRequest(H, type, from),
    stats: () => ({ started: { ...H.save.stats.started }, requests: { ...H.save.stats.requests } }),
  };
  sim.services.happenings = api;
  installed.set(sim, api);
  return api;
}

export function happeningsOf(sim: Simulation): HappeningsInstall | undefined { return installed.get(sim); }
