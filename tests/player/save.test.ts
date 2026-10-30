import { describe, expect, it } from 'vitest';
import { installPlayer } from '../../src/player';
import { installEconomy } from '../../src/sim/economy';
import { MemorySaveStore } from '../../src/sim/save-memory';
import { hashState } from '../../src/sim/serialize';
import { Simulation } from '../../src/sim/sim';
import { installSocial } from '../../src/sim/social';
import { mockGenerator } from '../sim/helpers';
import { FakeZone, input, rig, run } from './fakes';

async function reload(store: MemorySaveStore, setup?: (z: FakeZone) => void): Promise<{ sim: Simulation; zone: FakeZone; body: ReturnType<ReturnType<typeof installPlayer>['body']> }> {
  const sim = (await Simulation.load(store, mockGenerator('tiny')))!;
  const zone = new FakeZone();
  setup?.(zone);
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const player = installPlayer(sim, { zone, economy, social });
  return { sim, zone, body: player.body() };
}

describe('saving the player', () => {
  it('puts the character back where the run was left and continues identically (same state hash)', async () => {
    const store = new MemorySaveStore();
    const r = rig({ seed: 'psave', store, autosave: { intervalMs: 0 } });
    run(r, 3, { forward: 1, sprint: true });
    run(r, 1, {});
    const at = { ...r.player.body()! };
    r.player.persist!();
    await r.sim.flush();

    const loaded = await reload(store);
    expect(loaded.body!.x).toBeCloseTo(at.x, 1);
    expect(loaded.body!.z).toBeCloseTo(at.z, 1);
    expect(hashState(loaded.sim.state)).toBe(hashState(r.sim.state));
    for (let i = 0; i < 300; i++) { r.player.setInput(input()); r.sim.step(0.05); loaded.sim.step(0.05); }
    expect(hashState(loaded.sim.state)).toBe(hashState(r.sim.state));
  });

  it('spawns at the home door for a new run, and ignores a saved position of a previous character', async () => {
    const store = new MemorySaveStore();
    const r = rig({ seed: 'pswitch', store, autosave: { intervalMs: 0 } });
    const door = { ...r.player.body()! };
    run(r, 2, { forward: 1 });
    r.player.persist!();
    r.sim.state.ext['player'] = { v: 1, person: 999999, x: 5, z: 5, yaw: 0 };
    await r.sim.flush();
    const loaded = await reload(store);
    // the saved record belongs to someone else: the body starts at the home door instead
    expect(Math.hypot(loaded.body!.x - door.x, loaded.body!.z - door.z)).toBeLessThan(0.5);
  });

  it('remembers a ridden horse and takes it back if the zone still has it', async () => {
    const store = new MemorySaveStore();
    const r = rig({ seed: 'phorse', store, autosave: { intervalMs: 0 }, zone: (z) => { z.supportsClaims = true; } });
    const p = r.sim.state.persons.get(r.pid)!;
    const b = { ...r.player.body()! };
    r.zone.addAnimal(500, 'horse', b.x + 2, b.z, p.household);
    r.player.setInput(input({ mount: true }));
    r.sim.step(0.05);
    run(r, 2, {});
    expect(r.player.mounted!()).toBe(true);
    r.player.persist!();
    await r.sim.flush();
    const loaded = await reload(store);
    const player2 = loaded.zone.attached;
    expect(player2).not.toBeNull();
    expect(loaded.zone.claimed).toEqual([500]);
    expect(player2!.draw.mount?.coat).toBe(0x7a5032);
    loaded.sim.step(0.05);
    expect(loaded.sim.view.player()!.mounted).toBe(true);
  });
});
