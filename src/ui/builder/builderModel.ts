// Builder mode, the pure part (docs/CIV.md §5): how the catalogue is grouped and filtered, how a cost, a requirement, a site and
// a building are put into words, what a ghost is made of, what an outpost is called. No DOM, no services: everything takes plain
// data, so it is unit-tested with fakes (tests/ui/builder/).
import { RANK_NAMES } from '../../core/domain';
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { P2 } from '../../core/math';
import type { BuildGhost } from '../../render/types';
import type {
  BuildCategory, BuildCost, BuildOption, BuildRequirement, BuildScope, LinePart, LinePlan, PlacementCheck, SiteStatus, SiteView,
} from '../../sim/construction/types';
import { formatMoney } from '../../sim/money';
import { toDate, SEASON_NAMES } from '../../core/time';
import type { IconName } from '../core/icons';

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

export const CATEGORY_ORDER: readonly BuildCategory[] = ['home', 'farm', 'craft', 'food', 'religion', 'civic', 'defence', 'resource', 'military'];

export const CATEGORY_LABEL: Readonly<Record<BuildCategory, string>> = {
  home: 'Homes', farm: 'Farm', craft: 'Crafts', food: 'Food and drink', religion: 'Church', civic: 'Civic', defence: 'Defence', resource: 'Resources', military: 'Military',
};

export const CATEGORY_ICON: Readonly<Record<BuildCategory, IconName>> = {
  home: 'hut', farm: 'farming', craft: 'hammer', food: 'bread', religion: 'church', civic: 'market', defence: 'walls', resource: 'mining', military: 'swords',
};

export interface CatalogueGroup { category: BuildCategory; label: string; options: BuildOption[]; open: number }

/** Options by category, in the catalogue's order; within a category the ones that can be raised come first, then by name. */
export function groupCatalogue(options: readonly BuildOption[]): CatalogueGroup[] {
  const by = new Map<BuildCategory, BuildOption[]>();
  for (const o of options) {
    let list = by.get(o.category);
    if (!list) { list = []; by.set(o.category, list); }
    list.push(o);
  }
  const out: CatalogueGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const list = by.get(category);
    if (!list) continue;
    list.sort((a, b) => Number(b.ok) - Number(a.ok) || a.name.localeCompare(b.name, 'en'));
    out.push({ category, label: CATEGORY_LABEL[category], options: list, open: list.filter((o) => o.ok).length });
  }
  return out;
}

export interface CatalogueFilter { category: BuildCategory | 'all'; query: string; showUnavailable: boolean }

/** The options a filter lets through, in display order: open ones first (by category order), unavailable ones after them. */
export function filterCatalogue(options: readonly BuildOption[], f: CatalogueFilter): BuildOption[] {
  const q = f.query.trim().toLowerCase();
  const rank = (c: BuildCategory): number => CATEGORY_ORDER.indexOf(c);
  return options
    .filter((o) => (f.category === 'all' || o.category === f.category)
      && (f.showUnavailable || o.ok)
      && (q === '' || o.name.toLowerCase().includes(q) || o.kind.replace(/_/g, ' ').includes(q) || o.does.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.ok) - Number(a.ok) || rank(a.category) - rank(b.category) || a.name.localeCompare(b.name, 'en'));
}

