// Ruler mode's pure model (src/ui/ruler/rulerModel.ts): the pages, the treasury's year and the books, stores, research by branch and
// what the buttons offer, the cost of raising men, crops and the works' share, what the lands yield and lack, trade orders, rivals,
// news and the overview map — with fakes, and against the real realm.
import { describe, expect, it } from 'vitest';
import type { NewsItem, RecruitOption, ResearchOption, ResearchProject, RivalView } from '../../../src/sim/realm/types';
import type { Deposit } from '../../../src/world/types';
import {
  BATCH, BRANCHES, DAYS_PER_YEAR, NEWS_ICON, PAGES, RESERVE_DAYS, TOAST_THREAT, YIELD_GOODS, amountText, boxOf, cropOptions, cropName, dubbable, fieldRoleWords, fitBox,
  groupResearch, growthWords, isPage, kindName, kmText, knightsOf, lackHints, newsFor, newsToastKey, newsToastWorthy, orderFormProblem, orderWords, polyPath, projectWords,
  prosperityWord, roadPath, recruitMax, recruitPreview, researchCostLines, roleMay, roleWords, sortRivals, splitBooks, stanceTone, startChoice, storeRows, threatWords, tradeProfile,
  troopCounts, worksShareWords, yearWords,
} from '../../../src/ui/ruler/rulerModel';
import { realmSim } from '../../sim/realm/helpers';

describe('the pages', () => {
  it('are the eight of CIV §6, each with a label, icon and blurb', () => {
    expect(PAGES.map((p) => p.id)).toEqual(['overview', 'lands', 'fields', 'research', 'military', 'trade', 'diplomacy', 'rivals']);
    for (const p of PAGES) { expect(p.label.length).toBeGreaterThan(3); expect(p.blurb.length).toBeGreaterThan(20); }
    expect(isPage('rivals')).toBe(true);
    expect(isPage('nope')).toBe(false);
    expect(isPage(undefined)).toBe(false);
  });

  it('say how a person rules and what that lets them do', () => {
    expect(roleWords('holder')).toMatch(/holder/i);
    expect(roleWords('regent')).toMatch(/regent/i);
    expect(roleWords(undefined)).toMatch(/holder/i);
    expect(roleMay('holder')).toEqual({ plan: true, trade: true, realm: true });
    expect(roleMay('reeve')).toEqual({ plan: true, trade: false, realm: false });
    expect(roleMay('steward', false)).toEqual({ plan: true, trade: true, realm: false });
    expect(roleMay('steward', true).realm).toBe(true);
  });
});

describe('the treasury and the books', () => {
  it('words the year as a surplus, a deficit or balanced', () => {
    expect(yearWords(2400, 1200)).toMatchObject({ net: 1200, tone: 'green' });
    expect(yearWords(2400, 1200).word).toBe('A surplus of £5');
    expect(yearWords(100, 1300)).toMatchObject({ net: -1200, tone: 'vermilion' });
    expect(yearWords(100, 1300).word).toBe('A deficit of £5');
    expect(yearWords(1000, 995).word).toBe('Balanced');
    expect(yearWords(0, 0).word).toMatch(/not yet closed/);
  });

  it('splits the books into what came in and what went out, largest first', () => {
    const b = splitBooks([{ label: 'Wages', pence: -300 }, { label: 'Sales', pence: 900 }, { label: 'Rents', pence: 1200 }, { label: 'Research', pence: -50 }]);
    expect(b.in.map((l) => l.label)).toEqual(['Rents', 'Sales']);
    expect(b.out.map((l) => `${l.label}:${l.pence}`)).toEqual(['Wages:300', 'Research:50']);
    expect(b.totalIn).toBe(2100);
    expect(b.totalOut).toBe(350);
    expect(splitBooks([])).toMatchObject({ in: [], out: [], totalIn: 0, totalOut: 0 });
  });

  it('words the prosperity and the amounts of goods', () => {
    expect(prosperityWord(1.3)).toBe('prospering');
    expect(prosperityWord(1)).toBe('getting by');
    expect(prosperityWord(0.5)).toBe('starving');
    expect(amountText(1240.4)).toBe('1,240');
    expect(amountText(12.37)).toBe('12.4');
    expect(amountText(0.456)).toBe('0.46');
  });

  it('lists the stores by category, the larger stock first, leaving out the dust', () => {
    const info = (g: string): { name: string; category: string } | undefined => ({ wheat: { name: 'Wheat', category: 'grain' }, planks: { name: 'Planks', category: 'material' }, timber: { name: 'Timber', category: 'material' }, horse: { name: 'Horse', category: 'livestock' } } as Record<string, { name: string; category: string }>)[g];
    const rows = storeRows({ horse: 7, timber: 40, wheat: 100, planks: 60, mystery: 3, dust: 0.001 }, info);
    expect(rows.map((r) => r.good)).toEqual(['wheat', 'planks', 'timber', 'horse', 'mystery']);
    expect(rows[4]).toMatchObject({ name: 'mystery', category: 'misc' });
  });
});

