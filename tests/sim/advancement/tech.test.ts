// House trees (SPEC §17): learned by doing, held by people, taught, preserved in books, lost with the last holder.
import { describe, expect, it } from 'vitest';
import type { ActionOption } from '../../../src/sim/actions';
import { BRANCHES, TECHS } from '../../../src/sim/advancement';
import { libraryLost, record, settlementYear } from '../../../src/sim/advancement/learning';
import { killPerson } from '../../../src/sim/succession';
import { mkHouse, mkHousehold, mkPerson } from '../builders';
import { forget, advSim, playerOf } from './helpers';

const actionDone = (sim: ReturnType<typeof advSim>['sim'], id: string): void => {
  sim.events.emit('action', {
    type: 'completed', actor: sim.state.run.playerId,
    option: { id, provider: 'test', label: id, category: 'work', target: { kind: 'self' }, enabled: true, seconds: 1, range: 1, priority: 1 } as ActionOption,
    outcome: { ok: true },
  });
};

describe('the tech data', () => {
  it('has the four branches and every technique SPEC §17 lists', () => {
    expect(BRANCHES.map((b) => b.id)).toEqual(['economy', 'military', 'kinship', 'knowledge']);
    const ids = new Set(TECHS.map((t) => t.id));
    for (const id of [
      'heavy_plough', 'improved_rotation', 'watermill', 'windmill', 'fulling_mill', 'market_charter', 'fair_charter', 'guild_charter', 'wool_trade', 'letters_of_credit',
      'longbow_drill', 'crossbows', 'coat_of_plates', 'plate_armour', 'destriers', 'stone_keep', 'curtain_walls', 'concentric_castle', 'trebuchet', 'paid_retinues', 'bombards',
      'marriage_pacts', 'wardship', 'oaths', 'alliance_treaties', 'truces', 'heralds', 'tournaments', 'council_of_the_realm',
      'parish_school', 'scriptorium', 'cathedral_school', 'university', 'herbal_medicine', 'infirmary_care', 'written_charters', 'accounting', 'printing',
    ]) expect(ids.has(id), id).toBe(true);
  });

  it('has consistent prerequisites and a way to learn each technique', () => {
    const byId = new Map(TECHS.map((t) => [t.id, t]));
    for (const t of TECHS) {
      for (const r of t.requires) expect(byId.has(r), `${t.id} requires ${r}`).toBe(true);
      expect(t.learn.rate, t.id).toBeGreaterThan(0);
      expect(t.points, t.id).toBeGreaterThan(0);
      const roles = (t.learn.careers?.length ?? 0) + (t.learn.fields?.length ?? 0) + (t.learn.titles?.length ?? 0) + (t.learn.estates?.length ?? 0);
      expect(roles, `${t.id} has someone who can learn it`).toBeGreaterThan(0);
      // no cycles: walk the requirement chain
      const seen = new Set<string>();
      const walk = (id: string): void => { expect(seen.has(id), `cycle at ${id}`).toBe(false); seen.add(id); for (const r of byId.get(id)?.requires ?? []) walk(r); seen.delete(id); };
      walk(t.id);
    }
  });
});

describe('knowledge at the start of a run', () => {
  it('is dealt out to the people who qualify, and the services are registered', () => {
    const { sim, adv } = advSim();
    expect(sim.services.advancement).toBe(adv);
    expect(sim.services.happenings).toBe(adv.happenings);
    expect(adv.holders('heavy_plough').length).toBeGreaterThan(5);
    expect(adv.holders('parish_school').length).toBeGreaterThan(5);
    // late and undiscovered techniques start unknown
    expect(adv.holders('printing')).toHaveLength(0);
    expect(adv.holders('plate_armour')).toHaveLength(0);
    // a holder knows it, and so does their House
    const holder = adv.holders('heavy_plough')[0];
    const p = sim.state.persons.get(holder)!;
    expect(adv.knows(holder, 'heavy_plough')).toBe(true);
    expect(adv.houseHas(p.house, 'heavy_plough')).toBe(true);
    expect(adv.techsOf(holder)).toContain('heavy_plough');
  });
});