/** Per-category counts of the options that can be raised, for the filter chips ("Defence 3"). */
export function categoryCounts(options: readonly BuildOption[]): Record<BuildCategory | 'all', number> {
  const out = { all: 0 } as Record<BuildCategory | 'all', number>;
  for (const c of CATEGORY_ORDER) out[c] = 0;
  for (const o of options) { if (!o.ok) continue; out.all++; out[o.category]++; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Costs and requirements in words
// ---------------------------------------------------------------------------------------------

export interface CostLine {
  kind: 'good' | 'labour' | 'pence';
  /** The good's id for 'good'. */
  good?: string;
  qty: number;
  text: string;
}

/** Plural-aware "worker-day(s)". */
export function workerDays(n: number): string {
  const v = Math.round(n * 10) / 10;
  return `${trim(v)} worker-${v === 1 ? 'day' : 'days'}`;
}

function trim(n: number): string { return String(Math.round(n * 10) / 10); }

/**
 * A cost as lines: the goods (largest first; `name` words each, "20 planks"), the labour in worker-days and the cash. Goods the
 * caller does not know by name keep their id.
 */
export function costLines(cost: BuildCost, describe: (good: string, qty: number) => string): CostLine[] {
  const goods = Object.entries(cost.goods).filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out: CostLine[] = goods.map(([good, qty]) => ({ kind: 'good', good, qty, text: describe(good, qty) }));
  if (cost.labour > 0) out.push({ kind: 'labour', qty: cost.labour, text: workerDays(cost.labour) });
  if (cost.pence > 0) out.push({ kind: 'pence', qty: cost.pence, text: formatMoney(cost.pence) });
  return out;
}

/** One line for a list row: "8 worker-days · 20 planks · 30 straw · 6s" (the goods first, then labour and cash). */
export function costSummary(cost: BuildCost, describe: (good: string, qty: number) => string, max = 3): string {
  const lines = costLines(cost, describe);
  const goods = lines.filter((l) => l.kind === 'good');
  const rest = lines.filter((l) => l.kind !== 'good');
  const shown = goods.slice(0, max).map((l) => l.text);
  if (goods.length > max) shown.push(`+${goods.length - max} more`);
  return [...rest.filter((l) => l.kind === 'labour').map((l) => l.text), ...shown, ...rest.filter((l) => l.kind === 'pence').map((l) => l.text)].join(' · ');
}

/** What is missing from a store against a cost: good → shortfall (only the goods that fall short). */
export function shortfall(cost: BuildCost, have: (good: string) => number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [g, q] of Object.entries(cost.goods)) {
    const lack = q - have(g);
    if (lack > 0.0001) out[g] = Math.ceil(lack);
  }
  return out;
}

export interface RequirementLine { icon: IconName; text: string; tone?: 'ok' | 'warn' }

const TERRAIN_WORDS: Readonly<Record<NonNullable<BuildRequirement['terrain']>, string>> = {
  river: 'A river bank within 25 m', rise: 'A rise of the ground, open to the wind', coast: 'The coast', deposit: 'A deposit under the site', forest: 'Woodland',
};
const DEPOSIT_WORDS: Readonly<Record<string, string>> = { iron: 'iron', stone: 'stone', clay: 'clay', salt: 'salt', silver: 'silver', gold: 'gold' };

/** "an iron, silver or gold deposit". */
export function depositWords(kinds: readonly string[]): string {
  const names = kinds.map((k) => DEPOSIT_WORDS[k] ?? k);
  const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  const article = /^[aeiou]/.test(list) ? 'an' : 'a';
  return `${article} ${list} deposit`;
}

/**
 * The requirements of a building in words: its technique, its terrain, the deposit it stands on, the rank it asks of the builder
 * and how many a place may hold. `techName` turns an advancement id into its name; `have` says which techniques the House commands
 * (absent = do not say).
 */
export function requirementLines(req: BuildRequirement, techName: (id: string) => string, have?: (tech: string) => boolean): RequirementLine[] {
  const out: RequirementLine[] = [];
  if (req.tech) out.push({ icon: 'book', text: `Technique: ${techName(req.tech)}`, tone: have ? (have(req.tech) ? 'ok' : 'warn') : undefined });
  if (req.terrain === 'deposit') out.push({ icon: 'mining', text: `On ${depositWords(req.deposits && req.deposits.length ? req.deposits : req.deposit ? [req.deposit] : [])}` });
  else if (req.terrain) out.push({ icon: 'pin', text: TERRAIN_WORDS[req.terrain] });
  if (req.rank !== undefined && req.rank > 1) out.push({ icon: 'crown', text: `Builder of ${rankWord(req.rank)} rank or better` });
  if (req.max !== undefined) out.push({ icon: 'box', text: req.max === 1 ? 'One to a place' : `At most ${req.max} to a place` });
  return out;
}

/** "knightly" style word for a rank tier (the names of SPEC §4 lower-cased: "knight", "baron"). */
export function rankWord(rank: number): string {
  return (RANK_NAMES[Math.max(0, Math.min(8, Math.round(rank)))] ?? '').toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Why a person cannot build, and what would let them
// ---------------------------------------------------------------------------------------------

export interface NoBuildCard {
  title: string;
  /** Why, in the construction module's own words. */
  why: string;
  /** What would let you build. */
  ways: Array<{ icon: IconName; text: string }>;
}

/**
 * The card builder mode shows when `scope.role` is 'none': the reason is the scope's label (the module words it: "Too young to
 * build", "Only the head of the household builds for it (Godwin)", "You hold no land to build on", "A prisoner builds nothing").
 */
export function noBuildCard(scope: Pick<BuildScope, 'role' | 'label'>): NoBuildCard {
  const why = scope.label || 'You hold no land to build on';
  const ways: NoBuildCard['ways'] = [
    { icon: 'home', text: 'Head a household: raise sheds, pens, a hen-house, a kiln or a new home on your own plot or on a plot you buy or rent.' },
    { icon: 'hammer', text: 'Become a master: build and improve your own workshop.' },
    { icon: 'key', text: 'Hold an office: a steward, bailiff or castellan builds on the lord’s orders; a reeve for the farm and village works; a mayor for the town’s.' },
    { icon: 'castle', text: 'Hold a manor, a town or an abbey: raise anything your rank allows anywhere in its lands.' },
    { icon: 'crown', text: 'Be a baron or greater: and found named outposts at deposits in the wild.' },
  ];
  return { title: 'You cannot build yet', why, ways };
}

// ---------------------------------------------------------------------------------------------
// The ghost and the cursor
// ---------------------------------------------------------------------------------------------

/** The renderer's ghost for a check: where the building would stand, green or red, with its footprint outlined. */
export function ghostFrom(kind: BuildingKind, level: number, check: PlacementCheck): BuildGhost {
  return { kind, level, x: check.x, z: check.z, rot: check.rot, ok: check.ok, footprint: check.footprint.map((p: P2) => ({ x: p.x, z: p.z })) };
}

export interface CursorTip {
  tone: 'ok' | 'bad' | 'info';
  /** The first line (the reason when it does not fit, what clicking does when it does). */
  text: string;
  /** A second line (the outpost that would be founded, what it costs). */
  sub?: string;
}

/** What the label by the cursor says for a check: the red reason when it does not fit, else what a click does. */
export function cursorTip(name: string, check: PlacementCheck, costText: string): CursorTip {
  if (!check.ok) return { tone: 'bad', text: check.reason || 'You cannot build here' };
  const o = check.outpost;
  if (o && o.id === 0) return { tone: 'ok', text: `Click to found an outpost and stake out the ${name.toLowerCase()}`, sub: costText };
  if (o && o.id > 0) return { tone: 'ok', text: `Click to stake out the ${name.toLowerCase()} at ${o.name}`, sub: costText };
  return { tone: 'ok', text: `Click to stake out the ${name.toLowerCase()}`, sub: costText };
}

/** The label by the cursor while a run of wall is being drawn: its length, what it is made of, what it costs, or why it cannot be laid. */
export function lineTip(plan: LinePlan, costText: string): CursorTip {
  if (!plan.ok) return { tone: 'bad', text: plan.reason || 'The run cannot be laid there' };
  const bits = Object.entries(plan.byKind).map(([k, n]) => `${n} ${(BUILDINGS[k as BuildingKind]?.name ?? k).toLowerCase()}${n === 1 ? '' : 's'}`);
  return { tone: 'ok', text: `Click to lay ${Math.round(plan.length)} m: ${bits.join(', ')}`, sub: costText };
}

/** The footprints of every piece of a planned run, for the tint that shows the whole run on the ground. */
export function lineAreas(plan: LinePlan): P2[][] {
  return plan.parts.map((p) => p.footprint.map((q) => ({ x: q.x, z: q.z })));
}

/** The one piece of a run the ghost shows: the first that fails (red, with its reason), else the piece at the far end. */
export function lineGhostPart(plan: LinePlan): LinePart | null {
  return plan.parts.find((p) => !p.ok) ?? plan.parts[plan.parts.length - 1] ?? null;
}

/** Rotates by `steps` quarter-turns' fractions: 15° each, wrapped to (−π, π]. */
export const ROTATE_STEP = Math.PI / 12;
export function rotate(rot: number, steps: number): number {
  let r = rot + steps * ROTATE_STEP;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r <= -Math.PI) r += Math.PI * 2;
  return Math.abs(r) < 1e-9 ? 0 : r;
}

// ---------------------------------------------------------------------------------------------
// Outposts
// ---------------------------------------------------------------------------------------------

const OUTPOST_BY_DEPOSIT: Readonly<Record<string, string>> = {
  iron: 'Iron camp', silver: 'Silver camp', gold: 'Gold camp', stone: 'Stone quarry', clay: 'Clay pit', salt: 'Salt pans',
};
const OUTPOST_BY_KIND: Readonly<Partial<Record<BuildingKind, string>>> = {
  lumber_camp: 'Lumber camp', quarry: 'Stone quarry', clay_pit: 'Clay pit', salt_pan: 'Salt pans', dock: 'Fishing hamlet', mine: 'Mining camp', tent: 'Camp', charcoal_mound: 'Charcoal burners',
};

/**
 * The name offered for an outpost: from the deposit the site lies on ("Iron camp"), else from what is being built there, else the
 * module's own suggestion (`check.outpost.name`), else "Outpost".
 */
export function defaultOutpostName(depositKind: string | undefined, kind: BuildingKind, suggested?: string): string {
  if (depositKind && OUTPOST_BY_DEPOSIT[depositKind]) return OUTPOST_BY_DEPOSIT[depositKind];
  if (OUTPOST_BY_KIND[kind]) return OUTPOST_BY_KIND[kind] as string;
  if (suggested && suggested.trim()) return suggested.trim();
  return 'Outpost';
}

/** A name a player typed, made fit: trimmed, one line, at most 32 characters ('' = use the default). */
export function cleanOutpostName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 32);
}