function research(over: Partial<ResearchOption> & { tech: string }): ResearchOption {
  return { name: over.tech, branch: 'economy', cost: { goods: { timber: 24, planks: 20 }, pence: 220, days: 8 }, researchers: [1, 2], places: [10], ok: false, ...over };
}

describe('research', () => {
  const options = [
    research({ tech: 'windmill', name: 'Windmill', ok: false, buyable: true, days: 18 }),
    research({ tech: 'heavy_plough', name: 'Heavy plough', ok: true, days: 8 }),
    research({ tech: 'fulling', name: 'Fulling mill', ok: false, reason: 'Needs 20 planks', days: 5 }),
    research({ tech: 'bows', name: 'Longbow drill', branch: 'military', ok: true, days: 10 }),
    research({ tech: 'oaths', name: 'Oaths', branch: 'kinship', ok: false, buyable: true, days: 6 }),
    research({ tech: 'weird', name: 'Weird', branch: 'mystery', ok: true }),
  ];

  it('groups by branch with what can be started first, then what can be bought up, then the rest', () => {
    const g = groupResearch(options);
    expect([...g.keys()].slice(0, 4)).toEqual(BRANCHES.map((b) => b.id));
    expect(g.get('economy')!.map((o) => o.tech)).toEqual(['heavy_plough', 'windmill', 'fulling']);
    expect(g.get('military')!.map((o) => o.tech)).toEqual(['bows']);
    expect(g.get('knowledge')).toEqual([]);
    expect(g.get('mystery')!.map((o) => o.tech)).toEqual(['weird']);
  });

  it('offers Start, Buy the rest and start, or the reason why not', () => {
    expect(startChoice(options[1])).toEqual({ mode: 'start', label: 'Start' });
    expect(startChoice({ ...options[0], buyCost: 574.5 })).toMatchObject({ mode: 'buy', label: 'Buy the rest and start', buyCost: 574.5 });
    expect(startChoice(options[2])).toMatchObject({ mode: 'no', reason: 'Needs 20 planks' });
    expect(startChoice(research({ tech: 'x', ok: false })).reason).toMatch(/cannot be started/);
  });

  it('lines the price up with what the stores fall short of', () => {
    const lines = researchCostLines(research({ tech: 'x', short: { planks: 20 }, days: 5 }));
    expect(lines.filter((l) => l.kind === 'good').map((l) => `${l.good}:${l.qty}:${l.short ?? 0}`)).toEqual(['timber:24:0', 'planks:20:20']);
    expect(lines.find((l) => l.kind === 'pence')?.qty).toBe(220);
    expect(lines[lines.length - 1]).toMatchObject({ kind: 'days', qty: 5 });
  });

  it('words a project\'s progress', () => {
    const p = (over: Partial<ResearchProject>): ResearchProject => ({ id: 1, tech: 't', name: 'T', house: 1, researcher: 2, building: 3, progress: 0.4, eta: 130.3, state: 'active', ...over });
    expect(projectWords(p({}), 120)).toMatchObject({ eta: 'Done in 11 days', tone: 'green' });
    expect(projectWords(p({ eta: 120.2 }), 120).eta).toBe('Done tomorrow');
    expect(projectWords(p({ state: 'stalled', note: 'Waiting for 24 timber' }), 120)).toEqual({ eta: 'Waiting', state: 'Waiting for 24 timber', tone: 'vermilion' });
    expect(projectWords(p({ eta: Infinity }), 120).eta).toBe('No telling yet');
    expect(projectWords(p({ state: 'done' }), 120).eta).toBe('Done');
  });
});

