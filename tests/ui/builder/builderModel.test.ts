// Builder mode's pure model (src/ui/builder/builderModel.ts): the catalogue's grouping and filters, costs and requirements in words,
// the ghost and the cursor's label, outposts' names, sites and their materials, the queue, buildings' condition and what can be done to them.
import { describe, expect, it } from 'vitest';
import type { PlacementCheck, SiteView, BuildOption, BuildCost } from '../../../src/sim/construction/types';
import {
  CATEGORY_ORDER, ROTATE_STEP, categoryCounts, cleanOutpostName, conditionWords, costLines, costSummary, cursorTip, defaultOutpostName, depositWords,
  etaWords, filterCatalogue, ghostFrom, groupCatalogue, manageOptions, materialLines, nearestOf, noBuildCard, overviewPlan, ownerWords, priorityFor,
  queueRows, rankWord, requirementLines, rotate, shortfall, siteCard, siteTitle, whereOptions, workerDays,
} from '../../../src/ui/builder/builderModel';

const describe1 = (g: string, q: number): string => `${q} ${g}`;

function option(kind: string, name: string, category: BuildOption['category'], ok = true, reason?: string, cost: BuildCost = { goods: { planks: 10 }, labour: 4, pence: 0 }): BuildOption {
  return { kind: kind as BuildOption['kind'], name, category, level: 1, cost, requires: {}, does: `${name} does things`, ok, reason };
}

const OPTIONS: BuildOption[] = [
  option('cottage', 'Cottage', 'home'), option('hovel', 'Hovel', 'home'), option('manor_house', 'Manor house', 'home', false, 'Only the lord may raise a manor house'),
  option('smithy', 'Smithy', 'craft'), option('watermill', 'Watermill', 'craft', false, 'Needs the technique Watermill'),
  option('wall', 'Curtain wall', 'defence', false, 'Needs the curtain walls technique'), option('church', 'Church', 'religion'), option('barn', 'Barn', 'farm'),
];

describe('catalogue', () => {
  it('groups by category in the catalogue order, the open ones first and by name', () => {
    const groups = groupCatalogue(OPTIONS);
    expect(groups.map((g) => g.category)).toEqual(['home', 'farm', 'craft', 'religion', 'defence']);
    const home = groups[0];
    expect(home.options.map((o) => o.kind)).toEqual(['cottage', 'hovel', 'manor_house']);
    expect(home.open).toBe(2);
    expect(groups[2].options.map((o) => o.kind)).toEqual(['smithy', 'watermill']);
    // every category the module knows is in the order list
    expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
  });

  it('filters by category, by words and by whether the option is open', () => {
    const f = (category: Parameters<typeof filterCatalogue>[1]['category'], query = '', showUnavailable = true): string[] => filterCatalogue(OPTIONS, { category, query, showUnavailable }).map((o) => o.kind);
    expect(f('all')).toHaveLength(OPTIONS.length);
    // open first, then the unavailable, each in category order
    expect(f('all').slice(0, 5)).toEqual(['cottage', 'hovel', 'barn', 'smithy', 'church']);
    expect(f('all', '', false)).toEqual(['cottage', 'hovel', 'barn', 'smithy', 'church']);
    expect(f('craft')).toEqual(['smithy', 'watermill']);
    expect(f('all', 'MILL')).toEqual(['watermill']);
    expect(f('all', 'manor')).toEqual(['manor_house']);
    expect(f('all', 'does things', false)).toHaveLength(5);
    expect(f('home', 'zzz')).toEqual([]);
  });

  it('counts what can be raised per category', () => {
    const c = categoryCounts(OPTIONS);
    expect(c.all).toBe(5);
    expect(c.home).toBe(2);
    expect(c.craft).toBe(1);
    expect(c.defence).toBe(0);
    expect(c.military).toBe(0);
  });
});

