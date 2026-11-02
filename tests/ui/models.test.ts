import { describe, expect, it } from 'vitest';
import type { FamilyNode } from '../../src/sim/api';
import { familyTree } from '../../src/sim/api';
import { killPerson } from '../../src/sim/succession';
import type { Person } from '../../src/sim/state';
import { fullName } from '../../src/sim/state';
import { orderOptions, chanceBand, opinionWords, opinionFraction, moodTone } from '../../src/ui/core/dialogueModel';
import { CARD_H, CARD_W, SIBLING_GAP, layoutFamily } from '../../src/ui/core/familyLayout';
import { authoritySlots, obligationAmount } from '../../src/ui/core/ledgerModel';
import { KIND_FILTERS, buildRows, matchesFilter, nearestPlace, searchRows, type PlaceLike } from '../../src/ui/core/mapModel';
import { birthModel, lifeStory, successorCard } from '../../src/ui/core/models';
import { TradeBasket, settlementWords, trendLevel, trendWords } from '../../src/ui/core/tradeBasket';
import type { DialogueOption } from '../../src/sim/social/types';
import { personCard } from '../../src/sim/api';
import { formatMoney } from '../../src/sim/money';
import { newSim } from '../sim/helpers';

const node = (id: number, children: FamilyNode[] = [], spouse = 0): FamilyNode => ({
  id, name: `P${id}`, sex: id % 2 ? 'm' : 'f', born: 1, died: null, spouse, father: 0, mother: 0, children, known: true,
});

describe('trade basket', () => {
  const bounds = { stock: 5, have: 3 };

  it('buys within stock and sells within what you hold', () => {
    const b = new TradeBasket();
    expect(b.buy('bread', 3, bounds)).toBe(3);
    expect(b.buy('bread', 9, bounds)).toBe(5);
    expect(b.qty('bread')).toBe(5);
    expect(b.sell('wool', 2, bounds)).toBe(-2);
    expect(b.sell('wool', 9, bounds)).toBe(-3);
    expect(b.toLines()).toEqual([{ key: 'bread', qty: 5 }, { key: 'wool', qty: -3 }]);
  });

  it('keeps a good on one side only: buying cancels selling first', () => {
    const b = new TradeBasket();
    b.sell('ale', 2, bounds);
    expect(b.buy('ale', 1, bounds)).toBe(-1);
    expect(b.buy('ale', 1, bounds)).toBe(0);
    expect(b.isEmpty()).toBe(true);
  });

  it('knows a barter from a purchase', () => {
    const b = new TradeBasket();
    b.buy('bread', 1, bounds);
    expect(b.isBarter()).toBe(false);
    b.sell('wool', 1, bounds);
    expect(b.isBarter()).toBe(true);
    expect(b.hasBuy() && b.hasSell()).toBe(true);
    b.clear();
    expect(b.size).toBe(0);
  });

  it('prunes lines that no longer fit when stock or inventory changes', () => {
    const b = new TradeBasket();
    b.buy('bread', 4, bounds);
    b.sell('wool', 3, bounds);
    b.prune((key) => (key === 'bread' ? { stock: 2, have: 0 } : { stock: 0, have: 0 }));
    expect(b.qty('bread')).toBe(2);
    expect(b.qty('wool')).toBe(0);
  });

  it('words the settlement and the price trend', () => {
    expect(settlementWords(5, formatMoney)).toBe('You pay 5d');
    expect(settlementWords(-14, formatMoney)).toBe('You receive 1s 2d');
    expect(settlementWords(0, formatMoney)).toBe('An even exchange');
    expect(trendLevel(0.3)).toBe('up');
    expect(trendLevel(-0.3)).toBe('down');
    expect(trendLevel(0.05)).toBe('flat');
    expect(trendWords(0.7)).toBe('much dearer than usual');
    expect(trendWords(-0.2)).toBe('a little cheaper than usual');
    expect(trendWords(0)).toBe('about the usual price');
  });
});

describe('dialogue model', () => {
  const opt = (id: string, kind: DialogueOption['kind'], enabled: boolean, priority = 0): DialogueOption => ({ id, provider: 't', label: id, kind, enabled, priority });

  it('lists enabled options first by priority, disabled after, and leaving last', () => {
    const out = orderOptions([opt('leave', 'leave', true, 99), opt('flirt', 'court', false, 50), opt('chat', 'chat', true, 1), opt('news', 'news', true, 9)]);
    expect(out.map((o) => o.id)).toEqual(['news', 'chat', 'flirt', 'leave']);
  });

  it('bands chances and words opinions and moods', () => {
    expect(chanceBand(0.8)).toBe('good');
    expect(chanceBand(0.4)).toBe('fair');
    expect(chanceBand(0.1)).toBe('poor');
    expect(opinionWords(70, 'Agnes')).toBe('Agnes holds you dear');
    expect(opinionWords(0, 'Agnes')).toBe('Agnes has no strong feelings about you');
    expect(opinionWords(-40, 'Agnes')).toBe('Agnes dislikes you');
    expect(opinionFraction(-100)).toBe(0);
    expect(opinionFraction(100)).toBe(1);
    expect(opinionFraction(0)).toBe(0.5);
    expect(moodTone('hostile')).toBe('vermilion');
  });
});

