// Quest marks (docs/CIV.md §1): "!" over anyone who has something for the player, "?" over the person to report to when the current step
// is a hand-in whose needs are met. The objectives tell the zone both sets (setQuestMarks, falling back to setQuestGivers) and expose them
// with what each is about (ObjectivesApi.marks) for the compass, the minimap and the hover card.
import { describe, expect, it } from 'vitest';
import type { RequestType } from '../../../src/sim/happenings/types';
import type { Conversation } from '../../../src/sim/social/types';
import { active, fakeZone, objSim, playObjectives, playerOf, runTo, skipTutorial, type ObjSim } from './helpers';

function record(o: ObjSim, id: number) { return o.adv.happenings.requests().find((r) => r.id === id)!; }

function talk(o: ObjSim, who: number): Conversation {
  const open = o.social.current();
  if (open) o.social.end(open.id);
  const c = o.social.start(playerOf(o.sim).id, who);
  if ('ok' in c) throw new Error(`could not talk: ${c.reason}`);
  return c;
}

function offerAndAccept(o: ObjSim, type: RequestType): number {
  const id = o.adv.happenings.offerRequest(type);
  expect(id, `a ${type} request could be offered`).toBeGreaterThan(0);
  const from = record(o, id).from;
  let c = talk(o, from);
  c = o.social.choose(c.id, `req.hear.${id}`);
  o.social.choose(c.id, `req.accept.${id}`);
  o.social.end(c.id);
  expect(record(o, id).state).toBe('accepted');
  return id;
}

const lastMarks = (z: ReturnType<typeof fakeZone>) => z.marks[z.marks.length - 1] ?? [];

describe('quest marks', () => {
  it('"!" over the asker of a request that is offered, and over whoever the current step says to speak to', () => {
    const z = fakeZone({ marks: true });
    const o = objSim({ seed: 's1', zone: z.zone });
    const head = o.obj.tracked()!.steps[0].target!.id;
    expect(lastMarks(z).find((m) => m.person === head)?.kind).toBe('quest');
    skipTutorial(o);
    const id = o.adv.happenings.offerRequest('fetch');
    o.obj.poll(true);
    const from = record(o, id).from;
    expect(lastMarks(z).find((m) => m.person === from)).toEqual({ person: from, kind: 'quest' });
    // the player is never marked, and nothing is told twice
    expect(lastMarks(z).some((m) => m.person === playerOf(o.sim).id)).toBe(false);
    const calls = z.marks.length;
    o.obj.poll(true); o.obj.poll(true);
    expect(z.marks.length).toBe(calls);
  });

  it('"?" over the person to report to once what a hand-in needs is gathered — and "!" again if the goods go', () => {
    const z = fakeZone({ marks: true });
    const o = objSim({ seed: 's1', zone: z.zone });
    skipTutorial(o);
    const me = playerOf(o.sim);
    const id = offerAndAccept(o, 'fetch');
    const r = record(o, id);
    // accepted, the goods not yet gathered: the asker is still the one who has business with the player, but nothing can be handed in
    o.obj.poll(true);
    expect(lastMarks(z).find((m) => m.person === r.from)?.kind).toBe('quest');
    // gathered: the hand-in
    me.inventory[r.data.good!] = (me.inventory[r.data.good!] ?? 0) + r.data.qty!;
    o.sim.state.touch(me);
    o.obj.poll(true);
    expect(lastMarks(z).find((m) => m.person === r.from)).toEqual({ person: r.from, kind: 'turnin' });
    const mark = o.obj.marks!().find((m) => m.person === r.from)!;
    expect(mark.kind).toBe('turnin');
    expect(mark.text).toMatch(/^Give it to /);
    // sold on the way: no longer ready
    me.inventory[r.data.good!] = 0;
    o.sim.state.touch(me);
    o.obj.poll(true);
    expect(lastMarks(z).find((m) => m.person === r.from)?.kind).toBe('quest');
    // given: no mark for it any more
    me.inventory[r.data.good!] = r.data.qty!;
    o.sim.state.touch(me);
    o.obj.poll(true);
    let c = talk(o, r.from);
    c = o.social.choose(c.id, `req.fetch.${id}`);
    o.social.end(c.id);
    o.obj.poll(true);
    expect(lastMarks(z).find((m) => m.person === r.from)?.kind).not.toBe('turnin');
  });

  it('a message: the recipient is the one to report to, as soon as it is accepted', () => {
    const z = fakeZone({ marks: true });
    const o = objSim({ seed: 's1', zone: z.zone });
    skipTutorial(o);
    const id = o.adv.happenings.offerRequest('message');
    expect(id, 'a message could be offered').toBeGreaterThan(0);
    const accepted = offerAcceptExisting(o, id);
    const r = record(o, id);
    expect(accepted).toBe(true);
    o.obj.poll(true);
    const to = r.data.target!;
    expect(lastMarks(z).find((m) => m.person === to)).toEqual({ person: to, kind: 'turnin' });
    expect(lastMarks(z).find((m) => m.person === r.from)?.kind).toBe('quest');
  });

  it('"!" over the head of the household while there are chores of theirs to do', () => {
    const z = fakeZone({ marks: true });
    const o = objSim({ seed: 's1', zone: z.zone });
    playObjectives(o, ['tutorial']);
    runTo(o, 1, 5);
    const chore = active(o, 'chore').find((x) => x.giver);
    expect(chore, 'the household head set a chore').toBeTruthy();
    o.obj.poll(true);
    expect(lastMarks(z).find((m) => m.person === chore!.giver)?.kind).toBe('quest');
    const text = o.obj.marks!().find((m) => m.person === chore!.giver)!.text;
    expect(text).toMatch(/has work for you/);
  });

  it('falls back to setQuestGivers (every marked person, sorted) when the zone has no setQuestMarks, and to nothing without a zone', () => {
    const z = fakeZone();
    const o = objSim({ seed: 's1', zone: z.zone });
    skipTutorial(o);
    const me = playerOf(o.sim);
    const id = offerAndAccept(o, 'fetch');
    const r = record(o, id);
    me.inventory[r.data.good!] = r.data.qty!;
    o.sim.state.touch(me);
    o.obj.poll(true);
    const ids = z.givers[z.givers.length - 1].ids;
    expect(ids).toContain(r.from);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const bare = objSim({ seed: 's1' });
    expect(() => { bare.obj.poll(true); bare.obj.marks!(); }).not.toThrow();
  });

  it('keep the hand-in flag through a save and a rebuild of the steps', () => {
    const o = objSim({ seed: 's1' });
    skipTutorial(o);
    const id = offerAndAccept(o, 'fetch');
    const rec = o.obj.obj.save.list.find((x) => x.source === 'request' && x.data?.req === id)!;
    expect(rec.steps.map((s) => s.turnin === true)).toEqual([false, true]);
    expect(JSON.parse(JSON.stringify(rec)).steps[1].turnin).toBe(true);
  });
});

function offerAcceptExisting(o: ObjSim, id: number): boolean {
  const from = record(o, id).from;
  let c = talk(o, from);
  c = o.social.choose(c.id, `req.hear.${id}`);
  o.social.choose(c.id, `req.accept.${id}`);
  o.social.end(c.id);
  return record(o, id).state === 'accepted';
}
