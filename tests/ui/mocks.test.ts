// The gallery's fake economy, social and player: they back every screenshot, so they must behave
// like the contracts say (prices, quotes, trades, perks, conversations, actions, journeys).
import { describe, expect, it } from 'vitest';
import { gainSkill } from '../../src/sim/skills';
import type { Person } from '../../src/sim/state';
import { MockEconomy } from '../../src/ui/dev/mockEconomy';
import { MockPlayer } from '../../src/ui/dev/mockPlayer';
import { MockSocial } from '../../src/ui/dev/mockSocial';
import { newSim } from '../sim/helpers';

function setup(seed = 'ui-mock') {
  const sim = newSim({ seed, preset: 'small' });
  const economy = new MockEconomy(sim);
  const social = new MockSocial(sim);
  const id = sim.state.run.playerId;
  const me = sim.state.persons.get(id) as Person;
  return { sim, economy, social, id, me };
}

describe('mock economy', () => {
  it('gives the player goods, equipment and a purse', () => {
    const { economy, id } = setup();
    const inv = economy.inventory(id);
    expect(inv.items.length).toBeGreaterThan(5);
    expect(inv.money).toBeGreaterThan(0);
    expect(inv.weight).toBeGreaterThan(0);
    expect(inv.weight).toBeLessThan(inv.capacity);
    expect(inv.equipment.body).toBe('wool_tunic#1');
    expect(economy.describe('ale', 3)).toBe('3 gallons of ale');
    expect(economy.describe('ale', 1)).toBe('a gallon of ale');
    expect(economy.describe('cap#2', 1)).toBe('a good iron cap');
    expect(economy.describe('sickle#3')).toBe('fine sickle');
  });

  it('prices goods near the SPEC anchors and buys dearer than it sells', () => {
    const { economy } = setup();
    expect(economy.price(0, 'ale', 'buy')).toBeGreaterThanOrEqual(1);
    expect(economy.price(0, 'ale', 'buy')).toBeLessThanOrEqual(2); // ale ≈ 1–1.5 d a gallon
    expect(economy.price(0, 'linen_shirt', 'buy')).toBeGreaterThanOrEqual(12); // a linen shirt ≈ 12 d
    for (const g of economy.goods()) expect(economy.price(0, g.id, 'buy')).toBeGreaterThan(economy.price(0, g.id, 'sell') - 0.01);
    const market = economy.market(0)!;
    expect(market.lines.length).toBeGreaterThan(20);
    expect(market.lines.every((l) => l.buy >= l.sell)).toBe(true);
  });

  it('quotes and settles a barter: goods change hands and the purse follows the quote', () => {
    const { economy, sim, id, me } = setup();
    const partner = { kind: 'market', settlement: me.settlement } as const;
    const before = me.money;
    const breadBefore = me.inventory.bread ?? 0;
    const barleyBefore = me.inventory.barley ?? 0;
    const quote = economy.quote(id, partner, [{ key: 'bread', qty: 3 }, { key: 'barley', qty: -2 }]);
    expect(quote.ok).toBe(true);
    expect(quote.lines).toHaveLength(2);
    const buy = quote.lines.find((l) => l.key === 'bread')!;
    const sell = quote.lines.find((l) => l.key === 'barley')!;
    expect(buy.total).toBeGreaterThan(0);
    expect(sell.total).toBeLessThan(0);
    expect(quote.money).toBeCloseTo(buy.total + sell.total);
    const seen: number[] = [];
    sim.events.on('trade', (e) => seen.push(e.qty));
    const result = economy.trade(id, partner, [{ key: 'bread', qty: 3 }, { key: 'barley', qty: -2 }]);
    expect(result.ok).toBe(true);
    expect(me.inventory.bread).toBe(breadBefore + 3);
    expect(me.inventory.barley ?? 0).toBe(barleyBefore - 2);
    expect(me.money).toBeCloseTo(before - quote.money);
    expect(seen.sort()).toEqual([2, 3]);
  });

  it('refuses what you cannot afford or do not have', () => {
    const { economy, id, me } = setup();
    const partner = { kind: 'market', settlement: me.settlement } as const;
    expect(economy.quote(id, partner, [{ key: 'jack#1', qty: 1 }]).ok).toBe(false);
    expect(economy.quote(id, partner, [{ key: 'wheat', qty: -50 }]).reason).toMatch(/do not have/);
    expect(economy.quote(id, partner, [{ key: 'bread', qty: 999 }]).ok).toBe(false);
    expect(economy.quote(id, partner, []).ok).toBe(false);
    expect(economy.trade(id, partner, [{ key: 'jack#1', qty: 1 }]).ok).toBe(false);
  });

  it('eats, equips and stashes', () => {
    const { economy, id, me, sim } = setup();
    me.needs.hunger = 0.2;
    expect(economy.consume(id, 'bread', 2).ok).toBe(true);
    expect(me.needs.hunger).toBeGreaterThan(0.7);
    expect(economy.consume(id, 'sickle#1').ok).toBe(false);
    expect(economy.equip(id, 'main', 'knife#1').ok).toBe(false);
    expect(economy.equip(id, 'main', 'sickle#1').ok).toBe(true);
    expect(economy.equip(id, 'main', null).ok).toBe(true);
    expect(economy.inventory(id).equipment.main).toBeUndefined();
    const hh = sim.state.households.get(me.household)!;
    const wheat = me.inventory.wheat;
    expect(economy.stash(id, 'wheat', 2).ok).toBe(true);
    expect(me.inventory.wheat).toBe(wheat - 2);
    expect(hh.stores.wheat).toBeGreaterThanOrEqual(2);
    expect(economy.stash(id, 'wheat', -2).ok).toBe(true);
    expect(me.inventory.wheat).toBe(wheat);
    expect(economy.stash(id, 'wheat', 999).ok).toBe(false);
  });

  it('offers jobs whose requirements reflect the person, and applies only when they are met', () => {
    const { economy, id, me } = setup();
    const jobs = economy.jobs(me.settlement, id);
    expect(jobs.length).toBeGreaterThan(3);
    for (const j of jobs) expect(j.requirements.length).toBeGreaterThan(0);
    const open = jobs.find((j) => j.requirements.every((r) => r.met));
    const closed = jobs.find((j) => j.requirements.some((r) => !r.met));
    expect(closed).toBeDefined();
    expect(economy.applyForJob(id, closed!.id).ok).toBe(false);
    if (open) {
      expect(economy.applyForJob(id, open.id).ok).toBe(true);
      expect(economy.employment(id)?.title).toBe(open.title);
      expect(economy.quitJob(id).ok).toBe(true);
      expect(economy.employment(id)).toBeNull();
    }
  });

  it('lists the SPEC §6 career paths with the historical sex rule for women', () => {
    const { economy, id, me } = setup();
    me.sex = 'f';
    const paths = economy.careerPaths(id);
    const fields = paths.map((p) => p.field);
    for (const f of ['land', 'husbandry', 'brewing', 'craft', 'trade', 'arms', 'knighthood', 'church', 'service', 'healing', 'outlaw'] as const) expect(fields).toContain(f);
    const arms = paths.find((p) => p.field === 'arms')!;
    expect(arms.open).toBe(false);
    expect(arms.sexRule).toMatch(/men/);
    expect(paths.find((p) => p.field === 'land')?.open).toBe(true);
    expect(economy.entryTests().map((t) => t.career)).toContain('archer');
  });

  it('hands out perk choices once a skill has earned a slot, and takes the chosen perk', () => {
    const { economy, sim, id, me } = setup();
    expect(economy.perkChoices(id)).toHaveLength(0);
    gainSkill(sim, me, 'farming', 1200);
    const choices = economy.perkChoices(id);
    expect(choices).toHaveLength(1);
    expect(choices[0].skill).toBe('farming');
    expect(choices[0].options[0].id).not.toBe(choices[0].options[1].id);
    expect(economy.choosePerk(id, choices[0].options[1].id).ok).toBe(true);
    expect(me.perks).toContain(choices[0].options[1].id);
    expect(economy.perkChoices(id).filter((c) => c.skill === 'farming').length).toBeLessThanOrEqual(1);
    expect(economy.choosePerk(id, 'melee.first_blood').ok).toBe(false);
  });

  it('lets only the household head set tasks', () => {
    const { economy, sim, id, me } = setup();
    const hh = sim.state.households.get(me.household)!;
    const member = hh.members.find((m) => m !== hh.head)!;
    expect(economy.householdPlan(hh.id).length).toBe(hh.members.length);
    expect(economy.setTask(hh.head, member, 'wood').ok).toBe(true);
    expect(economy.householdPlan(hh.id).find((l) => l.person === member)).toMatchObject({ task: 'wood', set: true });
    if (hh.head !== id) expect(economy.setTask(id, member, 'rest').ok).toBe(false);
  });
});

