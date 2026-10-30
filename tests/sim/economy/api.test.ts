// The economy API as the UI, the player controller and the social system use it.
import { describe, expect, it } from 'vitest';
import { econSim, makeFarmer, playerOf } from './helpers';

describe('economy API', () => {
  it('drop throws goods away; give to nobody means the same', () => {
    const { sim, eco } = econSim({ seed: 'api-drop' });
    const { player } = makeFarmer(sim, { age: 16, strips: 1 });
    player.inventory['sickle#0'] = 1;
    player.inventory['bread'] = 4;
    player.money = 20;
    eco.equip(player.id, 'main', 'sickle#0');
    expect(eco.inventory(player.id).equipment.main).toBe('sickle#0');
    expect(eco.drop(player.id, 'bread', 2)).toEqual({ ok: true });
    expect(player.inventory['bread']).toBe(2);
    expect(eco.give(player.id, 0, 'bread', 5).ok).toBe(false); // more than carried
    expect(eco.give(player.id, 0, 'bread', 2).ok).toBe(true);
    expect(player.inventory['bread']).toBeUndefined();
    // dropping the last sickle takes it out of the hand
    expect(eco.drop(player.id, 'sickle#0', 1).ok).toBe(true);
    expect(eco.inventory(player.id).equipment.main).toBeUndefined();
    expect(player.inventory['~w:sickle#0']).toBeUndefined();
    expect(eco.drop(player.id, 'money', 5).ok).toBe(true);
    expect(player.money).toBe(15);
    expect(eco.drop(player.id, 'wheat', 0).ok).toBe(false);
    expect(eco.drop(player.id, 'cow', 1).ok).toBe(false);
  });

  it('gives goods to another person within carrying limits', () => {
    const { sim, eco } = econSim({ seed: 'api-give' });
    const { player, hh } = makeFarmer(sim, { age: 16, strips: 1 });
    const other = sim.state.persons.get(hh.members.find((id) => id !== player.id)!) ?? [...sim.state.persons.values()].find((p) => !p.death && p.id !== player.id)!;
    player.inventory['bread'] = 3;
    expect(eco.give(player.id, other.id, 'bread', 2).ok).toBe(true);
    expect(other.inventory['bread']).toBe(2);
    expect(player.inventory['bread']).toBe(1);
    expect(eco.give(player.id, other.id, 'bread', 9).ok).toBe(false);
  });

  it('registers its links with the social system', () => {
    const { sim, eco, hooks, topics } = econSim({ seed: 'api-hooks' });
    const player = playerOf(sim);
    expect(topics.length).toBeGreaterThan(0);
    expect(hooks.giveHook && hooks.itemInfoHook && hooks.priceTipsHook && hooks.dressTierHook && hooks.apprenticeHook).toBeTruthy();
    expect(hooks.itemInfoHook!('sickle#2')).toEqual({ name: 'good sickle', value: expect.any(Number) });
    expect(hooks.itemInfoHook!('no_such_thing')).toBeNull();
    expect(hooks.itemInfoHook!('sickle#2')!.value).toBeGreaterThan(hooks.itemInfoHook!('sickle#0')!.value);
    const town = sim.world.settlements.find((s) => s.kind === 'town')!;
    const tips = hooks.priceTipsHook!(town.id);
    for (const t of tips) { expect(t.trend).toBeGreaterThanOrEqual(-1); expect(t.trend).toBeLessThanOrEqual(1); }
    const tier = hooks.dressTierHook!(player.id);
    expect(tier).toBeGreaterThanOrEqual(1);
    expect(tier).toBeLessThanOrEqual(8);
    // a gift through the hook moves real goods
    player.inventory['bread'] = 2;
    const other = [...sim.state.persons.values()].find((p) => !p.death && p.id !== player.id)!;
    expect(hooks.giveHook!(player.id, other.id, 'bread', 1).ok).toBe(true);
    expect(other.inventory['bread']).toBe(1);
    void eco;
  });

  it('the apprentice hook quotes the premium and binds the youth', () => {
    const { sim, hooks, eco } = econSim({ seed: 'smith' });
    // find any master taking an apprentice and a boy in the same place
    let master = 0, boy = 0, premium = -1;
    for (const s of sim.world.settlements) {
      const job = eco.jobs(s.id, playerOf(sim).id).find((j) => j.terms === 'apprenticeship' && j.employer);
      if (!job) continue;
      master = job.employer;
      break;
    }
    expect(master).toBeGreaterThan(0);
    const m = sim.state.persons.get(master)!;
    const youth = [...sim.state.persons.values()].find((p) => !p.death && p.sex === 'm' && p.id !== master && p.household !== m.household && (sim.absDay - p.birthDay) / 16 >= 12 && (sim.absDay - p.birthDay) / 16 <= 16 && !eco.econ.isHired(p.id) && p.id !== playerOf(sim).id);
    expect(youth).toBeTruthy();
    boy = youth!.id;
    const quote = hooks.apprenticeHook!(boy, master, true);
    premium = quote.premium ?? 0;
    expect(quote.ok, quote.reason).toBe(true);
    const hh = sim.state.households.get(youth!.household)!;
    hh.purse = premium + 50;
    const done = hooks.apprenticeHook!(boy, master);
    expect(done.ok, done.reason).toBe(true);
    expect(youth!.household).toBe(m.household);
    expect(hh.purse).toBeLessThan(premium + 50);
  });
});
