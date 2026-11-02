// The AI rulers (docs/REALM.md "The AI rulers", CIV §10): every House but the player's runs the player's loop - works, research, arms,
// trade, fields, outposts - with the same calls, costs and labour, a round a week, dealt over the hours of the week.
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../../src/content/types';
import { AI, PACE } from '../../../src/sim/realm/aiConfig';
import { armsRound, troopTarget } from '../../../src/sim/realm/aiMilitary';
import { outpostAct, outpostChoose } from '../../../src/sim/realm/aiOutpost';
import { researchLimit, researchPicks, researchRound } from '../../../src/sim/realm/aiResearch';
import { fortWanted, loadPlace, type Sense } from '../../../src/sim/realm/aiSense';
import { orderRound } from '../../../src/sim/realm/aiTrade';
import { adjustWorks, cancelStalled, chooseUpgrade, commitUpgrade, homeCap, wantsFor, worksAct, worksChoose, yearCap } from '../../../src/sim/realm/aiWorks';
import { tidyOrders } from '../../../src/sim/realm/aiSupply';
import { addTradeOrder, tradeDaily } from '../../../src/sim/realm/trade';
import { addBuilding, setDay, youths } from './helpers';
import { addDeposits, aRuler, aiWorld, stockUpHousehold, wildPointNear, type AiWorld } from './aiworld';

const SEED = 'ai-mock';

/** The sense of a ruler with his purse and larder made what a test wants. */
function sense(w: AiWorld, id: number, o: { purse?: number; goods?: Record<string, number>; fear?: number; eager?: boolean } = {}): Sense {
  const p = w.sim.state.persons.get(id)!;
  const hh = w.sim.state.households.get(p.household)!;
  if (o.purse !== undefined) { hh.purse = o.purse; p.money = 0; w.sim.state.touchHousehold(hh); w.sim.state.touch(p); }
  if (o.goods) stockUpHousehold(w.sim, hh.id, o.goods);
  const S = w.ai.sense(id);
  if (!S) throw new Error(`ruler ${id} is not run by the AI`);
  if (o.fear !== undefined) { S.fear = o.fear; S.threat = o.fear; }
  // the year's share of a small lord can be nothing at all (it is a chance of the year); a test that wants him to build asks for a roomier one
  if (o.eager) S.pace = 3;
  return S;
}

/** Runs the two works shards of a ruler's round by hand, as the hourly system does, and reports how many works were staked out. */
function round(w: AiWorld, S: Sense): number {
  const before = w.cons.sites().length;
  const what = worksChoose(w.ai, S);
  if (what) worksAct(w.ai, S, what);
  return w.cons.sites().length - before;
}

/** The ruler who holds a place as his seat. */
function rulerAt(w: AiWorld, place: number): number {
  for (const u of w.ai.units()) {
    const S = w.ai.sense(u.ruler);
    if (S && S.seat === place) return u.ruler;
  }
  throw new Error(`no ruler at ${place}`);
}

