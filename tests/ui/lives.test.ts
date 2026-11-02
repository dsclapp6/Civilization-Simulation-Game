// Civilization pass, B6 (lives UI): living as anyone, the way across (glide or fade), quest marks, the steps of hands-on work.
// The pure models run against a real simulation (mock world) with a fake zone.
import { describe, expect, it } from 'vitest';
import type { MarkedPerson } from '../../src/agents/types';
import { fullName, type Person, type PersonId } from '../../src/sim/state';
import type { ActionStep } from '../../src/sim/actions';
import { MockObjectives } from '../../src/ui/dev/mockObjectives';
import {
  GLIDE_MAX_DISTANCE, GLIDE_SECONDS, FADE_HOLD_SECONDS, FADE_IN_SECONDS, FADE_OUT_SECONDS,
  PeopleIndex, doingWords, liveAsCard, liveAsReason, liveAsTarget, nearbyPeople, personSummary, switchKind, whoNowCard,
} from '../../src/ui/core/liveAsModel';
import { COMPASS_RANGE, MARK_COLOR, MARK_GLYPH, QuestMarkView, defaultMarkText } from '../../src/ui/core/questMarks';
import { CUE_SOUND, cueSound, type CueSound } from '../../src/ui/core/soundModel';
import { CueScheduler, stepAt, stepLine } from '../../src/ui/core/stepModel';
import { SwitchFx, followPoseBehind } from '../../src/ui/core/switchfx';
import { honorific, styledFirst, styledName } from '../../src/ui/core/titles';
import type { GameServices } from '../../src/ui/types';
import { rig, type FakeZone } from '../player/fakes';

function game(): GameServices & { fake: FakeZone } {
  const r = rig({ preset: 'small' });
  const objectives = new MockObjectives(r.sim, r.zone);
  return { sim: r.sim, economy: r.economy, social: r.social, zone: r.zone, player: r.player, objectives, fake: r.zone };
}

function someoneElse(g: GameServices, test: (p: Person) => boolean = () => true): Person {
  const me = g.sim.state.run.playerId;
  for (const p of g.sim.state.persons.values()) if (!p.death && p.id !== me && test(p)) return p;
  throw new Error('nobody');
}

describe('titles', () => {
  it('calls a knight Sir, and nobody else', () => {
    const knight = { first: 'Godwin', byname: 'Smith', sex: 'm', career: 'knight' } as const;
    expect(honorific(knight)).toBe('Sir');
    expect(styledName(knight)).toBe('Sir Godwin Smith');
    expect(styledFirst(knight)).toBe('Sir Godwin');
    expect(styledName({ ...knight, career: 'smith' })).toBe('Godwin Smith');
    expect(styledName({ ...knight, sex: 'f' })).toBe('Godwin Smith');
    expect(styledName({ first: 'Hugh', byname: '', sex: 'm', career: 'knight' })).toBe('Sir Hugh');
  });
});