describe('raising men', () => {
  const archer: RecruitOption = { kind: 'archer', label: 'Archer', goods: { longbow: 1, arrow: 24 }, pence: 6, upkeep: 2.5, available: 16, ok: true, buy: 57, equipped: 0, affordable: 16 };

  it('previews fees, gear to buy and eight days of wages, and what is left', () => {
    const p = recruitPreview(archer, 10, 5000);
    expect(p.fees).toBe(60);
    expect(p.gear).toBe(570);
    expect(p.reserve).toBe(2.5 * RESERVE_DAYS * 10);
    expect(p.total).toBe(60 + 570 + 200);
    expect(p.perDay).toBe(25);
    expect(p.perYear).toBe(25 * DAYS_PER_YEAR);
    expect(p.affordable).toBe(true);
    expect(p.left).toBe(5000 - 630);
    expect(recruitPreview(archer, 10, 800).affordable).toBe(false);
    expect(recruitPreview(archer, -3, 100).count).toBe(0);
  });

  it('counts the men the stores can arm as free of gear', () => {
    const armed = { ...archer, equipped: 4 };
    expect(recruitPreview(armed, 6, 9999).gear).toBe(57 * 2);
    expect(recruitPreview(armed, 3, 9999).gear).toBe(0);
  });

  it('offers at most what is available, affordable and allowed in one call', () => {
    expect(recruitMax(archer)).toBe(16);
    expect(recruitMax({ ...archer, affordable: 4 })).toBe(4);
    expect(recruitMax({ ...archer, available: 99, affordable: 99 })).toBe(BATCH);
    expect(recruitMax({ ...archer, available: 0, ok: false })).toBe(0);
  });

  it('counts the men on the roll, the best kind first, and says who can be knighted', () => {
    const troops = [{ kind: 'archer' as const, wage: 2.5 }, { kind: 'knight' as const, wage: 12 }, { kind: 'archer' as const, wage: 2.5 }, { kind: 'man_at_arms' as const, wage: 5 }];
    expect(troopCounts(troops)).toEqual([{ kind: 'knight', n: 1, wage: 12 }, { kind: 'man_at_arms', n: 1, wage: 5 }, { kind: 'archer', n: 2, wage: 5 }]);
    expect(dubbable({ kind: 'archer' })).toBe(true);
    expect(dubbable({ kind: 'knight' })).toBe(false);
    expect(dubbable({ kind: 'mercenary' })).toBe(false);
    expect(kindName('man_at_arms', 1)).toBe('man-at-arms');
    expect(kindName('knight')).toBe('knights');
    expect(kindName('wyvern')).toBe('wyvern');
  });
});

describe('fields and labour', () => {
  it('words what a field does and which crops its next sowing may take', () => {
    const f = { role: 'winter' as const, next: 'spring' as const, options: { winter: ['wheat', 'rye'] as const, spring: ['barley', 'oats', 'peas', 'beans'] as const } };
    expect(cropOptions(f)).toEqual(['barley', 'oats', 'peas', 'beans']);
    expect(cropOptions({ ...f, next: 'winter' })).toEqual(['wheat', 'rye']);
    expect(fieldRoleWords(f).now).toMatch(/Winter corn/);
    expect(fieldRoleWords({ ...f, role: 'fallow', next: 'winter' })).toMatchObject({ now: 'Lying fallow', next: expect.stringMatching(/autumn/) });
    expect(cropName('barley')).toBe('Barley');
    expect(cropName('fallow')).toMatch(/usual rotation/);
  });

  it('words the share of week-work sent to the works', () => {
    expect(worksShareWords(0)).toMatch(/demesne/);
    expect(worksShareWords(0.25)).toBe('25% of the week-work goes to the works');
    expect(worksShareWords(1)).toMatch(/All of it/);
  });
});

