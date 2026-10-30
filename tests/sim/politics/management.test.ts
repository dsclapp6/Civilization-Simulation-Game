// Management by authority (SPEC §7): exactly what the titles one holds allow, grants and revocation,
// petitions, and the ways the player meets politics (an action on himself, conversation topics).
import { describe, expect, it } from 'vitest';
import { politicsActions, politicsTopics } from '../../../src/sim/politics/talk';
import type { Conversation, DialogueOption } from '../../../src/sim/social/types';
import type { ActionOption } from '../../../src/sim/actions';
import { makePlayer, mkHousehold, mkPerson } from '../builders';
import { holderOf, housesHolding, noble, rig, titlesOfKind } from './helpers';

describe('authority', () => {
  it('lists what a person commands by the titles he holds', () => {
    const r = rig({ preset: 'small' });
    const king = r.x.core.headOf(housesHolding(r.sim, 'kingdom')[0])!;
    const a = r.pol.authority(king.id);
    expect(a.kingdoms.length).toBe(1);
    expect(a.counties.length).toBeGreaterThanOrEqual(1);
    expect(a.household).toBe(true);
    const knightTitle = titlesOfKind(r.sim, 'manor')[0];
    const knight = holderOf(r.sim, knightTitle);
    const k = r.pol.authority(knight.id);
    expect(k.manors).toContain(knightTitle.id);
    expect(k.kingdoms).toEqual([]);
    expect(k.baronies).toEqual([]);
    // a peasant commands only himself and his household
    const hh = mkHousehold(r.sim);
    const peasant = mkPerson(r.sim, { household: hh.id, age: 35 });
    r.sim.state.setHead(hh, peasant);
    expect(r.pol.authority(peasant.id)).toMatchObject({ household: true, manors: [], counties: [], kingdoms: [] });
  });

  it('only the lord of a manor sets its rents, labour and justice; only the crown makes the laws', () => {
    const r = rig({ preset: 'small' });
    const t = titlesOfKind(r.sim, 'manor')[0];
    const lord = holderOf(r.sim, t);
    const stranger = mkPerson(r.sim, { age: 40 });
    expect(r.pol.setManorPolicy(stranger.id, t.place, { rent: 1 }).ok).toBe(false);
    const honour = lord.rep.cruelty;
    expect(r.pol.setManorPolicy(lord.id, t.place, { rent: 2, justice: 'harsh' }).ok).toBe(true);
    expect(r.pol.manorPolicy(t.place)).toMatchObject({ rent: 2, justice: 'harsh', labour: 0 });
    expect(lord.rep.cruelty).toBeGreaterThan(honour);
    expect(r.pol.setManorPolicy(lord.id, t.place, { rent: 7 as never }).ok).toBe(false);

    const kt = titlesOfKind(r.sim, 'kingdom')[0];
    const king = holderOf(r.sim, kt);
    expect(r.pol.setRealmLaw(lord.id, kt.place, { tax: 3 }).ok).toBe(false);
    expect(r.pol.setRealmLaw(king.id, kt.place, { tax: 3, privateWar: true }).ok).toBe(true);
    expect(r.pol.realmLaws(kt.place)).toEqual({ privateWar: true, tax: 3 });
    expect(r.pol.setRealmLaw(king.id, kt.place, { tax: 9 as never }).ok).toBe(false);
    // the law governs what barons may do
    const foes = r.pol.vassalsOf(king.house).filter((h) => r.x.core.titlesOfHouse(h).some((x) => x.kind === 'county'));
    if (foes.length >= 2) {
      expect(r.pol.canDeclare(foes[0], foes[1], 'conquest').reason ?? '').not.toMatch(/law of the realm/);
      r.pol.setRealmLaw(king.id, kt.place, { privateWar: false });
      expect(r.pol.canDeclare(foes[0], foes[1], 'conquest').reason).toMatch(/law of the realm/);
    }
  });

  it('a liege grants a fief to a worthy knight and may strip it from a vassal', () => {
    const r = rig({ preset: 'small' });
    const kt = titlesOfKind(r.sim, 'kingdom')[0];
    const king = holderOf(r.sim, kt);
    const ct = titlesOfKind(r.sim, 'county').find((t) => holderOf(r.sim, t).house !== king.house && r.pol.liegeOf(holderOf(r.sim, t).house) === king.house)!;
    const earl = holderOf(r.sim, ct);
    // an earl may give one of his manors to a worthy knight of his House
    const manor = titlesOfKind(r.sim, 'manor').find((t) => t.liege === ct.id && holderOf(r.sim, t).house === earl.house) ?? null;
    const heir = noble(r, earl.house, 'm', 26, { father: earl, tier: 5 });
    if (manor) {
      const res = r.pol.grantTitle(earl.id, manor.id, heir.id);
      expect(res.ok).toBe(true);
      expect(r.sim.state.titles.get(manor.id)!.holder).toBe(heir.id);
      expect(r.sim.state.titles.get(manor.id)!.liege).toBe(ct.id);
    }
    // nobody gives away what is not his
    const stranger = noble(r, king.house, 'm', 30, { father: king, tier: 5 });
    expect(r.pol.grantTitle(stranger.id, ct.id, heir.id).ok).toBe(false);
    expect(r.pol.grantTitle(earl.id, kt.id, heir.id).ok).toBe(false); // a crown is not granted
    const child = noble(r, earl.house, 'm', 9, { father: earl, tier: 5 });
    if (manor) expect(r.pol.grantTitle(earl.id, manor.id, child.id).ok).toBe(false); // too young

    // a lord strips a vassal knight of his manor: the vassal and the vassals' vassals take note
    const vm = titlesOfKind(r.sim, 'manor').find((t) => t.liege && r.sim.state.titles.get(t.liege)!.holder !== 0 && holderOf(r.sim, t).house !== holderOf(r.sim, r.sim.state.titles.get(t.liege)!).house);
    if (vm) {
      const above = holderOf(r.sim, r.sim.state.titles.get(vm.liege)!);
      const knight = holderOf(r.sim, vm);
      const res = r.pol.revokeTitle(above.id, vm.id);
      expect(res.ok).toBe(true);
      expect(r.sim.state.titles.get(vm.id)!.holder).toBe(above.id);
      expect(knight.opinions[above.id] ?? 0).toBeLessThan(-30);
      expect(r.x.core.tie(knight.house, above.house).grievance).toBeGreaterThanOrEqual(40);
      expect(r.pol.revokeTitle(above.id, vm.id).ok).toBe(false);
    }
    // a great vassal cannot be stripped by decree
    expect(r.pol.revokeTitle(king.id, ct.id).ok).toBe(false);
  });
});

