// NPC requests to the player (SPEC §18, §21): neighbours ask for help with work, a loan, goods fetched,
// a message carried, a strayed animal found, a watch kept, a godparent, a marriage. Requests are offered
// about every two or three game days (SPEC §21: something to deal with every 2-3 minutes), heard and
// answered in conversation (a social topic), tracked in a small journal (the 'requests' panel) and have
// consequences both ways: rewards, opinion and standing when honoured; lost opinion and honour when
// accepted and then neglected or when left unanswered.
import { isCloseKin } from '../kin';
import { formatMoney } from '../money';
import { TIER_MONEY } from '../people';
import type { Conversation, DialogueLine, DialogueOption, TopicProvider, TopicReply } from '../social/types';
import { compass } from '../social/topics/ask';
import { ageYears, fullName, type Person, type PersonId } from '../state';
import type { DayInfo, HourInfo } from '../clock';
import type { Hap } from './core';
import { DATA, fill } from './data';
import type { RequestRec, RequestType, RequestView } from './types';

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const say = (speaker: PersonId, text: string, tone?: DialogueLine['tone']): DialogueLine => (tone ? { speaker, text, tone } : { speaker, text });
const WORK_IDS = /^(farm|garden|wood|stock|craft|appr|dig)\./;
const WORK_SKIP = /\.(wait|hire_on)$/;
const ANIMAL_WORDS: Record<string, string> = { sheep: 'sheep', pig: 'pig', goat: 'goat', cow: 'cow' };

type Builder = (H: Hap, me: Person, from?: PersonId) => RequestRec | null;

// ---------------------------------------------------------------------------------------------
// Journal views
// ---------------------------------------------------------------------------------------------

export function viewOf(H: Hap, r: RequestRec): RequestView {
  const p = H.state.persons.get(r.from);
  return { ...r, fromName: p ? fullName(p) : 'Someone', placeName: H.placeName(r.settlement), daysLeft: Math.max(0, Math.ceil(r.expires - H.day)) };
}

export function allRequests(H: Hap): RequestView[] {
  const open = (r: RequestRec): number => (r.state === 'offered' || r.state === 'accepted' ? 0 : 1);
  return H.save.reqs.slice().sort((a, b) => open(a) - open(b) || b.offered - a.offered || b.id - a.id).map((r) => viewOf(H, r));
}

export function openRequests(H: Hap): RequestView[] {
  return H.save.reqs.filter((r) => r.state === 'offered' || r.state === 'accepted').map((r) => viewOf(H, r));
}

const find = (H: Hap, id: number): RequestRec | undefined => H.save.reqs.find((r) => r.id === id);

// ---------------------------------------------------------------------------------------------
// Offering
// ---------------------------------------------------------------------------------------------

const plainAge = (H: Hap, p: Person): number => ageYears(p, H.day);

/** Picks who asks: someone of the player's village, favouring kin, friends and people of a similar station. */
function pickRequester(H: Hap, me: Person, ok: (p: Person) => boolean, from?: PersonId): Person | null {
  if (from !== undefined) { const p = H.state.persons.get(from); return p && !p.death && ok(p) ? p : null; }
  const rng = H.rng();
  const busy = new Set<number>();
  for (const r of H.save.reqs) if (r.state === 'offered' || r.state === 'accepted') busy.add(r.from);
  // a random sample of the village keeps the opinion lookups cheap in a big town
  const all = H.state.residentsOf(me.settlement);
  const eligible = (p: Person): boolean => !p.death && p.id !== me.id && plainAge(H, p) >= 14 && !busy.has(p.id) && p.household !== me.household && ok(p);
  const sample: Person[] = [];
  if (all.length <= 24) { for (const p of all) if (eligible(p)) sample.push(p); }
  else for (let i = 0; i < 60 && sample.length < 24; i++) { const p = all[Math.floor(rng.next() * all.length)]; if (eligible(p) && !sample.includes(p)) sample.push(p); }
  if (sample.length === 0) return null;
  const w = sample.map((p) => {
    const op = H.deps.social.opinion(p.id, me.id);
    const kin = (p.father !== 0 && (p.father === me.father || p.father === me.id)) || (p.mother !== 0 && (p.mother === me.mother || p.mother === me.id)) || me.father === p.id || me.mother === p.id;
    return 1 + Math.max(0, op) / 25 + (kin ? 1.5 : 0) + (Math.abs(p.rankTier - me.rankTier) <= 1 ? 1 : 0);
  });
  return rng.weighted(sample, w);
}