// ---------------------------------------------------------------------------------------------
// Sites: stage, progress, what they wait for
// ---------------------------------------------------------------------------------------------

export const STAGE_WORDS: Readonly<Record<NonNullable<SiteView['stage']>, string>> = {
  pegs: 'Pegs and lines', footings: 'Footings', frame: 'Frame and walls', roof: 'Roof', done: 'Finished',
};

export const WORK_WORDS: Readonly<Record<SiteView['work'], string>> = {
  build: 'Raising', upgrade: 'Improving', repair: 'Mending', demolish: 'Pulling down',
};

export const STATUS_WORDS: Readonly<Record<SiteStatus, string>> = {
  waiting: 'Waiting', working: 'At work', stalled: 'Stalled', done: 'Done', cancelled: 'Cancelled',
};

export const STATUS_TONE: Readonly<Record<SiteStatus, 'gold' | 'green' | 'vermilion' | 'lapis' | 'ink'>> = {
  waiting: 'gold', working: 'green', stalled: 'vermilion', done: 'lapis', cancelled: 'ink',
};

/** "Raising a cottage" / "Improving the smithy" / "Pulling down the barn". */
export function siteTitle(site: Pick<SiteView, 'work' | 'kind' | 'outpost' | 'level'>): string {
  const name = BUILDINGS[site.kind]?.name.toLowerCase() ?? String(site.kind);
  const art = site.work === 'build' ? (/^[aeiou]/.test(name) ? 'an ' : 'a ') : 'the ';
  const lvl = site.work === 'upgrade' && site.level ? ` to level ${site.level}` : '';
  return `${WORK_WORDS[site.work]} ${art}${name}${lvl}${site.outpost ? ` at ${site.outpost}` : ''}`;
}