describe('petitions', () => {
  it('villagers bring their troubles to the lord (the player), who may grant, compromise or refuse', () => {
    const r = rig({ preset: 'small', seed: 'petition', keepPlayer: true });
    const t = titlesOfKind(r.sim, 'manor')[0];
    const lord = holderOf(r.sim, t);
    makePlayer(r.sim, lord);
    lord.money = 2000;
    r.sim.state.settlements.get(t.place)!.prosperity = 0.6; // a hard year
    r.sim.rng('politics.petition').chance = () => true;
    const asked: string[] = [];
    r.sim.events.on('request', (e) => asked.push(e.text));
    for (let i = 0; i < 6 && r.pol.petitions(lord.id).length === 0; i++) r.x.manage.seasonal();
    const list = r.pol.petitions(lord.id);
    expect(list.length).toBeGreaterThan(0);
    expect(asked.length).toBeGreaterThan(0);
    const pet = list[0];
    const unrestBefore = r.pol.unrest(t.place);
    r.x.core.raiseUnrest(t.place, 30);
    const u = r.pol.unrest(t.place);
    expect(u).toBeGreaterThan(unrestBefore);
    const hh = r.sim.state.households.get(lord.household)!;
    const purse = hh.purse + lord.money;
    const res = r.pol.resolvePetition(pet.id, pet.kind === 'office' ? 'refuse' : 'grant');
    expect(res.ok).toBe(true);
    expect(r.pol.petitions(lord.id).find((p) => p.id === pet.id)).toBeUndefined();
    if (['relief', 'grain', 'protection'].includes(pet.kind)) expect(r.pol.unrest(t.place)).toBeLessThan(u);
    if (['grain', 'protection', 'alms'].includes(pet.kind)) expect(hh.purse + lord.money).toBeLessThan(purse);
    expect(r.pol.resolvePetition(pet.id, 'grant').ok).toBe(false);
  });

  it('a refused petition costs goodwill', () => {
    const r = rig({ preset: 'small', seed: 'petition2', keepPlayer: true });
    const t = titlesOfKind(r.sim, 'manor')[0];
    const lord = holderOf(r.sim, t);
    makePlayer(r.sim, lord);
    r.sim.rng('politics.petition').chance = () => true;
    for (let i = 0; i < 8 && r.pol.petitions(lord.id).length === 0; i++) r.x.manage.seasonal();
    const pet = r.pol.petitions(lord.id)[0];
    expect(pet).toBeTruthy();
    const from = r.sim.state.persons.get(pet.from)!;
    const before = from.opinions[lord.id] ?? 0;
    expect(r.pol.resolvePetition(pet.id, 'refuse').ok).toBe(true);
    expect(from.opinions[lord.id] ?? 0).toBeLessThanOrEqual(before);
  });
});