function make(H: Hap, type: RequestType, from: Person, text: string, summary: string, data: RequestRec['data'], reward: RequestRec['reward'], offerDays?: number): RequestRec {
  const r: RequestRec = {
    id: H.save.nextReq++, type, from: from.id, settlement: from.settlement, state: 'offered', offered: H.day,
    expires: H.day + (offerDays ?? DATA.requests.offerDays), text, summary, data, reward,
  };
  H.save.reqs.push(r);
  H.save.lastOffer = H.day;
  H.bump('requests', 'offered');
  H.trimRequests();
  H.touch();
  H.sim.events.emit('request', { id: r.id, from: from.id, text });
  H.notifyPlayer(`${fullName(from)} has something to ask of you. Find them and speak.`, 'quest', `request:${r.id}`);
  return r;
}

const vars = (me: Person, from: Person, extra: Record<string, string | number> = {}): Record<string, string | number> => ({ name: me.first, from: from.first, ...extra });

const pickText = (H: Hap, pool: string[], v: Record<string, string | number>): string => fill(H.rng().pick(pool), v);

const BUILD: Record<RequestType, Builder> = {
  fetch(H, me, forcedFrom) {
    const cfg = DATA.requests.fetch;
    const famine = H.activeAtOf('famine', me.settlement) !== undefined;
    const rng = H.rng();
    const opt = rng.pick(famine ? cfg.famineGoods : cfg.goods);
    const from = pickRequester(H, me, () => true, forcedFrom);
    if (!from) return null;
    const qty = rng.int(opt.qty[0], opt.qty[1]);
    const eco = H.deps.economy;
    const price = eco.good(opt.good)?.basePrice ?? 4;
    const pence = Math.max(6, Math.round(price * qty * cfg.premium));
    const what = eco.describe(opt.good, qty);
    const g = eco.good(opt.good);
    return make(H, 'fetch', from, pickText(H, cfg.ask, vars(me, from, { good: g ? g.name.toLowerCase() : opt.good, qty: what })), `Bring ${what} to ${from.first}`,
      { good: opt.good, qty }, { pence, opinion: 4, points: 1 });
  },
  loan(H, me, forcedFrom) {
    const cfg = DATA.requests.loan;
    const from = pickRequester(H, me, (p) => p.rankTier <= 3, forcedFrom);
    if (!from) return null;
    const amounts = cfg.amounts;
    const idx = clamp(from.rankTier - 1 + H.rng().int(-1, 1), 0, amounts.length - 1);
    const pence = amounts[idx];
    if (me.money < pence) return null;
    return make(H, 'loan', from, pickText(H, cfg.ask, vars(me, from, { pence: formatMoney(pence) })), `Lend ${formatMoney(pence)} to ${from.first}`,
      { pence, interest: cfg.interest }, { pence: Math.round(pence * (1 + cfg.interest)), opinion: 6, points: 2 }, cfg.offerDays);
  },
  work(H, me, forcedFrom) {
    const cfg = DATA.requests.work;
    const from = pickRequester(H, me, (p) => p.career !== 'child' && p.career !== 'none' && p.rankTier <= me.rankTier + 1, forcedFrom);
    if (!from) return null;
    const count = H.rng().int(cfg.count[0], cfg.count[1]);
    return make(H, 'work', from, pickText(H, cfg.ask, vars(me, from, { qty: count })), `Do ${count} jobs of work for ${from.first}`,
      { count, done: 0 }, { pence: count * cfg.wage, opinion: 4, points: 1 });
  },
  message(H, me, forcedFrom) {
    const cfg = DATA.requests.message;
    const from = pickRequester(H, me, (p) => p.rankTier >= 2, forcedFrom);
    if (!from) return null;
    // the recipient lives in a neighbouring place
    const rng = H.rng();
    const near = H.world.settlements
      .filter((s) => s.id !== me.settlement && H.distance(me.settlement, s.id) <= DATA.requests.message.radius && H.state.residentsOf(s.id).length > 5)
      .sort((a, b) => H.distance(me.settlement, a.id) - H.distance(me.settlement, b.id) || a.id - b.id).slice(0, 5);
    if (near.length === 0) return null;
    const place = rng.pick(near);
    const pool = H.state.residentsOf(place.id).filter((p) => !p.death && plainAge(H, p) >= 18 && Math.abs(p.rankTier - from.rankTier) <= 1);
    if (pool.length === 0) return null;
    const to = pool[Math.floor(rng.next() * pool.length)];
    return make(H, 'message', from, pickText(H, cfg.ask, vars(me, from, { who: fullName(to), place: place.name })), `Carry ${from.first}'s message to ${fullName(to)} at ${place.name}`,
      { target: to.id, place: place.id }, { pence: cfg.pay, opinion: 5, points: 1 });
  },
  lost_animal(H, me, forcedFrom) {
    const cfg = DATA.requests.lost_animal;
    const from = pickRequester(H, me, (p) => ['farmer', 'shepherd', 'swineherd', 'cottar', 'labourer', 'yeoman'].includes(p.career), forcedFrom);
    if (!from) return null;
    const s = H.settlementById.get(from.settlement);
    if (!s) return null;
    const rng = H.rng();
    let x = 0, z = 0, ok = false;
    for (let i = 0; i < 8 && !ok; i++) {
      // out beyond the houses and fields, in the pasture and the wood
      const a = rng.range(0, Math.PI * 2), r = s.radius + rng.range(cfg.radius[0], cfg.radius[1]);
      x = s.x + Math.cos(a) * r; z = s.z + Math.sin(a) * r;
      ok = H.world.waterSurfaceAt(x, z) === null && Number.isFinite(H.world.walkCostAt(x, z));
    }
    if (!ok) return null;
    const animal = from.career === 'shepherd' ? 'sheep' : rng.pick(['sheep', 'pig', 'goat', 'cow']);
    return make(H, 'lost_animal', from, pickText(H, cfg.ask, vars(me, from, { animal: ANIMAL_WORDS[animal], dir: compass(s.x, s.z, x, z) })),
      `Find ${from.first}'s ${animal} (${compass(s.x, s.z, x, z)} of ${s.name})`, { x: Math.round(x), z: Math.round(z), animal }, { pence: cfg.pay, opinion: 5, points: 1 });
  },
  watch(H, me, forcedFrom) {
    const cfg = DATA.requests.watch;
    const danger = H.save.active.some((r) => (r.kind === 'bandits' || r.kind === 'winter' || r.kind === 'plague') && (r.settlement < 0 ? H.playerKingdom() === r.kingdom : H.nearPlayer(r.settlement, 4000)));
    if (!danger && !H.rng().chance(0.2)) return null;
    const from = pickRequester(H, me, (p) => p.rankTier >= 2 || p.career === 'woodward', forcedFrom);
    if (!from) return null;
    return make(H, 'watch', from, pickText(H, cfg.ask, vars(me, from)), `Keep watch over ${H.placeName(from.settlement)} through the night`,
      { hours: cfg.hours, watched: 0 }, { pence: cfg.pay, opinion: 6, points: 2 });
  },
  godparent(H, me, forcedFrom) {
    const cfg = DATA.requests.godparent;
    const from = pickRequester(H, me, (p) => {
      if (p.sex !== 'f') return false;
      const last = p.children.length ? H.state.persons.get(p.children[p.children.length - 1]) : undefined;
      return !!last && !last.death && plainAge(H, last) < 1.2 && last.household === p.household;
    }, forcedFrom);
    if (!from) return null;
    const child = from.children[from.children.length - 1];
    return make(H, 'godparent', from, pickText(H, cfg.ask, vars(me, from)), `Stand godparent to ${from.first}'s child`,
      { child }, { pence: cfg.gift, opinion: 10, points: 3 });
  },
  marriage(H, me, forcedFrom) {
    const cfg = DATA.requests.marriage;
    if (me.spouse || plainAge(H, me) < 16 || plainAge(H, me) > 48) return null;
    const heads = H.state.residentList(me.settlement).filter((p) => !p.death && p.id !== me.id && plainAge(H, p) >= 30 && Math.abs(p.rankTier - me.rankTier) <= 1 && p.household !== me.household && (forcedFrom === undefined || p.id === forcedFrom));
    const rng = H.rng();
    for (let i = 0; i < 12 && heads.length > 0; i++) {
      const head = heads[Math.floor(rng.next() * heads.length)];
      const hh = H.state.households.get(head.household);
      if (!hh || hh.head !== head.id) continue;
      for (const id of hh.members) {
        const w = H.state.persons.get(id);
        if (!w || w.death || w.id === head.id || w.spouse || w.sex === me.sex) continue;
        const age = plainAge(H, w);
        if (age < 16 || age > 36 || Math.abs(age - plainAge(H, me)) > 12 || isCloseKin(H.state, w, me)) continue;
        const dowry = Math.round(TIER_MONEY[head.rankTier] * 0.6);
        const relation = w.father === head.id || w.mother === head.id ? (w.sex === 'f' ? 'daughter' : 'son') : 'ward';
        return make(H, 'marriage', head, pickText(H, cfg.ask, vars(me, head, { ward: fullName(w), relation, pence: formatMoney(dowry) })), `${fullName(head)} offers ${w.first} in marriage`,
          { ward: w.id, pence: dowry }, { pence: dowry, opinion: 10, points: 8 });
      }
    }
    return null;
  },
};