describe('trade', () => {
  const dep = (id: number, kind: Deposit['kind'], x: number, z: number): Deposit => ({ id, kind, x, z, radius: 60, richness: 0.7, settlement: -1 });

  it('finds what the lands yield and what none of them does', () => {
    const t = tradeProfile([{ yields: ['grain', 'wool', 'clay'] }, { yields: ['grain', 'timber', 'fish'] }]);
    expect(t.yields).toEqual(['grain', 'wool', 'timber', 'fish', 'clay']);
    expect(t.lacks).toEqual(['hay', 'firewood', 'iron_ore', 'stone', 'salt', 'silver_ore', 'gold_ore']);
    expect(tradeProfile([])).toEqual({ yields: [], lacks: [...YIELD_GOODS] });
  });

  it('says how to get what is lacking: buy it, or take the nearest deposit', () => {
    const hints = lackHints(['hay', 'iron_ore', 'gold_ore'], { x: 0, z: 0 }, [dep(1, 'iron', 4200, 0), dep(2, 'iron', 900, 0)], (d) => (d.id === 2 ? 'the lands of Dromore' : 'the wild'));
    expect(hints[0]).toMatchObject({ good: 'hay', text: 'Hay: buy it at the markets' });
    expect(hints[1].text).toBe('Iron ore: buy it, or take the deposit 900 m away (the lands of Dromore) by conquest or an outpost');
    expect(hints[1].deposit).toBe('iron');
    expect(hints[2].text).toMatch(/no deposit is known/);
    expect(kmText(4200)).toBe('4.2 km');
    expect(kmText(640)).toBe('640 m');
  });

  it('words an order and checks the form', () => {
    expect(orderWords({ side: 'sell', limit: 48, keep: 300 }, 'wheat', 'Dromore')).toBe('Sell wheat above 4s, keeping 300 in store, at Dromore');
    expect(orderWords({ side: 'buy', limit: 0, keep: 200 }, 'bricks', '')).toBe('Buy bricks, up to 200 in store');
    expect(orderFormProblem({ good: 'wheat', side: 'sell', limit: 0, keep: 0, settlement: 3 })).toBeNull();
    expect(orderFormProblem({ good: '', side: 'sell', limit: 0, keep: 10, settlement: 3 })).toMatch(/good/);
    expect(orderFormProblem({ good: 'wheat', side: 'buy', limit: 0, keep: 0, settlement: 3 })).toMatch(/stock up/);
    expect(orderFormProblem({ good: 'wheat', side: 'sell', limit: -2, keep: 10, settlement: 3 })).toMatch(/negative/);
    expect(orderFormProblem({ good: 'wheat', side: 'sell', limit: 0, keep: NaN, settlement: 3 })).toMatch(/keep/);
  });
});

