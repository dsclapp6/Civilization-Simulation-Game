// "Family matters…": asking consent to a courtship (a parent's blessing, the lord's leave), being
// sent to a master as an apprentice, discussing and arranging matches. Heads of households arrange
// matches for their wards (child, sibling) with the other family's head — opinion, rank and dowry decide.
import { kinshipLabel } from '../../api';
import { CAREERS, type CareerId } from '../../careers';
import { formatMoney } from '../../money';
import { fullName, type Person, type PersonId } from '../../state';
import { gainSkill } from '../../skills';
import type { ArrangeOutcome } from '../courtship';
import type { TopicReply } from '../types';
import { checkChance } from '../chance';
import { iSay, mkOption, npcSays, npcText, type TopicCtx, type TopicGroup } from './kit';
import { joinNames } from '../util';

const APPRENTICE_FROM: ReadonlySet<CareerId> = new Set<CareerId>(['child', 'none', 'labourer', 'farmer', 'cottar', 'shepherd', 'swineherd', 'servant']);

export function premiumFor(master: Person): number {
  return 12 * (4 + 2 * master.rankTier);
}

/** Master craftsmen of the actor's settlement who might take an apprentice. */
export function masterCandidates(t: TopicCtx): Person[] {
  const { core, actor } = t;
  const st = core.state;
  const out: Array<{ p: Person; key: number }> = [];
  for (const hh of st.householdList(actor.settlement)) {
    if (hh.kind !== 'family' || hh.members.length >= 9) continue;
    const head = core.living(hh.head);
    if (!head || head.id === actor.id || head.estate === 'clergy') continue;
    const def = CAREERS[head.career];
    if (def.field !== 'craft' || head.careerStage < 2) continue;
    if (def.sex && def.sex !== actor.sex) continue;
    const house = st.houses.get(head.house);
    let apprentices = 0;
    for (const id of hh.members) if (house?.sworn.includes(id)) apprentices++;
    if (apprentices >= 2) continue;
    out.push({ p: head, key: core.opinion.total(head, actor) + (head.id === actor.father ? 30 : 0) + head.trained.int * 0.3 - apprentices * 4 });
  }
  out.sort((a, b) => b.key - a.key || a.p.id - b.p.id);
  return out.slice(0, 3).map((x) => x.p);
}

function isGuardianOf(other: Person, actor: Person, core: TopicCtx['core']): boolean {
  if (actor.father === other.id || actor.mother === other.id) return true;
  const hh = core.state.households.get(actor.household);
  return !!hh && hh.head === other.id && other.id !== actor.id;
}

function apprenticeChance(t: TopicCtx, master: Person): number {
  const { core, actor, other } = t;
  const parentOk = checkChance(core, actor, other, { base: 0.78, opinionW: 0.003, chaW: 0.005, skillW: 0.004, extra: 0 });
  const masterOk = checkChance(core, actor, master, {
    base: 0.5, opinionW: 0.004, chaW: 0.01, skillW: 0.004, rankUp: -0.03, rankDown: 0.02,
    extra: (master.id === actor.father || master.id === actor.mother ? 0.3 : 0) + 0.015 * (actor.trained.str + actor.trained.int - 20) / 2,
    other: { patient: 0.05, hot_tempered: -0.05 },
  });
  return Math.round(parentOk * masterOk * 100) / 100;
}

interface Wards { ward: Person; cand: Person }