describe('living as anyone: who, and what the card says', () => {
  it('reads the reason from the request data', () => {
    expect(liveAsReason({ reason: 'rule' })).toBe('rule');
    expect(liveAsReason({ reason: 'choose' })).toBe('choose');
    expect(liveAsReason(undefined)).toBe('choose');
    expect(liveAsReason('rule')).toBe('choose');
  });

  it('takes the person given, else the one under the cursor, else the one in front', () => {
    const stub = (hover: unknown, front: unknown): Pick<GameServices, 'player'> => ({ player: { hover: () => hover, target: () => front } as unknown as GameServices['player'] });
    expect(liveAsTarget(stub(null, null), 42)).toEqual({ id: 42, via: 'given' });
    const hov = { target: { kind: 'person', id: 7 } };
    const front = { target: { kind: 'person', id: 9 } };
    expect(liveAsTarget(stub(hov, front))).toEqual({ id: 7, via: 'cursor' });
    expect(liveAsTarget(stub(null, front))).toEqual({ id: 9, via: 'front' });
    expect(liveAsTarget(stub({ target: { kind: 'strip', id: 1 } }, { target: { kind: 'building', id: 2 } }))).toBeNull();
    expect(liveAsTarget(stub(undefined, null))).toBeNull();
    expect(liveAsTarget(stub(null, null), 0)).toBeNull();
  });

  it('says in words what a person is doing', () => {
    expect(doingWords('Digging the garden', 'work')).toBe('digging the garden');
    expect(doingWords('', 'sleep')).toBe('asleep');
    expect(doingWords(undefined, undefined)).toBe('about their day');
  });

  it('describes a person: name, age, role, place, household, House', () => {
    const g = game();
    const other = someoneElse(g, (p) => p.household !== g.sim.state.persons.get(g.sim.state.run.playerId)!.household);
    const s = personSummary(g, other.id)!;
    expect(s.name).toContain(other.first);
    expect(s.age).toBeGreaterThanOrEqual(0);
    expect(s.role.length).toBeGreaterThan(1);
    expect(s.place.length).toBeGreaterThan(1);
    expect(s.household).toMatch(/soul/);
    expect(s.alive).toBe(true);
    expect(s.isPlayer).toBe(false);
    expect(personSummary(g, 99999999)).toBeNull();
  });

  it('measures how far they are when the zone knows where they stand', () => {
    const g = game();
    const other = someoneElse(g);
    const body = g.player.body()!;
    g.fake.addAgent(other.id, body.x + 30, body.z + 40);
    expect(personSummary(g, other.id)!.distance).toBeCloseTo(50, 3);
  });

  it('lets you live as anyone alive but yourself', () => {
    const g = game();
    const me = g.sim.state.run.playerId;
    const self = liveAsCard(g, me, 'choose')!;
    expect(self.canSwitch).toBe(false);
    expect(self.why).toMatch(/already/);
    const other = someoneElse(g);
    const card = liveAsCard(g, other.id, 'choose')!;
    expect(card.canSwitch).toBe(true);
    expect(card.why).toBe('');
    // not family, not of the House: still allowed (SPEC §8 changed)
    const stranger = someoneElse(g, (p) => p.house !== g.sim.state.persons.get(me)!.house && p.settlement !== g.sim.state.persons.get(me)!.settlement);
    expect(liveAsCard(g, stranger.id, 'choose')!.canSwitch).toBe(true);
    // the dead cannot be taken up
    stranger.death = { day: 1, cause: 'illness' };
    expect(liveAsCard(g, stranger.id, 'choose')).not.toBeNull();
    expect(liveAsCard(g, stranger.id, 'choose')!.canSwitch).toBe(false);
  });

  it('for "Rule this town" the card asks the realm what they rule, and refuses someone who rules nothing', () => {
    const g = game();
    const other = someoneElse(g);
    const ruled = new Map<PersonId, string>([[other.id, 'the manor of Dromore']]);
    const realm = {
      canRule: (id: PersonId) => ruled.has(id),
      view: (id: PersonId) => (ruled.has(id) ? { name: ruled.get(id), role: 'holder' } : null),
      rules: () => [],
    };
    const withRealm = { ...g, realm } as unknown as GameServices;
    const card = liveAsCard(withRealm, other.id, 'rule')!;
    expect(card.canRule).toBe(true);
    expect(card.canSwitch).toBe(true);
    expect(card.ruleLine).toBe('rules the manor of Dromore');
    const nobody = someoneElse(g, (p) => p.id !== other.id);
    const no = liveAsCard(withRealm, nobody.id, 'rule')!;
    expect(no.canSwitch).toBe(false);
    expect(no.why).toMatch(/rules nothing/);
    // a steward keeps it for the lord
    realm.view = (id: PersonId) => (ruled.has(id) ? { name: 'Dromore', role: 'steward' } : null);
    expect(liveAsCard(withRealm, other.id, 'rule')!.ruleLine).toMatch(/^keeps Dromore/);
  });

  it('describes who you are now, with the tasks the objectives set up', () => {
    const g = game();
    const me = g.sim.state.run.playerId;
    const card = whoNowCard(g, me, 'taking the air')!;
    expect(card.doing).toBe('taking the air');
    expect(card.name).toBe(fullName(g.sim.state.persons.get(me)!));
    expect(card.tasks.length).toBeGreaterThan(0);
    expect(card.tasks.length).toBeLessThanOrEqual(4);
    expect(card.tasks[0].title.length).toBeGreaterThan(3);
    // no objectives module: no tasks, no failure
    expect(whoNowCard({ ...g, objectives: undefined }, me)!.tasks).toEqual([]);
  });

  it('chooses a glide within 300 m when the camera can be posed, else a fade', () => {
    expect(GLIDE_MAX_DISTANCE).toBe(300);
    expect(switchKind(0, true)).toBe('glide');
    expect(switchKind(299.9, true)).toBe('glide');
    expect(switchKind(300, true)).toBe('glide');
    expect(switchKind(300.1, true)).toBe('fade');
    expect(switchKind(20, false)).toBe('fade');
    expect(switchKind(null, true)).toBe('fade');
    expect(switchKind(NaN, true)).toBe('fade');
  });
});

