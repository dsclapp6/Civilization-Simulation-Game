// A believable fake economy for the UI gallery: goods with SPEC §4 price ratios, one market, jobs, career
// paths, holdings, listings, obligations, ledger, household plan and perks. It implements the EconomyApi
// contract against the real simulation's people so every panel has something sensible to show.
import type { AnimalKind, SkillId } from '../../core/domain';
import { SKILLS } from '../../core/domain';
import { PERK_LEVELS, openPerkSlots } from '../../sim/skills';
import { skillLevel } from '../../sim/people';
import { CAREERS, STAGE_LABELS, type CareerField } from '../../sim/careers';
import { isMarketDay, marketDayOf, nextMarketDay } from '../../sim/calendar';
import {
  QUALITY_NAMES, itemKey, parseItemKey,
  type CareerPath, type EconomyApi, type EntryTest, type Employment, type GoodDef, type HoldingView, type HouseholdPlanLine,
  type HouseholdTask, type InventoryView, type ItemKey, type ItemStack, type JobOffer, type LedgerLine, type MarketLine, type MarketView,
  type Obligation, type PerkChoice, type PerkDef, type PropertyListing, type Quality, type Requirement, type Result, type TradeLine,
  type TradeQuote, type TradeResult, type EquipSlot,
} from '../../sim/economy/types';
import type { TradePartnerRef } from '../../sim/actions';
import type { Simulation } from '../../sim/sim';
import { ageYears, type PersonId } from '../../sim/state';

const g = (id: string, name: string, unit: string, category: GoodDef['category'], basePrice: number, weight: number, extra: Partial<GoodDef> = {}): GoodDef =>
  ({ id, name, unit, category, basePrice, weight, ...extra });

export const MOCK_GOODS: readonly GoodDef[] = [
  g('wheat', 'wheat', 'bushels of wheat', 'grain', 7, 2.5, { food: 0.1, spoilDays: 300 }),
  g('barley', 'barley', 'bushels of barley', 'grain', 5, 2.4, { food: 0.1 }),
  g('oats', 'oats', 'bushels of oats', 'grain', 3, 1.8, { food: 0.08 }),
  g('rye', 'rye', 'bushels of rye', 'grain', 6, 2.5, { food: 0.1 }),
  g('flour', 'flour', 'measures of flour', 'food', 9, 2, { food: 0.12 }),
  g('bread', 'bread', 'loaves of bread', 'food', 1, 0.7, { food: 0.3, spoilDays: 4 }),
  g('ale', 'ale', 'gallons of ale', 'drink', 1, 4, { food: 0.12, spoilDays: 6 }),
  g('cheese', 'cheese', 'wedges of cheese', 'food', 3, 0.5, { food: 0.25, spoilDays: 30 }),
  g('meat', 'meat', 'joints of meat', 'food', 6, 1.5, { food: 0.35, spoilDays: 5 }),
  g('fish', 'fish', 'fish', 'food', 1, 0.6, { food: 0.2, spoilDays: 2 }),
  g('salt', 'salt', 'pounds of salt', 'material', 4, 0.5),
  g('wool', 'wool', 'fleeces of wool', 'textile', 18, 2),
  g('linen_shirt', 'linen shirt', 'linen shirts', 'clothing', 12, 0.4, { slot: 'body' }),
  g('wool_tunic', 'woollen tunic', 'woollen tunics', 'clothing', 30, 1, { slot: 'body', quality: true }),
  g('cloak', 'cloak', 'cloaks', 'clothing', 60, 1.4, { slot: 'back', quality: true }),
  g('firewood', 'firewood', 'bundles of firewood', 'fuel', 1, 6),
  g('charcoal', 'charcoal', 'sacks of charcoal', 'fuel', 4, 5),
  g('candle', 'candle', 'candles', 'misc', 1, 0.1),
  g('sickle', 'sickle', 'sickles', 'tool', 14, 0.6, { quality: true, slot: 'main', held: 'sickle' }),
  g('hoe', 'hoe', 'hoes', 'tool', 10, 1.4, { quality: true, slot: 'main', held: 'hoe' }),
  g('axe', 'axe', 'axes', 'tool', 20, 2, { quality: true, slot: 'main', held: 'axe' }),
  g('knife', 'knife', 'knives', 'tool', 6, 0.3, { quality: true }),
  g('dagger', 'dagger', 'daggers', 'weapon', 36, 0.6, { quality: true, slot: 'main', held: 'dagger' }),
  g('longbow', 'longbow', 'longbows', 'weapon', 60, 1.2, { quality: true, slot: 'main', held: 'longbow' }),
  g('jack', 'padded jack', 'padded jacks', 'armour', 120, 4, { quality: true, slot: 'armour' }),
  g('cap', 'iron cap', 'iron caps', 'armour', 48, 1.2, { quality: true, slot: 'helmet' }),
  g('hen', 'hen', 'hens', 'livestock', 0.5, 1.5),
];

