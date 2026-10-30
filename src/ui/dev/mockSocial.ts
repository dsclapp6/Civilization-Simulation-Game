// A scripted fake of the social module for the gallery: a conversation with options of every kind,
// check chances, disabled reasons and opinion changes; relations; courtship and match candidates.
import { isCloseKin } from '../../sim/kin';
import { kinshipLabel } from '../../sim/api';
import type { Simulation } from '../../sim/sim';
import { fullName, ageYears, type PersonId } from '../../sim/state';
import type {
  Conversation, Courtship, DialogueLine, DialogueOption, RelationView, Result, SocialApi, TopicProvider,
} from '../../sim/social/types';

const GREETINGS = [
  'God give you good morrow. What brings you to my door?',
  'Well met, and God keep you. Have you come for something, or only to talk?',
  'Ah, it is you. Mind the dog. What is it?',
];

export class MockSocial implements SocialApi {
  private conv: Conversation | null = null;
  private seq = 100;
  private rolls = 0;
  private readonly courtships = new Map<string, number>();

  constructor(private readonly sim: Simulation) {}

  private name(id: PersonId): string { const p = this.sim.state.persons.get(id); return p ? p.first : 'they'; }

  private chance(base: number): number {
    // gentle spread so the numbers look like real checks
    const me = this.sim.state.persons.get(this.sim.state.run.playerId);
    const cha = me ? me.trained.cha : 10;
    return Math.max(0.05, Math.min(0.95, base + (cha - 10) * 0.025));
  }

  private roll(): number {
    this.rolls++;
    return ((this.rolls * 2654435761) % 1000) / 1000;
  }

  start(actor: PersonId, other: PersonId): Conversation | Result {
    const o = this.sim.state.persons.get(other);
    if (!o || o.death) return { ok: false, reason: 'They are not here.' };
    const opinion = this.opinion(other, actor);
    this.conv = {
      id: ++this.seq, actor, with: other,
      lines: [{ speaker: other, text: GREETINGS[this.seq % GREETINGS.length], tone: opinion >= 0 ? 'friendly' : 'wary' }],
      options: [], opinion, opinionDelta: 0, mood: opinion > 15 ? 'friendly' : opinion < -15 ? 'hostile' : 'neutral',
      relation: this.relationLabel(actor, other), ended: false,
    };
    this.refreshOptions(this.conv);
    this.sim.events.emit('conversation', { phase: 'start', id: this.conv.id, actor, with: other });
    return this.conv;
  }

  current(): Conversation | null { return this.conv; }

  end(conversation: number): void {
    if (!this.conv || this.conv.id !== conversation) return;
    const c = this.conv;
    c.ended = true;
    this.conv = null;
    this.sim.events.emit('conversation', { phase: 'end', id: c.id, actor: c.actor, with: c.with });
  }

  registerTopic(_provider: TopicProvider): () => void { return () => undefined; }

  private opt(id: string, label: string, kind: DialogueOption['kind'], extra: Partial<DialogueOption> = {}): DialogueOption {
    return { id, provider: 'mock', label, kind, enabled: true, ...extra };
  }

  private refreshOptions(c: Conversation): void {
    const me = this.sim.state.persons.get(c.actor);
    const other = this.sim.state.persons.get(c.with);
    const age = me ? ageYears(me, this.sim.absDay) : 12;
    const n = other ? other.first : 'them';
    c.options = [
      this.opt('news', 'Ask what news there is', 'news', { priority: 9 }),
      this.opt('chat', 'Pass the time of day', 'chat', { priority: 8 }),
      this.opt('trade', 'Ask what they have to trade', 'trade', { priority: 7 }),
      this.opt('work', 'Ask if there is any work', 'work', { priority: 6 }),
      this.opt('family', `Ask after ${n}’s family`, 'family', { priority: 5 }),
      this.opt('flatter', 'Flatter them', 'flatter', { chance: this.chance(0.55), priority: 4 }),
      this.opt('persuade', 'Persuade them to lower the rent', 'persuade', { chance: this.chance(0.38), priority: 3 }),
      this.opt('loan', 'Ask for a loan of sixpence', 'request', c.opinion >= 10
        ? { chance: this.chance(0.3), priority: 2 } : { enabled: false, reason: 'They do not know you well enough.', priority: 2 }),
      this.opt('court', 'Pay court to them', 'court', age >= 14 ? { chance: this.chance(0.25), priority: 1 } : { enabled: false, reason: 'You are too young.', priority: 1 }),
      this.opt('insult', 'Insult them', 'insult', { priority: 0 }),
      this.opt('leave', 'Take your leave', 'leave', { priority: -1 }),
    ];
  }

