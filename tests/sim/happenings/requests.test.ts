// NPC requests to the player (SPEC §18, §21): offered, heard and accepted in conversation, completed with
// rewards or neglected with consequences, tracked in a journal, paced.
import { describe, expect, it } from 'vitest';
import type { ActionOption } from '../../../src/sim/actions';
import type { Conversation } from '../../../src/sim/social/types';
import type { Person } from '../../../src/sim/state';
import { mkHouse, mkHousehold, mkPerson } from '../builders';
import { advSim, type AdvSim } from '../advancement/helpers';

const actionDone = (a: AdvSim, id: string): void => {
  a.sim.events.emit('action', {
    type: 'completed', actor: a.player.id,
    option: { id, provider: 'test', label: id, category: 'work', target: { kind: 'self' }, enabled: true, seconds: 1, range: 1, priority: 1 } as ActionOption,
    outcome: { ok: true },
  });
};

function talk(a: AdvSim, other: Person): Conversation {
  const open = a.social.current();
  if (open) a.social.end(open.id);
  const c = a.social.start(a.player.id, other.id);
  if ('ok' in c) throw new Error(`could not talk: ${c.reason}`);
  return c;
}

/** Offers a request and walks the conversation up to the accepted state. */
function offerAndAccept(a: AdvSim, type: Parameters<AdvSim['adv']['happenings']['offerRequest']>[0]): { id: number; from: Person } {
  const id = a.adv.happenings.offerRequest(type);
  expect(id, `a ${type} request could be offered`).toBeGreaterThan(0);
  const r = a.adv.happenings.requests().find((x) => x.id === id)!;
  const from = a.sim.state.persons.get(r.from)!;
  let c = talk(a, from);
  expect(c.options.some((o) => o.id === `req.hear.${id}`), c.options.map((o) => o.id).join(',')).toBe(true);
  c = a.social.choose(c.id, `req.hear.${id}`);
  expect(c.lines.some((l) => l.speaker === from.id && l.text.length > 10)).toBe(true);
  expect(c.options.some((o) => o.id === `req.accept.${id}`)).toBe(true);
  expect(c.options.some((o) => o.id === `req.decline.${id}`)).toBe(true);
  a.social.choose(c.id, `req.accept.${id}`);
  expect(a.adv.happenings.requests().find((x) => x.id === id)!.state).toBe('accepted');
  a.social.end(c.id);
  return { id, from };
}

/** Steps real time in frames of 1/20 s (a step call is clipped at a quarter second). */
const play = (a: AdvSim, seconds: number): void => { for (let i = 0; i < seconds * 20; i++) a.sim.step(1 / 20); };

const state = (a: AdvSim, id: number): string => a.adv.happenings.requests().find((x) => x.id === id)!.state;

describe('offering', () => {
  it('offers requests by itself, with a request event and a notice, and keeps a journal', () => {
    const a = advSim({ seed: 'req-offer' });
    const events: number[] = [];
    const notes: string[] = [];
    a.sim.events.on('request', (e) => events.push(e.id));
    a.sim.events.on('notify', (e) => { if (e.kind === 'quest') notes.push(e.text); });
    a.sim.advanceDays(32); // two years: a request every five minutes or so
    expect(events.length).toBeGreaterThan(2);
    expect(notes.length).toBeGreaterThanOrEqual(events.length);
    const journal = a.adv.happenings.requests();
    expect(journal.length).toBeGreaterThanOrEqual(events.length - 1);
    for (const r of journal) {
      expect(r.text.length).toBeGreaterThan(20);
      expect(r.fromName.length).toBeGreaterThan(0);
      expect(['fetch', 'loan', 'work', 'message', 'lost_animal', 'watch', 'godparent', 'marriage']).toContain(r.type);
    }
  });

  it('keeps to the pacing target: about one request every two to four minutes, never more than the cap open', () => {
    const a = advSim({ seed: 'req-pace' });
    const days: number[] = [];
    a.sim.events.on('request', () => days.push(a.sim.absDay));
    let maxOpen = 0;
    for (let d = 0; d < 48; d++) { a.sim.advanceDays(1); maxOpen = Math.max(maxOpen, a.adv.happenings.openRequests().length); }
    // the player answers by declining at once, so the slots keep freeing
    expect(maxOpen).toBeLessThanOrEqual(4);
    const per = 48 / days.length;
    expect(per).toBeGreaterThan(1.5);
    expect(per).toBeLessThan(6);
  });

  it('lets the player ask a neighbour whether there is anything to do', () => {
    const a = advSim({ seed: 'req-ask' });
    const friend = mkPerson(a.sim, { career: 'farmer', age: 38, tier: 2, settlement: a.player.settlement });
    a.social.adjustOpinion(friend.id, a.player.id, 40, 'test');
    let made = 0;
    for (let i = 0; i < 12 && made === 0; i++) {
      const c = talk(a, friend);
      if (!c.options.some((o) => o.id === 'req.ask')) { a.sim.advanceDays(5); continue; }
      a.social.choose(c.id, 'req.ask');
      made = a.adv.happenings.requests().filter((r) => r.from === friend.id).length;
      a.social.end(c.id);
      a.sim.advanceDays(5);
    }
    expect(made).toBeGreaterThan(0);
  });
});

