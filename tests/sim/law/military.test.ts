// The law and the military module (docs/CIV.md §4): the ransom right of a prisoner is the military's — `takeCaptive` on a capture by the
// watch, `release` when the law frees him, `captiveOf` / `payRansom` / `ransomValue` for a prisoner of war — and the law keeps the gaol,
// the fines and the sentences. Every one of those calls is optional: without them the law keeps the flag and the price itself. The
// military module here is a fake that keeps captives the way the real one does.
import { describe, expect, it } from 'vitest';
import type { PersonId } from '../../../src/sim/state';
import { deliver } from '../../../src/sim/law/captive';
import type { MilitaryApi } from '../../../src/sim/wave3';
import { lawContext, lawRig, rideUp, type LawRig } from './helpers';

interface Held { person: PersonId; captor: PersonId; holder: number; ransom: number; since: number; place: number }

/** A military module that keeps captives: it records what it is told, pays ransoms and frees them on request. */
function keep(r: LawRig, o: { takeRefused?: boolean; keeps?: boolean } = {}) {
  const held = new Map<PersonId, Held>();
  const calls = { taken: [] as Array<{ captive: PersonId; captor: PersonId; settlement?: number; reason?: string }>, released: [] as Array<{ captive: PersonId; reason: string }>, paid: [] as PersonId[] };
  const api = r.mil as unknown as MilitaryApi & Record<string, unknown>;
  api.takeCaptive = (captive: PersonId, captor: PersonId, opts?: { settlement?: number; reason?: string }) => {
    calls.taken.push({ captive, captor, ...opts });
    if (o.takeRefused) return { ok: false, reason: 'refused' };
    if (o.keeps !== false) held.set(captive, { person: captive, captor, holder: r.lordHouse, ransom: 90, since: r.sim.absDay, place: opts?.settlement ?? -1 });
    return { ok: true };
  };
  api.release = (captive: PersonId, reason: string) => {
    calls.released.push({ captive, reason });
    held.delete(captive);
    const p = r.sim.state.persons.get(captive);
    if (p) { delete p.flags.captive; r.sim.state.touch(p); }
  };
  api.captiveOf = (person: PersonId) => held.get(person) ?? null;
  api.captives = () => [...held.values()];
  api.payRansom = (captive: PersonId) => {
    const c = held.get(captive);
    if (!c) return { ok: false, reason: 'not held' };
    calls.paid.push(captive);
    held.delete(captive);
    const p = r.sim.state.persons.get(captive);
    if (p) { delete p.flags.captive; r.sim.state.touch(p); }
    return { ok: true };
  };
  api.ransomValue = () => 90;
  return { held, calls };
}

function halted(r: LawRig): void {
  r.law.report(r.stranger.id, r.court.x, r.court.z);
  rideUp(r);
  r.run(0.2);
}

/** The patrol is done and the prisoner is in the cell (the walk is not what these tests are about). */
function inCell(r: LawRig): void {
  const C = lawContext(r.sim);
  const p = C.patrol.get(r.stranger.id);
  if (p) C.patrol.finish(p);
  const rec = C.law.store.captiveOf(r.stranger.id)!;
  deliver(C.law, rec);
}

