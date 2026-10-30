import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { ARMOUR } from '../../src/combat/weapons';
import { absorb, rollLocation, shapeWound, type ArmourPiece } from '../../src/combat/wounds';
import { adultMen, combatRig, stepFor } from './helpers';
import type { HitLocation } from '../../src/sim/wave3';

const pieces = (...ids: string[]): ArmourPiece[] => ids.map((id) => ({ def: ARMOUR[id], quality: 1 as const }));

/** Many blows of one kind against one set of armour, returning what the flesh felt. */
function volley(n: number, kind: 'cut' | 'pierce' | 'blunt' | 'arrow', raw: number, ap: number, armour: ArmourPiece[], how: 'slash' | 'arrow' | 'overhead' | 'thrust' = 'slash') {
  const rng = new Rng(`volley:${kind}:${raw}`);
  let through = 0, mortal = 0, wounds = 0, bleeding = 0, dmg = 0;
  for (let i = 0; i < n; i++) {
    const loc = rollLocation(rng, { how });
    const ab = absorb(rng, armour, loc, kind, raw, ap);
    const s = shapeWound(rng, loc, kind, ab.through, 80);
    if (s.damage > 1) through++;
    dmg += s.damage;
    if (s.mortal) mortal++;
    if (s.severity > 0.04) wounds++;
    if (s.bleeding) bleeding++;
  }
  return { mean: dmg / n, through: through / n, mortal: mortal / n, wounds: wounds / n, bleeding: bleeding / n };
}

describe('wound rolls against armour', () => {
  it('one arrow can kill an unarmoured man outright', () => {
    const v = volley(4000, 'arrow', 32, 0.4, [], 'arrow');
    expect(v.mortal).toBeGreaterThan(0.04);
    expect(v.mortal).toBeLessThan(0.4);
    expect(v.wounds).toBeGreaterThan(0.95);
  });

  it('plate stops most sword cuts; mail and padding turn some; cloth turns none', () => {
    const plate = volley(4000, 'cut', 24, 0.15, pieces('plate_harness', 'bascinet'));
    const mail = volley(4000, 'cut', 24, 0.15, pieces('mail_hauberk', 'kettle_hat'));
    const padded = volley(4000, 'cut', 24, 0.15, pieces('padded_armour', 'cap_helmet'));
    const bare = volley(4000, 'cut', 24, 0.15, []);
    expect(plate.through).toBeLessThan(0.3);
    expect(plate.mean).toBeLessThan(mail.mean * 0.4);
    expect(mail.mean).toBeLessThan(padded.mean);
    expect(padded.mean).toBeLessThan(bare.mean);
    expect(bare.through).toBeGreaterThan(0.95);
    expect(plate.bleeding).toBeLessThan(0.15);
  });

  it('a mace still hurts a man in plate, an arrow less so than an unarmoured one', () => {
    const maceVsPlate = volley(3000, 'blunt', 22, 0.45, pieces('plate_harness', 'bascinet'), 'overhead');
    const swordVsPlate = volley(3000, 'cut', 24, 0.15, pieces('plate_harness', 'bascinet'));
    expect(maceVsPlate.mean).toBeGreaterThan(swordVsPlate.mean * 2);
    const arrowPlate = volley(3000, 'arrow', 32, 0.4, pieces('plate_harness', 'bascinet'), 'arrow');
    const arrowBare = volley(3000, 'arrow', 32, 0.4, [], 'arrow');
    expect(arrowPlate.mortal).toBeLessThan(arrowBare.mortal);
  });

  it('a blow to the head is worse than one to the leg', () => {
    const rng = new Rng('loc');
    const head = shapeWound(rng, 'head', 'cut', 24, 80);
    const leg = shapeWound(rng, 'leg_l', 'cut', 24, 80);
    expect(head.damage).toBeGreaterThan(leg.damage * 2);
    const counts: Record<HitLocation, number> = { head: 0, torso: 0, arm_l: 0, arm_r: 0, leg_l: 0, leg_r: 0 };
    for (let i = 0; i < 4000; i++) counts[rollLocation(rng, { how: 'thrust' })]++;
    expect(counts.torso).toBeGreaterThan(counts.head * 3);
    // a man on the ground is hit in the head more often; a shield turns the torso into limbs
    const prone: Record<HitLocation, number> = { head: 0, torso: 0, arm_l: 0, arm_r: 0, leg_l: 0, leg_r: 0 };
    for (let i = 0; i < 4000; i++) prone[rollLocation(rng, { how: 'slash', prone: true })]++;
    expect(prone.head).toBeGreaterThan(counts.head);
  });
});

