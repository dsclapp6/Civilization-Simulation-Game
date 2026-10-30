// The conversation framework: start / choose / end / current. Starting one turns on action time (the
// calendar slows 20×) and ends it again; `conversation` events let the player controller hold and
// release the NPC. Options come from the built-in topics and every registered TopicProvider, sorted by
// priority; replies are lines with tone, and move the NPC's opinion and mood.
import { formatMoney } from '../money';
import type { Person, PersonId } from '../state';
import type { SocialCore } from './core';
import { BuiltinTopics, PAGE_LABELS } from './topics';
import type { Session } from './topics/kit';
import { OPINION } from './tuning';
import type { Conversation, DialogueLine, DialogueOption, Result, TopicProvider, TopicReply } from './types';

export function moodOf(op: number): Conversation['mood'] {
  return op >= OPINION.moodFriendlyFrom ? 'friendly' : op >= OPINION.moodWaryBelow ? 'neutral' : op >= OPINION.moodHostileBelow ? 'wary' : 'hostile';
}

export class Conversations {
  readonly builtin: BuiltinTopics;
  private readonly providers: TopicProvider[] = [];
  private cur: Session | null = null;
  private last: Session | null = null;
  private nextId = 1;

  constructor(private readonly core: SocialCore) {
    this.builtin = new BuiltinTopics(core, (id) => this.sessionById(id));
    this.providers.push(this.builtin);
  }

  // ---- providers ----

  registerTopic(p: TopicProvider): () => void {
    const dup = this.providers.findIndex((x) => x.id === p.id);
    if (dup >= 0) {
      console.warn(`social: topic provider ${p.id} registered twice; replacing`);
      this.providers.splice(dup, 1);
    }
    this.providers.push(p);
    return () => {
      const i = this.providers.indexOf(p);
      if (i >= 0) this.providers.splice(i, 1);
    };
  }

  // ---- reading ----

  current(): Conversation | null { return this.cur ? this.cur.conv : null; }

  sessionById(id: number): Session | undefined {
    if (this.cur && this.cur.conv.id === id) return this.cur;
    if (this.last && this.last.conv.id === id) return this.last;
    return undefined;
  }

  /** Why `actor` cannot talk to `other` now (their words or ours), or null when they can. */
  refusal(actor: Person | undefined, other: Person | undefined): string | null {
    const core = this.core;
    if (!actor || actor.death) return 'You cannot speak.';
    if (!other) return 'There is no one there.';
    if (other.death) return `${other.first} is dead.`;
    if (actor.id === other.id) return 'You talk to yourself, and no one answers.';
    if (core.age(other) < 3) return `${other.first} is too young to talk.`;
    if (!core.isAwake(other)) return `${other.first} is asleep.`;
    if (other.health.hp < 0.25 && other.health.conditions.some((c) => c.fatal)) return `${other.first} is too ill to speak.`;
    const op = core.opinion.total(other, actor);
    if (op <= OPINION.refuseAtOrBelow) {
      const said = core.speech.text('greet.refuse', core.speech.ctx(other, actor));
      return said || `${other.first} will not speak with you.`;
    }
    return null;
  }

  // ---- start / end ----

  start(actorId: PersonId, otherId: PersonId): Conversation | Result {
    const core = this.core;
    if (this.cur && !this.cur.conv.ended) {
      const c = this.cur.conv;
      if (c.actor === actorId && c.with === otherId) return c;
      return { ok: false, reason: 'You are already in a conversation.' };
    }
    const actor = core.person(actorId), other = core.person(otherId);
    const why = this.refusal(actor, other);
    if (why || !actor || !other) return { ok: false, reason: why ?? 'There is no one there.' };

    const op = core.opinion.total(other, actor);
    const conv: Conversation = {
      id: this.nextId++, actor: actor.id, with: other.id, lines: [], options: [], opinion: op, opinionDelta: 0,
      mood: moodOf(op), relation: core.relations.brief(actor, other), ended: false, page: 'root', pageLabel: '',
    };
    const s: Session = {
      conv, actor, other, startOpinion: op, page: 'root', used: new Map(), scratch: new Map(), turns: 0,
    };
    this.cur = s;
    core.sim.dispatch({ type: 'setActionTime', on: true });
    core.sim.events.emit('conversation', { phase: 'start', id: conv.id, actor: actor.id, with: other.id });
    conv.lines.push(...this.greeting(s));
    this.rebuild(s);
    return conv;
  }

  end(id: number): void {
    const s = this.sessionById(id);
    if (!s || s.conv.ended) return;
    this.finish(s);
  }

  /** Ends whatever conversation is open (a death, a switch of character, game over). */
  endAny(): void {
    if (this.cur) this.finish(this.cur);
  }

  involves(person: PersonId): boolean {
    return !!this.cur && !this.cur.conv.ended && (this.cur.conv.actor === person || this.cur.conv.with === person);
  }

  private finish(s: Session): void {
    const core = this.core;
    s.conv.ended = true;
    s.conv.options = [];
    if (this.cur === s) { this.cur = null; this.last = s; }
    core.sim.dispatch({ type: 'setActionTime', on: false });
    if (core.state.clock.actionTime) core.sim.clock.setActionTime(false); // e.g. the run just ended and commands are refused
    core.sim.events.emit('conversation', { phase: 'end', id: s.conv.id, actor: s.conv.actor, with: s.conv.with });
  }