const GOOD_BY_ID = new Map(MOCK_GOODS.map((x) => [x.id, x]));

const PERKS: Partial<Record<SkillId, Array<[string, string, string, string, string]>>> = {
  farming: [
    ['farming.steady_hands', 'Steady hands', 'Reaping and sowing take a tenth less time.', 'farming.good_earth', 'Good earth: strips you work yield a little more grain.'],
    ['farming.bound_sheaves', 'Tight binder', 'Sheaves are bound well: less is lost between field and barn.', 'farming.weather_eye', 'Weather eye: you know a day ahead when rain is coming.'],
  ],
  husbandry: [['husbandry.gentle_hand', 'Gentle hand', 'Animals in your care are calmer and thrive.', 'husbandry.good_breeder', 'Good breeder: your beasts bear more young.']],
  melee: [['melee.first_blood', 'First blood', 'Your opening blow lands harder.', 'melee.shield_wall', 'Shield wall: a shield blocks more of what comes.']],
  archery: [['archery.steady_aim', 'Steady aim', 'Less scatter when you hold your breath.', 'archery.quick_nock', 'Quick nock: you loose more arrows a minute.']],
  trade: [['trade.haggler', 'Haggler', 'Better prices when you buy and sell.', 'trade.keen_appraisal', 'Keen appraisal: you see the true worth of goods.']],
  persuasion: [['persuasion.silver_tongue', 'Silver tongue', 'Flattery and requests land more often.', 'persuasion.honest_face', 'Honest face: people believe you more readily.']],
};

/** "bushels of wheat" → "bushel of wheat"; "padded jacks" → "padded jack". */
function singular(unit: string): string {
  const parts = unit.split(' ');
  const of = parts.indexOf('of');
  const i = of > 0 ? of - 1 : parts.length - 1;
  const w = parts[i];
  parts[i] = w === 'loaves' ? 'loaf' : w === 'knives' ? 'knife' : w.endsWith('s') ? w.slice(0, -1) : w;
  return parts.join(' ');
}

export class MockEconomy implements EconomyApi {
  private readonly equipment = new Map<PersonId, Partial<Record<EquipSlot, ItemKey>>>();
  private readonly employment_ = new Map<PersonId, Employment>();
  private readonly tasks = new Map<PersonId, HouseholdTask>();
  private readonly hired = new Set<PersonId>();
  private readonly stock = new Map<string, number>();
  private readonly boughtListings = new Set<number>();
  private readonly perkDefs = new Map<string, PerkDef>();
  private marketOpen = true;

  constructor(private readonly sim: Simulation) {
    for (const [skill, defs] of Object.entries(PERKS) as Array<[SkillId, Array<[string, string, string, string, string]>]>) {
      defs.forEach((d, i) => {
        const level = (PERK_LEVELS[i] ?? 5) as PerkDef['level'];
        this.perkDefs.set(d[0], { id: d[0], skill, level, name: d[1], description: d[2] });
        this.perkDefs.set(d[3], { id: d[3], skill, level, name: d[4].split(':')[0], description: d[4].split(': ')[1] ?? d[4] });
      });
    }
    for (const gd of MOCK_GOODS) this.stock.set(gd.id, 6 + ((gd.id.length * 7) % 30));
    this.stock.set('hen', 12);
    this.stock.set('longbow', 2);
    this.stock.set('jack', 1);
    // start the player's household with something to show
    const me = sim.state.persons.get(sim.state.run.playerId);
    if (me && Object.keys(me.inventory).length === 0) {
      Object.assign(me.inventory, {
        wheat: 3, barley: 2, bread: 4, ale: 2, 'sickle#1': 1, 'knife#1': 1, 'wool_tunic#1': 1, cheese: 1, candle: 3, hen: 2, linen_shirt: 1, firewood: 2,
      });
      me.money = Math.max(me.money, 38);
      this.equipment.set(me.id, { body: 'wool_tunic#1', main: 'sickle#1' });
    }
  }

  setMarketOpen(open: boolean): void { this.marketOpen = open; }

  // ---------------------------------------------------------------- goods

  goods(): readonly GoodDef[] { return MOCK_GOODS; }
  good(id: string): GoodDef | undefined { return GOOD_BY_ID.get(id); }

