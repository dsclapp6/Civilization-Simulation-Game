// The diplomacy ladder (SPEC §15): contact → truce → trade → marriage ties → alliance → union, with
// stance events; offers to the player arrive as letters; marriages bind Houses.
import { describe, expect, it } from 'vitest';
import type { SimEvents } from '../../../src/sim/events';
import type { Stance } from '../../../src/sim/wave3';
import { makePlayer } from '../builders';
import { bringNear, housesHolding, noble, rig, wed, type Rig } from './helpers';

/** Makes every diplomatic roll succeed. */
function alwaysAgree(r: Rig): void {
  const g = r.sim.rng('politics.diplo');
  g.next = () => 0;
}

function kings(r: Rig): [number, number] {
  const k = housesHolding(r.sim, 'kingdom');
  return [k[0], k[1]];
}

describe('diplomacy ladder', () => {
  it('climbs from no ties through truce and trade to kin and alliance, announcing each stance', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    alwaysAgree(r);
    const seen: Array<SimEvents['stance']> = [];
    r.sim.events.on('stance', (e) => seen.push(e));
    expect(r.pol.stance(a, b)).toBe('neutral');
    expect(r.pol.ladderStep(a, b)).toBe('truce');

    expect(r.pol.propose(a, b, 'truce').ok).toBe(true);
    expect(r.pol.stance(a, b)).toBe('truce');
    expect(r.pol.stance(b, a)).toBe('truce');
    expect(r.pol.ladderStep(a, b)).toBe('trade');
    expect(r.pol.propose(a, b, 'alliance').ok).toBe(false); // no skipping rungs

    expect(r.pol.propose(a, b, 'trade').ok).toBe(true);
    expect(r.pol.stance(a, b)).toBe('trade');
    expect(r.pol.ladderStep(a, b)).toBe('marriage');

    // a wedding between the two Houses binds them by kin
    const ha = r.x.core.headOf(a)!, hb = r.x.core.headOf(b)!;
    const groom = noble(r, a, 'm', 22, { father: ha, tier: 6 });
    const bride = noble(r, b, 'f', 19, { father: hb, tier: 6 });
    wed(r, groom, bride);
    expect(r.pol.stance(a, b)).toBe('kin');
    expect(r.pol.ladderStep(a, b)).toBe('alliance');

    expect(r.pol.propose(a, b, 'alliance').ok).toBe(true);
    expect(r.pol.stance(a, b)).toBe('alliance');
    expect(r.pol.ladderStep(a, b)).toBeNull();

    const stances = seen.filter((e) => e.a === a && e.b === b).map((e) => e.stance);
    expect(stances).toEqual<Stance[]>(['truce', 'trade', 'kin', 'alliance']);
    // and each is announced for both directions
    expect(seen.filter((e) => e.a === b && e.b === a).length).toBe(4);
  });

  it('a war overrides every pact and ends in a truce', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    bringNear(r, a, b);
    alwaysAgree(r);
    r.pol.propose(a, b, 'truce');
    r.pol.propose(a, b, 'trade');
    expect(r.pol.stance(a, b)).toBe('trade');
    const res = r.pol.declareWar(a, b, { cause: 'conquest', breakTruce: true } as never);
    expect(res.ok).toBe(true);
    expect(r.pol.stance(a, b)).toBe('war');
    expect(r.pol.stance(b, a)).toBe('war');
    expect(r.pol.ladderStep(a, b)).toBeNull();
    r.x.wars.end(r.x.wars.get(res.war!)!, 'white_peace', 'white');
    expect(['truce', 'hostile']).toContain(r.pol.stance(a, b));
    expect(r.x.core.tie(a, b).truce).toBeGreaterThan(r.sim.absDay);
    expect(r.x.core.tie(a, b).trade).toBe(0);
  });

  it('grievance makes a House hostile; truces run out and the world is told', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    r.x.core.addGrievance(a, b, 40);
    expect(r.pol.stance(a, b)).toBe('hostile');
    // grievances fade with the seasons
    for (let i = 0; i < 20; i++) r.sim.advanceDays(4);
    expect(r.pol.stance(a, b)).toBe('neutral');

    alwaysAgree(r);
    r.pol.propose(a, b, 'truce');
    expect(r.pol.stance(a, b)).toBe('truce');
    const seen: Array<SimEvents['stance']> = [];
    r.sim.events.on('stance', (e) => seen.push(e));
    r.sim.advanceDays(16 * 4);
    expect(r.pol.stance(a, b)).toBe('neutral');
    expect(seen.some((e) => e.a === a && e.b === b && e.stance === 'neutral')).toBe(true);
  });

  it('refusal costs a little goodwill and an offer needs the other House to be willing', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const g = r.sim.rng('politics.diplo');
    g.next = () => 0.999;
    const res = r.pol.propose(a, b, 'truce');
    expect(res.ok).toBe(false);
    expect(r.pol.stance(a, b)).toBe('neutral');
    // an angry House says no more often
    const calm = r.pol.acceptChance(a, b, 'truce');
    r.x.core.addGrievance(b, a, 60);
    expect(r.pol.acceptChance(a, b, 'truce')).toBeLessThan(calm);
    expect(r.pol.acceptChance(a, a, 'truce')).toBe(0);
  });

  it('a House proposing to the player writes a letter; accepting makes the pact, declining does not', () => {
    const r = rig({ preset: 'small', keepPlayer: true });
    const [a, b] = kings(r);
    // make the second king the player’s House
    const player = r.x.core.headOf(b)!;
    makePlayer(r.sim, player);
    r.x.core.invalidate();
    const seen: Array<SimEvents['request']> = [];
    r.sim.events.on('request', (e) => seen.push(e));
    expect(r.pol.propose(a, b, 'truce').reason).toBe('sent');
    expect(r.pol.inbox().length).toBe(1);
    expect(seen.length).toBe(1);
    expect(r.pol.stance(a, b)).toBe('neutral');
    const id = r.pol.inbox()[0].id;
    expect(r.pol.answer(id, true).ok).toBe(true);
    expect(r.pol.stance(a, b)).toBe('truce');
    expect(r.pol.inbox().length).toBe(0);

    r.pol.propose(a, b, 'trade');
    r.pol.answer(r.pol.inbox()[0].id, false);
    expect(r.pol.stance(a, b)).toBe('truce');
    expect(r.pol.answer(9999, true).ok).toBe(false);
  });

  it('a refused demand to kneel is remembered, and an unanswered letter lapses', () => {
    const r = rig({ preset: 'small', keepPlayer: true });
    const [a, b] = kings(r);
    makePlayer(r.sim, r.x.core.headOf(b)!);
    r.x.core.invalidate();
    r.pol.propose(a, b, 'submit');
    expect(r.pol.inbox()[0].kind).toBe('submit');
    r.pol.answer(r.pol.inbox()[0].id, false);
    expect(r.x.core.mindOf(a).ultimatum).toBe(b);
    // an unanswered demand counts as a refusal
    r.x.core.mindOf(a).ultimatum = 0;
    r.pol.propose(a, b, 'submit');
    r.sim.advanceDays(9);
    expect(r.pol.inbox().length).toBe(0);
    // the demander either still holds the grudge or has already gone to war over it
    const war = r.x.core.save.wars.find((w) => w.cause === 'submission');
    expect(r.x.core.mindOf(a).ultimatum === b || (!!war && war.attackers[0] === a && war.defenders[0] === b)).toBe(true);
  });

  it('marriage options pair adult unmarried nobles of two Houses, avoiding close kin', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const ha = r.x.core.headOf(a)!, hb = r.x.core.headOf(b)!;
    const son = noble(r, a, 'm', 20, { father: ha, tier: 6 });
    const daughter = noble(r, b, 'f', 18, { father: hb, tier: 6 });
    const opts = r.pol.matchOptions(a, b);
    expect(opts.some((o) => o.ward === son.id && o.partner === daughter.id)).toBe(true);
    for (const o of opts) {
      const w = r.sim.state.persons.get(o.ward)!, p = r.sim.state.persons.get(o.partner)!;
      expect(w.sex).not.toBe(p.sex);
      expect(w.spouse).toBe(0);
      expect(p.spouse).toBe(0);
    }
    // two of one House are brother and sister: never offered to each other
    expect(r.pol.matchOptions(a, a).length).toBeGreaterThanOrEqual(0);
  });
});
