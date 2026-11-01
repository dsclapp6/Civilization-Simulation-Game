// Nameplates and names (clarity pass): the full name, the relation · role line, the tone, the range, the quest and
// track marks, and the readable labels of buildings, strips and parcels.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PLATE_RANGE_FAR, PLATE_RANGE_NEAR } from '../../src/agents/plates';
import { buildingName, compassWord, stripName } from '../../src/agents/names';
import { fullName } from '../../src/sim/state';
import type { InteractCandidate } from '../../src/agents/types';
import type { Settlement } from '../../src/world/types';
import { makeRig, run, setClock, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
}, 180000);

beforeEach(() => {
  rig.sim.view.setSource('mode', () => 'street');
  rig.zone.detachPlayer();
  rig.focus.x = vil.x; rig.focus.z = vil.z;
  setClock(rig.sim, 1, 2, 0.4);
  rig.zone.resync();
});

describe('nameplates', () => {
  it('give every agent a full name, a second line, a tone and a range', () => {
    const { zone } = rig;
    expect(zone.agentsArr.length).toBeGreaterThan(10);
    for (const a of zone.agentsArr) {
      expect(a.draw.label).toBe(fullName(a.person));
      expect(a.draw.labelTone).toBeTruthy();
      expect([PLATE_RANGE_NEAR, PLATE_RANGE_FAR, 30]).toContain(a.draw.labelRange);
      // a nameplate is never the placeholder text of an unresolved relation
      expect(a.draw.sublabel ?? '').not.toMatch(/undefined|\[object/);
    }
  });

  it('says what somebody is to the player: kin in gold with the longer range, strangers in grey', () => {
    const { zone, sim } = rig;
    const me = sim.state.persons.get(sim.state.run.playerId)!;
    const hh = sim.state.households.get(me.household)!;
    const kin = hh.members.map((id) => sim.state.persons.get(id)!).find((p) => p.id !== me.id && !p.death);
    expect(kin, 'the player has family').toBeTruthy();
    // put the focus at the player's home so the family is in the zone
    const home = sim.state.buildings.get(hh.home)!;
    rig.focus.x = home.x; rig.focus.z = home.z;
    setClock(sim, 1, 2, 0.46);
    zone.resync();
    zone.summon?.(kin!.id, home.x + 3, home.z + 3);
    const a = zone.agent(kin!.id) as unknown as { draw: { label?: string; sublabel?: string; labelTone?: string; labelRange?: number } } | null;
    expect(a).toBeTruthy();
    expect(a!.draw.labelTone).toBe('kin');
    expect(a!.draw.labelRange).toBe(PLATE_RANGE_NEAR);
    expect(a!.draw.sublabel).toMatch(/^your /);
    // someone from another household who is no kin is a stranger or neighbour with the short range
    const other = zone.agentsArr.find((x) => x.person.household !== me.household && x.draw.labelTone === 'stranger');
    if (other) expect(other.draw.labelRange).toBe(PLATE_RANGE_FAR);
  });

  it('marks the askers of open requests and the tracked person, and clears the marks again', () => {
    const { zone } = rig;
    const a = zone.agentsArr.find((x) => !x.person.death && x.draw.mark === undefined)!;
    expect(a).toBeTruthy();
    zone.setQuestGivers?.([a.personId]);
    expect(a.draw.mark).toBe('quest');
    expect(a.draw.labelRange).toBe(PLATE_RANGE_NEAR);
    zone.setQuestGivers?.([]);
    expect(a.draw.mark).toBeUndefined();
    zone.setTrackedPerson?.(a.personId);
    expect(a.draw.mark).toBe('track');
    zone.setTrackedPerson?.(0);
    expect(a.draw.mark).toBeUndefined();
  });

  it('a spoken line replaces the plate while it lasts and the plate comes back after', () => {
    const { zone, sim } = rig;
    const a = zone.agentsArr[0];
    const name = a.draw.label;
    zone.say(a.personId, 'Good morrow!', 1);
    expect(a.draw.label).toBe('Good morrow!');
    expect(a.draw.sublabel).toBeUndefined();
    run(sim, 1.6);
    expect(a.draw.label).toBe(name);
  });
});

describe('names of things', () => {
  it('names the player\'s home, workshops after their keepers, churches after saints and inns after signs', () => {
    const { zone, sim } = rig;
    const ctx = { state: sim.state, world: sim.world };
    const me = sim.state.persons.get(sim.state.run.playerId)!;
    const hh = sim.state.households.get(me.household)!;
    expect(buildingName(ctx, sim.state.buildings.get(hh.home)!)).toBe('Your home');
    const sp = zone.places.of(vil.id)!;
    if (sp.church) expect(buildingName(ctx, sp.church)).toMatch(/^St [A-Z][a-z]+'s church$/);
    if (sp.alehouses[0]) expect(buildingName(ctx, sp.alehouses[0])).toMatch(/^The .+ \((alehouse|tavern)\)$/);
    const smithy = [...sim.state.buildings.values()].find((b) => b.kind === 'smithy' && b.household !== 0 && b.household !== me.household);
    if (smithy) expect(buildingName(ctx, smithy)).toMatch(/'s smithy$/);
    // the same building always has the same name
    if (sp.church) expect(buildingName(ctx, sp.church)).toBe(buildingName(ctx, sp.church));
  });

  it('names strips by owner, side of the village, crop and stage', () => {
    const { sim } = rig;
    const ctx = { state: sim.state, world: sim.world };
    const me = sim.state.persons.get(sim.state.run.playerId)!;
    const mine = vil.strips.map((id) => sim.state.strips.get(id)!).find((s) => s && s.holder === me.household);
    const any = sim.state.strips.get(vil.strips[0])!;
    const label = stripName(ctx, sim.world.strips[any.id], any);
    expect(label).toMatch(/strip/);
    expect(label).toMatch(/north|south|east|west/);
    if (mine) expect(stripName(ctx, sim.world.strips[mine.id], mine)).toMatch(/^Your family's /);
    const demesne = vil.strips.map((id) => sim.state.strips.get(id)!).find((s) => s && s.holder === 0);
    if (demesne) expect(stripName(ctx, sim.world.strips[demesne.id], demesne)).toMatch(/^The lord's /);
    expect(compassWord(0, 0, 10, 0)).toBe('east');
    expect(compassWord(0, 0, 0, -10)).toBe('north');
    expect(compassWord(0, 0, -10, 10)).toBe('south-west');
  });

  it('labels what the player can look at with the real names', () => {
    const { zone, sim } = rig;
    const sp = zone.places.of(vil.id)!;
    const out: InteractCandidate[] = [];
    const church = sp.church!;
    const d = zone.nav.doorOf(church.id)!;
    zone.interactables(d.x, d.z, d.yaw + Math.PI, 12, out);
    const c = out.find((x) => x.target.kind === 'building' && x.target.id === church.id);
    expect(c?.label).toMatch(/^St .+ church$/);
    void sim;
    const people = out.filter((x) => x.target.kind === 'person');
    for (const p of people) expect(p.label.length).toBeGreaterThan(2);
  });
});