describe('the AI rulers: who runs, and when', () => {
  it('are installed with the realm unless left out', () => {
    expect(aiWorld({ seed: SEED }).realm.ai).toBeTruthy();
    const none = aiWorld({ seed: SEED, noAi: true });
    expect(none.realm.ai).toBeUndefined();
    none.sim.advanceDays(6);
    expect(none.cons.sites().length).toBe(0);
    expect(none.sim.state.ext['realm.ai']).toBeUndefined();
  });

  it('register one hourly system of six shards, after the realm\'s own', () => {
    const w = aiWorld({ seed: SEED });
    const sys = w.sim.scheduler.list('hourly').find((s) => s.name === 'realm.ai');
    expect(sys).toBeTruthy();
    expect(sys!.shards).toBe(6);
    const names = w.sim.scheduler.list('hourly').map((s) => s.name);
    expect(names.indexOf('realm.ai')).toBeGreaterThan(names.indexOf('realm.hour'));
  });

  it('give every ruler one hour of the week, and never more than two rulers one hour', () => {
    const w = aiWorld({ seed: SEED });
    const units = w.ai.units();
    expect(units.length).toBeGreaterThan(5);
    const seen = new Map<number, number>();
    let most = 0;
    for (let h = 0; h < AI.periodHours; h++) {
      const due = w.ai.dueAt(h);
      most = Math.max(most, due.length);
      for (const u of due) seen.set(u.ruler, (seen.get(u.ruler) ?? 0) + 1);
    }
    expect(most).toBeLessThanOrEqual(2);
    expect(seen.size).toBe(units.length);
    for (const n of seen.values()) expect(n).toBe(1);
    // and the week after is the same
    expect(w.ai.dueAt(7).map((u) => u.ruler)).toEqual(w.ai.dueAt(7 + AI.periodHours).map((u) => u.ruler));
  });

  it('never run the House the player acts for', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 0);
    expect(w.ai.sense(r.id)).toBeTruthy();
    w.sim.state.run.houseId = r.house;
    w.sim.state.run.playerId = r.id;
    expect(w.ai.sense(r.id)).toBeNull();
    const placed = w.cons.sites().length;
    w.ai.runRound(r.id);
    expect(w.cons.sites().length).toBe(placed);
  });

  it('are switched off by `enabled`: the hours go by and nothing is staked out', () => {
    const w = aiWorld({ seed: SEED });
    w.ai.enabled = false;
    w.sim.advanceDays(8);
    expect(w.ai.table().length).toBe(0);
    expect(w.cons.sites().length).toBe(0);
  });
});