  describe(key: ItemKey, qty?: number): string {
    const { good, quality } = parseItemKey(key);
    const def = GOOD_BY_ID.get(good);
    if (!def) return qty ? `${qty} ${key}` : key;
    const q = quality !== undefined && def.quality && quality !== 1 ? `${QUALITY_NAMES[quality]} ` : '';
    if (qty === undefined) return `${q}${def.name}`;
    if (qty === 1) {
      const phrase = `${q}${singular(def.unit)}`;
      return `${/^[aeiou]/i.test(phrase) ? 'an' : 'a'} ${phrase}`;
    }
    return `${qty} ${q}${def.unit}`;
  }

  // ---------------------------------------------------------------- inventories

  private stackOf(key: ItemKey, qty: number): ItemStack | null {
    const { good, quality } = parseItemKey(key);
    const def = GOOD_BY_ID.get(good);
    if (!def) return null;
    const qf = quality === undefined ? 1 : [0.6, 1, 1.5, 2.4, 4][quality];
    return { key, good: def, quality, qty, value: Math.round(def.basePrice * 0.85 * qf * qty * 2) / 2 };
  }

  inventory(person: PersonId): InventoryView {
    const p = this.sim.state.persons.get(person);
    const items: ItemStack[] = [];
    let weight = 0;
    if (p) {
      for (const [key, qty] of Object.entries(p.inventory)) {
        if (qty <= 0) continue;
        const s = this.stackOf(key, qty);
        if (s) { items.push(s); weight += s.good.weight * qty; }
      }
    }
    const str = p ? p.trained.str : 10;
    return {
      owner: person, items, money: p?.money ?? 0, weight: Math.round(weight * 10) / 10, capacity: Math.round(20 + str * 2.5),
      equipment: { ...(this.equipment.get(person) ?? {}) },
    };
  }

  stores(household: number): ItemStack[] {
    const hh = this.sim.state.households.get(household);
    if (!hh) return [];
    const base: Record<string, number> = Object.keys(hh.stores).length ? hh.stores : { wheat: 12, barley: 8, oats: 6, peas: 0, ale: 5, cheese: 3, firewood: 14, wool: 2 };
    return Object.entries(base).filter(([, q]) => q > 0).map(([k, q]) => this.stackOf(k, q)).filter((s): s is ItemStack => !!s);
  }

  private take(person: PersonId, key: ItemKey, qty: number): boolean {
    const p = this.sim.state.persons.get(person);
    if (!p || (p.inventory[key] ?? 0) < qty) return false;
    p.inventory[key] -= qty;
    if (p.inventory[key] <= 0) delete p.inventory[key];
    this.sim.state.touch(p);
    return true;
  }

  private add(person: PersonId, key: ItemKey, qty: number): void {
    const p = this.sim.state.persons.get(person);
    if (!p) return;
    p.inventory[key] = (p.inventory[key] ?? 0) + qty;
    this.sim.state.touch(p);
  }

  stash(person: PersonId, key: ItemKey, qty: number): Result {
    const p = this.sim.state.persons.get(person);
    const hh = p ? this.sim.state.households.get(p.household) : undefined;
    if (!p || !hh) return { ok: false, reason: 'You have no household to stash goods with.' };
    if (qty > 0) {
      if (!this.take(person, key, qty)) return { ok: false, reason: 'You do not carry that much.' };
      hh.stores[key] = (hh.stores[key] ?? 0) + qty;
    } else {
      const n = -qty;
      if ((hh.stores[key] ?? 0) < n) return { ok: false, reason: 'The stores do not hold that much.' };
      hh.stores[key] -= n;
      this.add(person, key, n);
    }
    this.sim.state.touchHousehold(hh);
    return { ok: true };
  }

  equip(person: PersonId, slot: EquipSlot, key: ItemKey | null): Result {
    const eq = this.equipment.get(person) ?? {};
    if (key === null) delete eq[slot];
    else {
      const def = GOOD_BY_ID.get(parseItemKey(key).good);
      if (!def?.slot) return { ok: false, reason: 'That cannot be worn or wielded.' };
      if (def.slot !== slot) return { ok: false, reason: `That goes in the ${def.slot} slot.` };
      eq[slot] = key;
    }
    this.equipment.set(person, eq);
    return { ok: true };
  }

  consume(person: PersonId, key: ItemKey, qty = 1): Result {
    const def = GOOD_BY_ID.get(parseItemKey(key).good);
    if (!def || def.food === undefined) return { ok: false, reason: 'You cannot eat that.' };
    if (!this.take(person, key, qty)) return { ok: false, reason: 'You do not have that.' };
    const p = this.sim.state.persons.get(person);
    if (p) { p.needs.hunger = Math.min(1, p.needs.hunger + def.food * qty); this.sim.state.touch(p); }
    this.sim.events.emit('notify', { kind: 'gain', text: `You ${def.category === 'drink' ? 'drink' : 'eat'} ${this.describe(key, qty)}.`, person });
    return { ok: true };
  }