describe('family layout', () => {
  it('centres parents over their children and draws connectors', () => {
    const root = node(1, [node(2), node(3), node(4)]);
    const layout = layoutFamily(root, () => null);
    expect(layout.cards).toHaveLength(4);
    const parent = layout.byId.get(1)!;
    const a = layout.byId.get(2)!;
    const b = layout.byId.get(3)!;
    const c = layout.byId.get(4)!;
    expect(parent.x + CARD_W / 2).toBeCloseTo((a.x + CARD_W / 2 + c.x + CARD_W / 2) / 2);
    expect(a.y).toBeGreaterThan(parent.y);
    expect(b.x - a.x).toBeCloseTo(CARD_W + SIBLING_GAP);
    expect(layout.segments.some((s) => s.kind === 'line')).toBe(true);
    expect(layout.width).toBeGreaterThan(3 * CARD_W);
    expect(layout.height).toBeGreaterThan(2 * CARD_H);
  });

  it('seats a spouse beside the person with a marriage line, and never overlaps cards in a row', () => {
    const spouse = node(10);
    const root = node(1, [node(2, [node(5), node(6)], 11), node(3)], 10);
    const layout = layoutFamily(root, (n) => (n.id === 1 ? spouse : n.id === 2 ? node(11) : null));
    const wed = layout.cards.filter((c) => c.role === 'spouse');
    expect(wed.map((c) => c.id).sort()).toEqual([10, 11]);
    expect(layout.segments.filter((s) => s.kind === 'marriage')).toHaveLength(2);
    const rows = new Map<number, number[]>();
    for (const c of layout.cards) rows.set(c.y, [...(rows.get(c.y) ?? []), c.x]);
    for (const xs of rows.values()) {
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(CARD_W);
    }
  });

  it('lays out a single person', () => {
    const layout = layoutFamily(node(1), () => null);
    expect(layout.cards).toHaveLength(1);
    expect(layout.segments).toHaveLength(0);
  });

  it('lays out the real family of a simulated child', () => {
    const sim = newSim({ seed: 'ui-tree' });
    const tree = familyTree(sim.state, sim.state.run.playerId, 2, 3)!;
    const layout = layoutFamily(tree, (n) => {
      const p = sim.state.persons.get(n.spouse);
      return p ? node(p.id) : null;
    });
    expect(layout.byId.has(sim.state.run.playerId)).toBe(true);
    for (const c of layout.cards) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + CARD_W).toBeLessThanOrEqual(layout.width);
      expect(c.y + CARD_H).toBeLessThanOrEqual(layout.height);
    }
  });
});

describe('map model', () => {
  const places: PlaceLike[] = [
    { id: 0, name: 'Ashford', kind: 'village', x: 1000, z: 1000, kingdom: 0, market: false, population: 80 },
    { id: 1, name: 'Kingsbridge', kind: 'town', x: 3000, z: 1000, kingdom: 0, market: true, population: 900 },
    { id: 2, name: 'Thornbury', kind: 'abbey', x: 1000, z: 5000, kingdom: 1, market: false, population: 40 },
    { id: 3, name: 'Harrowgate', kind: 'castle', x: 5000, z: 5000, kingdom: 1, market: false, population: 60 },
  ];
  const kingdom = (id: number): { name: string; color: number } => ({ name: id === 0 ? 'Wessmark' : 'Aubrevaux', color: id === 0 ? 0xaa0000 : 0x0000aa });

  it('sorts by distance from you and marks where you are', () => {
    const rows = buildRows(places, { x: 1000, z: 1000 }, 0, kingdom);
    expect(rows.map((r) => r.name)).toEqual(['Ashford', 'Kingsbridge', 'Thornbury', 'Harrowgate']);
    expect(rows[0].here).toBe(true);
    expect(rows[1].distance).toBeCloseTo(2000);
    expect(rows[1].direction).toBe('east');
    expect(rows[2].direction).toBe('south');
  });

  it('searches by name, kingdom or kind and filters by type', () => {
    const rows = buildRows(places, { x: 0, z: 0 }, -1, kingdom);
    expect(searchRows(rows, 'king', 'all').map((r) => r.name)).toEqual(['Kingsbridge']);
    expect(searchRows(rows, 'AUBRE', 'all')).toHaveLength(2);
    expect(searchRows(rows, 'abbey', 'all').map((r) => r.name)).toEqual(['Thornbury']);
    expect(searchRows(rows, '', 'towns').map((r) => r.name)).toEqual(['Kingsbridge']);
    expect(searchRows(rows, '', 'markets')).toHaveLength(1);
    expect(searchRows(rows, 'zzz', 'all')).toHaveLength(0);
    expect(KIND_FILTERS.map((f) => f.id)).toContain('castles');
    expect(matchesFilter('hamlet', false, 'villages')).toBe(true);
    expect(matchesFilter('nunnery', false, 'church')).toBe(true);
  });

  it('picks the settlement nearest a clicked point, within reach', () => {
    expect(nearestPlace(places, 3100, 1100, 500)?.name).toBe('Kingsbridge');
    expect(nearestPlace(places, 2000, 1000, 500)).toBeNull();
    expect(nearestPlace(places, 4800, 5100, 500)?.name).toBe('Harrowgate');
  });
});