describe('learning by doing', () => {
  it('counts the player\'s work towards a technique and teaches it once enough has been done', () => {
    const { sim, adv, player } = advSim();
    forget(adv, 'heavy_plough');
    player.skills.farming = 40 * 16; // level 4
    const events: string[] = [];
    sim.events.on('tech', (e) => events.push(e.tech));
    const points0 = sim.state.score.points;
    const need = TECHS.find((t) => t.id === 'heavy_plough')!.learn.player!.need;
    let n = 0;
    while (!adv.knows(player.id, 'heavy_plough') && n < need * 2) { actionDone(sim, 'farm.plough'); n++; }
    expect(adv.knows(player.id, 'heavy_plough')).toBe(true);
    expect(n).toBeGreaterThan(need / 2);
    expect(n).toBeLessThanOrEqual(need * 1.5);
    expect(adv.houseHas(sim.state.run.houseId, 'heavy_plough')).toBe(true);
    expect(events).toContain('heavy_plough');
    expect(sim.state.score.points).toBeGreaterThan(points0);
    expect(sim.state.chronicle.some((c) => c.kind === 'tech' && c.text.includes('Heavy plough'))).toBe(true);
    // it shows in the House tree
    const view = adv.tree().find((v) => v.def.id === 'heavy_plough')!;
    expect(view.mine).toBe(true);
    expect(view.houseHas).toBe(true);
  });

  it('does not count practice until the prerequisites are held', () => {
    const { sim, adv, player } = advSim();
    forget(adv, 'heavy_plough');
    forget(adv, 'improved_rotation');
    player.skills.farming = 40 * 36;
    for (let i = 0; i < 80; i++) actionDone(sim, 'farm.sow');
    expect(adv.knows(player.id, 'improved_rotation')).toBe(false);
    expect(adv.tree().find((v) => v.def.id === 'improved_rotation')!.locked).toBe(true);
    adv.grant(player.id, 'heavy_plough');
    for (let i = 0; i < 80; i++) actionDone(sim, 'farm.sow');
    expect(adv.knows(player.id, 'improved_rotation')).toBe(true);
  });

  it('needs the skill, not only the practice', () => {
    const { sim, adv, player } = advSim();
    forget(adv, 'watermill');
    player.skills.carpentry = 0;
    for (let i = 0; i < 40; i++) actionDone(sim, 'farm.mill');
    expect(adv.knows(player.id, 'watermill')).toBe(true); // no skill needed for the mill itself
    forget(adv, 'fulling_mill');
    player.skills.tailoring = 0;
    for (let i = 0; i < 60; i++) actionDone(sim, 'craft.weave_cloth');
    expect(adv.knows(player.id, 'fulling_mill')).toBe(false);
    player.skills.tailoring = 40 * 16;
    for (let i = 0; i < 5; i++) actionDone(sim, 'craft.weave_cloth');
    expect(adv.knows(player.id, 'fulling_mill')).toBe(true);
  });
});