describe('costs and requirements in words', () => {
  const cost: BuildCost = { goods: { planks: 20, straw: 30, nails: 4 }, labour: 8, pence: 74 };

  it('lists goods (largest first), labour and cash', () => {
    const lines = costLines(cost, describe1);
    expect(lines.map((l) => l.kind)).toEqual(['good', 'good', 'good', 'labour', 'pence']);
    expect(lines[0]).toMatchObject({ good: 'straw', qty: 30, text: '30 straw' });
    expect(lines[3].text).toBe('8 worker-days');
    expect(lines[4].text).toBe('6s 2d');
  });

  it('summarises in one line, labour first, long lists cut', () => {
    expect(costSummary(cost, describe1)).toBe('8 worker-days · 30 straw · 20 planks · 4 nails · 6s 2d');
    expect(costSummary({ goods: { a: 5, b: 4, c: 3, d: 2, e: 1 }, labour: 1, pence: 0 }, describe1, 2)).toBe('1 worker-day · 5 a · 4 b · +3 more');
    expect(workerDays(1)).toBe('1 worker-day');
    expect(workerDays(2.5)).toBe('2.5 worker-days');
  });

  it('says what a store falls short of', () => {
    expect(shortfall(cost, (g) => ({ planks: 25, straw: 10, nails: 0 }[g] ?? 0))).toEqual({ straw: 20, nails: 4 });
    expect(shortfall(cost, () => 100)).toEqual({});
  });

  it('puts technique, terrain, deposit, rank and count into lines', () => {
    const tech = (id: string): string => ({ curtain_walls: 'Curtain walls' }[id] ?? id);
    const lines = requirementLines({ tech: 'curtain_walls', rank: 6, max: 1 }, tech, () => false);
    expect(lines.map((l) => l.text)).toEqual(['Technique: Curtain walls', 'Builder of baron rank or better', 'One to a place']);
    expect(lines[0].tone).toBe('warn');
    expect(requirementLines({ tech: 'x' }, tech, () => true)[0].tone).toBe('ok');
    expect(requirementLines({ terrain: 'deposit', deposit: 'iron', deposits: ['iron', 'silver', 'gold'] }, tech).map((l) => l.text)).toEqual(['On an iron, silver or gold deposit']);
    expect(requirementLines({ terrain: 'river' }, tech)[0].text).toContain('river bank');
    expect(requirementLines({ terrain: 'rise', rank: 1, max: 3 }, tech).map((l) => l.text)).toEqual(['A rise of the ground, open to the wind', 'At most 3 to a place']);
    expect(depositWords(['stone'])).toBe('a stone deposit');
    expect(rankWord(5)).toBe('knight');
    expect(rankWord(99)).toBe('royal');
  });
});

describe('why you cannot build', () => {
  it('uses the module\'s own reason and lists what would let you', () => {
    const card = noBuildCard({ role: 'none', label: 'Too young to build' });
    expect(card.why).toBe('Too young to build');
    expect(card.ways.length).toBeGreaterThanOrEqual(4);
    expect(card.ways.some((w) => /master/i.test(w.text))).toBe(true);
    expect(card.ways.some((w) => /baron/i.test(w.text) && /outpost/i.test(w.text))).toBe(true);
    expect(noBuildCard({ role: 'none', label: '' }).why).toMatch(/no land/i);
  });
});

