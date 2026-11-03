// Ruler mode, the pure part (docs/CIV.md §6, docs/REALM.md "For wave B"): the pages of the seat of government, the figures they
// show and how they are worded — the treasury's year, the stores, research by branch and what a researcher may be started on, the
// cost of raising men, what the lands yield and lack, the rivals and their threat, the news. No DOM, no services: plain data in,
// plain data out, so the models are unit-tested with fakes (tests/ui/ruler/).
import type { CropKind } from '../../core/domain';
import type { P2 } from '../../core/math';
import type {
  AccountLine, CropPlanLine, NewsItem, NewsKind, RealmRole, RealmTroop, RecruitOption, ResearchOption, ResearchProject, RivalView, TradeOrder,
} from '../../sim/realm/types';
import { formatMoney } from '../../sim/money';
import type { Person, PersonId } from '../../sim/state';
import type { Deposit, ResourceKind } from '../../world/types';
import type { IconName } from '../core/icons';

// ---------------------------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------------------------

export type RulerPage = 'overview' | 'lands' | 'fields' | 'research' | 'military' | 'trade' | 'diplomacy' | 'rivals';

export const PAGES: ReadonlyArray<{ id: RulerPage; label: string; icon: IconName; blurb: string }> = [
  { id: 'overview', label: 'Overview', icon: 'crown', blurb: 'Your lands, the treasury, the books, forces, works, research, threats and news' },
  { id: 'lands', label: 'Lands & works', icon: 'castle', blurb: 'Every place you rule: what stands there, what it makes, and the works under way' },
  { id: 'fields', label: 'Fields & labour', icon: 'wheat', blurb: 'What each field is sown with, the labour sent to the works, the manor’s dues' },
  { id: 'research', label: 'Research', icon: 'book', blurb: 'Techniques, paid for in the branch’s own goods and coin' },
  { id: 'military', label: 'Military', icon: 'swords', blurb: 'Forces, recruiting, knighting, armies' },
  { id: 'trade', label: 'Trade', icon: 'trade', blurb: 'What your lands yield and lack, and the steward’s standing orders' },
  { id: 'diplomacy', label: 'Diplomacy', icon: 'quill', blurb: 'Letters, marriages, truces, alliances, war and peace' },
  { id: 'rivals', label: 'Rivals', icon: 'shield', blurb: 'The Houses near you: their strength, their growth, their news' },
];

export function isPage(v: unknown): v is RulerPage {
  return typeof v === 'string' && PAGES.some((p) => p.id === v);
}

/** How the person comes to rule, in words for the title bar. */
export function roleWords(role: RealmRole | undefined): string {
  switch (role) {
    case 'regent': return 'Regent for the young lord';
    case 'steward': return 'Steward of the realm';
    case 'reeve': return 'Reeve of the village';
    default: return 'Holder of the lands';
  }
}

/** What a role may do (REALM.md "Who rules"): the pages it can act on; the rest are read-only. */
export function roleMay(role: RealmRole | undefined, acting = true): { plan: boolean; trade: boolean; realm: boolean } {
  switch (role) {
    case 'reeve': return { plan: true, trade: false, realm: false };
    case 'steward': return { plan: true, trade: true, realm: acting };
    default: return { plan: true, trade: true, realm: true };
  }
}

// ---------------------------------------------------------------------------------------------
// The treasury and the books
// ---------------------------------------------------------------------------------------------

export interface YearWords { net: number; word: string; tone: 'green' | 'vermilion' | 'gold' }

/** "A surplus of £3 4s" / "A deficit of £1 2s" over the rolling year. */
export function yearWords(income: number, spending: number): YearWords {
  const net = income - spending;
  if (income <= 0 && spending <= 0) return { net: 0, word: 'The books are not yet closed', tone: 'gold' };
  if (Math.abs(net) < Math.max(1, income * 0.02)) return { net, word: 'Balanced', tone: 'gold' };
  return net > 0 ? { net, word: `A surplus of ${formatMoney(net)}`, tone: 'green' } : { net, word: `A deficit of ${formatMoney(-net)}`, tone: 'vermilion' };
}

