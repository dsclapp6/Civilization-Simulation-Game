// What the player can do about techniques: ask a master to teach them one (for a fee), teach one to a
// pupil of their own, and study at the school, cloister or infirmary. Plus the listener that counts
// the player's completed actions as practice.
import type { ActionOption, ActionProvider } from '../actions';
import type { Conversation, DialogueLine, DialogueOption, TopicProvider, TopicReply } from '../social/types';
import { gainSkill } from '../skills';
import { formatMoney } from '../money';
import { ageYears, type Person, type PersonId } from '../state';
import type { Adv } from './core';
import { PLAYER_ACTION_TECHS, STUDY_BY_BUILDING, TECH_BY_ID, actionMatches } from './data';
import { canLearn, isMaster, practice } from './learning';
import type { Result, TechDef } from './types';

const say = (speaker: PersonId, text: string, tone?: DialogueLine['tone']): DialogueLine => (tone ? { speaker, text, tone } : { speaker, text });

/** Pays a teacher through the economy when it is installed, else directly. */
function pay(A: Adv, from: Person, to: Person, pence: number): boolean {
  if (pence <= 0) return true;
  if (from.money + 1e-9 < pence) return false;
  const r = A.deps.economy.give(from.id, to.id, 'money', pence);
  if (r.ok) return true;
  from.money = Math.round((from.money - pence) * 100) / 100;
  to.money = Math.round((to.money + pence) * 100) / 100;
  A.state.touch(from); A.state.touch(to);
  return true;
}

/** Teaches a technique; the outcome of the lesson is a roll unless forced. */
export function teach(A: Adv, teacherId: PersonId, learnerId: PersonId, tech: string, force = false): Result {
  const t = A.state.persons.get(teacherId), l = A.state.persons.get(learnerId);
  const def = TECH_BY_ID.get(tech);
  if (!t || !l || t.death || l.death) return { ok: false, reason: 'Nobody there' };
  if (!def) return { ok: false, reason: 'No such technique' };
  if (!A.knows(teacherId, tech)) return { ok: false, reason: `${t.first} does not know it` };
  if (!force && !isMaster(A, t, def)) return { ok: false, reason: `${t.first} is not skilled enough to teach it` };
  const can = canLearn(A, l, def);
  if (!can.ok) return can;
  if (!force) {
    const chance = Math.min(0.95, Math.max(0.3, 0.6 + 0.03 * (l.trained.int - 10) + 0.01 * (A.skillOf(t, 'persuasion') - 3)));
    if (!A.rng().chance(chance)) return { ok: false, reason: 'The lessons did not take; more practice is needed' };
  }
  A.grant(l, tech, 'taught');
  return { ok: true };
}