/** When a site should be done: "about Spring 3, Year 2 (in 9 days)", or "not while it stands idle" for an infinite eta. */
export function etaWords(eta: number, now: number, status: SiteStatus): string {
  if (status === 'done') return 'Finished';
  if (status === 'cancelled') return 'Cancelled';
  if (!Number.isFinite(eta) || eta <= 0) return status === 'stalled' ? 'Not while it stands idle' : 'Once the materials and the hands are there';
  const days = Math.max(0, Math.ceil(eta - now));
  const d = toDate(eta);
  const when = `${SEASON_NAMES[d.season]} ${d.dayOfSeason}`;
  if (days <= 0) return 'Today';
  return `About ${when} (${days === 1 ? 'tomorrow' : `in ${days} days`})`;
}

export interface MaterialLine {
  good: string;
  /** Still to come (not yet in the pile). */
  missing: number;
  /** Of which on a cart, arriving. */
  onTheWay: number;
  /** The day the next of it arrives (absolute), if any is on the way. */
  arrive?: number;
  text: string;
}

export interface Delivery { good: string; qty: number; arrive: number; from: number }

/**
 * What a site still waits for, good by good: how much is missing, how much of it is on the road (`deliveries` of the paying
 * household) and when the carts come. `describe` words an amount ("12 planks"), `placeName` a settlement.
 */
