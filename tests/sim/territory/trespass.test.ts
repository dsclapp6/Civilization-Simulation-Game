// May this person be here? Hostile land (war, feud, bad blood, outlaws, the lord's enemies), private land (the lord's closes,
// his park, the castle at night or on alert) and who is let in (his House and household, the manor's bound people, officers,
// a pass, the market day). Other modules' answers are scripted.
import { describe, expect, it } from 'vitest';
import { isMarketDay, marketDayOf } from '../../../src/sim/calendar';
import type { Person } from '../../../src/sim/state';
import type { Plot, Settlement, WorldModel } from '../../../src/world/types';
import { mkHouse, mkHousehold, mkPerson } from '../builders';
import { mockRig, scriptedMilitary, scriptedPolitics, setTimeOfDay } from './helpers';

/** The stand-in world with a manor court added inside its first town (so the market day can matter). */
function addTownManor(w: WorldModel): void {
  const town = w.settlements.find((s) => s.kind === 'town')! as Settlement;
  const id = (w.plots as Plot[]).length;
  (w.plots as Plot[]).push({ id, kind: 'manor_house', level: 2, x: town.x + 60, z: town.z + 60, rot: 0, settlement: town.id, culture: town.culture, seed: 5, role: 'lord_seat' });
  town.plots.push(id);
}

