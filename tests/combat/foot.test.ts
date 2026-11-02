// The sword and the bow on foot (docs/WAR.md §5). War in the zone gave every man orders, slots and a morale of his own; none of it may
// change how a single cut or a single arrow feels. These tests measure the swing and the shot as a man in a fight lives them and tie
// the numbers to the weapon tables, with bands wide enough to be about feel and not about the exact frame.
import { describe, expect, it } from 'vitest';
import { S } from '../../src/combat/fighter';
import { RANGED, WEAPONS } from '../../src/combat/weapons';
import { SIM_DT } from '../../src/core/time';
import { adultMen, combatRig, setStats } from './helpers';

/** A dummy: stands where it is put and never thinks. */
function freeze(f: { think: number; wantSpeed: number; aggression: number; cooldown: number; morale: number; moraleBase: number }): void {
  f.think = 1e9; f.wantSpeed = 0; f.aggression = 0.01; f.cooldown = 999; f.morale = f.moraleBase = 500;
}

/** One man with `kit`, one standing dummy `gap` metres away, a fight between them. */
function duel(seed: string, kit: { weapon: string; ranged?: string | null }, gap: number) {
  const r = combatRig({ seed, preset: 'small' });
  const [a, b] = adultMen(r.sim, 2, 20, 35);
  setStats(a, { str: 12, agi: 11, end: 12, per: 12 });
  a.needs.hunger = 1; a.needs.rest = 1; b.needs.hunger = 1; b.needs.rest = 1;
  r.combat.arena.setKitOverride(a.id, { weapon: kit.weapon, ranged: kit.ranged ?? null, armour: [] });
  r.combat.arena.setKitOverride(b.id, { weapon: 'dagger', armour: [] });
  r.combat.engage([{ faction: 'house:1', people: [a.id] }, { faction: 'house:2', people: [b.id] }], { at: { x: 800, z: 800 }, reason: 'fight', yieldAllowed: false });
  const fa = r.combat.arena.fighterOf(a.id)!;
  const fb = r.combat.arena.fighterOf(b.id)!;
  fa.x = 800; fa.z = 800; fa.yaw = fa.wantYaw = 0;
  fb.x = 800; fb.z = 800 + gap; fb.yaw = fb.wantYaw = Math.PI;
  freeze(fb);
  fb.hp = 1e6; fb.maxHp = 1e6;
  return { r, fa, fb };
}

describe('the sword on foot', () => {
  it('data: a spear reaches further than a sword, a lance further than a spear; a cut is windup plus recovery from the table', () => {
    expect(WEAPONS.spear.reach).toBeGreaterThan(WEAPONS.sword.reach);
    expect(WEAPONS.lance.reach).toBeGreaterThan(WEAPONS.spear.reach);
    const cut = WEAPONS.sword.attacks.slash;
    expect(cut.windup + cut.recover).toBeGreaterThan(0.6);
    expect(cut.windup + cut.recover).toBeLessThan(1.0);
  });

  it('a swordsman at a man swings again and again: each cut winds up for about the table\'s windup and the cuts come about a second apart', () => {
    const { r, fa, fb } = duel('foot-sword', { weapon: 'sword' }, 1.4);
    const starts: number[] = [];
    const windups: number[] = [];
    let prev: number = S.Idle, since = 0;
    for (let i = 0; i < 20 * 14; i++) {
      r.sim.step(SIM_DT);
      fb.x = 800; fb.z = 801.4; // the dummy stays at arm's length
      const t = i * SIM_DT;
      if (fa.st === S.Windup && prev !== S.Windup) { starts.push(t); since = t; }
      if (fa.st !== S.Windup && prev === S.Windup) windups.push(t - since);
      prev = fa.st;
    }
    expect(starts.length).toBeGreaterThanOrEqual(5);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]).sort((x, y) => x - y);
    const median = gaps[Math.floor(gaps.length / 2)];
    expect(median).toBeGreaterThan(0.7);
    expect(median).toBeLessThan(2.2);
    const wMedian = [...windups].sort((x, y) => x - y)[Math.floor(windups.length / 2)];
    expect(wMedian).toBeGreaterThan(0.3);
    expect(wMedian).toBeLessThan(0.75);
    // and the cuts land: the dummy has been struck
    expect(fa.hitsLanded).toBeGreaterThan(0);
  });

  it('a spearman keeps a swordsman at the point: his thrust starts at a range the sword cannot answer', () => {
    const r = combatRig({ seed: 'foot-reach', preset: 'small' });
    const [a, b] = adultMen(r.sim, 2, 20, 35);
    for (const p of [a, b]) { setStats(p, { str: 12, agi: 11, end: 12 }); p.needs.hunger = 1; p.needs.rest = 1; }
    r.combat.arena.setKitOverride(a.id, { weapon: 'spear', armour: [] });
    r.combat.arena.setKitOverride(b.id, { weapon: 'sword', armour: [] });
    r.combat.engage([{ faction: 'house:1', people: [a.id] }, { faction: 'house:2', people: [b.id] }], { at: { x: 800, z: 800 }, reason: 'fight', yieldAllowed: false });
    const fa = r.combat.arena.fighterOf(a.id)!, fb = r.combat.arena.fighterOf(b.id)!;
    fa.x = 800; fa.z = 790; fb.x = 800; fb.z = 810;
    let spearFirst = -1, swordFirst = -1;
    for (let i = 0; i < 20 * 10 && (spearFirst < 0 || swordFirst < 0); i++) {
      r.sim.step(SIM_DT);
      const d = Math.hypot(fa.x - fb.x, fa.z - fb.z);
      if (spearFirst < 0 && fa.st === S.Windup) spearFirst = d;
      if (swordFirst < 0 && fb.st === S.Windup) swordFirst = d;
    }
    expect(spearFirst).toBeGreaterThan(0);
    expect(swordFirst).toBeGreaterThan(0);
    expect(spearFirst).toBeGreaterThan(swordFirst - 0.05);
  });
});

