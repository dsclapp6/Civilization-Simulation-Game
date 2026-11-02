// The works of an AI ruler (docs/CIV.md §10): what he builds next, and where. Each round he looks at one of his places and asks the
// builder's own rules (the rank, technique and count the catalogue asks of the player; the spot is then asked of `check`): homes when families crowd, the
// workshop a trade is missing, a mill by the river, a church for the faithful, walls and arms when his neighbours frighten him,
// the lumber camp or quarry when the materials he builds with run dear. He pays from his purse, hires the same labourers and buys
// the same materials at the same markets; he starts nothing that the markets cannot supply or that his purse cannot carry, keeps
// only a few works going at once, and gives up one that stands still.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import { hash01 } from '../../core/math';
import type { ResourceKind } from '../../world/types';
import { costValue, maxPerSettlement, rulesOf } from '../construction/data';
import { TITLE_RANK } from '../state';
import { AI, BARRACKS_MEN, DEFENCE_KINDS, FORT_WEIGHT, HOUSING_KINDS, NOTABLE, YEAR_SHARE } from './aiConfig';
import type { PlacementCheck } from '../construction/types';
import { fortWanted, loadPlace, openLimit, refreshFunds, type Place, type Sense } from './aiSense';
import { researchPlaceWanted } from './aiResearch';
import { findSpot } from './aiSpot';
import { liveValue, stockUp, stuck, supplied } from './aiSupply';
import type { Ai } from './ai';
import { addNews } from './news';
import { setWorksShare, worksShare } from './plans';

/** A thing the ruler would like to build, and how much. */
export interface Want {
  kind: BuildingKind;
  /** Roughly 0..1.2: how much he wants it now. */
  score: number;
  place: Place;
  why: string;
}

type Group = 'home' | 'farm' | 'craft' | 'trade' | 'faith' | 'civic' | 'defence' | 'military' | 'resource';

interface Ctx {
  A: Ai;
  S: Sense;
  p: Place;
  n(kind: BuildingKind): number;
  has(tech: string): boolean;
  yields(good: string): boolean;
  deposits(kind: ResourceKind): number;
  scarce(good: string): number;
  /** Men of the ruler's retinue at this place. */
  men: number;
}

interface Rule { kind: BuildingKind; group: Group; f(c: Ctx): number | [number, string] }

const rnd = (x: number): number => Math.round(x);

/** Does the place need more walls than it has? Cities and castles with their walls about them need none. */
function fortGap(c: Ctx): boolean {
  return c.p.fort < fortWanted(c.S.fear) - 0.2;
}

