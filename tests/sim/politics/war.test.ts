// Wars (SPEC §15): legality under realm law, progress from battle reports and sieges (or the abstract
// campaign when no military is installed), and peace terms that move titles, money and oaths.
import { describe, expect, it, vi } from 'vitest';
import type { SimEvents } from '../../../src/sim/events';
import { continentPct, ruledTitles } from '../../../src/sim/score';
import { makePlayer } from '../builders';
import type { MilitaryApi } from '../../../src/sim/wave3';
import { bringNear, holderOf, housesHolding, noble, rig, titlesOfKind, type Rig } from './helpers';

function kings(r: Rig): [number, number] {
  const k = housesHolding(r.sim, 'kingdom');
  return [k[0], k[1]];
}

function startWar(r: Rig, a: number, b: number): number {
  bringNear(r, a, b);
  const res = r.pol.declareWar(a, b, { cause: 'conquest' });
  expect(res).toMatchObject({ ok: true });
  return res.war!;
}

describe('declaring wars', () => {
  it('a king may make war across the border; sides gather vassals; events and chronicle say so', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const events: Array<SimEvents['war']> = [];
    r.sim.events.on('war', (e) => events.push(e));
    const id = startWar(r, a, b);
    const w = r.pol.war(id)!;
    expect(w.attackers[0]).toBe(a);
    expect(w.defenders[0]).toBe(b);
    for (const v of r.pol.vassalsOf(a)) expect(w.attackers).toContain(v);
    for (const v of r.pol.vassalsOf(b)) expect(w.defenders).toContain(v);
    expect(w.goal).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ phase: 'declared', war: id });
    expect(events[0].attackers[0]).toBe(a);
    expect(r.pol.wars().map((x) => x.id)).toContain(id);
    expect(r.pol.warsOf(a).length).toBe(1);
    expect(r.pol.warsOf(r.pol.vassalsOf(b)[0]).length).toBe(1);
    expect(r.pol.stance(a, b)).toBe('war');
    expect(r.sim.state.chronicle.some((c) => c.kind === 'war')).toBe(true);
    // one offensive war at a time, and not against a House already fought
    expect(r.pol.canDeclare(a, b, 'conquest').ok).toBe(false);
  });

  it('realm law governs private war: barons need the king’s leave, knights never wage it', () => {
    const r = rig({ preset: 'small' });
    const k = housesHolding(r.sim, 'kingdom')[0];
    const earls = r.pol.vassalsOf(k).filter((h) => r.x.core.titlesOfHouse(h).some((t) => t.kind === 'county'));
    expect(earls.length).toBeGreaterThanOrEqual(1);
    const kingdom = r.x.core.kingdomOfHouse(k);
    const knights = r.pol.actors().filter((h) => r.x.core.primaryTitle(h)?.kind === 'manor' && r.pol.realmLeader(h) === k);
    r.x.core.lawsFor(kingdom).privateWar = false;
    const e = earls[0];
    const foes = r.pol.actors().filter((h) => h !== e && h !== k && r.pol.liegeOf(h) === k);
    const foe = foes[0];
    expect(foe).toBeTruthy();
    expect(r.pol.canDeclare(e, foe, 'conquest').ok).toBe(false);
    expect(r.pol.canDeclare(e, foe, 'conquest').reason).toMatch(/law of the realm/);
    r.x.core.lawsFor(kingdom).privateWar = true;
    if (knights.length) {
      const m = knights.find((x) => x !== foe) ?? knights[0];
      expect(r.pol.canDeclare(m, foe, 'conquest').ok).toBe(false);
      expect(r.pol.canDeclare(m, foe, 'conquest').reason).toMatch(/baron/);
    }
    // a vassal never makes ordinary war on his own liege
    expect(r.pol.canDeclare(e, k, 'conquest').ok).toBe(false);
    expect(r.pol.canDeclare(k, e, 'conquest').ok).toBe(false);
    expect(r.pol.canDeclare(k, e, 'punitive').ok).toBe(true);
  });

  it('a truce holds a House back unless it breaks the truce at a price in honour', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    r.x.diplo.apply(a, b, 'truce');
    expect(r.pol.canDeclare(a, b, 'conquest').ok).toBe(false);
    expect(r.pol.canDeclare(a, b, 'conquest', true).ok).toBe(true);
    const head = r.x.core.headOf(a)!;
    const honour = head.rep.honour;
    bringNear(r, a, b);
    expect(r.pol.declareWar(a, b, { cause: 'conquest', breakTruce: true }).ok).toBe(true);
    expect(head.rep.honour).toBeLessThan(honour);
  });

  it('allies answer the call; a defender’s liege defends him across a border', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    // the second king’s vassal is attacked by the first king: the second king defends him
    const vassal = r.pol.vassalsOf(b).find((v) => r.x.core.titlesOfHouse(v).some((t) => t.kind === 'county'));
    expect(vassal).toBeTruthy();
    bringNear(r, a, vassal!);
    r.sim.rng('politics.war').next = () => 0;
    const res = r.pol.declareWar(a, vassal!, { cause: 'conquest' });
    expect(res.ok).toBe(true);
    const w = r.pol.war(res.war!)!;
    expect(w.defenders).toContain(b);
  });
});