describe('how the player meets politics', () => {
  it('offers "Realm, offices and politics" on himself, opening the politics panel', () => {
    const r = rig({ preset: 'tiny', keepPlayer: true });
    const provider = politicsActions(r.x.core);
    const out: ActionOption[] = [];
    provider.list(r.sim, r.sim.state.run.playerId, { kind: 'self' }, out);
    expect(out.length).toBe(1);
    expect(out[0].enabled).toBe(true);
    const done = provider.complete(r.sim, r.sim.state.run.playerId, out[0], 1);
    expect(done.ui).toEqual({ panel: 'ext', name: 'politics' });
    const none: ActionOption[] = [];
    provider.list(r.sim, r.sim.state.run.playerId, { kind: 'building', id: 1 }, none);
    expect(none.length).toBe(0);
    // and it is registered with the action system, so the wheel shows it
    const all = r.sim.actions.list(r.sim.state.run.playerId, { kind: 'self' });
    expect(all.some((o) => o.provider === 'politics')).toBe(true);
  });

  it('adds conversation topics: ask a lord for a post, canvass a voter, treat with another House', () => {
    const r = rig({ preset: 'small', seed: 'topics', keepPlayer: true });
    const topics = politicsTopics(r.x.core, r.pol, r.x.offices);
    // a house-to-house conversation between two kings
    const [a, b] = housesHolding(r.sim, 'kingdom');
    const ka = r.x.core.headOf(a)!, kb = r.x.core.headOf(b)!;
    makePlayer(r.sim, ka);
    r.x.core.invalidate();
    const conv = { id: 1, actor: ka.id, with: kb.id, lines: [], options: [], opinion: 0, opinionDelta: 0, mood: 'neutral', relation: 'a king', ended: false } as Conversation;
    const out: DialogueOption[] = [];
    topics.options(conv, out);
    const step = out.find((o) => o.id.startsWith('pol.step:'));
    expect(step).toBeTruthy();
    expect(step!.id).toBe('pol.step:truce');
    expect(typeof (step as DialogueOption & { chance?: number }).chance).toBe('number');
    r.sim.rng('politics.diplo').next = () => 0;
    const reply = topics.choose(conv, step!);
    expect(reply.lines.length).toBeGreaterThan(0);
    expect(r.pol.stance(a, b)).toBe('truce');
    // topics are for the player only
    const out2: DialogueOption[] = [];
    topics.options({ ...conv, actor: kb.id, with: ka.id }, out2);
    expect(out2.length).toBe(0);
  });
});
