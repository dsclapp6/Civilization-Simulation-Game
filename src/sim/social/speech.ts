// The text engine: picks a variant from a dialogue pool for who is speaking, to whom and in what
// situation; fills {placeholders}; chooses forms of address by culture, rank, age and kinship.
//
// Variation is cosmetic, so it uses hashes (never the simulation's RNG): a variant is chosen by weight
// (more specific variants — more matching conditions — are likelier) and the last few used by a
// speaker for a pool are avoided, so the same words do not come back at once.
import { CAREERS, roleLabel } from '../careers';
import { dayPart, isHolyDay, isMarketDay, type DayPart } from '../calendar';
import { kinshipLabel } from '../api';
import { toDate } from '../../core/time';
import { sampleWeather } from '../weather';
import { fullName, type Person } from '../state';
import { dialogueContent, type AddressForms, type Cond, type DialogueContent, type Pool } from './content';
import type { SocialCore } from './core';
import type { DialogueLine, Tone } from './types';
import { ageBand, capitalise, noise01, rankBand, type AgeBand, type RankBand } from './util';
import type { OpinionBucket } from './opinion';

export interface SpeechCtx {
  readonly speaker: Person;
  readonly listener: Person | null;
  readonly culture: string;
  readonly sex: 'm' | 'f';
  readonly age: AgeBand;
  readonly rank: RankBand;
  /** The listener's age band, or null when nobody is addressed. */
  readonly listenerAge: AgeBand | null;
  readonly rel: 'up' | 'down' | 'peer';
  readonly op: OpinionBucket;
  readonly part: DayPart;
  readonly season: number;
  readonly weather: string;
  readonly roles: ReadonlySet<string>;
  readonly place: string;
  readonly tags: Set<string>;
  /** Values for {placeholders} supplied by the caller. */
  readonly vars: Record<string, string>;
  readonly cache: Record<string, string>;
}

export interface Picked { text: string; tone?: Tone; index: number }

export interface CtxOptions {
  tags?: Iterable<string>;
  vars?: Record<string, string>;
  /** Skip the costlier lookups (courtship, debts, memories): barks. */
  light?: boolean;
}

const KIN_CLASS: Record<string, string> = {
  father: 'kin.father', mother: 'kin.mother', son: 'kin.son', daughter: 'kin.daughter', brother: 'kin.brother', sister: 'kin.sister',
  husband: 'kin.husband', wife: 'kin.wife', grandfather: 'kin.grandfather', grandmother: 'kin.grandmother',
  grandson: 'kin.grandson', granddaughter: 'kin.granddaughter', uncle: 'kin.uncle', aunt: 'kin.aunt', nephew: 'kin.nephew',
  niece: 'kin.niece', cousin: 'kin.cousin',
};

export class Speech {
  private readonly content: DialogueContent = dialogueContent();
  private readonly recent = new Map<string, number[]>();
  private counter = 0;
  private weatherHour = -1;
  private weatherWordCache = 'fair';
  /** Placeholders met that nothing could resolve (tests assert this stays empty). */
  readonly unknownVars = new Set<string>();
  /** Pools asked for that do not exist. */
  readonly missingPools = new Set<string>();

  constructor(private readonly core: SocialCore) {}

  // ---- content access ----

  has(poolId: string): boolean { return this.content.pools.has(poolId); }
  pool(poolId: string): Pool | undefined { return this.content.pools.get(poolId); }
  get tables(): DialogueContent['tables'] { return this.content.tables; }
  poolIds(): string[] { return [...this.content.pools.keys()]; }

  reasonUi(code: string): string { return this.content.tables.reasons[code]?.ui ?? code; }
  reasonMem(code: string): string { return this.content.tables.reasons[code]?.mem ?? ''; }
  reasonGood(code: string): boolean { return this.content.tables.reasons[code]?.good ?? true; }

  // ---- context ----