  give(from: PersonId, to: PersonId, key: ItemKey | 'money', qty: number): Result {
    const a = this.sim.state.persons.get(from);
    if (!a) return { ok: false, reason: 'No such person.' };
    if (key === 'money') {
      if (a.money < qty) return { ok: false, reason: 'You do not have that much.' };
      a.money -= qty;
      const b = this.sim.state.persons.get(to);
      if (b) b.money += qty;
      return { ok: true };
    }
    if (!this.take(from, key, qty)) return { ok: false, reason: 'You do not have that.' };
    if (to) this.add(to, key, qty);
    return { ok: true };
  }

  // ---------------------------------------------------------------- markets

  private priceOf(good: GoodDef, quality: Quality | undefined, side: 'buy' | 'sell'): number {
    const qf = quality === undefined ? 1 : [0.6, 1, 1.5, 2.4, 4][quality];
    const season = Math.floor(this.sim.absDay / 4) % 4;
    const seasonal = good.category === 'grain' ? [1.15, 0.95, 0.8, 1.05][season] : good.category === 'fuel' ? [0.9, 0.8, 0.95, 1.4][season] : 1;
    const raw = good.basePrice * qf * seasonal * (side === 'buy' ? 1.12 : 0.86);
    return Math.max(0.5, Math.round(raw * 2) / 2);
  }

  market(settlement: number): MarketView | null {
    const s = this.sim.world.settlements.find((x) => x.id === settlement);
    if (!s) return null;
    const lines: MarketLine[] = [];
    for (const good of MOCK_GOODS) {
      if (good.quality) {
        for (const q of [1, 2] as Quality[]) lines.push(this.line(good, q));
      } else lines.push(this.line(good, undefined));
    }
    return {
      settlement, name: s.name, open: this.marketOpen, marketDay: isMarketDay(this.sim.absDay, settlement),
      nextMarketDay: nextMarketDay(this.sim.absDay, settlement), toll: s.market ? 1 : 0, lines,
    };
  }

  private line(good: GoodDef, quality: Quality | undefined): MarketLine {
    const ref = good.basePrice * (quality === undefined ? 1 : [0.6, 1, 1.5, 2.4, 4][quality]);
    const buy = this.priceOf(good, quality, 'buy');
    const sell = this.priceOf(good, quality, 'sell');
    const hashed = ((good.id.length * 31 + (quality ?? 0) * 7) % 21) - 10;
    return {
      key: itemKey(good.id, quality), good, quality, buy, sell,
      stock: Math.max(0, (this.stock.get(good.id) ?? 5) - (quality ? quality * 2 : 0)),
      trend: Math.max(-1, Math.min(1, (buy / Math.max(0.5, ref) - 1.12) * 4 + hashed / 40)),
    };
  }

  price(settlement: number, key: ItemKey, side: 'buy' | 'sell'): number {
    const { good, quality } = parseItemKey(key);
    const def = GOOD_BY_ID.get(good);
    void settlement;
    return def ? this.priceOf(def, quality, side) : 0;
  }

  partnerStock(partner: TradePartnerRef, actor: PersonId): MarketLine[] {
    void actor;
    if (partner.kind === 'market') return this.market(partner.settlement)?.lines ?? [];
    // a person or shop: a short list of what they deal in
    const wanted = partner.kind === 'person' ? ['bread', 'ale', 'cheese', 'candle', 'knife', 'hen', 'wool'] : ['wheat', 'barley', 'oats', 'flour', 'bread', 'ale', 'salt'];
    return this.market(this.sim.state.persons.get(this.sim.state.run.playerId)?.settlement ?? 0)?.lines.filter((l) => wanted.includes(l.good.id)) ?? [];
  }

  quote(actor: PersonId, partner: TradePartnerRef, lines: TradeLine[]): TradeQuote {
    const p = this.sim.state.persons.get(actor);
    const out: TradeQuote['lines'] = [];
    let money = 0;
    let reason: string | undefined;
    const stockLines = new Map(this.partnerStock(partner, actor).map((l) => [l.key, l]));
    for (const l of lines) {
      if (l.qty === 0) continue;
      const parsed = parseItemKey(l.key);
      const def = GOOD_BY_ID.get(parsed.good);
      if (!def) { reason = 'Unknown goods.'; continue; }
      const ml = stockLines.get(l.key);
      const unit = l.qty > 0 ? ml?.buy ?? this.priceOf(def, parsed.quality, 'buy') : ml?.sell ?? this.priceOf(def, parsed.quality, 'sell');
      if (l.qty > 0 && ml && l.qty > ml.stock) reason = `They have only ${ml.stock} ${def.unit}.`;
      if (l.qty < 0 && (p?.inventory[l.key] ?? 0) < -l.qty) reason = `You do not have that many ${def.unit}.`;
      const total = Math.round(unit * l.qty * 2) / 2;
      out.push({ key: l.key, qty: l.qty, unitPrice: unit, total });
      money += total;
    }
    if (!reason && p && money > p.money) reason = 'You cannot afford that.';
    if (!reason && out.length === 0) reason = 'Nothing chosen.';
    return { lines: out, money, ok: !reason, reason };
  }