describe('the death screen: anyone alive', () => {
  it('finds people by name, place and role, best matches first, never the dead or the excluded', () => {
    const g = game();
    const idx = new PeopleIndex(g);
    expect(idx.size).toBe([...g.sim.state.persons.values()].filter((p) => !p.death).length);
    expect(idx.search('')).toEqual([]);
    expect(idx.search('   ')).toEqual([]);
    const target = someoneElse(g);
    const hits = idx.search(target.first, 50);
    expect(hits.some((h) => h.id === target.id)).toBe(true);
    for (const h of hits) expect(`${h.name} ${h.place} ${h.role}`.toLowerCase()).toContain(target.first.toLowerCase());
    // a name that starts with the word comes before one that merely contains it
    const firstStarts = hits.findIndex((h) => h.first.toLowerCase().startsWith(target.first.toLowerCase()));
    expect(firstStarts).toBe(0);
    // every word must match
    const both = idx.search(`${target.first} ${target.byname || target.first}`, 50);
    expect(both.some((h) => h.id === target.id)).toBe(true);
    expect(idx.search('zzzzqq')).toEqual([]);
    // limits and exclusions
    expect(idx.search(target.first, 2).length).toBeLessThanOrEqual(2);
    expect(idx.search(target.first, 50, { exclude: new Set([target.id]) }).some((h) => h.id === target.id)).toBe(false);
    // by place and by role
    const placeName = g.sim.world.settlements.find((s) => s.id === target.settlement)!.name;
    expect(idx.search(placeName.toLowerCase(), 5).every((h) => h.place.toLowerCase().includes(placeName.toLowerCase()) || h.name.toLowerCase().includes(placeName.toLowerCase()) || h.role.toLowerCase().includes(placeName.toLowerCase()))).toBe(true);
    // a fresh index does not list a person who has died since
    target.death = { day: 1, cause: 'illness' };
    expect(new PeopleIndex(g).search(target.first, 500).some((h) => h.id === target.id)).toBe(false);
  });

  it('names the people near the place of death, then the notable residents', () => {
    const g = game();
    const me = g.sim.state.persons.get(g.sim.state.run.playerId)!;
    const folk = [...g.sim.state.persons.values()].filter((p) => !p.death && p.id !== me.id && p.settlement === me.settlement).slice(0, 4);
    const body = g.player.body()!;
    folk.forEach((p, i) => g.fake.addAgent(p.id, body.x + 10 * (i + 1), body.z));
    const near = nearbyPeople(g, { x: body.x, z: body.z }, me.settlement, 3);
    expect(near.length).toBe(3);
    expect(near.map((n) => n.id)).toEqual(folk.slice(0, 3).map((p) => p.id));
    // without the zone the residents of the place fill the list, highest rank first
    const bare = nearbyPeople(g, null, me.settlement, 5, new Set([me.id]));
    expect(bare.length).toBeGreaterThan(0);
    for (let i = 1; i < bare.length; i++) expect(bare[i - 1].rankTier).toBeGreaterThanOrEqual(bare[i].rankTier);
    expect(bare.some((b) => b.id === me.id)).toBe(false);
  });
});

