// The watch (docs/CIV.md §4): about twice a second the territory is asked whether the player may be where he stands; if not, the people of
// the owning lands who can SEE him report it — a villager runs to the manor (seven to sixteen seconds), an armed man whistles up the
// others at once — and the patrol comes. By day they see eighty metres, at night twenty-six (forty-eight beside a torch), through
// no wall. The zone's people are fakes we place; the territory is the real module on the stand-in world.
import { describe, expect, it } from 'vitest';
import { LAW } from '../../../src/sim/law/config';
import type { SimEvents } from '../../../src/sim/events';
import type { Person } from '../../../src/sim/state';
import { mkPerson } from '../builders';
import { lawContext, lawRig, offLand, type LawRig } from './helpers';

/** Sets the time of day (0 = midnight, 0.5 = noon) of the current day. */
function at(r: LawRig, frac: number): void {
  r.sim.state.clock.absDay = Math.floor(r.sim.state.clock.absDay) + 1 + frac;
  r.sim.state.clock.firedHour = Math.floor(r.sim.state.clock.absDay * 24);
  r.terr.refresh();
}

/** A person of the lord's village, standing `d` metres east of the player. */
function onlooker(r: LawRig, d: number, o: { armed?: boolean; torch?: boolean; village?: number; dz?: number } = {}): Person {
  const p = mkPerson(r.sim, {
    settlement: o.village ?? r.village.id, tier: o.armed ? 3 : 2, estate: 'free', career: o.armed ? 'man_at_arms' : 'farmer', age: o.armed ? 28 : 35,
    house: o.armed ? r.lordHouse : undefined,
  });
  const a = r.zone.addAgent(p.id, r.player.pos.x + d, r.player.pos.z + (o.dz ?? 0));
  if (o.torch) a.draw.mainHand = 'torch';
  return p;
}

const events = (r: LawRig): Array<SimEvents['trespass']> => { const out: Array<SimEvents['trespass']> = []; r.sim.events.on('trespass', (e) => out.push(e)); return out; };