  trade(actor: PersonId, partner: TradePartnerRef, lines: TradeLine[]): TradeResult {
    const quote = this.quote(actor, partner, lines);
    if (!quote.ok) return { ok: false, reason: quote.reason, quote };
    const p = this.sim.state.persons.get(actor);
    if (!p) return { ok: false, reason: 'No such person.' };
    const settlement = partner.kind === 'market' ? partner.settlement : p.settlement;
    for (const l of quote.lines) {
      if (l.qty > 0) this.add(actor, l.key, l.qty); else this.take(actor, l.key, -l.qty);
      const good = parseItemKey(l.key).good;
      this.stock.set(good, Math.max(0, (this.stock.get(good) ?? 0) - l.qty));
      this.sim.events.emit('trade', {
        buyer: l.qty > 0 ? actor : 0, seller: l.qty > 0 ? 0 : actor, settlement, item: l.key, qty: Math.abs(l.qty), pence: Math.abs(l.total),
      });
    }
    p.money = Math.round((p.money - quote.money) * 2) / 2;
    this.sim.state.touch(p);
    return { ok: true, quote };
  }

  // ---------------------------------------------------------------- work and careers

  private reqs(person: PersonId, items: Array<[string, (p: NonNullable<ReturnType<Simulation['state']['persons']['get']>>) => boolean]>): Requirement[] {
    const p = this.sim.state.persons.get(person);
    return items.map(([label, test]) => ({ label, met: !!p && test(p) }));
  }

  jobs(settlement: number, forPerson: PersonId): JobOffer[] {
    const me = this.sim.state.persons.get(forPerson);
    const age = me ? ageYears(me, this.sim.absDay) : 12;
    const s = this.sim.world.settlements.find((x) => x.id === settlement);
    const lord = this.sim.state.titleFor('manor', settlement)?.holder ?? 0;
    const mk = (id: number, over: Partial<JobOffer> & Pick<JobOffer, 'title' | 'career' | 'wage' | 'terms' | 'requirements'>): JobOffer =>
      ({ id, employer: 0, settlement, ...over });
    return [
      mk(1, {
        title: 'Farmhand on the demesne', career: 'labourer', wage: 2, terms: 'season', employer: lord,
        requirements: this.reqs(forPerson, [['Strength 8', (p) => p.trained.str >= 8], ['Aged 12 or over', () => age >= 12]]),
      }),
      mk(2, {
        title: 'Shepherd’s boy', career: 'shepherd', wage: 1, terms: 'day',
        requirements: this.reqs(forPerson, [['Aged 10 or over', () => age >= 10], ['Husbandry 1', (p) => skillLevel(p.skills.husbandry) >= 1]]),
      }),
      mk(3, {
        title: `Apprentice to the miller of ${s?.name ?? 'the town'}`, career: 'miller', wage: 0, terms: 'apprenticeship', premium: 480,
        requirements: this.reqs(forPerson, [['Aged 13 or over', () => age >= 13], ['A premium of £2', (p) => p.money >= 480], ['Strength 10', (p) => p.trained.str >= 10]]),
        sex: 'm',
      }),
      mk(4, {
        title: 'Alehouse help', career: 'alewife', wage: 2, terms: 'day',
        requirements: this.reqs(forPerson, [['Aged 14 or over', () => age >= 14], ['Brewing 1', (p) => skillLevel(p.skills.brewing) >= 1]]),
      }),
      mk(5, {
        title: 'Parish clerk’s boy', career: 'clerk', wage: 3, terms: 'service',
        requirements: this.reqs(forPerson, [['Letters 3', (p) => skillLevel(p.skills.letters) >= 3], ['Aged 14 or over', () => age >= 14]]),
      }),
      mk(6, {
        title: 'Weaver’s apprentice', career: 'weaver', wage: 0, terms: 'apprenticeship', premium: 360,
        requirements: this.reqs(forPerson, [['Agility 9', (p) => p.trained.agi >= 9], ['A premium of thirty shillings', (p) => p.money >= 360]]),
      }),
    ];
  }

