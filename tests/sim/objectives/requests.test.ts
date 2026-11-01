// Villagers' requests as objectives: the happenings module's record stays the truth, the objective mirrors it.
import { describe, expect, it } from 'vitest';
import type { ActionOption } from '../../../src/sim/actions';
import type { RequestType } from '../../../src/sim/happenings/types';
import type { Conversation } from '../../../src/sim/social/types';
import { active, allText, install, objSim, playerOf, play, skipTutorial, tracked, walkTo, type ObjSim } from './helpers';

function reqObjs(o: ObjSim) { return o.obj.list().filter((x) => x.source === 'request'); }
function record(o: ObjSim, id: number) { return o.adv.happenings.requests().find((r) => r.id === id)!; }

function talk(o: ObjSim, who: number): Conversation {
  const open = o.social.current();
  if (open) o.social.end(open.id);
  const c = o.social.start(playerOf(o.sim).id, who);
  if ('ok' in c) throw new Error(`could not talk: ${c.reason}`);
  return c;
}

/** Offers a request and walks the conversation up to the accepted state. */
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

const done = (name: string): ActionOption => ({
  id: name, provider: 'test', label: name, category: 'work', target: { kind: 'self' }, enabled: true, seconds: 1, range: 1, priority: 1,
});

describe('requests as objectives', () => {
  it('a new request appears as an objective: the asker to hear, what it is, when it lapses', () => {
    const o = objSim({ seed: 's1' });
    expect(reqObjs(o)).toHaveLength(0);
    const id = o.adv.happenings.offerRequest('fetch');
    const r = record(o, id);
    const [ob] = reqObjs(o);
    expect(ob, 'an objective for the request').toBeTruthy();
    expect(ob.state).toBe('active');
    expect(ob.title).toBe(r.summary);
    expect(ob.giver).toBe(r.from);
    expect(ob.why).toBe(r.text);
    expect(ob.dueDay).toBe(r.expires);
    expect(ob.reward).toMatch(/thanks/);
    expect(ob.steps).toHaveLength(1);
    expect(ob.steps[0].text).toMatch(/^Hear what \w+ wants$/);
    expect(ob.steps[0].target?.kind).toBe('person');
    expect(ob.steps[0].target?.id).toBe(r.from);
    expect(ob.steps[0].hint).toMatch(/press E/);
  });

  it('a fetch goes: hear, accept, bring the goods, hand them over, paid', () => {
    const o = objSim({ seed: 's1' });
    skipTutorial(o);
    const me = playerOf(o.sim);
    const id = offerAndAccept(o, 'fetch');
    const r = record(o, id);
    const ob = reqObjs(o)[0];
    // accepted: now bring the goods, then hand them over
    expect(ob.steps.map((s) => s.text)).toEqual([expect.stringMatching(/^Bring .* \(you carry 0\)$/), expect.stringMatching(/^Give it to \w+$/)]);
    expect(ob.steps[0].goal).toBe(r.data.qty);
    expect(ob.steps[0].done).toBe(false);
    me.inventory[r.data.good!] = (me.inventory[r.data.good!] ?? 0) + r.data.qty!;
    o.sim.state.touch(me);
    o.obj.poll(true);
    expect(reqObjs(o)[0].steps[0].done).toBe(true);
    expect(reqObjs(o)[0].steps[1].done).toBe(false);
    expect(tracked(o)?.id).toBe(ob.id);
    // hand over in conversation
    const money0 = me.money;
    let c = talk(o, r.from);
    c = o.social.choose(c.id, `req.fetch.${id}`);
    o.social.end(c.id);
    expect(record(o, id).state).toBe('done');
    expect(reqObjs(o)[0].state).toBe('done');
    expect(me.money).toBeGreaterThan(money0);
    for (const t of allText(o.obj.list())) expect(t, t).not.toMatch(/\{\w+\}/);
  });

  it('declined or left unanswered, the objective lapses; neglected after accepting, it fails', () => {
    const o = objSim({ seed: 's1' });
    const a = o.adv.happenings.offerRequest('work');
    o.adv.happenings.declineRequest(a);
    o.obj.poll(true); // the next look at the state (in play: the conversation ends, or the slow poll)
    expect(reqObjs(o).find((x) => x.title === record(o, a).summary)?.state).toBe('expired');

    // run until the offer lapses (its window follows the request pacing), then look while it is still listed
    const b = o.adv.happenings.offerRequest('fetch');
    for (let i = 0; i < 28 && record(o, b).state === 'offered'; i++) o.sim.advanceDays(0.25);
    o.obj.poll(true);
    expect(record(o, b).state).toBe('expired');
    expect(reqObjs(o).find((x) => x.title === record(o, b).summary)?.state).toBe('expired');

    const c = offerAndAccept(o, 'fetch');
    for (let i = 0; i < 36 && record(o, c).state === 'accepted'; i++) o.sim.advanceDays(0.25);
    o.obj.poll(true);
    expect(record(o, c).state).toBe('failed');
    expect(reqObjs(o).find((x) => x.title === record(o, c).summary)?.state).toBe('failed');
  });

  it('work requests count the player\'s jobs as they are done', () => {
    const o = objSim({ seed: 's1' });
    const id = offerAndAccept(o, 'work');
    const r = record(o, id);
    const ob = () => reqObjs(o)[0];
    expect(ob().steps[0].goal).toBe(r.data.count);
    expect(ob().steps[0].progress).toBe(0);
    o.sim.events.emit('action', { type: 'completed', actor: playerOf(o.sim).id, option: done('farm.weed'), outcome: { ok: true } });
    expect(ob().steps[0].progress).toBe(1);
    for (let i = 1; i < r.data.count!; i++) o.sim.events.emit('action', { type: 'completed', actor: playerOf(o.sim).id, option: done('farm.weed'), outcome: { ok: true } });
    expect(record(o, id).state).toBe('done');
    expect(ob().state).toBe('done');
  });

  it('a strayed animal is a place to go to: the search ends when the player stands there', () => {
    const o = objSim({ seed: 's1' });
    const id = offerAndAccept(o, 'lost_animal');
    const r = record(o, id);
    const ob = () => reqObjs(o)[0];
    expect(ob().steps[0].text).toMatch(/^Find \w+'s (sheep|pig|goat|cow) to the [a-z-]+ of/);
    expect(ob().steps[0].target?.kind).toBe('place');
    expect([ob().steps[0].target!.x, ob().steps[0].target!.z]).toEqual([r.data.x, r.data.z]);
    walkTo(o, r.data.x!, r.data.z!);
    play(o, 2); // the happenings look once a second
    expect(record(o, id).state).toBe('done');
    expect(ob().state).toBe('done');
  });

  it('a message names who to find and where; a loan waits for the day it is repaid', () => {
    const o = objSim({ seed: 's1' });
    skipTutorial(o);
    const id = offerAndAccept(o, 'message');
    const r = record(o, id);
    const ob = reqObjs(o).find((x) => x.title === r.summary)!;
    expect(ob.steps[0].text).toMatch(/^Carry the message to \w+ at \w+/);
    expect(ob.steps[0].target?.kind).toBe('person');
    expect(ob.steps[0].target?.id).toBe(r.data.target);
    playerOf(o.sim).money = 900;
    const l = offerAndAccept(o, 'loan');
    const lr = record(o, l);
    const lo = reqObjs(o).find((x) => x.title === lr.summary)!;
    expect(lo.steps[0].text).toMatch(/^\w+ repays the loan on day \d+$/);
    // the day comes: the happenings settle it and the objective follows
    o.sim.advanceDays(Math.ceil(lr.data.due! - o.sim.absDay) + 1);
    expect(['done', 'failed']).toContain(record(o, l).state);
    expect(reqObjs(o).find((x) => x.title === lr.summary)?.state).toBe(record(o, l).state);
  });

  it('a request already open when the module starts (a loaded game) is picked up', () => {
    const o = objSim({ seed: 's1', install: false });
    const id = o.adv.happenings.offerRequest('fetch');
    expect(id).toBeGreaterThan(0);
    const inst = install(o);
    expect(inst.list().filter((x) => x.source === 'request')).toHaveLength(1);
    expect(active(o).length).toBeGreaterThan(0);
  });
});
