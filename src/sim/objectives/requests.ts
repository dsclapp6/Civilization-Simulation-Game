// Requests from villagers (the happenings module) as objectives. The request record stays the truth: the
// objective mirrors its state and rebuilds its steps from it, so hearing a request, accepting it, doing the
// work and handing the result over are all checked against the one place that knows.
import { formatMoney } from '../money';
import { DATA } from '../happenings/data';
import type { RequestView } from '../happenings/types';
import { compass } from '../social/topics/ask';
import type { NewObjective, Obj, ObjRec, StepRec } from './core';
import { T } from './data';
import { buildingTarget, churchOf, describePerson, personTarget, settlementTarget } from './places';
import { happeningsOf, holdingOf } from './sources';

type SpecStep = NewObjective['steps'][number];

function stepsFor(O: Obj, r: RequestView): SpecStep[] {
  const from = O.state.persons.get(r.from);
  const fromName = from ? from.first : r.fromName;
  const fromTarget = from ? personTarget(O, from, describePerson(O, from)) : undefined;
  const place = O.settlementById.get(r.settlement);
  const vars = { from: fromName, place: place?.name ?? 'the village' };
  const t = (k: string, extra: Record<string, string | number> = {}): string => T('text', k, { ...vars, ...extra });
  const step = (text: string, hint: string, m: SpecStep['m'], target = fromTarget, goal?: number): SpecStep => {
    const s: SpecStep = { text, hint, m };
    if (target) s.target = target;
    if (goal !== undefined) { s.goal = goal; s.progress = 0; }
    return s;
  };
  if (r.state === 'offered') return [step(t('req.hear'), t('req.hear.hint'), { k: 'req', id: r.id, at: 'accepted' })];
  const d = r.data;
  switch (r.type) {
    case 'fetch': {
      const good = d.good ?? '';
      const qty = d.qty ?? 1;
      const what = O.deps.economy.describe(good, qty);
      const pack = O.me ? Math.floor((O.me.inventory[good] ?? 0) * 10) / 10 : 0;
      return [
        step(t('req.fetch.have', { what, have: pack }), t('req.fetch.have.hint'), { k: 'have', good, qty }, undefined, qty),
        step(t('req.fetch.give'), t('req.fetch.give.hint'), { k: 'req', id: r.id, at: 'done' }),
      ];
    }
    case 'loan':
      return [step(t('req.loan.wait', { day: Math.floor(d.due ?? r.expires) }), t('req.loan.wait.hint'), { k: 'req', id: r.id, at: 'done' })];
    case 'work':
      return [step(t('req.work.do', { n: d.count ?? 3 }), t('req.work.hint'), { k: 'reqwork', id: r.id, field: 'done' }, place ? settlementTarget(O, place) : undefined, d.count ?? 3)];
    case 'message': {
      const to = d.target ? O.state.persons.get(d.target) : undefined;
      const dest = d.place !== undefined ? O.settlementById.get(d.place) : undefined;
      const text = t('req.message.go', { to: to ? to.first : 'the recipient', place: dest?.name ?? 'the next village' });
      return [step(text, t('req.message.hint', { to: to ? to.first : 'them', place: dest?.name ?? 'there' }), { k: 'req', id: r.id, at: 'done' }, to ? personTarget(O, to) : dest ? settlementTarget(O, dest) : undefined)];
    }
    case 'lost_animal': {
      const x = d.x ?? 0, z = d.z ?? 0;
      const dir = place ? compass(place.x, place.z, x, z) : 'the countryside';
      const at = { kind: 'place' as const, id: -1, x, z, label: `Lost ${d.animal ?? 'animal'}` };
      return [step(t('req.animal.go', { animal: d.animal ?? 'animal', dir }), t('req.animal.hint'), { k: 'reach', x, z, r: DATA.requests.lost_animal.found }, at)];
    }
    case 'watch': {
      const hours = d.hours ?? 5;
      return [step(t('req.watch.go'), t('req.watch.hint'), { k: 'reqwork', id: r.id, field: 'watched' }, place ? settlementTarget(O, place) : undefined, hours)];
    }
    case 'godparent': {
      const me = O.me;
      const church = me ? churchOf(O, me) : undefined;
      const at = d.at ?? r.expires - 0.5;
      const target = church ? buildingTarget(O, church) : place ? settlementTarget(O, place) : undefined;
      return [step(t('req.godparent.go'), t('req.godparent.hint'), target ? { k: 'reach', x: target.x, z: target.z, r: 30, from: at, to: at + 0.6 } : { k: 'req', id: r.id, at: 'done' }, target)];
    }
    default:
      return [step(t('req.generic'), t('req.hear.hint'), { k: 'req', id: r.id, at: 'done' })];
  }
}

