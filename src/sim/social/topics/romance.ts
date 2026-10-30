// Courting and proposing (SPEC §15 marriage). Gestures win progress with a person; the courtship
// engine (courtship.ts) holds the rules — age, kinship, consent, the wedding itself.
import { formatMoney } from '../../money';
import { gainSkill } from '../../skills';
import type { Person } from '../../state';
import { checkChance } from '../chance';
import type { TopicReply } from '../types';
import { niceAmount, transferMoney } from './favours';
import { iSay, mkOption, npcSays, type TopicCtx, type TopicGroup } from './kit';

function gapOf(t: TopicCtx): number {
  const { core, actor, other } = t;
  const man = actor.sex === 'm' ? actor : other, woman = actor.sex === 'm' ? other : actor;
  return core.age(man) - core.age(woman);
}

/** Shared shape of a courting check. */
function courtChance(t: TopicCtx, base: number, opinionW: number, extra = 0): number {
  const { core, actor, other } = t;
  const dt = Math.abs(actor.rankTier - other.rankTier);
  return checkChance(core, actor, other, {
    base, opinionW, chaW: 0.025, skillW: 0.004, rankUp: 0, rankDown: 0,
    other: { pious: -0.05, hot_tempered: -0.02, deceitful: 0.03, content: 0.02 },
    actor: { comely: 0.08, scarred: -0.04 },
    extra: extra - 0.05 * dt - 0.01 * Math.max(0, Math.abs(gapOf(t) - 3) - 8),
  });
}

function tokenCost(actor: Person): number {
  return Math.min(48, Math.max(3, niceAmount(actor.money * 0.03)));
}

function usedToday(t: TopicCtx): number {
  const rec = t.core.store.talkRec(t.actor.id, t.other.id, t.core.day, false);
  return rec ? rec.c : 0;
}

function bump(t: TopicCtx): number {
  const rec = t.core.store.talkRec(t.actor.id, t.other.id, t.core.day, true);
  if (!rec) return 0;
  rec.c++;
  t.core.store.touch();
  return rec.c;
}

export const romanceGroup: TopicGroup = {
  prefix: 'romance',

  options(t, out) {
    const { session, core, actor, other } = t;
    const eligible = core.courtship.canCourt(actor, other);
    // offered when courting is possible, or fails for a reason worth explaining (rank, kinship, age); not to the married
    const explain = !eligible.ok && (eligible.code === 'rank' || eligible.code === 'age' || eligible.code === 'kin' || eligible.code === 'betrothed' || eligible.code === 'young');
    const plausible = eligible.ok || (explain && actor.sex !== other.sex && core.age(actor) >= 14);
    const rec = core.courtship.record(actor.id, other.id);
    if (session.page === 'root') {
      if (plausible || (rec && !actor.spouse)) {
        const pct = rec ? ` — ${Math.round(rec.p * 100)}% won` : '';
        out.push(mkOption('nav.court', `Court ${other.first}${pct}`, 'court', { enabled: eligible.ok, reason: eligible.reason, priority: 75, data: { progress: rec?.p ?? 0 } }));
      }
      if (rec && rec.p >= 0.5 && !actor.spouse && !other.spouse) {
        const block = core.courtship.proposalBlock(actor, other);
        // always askable: when something stands in the way, they say so themselves (consent, age, "not yet")
        out.push(mkOption('romance.propose', `Ask ${other.first} to marry you`, 'marry', {
          chance: block === null ? core.courtship.proposalChance(actor, other) : undefined, priority: 95, data: { blocked: block },
        }));
      }
      return;
    }
    if (session.page !== 'court') return;
    const tired = usedToday(t) >= 4;
    const why = tired ? 'Enough for one day; let it rest.' : undefined;
    out.push(mkOption('romance.compliment', `Pay ${other.first} a compliment`, 'court', { chance: courtChance(t, 0.5, 0.004), priority: 70, enabled: !tired, reason: why }));
    out.push(mkOption('romance.walk', `Ask ${other.first} to walk out with you`, 'court', { chance: courtChance(t, 0.4, 0.008), priority: 65, enabled: !tired, reason: why }));
    const cost = tokenCost(actor);
    const afford = actor.money >= cost;
    out.push(mkOption('romance.token', `Give ${other.first} a love token (${formatMoney(cost)})`, 'gift', {
      chance: courtChance(t, 0.62, 0.004, 0.05), priority: 60, enabled: afford && !tired, reason: tired ? why : afford ? undefined : 'You cannot afford one.',
    }));
    out.push(mkOption('romance.feelings', `Ask how ${other.first} feels about you`, 'ask', { priority: 40 }));
  },

  choose(t, option): TopicReply {
    switch (option.id) {
      case 'romance.compliment': return gesture(t, 'compliment');
      case 'romance.walk': return gesture(t, 'walk');
      case 'romance.token': return gesture(t, 'token');
      case 'romance.feelings': return feelings(t);
      case 'romance.propose': return propose(t);
      default: return { lines: [] };
    }
  },
};

