// J5: a crossbowman fights close with the crossbow kit (slow reload, bolts, high penetration), not a bow.
import { describe, expect, it } from 'vitest';
import { gearOf, type GearEnv } from '../../src/combat/gear';
import { RANGED } from '../../src/combat/weapons';
import { adultMen, combatRig } from './helpers';

describe('a crossbowman in a detail fight', () => {
  it('carries the crossbow and bolts where an archer carries the longbow and arrows', () => {
    const { sim, economy } = combatRig();
    const env: GearEnv = {
      state: sim.state, economy, absDay: sim.absDay,
      appearance: { get: () => ({ look: {} }) as never },
    };
    const [a, b] = adultMen(sim, 2);
    a.career = 'crossbowman';
    b.career = 'archer';
    const x = gearOf(env, a), y = gearOf(env, b);
    expect(x.ranged?.type).toBe('crossbow');
    expect(x.ranged?.ammo).toBe('bolt');
    expect(y.ranged?.type).toBe('bow');
    // slow to reload, hard to stop
    expect(x.ranged!.reload).toBeGreaterThan(RANGED.longbow.reload * 5);
    expect(x.ranged!.ap).toBeGreaterThan(RANGED.longbow.ap);
    expect(x.ammo).toBeGreaterThan(0);
  });
});