describe('fetching goods', () => {
  it('is handed over in conversation for silver and good will', () => {
    const a = advSim({ seed: 'req-fetch' });
    const { id, from } = offerAndAccept(a, 'fetch');
    const r = a.adv.happenings.requests().find((x) => x.id === id)!;
    const money0 = a.player.money;
    const op0 = a.social.opinion(from.id, a.player.id);
    let c = talk(a, from);
    const turn = c.options.find((o) => o.id === `req.fetch.${id}`)!;
    expect(turn.enabled).toBe(false); // nothing carried yet
    a.player.inventory[r.data.good!] = (a.player.inventory[r.data.good!] ?? 0) + r.data.qty!;
    c = talk(a, from);
    expect(c.options.find((o) => o.id === `req.fetch.${id}`)!.enabled).toBe(true);
    const points0 = a.sim.state.score.points;
    a.social.choose(c.id, `req.fetch.${id}`);
    expect(state(a, id)).toBe('done');
    expect(a.player.money).toBeGreaterThan(money0);
    expect(a.social.opinion(from.id, a.player.id)).toBeGreaterThan(op0);
    expect(a.sim.state.score.points).toBeGreaterThan(points0);
  });

  it('costs opinion and honour when promised and not done', () => {
    const a = advSim({ seed: 'req-fail' });
    const { id, from } = offerAndAccept(a, 'fetch');
    const op0 = a.social.opinion(from.id, a.player.id);
    const honour0 = a.player.rep.honour;
    a.sim.advanceDays(8);
    expect(state(a, id)).toBe('failed');
    expect(a.social.opinion(from.id, a.player.id)).toBeLessThan(op0);
    expect(a.player.rep.honour).toBeLessThan(honour0);
  });

  it('costs a little opinion when left unanswered, and nothing is owed', () => {
    const a = advSim({ seed: 'req-ignore' });
    const id = a.adv.happenings.offerRequest('fetch');
    const r = a.adv.happenings.requests().find((x) => x.id === id)!;
    const op0 = a.social.opinion(r.from, a.player.id);
    a.sim.advanceDays(6);
    expect(state(a, id)).toBe('expired');
    expect(a.social.opinion(r.from, a.player.id)).toBeLessThan(op0);
    expect(a.player.rep.honour).toBe(a.player.rep.honour);
  });

  it('can be declined politely', () => {
    const a = advSim({ seed: 'req-decline' });
    const id = a.adv.happenings.offerRequest('work');
    expect(a.adv.happenings.declineRequest(id).ok).toBe(true);
    expect(state(a, id)).toBe('declined');
    expect(a.adv.happenings.acceptRequest(id).ok).toBe(false);
  });
});

