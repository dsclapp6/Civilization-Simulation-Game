// The smith's ladder (brief: wave2-econ): a free-born boy is bound apprentice to the village smith for a
// premium, fetches and strikes until his skill is good enough, becomes a journeyman at the end of the term,
// then makes his masterpiece for the guild and sets up on his own.
import { describe, expect, it } from 'vitest';
import { skillLevel, xpForLevel } from '../../../src/sim/people';
import { CAREERS } from '../../../src/sim/careers';
import { econSim, find, makeApprentice, optionsFor, perform, runWork } from './helpers';
import { bagAdd } from '../../../src/sim/economy/items';

describe("the smith's ladder", () => {
  it('apprentice to journeyman to master', () => {
    const { sim, eco } = econSim({ seed: 'smith' });
    const { player, hh, job, shop } = makeApprentice(sim, { age: 12, title: 'Apprentice smith' });
    const smithy = { kind: 'building', id: shop } as const;

    // ---- find the post and pay the premium out of the family purse ----
    expect(job.terms).toBe('apprenticeship');
    expect(job.premium).toBeGreaterThan(0);
    expect(job.requirements.every((r) => r.met), JSON.stringify(job.requirements)).toBe(true);
    const purse0 = hh.purse + player.money;
    const applied = eco.applyForJob(player.id, job.id);
    expect(applied.ok, applied.reason).toBe(true);
    const emp = eco.employment(player.id)!;
    expect(emp.terms).toBe('apprenticeship');
    expect(emp.career).toBe('smith');
    expect(CAREERS[player.career].field).toBe('craft');
    expect(player.careerStage).toBe(0);
    const bound = sim.state.persons.get(emp.employer)!;
    expect(player.household).toBe(bound.household); // he lives in the master's house
    expect(purse0).toBeGreaterThan(0);
    // a second application is refused: he is already bound
    expect(eco.applyForJob(player.id, job.id).ok).toBe(false);

    // ---- fetch, pump the bellows and strike: skill grows, the body with it ----
    const counts: Record<string, number> = {};
    const str0 = player.trained.str;
    const home = { kind: 'building', id: sim.state.households.get(player.household)!.home } as const;
    runWork(sim, { home, targets: [smithy], accept: /^appr\./, days: 40, until: () => skillLevel(player.skills.smithing) >= 3, counts });
    const learned = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(learned).toBeGreaterThan(10);
    expect(skillLevel(player.skills.smithing)).toBeGreaterThanOrEqual(3);
    expect(player.trained.str).toBeGreaterThan(str0);

    // ---- the term runs out: a journeyman with a yearly wage ----
    expect(emp.until).toBeGreaterThan(sim.absDay + 50); // an apprenticeship is years long
    sim.advanceDays(Math.ceil(emp.until - sim.absDay) + 2);
    expect(sim.state.run.phase).toBe('alive');
    const after = eco.employment(player.id)!;
    expect(after, 'still employed').toBeTruthy();
    expect(after.terms).toBe('year');
    expect(after.wage).toBeGreaterThanOrEqual(2.5);
    expect(player.careerStage).toBe(1);

    // ---- a journeyman earns his wage from the master's purse ----
    const before = player.money;
    sim.advanceDays(8);
    expect(player.money).toBeGreaterThan(before);

    // ---- the masterpiece: skill 8, the materials twice over, and the masters' judgement ----
    player.skills.smithing = xpForLevel(8) + 5;
    sim.state.touch(player);
    const offer0 = find(optionsFor(sim, smithy), 'craft.masterpiece');
    expect(offer0, 'a journeyman is offered the masterpiece at the forge').toBeTruthy();
    const need = offer0!.enabled ? [] : offer0!.reason ?? '';
    expect(need.length === 0 || /needs/i.test(String(need))).toBe(true);
    // give him what the masterpiece asks for
    for (const k of ['iron', 'charcoal', 'nails', 'timber', 'planks']) bagAdd(player.inventory, k, 40);
    player.money += 200;
    let master = false;
    for (let attempt = 0; attempt < 12 && !master; attempt++) {
      const o = find(optionsFor(sim, smithy), 'craft.masterpiece');
      if (!o || !o.enabled) break;
      const r = perform(sim, o);
      if (r.ok) master = true;
      for (const k of ['iron', 'charcoal', 'nails', 'timber', 'planks']) bagAdd(player.inventory, k, 20);
    }
    expect(master, 'the guild passes the masterpiece').toBe(true);
    expect(player.careerStage).toBe(2);
    expect(eco.employment(player.id)).toBeNull(); // he works for himself now
    const hh2 = sim.state.households.get(player.household)!;
    expect(hh2.head).toBe(player.id); // and keeps his own house
    expect(player.rankTier).toBeGreaterThanOrEqual(3);
  });
});
