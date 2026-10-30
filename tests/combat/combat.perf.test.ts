// Timing budgets of the combat module (run alone: `npm run test:perf`). A 20-against-20 fight, archers and
// beasts included, must cost far less than a frame: < 1 ms per sub-step on average, no spike over 8 ms.
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/time';
import { adultMen, combatRig, setStats } from './helpers';

describe('combat performance', () => {
  it('a 20 v 20 fight costs under 1 ms per sub-step on average, never over 8 ms', () => {
    const r = combatRig({ seed: 'perf', preset: 'small' });
    const men = adultMen(r.sim, 40, 16, 50);
    const kits = [
      { weapon: 'sword', shield: 'shield', armour: ['padded_armour'] },
      { weapon: 'spear', armour: [] as string[] },
      { weapon: 'axe', armour: ['cap_helmet'] },
      { weapon: 'bill', armour: ['mail_hauberk'] },
      { weapon: 'dagger', ranged: 'shortbow', armour: [] as string[] },
    ];
    men.forEach((p, i) => { setStats(p, { str: 11, agi: 11, end: 12 }); p.needs.hunger = 1; r.combat.arena.setKitOverride(p.id, kits[i % kits.length]); });
    r.sim.scheduler.profiling = true;
    const id = r.combat.engage([
      { faction: 'red', people: men.slice(0, 20).map((p) => p.id) },
      { faction: 'blue', people: men.slice(20).map((p) => p.id) },
    ], { at: { x: 800, z: 800 }, yieldAllowed: true });
    expect(id).toBeGreaterThan(0);
    let steps = 0;
    for (let i = 0; i < 20 * 60 && r.combat.anyFight!(); i++) { r.sim.step(SIM_DT); steps++; }
    const prof = r.sim.scheduler.profile.get('combat.step')!;
    const mean = prof.totalMs / prof.calls;
    console.log(`20v20: ${steps} sub-steps, combat.step mean ${mean.toFixed(3)} ms, max ${prof.maxMs.toFixed(2)} ms`);
    expect(steps).toBeGreaterThan(100);
    expect(mean).toBeLessThan(1);
    expect(prof.maxMs).toBeLessThan(8);
  });

  it('with no fight going the module is free', () => {
    const r = combatRig({ seed: 'idle', preset: 'small' });
    r.sim.scheduler.profiling = true;
    for (let i = 0; i < 20 * 20; i++) r.sim.step(SIM_DT);
    const prof = r.sim.scheduler.profile.get('combat.step')!;
    expect(prof.totalMs / prof.calls).toBeLessThan(0.05);
  });
});