describe('the way across', () => {
  const pose = (d: number, pitch = 0.3, yaw = 0, at = { x: 100, y: 12, z: 100 }): { position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } } => ({
    lookAt: { x: at.x, y: at.y + 1.55, z: at.z },
    position: { x: at.x - Math.sin(yaw) * Math.cos(pitch) * d, y: at.y + 1.55 + Math.sin(pitch) * d, z: at.z - Math.cos(yaw) * Math.cos(pitch) * d },
  });

  it('puts the camera behind the new body with the same boom, looking where it faces', () => {
    const cur = pose(8, 0.3);
    const next = followPoseBehind(cur, { x: 200, y: 20, z: 300 }, Math.PI / 2)!;
    expect(next.lookAt).toEqual({ x: 200, y: 21.55, z: 300 });
    const off = { x: next.position.x - next.lookAt.x, y: next.position.y - next.lookAt.y, z: next.position.z - next.lookAt.z };
    expect(Math.hypot(off.x, off.y, off.z)).toBeCloseTo(8, 6);
    expect(off.y).toBeCloseTo(8 * Math.sin(0.3), 6);
    // behind a body that faces +x is to its west
    expect(off.x).toBeLessThan(0);
    expect(Math.abs(off.z)).toBeLessThan(1e-9);
    // facing +z, behind is to the north (−z)
    const north = followPoseBehind(cur, { x: 0, y: 0, z: 0 }, 0)!;
    expect(north.position.z).toBeLessThan(0);
    expect(Math.abs(north.position.x)).toBeLessThan(1e-9);
  });

  it('keeps a sane boom and does not glide a strategic map camera', () => {
    const tiny = followPoseBehind(pose(0.5, 0.2), { x: 0, y: 0, z: 0 }, 0)!;
    expect(Math.hypot(tiny.position.x - tiny.lookAt.x, tiny.position.y - tiny.lookAt.y, tiny.position.z - tiny.lookAt.z)).toBeGreaterThanOrEqual(2.2 - 1e-9);
    expect(followPoseBehind(pose(2600, 1), { x: 0, y: 0, z: 0 }, 0)).toBeNull();
    expect(followPoseBehind(pose(8), { x: NaN, y: 0, z: 0 }, 0)).toBeNull();
    // a pitch the follow camera could never have is brought back into its range
    const steep = followPoseBehind(pose(8, 1.55), { x: 0, y: 0, z: 0 }, 0)!;
    expect(steep.position.y - steep.lookAt.y).toBeLessThanOrEqual(8 * Math.sin(1.45) + 1e-9);
  });

  it('fades out, cuts, holds and fades in on its own clock', () => {
    const fx = new SwitchFx();
    expect(fx.active).toBe(false);
    expect(fx.veil).toBe(0);
    fx.start('fade');
    expect(fx.active).toBe(true);
    expect(fx.step(FADE_OUT_SECONDS / 2)).toEqual([]);
    expect(fx.veil).toBeGreaterThan(0.3);
    expect(fx.veil).toBeLessThan(0.7);
    expect(fx.step(FADE_OUT_SECONDS / 2 + 0.001)).toEqual(['cut']);
    expect(fx.veil).toBe(1);
    expect(fx.phase).toBe('hold');
    expect(fx.step(FADE_HOLD_SECONDS)).toEqual([]);
    expect(fx.phase).toBe('in');
    expect(fx.step(FADE_IN_SECONDS / 2)).toEqual([]);
    expect(fx.veil).toBeLessThan(0.7);
    expect(fx.step(FADE_IN_SECONDS)).toEqual(['done']);
    expect(fx.active).toBe(false);
    expect(fx.veil).toBe(0);
  });

  it('survives one huge step: cut and done in the right order', () => {
    const fx = new SwitchFx();
    fx.start('fade');
    expect(fx.step(10)).toEqual(['cut', 'done']);
    expect(fx.active).toBe(false);
  });

  it('runs a glide for its seconds with the screen clear, and can be cancelled', () => {
    const fx = new SwitchFx();
    fx.start('glide');
    expect(fx.phase).toBe('glide');
    expect(fx.veil).toBe(0);
    expect(fx.step(GLIDE_SECONDS - 0.1)).toEqual([]);
    expect(fx.step(0.2)).toEqual(['done']);
    expect(fx.active).toBe(false);
    fx.start('glide');
    fx.cancel();
    expect(fx.step(5)).toEqual([]);
  });
});