  ctx(speaker: Person, listener: Person | null, opts: CtxOptions = {}): SpeechCtx {
    const core = this.core;
    const now = core.now;
    const date = toDate(now);
    const tags = new Set<string>(opts.tags ?? []);
    const roles = new Set<string>();
    roles.add(speaker.career);
    roles.add(CAREERS[speaker.career]?.field ?? 'none');
    if (speaker.estate === 'clergy') roles.add('clergy');
    if (speaker.estate === 'noble') roles.add('noble');
    if (speaker.estate === 'unfree') roles.add('serf');
    if (speaker.offices.some((o) => o.office === 'reeve')) roles.add('reeve');
    if (core.state.titlesHeldBy(speaker.id).size > 0) roles.add('lord');
    let rel: 'up' | 'down' | 'peer' = 'peer';
    let op: OpinionBucket = 'neutral';
    if (listener) {
      const gap = core.perceivedStanding(speaker, listener) - (speaker.rankTier + (speaker.estate === 'clergy' && speaker.rankTier < 5 ? 0.5 : 0));
      rel = gap >= 1 ? 'up' : gap <= -1 ? 'down' : 'peer';
      op = core.opinion.bucket(core.opinion.total(speaker, listener));
      const kin = kinshipLabel(core.state, speaker, listener);
      if (kin) {
        tags.add('kin');
        if (kin === 'husband' || kin === 'wife') tags.add('spouse');
        else if (kin === 'father' || kin === 'mother') tags.add('parent');
        else if (kin === 'son' || kin === 'daughter') tags.add('child');
        else if (kin === 'brother' || kin === 'sister') tags.add('sibling');
      } else if (!core.knows(speaker, listener)) tags.add('stranger');
      if (op === 'devoted' || op === 'warm') tags.add('fond');
      if (core.opinion.total(speaker, listener) >= 28) tags.add('friend');
      if (op === 'hostile') tags.add('hostile');
      if (!opts.light) this.situationTags(speaker, listener, tags);
    }
    if (isHolyDay(now)) tags.add('holy');
    if (speaker.settlement >= 0 && isMarketDay(now, speaker.settlement) && core.settlement(speaker.settlement)?.market) tags.add('market');
    const part = dayPart(now);
    if (part === 'night') tags.add('night');
    if (speaker.needs.hunger < 0.3) tags.add('hungry');
    if (speaker.needs.rest < 0.3) tags.add('tired');
    if (speaker.needs.warmth < 0.3) tags.add('chilled');
    if (speaker.needs.mood < 0.3) tags.add('unhappy');
    if (speaker.needs.mood > 0.8) tags.add('cheerful');
    if (speaker.spouse) tags.add('married');
    else if (speaker.children.length > 0 && speaker.sex === 'f') tags.add('widowed');
    if (speaker.children.length > 0) tags.add('parent_of_children');
    if (speaker.career === 'beggar') tags.add('beggar');
    if (speaker.ambition) tags.add(`ambition_${speaker.ambition}`);
    return {
      speaker, listener, culture: speaker.culture, sex: speaker.sex, age: ageBand(core.age(speaker)),
      rank: rankBand(speaker.rankTier), listenerAge: listener ? ageBand(core.age(listener)) : null, rel, op, part, season: date.season, weather: this.weatherWord(), roles,
      place: core.settlement(speaker.settlement)?.kind ?? 'village', tags, vars: opts.vars ?? {}, cache: {},
    };
  }

  private situationTags(speaker: Person, listener: Person, tags: Set<string>): void {
    const core = this.core;
    const store = core.store;
    const court = store.courtOf(speaker.id, listener.id);
    if (court) tags.add(court.be ? 'betrothed' : court.p >= 0.15 ? 'sweetheart' : 'courted');
    for (const d of store.debtsOwedBy(listener.id)) if (d.from === speaker.id) { tags.add('debtor'); break; }
    for (const d of store.debtsOwedBy(speaker.id)) if (d.from === listener.id) { tags.add('creditor'); break; }
    const mem = store.memoriesOf(speaker.id, listener.id);
    if (mem.length > 0) {
      const last = mem[mem.length - 1];
      if (core.day - last.d <= 24) tags.add(last.v < 0 ? 'grudge' : 'favoured');
    }
  }

  /** A stable 0..1 for (id, today, salt): which of several things a person mentions today. */
  hash01(id: number, salt: string): number { return noise01(id, this.core.day, salt); }

  // ---- weather ----

  weatherWord(): string {
    const hour = Math.floor(this.core.now * 24);
    if (hour === this.weatherHour) return this.weatherWordCache;
    this.weatherHour = hour;
    const w = sampleWeather(this.core.state.seed, this.core.now);
    const wind = Math.hypot(w.windX, w.windZ);
    this.weatherWordCache = w.snow > 0.2 ? 'snow' : w.rain > 0.25 ? 'rain' : w.fog > 0.5 ? 'fog' : wind > 7.5 ? 'wind'
      : w.temperature < 3 ? 'cold' : w.temperature > 21 ? 'hot' : w.cloud > 0.7 ? 'cloudy' : 'fair';
    return this.weatherWordCache;
  }

  // ---- picking ----

