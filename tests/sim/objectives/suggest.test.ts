// "What now?": the tracked step first, then hunger, sleep, the dark, the market day, the holy day, a villager
// with a request, a perk, and honest ideas when nothing presses.
import { describe, expect, it } from 'vitest';
import { marketDayOf } from '../../../src/sim/calendar';
import { marketTownOf } from '../../../src/sim/objectives/places';
import { objSim, playObjectives, playerOf, setTime, tracked, walkTo, type ObjSim } from './helpers';

/** A tutorial-finished player, so the tracked thing is an ordinary goal and the suggestions are about the world. */
function settled(seed = 's3'): ObjSim {
  const o = objSim({ seed });
  playObjectives(o, ['tutorial']);
  return o;
}

const texts = (o: ObjSim, n = 8): string[] => o.obj.suggestions(n).map((s) => s.text);

describe('suggestions', () => {
  it('start with the tracked step, with its target', () => {
    const o = objSim({ seed: 's1' });
    const s = o.obj.suggestions();
    expect(s[0].text).toBe(tracked(o)!.steps[0].text);
    expect(s[0].target).toEqual(tracked(o)!.steps[0].target);
    expect(s[0].objective).toBe(tracked(o)!.id);
    expect(s.length).toBeLessThanOrEqual(4);
    expect(o.obj.suggestions(1)).toHaveLength(1);
    // no repeats
    expect(new Set(texts(o)).size).toBe(texts(o).length);
  });

  it('say to eat when hungry: from the pack if there is food in it, else at home', () => {
    const o = settled();
    const me = playerOf(o.sim);
    setTime(o.sim, 0.45, 1);
    me.needs.hunger = 0.3;
    expect(texts(o).some((t) => /Eat something/.test(t))).toBe(true);
    for (const k of Object.keys(me.inventory)) delete me.inventory[k];
    const s = o.obj.suggestions(8).find((x) => /hungry/.test(x.text))!;
    expect(s.text).toMatch(/Go home and eat/);
    expect(s.target?.label).toBe('Your home');
    // an ordinary hunger waits behind the tracked goal; starvation comes first
    expect(o.obj.suggestions(1)[0].text).not.toBe(s.text);
    me.needs.hunger = 0.1;
    expect(o.obj.suggestions(1)[0].text).toBe(s.text);
  });

  it('say to sleep when exhausted and to go home when it is getting dark', () => {
    const o = settled();
    const me = playerOf(o.sim);
    walkTo(o, o.at.x + 200, o.at.z + 200);
    setTime(o.sim, 0.45, 1);
    me.needs.rest = 0.1;
    expect(texts(o).some((t) => /Sleep: you are exhausted/.test(t))).toBe(true);
    me.needs.rest = 0.9;
    expect(texts(o).some((t) => /getting dark/.test(t))).toBe(false);
    setTime(o.sim, 0.8, 1);
    const dark = o.obj.suggestions(8).find((x) => /getting dark/.test(x.text))!;
    expect(dark).toBeTruthy();
    expect(dark.target?.label).toBe('Your home');
    // at home already: no need
    const hh = o.sim.state.households.get(me.household)!;
    const home = o.sim.state.buildings.get(hh.home)!;
    walkTo(o, home.x, home.z);
    expect(texts(o).some((t) => /getting dark/.test(t))).toBe(false);
  });

  it('point to the market on market day, and to what could be sold', () => {
    const o = settled('s3');
    const me = playerOf(o.sim);
    const town = marketTownOf(o.obj.obj, me.settlement)!;
    expect(town).toBeTruthy();
    // the next day of the season that is this market's day, at ten in the morning
    let day = Math.floor(o.sim.absDay) + 1;
    while (((day % 4) + 1) !== marketDayOf(town.id)) day++;
    setTime(o.sim, 0.42, day);
    me.inventory.eggs = 6;
    const line = texts(o).find((t) => /market day/.test(t));
    expect(line, texts(o).join(' | ')).toMatch(new RegExp(`${town.name}`));
    expect(line).toMatch(/eggs/);
    // nothing to sell: a plain reminder
    delete me.inventory.eggs;
    for (const k of Object.keys(me.inventory)) if (!/bread|ale|clothes/.test(k)) delete me.inventory[k];
    expect(texts(o).some((t) => new RegExp(`market day in ${town.name}`).test(t))).toBe(true);
  });

  it('point to Mass on the holy day, in the morning', () => {
    const o = settled('s3');
    setTime(o.sim, 0.4, 3);
    const s = o.obj.suggestions(8).find((x) => /Hear Mass/.test(x.text));
    expect(s, texts(o).join(' | ')).toBeTruthy();
    expect(s!.target?.kind).toBe('building');
    setTime(o.sim, 0.9, 3);
    expect(texts(o).some((t) => /Hear Mass/.test(t))).toBe(false);
  });

  it('tell of a villager waiting for a word', () => {
    const o = settled();
    const id = o.adv.happenings.offerRequest('fetch');
    expect(id).toBeGreaterThan(0);
    const from = o.adv.happenings.requests().find((r) => r.id === id)!;
    const line = o.obj.suggestions(8).find((x) => /wants a word/.test(x.text));
    expect(line, texts(o).join(' | ')).toBeTruthy();
    expect(line!.text).toContain(o.sim.state.persons.get(from.from)!.first);
    expect(line!.target?.kind).toBe('person');
  });

  it('remind of a perk waiting to be chosen', () => {
    const o = settled();
    const me = playerOf(o.sim);
    me.skills.farming = 5 * 5 * 40 + 1;
    o.sim.state.touch(me);
    expect(texts(o).some((t) => /Choose a perk for farming/.test(t))).toBe(true);
  });

  it('are never empty, even when nothing presses', () => {
    const o = settled();
    const me = playerOf(o.sim);
    for (const ob of o.obj.list()) if (ob.state === 'active') o.obj.obj.finish(o.obj.obj.byId(ob.id)!, 'expired');
    me.needs.hunger = 1;
    setTime(o.sim, 0.5, 1);
    const s = o.obj.suggestions();
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) expect(x.text.length).toBeGreaterThan(10);
  });
});
