// Claims by blood and by marriage (SPEC §15), computed from kinship to the holders of titles.
import { describe, expect, it } from 'vitest';
import { transferTitle } from '../../../src/sim/politics/titles';
import { ageYears } from '../../../src/sim/state';
import { bringNear, holderOf, noble, rig, titlesOfKind, wed } from './helpers';

function earls(r: ReturnType<typeof rig>): { a: number; b: number; tb: ReturnType<typeof titlesOfKind>[number] } {
  const king = r.pol.actors().find((h) => r.pol.liegeOf(h) === 0 && r.x.core.titlesOfHouse(h).some((t) => t.kind === 'kingdom'))!;
  const list = titlesOfKind(r.sim, 'county').map((t) => ({ t, h: holderOf(r.sim, t).house })).filter((x) => x.h !== king);
  const first = list[0], second = list.find((x) => x.h !== first.h)!;
  return { a: first.h, b: second.h, tb: second.t };
}

describe('claims', () => {
  it('a House has no claim on strangers', () => {
    const r = rig({ preset: 'small' });
    const { a, tb } = earls(r);
    expect(r.pol.claimsOn(tb.id).some((c) => c.house === a)).toBe(false);
    expect(r.pol.claimsOf(a).length).toBe(r.pol.claimsOf(a).filter((c) => c.house === a).length);
  });

  it('a daughter married out gives her husband’s House a claim on her father’s title (by blood, then by marriage)', () => {
    const r = rig({ preset: 'small' });
    const { a, b, tb } = earls(r);
    const hb = holderOf(r.sim, tb);
    const ha = r.x.core.headOf(a)!;
    const groom = noble(r, a, 'm', 22, { father: ha, tier: 6 });
    const bride = noble(r, b, 'f', 19, { father: hb, tier: 6 });
    expect(r.pol.claimsOn(tb.id).some((c) => c.house === a)).toBe(false);
    wed(r, groom, bride);
    r.x.core.invalidate();
    expect(bride.house).toBe(a);
    const claims = r.pol.claimsOn(tb.id).filter((c) => c.house === a);
    expect(claims.length).toBe(1);
    expect(claims[0].strength).toBe(3);
    expect(claims[0].kind).toBe('blood');
    expect(claims[0].person).toBe(bride.id);
    expect(r.pol.claimsOf(a).some((c) => c.title === tb.id)).toBe(true);
    // the husband alone, with no blood, would hold only a marriage claim: a child of the pair is the strong heir
    const child = noble(r, a, 'm', 1, { father: groom, mother: bride, tier: 5 });
    r.x.core.invalidate();
    expect(ageYears(child, r.sim.absDay)).toBeLessThan(2);
    const second = r.pol.claimsOn(tb.id).filter((c) => c.house === a)[0];
    expect(second.strength).toBeGreaterThanOrEqual(2);
    // the claim is a casus belli: a war on the claim is legal where the same war without it is not
    bringNear(r, a, b);
    r.x.core.lawsFor(r.x.core.kingdomOfHouse(a)).privateWar = true;
    // the wedding made a truce; a House that presses its claim anyway must break it
    expect(r.pol.canDeclare(a, b, 'claim').ok).toBe(false);
    expect(r.pol.canDeclare(a, b, 'claim', true)).toEqual({ ok: true });
    const res = r.pol.declareWar(a, b, { cause: 'claim', breakTruce: true });
    expect(res.ok).toBe(true);
    const war = r.pol.war(res.war!)!;
    expect(war.goal).toBe(tb.id);
    expect(war.claimant).toBe(bride.id);
  });

  it('a sister married out has a weaker claim than a daughter', () => {
    const r = rig({ preset: 'small' });
    const { a, b, tb } = earls(r);
    const hb = holderOf(r.sim, tb);
    // a sister of the holder, sharing his parents
    const father = noble(r, b, 'm', 55, { tier: 7 });
    hb.father = father.id; father.children.push(hb.id);
    const sister = noble(r, b, 'f', 25, { father, tier: 6 });
    const ha = r.x.core.headOf(a)!;
    const husband = noble(r, a, 'm', 27, { father: ha, tier: 6 });
    wed(r, husband, sister);
    r.x.core.invalidate();
    const c = r.pol.claimsOn(tb.id).find((x) => x.house === a)!;
    expect(c).toBeTruthy();
    expect(c.strength).toBe(2);
  });

  it('the House that lost a title keeps a claim on it for years', () => {
    const r = rig({ preset: 'small' });
    const { a, b, tb } = earls(r);
    const winner = r.x.core.headOf(a)!;
    r.x.wars.makeVassal(b, a); // irrelevant to the claim; just a realistic setting
    const loserHouse = holderOf(r.sim, tb).house;
    // the title changes hands by conquest
    transferTitle(r.x.core, tb, winner, 'test conquest');
    r.x.core.invalidate();
    const claim = r.pol.claimsOn(tb.id).find((c) => c.house === loserHouse);
    expect(claim).toBeTruthy();
    expect(claim!.kind).toBe('deposed');
    expect(claim!.strength).toBe(3);
    // and it fades
    r.sim.advanceDays(16 * 6);
    r.x.core.invalidate();
    expect(r.pol.claimsOn(tb.id).some((c) => c.house === loserHouse)).toBe(false);
  });
});

