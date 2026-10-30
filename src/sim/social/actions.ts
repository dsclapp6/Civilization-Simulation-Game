// Social verbs on the action layer (sim/actions.ts): Talk, Greet, Wrestle, Play with people;
// Pray, Hear Mass at churches, chapels and abbeys; Confess to a priest. Instant or short timed
// actions; the player controller lists and starts them. The "Talk" outcome opens the dialogue panel.
import { dayPart, isHolyDay } from '../calendar';
import type { ActionGain, ActionOption, ActionOutcome, ActionProvider, TargetRef } from '../actions';
import type { SimContext } from '../context';
import { gainSkill, skillOf, trainStat } from '../skills';
import type { Person, PersonId } from '../state';
import type { Conversations } from './conversation';
import type { SocialCore } from './core';
import { clamp } from './util';

const CHURCH_KINDS: ReadonlySet<string> = new Set(['church', 'chapel', 'abbey_church', 'cathedral']);

export function createSocialActions(core: SocialCore, convs: Conversations): ActionProvider {
  const provider: ActionProvider = {
    id: 'social',

    list(_ctx, actorId, target, out) {
      if (target.kind === 'person') listPerson(core, convs, actorId, target, out);
      else if (target.kind === 'building') listChurch(core, actorId, target, out);
    },

    check(_ctx, actorId, option) {
      const actor = core.living(actorId);
      if (!actor) return 'You are not able.';
      if (option.target.kind === 'person') {
        const other = core.living(option.target.id);
        if (!other) return 'They are gone.';
        if (option.id !== 'social.talk' && !core.isAwake(other)) return `${other.first} has turned away.`;
      }
      if (option.id === 'social.mass' && !massOpen(core, option.target)) return 'Mass is over.';
      return null;
    },

    complete(ctx, actorId, option) {
      const actor = core.living(actorId);
      if (!actor) return { ok: false };
      switch (option.id) {
        case 'social.talk': return talk(convs, actor, option);
        case 'social.greet': return greet(core, actor, option);
        case 'social.wrestle': return wrestle(core, ctx, actor, option);
        case 'social.play': return play(core, ctx, actor, option);
        case 'social.pray': return pray(core, actor);
        case 'social.mass': return mass(core, actor, option);
        case 'social.confess': return confess(core, actor, option);
        default: return { ok: false };
      }
    },
  };
  return provider;
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

function listPerson(core: SocialCore, convs: Conversations, actorId: PersonId, target: Extract<TargetRef, { kind: 'person' }>, out: ActionOption[]): void {
  const actor = core.living(actorId);
  const other = core.person(target.id);
  if (!actor || !other || actor.id === other.id) return;
  const base = { target, provider: '' } as const;
  const refusal = convs.refusal(actor, other);
  out.push({
    ...base, id: 'social.talk', label: 'Talk', category: 'talk', enabled: refusal === null, reason: refusal ?? undefined,
    seconds: 0, range: 4, priority: 60, preview: core.relations.describe(actor, other, false),
  });
  if (other.death) return;
  const awake = core.isAwake(other);
  const age = core.age(other), myAge = core.age(actor);
  out.push({
    ...base, id: 'social.greet', label: 'Greet', category: 'social', enabled: awake && age >= 3, reason: awake ? undefined : `${other.first} is asleep.`,
    seconds: 1.2, anim: 'wave', range: 8, priority: 40,
  });
  // sport for those of a size: same sex, youths and young men; games for the young
  const sameSex = other.sex === actor.sex;
  const peers = Math.abs(age - myAge) <= 8 && age >= 9 && age <= 45 && myAge >= 9 && myAge <= 45;
  const fit = actor.health.hp >= 0.6 && other.health.hp >= 0.6 && actor.health.conditions.length === 0 && !actor.pregnancy;
  const gap = Math.abs(other.rankTier - actor.rankTier);
  if (sameSex && peers && !core.hostile(other, actor)) {
    const reason = !awake ? `${other.first} is asleep.` : !fit ? 'Not in your condition.' : gap >= 2 ? 'Not with one so far above or below you.' : undefined;
    out.push({
      ...base, id: 'social.wrestle', label: 'Wrestle', category: 'social', enabled: reason === undefined, reason,
      seconds: 8, anim: 'work_lift', range: 3, priority: 30, preview: '+Strength · +Agility',
    });
  }
  const youngPlay = (age <= 16 && myAge <= 18) || (myAge <= 16 && age <= 18);
  if (youngPlay && !core.hostile(other, actor)) {
    out.push({
      ...base, id: 'social.play', label: 'Play', category: 'social', enabled: awake, reason: awake ? undefined : `${other.first} is asleep.`,
      seconds: 10, anim: 'dodge', range: 3, priority: 35, preview: '+Agility · good company',
    });
  }
  // confession
  if (other.estate === 'clergy' && (other.career === 'priest' || other.career === 'monk' || other.career === 'prior' || other.career === 'abbot') && other.sex === 'm') {
    const rec = core.store.read().mass;
    const recent = core.day - rec.conf < 4;
    out.push({
      ...base, id: 'social.confess', label: 'Confess', category: 'social', enabled: awake && !recent, reason: !awake ? `${other.first} is asleep.` : recent ? 'You have confessed so lately.' : undefined,
      seconds: 8, anim: 'kneel', range: 3, priority: 45, preview: '+Peace of mind · +Piety',
    });
  }
}

function listChurch(core: SocialCore, actorId: PersonId, target: Extract<TargetRef, { kind: 'building' }>, out: ActionOption[]): void {
  const b = core.state.buildings.get(target.id);
  if (!b || !CHURCH_KINDS.has(b.kind) || b.construction < 1) return;
  const actor = core.living(actorId);
  if (!actor) return;
  const base = { target, provider: '' } as const;
  out.push({
    ...base, id: 'social.pray', label: 'Pray', category: 'rest', enabled: true, seconds: 6, anim: 'pray', range: 14, priority: 50,
    preview: '+Piety · calm',
  });
  const open = massOpen(core, target);
  const why = !open ? massWhy(core, target) : undefined;
  out.push({
    ...base, id: 'social.mass', label: 'Hear Mass', category: 'rest', enabled: open, reason: why, seconds: 12, anim: 'pray', range: 14, priority: 55,
    preview: '+Piety · fellowship',
  });
}

// ---------------------------------------------------------------------------------------------
// Mass
// ---------------------------------------------------------------------------------------------

function buildingOf(core: SocialCore, target: TargetRef): { settlement: number; kind: string } | null {
  if (target.kind !== 'building') return null;
  const b = core.state.buildings.get(target.id);
  return b ? { settlement: b.settlement, kind: b.kind } : null;
}

/** Mass is said on holy days in the morning (daily in an abbey church or cathedral), where there is a priest or a monastery. */
export function massOpen(core: SocialCore, target: TargetRef): boolean {
  return massWhy(core, target) === undefined;
}

function massWhy(core: SocialCore, target: TargetRef): string | undefined {
  const b = buildingOf(core, target);
  if (!b) return 'There is no church here.';
  const daily = b.kind === 'abbey_church' || b.kind === 'cathedral';
  if (!daily && !isHolyDay(core.now)) return 'Mass is said on holy days.';
  if (core.store.read().mass.last === core.day) return 'You have heard Mass today.';
  const part = dayPart(core.now);
  if (part !== 'dawn' && part !== 'morning' && part !== 'midday') return 'Mass is said in the morning.';
  if (!daily && !core.scene(b.settlement).priest) return 'There is no priest to say Mass.';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

function talk(convs: Conversations, actor: Person, option: ActionOption): ActionOutcome {
  if (option.target.kind !== 'person') return { ok: false };
  const r = convs.start(actor.id, option.target.id);
  if ('ok' in r) return { ok: false, message: r.reason };
  return { ok: true, ui: { panel: 'dialogue', conversation: r.id } };
}

function greet(core: SocialCore, actor: Person, option: ActionOption): ActionOutcome {
  if (option.target.kind !== 'person') return { ok: false };
  const other = core.living(option.target.id);
  if (!other) return { ok: false };
  const rec = core.store.talkRec(actor.id, other.id, core.day, true);
  const first = !!rec && (rec.x & 2) === 0;
  if (rec) { rec.x |= 2; core.store.touch(); }
  if (first && rec && rec.n === 0) core.opinion.adjust(other.id, actor.id, 0.6, 'greeted');
  const said = core.barks.say(other.id, 'greet', actor.id);
  return { ok: true, message: said ? `${other.first}: "${said}"` : `${other.first} nods to you.` };
}

function wrestle(core: SocialCore, ctx: SimContext, actor: Person, option: ActionOption): ActionOutcome {
  if (option.target.kind !== 'person') return { ok: false };
  const other = core.living(option.target.id);
  if (!other) return { ok: false };
  const pWin = clamp(0.5 + 0.035 * (actor.trained.str - other.trained.str) + 0.02 * (actor.trained.agi - other.trained.agi) + 0.01 * (skillOf(actor, 'melee') - skillOf(other, 'melee')), 0.1, 0.9);
  const win = core.rng().next() < pWin;
  const str0 = actor.trained.str, agi0 = actor.trained.agi;
  trainStat(ctx, actor, 'str', win ? 0.07 : 0.05);
  trainStat(ctx, actor, 'agi', 0.03);
  const closeMatch = Math.abs(pWin - 0.5) < 0.15;
  core.opinion.adjust(other.id, actor.id, closeMatch ? 3 : 2, 'wrestled');
  const rec = core.store.talkRec(actor.id, other.id, core.day, true);
  if (win && rec && (rec.x & 4) === 0) { rec.x |= 4; core.store.touch(); core.opinion.addRep(actor, 'valour', 1); }
  const gains: ActionGain[] = [];
  const dStr = Math.round((actor.trained.str - str0) * 100) / 100, dAgi = Math.round((actor.trained.agi - agi0) * 100) / 100;
  if (dStr > 0) gains.push({ label: 'Strength', amount: dStr, ref: 'str' });
  if (dAgi > 0) gains.push({ label: 'Agility', amount: dAgi, ref: 'agi' });
  const text = core.speech.text(win ? 'act.wrestle.win' : 'act.wrestle.lose', core.speech.ctx(other, actor, { light: true }));
  return { ok: true, message: text || (win ? `You throw ${other.first}.` : `${other.first} throws you.`), gains };
}

function play(core: SocialCore, ctx: SimContext, actor: Person, option: ActionOption): ActionOutcome {
  if (option.target.kind !== 'person') return { ok: false };
  const other = core.living(option.target.id);
  if (!other) return { ok: false };
  const agi0 = actor.trained.agi;
  trainStat(ctx, actor, 'agi', 0.03);
  trainStat(ctx, actor, 'end', 0.02);
  for (const p of [actor, other]) {
    p.needs.mood = Math.round(Math.min(1, p.needs.mood + 0.05) * 100) / 100;
    core.state.touch(p);
  }
  core.opinion.adjust(other.id, actor.id, 1.5, 'played');
  if (core.age(actor) > core.age(other) + 2) gainSkill(ctx, actor, 'leadership', 3);
  const gains: ActionGain[] = [];
  const dAgi = Math.round((actor.trained.agi - agi0) * 100) / 100;
  if (dAgi > 0) gains.push({ label: 'Agility', amount: dAgi, ref: 'agi' });
  const text = core.speech.text('act.play', core.speech.ctx(other, actor, { light: true }));
  return { ok: true, message: text || `You and ${other.first} race about the green.`, gains };
}

function pray(core: SocialCore, actor: Person): ActionOutcome {
  const rec = core.store.write().mass;
  const first = rec.pray !== core.day;
  rec.pray = core.day;
  core.store.touch();
  actor.needs.mood = Math.round(Math.min(1, actor.needs.mood + 0.04) * 100) / 100;
  core.state.touch(actor);
  const gains: ActionGain[] = [];
  if (first) { core.opinion.addRep(actor, 'piety', 1); gains.push({ label: 'Piety', amount: 1 }); }
  const text = core.speech.text('act.pray', core.speech.ctx(actor, null, { light: true }));
  return { ok: true, message: text || 'You kneel and say a prayer.', gains };
}

function mass(core: SocialCore, actor: Person, option: ActionOption): ActionOutcome {
  const b = buildingOf(core, option.target);
  const rec = core.store.write().mass;
  rec.last = core.day;
  rec.missed = 0;
  if (isHolyDay(core.now)) rec.streak++;
  core.store.touch();
  core.opinion.addRep(actor, 'piety', 2);
  actor.needs.mood = Math.round(Math.min(1, actor.needs.mood + 0.1) * 100) / 100;
  core.state.touch(actor);
  const priest = b ? core.scene(b.settlement).priest : null;
  if (priest) core.opinion.adjust(priest.id, actor.id, 1.5, 'mass');
  const text = core.speech.text('act.mass', priest ? core.speech.ctx(priest, actor, { light: true }) : core.speech.ctx(actor, null, { light: true }));
  return { ok: true, message: text || 'You hear Mass with the parish.', gains: [{ label: 'Piety', amount: 2 }] };
}

function confess(core: SocialCore, actor: Person, option: ActionOption): ActionOutcome {
  if (option.target.kind !== 'person') return { ok: false };
  const priest = core.living(option.target.id);
  if (!priest) return { ok: false };
  const rec = core.store.write().mass;
  rec.conf = core.day;
  core.store.touch();
  const sins = actor.rep.cruelty >= 10 || actor.rep.honour <= -5 || core.store.read().mem.some((m) => m.a === actor.id && m.v < 0 && core.day - m.d <= 24);
  actor.needs.mood = Math.round(Math.min(1, actor.needs.mood + (sins ? 0.15 : 0.05)) * 100) / 100;
  core.state.touch(actor);
  core.opinion.addRep(actor, 'piety', 1);
  core.opinion.adjust(priest.id, actor.id, 1, 'confessed');
  const ctx = core.speech.ctx(priest, actor, { light: true, tags: sins ? ['sinful'] : ['blameless'] });
  const text = core.speech.text('act.confess', ctx);
  return { ok: true, message: text || `${priest.first} hears you and sets a penance.`, gains: [{ label: 'Piety', amount: 1 }] };
}