/** Draws a request type by weight and builds it; tries the others if the first cannot be built. */
function offer(H: Hap, me: Person): RequestRec | null {
  const rng = H.rng();
  const pool = (Object.keys(DATA.requests.weights) as RequestType[]);
  while (pool.length) {
    const t = rng.weighted(pool, pool.map((x) => DATA.requests.weights[x]));
    pool.splice(pool.indexOf(t), 1);
    const made = BUILD[t](H, me);
    if (made) return made;
  }
  return null;
}

/** Offers a particular type (tests, tools, scenarios); with `from` that person is the one who asks. Returns the request id or 0. */
export function offerRequest(H: Hap, type: RequestType, from?: PersonId): number {
  const me = H.state.persons.get(H.playerId);
  if (!me || me.death) return 0;
  const r = BUILD[type](H, me, from);
  return r ? r.id : 0;
}

/** Each daytime hour: possibly offer a new request, keeping to the pacing target (a day is ten minutes of play: about one request every seven or eight). */
function maybeOffer(H: Hap): void {
  const me = H.state.persons.get(H.playerId);
  if (!me || me.death || H.state.run.phase !== 'alive') return;
  const cfg = DATA.requests;
  const open = H.save.reqs.filter((r) => r.state === 'offered' || r.state === 'accepted').length;
  if (open >= cfg.maxOpen) return;
  const since = H.day - H.save.lastOffer;
  if (since < cfg.minGapDays) return;
  // a long quiet spell makes the next request likelier
  const p = cfg.hourlyChance * H.diff('requests') + Math.min(0.5, Math.max(0, since - 1.2) * 0.35);
  if (!H.rng().chance(p)) return;
  offer(H, me);
}

