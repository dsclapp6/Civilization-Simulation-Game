// Timing budgets (run alone: `PERF=1 npx vitest run tests/sim/realm/realm.perf.test.ts`): the realm's calendar jobs are dealt
// out over the hours of the day (none above a few ms even with every great House busy), and the calls the UI and the AI make
// every frame or every day are cheap.
import { describe, expect, it } from 'vitest';
import { TECHS } from '../../../src/sim/advancement';
import { addBuilding, forget, realmSim, stock, titlesOfKind, holderOf, householdOf, youths } from './helpers';

const avg = (n: number, fn: () => void): number => {
  for (let i = 0; i < Math.min(n, 20); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
};

describe('realm budgets (11 000 people, six kingdoms)', () => {
  it('deals a day of work for every House out over the hours and answers the UI quickly', () => {
    const r = realmSim({ preset: 'large', seed: 'perf', politics: true, military: true });
    const { sim, realm } = r;
    r.market.days = 1;
    // work in hand for every great House: four researches, a full set of orders, a company of men
    const kings = titlesOfKind(sim, 'kingdom').map((t) => holderOf(sim, t));
    const lords = titlesOfKind(sim, 'county').map((t) => holderOf(sim, t));
    const town = sim.world.settlements.find((s) => s.market)!.id;
    let projects = 0, men = 0, orders = 0;
    for (const lord of [...kings, ...lords]) {
      const hh = householdOf(sim, lord);
      hh.purse = 5_000_000;
      stock(sim, hh, { timber: 900, planks: 900, stone: 900, iron: 900, arrow: 900, brick: 900, vellum: 900, candle: 900, cloth: 900, ale: 900 });
      for (const kind of ['carpenter', 'smithy', 'church', 'school', 'archery_butts', 'market_hall', 'great_hall', 'guildhall'] as const) addBuilding(sim, lord.settlement, kind);
      for (const o of realm.researchOptions(lord.id)) {
        if (o.ok && projects < 120 && realm.startResearch(lord.id, o.tech, 0, -1).ok) projects++;
      }
      const goods = ['wheat', 'ale', 'cheese', 'bread', 'timber', 'brick', 'iron', 'cloth', 'wool', 'candle'];
      for (const g of goods) if (realm.addTradeOrder(lord.id, { settlement: town, good: g, side: orders % 2 ? 'sell' : 'buy', limit: 0, keep: 50 }).ok) orders++;
      youths(sim, lord.settlement, 20);
      const m = realm.recruit(lord.id, lord.settlement, 'man_at_arms', 20);
      if (m.ok) men += m.raised ?? 0;
    }
    expect(projects).toBeGreaterThan(10);
    expect(orders).toBeGreaterThan(30);
    expect(men).toBeGreaterThan(20);
    sim.advanceDays(2); // warm-up
    sim.scheduler.profiling = true;
    const calls: number[] = [];
    sim.scheduler.onCall = (name, ms) => { if (name === 'realm.hour') calls.push(ms); };
    const days = 16;
    sim.advanceDays(days);
    // a shared machine adds noise to single calls: judge the median day, and the worst call only against a wide margin
    const perDay: number[] = [];
    for (let d = 0; d + 24 <= calls.length; d += 24) perDay.push(calls.slice(d, d + 24).reduce((a, b) => a + b, 0));
    perDay.sort((a, b) => a - b);
    const median = perDay[Math.floor(perDay.length / 2)];
    const worst = Math.max(...calls);
    const hourly = calls.slice().sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`realm: ${projects} projects, ${orders} orders, ${men} men; median day ${median.toFixed(3)} ms, worst call ${worst.toFixed(2)} ms, median call ${hourly[Math.floor(hourly.length / 2)].toFixed(4)} ms`);
    // an extreme load (every great House busy with four works, its orders, and a company on the pay roll): the day's jobs are
    // dealt out over eighteen hours; an ordinary day with a ruler or two at work costs a few tenths of a ms
    expect(median).toBeLessThan(6);
    expect(worst).toBeLessThan(25);

    const king = kings[0];
    const times = {
      rulerOf: avg(20000, () => realm.rulerOf(town)),
      canRule: avg(5000, () => realm.canRule(king.id)),
      worksShare: avg(100000, () => realm.worksShare(town)),
      cropPlan: avg(20000, () => realm.cropPlan(town)),
      view: avg(200, () => realm.view(king.id)),
      news: avg(2000, () => realm.news(40)),
      rivals: avg(50, () => realm.rivals(king.id)),
      researchOptions: avg(10, () => realm.researchOptions(king.id)),
      recruitOptions: avg(20, () => realm.recruitOptions(king.id, king.settlement)),
    };
    // eslint-disable-next-line no-console
    console.log(Object.entries(times).map(([k, v]) => `${k} ${v < 0.1 ? `${(v * 1000).toFixed(1)} µs` : `${v.toFixed(2)} ms`}`).join(', '));
    expect(times.rulerOf).toBeLessThan(0.02);
    expect(times.worksShare).toBeLessThan(0.005);
    expect(times.cropPlan).toBeLessThan(0.01);
    expect(times.canRule).toBeLessThan(0.1);
    expect(times.view).toBeLessThan(2);
    expect(times.news).toBeLessThan(0.1);
    expect(times.rivals).toBeLessThan(10);
    expect(times.researchOptions).toBeLessThan(25);
    expect(times.recruitOptions).toBeLessThan(25);
    void TECHS; void forget;
  }, 300_000);
});