/** The books split into what came in and what went out, largest first (the module's lines are signed or not: both ways read). */
export function splitBooks(lines: readonly AccountLine[]): { in: AccountLine[]; out: AccountLine[]; totalIn: number; totalOut: number } {
  const inn = lines.filter((l) => l.pence > 0).sort((a, b) => b.pence - a.pence);
  const out = lines.filter((l) => l.pence < 0).map((l) => ({ label: l.label, pence: -l.pence })).sort((a, b) => b.pence - a.pence);
  return { in: inn, out, totalIn: inn.reduce((s, l) => s + l.pence, 0), totalOut: out.reduce((s, l) => s + l.pence, 0) };
}

/** Words for the prosperity figure (1 = normal). */
export function prosperityWord(p: number): string {
  if (p >= 1.25) return 'prospering';
  if (p >= 1.05) return 'comfortable';
  if (p >= 0.9) return 'getting by';
  if (p >= 0.7) return 'in hardship';
  return 'starving';
}

// ---------------------------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------------------------

export interface StoreRow { good: string; qty: number; name: string; category: string }

const CATEGORY_RANK: Readonly<Record<string, number>> = {
  grain: 0, food: 1, drink: 2, produce: 3, material: 4, metal: 5, fuel: 6, textile: 7, tool: 8, weapon: 9, armour: 10, clothing: 11, livestock: 12, misc: 13,
};

/** The realm's stores as rows: by category (grain, food, materials, metal…), the larger stock first; nothing under a hundredth. */
export function storeRows(stores: Readonly<Record<string, number>>, info: (good: string) => { name: string; category: string } | undefined): StoreRow[] {
  const rows: StoreRow[] = [];
  for (const [good, qty] of Object.entries(stores)) {
    if (!(qty >= 0.01)) continue;
    const i = info(good);
    rows.push({ good, qty, name: i?.name ?? good.replace(/_/g, ' '), category: i?.category ?? 'misc' });
  }
  return rows.sort((a, b) => (CATEGORY_RANK[a.category] ?? 99) - (CATEGORY_RANK[b.category] ?? 99) || b.qty - a.qty || a.name.localeCompare(b.name, 'en'));
}

/** "1 240", "12.4", "0.6": amounts of goods without a pile of decimals. */
export function amountText(q: number): string {
  if (q >= 100) return Math.round(q).toLocaleString('en-GB');
  if (q >= 10) return String(Math.round(q * 10) / 10);
  return String(Math.round(q * 100) / 100);
}

// ---------------------------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------------------------

export const BRANCHES: ReadonlyArray<{ id: string; label: string; icon: IconName; currencies: string }> = [
  { id: 'economy', label: 'Economy', icon: 'trade', currencies: 'timber, planks, stone, bricks and coin' },
  { id: 'military', label: 'Military', icon: 'swords', currencies: 'iron, horses, stone, arrows and coin' },
  { id: 'kinship', label: 'Kinship & Diplomacy', icon: 'ring', currencies: 'cloth, ale and coin' },
  { id: 'knowledge', label: 'Knowledge & Belief', icon: 'book', currencies: 'vellum, candles and coin' },
];

/** The options of each branch: what can be started now first, then what can be bought up, then the rest by price in days. */
export function groupResearch(options: readonly ResearchOption[]): Map<string, ResearchOption[]> {
  const by = new Map<string, ResearchOption[]>();
  for (const b of BRANCHES) by.set(b.id, []);
  for (const o of options) {
    let list = by.get(o.branch);
    if (!list) { list = []; by.set(o.branch, list); }
    list.push(o);
  }
  const rank = (o: ResearchOption): number => (o.ok ? 0 : o.buyable ? 1 : 2);
  for (const list of by.values()) list.sort((a, b) => rank(a) - rank(b) || (a.days ?? a.cost.days) - (b.days ?? b.cost.days) || a.name.localeCompare(b.name, 'en'));
  return by;
}

