// "What now?": good things to do right now, best first. The tracked step comes first, then what the body
// needs (food, sleep, warmth), what the hour of the day asks (home before dark), what the calendar offers (a
// market day, the holy day), a villager waiting for a word, a perk to choose, and, when nothing presses, a
// few honest ideas.
import { dist } from '../../core/math';
import { dayPart, isHolyDay, isMarketDay } from '../calendar';
import { skillLevel } from '../people';
import type { Person } from '../state';
import type { Obj } from './core';
import { T } from './data';
import {
  buildingPhrase, buildingTarget, churchOf, findNear, homeOf, marketPlaceIn, marketTownOf, metresTo, personTarget, playerXZ, settlementTarget,
} from './places';
import { requestsOf } from './sources';
import type { Suggestion } from './types';

interface Scored extends Suggestion { score: number }

const SELLABLE = new Set(['grain', 'food', 'produce', 'textile', 'drink', 'material', 'fuel']);

/** The best things to sell from the pack: names of the two largest stacks that a market buys. */
function sellable(O: Obj, me: Person): string[] {
  const eco = O.deps.economy;
  const stacks: Array<{ key: string; qty: number }> = [];
  for (const [key, qty] of Object.entries(me.inventory)) {
    if (key.charCodeAt(0) === 126 || qty < 1) continue;
    const g = eco.good(key.split('#')[0]);
    if (g && SELLABLE.has(g.category) && g.id !== 'bread' && g.id !== 'ale') stacks.push({ key, qty });
  }
  stacks.sort((a, b) => b.qty - a.qty || (a.key < b.key ? -1 : 1));
  return stacks.slice(0, 2).map((s) => eco.good(s.key.split('#')[0])?.name.toLowerCase() ?? s.key);
}

function foodInPack(O: Obj, me: Person): boolean {
  for (const [key, qty] of Object.entries(me.inventory)) {
    if (key.charCodeAt(0) === 126 || qty <= 0) continue;
    const g = O.deps.economy.good(key.split('#')[0]);
    if (g && g.food && g.category !== 'livestock') return true;
  }
  return false;
}

export function suggest(O: Obj, limit = 4): Suggestion[] {
  const me = O.me;
  if (!me) return [];
  const out: Scored[] = [];
  const push = (score: number, text: string, target?: Suggestion['target'], objective?: number): void => {
    const s: Scored = { score, text };
    if (target) s.target = target;
    if (objective !== undefined) s.objective = objective;
    out.push(s);
  };
  const home = homeOf(O, me);
  const homeTarget = home ? buildingTarget(O, home, 'Your home') : undefined;
  const part = dayPart(O.day);
  const pos = playerXZ(O);
  const nearHome = !!home && !!pos && dist(pos.x, pos.z, home.x, home.z) < 25;

  // the tracked objective, then the others by their order of importance
  const trackedId = O.save.tracked;
  let rank = 0;
  for (const o of O.list()) {
    if (o.state !== 'active') continue;
    const step = o.steps.find((s) => !s.done);
    if (!step) continue;
    const base = o.id === trackedId ? 100 : 60 - 4 * rank++;
    push(base, step.target ? `${step.text}` : step.text, step.target, o.id);
  }

  // needs
  if (me.needs.hunger < 0.4) {
    if (foodInPack(O, me)) push(90, T('text', 'sug.hungry.pack'));
    else if (home && O.state.households.get(me.household)?.settlement === me.settlement) push(90, T('text', 'sug.hungry.home'), homeTarget);
    else push(90, T('text', 'sug.hungry.buy'));
  }
  if (me.needs.rest < 0.25) push(88, T('text', 'sug.tired'), homeTarget);
  else if (me.needs.warmth < 0.25 && home && !nearHome) push(70, T('text', 'sug.cold'), homeTarget);

  // the hour
  if ((part === 'evening' || part === 'dusk' || part === 'night') && home && !nearHome) push(85, T('text', 'sug.dark'), homeTarget);

  // the calendar
  const town = marketTownOf(O, me.settlement);
  if (town && isMarketDay(O.day, town.id) && part !== 'night' && part !== 'dusk') {
    const goods = sellable(O, me);
    const hall = marketPlaceIn(O, town);
    const target = hall ? buildingTarget(O, hall) : settlementTarget(O, town);
    if (goods.length > 0) push(66, T('text', 'sug.market.sell', { goods: goods.join(' and '), town: town.name }), target);
    else push(40, T('text', 'sug.market.day', { town: town.name }), target);
  }
  if (isHolyDay(O.day) && (part === 'dawn' || part === 'morning' || part === 'midday')) {
    const church = churchOf(O, me);
    if (church) push(72, T('text', 'sug.holy.mass', { church: buildingPhrase(O, church) }), buildingTarget(O, church));
    const butts = findNear(O, me, ['archery_butts'], 900);
    if (butts && me.sex === 'm' && O.age(me) >= 12) push(45, T('text', 'sug.holy.butts'), buildingTarget(O, butts));
  }

  // a villager with something to ask
  for (const r of requestsOf(O)) {
    if (r.state !== 'offered' || r.heard) continue;
    const p = O.state.persons.get(r.from);
    if (p && !p.death) push(62, T('text', 'sug.request', { from: p.first }), personTarget(O, p));
    break;
  }

  // a perk waiting
  const choices = O.deps.economy.perkChoices(me.id);
  if (choices.length > 0) push(55, T('text', 'sug.perk', { skill: choices[0].skill }));

  // nothing presses: a few honest ideas
  if (out.length < 2) {
    const butts = findNear(O, me, ['archery_butts'], 900);
    if (me.sex === 'm' && O.age(me) >= 12 && butts) push(20, T('text', 'sug.idle.butts'), buildingTarget(O, butts));
    push(18, T('text', 'sug.idle.talk'));
    if (homeTarget && !nearHome) push(15, T('text', 'sug.idle.home'), homeTarget);
  }

  // best first, no repeats
  out.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const res: Suggestion[] = [];
  for (const s of out) {
    if (seen.has(s.text)) continue;
    seen.add(s.text);
    const { score: _score, ...rest } = s;
    void _score;
    res.push(rest);
    if (res.length >= limit) break;
  }
  return res;
}

export { metresTo, skillLevel };