// ---------------------------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------------------------

function haveGood(H: Hap, p: Person, good: string): number {
  let n = 0;
  for (const s of H.deps.economy.inventory(p.id).items) if (s.good.id === good) n += s.qty;
  return n;
}

export function acceptRequest(H: Hap, id: number): { ok: boolean; reason?: string } {
  const r = find(H, id);
  const me = H.state.persons.get(H.playerId);
  if (!r || !me) return { ok: false, reason: 'No such request' };
  if (r.state !== 'offered') return { ok: false, reason: 'Already settled' };
  const from = H.state.persons.get(r.from);
  if (!from || from.death) { settle(H, r, 'expired', 'They are no longer there'); return { ok: false, reason: 'They are no longer there' }; }
  const cfg = DATA.requests;
  switch (r.type) {
    case 'loan': {
      const pence = r.data.pence ?? 0;
      const res = H.deps.economy.give(me.id, from.id, 'money', pence);
      if (!res.ok) return { ok: false, reason: res.reason ?? 'You cannot afford it' };
      r.data.due = H.day + cfg.loan.days;
      r.expires = r.data.due;
      break;
    }
    case 'marriage': {
      const ward = H.state.persons.get(r.data.ward ?? 0);
      if (!ward || ward.death) { settle(H, r, 'failed', 'The match is no longer possible'); return { ok: false, reason: 'The match is no longer possible' }; }
      const res = H.deps.social.arrangeMatch(from.id, ward.id, me.id);
      if (!res.ok) { settle(H, r, 'failed', res.reason ?? 'The match cannot be made'); return { ok: false, reason: res.reason ?? 'The match cannot be made' }; }
      r.state = 'accepted';
      pay(H, from, me, r.reward.pence);
      complete(H, r, `${ward.first} and you are promised to each other (dowry ${formatMoney(r.reward.pence)}).`, false);
      return { ok: true };
    }
    case 'godparent': {
      const child = r.data.child ?? 0;
      const at = Math.floor(H.day) + 2 + 11 / 24;
      r.data.at = at;
      if (!H.save.queue.some((q) => q.kind === 'christening' && q.persons[0] === child)) {
        const c = H.state.persons.get(child);
        H.save.queue.push({ at, kind: 'christening', settlement: r.settlement, persons: [child], name: c ? fullName(c) : 'The child' });
      }
      r.expires = at + 0.5;
      break;
    }
    default:
      r.expires = H.day + (cfg[r.type] as { days: number }).days;
  }
  r.state = 'accepted';
  H.bump('requests', 'accepted');
  H.touch();
  H.notifyPlayer(`You agree: ${r.summary.charAt(0).toLowerCase()}${r.summary.slice(1)}.`, 'quest', `request:${r.id}`);
  return { ok: true };
}