describe('mock social', () => {
  it('runs a conversation: lines, options with checks and reasons, opinion, ending', () => {
    const { sim, social, id, me } = setup('ui-mock-social');
    const hh = sim.state.households.get(me.household)!;
    const other = hh.members.find((m) => m !== id)!;
    const events: string[] = [];
    sim.events.on('conversation', (e) => events.push(e.phase));
    const started = social.start(id, other);
    expect('lines' in started).toBe(true);
    if (!('lines' in started)) return;
    expect(social.current()?.id).toBe(started.id);
    expect(started.relation.length).toBeGreaterThan(0);
    expect(started.options.some((o) => o.chance !== undefined && o.chance > 0 && o.chance < 1)).toBe(true);
    const court = started.options.find((o) => o.kind === 'court')!;
    expect(court.enabled).toBe(false); // twelve years old
    expect(court.reason).toMatch(/young/);
    const before = started.lines.length;
    const after = social.choose(started.id, 'chat');
    expect(after.lines.length).toBeGreaterThan(before);
    expect(after.opinionDelta).toBeGreaterThan(0);
    social.choose(started.id, 'leave');
    expect(social.current()).toBeNull();
    expect(events).toEqual(['start', 'end']);
  });

  it('finds courtship candidates of the other sex, not close kin', () => {
    const { sim, social, id, me } = setup('ui-mock-match');
    me.birthDay -= 5 * 16; // old enough to be matched
    const cands = social.matchCandidates(id, 8);
    for (const c of cands) {
      const p = sim.state.persons.get(c)!;
      expect(p.sex).not.toBe(me.sex);
      expect(p.father === me.father && p.father !== 0).toBe(false);
      const court = social.courtship(id, c)!;
      expect(court.progress).toBeGreaterThanOrEqual(0);
      expect(court.progress).toBeLessThanOrEqual(1);
    }
  });
});