describe('rivals and news', () => {
  const rival = (over: Partial<RivalView>): RivalView => ({ house: 2, name: 'Avenel', distance: 3000, strength: 100, built: 0, techs: 0, recruited: 0, stance: 'neutral', threat: 0.2, ...over });

  it('reads a threat in words and sorts the greatest first', () => {
    expect(threatWords(0.9)).toEqual({ word: 'Grave', tone: 'vermilion' });
    expect(threatWords(0.55).word).toBe('Serious');
    expect(threatWords(0.35).tone).toBe('gold');
    expect(threatWords(0.1).word).toBe('Little to fear');
    const sorted = sortRivals([rival({ name: 'B', threat: 0.2, distance: 5000 }), rival({ name: 'A', threat: 0.6 }), rival({ name: 'C', threat: 0.2, distance: 2000 })]);
    expect(sorted.map((r) => r.name)).toEqual(['A', 'C', 'B']);
  });

  it('words stances and growth', () => {
    expect(stanceTone('war')).toBe('vermilion');
    expect(stanceTone('truce')).toBe('lapis');
    expect(stanceTone('alliance')).toBe('green');
    expect(stanceTone('neutral')).toBe('');
    expect(growthWords(rival({ built: 4, techs: 1, recruited: 18 }))).toBe('4 buildings, 1 technique, 18 men raised');
    expect(growthWords(rival({ built: 1 }))).toBe('1 building');
    expect(growthWords(rival({}))).toBe('Nothing seen this year');
  });

  it('picks the news of a House, newest first, and which news is a toast', () => {
    const n = (id: number, day: number, house: number, threat: number, kind: NewsItem['kind'] = 'built'): NewsItem => ({ id, day, kind, house, settlement: 1, text: `n${id}`, threat });
    const items = [n(1, 10, 2, 0.2), n(2, 12, 3, 0.7, 'army'), n(3, 12, 2, 0.5), n(4, 5, 2, 0.1)];
    expect(newsFor(items, null).map((x) => x.id)).toEqual([3, 2, 1, 4]);
    expect(newsFor(items, 2).map((x) => x.id)).toEqual([3, 1, 4]);
    expect(newsFor(items, 2, 2)).toHaveLength(2);
    expect(newsToastWorthy(n(1, 1, 1, TOAST_THREAT))).toBe(true);
    expect(newsToastWorthy(n(1, 1, 1, 0.49))).toBe(false);
    expect(newsToastKey({ id: 7 })).toBe('news-7');
    expect(Object.keys(NEWS_ICON)).toContain('army');
  });
});

describe('the overview map', () => {
  const square = (cx: number, cz: number, r: number): Array<{ x: number; z: number }> => [{ x: cx - r, z: cz - r }, { x: cx + r, z: cz - r }, { x: cx + r, z: cz + r }, { x: cx - r, z: cz + r }];

  it('boxes polygons and points and fits them into a picture, centred, z downward', () => {
    expect(boxOf([])).toBeNull();
    const box = boxOf([square(1000, 1000, 500)], [{ x: 3000, z: 1000 }], 0)!;
    expect(box).toMatchObject({ minX: 500, maxX: 3000, minZ: 500, maxZ: 1500 });
    const fit = fitBox(box, 500, 400);
    expect(fit.scale).toBeCloseTo(0.2, 9);
    expect(fit.x(500)).toBeCloseTo(0, 6);
    expect(fit.x(3000)).toBeCloseTo(500, 6);
    // 1000 m of z is 200 px of the 400: centred, so it starts at 100
    expect(fit.y(500)).toBeCloseTo(100, 6);
    expect(fit.y(1500)).toBeCloseTo(300, 6);
    expect(polyPath(square(1000, 1000, 500), fit)).toMatch(/^M[\d.,]+L[\d.,]+L[\d.,]+L[\d.,]+Z$/);
    expect(polyPath([], fit)).toBe('');
    // a tiny box still has a size
    const tiny = boxOf([], [{ x: 5, z: 5 }])!;
    expect(tiny.maxX - tiny.minX).toBeGreaterThan(100);
  });
});

describe('against the real realm', () => {
  it('previews raising men the way the realm prices them, and the options group by branch', () => {
    const s = realmSim({ seed: 'ui-ruler-1', military: true, politics: true });
    const { sim, realm } = s;
    const seat = sim.world.settlements.find((x) => x.kind === 'castle' || x.kind === 'town') ?? sim.world.settlements[0];
    const ruler = realm.rulerOf(seat.id);
    expect(ruler).toBeGreaterThan(0);
    const hh = sim.state.households.get(sim.state.persons.get(ruler)!.household)!;
    hh.purse = 500000;
    const options = realm.recruitOptions(ruler, seat.id);
    expect(options.length).toBeGreaterThan(3);
    for (const o of options.filter((x) => x.ok && x.affordable)) {
      const n = recruitMax(o);
      expect(n, o.kind).toBeGreaterThan(0);
      // the realm says n are affordable: the preview agrees that n fit the purse, within the margin of equipment it counts
      expect(recruitPreview(o, n, hh.purse).affordable, o.kind).toBe(true);
      // and a preview of more than the purse can pay is not affordable
      expect(recruitPreview(o, 1e9, hh.purse).affordable, o.kind).toBe(false);
    }
    const g = groupResearch(realm.researchOptions(ruler));
    let total = 0;
    for (const list of g.values()) total += list.length;
    expect(total).toBe(realm.researchOptions(ruler).length);
    for (const o of realm.researchOptions(ruler)) {
      const c = startChoice(o);
      if (o.ok) expect(c.mode).toBe('start');
      else if (o.buyable) expect(c.mode).toBe('buy');
      else expect(c.reason).toBeTruthy();
      expect(researchCostLines(o).length).toBeGreaterThan(1);
    }
    const rivals = realm.rivals(ruler);
    for (const r of sortRivals(rivals)) { expect(threatWords(r.threat).word.length).toBeGreaterThan(3); expect(kmText(r.distance).length).toBeGreaterThan(1); }
  });
});