describe('authority and obligations', () => {
  it('unlocks sections with rank and office, locks the rest with what unlocks them', () => {
    const sim = newSim({ seed: 'ui-authority', preset: 'small' });
    const id = sim.state.run.playerId;
    const p = sim.state.persons.get(id)!;
    const card = personCard(sim, id)!;
    const slots = authoritySlots(card, p);
    const byId = new Map(slots.map((s) => [s.id, s]));
    expect(byId.get('self')?.unlocked).toBe(true);
    expect(byId.get('crown')?.unlocked).toBe(false);
    expect(byId.get('crown')?.unlockedBy).toMatch(/crown/i);
    expect(byId.get('household')?.unlocked).toBe(card.isHead);
    // a landed knight holds the manor, but not a barony
    const knight = { ...card, rankTier: 5 as const };
    const k = new Map(authoritySlots(knight, p).map((s) => [s.id, s]));
    expect(k.get('manor')?.unlocked).toBe(true);
    expect(k.get('barony')?.unlocked).toBe(false);
    // offices unlock the reeve's powers
    const reeve = { ...p, offices: [{ office: 'reeve', place: p.settlement, since: 0 }] } as Person;
    expect(new Map(authoritySlots(card, reeve).map((s) => [s.id, s])).get('reeve')?.unlocked).toBe(true);
  });

  it('words what is owed', () => {
    expect(obligationAmount(96, 'pence', formatMoney)).toBe('8s');
    expect(obligationAmount(2, 'days', formatMoney)).toBe('2 days of labour');
    expect(obligationAmount(1, 'days', formatMoney)).toBe('1 day of labour');
    expect(obligationAmount(3, 'goods', formatMoney)).toBe('3 measures of goods');
  });
});

describe('birth reveal and life story from a real simulation', () => {
  it('describes who you were born as, with family, household and the points multiplier', () => {
    const sim = newSim({ seed: 'ui-birth', preset: 'small', start: 'lord' });
    const m = birthModel(sim)!;
    const me = sim.state.persons.get(sim.state.run.playerId)!;
    expect(m.name).toBe(fullName(me));
    expect(m.age).toBeGreaterThanOrEqual(18);
    expect(m.stats).toHaveLength(6);
    expect(m.realm.length).toBeGreaterThan(0);
    expect(m.headline).toContain(m.settlement.name);
    expect(m.life.length).toBeGreaterThan(80);
    expect(m.multiplier.total).toBeCloseTo(m.multiplier.birth * m.multiplier.difficulty, 5);
    expect(m.household.size).toBeGreaterThanOrEqual(1);
    for (const k of [...m.parents, ...m.siblings]) expect(k.name.length).toBeGreaterThan(0);
  });

  it('tells the story of a life and offers the family as successors', () => {
    const sim = newSim({ seed: 'ui-death', preset: 'small' });
    const startId = sim.state.run.playerId;
    const start = sim.state.persons.get(startId)!;
    const hh = sim.state.households.get(start.household)!;
    // take over the head of the household (an adult with a spouse and children), then let them die
    if (hh.head !== startId) expect(sim.dispatch({ type: 'switchCharacter', personId: hh.head }).ok).toBe(true);
    const dying = sim.state.persons.get(sim.state.run.playerId)!;
    killPerson(sim, dying, 'plague', sim.absDay);
    expect(sim.state.run.phase === 'choosing' || sim.state.run.phase === 'over').toBe(true);
    const story = lifeStory(sim, dying.id, 1)!;
    expect(story.name).toBe(fullName(dying));
    expect(story.causeText).toBe('of the plague');
    expect(story.paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(story.paragraphs[story.paragraphs.length - 1]).toContain('plague');
    expect(story.ageAtDeath).toBeGreaterThanOrEqual(0);
    const pending = sim.state.run.pendingSuccession;
    if (pending) {
      const cards = pending.eligible.map((id) => successorCard(sim, dying, id)!);
      expect(cards.length).toBeGreaterThan(0);
      for (const c of cards) { expect(c.top).toHaveLength(2); expect(c.relation.length).toBeGreaterThan(0); }
    }
  });
});