describe('who sees the trespasser', () => {
  it('a villager within eighty metres by day sees him, carries the word, and the patrol comes after the delay of the report', () => {
    const r = lawRig({ seed: 'law-watch1' });
    at(r, 0.5);
    r.rig(0.5);
    const ev = events(r);
    onlooker(r, 30);
    expect(r.terr.trespass(r.stranger.id, r.court.x, r.court.z).level).toBe('private');
    r.run(2);
    // seen at the first look; nothing has been sent yet
    expect(ev.map((e) => e.phase)).toEqual(['seen']);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    expect(lawContext(r.sim).watch.current()!.seenAt).toBeGreaterThanOrEqual(0);
    // the report takes between seven and sixteen seconds (with the draw at the middle: eleven and a half)
    r.run(7);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    r.run(5);
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p).not.toBeNull();
    expect(p.phase).toBe('coming');
    expect(lawContext(r.sim).law.store.data.stats.seen).toBe(1);
    expect(lawContext(r.sim).law.store.data.stats.patrols).toBe(1);
  });

  it('nobody to see him, nothing happens: no matter how long he stays, no patrol is sent', () => {
    const r = lawRig({ seed: 'law-watch2' });
    at(r, 0.5);
    r.run(60);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    expect(lawContext(r.sim).watch.current()!.seenAt).toBe(-1);
    expect(summonedCount(r)).toBe(0);
  });

  it('beyond eighty metres by day is out of sight; so is anyone of another lord\'s land, a child, or a man behind a wall', () => {
    const r = lawRig({ seed: 'law-watch3' });
    at(r, 0.5);
    onlooker(r, LAW.sightDay + 12);
    const other = r.world.settlements.find((s) => s.kind === 'village' && s.id !== r.village.id)!;
    const stranger = onlooker(r, 20, { village: other.id });
    stranger.house = r.strangerHouse;
    r.sim.state.touch(stranger);
    const child = mkPerson(r.sim, { settlement: r.village.id, age: 8, tier: 2 });
    r.zone.addAgent(child.id, r.player.pos.x + 10, r.player.pos.z);
    r.run(30);
    expect(lawContext(r.sim).watch.current()!.seenAt).toBe(-1);
    // a man close by, but behind a wall
    onlooker(r, 25, { dz: 3 });
    (r.zone.nav as { lineClear?: () => boolean }).lineClear = () => false;
    r.run(30);
    expect(lawContext(r.sim).watch.current()!.seenAt).toBe(-1);
    // the wall comes down: he is seen
    (r.zone.nav as { lineClear?: () => boolean }).lineClear = () => true;
    r.run(2);
    expect(lawContext(r.sim).watch.current()!.seenAt).toBeGreaterThanOrEqual(0);
  });

  it('at night he is seen from twenty-six metres, or forty-eight beside a torch', () => {
    const r = lawRig({ seed: 'law-watch4' });
    at(r, 0.02);
    onlooker(r, 40);
    r.run(20);
    expect(lawContext(r.sim).watch.current()!.seenAt).toBe(-1);
    onlooker(r, 20);
    r.run(2);
    expect(lawContext(r.sim).watch.current()!.seenAt).toBeGreaterThanOrEqual(0);
    // and a man with a torch, farther off than the dark allows an ordinary one
    const r2 = lawRig({ seed: 'law-watch4b' });
    at(r2, 0.02);
    onlooker(r2, 40, { torch: true });
    r2.run(2);
    expect(lawContext(r2.sim).watch.current()!.seenAt).toBeGreaterThanOrEqual(0);
    onlooker(r2, 52, { torch: true });
  });

  it('an armed man of the land who sees him acts sooner than a villager would (3 to 8 s)', () => {
    const r = lawRig({ seed: 'law-watch5' });
    at(r, 0.5);
    r.rig(0.5);
    onlooker(r, 30, { armed: true });
    r.run(2);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    r.run(4);
    // 3 + 5 * 0.3 = 4.5 s after being seen
    expect(r.law.patrolFor(r.stranger.id)).not.toBeNull();
  });

  it('a man who walks off the land before the word is carried is not pursued, and one who is not seen and leaves closes the case', () => {
    const r = lawRig({ seed: 'law-watch6' });
    at(r, 0.5);
    r.rig(1);
    onlooker(r, 30);
    r.run(3);
    expect(lawContext(r.sim).watch.current()!.seenAt).toBeGreaterThanOrEqual(0);
    // off the land (the case is kept a few seconds, then dropped)
    const away = offLand(r);
    r.player.pos.x = away.x; r.player.pos.z = away.z;
    r.run(10);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    expect(lawContext(r.sim).watch.current()).toBeNull();
    r.run(30);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
  });

  it('on the map, in a skip of time, or in the cell, the watch does not look', () => {
    const r = lawRig({ seed: 'law-watch7' });
    at(r, 0.5);
    onlooker(r, 30);
    r.sim.view.setSource('mode', () => 'map');
    r.run(30);
    expect(lawContext(r.sim).watch.current()).toBeNull();
    r.sim.view.setSource('mode', () => 'street');
    r.run(1);
    expect(lawContext(r.sim).watch.current()).not.toBeNull();
  });
});

describe('hostile land', () => {
  it('the watch reacts at once to a known enemy: an armed man sees him and the patrol is on its way within three seconds', () => {
    const r = lawRig({ seed: 'law-watch8' });
    at(r, 0.5);
    r.pol.war([r.lordHouse], [r.strangerHouse]);
    r.stranger.career = 'soldier';
    r.rig(0.5);
    expect(r.terr.trespass(r.stranger.id, r.court.x, r.court.z).level).toBe('hostile');
    onlooker(r, 30, { armed: true });
    r.run(1.2);
    expect(r.law.patrolFor(r.stranger.id)).toBeNull();
    r.run(1.4);
    const p = r.law.patrolFor(r.stranger.id)!;
    expect(p).not.toBeNull();
    expect(p.level).toBe('hostile');
  });

  it('a man the lord has wanted since his escape is hunted at sight, wherever he is seen by the lord\'s people', () => {
    const r = lawRig({ seed: 'law-watch9' });
    at(r, 0.5);
    lawContext(r.sim).law.store.makeWanted(r.stranger.id, r.village.id, r.sim.absDay + 8);
    r.rig(0.5);
    onlooker(r, 30);
    r.run(4);
    // a wanted man: no waiting for a report to the manor
    expect(r.law.patrolFor(r.stranger.id)).not.toBeNull();
  });
});

function summonedCount(r: LawRig): number { return r.zone.summoned.size; }