function wardPairs(t: TopicCtx): Wards[] {
  const { core, actor, other } = t;
  const st = core.state;
  const hh = st.households.get(actor.household);
  if (!hh || hh.head !== actor.id) return [];
  const wards: Person[] = [];
  for (const id of hh.members) {
    const w = core.living(id);
    if (w && w.id !== actor.id && !w.spouse && w.estate !== 'clergy' && core.age(w) >= 12 && core.courtship.hasAuthority(actor, w)) wards.push(w);
  }
  const cands: Person[] = [];
  const oh = st.households.get(other.household);
  if (oh && oh.head === other.id) for (const id of oh.members) { const c = core.living(id); if (c) cands.push(c); }
  else cands.push(other);
  const out: Wards[] = [];
  for (const w of wards) {
    for (const c of cands) {
      if (c.id === w.id || c.spouse || c.sex === w.sex || c.estate === 'clergy' || core.age(c) < 12) continue;
      const a = core.courtship.arrangeChance(actor, w, c);
      if (a.ok) out.push({ ward: w, cand: c });
    }
  }
  // the likeliest matches first
  out.sort((x, y) => core.courtship.arrangeChance(actor, y.ward, y.cand).chance - core.courtship.arrangeChance(actor, x.ward, x.cand).chance);
  return out.slice(0, 3);
}

export const familyGroup: TopicGroup = {
  prefix: 'family',

  options(t, out) {
    const { session } = t;
    if (session.page === 'root') {
      const probe: ReturnType<typeof mkOption>[] = [];
      collect(t, probe);
      if (probe.length > 0) out.push(mkOption('nav.family', 'Family matters…', 'family', { priority: 65 }));
      return;
    }
    if (session.page !== 'family') return;
    collect(t, out);
  },

  choose(t, option): TopicReply {
    const id = option.id;
    if (id.startsWith('family.consent.')) return consent(t, Number(id.slice('family.consent.'.length)));
    if (id.startsWith('family.apprentice.')) return apprentice(t, Number(id.slice('family.apprentice.'.length)));
    if (id.startsWith('family.foster.')) return foster(t, Number(id.slice('family.foster.'.length)));
    if (id.startsWith('family.match.')) return matchForSelf(t, Number(id.slice('family.match.'.length)));
    if (id.startsWith('family.propose.')) {
      const [w, c] = id.slice('family.propose.'.length).split('.').map(Number);
      return proposeMatch(t, w, c);
    }
    if (id === 'family.discuss') return discuss(t);
    return { lines: [] };
  },
};

