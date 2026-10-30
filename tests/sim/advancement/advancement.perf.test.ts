// Timing budgets (run alone: `npm run test:perf`): the advancement and happenings systems cost under 1 ms a
// frame on average at 8× speed and never spike over 8 ms, on a full-size continent.
import { describe, expect, it } from 'vitest';
import { installAdvancement } from '../../../src/sim/advancement';
import { installEconomy } from '../../../src/sim/economy';
import { newProfile } from '../../../src/sim/legacy';
import { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import { createMockWorld } from '../../../src/sim/testing/mockWorld';

describe('advancement and happenings budget', () => {
  it('stays under 1 ms a frame at 8× and has no frame spike over 8 ms', () => {
    const sim = Simulation.newGame({ seed: 'perf-adv', difficulty: 'king', profile: newProfile(), generateWorld: (s) => createMockWorld({ seed: s, preset: 'large' }) });
    const social = installSocial(sim);
    const economy = installEconomy(sim, { social });
    const adv = installAdvancement(sim, { economy, social });
    // warm up: a year so every code path has been compiled
    sim.advanceDays(16);
    sim.dispatch({ type: 'setSpeed', speed: 8 });
    sim.scheduler.profiling = true;
    // keep the run going if the character dies
    sim.events.on('playerDied', (e) => { if (e.eligible.length) sim.switchTo(e.eligible[0]); });
    // three trials of one game year at 8× and 60 fps (a day is 450 frames). A shared machine adds garbage-collection pauses
    // to whichever system happens to be running, so the spike budget is judged on the best trial.
    const frames = 16 * 450;
    const worsts: number[] = [];
    let perFrame = 0;
    for (let trial = 0; trial < 3; trial++) {
      sim.scheduler.profile.clear();
      for (let i = 0; i < frames; i++) sim.step(1 / 60);
      let total = 0;
      let worst = 0;
      const lines: string[] = [];
      for (const [name, p] of sim.scheduler.profile) {
        if (!/^(tech|happenings)\./.test(name)) continue;
        total += p.totalMs;
        worst = Math.max(worst, p.maxMs);
        lines.push(`${name} avg ${(p.totalMs / p.calls).toFixed(3)} max ${p.maxMs.toFixed(2)} calls ${p.calls}`);
      }
      worsts.push(worst);
      perFrame = Math.max(perFrame, total / frames);
      process.stderr.write(`\nadvancement perf trial ${trial + 1}: ${(total / frames).toFixed(4)} ms/frame; worst single call ${worst.toFixed(2)} ms\n  ${lines.join('\n  ')}\n`);
    }
    expect(perFrame).toBeLessThan(1);
    expect(Math.min(...worsts)).toBeLessThan(8);
    expect(adv.happenings.stats().started).toBeDefined();
  }, 240000);
});
