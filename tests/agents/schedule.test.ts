import { beforeAll, describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../src/content/types';
import { pointInPolygon } from '../../src/core/math';
import { daylight } from '../../src/core/time';
import { marketDayOf } from '../../src/sim/calendar';
import { ageYears, type Person } from '../../src/sim/state';
import { newIntent } from '../../src/agents/schedule';
import type { Settlement } from '../../src/world/types';
import { makeRig, settlementOfKind, setClock, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;
let people: Person[];

const SUMMER = 1;

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
  people = [...rig.sim.state.residentsOf(vil.id)];
}, 180000);

const where = (p: Person, season: number, dow: number, frac: number) => {
  setClock(rig.sim, season, dow, 0);
  return rig.zone.sched.whereabouts(p, rig.sim.absDay + frac);
};
const adults = () => people.filter((p) => ageYears(p, rig.sim.absDay) >= 16 && ageYears(p, rig.sim.absDay) < 60 && p.health.conditions.length === 0);

describe('whereabouts', () => {
  it('is deterministic and does not depend on what was asked before', () => {
    const p = adults()[0];
    const a = where(p, SUMMER, 1, 0.4);
    // ask about other people and other times in between
    for (const q of people.slice(0, 20)) where(q, 2, 3, 0.7);
    const b = where(p, SUMMER, 1, 0.4);
    expect(b).toEqual(a);
    expect(rig.zone.whereabouts(p.id, rig.sim.absDay + 0.4)).toEqual(a);
  });

  it('puts everybody indoors, at home, in the middle of the night', () => {
    let indoors = 0, n = 0;
    for (const p of people) {
      if (p.career === 'soldier' || p.career === 'man_at_arms') continue;
      const w = where(p, SUMMER, 2, 0.04);
      n++;
      if (w.indoors) indoors++;
    }
    expect(indoors / n).toBeGreaterThan(0.97);
  });

  it('sends a farmer to the strips of his household (or the lord\'s demesne) on a work day', () => {
    const sp = rig.zone.places.of(vil.id)!;
    const farmers = adults().filter((p) => (p.career === 'farmer' || p.career === 'cottar' || p.career === 'labourer') && p.sex === 'm');
    expect(farmers.length).toBeGreaterThan(2);
    let atStrip = 0;
    const I = newIntent();
    for (const f of farmers) {
      // on a ten-minute day the way to the strips is a long walk: at this hour many are still on it, and the intent is the place they walk to
      setClock(rig.sim, SUMMER, 2, 0);
      rig.zone.sched.intent(f, rig.sim.absDay + 0.4, I);
      expect(I.indoors).toBe(false);
      expect(I.activity).toBe('work');
      if (sp.strips.some((s) => pointInPolygon(I.x, I.z, s.poly) || Math.hypot(I.x - s.poly[0].x, I.z - s.poly[0].z) < 40)) atStrip++;
    }
    expect(atStrip / farmers.length).toBeGreaterThan(0.8);
  });

  it('keeps the priest at the church and the smith at the smithy', () => {
    const sp = rig.zone.places.of(vil.id)!;
    const priest = people.find((p) => p.career === 'priest')!;
    const wp = where(priest, SUMMER, 2, 0.4);
    expect(Math.hypot(wp.x - sp.church!.x, wp.z - sp.church!.z)).toBeLessThan(25);
    const smith = people.find((p) => p.career === 'smith' && p.careerStage >= 2);
    if (smith) {
      const smithy = sp.first('smithy')!;
      const ws = where(smith, SUMMER, 2, 0.4);
      expect(ws.activity).toBe('work');
      expect(Math.hypot(ws.x - smithy.x, ws.z - smithy.z)).toBeLessThan(BUILDINGS.smithy.d + 8);
    }
  });

  it('has the village at Mass on a holy day morning, indoors in the parish church', () => {
    const sp = rig.zone.places.of(vil.id)!;
    // mid-Mass: halfway between the parish\'s Mass start and end
    const { sunrise } = daylight(SUMMER);
    const mid = sunrise + 0.085 + 0.012 * 0.5 + 0.05 + 0.006;
    let inChurch = 0, n = 0;
    for (const p of people) {
      if (ageYears(p, rig.sim.absDay) < 3 || p.health.conditions.length) continue;
      const w = where(p, SUMMER, 4, mid);
      n++;
      if (w.indoors && w.activity === 'church' && w.building === sp.church!.id) inChurch++;
    }
    expect(inChurch / n).toBeGreaterThan(0.75);
  });

  it('turns the holy-day afternoon to leisure: archery for men, the alehouse, play and gossip', () => {
    const tally: Record<string, number> = {};
    for (const p of adults()) {
      const w = where(p, SUMMER, 4, 0.58);
      tally[w.activity] = (tally[w.activity] ?? 0) + 1;
    }
    expect(tally['work'] ?? 0).toBe(0);
    const leisure = (tally['practice'] ?? 0) + (tally['alehouse'] ?? 0) + (tally['talk'] ?? 0) + (tally['home'] ?? 0) + (tally['eat'] ?? 0) + (tally['play'] ?? 0) + (tally['walk'] ?? 0) + (tally['church'] ?? 0) + (tally['travel'] ?? 0);
    expect(leisure).toBeGreaterThan(adults().length * 0.9);
    expect((tally['practice'] ?? 0) + (tally['alehouse'] ?? 0)).toBeGreaterThan(0);
  });

  it('shortens outdoor work in bad weather', () => {
    const outdoorsAt = (): number => adults().filter((p) => !where(p, SUMMER, 2, 0.42).indoors).length;
    rig.zone.sched.forceWeather({ rain: 0, snow: 0, temperature: 14 });
    const dry = outdoorsAt();
    rig.zone.sched.forceWeather({ rain: 0.95, snow: 0, temperature: 8 });
    const wet = outdoorsAt();
    rig.zone.sched.forceWeather({ rain: 0, snow: 0, temperature: 14 });
    expect(wet).toBeLessThan(dry * 0.7);
  });

  it('keeps the sick in bed', () => {
    const p = adults()[3];
    p.health.conditions.push({ id: 'fever', since: rig.sim.absDay, until: rig.sim.absDay + 5, severity: 0.3, fatal: false });
    const w = where(p, SUMMER, 2, 0.4);
    p.health.conditions.length = 0;
    expect(w.indoors).toBe(true);
    expect(w.activity).toBe('sleep');
  });

  it('gives children play and chores, and keeps infants in the house', () => {
    const kids = people.filter((p) => ageYears(p, rig.sim.absDay) >= 6 && ageYears(p, rig.sim.absDay) < 12);
    const infants = people.filter((p) => ageYears(p, rig.sim.absDay) < 2);
    expect(kids.length).toBeGreaterThan(2);
    const acts = new Set(kids.map((k) => where(k, SUMMER, 2, 0.45).activity));
    expect([...acts].some((a) => a === 'play' || a === 'home' || a === 'work' || a === 'school')).toBe(true);
    for (const i of infants) expect(where(i, SUMMER, 2, 0.45).indoors).toBe(true);
  });

  it('moves people between places over a few hours (travel is part of the day)', () => {
    const o = newIntent();
    let walking = 0, total = 0, most = 0;
    setClock(rig.sim, SUMMER, 2, 0);
    const farmers = adults().filter((q) => q.career === 'farmer');
    expect(farmers.length).toBeGreaterThan(3);
    for (const p of farmers) {
      let mine = 0;
      for (let i = 0; i < 96; i++) {
        rig.zone.sched.intent(p, rig.sim.absDay + i / 96, o);
        total++;
        if (o.travel < 1) { walking++; mine++; }
      }
      most = Math.max(most, mine / 96);
    }
    expect(walking).toBeGreaterThan(0);
    // people walk at the speed of people (a ten-minute day): the fields are a long way for some, a short one for most
    expect(walking).toBeLessThan(total * 0.78);
    expect(most).toBeLessThan(0.9);
  });
});

