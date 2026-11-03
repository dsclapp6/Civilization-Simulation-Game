// The army campaign (docs/WAR.md §6): march, night camp, the dawn storm, the retreat, and the castle scenario.
import { describe, expect, it } from 'vitest';
import { CampaignMode } from '../../src/app/campaign';
import { castleScenario } from '../../src/app/scenarios';
import { militaryContext } from '../../src/sim/military';
import { milSim } from '../sim/military/helpers';

function rig(seed: string) {
  const ctx = milSim({ seed, body: true });
  const { sim, mil } = ctx;
  const zone = { nav: { walkable: () => true, nearestWalkable: () => false }, agent: () => null, agents: () => [], command: () => undefined, summon: () => undefined, dismiss: () => undefined } as never;
  const player = {
    body: () => ({ x: ctx.body.x, y: 0, z: ctx.body.z, yaw: 0 }),
    placeAt: (x: number, z: number) => { ctx.body.x = x; ctx.body.z = z; },
  } as never;
  const campaign = new CampaignMode(sim, zone, player);
  return { ...ctx, campaign, M: militaryContext(sim), mil };
}

/** Runs the world on as the game does: the sim steps, the campaign looks, until `done()` or the time is out. */
function run(t: ReturnType<typeof rig>, seconds: number, done: () => boolean = () => false): void {
  for (let i = 0; i < seconds * 4 && !done(); i++) { t.sim.step(0.25); t.campaign.update(0.25); }
}

describe('the army campaign', () => {
  it('the castle scenario: 250 against 300, afternoon, a knight in the lord\'s host; the days pass on the road and the host camps at nightfall', () => {
    const t = rig('camp-a');
    const r = castleScenario({ sim: t.sim, campaign: t.campaign });
    expect(r).toMatchObject({ ok: true });
    const A = t.M.army(t.campaign.army)!;
    expect(A.men.length).toBeGreaterThanOrEqual(250);
    expect(t.mil.assaultPlan!(A.id)!.defenders).toBeGreaterThanOrEqual(295);
    // you are one of the host, fighting as a knight of the lord (and can go back to him)
    expect(A.men).toContain(t.sim.state.run.playerId);
    expect(t.sim.state.run.liege).toBeTruthy();
    expect(t.campaign.phase).toBeTruthy();
    // the afternoon of the first day
    expect((t.sim.absDay % 1) * 24).toBeGreaterThan(14);
    const seen = new Set<string>();
    let tents = 0;
    run(t, 3000, () => {
      const p = t.campaign.phase;
      if (p) seen.add(p);
      if (p === 'camp' || p === 'before') tents = Math.max(tents, [...t.sim.state.buildings.values()].filter((b) => b.kind === 'tent').length);
      return seen.has('storm');
    });
    // night falls on the road or before the walls: a camp of tents; at first light the camp is struck and the storm goes in
    expect(seen.has('camp') || seen.has('before')).toBe(true);
    expect(tents).toBeGreaterThan(0);
    expect(seen.has('storm')).toBe(true);
    expect([...t.sim.state.buildings.values()].filter((b) => b.kind === 'tent').length).toBe(0);
  });

  it('first light breaks the camp; the storm goes in and the campaign ends with the storm', () => {
    const t = rig('camp-b');
    expect(castleScenario({ sim: t.sim, campaign: t.campaign }).ok).toBe(true);
    const seen = new Set<string>();
    run(t, 4000, () => { const p = t.campaign.phase; if (p) seen.add(p); return !p && seen.size > 0; });
    expect(seen.has('storm') || seen.has('before')).toBe(true);
    expect(t.campaign.phase).toBeNull();
  });

  it('sounding the retreat on the march turns the host for home and ends the campaign', () => {
    const t = rig('camp-c');
    expect(castleScenario({ sim: t.sim, campaign: t.campaign }).ok).toBe(true);
    const id = t.campaign.army;
    const r = t.campaign.retreat();
    expect(r.ok).toBe(true);
    expect(t.campaign.phase).toBeNull();
    expect(t.M.army(id)?.intent).toBe('return');
    // and with no campaign there is nothing to retreat from
    expect(t.campaign.retreat().ok).toBe(false);
  });
});