  choose(conversation: number, optionId: string): Conversation {
    const c = this.conv;
    if (!c || c.id !== conversation) throw new Error('no such conversation');
    const me = c.actor;
    const them = c.with;
    const say = (text: string, speaker = them, tone: DialogueLine['tone'] = 'neutral'): void => { c.lines.push({ speaker, text, tone }); };
    const opt = c.options.find((o) => o.id === optionId);
    if (!opt || !opt.enabled) return c;
    const nudge = (delta: number, reason: string): void => {
      c.opinion = Math.max(-100, Math.min(100, c.opinion + delta));
      c.opinionDelta += delta;
      this.sim.events.emit('opinion', { of: them, about: me, delta, reason });
    };
    say(opt.label.replace(/^Ask /, 'I ask ').replace(/^Take your leave/, 'I must be going.'), me, 'neutral');
    const win = opt.chance === undefined || this.roll() < opt.chance;
    switch (optionId) {
      case 'news': {
        const items = this.news(this.sim.state.persons.get(them)?.settlement ?? 0, 2);
        say(items.join(' '), them, 'friendly');
        break;
      }
      case 'chat': say('Fair weather for the work, God be thanked. The barley is coming on well.', them, 'friendly'); nudge(1, 'friendly talk'); break;
      case 'trade': say('A few things, if you have the coin.', them, 'neutral'); this.sim.events.emit('ui', { panel: 'trade', partner: { kind: 'person', id: them } }); break;
      case 'work': say('The reeve wants hands on the demesne this season. Ask him; tell him I sent you.', them, 'neutral'); break;
      case 'family': say('We are well enough. The youngest has a cough, but Mother Agnes has a draught for it.', them, 'warm'); nudge(1, 'asked after family'); break;
      case 'flatter': if (win) { say('Ha! You have a way with words, you do. Go on.', them, 'pleased'); nudge(4, 'flattery'); } else { say('Save your honey for the bees.', them, 'wary'); nudge(-2, 'clumsy flattery'); } break;
      case 'persuade': if (win) { say('Hm. You make a fair case. I will speak to the bailiff.', them, 'neutral'); nudge(2, 'a fair argument'); } else { say('The rent is the rent, child.', them, 'cold'); } break;
      case 'loan': if (win) { say('Sixpence, then. See that I have it back by Michaelmas.', them, 'neutral'); nudge(2, 'a loan'); } else { say('I have none to spare, and you know it.', them, 'cold'); nudge(-1, 'refused'); } break;
      case 'court': if (win) { say('You are bold. Perhaps I should like to see you at the next feast.', them, 'flirt'); nudge(5, 'courtship'); } else { say('You are too forward by half.', them, 'angry'); nudge(-4, 'unwelcome advances'); } break;
      case 'insult': say('You dare! Out of my sight!', them, 'angry'); nudge(-12, 'an insult'); break;
      case 'leave': say('God keep you.', them, 'friendly'); this.end(conversation); c.ended = true; return c;
      default: break;
    }
    c.mood = c.opinion > 15 ? 'friendly' : c.opinion < -15 ? 'hostile' : c.opinion < 0 ? 'wary' : 'neutral';
    this.refreshOptions(c);
    return c;
  }

  // ---------------------------------------------------------------- opinions

