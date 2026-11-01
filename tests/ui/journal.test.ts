// The journal's pages and the intro card are built from the game's read APIs: here they run on a real simulation with
// the economy and social modules installed (and the UI's stand-in objectives), so the text is what a player would read.
import { describe, expect, it } from 'vitest';
import { toDate } from '../../src/core/time';
import { PERSON_GROUPS, peopleRows, placeRows, taskWords, todayModel } from '../../src/ui/core/journalModel';
import { introModel, tourViewpoint } from '../../src/ui/core/introModel';
import { MockObjectives } from '../../src/ui/dev/mockObjectives';
import type { GameServices } from '../../src/ui/types';
import { rig, type FakeZone } from '../player/fakes';

function game(): GameServices & { fake: FakeZone } {
  const r = rig({ preset: 'small' });
  const objectives = new MockObjectives(r.sim, r.zone);
  return { sim: r.sim, economy: r.economy, social: r.social, zone: r.zone, player: r.player, objectives, fake: r.zone };
}

/** Moves the calendar to a given day of the season (1..4) at mid-morning. */
function setDay(g: GameServices, dayOfSeason: number): void {
  const d = toDate(g.sim.absDay);
  const target = Math.floor(g.sim.absDay) - (d.dayOfSeason - 1) + (dayOfSeason - 1) + 0.4;
  g.sim.state.clock.absDay = target;
}

describe('Today', () => {
  it('says what kind of day it is: working, market, holy', () => {
    const g = game();
    const me = g.sim.state.run.playerId;
    setDay(g, 4);
    const holy = todayModel(g, me)!;
    expect(holy.headline).toBe('Holy day');
    expect(holy.blurb).toMatch(/Mass/);
    expect(holy.dateLine).toMatch(/Day 4 of 4/);
    const kinds = new Set<string>();
    for (let d = 1; d <= 4; d++) { setDay(g, d); kinds.add(todayModel(g, me)!.headline.replace(/ at .*/, '')); }
    expect(kinds.has('Holy day')).toBe(true);
    expect(kinds.has('A working day')).toBe(true);
  });

  it('lists the family plan with you in it, the sun, and what is open', () => {
    const g = game();
    const m = todayModel(g, g.sim.state.run.playerId)!;
    expect(m.plan.some((p) => p.you && p.name === 'You')).toBe(true);
    expect(m.plan.some((p) => p.head)).toBe(true);
    expect(m.sunrise).toMatch(/^\d\d:\d\d$/);
    expect(m.sunset).toMatch(/^\d\d:\d\d$/);
    expect(m.open.some((o) => o.label === 'Mass')).toBe(true);
  });

  it('has words for every household task', () => {
    for (const t of ['fields', 'garden', 'livestock', 'craft', 'brew', 'spin', 'market', 'wood', 'service', 'school', 'play', 'rest', 'auto'] as const) {
      expect(taskWords(t).length).toBeGreaterThan(3);
    }
  });
});

describe('People you know', () => {
  it('lists the household and the family with how they are related, and sorts by group', () => {
    const g = game();
    const me = g.sim.state.run.playerId;
    const rows = peopleRows(g, me);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.id !== me)).toBe(true);
    const order = PERSON_GROUPS.map((x) => x.id);
    const idx = rows.map((r) => order.indexOf(r.group));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    // the household is there, with a relation word and a place
    const p = g.sim.state.persons.get(me)!;
    const hh = g.sim.state.households.get(p.household)!;
    const kin = rows.filter((r) => hh.members.includes(r.id));
    expect(kin.length).toBe(hh.members.filter((m) => m !== me && !g.sim.state.persons.get(m)?.death).length);
    for (const r of kin) {
      expect(r.name.length).toBeGreaterThan(2);
      expect(r.where.length).toBeGreaterThan(2);
    }
    expect(rows.some((r) => /father|mother/.test(r.relation))).toBe(true);
  });

  it('says where someone is now, close by or away', () => {
    const g = game();
    const me = g.sim.state.run.playerId;
    const b = g.player.body()!;
    const first = peopleRows(g, me)[0];
    g.fake.addAgent(first.id, b.x + 30, b.z);
    const near = peopleRows(g, me).find((r) => r.id === first.id)!;
    expect(near.inZone).toBe(true);
    expect(near.where).toMatch(/\d+ m/);
    expect(near.x).toBeCloseTo(b.x + 30, 0);
  });
});

