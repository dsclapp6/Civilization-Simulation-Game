// The map's civilization-pass model (src/ui/core/mapModel.ts): layers and deposit tooltips, House colours, who lives in a place
// (grouped by calling, searchable), checked against the real deposits of a generated continent and the real residents of a simulation.
import { describe, expect, it } from 'vitest';
import {
  DEPOSIT_COLOR, DEPOSIT_KINDS, DEPOSIT_NAME, DEPOSIT_USE, ROLE_GROUPS, cssColor, defaultLayers, depositShown, depositTip, groupCounts, houseColor, onScreen,
  peopleOfSettlement, peopleRows, richnessWords, roleGroup, rgba, searchPeople, whoseLands, type RoleGroup,
} from '../../src/ui/core/mapModel';
import { generateWorld } from '../../src/world/generate';
import { newSim } from '../sim/helpers';

describe('deposits on the map', () => {
  it('has a colour, a name and a use for every kind, all different', () => {
    expect(DEPOSIT_KINDS).toEqual(['iron', 'stone', 'clay', 'salt', 'silver', 'gold']);
    expect(new Set(DEPOSIT_KINDS.map((k) => DEPOSIT_COLOR[k])).size).toBe(6);
    for (const k of DEPOSIT_KINDS) { expect(DEPOSIT_NAME[k].length).toBeGreaterThan(3); expect(DEPOSIT_USE[k].length).toBeGreaterThan(20); }
  });

  it('words richness from thin to rich', () => {
    expect(richnessWords(0.2)).toBe('thin');
    expect(richnessWords(0.4)).toBe('fair');
    expect(richnessWords(0.65)).toBe('good');
    expect(richnessWords(0.95)).toBe('rich');
  });

  it('shows the layers a player turned on', () => {
    const l = defaultLayers();
    expect(l.borders && l.outposts && l.deposits).toBe(true);
    expect(DEPOSIT_KINDS.every((k) => depositShown(l, k))).toBe(true);
    expect(depositShown({ ...l, deposits: false }, 'iron')).toBe(false);
    expect(depositShown({ ...l, kinds: { ...l.kinds, gold: false } }, 'gold')).toBe(false);
    expect(depositShown({ ...l, kinds: { ...l.kinds, gold: false } }, 'iron')).toBe(true);
  });

  it('makes a tooltip of kind, richness, whose lands, whether a work stands there and what it is good for', () => {
    const tip = depositTip({ kind: 'iron', richness: 0.9 }, whoseLands('Dromore', 'Avenel'));
    expect(tip.split('\n')).toEqual(['Iron ore deposit: rich', 'In the lands of Dromore (House Avenel)', DEPOSIT_USE.iron]);
    expect(depositTip({ kind: 'gold', richness: 0.3 }, whoseLands(null, null), 'Gold camp')).toContain('A work stands here: Gold camp');
    expect(whoseLands('Dromore', null)).toBe('In the lands of Dromore');
    expect(whoseLands(null, null)).toMatch(/wild/);
  });

  it('describes every deposit of a generated continent (no kind without a word)', () => {
    const world = generateWorld('abc');
    const deposits = world.deposits ?? [];
    expect(deposits.length).toBeGreaterThan(50);
    for (const d of deposits) {
      const tip = depositTip({ kind: d.kind as (typeof DEPOSIT_KINDS)[number], richness: d.richness }, whoseLands(d.settlement >= 0 ? world.settlements[d.settlement]?.name ?? null : null, null));
      expect(tip.startsWith(`${DEPOSIT_NAME[d.kind as (typeof DEPOSIT_KINDS)[number]]} deposit`)).toBe(true);
    }
  });
});

describe('colours and the screen', () => {
  it('takes a House\'s shield field, else the kingdom\'s colour', () => {
    expect(houseColor(0xaa3322, 0x111111)).toBe(0xaa3322);
    expect(houseColor(undefined, 0x336699)).toBe(0x336699);
    expect(houseColor(Number.NaN, 0x336699)).toBe(0x336699);
    expect(cssColor(0x0a0b0c)).toBe('#0a0b0c');
    expect(cssColor(0xff0000)).toBe('#ff0000');
    expect(rgba(0x336699, 0.5)).toBe('rgba(51, 102, 153, 0.5)');
    expect(rgba(0x336699, 7)).toBe('rgba(51, 102, 153, 1)');
  });

  it('knows what is on the screen, with a margin, and that nothing behind the camera is', () => {
    expect(onScreen({ x: 10, y: 10 }, 1280, 720)).toBe(true);
    expect(onScreen({ x: -20, y: 10 }, 1280, 720)).toBe(true);
    expect(onScreen({ x: -40, y: 10 }, 1280, 720)).toBe(false);
    expect(onScreen({ x: 1300, y: 740 }, 1280, 720, 30)).toBe(true);
    expect(onScreen(null, 1280, 720)).toBe(false);
  });
});

