// Politics & rival AI (wave 3, SPEC §15, §16, §7, §20). `installPolitics(sim, deps)` registers
// `sim.services.politics` and the macro systems (daily / seasonal / yearly hooks, time-sliced across
// the Houses). It works headless and without the other wave 3 modules: with no military installed,
// wars are fought on paper; with it, battles and sieges report in through `reportBattle` and the
// `siege` events. See docs/POLITICS.md.
import type { Simulation } from '../sim';
import { setSuccessionHooks } from '../succession';
import { fullName, type HouseId, type PersonId, type TitleId } from '../state';
import type { Wave3Deps } from '../wave3deps';
import type { WarView } from '../wave3';
import { Ai } from './ai';
import { PoliticsCore, YEAR } from './core';
import { Diplomacy } from './diplomacy';
import { Management } from './management';
import { Offices } from './offices';
import { Realms } from './realm';
import { claimsOfHouse, claimsOnTitle } from './titles';
import { politicsActions, politicsTopics } from './talk';
import type { HouseView, PoliticsRuntime, ProposalKind } from './types';
import { Unrest } from './unrest';
import { Wars } from './wars';

export type { PoliticsRuntime } from './types';
export type * from './types';

const installed = new WeakMap<Simulation, PoliticsRuntime>();

/** The runtime installed in a simulation, if any (tests, tools, the UI). */
export function politicsOf(sim: Simulation): PoliticsRuntime | undefined { return installed.get(sim); }

export function installPolitics(sim: Simulation, deps: Pick<Wave3Deps, 'economy' | 'social'>): PoliticsRuntime {
  const existing = installed.get(sim);
  if (existing) return existing;
  const core = new PoliticsCore(sim, deps);
  const wars = new Wars(core);
  const diplo = new Diplomacy(core, wars);
  const realms = new Realms(core, wars, diplo);
  const offices = new Offices(core);
  const unrest = new Unrest(core, offices);
  const manage = new Management(core, offices, wars);
  const ai = new Ai(core, wars, diplo);
  wars.endListeners.push((w) => realms.warEnded(w.id));
  if (!core.save.diffApplied) realms.applyDifficulty();

  // ---- macro systems ----
  const offs: Array<() => void> = [];
  offs.push(sim.registerSystem({
    name: 'politics.daily', phase: 'daily', order: 70,
    run: () => {
      core.invalidate();
      wars.daily();
      realms.coalitionsDaily();
      diplo.expire();
    },
  }));
  // the Houses think and the posts are reviewed a little each hour, so no frame carries the whole day
  offs.push(sim.registerSystem({
    name: 'politics.hourly', phase: 'hourly', order: 70,
    run: (_ctx, info) => {
      ai.hourly(info.hourIndex);
      offices.hourly(info.hour);
    },
  }));
  offs.push(sim.registerSystem({
    name: 'politics.seasonal', phase: 'seasonal', order: 70,
    run: () => {
      unrest.seasonal();
      realms.coalitionsSeasonal();
      manage.seasonal();
      decayTies(core);
    },
  }));
  offs.push(sim.registerSystem({
    name: 'politics.yearly', phase: 'yearly', order: 70,
    run: () => {
      core.invalidate();
      diplo.refreshKin();
      realms.yearly();
      core.state.score.continentPct = core.state.score.continentPct; // the score keeper refreshes it in its own yearly pass
    },
  }));

  // ---- events ----
  offs.push(sim.events.on('marriage', (e) => diplo.onMarriage(e)));
  offs.push(sim.events.on('inheritance', (e) => realms.onInheritance(e)));
  offs.push(sim.events.on('siege', (e) => wars.onSiege(e)));
  offs.push(sim.events.on('playerSwitched', () => core.invalidate()));

  // the monks vote for their abbot and prior
  setSuccessionHooks(core.state, {
    religiousHead: (_ctx, title, dead) => offices.electMonk(title, dead),
  });

  // ---- conversation topics and the action on "self" ----
  const runtime: PoliticsRuntime = {
    // ---- the contract ----
    stance: (a, b) => core.stance(a, b),
    wars: () => core.save.wars.map(view),
    warsOf: (h) => core.warsOf(h).map(view),
    liegeOf: (h) => core.liegeOf(h),
    strength: (h) => core.strengthOf(h),
    reportBattle: (war, attackerWon, weight) => wars.reportBattle(war, attackerWon, weight),

    // ---- houses and realms ----
    actors: () => core.actors().slice().sort((a, b) => core.strengthOf(b) - core.strengthOf(a) || a - b),
    houseView: (h, from) => houseView(core, h, from),
    realmLeader: (h) => core.realmLeader(h),
    vassalsOf: (h) => core.vassalsOf(h).slice(),
    primaryTitle: (h) => core.primaryTitle(h)?.id ?? 0,
    neighbours: (h) => core.neighbours(h).slice(),
    realmShare: (h) => core.realmShare(h),
    stats: () => ({ ...core.save.stats }),

    // ---- claims ----
    claimsOn: (t) => { const x = core.state.titles.get(t); return x ? claimsOnTitle(core, x) : []; },
    claimsOf: (h) => claimsOfHouse(core, h),

    // ---- diplomacy ----
    tieOf: (a, b) => core.tie(a, b),
    ladderStep: (a, b) => diplo.ladderStep(a, b),
    acceptChance: (a, b, k) => diplo.acceptChance(a, b, k),
    propose: (a, b, k, o) => diplo.propose(a, b, k, o),
    inbox: () => core.save.inbox,
    answer: (id, accept) => diplo.answer(id, accept),
    matchOptions: (a, b) => diplo.matchOptions(a, b),

    // ---- wars ----
    war: (id) => wars.get(id),
    canDeclare: (h, t, c) => wars.canDeclare(h, t, c),
    declareWar: (h, t, o) => wars.declare(h, t, o),
    peaceOptions: (id, side) => { const w = wars.get(id); return w ? wars.peaceOptions(w, side) : []; },
    makePeace: (id, side, terms) => { const w = wars.get(id); return w ? wars.makePeace(w, side, terms) : { ok: false, reason: 'That war is over.' }; },
    history: () => core.save.history,
    coalitions: () => core.save.coalitions,

    // ---- the AI ----
    personality: (h) => core.personality(h),
    mind: (h) => core.save.ai[String(h)],
    think: (h) => ai.think(h),

    // ---- offices ----
    officeSeats: (place) => offices.officeSeats(place),
    holders: (o, p) => offices.holders(o, p),
    elections: () => offices.elections(),
    canStand: (p, o, pl) => offices.canStand(p, o, pl),
    stand: (p, o, pl) => offices.stand(p, o, pl),
    withdraw: (p, o, pl) => offices.withdraw(p, o, pl),
    campaign: (p, o, pl, v) => offices.campaign(p, o, pl, v),
    bribe: (p, o, pl, n) => offices.bribe(p, o, pl, n),
    petitionOffice: (p, o, pl) => offices.petitionOffice(p, o, pl),
    petitionChance: (p, o, pl) => offices.petitionChance(p, o, pl),
    appoint: (pa, o, pl, to) => offices.appoint(pa, o, pl, to),
    holdElection: (o, pl) => offices.holdElection(o, pl),
    forecast: (o, pl) => offices.forecast(o, pl),

    // ---- management ----
    authority: (p) => manage.authority(p),
    manorPolicy: (s) => manage.manorPolicy(s),
    setManorPolicy: (p, s, c) => manage.setManorPolicy(p, s, c),
    realmLaws: (k) => manage.realmLaws(k),
    setRealmLaw: (p, k, c) => manage.setRealmLaw(p, k, c),
    grantTitle: (l, t, to) => manage.grantTitle(l, t, to),
    revokeTitle: (l, t) => manage.revokeTitle(l, t),
    petitions: (p) => manage.petitions(p),
    resolvePetition: (id, c) => manage.resolvePetition(id, c),

    // ---- unrest ----
    unrest: (s) => unrest.get(s),
    revolts: () => core.save.revolts,
    bands: () => core.save.bands,
    startRevolt: (s) => unrest.startRevolt(s),
  };

  const view = (w: { id: number; attackers: HouseId[]; defenders: HouseId[]; goal: TitleId; since: number; score: number }): WarView => ({
    id: w.id, attackers: w.attackers.slice(), defenders: w.defenders.slice(), goal: w.goal, since: w.since, score: Math.round(w.score),
  });

  offs.push(sim.actions.register(politicsActions(core)));
  offs.push(deps.social.registerTopic(politicsTopics(core, runtime, offices)));

  sim.services.politics = runtime;
  installed.set(sim, runtime);
  void offs;
  return runtime;
}

