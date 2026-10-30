import { describe, expect, it } from 'vitest';
import {
  MINUS, ageText, barFraction, chronicleDate, clamp01, clockText, compass, dateText, dateTimeText, deathCauseText, distanceText,
  dueText, ellipsize, joinList, minuteOfDay, ordinal, pct, personWord, plural, relativeDay, signed, thousands, trim, weightText,
} from '../../src/ui/core/format';
import { formatMoney } from '../../src/sim/money';

describe('clock and dates', () => {
  it('formats the time of day from the day fraction', () => {
    expect(clockText(0)).toBe('00:00');
    expect(clockText(0.5)).toBe('12:00');
    expect(clockText(0.25)).toBe('06:00');
    expect(clockText(0.999)).toBe('23:58');
    expect(clockText(1.5)).toBe('12:00');
    expect(clockText(-0.25)).toBe('18:00');
  });

  it('counts displayed minutes so the HUD repaints once a minute', () => {
    expect(minuteOfDay(0.5)).toBe(720);
    expect(minuteOfDay(0.5 + 0.0001)).toBe(720);
    expect(minuteOfDay(0.5 + 1 / 1440)).toBe(721);
  });

  it('formats calendar dates in the 16-day year', () => {
    expect(dateText(0.25)).toBe('Spring 1, Year 1');
    expect(dateText(4)).toBe('Summer 1, Year 1');
    expect(dateText(15.9)).toBe('Winter 4, Year 1');
    expect(dateText(16)).toBe('Spring 1, Year 2');
    expect(dateTimeText(16.5)).toBe('Spring 1, Year 2 · 12:00');
    expect(chronicleDate(21)).toBe('Y2 · Summer 2');
  });

  it('describes days relative to today', () => {
    expect(relativeDay(10.9, 10.1)).toBe('today');
    expect(relativeDay(11.2, 10.9)).toBe('tomorrow');
    expect(relativeDay(9.5, 10.5)).toBe('yesterday');
    expect(relativeDay(14, 10)).toBe('in 4 days');
    expect(relativeDay(5, 10)).toBe('5 days ago');
  });

  it('words obligations by due date', () => {
    expect(dueText(10.2, 10.8)).toBe('due today');
    expect(dueText(13, 10)).toBe('due in 3 days');
    expect(dueText(11, 10)).toBe('due tomorrow');
    expect(dueText(8, 10)).toBe('overdue by 2 days');
    expect(dueText(9, 10)).toBe('overdue by 1 day');
  });
});

describe('numbers and words', () => {
  it('pluralises and groups', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(3, 'day')).toBe('3 days');
    expect(plural(0, 'child', 'children')).toBe('0 children');
    expect(plural(1, 'child', 'children')).toBe('1 child');
    expect(thousands(1234567)).toBe('1,234,567');
    expect(thousands(999.6)).toBe('1,000');
  });

  it('trims decimals and signs deltas with a true minus', () => {
    expect(trim(2.5, 1)).toBe('2.5');
    expect(trim(2, 1)).toBe('2');
    expect(trim(2.449, 1)).toBe('2.4');
    expect(signed(4)).toBe('+4');
    expect(signed(-3)).toBe(`${MINUS}3`);
    expect(signed(0)).toBe('0');
    expect(signed(0.04)).toBe('0');
    expect(signed(1.25, 1)).toBe('+1.3');
  });

  it('formats percentages, weights and distances', () => {
    expect(pct(0.425)).toBe('43%');
    expect(pct(2)).toBe('100%');
    expect(pct(-1)).toBe('0%');
    expect(pct(0.1234, 1)).toBe('12.3%');
    expect(weightText(0.65)).toBe('0.7 kg');
    expect(weightText(12.4)).toBe('12 kg');
    expect(distanceText(420)).toBe('420 m');
    expect(distanceText(1234)).toBe('1.2 km');
    expect(distanceText(16000)).toBe('16 km');
  });

  it('names compass directions with x east and z south', () => {
    expect(compass(0, -100)).toBe('north');
    expect(compass(100, 0)).toBe('east');
    expect(compass(0, 100)).toBe('south');
    expect(compass(-100, 0)).toBe('west');
    expect(compass(100, -100)).toBe('north-east');
    expect(compass(-100, 100)).toBe('south-west');
  });

  it('joins lists, ordinals, ages and clamps', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['a'])).toBe('a');
    expect(joinList(['a', 'b'])).toBe('a and b');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    expect(ageText(12.9)).toBe('12 years');
    expect(ageText(1)).toBe('1 year');
    expect(clamp01(NaN)).toBe(0);
    expect(barFraction(5, 20)).toBe(0.25);
    expect(barFraction(5, 0)).toBe(0);
    expect(ellipsize('hello world', 8)).toBe('hello w…');
    expect(ellipsize('hi', 8)).toBe('hi');
  });

  it('words causes of death and kinds of people', () => {
    expect(deathCauseText('plague')).toBe('of the plague');
    expect(deathCauseText('childbirth')).toBe('in childbirth');
    expect(deathCauseText('execution')).toBe('on the gallows');
    expect(personWord('m', 5)).toBe('boy');
    expect(personWord('f', 15)).toBe('maiden');
    expect(personWord('f', 70)).toBe('old woman');
  });

  it('shows money as pounds, shillings and pence', () => {
    expect(formatMoney(0)).toBe('0d');
    expect(formatMoney(14)).toBe('1s 2d');
    expect(formatMoney(240 + 36 + 5)).toBe('£1 3s 5d');
  });
});
