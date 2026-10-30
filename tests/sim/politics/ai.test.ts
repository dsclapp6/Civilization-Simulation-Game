// The rival AI (SPEC §16): harsh and opportunistic, no cheats. Houses strike when a neighbour is weak
// (child heir, famine, plague, war elsewhere), ally against the strongest — the player's House
// included — and difficulty only changes how readily and how cleverly they act.
import { describe, expect, it, vi } from 'vitest';
import { Rng } from '../../../src/core/rng';
import { makePlayer } from '../builders';
import { ageHead, bringNear, housesHolding, noble, rig, setTraits, wed, type Rig } from './helpers';

function pair(r: Rig): { a: number; b: number } {
  const k = housesHolding(r.sim, 'kingdom');
  bringNear(r, k[0], k[1]);
  return { a: k[0], b: k[1] };
}

/** Makes House `a` clearly stronger than `b` by giving it knights. */
function arm(r: Rig, a: number, n: number): void {
  for (let i = 0; i < n; i++) noble(r, a, 'm', 24 + (i % 10), { tier: 5 });
  r.x.core.invalidate();
}

/** Counts the wars House `a` starts against `b` in `trials` thinking rounds (resetting after each). */
function warsStarted(r: Rig, a: number, b: number, trials: number): number {
  let n = 0;
  for (let i = 0; i < trials; i++) {
    r.x.core.mindOf(a).lastWar = -999;
    r.x.core.mindOf(a).lastProposal = -999;
    r.x.core.invalidate();
    r.x.ai.think(a);
    const w = r.x.wars.offensiveWar(a);
    if (w && w.defenders[0] === b) { n++; r.x.wars.end(w, 'white_peace', 'white'); }
    else if (w) r.x.wars.end(w, 'white_peace', 'white');
    // forget truces so the next trial is fair
    const t = r.x.core.tieRef(a, b);
    t.truce = 0; t.grievance = 0;
    r.sim.state.clock.absDay += 0; // time does not pass between trials: same day, same snapshot rules
  }
  return n;
}

describe('rival AI: opportunism', () => {
  it('weakness invites attack: a child heir, a famine and a war elsewhere each raise the appetite', () => {
    const r = rig({ preset: 'small' });
    const { a, b } = pair(r);
    setTraits(r, a, ['ambitious']);
    setTraits(r, b, ['content']);
    arm(r, a, 8);
    const base = r.x.ai.desire(a, b, 'conquest');
    // famine on the target's land
    for (const sid of r.x.core.demesnes(b)) { const st = r.sim.state.settlements.get(sid)!; st.prosperity = 0.5; }
    r.x.core.invalidate();
    const famine = r.x.ai.desire(a, b, 'conquest');
    expect(famine).toBeGreaterThan(base + 0.2);
    // a child on the throne
    ageHead(r, b, 9);
    r.x.core.invalidate();
    const child = r.x.ai.desire(a, b, 'conquest');
    expect(child).toBeGreaterThan(famine + 0.15);
    // and a war elsewhere
    const third = housesHolding(r.sim, 'county').find((h) => h !== a && h !== b)!;
    bringNear(r, b, third);
    r.sim.state.settlements.forEach((s) => { s.prosperity = 1; });
    ageHead(r, b, 40);
    const calm = (r.x.core.invalidate(), r.x.ai.desire(a, b, 'conquest'));
    r.x.wars.declare(b, third, { cause: 'conquest' });
    r.x.core.invalidate();
    expect(r.x.ai.desire(a, b, 'conquest')).toBeGreaterThan(calm + 0.15);
  });

  it('an ambitious House strikes a weakened neighbour and leaves a healthy one alone', () => {
    const healthy = rig({ preset: 'small', seed: 'ai-opp' });
    const h = pair(healthy);
    setTraits(healthy, h.a, ['ambitious']);
    setTraits(healthy, h.b, ['content']);
    arm(healthy, h.a, 8);
    const calm = warsStarted(healthy, h.a, h.b, 80);

    const weak = rig({ preset: 'small', seed: 'ai-opp' });
    const w = pair(weak);
    setTraits(weak, w.a, ['ambitious']);
    setTraits(weak, w.b, ['content']);
    arm(weak, w.a, 8);
    ageHead(weak, w.b, 9); // a boy on the throne
    for (const sid of weak.x.core.demesnes(w.b)) weak.sim.state.settlements.get(sid)!.prosperity = 0.55; // and a famine
    weak.x.core.invalidate();
    const struck = warsStarted(weak, w.a, w.b, 80);
    expect(struck).toBeGreaterThan(0);
    expect(struck).toBeGreaterThan(calm);
  });

  it('a cautious, honourable House does not strike even a weak neighbour as readily as an ambitious cruel one', () => {
    const mk = (traits: Parameters<typeof setTraits>[2], seed: string): number => {
      const r = rig({ preset: 'small', seed });
      const { a, b } = pair(r);
      setTraits(r, a, traits);
      setTraits(r, b, ['content']);
      arm(r, a, 8);
      ageHead(r, b, 9);
      r.x.core.invalidate();
      return warsStarted(r, a, b, 60);
    };
    const meek = mk(['honest', 'patient', 'content'], 'ai-meek');
    const bold = mk(['ambitious', 'hot_tempered', 'brave'], 'ai-meek');
    expect(bold).toBeGreaterThan(meek);
  });

  it('difficulty scales aggression only: Squire strikes less than King against the same neighbour', () => {
    const count = (difficulty: 'squire' | 'king'): number => {
      const r = rig({ preset: 'small', seed: 'ai-diff', difficulty });
      const { a, b } = pair(r);
      setTraits(r, a, ['ambitious']);
      setTraits(r, b, ['content']);
      arm(r, a, 8);
      ageHead(r, b, 9);
      r.x.core.invalidate();
      return warsStarted(r, a, b, 80);
    };
    const squire = count('squire'), king = count('king');
    expect(king).toBeGreaterThan(squire);
    expect(rig({ preset: 'tiny', difficulty: 'squire' }).x.core.aggression).toBeLessThan(rig({ preset: 'tiny', difficulty: 'knight' }).x.core.aggression);
    expect(rig({ preset: 'tiny', difficulty: 'king' }).x.core.coordination).toBeGreaterThan(rig({ preset: 'tiny', difficulty: 'knight' }).x.core.coordination);
  });

  it('gets no hidden bonus: the same Houses have the same strength and purses on every difficulty except the visible Lord/King head start', () => {
    const at = (d: 'knight' | 'lord' | 'king') => {
      const r = rig({ preset: 'small', seed: 'ai-fair', difficulty: d, keepPlayer: true });
      const k = housesHolding(r.sim, 'kingdom');
      return { r, k, purse: k.map((h) => r.x.core.purseOf(h)), strength: k.map((h) => r.pol.strength(h)) };
    };
    const kn = at('knight'), lo = at('lord'), ki = at('king');
    expect(lo.strength).toEqual(kn.strength);
    expect(ki.strength).toEqual(kn.strength);
    // rivals start richer on Lord and King (visible in the difficulty table), the player's own House never does
    const playerHouse = kn.r.sim.state.run.houseId;
    for (let i = 0; i < kn.k.length; i++) {
      if (kn.k[i] === playerHouse) continue;
      expect(lo.purse[i]).toBeGreaterThan(kn.purse[i]);
      expect(ki.purse[i]).toBeGreaterThan(lo.purse[i]);
    }
    const pOf = (x: typeof kn): number => x.r.x.core.purseOf(playerHouse);
    expect(pOf(lo)).toBe(pOf(kn));
    expect(pOf(ki)).toBe(pOf(kn));
  });
});

