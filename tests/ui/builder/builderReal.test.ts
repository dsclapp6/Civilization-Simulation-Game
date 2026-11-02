// The builder's model against the real construction module (on the tests' mock continent with a fake territory): what the catalogue,
// `check`, `suggestSpot`, the sites and `quote` really give is what the model words and groups — so a change in the module's shapes
// shows here, not in the browser.
import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../../../src/content/types';
import type { Deposit } from '../../../src/world/types';
import {
  CATEGORY_ORDER, conditionWords, costLines, costSummary, cursorTip, defaultOutpostName, filterCatalogue, ghostFrom, groupCatalogue, manageOptions,
  noBuildCard, queueRows, requirementLines, siteCard, siteTitle,
} from '../../../src/ui/builder/builderModel';
import { allMaterials, clearSpot, enrich, houseOf, manorLord, probeWild, rig, village, type Rig } from '../../sim/construction/helpers';

const describeGood = (g: string, q: number): string => `${q} ${g}`;

describe('the real catalogue', () => {
  it('groups every kind of building into a category the builder lists', () => {
    const r = rig('ui-b-cat');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const options = r.cons.catalogue(lord.id, v.id);
    expect(options).toHaveLength(Object.keys(BUILDINGS).length);
    for (const o of options) expect(CATEGORY_ORDER).toContain(o.category);
    const groups = groupCatalogue(options);
    expect(groups.reduce((n, g) => n + g.options.length, 0)).toBe(options.length);
    // a lord in his own manor can raise some things and is told why he cannot raise the others
    const open = options.filter((o) => o.ok);
    const closed = options.filter((o) => !o.ok);
    expect(open.length).toBeGreaterThan(8);
    expect(closed.length).toBeGreaterThan(3);
    for (const o of closed) expect(o.reason, o.kind).toBeTruthy();
    // every row has something to say about what it costs and every requirement reads as words
    for (const o of options) {
      expect(costSummary(o.cost, describeGood).length, o.kind).toBeGreaterThan(0);
      for (const l of requirementLines(o.requires, (t) => t)) expect(l.text.length).toBeGreaterThan(3);
    }
    // the filter keeps the open ones first
    const list = filterCatalogue(options, { category: 'all', query: '', showUnavailable: true });
    const firstClosed = list.findIndex((o) => !o.ok);
    expect(list.slice(0, firstClosed).every((o) => o.ok)).toBe(true);
    expect(list.slice(firstClosed).every((o) => !o.ok)).toBe(true);
  });

  it('says why a child cannot build and what would let him', () => {
    const r = rig('ui-b-child');
    const child = r.sim.state.persons.get(r.sim.state.run.playerId)!;
    const scope = r.cons.scope(child.id);
    expect(scope.role).toBe('none');
    const card = noBuildCard(scope);
    expect(card.why).toMatch(/young|household|land/i);
    expect(card.ways.length).toBeGreaterThan(3);
    // the catalogue still lists everything, every option closed with the same reason
    const options = r.cons.catalogue(child.id, child.settlement);
    expect(options.every((o) => !o.ok && !!o.reason)).toBe(true);
  });
});