describe('the ghost and the cursor', () => {
  const check = (over: Partial<PlacementCheck> = {}): PlacementCheck => ({
    ok: true, x: 100, z: 200, rot: 0.5, settlement: 3, footprint: [{ x: 98, z: 198 }, { x: 102, z: 198 }, { x: 102, z: 202 }, { x: 98, z: 202 }], ...over,
  });

  it('makes the renderer\'s ghost from a check', () => {
    const g = ghostFrom('cottage', 1, check());
    expect(g).toMatchObject({ kind: 'cottage', level: 1, x: 100, z: 200, rot: 0.5, ok: true });
    expect(g.footprint).toHaveLength(4);
    expect(ghostFrom('cottage', 1, check({ ok: false, reason: 'On the road' })).ok).toBe(false);
  });

  it('says the reason in red when it does not fit, and what a click does when it does', () => {
    expect(cursorTip('Cottage', check({ ok: false, reason: 'Overlaps the smithy' }), '8 worker-days')).toEqual({ tone: 'bad', text: 'Overlaps the smithy' });
    expect(cursorTip('Cottage', check({ ok: false }), '').text).toMatch(/cannot build/);
    const ok = cursorTip('Cottage', check(), '8 worker-days');
    expect(ok).toMatchObject({ tone: 'ok', text: 'Click to stake out the cottage', sub: '8 worker-days' });
    expect(cursorTip('Mine', check({ outpost: { id: 0, parent: 5, name: 'Dromore Mine' } }), '').text).toMatch(/found an outpost/);
    expect(cursorTip('Mine', check({ outpost: { id: 4, parent: 5, name: 'Iron camp' } }), '').text).toMatch(/at Iron camp/);
  });

  it('turns in 15 degree steps and wraps', () => {
    expect(ROTATE_STEP).toBeCloseTo(Math.PI / 12, 9);
    expect(rotate(0, 1)).toBeCloseTo(ROTATE_STEP, 9);
    expect(rotate(0, 24)).toBe(0);
    expect(rotate(Math.PI - 0.01, 1)).toBeLessThan(0);
    let r = 0;
    for (let i = 0; i < 100; i++) r = rotate(r, -1);
    expect(r).toBeGreaterThan(-Math.PI - 1e-9);
    expect(r).toBeLessThanOrEqual(Math.PI);
  });
});

describe('outposts', () => {
  it('names an outpost from its deposit, else from the building, else from the module\'s suggestion', () => {
    expect(defaultOutpostName('iron', 'mine')).toBe('Iron camp');
    expect(defaultOutpostName('stone', 'quarry')).toBe('Stone quarry');
    expect(defaultOutpostName('salt', 'salt_pan')).toBe('Salt pans');
    expect(defaultOutpostName(undefined, 'lumber_camp')).toBe('Lumber camp');
    expect(defaultOutpostName(undefined, 'tower', 'Dromore Tower')).toBe('Dromore Tower');
    expect(defaultOutpostName(undefined, 'tower')).toBe('Outpost');
  });

  it('cleans a typed name', () => {
    expect(cleanOutpostName('   Iron   camp \n')).toBe('Iron camp');
    expect(cleanOutpostName('x'.repeat(80))).toHaveLength(32);
    expect(cleanOutpostName('   ')).toBe('');
  });
});

function site(over: Partial<SiteView> = {}): SiteView {
  return {
    id: 7, building: 90, kind: 'cottage', work: 'build', settlement: 3, x: 10, z: 20, rot: 0, household: 11, house: 4, progress: 0.4, missing: { planks: 12 }, labourLeft: 5, workers: 2,
    status: 'waiting', note: 'Waiting for 12 planks: on the way from Dromore market, 1 day', eta: 120, priority: 0, level: 1, stage: 'frame', ...over,
  };
}

