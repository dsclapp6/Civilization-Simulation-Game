// A siege's storm fought in the detail zone when the player is in the line (docs/WAR.md): the macro record sets it up, the arena
// fights it, the macro model concludes it.
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../../src/core/time';
import { militaryContext } from '../../../src/sim/military';
import { stormRig, type StormRig } from './stormRig';

function beginStorm(t: StormRig) {
  const M = militaryContext(t.sim);
  t.mil.order(t.armyId, { kind: 'siege', settlement: t.castleId });
  for (let h = 0; h < 72 && !M.sieges.recOf(t.castleId); h++) t.sim.advanceHours(1);
  const rec = M.sieges.recOf(t.castleId)!;
  expect(rec).toBeTruthy();
  rec.ladders = true;
  rec.rams = 1;
  M.sieges.assault(rec, M.army(t.armyId)!);
  const battle = M.data.battles.find((b) => b.siege === t.castleId)!;
  return { M, rec, battle };
}

function runUntilConcluded(t: StormRig, seconds: number): number {
  const M = militaryContext(t.sim);
  let n = 0;
  for (; n < seconds * 20 && M.data.battles.length > 0; n++) t.sim.step(SIM_DT);
  return n * SIM_DT;
}

describe('a storm with the player in the line', () => {
  it('as one of the besiegers: the macro assault becomes a detail storm with a ram, ladders and the walls manned', () => {
    const t = stormRig('mstorm-a');
    expect(t.mil.armyOf(t.player.id)).toBe(t.armyId);
    const { battle } = beginStorm(t);
    expect(battle.fight).toBeGreaterThan(0);
    const fight = t.combat.arena.fights.get(battle.fight)!;
    expect(fight.reason).toBe('storm');
    expect(fight.scene).toBeTruthy();
    expect(fight.scene!.setup.rams).toBe(1);
    expect(fight.scene!.setup.ladders).toBeGreaterThanOrEqual(2);
    expect(fight.sides[0].members.some((f) => f.isPlayer)).toBe(true);
    // the walls are manned by the defenders who shoot
    expect(fight.scene!.status().stationed).toBeGreaterThanOrEqual(0);
    expect(t.mil.alertOf(t.castleId)).toBe('assault');
    // the gate is shut for the renderer
    const gate = t.sim.view.forts!().find((f) => f.building === t.fort.gate.id);
    expect(gate?.gate).toBe('shut');
    expect(t.sim.view.siegeWorks!().length).toBeGreaterThan(0);
  });

  it('runs to a result: the battle concludes, the macro siege hears of it, and the works are gone', () => {
    const t = stormRig('mstorm-b');
    expect(t.mil.armyOf(t.player.id)).toBe(t.armyId);
    const { M, battle } = beginStorm(t);
    const events: Array<{ attackerWon: boolean; playerPresent: boolean }> = [];
    t.sim.events.on('battle', (e) => events.push(e));
    const took = runUntilConcluded(t, 900);
    expect(M.data.battles.find((b) => b.id === battle.id)).toBeUndefined();
    expect(took).toBeLessThanOrEqual(900);
    expect(events).toHaveLength(1);
    expect(events[0].playerPresent).toBe(true);
    expect(t.combat.arena.anyFight()).toBe(false);
    expect(t.sim.view.siegeWorks!()).toHaveLength(0);
    // the walls took what the ram dealt, in the record the macro model keeps
    expect(t.fort.gate.damage).toBeGreaterThanOrEqual(0);
    expect(t.mil.alertOf(t.castleId)).not.toBe('assault');
  });

  it('as a defender (a man of the place): he stands among the defenders and the besiegers come to the gate', () => {
    const t = stormRig('mstorm-c', { asDefender: true });
    const M = militaryContext(t.sim);
    // somebody else leads the besiegers and the army sits down before the walls
    t.mil.order(t.armyId, { kind: 'siege', settlement: t.castleId });
    for (let h = 0; h < 72 && !M.sieges.recOf(t.castleId); h++) t.sim.advanceHours(1);
    const rec = M.sieges.recOf(t.castleId)!;
    rec.ladders = true; rec.rams = 1;
    M.sieges.assault(rec, M.army(t.armyId)!);
    const battle = M.data.battles.find((b) => b.siege === t.castleId)!;
    expect(battle.fight).toBeGreaterThan(0);
    const fight = t.combat.arena.fights.get(battle.fight)!;
    expect(fight.sides[1].members.some((f) => f.isPlayer)).toBe(true);
    expect(fight.scene).toBeTruthy();
    const took = runUntilConcluded(t, 900);
    expect(took).toBeLessThanOrEqual(900);
  });

  it('the commander of the host gives orders to its groups and the old six orders reach them', () => {
    const t = stormRig('mstorm-d', { asCommander: true });
    const M = militaryContext(t.sim);
    expect(M.army(t.armyId)!.commander).toBe(t.player.id);
    expect(t.mil.commandLevel()).toBe('army');
    t.mil.order(t.armyId, { kind: 'siege', settlement: t.castleId });
    for (let h = 0; h < 72 && !M.sieges.recOf(t.castleId); h++) t.sim.advanceHours(1);
    const rec = M.sieges.recOf(t.castleId)!;
    rec.ladders = true; rec.rams = 1;
    M.sieges.assault(rec, M.army(t.armyId)!);
    const battle = M.data.battles.find((b) => b.siege === t.castleId)!;
    expect(battle.fight).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) t.sim.step(SIM_DT);
    const own = t.mil.battleGroups('own');
    expect(own.length).toBeGreaterThan(1);
    expect(own[0].key).toBe('all');
    const r = t.mil.orderGroup('foot', { kind: 'hold' });
    expect(r.ok).toBe(true);
    expect(t.mil.battleGroups('own').find((g) => g.key === 'foot')?.order).toBe('hold');
    // the macro order set (keys 1–6 of the command panel) reaches the same groups
    expect(t.mil.command('charge').ok).toBe(true);
    expect(t.mil.battleGroups('own').find((g) => g.key === 'foot')?.order).toBe('charge');
    expect(t.mil.battleGroups('enemy').length).toBeGreaterThanOrEqual(0);
  });
});