describe('mock player', () => {
  it('runs a real timed action through the action registry: progress, gains, notify and skill events', () => {
    const { sim, social, id, me } = setup('ui-mock-player');
    const zone = undefined as never;
    const player = new MockPlayer(sim, social, zone);
    expect(player.hud()?.name).toContain(me.first);
    const options = player.options();
    expect(options.length).toBeGreaterThan(3);
    expect(options[0].label).toBe('Reap');
    expect(options.find((o) => o.id === 'glean')?.enabled).toBe(false);
    expect(options.find((o) => o.id === 'glean')?.reason).toBe('Needs a basket');
    const notes: string[] = [];
    const gains: string[] = [];
    sim.events.on('notify', (n) => notes.push(n.text));
    sim.events.on('action', (e) => { if (e.type === 'completed') for (const g of e.outcome.gains ?? []) gains.push(g.label); });
    expect(player.perform(options[0]).ok).toBe(true);
    expect(player.hud()?.action?.label).toBe('Reap');
    for (let i = 0; i < 180; i++) sim.step(0.05);
    expect(notes).toContain('You reap a quarter of the strip.');
    expect(gains).toContain('sheaves');
    expect(me.skills.farming).toBeGreaterThan(0);
    expect(id).toBe(sim.state.run.playerId);
  });

  it('refuses a disabled option and cancels cleanly', () => {
    const { sim, social } = setup('ui-mock-player-2');
    const player = new MockPlayer(sim, social, undefined as never);
    const glean = player.options().find((o) => o.id === 'glean')!;
    expect(player.perform(glean).ok).toBe(false);
    player.perform(player.options()[0]);
    player.cancelAction();
    expect(player.hud()?.action).toBeNull();
  });

  it('runs a journey to an encounter and arrival', () => {
    const { sim, social, me } = setup('ui-mock-travel');
    const player = new MockPlayer(sim, social, undefined as never);
    const target = sim.world.settlements.find((s) => s.id !== me.settlement)!;
    const phases: string[] = [];
    sim.events.on('travel', (e) => phases.push(e.phase));
    expect(player.travelTo(me.settlement).ok).toBe(false);
    player.encounterAt = 0.5;
    expect(player.travelTo(target.id).ok).toBe(true);
    expect(player.travel()?.phase).toBe('travelling');
    for (let i = 0; i < 40; i++) player.update(1);
    expect(player.travel()?.phase).toBe('encounter');
    expect(player.travel()?.encounter?.hostile).toBe(true);
    player.cancelTravel();
    expect(player.travel()).toBeNull();
    expect(phases).toEqual(['start', 'encounter', 'cancel']);
  });
});
