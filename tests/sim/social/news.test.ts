import { describe, expect, it } from 'vitest';
import { NEWS } from '../../../src/sim/social/tuning';
import { killPerson } from '../../../src/sim/succession';
import type { Person } from '../../../src/sim/state';
import { begin, mkPerson, pick, rig, setClock, villager, type Rig } from './helpers';

function newborn(r: Rig, mother: Person, daysAgo = 1): Person {
  const child = mkPerson(r.sim, { age: 0, sex: 'f', household: mother.household, mother, settlement: mother.settlement });
  child.birthDay = Math.floor(r.sim.absDay) - daysAgo;
  return child;
}

describe('news and rumour', () => {
  it('tells of births, burials, weddings and the sick in the settlement, by name', () => {
    const r = rig({ seed: 'news-local' });
    setClock(r.sim, 0.5, 5);
    const mother = villager(r, { sex: 'f', age: 26, byname: 'Brewster' });
    const baby = newborn(r, mother);
    const old = villager(r, { sex: 'm', age: 71, byname: 'Oldman' });
    killPerson(r.sim, old, 'old_age', r.sim.absDay - 1);
    const groom = villager(r, { sex: 'm', age: 24, byname: 'Newlywed' });
    const bride = villager(r, { sex: 'f', age: 22, byname: 'Newbride' });
    r.sim.state.marry(groom, bride, Math.floor(r.sim.absDay) - 1);
    const lines = r.social.news(mother.settlement, 40);
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(text).toContain(baby.first);
    expect(text).toContain(old.first);
    expect(text).toContain(groom.first);
    for (const l of lines) { expect(l).not.toMatch(/[{}]|undefined/); expect(l.length).toBeGreaterThan(10); }
    expect(r.social.news(mother.settlement, 2).length).toBeLessThanOrEqual(2);
  });

  it('travels: news from a neighbouring settlement arrives after distance / speed days, and grows stale', () => {
    const r = rig({ seed: 'news-travel', preset: 'small' });
    setClock(r.sim, 0.5, 5);
    const home = r.player.settlement;
    const far = r.core.nearby(home, NEWS.reach)[0];
    expect(far).toBeDefined();
    const mother = villager(r, { sex: 'f', age: 26, byname: 'Faraway', settlement: far.id });
    const baby = newborn(r, mother, 0);
    baby.birthDay = Math.floor(r.sim.absDay);
    const delay = far.dist / NEWS.spreadPerDay;
    const hearsOfIt = (): boolean => r.social.news(home, 20).some((l) => l.includes(baby.first));
    expect(r.social.news(far.id, 20).some((l) => l.includes(baby.first))).toBe(true); // there it is fresh
    expect(hearsOfIt()).toBe(false); // here it has not arrived
    setClock(r.sim, 0.5 + 0.0, 5 + Math.ceil(delay) + 1);
    expect(hearsOfIt()).toBe(true);
    expect(r.social.news(home, 20).find((l) => l.includes(baby.first))).toMatch(new RegExp(`${r.core.placeName(far.id)}`));
    setClock(r.sim, 0.5, 5 + NEWS.lifetimeDays + 3);
    expect(hearsOfIt()).toBe(false);
  });

  it('carries the market\'s talk of prices when the economy supplies it', () => {
    const r = rig({ seed: 'news-prices' });
    r.social.setHooks?.({ priceTipsHook: () => [{ good: 'wheat', trend: 0.5 }, { good: 'salt', trend: -0.4 }, { good: 'ale', trend: 0.01 }] });
    const lines = r.social.news(r.player.settlement, 10).join(' ');
    expect(lines).toMatch(/wheat/i);
    expect(lines).toMatch(/salt/i);
    expect(lines).not.toMatch(/\bale\b.*price/i);
  });

  it('spreads word of what the player does', () => {
    const r = rig({ seed: 'news-deeds' });
    const poor = villager(r, { tier: 1, estate: 'unfree' });
    r.player.money = 500;
    let c = begin(r, poor);
    c = pick(r, c, 'nav.gift');
    const big = c.options.filter((o) => o.id.startsWith('gift.money.')).map((o) => o.id).sort((a, b) => Number(b.split('.').pop()) - Number(a.split('.').pop()))[0];
    expect(Number(big.split('.').pop())).toBeGreaterThanOrEqual(24);
    r.social.choose(c.id, big);
    const lines = r.social.news(r.player.settlement, 10).join(' ');
    expect(lines).toContain(r.player.first);
    expect(r.core.store.read().rum.some((x) => x.k === 'alms')).toBe(true);
  });

  it('announces an heir taking a title', () => {
    const r = rig({ seed: 'news-heir' });
    const heir = villager(r, { sex: 'm', age: 30, tier: 5, estate: 'noble', career: 'knight', byname: 'Heirloom' });
    const father = villager(r, { sex: 'm', age: 60, tier: 5, estate: 'noble', byname: 'Heirloom' });
    const title = r.sim.state.titleFor('manor', heir.settlement) ?? [...r.sim.state.titles.values()][0];
    r.sim.events.emit('inheritance', { from: father.id, to: heir.id, title: title.id });
    const text = r.social.news(heir.settlement, 8).join(' ');
    expect(text).toContain(heir.first);
    expect(text).toContain(title.name);
  });

  it('is deterministic and cheap enough to ask for freely', () => {
    const r = rig({ seed: 'news-cost', preset: 'large' });
    r.sim.advanceDays(6);
    const s = r.player.settlement;
    const a = r.social.news(s, 6);
    const b = r.social.news(s, 6);
    expect(b).toEqual(a);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) { setClock(r.sim, 0.5, 8 + i); r.social.news(s, 6); }
    expect((performance.now() - t0) / 20).toBeLessThan(15);
  });
});