describe('techniques live in people', () => {
  it('a master teaches an apprentice (by lesson and over the years)', () => {
    const { sim, adv } = advSim();
    const village = sim.world.settlements.find((s) => s.kind === 'village')!;
    const hh = mkHousehold(sim, village.id);
    const house = mkHouse(sim, 'Smiths');
    const master = mkPerson(sim, { career: 'smith', age: 45, household: hh.id, settlement: village.id, house: house.id, tier: 3 });
    const lad = mkPerson(sim, { career: 'smith', age: 14, household: hh.id, settlement: village.id, house: house.id, tier: 2 });
    master.careerStage = 3; lad.careerStage = 0;
    master.skills.smithing = 40 * 64; lad.skills.smithing = 40 * 9;
    forget(adv, 'coat_of_plates');
    adv.grant(master.id, 'coat_of_plates');
    expect(adv.knows(lad.id, 'coat_of_plates')).toBe(false);
    // the lad cannot take lessons from someone who does not know it
    expect(adv.teach(lad.id, master.id, 'coat_of_plates').ok).toBe(false);
    // years of working side by side
    for (let year = 0; year < 14 && !adv.knows(lad.id, 'coat_of_plates'); year++) settlementYear(adv.adv, village);
    expect(adv.knows(lad.id, 'coat_of_plates')).toBe(true);
    expect(adv.knows(master.id, 'coat_of_plates')).toBe(true);
    expect(adv.holders('coat_of_plates')).toContain(lad.id);
  });

  it('a lesson needs the skill to follow it', () => {
    const { sim, adv } = advSim();
    const village = sim.world.settlements.find((s) => s.kind === 'village')!;
    const master = mkPerson(sim, { career: 'smith', age: 45, settlement: village.id, tier: 3 });
    const boy = mkPerson(sim, { career: 'smith', age: 14, settlement: village.id, tier: 2 });
    master.skills.smithing = 40 * 64; boy.skills.smithing = 0;
    forget(adv, 'coat_of_plates');
    adv.grant(master.id, 'coat_of_plates');
    expect(adv.canLearn(boy.id, 'coat_of_plates').ok).toBe(false);
    boy.skills.smithing = 40 * 16;
    expect(adv.canLearn(boy.id, 'coat_of_plates').ok).toBe(true);
    expect(adv.teach(master.id, boy.id, 'coat_of_plates', { force: true }).ok).toBe(true);
    expect(adv.knows(boy.id, 'coat_of_plates')).toBe(true);
  });

  it('is lost when its last holder dies unrecorded', () => {
    const { sim, adv } = advSim();
    forget(adv, 'trebuchet');
    const carp = mkPerson(sim, { career: 'carpenter', age: 50, tier: 3 });
    adv.grant(carp.id, 'trebuchet');
    expect(adv.holders('trebuchet')).toEqual([carp.id]);
    expect(adv.isLost('trebuchet')).toBe(false);
    killPerson(sim, carp, 'illness', sim.absDay);
    expect(adv.holders('trebuchet')).toHaveLength(0);
    expect(adv.knows(carp.id, 'trebuchet')).toBe(false);
    expect(adv.isLost('trebuchet')).toBe(true);
    expect(adv.isPreserved('trebuchet')).toBe(false);
    expect(sim.state.chronicle.some((c) => c.kind === 'tech' && /lost/.test(c.text))).toBe(true);
    // the House tree says so
    expect(adv.tree().find((v) => v.def.id === 'trebuchet')!.state).toBe('lost');
    // and the player's progress towards it starts again
    expect(adv.adv.save.prog['trebuchet'] ?? 0).toBe(0);
  });

  it('survives its last holder when a library has it in writing, and a reader can recover it', () => {
    const { sim, adv } = advSim();
    const abbey = sim.world.settlements.find((s) => (sim.state.buildingsAt.get(s.id) ?? []).some((b) => b.kind === 'cloister' || b.kind === 'cathedral'))!;
    expect(abbey).toBeDefined();
    forget(adv, 'coat_of_plates');
    const smith = mkPerson(sim, { career: 'smith', age: 50, tier: 3, settlement: abbey.id });
    adv.grant(smith.id, 'coat_of_plates');
    record(adv.adv, 'coat_of_plates', abbey.id);
    killPerson(sim, smith, 'illness', sim.absDay);
    expect(adv.holders('coat_of_plates')).toHaveLength(0);
    expect(adv.isPreserved('coat_of_plates')).toBe(true);
    expect(adv.isLost('coat_of_plates')).toBe(false);
    expect(sim.state.chronicle.some((c) => c.kind === 'tech' && /coat of plates/.test(c.text))).toBe(false);
    // someone literate in the abbey town reads it back out of the books within some years
    for (let year = 0; year < 30 && adv.holders('coat_of_plates').length === 0; year++) settlementYear(adv.adv, abbey);
    expect(adv.holders('coat_of_plates').length).toBeGreaterThan(0);
    expect(adv.isPreserved('coat_of_plates')).toBe(false);
  });

  it('is lost after all when the library burns', () => {
    const { sim, adv } = advSim();
    const abbey = sim.world.settlements.find((s) => (sim.state.buildingsAt.get(s.id) ?? []).some((b) => b.kind === 'cloister' || b.kind === 'cathedral'))!;
    forget(adv, 'trebuchet');
    const carp = mkPerson(sim, { career: 'carpenter', age: 50, tier: 3, settlement: abbey.id });
    adv.grant(carp.id, 'trebuchet');
    record(adv.adv, 'trebuchet', abbey.id);
    killPerson(sim, carp, 'illness', sim.absDay);
    expect(adv.isPreserved('trebuchet')).toBe(true);
    expect(libraryLost(adv.adv, abbey.id)).toBeGreaterThan(0);
    expect(adv.isLost('trebuchet')).toBe(true);
  });

  it('passes with the title or to the eldest child for heritable techniques', () => {
    const { sim, adv } = advSim();
    forget(adv, 'oaths');
    const house = mkHouse(sim, 'Lords');
    const village = sim.world.settlements.find((s) => s.kind === 'village')!;
    const hh = mkHousehold(sim, village.id);
    const lord = mkPerson(sim, { sex: 'm', age: 52, estate: 'noble', tier: 5, career: 'lord', household: hh.id, house: house.id });
    const heir = mkPerson(sim, { sex: 'm', age: 24, estate: 'noble', tier: 4, career: 'noble', household: hh.id, house: house.id, father: lord });
    adv.grant(lord.id, 'oaths');
    killPerson(sim, lord, 'old_age', sim.absDay);
    expect(adv.knows(heir.id, 'oaths')).toBe(true);
    expect(adv.isLost('oaths')).toBe(false);
  });
});

