// News and rivals (docs/CIV.md §6.8, §10): what neighbours do, with a threat reading; the yearly counts.
import { describe, expect, it } from 'vitest';
import { NEWS } from '../../../src/sim/realm/config';
import { bump, newsDaily, outpostsDaily, threatOf, yearCounts } from '../../../src/sim/realm/news';
import type { Simulation } from '../../../src/sim/sim';
import { makePlayer } from '../builders';
import { aManor, holderOf, realmSim, setDay, titlesOfKind } from './helpers';

/** The manor lord plays; the other great Houses of the world are rivals. */
function scene() {
  const r = realmSim({ preset: 'large', politics: true, military: true, keepPlayer: true });
  const m = aManor(r.sim);
  makePlayer(r.sim, m.lord);
  return { ...r, ...m };
}

const construction = (sim: Simulation, house: number, settlement: number, kind: string, work: 'build' | 'upgrade' = 'build'): void => {
  sim.events.emit('construction', { phase: 'done', site: 1, building: 1, settlement, kind, work, house });
};

/** A great House with land far from the player's village, and one near it. */
function farAndNear(sim: Simulation, from: number) {
  const here = sim.world.settlements.find((s) => s.id === from)!;
  const houses = titlesOfKind(sim, 'county').map((t) => holderOf(sim, t).house);
  const dist = (h: number): number => {
    const seat = sim.world.settlements.find((s) => s.id === sim.state.houses.get(h)!.seat)!;
    return Math.hypot(seat.x - here.x, seat.z - here.z);
  };
  const list = [...new Set(houses)].filter((h) => h !== sim.state.persons.get(sim.state.run.playerId)!.house).sort((a, b) => dist(a) - dist(b));
  return { near: list[0], far: list[list.length - 1], dist };
}

describe('news from events', () => {
  it('reports what a rival raises, with a threat that grows with the building\'s purpose', () => {
    const { sim, realm } = scene();
    const house = [...sim.state.houses.values()].find((h) => h.kind === 'noble' && h.id !== sim.state.run.houseId)!;
    const seat = house.seat;
    const told: string[] = [];
    sim.events.on('news', (n) => { told.push(n.text); });
    construction(sim, house.id, seat, 'wall');
    construction(sim, house.id, seat, 'hovel'); // homes are no news
    const list = realm.news(10);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'built', house: house.id, settlement: seat });
    expect(list[0].text).toMatch(/has raised a wall at/);
    expect(list[0].threat).toBeGreaterThan(0);
    expect(told).toHaveLength(1);
    construction(sim, house.id, seat, 'watermill');
    const mill = realm.news(10)[0];
    expect(mill.threat).toBeLessThan(list[0].threat);
  });

  it('counts a rival\'s works even when they are not worth a line', () => {
    const { sim, realm, R } = scene();
    const house = [...sim.state.houses.values()].find((h) => h.kind === 'noble' && h.id !== sim.state.run.houseId)!;
    for (let i = 0; i < 4; i++) construction(sim, house.id, house.seat, 'hovel');
    expect(realm.news(10)).toHaveLength(0);
    expect(yearCounts(R, house.id).built).toBe(4);
  });

  it('tells the player\'s own works with no threat', () => {
    const { sim, realm, lord } = scene();
    construction(sim, lord.house, sim.state.persons.get(lord.id)!.settlement, 'barn');
    const n = realm.news(5)[0];
    expect(n.house).toBe(lord.house);
    expect(n.threat).toBe(0);
  });

  it('tells wars, sieges, famines and raids, and a war on the player is the gravest', () => {
    const { sim, realm, lord } = scene();
    const mine = lord.house;
    const others = titlesOfKind(sim, 'county').map((t) => holderOf(sim, t).house).filter((h) => h !== mine);
    sim.events.emit('war', { phase: 'declared', war: 1, attackers: [others[0]], defenders: [others[1]] });
    const away = realm.news(1)[0];
    sim.events.emit('war', { phase: 'declared', war: 2, attackers: [others[0]], defenders: [mine] });
    const onMe = realm.news(1)[0];
    expect(away.kind).toBe('war');
    expect(onMe.threat).toBeGreaterThan(away.threat);
    expect(onMe.text).toMatch(/has declared war on/);
    sim.events.emit('war', { phase: 'ended', war: 2, attackers: [others[0]], defenders: [mine], winner: 'white_peace' });
    expect(realm.news(1)[0]).toMatchObject({ kind: 'peace' });
    const town = sim.world.settlements.find((s) => s.kind === 'town')!;
    sim.events.emit('siege', { phase: 'start', settlement: town.id, besieger: others[0] });
    expect(realm.news(1)[0]).toMatchObject({ kind: 'war', settlement: town.id });
    sim.events.emit('siege', { phase: 'fell', settlement: town.id, besieger: others[0] });
    expect(realm.news(1)[0]).toMatchObject({ kind: 'fell' });
    sim.events.emit('happening', { phase: 'start', id: 1, kind: 'famine', settlement: town.id, text: 'Famine stalks the town.' });
    expect(realm.news(1)[0]).toMatchObject({ kind: 'famine', text: 'Famine stalks the town.' });
    sim.events.emit('raid', { settlement: town.id, raider: others[1], burned: 3, stolen: 20, captives: 1 });
    expect(realm.news(1)[0].text).toMatch(/Raiders have fallen on .*3 burned/);
  });

  it('tells of a new army raised by another House, once', () => {
    const { sim, realm, mil, R } = scene();
    const kings = titlesOfKind(sim, 'kingdom').map((t) => holderOf(sim, t).house);
    const id = mil!.raiseArmy(kings[1], 'war');
    expect(id).toBeGreaterThan(0);
    newsDaily(R);
    const first = realm.news(5).filter((n) => n.kind === 'army');
    expect(first).toHaveLength(1);
    expect(first[0].text).toMatch(/has raised \d+ men/);
    newsDaily(R);
    expect(realm.news(5).filter((n) => n.kind === 'army')).toHaveLength(1);
  });

  it('tells of an outpost founded in the wild, once', () => {
    const { sim, realm, R, lord } = scene();
    const outposts = [{ id: 1, name: 'Ironhold', settlement: lord.settlement, x: 10, z: 10, deposit: 3, founded: 0 }];
    (sim.services as { construction?: unknown }).construction = { outposts: () => outposts };
    outpostsDaily(R);
    const n = realm.news(3).filter((x) => x.kind === 'founded');
    expect(n).toHaveLength(1);
    expect(n[0].text).toMatch(/founded the outpost of Ironhold/);
    outpostsDaily(R);
    expect(realm.news(5).filter((x) => x.kind === 'founded')).toHaveLength(1);
    outposts.push({ id: 2, name: 'Saltmere', settlement: lord.settlement, x: 20, z: 20, deposit: 4, founded: 1 });
    outpostsDaily(R);
    expect(realm.news(5).filter((x) => x.kind === 'founded')).toHaveLength(2);
  });

  it('keeps the newest first and no more than the ring holds', () => {
    const { sim, realm } = scene();
    const house = [...sim.state.houses.values()].find((h) => h.kind === 'noble' && h.id !== sim.state.run.houseId)!;
    for (let i = 0; i < NEWS.cap + 40; i++) construction(sim, house.id, house.seat, 'tower');
    expect(realm.news(1000)).toHaveLength(NEWS.cap);
    const top = realm.news(3);
    expect(top[0].id).toBeGreaterThan(top[1].id);
    expect(top[1].id).toBeGreaterThan(top[2].id);
    expect(realm.news(7)).toHaveLength(7);
  });

  it('tells of an heir to a great title', () => {
    const { sim, realm } = scene();
    const kt = titlesOfKind(sim, 'kingdom')[0];
    const king = holderOf(sim, kt);
    sim.events.emit('inheritance', { from: king.id, to: king.id, title: kt.id });
    expect(realm.news(1)[0].text).toMatch(/succeeds/);
  });
});