export function declineRequest(H: Hap, id: number): { ok: boolean; reason?: string } {
  const r = find(H, id);
  if (!r) return { ok: false, reason: 'No such request' };
  if (r.state !== 'offered') return { ok: false, reason: 'Already settled' };
  settle(H, r, 'declined', 'You said no');
  H.deps.social.adjustOpinion(r.from, H.playerId, -1, 'would not help');
  return { ok: true };
}

function settle(H: Hap, r: RequestRec, state: RequestRec['state'], note: string): void {
  r.state = state;
  r.resolved = H.day;
  r.note = note;
  H.bump('requests', state);
  H.touch();
}

/** Pays from the asker's purse as far as it goes; the rest is the gratitude of the village. */
function pay(H: Hap, from: Person, to: Person, pence: number): void {
  if (pence <= 0) return;
  const real = Math.min(Math.floor(from.money * 0.8), pence);
  if (real > 0) { from.money = Math.round((from.money - real) * 100) / 100; H.state.touch(from); }
  to.money = Math.round((to.money + pence) * 100) / 100;
  H.state.touch(to);
}

function complete(H: Hap, r: RequestRec, text?: string, payReward = true): void {
  const me = H.state.persons.get(H.playerId);
  const from = H.state.persons.get(r.from);
  settle(H, r, 'done', text ?? 'Done');
  if (!me) return;
  if (from && payReward && r.type !== 'marriage' && r.type !== 'loan') pay(H, from, me, r.reward.pence);
  if (from) H.deps.social.adjustOpinion(from.id, me.id, r.reward.opinion, 'helped');
  me.rep.generosity += 1;
  H.state.touch(me);
  if (r.reward.points > 0) H.sim.score.award('deed', r.reward.points, `Helped ${from ? from.first : 'a neighbour'}`);
  const gain = payReward && r.reward.pence > 0 && r.type !== 'loan' ? ` (+${formatMoney(r.reward.pence)})` : '';
  H.notifyPlayer(`${text ?? 'Done'}${gain}`, 'gain', `request:${r.id}`);
}

function fail(H: Hap, r: RequestRec, note: string, blame = true): void {
  const me = H.state.persons.get(H.playerId);
  settle(H, r, 'failed', note);
  if (!me || !blame) { H.notifyPlayer(note, 'warn', `request:${r.id}`); return; }
  H.deps.social.adjustOpinion(r.from, me.id, -6, 'broke a promise');
  me.rep.honour -= 2;
  H.state.touch(me);
  H.notifyPlayer(`${note} ${H.state.persons.get(r.from)?.first ?? 'They'} thinks the less of you.`, 'loss', `request:${r.id}`);
}

// ---------------------------------------------------------------------------------------------
// Time: expiry, repayment, watches, christenings
// ---------------------------------------------------------------------------------------------