  /** Chooses a variant of `poolId` for the context, or null when the pool is missing or nothing fits. */
  pick(poolId: string, ctx: SpeechCtx): Picked | null {
    const pool = this.content.pools.get(poolId);
    if (!pool) { this.missingPools.add(poolId); return null; }
    const lines = pool.lines;
    const cand: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const score = l.if ? matchScore(l.if, ctx) : 0;
      if (score < 0) continue;
      cand.push(i);
      weights.push(l.w * (1 + 1.5 * score));
    }
    if (cand.length === 0) return null;
    const key = `${ctx.speaker.id}|${poolId}`;
    const recent = this.recent.get(key);
    let total = 0;
    const eff: number[] = new Array(cand.length);
    for (let k = 0; k < cand.length; k++) {
      const seen = recent ? recent.lastIndexOf(cand[k]) : -1;
      // the more recently used, the less likely; the last one used is excluded when there is a choice
      const damp = seen < 0 ? 1 : seen === recent!.length - 1 ? (cand.length > 1 ? 0 : 1) : 0.25;
      eff[k] = weights[k] * damp;
      total += eff[k];
    }
    if (total <= 0) { for (let k = 0; k < cand.length; k++) { eff[k] = weights[k]; total += eff[k]; } }
    let r = noise01(ctx.speaker.id, ctx.listener?.id ?? 0, `${poolId}#${this.counter++}`) * total;
    let chosen = cand[cand.length - 1];
    for (let k = 0; k < cand.length; k++) {
      r -= eff[k];
      if (r <= 0) { chosen = cand[k]; break; }
    }
    if (this.recent.size > 4000) this.recent.clear();
    const hist = recent ?? [];
    hist.push(chosen);
    if (hist.length > Math.min(4, Math.max(1, lines.length - 1))) hist.shift();
    this.recent.set(key, hist);
    const line = lines[chosen];
    return { text: this.fill(line.t, ctx), tone: line.tone, index: chosen };
  }

  /** A DialogueLine spoken by the context's speaker, or null. */
  line(poolId: string, ctx: SpeechCtx, tone?: Tone): DialogueLine | null {
    const p = this.pick(poolId, ctx);
    if (!p) return null;
    return { speaker: ctx.speaker.id, text: p.text, tone: p.tone ?? tone };
  }

  /** Plain text of a pick ('' when nothing fits). */
  text(poolId: string, ctx: SpeechCtx): string { return this.pick(poolId, ctx)?.text ?? ''; }

  /** How many variants of a pool could be used in this context. */
  fitting(poolId: string, ctx: SpeechCtx): number {
    const pool = this.content.pools.get(poolId);
    if (!pool) return 0;
    let n = 0;
    for (const l of pool.lines) if (!l.if || matchScore(l.if, ctx) >= 0) n++;
    return n;
  }

  // ---- placeholders ----

  fill(template: string, ctx: SpeechCtx): string {
    if (template.indexOf('{') < 0) return template;
    const out = template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const direct = this.resolve(name, ctx);
      if (direct !== null) return direct;
      const lower = name.charAt(0).toLowerCase() + name.slice(1);
      if (lower !== name) {
        const v = this.resolve(lower, ctx);
        if (v !== null) return capitalise(v);
      }
      this.unknownVars.add(name);
      return '';
    });
    // a placeholder that resolved to nothing can leave doubled spaces or a space before punctuation
    return out.replace(/ {2,}/g, ' ').replace(/ ([,.;:!?])/g, '$1').trim();
  }

  private resolve(name: string, ctx: SpeechCtx): string | null {
    const c = ctx.cache[name];
    if (c !== undefined) return c;
    const given = ctx.vars[name];
    const v = given !== undefined ? given : this.builtin(name, ctx);
    if (v === null) return null;
    ctx.cache[name] = v;
    return v;
  }

  private builtin(name: string, ctx: SpeechCtx): string | null {
    const core = this.core;
    const sp = ctx.speaker;
    const ls = ctx.listener;
    switch (name) {
      case 'first': return ls ? ls.first : '';
      case 'full': return ls ? fullName(ls) : '';
      case 'byname': return ls ? (ls.byname || ls.first) : '';
      case 'self': return sp.first;
      case 'selffull': return fullName(sp);
      case 'addr': return ls ? this.address(sp, ls, false) : 'friend';
      case 'named': return ls ? this.address(sp, ls, true) : 'friend';
      case 'kin': return ls ? kinshipLabel(core.state, sp, ls) : '';
      case 'place': return core.placeName(sp.settlement);
      case 'lplace': return ls ? core.placeName(ls.settlement) : '';
      case 'lord': return this.lordLabel(sp.settlement);
      case 'priest': { const p = core.scene(sp.settlement).priest; return p ? this.clericLabel(p) : 'the priest'; }
      case 'reeve': { const r = core.scene(sp.settlement).reeve; return r ? `Reeve ${r.first}` : 'the reeve'; }
      case 'season': return ['spring', 'summer', 'autumn', 'winter'][ctx.season];
      case 'part': return ctx.part === 'dawn' ? 'dawn' : ctx.part === 'dusk' ? 'dusk' : ctx.part === 'midday' ? 'noon' : ctx.part === 'night' ? 'night' : ctx.part;
      case 'daygreet': return ctx.part === 'dawn' || ctx.part === 'morning' ? 'morning' : ctx.part === 'midday' ? 'day' : ctx.part === 'afternoon' ? 'afternoon' : ctx.part === 'night' ? 'night' : 'evening';
      case 'weather': return ctx.weather;
      case 'crop': return core.scene(sp.settlement).crop;
      case 'trade': return tradeWord(sp);
      case 'ltrade': return ls ? tradeWord(ls) : '';
      case 'spouse': { const s = sp.spouse ? core.person(sp.spouse) : undefined; return s ? s.first : ''; }
      case 'spouseword': return sp.sex === 'm' ? 'wife' : 'husband';
      case 'ambition': return this.content.tables.ambition[sp.ambition] ?? 'a quiet life';
      case 'holy': return 'holy day';
      case 'mood': return sp.needs.mood < 0.35 ? 'low' : sp.needs.mood > 0.7 ? 'good' : 'middling';
      default: return null;
    }
  }

  // ---- names and labels ----

  /** "Sir Miles Mortimer", "Lord Mortimer", "Master Hugh", "Abbot Hamo": the lord of a settlement, or "our lord". */
  lordLabel(settlement: number): string {
    const lord = this.core.scene(settlement).lord;
    return lord ? this.titled(lord) : 'the lord';
  }

  titled(p: Person): string {
    const by = p.byname || p.first;
    if (p.career === 'abbot') return p.sex === 'f' ? `Abbess ${p.first}` : `Abbot ${p.first}`;
    if (p.career === 'prior') return p.sex === 'f' ? `Prioress ${p.first}` : `Prior ${p.first}`;
    if (p.career === 'bishop') return `Bishop ${p.first}`;
    if (p.rankTier >= 6) return p.sex === 'f' ? `Lady ${by}` : `Lord ${by}`;
    if (p.rankTier === 5) return p.sex === 'f' ? `Lady ${p.first}` : `Sir ${p.first} ${p.byname}`.trim();
    if (p.rankTier === 4) return p.sex === 'f' ? `Mistress ${by}` : `Master ${by}`;
    return fullName(p);
  }

  clericLabel(p: Person): string {
    if (p.career === 'monk') return p.sex === 'f' ? `Sister ${p.first}` : `Brother ${p.first}`;
    if (p.career === 'nun') return `Sister ${p.first}`;
    if (p.career === 'priest') return `Father ${p.first}`;
    return this.titled(p);
  }

  // ---- forms of address ----

  /** What `speaker` calls `listener`: "my lord", "master", "Father Hamo", "friend", "Peter". */
  address(speaker: Person, listener: Person, named: boolean): string {
    const cls = this.addressClass(speaker, listener);
    const forms = this.formsFor(speaker.culture, cls);
    // the listener's sex picks the form; a fixed hash keeps the same pair on the same words
    const male = listener.sex === 'm';
    let list: string[] | undefined;
    if (named) list = (male ? forms.mn : forms.fn) ?? forms.anyn;
    if (!list || list.length === 0) list = (male ? forms.m : forms.f) ?? forms.any;
    if (!list || list.length === 0) return listener.first;
    const pick = list[Math.floor(noise01(speaker.id, listener.id, cls) * list.length)];
    const by = listener.byname || listener.first;
    return pick
      .replace('{first}', listener.first)
      .replace('{byname}', by)
      .replace('{full}', fullName(listener))
      .trim() || listener.first;
  }

  private formsFor(culture: string, cls: string): AddressForms {
    const table = this.content.tables.address;
    return table[culture]?.[cls] ?? table.default[cls] ?? table.default['peer.low'] ?? {};
  }

  addressClass(speaker: Person, listener: Person): string {
    const core = this.core;
    const kin = kinshipLabel(core.state, speaker, listener);
    if (kin) {
      if (KIN_CLASS[kin]) return KIN_CLASS[kin];
      return 'kin.in_law';
    }
    if (listener.estate === 'clergy' && speaker.estate !== 'clergy') {
      switch (listener.career) {
        case 'priest': return 'cleric.priest';
        case 'monk': return 'cleric.monk';
        case 'nun': return 'cleric.nun';
        case 'prior': return 'cleric.prior';
        case 'abbot': return 'cleric.abbot';
        case 'bishop': return 'cleric.bishop';
        case 'clerk': return 'cleric.clerk';
        default: break;
      }
    }
    const standing = core.perceivedStanding(speaker, listener);
    const own = speaker.rankTier + (speaker.estate === 'clergy' && speaker.rankTier < 5 ? 0.5 : 0);
    const gap = standing - own;
    const listenerAge = core.age(listener);
    const speakerAge = core.age(speaker);
    if (gap >= 1) {
      if (standing >= 7.5) return 'up.royal';
      if (standing >= 6.5) return 'up.magnate';
      if (standing >= 5.5) return 'up.baron';
      if (standing >= 4.5) return 'up.knight';
      if (standing >= 3.5) return 'up.gentry';
      if (standing >= 2.5) return 'up.middling';
      return 'up.commoner';
    }
    if (speakerAge < 14 && listenerAge >= 18) return 'youth.up';
    if (gap <= -1) {
      if (speaker.estate === 'clergy') return 'down.cleric';
      if (listenerAge < 12) return 'down.child';
      if (listenerAge < 18) return 'down.youth';
      return listenerAge >= 55 ? 'down.elder' : 'down.adult';
    }
    if (speaker.estate === 'clergy' && listener.estate !== 'clergy') return 'down.cleric';
    return standing >= 4.5 ? 'peer.high' : standing >= 2.5 ? 'peer.mid' : 'peer.low';
  }
}