describe('market days', () => {
  it('fills the market square of a market town with sellers and shoppers, and brings visitors from the villages round about', () => {
    const { zone, sim, world } = rig;
    const towns = world.settlements.filter((s) => s.kind === 'town' && s.market && zone.places.feedersOf(s.id).length > 0);
    expect(towns.length).toBeGreaterThan(0);
    const town = towns[0];
    const dow = marketDayOf(town.id);
    setClock(sim, SUMMER, dow, 0);
    const residents = sim.state.residentsOf(town.id);
    let selling = 0;
    for (const p of residents) {
      const w = zone.sched.whereabouts(p, sim.absDay + 0.42);
      if (w.activity === 'market' && !w.indoors) selling++;
    }
    expect(selling).toBeGreaterThan(5);
    // visitors: residents of the feeder villages whose whereabouts are in the town
    let visitors = 0;
    for (const fid of zone.places.feedersOf(town.id)) {
      for (const p of sim.state.residentsOf(fid)) {
        const w = zone.sched.whereabouts(p, sim.absDay + 0.45);
        if (w.settlement === town.id) visitors++;
      }
    }
    expect(visitors).toBeGreaterThan(0);
  });
});

describe('places', () => {
  it('finds the buildings of daily life in every kind of settlement', () => {
    const town = settlementOfKind(rig.world, 'town');
    const sp = rig.zone.places.of(town.id)!;
    expect(sp.church).not.toBeNull();
    expect(sp.hasMarketBuildings).toBe(true);
    expect(sp.alehouses.length).toBeGreaterThan(0);
  });
});