describe('the bow on foot', () => {
  it('data: the longbow draws in about a second, reaches 90 m and flies at 55 m/s', () => {
    const lb = RANGED.longbow;
    expect(lb.drawTime).toBeGreaterThan(0.8);
    expect(lb.drawTime).toBeLessThan(1.6);
    expect(lb.range).toBeGreaterThanOrEqual(80);
    expect(lb.speed).toBeGreaterThan(45);
  });

  it('an archer draws, aims and looses: the string is ready in a second or two, the arrow is down within a second and a half at 30 m, and in time a man standing there is hit', () => {
    const { r, fa, fb } = duel('foot-bow', { weapon: 'dagger', ranged: 'longbow' }, 30);
    const proj = r.combat.arena.env.proj;
    let drawAt = -1, loosedAt = -1, landedAt = -1;
    for (let i = 0; i < 20 * 14; i++) {
      r.sim.step(SIM_DT);
      fa.x = 800; fa.z = 800; fb.x = 800; fb.z = 830;
      const t = i * SIM_DT;
      if (drawAt < 0 && fa.st === S.Draw) drawAt = t;
      if (loosedAt < 0 && proj.flying.length > 0) loosedAt = t;
      if (loosedAt >= 0 && landedAt < 0 && proj.flying.length === 0) landedAt = t;
    }
    expect(drawAt).toBeGreaterThanOrEqual(0);
    expect(loosedAt).toBeGreaterThan(drawAt);
    const ready = loosedAt - drawAt;
    expect(ready).toBeGreaterThan(RANGED.longbow.drawTime * 0.8);
    expect(ready).toBeLessThan(RANGED.longbow.drawTime + RANGED.longbow.aimTime + 2.5);
    expect(landedAt - loosedAt).toBeGreaterThan(0.25);
    expect(landedAt - loosedAt).toBeLessThan(1.6);
    expect(fb.hitsTaken).toBeGreaterThan(0);
  });

  it('beyond its range an archer does not loose: he closes first', () => {
    const { r, fa, fb } = duel('foot-bow-range', { weapon: 'dagger', ranged: 'shortbow' }, 100);
    const proj = r.combat.arena.env.proj;
    let early = false;
    for (let i = 0; i < 20 * 4; i++) {
      r.sim.step(SIM_DT);
      fb.x = 800; fb.z = 900;
      if (Math.hypot(fa.x - fb.x, fa.z - fb.z) > RANGED.shortbow.range + 5 && proj.flying.length > 0) early = true;
    }
    expect(early).toBe(false);
  });
});