describe('the wound book', () => {
  it('a bleeding wound drains blood; binding it saves the man', () => {
    const { combat, sim } = combatRig();
    const [a, b] = adultMen(sim, 2);
    const wound = (p: typeof a) => combat.book.inflict(p, { location: 'torso', kind: 'cut', damage: 30, severity: 0.45, bleeding: true, rate: 0.0045, fracture: false, mortal: false, stun: 0 }, 'sword');
    wound(a); wound(b);
    expect(combat.wounds(a.id)).toHaveLength(1);
    expect(a.health.hp).toBeLessThan(0.7);
    expect(a.health.conditions.some((c) => c.id === 'injury')).toBe(true);
    combat.book.tend(b, 5, sim.rng('combat'));
    combat.book.advance(a, 240);
    combat.book.advance(b, 240);
    expect(combat.blood!(a.id)).toBeLessThan(0.7);
    expect(combat.blood!(b.id)).toBeGreaterThan(0.9);
    expect(combat.blood!(b.id)).toBeGreaterThan(combat.blood!(a.id) + 0.2);
  });

  it('too much blood lost is death, by violence', () => {
    const { combat, sim } = combatRig();
    const [a] = adultMen(sim, 1);
    for (let i = 0; i < 3; i++) {
      combat.book.inflict(a, { location: i === 0 ? 'leg_l' : 'torso', kind: 'cut', damage: 14, severity: 0.2, bleeding: true, rate: 0.02, fracture: false, mortal: false, stun: 0 }, 'axe');
    }
    expect(a.death).toBeNull();
    let t = 0;
    while (!a.death && t < 600) { combat.book.advance(a, 5); t += 5; }
    expect(a.death).not.toBeNull();
    expect(a.death!.cause).toBe('violence');
    expect(combat.wounds(a.id)).toHaveLength(0);
  });

  it('a mortal blow kills within moments', () => {
    const { combat, sim } = combatRig();
    const [a] = adultMen(sim, 1);
    const out = combat.book.inflict(a, { location: 'torso', kind: 'arrow', damage: 24, severity: 0.33, bleeding: true, rate: 0.003, fracture: false, mortal: true, stun: 0 }, 'longbow');
    expect(out.mortal).toBe(true);
    expect(combat.book.down(a.id)).toBe(true);
    let t = 0;
    while (!a.death && t < 60) { combat.book.advance(a, 1); t++; }
    expect(a.death).not.toBeNull();
    expect(t).toBeLessThan(40);
  });

  it('wounds mend over days with rest and food, faster with care, and leave marks when deep', () => {
    const { combat, sim } = combatRig();
    const [a, b] = adultMen(sim, 2);
    for (const p of [a, b]) {
      p.needs.hunger = 1; p.needs.rest = 1; p.needs.warmth = 1;
      combat.book.inflict(p, { location: 'leg_r', kind: 'cut', damage: 34, severity: 0.55, bleeding: false, rate: 0, fracture: false, mortal: false, stun: 0 }, 'sword');
    }
    combat.book.tend(b, 6, sim.rng('combat'));
    let dayA = 0, dayB = 0;
    for (let d = 1; d <= 40; d++) {
      combat.book.day(sim.absDay + d);
      if (!dayA && combat.wounds(a.id).length === 0) dayA = d;
      if (!dayB && combat.wounds(b.id).length === 0) dayB = d;
      a.needs.hunger = b.needs.hunger = 1; a.needs.rest = b.needs.rest = 1;
    }
    expect(dayB).toBeGreaterThan(0);
    expect(dayB).toBeLessThanOrEqual(dayA || 99);
    expect(a.health.conditions.some((c) => c.id === 'injury')).toBe(false);
    expect(a.health.hp).toBeGreaterThan(0.85);
  });

  it('a badly hurt leg can leave a man lame, and a broken arm hits weakly while it mends', () => {
    const { combat, sim } = combatRig();
    const men = adultMen(sim, 12);
    for (const p of men) {
      p.needs.hunger = 1; p.needs.rest = 1;
      combat.book.inflict(p, { location: 'leg_l', kind: 'blunt', damage: 40, severity: 0.7, bleeding: false, rate: 0, fracture: true, mortal: false, stun: 0 }, 'mace');
    }
    expect(combat.book.limbPenalty(men[0].id, 'legs')).toBeGreaterThan(0.5);
    for (let d = 1; d <= 60; d++) combat.book.day(sim.absDay + d);
    expect(men.every((p) => combat.wounds(p.id).length === 0)).toBe(true);
    expect(men.some((p) => p.traits.includes('lame'))).toBe(true);
    expect(men.every((p) => p.death === null)).toBe(true);
  });

  it('untended pierce wounds can fester into fever', () => {
    const { combat, sim } = combatRig();
    const men = adultMen(sim, 14);
    for (const p of men) {
      p.needs.hunger = 0.5;
      combat.book.inflict(p, { location: 'torso', kind: 'pierce', damage: 24, severity: 0.4, bleeding: false, rate: 0, fracture: false, mortal: false, stun: 0 }, 'spear');
    }
    let infected = 0;
    for (let d = 1; d <= 4; d++) {
      combat.book.day(sim.absDay + d);
      infected = men.filter((p) => combat.wounds(p.id).some((w) => w.infected)).length;
      if (infected) break;
    }
    expect(infected).toBeGreaterThan(0);
    expect(men.some((p) => p.health.conditions.some((c) => c.id === 'fever'))).toBe(true);
  });
});

