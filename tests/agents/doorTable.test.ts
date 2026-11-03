// The agents' doors are the real doors (docs/INTERIORS.md): the table they use without plans is the plans' own main doors.
import { describe, expect, it } from 'vitest';
import { DOOR_STAND } from '../../src/agents/doorTable';
import { doorEntries } from '../../tools/door-table';

describe('door table', () => {
  it('matches the main doors of the interior plans of every kind, level and culture', () => {
    const e = doorEntries();
    expect(Object.keys(DOOR_STAND).sort()).toEqual(Object.keys(e).sort());
    for (const [k, v] of Object.entries(e)) {
      const t = DOOR_STAND[k];
      expect(Math.abs(t[0] - v[0]) + Math.abs(t[1] - v[1]), k).toBeLessThan(0.02);
    }
  }, 120000);
});