export interface StartChoice {
  /** 'start' = the goods are in store; 'buy' = start and buy what is short; 'no' = cannot be started. */
  mode: 'start' | 'buy' | 'no';
  label: string;
  /** Shown when 'no' (and as the hint of a buy). */
  reason?: string;
  /** Pence to buy the shortfall (mode 'buy'). */
  buyCost?: number;
}

/** What the ruler's buttons offer for an option: Start, Buy the rest and start, or the reason why not. */
export function startChoice(o: ResearchOption): StartChoice {
  if (o.ok) return { mode: 'start', label: 'Start' };
  if (o.buyable) return { mode: 'buy', label: 'Buy the rest and start', buyCost: o.buyCost, reason: o.reason };
  return { mode: 'no', label: 'Start', reason: o.reason ?? 'It cannot be started now' };
}

export interface ResearchCostLine { kind: 'good' | 'pence' | 'days'; good?: string; qty: number; short?: number }

/** The price of an option as lines: goods (with what is short in the stores), coin, days of work. */
export function researchCostLines(o: ResearchOption): ResearchCostLine[] {
  const goods = Object.entries(o.cost.goods).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const lines: ResearchCostLine[] = goods.map(([good, qty]) => ({ kind: 'good', good, qty, short: o.short?.[good] }));
  if (o.cost.pence > 0) lines.push({ kind: 'pence', qty: o.cost.pence });
  lines.push({ kind: 'days', qty: o.days ?? o.cost.days });
  return lines;
}

/** How long a project has run and what it waits for, in words. */
export function projectWords(p: ResearchProject, now: number): { eta: string; state: string; tone: 'green' | 'gold' | 'vermilion' } {
  if (p.state === 'stalled') return { eta: 'Waiting', state: p.note ?? 'Stalled', tone: 'vermilion' };
  if (p.state === 'done') return { eta: 'Done', state: 'Finished', tone: 'green' };
  if (p.state === 'abandoned') return { eta: 'Given up', state: 'Abandoned', tone: 'vermilion' };
  if (!Number.isFinite(p.eta) || p.eta <= 0) return { eta: 'No telling yet', state: p.note ?? 'Under way', tone: 'gold' };
  const days = Math.max(0, Math.ceil(p.eta - now));
  return { eta: days === 0 ? 'Done today' : days === 1 ? 'Done tomorrow' : `Done in ${days} days`, state: p.note ?? 'Under way', tone: 'green' };
}

// ---------------------------------------------------------------------------------------------
// Recruiting
// ---------------------------------------------------------------------------------------------

/** The days of wages the treasury must also hold for each man raised (the module's TROOPS.reserveDays). */
export const RESERVE_DAYS = 8;
export const BATCH = 60;
export const DAYS_PER_YEAR = 16;

export interface RecruitPreview {
  count: number;
  fees: number;
  /** Gear the stores lack, bought at the smiths' prices. */
  gear: number;
  /** Eight days' wages held in hand. */
  reserve: number;
  total: number;
  /** Wages per day for these men, and per year. */
  perDay: number;
  perYear: number;
  affordable: boolean;
  /** The treasury after paying. */
  left: number;
}

/** The most men the stepper offers: what the realm can field, can pay and may raise at once. */
export function recruitMax(o: Pick<RecruitOption, 'available' | 'affordable' | 'ok'>): number {
  return Math.max(0, Math.min(o.available, o.affordable ?? o.available, BATCH));
}