function collect(t: TopicCtx, out: ReturnType<typeof mkOption>[]): void {
  const { core, actor, other } = t;
  const st = core.state;
  // consent for my courtships
  for (const rec of core.store.courtsInvolving(actor.id)) {
    if (rec.be) continue;
    const partner = core.living(rec.a === actor.id ? rec.b : rec.a);
    if (!partner) continue;
    const need = core.courtship.needsConsent(actor, partner).find((n) => n.who === other.id);
    if (!need || rec.ok.includes(other.id)) continue;
    const ward = core.person(need.ward) ?? actor;
    const asked = rec.no.find(([who]) => who === other.id);
    const waiting = !!asked && core.day - asked[1] < 8;
    const early = rec.p < 0.25;
    const chance = core.courtship.consentChance(actor, other, ward, ward.id === actor.id ? partner : actor, need.role);
    const label = need.role === 'lord' ? `Petition ${core.speech.titled(other)} for leave to wed ${partner.first}`
      : ward.id === actor.id ? `Ask ${other.first}'s blessing to wed ${partner.first}`
        : `Ask for ${partner.first}'s hand`;
    out.push(mkOption(`family.consent.${partner.id}`, label, 'marry', {
      chance, priority: 80,
      enabled: !waiting && !early,
      reason: waiting ? `${other.first} wants time to think.` : early ? `Court ${partner.first} a little longer first.` : undefined,
    }));
  }
  // an apprenticeship
  const age = core.age(actor);
  if (age >= 12 && age < 18 && isGuardianOf(other, actor, core) && APPRENTICE_FROM.has(actor.career) && actor.rankTier <= 3) {
    for (const m of masterCandidates(t)) {
      const premium = premiumFor(m);
      const hh = st.households.get(other.household);
      const pay = hh && hh.id === actor.household ? hh : st.households.get(actor.household);
      const afford = !!pay && pay.purse >= premium;
      const unfree = actor.estate === 'unfree';
      out.push(mkOption(`family.apprentice.${m.id}`, `Be apprenticed to ${m.first} the ${CAREERS[m.career].label.toLowerCase()} (${formatMoney(premium)})`, 'family', {
        chance: apprenticeChance(t, m), priority: 70,
        enabled: afford && !unfree,
        reason: unfree ? 'A serf\'s child needs the lord\'s leave to leave the manor.' : afford ? undefined : `The household cannot spare ${formatMoney(premium)}.`,
      }));
    }
  }
  // fostering, for the children of the gentry and above
  if (age >= 7 && age < 17 && actor.rankTier >= 4 && isGuardianOf(other, actor, core) && !actor.spouse) {
    for (const h of fosterHosts(t)) {
      out.push(mkOption(`family.foster.${h.id}`, `Ask to be fostered in ${h.first}'s household`, 'family', { chance: fosterChance(t, h), priority: 68 }));
    }
  }
  // a match arranged by my parent or head
  if (age >= 14 && !actor.spouse && core.courtship.hasAuthority(other, actor) && actor.estate !== 'clergy') {
    for (const id of core.courtship.matchCandidates(actor.id, 3)) {
      const c = core.person(id);
      if (!c) continue;
      const a = core.courtship.arrangeChance(other, actor, c);
      if (!a.ok) continue;
      out.push(mkOption(`family.match.${c.id}`, `Ask ${other.first} to arrange a match with ${c.first}`, 'family', {
        chance: a.chance, priority: 60, enabled: t.op >= -5, reason: t.op >= -5 ? undefined : `${other.first} wants no part in it.`,
      }));
    }
  }
  // I am the head: propose a match between my ward and their kin
  for (const w of wardPairs(t)) {
    const a = core.courtship.arrangeChance(actor, w.ward, w.cand);
    out.push(mkOption(`family.propose.${w.ward.id}.${w.cand.id}`, `Propose a match: ${w.ward.first} and ${w.cand.first}`, 'family', { chance: a.chance, priority: 62 }));
  }
  // talk it over
  const kin = !!t.npc.tags.has('kin');
  if (kin && age >= 14 && !actor.spouse) out.push(mkOption('family.discuss', 'Talk over whom you might marry', 'family', { priority: 40 }));
}

// ---------------------------------------------------------------------------------------------

function consent(t: TopicCtx, partnerId: PersonId): TopicReply {
  const { core, actor, other } = t;
  const partner = core.person(partnerId);
  if (!partner) return { lines: [] };
  t.me.vars.third = partner.first; t.npc.vars.third = partner.first;
  t.npc.vars.thirdfull = fullName(partner);
  const need = core.courtship.needsConsent(actor, partner).find((n) => n.who === other.id);
  const lines = iSay(t, need?.role === 'lord' ? 'family.lord.ask' : need && need.ward !== actor.id ? 'family.hand.ask' : 'family.blessing.ask');
  const res = core.courtship.askConsent(actor, other, partner);
  if (!res) return { lines: [...lines, ...npcSays(t, 'chat.repeat')] };
  gainSkill(core.sim, actor, 'persuasion', res.granted ? 7 : 3);
  const role = res.role === 'lord' ? 'lord' : need && need.ward !== actor.id ? 'hand' : 'blessing';
  if (res.wait) return { lines: [...lines, ...npcSays(t, `family.${role}.later`, 'wary')] };
  if (res.granted) {
    core.notify(`${other.first} consents to your match with ${partner.first}.`, 'social');
    return { lines: [...lines, ...npcSays(t, `family.${role}.yes`, 'warm')], opinion: 2, reason: 'consent' };
  }
  return { lines: [...lines, ...npcSays(t, `family.${role}.no`, 'cold')], opinion: -2, reason: 'refused' };
}