export function requestsDaily(H: Hap, _info: DayInfo): void {
  const me = H.state.persons.get(H.playerId);
  const now = H.day;
  for (const r of H.save.reqs.slice()) {
    if (r.state !== 'offered' && r.state !== 'accepted') continue;
    const from = H.state.persons.get(r.from);
    if (r.state === 'offered') {
      if (!from || from.death) { settle(H, r, 'expired', 'They are gone'); continue; }
      if (now >= r.expires) {
        settle(H, r, 'expired', 'Left unanswered');
        if (me) H.deps.social.adjustOpinion(r.from, me.id, -2, 'ignored them');
      }
      continue;
    }
    // accepted
    if (r.type === 'loan') {
      if (!from || from.death) { settle(H, r, 'failed', 'The borrower died; the debt is forgiven'); continue; }
      if (now >= (r.data.due ?? r.expires)) repay(H, r, from, me);
      continue;
    }
    if (r.type === 'message' && r.data.target) {
      const t = H.state.persons.get(r.data.target);
      if (!t || t.death) { fail(H, r, `${from ? from.first : 'The sender'}'s message cannot be delivered: ${t ? t.first : 'the recipient'} is dead.`, false); continue; }
    }
    if (now >= r.expires) fail(H, r, `You did not finish what you promised ${from ? from.first : 'them'}.`);
  }
}

function repay(H: Hap, r: RequestRec, from: Person, me: Person | undefined): void {
  const owed = r.reward.pence;
  const honest = from.traits.includes('honest') || !from.traits.includes('deceitful');
  const can = Math.min(owed, Math.max(0, Math.floor(from.money)));
  const share = honest ? can : Math.floor(can * 0.4);
  if (me && share > 0) {
    from.money = Math.round((from.money - share) * 100) / 100;
    me.money = Math.round((me.money + share) * 100) / 100;
    H.state.touch(from); H.state.touch(me);
  }
  if (!me) { settle(H, r, 'failed', 'No lender'); return; }
  if (share >= owed) {
    complete(H, r, `${from.first} repays ${formatMoney(share)}, with thanks.`, false);
    r.note = `Repaid ${formatMoney(share)}`;
  } else {
    settle(H, r, 'failed', share > 0 ? `${from.first} could repay only ${formatMoney(share)} of ${formatMoney(owed)}` : `${from.first} cannot repay`);
    H.notifyPlayer(r.note ?? '', 'warn', `request:${r.id}`);
    H.deps.social.adjustOpinion(from.id, me.id, -2, 'owes them');
  }
}

export function requestsHourly(H: Hap, info: HourInfo): void {
  const me = H.state.persons.get(H.playerId);
  if (!me || me.death) return;
  // people ask for help through the working day, not in the small hours
  if (info.hour >= 7 && info.hour <= 17) maybeOffer(H);
  const night = info.hour >= 20 || info.hour < 5;
  const body = H.deps.player?.body() ?? null;
  for (const r of H.save.reqs) {
    if (r.state !== 'accepted') continue;
    if (r.type === 'watch' && night) {
      const s = H.settlementById.get(r.settlement);
      const near = s ? (body ? Math.hypot(body.x - s.x, body.z - s.z) <= Math.max(140, s.radius + 40) : me.settlement === r.settlement) : false;
      if (near) {
        r.data.watched = (r.data.watched ?? 0) + 1;
        H.touch();
        if (r.data.watched >= (r.data.hours ?? 5)) complete(H, r, 'You kept the watch until dawn.');
      }
    } else if (r.type === 'godparent' && r.data.at !== undefined && H.day >= r.data.at && H.day < r.data.at + 0.4) {
      if (me.settlement === r.settlement) complete(H, r, `You stood godparent at the font.`);
    }
  }
}