  applyForJob(person: PersonId, jobId: number): Result {
    const job = this.jobs(this.sim.state.persons.get(person)?.settlement ?? 0, person).find((j) => j.id === jobId);
    if (!job) return { ok: false, reason: 'That post has been filled.' };
    const unmet = job.requirements.find((r) => !r.met);
    if (unmet) return { ok: false, reason: `Not yet: ${unmet.label}.` };
    this.employment_.set(person, {
      employer: job.employer, career: job.career, title: job.title, wage: job.wage, since: this.sim.absDay, settlement: job.settlement, terms: job.terms,
      until: job.terms === 'apprenticeship' ? this.sim.absDay + 7 * 16 : -1,
    });
    this.sim.events.emit('notify', { kind: 'gain', text: `You are taken on as ${job.title.toLowerCase()}.`, person });
    return { ok: true };
  }

  quitJob(person: PersonId): Result {
    if (!this.employment_.delete(person)) return { ok: false, reason: 'You have no post to leave.' };
    return { ok: true };
  }

  employment(person: PersonId): Employment | null { return this.employment_.get(person) ?? null; }

  careerPaths(person: PersonId): CareerPath[] {
    const me = this.sim.state.persons.get(person);
    const female = me?.sex === 'f';
    const mine = me ? CAREERS[me.career].field : 'none';
    const path = (field: CareerField, label: string, entry: string, requirements: Requirement[], over: Partial<CareerPath> = {}): CareerPath => {
      const maleOnly = over.sexRule !== undefined;
      return {
        field, label, entry, ladder: [...STAGE_LABELS[field]], stage: mine === field ? (me?.careerStage ?? 0) : -1,
        requirements, open: !(maleOnly && female) && requirements.every((r) => r.met), ...over,
      };
    };
    const age = me ? ageYears(me, this.sim.absDay) : 12;
    const ok = (label: string, met: boolean): Requirement => ({ label, met });
    return [
      path('land', 'Land', 'Work the family holding, or hire out as a farmhand.', [ok('Aged 12 or over', age >= 12)]),
      path('husbandry', 'Husbandry', 'Herd for the village, or keep beasts of your own.', [ok('Aged 10 or over', age >= 10)]),
      path('brewing', 'Brewing', 'Brew at home and sell the surplus; women led the trade before the mid-14th century.', [ok('Aged 14 or over', age >= 14), ok('Brewing 1', skillLevel(me?.skills.brewing ?? 0) >= 1)]),
      path('craft', 'Craft', 'Ask a master smith, carpenter, mason or weaver to take you on, and pay the premium.', [ok('Aged 13 or over', age >= 13), ok('A master’s consent', false), ok('A premium of £1 10s', (me?.money ?? 0) >= 360)], {
        sexRule: 'Most crafts took only men; women worked in spinning and weaving, and widows could keep a late husband’s workshop.',
      }),
      path('trade', 'Trade', 'Start as a shop boy or peddler; you will need capital.', [ok('Aged 16 or over', age >= 16), ok('Capital of £1', (me?.money ?? 0) >= 240)]),
      path('arms', 'Arms', 'Pass the recruiter’s test; every man of 15 to 60 may be called to the levy.', [ok('Strength 10', (me?.trained.str ?? 0) >= 10), ok('Archery 3', skillLevel(me?.skills.archery ?? 0) >= 3)], {
        sexRule: 'Only men served in the levy and the lord’s companies.',
      }),
      path('knighthood', 'Knighthood', 'Born a knight’s child you serve as a page, then a squire from fourteen; commoners are knighted for valour.', [ok('Knightly birth, or valour', (me?.rankTier ?? 1) >= 5), ok('Horse and armour', false)], {
        sexRule: 'Knighthood was open to men only.',
      }),
      path('church', 'Church', 'Enter as a novice with letters or a gift.', [ok('Letters 2', skillLevel(me?.skills.letters ?? 0) >= 2), ok('A gift to the house', (me?.money ?? 0) >= 120)]),
      path('service', 'Service', 'Serve in a great household, and rise by letters to clerk and steward.', [ok('Aged 11 or over', age >= 11)]),
      path('healing', 'Healing', 'Learn from a healer or the infirmary.', [ok('Aged 16 or over', age >= 16), ok('Medicine 1', skillLevel(me?.skills.medicine ?? 0) >= 1)]),
      path('outlaw', 'Outlaw', 'Poach, rob, flee. There is no honest way back but a pardon.', [ok('Aged 15 or over', age >= 15), ok('Stealth 2', skillLevel(me?.skills.stealth ?? 0) >= 2)]),
    ];
  }