function apprentice(t: TopicCtx, masterId: PersonId): TopicReply {
  const { core, actor } = t;
  const st = core.state;
  const master = core.living(masterId);
  if (!master) return { lines: [] };
  const trade = CAREERS[master.career].label.toLowerCase();
  t.me.vars.third = master.first; t.npc.vars.third = master.first; t.me.vars.trade = trade; t.npc.vars.trade = trade;
  const premium = premiumFor(master);
  t.npc.vars.money = formatMoney(premium);
  const lines = iSay(t, 'family.apprentice.ask');
  const chance = apprenticeChance(t, master);
  if (!(core.rng().next() < chance)) return { lines: [...lines, ...npcSays(t, 'family.apprentice.no', 'wary')], reason: 'asked' };
  const payer = st.households.get(actor.household);
  const masterHh = st.households.get(master.household);
  if (!payer || !masterHh || payer.purse < premium) return { lines: [...lines, ...npcSays(t, 'family.apprentice.poor', 'sad')] };
  payer.purse -= premium; masterHh.purse += premium;
  st.touchHousehold(payer); st.touchHousehold(masterHh);
  const house = st.houses.get(master.house);
  st.leaveHousehold(actor);
  st.joinHousehold(actor, masterHh);
  if (house) { st.setHouse(actor, house.id); if (!house.sworn.includes(actor.id)) house.sworn.push(actor.id); st.touchHouse(house); }
  actor.career = master.career; actor.careerStage = 0; actor.rankTier = 2; actor.estate = 'free';
  st.touch(actor);
  core.opinion.adjust(master.id, actor.id, 3, 'apprenticed');
  core.notify(`You are apprenticed to ${fullName(master)}, ${trade}.`, 'gain');
  st.log(core.now, 'career', `${fullName(actor)} was apprenticed to ${fullName(master)}, ${trade}.`, [actor.id, master.id]);
  return { lines: [...lines, ...npcSays(t, 'family.apprentice.yes', 'warm')], opinion: 2, reason: 'apprenticed' };
}

// ---- fostering (gentry and nobility send their young to a kinsman's or a lord's household) ----

function fosterHosts(t: TopicCtx): Person[] {
  const { core, actor } = t;
  const st = core.state;
  const out: Array<{ p: Person; key: number }> = [];
  for (const hh of st.householdList(actor.settlement)) {
    if (hh.id === actor.household || (hh.kind !== 'family' && hh.kind !== 'lord') || hh.members.length >= 10) continue;
    const head = core.living(hh.head);
    if (!head || head.rankTier < Math.max(4, actor.rankTier) || head.estate === 'clergy') continue;
    const kin = kinshipLabel(st, actor, head);
    out.push({ p: head, key: (kin ? 50 : 0) + core.opinion.total(head, actor) - Math.abs(head.rankTier - actor.rankTier) * 4 });
  }
  out.sort((a, b) => b.key - a.key || a.p.id - b.p.id);
  return out.slice(0, 2).map((x) => x.p);
}

function fosterChance(t: TopicCtx, host: Person): number {
  const { core, actor, other } = t;
  const parentOk = checkChance(core, actor, other, { base: 0.78, opinionW: 0.003, chaW: 0.005, skillW: 0.004 });
  const kin = kinshipLabel(core.state, actor, host) !== '';
  const hostOk = checkChance(core, actor, host, {
    base: 0.45, opinionW: 0.004, chaW: 0.01, skillW: 0.004, rankUp: -0.02, rankDown: 0.02,
    extra: (kin ? 0.25 : 0) + 0.01 * (actor.trained.cha + actor.trained.int - 20) / 2, other: { patient: 0.05, hot_tempered: -0.05 },
  });
  return Math.round(parentOk * hostOk * 100) / 100;
}