describe('trespass', () => {
  const rig = mockRig({ preset: 'small', seed: 'trespass', mutate: addTownManor });
  const { terr, sim, world, social } = rig;
  const st = sim.state;
  const pol = scriptedPolitics(sim);
  const mil = scriptedMilitary(sim);

  // ---- the places ----
  const manor = world.plots.find((p) => p.kind === 'manor_house' && p.role === 'lord_seat' && world.settlements[p.settlement].kind === 'village')!;
  const village = world.settlements[manor.settlement];
  const court = { x: manor.x, z: manor.z };
  const lordship = terr.ownerOf!(village.id);
  const lord = st.persons.get(lordship.lord)!;
  const lordHouse = lordship.house;
  const castle = world.settlements.find((s) => s.kind === 'castle')!;
  const castleOwner = terr.ownerOf!(castle.id);
  const town = world.settlements.find((s) => s.kind === 'town')!;
  const townManor = world.plots.find((p) => p.settlement === town.id && p.kind === 'manor_house')!;
  const strip = world.strips.find((s) => s.settlement === village.id)!;
  const stripAt = { x: (strip.poly[0].x + strip.poly[2].x) / 2, z: (strip.poly[0].z + strip.poly[2].z) / 2 };
  const otherVillage = world.settlements.find((s) => s.kind === 'village' && s.id !== village.id)!;
  const wildAt = (() => { for (let x = 200; x < 15800; x += 400) for (let z = 200; z < 15800; z += 400) if (world.settlements.every((s) => Math.hypot(s.x - x, s.z - z) > 3300)) return { x, z }; throw new Error('no wild land'); })();

  // ---- the people ----
  const strangerHouse = mkHouse(sim, 'Stranger').id;
  const stranger = mkPerson(sim, { settlement: otherVillage.id, house: strangerHouse, tier: 2, estate: 'free' });
  const person = (o: Partial<Parameters<typeof mkPerson>[1]> = {}): Person => mkPerson(sim, { settlement: otherVillage.id, house: mkHouse(sim, 'Some').id, tier: 2, estate: 'free', ...o });

  it('lets anyone be on common, public and wild land in peace', () => {
    expect(terr.trespass(stranger.id, stripAt.x, stripAt.z)).toMatchObject({ level: 'none', reason: '' });
    expect(terr.trespass(stranger.id, village.x, village.z).level).toBe('none');
    expect(terr.trespass(stranger.id, wildAt.x, wildAt.z).level).toBe('none');
    expect(terr.trespass(stranger.id, -50, 50).level).toBe('none');
    // a person who is not there (dead, never was) is nobody's trespasser
    expect(terr.trespass(99999999, court.x, court.z).level).toBe('none');
    const dead = person();
    st.markDead(dead, sim.absDay, 'illness');
    expect(terr.trespass(dead.id, court.x, court.z).level).toBe('none');
  });

  describe('private land', () => {
    it('keeps the lord\'s closes and manor court from those with no business there, and says whose', () => {
      expect(terr.landAt(court.x, court.z).kind).toBe('demesne');
      const t = terr.trespass(stranger.id, court.x, court.z);
      expect(t.level).toBe('private');
      expect(t.cause).toBe('demesne');
      expect(t.lord).toBe(lord.id);
      expect(t.land.house).toBe(lordHouse);
      expect(t.reason).toContain(village.name);
      expect(t.reason.toLowerCase()).toContain('lord');
    });

    it('lets the lord\'s House, his household and the people sworn to him in', () => {
      expect(terr.trespass(lord.id, court.x, court.z).level).toBe('none');
      const kin = person({ house: lordHouse });                       // sworn to the House
      expect(terr.trespass(kin.id, court.x, court.z).level).toBe('none');
      const hh = st.households.get(lord.household)!;
      const servant = person({ household: hh.id });                   // of his household (a House of its own)
      expect(servant.house).not.toBe(lordHouse);
      expect(terr.trespass(servant.id, court.x, court.z).level).toBe('none');
    });

    it('lets the manor\'s bound people work his closes, and its officers go where their office takes them', () => {
      const serf = person({ settlement: village.id, estate: 'unfree', tier: 1 });
      expect(terr.trespass(serf.id, court.x, court.z).level).toBe('none');
      const freeman = person({ settlement: village.id, estate: 'free' });
      expect(terr.trespass(freeman.id, court.x, court.z).level).toBe('private');
      const reeve = person({ settlement: otherVillage.id });
      reeve.offices.push({ office: 'reeve', place: village.id, since: 0 });
      expect(terr.trespass(reeve.id, court.x, court.z).level).toBe('none');
      // an office elsewhere does nothing here
      const bailiff = person();
      bailiff.offices.push({ office: 'bailiff', place: otherVillage.id, since: 0 });
      expect(terr.trespass(bailiff.id, court.x, court.z).level).toBe('private');
    });

    it('lets in someone with the lord\'s leave, until it runs out (and the leave is kept for the day it ends)', () => {
      const guest = person();
      expect(terr.trespass(guest.id, court.x, court.z).level).toBe('private');
      expect(terr.leaveUntil!(guest.id, village.id)).toBe(0);
      const day = sim.absDay;
      terr.grantLeave!(guest.id, village.id, 2);
      expect(terr.leaveUntil!(guest.id, village.id)).toBeCloseTo(day + 2, 6);
      expect(terr.trespass(guest.id, court.x, court.z).level).toBe('none');
      // leave here is not leave elsewhere
      const manor2 = world.plots.find((p) => p.kind === 'manor_house' && p.settlement !== village.id)!;
      expect(terr.trespass(guest.id, manor2.x, manor2.z).level).toBe('private');
      // a longer leave is not cut short by a shorter one
      terr.grantLeave!(guest.id, village.id, 1);
      expect(terr.leaveUntil!(guest.id, village.id)).toBeCloseTo(day + 2, 6);
      sim.advanceDays(3);
      expect(terr.leaveUntil!(guest.id, village.id)).toBe(0);
      expect(terr.trespass(guest.id, court.x, court.z).level).toBe('private');
    });

    it('lets everyone into a town\'s private ground on its market day, and only then', () => {
      const here = { x: townManor.x, z: townManor.z };
      expect(terr.landAt(here.x, here.z).kind).toBe('demesne');
      const base = Math.floor(sim.absDay) + 8;
      let market = base, other = base;
      while (!isMarketDay(market, town.id)) market++;
      while (isMarketDay(other, town.id) || other % 4 === marketDayOf(town.id)) other++;
      sim.state.clock.absDay = market + 0.5; terr.refresh();
      expect(terr.trespass(stranger.id, here.x, here.z).level).toBe('none');
      sim.state.clock.absDay = other + 0.5; terr.refresh();
      expect(isMarketDay(sim.absDay, town.id)).toBe(false);
      expect(terr.trespass(stranger.id, here.x, here.z).level).toBe('private');
    });

    it('closes the lord\'s deer park to those without business, like his closes', () => {
      const forestAt = world.forestAt.bind(world);
      (world as { forestAt: WorldModel['forestAt'] }).forestAt = (x, z) => (Math.hypot(x - castle.x, z - castle.z) < 700 ? 0.6 : forestAt(x, z));
      try {
        const p = { x: castle.x + 300, z: castle.z };
        expect(terr.landAt(p.x, p.z).kind).toBe('park');
        const t = terr.trespass(stranger.id, p.x, p.z);
        expect(t).toMatchObject({ level: 'private', cause: 'park' });
        expect(t.reason).toContain('deer park');
        expect(terr.trespass(person({ house: castleOwner.house }).id, p.x, p.z).level).toBe('none');
        // the forest beyond it is not private (poaching is a matter for hunting, not for walking)
        expect(terr.trespass(stranger.id, castle.x + 600, castle.z).level).toBe('none');
      } finally {
        (world as { forestAt: WorldModel['forestAt'] }).forestAt = forestAt;
      }
    });
  });

  describe('the castle', () => {
    const inside = { x: castle.x, z: castle.z };

    it('is open by day and shut at night to those who do not belong to it', () => {
      setTimeOfDay(rig, 0.5);
      expect(terr.landAt(inside.x, inside.z).kind).toBe('castle');
      expect(terr.trespass(stranger.id, inside.x, inside.z).level).toBe('none');
      setTimeOfDay(rig, 0.02);
      const t = terr.trespass(stranger.id, inside.x, inside.z);
      expect(t).toMatchObject({ level: 'private', cause: 'castle', lord: castleOwner.lord });
      expect(t.reason).toContain('night');
      // its own lord and his men are not locked out
      expect(terr.trespass(castleOwner.lord, inside.x, inside.z).level).toBe('none');
      expect(terr.trespass(person({ house: castleOwner.house }).id, inside.x, inside.z).level).toBe('none');
      setTimeOfDay(rig, 0.5);
    });

    it('is shut by day under siege, or while a hostile army stands within sight of it', () => {
      setTimeOfDay(rig, 0.5);
      mil.sieges.add(castle.id);
      terr.refresh();
      sim.state.clock.absDay += 1 / 24; terr.refresh();
      const t = terr.trespass(stranger.id, inside.x, inside.z);
      expect(t).toMatchObject({ level: 'private', cause: 'castle' });
      expect(t.reason).toContain('alert');
      mil.sieges.delete(castle.id);
      sim.state.clock.absDay += 1 / 24; terr.refresh();
      expect(terr.trespass(stranger.id, inside.x, inside.z).level).toBe('none');
      // an army of a House at war with the castle's lord, close by: alert; far away: calm
      const enemy = mkHouse(sim, 'Besiegers').id;
      const w = pol.war([enemy], [castleOwner.house]);
      mil.armyList.push({ id: 1, house: enemy, commander: 0, x: castle.x + 600, z: castle.z, troops: {}, task: 'march' });
      sim.state.clock.absDay += 1 / 24; terr.refresh();
      expect(terr.trespass(stranger.id, inside.x, inside.z)).toMatchObject({ level: 'private', cause: 'castle' });
      mil.armyList[0].x = castle.x + 6000;
      sim.state.clock.absDay += 1 / 24; terr.refresh();
      expect(terr.trespass(stranger.id, inside.x, inside.z).level).toBe('none');
      mil.armyList.length = 0;
      pol.endWar(w.id);
      terr.refresh();
    });
  });

  describe('hostile land', () => {
    const at = stripAt; // an ordinary field of the lord's village

    it('is the land of a House at war with yours: any of it, fields and roads too', () => {
      const w = pol.war([lordHouse], [strangerHouse]);
      terr.refresh();
      for (const p of [at, court, { x: village.x, z: village.z }]) {
        const t = terr.trespass(stranger.id, p.x, p.z);
        expect(t.level).toBe('hostile');
        expect(t.cause).toBe('war');
        expect(t.lord).toBe(lord.id);
        expect(t.reason).toContain('at war with yours');
        expect(t.reason).toContain('House');
      }
      // a third party is not at war with him; he himself is not at war with his own land
      expect(terr.trespass(person().id, at.x, at.z).level).toBe('none');
      expect(terr.trespass(lord.id, at.x, at.z).level).toBe('none');
      // the war ends, the land opens
      pol.endWar(w.id);
      terr.refresh();
      expect(terr.trespass(stranger.id, at.x, at.z).level).toBe('none');
    });

    it('is also the land of a House at war with your lord: a commoner follows his lord\'s quarrels', () => {
      const lordOfOther = terr.ownerOf!(otherVillage.id).house;
      const commoner = person({ settlement: otherVillage.id });       // a peasant of the other village, in a House of his own
      expect(commoner.house).not.toBe(lordOfOther);
      const w = pol.war([lordHouse], [lordOfOther]);
      terr.refresh();
      const t = terr.trespass(commoner.id, at.x, at.z);
      expect(t).toMatchObject({ level: 'hostile', cause: 'war' });
      expect(t.reason).toContain("your lord's");
      pol.endWar(w.id);
      terr.refresh();
      expect(terr.trespass(commoner.id, at.x, at.z).level).toBe('none');
    });

    it('is the land of a House in a feud with yours, and of one on hostile terms', () => {
      mil.feud(lordHouse, strangerHouse);
      expect(terr.trespass(stranger.id, at.x, at.z)).toMatchObject({ level: 'hostile', cause: 'feud' });
      expect(terr.trespass(stranger.id, at.x, at.z).reason).toContain('feud');
      mil.endFeud(lordHouse, strangerHouse);
      expect(terr.trespass(stranger.id, at.x, at.z).level).toBe('none');
      pol.setStance(lordHouse, strangerHouse, 'hostile');
      expect(terr.trespass(stranger.id, at.x, at.z)).toMatchObject({ level: 'hostile', cause: 'hostile' });
      pol.setStance(lordHouse, strangerHouse, 'truce');
      expect(terr.trespass(stranger.id, at.x, at.z).level).toBe('none');
      pol.setStance(lordHouse, strangerHouse, 'neutral');
    });

    it('is any lord\'s land to an outlaw (but not the wild, and not his own House\'s)', () => {
      const outlaw = person();
      outlaw.flags.outlaw = true;
      expect(terr.trespass(outlaw.id, at.x, at.z)).toMatchObject({ level: 'hostile', cause: 'outlaw' });
      expect(terr.trespass(outlaw.id, wildAt.x, wildAt.z).level).toBe('none');
      const own = person({ house: lordHouse });
      own.flags.outlaw = true;
      expect(terr.trespass(own.id, at.x, at.z).level).toBe('none');
    });

    it('is the land of a lord who counts you his enemy (his grudge is what counts, not a passing coolness)', () => {
      lord.opinions[stranger.id] = -10;
      expect(terr.trespass(stranger.id, at.x, at.z).level).toBe('none');
      lord.opinions[stranger.id] = -70;
      expect(social.opinion(lord.id, stranger.id)).toBeLessThanOrEqual(-50);
      expect(terr.trespass(stranger.id, at.x, at.z)).toMatchObject({ level: 'hostile', cause: 'enemy', lord: lord.id });
      delete lord.opinions[stranger.id];
      expect(terr.trespass(stranger.id, at.x, at.z).level).toBe('none');
    });

    it('outranks private ground: a man at war with the lord is not told he is merely trespassing', () => {
      const w = pol.war([lordHouse], [strangerHouse]);
      terr.refresh();
      expect(terr.trespass(stranger.id, court.x, court.z).level).toBe('hostile');
      pol.endWar(w.id);
      terr.refresh();
      expect(terr.trespass(stranger.id, court.x, court.z).level).toBe('private');
    });
  });

  describe('leaving the land', () => {
    it('finds the nearest point where a trespasser is no longer one', () => {
      const exit = terr.exitFrom!(stranger.id, court.x, court.z)!;
      expect(exit).not.toBeNull();
      expect(terr.trespass(stranger.id, exit.x, exit.z).level).toBe('none');
      expect(Math.hypot(exit.x - court.x, exit.z - court.z)).toBeLessThan(150);
      // someone who is not trespassing is already out
      expect(terr.exitFrom!(stranger.id, stripAt.x, stripAt.z)).toEqual(stripAt);
    });
  });
});