/** Rules, in the order of the doc: what a ruler asks of each place. A score of 0 (or less) means "not wanted". */
const RULES: readonly Rule[] = [
  // ---- the land and the larder ----
  { kind: 'granary', group: 'farm', f: (c) => (c.p.pop >= 70 && c.n('granary') < (c.p.pop >= 300 ? 2 : 1) ? [0.4 + (c.p.prosperity < 0.97 ? 0.2 : 0), 'a granary against hungry years'] : 0) },
  { kind: 'barn', group: 'farm', f: (c) => (c.p.pop >= 60 && c.n('barn') < Math.max(1, rnd(c.p.pop / 150)) ? [0.34, 'barn room for the harvest'] : 0) },
  { kind: 'stable', group: 'military', f: (c) => (c.n('stable') < 1 && c.S.tier >= 5 && (c.S.fear > 0.3 || c.S.mind.ambitious > 0.55) ? [0.3, 'stabling for the horse'] : 0) },
  { kind: 'tithe_barn', group: 'farm', f: (c) => (c.p.kind === 'village' && c.p.pop >= 160 && c.n('tithe_barn') < 1 ? [0.22, 'a tithe barn'] : 0) },
  { kind: 'watermill', group: 'craft', f: (c) => (c.p.res?.river && c.has('watermill') && c.yields('grain') && c.n('watermill') < (c.p.pop >= 240 ? 2 : 1) ? [0.68, 'a mill on the river'] : 0) },
  { kind: 'windmill', group: 'craft', f: (c) => (c.has('windmill') && !c.p.res?.river && c.n('windmill') + c.n('watermill') < (c.p.pop >= 240 ? 2 : 1) && c.yields('grain') ? [0.5, 'a windmill on the rise'] : 0) },
  { kind: 'fulling_mill', group: 'craft', f: (c) => (c.p.res?.river && c.has('fulling_mill') && c.yields('wool') && c.n('fulling_mill') < 1 ? [0.34, 'a fulling mill for the wool'] : 0) },
  { kind: 'bakehouse', group: 'craft', f: (c) => (c.p.pop >= 100 && c.n('bakehouse') < Math.max(1, rnd(c.p.pop / 260)) ? [0.4, 'a bakehouse'] : 0) },
  { kind: 'brewhouse', group: 'craft', f: (c) => (c.p.pop >= 70 && c.n('brewhouse') < Math.max(1, rnd(c.p.pop / 200)) ? [0.34, 'a brewhouse'] : 0) },
  // ---- trades ----
  { kind: 'smithy', group: 'craft', f: (c) => (c.p.pop >= 60 && c.n('smithy') < Math.max(1, rnd(c.p.pop / 190)) ? [0.4, 'a smith for the village'] : 0) },
  { kind: 'carpenter', group: 'craft', f: (c) => (c.p.pop >= 80 && c.n('carpenter') < Math.max(1, rnd(c.p.pop / 230)) ? [0.34, 'a carpenter'] : 0) },
  { kind: 'weaver', group: 'craft', f: (c) => (c.yields('wool') && c.p.pop >= 90 && c.n('weaver') < Math.max(1, rnd(c.p.pop / 210)) ? [0.33, 'a weaver for the wool'] : 0) },
  { kind: 'tannery', group: 'craft', f: (c) => (c.p.res?.river && c.p.pop >= 120 && c.n('tannery') < Math.max(1, Math.ceil(c.p.pop / 420)) ? [0.28, 'a tannery by the water'] : 0) },
  { kind: 'slaughterhouse', group: 'craft', f: (c) => (c.p.pop >= 130 && c.n('slaughterhouse') < 1 ? [0.27, 'a slaughterhouse'] : 0) },
  // the materials the lord builds with: where the woods and the stone are his, dear materials call for the works that make them
  { kind: 'lumber_camp', group: 'resource', f: (c) => ((c.p.res?.forest ?? 0) >= 0.3 && c.n('lumber_camp') < 1 ? [0.34 + 0.5 * c.scarce('timber'), 'a lumber camp: timber is dear'] : 0) },
  { kind: 'sawpit', group: 'resource', f: (c) => (c.n('sawpit') < 1 && (c.n('lumber_camp') > 0 || (c.p.res?.forest ?? 0) >= 0.2) ? [0.3 + 0.5 * c.scarce('planks'), 'a saw pit: planks are dear'] : 0) },
  { kind: 'quarry', group: 'resource', f: (c) => (c.n('quarry') < 1 && c.deposits('stone') > 0 ? [0.3 + 0.5 * c.scarce('stone') + (c.S.fear > 0.4 ? 0.25 : 0), 'a quarry for stone'] : 0) },
  { kind: 'clay_pit', group: 'resource', f: (c) => (c.n('clay_pit') < 1 && c.deposits('clay') > 0 ? [0.25 + 0.3 * c.scarce('brick'), 'a clay pit'] : 0) },
  { kind: 'kiln', group: 'craft', f: (c) => (c.n('kiln') < 1 && c.n('clay_pit') > 0 ? [0.28 + 0.4 * c.scarce('brick'), 'a kiln for bricks'] : 0) },
  { kind: 'mine', group: 'resource', f: (c) => {
    const rich = c.deposits('silver') + c.deposits('gold');
    return c.n('mine') < (rich > 0 ? 2 : 1) && (c.deposits('iron') > 0 || rich > 0) ? [0.25 + 0.3 * c.S.mind.ambitious + (rich > 0 ? 0.25 : 0), 'a mine on the ore'] : 0;
  } },
  { kind: 'salt_pan', group: 'resource', f: (c) => (c.n('salt_pan') < 1 && c.deposits('salt') > 0 && c.p.res?.coast ? [0.22, 'salt pans on the shore'] : 0) },
  { kind: 'dock', group: 'trade', f: (c) => (c.p.s.port && c.p.res?.coast && c.p.pop >= 120 && c.n('dock') < 1 ? [0.28, 'a dock for the boats'] : 0) },
  { kind: 'bloomery', group: 'craft', f: (c) => (c.deposits('iron') > 0 && c.n('mine') > 0 && c.n('bloomery') < 1 ? [0.25, 'a bloomery for the ore'] : 0) },
  { kind: 'charcoal_mound', group: 'craft', f: (c) => (c.n('bloomery') > 0 && c.n('charcoal_mound') < 1 ? [0.2, 'charcoal for the bloomery'] : 0) },
  // ---- trade and town ----
  { kind: 'warehouse', group: 'trade', f: (c) => (c.p.market && c.p.pop >= 140 && c.n('warehouse') < (c.p.kind === 'town' || c.p.kind === 'city' ? 2 : 1) ? [0.3, 'a warehouse at the market'] : 0) },
  { kind: 'market_cross', group: 'trade', f: (c) => (c.p.market && c.n('market_cross') < 1 ? [0.28, 'a market cross'] : 0) },
  { kind: 'market_stall', group: 'trade', f: (c) => (c.p.market && c.n('market_stall') < Math.max(1, Math.min(5, rnd(c.p.pop / 90))) ? [0.2, 'stalls for market day'] : 0) },
  { kind: 'market_hall', group: 'trade', f: (c) => (c.has('market_charter') && (c.p.kind === 'town' || c.p.kind === 'city') && c.n('market_hall') < 1 ? [0.45, 'a market hall under the charter'] : 0) },
  { kind: 'guildhall', group: 'trade', f: (c) => (c.has('guild_charter') && c.p.pop >= 180 && c.n('guildhall') < 1 ? [0.34, 'a guildhall'] : 0) },
  { kind: 'alehouse', group: 'civic', f: (c) => (c.p.pop >= 60 && c.n('alehouse') < Math.max(1, rnd(c.p.pop / 160)) ? [0.27, 'an alehouse'] : 0) },
  { kind: 'tavern', group: 'trade', f: (c) => (c.p.pop >= 220 && c.n('tavern') < Math.max(1, rnd(c.p.pop / 320)) ? [0.25, 'a tavern'] : 0) },
  { kind: 'well', group: 'civic', f: (c) => (c.n('well') < Math.max(1, rnd(c.p.pop / 150)) ? [0.3, 'a well'] : 0) },
  { kind: 'stocks', group: 'civic', f: (c) => (c.p.pop >= 100 && c.n('stocks') < 1 ? [0.12, 'stocks for the peace'] : 0) },
  { kind: 'gaol', group: 'civic', f: (c) => ((c.p.kind === 'town' || c.p.kind === 'city' || c.p.kind === 'castle') && c.n('gaol') < 1 ? [0.22 + (c.S.war ? 0.1 : 0), 'a gaol'] : 0) },
  { kind: 'school', group: 'faith', f: (c) => (c.has('parish_school') && c.p.pop >= 120 && c.n('school') < 1 ? [0.34, 'a school'] : 0) },
  // ---- faith ----
  { kind: 'church', group: 'faith', f: (c) => {
    if (c.p.kind === 'castle') return 0;
    if (c.n('church') < 1 && c.p.pop >= 80) return [0.55 + 0.3 * c.S.mind.pious, 'a parish church'];
    if ((c.p.kind === 'town' || c.p.kind === 'city') && c.n('church') < Math.ceil(c.p.pop / 350)) return [0.22 + 0.3 * c.S.mind.pious, 'another church for the town'];
    return 0;
  } },
  { kind: 'chapel', group: 'faith', f: (c) => (c.n('chapel') < 1 && c.n('church') < 1 && (c.p.kind === 'castle' || c.p.pop < 80) ? [0.28 + 0.2 * c.S.mind.pious, 'a chapel'] : 0) },
  { kind: 'infirmary', group: 'faith', f: (c) => (c.has('infirmary_care') && c.p.pop >= 140 && c.n('infirmary') < 1 ? [0.3, 'an infirmary'] : 0) },
  { kind: 'cloister', group: 'faith', f: (c) => ((c.p.kind === 'abbey' || c.p.kind === 'priory' || c.p.kind === 'nunnery') && c.n('cloister') < 1 ? [0.5, 'a cloister'] : 0) },
  { kind: 'abbey_church', group: 'faith', f: (c) => ((c.p.kind === 'abbey') && c.n('abbey_church') < 1 ? [0.5, 'an abbey church'] : 0) },
  // ---- arms and walls: they follow fear ----
  { kind: 'archery_butts', group: 'military', f: (c) => (c.n('archery_butts') < 1 && c.p.pop >= 80 && (c.S.fear > 0.3 || c.S.mind.ambitious > 0.6) ? [0.18 + 0.2 * c.S.fear, 'butts to train the archers'] : 0) },
  { kind: 'barracks', group: 'military', f: (c) => (c.men >= BARRACKS_MEN && c.n('barracks') < Math.ceil(c.men / 40) ? [0.32 + 0.3 * c.S.fear, 'a barracks for the men'] : 0) },
  { kind: 'training_yard', group: 'military', f: (c) => (c.S.troops.length >= 14 && c.n('training_yard') < 1 ? [0.22 + 0.2 * c.S.fear, 'a yard to train in'] : 0) },
  { kind: 'great_hall', group: 'military', f: (c) => (c.n('great_hall') < 1 && c.S.tier >= 5 && c.p.id === c.S.seat ? [0.14, 'a great hall'] : 0) },
  { kind: 'palisade', group: 'defence', f: (c) => (c.S.fear >= 0.3 && fortGap(c) && (!c.has('curtain_walls') || c.p.kind === 'village' || c.p.kind === 'hamlet') ? [0.3 + 0.5 * c.S.fear, 'a palisade against the danger'] : 0) },
  { kind: 'wall', group: 'defence', f: (c) => (fortGap(c) && c.has('curtain_walls') ? [0.45 + 0.5 * c.S.fear, 'curtain wall against the danger'] : 0) },
  { kind: 'tower', group: 'defence', f: (c) => (fortGap(c) && c.has('stone_keep') && c.p.pieces >= 5 && c.n('tower') < c.p.pieces / 6 ? [0.3 + 0.3 * c.S.fear, 'a tower on the wall'] : 0) },
  { kind: 'gatehouse', group: 'defence', f: (c) => (fortGap(c) && c.has('curtain_walls') && c.n('wall') >= 6 && c.n('gatehouse') < 1 ? [0.3 + 0.2 * c.S.fear, 'a gatehouse'] : 0) },
  { kind: 'keep_stone', group: 'defence', f: (c) => (fortGap(c) && c.has('stone_keep') && c.S.fear > 0.4 && c.n('keep_stone') < 1 && c.n('motte') < 1 && (c.p.kind === 'castle' || c.p.id === c.S.seat) ? [0.4 + 0.4 * c.S.fear, 'a stone keep'] : 0) },
  { kind: 'motte', group: 'defence', f: (c) => (fortGap(c) && !c.has('stone_keep') && c.S.fear > 0.45 && c.S.tier >= 5 && c.p.pop >= 60 && c.n('motte') < 1 && c.n('keep_stone') < 1 ? [0.35 + 0.3 * c.S.fear, 'a motte and keep'] : 0) },
];