function foster(t: TopicCtx, hostId: PersonId): TopicReply {
  const { core, actor } = t;
  const st = core.state;
  const host = core.living(hostId);
  if (!host) return { lines: [] };
  t.me.vars.third = host.first; t.npc.vars.third = host.first; t.npc.vars.thirdaddr = core.speech.address(t.other, host, true);
  const lines = iSay(t, 'family.foster.ask');
  if (!(core.rng().next() < fosterChance(t, host))) return { lines: [...lines, ...npcSays(t, 'family.foster.no', 'wary')], reason: 'asked' };
  const hostHh = st.households.get(host.household);
  if (!hostHh) return { lines };
  st.leaveHousehold(actor);
  st.joinHousehold(actor, hostHh);
  if (actor.sex === 'm') { actor.career = core.age(actor) < 14 ? 'page' : 'squire'; actor.careerStage = core.age(actor) < 14 ? 0 : 1; }
  st.touch(actor);
  core.opinion.adjust(host.id, actor.id, 3, 'apprenticed');
  core.notify(`You are fostered in the household of ${fullName(host)}.`, 'gain');
  st.log(core.now, 'career', `${fullName(actor)} was fostered in the household of ${fullName(host)}.`, [actor.id, host.id]);
  return { lines: [...lines, ...npcSays(t, 'family.foster.yes', 'warm')], opinion: 2, reason: 'apprenticed' };
}

function matchForSelf(t: TopicCtx, candId: PersonId): TopicReply {
  const { core, actor, other } = t;
  const cand = core.living(candId);
  if (!cand) return { lines: [] };
  t.me.vars.third = cand.first; t.npc.vars.third = cand.first; t.npc.vars.thirdfull = fullName(cand);
  const lines = iSay(t, 'family.match.ask');
  const out = core.courtship.arrange(other.id, actor.id, cand.id);
  return matchReply(t, lines, out, 'family.match');
}

function proposeMatch(t: TopicCtx, wardId: PersonId, candId: PersonId): TopicReply {
  const { core, actor } = t;
  const ward = core.living(wardId), cand = core.living(candId);
  if (!ward || !cand) return { lines: [] };
  t.me.vars.third = cand.first; t.npc.vars.third = cand.first; t.me.vars.ward = ward.first; t.npc.vars.ward = ward.first;
  t.npc.vars.thirdfull = fullName(cand);
  const lines = iSay(t, 'family.propose.ask');
  const out = core.courtship.arrange(actor.id, ward.id, cand.id);
  return matchReply(t, lines, out, 'family.propose');
}

function matchReply(t: TopicCtx, lines: ReturnType<typeof iSay>, out: ArrangeOutcome, pool: string): TopicReply {
  if (out.ok) {
    if (out.code === 'betrothed') t.npc.tags.add('betrothed');
    return { lines: [...lines, ...npcSays(t, `${pool}.yes`, 'warm')], opinion: 3, reason: 'match' };
  }
  t.npc.vars.money = formatMoney(out.dowryExpected);
  if (out.code === 'dowry') return { lines: [...lines, ...npcSays(t, `${pool}.dowry`, 'wary')] };
  if (out.code === 'refused') return { lines: [...lines, ...npcSays(t, `${pool}.no`, 'cold')] };
  return { lines: [...lines, npcText(t, out.reason, 'wary')] };
}

function discuss(t: TopicCtx): TopicReply {
  const { core, actor } = t;
  const lines = iSay(t, 'family.discuss.ask');
  const ids = core.courtship.matchCandidates(actor.id, 3);
  if (ids.length === 0) return { lines: [...lines, ...npcSays(t, 'family.discuss.none')] };
  const names = ids.map((id) => core.person(id)).filter((p): p is Person => !!p).map((p) => {
    const here = p.settlement === t.other.settlement ? '' : ` of ${core.placeName(p.settlement)}`;
    return `${fullName(p)}${here}`;
  });
  t.npc.vars.names = joinNames(names);
  t.npc.vars.first1 = core.person(ids[0])?.first ?? '';
  return { lines: [...lines, ...npcSays(t, 'family.discuss.reply', 'friendly')], opinion: 0.5, reason: 'chat' };
}

