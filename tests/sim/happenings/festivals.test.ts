// Festivals, fairs, tournaments, progresses and the gatherings of the player's village.
import { describe, expect, it } from 'vitest';
import { autoSuccessor } from '../helpers';
import { mkPerson } from '../builders';
import { advSim } from '../advancement/helpers';

/** Runs the calendar up to a day of the year (hour 6). */
function toDayOfYear(a: ReturnType<typeof advSim>, doy: number): void {
  const day = Math.floor(a.sim.absDay);
  const target = day - (day % 16) + doy + (doy <= day % 16 ? 16 : 0);
  a.sim.advanceHours(Math.max(1, Math.round((target + 0.25 - a.sim.absDay) * 24)));
}

describe('feasts', () => {
  it('keeps the harvest festival, midsummer and Christmas everywhere', () => {
    const a = advSim({ seed: 'feasts' });
    const seen: string[] = [];
    a.sim.events.on('happening', (e) => { if (e.phase === 'start') seen.push(e.kind); });
    toDayOfYear(a, 6);
    expect(a.adv.happenings.activeAt(a.player.settlement)).toContain('midsummer');
    toDayOfYear(a, 9);
    expect(a.adv.happenings.activeAt(a.player.settlement)).toContain('harvest');
    toDayOfYear(a, 12);
    expect(a.adv.happenings.activeAt(a.player.settlement)).toContain('christmas');
    a.sim.advanceDays(2);
    expect(a.adv.happenings.activeAt(a.player.settlement)).not.toContain('christmas');
    expect(seen).toEqual(expect.arrayContaining(['midsummer', 'harvest', 'christmas']));
  });

  it('lifts the mood of the player\'s neighbours on a feast day', () => {
    const a = advSim({ seed: 'feasts-mood' });
    const folk = a.sim.state.residentsOf(a.player.settlement).filter((p) => p.id !== a.player.id).slice(0, 20);
    for (const p of folk) p.needs.mood = 0.4;
    toDayOfYear(a, 9);
    const better = folk.filter((p) => !p.death && p.needs.mood > 0.4).length;
    expect(better).toBeGreaterThan(10);
  });
});

describe('fairs', () => {
  it('are held yearly at towns whose lords hold a fair charter', () => {
    const a = advSim({ seed: 'fair' });
    const town = a.sim.world.settlements.find((s) => (s.kind === 'town' || s.kind === 'city') && s.market && a.sim.state.titleFor('town', s.id)?.holder)!;
    const lord = a.sim.state.persons.get(a.sim.state.titleFor('town', town.id)!.holder)!;
    a.adv.grant(lord.id, 'market_charter');
    a.adv.grant(lord.id, 'fair_charter');
    const started: number[] = [];
    a.sim.events.on('happening', (e) => { if (e.phase === 'start' && e.kind === 'fair') started.push(e.settlement); });
    a.sim.advanceDays(16 * 2);
    expect(started).toContain(town.id);
    // and not at a town without the charter
    const bare = a.sim.world.settlements.find((s) => (s.kind === 'town' || s.kind === 'city') && s.market && s.id !== town.id && !a.adv.happenings.hap.save.recent.some((r) => r.kind === 'fair' && r.settlement === s.id));
    if (bare) {
      const holder = a.sim.state.titleFor('town', bare.id)?.holder;
      if (holder && !a.adv.knows(holder, 'fair_charter') && !a.adv.settlementHas(bare.id, 'fair_charter')) expect(started).not.toContain(bare.id);
    }
  });

  it('count for the player\'s score when held in their own town', () => {
    const a = advSim({ seed: 'fair-own' });
    const town = a.sim.world.settlements.find((s) => (s.kind === 'town' || s.kind === 'city') && s.market && a.sim.state.titleFor('town', s.id)?.holder)!;
    const t = a.sim.state.titleFor('town', town.id)!;
    a.sim.state.setTitleHolder(t, a.player.id);
    a.adv.grant(a.player.id, 'market_charter');
    a.adv.grant(a.player.id, 'fair_charter');
    const points0 = a.sim.state.score.points;
    a.sim.advanceDays(16 * 2);
    expect(a.sim.state.score.points).toBeGreaterThan(points0);
  });
});

