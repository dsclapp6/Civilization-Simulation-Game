import { describe, expect, it } from 'vitest';
import { DIFFICULTY_GOLD, type Difficulty } from '../../src/core/domain';
import { levelProfile, newProfile } from '../../src/sim/legacy';
import { BIRTH_CLASS_MULTIPLIER, RANK_MILESTONES, TITLE_POINTS, continentPct, ruledTitles } from '../../src/sim/score';
import { Simulation } from '../../src/sim/sim';
import type { BirthClass } from '../../src/sim/state';
import { mockGenerator } from './helpers';

function sim(difficulty: Difficulty = 'knight', seed = 'score'): Simulation {
  return Simulation.newGame({ seed, difficulty, generateWorld: mockGenerator('small'), profile: newProfile() });
}

describe('points and Legacy gold', () => {
  it('multiplies by birth class: serf x1.5, free x1.3, craftsman x1.1, merchant x1.0, gentry x0.9, knightly x0.8, baronial x0.6', () => {
    expect(BIRTH_CLASS_MULTIPLIER).toEqual({ serf: 1.5, free: 1.3, craftsman: 1.1, merchant: 1.0, gentry: 0.9, knightly: 0.8, baronial: 0.6 });
    const s = sim();
    for (const [cls, mult] of Object.entries(BIRTH_CLASS_MULTIPLIER) as Array<[BirthClass, number]>) {
      s.state.run.multiplier = mult;
      const before = s.state.score.points;
      const got = s.score.award('deed', 100, 'test');
      expect(got).toBeCloseTo(100 * mult, 6);
      expect(s.state.score.points - before).toBeCloseTo(100 * mult, 6);
      expect(cls).toBeDefined();
    }
  });

  it('banks gold immediately: 1 gold per 10 points x the difficulty multiplier, with no rounding loss', () => {
    for (const d of ['squire', 'knight', 'lord', 'king'] as const) {
      const s = sim(d, `gold-${d}`);
      s.state.run.multiplier = 1;
      const p = levelProfile(s.profile);
      const g0 = p.legacyGold;
      s.score.award('deed', 1000, 'big');
      expect(p.legacyGold - g0).toBe(Math.floor((1000 / 10) * DIFFICULTY_GOLD[d]));
      // many tiny awards add up exactly like one large one
      const t = sim(d, `gold2-${d}`);
      t.state.run.multiplier = 1;
      for (let i = 0; i < 100; i++) t.score.award('holdings', 7, 'drip');
      expect(levelProfile(t.profile).legacyGold).toBe(Math.floor((700 / 10) * DIFFICULTY_GOLD[d]));
      expect(t.state.score.goldBanked).toBe(levelProfile(t.profile).legacyGold);
    }
  });

  it('emits a points event and keeps a ledger', () => {
    const s = sim();
    s.state.run.multiplier = 1.5;
    const events: Array<{ kind: string; amount: number; total: number }> = [];
    s.events.on('points', (e) => events.push(e));
    s.score.award('rank', 10, 'first');
    s.score.award('deed', 20, 'second');
    expect(events.map((e) => e.amount)).toEqual([15, 30]);
    expect(events[1].total).toBe(45);
    expect(s.state.score.ledger.map((l) => l.reason)).toEqual(['first', 'second']);
    expect(s.state.score.byKind.rank).toBe(15);
    expect(s.score.award('deed', 0, 'nothing')).toBe(0);
    expect(s.score.award('deed', -5, 'negative')).toBe(0);
  });

  it('pays the rank milestones once, the first time each tier is reached (50, 150, 400, 1000, 2500, 6000, 15000, 40000)', () => {
    expect(RANK_MILESTONES.slice(1)).toEqual([50, 150, 400, 1000, 2500, 6000, 15000, 40000]);
    const s = sim();
    s.state.run.multiplier = 1;
    s.state.run.maxTier = 2; // born a free peasant
    expect(s.score.onRankReached(2)).toBe(0); // the birth rank pays nothing
    expect(s.score.onRankReached(1)).toBe(0);
    expect(s.score.onRankReached(3)).toBe(400);
    expect(s.score.onRankReached(3)).toBe(0);
    expect(s.state.run.maxTier).toBe(3);
    expect(s.score.onRankReached(5)).toBe(2500); // skipping a tier does not pay it
    expect(s.score.onRankReached(4)).toBe(0);
    expect(s.state.score.points).toBe(2900);
    expect(s.state.score.milestones).toEqual([3, 5]);
    s.state.run.multiplier = 1.5;
    expect(s.score.onRankReached(8)).toBe(60000);
  });

  it('stops scoring when the run is over', () => {
    const s = sim();
    s.dispatch({ type: 'abandonRun' });
    expect(s.score.award('deed', 100, 'late')).toBe(0);
  });
});

describe('holdings and continent share (stubs with real arithmetic)', () => {
  it('counts titles held by the player\'s House, vassals included, and the share of the continent they cover', () => {
    const s = sim();
    const st = s.state;
    const player = st.persons.get(st.run.playerId)!;
    expect(continentPct(st, s.world)).toBe(0);
    expect(ruledTitles(st).size).toBe(0);
    // crown the player's household head as king of the first kingdom
    const k = s.world.kingdoms[0];
    const kt = st.titleFor('kingdom', k.id)!;
    st.setTitleHolder(kt, player.id);
    const ruled = ruledTitles(st);
    expect(ruled.has(kt)).toBe(true);
    for (const t of st.titles.values()) {
      if (t.kind === 'county' && s.world.counties.find((c) => c.id === t.place)?.kingdom === k.id) expect(ruled.has(t)).toBe(true);
    }
    const pct = continentPct(st, s.world);
    expect(pct).toBeGreaterThan(30);
    expect(pct).toBeLessThan(70); // one of two kingdoms
    // yearly holdings award points
    st.run.multiplier = 1;
    const before = st.score.points;
    s.score.yearly(s.world);
    expect(st.score.points).toBeGreaterThanOrEqual(before + TITLE_POINTS.kingdom);
    expect(st.score.continentPct).toBeCloseTo(pct, 6);
  });
});