describe('a capture by the watch', () => {
  it('is told to the military module, which keeps the ransom right; the fine stays the lord\'s and is what the card asks', () => {
    const r = lawRig({ seed: 'law-mil1' });
    const m = keep(r);
    halted(r);
    r.law.answerPatrol(r.stranger.id, 'yield');
    expect(m.calls.taken).toHaveLength(1);
    expect(m.calls.taken[0]).toMatchObject({ captive: r.stranger.id, settlement: r.village.id });
    expect(m.calls.taken[0].reason).toMatch(/trespass|closes|lands/i);
    const rec = lawContext(r.sim).law.store.captiveOf(r.stranger.id)!;
    expect(rec.military).toBe(true);
    // a trespasser is held for a fine, not a ransom, whatever the module keeps for him
    const c = r.law.captivity(r.stranger.id)!;
    expect(c.war).toBeFalsy();
    expect(c.fine).toBeGreaterThan(0);
    expect(c.ransom).toBe(0);
    const pay = r.law.captivityChoices(r.stranger.id).find((x) => x.id === 'pay')!;
    expect(pay.label).toBe('Pay the fine');
  });

  it('paying the fine frees him in both: the law lets him go and the module is told (ransomed)', () => {
    const r = lawRig({ seed: 'law-mil2' });
    const m = keep(r);
    halted(r);
    r.law.answerPatrol(r.stranger.id, 'yield');
    inCell(r);
    r.stranger.money = 500;
    expect(r.law.chooseInCaptivity(r.stranger.id, 'pay').ok).toBe(true);
    expect(r.law.captivity(r.stranger.id)).toBeNull();
    expect(m.calls.released).toEqual([{ captive: r.stranger.id, reason: 'ransomed' }]);
    expect(m.held.size).toBe(0);
    expect(r.stranger.flags.captive).toBeFalsy();
    expect(r.player.bound).toBeNull();
  });

  it('serving the sentence frees him in both ("served"); escaping tells the module he escaped', () => {
    const r = lawRig({ seed: 'law-mil3' });
    const m = keep(r);
    halted(r);
    r.law.answerPatrol(r.stranger.id, 'yield');
    inCell(r);
    expect(r.law.chooseInCaptivity(r.stranger.id, 'serve').ok).toBe(true);
    r.sim.advanceDays(4);
    expect(r.law.captivity(r.stranger.id)).toBeNull();
    expect(m.calls.released.map((x) => x.reason)).toEqual(['served']);
    // and a second man escapes in the night
    const other = r.sim.state.residentList(r.village.id).find((p) => p.id !== r.stranger.id && p.sex === 'm' && !p.death && p.settlement === r.village.id)!;
    expect(r.law.seize(other.id, r.lord.id, 'poaching', r.village.id, "poaching the lord's deer")).toBe(true);
    const night = Math.floor(r.sim.absDay) + 1 + 0.02;
    r.sim.state.clock.absDay = night;
    r.rig(0.0);
    expect(r.law.chooseInCaptivity(other.id, 'escape').ok).toBe(true);
    expect(m.calls.released.at(-1)).toEqual({ captive: other.id, reason: 'escaped' });
    expect(r.law.wanted!(other.id).length).toBe(1);
  });

  it('a module that refuses (or keeps nobody) leaves the law to keep the flag and set the price itself', () => {
    const r = lawRig({ seed: 'law-mil4' });
    const m = keep(r, { takeRefused: true });
    halted(r);
    r.law.answerPatrol(r.stranger.id, 'yield');
    expect(m.calls.taken).toHaveLength(1);
    const rec = lawContext(r.sim).law.store.captiveOf(r.stranger.id)!;
    expect(rec.military).toBe(false);
    expect(r.stranger.flags.captive).toBe(true);
    inCell(r);
    r.stranger.money = 500;
    expect(r.law.chooseInCaptivity(r.stranger.id, 'pay').ok).toBe(true);
    expect(m.calls.released).toHaveLength(0);
    expect(r.stranger.flags.captive).toBeFalsy();

    // takeCaptive says yes but the module does not report him afterwards: the law does not hand him over
    const r2 = lawRig({ seed: 'law-mil4b' });
    keep(r2, { keeps: false });
    halted(r2);
    r2.law.answerPatrol(r2.stranger.id, 'yield');
    expect(lawContext(r2.sim).law.store.captiveOf(r2.stranger.id)!.military).toBe(false);
  });

  it('works with no military module at all (headless, old saves)', () => {
    const r = lawRig({ seed: 'law-mil5' });
    delete r.sim.services.military;
    halted(r);
    expect(r.law.answerPatrol(r.stranger.id, 'yield').ok).toBe(true);
    inCell(r);
    r.stranger.money = 500;
    expect(r.law.chooseInCaptivity(r.stranger.id, 'pay').ok).toBe(true);
    expect(r.stranger.flags.captive).toBeFalsy();
  });

  it('when the module frees him by its own rules (the family paid, its patience ran out) the law lets him go the next dawn', () => {
    const r = lawRig({ seed: 'law-mil6' });
    const m = keep(r);
    halted(r);
    r.law.answerPatrol(r.stranger.id, 'yield');
    inCell(r);
    expect(r.law.captivity(r.stranger.id)).not.toBeNull();
    // the module's daily tick frees him
    (r.mil as unknown as { release: (p: PersonId, why: string) => void }).release(r.stranger.id, 'ransomed');
    m.calls.released.length = 0;
    r.sim.advanceDays(1);
    expect(r.law.captivity(r.stranger.id)).toBeNull();
    expect(r.player.bound).toBeNull();
    // the law does not tell the module again what it already knows
    expect(m.calls.released).toHaveLength(0);
  });
});

