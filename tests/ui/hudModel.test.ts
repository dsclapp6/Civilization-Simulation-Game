import { describe, expect, it } from 'vitest';
import { daylight } from '../../src/core/time';
import type { PlayerHud, TravelState } from '../../src/player/types';
import {
  NEED_CRITICAL, NEED_LOW, actionView, dayFlags, dialModel, healthLevel, lowestNeed, needLevel, needViews, promptView, secondsText, travelView,
} from '../../src/ui/core/hudModel';
import { marketDayOf } from '../../src/sim/calendar';

describe('needs', () => {
  it('stays quiet until a need is low, then asks for attention', () => {
    expect(needLevel(1)).toBe('ok');
    expect(needLevel(NEED_LOW + 0.01)).toBe('ok');
    expect(needLevel(NEED_LOW - 0.01)).toBe('low');
    expect(needLevel(NEED_CRITICAL - 0.01)).toBe('critical');
    expect(needLevel(0)).toBe('critical');
  });

  it('describes each need and finds the worst', () => {
    const views = needViews({ hunger: 0.9, rest: 0.3, warmth: 0.1, mood: 0.6 });
    expect(views.map((v) => `${v.id}:${v.level}`)).toEqual(['hunger:ok', 'rest:low', 'warmth:critical', 'mood:ok']);
    expect(views[2].hint).toContain('Freezing');
    expect(views[0].hint).toBe('Hunger: Well fed.');
    expect(lowestNeed(views)?.id).toBe('warmth');
    expect(lowestNeed(needViews({ hunger: 1, rest: 1, warmth: 1, mood: 1 }))).toBeNull();
  });

  it('clamps out-of-range values', () => {
    expect(needViews({ hunger: 2, rest: -1, warmth: 0.5, mood: NaN })[1].value).toBe(0);
    expect(needViews({ hunger: 2, rest: -1, warmth: 0.5, mood: NaN })[0].value).toBe(1);
  });

  it('rates health', () => {
    expect(healthLevel(40, 40)).toBe('ok');
    expect(healthLevel(15, 40)).toBe('hurt');
    expect(healthLevel(5, 40)).toBe('critical');
    expect(healthLevel(0, 0)).toBe('ok');
  });
});

describe('calendar flags', () => {
  it('knows the holy day (the fourth of each season) and counts down to it', () => {
    expect(dayFlags(0.4, null)).toMatchObject({ dayOfWeek: 1, holy: false, daysToHoly: 3 });
    expect(dayFlags(3.4, null)).toMatchObject({ dayOfWeek: 4, holy: true, daysToHoly: 0 });
    expect(dayFlags(4.4, null).daysToHoly).toBe(3);
  });

  it('flags market days only where there is a market', () => {
    const town = 5;
    const day = marketDayOf(town) - 1; // dayOfWeek is 1-based within the season
    expect(dayFlags(day + 0.5, town).market).toBe(true);
    expect(dayFlags(day + 0.5, null).market).toBe(false);
    expect(dayFlags(3.5, town).market).toBe(false); // never on the holy day
  });
});

describe('sun and moon dial', () => {
  it('puts noon at the top and midnight at the bottom', () => {
    expect(dialModel(1, 0.5).handDeg).toBeCloseTo(0);
    expect(Math.abs(dialModel(1, 0).handDeg)).toBeCloseTo(180);
    expect(dialModel(1, 0.75).handDeg).toBeCloseTo(90);
    expect(dialModel(1, 0.25).handDeg).toBeCloseTo(-90);
  });

  it('draws the daylight wedge from sunrise to sunset and widens it in summer', () => {
    for (const season of [0, 1, 2, 3] as const) {
      const d = dialModel(season, 0.5);
      const { sunrise, sunset } = daylight(season);
      expect(d.sunriseDeg).toBeCloseTo((sunrise - 0.5) * 360);
      expect(d.sunsetDeg).toBeCloseTo((sunset - 0.5) * 360);
      expect(d.sunriseDeg).toBeLessThan(0);
      expect(d.sunsetDeg).toBeGreaterThan(0);
    }
    const span = (s: 0 | 1 | 2 | 3): number => dialModel(s, 0.5).sunsetDeg - dialModel(s, 0.5).sunriseDeg;
    expect(span(1)).toBeGreaterThan(span(3));
  });

  it('knows day from night', () => {
    expect(dialModel(1, 0.5).night).toBe(false);
    expect(dialModel(1, 0.02).night).toBe(true);
    expect(dialModel(3, 0.8).night).toBe(true);
  });
});

describe('travel, action and prompt summaries', () => {
  const travel = (over: Partial<TravelState> = {}): TravelState => ({ phase: 'travelling', from: 1, to: 4, route: [], progress: 0.42, daysLeft: 1.6, ...over });
  const place = (id: number): string => ['Ashford', 'Wick', 'Oakham', 'Mill', 'Elmstead'][id] ?? '?';

  it('words a journey', () => {
    const v = travelView(travel(), place);
    expect(v.title).toBe('Journey to Elmstead');
    expect(v.remaining).toBe('About 1.6 days left');
    expect(v.progress).toBeCloseTo(0.42);
    expect(travelView(travel({ daysLeft: 1 }), place).remaining).toBe('About 1 day left');
    expect(travelView(travel({ daysLeft: 0.02 }), place).remaining).toBe('Arriving now');
    expect(travelView(travel({ phase: 'arrived', progress: 1 }), place).title).toBe('Arrived at Elmstead');
    const enc = travelView(travel({ phase: 'encounter', encounter: { kind: 'bandits', label: 'Outlaws', hostile: true } }), place);
    expect(enc.hostile).toBe(true);
    expect(enc.encounter).toBe('Outlaws');
  });

  it('counts down an action', () => {
    expect(actionView({ label: 'Reap', progress: 0.25, seconds: 8 })).toEqual({ label: 'Reap', progress: 0.25, secondsLeft: 6 });
    expect(actionView({ label: 'Reap', progress: 1, seconds: 8 }).secondsLeft).toBe(0);
    expect(secondsText(1)).toBe('1 second');
    expect(secondsText(45)).toBe('45 seconds');
    expect(secondsText(150)).toBe('3 minutes');
  });

  it('shows the reason only when the prompt is disabled', () => {
    const ok: PlayerHud['prompt'] = { label: 'Reap', targetLabel: 'strip of barley', enabled: true, reason: 'ignored' };
    expect(promptView(ok)).toEqual({ label: 'Reap', target: 'strip of barley', enabled: true, reason: '' });
    const no: PlayerHud['prompt'] = { label: 'Reap', targetLabel: 'strip of barley', enabled: false, reason: 'Needs a sickle' };
    expect(promptView(no)?.reason).toBe('Needs a sickle');
    expect(promptView(null)).toBeNull();
  });
});
