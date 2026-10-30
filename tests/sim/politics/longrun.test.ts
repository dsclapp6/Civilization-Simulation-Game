// A long headless run on a continent of six kingdoms (SPEC §15, §16): politics stays sane — no
// collapse of the continent every decade, but real changes of power — and every invariant of the
// feudal tree holds the whole way.
import { describe, expect, it } from 'vitest';
import type { SimEvents } from '../../../src/sim/events';
import { TITLE_RANK, type Title } from '../../../src/sim/state';
import { rig, type Rig } from './helpers';

function invariants(r: Rig): string[] {
  const bad: string[] = [];
  const st = r.sim.state;
  for (const t of st.titles.values()) {
    const holder = st.persons.get(t.holder);
    if (!holder || holder.death) bad.push(`${t.name}: holder dead or missing`);
    if (t.liege) {
      const above = st.titles.get(t.liege);
      if (!above) bad.push(`${t.name}: liege title missing`);
      else if (above.id === t.id) bad.push(`${t.name}: its own liege`);
      else if (TITLE_RANK[above.kind] < TITLE_RANK[t.kind] && t.kind !== 'town') bad.push(`${t.name}: held from a lesser title (${above.name})`);
    }
  }
  // the feudal chain has no loops
  for (const h of r.pol.actors()) {
    const seen = new Set<number>([h]);
    let cur = h;
    for (let i = 0; i < 12; i++) {
      const l = r.pol.liegeOf(cur);
      if (!l) break;
      if (seen.has(l)) { bad.push(`house ${h}: feudal loop`); break; }
      seen.add(l);
      cur = l;
    }
  }
  for (const w of r.pol.wars()) {
    if (!r.pol.actors().includes(w.attackers[0]) || !r.pol.actors().includes(w.defenders[0])) bad.push(`war ${w.id}: leader gone`);
    if (w.attackers.some((h) => w.defenders.includes(h))) bad.push(`war ${w.id}: a House on both sides`);
  }
  return bad;
}

describe('fifty years of politics', () => {
  it('stays sane: real changes of power, no continent-wide collapse, a sound feudal tree', () => {
    const r = rig({ preset: 'large', seed: 'fifty' });
    const startKingdoms = r.sim.world.kingdoms.length;
    const moved: number[] = [];
    const wars: Array<SimEvents['war']> = [];
    const offices: number[] = [0];
    r.sim.events.on('war', (e) => { if (e.phase === 'declared') wars.push(e); });
    r.sim.events.on('office', () => { offices[0]++; });
    const startPop = r.sim.state.population;
    const problems: string[] = [];
    for (let year = 1; year <= 50; year++) {
      const before = r.pol.stats().titlesMoved;
      r.sim.advanceDays(16);
      moved.push(r.pol.stats().titlesMoved - before);
      if (year % 5 === 0) problems.push(...invariants(r));
    }
    expect(problems).toEqual([]);
    const s = r.pol.stats();
    // real changes of power …
    expect(s.warsDeclared).toBeGreaterThanOrEqual(10);
    expect(s.titlesMoved).toBeGreaterThanOrEqual(3);
    expect(wars.length).toBe(s.warsDeclared);
    // … but never a continent-wide collapse: no decade moves more than a quarter of all titles
    const titles = r.sim.state.titles.size;
    for (let d = 0; d < 5; d++) {
      const decade = moved.slice(d * 10, d * 10 + 10).reduce((a, b) => a + b, 0);
      expect(decade, `decade ${d}`).toBeLessThan(titles / 4);
    }
    // every kingdom is still somebody's, the people are still there, offices are filled and refilled
    const kingTitles = [...r.sim.state.titles.values()].filter((t: Title) => t.kind === 'kingdom');
    expect(kingTitles.length).toBe(startKingdoms);
    for (const t of kingTitles) expect(r.sim.state.persons.get(t.holder)!.death).toBeNull();
    expect(r.sim.state.population).toBeGreaterThan(startPop * 0.7);
    expect(offices[0]).toBeGreaterThan(50);
    // wars are not eternal: few are running at the end, and none has outlived a decade
    for (const w of r.pol.wars()) expect(r.sim.absDay - w.since).toBeLessThan(16 * 10);
    expect(r.pol.wars().length).toBeLessThanOrEqual(6);
    // a lasting record of it all, bounded
    expect(r.sim.state.chronicle.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(r.x.core.save).length).toBeLessThan(400_000);
  }, 600_000);
});