describe('prisoners of war', () => {
  it('a soldier who yields at war is a prisoner of war: the ransom is the module\'s figure, paid through it', () => {
    const r = lawRig({ seed: 'law-mil7' });
    const m = keep(r);
    r.pol.war([r.lordHouse], [r.strangerHouse]);
    r.stranger.career = 'soldier';
    halted(r);
    r.law.answerPatrol(r.stranger.id, 'yield');
    const c = r.law.captivity(r.stranger.id)!;
    expect(c.kind).toBe('war');
    expect(c.war).toBe(true);
    expect(c.ransom).toBe(90);
    expect(c.fine).toBe(0);
    const ids = r.law.captivityChoices(r.stranger.id);
    expect(ids.find((x) => x.id === 'pay')!.label).toBe('Pay your own ransom');
    expect(ids.find((x) => x.id === 'serve')!.ok).toBe(false);
    inCell(r);
    r.stranger.money = 200;
    expect(r.law.chooseInCaptivity(r.stranger.id, 'pay').ok).toBe(true);
    expect(m.calls.paid).toEqual([r.stranger.id]);
    expect(r.law.captivity(r.stranger.id)).toBeNull();
    expect(r.player.bound).toBeNull();
  });

  it('a capture the module made itself (a battle) is the player\'s case here at once: the card opens, he is bound in the cell', () => {
    const r = lawRig({ seed: 'law-mil8', gaol: true });
    const m = keep(r);
    const ui: unknown[] = [];
    r.sim.events.on('ui', (e) => ui.push(e));
    // the module took him in a battle: its record exists, then it tells the world
    m.held.set(r.stranger.id, { person: r.stranger.id, captor: r.lord.id, holder: r.lordHouse, ransom: 300, since: r.sim.absDay, place: r.village.id });
    r.stranger.flags.captive = true;
    r.sim.events.emit('captured', { captive: r.stranger.id, captor: r.lord.id, ransom: 300 });
    const c = r.law.captivity(r.stranger.id)!;
    expect(c.war).toBe(true);
    expect(c.ransom).toBe(300);
    expect(c.text).toMatch(/Held prisoner/);
    expect(r.player.bound?.kind).toBe('held');
    expect(ui).toContainEqual({ panel: 'ext', name: 'law', data: { mode: 'captive' } });
    // and the ruler's list shows him once
    expect(r.law.prisoners().filter((x) => x.person === r.stranger.id)).toHaveLength(1);
  });

  it('prisoners the module keeps without a case of the law\'s own are on the ruler\'s list, with the module\'s ransom', () => {
    const r = lawRig({ seed: 'law-mil9', gaol: true });
    const m = keep(r);
    const knight = r.sim.state.residentList(r.village.id).find((p) => p.id !== r.stranger.id && p.sex === 'm' && !p.death)!;
    m.held.set(knight.id, { person: knight.id, captor: r.lord.id, holder: r.lordHouse, ransom: 450, since: r.sim.absDay, place: r.village.id });
    knight.flags.captive = true;
    const list = r.law.prisoners();
    const v = list.find((x) => x.person === knight.id)!;
    expect(v).toBeDefined();
    expect(v.war).toBe(true);
    expect(v.ransom).toBe(450);
    expect(r.law.prisoners(r.village.id).some((x) => x.person === knight.id)).toBe(true);
    // for the player's own House the choices are the plain ones: wait or pay
    const mine = r.law.captivityChoices(knight.id).map((x) => x.id);
    expect(mine).toEqual(['wait', 'pay']);
  });

  it('a prisoner of war the module no longer keeps and nobody ransomed is let go after a long wait', () => {
    const r = lawRig({ seed: 'law-mil10' });
    delete r.sim.services.military;
    r.pol.war([r.lordHouse], [r.strangerHouse]);
    const other = r.sim.state.residentList(r.village.id).find((p) => p.id !== r.stranger.id && p.sex === 'm' && !p.death)!;
    // a family that cannot raise a penny
    other.money = 0;
    r.sim.state.households.get(other.household)!.purse = 0;
    const head = r.sim.state.persons.get(r.sim.state.houses.get(other.house)?.head ?? 0);
    if (head) r.sim.state.households.get(head.household)!.purse = 0;
    expect(r.law.seize(other.id, r.lord.id, 'war', r.village.id, 'scouting the lord\'s lands')).toBe(true);
    r.sim.advanceDays(10);
    expect(r.law.captivity(other.id)).not.toBeNull();
    r.sim.advanceDays(40);
    expect(r.law.captivity(other.id)).toBeNull();
    expect(other.flags.captive).toBeFalsy();
  });
});