describe('who lives there', () => {
  const p = (career: string, over: Record<string, unknown> = {}): Parameters<typeof roleGroup>[0] => ({ career, offices: [], age: 30, ...over });

  it('puts a person in the highest calling they have', () => {
    expect(roleGroup(p('lord'))).toBe('lord');
    expect(roleGroup(p('farmer', { holdsTitle: true }))).toBe('lord');
    expect(roleGroup(p('knight', { offices: [{ office: 'reeve' }] }))).toBe('officer');
    expect(roleGroup(p('steward'))).toBe('officer');
    expect(roleGroup(p('priest'))).toBe('priest');
    expect(roleGroup(p('monk'))).toBe('priest');
    expect(roleGroup(p('smith'))).toBe('smith');
    expect(roleGroup(p('knight'))).toBe('knight');
    expect(roleGroup(p('squire'))).toBe('knight');
    expect(roleGroup(p('archer'))).toBe('soldier');
    expect(roleGroup(p('merchant'))).toBe('merchant');
    expect(roleGroup(p('alewife'))).toBe('merchant');
    expect(roleGroup(p('weaver'))).toBe('craft');
    expect(roleGroup(p('labourer'))).toBe('farmer');
    expect(roleGroup(p('servant'))).toBe('servant');
    expect(roleGroup(p('child', { age: 6 }))).toBe('child');
    expect(roleGroup(p('farmer', { age: 9 }))).toBe('child');
    expect(roleGroup(p('beggar'))).toBe('other');
  });

  it('lists the people of a real settlement with the ruler first, searchable by name and calling, every one of them somewhere', () => {
    const sim = newSim({ seed: 'ui-people', preset: 'small' });
    const place = sim.world.settlements.find((s) => s.kind === 'village' && sim.state.titleFor('manor', s.id))!;
    const manor = sim.state.titleFor('manor', place.id)!;
    const rows = peopleOfSettlement(sim.state, place.id, sim.absDay, manor.holder);
    expect(rows.length).toBe(sim.state.residentsOf(place.id).length);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows[0].id).toBe(manor.holder);
    expect(rows[0].ruler).toBe(true);
    expect(rows[0].group).toBe('lord');
    for (const r of rows) { expect(r.name.length).toBeGreaterThan(2); expect(r.role.length).toBeGreaterThan(1); expect(ROLE_GROUPS.some((g) => g.id === r.group)).toBe(true); }
    // children are most of the youngest, farm folk the most of the grown
    const counts = groupCounts(rows);
    expect(counts.all).toBe(rows.length);
    expect(counts.child).toBeGreaterThan(0);
    expect(counts.farmer).toBeGreaterThan(0);
    expect(DEPOSIT_KINDS.length).toBe(6);
    let sum = 0;
    for (const g of ROLE_GROUPS) if (g.id !== 'all') sum += counts[g.id as RoleGroup];
    expect(sum).toBe(rows.length);
    // search
    const who = rows[3];
    const byName = searchPeople(rows, who.name.split(' ')[0].toLowerCase(), 'all');
    expect(byName.rows.some((r) => r.id === who.id)).toBe(true);
    const farmers = searchPeople(rows, '', 'farmer');
    expect(farmers.rows.every((r) => r.group === 'farmer')).toBe(true);
    expect(farmers.total).toBe(counts.farmer);
    expect(searchPeople(rows, 'zzzzzz', 'all')).toEqual({ rows: [], total: 0 });
    expect(searchPeople(rows, '', 'all', 5).rows).toHaveLength(5);
    expect(searchPeople(rows, '', 'all', 5).total).toBe(rows.length);
  });

  it('sorts the ruler first, then the greater, then by name', () => {
    const person = (id: number, first: string, rankTier: number, career = 'farmer'): Parameters<typeof peopleRows>[0][number] => ({ id, first, byname: 'Fowler', sex: 'm', career, offices: [], age: 30, rankTier, household: id });
    const rows = peopleRows([person(1, 'Zed', 1), person(2, 'Amy', 1), person(3, 'Hugh', 5, 'knight'), person(4, 'Mark', 3, 'smith'), person(5, 'Bert', 1)], (p) => p.career, new Set([4]), 5);
    expect(rows.map((r) => r.id)).toEqual([5, 3, 4, 2, 1]);
    expect(rows[0].ruler).toBe(true);
    // a title makes a lord of anyone
    expect(rows.find((r) => r.id === 4)?.group).toBe('lord');
    expect(rows.find((r) => r.id === 3)?.group).toBe('knight');
    // search keeps the order it is given, narrows by words of the calling, and counts what it left out
    expect(searchPeople(rows, 'farmer', 'all').rows.map((r) => r.id)).toEqual([5, 2, 1]);
    expect(searchPeople(rows, '', 'all', 2)).toMatchObject({ total: 5 });
  });
});