type Gesture = 'compliment' | 'walk' | 'token';

function gesture(t: TopicCtx, kind: Gesture): TopicReply {
  const { core, actor, other } = t;
  const lines = iSay(t, `court.${kind}.ask`);
  const el = core.courtship.canCourt(actor, other);
  if (!el.ok) return { lines: [...lines, ...npcSays(t, 'court.refuse', 'cold')] };
  const chance = kind === 'compliment' ? courtChance(t, 0.5, 0.004) : kind === 'walk' ? courtChance(t, 0.4, 0.008) : courtChance(t, 0.62, 0.004, 0.05);
  const nth = bump(t);
  const fresh = Math.max(0.4, 1 - 0.15 * (nth - 1));
  const yes = core.rng().next() < chance;
  gainSkill(core.sim, actor, 'persuasion', yes ? 4 : 2);
  if (!yes) {
    core.courtship.advance(actor, other, -0.02, false);
    return { lines: [...lines, ...npcSays(t, `court.${kind}.no`, 'wary')], opinion: -1, reason: 'rebuffed' };
  }
  let progress = 0;
  let gain = 0;
  if (kind === 'compliment') { progress = Math.min(0.08, 0.05 + 0.002 * (actor.trained.cha - 10)); gain = 2.2; }
  else if (kind === 'walk') { progress = 0.08; gain = 3; }
  else {
    const cost = tokenCost(actor);
    const r = transferMoney(core, actor, other, cost);
    if (!r.ok) return { lines: [{ speaker: actor.id, text: r.reason ?? 'You cannot afford it.' }] };
    t.npc.vars.money = formatMoney(cost);
    progress = 0.1; gain = 3.5;
  }
  const now = core.courtship.advance(actor, other, progress * fresh);
  if (kind === 'token') t.me.vars.money = t.npc.vars.money;
  const tone = now >= 0.8 ? 'flirt' : 'friendly';
  const out: TopicReply = { lines: [...lines, ...npcSays(t, `court.${kind}.yes`, tone)], opinion: Math.round(gain * fresh * 10) / 10, reason: 'courted', mood: 0.03 };
  if (now >= 1) core.notify(`${other.first} has given you their heart.`, 'social');
  return out;
}

function feelings(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const lines = iSay(t, 'court.feelings.ask');
  const rec = core.courtship.record(actor.id, other.id);
  const p = rec ? rec.p : 0;
  t.npc.tags.add(`feel_${core.opinion.bucket(t.op)}`);
  t.npc.tags.add(p >= 0.9 ? 'p_high' : p >= 0.4 ? 'p_mid' : 'p_low');
  const block = rec ? core.courtship.outstanding(rec) : [];
  if (block.length > 0) {
    const names = block.map((id) => core.person(id)?.first ?? 'their kin');
    t.npc.vars.who = names.join(' and ');
    t.npc.tags.add('needs_consent');
  }
  return { lines: [...lines, ...npcSays(t, 'court.feelings.reply', 'friendly')] };
}

function propose(t: TopicCtx): TopicReply {
  const { core, actor, other } = t;
  const lines = iSay(t, 'court.propose.ask');
  const block = core.courtship.proposalBlock(actor, other);
  if (block) {
    const rec = core.courtship.record(actor.id, other.id);
    const missing = rec ? core.courtship.outstanding(rec) : [];
    if (missing.length > 0) {
      t.npc.vars.who = missing.map((id) => core.person(id)?.first ?? 'my kin').join(' and ');
      return { lines: [...lines, ...npcSays(t, 'court.propose.consent', 'wary')] };
    }
    return { lines: [...lines, ...npcSays(t, core.age(other) < 16 || core.age(actor) < 16 ? 'court.propose.young' : 'court.propose.later', 'wary')] };
  }
  const r = core.courtship.propose(actor.id, other.id);
  if (!r.ok) return { lines: [...lines, ...npcSays(t, 'court.propose.no', 'sad')], reason: 'refused' };
  return { lines: [...lines, ...npcSays(t, 'court.propose.yes', 'warm')], reason: 'wed', mood: 0.1 };
}
