// Timing budgets of the combat module (run alone: `npm run test:perf`). A 20-against-20 fight, archers and
// beasts included, must cost far less than a frame: < 1 ms per sub-step on average, no spike over 8 ms.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/time';
import { adultMen, combatRig, setStats } from './helpers';

const KITS = [
  { weapon: 'sword', shield: 'shield', armour: ['padded_armour'] },
  { weapon: 'spear', armour: [] as string[] },
  { weapon: 'axe', armour: ['cap_helmet'] },
  { weapon: 'bill', armour: ['mail_hauberk'] },
  { weapon: 'dagger', ranged: 'shortbow', armour: [] as string[] },
];

/** Builds the 20 v 20 scene; `profile` turns the scheduler's timers on. */
function scene(seed: string, profile: boolean) {
  const r = combatRig({ seed, preset: 'small' });
  const men = adultMen(r.sim, 40, 16, 50);
  men.forEach((p, i) => { setStats(p, { str: 11, agi: 11, end: 12 }); p.needs.hunger = 1; r.combat.arena.setKitOverride(p.id, KITS[i % KITS.length]); });
  r.sim.scheduler.profiling = profile;
  const id = r.combat.engage([
    { faction: 'red', people: men.slice(0, 20).map((p) => p.id) },
    { faction: 'blue', people: men.slice(20).map((p) => p.id) },
  ], { at: { x: 800, z: 800 }, yieldAllowed: true });
  return { r, id };
}

describe('combat performance', () => {
  it('a 20 v 20 fight costs under 1 ms per sub-step on average, never over 8 ms', () => {
    // a throw-away fight first: the budget is for steady state, not for the engine compiling the module
    const warm = scene('perf-warm', false);
    for (let i = 0; i < 20 * 12 && warm.r.combat.anyFight!(); i++) warm.r.sim.step(SIM_DT);
    // best of three identical, deterministic fights: a machine busy with other work only ever adds time
    let mean = Infinity, max = Infinity, steps = 0;
    for (let run = 0; run < 3; run++) {
      const { r, id } = scene('perf', true);
      expect(id).toBeGreaterThan(0);
      steps = 0;
      for (let i = 0; i < 20 * 60 && r.combat.anyFight!(); i++) { r.sim.step(SIM_DT); steps++; }
      const prof = r.sim.scheduler.profile.get('combat.step')!;
      mean = Math.min(mean, prof.totalMs / prof.calls);
      max = Math.min(max, prof.maxMs);
    }
    const line = `20v20: ${steps} sub-steps, combat.step mean ${mean.toFixed(3)} ms, max ${max.toFixed(2)} ms`;
    console.log(line);
    if (process.env.PERF_LOG) appendFileSync(process.env.PERF_LOG, line + '\n');
    expect(steps).toBeGreaterThan(100);
    expect(mean).toBeLessThan(1);
    expect(max).toBeLessThan(8);
  });

  it('with no fight going the module is free', () => {
    const r = combatRig({ seed: 'idle', preset: 'small' });
    r.sim.scheduler.profiling = true;
    for (let i = 0; i < 20 * 20; i++) r.sim.step(SIM_DT);
    const prof = r.sim.scheduler.profile.get('combat.step')!;
    expect(prof.totalMs / prof.calls).toBeLessThan(0.05);
  });
});
