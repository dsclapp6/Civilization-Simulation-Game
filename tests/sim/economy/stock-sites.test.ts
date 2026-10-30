// Livestock work is offered only where the animals are kept: milking at the cowshed (or the longhouse), never at a townhouse door.
import { describe, expect, it } from 'vitest';
import { econSim, find, makeFarmer, optionsFor } from './helpers';

describe('livestock work sites', () => {
  it('offers milking at a cowshed but not at a townhouse, and shearing only at a sheepfold', () => {
    const { sim } = econSim({ seed: 'stock-sites', preset: 'tiny' });
    const { player, hh } = makeFarmer(sim, { age: 20, strips: 3 });
    hh.stores.cow = 3;
    hh.stores.sheep = 8;
    sim.state.touchHousehold(hh);
    const sid = player.settlement;
    const b = [...sim.state.buildings.values()].find((x) => x.settlement === sid);
    expect(b).toBeDefined();
    if (!b) return;
    const ids = (kind: string): string[] => {
      b.kind = kind as typeof b.kind;
      b.household = hh.id;
      return optionsFor(sim, { kind: 'building', id: b.id }).filter((o) => o.id.startsWith('stock.')).map((o) => o.id);
    };
    expect(ids('townhouse')).toEqual([]);
    expect(ids('manor_house')).toEqual([]);
    expect(ids('cowshed')).toContain('stock.milk');
    expect(ids('cowshed')).not.toContain('stock.shear');
    expect(ids('sheepfold')).not.toContain('stock.milk');
    expect(find(optionsFor(sim, { kind: 'building', id: b.id }), 'stock.milk')).toBeUndefined();
  });
});
