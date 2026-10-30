// Disasters (SPEC §19): plague along the roads, famine after a bad harvest, fire, flood, drought, bandits,
// revolt, succession crises; scaled by difficulty and seeded.
import { describe, expect, it } from 'vitest';
import type { MilitaryApi } from '../../../src/sim/wave3';
import { banditOdds } from '../../../src/sim/happenings/disasters';
import { mkPerson } from '../builders';
import { advSim } from '../advancement/helpers';

const out = (s: string): void => { process.stderr.write(`\n${s}\n`); };
void out;

/** The settlement with most road neighbours (a hub the plague can spread from). */
function hub(a: ReturnType<typeof advSim>): number {
  const h = a.adv.happenings.hap;
  let best = -1, bestN = -1;
  for (const s of a.sim.world.settlements) {
    const n = h.roads.get(s.id)?.length ?? 0;
    if (n > bestN && a.sim.state.residentsOf(s.id).length > 20) { best = s.id; bestN = n; }
  }
  return best;
}

describe('plague', () => {
  it('spreads along the roads, sets the epidemic and kills more people than usual', () => {
    const plague = advSim({ seed: 'plague', preset: 'small' });
    const calm = advSim({ seed: 'plague', preset: 'small' });
    const origin = hub(plague);
    const deaths = (a: ReturnType<typeof advSim>): number => {
      const st = a.sim.state.stats;
      return st.current.deaths + st.history.reduce((n, y) => n + y.deaths, 0);
    };
    const infected = new Set<number>();
    plague.sim.events.on('happening', (e) => { if (e.phase === 'start' && e.kind === 'plague') infected.add(e.settlement); });
    const id = plague.adv.happenings.trigger!('plague', origin);
    expect(id).toBeGreaterThan(0);
    expect(plague.adv.happenings.activeAt(origin)).toContain('plague');
    expect(plague.sim.state.settlements.get(origin)).toBeDefined();
    plague.sim.advanceDays(2);
    expect(plague.sim.state.settlements.get(origin)!.epidemic).toBeGreaterThan(0.1);
    const d0 = deaths(plague), c0 = deaths(calm);
    plague.sim.advanceDays(28);
    calm.sim.advanceDays(30);
    expect(infected.size).toBeGreaterThan(1);
    // every infected place is connected by road to another infected place or the origin
    const hap = plague.adv.happenings.hap;
    for (const sid of infected) {
      if (sid === origin) continue;
      const linked = [...infected].some((o) => o !== sid && (hap.roads.get(o) ?? []).some((e) => e.to === sid));
      expect(linked, `settlement ${sid} was reached along a road`).toBe(true);
    }
    const plagueDeaths = (plague.sim.state.stats.history.concat([plague.sim.state.stats.current])).reduce((n, y) => n + (y.deathsByCause.plague ?? 0), 0);
    expect(plagueDeaths).toBeGreaterThan(3);
    expect(deaths(plague) - d0).toBeGreaterThan((deaths(calm) - c0) * 1.2);
  });

  it('ends: the epidemic fades after the wave has passed', () => {
    const a = advSim({ seed: 'plague-end', preset: 'small' });
    const origin = hub(a);
    a.adv.happenings.trigger!('plague', origin);
    a.sim.advanceDays(16 * 3);
    expect(a.adv.happenings.active().filter((r) => r.kind === 'plague')).toHaveLength(0);
    for (const ss of a.sim.state.settlements.values()) expect(ss.epidemic).toBeLessThan(0.05);
    expect(a.sim.state.chronicle.some((c) => /plague/i.test(c.text))).toBe(true);
  });

  it('is gentler where herbal medicine and an infirmary are known', () => {
    const run = (withMedicine: boolean): number => {
      const a = advSim({ seed: 'plague-med' });
      const origin = hub(a);
      if (!withMedicine) {
        for (const t of ['herbal_medicine', 'infirmary_care']) for (const id of a.adv.holders(t).slice()) a.adv.adv.removeHolder(id, t);
      } else {
        for (const p of a.sim.state.residentsOf(origin).slice(0, 20)) { a.adv.grant(p.id, 'herbal_medicine'); a.adv.grant(p.id, 'infirmary_care'); }
      }
      a.adv.happenings.trigger!('plague', origin);
      a.sim.advanceDays(12);
      return (a.sim.state.stats.current.deathsByCause.plague ?? 0) + a.sim.state.stats.history.reduce((n, y) => n + (y.deathsByCause.plague ?? 0), 0);
    };
    expect(run(true)).toBeLessThan(run(false));
  });
});