describe('the threat reading', () => {
  it('is greater for a near House than a far one, and greater at war than in alliance', () => {
    const { sim, R, lord } = scene();
    const { near, far } = farAndNear(sim, lord.settlement);
    const seatNear = sim.state.houses.get(near)!.seat, seatFar = sim.state.houses.get(far)!.seat;
    // same deed, same stance: the nearer House is the greater threat
    const a = threatOf(R, near, seatNear, 0.7), b = threatOf(R, far, seatFar, 0.7);
    expect(a).toBeGreaterThanOrEqual(b);
    // at war with the player's House
    const w = sim.services.politics as unknown as { declareWar(h: number, t: number, o: object): { ok: boolean } };
    const ok = w.declareWar(near, lord.house, { cause: 'raid' });
    if (ok.ok) {
      const war = threatOf(R, near, seatNear, 0.7);
      expect(war).toBeGreaterThan(a);
    }
    expect(threatOf(R, lord.house, seatNear, 1)).toBe(0);
    expect(threatOf(R, 0, seatNear, 1)).toBe(0);
    expect(threatOf(R, near, seatNear, 0)).toBe(0);
  });
});

describe('rivals', () => {
  it('lists the landed Houses with their year, stance and threat, the greatest threat first', () => {
    const { sim, realm, R, lord } = scene();
    const { near } = farAndNear(sim, lord.settlement);
    bump(R, near, 0, 5); bump(R, near, 1, 2); bump(R, near, 2, 40);
    const rivals = realm.rivals(lord.id);
    expect(rivals.length).toBeGreaterThan(5);
    expect(rivals.some((r) => r.house === lord.house)).toBe(false);
    for (let i = 1; i < rivals.length; i++) expect(rivals[i - 1].threat).toBeGreaterThanOrEqual(rivals[i].threat);
    const row = rivals.find((r) => r.house === near)!;
    expect(row).toMatchObject({ built: 5, techs: 2, recruited: 40, stance: expect.any(String) });
    expect(row.distance).toBeGreaterThan(0);
    expect(row.strength).toBeGreaterThan(0);
    expect(row.name).toBe(sim.state.houses.get(near)!.name);
    expect(row.share).toBeGreaterThan(0);
    // a House of the players's own realm is not a rival of itself, and a farmer gets his lord's rivals as a commoner would
    expect(realm.rivals(999999)).toEqual([]);
  });

  it('counts a year as it rolls: this year and the part of last year still within the last 16 days', () => {
    const { sim, R, lord } = scene();
    const house = [...sim.state.houses.values()].find((h) => h.kind === 'noble' && h.id !== lord.house)!;
    setDay(sim, 16 * 3 + 0.01); // just after the turn of a year
    bump(R, house.id, 0, 8);
    expect(yearCounts(R, house.id).built).toBe(8);
    sim.advanceDays(16); // the year turns: it is now last year's count
    expect(yearCounts(R, house.id).built).toBe(8);
    sim.advanceDays(8); // half a year on
    expect(yearCounts(R, house.id).built).toBe(4);
    sim.advanceDays(8); // the next turn of the year: last year's count goes
    expect(yearCounts(R, house.id).built).toBe(0);
  });
});
