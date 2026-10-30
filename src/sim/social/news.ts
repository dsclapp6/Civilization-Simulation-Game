// News and rumour (SPEC §18): what folk in a settlement are talking about. Most of it is read straight
// from the world — babies, burials, weddings, women with child, the sick, a new reeve — so nothing needs
// recording; a few things (an heir taking a title, the player's own deeds) are kept as small rumours in
// the save. News travels: an item is heard in another settlement after distance / spreadPerDay days.
import { fullName, type DeathCause, type Person, type PersonId } from '../state';
import type { SocialCore } from './core';
import type { SpeechCtx } from './speech';
import { NEWS } from './tuning';
import { capitalise } from './util';

export type NewsKind = 'birth' | 'death' | 'wedding' | 'expecting' | 'sick' | 'reeve' | 'inherit' | 'price' | 'deed';

export interface NewsItem {
  key: string;
  kind: NewsKind;
  /** Day it happened. */
  day: number;
  /** Where it happened. */
  origin: number;
  /** People it concerns (first is the main one). */
  persons: PersonId[];
  /** Importance 0..1 (nobles, kin of the listener …) before recency. */
  weight: number;
  /** Extra detail: rumour kind, title id, price good … */
  detail?: string;
  trend?: number;
}

const CAUSE_WORDS: Partial<Record<DeathCause, string>> = {
  old_age: 'of old age', illness: 'of a sickness', plague: 'of the plague', famine: 'of hunger', childbirth: 'in childbed',
  infancy: 'in the cradle', accident: 'by misadventure', violence: 'by a violent hand', battle: 'in battle',
  execution: 'on the gallows', exposure: 'of the cold', unknown: '',
};

export class NewsEngine {
  private cache: { key: string; items: NewsItem[] } | null = null;

  constructor(private readonly core: SocialCore) {}

  // ---- recording ----

  /** Remembers something worth gossip that cannot be read from the world later (see store.addRumour). */
  rumour(kind: string, settlement: number, a: PersonId, b: PersonId = 0, detail?: string): void {
    this.core.store.addRumour({ k: kind, d: this.core.day, s: settlement, a, b, x: detail });
    this.cache = null;
  }

  // ---- collecting ----

