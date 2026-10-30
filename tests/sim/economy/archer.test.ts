// Training at the butts (brief: wave2-econ): the archers' recruiter wants STR 10 and Archery 3. A 12-year-old
// with a strength potential of 11 or more who shoots at the butts reaches STR 10 by 14 or 15.
import { describe, expect, it } from 'vitest';
import { ageYears } from '../../../src/sim/state';
import { skillLevel, refreshTrained } from '../../../src/sim/people';
import { pickHome } from '../../../src/sim/succession';
import { bagAdd } from '../../../src/sim/economy/items';
import { econSim, playerOf, runWork } from './helpers';

describe('the archer test', () => {
  it('a 12-year-old with potential 11 who practises at the butts reaches STR 10 and Archery 3 by 15', () => {
    const { sim, eco } = econSim({ seed: 'butts' });
    const st = sim.state;
    const player = playerOf(sim);
    const hh = st.households.get(player.household)!;
    const butts = [...st.buildings.values()].find((b) => b.kind === 'archery_butts');
    expect(butts, 'the world has an archery butts').toBeTruthy();
    if (hh.settlement !== butts!.settlement) {
      const home = pickHome(st, sim.rng('test-home'), butts!.settlement, ['cottage', 'longhouse']);
      st.relocateHousehold(hh, butts!.settlement, home ? home.id : -1);
    }
    player.sex = 'm';
    player.birthDay = Math.round(sim.absDay - 12 * 16);
    player.potential.str = 11;
    player.skills.archery = 0;
    refreshTrained(player, ageYears(player, sim.absDay));
    bagAdd(player.inventory, 'longbow#1', 1);
    bagAdd(player.inventory, 'arrow#1', 24);
    st.touch(player);
    const str0 = player.trained.str;
    expect(str0).toBeLessThan(10);

    const test = eco.entryTests().find((t) => t.career === 'archer');
    expect(test, 'there is an archer recruiter test').toBeTruthy();
    expect(test!.stats.str).toBe(10);
    expect(test!.skills.archery).toBe(3);

    const home = { kind: 'building', id: hh.home } as const;
    const counts: Record<string, number> = {};
    let reached = -1;
    // shoot a few bouts every day (the village shoots together on holy days) for up to three years
    for (let day = 0; day < 48 && reached < 0; day++) {
      runWork(sim, { home, targets: [{ kind: 'building', id: butts!.id }], accept: /^arms\.practise/, days: 1, counts });
      if (player.trained.str >= 10 && skillLevel(player.skills.archery) >= 3) reached = ageYears(player, sim.absDay);
      // top up the arrows now and then (they are mostly picked up again)
      bagAdd(player.inventory, 'arrow#1', 2);
    }
    expect(counts['arms.practise'] ?? 0).toBeGreaterThan(30);
    expect(reached, `STR ${player.trained.str.toFixed(1)}, Archery ${skillLevel(player.skills.archery)}, ${JSON.stringify(counts)}`).toBeGreaterThan(0);
    expect(reached).toBeGreaterThan(12.5);
    expect(reached).toBeLessThan(15.5);
    expect(player.trained.str).toBeGreaterThan(str0);
  });
});
