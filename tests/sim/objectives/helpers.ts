// A simulation with social, economy, advancement (happenings) and the objectives installed, a controllable
// player position (the player module is not installed in these tests), and drivers that play the steps.
import type { ActionOption, TargetRef } from '../../../src/sim/actions';
import { installAdvancement, type AdvancementInstall } from '../../../src/sim/advancement';
import { installEconomy, type EconomyRuntime } from '../../../src/sim/economy';
import { installObjectives, type ObjectivesRuntime } from '../../../src/sim/objectives';
import { setStrictText } from '../../../src/sim/objectives/data';
import type { Match, ObjRec } from '../../../src/sim/objectives/core';
import { stripCentre } from '../../../src/sim/objectives/places';
import type { Objective, ObjectiveTarget } from '../../../src/sim/objectives/types';
import type { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import type { SocialApi } from '../../../src/sim/social/types';
import { ageYears, type Household, type Person } from '../../../src/sim/state';
import type { Wave3Deps } from '../../../src/sim/wave3deps';
import { newSim, type TestSimOptions } from '../helpers';

setStrictText(true);

export interface ObjSim {
  sim: Simulation;
  social: SocialApi;
  economy: EconomyRuntime;
  adv: AdvancementInstall;
  obj: ObjectivesRuntime;
  deps: Wave3Deps;
  player: Person;
  /** Where the (pretend) player body stands. */
  at: { x: number; z: number };
}

export interface ObjSimOptions extends TestSimOptions {
  zone?: Wave3Deps['zone'];
  /** Install the objectives (default true). Turn off to arrange the world first, then call `install`. */
  install?: boolean;
}

export function playerOf(sim: Simulation): Person {
  return sim.state.persons.get(sim.state.run.playerId) as Person;
}

export function objSim(opts: ObjSimOptions = {}): ObjSim {
  return wrapSim(newSim({ preset: 'tiny', ...opts }), opts.zone, opts.install !== false);
}

/** Installs the modules into an existing simulation (a new one, or one just loaded) and returns the test handle. */
export function wrapSim(sim: Simulation, zone?: Wave3Deps['zone'], withObjectives = true): ObjSim {
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const deps: Wave3Deps = { economy, social, zone };
  const adv = installAdvancement(sim, deps);
  const player = playerOf(sim);
  const at = { x: 0, z: 0 };
  const hh = sim.state.households.get(player.household) as Household;
  const home = sim.state.buildings.get(hh.home);
  if (home) { at.x = home.x; at.z = home.z; }
  sim.view.setSource('player', () => ({ personId: sim.state.run.playerId, x: at.x, y: 0, z: at.z, yaw: 0, mounted: false, alive: true }));
  sim.view.setSource('focus', () => at);
  const o: ObjSim = { sim, social, economy, adv, obj: undefined as unknown as ObjectivesRuntime, deps, player, at };
  if (withObjectives) o.obj = installObjectives(sim, deps);
  return o;
}

export function install(o: ObjSim): ObjectivesRuntime {
  o.obj = installObjectives(o.sim, o.deps);
  return o.obj;
}

// ---------------------------------------------------------------------------------------------
// Looking
// ---------------------------------------------------------------------------------------------

export function tracked(o: ObjSim): Objective | null { return o.obj.tracked(); }

export function stepOf(obj: Objective | null): Objective['steps'][number] | undefined {
  return obj?.steps.find((s) => !s.done);
}

export function active(o: ObjSim, source?: Objective['source']): Objective[] {
  return o.obj.list().filter((x) => x.state === 'active' && (!source || x.source === source));
}

export function byTitle(o: ObjSim, re: RegExp): Objective | undefined {
  return o.obj.list().find((x) => re.test(x.title));
}

/** Everything a step says, for checks that no placeholder was left unfilled. */
export function allText(list: readonly Objective[]): string[] {
  const out: string[] = [];
  for (const x of list) {
    out.push(x.title, x.why, x.reward ?? '');
    for (const s of x.steps) out.push(s.text, s.hint ?? '', s.target?.label ?? '');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------------------------

/** Moves the pretend body and lets the objectives look. */
export function walkTo(o: ObjSim, x: number, z: number): void {
  o.at.x = x; o.at.z = z;
  o.obj.poll(true);
}

export function walkToTarget(o: ObjSim, t: ObjectiveTarget): void { walkTo(o, t.x, t.z); }

/** Puts the pretend body at the player's home door (after a test moved the household). */
export function goHome(o: ObjSim): void {
  const hh = o.sim.state.households.get(playerOf(o.sim).household) as Household;
  const home = o.sim.state.buildings.get(hh.home);
  if (home) { o.at.x = home.x; o.at.z = home.z; }
}

/** Steps the simulation in real-time frames (20 a second of play). */
export function play(o: ObjSim, seconds: number): void {
  for (let i = 0; i < seconds * 20; i++) o.sim.step(1 / 20);
}

/** Runs the first enabled option whose id matches, to completion (all its repeats if `repeats`). */
export function doAction(o: ObjSim, target: TargetRef, re: RegExp, repeats = 0): { ok: boolean; message?: string; option?: ActionOption } {
  const actor = o.sim.state.run.playerId;
  const opt = o.sim.actions.list(actor, target).find((x) => x.enabled && re.test(x.id));
  if (!opt) return { ok: false, message: `no enabled ${re} on ${JSON.stringify(target)}: ${o.sim.actions.list(actor, target).map((x) => `${x.id}${x.enabled ? '' : '(' + x.reason + ')'}`).join(', ')}` };
  let done = 0;
  let last: { ok: boolean; message?: string } = { ok: true };
  const off = o.sim.actions.onEvent((e) => { if (e.type === 'completed') { done++; last = e.outcome; } });
  const first = o.sim.actions.start(actor, opt);
  if (!first.ok) { off(); return { ...first, option: opt }; }
  let guard = 0;
  while (o.sim.actions.active(actor) && done < repeats + 1 && guard++ < 60 * 20 * 4) o.sim.step(1 / 20);
  if (done >= repeats + 1) o.sim.actions.cancel(actor);
  off();
  return { ...last, option: opt };
}

/** Starts a conversation with someone and ends it again. */
export function talkTo(o: ObjSim, who: number): boolean {
  const open = o.social.current();
  if (open) o.social.end(open.id);
  const c = o.social.start(o.sim.state.run.playerId, who);
  if ('ok' in c) return false;
  o.social.end(c.id);
  return true;
}

/** Sets the clock to a time of day on the current day without firing hooks. */
export function setTime(sim: Simulation, fraction: number, day = Math.floor(sim.absDay)): void {
  sim.state.clock.absDay = day + fraction;
  sim.state.clock.firedHour = Math.floor((day + fraction) * 24);
}

export function ageNow(sim: Simulation, p: Person): number { return ageYears(p, sim.absDay); }

/** Ends the tutorial without playing it (for tests about what comes after). */
export function skipTutorial(o: ObjSim): void {
  o.obj.obj.save.tut.done = true;
  for (const x of o.obj.list()) if (x.source === 'tutorial' && x.state === 'active') o.obj.obj.finish(o.obj.obj.byId(x.id)!, 'expired');
}

/** Puts fallen trees at the given offsets from the player's home (the mock world has no vegetation). Returns their ids. */
export function addDeadwood(o: ObjSim, offsets: Array<[number, number]> = [[30, 0], [55, 10], [80, -10]]): number[] {
  const hh = o.sim.state.households.get(playerOf(o.sim).household) as Household;
  const home = o.sim.state.buildings.get(hh.home)!;
  const byChunk = new Map<string, Array<{ id: number; kind: 'deadtree'; x: number; z: number; scale: number; rot: number; variant: number }>>();
  const ids: number[] = [];
  offsets.forEach(([dx, dz], i) => {
    const x = home.x + dx, z = home.z + dz;
    const cx = Math.floor(x / 64), cz = Math.floor(z / 64);
    const id = (cz * 250 + cx) * 4096 + 100 + i;
    const key = `${cx}:${cz}`;
    const list = byChunk.get(key) ?? [];
    list.push({ id, kind: 'deadtree', x, z, scale: 1, rot: 0, variant: 0 });
    byChunk.set(key, list);
    ids.push(id);
  });
  (o.sim.world as { scatterInChunk: (cx: number, cz: number) => unknown }).scatterInChunk = (cx: number, cz: number) => byChunk.get(`${cx}:${cz}`) ?? [];
  return ids;
}

export interface FakeZone {
  zone: Wave3Deps['zone'];
  /** Where the agents stand (people not listed are not in the zone). */
  agents: Map<number, { x: number; z: number }>;
  /** What the objectives told the zone about quest marks, each call: every marked person, and who has which mark. */
  givers: Array<{ ids: number[]; quest: number[]; turnin: number[] }>;
  /** Whom the objectives asked the zone to mark as the person being looked for, each call (0 clears). */
  tracked: number[];
}

/** Just enough of the detail zone for the objectives: agents, whereabouts, doors and the quest-giver hook. */
export function fakeZone(): FakeZone {
  const agents = new Map<number, { x: number; z: number }>();
  const givers: FakeZone['givers'] = [];
  const tracked: number[] = [];
  const zone = {
    agent: (id: number) => { const a = agents.get(id); return a ? { personId: id, x: a.x, y: 0, z: a.z, yaw: 0 } : null; },
    whereabouts: () => ({ activity: 'home', settlement: 0, building: -1, indoors: false, x: 123, z: 456, label: '' }),
    nav: { doorOf: () => null },
    setQuestMarks: (marks: ReadonlyArray<{ person: number; kind: 'quest' | 'turnin' }>) => {
      givers.push({
        ids: marks.map((m) => m.person),
        quest: marks.filter((m) => m.kind === 'quest').map((m) => m.person),
        turnin: marks.filter((m) => m.kind === 'turnin').map((m) => m.person),
      });
    },
    setTrackedPerson: (id: number) => { tracked.push(id); },
  } as unknown as Wave3Deps['zone'];
  return { zone, agents, givers, tracked };
}

/** Speaks to everyone who has something for the player (a "!" over their head), as a player would: what they
 *  offered is taken up. Returns how many were taken up. */
export function hearOffers(o: ObjSim): number {
  let n = 0;
  const tried = new Set<number>();
  for (let guard = 0; guard < 8; guard++) {
    const givers = [...new Set(o.obj.obj.offered().map((x) => x.giver).filter((g): g is number => !!g && !tried.has(g)))];
    if (!givers.length) break;
    for (const g of givers) {
      tried.add(g);
      const before = o.obj.obj.offered().length;
      // someone asleep or away cannot be spoken to now: their offer waits, as in play
      if (talkTo(o, g)) n += before - o.obj.obj.offered().length;
    }
  }
  return n;
}

/** Runs the calendar to a given hour of a day (hooks fire as in play). By default the scripted player then speaks to
 *  whoever has something for them (`hearOffers`); pass `hear = false` to leave the offers waiting. */
export function runTo(o: ObjSim, day: number, hour: number, hear = true): void {
  const target = day + hour / 24;
  // a sleep or wait that is still pending would hold the calendar: let it finish
  for (let g = 0; o.sim.clock.skip && g < 4000; g++) o.sim.step(0.25);
  for (let i = 0; o.sim.absDay + 1e-9 < target; i++) {
    const before = o.sim.absDay;
    o.sim.advanceHours(1);
    if (i > 800 || o.sim.absDay <= before) throw new Error(`the calendar is stuck at ${before} (wanted ${target})`);
  }
  if (hear && o.obj) hearOffers(o);
}

export type { ObjRec };

// ---------------------------------------------------------------------------------------------
// A scripted player that does what the current step says
// ---------------------------------------------------------------------------------------------

/** The raw record of an objective (steps carry their matcher). */
export function recOf(o: ObjSim, id: number): ObjRec {
  return o.obj.obj.byId(id) as ObjRec;
}

function regexOf(ids: readonly string[]): RegExp {
  return new RegExp(`^(${ids.map((i) => i.replace(/[.]/g, '\\.').replace(/\*$/, '.*')).join('|')})$`);
}

/** Buys (or failing that sells) one thing from a partner. */
export function tradeSomething(o: ObjSim, partner: Parameters<EconomyRuntime['partnerStock']>[0]): boolean {
  const p = playerOf(o.sim);
  p.money = Math.max(p.money, 30);
  const lines = o.economy.partnerStock(partner, p.id).filter((l) => l.buy > 0 && l.stock >= 1 && l.good.category !== 'livestock').sort((a, b) => a.buy - b.buy);
  for (const l of lines.slice(0, 6)) {
    const r = o.economy.trade(p.id, partner, [{ key: l.key, qty: 1 }]);
    if (r.ok) return true;
  }
  const have = Object.keys(p.inventory).filter((k) => k.charCodeAt(0) !== 126);
  for (const k of have) {
    const r = o.economy.trade(p.id, partner, [{ key: k, qty: -1 }]);
    if (r.ok) return true;
  }
  return false;
}

export interface Played { titles: string[]; trace: string[]; stuck: string | null }

/**
 * Plays objectives of the given sources one after another until none is left (or one cannot be done).
 * The evening stage of the tutorial waits for the evening: the clock is moved there when nothing else is open.
 */
export function playObjectives(o: ObjSim, sources: ReadonlyArray<Objective['source']> = ['tutorial'], maxObjectives = 20): Played {
  const out: Played = { titles: [], trace: [], stuck: null };
  for (let guard = 0; guard < maxObjectives; guard++) {
    const todo = active(o).filter((x) => sources.includes(x.source));
    if (todo.length === 0) {
      const t = o.obj.obj.save.tut;
      if (sources.includes('tutorial') && !t.done && o.sim.absDay % 1 < 0.7) {
        setTime(o.sim, 0.8, Math.floor(o.sim.absDay));
        o.sim.advanceHours(1);
        if (active(o).some((x) => sources.includes(x.source))) continue;
      }
      break;
    }
    const ob = todo[0];
    const rec = recOf(o, ob.id);
    out.titles.push(ob.title);
    for (let i = 0; i < 14 && rec.state === 'active'; i++) {
      const step = o.obj.obj.current(rec);
      const did = playStep(o, rec);
      out.trace.push(`${ob.title} / ${step?.text}: ${did || 'COULD NOT'}`);
      if (!did) break;
    }
    if (rec.state === 'active') { out.stuck = `${ob.title}: ${o.obj.obj.current(rec)?.text}`; break; }
  }
  return out;
}

/**
 * Does one thing the current step of an objective asks for. Returns what it did ('' when it cannot).
 * Cheats only where the world would take real time (goods in the pack, stats, the purse).
 */
export function playStep(o: ObjSim, rec: ObjRec): string {
  const step = o.obj.obj.current(rec);
  if (!step) return 'done';
  const m: Match = step.m;
  const p = playerOf(o.sim);
  switch (m.k) {
    case 'talk': return talkTo(o, m.who) ? `talk ${m.who}` : '';
    case 'talkAny': {
      const res = o.sim.state.residentsOf(p.settlement).filter((r) => !r.death && !m.not.includes(r.id) && !m.seen.includes(r.id) && ageNow(o.sim, r) >= 3);
      return res.length > 0 && talkTo(o, res[0].id) ? `talk ${res[0].id}` : '';
    }
    case 'reach': {
      const c = m.strip !== undefined ? stripCentre(o.obj.obj, m.strip) : { x: m.x, z: m.z };
      walkTo(o, c.x, c.z);
      if (m.from !== undefined && o.sim.absDay < m.from) { o.sim.state.clock.absDay = m.from + 0.01; walkTo(o, c.x, c.z); }
      return 'reach';
    }
    case 'act': {
      if (!m.at) return '';
      const target = { kind: m.at.kind, id: m.at.id } as TargetRef;
      const r = doAction(o, target, regexOf(m.ids), 0);
      return r.ok ? `act ${r.option?.id}` : '';
    }
    case 'strip': {
      let n = 0;
      for (; n < 14 && !step.done; n++) {
        const r = doAction(o, { kind: 'strip', id: m.strip }, /^farm\./, 0);
        if (!r.ok) return '';
      }
      return `strip ${m.task} x${n}`;
    }
    case 'trade': {
      const t = step.target;
      if (!t) return '';
      const partner = t.kind === 'person' ? { kind: 'person' as const, id: t.id } : { kind: 'building' as const, id: t.id };
      return tradeSomething(o, partner) ? 'trade' : '';
    }
    case 'have': {
      for (const g of m.good.split('|').slice(0, 1)) p.inventory[g] = (p.inventory[g] ?? 0) + m.qty;
      o.sim.state.touch(p);
      o.obj.poll(true);
      return 'have';
    }
    case 'sleep': {
      o.sim.dispatch({ type: 'sleep' });
      // sleep through to the dawn
      for (let g = 0; o.sim.clock.skip && g < 4000; g++) o.sim.step(0.25);
      return 'sleep';
    }
    case 'skill': p.skills[m.skill] = Math.max(p.skills[m.skill], m.level * m.level * 40 + 1); o.sim.state.touch(p); o.obj.poll(true); return 'skill';
    case 'stat': p.trained[m.stat] = m.value + 0.1; o.sim.state.touch(p); o.obj.poll(true); return 'stat';
    case 'money': p.money = Math.max(p.money, m.pence + 1); o.sim.state.touch(p); o.obj.poll(true); return 'money';
    case 'wait': o.sim.state.clock.absDay = Math.max(o.sim.absDay, m.until + 0.01); o.obj.poll(true); return 'wait';
    default: return '';
  }
}