function tradeWord(p: Person): string {
  const label = roleLabel(p.career, p.careerStage, p.sex);
  return label.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

function anyOf<T>(want: T | T[], have: (v: T) => boolean): boolean {
  if (Array.isArray(want)) { for (const w of want) if (have(w)) return true; return false; }
  return have(want);
}

/** −1 when the condition fails, else the number of keys that matched (a measure of how specific it is). */
export function matchScore(c: Cond, ctx: SpeechCtx): number {
  let score = 0;
  if (c.culture !== undefined) { if (!anyOf(c.culture, (v) => v === ctx.culture)) return -1; score++; }
  if (c.sex !== undefined) { if (c.sex !== ctx.sex) return -1; score++; }
  if (c.lsex !== undefined) { if (!ctx.listener || ctx.listener.sex !== c.lsex) return -1; score++; }
  if (c.lage !== undefined) { if (ctx.listenerAge === null || !anyOf(c.lage, (v) => v === ctx.listenerAge)) return -1; score++; }
  if (c.age !== undefined) { if (!anyOf(c.age, (v) => v === ctx.age)) return -1; score++; }
  if (c.rank !== undefined) { if (!anyOf(c.rank, (v) => v === ctx.rank)) return -1; score++; }
  if (c.rel !== undefined) { if (!anyOf(c.rel, (v) => v === ctx.rel)) return -1; score++; }
  if (c.op !== undefined) { if (!anyOf(c.op, (v) => v === ctx.op)) return -1; score++; }
  if (c.part !== undefined) { if (!anyOf(c.part, (v) => v === ctx.part)) return -1; score++; }
  if (c.season !== undefined) { if (!anyOf(c.season, (v) => v === ctx.season)) return -1; score++; }
  if (c.weather !== undefined) { if (!anyOf(c.weather, (v) => v === ctx.weather)) return -1; score++; }
  if (c.place !== undefined) { if (!anyOf(c.place, (v) => v === ctx.place)) return -1; score++; }
  if (c.trait !== undefined) { if (!anyOf(c.trait, (v) => ctx.speaker.traits.includes(v as never))) return -1; score++; }
  if (c.not !== undefined) { if (anyOf(c.not, (v) => ctx.speaker.traits.includes(v as never))) return -1; }
  if (c.role !== undefined) { if (!anyOf(c.role, (v) => ctx.roles.has(v))) return -1; score++; }
  if (c.tag !== undefined) {
    if (Array.isArray(c.tag)) { for (const t of c.tag) if (!ctx.tags.has(t)) return -1; score += c.tag.length; }
    else { if (!ctx.tags.has(c.tag)) return -1; score++; }
  }
  if (c.notTag !== undefined) { if (anyOf(c.notTag, (v) => ctx.tags.has(v))) return -1; }
  return score;
}