describe('sites', () => {
  it('words the title of the work', () => {
    expect(siteTitle(site())).toBe('Raising a cottage');
    expect(siteTitle(site({ kind: 'smithy' }))).toBe('Raising a smithy');
    expect(siteTitle(site({ kind: 'alehouse' }))).toBe('Raising an alehouse');
    expect(siteTitle(site({ work: 'upgrade', level: 2, kind: 'barn' }))).toBe('Improving the barn to level 2');
    expect(siteTitle(site({ work: 'repair' }))).toBe('Mending the cottage');
    expect(siteTitle(site({ work: 'demolish' }))).toBe('Pulling down the cottage');
    expect(siteTitle(site({ kind: 'mine', outpost: 'Iron camp' }))).toBe('Raising a mine at Iron camp');
  });

  it('says when it should be done, and when no one can tell', () => {
    expect(etaWords(130.2, 120, 'working')).toMatch(/^About .* \(in 11 days\)$/);
    expect(etaWords(120.5, 120, 'working')).toMatch(/tomorrow/);
    expect(etaWords(Infinity, 120, 'stalled')).toBe('Not while it stands idle');
    expect(etaWords(Infinity, 120, 'waiting')).toMatch(/materials/);
    expect(etaWords(0, 120, 'done')).toBe('Finished');
  });

  it('lists what is missing with what is on the way and when it comes', () => {
    const d = [{ good: 'planks', qty: 20, arrive: 121.4, from: 5 }, { good: 'straw', qty: 5, arrive: 122, from: -1 }];
    const lines = materialLines({ planks: 12, straw: 30, nails: 4 }, d, 120, describe1, (id) => `Place${id}`);
    expect(lines.map((l) => l.good)).toEqual(['straw', 'planks', 'nails']);
    expect(lines[1].text).toBe('12 planks — all on the way from Place5, due in 2 days');
    expect(lines[0].text).toBe('30 straw — 5 on the way, due in 2 days');
    expect(lines[2].text).toBe('4 nails — not yet ordered');
    expect(materialLines({}, d, 120, describe1, String)).toEqual([]);
  });

  it('makes the card of a site', () => {
    const m = siteCard(site({ hired: 2, workers: 3, materials: 0.5 }), [], 120, describe1, String);
    expect(m.title).toBe('Raising a cottage');
    expect(m.stage).toBe('Frame and walls');
    expect(m.progress).toBeCloseTo(0.4);
    expect(m.statusWord).toBe('Waiting');
    expect(m.workers).toBe('3 at work today, 2 hired');
    expect(m.labour).toBe('5 worker-days of work to do');
    expect(m.materialShare).toBe(0.5);
    expect(m.note).toContain('Dromore market');
    expect(siteCard(site({ workers: 0, labourLeft: 0, missing: {}, stage: undefined, progress: 1 }), [], 0, describe1, String)).toMatchObject({ stage: 'Finished', workers: 'No one at work today', labour: 'The work is done', materialShare: 1 });
  });
});

describe('the queue', () => {
  const sites = [
    site({ id: 1, priority: 2, status: 'working', note: undefined, missing: {} }),
    site({ id: 2, priority: 0 }),
    site({ id: 3, priority: -1, status: 'done' }),
    site({ id: 4, priority: 1, status: 'stalled', note: 'No one is left to do the work' }),
    site({ id: 5, priority: -5, status: 'cancelled' }),
  ];
  const name = (id: number): string => `Place${id}`;

  it('lists the person\'s works in the order they are worked, with others after, and leaves out the finished', () => {
    const rows = queueRows(sites, (id) => id !== 4, 120, name);
    expect(rows.map((r) => r.id)).toEqual([2, 1, 4]);
    expect(rows.map((r) => r.mine)).toEqual([true, true, false]);
    expect(queueRows(sites, (id) => id !== 4, 120, name, true).map((r) => r.id)).toEqual([2, 1]);
    expect(rows[0].line).toBe(sites[1].note);
    expect(rows[1].line).toMatch(/about|today|tomorrow/i);
    expect(rows[1].place).toBe('Place3');
  });

  it('finds the priority that puts a work first or last', () => {
    const rows = queueRows(sites, () => true, 120, name);
    expect(priorityFor(rows, 'first')).toBe(-1);
    expect(priorityFor(rows, 'last')).toBe(3);
    expect(priorityFor([], 'first')).toBe(0);
  });
});