describe('Places', () => {
  it('starts with your home and finds the church and the well of the village when there are some', () => {
    const g = game();
    const rows = placeRows(g, g.sim.state.run.playerId);
    expect(rows[0].name).toBe('Your home');
    expect(rows[0].group).toBe('yours');
    for (const r of rows) {
      expect(Number.isFinite(r.x)).toBe(true);
      expect(Number.isFinite(r.z)).toBe(true);
      expect(r.sub.length).toBeGreaterThan(2);
    }
    const names = rows.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('Places from the objectives module', () => {
  it('takes the module\u2019s list and its names, so the journal and the tracker call a place the same thing', () => {
    const g = game();
    const listed = g.objectives!.places!();
    expect(listed.length).toBeGreaterThan(2);
    const rows = placeRows(g, g.sim.state.run.playerId);
    expect(rows.map((r) => r.name)).toEqual(listed.map((t) => t.label));
    for (const r of rows) { expect(r.target).toBeDefined(); expect(r.sub.length).toBeGreaterThan(2); }
    // what is yours is set apart from what is the village\u2019s
    expect(rows.filter((r) => r.group === 'yours').every((r) => /^Your/.test(r.name))).toBe(true);
    expect(rows.some((r) => r.group === 'village')).toBe(true);
  });

  it('falls back to its own list when the module has none (an older module, a fake)', () => {
    const g = game();
    const bare = { list: () => [], tracked: () => null, track: () => {}, suggestions: () => [], daySummary: () => null, trackPerson: () => {} };
    const rows = placeRows({ ...g, objectives: bare }, g.sim.state.run.playerId);
    expect(rows[0].name).toBe('Your home');
    expect(rows.every((r) => r.target === undefined)).toBe(true);
  });
});

describe('The intro card', () => {
  it('opens with the season, where you wake and what the first task is, and names three places to visit', () => {
    const g = game();
    const m = introModel(g)!;
    expect(m.title).toMatch(/Spring|Summer|Autumn|Winter/);
    expect(m.paragraphs[0]).toMatch(/You wake in your/);
    const settlement = g.sim.world.settlements.find((s) => s.id === g.sim.state.persons.get(g.sim.state.run.playerId)!.settlement)!;
    expect(m.paragraphs[0]).toContain(settlement.name);
    expect(m.paragraphs.join(' ')).toMatch(/top left corner/);
    expect(m.spots[0].kind).toBe('home');
    expect(m.spots[0].label).toBe('Your home');
    for (const s of m.spots) { expect(Number.isFinite(s.x)).toBe(true); expect(s.caption.length).toBeGreaterThan(10); }
  });

  it('uses the module\u2019s own opening line when it has one, and tells what kind of place it is', () => {
    const g = game();
    const m = introModel(g)!;
    expect(m.paragraphs[0]).toBe(g.objectives!.intro!());
    const settlement = g.sim.world.settlements.find((s) => s.id === g.sim.state.persons.get(g.sim.state.run.playerId)!.settlement)!;
    expect(m.paragraphs[1]).toContain(settlement.name);
  });

  it('writes the opening itself when the module has no line', () => {
    const g = game();
    const bare = { list: () => [], tracked: () => null, track: () => {}, suggestions: () => [], daySummary: () => null, trackPerson: () => {} };
    const m = introModel({ ...g, objectives: bare })!;
    expect(m.paragraphs[0]).toMatch(/^(Spring|Summer|Autumn|Winter)\. You wake in your/);
  });

  it('takes the reason for the tracked task into the story', () => {
    const g = game();
    const m = introModel(g)!;
    expect(m.paragraphs.join(' ')).toContain(g.objectives!.tracked()!.why);
  });
});

describe('The tour camera', () => {
  it('stands on the player\u2019s side at about the asked distance, and steps round a house that is in the way', () => {
    const g = game();
    const st = g.sim.state;
    const me = st.persons.get(st.run.playerId)!;
    const home = st.buildings.get(st.households.get(me.household)!.home)!;
    const spot = { x: home.x, z: home.z };
    const from = { x: home.x + 60, z: home.z };
    const open = tourViewpoint(g, spot, from, 20);
    // no buildings: straight out on the player's side
    expect(Math.hypot(open.x - spot.x, open.z - spot.z)).toBeGreaterThan(15);
    expect(Math.hypot(open.x - spot.x, open.z - spot.z)).toBeLessThan(26);
    // wherever it stands, no building of the place is within a few metres of it (the home itself aside)
    const list = st.buildingsAt.get(me.settlement) ?? [];
    for (const b of list) {
      if (Math.hypot(b.x - spot.x, b.z - spot.z) < 8) continue;
      expect(Math.hypot(b.x - open.x, b.z - open.z)).toBeGreaterThan(2.5);
    }
    // with nobody to stand next to, it still chooses somewhere
    expect(Number.isFinite(tourViewpoint(g, spot, null, 20).x)).toBe(true);
  });
});

describe('The stand-in objectives', () => {
  it('walks the first-day chain from events: speak, water, work the strip, sleep', () => {
    const r = rig({ preset: 'small' });
    const o = new MockObjectives(r.sim, r.zone);
    const first = o.tracked()!;
    expect(first.source).toBe('tutorial');
    expect(first.steps.length).toBe(4);
    const phases: string[] = [];
    r.sim.events.on('objective', (e) => phases.push(e.phase));
    o.advance();
    expect(first.steps[0].done).toBe(true);
    o.advance(); o.advance(); o.advance();
    expect(first.state).toBe('done');
    expect(phases).toContain('done');
    expect(o.tracked()?.id).not.toBe(first.id);
  });

  it('suggests the tracked step first and writes a day summary when the day ends', () => {
    const r = rig({ preset: 'small' });
    const o = new MockObjectives(r.sim, r.zone);
    const s = o.suggestions(3);
    expect(s.length).toBeGreaterThan(0);
    expect(s[0].objective).toBe(o.tracked()!.id);
    expect(o.daySummary()).toBeNull();
    let ended = -1;
    r.sim.events.on('dayEnd', (e) => { ended = e.day; });
    o.endDay();
    expect(o.daySummary()?.day).toBe(ended);
    expect(o.daySummary(ended + 5)).toBeNull();
  });

  it('marks a found person and a found place in the world markers, and counts every change', () => {
    const r = rig({ preset: 'small' });
    const o = new MockObjectives(r.sim, r.zone);
    const me = r.sim.state.run.playerId;
    const other = r.sim.state.households.get(r.sim.state.persons.get(me)!.household)!.members.find((id) => id !== me)!;
    const v0 = o.version();
    o.trackPerson(other);
    expect(o.found().person).toBe(other);
    expect(o.version()).toBeGreaterThan(v0);
    expect(r.sim.view.worldMarkers!().some((m) => m.kind === 'person')).toBe(true);
    o.trackPlace({ kind: 'place', id: -1, x: 5, z: 6, label: 'There' });
    expect(r.sim.view.worldMarkers!().find((m) => m.kind === 'place')).toMatchObject({ x: 5, z: 6, label: 'There' });
    o.trackPlace(null); o.trackPerson(0);
    expect(o.found()).toEqual({ person: 0, place: null });
    expect(r.sim.view.worldMarkers!().some((m) => m.kind === 'person' || m.kind === 'place')).toBe(false);
  });

  it('feeds the world markers: the tracked step is the primary one', () => {
    const r = rig({ preset: 'small' });
    const o = new MockObjectives(r.sim, r.zone);
    const markers = r.sim.view.worldMarkers!();
    expect(markers.some((m) => m.primary && m.kind === 'objective')).toBe(true);
    o.dispose();
    expect(r.sim.view.worldMarkers!().length).toBe(0);
  });
});