describe('your knights', () => {
  const person = (id: number, o: Record<string, unknown> = {}): never => ({ id, career: 'knight', death: null, flags: {}, health: { hp: 1 }, house: 1, ...o } as never);
  const st = (people: unknown[], titles: Record<number, Array<{ id: number; liege: number }>> = {}) => ({
    persons: { get: (id: number) => (people as Array<{ id: number }>).find((p) => p.id === id) as never, values: () => people as never },
    titlesHeldBy: (id: number) => new Set(titles[id] ?? []) as never,
  });

  it('lists the knights of the House, his vassals and the men in his pay, the paid first, the hurt after', () => {
    const people = [person(1, { career: 'lord' }), person(2), person(3, { house: 2 }), person(4, { house: 3 }), person(5, { house: 3, health: { hp: 0.3 } }), person(6, { house: 3, flags: { captive: true } }), person(7, { house: 3, career: 'squire' })];
    const rows = knightsOf(st(people, { 1: [{ id: 10, liege: 99 }], 3: [{ id: 11, liege: 10 }] }) as never, 1, [4]);
    expect(rows.map((r) => [r.id, r.why, r.hurt])).toEqual([[4, 'in your pay', false], [3, 'your vassal', false], [2, 'of your House', false]]);
    const hurt = knightsOf(st(people) as never, 1, [5], (id) => id === 2);
    expect(hurt.find((r) => r.id === 5)).toMatchObject({ why: 'in your pay', hurt: true });
    expect(hurt.find((r) => r.id === 2)!.hurt).toBe(true);
  });
});

describe('roads on the overview map', () => {
  const box = { minX: 0, minZ: 0, maxX: 1000, maxZ: 1000 };
  const fit = { x: (wx: number) => wx / 10, y: (wz: number) => wz / 10 };

  it('draws the stretches inside the picture and runs off its edge instead of stopping short', () => {
    const d = roadPath([{ x: -5000, z: 500 }, { x: -200, z: 500 }, { x: 100, z: 500 }, { x: 900, z: 500 }, { x: 1300, z: 500 }, { x: 9000, z: 500 }], box, fit);
    expect(d.startsWith('M-20.0,50.0L10.0,50.0')).toBe(true);
    expect(d).toContain('L130.0,50.0');
    expect(d).not.toContain('900.0');
    expect(d.match(/M/g)).toHaveLength(1);
  });

  it('leaves out a road that is not in the picture, and splits one that leaves and comes back', () => {
    expect(roadPath([{ x: 5000, z: 5000 }, { x: 6000, z: 6000 }], box, fit)).toBe('');
    const d = roadPath([{ x: 100, z: 100 }, { x: 5000, z: 100 }, { x: 9000, z: 100 }, { x: 5000, z: 900 }, { x: 100, z: 900 }], box, fit);
    expect(d.match(/M/g)).toHaveLength(2);
  });

  it('drops points that crowd each other on the page', () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ x: 100 + i * 0.5, z: 500 }));
    const d = roadPath(pts, box, fit);
    expect((d.match(/L/g) ?? []).length).toBeLessThan(10);
    expect(d.endsWith('199.5,50.0') || d.endsWith('19.9,50.0') || d.endsWith('20.0,50.0')).toBe(true);
  });
});