describe('the AI rulers: works', () => {
  it('build homes where families share a home, and not where none do', () => {
    const w = aiWorld({ seed: SEED });
    const crowded = aRuler(w, 'manor', 2); // Vilbourg: a third of its families share a home
    const S = sense(w, crowded.id, { purse: 40000, goods: { planks: 400, straw: 600, nails: 200, timber: 100 } });
    const p = loadPlace(w.ai, S.places[0]);
    expect(p.sharing / p.families).toBeGreaterThan(0.2);
    const wants = wantsFor(w.ai, S, p);
    const home = wants.find((x) => BUILDINGS[x.kind].cat === 'home');
    expect(home, 'a home is wanted').toBeTruthy();
    expect(home!.score).toBeGreaterThan(AI.startScore);
    expect(home!.why).toMatch(/share a home/);

    const calm = aRuler(w, 'manor', 0); // Thornfield: nearly everyone has a home of their own
    const C = sense(w, calm.id, { purse: 40000 });
    const q = loadPlace(w.ai, C.places[0]);
    expect(q.sharing / q.families).toBeLessThan(0.1);
    expect(wantsFor(w.ai, C, q).some((x) => BUILDINGS[x.kind].cat === 'home')).toBe(false);
  });

  it('stake out what they want through the builder, paying from the ruler\'s own purse', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const S = sense(w, r.id, { purse: 40000, eager: true, goods: { planks: 400, straw: 600, nails: 200, timber: 100, stone: 100, iron: 20 } });
    const hh = S.payer!;
    const purse0 = hh.purse;
    expect(round(w, S)).toBe(1);
    const site = w.cons.sites().find((x) => x.builder === r.id)!;
    expect(site).toBeTruthy();
    expect(site.house).toBe(S.house);
    expect(site.household).toBe(hh.id);
    expect(w.ai.table()[0].placed).toBe(1);
    // the builder's own rules: the ruler is its `builder`, and the site is on land he holds
    expect(w.cons.scope(r.id).settlements).toContain(site.settlement);
    // the purse paid fees or stayed; it never grew by it
    expect(hh.purse).toBeLessThanOrEqual(purse0 + 1e-6);
  });

  it('start nothing for want of money', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const poor = sense(w, r.id, { purse: 40, eager: true });
    expect(poor.allowance).toBeLessThan(AI.minFunds);
    expect(round(w, poor)).toBe(0);
    expect(w.cons.sites().length).toBe(0);
  });

  it('keep to their share of the year, and begin again in the next', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const rich = { purse: 80000, eager: true, goods: { planks: 900, straw: 900, nails: 300, timber: 200, stone: 300 } };
    const S = sense(w, r.id, rich);
    const cap = yearCap(S);
    expect(cap).toBeGreaterThan(0);
    const rec = w.ai.rec(S.house);
    // the year's works are all done: nothing more, however rich and however much he wants
    rec.yr = [w.ai.yearIndex, cap + homeCap(S, cap) + 3, 0];
    expect(round(w, sense(w, r.id, rich))).toBe(0);
    // next year the count starts again
    rec.yr = [w.ai.yearIndex - 1, 99, 99];
    rec.no = {};
    expect(w.ai.placedThisYear(S.house).works).toBe(0);
    expect(round(w, sense(w, r.id, rich))).toBe(1);
  });

  it('want a palisade when afraid and build it when they have the timber; lay in a stock when they have not', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 0);
    // no timber in the markets or the larder: nothing is begun
    (w.economy as unknown as { stockAt: () => number }).stockAt = () => 0;
    const afraid = sense(w, r.id, { purse: 60000, fear: 0.9, eager: true });
    const p = loadPlace(w.ai, afraid.places[0]);
    expect(p.fort).toBe(1);
    const wants = wantsFor(w.ai, afraid, p);
    expect(wants[0].kind).toBe('palisade');
    expect(wants[0].score).toBeGreaterThan(0.9);
    expect(w.ai.data.s.length).toBe(0);
    // a standing order to buy it is given, never above `dearPrice` times the usual price
    const sites0 = w.cons.sites().length;
    worksChoose(w.ai, afraid);
    expect(w.cons.sites().length).toBe(sites0);
    const order = w.realm.tradeOrders(r.id).find((o) => o.good === 'timber' && o.side === 'buy');
    expect(order, 'a standing order for timber').toBeTruthy();
    expect(order!.limit).toBeLessThanOrEqual(w.economy.good('timber')!.basePrice * AI.dearPrice + 1e-6);
    // with timber in the store it is staked out at once
    delete (w.economy as unknown as { stockAt?: unknown }).stockAt;
    w.ai.rec(afraid.house).no = {};
    const stocked = sense(w, r.id, { goods: { timber: 400 }, fear: 0.9, eager: true });
    expect(round(w, stocked)).toBe(1);
    const site = w.cons.sites().find((x) => x.builder === r.id)!;
    expect(site.kind).toBe('palisade');
    expect(w.ai.table()[0].defence).toBe(1);
  });

  it('want no palisade when they have little to fear', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 0);
    const calm = sense(w, r.id, { purse: 60000, fear: 0.15 });
    const wants = wantsFor(w.ai, calm, loadPlace(w.ai, calm.places[0]));
    expect(wants.some((x) => x.kind === 'palisade' || x.kind === 'motte')).toBe(false);
    expect(fortWanted(0.15)).toBeLessThan(1.4);
    expect(fortWanted(0.9)).toBeGreaterThan(2.5);
  });

  it('give up a work that has stood still too long', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const S = sense(w, r.id, { purse: 40000 });
    const spot = w.cons.suggestSpot(r.id, 'barn', S.places[0].id)!;
    expect(spot).toBeTruthy();
    const res = w.cons.place(r.id, 'barn', spot.x, spot.z, spot.rot);
    expect(res.ok).toBe(true);
    w.ai.sitePlaced(S.house, res.site!, 'barn', S.places[0].id);
    const T = w.ai.sense(r.id)!;
    expect(T.open.length).toBe(1);
    // it stands still, and long ago it was staked out
    T.open[0] = { ...T.open[0], status: 'stalled' };
    w.ai.data.s[0][1] = Math.floor(w.sim.absDay) - AI.stallDays - 1;
    expect(cancelStalled(w.ai, T)).toBe(1);
    expect(w.cons.site(res.site!)?.status).toBe('cancelled');
    expect(w.ai.table()[0].cancelled).toBe(1);
  });

  it('start no new work while one waits for materials', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const S = sense(w, r.id, { purse: 40000, eager: true, goods: { planks: 400, straw: 600, nails: 200, timber: 100 } });
    const sites = w.cons.sites().length;
    const open = { id: -1, status: 'stalled', work: 'build', kind: 'barn', settlement: S.places[0].id } as unknown as Sense['open'][number];
    S.open.push(open);
    expect(worksChoose(w.ai, S)).toBeNull();
    expect(w.cons.sites().length).toBe(sites);
  });
});