describe('famine', () => {
  it('follows a bad harvest: low prosperity at the year end becomes a famine with a chronicle line', () => {
    const a = advSim({ seed: 'famine' });
    const village = a.sim.world.settlements.find((s) => s.kind === 'village' && a.sim.state.residentsOf(s.id).length > 20)!;
    const ss = a.sim.state.settlements.get(village.id)!;
    const events: string[] = [];
    a.sim.events.on('happening', (e) => events.push(`${e.phase}:${e.kind}:${e.settlement}`));
    ss.prosperity = 0.5;
    // run the hook the economy would have run before ours
    const sys = a.sim.scheduler.list('yearly').find((s) => s.name === 'happenings.yearly')!;
    sys.run(a.sim, { year: 2, day: 16 });
    expect(events).toContain(`start:famine:${village.id}`);
    expect(a.adv.happenings.activeAt(village.id)).toContain('famine');
    // and it ends when the prosperity recovers
    ss.prosperity = 1.0;
    sys.run(a.sim, { year: 3, day: 32 });
    expect(a.adv.happenings.activeAt(village.id)).not.toContain('famine');
  });

  it('comes out of a forced failed harvest through the economy', () => {
    const a = advSim({ seed: 'famine-econ' });
    const econ = a.sim.state.ext['econ'] as { harvest: { f: number[] } };
    a.sim.advanceDays(16);
    for (let i = 0; i < econ.harvest.f.length; i++) if (econ.harvest.f[i] !== undefined) econ.harvest.f[i] = 0.35;
    const starts: number[] = [];
    a.sim.events.on('happening', (e) => { if (e.phase === 'start' && e.kind === 'famine') starts.push(e.settlement); });
    let low = 1;
    for (let y = 0; y < 3; y++) {
      // keep the harvests failing
      for (let i = 0; i < econ.harvest.f.length; i++) if (econ.harvest.f[i] !== undefined) econ.harvest.f[i] = 0.35;
      a.sim.advanceDays(16);
      for (const ss of a.sim.state.settlements.values()) low = Math.min(low, ss.prosperity);
    }
    expect(low).toBeLessThan(0.9);
    expect(starts.length).toBeGreaterThan(0);
  });

  it('is eased where improved rotation is known', () => {
    const a = advSim({ seed: 'famine-rotation' });
    const village = a.sim.world.settlements.find((s) => s.kind === 'village' && a.sim.state.residentsOf(s.id).length > 20)!;
    const ss = a.sim.state.settlements.get(village.id)!;
    const p = a.sim.state.residentsOf(village.id).find((x) => x.career === 'farmer')!;
    a.adv.grant(p.id, 'heavy_plough');
    a.adv.grant(p.id, 'improved_rotation');
    ss.prosperity = 0.7; // would be a famine (0.78)
    const sys = a.sim.scheduler.list('yearly').find((s) => s.name === 'happenings.yearly')!;
    sys.run(a.sim, { year: 2, day: 16 });
    expect(ss.prosperity).toBeGreaterThan(0.7);
    ss.prosperity = 0.5;
    sys.run(a.sim, { year: 3, day: 32 });
    expect(a.adv.happenings.activeAt(village.id)).toContain('famine');
  });
});

describe('fire', () => {
  it('burns buildings and displaces a household, then the neighbours rebuild', () => {
    const a = advSim({ seed: 'fire', preset: 'small' });
    const sid = a.sim.world.settlements.find((s) => s.kind === 'town')!.id;
    const homes = (): number => (a.sim.state.buildingsAt.get(sid) ?? []).filter((b) => b.occupied).length;
    void homes;
    const id = a.adv.happenings.trigger!('fire', sid);
    expect(id).toBeGreaterThan(0);
    const burning = (): number => (a.sim.state.buildingsAt.get(sid) ?? []).filter((b) => b.onFire).length;
    expect(burning()).toBe(1);
    expect(a.adv.happenings.activeAt(sid)).toContain('fire');
    a.sim.advanceHours(14);
    const damaged = (a.sim.state.buildingsAt.get(sid) ?? []).filter((b) => b.damage >= 0.8);
    expect(damaged.length).toBeGreaterThanOrEqual(1);
    expect(burning()).toBe(0);
    expect(a.adv.happenings.activeAt(sid)).not.toContain('fire');
    const ruined = damaged[0];
    a.sim.advanceDays(16);
    expect(ruined.damage).toBe(0);
  });

  it('spreads less where the guilds keep a watch', () => {
    const spread = (watch: boolean): number => {
      let total = 0;
      for (let k = 0; k < 4; k++) {
        const a = advSim({ seed: `fire-spread-${k}`, preset: 'small' });
        const sid = a.sim.world.settlements.find((s) => s.kind === 'city' || s.kind === 'town')!.id;
        for (const id of a.adv.holders('guild_charter').slice()) a.adv.adv.removeHolder(id, 'guild_charter');
        if (watch) for (const p of a.sim.state.residentsOf(sid).slice(0, 30)) a.adv.grant(p.id, 'guild_charter');
        a.adv.happenings.trigger!('fire', sid);
        a.sim.advanceHours(16);
        total += (a.sim.state.buildingsAt.get(sid) ?? []).filter((b) => b.damage > 0).length;
      }
      return total;
    };
    expect(spread(true)).toBeLessThanOrEqual(spread(false));
  });
});