describe('quest marks in the HUD', () => {
  it('lists the marked people from the zone and the words from the objectives, nearest first', () => {
    const g = game();
    const folk = [...g.sim.state.persons.values()].filter((p) => !p.death && p.id !== g.sim.state.run.playerId).slice(0, 3);
    const marked: MarkedPerson[] = [
      { person: folk[0].id, kind: 'quest', x: 130, z: 100, inZone: true, indoors: false },
      { person: folk[1].id, kind: 'turnin', x: 100, z: 160, inZone: false, indoors: true },
      { person: folk[2].id, kind: 'quest', x: 500, z: 500, inZone: false, indoors: false },
    ];
    (g.zone as { markedPeople?: () => MarkedPerson[] }).markedPeople = () => marked;
    (g.objectives as unknown as { marks: () => unknown[] }).marks = () => [
      { person: folk[0].id, kind: 'quest', text: `${folk[0].first} wants 7 bundles of firewood`, objective: 5 },
      { person: folk[1].id, kind: 'turnin', text: `Hand the firewood to ${folk[1].first}`, objective: 5 },
    ];
    const view = new QuestMarkView();
    const rows = view.update(g, { x: 100, z: 100 }, 1);
    expect(rows.map((r) => r.person)).toEqual(folk.map((p) => p.id));
    expect(rows[0].text).toBe(`${folk[0].first} wants 7 bundles of firewood`);
    expect(rows[0].dist).toBeCloseTo(30, 6);
    expect(rows[0].objective).toBe(5);
    expect(rows[1].kind).toBe('turnin');
    expect(rows[1].indoors).toBe(true);
    expect(rows[1].text).toContain('Hand the firewood');
    // a mark the objectives module has not spoken of gets a plain line
    expect(rows[2].text).toBe(defaultMarkText(fullName(folk[2]), 'quest'));
    expect(rows[2].dist).toBeGreaterThan(COMPASS_RANGE);
    expect(view.rowFor(folk[1].id)!.kind).toBe('turnin');
    expect(view.rowFor(123456789)).toBeUndefined();
    const sorted = view.sorted();
    expect(sorted.map((r) => r.dist)).toEqual([...sorted.map((r) => r.dist)].sort((a, b) => a - b));
  });

  it('reuses its rows between frames, and picks up changes of the words twice a second', () => {
    const g = game();
    const p = [...g.sim.state.persons.values()].find((q) => !q.death && q.id !== g.sim.state.run.playerId)!;
    (g.zone as { markedPeople?: () => MarkedPerson[] }).markedPeople = () => [{ person: p.id, kind: 'quest', x: 10, z: 10, inZone: true, indoors: false }];
    let text = 'first';
    (g.objectives as unknown as { marks: () => unknown[] }).marks = () => [{ person: p.id, kind: 'quest', text, objective: 1 }];
    const view = new QuestMarkView();
    const a = view.update(g, { x: 0, z: 0 }, 0)[0];
    text = 'second';
    expect(view.update(g, { x: 0, z: 0 }, 0.2)[0]).toBe(a);
    expect(a.text).toBe('first');
    view.update(g, { x: 0, z: 0 }, 0.6);
    expect(a.text).toBe('second');
  });

  it('without markedPeople it places the objectives’ marks by the zone, and survives having neither', () => {
    const g = game();
    const p = [...g.sim.state.persons.values()].find((q) => !q.death && q.id !== g.sim.state.run.playerId)!;
    g.fake.addAgent(p.id, 40, 30);
    (g.objectives as unknown as { marks: () => unknown[] }).marks = () => [{ person: p.id, kind: 'turnin', text: 'Give it to them', objective: 2 }];
    const view = new QuestMarkView();
    const rows = view.update(g, { x: 0, z: 0 }, 0);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ person: p.id, kind: 'turnin', inZone: true, text: 'Give it to them' });
    expect(rows[0].dist).toBeCloseTo(50, 6);
    expect(new QuestMarkView().update({ ...g, objectives: undefined }, { x: 0, z: 0 }, 0)).toEqual([]);
  });

  it('draws "!" in gold and "?" in silver', () => {
    expect(MARK_GLYPH).toEqual({ quest: '!', turnin: '?' });
    expect(MARK_COLOR.quest).not.toBe(MARK_COLOR.turnin);
    expect(COMPASS_RANGE).toBe(150);
  });
});

