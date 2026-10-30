import { describe, expect, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { bagAdd } from '../../../src/sim/economy/items';
import { mkHousehold, mkPerson, makePlayer } from '../builders';
import { declareWar, fakeCombat, fakePolitics, milSim } from './helpers';

function royals(sim: ReturnType<typeof milSim>['sim']): number[] {
  return [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
}

/** A grown man of the king's own capital becomes the player. */
function playerIn(ctx: ReturnType<typeof milSim>, tier: 1 | 2 | 3 = 2) {
  const { sim } = ctx;
  const M = militaryContext(sim);
  const [ka] = royals(sim);
  const cap = M.realm.settlementsOf(ka)[0];
  const hh = mkHousehold(sim, cap);
  const p = mkPerson(sim, { age: 24, tier, household: hh.id, settlement: cap, house: 0, career: 'labourer' });
  sim.state.joinHousehold(p, hh);
  makePlayer(sim, p);
  return { M, ka, p, hh, cap };
}

describe('the player\'s military life', () => {
  it('the lord calls the levy: the player is called, may march or refuse (and pays for refusing)', () => {
    const ctx = milSim({ seed: 'call', body: true });
    const { sim, mil } = ctx;
    const { M, ka, p, hh } = playerIn(ctx);
    hh.purse = 500;
    const msgs: string[] = [];
    sim.events.on('notify', (e) => msgs.push(e.text));
    const army = mil.raiseArmy(ka, 'war', { fraction: 1, vassals: false });
    expect(army).toBeGreaterThan(0);
    // the player is not conscripted silently: there is a call to answer
    expect(mil.armyOf(p.id)).toBe(0);
    const svc = mil.service();
    expect(svc.call).not.toBeNull();
    expect(svc.call!.house).toBe(ka);
    expect(msgs.some((m) => /calls the levy/.test(m))).toBe(true);
    const money0 = p.money;
    expect(mil.answerCall(false).ok).toBe(true);
    expect(p.money).toBeLessThanOrEqual(money0);
    expect(mil.service().call).toBeNull();
    expect(mil.armyOf(p.id)).toBe(0);
    // a second call, answered
    M.data.player.call = { house: ka, army, muster: 0, day: sim.absDay, due: sim.absDay + 3, household: [], self: true };
    expect(mil.answerCall(true).ok).toBe(true);
    expect(mil.armyOf(p.id)).toBe(army);
    expect(mil.service().role).toBe('levy');
    expect(mil.commandLevel()).toBe('self');
    // an unanswered call lapses with the penalty
    mil.leaveService();
    M.data.player.call = { house: ka, army, muster: 0, day: sim.absDay, due: sim.absDay + 1, household: [], self: true };
    sim.advanceDays(2);
    expect(mil.service().call).toBeNull();
  });

  it('the men of the player\'s household are taken in the levy and he is told', () => {
    const ctx = milSim({ seed: 'household', body: true });
    const { sim, mil } = ctx;
    const { ka, p, hh, cap } = playerIn(ctx);
    for (let i = 0; i < 3; i++) { const son = mkPerson(sim, { age: 19 + i, household: hh.id, settlement: cap, house: 0, career: 'labourer' }); sim.state.joinHousehold(son, hh); }
    const msgs: string[] = [];
    sim.events.on('notify', (e) => msgs.push(e.text));
    mil.raiseArmy(ka, 'war', { fraction: 1, vassals: false });
    const taken = hh.members.filter((id) => id !== p.id && mil.armyOf(id) !== 0);
    expect(taken.length).toBe(3);
    expect(msgs.some((m) => /men of your household are called/.test(m))).toBe(true);
  });

  it('a lord calls his own levy and rides at its head; the army on the map has his marker', () => {
    const ctx = milSim({ seed: 'lord', body: true });
    const { sim, mil } = ctx;
    const [ka] = royals(sim);
    const king = sim.state.persons.get(sim.state.houses.get(ka)!.head)!;
    makePlayer(sim, king);
    const r = mil.callLevy();
    expect(r.ok).toBe(true);
    expect(mil.service().role).toBe('commander');
    expect(mil.commandLevel()).toBe('army');
    expect(mil.service().commands).toBeGreaterThan(10);
    expect(mil.callLevy().ok).toBe(false);
    // the lord commands the army: orders hold, advance, charge, loose, retreat, follow me
    const id = mil.armyOf(king.id);
    for (const o of ['hold', 'advance', 'charge', 'loose', 'retreat', 'follow'] as const) expect(mil.command(o).ok).toBe(true);
    expect(militaryContext(sim).army(id)!.stance).toBe('follow');
    // map markers include the army
    const markers = sim.view.mapMarkers();
    expect(markers.some((m) => m.kind === 'army' && m.size > 10)).toBe(true);
  });

  it('what a man commands follows his rank: himself, a squad, a company, the army', () => {
    const ctx = milSim({ seed: 'rank', body: true });
    const { sim, mil } = ctx;
    const { M, ka, p } = playerIn(ctx);
    const id = mil.raiseArmy(ka, 'war', { fraction: 1, vassals: false });
    mil.joinArmy(id);
    expect(mil.commandLevel()).toBe('self');
    expect(mil.command('hold').ok).toBe(false);
    p.career = 'sergeant'; p.careerStage = 2; sim.state.touch(p);
    expect(mil.commandLevel()).toBe('squad');
    expect(mil.command('hold').ok).toBe(true);
    p.careerStage = 3;
    expect(mil.commandLevel()).toBe('company');
    M.army(id)!.commander = p.id;
    expect(mil.commandLevel()).toBe('army');
  });

  it('promotion by valour: levy to retinue, sergeant, captain, and knighted on the field', () => {
    const ctx = milSim({ seed: 'promote', body: true });
    const { sim, mil } = ctx;
    const { M, ka, p } = playerIn(ctx);
    p.trained.str = 13; p.trained.end = 11; p.skills.melee = 40 * 17; p.skills.archery = 40 * 10;
    bagAdd(p.inventory, 'mail_hauberk#1', 1);
    const id = mil.raiseArmy(ka, 'war', { fraction: 1, vassals: false });
    mil.order(id, { kind: 'hold' });
    mil.joinArmy(id);
    sim.advanceDays(5);
    const points: number[] = [];
    sim.events.on('points', (e) => { if (e.kind === 'deed' || e.kind === 'rank') points.push(e.amount); });
    const tiers: number[] = [];
    sim.events.on('rankChanged', (e) => { if (e.person === p.id) tiers.push(e.to); });
    const pm = M.data.player;
    const step = (valour: number): void => { pm.valour = valour; sim.advanceDays(1.1); };
    step(6);
    expect(['man_at_arms', 'archer']).toContain(p.career);
    expect(mil.service().role).toBe('soldier');
    step(13);
    expect(p.career).toBe('sergeant');
    expect(mil.service().role).toBe('sergeant');
    step(23);
    expect(mil.service().role).toBe('captain');
    expect(p.rankTier).toBeGreaterThanOrEqual(4);
    step(41);
    expect(p.career).toBe('knight');
    expect(p.rankTier).toBe(5);
    expect(p.estate).toBe('noble');
    expect(tiers).toContain(5);
    expect(points.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
    expect(sim.state.chronicle.some((c) => /knighted for valour/.test(c.text))).toBe(true);
  });

  it('marching with the army: the player\'s body is carried along; plunder and pay reach his purse', () => {
    const ctx = milSim({ seed: 'carry', body: true });
    const { sim, mil, body } = ctx;
    const { M, ka, p } = playerIn(ctx);
    const id = mil.raiseArmy(ka, 'war', { fraction: 1, vassals: false });
    mil.joinArmy(id);
    const army = M.army(id)!;
    expect(body.moves).toBeGreaterThan(0);
    sim.advanceDays(4);
    const dest = sim.world.settlements.find((s) => Math.hypot(s.x - army.x, s.z - army.z) > 2500)!;
    mil.order(id, { kind: 'march', x: dest.x, z: dest.z, settlement: dest.id });
    for (let i = 0; i < 24 * 3; i++) {
      sim.advanceHours(1);
      // sub-steps run in step(); here the body is moved by the system on every call
      for (let k = 0; k < 3; k++) sim.step(0.05);
    }
    expect(Math.hypot(body.x - army.x, body.z - army.z)).toBeLessThan(200);
    const money0 = p.money;
    army.funds = 4000;
    mil.disband(id);
    expect(p.money).toBeGreaterThan(money0);
    expect(M.data.player.earned).toBeGreaterThan(0);
  });

  it('a battle the player is in runs as a detail fight through the combat module (≤ 60 a side), then concludes', () => {
    const ctx = milSim({ seed: 'detail', body: true });
    const { sim, mil, body } = ctx;
    const pol = fakePolitics(sim);
    const combat = fakeCombat(sim, 0.4);
    const { M, ka, p } = playerIn(ctx);
    const kb = royals(sim)[1];
    const w = declareWar(pol, sim, [ka], [kb]);
    const ia = mil.raiseArmy(ka, 'war', { fraction: 1, vassals: true, war: w.id });
    const ib = mil.raiseArmy(kb, 'war', { vassals: true, war: w.id });
    mil.order(ia, { kind: 'hold' }); mil.order(ib, { kind: 'hold' });
    mil.joinArmy(ia);
    sim.advanceDays(5);
    const A = M.army(ia)!, B = M.army(ib)!;
    expect(A.men.length).toBeGreaterThan(60);
    body.x = A.x; body.z = A.z;
    B.x = A.x + 60; B.z = A.z;
    sim.advanceHours(1);
    expect(combat.engaged).toHaveLength(1);
    const rec = M.data.battles[0];
    expect(rec).toBeTruthy();
    expect(rec.detailA.length).toBeLessThanOrEqual(60);
    expect(rec.detailD.length).toBeLessThanOrEqual(60);
    expect([...rec.detailA, ...rec.detailD]).toContain(p.id);
    expect(mil.battles().some((b) => b.playerPresent)).toBe(true);
    expect(sim.hostileNear()).toBe(true);
    // the army cannot be told to disband in the middle of it
    expect(mil.disband(ia).ok).toBe(false);
    const points: number[] = [];
    sim.events.on('points', (e) => { if (e.kind === 'deed') points.push(e.amount); });
    combat.finish(rec.fight, `house:${ka}`);
    sim.step(0.05);
    expect(mil.battles()).toHaveLength(0);
    expect(sim.hostileNear()).toBe(false);
    expect(pol.reports.length).toBeGreaterThan(0);
    expect(M.data.player.battles).toBe(1);
    expect(M.data.player.valour).toBeGreaterThan(0);
    expect(points.length).toBeGreaterThan(0);
  });
});