describe('what techniques do', () => {
  it('shows in bonuses a fake economy reads: yields for the House, effects for a settlement', () => {
    const { sim, adv } = advSim();
    const village = sim.world.settlements.find((s) => s.kind === 'village')!;
    forget(adv, 'heavy_plough');
    forget(adv, 'improved_rotation');
    const house = mkHouse(sim, 'Ploughmen');
    const hh = mkHousehold(sim, village.id);
    const farmer = mkPerson(sim, { career: 'farmer', age: 35, household: hh.id, settlement: village.id, house: house.id });
    const yieldOf = (h: number): number => 1 + (sim.services.advancement?.bonus?.(h, 'farm.yield') ?? 0);
    expect(yieldOf(house.id)).toBe(1);
    adv.grant(farmer.id, 'heavy_plough');
    expect(yieldOf(house.id)).toBeCloseTo(1.1, 5);
    adv.grant(farmer.id, 'improved_rotation');
    expect(yieldOf(house.id)).toBeCloseTo(1.18, 5);
    // another House does not benefit
    const other = mkHouse(sim, 'Others');
    expect(yieldOf(other.id)).toBe(1);
    // the village as a community
    expect(sim.services.advancement?.settlementHas?.(village.id, 'heavy_plough')).toBe(true);
    expect(sim.services.advancement?.settlementBonus?.(village.id, 'farm.yield')).toBeGreaterThan(0.17);
    expect(adv.personBonus(farmer.id, 'prosperity')).toBeCloseTo(0.07, 5);
  });

  it('lifts a settlement\'s prosperity a little when its farmers have the better ploughs', () => {
    const { sim, adv } = advSim();
    const village = sim.world.settlements.find((s) => s.kind === 'village' && sim.state.residentsOf(s.id).length > 20)!;
    const ss = sim.state.settlements.get(village.id)!;
    for (const p of sim.state.residentsOf(village.id)) adv.adv.removeHolder(p.id, 'heavy_plough');
    ss.prosperity = 1;
    const sys = sim.scheduler.list('yearly').find((s) => s.name === 'tech.prosperity')!;
    sys.run(sim, { year: 2, day: 16 });
    const before = ss.prosperity;
    for (const p of sim.state.residentsOf(village.id).slice(0, 12)) adv.adv.addHolder(p, 'heavy_plough');
    ss.prosperity = 1;
    sys.run(sim, { year: 3, day: 32 });
    expect(before).toBe(1);
    expect(ss.prosperity).toBeGreaterThan(1.001);
    expect(ss.prosperity).toBeLessThan(1.1);
  });
});

describe('teaching in conversation', () => {
  it('offers lessons from a master for a fee, and teaches a pupil of your own', () => {
    const { sim, adv, rig, player, social } = advSim();
    const village = sim.world.settlements.find((s) => s.id === player.settlement) ?? sim.world.settlements[0];
    const smith = mkPerson(sim, { career: 'smith', age: 48, tier: 3, settlement: player.settlement });
    smith.skills.smithing = 40 * 64;
    forget(adv, 'coat_of_plates');
    adv.grant(smith.id, 'coat_of_plates');
    player.skills.smithing = 40 * 16;
    player.money = 1000;
    player.birthDay = Math.round(sim.absDay - 20 * 16);
    social.adjustOpinion(smith.id, player.id, 20, 'test');
    const c = social.start(player.id, smith.id);
    if ('ok' in c) throw new Error(c.reason);
    const opt = c.options.find((o) => o.id === 'tech.learn.coat_of_plates');
    expect(opt, c.options.map((o) => o.id).join(',')).toBeDefined();
    expect(opt!.enabled).toBe(true);
    const money0 = player.money;
    // keep choosing until the lesson takes (a roll), at most a few times
    let learned = false;
    for (let i = 0; i < 8 && !learned; i++) {
      social.choose(c.id, 'tech.learn.coat_of_plates');
      learned = adv.knows(player.id, 'coat_of_plates');
      if (player.money < 120) player.money = 1000;
    }
    expect(learned).toBe(true);
    expect(player.money).toBeLessThan(money0 + 1);
    social.end(c.id);
    void rig; void village;
  });
});