  entryTests(): readonly EntryTest[] {
    return [
      { career: 'archer', label: 'Archer', stats: { str: 10 }, skills: { archery: 3 }, kit: ['longbow'], sex: 'm', minAge: 15, maxAge: 60 },
      { career: 'man_at_arms', label: 'Man-at-arms', stats: { str: 12, end: 10 }, skills: { melee: 4 }, kit: ['armour'], sex: 'm', minAge: 16, maxAge: 60 },
      { career: 'sergeant', label: 'Mounted sergeant', stats: { str: 12, end: 10 }, skills: { melee: 4, riding: 4 }, kit: ['armour', 'horse'], sex: 'm', minAge: 20 },
    ];
  }

  workSpot(): null { return null; }

  // ---------------------------------------------------------------- land, property, obligations

  holding(household: number): HoldingView | null {
    const hh = this.sim.state.households.get(household);
    if (!hh) return null;
    const settlement = this.sim.world.settlements.find((s) => s.id === hh.settlement);
    const ids = (settlement?.strips ?? []).slice(0, 6);
    const crops = ['barley', 'wheat', 'oats', 'peas', 'fallow', 'rye'] as const;
    const states = ['ripe', 'growing', 'sown', 'ploughed', 'stubble', 'fallow'] as const;
    const tasks = ['Reap', 'Weed', 'Wait for the sprouts', 'Sow barley', 'Plough', 'Rest the field'];
    const free = hh.id % 2 === 0;
    return {
      household, home: hh.home, tenure: free ? 'free' : 'serf', rent: free ? 96 : 0, weekWork: free ? 0 : 2,
      strips: ids.map((id, i) => ({
        id, field: (i % 3) as 0 | 1 | 2, crop: crops[i % crops.length], state: states[i % states.length], growth: [0.95, 0.5, 0.15, 0, 1, 0][i % 6],
        work: [0.4, 0, 0, 0.7, 0, 0][i % 6], nextTask: tasks[i % tasks.length],
      })),
      gardenParcel: 0,
      livestock: { hen: 6, pig: 1, sheep: 3, cow: 1 } as Partial<Record<AnimalKind, number>>,
      buildings: hh.home >= 0 ? [hh.home] : [],
      stores: this.stores(household),
    };
  }

  listings(settlement: number): PropertyListing[] {
    const rows: Array<Omit<PropertyListing, 'id' | 'settlement' | 'seller'>> = [
      { kind: 'house', label: 'A cottage by the green', price: 960, rent: 72, requirements: [{ label: 'Free status', met: true }, { label: 'Funds for a deposit', met: false }] },
      { kind: 'strip', label: 'Two strips in the east field', price: 420, rent: 36, requirements: [{ label: 'Free status', met: true }] },
      { kind: 'workshop', label: 'A smithy, lately the widow’s', price: 2400, rent: 180, requirements: [{ label: 'A master’s craft', met: false }] },
      { kind: 'shop', label: 'A market stall under the cross', price: null, rent: 60, requirements: [{ label: 'Admitted to the town', met: false }] },
    ];
    return rows.map((r, i) => ({ ...r, id: settlement * 10 + i + 1, settlement, seller: 0 })).filter((l) => !this.boughtListings.has(l.id));
  }

  buyOrRent(person: PersonId, listingId: number, mode: 'buy' | 'rent'): Result {
    void person;
    const l = this.listings(Math.floor(listingId / 10)).find((x) => x.id === listingId);
    if (!l) return { ok: false, reason: 'It has been taken.' };
    const price = mode === 'buy' ? l.price : l.rent;
    if (price === null) return { ok: false, reason: mode === 'buy' ? 'It is not for sale.' : 'It is not to let.' };
    const unmet = l.requirements.find((r) => !r.met);
    if (unmet) return { ok: false, reason: `Not yet: ${unmet.label}.` };
    this.boughtListings.add(listingId);
    return { ok: true };
  }

  obligations(person: PersonId): Obligation[] {
    const day = Math.floor(this.sim.absDay);
    const serf = (this.sim.state.persons.get(person)?.rankTier ?? 1) <= 1;
    const list: Obligation[] = [];
    if (serf) {
      list.push({ kind: 'week_work', label: 'Week-work on the lord’s demesne', amount: 2, unit: 'days', due: day + 1, to: 0, overdue: false });
      list.push({ kind: 'boon_work', label: 'Harvest boon-work', amount: 3, unit: 'days', due: day + 6, to: 0, overdue: false });
      list.push({ kind: 'merchet', label: 'Merchet for Maud’s marriage (when it comes)', amount: 24, unit: 'pence', due: day + 30, to: 0, overdue: false });
    } else {
      list.push({ kind: 'rent', label: 'Rent for the strips', amount: 96, unit: 'pence', due: day + 3, to: 0, overdue: false });
    }
    list.push({ kind: 'tithe', label: 'Tithe: a tenth of the harvest', amount: 3, unit: 'goods', due: day + 5, to: 0, overdue: false });
    list.push({ kind: 'mill_fee', label: 'The lord’s mill: a toll of grain', amount: 2, unit: 'goods', due: day - 1, to: 0, overdue: true });
    return list;
  }