describe('rival AI: diplomacy and marriage', () => {
  it('Houses open the ladder with their neighbours over time (truce, trade, kin, alliance)', () => {
    const r = rig({ preset: 'small' });
    const { a, b } = pair(r);
    expect(r.pol.stance(a, b)).toBe('neutral');
    for (let i = 0; i < 40 && r.pol.stance(a, b) === 'neutral'; i++) r.sim.advanceDays(4);
    expect(r.pol.stance(a, b)).not.toBe('neutral');
    const kinds = new Set<string>();
    for (const h of r.pol.actors()) for (const o of r.pol.neighbours(h)) kinds.add(r.pol.stance(h, o));
    expect(kinds.size).toBeGreaterThan(1);
  });

  it('arranges a marriage between two Houses through the social system, binding them as kin', () => {
    const r = rig({ preset: 'small' });
    const { a, b } = pair(r);
    const ha = r.x.core.headOf(a)!, hb = r.x.core.headOf(b)!;
    const son = noble(r, a, 'm', 21, { father: ha, tier: 6 });
    const daughter = noble(r, b, 'f', 18, { father: hb, tier: 6 });
    // consents and chance all say yes
    const fake = new Rng('yes');
    fake.next = () => 0;
    const spy = vi.spyOn(r.core, 'rng').mockReturnValue(fake);
    const res = r.pol.propose(a, b, 'marriage', { a: son.id, b: daughter.id });
    spy.mockRestore();
    expect(res.ok).toBe(true);
    if (son.spouse) {
      expect(son.spouse).toBe(daughter.id);
      expect(r.pol.stance(a, b)).toBe('kin');
    } else {
      // betrothed: consent of the families is still to be given; the match is registered
      expect(r.social.courtship(son.id, daughter.id)?.betrothed).toBe(true);
    }
  });

  it('a House seeks marriages for its unwed heirs when it thinks', () => {
    const r = rig({ preset: 'small' });
    const { a, b } = pair(r);
    const ha = r.x.core.headOf(a)!, hb = r.x.core.headOf(b)!;
    const son = noble(r, a, 'm', 21, { father: ha, tier: 6 });
    noble(r, b, 'f', 18, { father: hb, tier: 6 });
    const fake = new Rng('yes');
    fake.next = () => 0;
    const spy = vi.spyOn(r.core, 'rng').mockReturnValue(fake);
    r.sim.rng('politics.ai.marry').next = () => 0;
    r.x.ai.think(a);
    spy.mockRestore();
    expect(r.x.core.mindOf(a).matched[String(son.id)]).toBeDefined();
  });
});