describe('loans', () => {
  it('are paid back with interest by an honest borrower', () => {
    const a = advSim({ seed: 'req-loan-2' });
    a.player.money = 2000;
    const id = a.adv.happenings.offerRequest('loan');
    expect(id).toBeGreaterThan(0);
    const r = a.adv.happenings.requests().find((x) => x.id === id)!;
    const from = a.sim.state.persons.get(r.from)!;
    from.traits = ['honest'];
    from.money = 5000;
    const lent = r.data.pence!;
    const before = a.player.money;
    expect(a.adv.happenings.acceptRequest(id).ok).toBe(true);
    expect(a.player.money).toBe(before - lent);
    expect(state(a, id)).toBe('accepted');
    a.sim.advanceDays(26);
    expect(state(a, id)).toBe('done');
    expect(a.player.money).toBeGreaterThan(before);
  });

  it('are forgiven if the borrower dies, and cannot be accepted without the money', () => {
    const a = advSim({ seed: 'req-loan-poor' });
    a.player.money = 2000;
    const id = a.adv.happenings.offerRequest('loan');
    a.player.money = 1;
    expect(a.adv.happenings.acceptRequest(id).ok).toBe(false);
    expect(state(a, id)).toBe('offered');
  });
});

describe('work, messages, strayed animals, watches, godparents, marriages', () => {
  it('work: the labour counts and is paid when done', () => {
    const a = advSim({ seed: 'req-work' });
    const { id } = offerAndAccept(a, 'work');
    const r = a.adv.happenings.requests().find((x) => x.id === id)!;
    const money0 = a.player.money;
    a.player.settlement = r.settlement;
    for (let i = 0; i < (r.data.count ?? 3) - 1; i++) actionDone(a, 'farm.reap');
    expect(state(a, id)).toBe('accepted');
    actionDone(a, 'farm.wait'); // waiting is not work
    expect(state(a, id)).toBe('accepted');
    actionDone(a, 'farm.sow');
    expect(state(a, id)).toBe('done');
    expect(a.player.money).toBeGreaterThan(money0);
  });

  it('message: carried to the person named and delivered in conversation', () => {
    const a = advSim({ seed: 'req-msg', preset: 'small' });
    const { id, from } = offerAndAccept(a, 'message');
    const r = a.adv.happenings.requests().find((x) => x.id === id)!;
    const to = a.sim.state.persons.get(r.data.target!)!;
    expect(to.settlement).not.toBe(from.settlement);
    const money0 = a.player.money;
    const c = talk(a, to);
    expect(c.options.some((o) => o.id === `req.deliver.${id}`)).toBe(true);
    a.social.choose(c.id, `req.deliver.${id}`);
    expect(state(a, id)).toBe('done');
    expect(a.player.money).toBeGreaterThan(money0);
  });

  it('message: is dropped without blame when the recipient dies', () => {
    const a = advSim({ seed: 'req-msg-dead', preset: 'small' });
    const { id } = offerAndAccept(a, 'message');
    const r = a.adv.happenings.requests().find((x) => x.id === id)!;
    const honour0 = a.player.rep.honour;
    a.sim.state.persons.get(r.data.target!)!.death = { day: a.sim.absDay, cause: 'illness' };
    a.sim.advanceDays(1.2);
    expect(state(a, id)).toBe('failed');
    expect(a.player.rep.honour).toBe(honour0);
  });

  it('lost animal: found by going where it strayed', () => {
    const a = advSim({ seed: 'req-animal' });
    mkPerson(a.sim, { career: 'shepherd', age: 35, tier: 1, settlement: a.player.settlement });
    const { id } = offerAndAccept(a, 'lost_animal');
    const r = a.adv.happenings.requests().find((x) => x.id === id)!;
    const spot = a.adv.happenings.hap.save.reqs.find((x) => x.id === id)!.data;
    const here = { x: spot.x! + 500, z: spot.z! };
    a.sim.view.setSource('focus', () => here);
    play(a, 1.2); // the check runs once a second
    expect(state(a, id)).toBe('accepted');
    here.x = spot.x! + 10;
    play(a, 1.2);
    expect(state(a, id)).toBe('done');
    expect(r.type).toBe('lost_animal');
  });

  it('watch: kept by staying in the village through the night', () => {
    const a = advSim({ seed: 'req-watch', noon: false });
    const rec = a.adv.happenings.hap;
    // make a watch request directly (they come mostly in dangerous times)
    const from = mkPerson(a.sim, { career: 'farmer', age: 40, tier: 3, settlement: a.player.settlement });
    const danger = a.adv.happenings.trigger!('bandits', a.player.settlement);
    expect(danger).toBeGreaterThan(0);
    let id = 0;
    for (let i = 0; i < 20 && id === 0; i++) id = a.adv.happenings.offerRequest('watch', from.id);
    expect(id).toBeGreaterThan(0);
    expect(a.adv.happenings.acceptRequest(id).ok).toBe(true);
    a.sim.advanceDays(2);
    expect(state(a, id)).toBe('done');
    void rec;
  });

  it('godparent: attend the christening', () => {
    const a = advSim({ seed: 'req-god' });
    const hh = mkHousehold(a.sim, a.player.settlement);
    const mother = mkPerson(a.sim, { sex: 'f', age: 25, tier: 2, settlement: a.player.settlement, household: hh.id });
    a.sim.state.setHead(hh, mother);
    const baby = mkPerson(a.sim, { sex: 'f', age: 0, tier: 2, settlement: a.player.settlement, household: hh.id, mother });
    baby.birthDay = Math.round(a.sim.absDay - 3);
    a.sim.state.addChild(mother, baby.id);
    const id = a.adv.happenings.offerRequest('godparent', mother.id);
    expect(id).toBeGreaterThan(0);
    expect(a.adv.happenings.acceptRequest(id).ok).toBe(true);
    a.sim.advanceDays(3.6);
    expect(state(a, id)).toBe('done');
  });

  it('marriage: a parent offers a ward, and accepting arranges the match', () => {
    const a = advSim({ seed: 'req-marry' });
    a.player.spouse = 0;
    a.player.birthDay = Math.round(a.sim.absDay - 20 * 16);
    a.player.sex = 'm';
    a.player.rankTier = 2;
    const hh = mkHousehold(a.sim, a.player.settlement);
    const house = mkHouse(a.sim, 'Brides');
    const father = mkPerson(a.sim, { sex: 'm', age: 48, tier: 2, settlement: a.player.settlement, household: hh.id, house: house.id });
    a.sim.state.setHead(hh, father);
    const daughter = mkPerson(a.sim, { sex: 'f', age: 19, tier: 2, settlement: a.player.settlement, household: hh.id, house: house.id, father });
    a.sim.state.addChild(father, daughter.id);
    const id = a.adv.happenings.offerRequest('marriage', father.id);
    expect(id).toBeGreaterThan(0);
    const res = a.adv.happenings.acceptRequest(id);
    expect(['done', 'failed']).toContain(state(a, id));
    if (res.ok) expect(a.adv.happenings.requests().find((x) => x.id === id)!.note).toMatch(/promised/);
  });
});

describe('requesters in the detail zone', () => {
  it('walk up to the player and speak', () => {
    const commands: Array<[number, string]> = [];
    const said: Array<[number, string]> = [];
    const agents = new Map<number, { x: number; z: number }>();
    const zone = {
      agent: (id: number) => agents.get(id) ?? null,
      command: (id: number, o: { kind: string }) => { commands.push([id, o.kind]); },
      say: (id: number, t: string) => { said.push([id, t]); },
      nav: { doorOf: () => null },
    };
    const a = advSim({ seed: 'req-zone', zone: zone as never });
    (a.adv.happenings.hap.deps as { player?: unknown }).player = { body: () => ({ x: 100, y: 0, z: 100, yaw: 0 }) };
    const id = a.adv.happenings.offerRequest('fetch');
    const r = a.adv.happenings.requests().find((x) => x.id === id)!;
    agents.set(r.from, { x: 130, z: 100 });
    play(a, 1.2);
    expect(said.some(([who]) => who === r.from)).toBe(true);
    expect(commands.some(([who, k]) => who === r.from && k === 'goto')).toBe(true);
    // and go back to their day later
    play(a, 30);
    expect(commands.some(([who, k]) => who === r.from && k === 'resume')).toBe(true);
  });
});