  opinion(of: PersonId, about: PersonId): number {
    const p = this.sim.state.persons.get(of);
    const base = p?.opinions[about] ?? 0;
    const q = this.sim.state.persons.get(about);
    return base + (p && q && (p.father === q.id || p.mother === q.id || q.father === p.id || q.mother === p.id) ? 30 : 4);
  }

  adjustOpinion(of: PersonId, about: PersonId, delta: number, reason: string): void {
    const p = this.sim.state.persons.get(of);
    if (!p) return;
    p.opinions[about] = Math.max(-100, Math.min(100, (p.opinions[about] ?? 0) + delta));
    this.sim.events.emit('opinion', { of, about, delta, reason });
  }

  relations(person: PersonId): RelationView[] {
    const p = this.sim.state.persons.get(person);
    if (!p) return [];
    const out: RelationView[] = [];
    for (const id of [p.father, p.mother, p.spouse, ...p.children]) {
      const q = id ? this.sim.state.persons.get(id) : undefined;
      if (!q) continue;
      out.push({ person: id, kinds: ['kin'], label: this.relationLabel(person, id), theirOpinion: this.opinion(id, person), myOpinion: this.opinion(person, id) });
    }
    return out;
  }

  relationLabel(viewer: PersonId, other: PersonId): string {
    const a = this.sim.state.persons.get(viewer);
    const b = this.sim.state.persons.get(other);
    if (!a || !b) return 'a stranger';
    const k = kinshipLabel(this.sim.state, a, b);
    if (k) return `your ${k}`;
    if (a.settlement === b.settlement) return b.career === 'priest' ? 'the parish priest' : 'a neighbour';
    return 'a stranger';
  }

  // ---------------------------------------------------------------- courtship

  private key(a: PersonId, b: PersonId): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }

  courtship(a: PersonId, b: PersonId): Courtship | null {
    const pa = this.sim.state.persons.get(a);
    const pb = this.sim.state.persons.get(b);
    if (!pa || !pb) return null;
    const progress = this.courtships.get(this.key(a, b)) ?? ((b * 7) % 10) / 10;
    const needs: PersonId[] = [];
    if (pb.father) needs.push(pb.father);
    if (pa.rankTier <= 1 && this.sim.state.titleFor('manor', pa.settlement)) needs.push(this.sim.state.titleFor('manor', pa.settlement)?.holder ?? 0);
    return { a, b, progress, needsConsentFrom: needs.filter(Boolean) };
  }

  propose(a: PersonId, b: PersonId): Result {
    const c = this.courtship(a, b);
    if (!c) return { ok: false, reason: 'No such person.' };
    if (c.progress < 1) return { ok: false, reason: 'The courtship has not gone far enough.' };
    return { ok: true };
  }

  arrangeMatch(head: PersonId, ward: PersonId, partner: PersonId): Result {
    void head;
    this.courtships.set(this.key(ward, partner), 1);
    return { ok: true };
  }

  matchCandidates(person: PersonId, limit = 6): PersonId[] {
    const me = this.sim.state.persons.get(person);
    if (!me) return [];
    const out: PersonId[] = [];
    for (const q of this.sim.state.residentsOf(me.settlement)) {
      if (q.id === me.id || q.sex === me.sex || q.spouse || q.death) continue;
      const age = ageYears(q, this.sim.absDay);
      if (age < 14 || age > 30 || isCloseKin(this.sim.state, me, q)) continue;
      out.push(q.id);
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- flavour

  bark(): string | null { return null; }

  news(settlement: number, limit = 3): string[] {
    void settlement;
    return [
      'the reeve means to hold the harvest feast on the green this year',
      'a pedlar came through from the next valley, selling needles and ribbons',
      'old Wat the miller is ailing, and his son is none too keen on the work',
      'wolves were seen near the forest edge at dusk',
    ].slice(0, limit).map((s) => `They say ${s}.`);
  }

  describeFor(id: PersonId): string { const p = this.sim.state.persons.get(id); return p ? fullName(p) : 'someone'; }
}
