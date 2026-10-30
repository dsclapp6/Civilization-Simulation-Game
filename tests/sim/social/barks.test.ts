import { describe, expect, it, vi } from 'vitest';
import { BARK } from '../../../src/sim/social/tuning';
import { BARK_SITUATIONS } from '../../../src/sim/social/barks';
import type { BarkSituation } from '../../../src/sim/social/types';
import { mkPerson, rig, setClock, villager } from './helpers';

describe('barks', () => {
  it('say something for every situation, with no placeholder left behind', () => {
    const r = rig({ seed: 'bark-all', preset: 'small' });
    const people = [...r.sim.state.persons.values()].filter((p) => !p.death && r.core.age(p) >= 3).slice(0, 80);
    for (const s of BARK_SITUATIONS) {
      let heard = 0;
      for (const p of people) {
        const text = r.core.barks.say(p.id, s, r.player.id);
        if (text === null) continue;
        heard++;
        expect(text, `${s}: ${text}`).not.toMatch(/[{}]|undefined/);
        expect(text.length).toBeGreaterThan(2);
        expect(text.length).toBeLessThan(80);
      }
      expect(heard, s).toBe(people.length); // `say` ignores the limits, so everyone has a line
    }
  });

  it('are rate-limited per speaker and quiet most of the time', () => {
    const r = rig({ seed: 'bark-rate' });
    const npc = villager(r);
    // one speaker, asked again and again through half a minute of game time
    let spoke = 0;
    let t = 0.5;
    const times: number[] = [];
    for (let i = 0; i < 400; i++) {
      setClock(r.sim, t);
      const line = r.social.bark(npc.id, 'bump', r.player.id); // an urgent, 85% situation
      if (line !== null) { spoke++; times.push(t); }
      t += 0.0005; // 0.7 s of game time
    }
    expect(spoke).toBeGreaterThan(0);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(BARK.cooldownDays - 1e-9);
    expect(spoke).toBeLessThan(400 * 0.0005 / BARK.cooldownDays + 2);

    // a street full of people at one moment: only a few may greet, though anyone may cry out
    const crowd = Array.from({ length: 60 }, () => villager(r));
    setClock(r.sim, 0.62);
    let greets = 0;
    for (const p of crowd) if (r.social.bark(p.id, 'greet', r.player.id) !== null) greets++;
    expect(greets).toBeLessThanOrEqual(BARK.windowMax);
    setClock(r.sim, 0.9);
    let cries = 0;
    for (const p of crowd) if (r.social.bark(p.id, 'fear', r.player.id) !== null) cries++;
    expect(cries).toBeGreaterThan(BARK.windowMax);
  });

  it('stay mostly silent: over a day of asking, idle talk is rare', () => {
    const r = rig({ seed: 'bark-quiet' });
    const crowd = Array.from({ length: 40 }, () => villager(r));
    let said = 0, asked = 0;
    for (let slot = 0; slot < 60; slot++) {
      setClock(r.sim, 0.3 + slot * 0.01);
      for (const p of crowd) { asked++; if (r.social.bark(p.id, 'idle') !== null) said++; }
    }
    expect(said / asked).toBeLessThan(0.1);
    expect(said).toBeGreaterThan(0);
  });

  it('follow rank and kinship: a serf greets a knight deferentially, kin greet kin', () => {
    const r = rig({ seed: 'bark-rank' });
    const serf = villager(r, { tier: 1, estate: 'unfree' });
    const knight = villager(r, { tier: 5, estate: 'noble', career: 'knight', byname: 'Strong' });
    const spy = vi.spyOn(r.core.speech, 'text');
    r.core.barks.say(serf.id, 'greet', knight.id);
    expect(spy.mock.calls.at(-1)?.[0]).toBe('bark.greet_superior');
    r.core.barks.say(knight.id, 'greet', serf.id);
    expect(spy.mock.calls.at(-1)?.[0]).toBe('bark.greet');
    const kid = mkPerson(r.sim, { age: 10, household: serf.household, father: serf });
    r.core.barks.say(serf.id, 'greet', kid.id);
    expect(spy.mock.calls.at(-1)?.[0]).toBe('bark.greet_kin');
    spy.mockRestore();
    // and the words they use for a lord
    const words = new Set<string>();
    for (let i = 0; i < 80; i++) { setClock(r.sim, 0.2 + i * 0.002); const t = r.core.barks.say(serf.id, 'greet', knight.id); if (t) words.add(t); }
    expect([...words].some((w) => /lord|sir|servant|respects|service/i.test(w))).toBe(true);
  });

  it('use the speaker\'s own tongue now and then', () => {
    const r = rig({ seed: 'bark-culture', preset: 'large' });
    const byCulture = new Map<string, string[]>();
    for (const p of r.sim.state.persons.values()) {
      if (p.death || r.core.age(p) < 14) continue;
      const list = byCulture.get(p.culture) ?? [];
      if (list.length < 12) { list.push(p.id.toString()); byCulture.set(p.culture, list); }
    }
    const flavour: Record<string, RegExp> = { gael: /Mary|God save all/, franc: /Dieu|Merci/, cymric: /Bore da|Diolch|Hwyl/, norse: /Heill|Fare you well/, teuton: /Gott|Danke|Leb wohl/ };
    for (const [culture, re] of Object.entries(flavour)) {
      const ids = (byCulture.get(culture) ?? []).map(Number);
      if (ids.length === 0) continue;
      let found = false;
      for (let i = 0; i < 60 && !found; i++) {
        setClock(r.sim, 0.4 + i * 0.001);
        for (const id of ids) for (const sit of ['greet', 'thanks', 'farewell'] as BarkSituation[]) {
          const text = r.core.barks.say(id, sit, undefined);
          if (text && re.test(text)) found = true;
        }
      }
      expect(found, culture).toBe(true);
    }
  });

  it('are silent from the dead and from infants', () => {
    const r = rig({ seed: 'bark-dead' });
    const baby = mkPerson(r.sim, { age: 1 });
    const gone = villager(r);
    r.sim.state.markDead(gone, r.sim.absDay, 'illness');
    for (let i = 0; i < 50; i++) {
      setClock(r.sim, 0.2 + i * 0.01);
      expect(r.social.bark(baby.id, 'idle')).toBeNull();
      expect(r.social.bark(gone.id, 'fear')).toBeNull();
    }
  });
});