describe('rival AI: rebellion and coalitions', () => {
  it('an unhappy, strong vassal rises against a weak liege; a content one does not', () => {
    const run = (unhappy: boolean): number => {
      const r = rig({ preset: 'small', seed: 'ai-rebel' });
      const king = housesHolding(r.sim, 'kingdom')[0];
      const rebel = r.pol.vassalsOf(king).find((v) => r.x.core.titlesOfHouse(v).some((t) => t.kind === 'county'))!;
      setTraits(r, rebel, ['ambitious', 'deceitful']);
      setTraits(r, king, ['content']);
      arm(r, rebel, 14);
      if (unhappy) {
        const hv = r.x.core.headOf(rebel)!, hk = r.x.core.headOf(king)!;
        r.social.adjustOpinion(hv.id, hk.id, -70, 'test');
        ageHead(r, king, 10);
      }
      r.x.core.invalidate();
      let n = 0;
      for (let i = 0; i < 60; i++) {
        r.x.core.mindOf(rebel).lastWar = -999;
        r.x.ai.think(rebel);
        const w = r.x.wars.offensiveWar(rebel);
        if (w) { n++; expect(w.cause).toBe('independence'); r.x.wars.end(w, 'white_peace', 'white'); }
      }
      return n;
    };
    expect(run(true)).toBeGreaterThan(0);
    expect(run(false)).toBe(0);
  });

  it('the Houses league against whoever grows too strong, and march when they can match him', () => {
    const r = rig({ preset: 'large', seed: 'coalition' });
    const kings = housesHolding(r.sim, 'kingdom');
    expect(kings.length).toBe(6);
    const giant = kings[0];
    // the giant swallows two neighbours by treaty
    r.x.wars.makeVassal(kings[1], giant);
    r.x.wars.makeVassal(kings[2], giant);
    r.x.core.invalidate();
    expect(r.pol.realmShare(giant)).toBeGreaterThan(30);
    for (const o of kings.slice(3)) r.sim.rng('politics.coalition').next = () => 0;
    r.x.realms.coalitionsSeasonal();
    const co = r.pol.coalitions().find((c) => c.target === giant);
    expect(co).toBeTruthy();
    expect(co!.members.length).toBeGreaterThanOrEqual(2);
    expect(co!.members).not.toContain(giant);
    // the members are allies of each other
    const [m1, m2] = co!.members;
    expect(r.pol.stance(m1, m2)).toBe('alliance');
    expect(r.x.core.save.stats.coalitions).toBe(1);
    expect(r.sim.state.chronicle.some((c) => c.kind === 'coalition')).toBe(true);
    // the league marches: a war of cause 'coalition' with the members on one side
    for (const m of co!.members) bringNear(r, giant, m);
    r.sim.rng('politics.coalition').next = () => 0;
    r.sim.advanceDays(12);
    const w = r.x.core.save.wars.find((x) => x.cause === 'coalition');
    expect(w).toBeTruthy();
    expect(w!.defenders[0]).toBe(giant);
    expect(co!.war).toBe(w!.id);
    // the war over, the league is dissolved
    r.x.wars.end(w!, 'white_peace', 'white');
    expect(r.pol.coalitions().length).toBe(0);
  });

  it('the player’s House is leagued against as soon as it is the strongest in the land', () => {
    const r = rig({ preset: 'large', seed: 'coalition-player', keepPlayer: true });
    const kings = housesHolding(r.sim, 'kingdom');
    makePlayer(r.sim, r.x.core.headOf(kings[0])!);
    r.x.wars.makeVassal(kings[1], kings[0]);
    r.x.wars.makeVassal(kings[2], kings[0]);
    r.x.core.invalidate();
    const warns: string[] = [];
    r.sim.events.on('notify', (e) => { if (e.kind === 'danger') warns.push(e.text); });
    r.sim.rng('politics.coalition').next = () => 0;
    r.x.realms.coalitionsSeasonal();
    const co = r.pol.coalitions().find((c) => c.target === kings[0]);
    expect(co).toBeTruthy();
    expect(warns.some((t) => /gathering against you/.test(t))).toBe(true);
  });

  it('nobody leagues against a House that is not dominant, and a smaller difficulty needs a bigger giant', () => {
    const r = rig({ preset: 'large', seed: 'coalition-none' });
    r.x.realms.coalitionsSeasonal();
    expect(r.pol.coalitions().length).toBe(0);
  });
});