export function techTopics(A: Adv): TopicProvider {
  const opt = (id: string, label: string, enabled: boolean, reason: string | undefined, priority: number): DialogueOption =>
    ({ id, provider: '', label, kind: 'learn', enabled, reason, priority });
  return {
    id: 'advancement',
    options(conv: Readonly<Conversation>, out: DialogueOption[]): void {
      const a = A.state.persons.get(conv.actor), b = A.state.persons.get(conv.with);
      if (!a || !b || a.death || b.death) return;
      const social = A.deps.social;
      let shown = 0;
      for (const id of A.techsOf(b.id)) {
        if (shown >= 3) break;
        const def = TECH_BY_ID.get(id);
        if (!def || A.knows(a.id, id)) continue;
        if (!canLearn(A, a, def).ok || !isMaster(A, b, def)) continue;
        const fee = def.teach.fee;
        const op = social.opinion(b.id, a.id);
        const poor = a.money + 1e-9 < fee;
        const cold = op < -10;
        out.push(opt(`tech.learn.${id}`, `Ask ${b.first} to teach you ${def.name.toLowerCase()} (${formatMoney(fee)})`, !poor && !cold,
          poor ? `Lessons cost ${formatMoney(fee)}` : cold ? `${b.first} will not teach you` : undefined, 6 - shown * 0.1));
        shown++;
      }
      let teaches = 0;
      const kin = a.house === b.house || a.household === b.household;
      const apprentice = A.deps.economy.employment(b.id)?.employer === a.id;
      for (const id of A.techsOf(a.id)) {
        if (teaches >= 2) break;
        const def = TECH_BY_ID.get(id);
        if (!def || A.knows(b.id, id) || ageYears(b, A.day) < 12) continue;
        if (!canLearn(A, b, def).ok || !isMaster(A, a, def)) continue;
        if (!(kin || apprentice || social.opinion(b.id, a.id) >= 10)) continue;
        out.push(opt(`tech.teach.${id}`, `Teach ${b.first} ${def.name.toLowerCase()}`, true, undefined, 5 - teaches * 0.1));
        teaches++;
      }
    },
    choose(conv: Readonly<Conversation>, option: DialogueOption): TopicReply {
      const a = A.state.persons.get(conv.actor) as Person, b = A.state.persons.get(conv.with) as Person;
      if (option.id.startsWith('tech.learn.')) {
        const id = option.id.slice('tech.learn.'.length);
        const def = TECH_BY_ID.get(id) as TechDef;
        if (!pay(A, a, b, def.teach.fee)) return { lines: [say(b.id, 'Lessons are not given for nothing.', 'cold')] };
        const r = teach(A, b.id, a.id, id);
        return r.ok
          ? { lines: [say(b.id, `Watch closely, and do it as I do. There, you have it: ${def.name.toLowerCase()}.`, 'pleased')], opinion: 2, reason: 'lessons' }
          : { lines: [say(b.id, r.reason ?? 'It is not for everyone.', 'neutral')], reason: 'lessons' };
      }
      if (option.id.startsWith('tech.teach.')) {
        const id = option.id.slice('tech.teach.'.length);
        const def = TECH_BY_ID.get(id) as TechDef;
        const r = teach(A, a.id, b.id, id);
        return r.ok
          ? { lines: [say(b.id, `Now I see how it is done. Thank you, ${a.first}.`, 'pleased')], opinion: 4, reason: 'taught them' }
          : { lines: [say(b.id, r.reason ?? `I cannot make head or tail of ${def.name.toLowerCase()}.`, 'sad')] };
      }
      return { lines: [] };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Study at the school, cloister, cathedral, infirmary or guildhall
// ---------------------------------------------------------------------------------------------

export function studyProvider(A: Adv): ActionProvider {
  return {
    id: 'tech.study',
    list(_ctx, actor, target, out) {
      if (target.kind !== 'building' || actor !== A.playerId) return;
      const b = A.state.buildings.get(target.id);
      if (!b) return;
      const defs = STUDY_BY_BUILDING.get(b.kind);
      const p = A.state.persons.get(actor);
      if (!defs || !p) return;
      for (const def of defs) {
        if (A.knows(actor, def.id)) continue;
        const o: ActionOption = {
          id: `tech.study.${def.id}`, provider: '', label: `Study: ${def.name}`, category: 'learn', target, enabled: true,
          seconds: 20, anim: 'idle', mainHand: 'book', range: 10, priority: 22, repeat: true,
          preview: `${A.save.prog[def.id] ? `${Math.round(((A.save.prog[def.id] ?? 0) / (def.learn.player?.need ?? 1)) * 100)}% · ` : ''}${def.learn.skill ? `${def.learn.skill[0].toUpperCase()}${def.learn.skill.slice(1)} grows with the study` : 'Learn the craft'}`,
          data: { tech: def.id },
        };
        const can = canLearn(A, p, def);
        if (!can.ok) { o.enabled = false; o.reason = can.reason; }
        out.push(o);
      }
    },
    complete(ctx, actor, option) {
      const p = A.state.persons.get(actor);
      const id = (option.data as { tech?: string } | undefined)?.tech ?? '';
      const def = TECH_BY_ID.get(id);
      if (!p || !def) return { ok: false, message: 'Nothing comes of it.' };
      const gains = [];
      if (def.learn.skill) {
        gainSkill(ctx, p, def.learn.skill, 30);
        gains.push({ label: def.learn.skill, amount: 30, ref: def.learn.skill });
      }
      const learned = practice(A, p, def, 1);
      return { ok: true, message: learned ? `You have mastered ${def.name}.` : `You study ${def.name.toLowerCase()}.`, gains };
    },
  };
}

/** Counts the player's completed actions as practice towards the techniques they belong to. */
export function listenToActions(A: Adv): () => void {
  return A.sim.events.on('action', (e) => {
    if (e.type !== 'completed' || !e.outcome.ok) return;
    if (e.actor !== A.playerId) return;
    const p = A.state.persons.get(e.actor);
    if (!p) return;
    for (const def of PLAYER_ACTION_TECHS) {
      const acts = def.learn.player?.actions;
      if (acts && actionMatches(e.option.id, acts)) practice(A, p, def, 1);
    }
  });
}