describe('study', () => {
  it('the school, cloister and infirmary offer study that builds the skill and then teaches the technique', () => {
    const { sim, adv, player } = advSim();
    const sid = sim.world.settlements.find((s) => (sim.state.buildingsAt.get(s.id) ?? []).some((b) => b.kind === 'school'))!.id;
    const school = (sim.state.buildingsAt.get(sid) ?? []).find((b) => b.kind === 'school')!;
    forget(adv, 'parish_school');
    player.skills.letters = 40 * 4; // level 2: two short of the 3 the tech wants
    const target = { kind: 'building', id: school.id } as const;
    let done = 0;
    for (let i = 0; i < 40 && !adv.knows(player.id, 'parish_school'); i++) {
      const o = sim.actions.list(player.id, target).find((x) => x.id === 'tech.study.parish_school');
      expect(o, 'study option').toBeDefined();
      expect(o!.enabled).toBe(true);
      sim.actions.start(player.id, o!);
      for (let t = 0; t < 40 * 20 && sim.actions.active(player.id); t++) sim.step(1 / 20);
      done++;
    }
    expect(adv.knows(player.id, 'parish_school')).toBe(true);
    expect(done).toBeGreaterThanOrEqual(3);
    expect(sim.actions.list(player.id, target).some((x) => x.id === 'tech.study.parish_school')).toBe(false);
  });
});

describe('persistence', () => {
  it('a save, load and continue gives the same state', async () => {
    const { MemorySaveStore } = await import('../../../src/sim/save-memory');
    const { Simulation } = await import('../../../src/sim/sim');
    const { installAdvancement } = await import('../../../src/sim/advancement');
    const { installEconomy } = await import('../../../src/sim/economy');
    const { installSocial } = await import('../../../src/sim/social');
    const { mockGenerator, settle } = await import('../helpers');
    const store = new MemorySaveStore();
    const a = advSim({ seed: 'tech-save', store, autosave: { intervalMs: 0 } });
    a.sim.advanceDays(16 * 4);
    forget(a.adv, 'trebuchet');
    const carp = mkPerson(a.sim, { career: 'carpenter', age: 50, tier: 3 });
    a.adv.grant(carp.id, 'trebuchet');
    a.sim.advanceDays(3);
    await settle();
    a.sim.requestSave('test');
    await a.sim.flush();
    const loaded = (await Simulation.load(store, mockGenerator('tiny')))!;
    const social = installSocial(loaded);
    const economy = installEconomy(loaded, { social });
    const adv2 = installAdvancement(loaded, { economy, social });
    expect(loaded.stateHash()).toBe(a.sim.stateHash());
    expect(adv2.holders('trebuchet')).toEqual(a.adv.holders('trebuchet'));
    expect(adv2.knows(carp.id, 'trebuchet')).toBe(true);
    expect(adv2.happenings.stats()).toEqual(a.adv.happenings.stats());
    a.sim.advanceDays(16 * 4);
    loaded.advanceDays(16 * 4);
    expect(loaded.stateHash()).toBe(a.sim.stateHash());
    expect(adv2.holders('heavy_plough')).toEqual(a.adv.holders('heavy_plough'));
    void playerOf;
  });

  it('is deterministic: two runs of the same seed agree', () => {
    const run = (): string => {
      const { sim, adv } = advSim({ seed: 'tech-det' });
      sim.advanceDays(16 * 6);
      return `${sim.stateHash()}|${adv.holders('heavy_plough').join(',')}|${JSON.stringify(adv.happenings.stats())}`;
    };
    expect(run()).toBe(run());
  });
});