describe('tournaments and progresses', () => {
  it('a tournament is held where knights know how, and a knight wins it', () => {
    const a = advSim({ seed: 'tourney', preset: 'small' });
    const county = a.sim.world.counties[0];
    const seat = county.seat;
    const knights = [0, 1, 2].map(() => mkPerson(a.sim, { sex: 'm', age: 25, estate: 'noble', tier: 5, career: 'knight', settlement: seat }));
    for (const k of knights) { k.skills.melee = 40 * 49; a.adv.grant(k.id, 'tournaments'); }
    a.player.rankTier = 2;
    const won: number[] = [];
    a.sim.events.on('happening', (e) => { if (e.kind === 'tournament' && e.phase === 'start') won.push(e.settlement); });
    const prestige = knights.map((k) => k.prestige);
    toDayOfYear(a, 6);
    a.sim.advanceHours(2);
    expect(won).toContain(seat);
    expect(knights.some((k, i) => k.prestige > prestige[i])).toBe(true);
    expect(a.sim.state.chronicle.some((c) => /won the tournament/.test(c.text))).toBe(true);
  });

  it('the king makes a royal progress to a town of his realm each year', () => {
    const a = advSim({ seed: 'progress' });
    autoSuccessor(a.sim); // a long run must not stop when the random player dies
    const seen: number[] = [];
    a.sim.events.on('happening', (e) => { if (e.phase === 'start' && e.kind === 'progress') seen.push(e.settlement); });
    a.sim.advanceDays(16 * 2);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });
});

describe('weddings, funerals and christenings', () => {
  it('become gatherings at the church of the player\'s village, with people sent to the door', () => {
    const commands: Array<[number, { kind: string; x?: number; z?: number }]> = [];
    const said: string[] = [];
    const agents = new Set<number>();
    const zone = {
      agent: (id: number) => (agents.has(id) ? { x: 0, z: 0 } : null),
      command: (id: number, o: { kind: string; x?: number; z?: number }) => { commands.push([id, o]); },
      say: (_id: number, t: string) => { said.push(t); },
      nav: { doorOf: () => ({ x: 500, z: 500, yaw: 0 }) },
    };
    const a = advSim({ seed: 'wedding', zone: zone as never });
    const sid = a.player.settlement;
    const groom = mkPerson(a.sim, { sex: 'm', age: 22, tier: 2, settlement: sid });
    const bride = mkPerson(a.sim, { sex: 'f', age: 20, tier: 2, settlement: sid });
    for (const p of a.sim.state.residentsOf(sid)) agents.add(p.id);
    const phases: string[] = [];
    a.sim.events.on('happening', (e) => { if (e.kind === 'wedding') phases.push(e.phase); });
    a.sim.events.emit('marriage', { a: groom.id, b: bride.id, settlement: sid });
    expect(a.adv.happenings.hap.save.queue).toHaveLength(1);
    a.sim.advanceHours(19); // seven in the morning tomorrow
    expect(phases).toEqual([]); // not yet: ten o'clock
    a.sim.advanceHours(5);
    expect(phases).toEqual(['start']);
    expect(a.adv.happenings.activeAt(sid)).toContain('wedding');
    expect(commands.filter(([, o]) => o.kind === 'goto').length).toBeGreaterThanOrEqual(3);
    expect(said.length).toBeGreaterThan(0);
    // everyone goes back to their day
    a.sim.advanceHours(5);
    expect(phases).toEqual(['start', 'end']);
    expect(commands.filter(([, o]) => o.kind === 'resume').length).toBeGreaterThanOrEqual(3);
  });

  it('are held for funerals and christenings too, but only near the player', () => {
    const a = advSim({ seed: 'funeral' });
    const far = a.sim.world.settlements.find((s) => s.id !== a.player.settlement && a.sim.state.residentsOf(s.id).length > 5)!;
    const farFolk = a.sim.state.residentsOf(far.id)[0];
    a.sim.events.emit('death', { person: farFolk.id, cause: 'illness', age: 50, wasHead: false });
    expect(a.adv.happenings.hap.save.queue).toHaveLength(0);
    const near = a.sim.state.residentsOf(a.player.settlement).find((p) => p.id !== a.player.id)!;
    a.sim.events.emit('death', { person: near.id, cause: 'illness', age: 50, wasHead: false });
    expect(a.adv.happenings.hap.save.queue.map((q) => q.kind)).toEqual(['funeral']);
    a.sim.events.emit('birth', { person: near.id, mother: 0, father: 0, settlement: a.player.settlement });
    expect(a.adv.happenings.hap.save.queue.map((q) => q.kind)).toEqual(['funeral', 'christening']);
  });
});