/** Seasonal: grievances fade, truces run out (the world is told). */
function decayTies(core: PoliticsCore): void {
  const day = core.day;
  for (const [key, t] of Object.entries(core.save.ties).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const [a, b] = key.split(':').map(Number);
    const before: Array<ReturnType<PoliticsCore['stance']>> = [core.stance(a, b), core.stance(b, a)];
    let changed = false;
    if (t.grievance > 0) { t.grievance = Math.max(0, Math.round((t.grievance - 3) * 10) / 10); changed = true; }
    if (t.truce > 0 && t.truce <= day) { t.truce = 0; changed = true; }
    if (changed) {
      core.touch();
      core.announceStance(a, b, before);
      core.dropIfEmpty(a, b);
    }
  }
}

function houseView(core: PoliticsCore, h: HouseId, from?: HouseId): HouseView | null {
  const house = core.state.houses.get(h);
  if (!house) return null;
  const head = core.headOf(h);
  const titles = core.titlesOfHouse(h).map((t) => ({ id: t.id, kind: t.kind, name: t.name }));
  const me = from ?? core.playerHouse;
  const tie = me && me !== h ? core.tie(me, h) : undefined;
  const pacts: string[] = [];
  if (tie) {
    if (tie.alliance) pacts.push('alliance');
    if (tie.kin > 0) pacts.push('kin by marriage');
    if (tie.trade) pacts.push('trade');
    if (tie.truce > core.day) pacts.push(`truce for ${Math.max(1, Math.round((tie.truce - core.day) / YEAR))} years`);
    if (tie.grievance >= 35) pacts.push('bitter');
  }
  return {
    house: h, name: house.name, head: head?.id ?? 0, headName: head ? fullName(head) : 'no one', strength: Math.round(core.strengthOf(h)),
    titles, liege: core.liegeOf(h), vassals: core.vassalsOf(h).length, stance: me && me !== h ? core.stance(me, h) : 'alliance',
    pacts, atWar: core.warsOf(h).length > 0, isPlayer: core.isPlayerHouse(h),
  };
}

export type { ProposalKind, PersonId };
