import { describe, expect, it } from 'vitest';
import { MiniLogic, miniKindOf } from '../../src/ui/hud/minigame';

describe('work mini-games', () => {
  it('pick a game for every kind of work, and none for rest or talk', () => {
    expect(miniKindOf('craft.sword', 'work_hammer')).toBe('rhythm');
    expect(miniKindOf('wood.fell', 'work_axe')).toBe('rhythm');
    expect(miniKindOf('farm.plough', 'work_hoe')).toBe('rhythm');
    expect(miniKindOf('farm.sow', 'work_hoe')).toBe('sow');
    expect(miniKindOf('garden.sow', 'work_dig')).toBe('sow');
    expect(miniKindOf('tend', 'kneel')).toBe('steady');
    expect(miniKindOf('bind', 'kneel')).toBe('steady');
    expect(miniKindOf('craft.ale', 'work_stir')).toBe('steady');
    expect(miniKindOf('arms.practise', 'shoot_bow')).toBe('aim');
    expect(miniKindOf('recuperate', '')).toBeNull();
    expect(miniKindOf('farm.wait', 'work_hoe')).toBeNull();
    expect(miniKindOf('talk', 'talk')).toBeNull();
  });

  it('rhythm: a stroke on the gold is perfect, one far off is a miss', () => {
    const L = new MiniLogic('rhythm', 7);
    L.needle = L.band;
    expect(L.press('J')[0].score).toBe(1);
    L.needle = L.band > 0.5 ? 0 : 1;
    expect(L.press('J')[0].score).toBe(0);
    expect(L.mean).toBeCloseTo(0.5);
    // the needle sweeps there and back within the track
    for (let i = 0; i < 200; i++) { L.update(0.05); expect(L.needle).toBeGreaterThanOrEqual(0); expect(L.needle).toBeLessThanOrEqual(1); }
  });

  it('sow: the asked key in time scores, the wrong one or none at all does not', () => {
    const L = new MiniLogic('sow', 3);
    const want = L.want;
    expect(L.press(want)[0].score).toBe(1);
    const wrong = L.want === 'J' ? 'K' : 'J';
    expect(L.press(wrong)[0].score).toBe(0);
    const late = L.update(2);
    expect(late.length).toBe(1);
    expect(late[0].score).toBe(0);
  });

  it('steady: keeping the needle in the band scores; letting it fall away does not', () => {
    const good = new MiniLogic('steady', 1);
    const scores: number[] = [];
    for (let i = 0; i < 120; i++) {
      // a careful hand: hold when below the band, let go when above
      if (good.level < good.steadyBand(good.t + 0.05)) good.press('J'); else good.release('J');
      for (const s of good.update(0.05)) scores.push(s.score);
    }
    expect(scores.length).toBeGreaterThan(8);
    expect(good.mean).toBeGreaterThan(0.75);
    const idle = new MiniLogic('steady', 1);
    for (let i = 0; i < 120; i++) idle.update(0.05);
    expect(idle.mean).toBeLessThan(good.mean);
  });

  it('aim: a full draw loosed on the mark is the gold; an underdrawn shaft falls short', () => {
    const L = new MiniLogic('aim', 5);
    L.press('J');
    for (let i = 0; i < 30; i++) L.update(0.05);
    L.aimX = 0; L.aimY = 0;
    expect(L.release('J')[0].score).toBeGreaterThan(0.95);
    L.press('J');
    L.update(0.1);
    expect(L.release('J')[0].score).toBeLessThan(0.2);
  });

  // work pass (docs/WORK.md): the faults found playing them
  it('an ignored game costs nothing: no misses before the first key of the bout', () => {
    const sow = new MiniLogic('sow', 5);
    expect(sow.update(10)).toEqual([]);
    expect(sow.mean).toBe(-1);
    const steady = new MiniLogic('steady', 5);
    for (let i = 0; i < 100; i++) expect(steady.update(0.05)).toEqual([]);
    expect(steady.mean).toBe(-1);
    // once the player is sowing, a seed not dropped in time is a miss
    sow.press(sow.want);
    const late = sow.update(2);
    expect(late.length).toBe(1);
    expect(late[0].score).toBe(0);
  });

  it('takes only the keys it uses: K is the sower\'s, elsewhere it stays the realm page\'s', () => {
    expect(new MiniLogic('sow', 1).uses('K')).toBe(true);
    for (const k of ['rhythm', 'steady', 'aim'] as const) {
      const L = new MiniLogic(k, 1);
      expect(L.uses('K')).toBe(false);
      expect(L.uses('J')).toBe(true);
      expect(L.press('K')).toEqual([]);
      expect(L.engaged).toBe(false);
    }
  });

  it('sowing is told by the bout\'s motion as well as its id (the garden and the strip both sow)', () => {
    expect(miniKindOf('farm.keep', 'work_sow')).toBe('sow');
    expect(miniKindOf('garden.sow.cabbage', 'work_sow')).toBe('sow');
    expect(miniKindOf('arms.practise.keep', 'shoot_bow')).toBe('aim');
    expect(miniKindOf('dig.stone.keep', 'work_pick')).toBe('rhythm');
  });
});
