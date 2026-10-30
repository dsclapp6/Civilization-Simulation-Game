import { describe, expect, it } from 'vitest';
import {
  FEED_TTL, Feed, feedForChronicle, feedForNotify, feedForOpinion, feedForSkip, feedForTrade, feedForTravel, gainChip,
  toastForPoints, toastForRank, toastForSkillLevel,
} from '../../src/ui/core/feed';

const PLAYER = 7;

describe('feed queue', () => {
  it('keeps the newest lines and drops the oldest past the limit', () => {
    const feed = new Feed(3);
    for (let i = 0; i < 5; i++) feed.push({ kind: 'info', text: `line ${i}` }, i * 10);
    expect(feed.list().map((l) => l.text)).toEqual(['line 2', 'line 3', 'line 4']);
  });

  it('merges identical lines in quick succession into a count', () => {
    const feed = new Feed(6, 6);
    feed.push({ kind: 'gain', text: 'You reap a quarter of the strip.' }, 1);
    feed.push({ kind: 'gain', text: 'You reap a quarter of the strip.' }, 3);
    feed.push({ kind: 'gain', text: 'You reap a quarter of the strip.' }, 5);
    expect(feed.list()).toHaveLength(1);
    expect(feed.list()[0].count).toBe(3);
    // too late to merge, or a different kind: a new line
    feed.push({ kind: 'gain', text: 'You reap a quarter of the strip.' }, 30);
    feed.push({ kind: 'warn', text: 'You reap a quarter of the strip.' }, 31);
    expect(feed.list()).toHaveLength(3);
  });

  it('expires lines by kind and fades them out at the end', () => {
    const feed = new Feed(6);
    const warn = feed.push({ kind: 'warn', text: 'careful' }, 0);
    const info = feed.push({ kind: 'info', text: 'hello' }, 0);
    expect(feed.opacity(info, 1)).toBe(1);
    const nearEnd = FEED_TTL.info - 0.4;
    expect(feed.opacity(info, nearEnd)).toBeGreaterThan(0);
    expect(feed.opacity(info, nearEnd)).toBeLessThan(1);
    expect(feed.prune(FEED_TTL.info + 0.1)).toBe(true);
    expect(feed.list().map((l) => l.id)).toEqual([warn.id]);
    expect(feed.prune(FEED_TTL.warn + 1)).toBe(true);
    expect(feed.list()).toHaveLength(0);
    expect(feed.prune(100)).toBe(false);
  });
});