describe('the steps of hands-on work', () => {
  const forge: ActionStep[] = [
    { share: 0.25, label: 'Heat the bar', sfx: 'bellows' },
    { share: 0.4, label: 'Draw it out', sfx: 'hammer' },
    { share: 0.15, label: 'Quench', sfx: 'quench' },
    { share: 0.2, label: 'Grind and hilt', sfx: 'grind' },
  ];

  it('finds the step a bout is in from its progress (cumulative shares)', () => {
    expect(stepAt(undefined, 0.5)).toBeNull();
    expect(stepAt([], 0.5)).toBeNull();
    expect(stepAt(forge, 0)!.label).toBe('Heat the bar');
    expect(stepAt(forge, 0.2499)!.label).toBe('Heat the bar');
    expect(stepAt(forge, 0.25)!.label).toBe('Draw it out');
    expect(stepAt(forge, 0.64)!.label).toBe('Draw it out');
    expect(stepAt(forge, 0.65)!.label).toBe('Quench');
    expect(stepAt(forge, 0.8)!.label).toBe('Grind and hilt');
    expect(stepAt(forge, 1)!.label).toBe('Grind and hilt');
    expect(stepAt(forge, 7)!.index).toBe(3);
    expect(stepAt(forge, -1)!.index).toBe(0);
    expect(stepAt(forge, NaN)!.index).toBe(0);
    const mid = stepAt(forge, 0.45)!;
    expect(mid.index).toBe(1);
    expect(mid.count).toBe(4);
    expect(mid.from).toBeCloseTo(0.25, 9);
    expect(mid.to).toBeCloseTo(0.65, 9);
    expect(mid.within).toBeCloseTo(0.5, 9);
    expect(stepLine(mid)).toBe('Draw it out · step 2 of 4');
    expect(stepLine(stepAt([{ share: 1, label: 'Dig' }], 0.3)!)).toBe('Dig');
  });

  it('reads shares as proportions, and equal steps when none say', () => {
    const odd = [{ share: 2, label: 'a' }, { share: 2, label: 'b' }];
    expect(stepAt(odd, 0.49)!.label).toBe('a');
    expect(stepAt(odd, 0.51)!.label).toBe('b');
    const none = [{ share: 0, label: 'a' }, { share: 0, label: 'b' }, { share: 0, label: 'c' }];
    expect(stepAt(none, 0.5)!.label).toBe('b');
  });

  it('has a sound for every cue the economy names, and none for what it does not', () => {
    for (const cue of ['bellows', 'hammer', 'quench', 'saw', 'chop', 'cut', 'dig', 'stir', 'fire', 'grind', 'scrape', 'knead']) {
      const c = cueSound(cue);
      expect(c, cue).not.toBeNull();
      expect(c!.gain).toBeGreaterThan(0);
      expect(c!.gain).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(CUE_SOUND)).toHaveLength(12);
    expect(cueSound('trumpet')).toBeNull();
    expect(cueSound(undefined)).toBeNull();
    // quenching and fire sound once; the tool's strokes repeat
    expect(CUE_SOUND.quench.period).toBeUndefined();
    expect(CUE_SOUND.fire.period).toBeUndefined();
    expect(CUE_SOUND.hammer.period).toBeGreaterThan(0.3);
  });

  it('sounds each step’s cue once as the bout enters it, with the strokes of a rhythmic one in between', () => {
    const s = new CueScheduler();
    const out: CueSound[] = [];
    const played: string[] = [];
    let now = 0;
    const tick = (progress: number): void => { s.update('craft/sword', forge, progress, now, out); for (const c of out) played.push(`${now.toFixed(1)}:${c.sfx}`); };
    // 12 seconds of bout, a frame every 0.1 s
    for (let i = 0; i < 120; i++) { now = i * 0.1; tick(i / 120); }
    const sfx = played.map((p) => p.split(':')[1]);
    // each step's cue first, in order
    const first = (name: string): number => sfx.indexOf(name);
    expect(first('bellows')).toBe(0);
    expect(first('bellows')).toBeLessThan(first('clank'));
    expect(first('clank')).toBeLessThan(first('quench'));
    expect(first('quench')).toBeLessThan(first('grind'));
    // quench once; the hammer's 4.8 s step carries strokes
    expect(sfx.filter((n) => n === 'quench')).toHaveLength(1);
    expect(sfx.filter((n) => n === 'clank').length).toBeGreaterThan(2);
    // nothing sounds twice in the same frame
    expect(new Set(played).size).toBe(played.length);
  });

  it('starts the cues again when the next bout begins, and when the option changes', () => {
    const s = new CueScheduler();
    const out: CueSound[] = [];
    const bout = (key: string, steps: ActionStep[], from: number): number => {
      let n = 0;
      for (let i = 0; i < 10; i++) { s.update(key, steps, i / 10, from + i * 0.05, out); n += out.length; }
      return n;
    };
    const one: ActionStep[] = [{ share: 1, label: 'Quench', sfx: 'quench' }];
    expect(bout('a', one, 0)).toBe(1);
    expect(bout('a', one, 1)).toBe(1); // the repeat: progress fell back, the cue sounds again
    expect(bout('b', one, 2)).toBe(1);
    // an option without steps (or a step without a cue) is silent and resets
    s.update('a', undefined, 0.5, 5, out);
    expect(out).toEqual([]);
    s.update('a', [{ share: 1, label: 'Wait' }], 0.1, 6, out);
    expect(out).toEqual([]);
  });
});