  /** Everything heard in `settlement` by now, most interesting first. */
  items(settlement: number): NewsItem[] {
    const core = this.core;
    const hour = Math.floor(core.now * 24);
    const ck = `${settlement}:${hour}:${core.store.read().rum.length}`;
    if (this.cache && this.cache.key === ck) return this.cache.items;
    const now = core.now;
    const out: NewsItem[] = [];
    const seen = new Set<string>();
    const add = (it: NewsItem): void => {
      if (seen.has(it.key)) return;
      const delay = it.origin === settlement ? 0 : core.distance(it.origin, settlement) / NEWS.spreadPerDay;
      if (now < it.day + delay) return; // has not arrived yet
      if (now - it.day > NEWS.lifetimeDays) return;
      seen.add(it.key);
      out.push(it);
    };
    const near = [{ id: settlement, dist: 0 }, ...core.nearby(settlement, NEWS.reach).slice(0, 8)];
    const player = core.person(core.playerId);
    const kin = player ? kinSet(core, player) : null;
    const weightFor = (p: Person, base: number): number => {
      let w = base;
      if (p.rankTier >= 4) w += 0.25;
      if (p.rankTier >= 6) w += 0.2;
      if (kin && kin.has(p.id)) w += 0.5;
      if (player && p.household === player.household) w += 0.2;
      return Math.min(1, w);
    };
    for (const { id, dist } of near) {
      const local = id === settlement;
      const reach = dist / NEWS.spreadPerDay;
      const horizon = now - NEWS.lifetimeDays;
      for (const p of core.state.residentsOf(id)) {
        if (p.birthDay >= horizon && p.birthDay + reach <= now && core.age(p) < 1.6) {
          add({ key: `b:${p.id}`, kind: 'birth', day: p.birthDay, origin: id, persons: [p.id, p.mother, p.father].filter(Boolean), weight: weightFor(p, 0.4) });
        }
        if (p.sex === 'f' && p.spouse && p.marriedDay >= horizon && p.marriedDay + reach <= now) {
          add({ key: `w:${p.id}`, kind: 'wedding', day: p.marriedDay, origin: id, persons: [p.spouse, p.id], weight: weightFor(p, 0.5) });
        }
        if (local) {
          if (p.pregnancy && p.sex === 'f' && p.pregnancy.due - now < 9) add({ key: `e:${p.id}`, kind: 'expecting', day: Math.max(horizon + 1, p.pregnancy.conceived + 4), origin: id, persons: [p.id], weight: weightFor(p, 0.2) });
          if (p.health.conditions.some((c) => c.fatal)) add({ key: `s:${p.id}`, kind: 'sick', day: now - 1, origin: id, persons: [p.id], weight: weightFor(p, 0.25) });
          for (const o of p.offices) {
            if (o.office === 'reeve' && o.place === id && o.since >= horizon) add({ key: `r:${p.id}:${o.since}`, kind: 'reeve', day: o.since, origin: id, persons: [p.id], weight: 0.45 });
          }
        }
      }
    }
    // deaths: the graveyard is ordered by day of death, newest last
    const g = core.state.graveyard;
    const nearIds = new Set(near.map((n) => n.id));
    for (let i = g.length - 1; i >= core.state.graveyardHead && i >= 0; i--) {
      const p = g[i];
      const dd = (p.death as { day: number }).day;
      if (now - dd > NEWS.lifetimeDays) break;
      if (!nearIds.has(p.settlement)) continue;
      add({ key: `d:${p.id}`, kind: 'death', day: dd, origin: p.settlement, persons: [p.id], weight: weightFor(p, 0.35), detail: p.death?.cause });
    }
    // recorded rumours
    const rum = core.store.read().rum;
    rum.forEach((r, i) => {
      const kind: NewsKind = r.k === 'inherit' ? 'inherit' : 'deed';
      const a = core.person(r.a);
      add({ key: `x:${r.k}:${r.d}:${r.a}:${i}`, kind, day: r.d, origin: r.s, persons: [r.a, r.b].filter(Boolean), weight: r.k === 'inherit' ? 0.6 : 0.45 + (a && a.id === core.playerId ? 0.2 : 0), detail: r.k === 'inherit' ? r.x : r.k });
    });
    // market gossip from the economy
    const tips = core.hooks.priceTipsHook?.(settlement) ?? [];
    for (const tip of tips) {
      if (Math.abs(tip.trend) < 0.12) continue;
      add({ key: `m:${tip.good}:${Math.floor(now / 4)}`, kind: 'price', day: now - 0.5, origin: settlement, persons: [], weight: 0.3 + Math.min(0.3, Math.abs(tip.trend)), detail: tip.good, trend: tip.trend });
    }
    out.sort((a, b) => score(b, now) - score(a, now) || (a.key < b.key ? -1 : 1));
    this.cache = { key: ck, items: out };
    return out;
  }

  // ---- telling ----

  /** Gossip lines for the API: up to `limit` items, no more than half of one kind. */
  news(settlement: number, limit = 5): string[] {
    const items = this.items(settlement);
    const narrator = this.narrator(settlement);
    if (!narrator) return [];
    const ctx = this.core.speech.ctx(narrator, null, { light: true });
    return this.pickVaried(items, limit).map((it) => this.render(it, ctx, settlement));
  }

  /** What `npc` tells the player now: fresh items first, remembered as told. */
  tell(npc: Person, count: number): string[] {
    const core = this.core;
    const told = core.store.read().told;
    const items = this.items(npc.settlement).filter((it) => told[it.key] === undefined || core.day - told[it.key] > NEWS.lifetimeDays);
    const ctx = core.speech.ctx(npc, core.person(core.playerId) ?? null);
    const chosen = this.pickVaried(items, count);
    const out: string[] = [];
    for (const it of chosen) {
      out.push(this.render(it, ctx, npc.settlement));
      core.store.markTold(it.key, core.day);
    }
    return out;
  }

  private pickVaried(items: NewsItem[], limit: number): NewsItem[] {
    const out: NewsItem[] = [];
    const per = new Map<NewsKind, number>();
    const cap = Math.max(1, Math.ceil(limit / 2));
    for (const it of items) {
      const n = per.get(it.kind) ?? 0;
      if (n >= cap) continue;
      per.set(it.kind, n + 1);
      out.push(it);
      if (out.length >= limit) break;
    }
    if (out.length < limit) for (const it of items) { if (!out.includes(it)) { out.push(it); if (out.length >= limit) break; } }
    return out;
  }