/** About once a second of play: a strayed animal is found when the player stands where it is, and requesters in the zone walk up to the player. */
export function requestsStep(H: Hap, step: number): void {
  const me = H.state.persons.get(H.playerId);
  if (!me || me.death) return;
  const focus = H.sim.view.focus();
  for (const r of H.save.reqs) {
    if (r.state !== 'accepted' || r.type !== 'lost_animal' || r.data.x === undefined || r.data.z === undefined) continue;
    if (Math.hypot(focus.x - r.data.x, focus.z - (r.data.z as number)) <= DATA.requests.lost_animal.found) complete(H, r, `You find ${H.state.persons.get(r.from)?.first ?? 'the'}'s ${r.data.animal ?? 'animal'} and lead it home.`);
  }
  const zone = H.deps.zone;
  const body = H.deps.player?.body();
  if (!zone || !body) return;
  for (const [id, until] of H.approach) {
    if (step >= until) {
      const r = find(H, id);
      if (r) zone.command(r.from, { kind: 'resume' });
      H.approach.delete(id);
    }
  }
  for (const r of H.save.reqs) {
    if (r.state !== 'offered' || r.heard || H.approached.has(r.id)) continue;
    const ag = zone.agent(r.from);
    if (!ag || Math.hypot(ag.x - body.x, ag.z - body.z) > 90) continue;
    H.approached.add(r.id);
    zone.say(r.from, 'Excuse me, a word, if you please!', 6);
    zone.command(r.from, { kind: 'goto', x: body.x + Math.sin(body.yaw) * 2.5, z: body.z + Math.cos(body.yaw) * 2.5 });
    H.approach.set(r.id, step + 20 * 25);
  }
}