describe('the real ghost, site and queue', () => {
  it('makes a ghost of a real check, a card of a real site and a queue row of it', () => {
    const r = rig('ui-b-site');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    enrich(houseOf(r.sim, lord), allMaterials('cottage', r.cons));
    const spot = clearSpot(r, v.id, 'cottage', lord);
    const check = r.cons.check(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(check.ok, check.reason).toBe(true);
    const ghost = ghostFrom('cottage', 1, check);
    expect(ghost.footprint).toHaveLength(4);
    expect(ghost.ok).toBe(true);
    expect(cursorTip('Cottage', check, costSummary(r.cons.cost('cottage', 1), describeGood)).tone).toBe('ok');
    // a spot in the middle of a building does not fit, and the cursor says why
    const b = r.sim.state.buildingsAt.get(v.id)!.find((x) => x.construction >= 1 && x.plot >= 0)!;
    const bad = r.cons.check(lord.id, 'cottage', b.x, b.z, 0);
    expect(bad.ok).toBe(false);
    const tip = cursorTip('Cottage', bad, '');
    expect(tip.tone).toBe('bad');
    expect(tip.text.length).toBeGreaterThan(3);

    const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    const site = r.cons.site(res.site as number)!;
    const card = siteCard(site, [], r.sim.absDay, describeGood, (id) => `P${id}`);
    expect(card.title).toBe('Raising a cottage');
    expect(card.stage).toBe('Pegs and lines');
    expect(card.progress).toBe(0);
    expect(card.labour).toMatch(/worker-days of work/);
    const rows = queueRows(r.cons.sites(), (id) => r.cons.canManage?.(lord.id, id) ?? false, r.sim.absDay, (id) => `P${id}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: site.id, mine: true, title: siteTitle(site) });
    // someone else's work in the same place is listed, but not as theirs
    const other = r.sim.state.persons.get(r.sim.state.run.playerId)!;
    expect(queueRows(r.cons.sites(), (id) => r.cons.canManage?.(other.id, id) ?? false, r.sim.absDay, (id) => `P${id}`)[0].mine).toBe(false);
    // the costs of the whole job, in lines
    expect(costLines(site.cost!, describeGood).some((l) => l.kind === 'labour')).toBe(true);
  });

  it('words what can be done to a standing building from the module\'s quotes', () => {
    const r = rig('ui-b-quote');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    enrich(houseOf(r.sim, lord), { planks: 500, timber: 500, stone: 500, nails: 500, straw: 500, iron: 200 });
    const barn = r.sim.state.buildingsAt.get(v.id)!.find((b) => b.kind === 'barn' && b.construction >= 1) ?? r.sim.state.buildingsAt.get(v.id)!.find((b) => b.construction >= 1 && b.plot >= 0)!;
    const quotes = {
      upgrade: r.cons.quote!(lord.id, 'upgrade', barn.id),
      repair: r.cons.quote!(lord.id, 'repair', barn.id),
      demolish: r.cons.quote!(lord.id, 'demolish', barn.id),
    };
    const opts = manageOptions(quotes, describeGood);
    expect(opts).toHaveLength(3);
    // an undamaged building has nothing to mend, and the reason is the module's
    expect(opts[1].ok).toBe(false);
    expect(opts[1].detail.length).toBeGreaterThan(3);
    expect(conditionWords(barn.damage).word).toBe('Sound');
    // demolishing is always on offer to the owner
    expect(opts[2].ok).toBe(true);
  });
});

describe('the real outpost', () => {
  it('founding one in the wild shows the outpost in the check and offers a name from the deposit', () => {
    const W = probeWild('outpost');
    const dep: Deposit = { id: 0, kind: 'iron', x: W.x, z: W.z, radius: 60, richness: 0.8, settlement: -1 };
    const r: Rig = rig('outpost', { deposits: [dep], roads: [] });
    const t = [...r.sim.state.titles.values()].find((x) => x.kind === 'county' && x.place === 1)!;
    const earl = r.sim.state.persons.get(t.holder)!;
    enrich(r.sim.state.households.get(earl.household)!, { timber: 500, planks: 500, nails: 500, iron: 100, stone: 500 });
    const check = r.cons.check(earl.id, 'mine', dep.x, dep.z, 0);
    expect(check.ok, check.reason).toBe(true);
    expect(check.outpost?.id).toBe(0);
    expect(cursorTip('Mine', check, '').text).toMatch(/found an outpost/);
    const found = r.sim.services.territory!.depositAt(check.x, check.z);
    expect(found?.kind).toBe('iron');
    expect(defaultOutpostName(found?.kind, 'mine', check.outpost?.name)).toBe('Iron camp');
  });
});
