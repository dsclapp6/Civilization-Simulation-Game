// Law (civilization pass, wave B, docs/CIV.md §4 and docs/LAW.md): trespass, patrols, captivity.
//
// `installLaw(sim, deps)` registers `sim.services.law`. It watches the player (twice a second) against the territory module, sends
// the lord's men after a trespasser they have seen, hears the answers, fights or escorts or takes the prisoner; keeps the prisoners
// of the player and the AI (the gaol, fines, ransoms, sentences, escapes, the hangman) in `state.ext['law']`; and makes the AI's
// poachers, bandits and scouts off-screen once a day. It finds every other module lazily (the zone, the player, the territory,
// combat, military, politics may all be missing: headless runs and tests have only some).
import type { Simulation } from '../sim';
import type { PersonId } from '../state';
import type { Wave3Deps } from '../wave3deps';
import { dailyCases } from './ai';
import { adoptWar, captivityChoices, chooseInCaptivity, dailyCaptives, deliver, restrainPlayer, seizePerson, viewOf, warView } from './captive';
import { Law } from './context';
import { PatrolSystem } from './patrol';
import { Watch } from './watch';
import type { CaptivityView, LawRuntime } from './types';

export type { LawApi, LawRuntime } from './types';
export * from './types';

const contexts = new WeakMap<Simulation, { law: Law; patrol: PatrolSystem; watch: Watch }>();

/** The module's internal parts (tests, tools). */
export function lawContext(sim: Simulation): { law: Law; patrol: PatrolSystem; watch: Watch } {
  const c = contexts.get(sim);
  if (!c) throw new Error('installLaw has not run for this simulation');
  return c;
}

export function installLaw(sim: Simulation, deps: Wave3Deps): LawRuntime {
  const L = new Law(sim, deps);
  const patrol = new PatrolSystem(L);
  const watch = new Watch(L, patrol);
  contexts.set(sim, { law: L, patrol, watch });
  const offs = L.offs;

  // ---- systems ----
  offs.push(sim.registerSystem({
    name: 'law.step', phase: 'perStep', order: 62,
    run: (_c, info) => {
      patrol.step(info.dt);
      watch.step(info.dt);
    },
  }));
  offs.push(sim.registerSystem({
    name: 'law.day', phase: 'daily', order: 62,
    run: () => {
      dailyCaptives(L);
      dailyCases(L);
    },
  }));

  // ---- events ----
  offs.push(sim.events.on('fightEnded', (r) => patrol.fought(r)));
  // a prisoner of war the military module took (a battle, a raid, a yielded noble): the player's case is kept here too
  offs.push(sim.events.on('captured', (e) => {
    if (e.captive !== L.playerId || L.store.captiveOf(e.captive)) return;
    const rec = adoptWar(L, e.captive, e.captor, e.ransom);
    if (rec) {
      restrainPlayer(L, rec);
      sim.events.emit('ui', { panel: 'ext', name: 'law', data: { mode: 'captive' } });
    }
  }));
  offs.push(sim.events.on('death', (e) => {
    patrol.dropFor(e.person);
    const rec = L.store.captiveOf(e.person);
    if (rec) { L.store.remove(rec); L.store.touch(); }
  }));
  offs.push(sim.events.on('playerSwitched', (e) => {
    // the old body goes on under the AI (still a prisoner if it was); the new one is held if the law holds it
    patrol.dropFor(e.from);
    watch.reset();
    L.player?.restrain?.(null);
    const rec = L.store.captiveOf(e.to);
    if (rec) { if (rec.led) deliver(L, rec); else restrainPlayer(L, rec); }
  }));
  offs.push(sim.events.on('playerDied', (e) => { patrol.dropFor(e.person); watch.reset(); }));
  offs.push(sim.events.on('gameOver', () => { patrol.clear(); watch.reset(); }));

  // ---- hostile near: a patrol on the player's heels means no hurrying and no sleeping ----
  const prevHostile = sim.hostileNear;
  sim.hostileNear = () => patrol.hostile() || prevHostile();

  // ---- a game loaded while the player was a prisoner: they are in the cell, bound ----
  {
    const rec = L.store.captiveOf(L.playerId);
    if (rec) {
      if (rec.led) {
        // the walk was not saved: they were put in the cell
        const place = L.holdingPlace(rec.settlement, rec.house);
        rec.led = false; rec.settlement = place.settlement; rec.building = place.building?.id ?? -1;
      }
      restrainPlayer(L, rec);
    }
  }

  const prisoners = (settlement?: number): CaptivityView[] => {
    const out: CaptivityView[] = [];
    const seen = new Set<PersonId>();
    for (const rec of L.store.data.captives) {
      if (settlement !== undefined && rec.settlement !== settlement) continue;
      out.push(viewOf(L, rec));
      seen.add(rec.person);
    }
    for (const c of L.military?.captives?.() ?? []) {
      if (seen.has(c.person)) continue;
      const v = warView(L, c.person);
      if (v && (settlement === undefined || v.settlement === settlement)) out.push(v);
    }
    return out;
  };

  const api: LawRuntime = {
    patrolFor: (person) => { const p = patrol.get(person); return p ? patrol.view(p) : null; },
    patrolChoices: (person) => patrol.choices(person),
    answerPatrol: (person, choice) => patrol.answer(person, choice),
    captivity: (person) => {
      const rec = L.store.captiveOf(person);
      return rec ? viewOf(L, rec) : warView(L, person);
    },
    captivityChoices: (person) => captivityChoices(L, person),
    chooseInCaptivity: (person, choice) => chooseInCaptivity(L, person, choice),
    prisoners,
    version: () => L.store.rev,
    wanted: (person) => L.store.data.wanted.filter((w) => w.person === person && w.until > L.day).map((w) => ({ settlement: w.settlement, until: w.until })),
    report: (person, x, z) => {
      const p = L.person(person);
      return !!p && watch.report(p, x, z);
    },
    seize: (person, captor, kind, settlement, cause) => {
      const p = L.alive(person);
      if (!p) return false;
      const rec = seizePerson(L, p, captor, kind, settlement, cause ?? (kind === 'poaching' ? "poaching the lord's deer" : 'trespass'), { level: kind === 'war' ? 'hostile' : 'private' });
      if (rec && person === L.playerId) restrainPlayer(L, rec);
      return !!rec;
    },
    dispose: () => {
      patrol.clear();
      for (const off of offs.splice(0)) off();
      sim.hostileNear = prevHostile;
      if (sim.services.law === api) delete sim.services.law;
    },
  };
  sim.services.law = api;
  return api;
}