describe('the AI rulers: arms, learning, trade, outposts', () => {
  it('take men on when afraid, at the cost of fees and gear from the treasury, and pay them', () => {
    const w = aiWorld({ seed: SEED });
    setDay(w.sim, 20.3);
    const r = aRuler(w, 'manor', 2);
    youths(w.sim, w.ai.sense(r.id)!.places[0].id, 10);
    const S = sense(w, r.id, { purse: 40000, fear: 0.8, goods: { 'longbow#2': 8, arrow: 300, sword: 6, shield: 6, spear: 6, padded_armour: 10, cap_helmet: 6 } });
    expect(troopTarget(S)).toBeGreaterThan(2);
    const purse0 = S.payer!.purse;
    armsRound(w.ai, S);
    const men = w.realm.troops!(r.id);
    expect(men.length).toBeGreaterThan(0);
    expect(men.length).toBeLessThanOrEqual(troopTarget(S));
    expect(S.payer!.purse).toBeLessThan(purse0);
    expect(w.ai.table()[0].recruits).toBe(men.length);
    // the same House takes no more the next hour (the gap between musters)
    const again = sense(w, r.id, { fear: 0.8 });
    armsRound(w.ai, again);
    expect(w.realm.troops!(r.id).length).toBe(men.length);
  });

  it('keep fewer men in peace than in fear, and none when the purse is thin or the lord is an abbot', () => {
    const w = aiWorld({ seed: SEED });
    setDay(w.sim, 20.3);
    const r = aRuler(w, 'county', 0);
    const calm = sense(w, r.id, { purse: 500000, fear: 0.05 });
    const afraid = sense(w, r.id, { purse: 500000, fear: 0.9 });
    expect(troopTarget(afraid)).toBeGreaterThan(troopTarget(calm));
    const poor = sense(w, r.id, { purse: 30, fear: 0.9 });
    armsRound(w.ai, poor);
    expect(w.realm.troops!(r.id).length).toBe(0);
    const abbot = aRuler(w, 'abbey', 0);
    expect(troopTarget(sense(w, abbot.id, { fear: 0.9 }))).toBe(0);
  });

  it('start a technique they can pay for and work in, and no more than their share at once', () => {
    const w = aiWorld({ seed: SEED });
    setDay(w.sim, 20.3);
    const r = aRuler(w, 'kingdom', 0);
    const goods = { timber: 300, planks: 300, stone: 300, iron: 100, straw: 200, cloth: 100, ale: 300, vellum: 100, candle: 300 };
    const S = sense(w, r.id, { purse: 5_000_000, goods });
    expect(researchPicks(w.ai, S).length).toBeGreaterThan(3);
    const limit = researchLimit(S);
    let most = 0;
    for (let i = 0; i < 12; i++) {
      w.ai.rec(S.house).at['res'] = -999;
      researchRound(w.ai, sense(w, r.id));
      most = Math.max(most, w.realm.projects(S.house).filter((p) => p.state === 'active' || p.state === 'stalled').length);
    }
    expect(w.realm.projects(S.house).length).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(limit);
    expect(w.ai.table().reduce((n, y) => n + y.research, 0)).toBe(w.realm.projects(S.house).length);
    // and he pays out of his own purse
    expect(S.payer!.purse).toBeLessThan(5_000_000);
  });

  it('start no research they cannot pay for', () => {
    const w = aiWorld({ seed: SEED });
    setDay(w.sim, 20.3);
    const r = aRuler(w, 'manor', 0);
    const S = sense(w, r.id, { purse: 120 });
    researchRound(w.ai, S);
    expect(w.realm.projects(S.house).length).toBe(0);
  });

  it('put a surplus on sale and the order is carried out by the realm\'s own trade', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'county', 0);
    const S = sense(w, r.id, { purse: 600000, goods: { wool: 150 } });
    orderRound(w.ai, S);
    const sell = w.realm.tradeOrders(r.id).find((o) => o.good === 'wool' && o.side === 'sell');
    expect(sell).toBeTruthy();
    expect(w.ai.table()[0].orders).toBeGreaterThan(0);
    tradeDaily(w.R);
    expect(w.realm.tradeOrders(r.id).find((o) => o.good === 'wool')!.done).toBeGreaterThan(0);
  });

  it('plan the fields by need: rye and oats in a hard year, and keep them in the realm\'s own plan', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const place = w.ai.sense(r.id)!.places[0].id;
    w.sim.state.settlementState(place)!.prosperity = 0.8;
    w.ai.runRound(r.id);
    const plan = w.realm.cropPlanView!(place);
    expect(plan.length).toBeGreaterThan(0);
    expect(w.ai.table()[0].crops).toBeGreaterThan(0);
  });

  it('send a baron or greater to a wild deposit his lands lack, and never a manor lord', () => {
    const seat = 2; // a county's seat; its lands hold stone, iron and clay, and it lacks the precious metals
    const w = aiWorld({
      seed: SEED,
      prepare: (sim) => {
        const a = wildPointNear(sim, seat, 0)!, b = wildPointNear(sim, seat, 40)!;
        addDeposits(sim, [{ kind: 'silver', x: a.x, z: a.z }, { kind: 'gold', x: b.x, z: b.z }]);
      },
    });
    const c = rulerAt(w, seat);
    const rich = { purse: 5_000_000, goods: { timber: 600, planks: 600, nails: 300, iron: 80, stone: 300 } };
    // a count with no taste for riches wants nothing of the wild
    const modest = sense(w, c, rich);
    modest.mind = { ...modest.mind, greedy: 0.1, ambitious: 0.05 };
    for (let i = 0; i < 4; i++) {
      expect(outpostChoose(w.ai, modest)).toBeNull();
      w.sim.advanceDays(4);
    }
    // a greedy, ambitious one founds a camp on the ore, at the next round that is his to do so
    let founded = 0;
    for (let i = 0; i < 4 && !founded; i++) {
      const S = sense(w, c, rich);
      S.mind = { ...S.mind, greedy: 0.9, ambitious: 0.9 };
      const pend = outpostChoose(w.ai, S);
      if (pend) { outpostAct(w.ai, S, pend); founded++; }
      else w.sim.advanceDays(4);
    }
    expect(founded).toBe(1);
    // (the other great Houses of the continent may have founded camps of their own meanwhile)
    const house = w.ai.sense(c)!.house;
    const camps = w.cons.outposts().filter((o) => o.house === house);
    expect(camps).toHaveLength(1);
    expect(['silver', 'gold']).toContain(w.R.territory!.deposits()[camps[0].deposit].kind);
    expect(w.ai.rec(house).outs).toBe(1);
    expect(w.ai.table().reduce((n, y) => n + y.outposts, 0)).toBeGreaterThanOrEqual(1);
    // he founds no second one at once (the gap of years), and a manor lord never founds one
    const again = sense(w, c, rich);
    again.mind = { ...again.mind, greedy: 0.9, ambitious: 0.9 };
    expect(outpostChoose(w.ai, again)).toBeNull();
    const m = aRuler(w, 'manor', 0);
    for (let i = 0; i < 4; i++) {
      expect(outpostChoose(w.ai, sense(w, m.id, { purse: 5_000_000 }))).toBeNull();
      w.sim.advanceDays(4);
    }
  });
});