  private narrator(settlement: number): Person | null {
    const sc = this.core.scene(settlement);
    if (sc.priest) return sc.priest;
    if (sc.reeve) return sc.reeve;
    for (const p of this.core.state.residentsOf(settlement)) if (this.core.age(p) >= 18) return p;
    return null;
  }

  // ---- phrasing ----

  render(it: NewsItem, ctx: SpeechCtx, at: number): string {
    const seed = `${it.key}:${ctx.speaker.id}`;
    const core = this.core;
    const v: Record<string, string> = { ...ctx.vars };
    const who = it.persons[0] !== undefined ? core.person(it.persons[0]) : undefined;
    const second = it.persons[1] !== undefined ? core.person(it.persons[1]) : undefined;
    const tags: string[] = [];
    let pool = `news.item.${it.kind}`;
    if (who) {
      v.who = who.first; v.whofull = fullName(who);
      if (who.rankTier >= 5) tags.push('great');
    }
    if (it.origin !== at) { v.there = core.placeName(it.origin); tags.push('far'); }
    switch (it.kind) {
      case 'birth': {
        const mother = who && who.mother ? core.person(who.mother) : undefined;
        v.baby = who ? (who.sex === 'm' ? 'a boy' : 'a girl') : 'a child';
        v.babe = who ? (who.sex === 'm' ? 'boy' : 'girl') : 'child';
        v.mother = mother ? fullName(mother) : 'a woman of the parish';
        v.mothfirst = mother ? mother.first : 'the mother';
        if (who && who.father && who.father !== 0) { const f = core.person(who.father); if (f) v.father = f.first; }
        if (who?.death) tags.push('died');
        break;
      }
      case 'death': {
        if (who) {
          const age = Math.floor(core.age(who));
          v.age = String(age);
          v.cause = CAUSE_WORDS[it.detail as DeathCause] ?? '';
          if (age < 2) tags.push('infant'); else if (age < 16) tags.push('young'); else if (age >= 60) tags.push('old');
          if (it.detail === 'childbirth') tags.push('childbed');
          if (it.detail === 'plague') tags.push('plague');
          if (who.spouse) { const sp = core.person(who.spouse); if (sp && !sp.death) { v.widow = sp.first; tags.push('widowed'); } }
          if (who.sex === 'f') tags.push('woman'); else tags.push('man');
        }
        break;
      }
      case 'wedding': {
        if (who && second) { v.groom = who.first; v.bride = second.first; v.groomfull = fullName(who); v.bridefull = fullName(second); }
        break;
      }
      case 'inherit': {
        const title = it.detail ? core.state.titles.get(Number(it.detail)) : undefined;
        v.title = title ? title.name : 'the lordship';
        if (second) v.from = fullName(second);
        break;
      }
      case 'sick': {
        const c = who?.health.conditions.find((x) => x.fatal);
        v.ill = c ? ({ fever: 'a fever', flux: 'the flux', consumption: 'a wasting cough', frailty: 'the weakness of years', plague: 'the plague' } as Record<string, string>)[c.id] ?? 'a sickness' : 'a sickness';
        break;
      }
      case 'price': {
        v.good = (it.detail ?? 'grain').replace(/_/g, ' ');
        pool = (it.trend ?? 0) > 0 ? 'news.item.price_dear' : 'news.item.price_cheap';
        break;
      }
      case 'deed': {
        pool = `news.deed.${it.detail ?? 'other'}`;
        if (!core.speech.has(pool)) pool = 'news.deed.other';
        if (second) v.other = second.first;
        break;
      }
      default: break;
    }
    const local: SpeechCtx = { ...ctx, vars: v, cache: {}, tags: new Set([...ctx.tags, ...tags]) };
    const text = core.speech.text(pool, local, seed);
    if (!text) return '';
    if (it.origin !== at) {
      const lead = core.speech.text('news.far', local, `${seed}:far`);
      if (lead) return `${lead} ${capitalise(text)}`;
    }
    return capitalise(text);
  }
}

function score(it: NewsItem, now: number): number {
  const age = Math.max(0, now - it.day);
  return it.weight + 1 / (1 + age * 0.35);
}

function kinSet(core: SocialCore, p: Person): Set<PersonId> {
  const out = new Set<PersonId>();
  const add = (id: PersonId): void => { if (id) out.add(id); };
  add(p.father); add(p.mother); add(p.spouse);
  for (const c of p.children) add(c);
  const hh = core.state.households.get(p.household);
  if (hh) for (const m of hh.members) add(m);
  return out;
}