describe('how wars go and end', () => {
  it('battle reports and sieges move the score; a decisive score ends the war', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const id = startWar(r, a, b);
    r.pol.reportBattle(id, true, 15);
    expect(r.pol.war(id)!.score).toBe(15);
    r.pol.reportBattle(id, false, 40);
    expect(r.pol.war(id)!.score).toBe(-25);
    r.pol.reportBattle(id, true, 500); // clamped to one battle's worth
    expect(r.pol.war(id)!.score).toBe(15);
    expect(r.pol.wars().find((x) => x.id === id)!.score).toBe(15);
    // a siege of the defender's town counts for the besieger
    const seat = r.x.core.demesnes(b)[0];
    const before = r.pol.war(id)!.score;
    r.sim.events.emit('siege', { phase: 'fell', settlement: seat, besieger: a });
    expect(r.pol.war(id)!.score).toBeGreaterThan(before);
    expect(r.pol.war(id)!.occupied).toContain(seat);
    r.sim.events.emit('siege', { phase: 'lifted', settlement: seat, besieger: a });
    expect(r.pol.war(id)!.occupied).not.toContain(seat);
  });

  it('victory takes the prize: the title changes House, its oath is renewed, the loser keeps a claim and a truce follows', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const id = startWar(r, a, b);
    const goal = r.sim.state.titles.get(r.pol.war(id)!.goal)!;
    const loser = holderOf(r.sim, goal).house;
    const ended: Array<SimEvents['war']> = [];
    r.sim.events.on('war', (e) => { if (e.phase === 'ended') ended.push(e); });
    const offices: Array<SimEvents['office']> = [];
    r.sim.events.on('office', (e) => offices.push(e));
    r.pol.war(id)!.score = 100;
    r.sim.advanceDays(1);
    expect(r.pol.wars().length).toBe(0);
    expect(ended).toHaveLength(1);
    expect(ended[0].winner).toBe('attackers');
    expect(holderOf(r.sim, goal).house).toBe(a);
    expect(r.x.core.liegeOf(a)).toBe(0);
    // held from the conqueror's own crown now
    const above = r.sim.state.titles.get(goal.liege)!;
    expect(holderOf(r.sim, above).house).toBe(a);
    expect(r.pol.claimsOn(goal.id).some((c) => c.house === loser && c.kind === 'deposed')).toBe(true);
    expect(r.x.core.tie(a, b).truce).toBeGreaterThan(r.sim.absDay);
    expect(r.pol.history().at(-1)).toMatchObject({ winner: 'attackers', terms: 'title' });
    expect(offices.some((o) => o.gained && o.place === goal.place && o.person === holderOf(r.sim, goal).id)).toBe(true);
    expect(holderOf(r.sim, goal).offices.some((o) => o.place === goal.place)).toBe(true);
    expect(r.sim.state.chronicle.some((c) => /takes/.test(c.text))).toBe(true);
    expect(r.x.core.save.stats.titlesMoved).toBeGreaterThanOrEqual(1);
  });

  it('terms by margin of victory: tribute for a narrow win, white peace for a draw, homage on request', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const id = startWar(r, a, b);
    const w = r.x.wars.get(id)!;
    w.score = 40;
    expect(r.x.wars.victorTerms(w, 'attackers')).toBe('tribute');
    w.score = 10;
    expect(r.x.wars.victorTerms(w, 'attackers')).toBe('white');
    w.score = -80;
    expect(r.x.wars.victorTerms(w, 'defenders')).toBe('tribute');
    // tribute moves money from the loser to the winner
    const pa = r.x.core.purseOf(a), pb = r.x.core.purseOf(b);
    r.x.wars.end(w, 'attackers', 'tribute');
    expect(r.x.core.purseOf(b)).toBeLessThan(pb);
    expect(r.x.core.purseOf(a)).toBeGreaterThan(pa);
    // vassalage terms bind the loser to the winner
    const r2 = rig({ preset: 'small' });
    const [a2, b2] = kings(r2);
    const id2 = startWar(r2, a2, b2);
    r2.x.wars.end(r2.x.wars.get(id2)!, 'attackers', 'vassalize');
    expect(r2.pol.liegeOf(b2)).toBe(a2);
    expect(r2.pol.stance(b2, a2)).toBe('vassal');
  });

  it('the side that is winning can be asked for peace: odds rise with the score, surrender is always possible', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const id = startWar(r, a, b);
    const w = r.x.wars.get(id)!;
    w.score = 70;
    const win = r.pol.peaceOptions(id, 'attackers');
    const lose = r.pol.peaceOptions(id, 'defenders');
    expect(win.map((o) => o.terms)).toEqual(expect.arrayContaining(['white', 'tribute', 'title']));
    expect(lose.find((o) => o.terms === 'surrender')!.chance).toBe(1);
    expect(win.find((o) => o.terms === 'title')!.chance).toBeGreaterThan(win.find((o) => o.terms === 'vassalize')!.chance);
    // asking for white peace from a losing position is hard
    expect(lose.find((o) => o.terms === 'white')!.chance).toBeLessThan(win.find((o) => o.terms === 'white')!.chance);
    // a refused offer leaves the war; an accepted one ends it
    const rng = r.sim.rng('politics.peace');
    rng.next = () => 0.999;
    expect(r.pol.makePeace(id, 'attackers', 'tribute').ok).toBe(false);
    expect(r.pol.wars().length).toBe(1);
    rng.next = () => 0;
    expect(r.pol.makePeace(id, 'attackers', 'tribute').ok).toBe(true);
    expect(r.pol.wars().length).toBe(0);
    expect(r.pol.makePeace(id, 'attackers', 'tribute').ok).toBe(false);
  });

  it('without a military, an unattended war is fought on paper and always ends; battles are announced and men die', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const battles: Array<SimEvents['battle']> = [];
    r.sim.events.on('battle', (e) => battles.push(e));
    const ended: Array<SimEvents['war']> = [];
    r.sim.events.on('war', (e) => { if (e.phase === 'ended') ended.push(e); });
    startWar(r, a, b);
    const pop = r.sim.state.population;
    let days = 0;
    while (r.pol.wars().length > 0 && days < 16 * 8) { r.sim.advanceDays(1); days++; }
    expect(r.pol.wars().length).toBe(0);
    expect(ended).toHaveLength(1);
    expect(battles.length).toBeGreaterThan(0);
    expect(battles.every((x) => x.dead >= 0 && x.war > 0)).toBe(true);
    expect(r.sim.state.population).toBeLessThanOrEqual(pop + 40);
  });

  it('a war in which armies march is left to them: the paper campaign slows to a crawl and the leaders are told to raise their levies', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const raise = vi.fn(() => 1);
    const mil: MilitaryApi = {
      armies: () => [{ id: 1, house: a, commander: 0, x: 0, z: 0, troops: { levy: 120, knights: 8 }, task: 'march' }],
      raise, armyOf: () => 0,
    };
    const strengthBefore = r.pol.strength(a);
    r.sim.services.military = mil;
    r.x.core.invalidate();
    expect(r.pol.strength(a)).toBeGreaterThan(strengthBefore);
    const id = startWar(r, a, b);
    expect(raise).toHaveBeenCalledWith(a, expect.any(String));
    expect(raise).toHaveBeenCalledWith(b, expect.any(String));
    const battles: Array<SimEvents['battle']> = [];
    r.sim.events.on('battle', (e) => battles.push(e));
    r.sim.advanceDays(8);
    expect(battles.length).toBe(0); // the military reports its own battles through reportBattle
    expect(Math.abs(r.pol.war(id)!.score)).toBeLessThan(40);
    // a war the armies never settle still ends in the end (war weariness)
    r.sim.advanceDays(16 * 8);
    expect(r.pol.war(id)).toBeUndefined();
  });

  it('a raid plunders the stores and herds of a village and fires a raid event', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    bringNear(r, a, b);
    const raids: Array<SimEvents['raid']> = [];
    r.sim.events.on('raid', (e) => raids.push(e));
    const res = r.pol.declareWar(a, b, { cause: 'raid' });
    expect(res.ok).toBe(true);
    const w = r.pol.war(res.war!)!;
    expect(w.goal).toBe(0);
    expect(raids).toHaveLength(1);
    expect(raids[0].raider).toBe(a);
    expect(raids[0].stolen).toBeGreaterThanOrEqual(0);
    expect(r.x.core.save.unrest[String(w.target)]).toBeGreaterThan(0);
    r.sim.advanceDays(4);
    expect(r.pol.wars().length).toBe(0); // a raid is over in a few days
  });

  it('conquest moves the continent share of the player’s House', () => {
    const r = rig({ preset: 'small', keepPlayer: true });
    const [a, b] = kings(r);
    makePlayer(r.sim, r.x.core.headOf(a)!);
    r.x.core.invalidate();
    const before = ruledTitles(r.sim.state).size;
    const id = startWar(r, a, b);
    const goal = r.pol.war(id)!.goal;
    r.pol.war(id)!.score = 100;
    r.sim.advanceDays(1);
    const after = ruledTitles(r.sim.state);
    expect(after.size).toBeGreaterThan(before);
    expect([...after].some((t) => t.id === goal)).toBe(true);
    // the continent share is refreshed at once, not at the next yearly pass
    expect(r.sim.state.score.continentPct).toBe(continentPct(r.sim.state, r.sim.world));
    // and a deed is booked for the war won
    expect(r.sim.state.score.byKind.deed ?? 0).toBeGreaterThan(0);
  });

  it('a conquered title’s old officers and vassals follow the title to its new holder', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = kings(r);
    const county = titlesOfKind(r.sim, 'county').find((t) => holderOf(r.sim, t).house !== a && holderOf(r.sim, t).house !== b && r.pol.liegeOf(holderOf(r.sim, t).house) === b);
    expect(county).toBeTruthy();
    const knights = noble(r, a, 'm', 30, { tier: 5 });
    const old = holderOf(r.sim, county!);
    const vassalsBefore = [...r.sim.state.titles.values()].filter((t) => t.liege === county!.id).map((t) => t.id);
    const id = startWar(r, a, b);
    r.pol.war(id)!.goal = county!.id;
    r.pol.war(id)!.claimant = knights.id;
    r.pol.war(id)!.score = 100;
    r.sim.advanceDays(1);
    expect(holderOf(r.sim, county!).id).toBe(knights.id);
    expect(old.offices.some((o) => o.office === 'earl' && o.place === county!.place)).toBe(false);
    for (const v of vassalsBefore) expect(r.sim.state.titles.get(v)!.liege).toBe(county!.id);
    expect(holderOf(r.sim, county!).rankTier).toBeGreaterThanOrEqual(7);
  });
});