describe('harm off screen', () => {
  it('a scuffle mostly leaves men unhurt, a battle wounds and kills, armour helps', () => {
    const { combat, sim } = combatRig();
    const men = adultMen(sim, 30);
    const tally = { dead: 0, wounded: 0, unhurt: 0, down: 0, yielded: 0, captured: 0 };
    for (const p of men.slice(0, 10)) tally[combat.harm(p.id, 0.02, 'accident')]++;
    expect(tally.unhurt).toBeGreaterThanOrEqual(5);
    expect(tally.dead).toBe(0);
    const big = { dead: 0, wounded: 0, unhurt: 0, down: 0, yielded: 0, captured: 0 };
    for (const p of men.slice(10)) big[combat.harm(p.id, 1, 'battle')]++;
    expect(big.dead + big.down + big.wounded + big.yielded).toBeGreaterThan(14);
    expect(big.dead).toBeGreaterThan(0);
    expect(men.slice(10).some((p) => p.death?.cause === 'battle')).toBe(true);
  });

  it('wounded people keep bleeding on the hour tick', () => {
    const { combat, sim } = combatRig();
    const [a] = adultMen(sim, 1);
    combat.book.inflict(a, { location: 'torso', kind: 'cut', damage: 30, severity: 0.45, bleeding: true, rate: 0.0045, fracture: false, mortal: false, stun: 0 }, 'sword');
    const before = combat.blood!(a.id);
    sim.advanceHours(6);
    expect(combat.blood!(a.id)).toBeLessThan(before);
    stepFor(sim, 0.1);
  });
});