/** What raising `count` men of an option costs now: fees, gear to buy (the stores arm `equipped` of them), a week's wages in hand. */
export function recruitPreview(o: Pick<RecruitOption, 'pence' | 'upkeep' | 'buy' | 'equipped'>, count: number, treasury: number): RecruitPreview {
  const n = Math.max(0, Math.floor(count));
  const fees = o.pence * n;
  const gear = (o.buy ?? 0) * Math.max(0, n - (o.equipped ?? 0));
  const reserve = o.upkeep * RESERVE_DAYS * n;
  const total = fees + gear + reserve;
  return { count: n, fees, gear, reserve, total, perDay: o.upkeep * n, perYear: o.upkeep * n * DAYS_PER_YEAR, affordable: total <= treasury + 1e-9, left: treasury - fees - gear };
}

const KIND_ORDER = ['knight', 'sergeant', 'man_at_arms', 'crossbow', 'archer', 'mercenary', 'levy'];
const KIND_LABEL: Readonly<Record<string, [string, string]>> = {
  knight: ['knight', 'knights'], sergeant: ['mounted sergeant', 'mounted sergeants'], man_at_arms: ['man-at-arms', 'men-at-arms'], crossbow: ['crossbowman', 'crossbowmen'],
  archer: ['archer', 'archers'], mercenary: ['mercenary', 'mercenaries'], levy: ['levy man', 'levy men'],
};

export function kindName(kind: string, n = 2): string {
  const w = KIND_LABEL[kind];
  return w ? (n === 1 ? w[0] : w[1]) : kind;
}