describe('buildings standing', () => {
  it('says how sound a building is', () => {
    expect(conditionWords(0).word).toBe('Sound');
    expect(conditionWords(0.1).word).toBe('Weathered');
    expect(conditionWords(0.4)).toMatchObject({ word: 'Damaged', tone: 'gold' });
    expect(conditionWords(0.7).tone).toBe('vermilion');
    expect(conditionWords(0.95).word).toBe('In ruins');
    expect(conditionWords(0.25).share).toBeCloseTo(0.75);
    expect(conditionWords(-3).share).toBe(1);
  });

  it('turns the module\'s quotes into the three options with their reasons', () => {
    const o = manageOptions({
      upgrade: { ok: true, level: 2, cost: { goods: { planks: 8 }, labour: 3, pence: 0 } },
      repair: { ok: false, reason: 'Nothing to mend' },
      demolish: { ok: true, cost: { goods: {}, labour: 2, pence: 0 } },
    }, describe1);
    expect(o.map((x) => x.work)).toEqual(['upgrade', 'repair', 'demolish']);
    expect(o[0]).toMatchObject({ ok: true, label: 'Upgrade', level: 2 });
    expect(o[0].detail).toBe('Level 2: 3 worker-days · 8 planks');
    expect(o[1]).toMatchObject({ ok: false, detail: 'Nothing to mend' });
    expect(o[2].detail).toContain('come back');
  });

  it('says whose a building is', () => {
    const me = { house: 4, household: 11 };
    const houseName = (id: number): string => `H${id}`;
    expect(ownerWords({ owner: 9, household: 11 }, me, houseName)).toBe('your household’s');
    expect(ownerWords({ owner: 4, household: 0 }, me, houseName)).toBe('your House’s');
    expect(ownerWords({ owner: 9, household: 12 }, me, houseName)).toBe('House H9’s');
    expect(ownerWords({ owner: 0, household: 12 }, me, houseName)).toBe('a household’s');
    expect(ownerWords({ owner: 0, household: 0 }, me, houseName)).toBe('held in common');
  });
});

describe('where the camera looks and what places the catalogue can be asked about', () => {
  it('starts over the settlement, closer for a household head', () => {
    expect(overviewPlan({ x: 1, z: 2 }, 2500, 'lord')).toEqual({ x: 1, z: 2, radius: 1400, distance: 170 });
    expect(overviewPlan({ x: 1, z: 2 }, 600, 'lord').radius).toBe(600);
    expect(overviewPlan({ x: 1, z: 2 }, 2500, 'head')).toEqual({ x: 1, z: 2, radius: 450, distance: 120 });
    expect(overviewPlan({ x: 1, z: 2 }, 0, 'lord').radius).toBe(1400);
    expect(overviewPlan({ x: 1, z: 2 }, 50, 'baron').radius).toBe(250);
  });

  it('finds the nearest of some places', () => {
    const places = [{ id: 1, x: 0, z: 0 }, { id: 2, x: 100, z: 100 }, { id: 3, x: -500, z: 0 }];
    expect(nearestOf(places, 90, 80)).toBe(2);
    expect(nearestOf(places, -400, 10)).toBe(3);
    expect(nearestOf([], 0, 0)).toBe(-1);
  });

  it('offers the settlements in scope (home first), one\'s own place for a head, and the wild to a baron', () => {
    const name = (id: number): string => ({ 3: 'Dromore', 5: 'Avenel', 9: 'Cyney' }[id] ?? `P${id}`);
    expect(whereOptions({ settlements: [9, 3, 5], outposts: true, role: 'baron' }, 5, name).map((o) => `${o.id}:${o.label}`)).toEqual(['5:Avenel', '9:Cyney', '3:Dromore', '-1:The wild']);
    expect(whereOptions({ settlements: [9, 3], outposts: false, role: 'lord' }, 5, name).map((o) => o.id)).toEqual([9, 3]);
    expect(whereOptions({ settlements: [], outposts: false, role: 'head' }, 3, name)).toEqual([{ id: 3, label: 'Dromore', hint: 'your plot' }]);
    expect(whereOptions({ settlements: [], outposts: false, role: 'none' }, 3, name)).toEqual([]);
  });
});