describe('flood and drought', () => {
  it('a flood damages the low buildings and dents the harvest; drought dents it more', () => {
    const a = advSim({ seed: 'flood' });
    const econ = a.sim.state.ext['econ'] as { harvest: { f: number[] } };
    const sid = a.sim.world.settlements.find((s) => s.kind === 'village' && a.sim.state.residentsOf(s.id).length > 20)!;
    const k = sid.kingdom;
    const f0 = econ.harvest.f[k];
    a.adv.happenings.trigger!('flood', sid.id);
    expect(a.adv.happenings.activeAt(sid.id)).toContain('flood');
    const hit = (a.sim.state.buildingsAt.get(sid.id) ?? []).filter((b) => b.damage > 0);
    expect(hit.length).toBeGreaterThan(0);
    expect(econ.harvest.f[k]).toBeLessThan(f0);
    const f1 = econ.harvest.f[k];
    a.adv.happenings.trigger!('drought', sid.id);
    expect(econ.harvest.f[k]).toBeLessThan(f1);
    expect(a.adv.happenings.isActive!('drought', sid.id)).toBe(true);
    a.sim.advanceDays(10);
    expect(a.adv.happenings.isActive!('drought')).toBe(false);
  });
});

describe('winter', () => {
  it('a hard winter brings wolves close to the village at night when the zone is there', () => {
    const summoned: Array<[string, number, number, boolean]> = [];
    const dismissed: number[] = [];
    const zone = {
      summonAnimal: (kind: string, x: number, z: number, hostile: boolean) => { summoned.push([kind, x, z, hostile]); return summoned.length; },
      dismissAnimal: (id: number) => { dismissed.push(id); },
    };
    const a = advSim({ seed: 'wolves', zone: zone as never, noon: false });
    // the player module is absent: give the happenings a body to hunt near
    (a.adv.happenings.hap.deps as { player?: unknown }).player = { body: () => ({ x: 1000, y: 0, z: 1000, yaw: 0 }) };
    const k = a.sim.world.settlements.find((s) => s.id === a.player.settlement)!.kingdom;
    a.adv.happenings.trigger!('winter', a.player.settlement);
    expect(a.adv.happenings.isActive!('winter')).toBe(true);
    a.sim.advanceDays(1.5);
    expect(summoned.length).toBeGreaterThanOrEqual(2);
    expect(summoned.every((s) => s[0] === 'wolf' && s[3])).toBe(true);
    a.sim.advanceDays(1);
    expect(dismissed.length).toBeGreaterThanOrEqual(2);
    void k;
  });
});