describe('the AI rulers: difficulty', () => {
  it('are slower to expand on Squire and quicker on King, at the same prices', () => {
    expect(PACE.squire).toBeLessThan(PACE.knight);
    expect(PACE.king).toBeGreaterThan(PACE.knight);
    const at = (d: 'squire' | 'knight' | 'king') => {
      const w = aiWorld({ seed: SEED, difficulty: d });
      const r = aRuler(w, 'county', 0);
      const S = w.ai.sense(r.id)!;
      S.fear = 0.6;
      return { pace: S.pace, target: troopTarget(S), cap: yearCap(S) };
    };
    const squire = at('squire'), king = at('king');
    expect(squire.pace).toBeLessThan(king.pace);
    expect(squire.target).toBeLessThanOrEqual(king.target);
  });
});

describe('the AI rulers: news', () => {
  it('tell the neighbours what they raise: walls, barracks and the like are news', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 0);
    const S = sense(w, r.id, { purse: 60000, fear: 0.9, eager: true, goods: { timber: 400 } });
    expect(round(w, S)).toBe(1);
    const item = w.realm.news(20).find((n) => /is raising a palisade/.test(n.text));
    expect(item).toBeTruthy();
    expect(item!.house).toBe(S.house);
    // not a stream: the same House does not tell of the same kind again within the fortnight
    w.ai.rec(S.house).no = {};
    const T = sense(w, r.id, { purse: 60000, fear: 0.9, eager: true, goods: { timber: 400 } });
    round(w, T);
    expect(w.realm.news(50).filter((n) => /is raising a palisade/.test(n.text)).length).toBe(1);
  });
});

