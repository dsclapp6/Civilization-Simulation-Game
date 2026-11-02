// Who holds the land: the title over a settlement's lands, its holder's House, what happens when a title changes hands,
// is vacant, or is held by a child; and when `version()` moves.
import { describe, expect, it } from 'vitest';
import { mkHouse, mkPerson } from '../builders';
import { mockRig, scriptedConstruction, scriptedMilitary, scriptedPolitics } from './helpers';

describe('who holds the land', () => {
  const rig = mockRig({ preset: 'small', seed: 'owners' });
  const { terr, sim, world } = rig;
  const st = sim.state;
  const kindOf = (id: number): string => {
    const t = st.titles.get(terr.ownerOf!(id).title);
    return t ? t.kind : 'none';
  };

  it('finds the title by kind of place: manor for a village or hamlet, the lordship for a town, the abbey, the earl\'s county for his castle', () => {
    for (const s of world.settlements) {
      const o = terr.ownerOf!(s.id);
      expect(o.title, s.name).toBeGreaterThan(0);
      const want = s.kind === 'village' || s.kind === 'hamlet' ? 'manor' : s.kind === 'town' || s.kind === 'city' ? 'town' : s.kind === 'castle' ? 'county' : 'abbey';
      expect(kindOf(s.id), `${s.kind} ${s.name}`).toBe(want);
    }
  });

  it('names the holder, his House and the person who acts for him', () => {
    const village = world.settlements.find((s) => s.kind === 'village')!;
    const title = st.titleFor('manor', village.id)!;
    const holder = st.persons.get(title.holder)!;
    expect(terr.ownerOf!(village.id)).toEqual({ house: holder.house, title: title.id, holder: holder.id, lord: holder.id });
    // the same House and title as landAt says for any point of the lands
    const land = terr.landAt(village.x, village.z);
    expect(land.house).toBe(holder.house);
    expect(land.title).toBe(title.id);
    // the abbey's lands are held by the abbot, of the Church's House
    const abbey = world.settlements.find((s) => s.kind === 'abbey')!;
    const abbot = terr.ownerOf!(abbey.id);
    expect(st.houses.get(abbot.house)!.kind).toBe('church');
    // a place that does not exist is nobody's
    expect(terr.ownerOf!(987654)).toEqual({ house: 0, title: 0, holder: 0, lord: 0 });
  });

  it('follows a title to its new holder: at once on the inheritance event, within the hour without one', () => {
    const village = world.settlements.find((s) => s.kind === 'village' && st.titleFor('manor', s.id))!;
    const title = st.titleFor('manor', village.id)!;
    const old = st.persons.get(title.holder)!;
    const house = mkHouse(sim, 'Heir').id;
    const heir = mkPerson(sim, { age: 30, tier: 5, estate: 'noble', career: 'knight', byname: 'Heir', house });
    expect(terr.landAt(village.x, village.z).house).toBe(old.house);
    const v0 = terr.version();
    st.setTitleHolder(title, heir.id);
    sim.events.emit('inheritance', { from: old.id, to: heir.id, title: title.id });
    expect(terr.version()).toBeGreaterThan(v0);
    expect(terr.landAt(village.x, village.z).house).toBe(house);
    expect(terr.ownerOf!(village.id).holder).toBe(heir.id);
    // and back again, quietly: the next hourly look sees it
    st.setTitleHolder(title, old.id);
    expect(terr.landAt(village.x, village.z).house).toBe(house); // still the old answer: nothing told us
    sim.advanceHours(1);
    expect(terr.landAt(village.x, village.z).house).toBe(old.house);
    expect(terr.ownerOf!(village.id).holder).toBe(old.id);
  });

  it('lets a vacant title\'s lands be kept by the liege until it is filled', () => {
    const village = world.settlements.find((s) => s.kind === 'village' && st.titleFor('manor', s.id))!;
    const title = st.titleFor('manor', village.id)!;
    const holder = st.persons.get(title.holder)!;
    const liege = st.titles.get(title.liege)!;
    const liegeHolder = st.persons.get(liege.holder)!;
    st.markDead(holder, sim.absDay, 'illness');
    terr.refresh();
    const o = terr.ownerOf!(village.id);
    expect(o.title).toBe(title.id);               // still the manor's lands
    expect(o.holder).toBe(liegeHolder.id);        // kept by the liege
    expect(o.house).toBe(liegeHolder.house);
    expect(terr.landAt(village.x, village.z).house).toBe(liegeHolder.house);
  });

  it('lets a regent act for a child who holds a title (the House stays the child\'s)', () => {
    const village = world.settlements.filter((s) => s.kind === 'village' && st.titleFor('manor', s.id))[1] ?? world.settlements.find((s) => s.kind === 'hamlet' && st.titleFor('manor', s.id))!;
    const title = st.titleFor('manor', village.id)!;
    const childHouse = mkHouse(sim, 'Child').id;
    const child = mkPerson(sim, { age: 5, tier: 5, estate: 'noble', byname: 'Child', house: childHouse });
    const regent = mkPerson(sim, { age: 40, tier: 5, estate: 'noble', byname: 'Regent', house: childHouse });
    st.setTitleHolder(title, child.id);
    title.regent = regent.id;
    sim.events.emit('inheritance', { from: 0, to: child.id, title: title.id });
    const o = terr.ownerOf!(village.id);
    expect(o.holder).toBe(child.id);
    expect(o.house).toBe(child.house);
    expect(o.lord).toBe(regent.id);
  });

  it('moves `version` on titles changing hands, wars and feuds starting, offices of rule; not otherwise', () => {
    const v = terr.version();
    expect(terr.version()).toBe(v);
    sim.events.emit('war', { phase: 'declared', war: 1, attackers: [1], defenders: [2] });
    const v1 = terr.version();
    expect(v1).toBeGreaterThan(v);
    sim.events.emit('stance', { a: 1, b: 2, stance: 'war' });
    expect(terr.version()).toBeGreaterThan(v1);
    const v2 = terr.version();
    sim.events.emit('office', { person: 1, office: 'reeve', place: 1, gained: true });
    expect(terr.version()).toBe(v2);
    sim.events.emit('office', { person: 1, office: 'baron', place: 1, gained: true });
    expect(terr.version()).toBeGreaterThan(v2);
    const v3 = terr.version();
    sim.events.emit('siege', { phase: 'start', settlement: 1, besieger: 2 });
    expect(terr.version()).toBeGreaterThan(v3);
    // a title holder's death moves it; a commoner household head's does not
    const v4 = terr.version();
    const commoner = mkPerson(sim, { age: 40, tier: 2 });
    sim.events.emit('death', { person: commoner.id, cause: 'illness', age: 40, wasHead: true });
    expect(terr.version()).toBe(v4);
    const holder = st.persons.get(st.titleFor('manor', world.settlements.find((q) => q.kind === 'village' && st.titleFor('manor', q.id))!.id)!.holder)!;
    sim.events.emit('death', { person: holder.id, cause: 'illness', age: 40, wasHead: true });
    expect(terr.version()).toBeGreaterThan(v4);
  });

  it('moves `version` when a feud between Houses with armies in the field starts and when it runs out', () => {
    const mil = scriptedMilitary(sim);
    const pol = scriptedPolitics(sim);
    const a = mkHouse(sim, 'Left').id, b = mkHouse(sim, 'Right').id;
    mil.armyList.push({ id: 1, house: a, commander: 0, x: 100, z: 100, troops: {}, task: 'march' }, { id: 2, house: b, commander: 0, x: 900, z: 900, troops: {}, task: 'march' });
    terr.refresh();
    const v = terr.version();
    mil.feud(a, b);
    terr.refresh();
    const v1 = terr.version();
    expect(v1).toBeGreaterThan(v);
    terr.refresh();
    expect(terr.version()).toBe(v1);
    mil.endFeud(a, b);
    terr.refresh();
    expect(terr.version()).toBeGreaterThan(v1);
    // a war between politics' sides counts the same
    const v2 = terr.version();
    const w = pol.war([a], [b]);
    terr.refresh();
    expect(terr.version()).toBeGreaterThan(v2);
    pol.endWar(w.id);
    mil.armyList.length = 0;
    terr.refresh();
  });

  it('moves `version` when an outpost is founded (and not for sites that only progress)', () => {
    const fake = scriptedConstruction(sim, []);
    terr.refresh();
    const v = terr.version();
    sim.events.emit('construction', { phase: 'progress', site: 1, building: 1, settlement: 1, kind: 'barn', work: 'build', house: 1 });
    expect(terr.version()).toBe(v);
    fake.found({ id: 1, name: 'Ironcamp', settlement: world.settlements[0].id, x: 100, z: 100, deposit: 0, founded: 1 });
    expect(terr.version()).toBeGreaterThan(v);
  });
});

