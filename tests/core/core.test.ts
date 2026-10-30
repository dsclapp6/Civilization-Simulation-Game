import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { DAYS_PER_YEAR, toDate, yearsBetween } from '../../src/core/time';
import { hash3, wrapAngle } from '../../src/core/math';

describe('core', () => {
  it('rng is deterministic and serialisable', () => {
    const a = new Rng('seed'), b = new Rng('seed');
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
    const s = a.getState();
    const x = a.next();
    a.setState(s);
    expect(a.next()).toBe(x);
  });

  it('calendar converts absolute days', () => {
    expect(DAYS_PER_YEAR).toBe(16);
    const d = toDate(16 + 4 + 1.5);
    expect(d.year).toBe(2);
    expect(d.season).toBe(1);
    expect(d.dayOfSeason).toBe(2);
    expect(d.dayFraction).toBeCloseTo(0.5);
    expect(yearsBetween(0, 32)).toBe(2);
  });

  it('math helpers behave', () => {
    expect(hash3(1, 2, 3)).toBe(hash3(1, 2, 3));
    expect(Math.abs(wrapAngle(3 * Math.PI))).toBeCloseTo(Math.PI);
  });
});