/** The men on the roll by kind, the best first. */
export function troopCounts(troops: readonly Pick<RealmTroop, 'kind' | 'wage'>[]): Array<{ kind: string; n: number; wage: number }> {
  const by = new Map<string, { n: number; wage: number }>();
  for (const t of troops) {
    const e = by.get(t.kind) ?? { n: 0, wage: 0 };
    e.n++; e.wage += t.wage;
    by.set(t.kind, e);
  }
  return [...by.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** A knight who fights for a ruler: of his House, his vassal, or in his pay. */
export interface KnightRow { id: PersonId; why: 'in your pay' | 'your vassal' | 'of your House'; hurt: boolean }

/**
 * The knights the ruler may take the place of (`fightAs`): men of the House, those holding a title under one of his, and those on
 * his roll. `wounded` says whether a man carries wounds; a man under half his health is hurt as well. Vassals and the paid first.
 */
export function knightsOf(
  st: { persons: { get(id: PersonId): Person | undefined; values(): Iterable<Person> }; titlesHeldBy(id: PersonId): ReadonlySet<{ id: number; liege: number }> },
  me: PersonId, paid: readonly PersonId[], wounded: (id: PersonId) => boolean = () => false,
): KnightRow[] {
  const mine = new Set([...st.titlesHeldBy(me)].map((t) => t.id));
  const pay = new Set(paid);
  const house = st.persons.get(me)?.house ?? 0;
  const out: KnightRow[] = [];
  for (const p of st.persons.values()) {
    if (p.death || p.career !== 'knight' || p.id === me || p.flags.captive) continue;
    const vassal = [...st.titlesHeldBy(p.id)].some((t) => mine.has(t.liege));
    const why = pay.has(p.id) ? 'in your pay' : vassal ? 'your vassal' : house && p.house === house ? 'of your House' : null;
    if (!why) continue;
    out.push({ id: p.id, why, hurt: p.health.hp < 0.5 || wounded(p.id) });
  }
  const rank = { 'in your pay': 0, 'your vassal': 1, 'of your House': 2 } as const;
  return out.sort((a, b) => rank[a.why] - rank[b.why] || Number(a.hurt) - Number(b.hurt) || a.id - b.id);
}

/** May this man be knighted? Not already a knight, and the module's own checks do the rest. */
export function dubbable(t: Pick<RealmTroop, 'kind'>): boolean {
  return t.kind !== 'knight' && t.kind !== 'mercenary';
}

// ---------------------------------------------------------------------------------------------
// Crops and labour
// ---------------------------------------------------------------------------------------------

export const CROP_NAME: Readonly<Record<string, string>> = {
  wheat: 'Wheat', rye: 'Rye', barley: 'Barley', oats: 'Oats', peas: 'Peas', beans: 'Beans', fallow: 'Fallow: the usual rotation decides',
};

export function cropName(c: CropKind | 'fallow' | string): string { return CROP_NAME[c] ?? String(c); }

/** What the field does this year, in words ("Winter corn: ripening for harvest"). */
export function fieldRoleWords(f: Pick<CropPlanLine, 'role' | 'next'>): { now: string; next: string } {
  const now = f.role === 'winter' ? 'Winter corn standing, to be harvested' : f.role === 'spring' ? 'A spring crop growing' : 'Lying fallow';
  return { now, next: f.next === 'winter' ? 'Winter corn goes in this autumn' : 'A spring crop goes in this spring' };
}

/** The crops that may be named for the field's next sowing. */
export function cropOptions(f: Pick<CropPlanLine, 'next' | 'options'>): readonly CropKind[] {
  return f.options[f.next];
}

/** Share of week-work 0..1 in twentieths → words ("a fifth of the week-work"). */
export function worksShareWords(share: number): string {
  const pct = Math.round(share * 100);
  if (pct <= 0) return 'None: the serfs work the demesne';
  if (pct >= 100) return 'All of it goes to the works';
  return `${pct}% of the week-work goes to the works`;
}

// ---------------------------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------------------------

/** The goods a ruler may name in a standing order: what a realm buys and sells in bulk. */
export const TRADE_GOODS: readonly string[] = [
  'wheat', 'rye', 'barley', 'oats', 'peas', 'beans', 'flour', 'bread', 'ale', 'wool', 'cloth', 'timber', 'planks', 'firewood', 'charcoal', 'stone', 'brick', 'clay',
  'iron_ore', 'iron', 'nails', 'salt', 'salt_meat', 'meat', 'hide', 'leather', 'straw', 'hay', 'candles', 'vellum', 'silver_ore', 'gold_ore',
];

/** The goods a land can yield, by the names the territory module uses. */
export const YIELD_GOODS: readonly string[] = ['grain', 'wool', 'hay', 'timber', 'firewood', 'fish', 'iron_ore', 'stone', 'clay', 'salt', 'silver_ore', 'gold_ore'];

export const YIELD_NAME: Readonly<Record<string, string>> = {
  grain: 'Grain', wool: 'Wool', hay: 'Hay', timber: 'Timber', firewood: 'Firewood', fish: 'Fish', iron_ore: 'Iron ore', stone: 'Stone', clay: 'Clay', salt: 'Salt',
  silver_ore: 'Silver ore', gold_ore: 'Gold ore',
};

export const YIELD_DEPOSIT: Readonly<Record<string, ResourceKind>> = { iron_ore: 'iron', stone: 'stone', clay: 'clay', salt: 'salt', silver_ore: 'silver', gold_ore: 'gold' };

export interface TradeProfile { yields: string[]; lacks: string[] }

/** What the realm's lands make and what none of them does: the union of the settlements' yields against the goods lands can have. */
export function tradeProfile(profiles: ReadonlyArray<{ yields: readonly string[] }>): TradeProfile {
  const have = new Set<string>();
  for (const p of profiles) for (const y of p.yields) have.add(y);
  return { yields: YIELD_GOODS.filter((g) => have.has(g)), lacks: YIELD_GOODS.filter((g) => !have.has(g)) };
}

export interface LackHint { good: string; deposit?: ResourceKind; text: string }

/**
 * For each good the lands lack, how to get it: buy it (every good), and for the ores, stone, clay and salt where the nearest deposit
 * lies and whose lands it is in — to conquer, or to found an outpost at (a baron's right).
 */
export function lackHints(
  lacks: readonly string[], from: P2, deposits: readonly Deposit[], whose: (d: Deposit) => string, name: (good: string) => string = (g) => YIELD_NAME[g] ?? g,
): LackHint[] {
  return lacks.map((good) => {
    const kind = YIELD_DEPOSIT[good];
    if (!kind) return { good, text: `${name(good)}: buy it at the markets` };
    let best: Deposit | null = null;
    let bd = Infinity;
    for (const d of deposits) {
      if (d.kind !== kind) continue;
      const dist = Math.hypot(d.x - from.x, d.z - from.z);
      if (dist < bd) { bd = dist; best = d; }
    }
    if (!best) return { good, deposit: kind, text: `${name(good)}: buy it; no deposit is known` };
    const km = bd >= 1000 ? `${(Math.round(bd / 100) / 10).toString()} km` : `${Math.round(bd / 10) * 10} m`;
    return { good, deposit: kind, text: `${name(good)}: buy it, or take the deposit ${km} away (${whose(best)}) by conquest or an outpost` };
  });
}

/** One trade order as words: "Sell wheat above 4d, keeping 300, at Dromore". */
export function orderWords(o: Pick<TradeOrder, 'side' | 'limit' | 'keep'>, good: string, place: string): string {
  const lim = o.limit > 0 ? ` ${o.side === 'sell' ? 'above' : 'below'} ${formatMoney(o.limit)}` : '';
  const keep = o.side === 'sell' ? `, keeping ${amountText(o.keep)} in store` : `, up to ${amountText(o.keep)} in store`;
  return `${o.side === 'sell' ? 'Sell' : 'Buy'} ${good}${lim}${keep}${place ? `, at ${place}` : ''}`;
}

export interface OrderForm { good: string; side: 'sell' | 'buy'; limit: number; keep: number; settlement: number }

/** Checks the form before asking the realm: what is plainly missing. */
export function orderFormProblem(f: OrderForm): string | null {
  if (!f.good) return 'Name a good';
  if (!(f.keep >= 0) || !Number.isFinite(f.keep)) return 'Say how much to keep in store';
  if (f.side === 'buy' && f.keep <= 0) return 'Say how much to stock up to';
  if (!Number.isFinite(f.limit) || f.limit < 0) return 'The price limit cannot be negative (0 means any price)';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Rivals and news
// ---------------------------------------------------------------------------------------------

/** "little to fear" … "grave" from the threat 0..1. */
export function threatWords(t: number): { word: string; tone: 'green' | 'gold' | 'vermilion' | 'ink' } {
  if (t >= 0.75) return { word: 'Grave', tone: 'vermilion' };
  if (t >= 0.5) return { word: 'Serious', tone: 'vermilion' };
  if (t >= 0.3) return { word: 'Watchful', tone: 'gold' };
  return { word: 'Little to fear', tone: 'green' };
}

export const STANCE_WORDS: Readonly<Record<string, string>> = {
  war: 'At war', hostile: 'Hostile', neutral: 'No ties', truce: 'Truce', trade: 'Trading', kin: 'Kin by marriage', alliance: 'Allies', vassal: 'Your liege', liege: 'Your vassal',
};

export function stanceTone(stance: string): 'gold' | 'lapis' | 'vermilion' | 'green' | 'ink' | '' {
  switch (stance) {
    case 'war': case 'hostile': return 'vermilion';
    case 'truce': return 'lapis';
    case 'trade': case 'alliance': return 'green';
    case 'kin': return 'gold';
    case 'vassal': case 'liege': return 'ink';
    default: return '';
  }
}

/** Greatest threat first, then the nearer; the House's own deeds do not count. */
export function sortRivals(rivals: readonly RivalView[]): RivalView[] {
  return [...rivals].sort((a, b) => b.threat - a.threat || a.distance - b.distance || a.name.localeCompare(b.name, 'en'));
}

/** What a rival did this year: "4 buildings, 2 techniques, 18 men". */
export function growthWords(r: Pick<RivalView, 'built' | 'techs' | 'recruited'>): string {
  const parts: string[] = [];
  if (r.built > 0) parts.push(`${r.built} ${r.built === 1 ? 'building' : 'buildings'}`);
  if (r.techs > 0) parts.push(`${r.techs} ${r.techs === 1 ? 'technique' : 'techniques'}`);
  if (r.recruited > 0) parts.push(`${r.recruited} ${r.recruited === 1 ? 'man' : 'men'} raised`);
  return parts.length ? parts.join(', ') : 'Nothing seen this year';
}

/** Kilometres, one decimal: "3.8 km". */
export function kmText(metres: number): string {
  return metres >= 1000 ? `${(Math.round(metres / 100) / 10).toString()} km` : `${Math.round(metres / 10) * 10} m`;
}

export const NEWS_ICON: Readonly<Record<NewsKind, IconName>> = {
  built: 'hammer', founded: 'flag', research: 'book', recruited: 'users', army: 'swords', war: 'swords', peace: 'hand', fell: 'skull', grew: 'trend_up', famine: 'warning', other: 'scroll',
};

/** The news a rival made, newest first; or all of it. */
export function newsFor(items: readonly NewsItem[], house: number | null, limit = 12): NewsItem[] {
  return items.filter((n) => house === null || n.house === house).sort((a, b) => b.day - a.day || b.id - a.id).slice(0, limit);
}

/** Which news the HUD makes a toast of: threat at or above half to the player's House (docs: a toast for threat ≥ 0.5). */
export const TOAST_THREAT = 0.5;

export function newsToastWorthy(n: Pick<NewsItem, 'threat'>): boolean { return n.threat >= TOAST_THREAT; }

/** The toast's key, so a repeated deed does not stack. */
export function newsToastKey(n: Pick<NewsItem, 'id'>): string { return `news-${n.id}`; }

// ---------------------------------------------------------------------------------------------
// The overview map: lands drawn small
// ---------------------------------------------------------------------------------------------

export interface MapBox { minX: number; minZ: number; maxX: number; maxZ: number }

/** The box round some polygons and points, padded; null when there is nothing. */
export function boxOf(polys: ReadonlyArray<readonly P2[]>, points: readonly P2[] = [], pad = 0.04): MapBox | null {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const take = (x: number, z: number): void => { if (x < minX) minX = x; if (z < minZ) minZ = z; if (x > maxX) maxX = x; if (z > maxZ) maxZ = z; };
  for (const poly of polys) for (const p of poly) take(p.x, p.z);
  for (const p of points) take(p.x, p.z);
  if (!Number.isFinite(minX)) return null;
  // at least 200 m a side, round the middle of what there is
  const w = Math.max(200, maxX - minX) * (1 + 2 * pad), h = Math.max(200, maxZ - minZ) * (1 + 2 * pad);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  return { minX: cx - w / 2, minZ: cz - h / 2, maxX: cx + w / 2, maxZ: cz + h / 2 };
}

/** World → picture coordinates for a view of `w` × `h` pixels: uniform scale, centred; z grows downward as on the map. */
export function fitBox(box: MapBox, w: number, h: number): { scale: number; x: (wx: number) => number; y: (wz: number) => number } {
  const bw = box.maxX - box.minX, bh = box.maxZ - box.minZ;
  const scale = Math.min(w / bw, h / bh);
  const ox = (w - bw * scale) / 2, oy = (h - bh * scale) / 2;
  return { scale, x: (wx) => ox + (wx - box.minX) * scale, y: (wz) => oy + (wz - box.minZ) * scale };
}

/** An SVG path for a closed polygon, through a fit. */
export function polyPath(poly: readonly P2[], fit: { x(wx: number): number; y(wz: number): number }): string {
  if (!poly.length) return '';
  let d = '';
  for (let i = 0; i < poly.length; i++) d += `${i ? 'L' : 'M'}${fit.x(poly[i].x).toFixed(1)},${fit.y(poly[i].z).toFixed(1)}`;
  return `${d}Z`;
}
