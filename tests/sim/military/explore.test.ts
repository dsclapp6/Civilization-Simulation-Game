import { describe, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { milSim } from './helpers';

describe('explore', () => {
  it('prints realm', () => {
    const { sim } = milSim({ preset: 'small', seed: 'siege-a' });
    const M = militaryContext(sim);
    const rows: string[] = [];
    for (const s of sim.world.settlements) {
      const lord = M.realm.lordHouse(s.id);
      rows.push(`${s.id} ${s.kind} k${s.kingdom} lord=${lord} chain=${M.realm.chain(lord).join('>')}`);
    }
    console.log(rows.join('\n'));
    console.log([...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => `${h.id}:${h.seat}`).join(' '));
  });
});
