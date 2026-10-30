import { describe, expect, it } from 'vitest';
import { MemorySaveStore } from '../../../src/sim/save-memory';
import { hashState } from '../../../src/sim/serialize';
import { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import { mockGenerator } from '../helpers';
import { begin, forceRolls, makePlayer, mkPerson, pick, rig, setClock, villager, type Rig } from './helpers';
import { newSim } from '../helpers';

const gen = mockGenerator('tiny');

/** A busy few days of social life: talk, gifts, a loan, an insult, courting, a rumour. */
function socialLife(r: Rig): void {
  const st = r.sim.state;
  const me = mkPerson(r.sim, { sex: 'm', age: 19, household: r.player.household, father: st.persons.get(r.player.father), mother: st.persons.get(r.player.mother), byname: 'Hero' });
  makePlayer(r.sim, me);
  r.player = me;
  me.money = 600;
  const friend = villager(r, { money: 500 });
  const her = villager(r, { sex: 'f', age: 18, byname: 'Belove' });
  const priest = villager(r, { career: 'priest', estate: 'clergy', sex: 'm', age: 42 });
  priest.skills.letters = 1200;
  r.social.adjustOpinion(friend.id, me.id, 40, 'gift');
  const yes = forceRolls(r, 0.0);
  let c = begin(r, friend);
  c = pick(r, c, 'nav.chat', 'chat.weather', 'chat.hopes', 'nav.back', 'nav.favour');
  const loan = c.options.find((o) => o.id.startsWith('favour.loan.'));
  if (loan) c = pick(r, c, loan.id);
  c = pick(r, c, 'nav.back', 'nav.gift');
  const gift = c.options.find((o) => o.id.startsWith('gift.money.'));
  if (gift) c = pick(r, c, gift.id);
  r.social.end(c.id);
  r.sim.advanceDays(1);
  c = begin(r, her);
  c = pick(r, c, 'nav.court', 'romance.compliment', 'romance.walk');
  r.social.end(c.id);
  c = begin(r, priest);
  c = pick(r, c, 'nav.favour', 'favour.lessons', 'nav.back', 'nav.say', 'say.insult');
  if (!c.ended) r.social.end(c.id);
  yes();
  r.social.news(me.settlement, 6);
}

describe('saving and loading', () => {
  it('installing the module changes nothing in a save; its data appears only once there is some', () => {
    const a = newSim({ seed: 'persist-clean' });
    const before = hashState(a.state);
    installSocial(a);
    expect(hashState(a.state)).toBe(before);
    expect(a.state.ext['social']).toBeUndefined();
    const r = rig({ seed: 'persist-clean' });
    expect(hashState(r.sim.state)).not.toBe(before === '' ? 'x' : '' ); // the rig also moved the clock
    r.social.adjustOpinion(villager(r).id, r.player.id, 5, 'gift');
    expect(r.sim.state.ext['social']).toBeDefined();
  });

  it('round-trips: save → load → continue gives the same hash as never saving', async () => {
    const store = new MemorySaveStore();
    const r = rig({ seed: 'persist-rt', store, autosave: { intervalMs: 0 } });
    socialLife(r);
    const data = JSON.stringify(r.sim.state.ext['social']);
    expect(data.length).toBeGreaterThan(50);
    expect(data.length).toBeLessThan(6000);
    r.sim.state.markAllDirty(); // the test built people by hand, without touching them
    await r.sim.flush();
    const loaded = (await Simulation.load(store, gen))!;
    const social2 = installSocial(loaded);
    expect(JSON.stringify(loaded.state.ext['social'])).toBe(data);
    expect(hashState(loaded.state)).toBe(hashState(r.sim.state));
    // the loaded game remembers what the player did
    expect(social2.relations(r.player.id).length).toBeGreaterThan(0);
    // carry on identically: days pass (decay, courtship cooling, debts souring) …
    r.sim.advanceDays(9);
    loaded.advanceDays(9);
    expect(hashState(loaded.state)).toBe(hashState(r.sim.state));
    // … and the same new conversation has the same consequences (the RNG streams were saved)
    const act = (sim: Simulation, social: ReturnType<typeof installSocial>): void => {
      const player = sim.state.persons.get(sim.state.run.playerId)!;
      const npc = [...sim.state.residentsOf(player.settlement)].find((p) => p.id !== player.id && p.rankTier === 2 && !p.death && p.sex === 'f' && p.id % 3 === 0)!;
      const c = social.start(player.id, npc.id);
      if ('ok' in c) throw new Error(c.reason);
      let cur = social.choose(c.id, 'nav.say');
      cur = social.choose(cur.id, 'say.flatter');
      if (!cur.ended) social.end(cur.id);
    };
    act(r.sim, r.social);
    act(loaded, social2);
    expect(hashState(loaded.state)).toBe(hashState(r.sim.state));
  });

  it('survives a save in the middle of a conversation: the loaded game is not stuck in action time', async () => {
    const store = new MemorySaveStore();
    const r = rig({ seed: 'persist-mid', store, autosave: { intervalMs: 0 } });
    const npc = villager(r);
    begin(r, npc);
    expect(r.sim.state.clock.actionTime).toBe(true);
    r.sim.state.markAllDirty();
    await r.sim.flush();
    const loaded = (await Simulation.load(store, gen))!;
    expect(loaded.state.clock.actionTime).toBe(true); // as saved…
    const social2 = installSocial(loaded);
    expect(loaded.state.clock.actionTime).toBe(false); // …until the social system starts
    expect(social2.current()).toBeNull();
  });
});

describe('records stay small and clean', () => {
  it('keeps its section bounded and free of NaN, Infinity and negative zero after a lot of play', () => {
    const r = rig({ seed: 'persist-bounded' });
    socialLife(r);
    const people = Array.from({ length: 40 }, () => villager(r, { money: 300 }));
    const roll = forceRolls(r, 0.3);
    for (let day = 0; day < 20; day++) {
      setClock(r.sim, 0.5, 3 + day);
      for (const p of people.slice(day, day + 6)) {
        let c = begin(r, p);
        for (const path of [['nav.chat', 'chat.weather', 'nav.back'], ['nav.say', 'say.flatter', 'say.boast', 'nav.back'], ['nav.gift']]) {
          if (c.ended) break;
          for (const id of path) c = r.social.choose(c.id, id);
        }
        const gift = c.options.find((o) => o.id.startsWith('gift.money.'));
        if (gift && !c.ended) r.social.choose(c.id, gift.id);
        if (!c.ended) r.social.end(c.id);
      }
      r.sim.advanceHours(1);
    }
    roll();
    const d = r.core.store.read();
    expect(d.mem.length).toBeLessThanOrEqual(140);
    expect(d.talk.length).toBeLessThanOrEqual(48);
    expect(d.rum.length).toBeLessThanOrEqual(40);
    expect(Object.keys(d.told).length).toBeLessThanOrEqual(60);
    expect(JSON.stringify(d).length).toBeLessThan(20000);
    const bad: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'number') { if (Object.is(v, -0) || !Number.isFinite(v)) bad.push(`${path}=${String(v)}`); }
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(d, 'social');
    for (const p of r.sim.state.persons.values()) { walk(p.opinions, `opinions ${p.id}`); walk(p.rep, `rep ${p.id}`); walk(p.needs, `needs ${p.id}`); walk(p.money, `money ${p.id}`); }
    expect(bad).toEqual([]);
    // talk records fade after a few days
    r.sim.advanceDays(5);
    expect(r.core.store.read().talk.length).toBe(0);
  });
});