describe('the AI rulers: a world of them', () => {
  it('build in many places over a year without breaking the registry, and the table counts it', () => {
    const w = aiWorld({ seed: SEED });
    w.sim.advanceDays(15);
    const t = w.ai.table();
    expect(t.length).toBe(1);
    expect(t[0].placed).toBeGreaterThan(3);
    expect(t[0].placed).toBe(t[0].built + t[0].upgrades + t[0].repairs);
    // every work of theirs on the books is a real, open site; purses are never negative
    for (const e of w.ai.data.s) expect(w.cons.site(e[0]), `site ${e[0]}`).toBeTruthy();
    for (const hh of w.sim.state.households.values()) expect(hh.purse).toBeGreaterThanOrEqual(0);
    // and done + open + cancelled is everything they placed
    const open = w.ai.data.s.length;
    expect(t[0].done + t[0].cancelled + open).toBe(t[0].placed);
  });

  it('are the same twice for one seed', () => {
    const run = (): string => {
      const w = aiWorld({ seed: 'ai-twice' });
      w.sim.advanceDays(24);
      return w.sim.stateHash();
    };
    expect(run()).toBe(run());
  });

  it('leave the people about as they were: no collapse of the population, no famine from the works', () => {
    const control = aiWorld({ seed: 'ai-control', noAi: true });
    const withAi = aiWorld({ seed: 'ai-control' });
    control.sim.advanceDays(48);
    withAi.sim.advanceDays(48);
    const pop = (w: AiWorld): number => { let n = 0; for (const p of w.sim.state.persons.values()) if (!p.death) n++; return n; };
    expect(pop(withAi)).toBeGreaterThan(pop(control) * 0.93);
  });
});

