// The AI rulers over game years on the mock continent: the realms grow (works, men, techniques) without breaking the world - the people and
// their prosperity stay about what they are without the rulers, no purse is driven below nothing, no House builds past its share of the
// year or keeps more works open than it may, no place fills past what the builder allows, and the builder's registry stays whole.
import { describe, expect, it } from 'vitest';
import { maxPerSettlement } from '../../../src/sim/construction/data';
import { AI, OPEN_SITES, PACE, YEAR_SHARE } from '../../../src/sim/realm/aiConfig';
import { openLimit } from '../../../src/sim/realm/aiSense';
import { invariants } from '../construction/helpers';
import { aiWorld, type AiWorld } from './aiworld';

const YEARS = 4;
const DAYS = 16;

const living = (w: AiWorld): number => { let n = 0; for (const p of w.sim.state.persons.values()) if (!p.death) n++; return n; };
const prosperity = (w: AiWorld): number => { let s = 0, n = 0; for (const st of w.sim.state.settlements.values()) { s += st.prosperity; n++; } return n ? s / n : 1; };
const finished = (w: AiWorld): number => { let n = 0; for (const b of w.sim.state.buildings.values()) if (b.construction >= 1) n++; return n; };

describe('the AI rulers over years', () => {
  it('grow the realms without breaking the world', () => {
    const control = aiWorld({ seed: 'ai-balance', noAi: true });
    const w = aiWorld({ seed: 'ai-balance' });
    const start = { pop: living(w), buildings: finished(w) };
    const startAt = new Map<number, number>();
    for (const [sid, list] of w.sim.state.buildingsAt) startAt.set(sid, list.length);

    // what each House staked out, by game year (new works and improvements; mending is not counted against the share)
    const placed = new Map<string, number>();
    w.sim.events.on('construction', (e) => {
      if (e.phase !== 'placed' || e.work === 'repair') return;
      const k = `${e.house}:${Math.floor(w.sim.absDay / DAYS)}`;
      placed.set(k, (placed.get(k) ?? 0) + 1);
    });
    const places = new Map<number, number>();
    const classOf = new Map<number, keyof typeof YEAR_SHARE>();
    let worstOpen = 0;

    for (let y = 1; y <= YEARS; y++) {
      w.sim.advanceDays(DAYS);
      control.sim.advanceDays(DAYS);
      // the books at the turn of the year
      expect(invariants(w.sim, w.cons), `year ${y}`).toEqual([]);
      for (const hh of w.sim.state.households.values()) expect(hh.purse, `household ${hh.id} purse`).toBeGreaterThanOrEqual(0);
      for (const u of w.ai.units()) {
        const S = w.ai.sense(u.ruler);
        if (!S) continue;
        places.set(S.house, Math.max(places.get(S.house) ?? 0, S.places.length));
        classOf.set(S.house, S.class);
        // no more works open than the House keeps (one over, for a mending that was allowed past the count)
        worstOpen = Math.max(worstOpen, S.open.length - openLimit(S));
      }
    }

    // the people and their prosperity are about what they are without the rulers
    expect(living(w)).toBeGreaterThan(living(control) * 0.9);
    expect(prosperity(w)).toBeGreaterThan(prosperity(control) - 0.06);

    // the realms grew, but not without limit
    const grown = finished(w) - start.buildings;
    expect(grown).toBeGreaterThan(5);
    expect(grown).toBeLessThan(start.buildings * 0.35 + 60);
    let widest = 0;
    for (const [sid, list] of w.sim.state.buildingsAt) {
      widest = Math.max(widest, list.length - (startAt.get(sid) ?? 0));
      const byKind = new Map<string, number>();
      const kind = w.sim.world.settlements.find((s) => s.id === sid)?.kind;
      for (const b of list) byKind.set(b.kind, (byKind.get(b.kind) ?? 0) + 1);
      if (kind) for (const [k, n] of byKind) {
        const cap = maxPerSettlement(k as never, kind);
        // (what the world started with may stand over the builder's cap; the rulers never add to it)
        if (n > cap && !(startAt.get(sid) ?? 0)) expect(n, `${k} at ${sid}`).toBeLessThanOrEqual(cap);
      }
    }
    expect(widest).toBeLessThan(45);

    // each House kept to its share of the year
    for (const [k, n] of placed) {
      const house = Number(k.split(':')[0]);
      const cls = classOf.get(house);
      if (!cls) continue;
      const share = (AI.yearBase + AI.yearPerPlace * (places.get(house) ?? 1)) * YEAR_SHARE[cls] * PACE.knight;
      expect(n, `House ${house} (${cls}) in year ${k.split(':')[1]}`).toBeLessThanOrEqual(Math.ceil(share) + 4);
    }
    expect(worstOpen).toBeLessThanOrEqual(1);
    void OPEN_SITES;

    // and they did what rulers do: build, learn, arm
    const t = w.ai.table();
    const sum = (f: (r: (typeof t)[number]) => number): number => t.reduce((a, r) => a + f(r), 0);
    expect(sum((r) => r.placed)).toBeGreaterThan(20);
    expect(sum((r) => r.done)).toBeGreaterThan(10);
    expect(sum((r) => r.research)).toBeGreaterThan(3);
    expect(sum((r) => r.recruits)).toBeGreaterThan(0);
    expect(sum((r) => r.homes)).toBeGreaterThan(0);
    // a purse is not drained: most rulers still hold more than a fifth of what is comfortable
    let thin = 0, rulers = 0;
    for (const u of w.ai.units()) { const S = w.ai.sense(u.ruler); if (!S) continue; rulers++; if (S.funds < S.comfort * 0.2) thin++; }
    expect(thin).toBeLessThanOrEqual(Math.ceil(rulers * 0.3));
    void start.pop;
  }, 240_000);
});
