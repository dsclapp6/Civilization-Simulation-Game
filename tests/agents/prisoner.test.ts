// Prisoners in the schedule (docs/CIV.md §4, docs/LAW.md): a person the law holds neither works nor travels nor goes to mass — he is indoors in
// the cell he was put in, at every hour; held in another place he is away (not in this one); while being led he is where the law's walk
// puts him (the zone's order), so the schedule only keeps him from his day. Without the law module a captive flag keeps him home.
import { beforeAll, describe, expect, it } from 'vitest';
import { ageYears, type BuildingState, type Person } from '../../src/sim/state';
import type { CaptivityView, LawApi } from '../../src/sim/law/types';
import { newIntent } from '../../src/agents/schedule';
import type { Settlement } from '../../src/world/types';
import { makeRig, setClock, village, type Rig } from './helpers';

let rig: Rig;
let vil: Settlement;
let cell: BuildingState;
let prisoner: Person;
let neighbour: Person;

beforeAll(() => {
  rig = makeRig();
  vil = village(rig.world, rig.zone);
  const here = rig.sim.state.buildingsAt.get(vil.id) ?? [];
  // the lock-up: the manor if the village has one, else any finished building that is not a house (a stand-in cell)
  cell = here.find((b) => b.kind === 'manor_house' && b.construction >= 1) ?? here.find((b) => b.kind === 'church') ?? here[0];
  const adults = [...rig.sim.state.residentsOf(vil.id)].filter((p) => p.sex === 'm' && ageYears(p, rig.sim.absDay) >= 20 && ageYears(p, rig.sim.absDay) < 50 && p.health.conditions.length === 0 && p.estate !== 'clergy');
  prisoner = adults.find((p) => p.career === 'farmer' || p.career === 'labourer')!;
  neighbour = adults.find((p) => p.id !== prisoner.id && (p.career === 'farmer' || p.career === 'labourer'))!;
}, 180000);

const held = (view: Partial<CaptivityView> | null): void => {
  rig.sim.services.law = {
    captivity: (id: number) => (id === prisoner.id && view ? { person: id, kind: 'poaching', captor: 1, house: 1, settlement: vil.id, building: cell.id, since: 0, ransom: 0, fine: 10, sentenceDays: 2, text: '', danger: false, ...view } : null),
  } as unknown as LawApi;
};

const where = (p: Person, season: number, dow: number, frac: number) => {
  setClock(rig.sim, season, dow, 0);
  return rig.zone.sched.whereabouts(p, rig.sim.absDay + frac);
};

describe('a prisoner in his cell', () => {
  it('is indoors in the cell at every hour of every kind of day: never at the strips, the alehouse, the market or the church', () => {
    held({});
    prisoner.flags.captive = true;
    for (const [season, dow] of [[1, 2], [1, 4], [2, 1], [0, 3]]) {
      for (const frac of [0.02, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.93]) {
        const w = where(prisoner, season, dow, frac);
        expect(w.indoors, `season ${season} day ${dow} at ${frac}`).toBe(true);
        expect(w.building).toBe(cell.id);
        expect(w.settlement).toBe(vil.id);
        expect(w.label).toBe('Held prisoner');
      }
    }
    // and his neighbour keeps his ordinary day
    const w = where(neighbour, 1, 2, 0.4);
    expect(w.label).not.toBe('Held prisoner');
  });

  it('is put at the door of his cell: the place the schedule gives is at the building', () => {
    held({});
    prisoner.flags.captive = true;
    const w = where(prisoner, 1, 2, 0.4);
    expect(Math.hypot(w.x - cell.x, w.z - cell.z)).toBeLessThan(40);
  });

  it('is away (not in this place at all) when he is held in another', () => {
    held({ settlement: vil.id + 1000 });
    prisoner.flags.captive = true;
    setClock(rig.sim, 1, 2, 0);
    const I = newIntent();
    rig.zone.sched.intent(prisoner, rig.sim.absDay + 0.4, I);
    // the zone does not summon a man who is held elsewhere
    expect(I.away).toBe(true);
    expect(I.label).toBe('Held prisoner');
  });

  it('is kept from his day while he is still being led (building not yet known)', () => {
    held({ led: true, building: -1 });
    prisoner.flags.captive = true;
    const w = where(prisoner, 1, 2, 0.4);
    expect(w.label).toBe('Held prisoner');
  });

  it('with no law module a captive is home, not at his work', () => {
    delete rig.sim.services.law;
    prisoner.flags.captive = true;
    const w = where(prisoner, 1, 2, 0.4);
    expect(w.label).toBe('Held prisoner');
    expect(w.indoors).toBe(true);
  });

  it('is free to go about his day again once he is let out', () => {
    held(null);
    delete prisoner.flags.captive;
    const w = where(prisoner, 1, 2, 0.4);
    expect(w.label).not.toBe('Held prisoner');
  });
});