function signature(steps: readonly StepRec[]): string {
  return steps.map((s) => `${s.text}|${s.done ? 1 : 0}|${s.progress ?? ''}|${s.goal ?? ''}`).join('\n');
}

function rewardOf(O: Obj, r: RequestView): string {
  const who = O.state.persons.get(r.from)?.first ?? r.fromName;
  const pence = r.reward.pence;
  return pence > 0 ? `${formatMoney(pence)} and ${who}'s thanks` : `${who}'s thanks`;
}

/** Brings the objectives into line with the requests of the happenings module. */
export function syncRequests(O: Obj): void {
  const H = happeningsOf(O);
  const me = O.me;
  if (!H || !me) return;
  const reqs = H.requests();
  const byId = new Map(reqs.map((r) => [r.id, r]));
  // new ones
  for (const r of reqs) {
    if (r.state !== 'offered' && r.state !== 'accepted') continue;
    if (O.save.list.some((o) => o.source === 'request' && o.data?.req === r.id)) continue;
    O.add({
      source: 'request', key: `req:${r.id}`, title: r.summary, why: r.text, giver: r.from, reward: rewardOf(O, r), dueDay: r.expires,
      steps: stepsFor(O, r), data: { req: r.id }, offer: r.state === 'offered',
    });
  }
  // the ones we hold
  for (const o of O.save.list.slice()) {
    if (o.source !== 'request' || o.state !== 'active') continue;
    const r = byId.get(Number(o.data?.req));
    if (!r) { O.finish(o, 'expired'); continue; }
    switch (r.state) {
      case 'done': O.finish(o, 'done'); continue;
      case 'failed': O.finish(o, 'failed'); continue;
      case 'expired': case 'declined': O.finish(o, 'expired'); continue;
      default: break;
    }
    refreshSteps(O, o, r);
  }
}

/** Rebuilds the steps from the record; keeps the objective as it is when nothing changed. */
function refreshSteps(O: Obj, o: ObjRec, r: RequestView): void {
  const fresh = stepsFor(O, r);
  const old = signature(o.steps);
  const kept = o.steps.map((s) => s.m.k + JSON.stringify(s.m));
  const next = fresh.map((s) => s.m.k + JSON.stringify(s.m));
  const same = kept.length === next.length && kept.every((k, i) => k === next[i]);
  if (same) {
    // only the wording and the target may have moved
    fresh.forEach((s, i) => { o.steps[i].text = s.text; if (s.target) o.steps[i].target = s.target; });
    if (signature(o.steps) !== old) O.touch();
    return;
  }
  o.steps = fresh.map((s) => {
    const st: StepRec = { text: s.text, done: false, m: s.m };
    if (s.hint) st.hint = s.hint;
    if (s.target) st.target = s.target;
    if (s.goal !== undefined) { st.goal = s.goal; st.progress = s.progress ?? 0; }
    return st;
  });
  o.dueDay = r.expires;
  O.touch();
  O.sim.events.emit('objective', { phase: 'progress', id: o.id, title: o.title });
}

export { holdingOf };
