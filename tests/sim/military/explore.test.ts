import { describe, it } from 'vitest';
import { milSim } from './helpers';

describe('explore', () => {
  it('prints forces', () => {
    const { sim, mil } = milSim({ preset: 'large', seed: 'explore' });
    const rows: string[] = [];
    let n = 0;
    for (const h of sim.state.houses.values()) {
      if (h.kind !== 'royal' && h.kind !== 'noble') continue;
      const f = mil.forces(h.id);
      if (n++ < 40 || h.kind === 'royal') rows.push(`${h.id} ${h.kind} ${h.name} seat=${h.seat} ret=${f.retinue} gar=${f.garrison} pool=${f.levyPool} mil=${f.militia} str=${f.strength}`);
    }
    console.log(rows.join('\n'));
    console.log('settlements', sim.world.settlements.length, 'houses', sim.state.houses.size, 'pop', sim.state.population);
  });
});