/** Work requests count the player's labour; the asker pays at once when the jobs are done. */
export function listenWork(H: Hap): () => void {
  return H.sim.events.on('action', (e) => {
    if (e.type !== 'completed' || !e.outcome.ok || e.actor !== H.playerId) return;
    const id = e.option.id;
    if (!WORK_IDS.test(id) || WORK_SKIP.test(id)) return;
    const me = H.state.persons.get(e.actor);
    if (!me) return;
    for (const r of H.save.reqs) {
      if (r.state !== 'accepted' || r.type !== 'work' || me.settlement !== r.settlement) continue;
      r.data.done = (r.data.done ?? 0) + 1;
      H.touch();
      if ((r.data.done ?? 0) >= (r.data.count ?? 3)) complete(H, r, `${H.state.persons.get(r.from)?.first ?? 'Your neighbour'} thanks you for the work.`);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The social topic: hearing, accepting, handing over, delivering, asking for work
// ---------------------------------------------------------------------------------------------

export function requestTopics(H: Hap): TopicProvider {
  const opt = (id: string, label: string, kind: DialogueOption['kind'], enabled = true, reason?: string, priority = 9): DialogueOption =>
    ({ id, provider: '', label, kind, enabled, reason, priority });
  return {
    id: 'requests',
    options(conv: Readonly<Conversation>, out: DialogueOption[]): void {
      if (conv.actor !== H.playerId) return;
      const me = H.state.persons.get(conv.actor), b = H.state.persons.get(conv.with);
      if (!me || !b || b.death) return;
      let theirs = false;
      for (const r of H.save.reqs) {
        if (r.from === b.id && r.state === 'offered') {
          theirs = true;
          if (!r.heard) out.push(opt(`req.hear.${r.id}`, `${b.first} seems to want a word. Ask what troubles them`, 'request', true, undefined, 20));
          else {
            const needs = r.type === 'loan' && me.money < (r.data.pence ?? 0);
            out.push(opt(`req.accept.${r.id}`, acceptLabel(r), 'request', !needs, needs ? `You do not have ${formatMoney(r.data.pence ?? 0)}` : undefined, 20));
            out.push(opt(`req.decline.${r.id}`, 'Decline politely', 'request', true, undefined, 19));
          }
        } else if (r.from === b.id && r.state === 'accepted' && r.type === 'fetch') {
          const have = haveGood(H, me, r.data.good ?? '');
          const qty = r.data.qty ?? 1;
          out.push(opt(`req.fetch.${r.id}`, `Hand over ${H.deps.economy.describe(r.data.good ?? '', qty)}`, 'request', have >= qty, have >= qty ? undefined : `You carry only ${Math.floor(have)}`, 20));
        } else if (r.state === 'accepted' && r.type === 'message' && r.data.target === b.id) {
          out.push(opt(`req.deliver.${r.id}`, `Deliver ${H.state.persons.get(r.from)?.first ?? 'their'}'s message`, 'request', true, undefined, 20));
        }
      }
      // ask whether there is anything to do
      if (!theirs && plainAge(H, b) >= 14 && b.household !== me.household && !H.cooling(`ask:${b.id}`, 4) && H.save.reqs.filter((r) => r.state === 'offered' || r.state === 'accepted').length < DATA.requests.maxOpen + 1) {
        out.push(opt('req.ask', 'Ask if there is anything you can do for them', 'request', true, undefined, 4));
      }
      out.push(opt('req.journal', 'Look over your promises and favours', 'ask', true, undefined, 1));
    },
    choose(conv: Readonly<Conversation>, option: DialogueOption): TopicReply {
      const me = H.state.persons.get(conv.actor) as Person, b = H.state.persons.get(conv.with) as Person;
      const [, verb, idText] = option.id.split('.');
      const id = Number(idText);
      const r = Number.isFinite(id) ? find(H, id) : undefined;
      switch (verb) {
        case 'journal': return { lines: [say(b.id, 'Keep your promises and you will be well thought of.', 'neutral')], ui: { panel: 'ext', name: 'requests' } };
        case 'ask': {
          H.save.cool[`ask:${b.id}`] = H.day;
          const op = H.deps.social.opinion(b.id, me.id);
          if (op < -5 || !H.rng().chance(0.45 + Math.max(0, op) / 100)) return { lines: [say(b.id, 'Nothing just now, but it is kind of you to ask.', 'neutral')], opinion: 1, reason: 'offered help' };
          const types = (Object.keys(DATA.requests.weights) as RequestType[]).filter((t) => t !== 'marriage' && t !== 'godparent');
          let made: RequestRec | null = null;
          const rng = H.rng();
          for (const t of rng.shuffle(types.slice())) { made = BUILD[t](H, me, b.id); if (made) break; }
          if (!made) return { lines: [say(b.id, 'No, nothing. But thank you.', 'neutral')], opinion: 1, reason: 'offered help' };
          made.heard = true;
          return { lines: [say(b.id, made.text, 'friendly')], opinion: 1, reason: 'offered help' };
        }
        case 'hear': {
          if (!r) return { lines: [] };
          r.heard = true;
          H.touch();
          return { lines: [say(b.id, r.text, 'sad')] };
        }
        case 'accept': {
          if (!r) return { lines: [] };
          const res = acceptRequest(H, r.id);
          if (!res.ok) return { lines: [say(b.id, res.reason ?? 'Never mind, then.', 'sad')] };
          return { lines: [say(b.id, fill(H.rng().pick(DATA.requests[r.type === 'marriage' ? 'marriage' : r.type].thanks), { name: me.first }), 'pleased')], opinion: 2, reason: 'agreed to help' };
        }
        case 'decline': {
          if (!r) return { lines: [] };
          settle(H, r, 'declined', 'You said no');
          return { lines: [say(b.id, 'I understand. I will manage somehow.', 'sad')], opinion: -1, reason: 'would not help' };
        }
        case 'fetch': {
          if (!r) return { lines: [] };
          const res = H.deps.economy.give(me.id, b.id, r.data.good ?? '', r.data.qty ?? 1);
          if (!res.ok) return { lines: [say(b.id, res.reason ?? 'That is not enough.', 'wary')] };
          complete(H, r, `${b.first} takes the goods and pays you.`);
          return { lines: [say(b.id, fill(H.rng().pick(DATA.requests.fetch.thanks), { name: me.first }), 'pleased')], opinion: 2 };
        }
        case 'deliver': {
          if (!r) return { lines: [] };
          complete(H, r, `${b.first} receives the message.`);
          const sender = H.state.persons.get(r.from);
          if (sender) H.deps.social.adjustOpinion(b.id, me.id, 2, 'brought word');
          return { lines: [say(b.id, fill(H.rng().pick(DATA.requests.message.delivered), { from: sender ? sender.first : 'my friend' }), 'pleased')] };
        }
      }
      return { lines: [] };
    },
  };
}

function acceptLabel(r: RequestRec): string {
  switch (r.type) {
    case 'fetch': return `Agree: ${r.summary}`;
    case 'loan': return `Lend ${formatMoney(r.data.pence ?? 0)}`;
    case 'work': return `Agree to help (${r.data.count} jobs)`;
    case 'message': return 'Agree to carry the message';
    case 'lost_animal': return 'Agree to look for the animal';
    case 'watch': return 'Agree to stand watch tonight';
    case 'godparent': return 'Agree to be godparent';
    case 'marriage': return 'Agree to the match';
  }
}