/** How much the personality and the times weigh each kind of work. */
function weightOf(S: Sense, g: Group): number {
  const m = S.mind;
  switch (g) {
    case 'faith': return 0.7 + 0.6 * m.pious;
    case 'defence': return 0.4 + 1.1 * S.fear;
    case 'military': return 0.5 + 0.5 * m.ambitious + 0.8 * S.fear;
    case 'trade': return 0.8 + 0.5 * m.greedy;
    case 'resource': return 0.9 + 0.3 * m.greedy;
    case 'home': return 1.1;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The wants of a place
// ---------------------------------------------------------------------------------------------

function homeKind(S: Sense, p: Place, salt: number): BuildingKind {
  const u = hash01(p.id, salt, 91);
  if (p.kind === 'city' || p.kind === 'town') return u < 0.35 && S.tier >= 4 ? 'townhouse' : 'cottage';
  return u < 0.18 && S.tier >= 5 ? 'longhouse' : u < 0.3 ? 'hovel' : 'cottage';
}

/** The rank the ruler builds at: his own, or that of the greatest title he holds. */
function buildRank(S: Sense, R: Ai['R']): number {
  const top = S.rules.length ? R.state.titles.get(S.rules[0].title) : undefined;
  return Math.max(S.person.rankTier, top ? Math.min(8, TITLE_RANK[top.kind]) : 0);
}

/** May this ruler raise the kind at this place (the technique his House commands, his rank, the count the place may hold)? */
function permitted(c: Ctx, rank: number, kind: BuildingKind): boolean {
  const rules = rulesOf(kind);
  if (rules.tech && !c.has(rules.tech)) return false;
  if (rules.rank > rank) return false;
  return (c.p.n[kind] ?? 0) < maxPerSettlement(kind, c.p.kind);
}

/** Wants for one place, best first. The place must be loaded; the spot, the supply and the purse are asked of the builder and the markets when he comes to place one. */
export function wantsFor(A: Ai, S: Sense, p: Place): Want[] {
  const R = A.R;
  const rank = buildRank(S, R);
  let men = 0;
  for (const t of S.troops) if (t.s === p.id) men++;
  const techMemo = new Map<string, boolean>();
  const ctx: Ctx = {
    A, S, p, men,
    n: (k) => p.n[k] ?? 0,
    has: (t) => {
      let v = techMemo.get(t);
      if (v === undefined) { v = R.advancement ? R.advancement.houseHas(S.house, t) : false; techMemo.set(t, v); }
      return v;
    },
    yields: (g) => !!p.res?.yields.includes(g),
    deposits: (k) => { let n = 0; for (const d of p.res?.deposits ?? []) if (d.kind === k) n++; return n; },
    scarce: (g) => Math.max(0, Math.min(1, (A.priceRatio(p.id, g) - 1.2) / 1.0)),
  };
  const out: Want[] = [];
  const add = (kind: BuildingKind, raw: number, why: string, group: Group): void => {
    if (raw <= 0 || !permitted(ctx, rank, kind)) return;
    const jitter = (hash01(S.ruler, Math.floor(R.day / 4), kind.length * 31 + p.id) - 0.5) * 0.12;
    out.push({ kind, score: raw * weightOf(S, group) + jitter, place: p, why });
  };
  for (const r of RULES) {
    const v = r.f(ctx);
    if (typeof v === 'number') add(r.kind, v, '', r.group);
    else add(r.kind, v[0], v[1], r.group);
  }
  // homes: families that share a home, and no empty home to let
  if (HOUSING_KINDS.has(p.kind) && p.families > 0) {
    const crowd = p.sharing / p.families;
    if (p.sharing >= 3 && crowd >= 0.08 && p.empty < 2 && p.queuedHomes < Math.ceil(p.sharing / 4)) {
      const kind = homeKind(S, p, Math.floor(R.day / 16));
      add(kind, 0.36 + 0.32 * Math.min(1, crowd / 0.25), `${p.sharing} families share a home`, 'home');
    }
  }
  // a place to work out the technique he wants most
  if (p.id === S.seat || S.places.length === 1) {
    const need = researchPlaceWanted(A, S);
    if (need) add(need.kind, 0.45, `a place to work out ${need.tech.replace(/_/g, ' ')}`, 'craft');
  }
  out.sort((a, b) => b.score - a.score || (a.kind < b.kind ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------------------------------

const aOrAn = (n: string): string => (/^[aeiou]/i.test(n) ? `an ${n.toLowerCase()}` : `a ${n.toLowerCase()}`);

/** What a ruler's round decided to do with the builder (chosen in one shard, done in the next, so that no call is long). */
export type Pending =
  | { kind: 'place'; want: Want; spot: PlacementCheck }
  | { kind: 'repair'; place: Place }
  | { kind: 'upgrade'; place: Place; id: number; building: BuildingKind };

/** Weighs a want against the purse and the markets and finds it a spot: the spot, or null (with the reason noted and the want put off). */
function prepare(A: Ai, S: Sense, w: Want): PlacementCheck | null {
  const R = A.R;
  const key = `w:${w.place.id}:${w.kind}`;
  const value = liveValue(A, w.place, w.kind);
  const share = value <= 600 ? 1 : AI.projectShare;
  if (value > S.allowance * share || S.allowance < AI.minFunds) { A.note(`${S.ruler} ${w.kind}@${w.place.id}: too dear (${Math.round(value)} of ${Math.round(S.allowance)})`); return null; }
  const short = supplied(A, S, w.place, w.kind);
  if (short) {
    A.note(`${S.ruler} ${w.kind}@${w.place.id}: no ${short}`);
    // a material the markets lack is laid in by a standing order, and the work begun when the store holds it
    if (!short.endsWith(')') && w.score >= AI.startScore + 0.1) stockUp(A, S, w.place, w.kind, short);
    A.block(S.house, key, 6);
    return null;
  }
  const spot = findSpot(R, S, w.place, w.kind);
  if (!spot) { A.note(`${S.ruler} ${w.kind}@${w.place.id}: no room`); A.fail(S.house, key, AI.retryDays); return null; }
  return spot;
}

/** Stakes the work out with the builder. */
function commitPlace(A: Ai, S: Sense, w: Want, spot: PlacementCheck): boolean {
  const R = A.R, C = R.construction;
  if (!C) return false;
  const key = `w:${w.place.id}:${w.kind}`;
  const rules = rulesOf(w.kind);
  const res = C.place(S.ruler, w.kind, spot.x, spot.z, spot.rot, {
    occupant: rules.cat === 'home' ? 'vacant' : undefined,
    priority: DEFENCE_KINDS.has(w.kind) && S.fear > 0.6 ? -1000 : undefined,
  });
  if (!res.ok || res.site === undefined) { A.note(`${S.ruler} ${w.kind}@${w.place.id}: refused: ${res.reason}`); A.fail(S.house, key, AI.retryDays); return false; }
  A.worked(S.house, key);
  A.sitePlaced(S.house, res.site, w.kind, w.place.id);
  const view = C.site(res.site);
  if (view) S.open.push(view);
  w.place.n[w.kind] = (w.place.n[w.kind] ?? 0) + 1;
  w.place.open++;
  refreshFunds(R, S);
  const weight = NOTABLE[w.kind];
  if (weight !== undefined && !A.said(S.house, `n:${w.kind}`, 16)) {
    A.say(S.house, `n:${w.kind}`);
    addNews(R, {
      kind: 'built', house: S.house, settlement: w.place.id, weight,
      text: `${R.houseName(S.house)} is raising ${aOrAn(BUILDINGS[w.kind].name)} at ${R.placeName(w.place.id)}`,
    });
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Mending, improving, giving up
// ---------------------------------------------------------------------------------------------

/** What a ruler cares to improve when he is rich, and how much. */
const UPGRADES: Readonly<Partial<Record<BuildingKind, number>>> = {
  watermill: 0.35, windmill: 0.3, smithy: 0.2, bakehouse: 0.2, brewhouse: 0.18, church: 0.3, barn: 0.18, granary: 0.2,
  market_hall: 0.3, guildhall: 0.25, warehouse: 0.2, tavern: 0.2, school: 0.2, infirmary: 0.2, stable: 0.14, carpenter: 0.16, weaver: 0.16,
  manor_house: 0.18, great_hall: 0.15,
  barracks: 0.3, training_yard: 0.2, palisade: 0.3, wall: 0.4, tower: 0.3, gatehouse: 0.3, keep_stone: 0.4, motte: 0.3,
};
const FORT_UP: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['palisade', 'wall', 'tower', 'gatehouse', 'keep_stone', 'motte', 'barracks', 'training_yard']);

function commitRepair(A: Ai, S: Sense, p: Place): boolean {
  const C = A.R.construction;
  if (!C || !p.hurt) return false;
  const b = p.hurt;
  const q = C.quote?.(S.ruler, 'repair', b.id);
  if (!q || !q.ok) { A.fail(S.house, `m:${b.id}`, AI.retryDays); return false; }
  const value = q.cost ? costValue(b.kind, q.cost) : 0;
  if (value > S.funds - S.comfort * 0.5) return false;
  const res = C.repair(S.ruler, b.id);
  if (!res.ok) { A.fail(S.house, `m:${b.id}`, AI.retryDays); return false; }
  if (res.site !== undefined) A.sitePlaced(S.house, res.site, b.kind, p.id, 'repair');
  p.hurt = null;
  refreshFunds(A.R, S);
  return true;
}

/** The building the ruler would most like to improve at the place (a look at the place's buildings; nothing is asked of the builder). */
function chooseUpgrade(A: Ai, S: Sense, p: Place): { id: number; kind: BuildingKind } | null {
  const R = A.R;
  if (!R.construction || p.prosperity < 1 || S.allowance < AI.minFunds * 4) return null;
  const list = R.state.buildingsAt.get(p.id) ?? [];
  let best: { id: number; kind: BuildingKind; score: number } | null = null;
  const week = Math.floor(R.day / 4);
  for (const b of list) {
    const base = UPGRADES[b.kind];
    if (base === undefined || b.construction < 1 || b.damage > 0.2 || b.level >= BUILDINGS[b.kind].maxLevel) continue;
    if (b.level >= 3) continue;
    if (A.blocked(S.house, `u:${b.id}`)) continue;
    if (b.owner !== 0 && b.owner !== S.house && b.household !== 0) continue;
    if (R.construction.siteOf(b.id)) continue;
    const fort = FORT_UP.has(b.kind) ? 0.4 + 1.1 * S.fear : 1;
    if (FORT_WEIGHT[b.kind] !== undefined && p.fort >= fortWanted(S.fear) + 0.4) continue;
    const score = base * fort * (1 - 0.3 * (b.level - 1)) + (hash01(b.id, week, 7) - 0.5) * 0.08;
    if (!best || score > best.score || (score === best.score && b.id < best.id)) best = { id: b.id, kind: b.kind, score };
  }
  return best && best.score >= AI.improveScore ? { id: best.id, kind: best.kind } : null;
}

function commitUpgrade(A: Ai, S: Sense, p: Place, id: number, kind: BuildingKind): boolean {
  const C = A.R.construction;
  if (!C) return false;
  const q = C.quote?.(S.ruler, 'upgrade', id);
  if (!q || !q.ok || !q.cost) { A.fail(S.house, `u:${id}`, AI.retryDays); return false; }
  const value = costValue(kind, q.cost);
  if (value > S.allowance * AI.projectShare) { A.block(S.house, `u:${id}`, 8); return false; }
  const short = supplied(A, S, p, kind, q.level ?? 2);
  if (short) { A.block(S.house, `u:${id}`, 6); return false; }
  const res = C.upgrade(S.ruler, id);
  if (!res.ok) { A.fail(S.house, `u:${id}`, AI.retryDays); return false; }
  if (res.site !== undefined) A.sitePlaced(S.house, res.site, kind, p.id, 'upgrade');
  refreshFunds(A.R, S);
  return true;
}

/** A work that has stood still for long is given up (part of its materials come back) so that it does not hold a place in the queue. */
export function cancelStalled(A: Ai, S: Sense): number {
  const C = A.R.construction;
  if (!C) return 0;
  let n = 0;
  for (const x of S.open.slice()) {
    if (!stuck(x) || A.siteAge(x.id) < AI.stallDays) continue;
    const res = C.cancel(S.ruler, x.id);
    if (res.ok) {
      n++;
      S.open.splice(S.open.indexOf(x), 1);
      A.block(S.house, x.work === 'build' ? `w:${x.settlement}:${x.kind}` : `u:${x.building}`, AI.retryDays * 2);
    }
  }
  if (n) refreshFunds(A.R, S);
  return n;
}

/** The share of the manor's week-work sent to the lord's works follows whether there are any. */
export function adjustWorks(A: Ai, S: Sense): void {
  for (const p of S.places) {
    const want = p.open > 0 ? 0.5 : 0;
    const have = worksShare(A.R, p.id);
    if (Math.abs(have - want) > 0.01) setWorksShare(A.R, S.ruler, p.id, want);
  }
}

// ---------------------------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------------------------

/** Works a House may stake out in a game year. */
export function yearCap(S: Sense): number {
  const x = (AI.yearBase + AI.yearPerPlace * S.places.length) * YEAR_SHARE[S.class] * S.pace;
  // the part of a work over the whole ones is a chance in the year, decided by the House's luck of the year
  return Math.floor(x) + (hash01(S.house, S.year, 41) < x - Math.floor(x) ? 1 : 0);
}

/** Homes a House may stake out in a game year: a share of its works, and more where many families share a home. */
export function homeCap(S: Sense, cap: number): number {
  let sharing = 0, families = 0;
  for (const p of S.places) { sharing += p.sharing; families += p.families; }
  const crowd = families > 0 ? sharing / families : 0;
  return Math.max(1, Math.ceil(cap / 2)) + (crowd > 0.25 ? 1 : 0) + (crowd > 0.4 ? 1 : 0);
}

/** The place the ruler looks at this round: one a round, in turn (the loop over a place's buildings is the dear part of looking). */
export function focusOf(S: Sense, round: number): Place {
  return S.places[(round + S.unit.key) % S.places.length];
}

/**
 * Stage 0 of a round, for the works: looks at the place of the round and asks the markets what the materials cost and how much there
 * is, before any work of the hour is staked out (a work staked out makes the economy count the world's works again at the next
 * question about the markets, which is dear), so the stages after it ask nothing of the markets they have not been told.
 */
export function warmUp(A: Ai, S: Sense): void {
  if (S.places.length === 0 || !A.R.construction || !canStake(A, S)) return;
  const p = focusOf(S, Math.floor(A.R.day / 4));
  loadPlace(A, p);
  for (const g of ['timber', 'planks', 'stone', 'iron', 'brick']) { A.priceRatio(p.id, g); A.stockAt(p.id, g); }
}

/** Can the ruler start a new work this round at all (his share of the year, the works going, the purse)? */
export function canStake(A: Ai, S: Sense): boolean {
  return A.placedThisYear(S.house).works < yearCap(S) + 2 && S.open.length < openLimit(S) && S.allowance >= AI.minFunds && !S.open.some(stuck);
}

/**
 * Stage 1 of a round, for the works: gives up what is stuck, and chooses what to do with the builder - mend what is hurt, stake out
 * the work he wants most that his purse, the markets and the ground allow (looking for the spot is the dear part, so it ends the
 * stage), else improve a building. The doing is the next stage's.
 */
export function worksChoose(A: Ai, S: Sense): Pending | null {
  const R = A.R, C = R.construction;
  if (!C || !S.payer || S.places.length === 0) return null;
  const round = Math.floor(R.day / 4);
  cancelStalled(A, S);
  const p = loadPlace(A, focusOf(S, round));
  const limit = openLimit(S);
  if (p.hurt && S.open.length <= limit + 1 && !A.blocked(S.house, `m:${p.hurt.id}`)) return { kind: 'repair', place: p };
  // a ruler whose works wait for materials starts nothing new, nor one who has had his share of the year
  const done = A.placedThisYear(S.house);
  const cap = yearCap(S);
  const homes = homeCap(S, cap);
  if (S.open.some(stuck) || S.open.length >= limit || S.allowance < AI.minFunds) return null;
  // the crowded realm may stake out a home or two more than its share of the year, and no more than that
  if (done.works < cap + (homes - Math.max(1, Math.ceil(cap / 2)))) {
    const homesFull = done.homes >= homes;
    let tried = 0;
    for (const w of wantsFor(A, S, p)) {
      if (tried >= 2 || w.score < AI.startScore) break;
      if (homesFull && HOMES.has(w.kind)) continue;
      // what is put off, or cannot be afforded, costs the round nothing; only a real attempt counts
      if (A.blocked(S.house, `w:${w.place.id}:${w.kind}`)) continue;
      tried++;
      const spot = prepare(A, S, w);
      if (spot) return { kind: 'place', want: w, spot };
    }
    if (hash01(S.ruler, round, 3) < 0.5) {
      const up = chooseUpgrade(A, S, p);
      if (up) return { kind: 'upgrade', place: p, id: up.id, building: up.kind };
    }
  }
  return null;
}

/** Stage 2 of a round, for the works: does what stage 1 chose. */
export function worksAct(A: Ai, S: Sense, what: Pending): void {
  switch (what.kind) {
    case 'place': commitPlace(A, S, what.want, what.spot); break;
    case 'repair': commitRepair(A, S, what.place); break;
    default: commitUpgrade(A, S, what.place, what.id, what.building); break;
  }
}

const HOMES: ReadonlySet<BuildingKind> = new Set<BuildingKind>(['hovel', 'cottage', 'longhouse', 'townhouse']);

/** Wants of the realm's places, for tests and tools: what he would build, best first. */
export function wantsOf(A: Ai, S: Sense): Want[] {
  const out: Want[] = [];
  for (const p of S.places) out.push(...wantsFor(A, S, loadPlace(A, p)));
  out.sort((a, b) => b.score - a.score);
  return out;
}