export function materialLines(
  missing: Readonly<Record<string, number>>, deliveries: readonly Delivery[], now: number,
  describe: (good: string, qty: number) => string, placeName: (settlement: number) => string,
): MaterialLine[] {
  const out: MaterialLine[] = [];
  for (const [good, need] of Object.entries(missing)) {
    if (need <= 0) continue;
    const carts = deliveries.filter((d) => d.good === good && d.qty > 0).sort((a, b) => a.arrive - b.arrive);
    let way = 0;
    for (const c of carts) way += c.qty;
    const onTheWay = Math.min(need, way);
    const first = carts[0];
    let text = describe(good, Math.ceil(need));
    if (onTheWay > 0 && first) {
      const days = Math.max(0, Math.ceil(first.arrive - now));
      text += ` — ${onTheWay >= need - 0.01 ? 'all' : Math.ceil(onTheWay)} on the way${first.from >= 0 ? ` from ${placeName(first.from)}` : ''}, ${days <= 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days} days`}`;
    } else text += ' — not yet ordered';
    out.push({ good, missing: need, onTheWay, arrive: first?.arrive, text });
  }
  return out.sort((a, b) => b.missing - a.missing || a.good.localeCompare(b.good));
}

export interface SiteCardModel {
  title: string;
  stage: string;
  progress: number;
  status: SiteStatus;
  statusWord: string;
  /** The module's own note ("Waiting for 12 planks: on the way from Dromore market, 1 day"). */
  note: string;
  materials: MaterialLine[];
  labour: string;
  workers: string;
  eta: string;
  /** 0..1 share of the materials in. */
  materialShare: number;
}

export function siteCard(
  site: SiteView, deliveries: readonly Delivery[], now: number,
  describe: (good: string, qty: number) => string, placeName: (settlement: number) => string,
): SiteCardModel {
  const stage = site.stage ?? (site.progress >= 1 ? 'done' : site.progress >= 0.7 ? 'roof' : site.progress >= 0.35 ? 'frame' : site.progress >= 0.08 ? 'footings' : 'pegs');
  const hired = site.hired ?? 0;
  return {
    title: siteTitle(site),
    stage: STAGE_WORDS[stage],
    progress: Math.max(0, Math.min(1, site.progress)),
    status: site.status,
    statusWord: STATUS_WORDS[site.status],
    note: site.note ?? '',
    materials: materialLines(site.missing, deliveries, now, describe, placeName),
    labour: site.labourLeft > 0 ? `${workerDays(site.labourLeft)} of work to do` : 'The work is done',
    workers: site.workers > 0 ? `${site.workers} at work today${hired > 0 ? `, ${hired} hired` : ''}` : 'No one at work today',
    eta: etaWords(site.eta, now, site.status),
    materialShare: site.materials ?? (Object.keys(site.missing).length === 0 ? 1 : 0),
  };
}

// ---------------------------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------------------------

export interface QueueRow {
  id: number;
  title: string;
  place: string;
  progress: number;
  status: SiteStatus;
  statusWord: string;
  /** Short wait/eta text for the row. */
  line: string;
  priority: number;
  x: number;
  z: number;
  mine: boolean;
  /** A laid run of wall, shown as one row: how many pieces it has. */
  pieces?: number;
}

/**
 * The player's sites in the order they are worked (lowest priority number first). `mine` says which the person may manage
 * (`canManage`) or ordered; other works in the same place are listed after them, dimmed, unless `onlyMine`.
 */
export function queueRows(
  sites: readonly SiteView[], manage: (site: number) => boolean, now: number, placeName: (settlement: number) => string, onlyMine = false,
): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const s of sites) {
    if (s.status === 'done' || s.status === 'cancelled') continue;
    const mine = manage(s.id);
    if (onlyMine && !mine) continue;
    const miss = Object.keys(s.missing).length;
    const line = s.note && s.status !== 'working' ? s.note : `${etaWords(s.eta, now, s.status)}${s.workers > 0 ? ` · ${s.workers} at work` : ''}`;
    rows.push({
      id: s.id, title: siteTitle(s), place: placeName(s.settlement), progress: s.progress, status: s.status, statusWord: STATUS_WORDS[s.status],
      line: miss && s.status === 'waiting' && !s.note ? `Waiting for ${miss} kind${miss === 1 ? '' : 's'} of goods` : line, priority: s.priority, x: s.x, z: s.z, mine,
    });
  }
  return groupRuns(rows, sites).sort((a, b) => Number(b.mine) - Number(a.mine) || a.priority - b.priority || a.id - b.id);
}

/** The lengths of one laid run of wall become one row (the first piece's id and place, the mean progress, the worst status). */
function groupRuns(rows: QueueRow[], sites: readonly SiteView[]): QueueRow[] {
  const lineOf = new Map<number, number>();
  for (const s of sites) if (s.line) lineOf.set(s.id, s.line);
  const first = new Map<number, QueueRow>();
  const out: QueueRow[] = [];
  for (const r of rows) {
    const ln = lineOf.get(r.id);
    if (!ln) { out.push(r); continue; }
    const head = first.get(ln);
    if (!head) { first.set(ln, { ...r, pieces: 1 }); continue; }
    head.progress = (head.progress * head.pieces! + r.progress) / (head.pieces! + 1);
    head.pieces!++;
    head.priority = Math.min(head.priority, r.priority);
    if (r.status === 'stalled') { head.status = 'stalled'; head.statusWord = r.statusWord; }
  }
  for (const [, r] of first) {
    r.title = `Laying a run of ${BUILDINGS[sites.find((s) => s.id === r.id)?.kind ?? 'wall']?.name.toLowerCase() ?? 'wall'} (${r.pieces} pieces)`;
    r.line = `${Math.round(r.progress * 100)}% done on the whole`;
    out.push(r);
  }
  return out;
}

/** The priority number that puts a site first / last among the sites it is queued with. */
export function priorityFor(rows: readonly Pick<QueueRow, 'priority' | 'mine'>[], where: 'first' | 'last'): number {
  const mine = rows.filter((r) => r.mine);
  if (!mine.length) return 0;
  return where === 'first' ? Math.min(...mine.map((r) => r.priority)) - 1 : Math.max(...mine.map((r) => r.priority)) + 1;
}

// ---------------------------------------------------------------------------------------------
// Buildings standing: condition, what can be done to them
// ---------------------------------------------------------------------------------------------

/** "Sound" / "Weathered" / "Damaged" / "In ruins" from the damage 0..1. */
export function conditionWords(damage: number): { word: string; tone: 'green' | 'gold' | 'vermilion'; share: number } {
  const share = Math.max(0, Math.min(1, 1 - damage));
  if (damage < 0.05) return { word: 'Sound', tone: 'green', share };
  if (damage < 0.25) return { word: 'Weathered', tone: 'green', share };
  if (damage < 0.55) return { word: 'Damaged', tone: 'gold', share };
  if (damage < 0.85) return { word: 'Badly damaged', tone: 'vermilion', share };
  return { word: 'In ruins', tone: 'vermilion', share };
}

export type ManageWork = 'upgrade' | 'repair' | 'demolish';

export interface ManageOption {
  work: ManageWork;
  label: string;
  ok: boolean;
  reason?: string;
  cost?: BuildCost;
  level?: number;
  /** "Level 2: 12 planks, 4 worker-days". */
  detail: string;
}

const MANAGE_LABEL: Readonly<Record<ManageWork, string>> = { upgrade: 'Upgrade', repair: 'Repair', demolish: 'Demolish' };

/** The three things you can do to a standing building, from the module's `quote`s. */
export function manageOptions(
  quotes: Readonly<Record<ManageWork, { ok: boolean; reason?: string; cost?: BuildCost; level?: number }>>,
  describe: (good: string, qty: number) => string,
): ManageOption[] {
  return (['upgrade', 'repair', 'demolish'] as const).map((work) => {
    const q = quotes[work];
    const cost = q.cost ? costSummary(q.cost, describe, 4) : '';
    const detail = q.ok
      ? work === 'demolish' ? `${cost ? `${cost}; ` : ''}some timber, planks and stone come back` : `${work === 'upgrade' && q.level ? `Level ${q.level}: ` : ''}${cost}`
      : q.reason ?? 'It cannot be done';
    return { work, label: MANAGE_LABEL[work], ok: q.ok, reason: q.reason, cost: q.cost, level: q.level, detail };
  });
}

/** Who owns a building, in words: "yours", "your household's", "House Avenel's", "no one in particular". */
export function ownerWords(
  b: { owner: number; household: number }, me: { house: number; household: number }, houseName: (id: number) => string,
): string {
  if (b.household && b.household === me.household) return 'your household’s';
  if (b.owner && b.owner === me.house) return 'your House’s';
  if (b.owner) return `House ${houseName(b.owner)}’s`;
  if (b.household) return 'a household’s';
  return 'held in common';
}

// ---------------------------------------------------------------------------------------------
// Where the camera goes
// ---------------------------------------------------------------------------------------------

export interface OverviewPlan { x: number; z: number; radius: number; distance: number }

/**
 * The first circle the overview camera looks over: the nearest settlement the person may build in (or their own, for a household
 * head), with a radius that takes in the buildable ground but not the whole of a great lordship; the camera starts close enough
 * to see buildings as buildings.
 */
export function overviewPlan(
  centre: { x: number; z: number }, landsRadius: number, role: BuildScope['role'],
): OverviewPlan {
  const reach = role === 'head' ? 450 : 1400;
  return { x: centre.x, z: centre.z, radius: Math.max(250, Math.min(landsRadius || reach, reach)), distance: role === 'head' ? 120 : 170 };
}

/** The nearest of some places to a point (ids from `places`), or −1. */
export function nearestOf(places: ReadonlyArray<{ id: number; x: number; z: number }>, x: number, z: number): number {
  let best = -1;
  let bd = Infinity;
  for (const p of places) {
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bd) { bd = d; best = p.id; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Where to build
// ---------------------------------------------------------------------------------------------

export interface WhereOption { id: number; label: string; hint?: string }

/**
 * The places the catalogue can be asked about: the settlements the person has a say in (their own first), their own place when
 * they only build on their own plot, and the wild when they may found outposts (−1).
 */
export function whereOptions(
  scope: Pick<BuildScope, 'settlements' | 'outposts' | 'role'>, home: number, name: (settlement: number) => string,
): WhereOption[] {
  const out: WhereOption[] = [];
  const ids = scope.settlements.length ? [...scope.settlements] : scope.role === 'head' || scope.role === 'steward' ? [home] : [];
  ids.sort((a, b) => (a === home ? -1 : b === home ? 1 : name(a).localeCompare(name(b), 'en')));
  for (const id of ids) {
    if (id < 0) continue;
    out.push({ id, label: name(id), hint: scope.role === 'head' && !scope.settlements.length ? 'your plot' : undefined });
  }
  if (scope.outposts) out.push({ id: -1, label: 'The wild', hint: 'found an outpost' });
  return out;
}