describe('the AI rulers: mending, improving, labour, orders, the accolade', () => {
  it('mend what is hurt before they build anew, at their own cost', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const S0 = sense(w, r.id);
    const place = S0.places[0].id;
    const b = addBuilding(w.sim, place, 'granary');
    b.damage = 0.5;
    w.sim.state.touchBuilding(b);
    const S = sense(w, r.id, { purse: 40000, eager: true, goods: { planks: 100, timber: 50, nails: 40, straw: 50 } });
    const purse0 = S.payer!.purse;
    const what = worksChoose(w.ai, S);
    expect(what?.kind).toBe('repair');
    worksAct(w.ai, S, what!);
    const site = w.cons.sites().find((x) => x.builder === r.id)!;
    expect(site).toBeTruthy();
    expect(site.work).toBe('repair');
    expect(site.building).toBe(b.id);
    expect(w.ai.table()[0].repairs).toBe(1);
    expect(S.payer!.purse).toBeLessThanOrEqual(purse0);
    // a building that is being mended is not hurt any more in his eyes: he does not mend it twice
    const again = sense(w, r.id, { eager: true });
    expect(worksChoose(w.ai, again)?.kind).not.toBe('repair');
  });

  it('improve a building when the place is prosperous and the purse is full, and not when it is not', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const S0 = sense(w, r.id);
    const place = S0.places[0].id;
    addBuilding(w.sim, place, 'church');
    w.sim.state.settlementState(place)!.prosperity = 1.05;
    const S = sense(w, r.id, { purse: 80000, eager: true, goods: { planks: 200, timber: 100, nails: 60, stone: 600, iron: 40 } });
    const p = loadPlace(w.ai, S.places[0]);
    const up = chooseUpgrade(w.ai, S, p);
    expect(up, 'an improvement is wanted').toBeTruthy();
    const purse0 = S.payer!.purse;
    expect(commitUpgrade(w.ai, S, p, up!.id, up!.kind)).toBe(true);
    const site = w.cons.sites().find((x) => x.builder === r.id && x.work === 'upgrade')!;
    expect(site).toBeTruthy();
    expect(site.building).toBe(up!.id);
    expect(w.ai.table()[0].upgrades).toBe(1);
    expect(S.payer!.purse).toBeLessThanOrEqual(purse0);

    // a poor place, or a poor purse, improves nothing
    const w2 = aiWorld({ seed: SEED });
    const r2 = aRuler(w2, 'manor', 2);
    const place2 = sense(w2, r2.id).places[0].id;
    addBuilding(w2.sim, place2, 'church');
    w2.sim.state.settlementState(place2)!.prosperity = 0.8;
    const T = sense(w2, r2.id, { purse: 80000, eager: true });
    expect(chooseUpgrade(w2.ai, T, loadPlace(w2.ai, T.places[0]))).toBeNull();
    w2.sim.state.settlementState(place2)!.prosperity = 1.05;
    const U = sense(w2, r2.id, { purse: 90, eager: true });
    expect(chooseUpgrade(w2.ai, U, loadPlace(w2.ai, U.places[0]))).toBeNull();
  });

  it('send the manor\'s week-work to the lord\'s works while there are any, and take it back when there are none', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'manor', 2);
    const S = sense(w, r.id, { purse: 40000, eager: true, goods: { planks: 400, straw: 600, nails: 200, timber: 100, stone: 100, iron: 20 } });
    const place = S.places[0].id;
    adjustWorks(w.ai, S);
    expect(w.realm.worksShare(place)).toBe(0);
    expect(round(w, S)).toBe(1);
    const open = sense(w, r.id);
    expect(open.places[0].open).toBe(1);
    adjustWorks(w.ai, open);
    expect(w.realm.worksShare(place)).toBe(0.5);
    // the work is cancelled: the share goes back
    w.cons.cancel(r.id, w.cons.sites().find((x) => x.builder === r.id)!.id);
    adjustWorks(w.ai, sense(w, r.id));
    expect(w.realm.worksShare(place)).toBe(0);
  });

  it('take the buying orders down when the purse is thin, and the stock-up orders when the store holds what they wanted', () => {
    const w = aiWorld({ seed: SEED });
    const r = aRuler(w, 'county', 0);
    const rich = sense(w, r.id, { purse: 600000 });
    expect(addTradeOrder(w.R, r.id, { settlement: -1, good: 'timber', side: 'buy', limit: 40, keep: 100 }).ok).toBe(true);
    expect(addTradeOrder(w.R, r.id, { settlement: -1, good: 'wool', side: 'sell', limit: 0, keep: 5 }).ok).toBe(true);
    // a rich ruler leaves his orders alone
    orderRound(w.ai, rich);
    expect(w.realm.tradeOrders(r.id).filter((o) => o.side === 'buy').length).toBe(1);
    // a thin purse buys nothing: the buying order goes, the selling one stays
    const poor = sense(w, r.id, { purse: 30 });
    orderRound(w.ai, poor);
    expect(w.realm.tradeOrders(r.id).filter((o) => o.side === 'buy').length).toBe(0);
    expect(w.realm.tradeOrders(r.id).filter((o) => o.side === 'sell').length).toBe(1);

    // an order laid in for a work is taken down once the store holds the stock
    const S = sense(w, r.id, { purse: 600000 });
    expect(addTradeOrder(w.R, r.id, { settlement: -1, good: 'stone', side: 'buy', limit: 40, keep: 80 }).ok).toBe(true);
    w.ai.mark(S.house, 'stock:stone');
    tidyOrders(w.ai, S);
    expect(w.realm.tradeOrders(r.id).some((o) => o.good === 'stone')).toBe(true);
    const stocked = sense(w, r.id, { goods: { stone: 120 } });
    tidyOrders(w.ai, stocked);
    expect(w.realm.tradeOrders(r.id).some((o) => o.good === 'stone')).toBe(false);
  });

  it('knight the worthiest of their men from time to time, at the treasury\'s cost', () => {
    const w = aiWorld({ seed: SEED });
    setDay(w.sim, 20.3);
    const r = aRuler(w, 'kingdom', 0);
    for (const p of w.ai.sense(r.id)!.places) youths(w.sim, p.id, 12);
    const kit = { 'longbow#2': 12, arrow: 400, sword: 12, shield: 12, spear: 12, padded_armour: 14, cap_helmet: 12, horse: 4, chainmail: 4 };
    // a few musters, a week apart, until he has a score of men
    let S = sense(w, r.id, { purse: 900000, fear: 0.8, goods: kit });
    for (let i = 0; i < 6 && w.realm.troops!(r.id).length < 4; i++) {
      w.ai.rec(S.house).at['rec'] = -999;
      armsRound(w.ai, S);
      S = sense(w, r.id, { fear: 0.8 });
    }
    const men = w.realm.troops!(r.id);
    expect(men.length).toBeGreaterThanOrEqual(4);
    // one of them is a seasoned fighter
    const strong = w.sim.state.persons.get(men[0].person)!;
    strong.skills.melee = 8 * 8 * 40;
    strong.health.hp = 1;
    w.sim.state.touch(strong);
    const again = sense(w, r.id, { purse: 900000, goods: kit });
    expect(again.troops.length).toBeGreaterThanOrEqual(4);
    armsRound(w.ai, again);
    expect(w.ai.table()[0].knights).toBe(1);
    expect(w.sim.state.persons.get(strong.id)!.career).toBe('knight');
    // and not another in the next fortnight
    armsRound(w.ai, sense(w, r.id));
    expect(w.ai.table()[0].knights).toBe(1);
  });

  it('are run by the steward when the lord is held captive, paying from the lord\'s own household', () => {
    const w = aiWorld({ seed: SEED });
    const k = aRuler(w, 'kingdom', 0);
    const king = w.sim.state.persons.get(k.id)!;
    const capital = w.ai.sense(k.id)!.seat;
    king.flags.captive = true;
    w.sim.state.touch(king);
    w.sim.advanceHours(1);
    const acting = w.realm.rulerOf(capital);
    expect(acting).not.toBe(king.id);
    const S = sense(w, acting, { purse: 400000, eager: true, goods: { planks: 400, straw: 600, nails: 200, timber: 300, stone: 300, iron: 60 } });
    expect(S.role).toBe('steward');
    expect(S.house).toBe(king.house);
    expect(S.payer!.id).toBe(king.household);
    expect(round(w, S)).toBeGreaterThanOrEqual(0);
    for (const site of w.cons.sites()) expect(site.household).toBe(king.household);
  });
});