describe('event to feed mapping', () => {
  it('shows notifications about the player only', () => {
    expect(feedForNotify({ kind: 'gain', text: 'You reap.' }, PLAYER)).toEqual({ kind: 'gain', text: 'You reap.', icon: undefined });
    expect(feedForNotify({ kind: 'warn', text: 'Careful', person: PLAYER }, PLAYER)?.kind).toBe('warn');
    expect(feedForNotify({ kind: 'info', text: 'Someone else', person: 99 }, PLAYER)).toBeNull();
    expect(feedForNotify({ kind: 'info', text: '' }, PLAYER)).toBeNull();
    expect(feedForNotify({ kind: 'danger', text: 'Wolves!' }, PLAYER)?.icon).toBe('swords');
  });

  it('words trades from the player’s side', () => {
    const describe = (item: string, qty: number): string => `${qty} of ${item}`;
    const bought = feedForTrade({ buyer: PLAYER, seller: 0, settlement: 1, item: 'ale', qty: 3, pence: 3 }, PLAYER, describe);
    expect(bought).toEqual({ kind: 'info', icon: 'coin', text: 'Bought 3 of ale for 3d.' });
    const sold = feedForTrade({ buyer: 0, seller: PLAYER, settlement: 1, item: 'wool', qty: 2, pence: 36 }, PLAYER, describe);
    expect(sold?.kind).toBe('gain');
    expect(sold?.text).toBe('Sold 2 of wool for 3s.');
    expect(feedForTrade({ buyer: 3, seller: 4, settlement: 1, item: 'ale', qty: 1, pence: 1 }, PLAYER, describe)).toBeNull();
  });

  it('shows opinion shifts about the player that matter', () => {
    const name = (id: number): string => (id === 5 ? 'Agnes' : 'Hugh');
    expect(feedForOpinion({ of: 5, about: PLAYER, delta: 4, reason: 'a kind word' }, PLAYER, name)?.text).toBe('Agnes thinks better of you (+4) — a kind word');
    expect(feedForOpinion({ of: 5, about: PLAYER, delta: -6, reason: '' }, PLAYER, name)?.text).toBe(`Agnes thinks less of you (−6)`);
    expect(feedForOpinion({ of: 5, about: PLAYER, delta: 1, reason: 'x' }, PLAYER, name)).toBeNull();
    expect(feedForOpinion({ of: PLAYER, about: 5, delta: 9, reason: 'x' }, PLAYER, name)).toBeNull();
  });

  it('tells the story of a journey', () => {
    const place = (id: number): string => `Place${id}`;
    expect(feedForTravel({ phase: 'start', to: 3 }, place)?.text).toBe('You set out for Place3.');
    expect(feedForTravel({ phase: 'arrive', to: 3 }, place)?.kind).toBe('gain');
    expect(feedForTravel({ phase: 'encounter', to: 3, encounter: 'bandits' }, place)).toMatchObject({ kind: 'warn', text: 'On the road: bandits.' });
    expect(feedForTravel({ phase: 'cancel', to: 3 }, place)?.text).toBe('You abandon the journey.');
  });

  it('words the end of sleeping and waiting, and stays quiet at the start', () => {
    expect(feedForSkip({ phase: 'start', kind: 'sleep', label: 'Sleep until dawn' })).toBeNull();
    expect(feedForSkip({ phase: 'end', kind: 'sleep', label: 'Sleep until dawn' })?.text).toBe('You wake, rested.');
    expect(feedForSkip({ phase: 'end', kind: 'wait', label: 'Wait until noon' })?.text).toBe('Wait until noon is over.');
    expect(feedForSkip({ phase: 'timeout', kind: 'wait', label: 'x' })?.kind).toBe('warn');
  });

  it('feeds only family news from the chronicle', () => {
    const family = new Set([1, 2]);
    expect(feedForChronicle({ day: 3, kind: 'death', text: 'Agnes died.', persons: [2] }, family)).toMatchObject({ kind: 'loss', text: 'Agnes died.' });
    expect(feedForChronicle({ day: 3, kind: 'birth', text: 'A child was born.', persons: [9, 1] }, family)?.kind).toBe('gain');
    expect(feedForChronicle({ day: 3, kind: 'death', text: 'A stranger died.', persons: [9] }, family)).toBeNull();
    expect(feedForChronicle({ day: 3, kind: 'switch', text: 'You are now Wat.', persons: [1] }, family)).toBeNull();
  });
});

describe('toasts and gain chips', () => {
  it('makes a gold toast for points and a perk toast with an action', () => {
    expect(toastForPoints({ kind: 'rank', amount: 150, reason: 'Reached rank 3', total: 150 })).toMatchObject({ tone: 'gold', title: '+150 points', text: 'Reached rank 3' });
    const perk = toastForSkillLevel({ person: PLAYER, skill: 'farming', level: 5, perkChoice: true }, PLAYER);
    expect(perk?.title).toBe('Farming 5');
    expect(perk?.action?.request).toEqual({ panel: 'perk', person: PLAYER, skill: 'farming' });
    const plain = toastForSkillLevel({ person: PLAYER, skill: 'archery', level: 3, perkChoice: false }, PLAYER);
    expect(plain?.action).toBeUndefined();
    expect(toastForSkillLevel({ person: 99, skill: 'archery', level: 3, perkChoice: false }, PLAYER)).toBeNull();
  });

  it('announces a rise or fall in station', () => {
    expect(toastForRank({ person: PLAYER, from: 2, to: 3 }, PLAYER)).toMatchObject({ tone: 'gold', text: 'Commoner → Middling' });
    expect(toastForRank({ person: PLAYER, from: 3, to: 2 }, PLAYER)?.tone).toBe('vermilion');
    expect(toastForRank({ person: PLAYER, from: 2, to: 2 }, PLAYER)).toBeNull();
  });

  it('turns action gains into icon chips', () => {
    const goodIcon = (ref: string): 'wheat' | undefined => (ref === 'wheat' ? 'wheat' : undefined);
    expect(gainChip({ label: 'sheaves', amount: 3, ref: 'wheat' }, goodIcon)).toEqual({ icon: 'wheat', text: '+3 sheaves' });
    expect(gainChip({ label: 'Farming', amount: 12, ref: 'farming' }, goodIcon)).toEqual({ icon: 'farming', text: '+12 Farming' });
    expect(gainChip({ label: '', amount: 14, ref: 'money' }, goodIcon)).toEqual({ icon: 'coin', text: '+1s 2d' });
    expect(gainChip({ label: 'a trinket', ref: 'trinket' }, goodIcon)).toEqual({ icon: 'box', text: 'a trinket' });
  });
});
