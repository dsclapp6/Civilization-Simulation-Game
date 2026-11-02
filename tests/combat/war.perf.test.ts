// Timing budgets of war in the zone (run alone: `npm run test:perf`, or `PERF=1 npx vitest run tests/combat/war.perf.test.ts`).
// A field battle and a storm of 60 a side, with groups, formations, the AI commander on both sides, archers, a ram and ladders, must
// cost what the arena's own budget allows (tests/combat/combat.perf.test.ts): < 1 ms per sub-step on average, no spike over 8 ms.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/time';
import { adultMen, combatRig, setStats } from './helpers';
import { storm } from './stormHelpers';

const KITS = [
  { weapon: 'sword', shield: 'shield', armour: ['padded_armour'] },
  { weapon: 'spear', armour: [] as string[] },
  { weapon: 'axe', armour: ['cap_helmet'] },
  { weapon: 'bill', armour: ['mail_hauberk'] },
  { weapon: 'dagger', ranged: 'shortbow', armour: [] as string[] },
];

const N = 60;

type Scene = { r: ReturnType<typeof combatRig>; fighting: () => boolean };

/** A field battle of N a side (the macro battle's own reason, so groups, the commander and morale are all in play). */
function battle(seed: string): Scene {
  const r = combatRig({ seed, preset: 'small' });
  const men = adultMen(r.sim, N * 2, 16, 50);
  men.forEach((p, i) => { setStats(p, { str: 11, agi: 11, end: 12 }); p.needs.hunger = 1; r.combat.arena.setKitOverride(p.id, KITS[i % KITS.length]); });
  r.sim.scheduler.profiling = true;
  r.combat.engage([
    { faction: 'house:1', people: men.slice(0, N).map((p) => p.id) },
    { faction: 'house:2', people: men.slice(N).map((p) => p.id) },
  ], { at: { x: 800, z: 800 }, yieldAllowed: true, reason: 'battle' });
  return { r, fighting: () => r.combat.anyFight!() };
}

/** A storm of the walled ring: N a side, a fifth of the defenders and a third of the attackers shoot. */
function assault(seed: string): Scene {
  const t = storm(seed, { archers: Math.round(N * 0.35), foot: Math.round(N * 0.65) }, { archers: Math.round(N * 0.2), foot: Math.round(N * 0.8) }, { rams: 1, ladders: 3 });
  t.r.sim.scheduler.profiling = true;
  return { r: t.r, fighting: () => t.r.combat.anyFight!() };
}

/** Best of three identical, deterministic fights after a throw-away one: a machine busy with other work only ever adds time. */
function measure(make: (seed: string) => Scene, label: string): { mean: number; max: number; steps: number } {
  const warm = make('war-perf-warm');
  for (let i = 0; i < 20 * 15 && warm.fighting(); i++) warm.r.sim.step(SIM_DT);
  let mean = Infinity, max = Infinity, steps = 0;
  for (let run = 0; run < 3; run++) {
    const s = make('war-perf');
    steps = 0;
    for (let i = 0; i < 20 * 90 && s.fighting(); i++) { s.r.sim.step(SIM_DT); steps++; }
    const prof = s.r.sim.scheduler.profile.get('combat.step')!;
    mean = Math.min(mean, prof.totalMs / prof.calls);
    max = Math.min(max, prof.maxMs);
  }
  const line = `${label}: ${steps} sub-steps, combat.step mean ${mean.toFixed(3)} ms, max ${max.toFixed(2)} ms`;
  console.log(line);
  if (process.env.PERF_LOG) appendFileSync(process.env.PERF_LOG, line + '\n');
  return { mean, max, steps };
}

describe('war performance', () => {
  it(`a field battle of ${N} a side (groups, formations, commanders) costs under 1 ms per sub-step on average, never over 8 ms`, () => {
    const m = measure(battle, `${N}v${N} battle`);
    expect(m.steps).toBeGreaterThan(200);
    expect(m.mean).toBeLessThan(1);
    expect(m.max).toBeLessThan(8);
  });

  it(`a storm of ${N} a side (walls manned, ram, ladders, shots from the height) costs under 1 ms per sub-step on average, never over 8 ms`, () => {
    const m = measure(assault, `${N}v${N} storm`);
    expect(m.steps).toBeGreaterThan(200);
    expect(m.mean).toBeLessThan(1);
    expect(m.max).toBeLessThan(8);
  });
});