  ledger(household: number): LedgerLine[] {
    void household;
    const day = Math.floor(this.sim.absDay);
    const rows: Array<[number, string, number]> = [
      [0, 'Sold barley at the market', 28], [0, 'Bought ale', -3], [-1, 'Day’s wage, the demesne', 2], [-1, 'Bread and cheese', -4], [-2, 'Tithe paid', -6],
      [-2, 'Sold a hen', 1], [-3, 'Mended the roof (thatch)', -9], [-4, 'Eggs and cheese at the market', 5], [-5, 'Rent to the lord', -96], [-6, 'Sold wool', 36],
    ];
    return rows.map(([d, label, pence]) => ({ day: day + d, label, pence }));
  }

  // ---------------------------------------------------------------- household management

  householdPlan(household: number): HouseholdPlanLine[] {
    const hh = this.sim.state.households.get(household);
    if (!hh) return [];
    const defaults: HouseholdTask[] = ['fields', 'garden', 'livestock', 'brew', 'spin', 'wood', 'play', 'rest'];
    return hh.members.map((id, i) => ({ person: id, task: this.tasks.get(id) ?? defaults[i % defaults.length], set: this.tasks.has(id) }));
  }

  setTask(head: PersonId, member: PersonId, task: HouseholdTask): Result {
    const h = this.sim.state.persons.get(head);
    const hh = h ? this.sim.state.households.get(h.household) : undefined;
    if (!hh || hh.head !== head) return { ok: false, reason: 'Only the head of the household can set tasks.' };
    this.tasks.set(member, task);
    return { ok: true };
  }

  hire(employer: PersonId, worker: PersonId, wage: number, task: HouseholdTask): Result {
    const w = this.sim.state.persons.get(worker);
    if (!w) return { ok: false, reason: 'No such person.' };
    this.hired.add(worker);
    this.tasks.set(worker, task);
    this.employment_.set(worker, { employer, career: w.career, title: 'Hired help', wage, since: this.sim.absDay, settlement: w.settlement, terms: 'day', until: -1 });
    return { ok: true };
  }

  dismiss(employer: PersonId, worker: PersonId): Result {
    void employer;
    this.hired.delete(worker);
    this.employment_.delete(worker);
    return { ok: true };
  }

  // ---------------------------------------------------------------- skills and perks

  perk(id: string): PerkDef | undefined { return this.perkDefs.get(id); }

  perkChoices(person: PersonId): PerkChoice[] {
    const p = this.sim.state.persons.get(person);
    if (!p) return [];
    const out: PerkChoice[] = [];
    for (const skill of SKILLS) {
      if (openPerkSlots(p, skill) <= 0) continue;
      const level = skillLevel(p.skills[skill]);
      const slot = PERK_LEVELS.filter((l) => l <= level)[p.perks.filter((x) => x.startsWith(`${skill}.`)).length] ?? 5;
      const defs = PERKS[skill];
      const pair = defs?.[0];
      const a: PerkDef = pair ? { ...(this.perkDefs.get(pair[0]) as PerkDef), level: slot as PerkDef['level'] } : { id: `${skill}.one`, skill, level: slot as PerkDef['level'], name: 'Practised hand', description: 'A little better at everything you do with it.' };
      const b: PerkDef = pair ? { ...(this.perkDefs.get(pair[3]) as PerkDef), level: slot as PerkDef['level'] } : { id: `${skill}.two`, skill, level: slot as PerkDef['level'], name: 'Hard-won lesson', description: 'Experience spares you effort and mistakes.' };
      out.push({ skill, level: slot, options: [a, b] });
    }
    return out;
  }

  choosePerk(person: PersonId, perkId: string): Result {
    const p = this.sim.state.persons.get(person);
    if (!p) return { ok: false, reason: 'No such person.' };
    const skill = perkId.split('.')[0] as SkillId;
    if (openPerkSlots(p, skill) <= 0) return { ok: false, reason: 'No perk is waiting in that skill.' };
    p.perks.push(perkId);
    this.sim.state.touch(p);
    return { ok: true };
  }

  marketDayLabel(settlement: number): number { return marketDayOf(settlement); }
}