  // ---- choosing ----

  choose(id: number, optionId: string): Conversation {
    const s = this.sessionById(id);
    if (!s) throw new Error(`social: no conversation ${id}`);
    const conv = s.conv;
    if (conv.ended) return conv;
    const core = this.core;
    const option = conv.options.find((o) => o.id === optionId);
    if (!option || !option.enabled) return conv;
    const provider = this.providers.find((p) => p.id === option.provider);
    if (!provider) return conv;

    const before = core.opinion.total(s.other, s.actor);
    let reply: TopicReply;
    try {
      reply = provider.choose(conv, option);
    } catch (err) {
      console.error(`social: topic ${option.provider}/${option.id} failed`, err);
      reply = { lines: [] };
    }
    s.turns++;
    if (reply.lines.length > 0) conv.lines.push(...reply.lines);
    const reason = reply.reason ?? option.label;
    if (reply.opinion) core.opinion.adjust(s.other.id, s.actor.id, reply.opinion, reason);
    if (reply.mood) {
      s.other.needs.mood = Math.round(Math.max(0, Math.min(1, s.other.needs.mood + reply.mood)) * 100) / 100;
      core.state.touch(s.other);
    }
    // company is a need too (SPEC §5): kind talk lifts your own spirits a little
    if ((reply.opinion ?? 0) > 0) {
      s.actor.needs.mood = Math.round(Math.min(1, s.actor.needs.mood + Math.min(0.02, (reply.opinion ?? 0) * 0.01)) * 100) / 100;
      core.state.touch(s.actor);
    }
    // pleasant company wins a sweetheart's heart a little
    if ((reply.opinion ?? 0) > 0 && option.kind !== 'court') core.courtship.advance(s.actor, s.other, 0.012, false);

    const after = core.opinion.total(s.other, s.actor);
    conv.opinion = after;
    conv.opinionDelta = after - s.startOpinion;
    conv.mood = moodOf(after);
    if (reply.ui) core.sim.events.emit('ui', reply.ui);

    // a conversation that turns bitter is cut short by the other
    let end = reply.end === true;
    if (!end && after <= OPINION.cutOffAtOrBelow && after < before) {
      const cut = core.speech.line('cutoff', core.speech.ctx(s.other, s.actor), 'angry');
      if (cut) conv.lines.push(cut);
      end = true;
    }
    if (end) { this.finish(s); return conv; }
    this.rebuild(s);
    return conv;
  }

  // ---- options ----

  private rebuild(s: Session): void {
    const conv = s.conv;
    const list: DialogueOption[] = [];
    for (const p of this.providers) {
      if (p !== this.builtin && s.page !== 'root') continue;
      const from = list.length;
      try {
        p.options(conv, list);
      } catch (err) {
        list.length = from;
        console.error(`social: topic provider ${p.id} failed`, err);
        continue;
      }
      for (let i = from; i < list.length; i++) list[i].provider = p.id;
    }
    const seen = new Set<string>();
    for (const o of list) {
      if (seen.has(o.id)) o.id = `${o.provider}:${o.id}`;
      seen.add(o.id);
    }
    const indexed = list.map((o, i) => ({ o, i }));
    indexed.sort((a, b) => {
      const la = a.o.kind === 'leave' ? 1 : 0, lb = b.o.kind === 'leave' ? 1 : 0;
      if (la !== lb) return la - lb;
      if (a.o.enabled !== b.o.enabled) return a.o.enabled ? -1 : 1;
      return (b.o.priority ?? 0) - (a.o.priority ?? 0) || a.i - b.i;
    });
    conv.options = indexed.map((x) => x.o);
    conv.page = s.page;
    conv.pageLabel = PAGE_LABELS[s.page] ?? '';
  }

  // ---- the greeting ----

  private greeting(s: Session): DialogueLine[] {
    const core = this.core;
    const out: DialogueLine[] = [];
    const npc = core.speech.ctx(s.other, s.actor);
    const hello = core.speech.line('greet.start', npc);
    if (hello) out.push(hello);
    const mem = core.store.memoriesOf(s.other.id, s.actor.id);
    const last = mem.length > 0 ? mem[mem.length - 1] : null;
    if (last) npc.vars.memory = core.speech.reasonMem(last.r);
    if (npc.tags.has('debtor')) {
      const owed = core.store.debtsOwedBy(s.actor.id).filter((d) => d.from === s.other.id).reduce((n, d) => n + d.v, 0);
      npc.vars.money = formatMoney(owed);
      const l = core.speech.line('greet.debt', npc);
      if (l) out.push(l);
    } else if (npc.tags.has('grudge') && last && npc.vars.memory) {
      const l = core.speech.line('greet.grudge', npc);
      if (l) out.push(l);
    } else if (npc.tags.has('favoured') && last && npc.vars.memory) {
      const l = core.speech.line('greet.favoured', npc);
      if (l) out.push(l);
    } else if (s.other.ambition !== 'content' && core.speech.hash01(s.other.id, `amb${core.day}`) < 0.3 && core.age(s.other) >= 12) {
      const l = core.speech.line('greet.ambition', npc);
      if (l) out.push(l);
    }
    return out;
  }
}
