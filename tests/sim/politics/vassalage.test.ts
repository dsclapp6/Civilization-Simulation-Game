// Oaths and liege chains (SPEC §15): the feudal tree comes from titles; heirs swear fealty; strength
// counts vassals; a House can be made a vassal by treaty and freed by war.
import { describe, expect, it } from 'vitest';
import { killPerson } from '../../../src/sim/succession';
import { bringNear, holderOf, housesHolding, rig, titlesOfKind } from './helpers';

describe('vassalage', () => {
  it('derives the feudal chain from the titles: knights under earls under the crown', () => {
    const r = rig({ preset: 'small' });
    const kings = housesHolding(r.sim, 'kingdom');
    expect(kings.length).toBe(2);
    const earls = titlesOfKind(r.sim, 'county').map((t) => holderOf(r.sim, t).house).filter((h) => !kings.includes(h));
    expect(earls.length).toBeGreaterThan(0);
    for (const e of earls) {
      const k = r.pol.liegeOf(e);
      expect(kings).toContain(k);
      expect(r.pol.realmLeader(e)).toBe(k);
      expect(r.pol.stance(e, k)).toBe('vassal');
      expect(r.pol.stance(k, e)).toBe('liege');
    }
    for (const k of kings) {
      expect(r.pol.liegeOf(k)).toBe(0);
      expect(r.pol.realmLeader(k)).toBe(k);
    }
    // every House that holds land belongs to exactly one realm
    for (const h of r.pol.actors()) expect(kings).toContain(r.pol.realmLeader(h));
  });

  it('counts vassals in a House’s strength (SPEC §16: strength incl. vassals)', () => {
    const r = rig({ preset: 'small' });
    const k = housesHolding(r.sim, 'kingdom')[0];
    const own = r.x.core.ownStrength(k);
    expect(r.pol.strength(k)).toBeGreaterThan(own);
    for (const v of r.pol.vassalsOf(k)) expect(r.pol.strength(k)).toBeGreaterThan(r.pol.strength(v));
    expect(r.pol.strength(k)).toBeGreaterThan(20);
  });

  it('an heir swears fealty to his father’s liege when a vassal dies', () => {
    const r = rig({ preset: 'small' });
    const king = housesHolding(r.sim, 'kingdom')[0];
    const county = titlesOfKind(r.sim, 'county').find((t) => holderOf(r.sim, t).house !== king && r.pol.liegeOf(holderOf(r.sim, t).house) === king);
    expect(county).toBeTruthy();
    const old = holderOf(r.sim, county!);
    const day = Math.floor(r.sim.absDay);
    killPerson(r.sim, old, 'illness', r.sim.absDay);
    const heir = holderOf(r.sim, county!);
    expect(heir.id).not.toBe(old.id);
    const sworn = r.x.core.save.oaths[String(county!.id)];
    // the heir swears unless he hates his liege; with no history of hatred he does
    expect(sworn).toBeGreaterThanOrEqual(day);
    expect(r.pol.liegeOf(heir.house)).toBe(king);
  });

  it('forced homage makes a House the vassal of its conqueror, and war can free it again', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = housesHolding(r.sim, 'kingdom');
    expect(r.x.wars.makeVassal(b, a)).toBe(true);
    expect(r.pol.liegeOf(b)).toBe(a);
    expect(r.pol.realmLeader(b)).toBe(a);
    expect(r.pol.stance(b, a)).toBe('vassal');
    // his vassals now belong to the greater realm
    for (const v of r.pol.vassalsOf(b)) expect(r.pol.realmLeader(v)).toBe(a);
    // a vassal cannot make an ordinary war on his liege …
    expect(r.pol.canDeclare(b, a, 'conquest').ok).toBe(false);
    // … only rise against him
    bringNear(r, a, b);
    const w = r.pol.declareWar(b, a, { cause: 'independence' });
    expect(w.ok).toBe(true);
    const war = r.pol.war(w.war!)!;
    war.score = 100;
    r.sim.advanceDays(1);
    expect(r.pol.liegeOf(b)).toBe(0);
    expect(r.x.core.save.stats.independence).toBe(1);
    expect(r.pol.wars().length).toBe(0);
  });

  it('a liege can only be a liege to what is held from him', () => {
    const r = rig({ preset: 'small' });
    const [a, b] = housesHolding(r.sim, 'kingdom');
    expect(r.pol.liegeOf(a)).toBe(0);
    expect(r.pol.liegeOf(b)).toBe(0);
    expect(r.pol.stance(a, b)).toBe('neutral');
    // a feudal loop is impossible: homage to one's own vassal is refused
    r.x.wars.makeVassal(b, a);
    expect(r.x.wars.makeVassal(a, b)).toBe(false);
  });

  it('vassals pay yearly aid to their liege, scaled by the realm’s tax law', () => {
    const r = rig({ preset: 'small' });
    const king = housesHolding(r.sim, 'kingdom')[0];
    const vassal = r.pol.vassalsOf(king)[0];
    const purse = (h: number): number => r.x.core.purseOf(h);
    const before = [purse(king), purse(vassal)];
    r.x.core.lawsFor(r.x.core.kingdomOfHouse(king)).tax = 3;
    r.x.realms.yearly();
    expect(purse(vassal)).toBeLessThan(before[1]);
    expect(purse(king)).toBeGreaterThan(before[0]);
    r.x.core.lawsFor(r.x.core.kingdomOfHouse(king)).tax = 0;
    const p2 = [purse(king), purse(vassal)];
    r.x.realms.yearly();
    expect(purse(vassal)).toBe(p2[1]);
  });
});
