// Outposts claim the wild land round them (about 600 m) for their House and their parent settlement, and the deposits there
// join the parent's resources.
import { describe, expect, it } from 'vitest';
import { TERRITORY } from '../../../src/sim/territory';
import { mkHouse, mkPerson } from '../builders';
import { mockRig, scriptedConstruction, scriptedPolitics } from './helpers';

describe('outposts', () => {
  const rig = mockRig({ preset: 'small', seed: 'outposts' });
  const { terr, sim, world } = rig;
  const st = sim.state;
  const silver = world.deposits!.find((d) => d.kind === 'silver')!;
  const parent = world.settlements.find((s) => s.kind === 'village' && st.titleFor('manor', s.id))!;
  const owner = terr.ownerOf!(parent.id);
  const fake = scriptedConstruction(sim, []);
  const camp = { x: silver.x + 100, z: silver.z };

  it('leaves wild land wild until an outpost is founded', () => {
    expect(silver.settlement).toBe(-1);
    expect(terr.landAt(camp.x, camp.z)).toMatchObject({ kind: 'wild', settlement: -1, house: 0 });
    expect(terr.resources(parent.id).deposits.map((d) => d.id)).not.toContain(silver.id);
  });

  it('claims the land within 600 m for the outpost\'s House and its parent settlement', () => {
    const v = terr.version();
    fake.found({ id: 1, name: 'Silverbeck', settlement: parent.id, x: camp.x, z: camp.z, deposit: silver.id, founded: sim.absDay });
    expect(terr.version()).toBeGreaterThan(v);
    expect(TERRITORY.outpostClaim).toBe(600);
    for (const d of [0, 200, 500, 590]) {
      const land = terr.landAt(camp.x + d, camp.z);
      expect(land, `${d} m`).toMatchObject({ settlement: parent.id, house: owner.house, title: owner.title });
      expect(land.kind).toBe('wild');
      expect(terr.settlementOf(camp.x + d, camp.z)).toBe(parent.id);
    }
    // the deposit itself (100 m away) is the House's now
    expect(terr.landAt(silver.x, silver.z).house).toBe(owner.house);
    // beyond the claim it is wild again
    expect(terr.landAt(camp.x + 640, camp.z)).toMatchObject({ kind: 'wild', settlement: -1, house: 0 });
  });

  it('does not take land that already has a lord: a settlement\'s lands win over an outpost\'s claim', () => {
    const other = world.settlements.find((s) => s.kind === 'village' && s.id !== parent.id)!;
    const oOwner = terr.ownerOf!(other.id);
    const here = { x: other.x + 300, z: other.z };
    const before = terr.landAt(here.x, here.z);
    fake.found({ id: 2, name: 'Squatters', settlement: parent.id, x: here.x, z: here.z, deposit: -1, founded: sim.absDay });
    const after = terr.landAt(here.x, here.z);
    expect(after.settlement).toBe(before.settlement);
    expect(after.house).toBe(before.house);
    expect(after.house).toBe(oOwner.house);
    fake.outposts.pop();
    terr.refresh();
  });

  it('adds the deposits it claims to its parent\'s resources', () => {
    terr.refresh();
    const profile = terr.resources(parent.id);
    expect(profile.deposits.map((d) => d.id)).toContain(silver.id);
    expect(profile.yields).toContain('silver_ore');
  });

  it('makes hostile what an enemy of the House finds there, as on any of its land', () => {
    const pol = scriptedPolitics(sim);
    const enemyHouse = mkHouse(sim, 'Raiders').id;
    const raider = mkPerson(sim, { settlement: world.settlements.find((s) => s.id !== parent.id && s.kind === 'village')!.id, house: enemyHouse });
    expect(terr.trespass(raider.id, camp.x, camp.z).level).toBe('none');
    const w = pol.war([owner.house], [enemyHouse]);
    terr.refresh();
    const t = terr.trespass(raider.id, camp.x, camp.z);
    expect(t).toMatchObject({ level: 'hostile', cause: 'war', lord: owner.lord });
    expect(t.land.house).toBe(owner.house);
    pol.endWar(w.id);
    terr.refresh();
  });

  it('gives the land back when the outpost is gone', () => {
    fake.outposts.length = 0;
    terr.refresh();
    expect(terr.landAt(camp.x, camp.z)).toMatchObject({ kind: 'wild', settlement: -1, house: 0 });
    expect(terr.resources(parent.id).deposits.map((d) => d.id)).not.toContain(silver.id);
  });
});
