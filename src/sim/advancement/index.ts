// Advancement and happenings (wave 3, SPEC §17-§21).
//
// `installAdvancement(sim, deps)` registers
//   sim.services.advancement  the House trees: four branches of techniques held by people
//   sim.services.happenings   events, disasters, festivals and requests to the player (src/sim/happenings)
// and returns the advancement runtime (with `.happenings`). Both work headless: zone and player are optional.
import { DAYS_PER_YEAR } from '../../core/time';
import type { Simulation } from '../sim';
import { fullName, type PersonId } from '../state';
import type { Wave3Deps } from '../wave3deps';
import { installHappenings, type HappeningsInstall } from '../happenings';
import { Adv } from './core';
import { BRANCHES, TECHS, TECH_BY_ID } from './data';
import { canLearn, libraryLost, onDeath, practice, settlementYear } from './learning';
import { listenToActions, studyProvider, teach, techTopics } from './topics';
import type { AdvancementRuntime, TechState, TechView } from './types';

export type { AdvancementRuntime, BranchDef, BranchId, TechDef, TechView, TechState } from './types';
export { TECHS, BRANCHES } from './data';

export type AdvancementInstall = AdvancementRuntime & { happenings: HappeningsInstall; adv: Adv };

const installed = new WeakMap<Simulation, AdvancementInstall>();

export function installAdvancement(sim: Simulation, deps: Wave3Deps): AdvancementInstall {
  const existing = installed.get(sim);
  if (existing) return existing;
  const A = new Adv(sim, deps);
  if (A.save.init === 0) {
    seedKnowledge(A);
    A.save.init = 1;
    A.touch();
  }

  const offs: Array<() => void> = [];
  // the yearly pass of each settlement runs on its own day and hour
  offs.push(sim.registerSystem({
    name: 'tech.settlements', phase: 'hourly', order: 60,
    run: (_ctx, info) => {
      for (const s of sim.world.settlements) {
        if (info.day % DAYS_PER_YEAR !== s.id % DAYS_PER_YEAR) continue;
        const part = (info.hour - ((s.id * 5) % 24) + 24) % 24;
        if (part < 3) settlementYear(A, s, part as 0 | 1 | 2);
      }
    },
  }));
  offs.push(sim.events.on('death', (e) => onDeath(A, e.person)));
  offs.push(listenToActions(A));
  offs.push(sim.actions.register(studyProvider(A)));
  offs.push(deps.social.registerTopic(techTopics(A)));

  const api: AdvancementInstall = {
    adv: A,
    happenings: undefined as unknown as HappeningsInstall,
    knows: (person, tech) => A.knows(person, tech),
    houseHas: (house, tech) => A.houseHas(house, tech),
    bonus: (house, key) => A.effectOf(A.houseTechs(house), key),
    settlementHas: (settlement, tech) => (A.settlementCounts(settlement).get(tech) ?? 0) > 0,
    settlementBonus: (settlement, key) => A.settlementBonus(settlement, key),

    branches: () => BRANCHES,
    techs: () => TECHS,
    tech: (id) => TECH_BY_ID.get(id),
    techsOf: (person) => A.techsOf(person),
    holders: (tech) => A.holdersOf(tech),
    personBonus: (person, key) => A.effectOf(A.techsOf(person), key),
    isPreserved: (tech) => A.isPreserved(tech),
    isLost: (tech) => A.isLost(tech),
    tree: () => tree(A),
    teach: (teacher, learner, tech, opts) => teach(A, teacher, learner, tech, opts?.force === true),
    grant: (person, tech, via = 'granted') => {
      const p = sim.state.persons.get(person);
      return !!p && A.grant(p, tech, via);
    },
    addProgress: (tech, amount) => {
      const def = TECH_BY_ID.get(tech);
      const p = sim.state.persons.get(sim.state.run.playerId);
      if (def && p) practice(A, p, def, amount);
    },
    canLearn: (person, tech) => canLearn(A, sim.state.persons.get(person), TECH_BY_ID.get(tech)),
    libraryLost: (settlement) => libraryLost(A, settlement),
  };
  sim.services.advancement = api;
  installed.set(sim, api);
  api.happenings = installHappenings(sim, deps, api);
  return api;
}

/** The runtime installed in a simulation (tests, tools, the dev pages). */
export function advancementOf(sim: Simulation): AdvancementInstall | undefined { return installed.get(sim); }

// ---------------------------------------------------------------------------------------------
// Start of run
// ---------------------------------------------------------------------------------------------

/** Deals out the knowledge a medieval continent already has: a share of every qualified person knows each starting technique. */
function seedKnowledge(A: Adv): void {
  A.seeding = true;
  const rng = A.sim.rng('tech.seed');
  const order = TECHS.filter((t) => t.start > 0 && (t.year ?? 0) <= 0);
  const rank = new Map(order.map((t, i) => [t.id, i]));
  for (const p of A.state.persons.values()) {
    if (p.death || A.ageOf(p) < 14) continue;
    const cands = A.candidates(p).filter((t) => rank.has(t.id)).sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
    for (const def of cands) {
      if (!rng.chance(def.start)) continue;
      if (!A.qualifies(p, def) || !A.prereqsKnown(p, def)) continue;
      A.grant(p, def.id, 'seed');
    }
  }
  A.seeding = false;
}

// ---------------------------------------------------------------------------------------------
// The House tree
// ---------------------------------------------------------------------------------------------

function tree(A: Adv): TechView[] {
  const run = A.state.run;
  const player = A.state.persons.get(run.playerId);
  const out: TechView[] = [];
  for (const def of TECHS) {
    const holders = A.holdersOf(def.id);
    const houseHas = A.houseHas(run.houseId, def.id);
    const state: TechState = holders.length > 0 ? 'known' : A.isPreserved(def.id) ? 'preserved' : A.isLost(def.id) ? 'lost' : 'undiscovered';
    const missing = def.requires.filter((r) => !A.houseHas(run.houseId, r));
    const early = def.year !== undefined && A.year < def.year;
    const locked = !houseHas && (missing.length > 0 || early);
    const mine = !!player && A.knows(player.id, def.id);
    // the player's House first, then the rest
    const ids: PersonId[] = [];
    for (const id of holders) if (A.state.persons.get(id)?.house === run.houseId && ids.length < 6) ids.push(id);
    for (const id of holders) if (ids.length < 6 && !ids.includes(id)) ids.push(id);
    let note: string | undefined;
    if (early) note = `Nobody can work this out before year ${def.year}`;
    else if (missing.length > 0) note = `First needs ${missing.map((m) => TECH_BY_ID.get(m)?.name ?? m).join(' and ')}`;
    else if (state === 'preserved') note = 'Written in the books; someone literate must relearn it';
    else if (state === 'lost') note = 'Nobody living knows it and no book keeps it';
    out.push({
      def, state, locked, houseHas, mine, holders: holders.length, holderIds: ids,
      progress: A.save.prog[def.id] ?? 0, need: def.learn.player?.need ?? 0, missing, note,
    });
  }
  return out;
}

/** Names of the people holding a tech, for panels. */
export function holderNames(A: Adv, tech: string, limit = 6): string[] {
  const out: string[] = [];
  for (const id of A.holdersOf(tech)) {
    const p = A.state.persons.get(id);
    if (p && !p.death) out.push(fullName(p));
    if (out.length >= limit) break;
  }
  return out;
}