describe('bandits', () => {
  it('raid a village (stores stolen, a raid event) or are driven off by the garrison', () => {
    let raids = 0, repelled = 0;
    for (let k = 0; k < 6; k++) {
      const a = advSim({ seed: `bandits-${k}` });
      const village = a.sim.world.settlements.find((s) => s.kind === 'village' && a.sim.state.residentsOf(s.id).length > 20)!;
      let raid: { stolen: number } | null = null;
      a.sim.events.on('raid', (e) => { raid = e; });
      a.adv.happenings.trigger!('bandits', village.id);
      expect(a.adv.happenings.activeAt(village.id)).toContain('bandits');
      a.sim.advanceDays(8);
      expect(a.adv.happenings.activeAt(village.id)).not.toContain('bandits');
      if (raid) raids++; else repelled++;
    }
    expect(raids + repelled).toBe(6);
    expect(raids).toBeGreaterThan(0);
  });

  it('call out the lord\'s men when the military module is installed', () => {
    const a = advSim({ seed: 'bandits-lord' });
    const calls: Array<[number, string]> = [];
    const military: MilitaryApi = { armies: () => [], armyOf: () => 0, raise: (house, reason) => { calls.push([house, reason]); return 1; } };
    a.sim.services.military = military;
    const village = a.sim.world.settlements.find((s) => a.sim.state.titleFor('manor', s.id)?.holder)!;
    a.adv.happenings.trigger!('bandits', village.id);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('bandits');
    const lord = a.sim.state.persons.get(a.sim.state.titleFor('manor', village.id)!.holder)!;
    expect(calls[0][0]).toBe(lord.house);
  });

  it('are likelier to be driven off by a village that stood watch with the player', () => {
    const a = advSim({ seed: 'bandits-watch' });
    const village = a.sim.world.settlements.find((s) => s.kind === 'village' && a.sim.state.residentsOf(s.id).length > 20)!;
    a.adv.happenings.trigger!('bandits', village.id);
    const rec = a.adv.happenings.active().find((r) => r.kind === 'bandits')!;
    const before = banditOdds(a.adv.happenings.hap, rec);
    a.adv.happenings.hap.save.reqs.push({
      id: 99, type: 'watch', from: a.player.id, settlement: village.id, state: 'done', offered: a.sim.absDay - 3, expires: a.sim.absDay, text: '', summary: '',
      data: { hours: 5, watched: 5 }, reward: { pence: 0, opinion: 0, points: 0 }, resolved: a.sim.absDay,
    });
    expect(banditOdds(a.adv.happenings.hap, rec)).toBeGreaterThan(before);
  });
});

describe('revolt and succession', () => {
  it('a revolt in a hard-pressed manor ends with ringleaders hanged or serfs freed', () => {
    const a = advSim({ seed: 'revolt' });
    const village = a.sim.world.settlements.find((s) => s.kind === 'village' && a.sim.state.residentsOf(s.id).length > 20)!;
    for (const p of a.sim.state.residentsOf(village.id)) { if (p.rankTier === 1) p.estate = 'unfree'; }
    const text: string[] = [];
    a.sim.events.on('happening', (e) => { if (e.kind === 'revolt') text.push(`${e.phase}`); });
    const id = a.adv.happenings.trigger!('revolt', village.id);
    expect(id).toBeGreaterThan(0);
    expect(a.adv.happenings.activeAt(village.id)).toContain('revolt');
    a.sim.advanceDays(6);
    expect(text).toEqual(['start', 'end']);
    expect(a.sim.state.chronicle.some((c) => /rising at|won their demands/.test(c.text))).toBe(true);
  });

  it('a child on the throne is a succession crisis', () => {
    const a = advSim({ seed: 'succession' });
    const t = [...a.sim.state.titles.values()].find((x) => x.kind === 'county')!;
    const regent = mkPerson(a.sim, { age: 40, tier: 6, estate: 'noble' });
    t.regent = regent.id;
    a.sim.advanceDays(1.2);
    const seat = a.sim.world.counties.find((c) => c.id === t.place)!.seat;
    expect(a.adv.happenings.activeAt(seat)).toContain('succession');
    a.sim.advanceDays(10);
    expect(a.adv.happenings.activeAt(seat)).not.toContain('succession');
  });
});

describe('difficulty and seeding', () => {
  it('happenings scale with the difficulty tier (SPEC §1)', () => {
    const started = (difficulty: 'squire' | 'king'): number => {
      let n = 0;
      for (let k = 0; k < 3; k++) {
        const a = advSim({ seed: `scale-${k}`, difficulty });
        a.sim.advanceDays(16 * 12);
        const s = a.adv.happenings.stats().started;
        n += (s.bandits ?? 0) + (s.fire ?? 0) + (s.plague ?? 0) * 0.2;
      }
      return n;
    };
    expect(started('king')).toBeGreaterThan(started('squire') * 1.5);
  });

  it('is seeded: the same seed gives the same history', () => {
    const run = (): string => {
      const a = advSim({ seed: 'seeded' });
      a.sim.advanceDays(16 * 6);
      return JSON.stringify([a.adv.happenings.stats(), a.sim.state.chronicle.map((c) => c.text).slice(-5)]);
    };
    expect(run()).toBe(run());
  });
});
