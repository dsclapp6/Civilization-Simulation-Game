// Schedules → whereabouts. A deterministic, cheap function of the person (career, age, sex, rank,
// household, home, health), the kind of day (work day, market day of their market town, holy day),
// the season (daylight), the weather and the time of day. It never touches the RNG or any state, so
// it can be asked about anyone at any time: "Where is Agnes at noon on the holy day?".
//
// The day is built from anchors relative to sunrise and sunset (people rose with the sun): rise,
// chores, work, the midday meal, work, evening, bed. On a holy day: dress, walk to church, Mass
// (indoors), the churchyard, then leisure — archery at the butts for men and youths (the 1363
// statute, SPEC §4), gossip, games, the alehouse. On a market day people carry goods to their
// market town. The economy's `workSpot` wins whenever it names a place; otherwise career defaults
// say where a farmer, smith, alewife, shepherd, priest, soldier… spends the day.
import { BUILDINGS, type BuildingKind } from '../content/types';
import type { P2 } from '../core/math';
import { hash01 } from '../core/math';
import { daylight, toDate, type Season } from '../core/time';
import type { AnimState, BackLook, CarryLook, HeldItem } from '../core/view';
import { dayPart, isHolyDay, isMarketDay } from '../sim/calendar';
import type { CareerId } from '../sim/careers';
import type { EconomyApi, WorkSpot } from '../sim/economy/types';
import { ageYears, type BuildingState, type GameState, type Person } from '../sim/state';
import { sampleWeather, type WeatherSample } from '../sim/weather';
import type { Strip, WorldModel } from '../world/types';
import { doorStand, frontPoint, type DoorPoint } from './geometry';
import { Places, type SettlementPlaces } from './places';
import type { Activity, Whereabouts } from './types';

// ---------------------------------------------------------------------------------------------
// Intent: what a person is doing and where, right now
// ---------------------------------------------------------------------------------------------

/** How the agent behaves once at the spot. */
export const Mode = {
  /** Stand or sit at the spot doing the animation. */
  Stay: 0,
  /** Loiter: drift to random points within `radius` of the spot, pausing between. */
  Wander: 1,
  /** Go back and forth between the spot and (bx, bz), carrying `carry` on one leg. */
  Errand: 2,
  /** Walk a loop through the spot, (bx, bz) and back. */
  Patrol: 3,
  /** Run about within `radius` of the spot (children). */
  Play: 4,
  /** Archery practice: draw, aim, loose, repeat. */
  Shoot: 5,
  /** Work the spot, shifting slowly along the strip direction `yaw`. */
  Furrow: 6,
} as const;
export type ModeId = (typeof Mode)[keyof typeof Mode];

export interface Intent {
  activity: Activity;
  label: string;
  settlement: number;
  /** Building to enter (when indoors) or stand at; −1 outdoors. */
  building: number;
  indoors: boolean;
  /** Not in this settlement now (visitors who went home). */
  away: boolean;
  x: number;
  z: number;
  yaw: number;
  anim: AnimState;
  main: HeldItem;
  off: HeldItem;
  carry: CarryLook;
  back: BackLook;
  /** Seat height when anim is 'sit'. */
  seat: number;
  mode: ModeId;
  radius: number;
  bx: number;
  bz: number;
  /** People with the same group key at the same place stand facing a common centre and talk. */
  group: number;
  /** Absolute days this stretch of the day starts and ends. */
  from: number;
  until: number;
  /** Where the person was before (travel interpolation) and how far along they are (1 = arrived). */
  prevX: number;
  prevZ: number;
  travel: number;
  /** Where the person enters/leaves the settlement when `away` flips (a gate). */
  exitX: number;
  exitZ: number;
}

export function newIntent(): Intent {
  return {
    activity: 'idle', label: '', settlement: -1, building: -1, indoors: false, away: false, x: 0, z: 0, yaw: 0,
    anim: 'idle', main: 'none', off: 'none', carry: 'none', back: 'none', seat: 0, mode: Mode.Stay, radius: 0, bx: 0, bz: 0,
    group: -1, from: 0, until: 0, prevX: 0, prevZ: 0, travel: 1, exitX: NaN, exitZ: NaN,
  };
}

function reset(o: Intent): void {
  o.activity = 'idle'; o.label = ''; o.building = -1; o.indoors = false; o.away = false; o.yaw = 0;
  o.anim = 'idle'; o.main = 'none'; o.off = 'none'; o.carry = 'none'; o.back = 'none'; o.seat = 0; o.mode = Mode.Stay;
  o.radius = 0; o.bx = 0; o.bz = 0; o.group = -1; o.travel = 1; o.exitX = NaN; o.exitZ = NaN;
}

// ---------------------------------------------------------------------------------------------
// Work templates
// ---------------------------------------------------------------------------------------------

type Where =
  | 'strip' | 'door' | 'home' | 'pasture' | 'wood' | 'market' | 'church' | 'manor' | 'guard' | 'drill' | 'walls'
  | 'well' | 'green' | 'cloister' | 'garden' | 'stroll' | 'errand' | 'road';

interface Work {
  where: Where;
  /** For 'door': the workplace kinds in order of preference. */
  kinds?: readonly BuildingKind[];
  anim: AnimState;
  main?: HeldItem;
  off?: HeldItem;
  carry?: CarryLook;
  label: string;
  /** Works under cover when it is wet. */
  shelter?: boolean;
}

const W = (where: Where, anim: AnimState, label: string, o: Partial<Work> = {}): Work => ({ where, anim, label, ...o });

const WORK: Partial<Record<CareerId, Work>> = {
  farmer: W('strip', 'work_hoe', 'Working the strips', { main: 'hoe' }),
  cottar: W('strip', 'work_hoe', 'Working the strips', { main: 'hoe' }),
  labourer: W('strip', 'work_hoe', 'Labouring', { main: 'hoe' }),
  yeoman: W('strip', 'work_hoe', 'Seeing to his land', { main: 'hoe' }),
  woodward: W('wood', 'work_axe', 'Felling wood', { main: 'axe' }),
  shepherd: W('pasture', 'idle', 'Minding the flock', { main: 'crook' }),
  swineherd: W('pasture', 'idle', 'Minding the pigs', { main: 'staff' }),
  alewife: W('door', 'work_stir', 'Brewing ale', { kinds: ['brewhouse', 'alehouse', 'tavern'], main: 'ladle', shelter: true }),
  tavern_keeper: W('door', 'work_lift', 'Keeping the tavern', { kinds: ['tavern', 'alehouse'], carry: 'barrel', shelter: true }),
  cook: W('door', 'work_stir', 'Cooking', { kinds: ['manor_house', 'great_hall', 'tavern', 'alehouse'], main: 'ladle', shelter: true }),
  smith: W('door', 'work_hammer', 'At the forge', { kinds: ['smithy'], main: 'hammer', off: 'tongs' }),
  carpenter: W('door', 'work_saw', 'Sawing timber', { kinds: ['carpenter', 'sawpit'], main: 'saw', shelter: true }),
  mason: W('church', 'work_pick', 'Dressing stone', { main: 'chisel' }),
  tanner: W('door', 'work_stir', 'Tanning hides', { kinds: ['tannery'], main: 'staff' }),
  weaver: W('door', 'work_spin', 'Weaving', { kinds: ['weaver'], main: 'distaff', shelter: true }),
  tailor: W('home', 'work_spin', 'Sewing', { main: 'distaff', shelter: true }),
  baker: W('door', 'work_knead', 'Baking', { kinds: ['bakehouse'], shelter: true }),
  miller: W('door', 'work_lift', 'At the mill', { kinds: ['watermill', 'windmill', 'fulling_mill'], carry: 'sack' }),
  butcher: W('home', 'work_hammer', 'Butchering', { main: 'dagger', shelter: true }),
  cooper: W('door', 'work_hammer', 'Coopering', { kinds: ['carpenter', 'sawpit'], main: 'hammer', shelter: true }),
  cobbler: W('home', 'work_hammer', 'Mending shoes', { main: 'hammer', shelter: true }),
  potter: W('home', 'work_knead', 'Throwing pots', { shelter: true }),
  fuller: W('door', 'work_lift', 'Fulling cloth', { kinds: ['fulling_mill', 'watermill', 'weaver'], carry: 'bundle_wood' }),
  chandler: W('home', 'work_stir', 'Dipping candles', { main: 'ladle', shelter: true }),
  wheelwright: W('door', 'work_saw', 'Making wheels', { kinds: ['carpenter', 'sawpit'], main: 'saw', shelter: true }),
  saddler: W('home', 'work_hammer', 'Working leather', { main: 'hammer', shelter: true }),
  fisher: W('road', 'idle', 'Fishing', { main: 'staff' }),
  merchant: W('market', 'idle', 'Trading', { shelter: false }),
  peddler: W('market', 'carry_walk', 'Peddling', { carry: 'basket' }),
  shopkeeper: W('market', 'idle', 'Minding the shop', { shelter: false }),
  soldier: W('guard', 'idle', 'On guard', { main: 'spear' }),
  archer: W('drill', 'draw_bow', 'Archery practice', { main: 'longbow' }),
  man_at_arms: W('guard', 'idle', 'On guard', { main: 'spear', off: 'shield_heater' }),
  sergeant: W('walls', 'walk', 'Walking the walls', { main: 'sword' }),
  squire: W('drill', 'attack_slash', 'Drilling', { main: 'sword' }),
  page: W('errand', 'carry_walk', 'Running errands', { carry: 'basket' }),
  knight: W('manor', 'idle', 'About the manor', { main: 'none' }),
  lord: W('manor', 'idle', 'About the manor'),
  lady: W('manor', 'idle', 'In the garden'),
  noble: W('manor', 'idle', 'About the house'),
  priest: W('church', 'idle', 'At the church', { main: 'book' }),
  monk: W('cloister', 'work_hoe', 'In the cloister garth', { main: 'hoe' }),
  nun: W('cloister', 'work_hoe', 'In the cloister garth', { main: 'hoe' }),
  prior: W('cloister', 'idle', 'Overseeing the house', { main: 'book' }),
  abbot: W('cloister', 'idle', 'Overseeing the house', { main: 'book' }),
  bishop: W('church', 'idle', 'At the cathedral', { main: 'book' }),
  clerk: W('manor', 'idle', 'Keeping accounts', { main: 'book' }),
  servant: W('errand', 'carry_walk', 'Serving the household', { carry: 'bucket' }),
  steward: W('stroll', 'idle', 'Going about the manor', { main: 'book' }),
  bailiff: W('stroll', 'idle', 'Inspecting the fields', { main: 'staff' }),
  healer: W('garden', 'work_dig', 'Gathering herbs', { main: 'spade', shelter: true }),
  midwife: W('garden', 'work_dig', 'Gathering herbs', { main: 'spade', shelter: true }),
  beggar: W('church', 'sit', 'Begging at the church'),
};

const MONASTIC: ReadonlySet<CareerId> = new Set<CareerId>(['monk', 'nun', 'prior', 'abbot']);
const MARKET_SELLERS: ReadonlySet<CareerId> = new Set<CareerId>([
  'merchant', 'shopkeeper', 'peddler', 'baker', 'butcher', 'weaver', 'tailor', 'cobbler', 'potter', 'chandler', 'cooper', 'tanner', 'saddler',
]);
const ARMS: ReadonlySet<CareerId> = new Set<CareerId>(['soldier', 'archer', 'man_at_arms', 'sergeant']);

// ---------------------------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------------------------

export interface ScheduleDeps {
  state: GameState;
  world: WorldModel;
  places: Places;
  economy: EconomyApi;
}

interface DayTimes {
  sr: number; ss: number;
  wake: number; chore: number; mealA: number; mealB: number; workEnd: number; bed: number;
  massA: number; massB: number; gatherA: number; afterB: number;
}

const TRAVEL_MIN = 0.012;
const TRAVEL_MAX = 0.07;
/** Day fraction a stroll of one metre takes on the macro clock (a person "covers" ~1000 m/day). */
const TRAVEL_PER_METRE = 1 / 2200;

export class Schedule {
  private readonly state: GameState;
  private readonly world: WorldModel;
  private readonly places: Places;
  private readonly economy: EconomyApi;
  private readonly times: DayTimes = { sr: 0, ss: 0, wake: 0, chore: 0, mealA: 0, mealB: 0, workEnd: 0, bed: 0, massA: 0, massB: 0, gatherA: 0, afterB: 0 };
  private readonly wx: WeatherSample = { cloud: 0, rain: 0, snow: 0, fog: 0, windX: 0, windZ: 0, temperature: 10 };
  private wxKey = NaN;
  private readonly spotCache = new Map<number, { day: number; spot: WorkSpot | null }>();
  private readonly door: DoorPoint = { x: 0, z: 0, yaw: 0 };
  private readonly door2: DoorPoint = { x: 0, z: 0, yaw: 0 };
  private readonly prev: Intent = newIntent();
  private readonly pt: P2 = { x: 0, z: 0 };

  constructor(deps: ScheduleDeps) {
    this.state = deps.state; this.world = deps.world; this.places = deps.places; this.economy = deps.economy;
  }

  // ---- public ----

  whereabouts(p: Person, absDay: number, scratch: Intent = this.scratch2): Whereabouts {
    this.intent(p, absDay, scratch);
    const travelling = scratch.travel < 1;
    return {
      activity: travelling ? 'walk' : scratch.activity,
      settlement: scratch.settlement,
      building: travelling ? -1 : scratch.building,
      indoors: !travelling && (scratch.indoors || scratch.away),
      x: travelling ? scratch.prevX + (scratch.x - scratch.prevX) * scratch.travel : scratch.x,
      z: travelling ? scratch.prevZ + (scratch.z - scratch.prevZ) * scratch.travel : scratch.z,
      label: travelling ? 'On the way' : scratch.label,
    };
  }
  private readonly scratch2: Intent = newIntent();

  /** Fills `out` with what person `p` is doing at `absDay`. */
  intent(p: Person, absDay: number, out: Intent): Intent {
    this.plan(p, absDay, out, 0);
    return out;
  }

  /** Forces the weather every schedule sees (tests, dev pages); null returns to the simulated weather. */
  forceWeather(w: { rain?: number; snow?: number; temperature?: number } | null): void {
    this.forced = w ? { rain: w.rain ?? 0, snow: w.snow ?? 0, temperature: w.temperature ?? 12 } : null;
    this.wxKey = NaN;
  }
  private forced: { rain: number; snow: number; temperature: number } | null = null;

  /** Weather at a time (cached to ~15 minutes of game time). */
  weather(absDay: number): WeatherSample {
    const key = Math.floor(absDay * 96);
    if (key !== this.wxKey) {
      this.wxKey = key;
      sampleWeather(this.state.seed, key / 96, this.wx);
      if (this.forced) { this.wx.rain = this.forced.rain; this.wx.snow = this.forced.snow; this.wx.temperature = this.forced.temperature; }
    }
    return this.wx;
  }

  // ---- core ----

  private plan(p: Person, absDay: number, o: Intent, depth: number): void {
    reset(o);
    const day = Math.floor(absDay);
    const f = absDay - day;
    const home = this.homeOf(p);
    const sp = this.places.of(p.settlement);
    o.settlement = p.settlement;
    // default position: the home door
    this.homeDoor(p, home, sp, o);
    const age = ageYears(p, absDay);
    const T = this.dayTimes(p, absDay, day);
    const date = toDate(absDay);
    const holy = isHolyDay(day);
    const wx = this.weather(absDay);
    const wet = Math.max(wx.rain, wx.snow * 0.85);
    const cold = wx.temperature < -1.5;

    this.fromUntil(o, day, 0, 1);
    const marketTown = this.marketGoer(p, day, age);
    const ownMarket = !!sp && sp.settlement.market && isMarketDay(day, p.settlement);
    if (f < T.wake || f >= T.bed) {
      // ---- night: asleep (or the watch) ----
      this.sleep(p, o, day, f, T, age, sp, home);
    } else if (this.bedridden(p, age)) {
      this.fromUntil(o, day, T.wake, T.bed);
      this.atHome(o, home, true, 'sleep', 'Ill in bed');
    } else if (age < 3) {
      this.fromUntil(o, day, T.wake, T.bed);
      this.atHome(o, home, true, 'home', 'Indoors with the family');
    } else if (marketTown >= 0 && this.visitor(p, o, day, f, T, marketTown, wet, home, sp)) {
      // ---- a trip to the market town ----
    } else if (holy && age >= 3) {
      this.holyDay(p, o, day, f, T, age, wet, home, sp);
    } else if (age < 12) {
      this.child(p, o, day, f, T, age, wet, home, sp);
    } else if (age >= 62) {
      this.elder(p, o, day, f, T, age, wet, home, sp);
    } else {
      this.workDay(p, o, day, f, T, age, wet, cold, home, sp, ownMarket);
    }
    o.until = Math.max(o.until, absDay + 1e-6);
    // ---- travel: people take a while to get from one stretch of the day to the next ----
    o.travel = 1;
    if (depth === 0) {
      const since = absDay - o.from;
      if (since >= 0 && since < TRAVEL_MAX && !o.away) {
        const pr = this.prevIntent(p, o.from - 1e-4);
        // arriving from outside: the entry point named by this stretch (a gate), else where the person left
        const px = pr.away ? (o.exitX === o.exitX ? o.exitX : pr.exitX) : pr.x;
        const pz = pr.away ? (o.exitZ === o.exitZ ? o.exitZ : pr.exitZ) : pr.z;
        const dist = Math.hypot(o.x - px, o.z - pz);
        if (dist > 3 && (pr.away || pr.settlement === o.settlement)) {
          const win = Math.min(TRAVEL_MAX, Math.max(TRAVEL_MIN, dist * TRAVEL_PER_METRE)) * (0.8 + 0.4 * hash01(p.id, 77));
          const t = since / win;
          if (t < 1) { o.prevX = px; o.prevZ = pz; o.travel = t; }
        }
      }
    }
  }

  private prevIntent(p: Person, absDay: number): Intent {
    this.plan(p, absDay, this.prev, 1);
    return this.prev;
  }

  /** Position of someone in the middle of a journey (x, z); only meaningful while `travel` < 1. */
  travelPoint(o: Intent, out: P2): P2 {
    out.x = o.prevX + (o.x - o.prevX) * o.travel;
    out.z = o.prevZ + (o.z - o.prevZ) * o.travel;
    return out;
  }

  // ---- trips to the market town ----

  /** Cheap test used by the zone's scan: might this person walk to market today? */
  maybeMarketGoer(p: Person, day: number): boolean {
    return this.marketGoer(p, day, ageYears(p, day)) >= 0;
  }

  /** Where a shepherd's flock grazes (the shepherd stands in the middle of it); null without pasture. */
  pastureSpot(p: Person, out: P2): P2 | null {
    const sp = this.places.of(p.settlement);
    if (!sp || sp.pastures.length === 0) return null;
    const par = sp.pastures[Math.floor(hash01(p.id, 9) * sp.pastures.length) % sp.pastures.length];
    return polyPoint(par.poly, hash01(p.id, 10), 0.4 + 0.3 * hash01(p.id, 11), out);
  }

  /** The market town this person walks to today, or −1. About one adult in six from the villages around goes. */
  private marketGoer(p: Person, day: number, age: number): number {
    if (age < 14 || age >= 62 || p.estate === 'clergy' || MONASTIC.has(p.career) || ARMS.has(p.career)) return -1;
    const town = this.places.marketTownOf(p.settlement);
    if (town < 0 || town === p.settlement) return -1;
    if (!isMarketDay(day, town)) return -1;
    return hash01(p.id, day * 13 + 7) < 0.16 ? town : -1;
  }

  /** Market visitor's day: leave home after the chores, trade from mid-morning, walk back at noon. */
  private visitor(p: Person, o: Intent, day: number, f: number, T: DayTimes, town: number, wet: number, home: BuildingState | null, sp: SettlementPlaces | null): boolean {
    void home;
    const a = 0.3 + 0.06 * hash01(p.id, 61), b = 0.6 + 0.05 * hash01(p.id, 62);
    const back = b + 0.14;
    if (f < T.chore || f >= back) return false;
    const hs = this.places.settlement(p.settlement), ts = this.places.settlement(town);
    if (!hs || !ts || !sp) return false;
    // the edge of the home village on the side facing the town, and the town gate nearest the village
    const dx = ts.x - hs.x, dz = ts.z - hs.z, dl = Math.hypot(dx, dz) || 1;
    const edgeX = hs.x + (dx / dl) * hs.radius * 0.95, edgeZ = hs.z + (dz / dl) * hs.radius * 0.95;
    this.places.nearestGate(town, hs.x, hs.z, this.pt);
    const gateX = this.pt.x, gateZ = this.pt.z;
    if (f < a) {
      this.fromUntil(o, day, T.chore, a);
      o.away = true; o.settlement = p.settlement; o.x = edgeX; o.z = edgeZ; o.exitX = edgeX; o.exitZ = edgeZ;
      o.activity = 'travel'; o.label = 'Off to market'; o.anim = 'carry_walk'; o.carry = 'basket';
      return true;
    }
    if (f < b) {
      this.fromUntil(o, day, a, b);
      const tp = this.places.of(town);
      if (!tp) return false;
      o.settlement = town; o.exitX = gateX; o.exitZ = gateZ;
      const seller = hash01(p.id, 63) < 0.6;
      this.marketSpot(p, o, tp, seller, day, f < 0.45);
      if (wet > 0.7) { o.mode = Mode.Wander; }
      return true;
    }
    if (f < b + 0.03) {
      this.fromUntil(o, day, b, b + 0.03);
      o.away = true; o.settlement = town; o.x = gateX; o.z = gateZ; o.exitX = gateX; o.exitZ = gateZ;
      o.activity = 'travel'; o.label = 'Heading home from market'; o.anim = 'carry_walk'; o.carry = 'basket';
      return true;
    }
    this.fromUntil(o, day, b + 0.03, back);
    o.away = true; o.settlement = p.settlement; o.x = edgeX; o.z = edgeZ; o.exitX = edgeX; o.exitZ = edgeZ;
    o.activity = 'travel'; o.label = 'On the road home'; o.anim = 'walk';
    return true;
  }

  // ---- times ----

  private dayTimes(p: Person, absDay: number, day: number): DayTimes {
    const T = this.times;
    const season = toDate(day + 0.5).season as Season;
    const { sunrise, sunset } = daylight(season);
    const j = (k: number): number => hash01(p.id, 100 + k);
    T.sr = sunrise; T.ss = sunset;
    T.wake = sunrise - 0.012 + 0.02 * j(1);
    T.chore = T.wake + 0.035;
    T.mealA = 0.47 + 0.04 * j(2);
    T.mealB = T.mealA + 0.04 + 0.02 * j(6);
    T.workEnd = sunset - 0.085 + 0.025 * j(3);
    T.bed = Math.min(0.985, sunset + 0.05 + 0.05 * j(4));
    T.massA = sunrise + 0.085 + 0.012 * hash01(p.settlement, 5);
    T.massB = T.massA + 0.12;
    // everyone leaves for church and for the churchyard at their own moment, so no one moves in a block
    T.gatherA = Math.max(T.chore + 0.01, T.massA - 0.07 - 0.1 * j(8));
    T.afterB = T.massB + 0.025 + 0.05 * j(9);
    void absDay;
    return T;
  }

  private fromUntil(o: Intent, day: number, a: number, b: number): void { o.from = day + a; o.until = day + b; }

  // ---- places ----

  private homeOf(p: Person): BuildingState | null {
    const hh = this.state.households.get(p.household);
    return hh ? this.state.buildings.get(hh.home) ?? null : null;
  }

  private homeDoor(p: Person, home: BuildingState | null, sp: SettlementPlaces | null, o: Intent): void {
    if (home) {
      doorStand(home, this.door);
      o.x = this.door.x; o.z = this.door.z; o.yaw = this.door.yaw; o.building = home.id;
    } else if (sp) {
      const a = hash01(p.id, 3) * Math.PI * 2, r = sp.settlement.radius * 0.5 * hash01(p.id, 4);
      o.x = sp.settlement.x + Math.cos(a) * r; o.z = sp.settlement.z + Math.sin(a) * r; o.building = -1;
    }
  }

  /** Stand somewhere in front of the home (outdoors), spread by a per-person key. */
  private homeYard(p: Person, home: BuildingState | null, sp: SettlementPlaces | null, o: Intent, salt: number): void {
    if (!home) { this.homeDoor(p, home, sp, o); return; }
    const lx = (hash01(p.id, salt) - 0.5) * (BUILDINGS[home.kind].w + 3);
    const depth = 1.8 + 3.2 * hash01(p.id, salt + 1);
    frontPoint(home, lx, BUILDINGS[home.kind].d / 2 + depth, this.door2, 0);
    o.x = this.door2.x; o.z = this.door2.z; o.yaw = home.rot + (hash01(p.id, salt + 2) - 0.5) * 2.2; o.building = -1;
  }

  private atHome(o: Intent, home: BuildingState | null, indoors: boolean, activity: Activity, label: string): void {
    o.activity = activity; o.label = label; o.indoors = indoors && !!home;
    if (home) o.building = home.id;
  }

  // ---- states of the day ----

  private sleep(p: Person, o: Intent, day: number, f: number, T: DayTimes, age: number, sp: SettlementPlaces | null, home: BuildingState | null): void {
    if (f >= T.bed) this.fromUntil(o, day, T.bed, 1 + T.wake); else this.fromUntil(o, day, T.wake - 1, T.wake);
    // the night watch: a quarter of the soldiers of a garrison or walled town walk the streets with a torch
    const arms = ARMS.has(p.career) && sp && (sp.settlement.kind === 'castle' || sp.settlement.kind === 'town' || sp.settlement.kind === 'city');
    const watchDay = f >= T.bed ? day : day - 1;
    if (arms && hash01(p.id, watchDay * 5 + 11) < 0.28 && age >= 16) {
      this.watch(p, o, sp!, home);
      return;
    }
    // revellers: a few men linger at the alehouse after the others have gone to bed
    if (f >= T.bed && f < T.bed + 0.03 && age >= 17 && p.sex === 'm' && hash01(p.id, day * 3 + 17) < 0.045 && sp && sp.alehouses.length) {
      const ale = sp.alehouses[Math.floor(hash01(p.id, 18) * sp.alehouses.length) % sp.alehouses.length];
      this.fromUntil(o, day, T.bed, T.bed + 0.03);
      this.alehouseSpot(p, ale, o, sp, true);
      o.activity = 'alehouse'; o.label = 'Late at the alehouse';
      return;
    }
    this.atHome(o, home, true, 'sleep', 'Asleep at home');
  }

  private watch(p: Person, o: Intent, sp: SettlementPlaces, home: BuildingState | null): void {
    o.activity = 'patrol'; o.label = 'Walking the watch';
    o.anim = 'walk'; o.main = 'torch'; o.mode = Mode.Patrol;
    o.indoors = false;
    const gates = sp.gates();
    const a = hash01(p.id, 33) * Math.PI * 2;
    const s = sp.settlement;
    const r = Math.min(s.radius * 0.5, 60) * (0.4 + 0.6 * hash01(p.id, 34));
    o.x = s.x + Math.cos(a) * r; o.z = s.z + Math.sin(a) * r;
    if (gates.length) {
      const g = gates[Math.floor(hash01(p.id, 35) * gates.length) % gates.length];
      o.bx = g.x; o.bz = g.z;
    } else { o.bx = s.x + Math.cos(a + 2) * r; o.bz = s.z + Math.sin(a + 2) * r; }
    o.building = -1;
    void home;
  }

  private bedridden(p: Person, age: number): boolean {
    const cs = p.health.conditions;
    if (cs.length === 0) return false;
    for (const c of cs) {
      if (c.id === 'fever' || c.id === 'flux' || c.id === 'plague' || c.id === 'childbed') return true;
      if ((c.id === 'consumption' || c.id === 'wasting' || c.id === 'injury') && p.health.hp < 0.55) return true;
      if (c.id === 'frailty' && age > 55 && p.health.hp < 0.5) return true;
    }
    return false;
  }

  // ---- children ----

  private child(p: Person, o: Intent, day: number, f: number, T: DayTimes, age: number, wet: number, home: BuildingState | null, sp: SettlementPlaces | null): void {
    const j = (k: number): number => hash01(p.id, 200 + k);
    // very young children are mostly indoors; they play at the door in fine weather
    const outdoors = wet < 0.35 && (age >= 6 || j(day % 7) < 0.55);
    if (f < T.chore) {
      this.fromUntil(o, day, T.wake, T.chore);
      this.homeYard(p, home, sp, o, 10);
      o.activity = 'home'; o.label = 'Fetching water'; o.anim = 'carry_walk'; o.carry = 'bucket'; o.mode = Mode.Errand;
      const well = sp?.first('well');
      if (well) { doorStand(well, this.door2, 0.4); o.bx = this.door2.x; o.bz = this.door2.z; } else { o.bx = o.x + 12; o.bz = o.z; }
      o.indoors = !outdoors && !!home;
      return;
    }
    const mealing = f >= T.mealA && f < T.mealB;
    if (mealing) {
      this.fromUntil(o, day, T.mealA, T.mealB);
      this.atHome(o, home, true, 'eat', 'At the family table');
      return;
    }
    if (f >= T.workEnd) {
      this.fromUntil(o, day, T.workEnd, T.bed);
      if (!outdoors || j(day % 5 + 40) < 0.3) { this.atHome(o, home, true, 'home', 'Indoors by the fire'); return; }
      this.playSpot(p, o, home, sp, 20, false);
      return;
    }
    const morning = f < T.mealA;
    this.fromUntil(o, day, morning ? T.chore : T.mealB, morning ? T.mealA : T.workEnd);
    // lessons with the parish priest for a few of the better-off boys (and the odd girl)
    const school = age >= 7 && sp?.church && (p.rankTier >= 2 || j(1) < 0.1) && j(2) < (p.sex === 'm' ? 0.28 : 0.1) && morning;
    if (school && sp?.church) {
      doorStand(sp.church, this.door2, 1.2);
      const k = Math.floor(hash01(p.id, 60) * 6);
      o.x = this.door2.x + Math.cos(this.door2.yaw) * (k - 2.5) * 0.9;
      o.z = this.door2.z - Math.sin(this.door2.yaw) * (k - 2.5) * 0.9;
      o.yaw = this.door2.yaw + Math.PI; o.building = sp.church.id; o.indoors = wet > 0.4;
      o.activity = 'school'; o.label = 'At lessons'; o.anim = 'sit'; o.seat = 0; o.main = 'none';
      return;
    }
    // help: the children of farmers and herders mind the animals or carry for their parents
    const parent = this.state.persons.get(p.father) ?? this.state.persons.get(p.mother);
    const pc = parent ? WORK[parent.career] : undefined;
    if (age >= 8 && pc && (pc.where === 'strip' || pc.where === 'pasture') && j(day % 11 + 5) < 0.55 && wet < 0.5) {
      const w = this.workPlace(parent!, day, f, home, sp, o, pc);
      if (w) {
        if (pc.where === 'pasture') {
          o.activity = 'work'; o.label = 'Minding the animals'; o.anim = 'idle'; o.main = 'crook'; o.mode = Mode.Wander; o.radius = 5;
        } else {
          o.activity = 'work'; o.label = 'Helping in the field'; o.anim = 'work_lift'; o.carry = 'bucket'; o.main = 'none'; o.mode = Mode.Stay;
          o.x += 1.4; o.z += 0.6;
        }
        o.group = -1;
        return;
      }
    }
    // chores near home, or play
    if (age >= 8 && j(day % 9 + 15) < 0.4 && outdoors) {
      this.homeYard(p, home, sp, o, 14);
      o.activity = 'home'; o.label = 'Fetching and carrying'; o.anim = 'carry_walk'; o.carry = 'bucket'; o.mode = Mode.Errand;
      const well = sp?.first('well');
      if (well) { doorStand(well, this.door2, 0.4); o.bx = this.door2.x; o.bz = this.door2.z; } else { o.bx = o.x - 14; o.bz = o.z + 4; }
      return;
    }
    if (!outdoors) { this.atHome(o, home, true, 'home', 'Indoors'); return; }
    this.playSpot(p, o, home, sp, 24, false);
  }

  private playSpot(p: Person, o: Intent, home: BuildingState | null, sp: SettlementPlaces | null, salt: number, green: boolean): void {
    o.activity = 'play'; o.label = 'Playing'; o.anim = 'run'; o.mode = Mode.Play;
    o.indoors = false;
    if (green && sp) {
      o.x = sp.green.x + (hash01(p.id, salt) - 0.5) * 16; o.z = sp.green.z + (hash01(p.id, salt + 1) - 0.5) * 16; o.building = -1; o.radius = 12;
    } else {
      this.homeYard(p, home, sp, o, salt); o.radius = 9;
    }
  }

  // ---- elders ----

  private elder(p: Person, o: Intent, day: number, f: number, T: DayTimes, age: number, wet: number, home: BuildingState | null, sp: SettlementPlaces | null): void {
    void age;
    const j = (k: number): number => hash01(p.id, 300 + k);
    if (f < T.chore + 0.02) { this.fromUntil(o, day, T.wake, T.chore + 0.02); this.atHome(o, home, true, 'home', 'Rising slowly'); return; }
    if (f >= T.mealA && f < T.mealB) { this.fromUntil(o, day, T.mealA, T.mealB); this.atHome(o, home, true, 'eat', 'At the family table'); return; }
    const mid = T.mealB + 0.2;
    const seg = f < T.mealA ? 0 : f < mid ? 1 : 2;
    const bounds: Array<[number, number]> = [[T.chore + 0.02, T.mealA], [T.mealB, mid], [mid, T.bed]];
    this.fromUntil(o, day, bounds[seg][0], bounds[seg][1]);
    if (wet > 0.35 || j(day % 6 + seg * 3) < 0.25) { this.atHome(o, home, true, 'home', 'Indoors by the fire'); return; }
    const choice = j(day % 5 + seg * 7);
    if (choice < 0.55) {
      // sit at the door
      this.homeYard(p, home, sp, o, 50 + seg);
      o.activity = 'home'; o.label = 'Sitting in the sun'; o.anim = 'sit'; o.seat = 0.4; o.yaw = home ? home.rot : 0;
    } else if (choice < 0.8 && sp) {
      // gossip on the green
      o.x = sp.green.x + (hash01(p.id, 55) - 0.5) * 10; o.z = sp.green.z + (hash01(p.id, 56) - 0.5) * 10; o.building = -1;
      o.activity = 'talk'; o.label = 'Chatting on the green'; o.anim = 'talk';
      o.group = Math.floor(hash01(p.id, day * 3 + seg) * 4) + 1000 * seg;
      o.mode = Mode.Wander; o.radius = 0.6;
    } else {
      this.homeYard(p, home, sp, o, 60 + seg);
      o.activity = 'home'; o.label = 'Pottering in the garden'; o.anim = 'work_dig'; o.main = 'spade';
    }
  }

  // ---- a working day ----

  private workDay(
    p: Person, o: Intent, day: number, f: number, T: DayTimes, age: number, wet: number, cold: boolean,
    home: BuildingState | null, sp: SettlementPlaces | null, marketDay: boolean,
  ): void {
    const j = (k: number): number => hash01(p.id, 400 + k);
    const c = p.career;
    // morning chores at the door
    if (f < T.chore) {
      this.fromUntil(o, day, T.wake, T.chore);
      this.choreAtHome(p, o, home, sp, wet, day);
      return;
    }
    // monks and nuns keep the hours
    if (MONASTIC.has(c) || (p.estate === 'clergy' && sp && (sp.settlement.kind === 'abbey' || sp.settlement.kind === 'priory' || sp.settlement.kind === 'nunnery'))) {
      this.monastic(p, o, day, f, T, wet, sp, home);
      return;
    }
    if (f >= T.mealA && f < T.mealB) {
      this.fromUntil(o, day, T.mealA, T.mealB);
      this.meal(p, o, day, home, sp, wet, marketDay);
      return;
    }
    if (f >= T.workEnd) {
      this.fromUntil(o, day, T.workEnd, T.bed);
      this.evening(p, o, day, age, wet, cold, home, sp);
      return;
    }
    const morning = f < T.mealA;
    this.fromUntil(o, day, morning ? T.chore : T.mealB, morning ? T.mealA : T.workEnd);
    // a youth below working age but past childhood helps at home
    this.working(p, o, day, f, T, age, wet, home, sp, marketDay, morning);
  }

  private choreAtHome(p: Person, o: Intent, home: BuildingState | null, sp: SettlementPlaces | null, wet: number, day: number): void {
    o.activity = 'home';
    if (wet > 0.45 || !home) { this.atHome(o, home, true, 'home', 'Stirring the fire'); return; }
    this.homeYard(p, home, sp, o, 70);
    const r = hash01(p.id, day % 9 + 80);
    if (p.sex === 'f') {
      if (r < 0.5) { o.label = 'Fetching water'; o.anim = 'carry_walk'; o.carry = 'bucket'; o.mode = Mode.Errand; const well = sp?.first('well'); if (well) { doorStand(well, this.door2, 0.4); o.bx = this.door2.x; o.bz = this.door2.z; } else { o.bx = o.x + 10; o.bz = o.z; } }
      else if (r < 0.8) { o.label = 'Milking'; o.anim = 'work_milk'; o.carry = 'none'; }
      else { o.label = 'Feeding the hens'; o.anim = 'work_lift'; o.carry = 'basket'; }
    } else if (r < 0.5) { o.label = 'Chopping wood'; o.anim = 'work_axe'; o.main = 'axe'; }
    else if (r < 0.8) { o.label = 'Fetching water'; o.anim = 'carry_walk'; o.carry = 'bucket'; o.mode = Mode.Errand; const well = sp?.first('well'); if (well) { doorStand(well, this.door2, 0.4); o.bx = this.door2.x; o.bz = this.door2.z; } else { o.bx = o.x - 10; o.bz = o.z; } }
    else { o.label = 'Mending the fence'; o.anim = 'work_hammer'; o.main = 'hammer'; }
  }

  private meal(p: Person, o: Intent, day: number, home: BuildingState | null, sp: SettlementPlaces | null, wet: number, marketDay: boolean): void {
    // The day is a minute long and a walk across the village takes longer than that, so nobody goes home for dinner
    // unless home is (nearly) where they work: a packed meal at the workplace for the rest (as field workers had)
    const wp = this.workTemplate(p);
    if (wp && wet < 0.6 && home) {
      this.working(p, o, day, 0.5, this.times, 30, wet, home, sp, marketDay, true);
      if (!o.indoors && !o.away && o.building !== home.id) {
        const dh = Math.hypot(o.x - home.x, o.z - home.z);
        if (dh > 40) {
          o.activity = 'eat'; o.label = 'Eating a packed meal'; o.anim = 'eat'; o.main = 'none'; o.off = 'none'; o.carry = 'none'; o.mode = Mode.Stay;
          o.group = -1; o.x += 0.9; o.z -= 0.5;
          return;
        }
      }
      this.clearLook(o);
      this.homeDoor(p, home, sp, o);
    }
    if (hash01(p.id, day % 5 + 90) < 0.3 && wet < 0.3) {
      this.homeYard(p, home, sp, o, 91);
      o.activity = 'eat'; o.label = 'Eating at the door'; o.anim = 'eat';
      return;
    }
    this.atHome(o, home, true, 'eat', 'At the family table');
  }

  private evening(p: Person, o: Intent, day: number, age: number, wet: number, cold: boolean, home: BuildingState | null, sp: SettlementPlaces | null): void {
    const j = (k: number): number => hash01(p.id, 500 + k);
    // the alehouse takes a share of the grown men and a few women
    if (sp && sp.alehouses.length && age >= 16) {
      const share = p.sex === 'm' ? 0.26 : 0.05;
      if (j(day % 7) < share && p.rankTier <= 4) {
        const ale = sp.alehouses[Math.floor(hash01(p.id, 6) * sp.alehouses.length) % sp.alehouses.length];
        this.alehouseSpot(p, ale, o, sp, wet > 0.45 || cold);
        return;
      }
    }
    if (wet > 0.4 || cold || j(day % 4 + 20) < 0.4) { this.atHome(o, home, true, 'home', 'Indoors by the fire'); return; }
    this.homeYard(p, home, sp, o, 95);
    o.activity = 'home';
    const r = j(day % 3 + 30);
    if (r < 0.45) { o.label = 'Chatting at the door'; o.anim = 'talk'; o.group = (home?.id ?? 0) * 3 + (day % 3); o.mode = Mode.Stay; }
    else if (r < 0.7) { o.label = 'Resting at the door'; o.anim = 'sit'; o.seat = 0.4; o.yaw = home ? home.rot : 0; }
    else { o.label = 'Tending the garden'; o.anim = 'work_dig'; o.main = 'spade'; }
  }

  private alehouseSpot(p: Person, ale: BuildingState, o: Intent, sp: SettlementPlaces, indoors: boolean): void {
    o.activity = 'alehouse'; o.label = 'At the alehouse'; o.building = ale.id;
    if (indoors) {
      doorStand(ale, this.door2);
      o.x = this.door2.x; o.z = this.door2.z; o.yaw = this.door2.yaw; o.indoors = true;
      return;
    }
    const def = BUILDINGS[ale.kind];
    const slot = Math.floor(hash01(p.id, 120) * 9);
    const lx = -def.w / 2 + 1.2 + (slot % 5) * (def.w - 2.4) / 4;
    const depth = 1.2 + Math.floor(slot / 5) * 1.3 + hash01(p.id, 121) * 0.7;
    frontPoint(ale, lx, def.d / 2 + depth, this.door2, 0);
    o.x = this.door2.x; o.z = this.door2.z; o.yaw = ale.rot + (hash01(p.id, 122) - 0.5) * 1.6; o.indoors = false;
    o.main = 'cup';
    if (slot < 3) { o.anim = 'sit'; o.seat = 0.45; o.yaw = ale.rot; o.x -= Math.sin(ale.rot) * 0.55; o.z -= Math.cos(ale.rot) * 0.55; } else { o.anim = 'talk'; o.group = ale.id * 5 + (slot % 3); }
    void sp;
  }

  // ---- the work itself ----

  private workTemplate(p: Person): Work | undefined {
    if (p.career === 'none' || p.career === 'child') return undefined;
    return WORK[p.career];
  }

  private working(
    p: Person, o: Intent, day: number, f: number, T: DayTimes, age: number, wet: number,
    home: BuildingState | null, sp: SettlementPlaces | null, marketDay: boolean, morning: boolean,
  ): void {
    void f; void T;
    const c = p.career;
    // the economy decides when it can
    const spot = this.economySpot(p, day);
    if (spot && spot.kind !== 'none') {
      if (this.applySpot(p, o, spot, day, wet, home, sp)) return;
    }
    // market day: sellers stand at stalls; many others shop
    if (marketDay && sp) {
      const seller = MARKET_SELLERS.has(c) && age >= 14;
      const shopper = !seller && age >= 14 && hash01(p.id, day * 3 + 8) < (p.sex === 'f' ? 0.35 : 0.2);
      if (seller || shopper) {
        this.marketSpot(p, o, sp, seller, day, morning);
        return;
      }
    }
    // householders (no trade of their own): the home and its garden, the well, a visit
    if (c === 'none' || c === 'child') { this.domestic(p, o, day, wet, home, sp, morning); return; }
    const wk = WORK[c];
    if (!wk) { this.domestic(p, o, day, wet, home, sp, morning); return; }
    const w = this.workPlace(p, day, f, home, sp, o, wk);
    if (!w) { this.clearLook(o); this.domestic(p, o, day, wet, home, sp, morning); return; }
    // bad weather sends field workers home for the afternoon and craftsmen under their roofs
    if (wet > 0.5 && wk.where !== 'cloister') {
      const sheltered = wk.shelter === true || wk.where === 'strip' || wk.where === 'pasture' || wk.where === 'wood' || wk.where === 'road';
      const bail = 0.5 + 0.35 * hash01(p.id, 140) + (morning ? 0.25 : 0);
      if (sheltered && wet > bail) {
        if (wk.where === 'door' && o.building >= 0) { o.indoors = true; o.activity = 'work'; o.label = `${wk.label} indoors`; return; }
        this.atHome(o, home, true, 'home', wet > 0.7 ? 'Sheltering from the weather' : 'Working indoors');
        this.homeDoor(p, home, sp, o);
        o.indoors = !!home;
      }
    }
  }

  /** Economy work spot, cached per person per day. */
  private economySpot(p: Person, day: number): WorkSpot | null {
    const hit = this.spotCache.get(p.id);
    if (hit && hit.day === day) return hit.spot;
    let spot: WorkSpot | null = null;
    try { spot = this.economy.workSpot(p.id, day); } catch { spot = null; }
    if (this.spotCache.size > 6000) this.spotCache.clear();
    this.spotCache.set(p.id, { day, spot });
    return spot;
  }

  private applySpot(p: Person, o: Intent, s: WorkSpot, day: number, wet: number, home: BuildingState | null, sp: SettlementPlaces | null): boolean {
    o.activity = s.kind === 'market' ? 'market' : 'work';
    o.label = s.label;
    o.anim = s.anim; o.main = s.mainHand; o.off = s.offHand ?? 'none'; o.carry = s.carry ?? 'none';
    const jx = (hash01(p.id, day + 1) - 0.5) * 1.6, jz = (hash01(p.id, day + 2) - 0.5) * 1.6;
    o.x = s.x + (s.kind === 'building' ? 0 : jx); o.z = s.z + (s.kind === 'building' ? 0 : jz);
    o.building = s.kind === 'building' ? s.id : -1;
    if (s.kind === 'strip') {
      const st = this.world.strips[s.id];
      if (st) this.stripAxis(st, o);
      o.mode = Mode.Furrow;
    }
    if (s.kind === 'building') {
      const b = this.state.buildings.get(s.id);
      if (b) {
        doorStand(b, this.door2, 0.2);
        o.x = this.door2.x; o.z = this.door2.z; o.yaw = this.door2.yaw;
        if (wet > 0.55) o.indoors = true;
      }
    }
    if (s.kind === 'pasture') { o.mode = Mode.Wander; o.radius = 6; }
    void home; void sp;
    return true;
  }

  private stripAxis(st: Strip, o: Intent): void {
    const a = st.poly[0], b = st.poly[1], c = st.poly[3];
    const l1 = Math.hypot(b.x - a.x, b.z - a.z), l2 = Math.hypot(c.x - a.x, c.z - a.z);
    const ex = l1 >= l2 ? b.x - a.x : c.x - a.x, ez = l1 >= l2 ? b.z - a.z : c.z - a.z;
    o.yaw = Math.atan2(ex, ez);
  }

  private clearLook(o: Intent): void {
    o.anim = 'idle'; o.main = 'none'; o.off = 'none'; o.carry = 'none'; o.back = 'none'; o.seat = 0; o.mode = Mode.Stay; o.radius = 0;
    o.group = -1; o.building = -1; o.indoors = false;
  }

  private domestic(p: Person, o: Intent, day: number, wet: number, home: BuildingState | null, sp: SettlementPlaces | null, morning: boolean): void {
    const r = hash01(p.id, day % 8 + 150 + (morning ? 0 : 20));
    o.activity = 'home';
    if (wet > 0.45 || !home) { this.atHome(o, home, true, 'home', 'Spinning by the fire'); return; }
    if (r < 0.2 && sp) {
      // to the well to fetch water and gossip
      const well = sp.first('well');
      if (well) {
        doorStand(well, this.door2, 0.6);
        o.x = this.door2.x + (hash01(p.id, 151) - 0.5) * 3; o.z = this.door2.z + (hash01(p.id, 152) - 0.5) * 3; o.building = -1;
        o.activity = 'talk'; o.label = 'Gossiping at the well'; o.anim = 'talk'; o.carry = 'bucket'; o.group = 500 + (day % 3);
        o.yaw = Math.atan2(well.x - o.x, well.z - o.z);
        return;
      }
    }
    if (r < 0.55) {
      this.homeYard(p, home, sp, o, 160);
      o.label = 'Spinning at the door'; o.anim = p.sex === 'f' ? 'work_spin' : 'work_hammer'; o.main = p.sex === 'f' ? 'distaff' : 'hammer';
      if (p.sex === 'm') o.label = 'Mending tools';
    } else if (r < 0.8) {
      this.homeYard(p, home, sp, o, 165);
      o.label = 'Working in the garden'; o.anim = 'work_dig'; o.main = 'spade';
      const g = this.gardenSpot(home, sp, p);
      if (g) { o.x = g.x; o.z = g.z; }
    } else {
      this.homeYard(p, home, sp, o, 170);
      o.label = 'Feeding the hens'; o.anim = 'work_lift'; o.carry = 'basket';
    }
  }

  private gardenSpot(home: BuildingState, sp: SettlementPlaces | null, p: Person): P2 | null {
    if (!sp) return null;
    let best: P2 | null = null, bd = 400;
    for (const g of sp.gardens) {
      const c = g.poly[0];
      const d = (c.x - home.x) ** 2 + (c.z - home.z) ** 2;
      if (d < bd) { bd = d; best = polyPoint(g.poly, hash01(p.id, 171), 0.5, this.pt); }
    }
    return best;
  }

  private marketSpot(p: Person, o: Intent, sp: SettlementPlaces, seller: boolean, day: number, morning: boolean): void {
    o.activity = 'market';
    const mc = sp.marketCentre;
    o.indoors = false; o.building = -1;
    if (seller && sp.stalls.length) {
      // behind a stall (counter on the +z face; the keeper stands at the back)
      const stall = sp.stalls[Math.floor(hash01(p.id, 180) * sp.stalls.length) % sp.stalls.length];
      frontPoint(stall, 0, -0.35, this.door2, 0);
      o.x = this.door2.x; o.z = this.door2.z; o.yaw = stall.rot;
      o.label = 'Selling at the market'; o.anim = hash01(p.id, day + 181) < 0.5 ? 'idle' : 'talk'; o.main = 'none'; o.carry = 'none';
      if (o.anim === 'talk') o.group = -1;
      return;
    }
    // customers and street sellers drift about the square
    const a = hash01(p.id, 182 + (morning ? 0 : 5)) * Math.PI * 2, r = 2 + 12 * Math.sqrt(hash01(p.id, 183));
    o.x = mc.x + Math.cos(a) * r; o.z = mc.z + Math.sin(a) * r;
    o.label = seller ? 'Selling goods' : 'Shopping at the market';
    o.mode = Mode.Wander; o.radius = 7; o.anim = seller ? 'idle' : 'idle';
    if (seller) { o.carry = 'basket'; o.anim = 'carry_walk'; o.mode = Mode.Wander; }
    else if (hash01(p.id, 184) < 0.5) { o.carry = 'basket'; }
  }

  /**
   * Decides the work place for a career template. Returns false if the person has no usable place.
   * Fills position, animation, items, mode.
   */
  private workPlace(p: Person, day: number, f: number, home: BuildingState | null, sp: SettlementPlaces | null, o: Intent, wk: Work): boolean {
    void f;
    o.activity = 'work'; o.label = wk.label; o.anim = wk.anim; o.main = wk.main ?? 'none'; o.off = wk.off ?? 'none'; o.carry = wk.carry ?? 'none';
    if (!sp) return false;
    const s = sp.settlement;
    const key = p.id;
    switch (wk.where) {
      case 'strip': {
        const hh = p.household;
        // serfs owe week-work: two days in three on the lord's land
        const dow = (day % 4) + 1;
        const owes = p.estate === 'unfree' && p.rankTier <= 1 && dow <= 2;
        let ids: readonly number[] = owes ? sp.stripsOf(0, day) : sp.stripsOf(hh, day);
        if (ids.length === 0) ids = owes ? sp.stripsOf(hh, day) : sp.stripsOf(0, day);
        if (ids.length === 0 && sp.strips.length) ids = sp.strips.map((q) => q.id);
        if (ids.length === 0) {
          // town labourers haul at the warehouse, market or dock; others work the garden
          return this.townLabour(p, o, sp, home);
        }
        const sid = ids[Math.floor(hash01(key, day * 5 + 1) * ids.length) % ids.length];
        const st = this.world.strips[sid];
        const ss = this.state.strips.get(sid);
        if (!st) return false;
        this.stripWork(p, o, st, ss?.state ?? 'growing', day);
        return true;
      }
      case 'door': {
        const b = sp.choose(wk.kinds ?? [], key);
        if (!b) return this.homeWork(p, o, home, sp, wk);
        doorStand(b, this.door2, 0.25);
        o.x = this.door2.x; o.z = this.door2.z; o.yaw = this.door2.yaw; o.building = b.id;
        if (wk.anim === 'work_lift' && wk.carry && wk.carry !== 'none') { o.mode = Mode.Errand; o.bx = o.x + Math.cos(b.rot) * 4; o.bz = o.z - Math.sin(b.rot) * 4; o.carry = wk.carry; }
        // smiths and the like stand a little to one side of the door, in front of the work
        o.x += Math.cos(b.rot) * (hash01(key, 8) - 0.5) * 2.2; o.z -= Math.sin(b.rot) * (hash01(key, 8) - 0.5) * 2.2;
        return true;
      }
      case 'home': return this.homeWork(p, o, home, sp, wk);
      case 'pasture': {
        const ps = this.pastureSpot(p, this.pt);
        if (ps) { o.x = ps.x; o.z = ps.z; }
        else { o.x = s.x + Math.cos(hash01(key, 12) * 6.28) * (s.radius + 40); o.z = s.z + Math.sin(hash01(key, 12) * 6.28) * (s.radius + 40); }
        o.building = -1; o.mode = Mode.Wander; o.radius = 5;
        return true;
      }
      case 'wood': {
        const wl = sp.woodlots.length ? sp.woodlots[Math.floor(hash01(key, 13) * sp.woodlots.length) % sp.woodlots.length] : null;
        if (wl) { polyPoint(wl.poly, hash01(key, 14), 0.3 + 0.4 * hash01(key, 15), this.pt); o.x = this.pt.x; o.z = this.pt.z; }
        else { const a = hash01(key, 16) * 6.28; o.x = s.x + Math.cos(a) * (s.radius + 60); o.z = s.z + Math.sin(a) * (s.radius + 60); }
        o.building = -1; o.yaw = hash01(key, 17) * 6.28;
        return true;
      }
      case 'church': {
        if (!sp.church) return this.homeWork(p, o, home, sp, wk);
        const ch = sp.church;
        if (wk.anim === 'work_pick') {
          // masons work against the church wall
          frontPoint(ch, (hash01(key, 18) - 0.5) * BUILDINGS[ch.kind].w * 0.7, BUILDINGS[ch.kind].d / 2 + 1.1, this.door2, Math.PI);
          o.x = this.door2.x; o.z = this.door2.z; o.yaw = ch.rot + Math.PI; o.building = ch.id;
          return true;
        }
        doorStand(ch, this.door2, 0.3 + hash01(key, 19) * 1.5);
        o.x = this.door2.x + Math.cos(ch.rot) * (hash01(key, 20) - 0.5) * 3; o.z = this.door2.z - Math.sin(ch.rot) * (hash01(key, 20) - 0.5) * 3;
        o.yaw = ch.rot + (hash01(key, 21) - 0.5) * 1.2; o.building = ch.id;
        if (wk.anim === 'sit') { o.seat = 0; }
        if (p.career === 'priest') { o.mode = Mode.Wander; o.radius = 2.5; o.anim = 'idle'; }
        return true;
      }
      case 'manor': {
        const m = sp.lordSeat ?? sp.church;
        if (!m) return this.homeWork(p, o, home, sp, wk);
        doorStand(m, this.door2, 1.0 + hash01(key, 22) * 4);
        o.x = this.door2.x + Math.cos(m.rot) * (hash01(key, 23) - 0.5) * 8; o.z = this.door2.z - Math.sin(m.rot) * (hash01(key, 23) - 0.5) * 8;
        o.yaw = m.rot + (hash01(key, 24) - 0.5) * 2; o.building = m.id; o.mode = Mode.Wander; o.radius = 5;
        if (p.rankTier >= 4 && hash01(key, 25) < 0.5) { o.anim = 'talk'; o.group = 2000 + m.id; o.mode = Mode.Stay; }
        return true;
      }
      case 'guard': {
        const gates = sp.gates();
        const gh = sp.first('gatehouse');
        const post = (hash01(key, 26) < 0.45 && (gh || gates.length)) ? 0 : hash01(key, 26) < 0.75 ? 1 : 2;
        if (post === 0 && (gh || gates.length)) {
          if (gh) { doorStand(gh, this.door2, 0.4); const side = hash01(key, 27) < 0.5 ? -1 : 1; o.x = this.door2.x + Math.cos(gh.rot) * side * 3.3; o.z = this.door2.z - Math.sin(gh.rot) * side * 3.3; o.yaw = gh.rot; o.building = gh.id; }
          else { const g = gates[Math.floor(hash01(key, 28) * gates.length) % gates.length]; o.x = g.x + 2; o.z = g.z + 2; o.yaw = hash01(key, 29) * 6.28; }
          o.label = 'Guarding the gate'; o.activity = 'guard';
          return true;
        }
        if (post === 1) { return this.walls(p, o, sp); }
        return this.drill(p, o, sp, wk);
      }
      case 'walls': return this.walls(p, o, sp);
      case 'drill': return this.drill(p, o, sp, wk);
      case 'well': case 'green': case 'road': {
        const well = sp.first('well');
        if (wk.where === 'road') { const a = hash01(key, 30) * 6.28; o.x = s.x + Math.cos(a) * (s.radius * 0.9); o.z = s.z + Math.sin(a) * (s.radius * 0.9); o.mode = Mode.Stay; return true; }
        o.x = (well?.x ?? s.x) + (hash01(key, 31) - 0.5) * 6; o.z = (well?.z ?? s.z) + (hash01(key, 32) - 0.5) * 6;
        return true;
      }
      case 'cloister': return this.cloisterWork(p, o, sp, wk);
      case 'garden': return this.homeWork(p, o, home, sp, wk);
      case 'stroll': {
        const m = sp.lordSeat ?? sp.church;
        const bar = sp.first('barn') ?? sp.first('granary');
        if (m) { doorStand(m, this.door2, 2); o.x = this.door2.x; o.z = this.door2.z; o.yaw = m.rot; o.building = m.id; }
        else { o.x = s.x; o.z = s.z; }
        if (bar) { doorStand(bar, this.door2, 2); o.bx = this.door2.x; o.bz = this.door2.z; } else { o.bx = o.x + 20; o.bz = o.z + 10; }
        o.mode = Mode.Patrol;
        o.anim = 'walk';
        return true;
      }
      case 'errand': {
        // servants run errands for the household they live in (a cottage, or the manor for the lord's own)
        const m = home ?? sp.lordSeat ?? null;
        if (m) { doorStand(m, this.door2, 0.4); o.x = this.door2.x; o.z = this.door2.z; o.yaw = this.door2.yaw; o.building = m.id; } else { o.x = s.x; o.z = s.z; }
        const target = hash01(key, day % 6 + 33) < 0.55 ? sp.first('well') : (sp.first('barn') ?? sp.first('stable') ?? sp.first('well'));
        if (target) { doorStand(target, this.door2, 0.6); o.bx = this.door2.x; o.bz = this.door2.z; } else { o.bx = o.x + 14; o.bz = o.z + 6; }
        o.mode = Mode.Errand;
        return true;
      }
      case 'market': {
        this.marketSpot(p, o, sp, true, day, true);
        return true;
      }
    }
    return false;
  }

  private townLabour(p: Person, o: Intent, sp: SettlementPlaces, home: BuildingState | null): boolean {
    const b = sp.choose(['warehouse', 'dock', 'market_hall', 'guildhall', 'barn'], p.id);
    o.activity = 'work';
    if (b) {
      doorStand(b, this.door2, 0.8);
      o.x = this.door2.x; o.z = this.door2.z; o.yaw = this.door2.yaw; o.building = b.id;
      o.anim = 'work_lift'; o.carry = 'sack'; o.label = 'Hauling goods'; o.mode = Mode.Errand;
      o.bx = o.x + Math.cos(b.rot) * 6; o.bz = o.z - Math.sin(b.rot) * 6;
      return true;
    }
    return this.homeWork(p, o, home, sp, { where: 'home', anim: 'work_dig', main: 'spade', label: 'Digging the garden' });
  }

  private homeWork(p: Person, o: Intent, home: BuildingState | null, sp: SettlementPlaces | null, wk: Work): boolean {
    if (!home) return false;
    this.homeYard(p, home, sp, o, 190);
    o.building = home.id;
    o.activity = 'work'; o.label = wk.label; o.anim = wk.anim; o.main = wk.main ?? 'none'; o.off = wk.off ?? 'none'; o.carry = wk.carry ?? 'none';
    if (wk.anim === 'work_spin' || wk.anim === 'work_hammer' || wk.anim === 'work_knead' || wk.anim === 'work_stir') {
      // sit-down crafts at the door
      o.yaw = home.rot;
    }
    return true;
  }

  private walls(p: Person, o: Intent, sp: SettlementPlaces): boolean {
    const s = sp.settlement;
    const poly = s.walls;
    o.activity = 'patrol'; o.label = 'Walking the walls'; o.anim = 'walk'; o.main = 'spear'; o.mode = Mode.Patrol;
    if (poly && poly.length >= 3) {
      const k = Math.floor(hash01(p.id, 36) * poly.length) % poly.length;
      const a = poly[k], b = poly[(k + 1) % poly.length];
      // walk along the inside of the wall
      const inx = (s.x - a.x) * 0.05, inz = (s.z - a.z) * 0.05;
      o.x = a.x + inx; o.z = a.z + inz; o.bx = b.x + (s.x - b.x) * 0.05; o.bz = b.z + (s.z - b.z) * 0.05;
    } else {
      const ang = hash01(p.id, 37) * 6.28;
      o.x = s.x + Math.cos(ang) * s.radius * 0.6; o.z = s.z + Math.sin(ang) * s.radius * 0.6;
      o.bx = s.x + Math.cos(ang + 1.2) * s.radius * 0.6; o.bz = s.z + Math.sin(ang + 1.2) * s.radius * 0.6;
    }
    o.building = -1;
    return true;
  }

  private drill(p: Person, o: Intent, sp: SettlementPlaces, wk: Work): boolean {
    const butts = sp.first('archery_butts');
    const yard = sp.first('training_yard');
    const archer = wk.anim === 'draw_bow' || (p.career !== 'squire' && hash01(p.id, 38) < 0.4);
    o.activity = 'practice';
    if (butts && archer) {
      this.shootingLine(p, butts, o);
      o.label = 'At the butts';
      return true;
    }
    const site = yard ?? sp.first('barracks') ?? sp.lordSeat ?? butts;
    if (!site) { o.x = sp.settlement.x; o.z = sp.settlement.z; o.anim = 'attack_slash'; o.main = 'sword'; o.label = 'Drilling'; return true; }
    doorStand(site, this.door2, 1 + hash01(p.id, 39) * 5);
    o.x = this.door2.x + Math.cos(site.rot) * (hash01(p.id, 40) - 0.5) * 8; o.z = this.door2.z - Math.sin(site.rot) * (hash01(p.id, 40) - 0.5) * 8;
    o.yaw = site.rot + Math.PI + (hash01(p.id, 41) - 0.5) * 0.6; o.building = site.id;
    o.anim = hash01(p.id, 42) < 0.5 ? 'attack_slash' : 'attack_overhead'; o.main = 'sword'; o.off = hash01(p.id, 43) < 0.5 ? 'shield_round' : 'none';
    o.label = 'Weapon drill';
    return true;
  }

  /** A place on the shooting line of the archery butts, facing the targets at the far end. */
  shootingLine(p: Person, butts: BuildingState, o: Intent): void {
    const def = BUILDINGS[butts.kind];
    const hw = def.w / 2 - 0.4, hd = def.d / 2 - 0.4;
    const lane = Math.floor(hash01(p.id, 44) * 6);
    const lx = -hw + 1 + lane * ((2 * hw - 2) / 5);
    frontPoint(butts, lx, hd - 1.9, this.door2, Math.PI);
    o.x = this.door2.x; o.z = this.door2.z; o.yaw = butts.rot + Math.PI; o.building = butts.id;
    o.anim = 'draw_bow'; o.main = 'longbow'; o.back = 'quiver'; o.mode = Mode.Shoot; o.activity = 'practice';
  }

  private stripWork(p: Person, o: Intent, st: Strip, state: string, day: number): void {
    // a spot along the middle of the strip, spread by a per-person key; the work follows the strip's state
    const a = st.poly[0], b = st.poly[1], c = st.poly[2], d = st.poly[3];
    const l1 = Math.hypot(b.x - a.x, b.z - a.z), l2 = Math.hypot(d.x - a.x, d.z - a.z);
    const long = l1 >= l2;
    const p0x = long ? (a.x + d.x) / 2 : (a.x + b.x) / 2, p0z = long ? (a.z + d.z) / 2 : (a.z + b.z) / 2;
    const p1x = long ? (b.x + c.x) / 2 : (d.x + c.x) / 2, p1z = long ? (b.z + c.z) / 2 : (d.z + c.z) / 2;
    const t = 0.1 + 0.8 * hash01(p.id, day % 3 + 45);
    o.x = p0x + (p1x - p0x) * t; o.z = p0z + (p1z - p0z) * t;
    o.yaw = Math.atan2(p1x - p0x, p1z - p0z) + (hash01(p.id, 46) < 0.5 ? 0 : Math.PI);
    o.building = -1; o.mode = Mode.Furrow; o.indoors = false;
    o.carry = 'none'; o.off = 'none';
    switch (state) {
      case 'ripe': {
        const sickle = p.sex === 'f';
        o.anim = sickle ? 'work_sickle' : 'work_scythe'; o.main = sickle ? 'sickle' : 'scythe'; o.label = 'Reaping';
        break;
      }
      case 'ploughed': o.anim = 'work_sow'; o.main = 'none'; o.carry = 'basket'; o.label = 'Sowing'; break;
      case 'harvested': case 'stubble': o.anim = 'work_lift'; o.main = 'none'; o.carry = 'sheaf'; o.label = 'Gathering the sheaves'; break;
      case 'bare': case 'fallow': o.anim = 'work_dig'; o.main = 'spade'; o.label = 'Digging'; break;
      default: o.anim = 'work_hoe'; o.main = 'hoe'; o.label = 'Weeding'; break;
    }
  }

  private cloisterWork(p: Person, o: Intent, sp: SettlementPlaces, wk: Work): boolean {
    const cl = sp.first('cloister') ?? sp.church;
    if (!cl) return false;
    const def = BUILDINGS[cl.kind];
    // the garth in the middle of the cloister range, or the yard before the church
    if (cl.kind === 'cloister') {
      frontPoint(cl, (hash01(p.id, 47) - 0.5) * (def.w - 8), (hash01(p.id, 48) - 0.5) * (def.d - 8), this.door2, 0);
      o.x = this.door2.x; o.z = this.door2.z; o.yaw = hash01(p.id, 49) * 6.28;
    } else {
      doorStand(cl, this.door2, 2 + hash01(p.id, 47) * 4);
      o.x = this.door2.x; o.z = this.door2.z; o.yaw = hash01(p.id, 49) * 6.28;
    }
    o.building = cl.id; o.anim = wk.anim; o.main = wk.main ?? 'none'; o.mode = Mode.Stay;
    if (p.career === 'prior' || p.career === 'abbot') { o.mode = Mode.Wander; o.radius = 4; o.anim = 'idle'; }
    return true;
  }

  // ---- monks and nuns ----

  private monastic(p: Person, o: Intent, day: number, f: number, T: DayTimes, wet: number, sp: SettlementPlaces | null, home: BuildingState | null): void {
    // services at dawn, mid-morning, dusk; meals in the refectory; work in between
    const svc = (a: number, b: number): boolean => f >= a && f < b;
    const sa = T.wake, sb = T.wake + 0.045;
    const ma = T.mealA - 0.07, mb = T.mealA - 0.03;
    const va = T.workEnd + 0.02, vb = T.workEnd + 0.07;
    const church = sp?.church ?? null;
    const inChurch = (a: number, b: number, label: string): void => {
      this.fromUntil(o, day, a, b);
      o.activity = 'church'; o.label = label;
      if (church) { doorStand(church, this.door2); o.x = this.door2.x; o.z = this.door2.z; o.yaw = this.door2.yaw; o.building = church.id; o.indoors = true; }
      else this.atHome(o, home, true, 'church', label);
    };
    if (svc(sa, sb)) { inChurch(sa, sb, 'At Lauds'); return; }
    if (svc(ma, mb)) { inChurch(ma, mb, 'At Terce'); return; }
    if (svc(va, vb)) { inChurch(va, vb, 'At Vespers'); return; }
    if (f >= T.mealA && f < T.mealB) { this.fromUntil(o, day, T.mealA, T.mealB); this.atHome(o, home, true, 'eat', 'In the refectory'); return; }
    // otherwise work: part outdoors, part in the scriptorium and infirmary (indoors)
    const bounds = f < ma ? [sb, ma] : f < T.mealA ? [mb, T.mealA] : f < va ? [T.mealB, va] : [vb, T.bed];
    this.fromUntil(o, day, bounds[0], bounds[1]);
    const pick = hash01(p.id, day % 5 + 600 + Math.floor(f * 6));
    const wk = WORK[p.career] ?? WORK.monk!;
    if (pick < 0.45 || wet > 0.4) {
      this.atHome(o, home, true, 'work', p.sex === 'f' ? 'Working in the infirmary' : 'Copying in the scriptorium');
      if (!home && church) { doorStand(church, this.door2); o.x = this.door2.x; o.z = this.door2.z; o.building = church.id; o.indoors = true; }
      return;
    }
    if (sp) this.workPlace(p, day, f, home, sp, o, wk);
    o.activity = 'work';
  }

  // ---- holy days ----

  private holyDay(p: Person, o: Intent, day: number, f: number, T: DayTimes, age: number, wet: number, home: BuildingState | null, sp: SettlementPlaces | null): void {
    const j = (k: number): number => hash01(p.id, 700 + k);
    const church = sp?.church ?? null;
    const gatherA = T.gatherA;
    const afterB = T.afterB;
    // who goes to Mass: nearly everyone (the sick are in bed already; some old and some mothers stay)
    const attends = !!church && j(day % 5) < (age >= 70 ? 0.55 : 0.93);
    if (f < gatherA) {
      this.fromUntil(o, day, T.wake, gatherA);
      this.atHome(o, home, true, 'home', 'Dressing for Mass');
      if (wet < 0.3 && j(day % 4 + 20) < 0.4) { this.homeYard(p, home, sp, o, 210); o.activity = 'home'; o.label = 'Making ready'; o.anim = 'idle'; o.indoors = false; }
      return;
    }
    if (!attends || !sp) {
      // stays away from church: at home until the others are out again, then the usual leisure
      if (f < afterB) { this.fromUntil(o, day, gatherA, afterB); this.atHome(o, home, true, 'home', 'Staying at home'); return; }
      this.holyLeisure(p, o, day, f, T, age, wet, home, sp, j, true);
      return;
    }
    if (f < T.massA) {
      this.fromUntil(o, day, gatherA, T.massA);
      this.churchyardSpot(p, o, sp, day, 'Gathering at the church', true);
      return;
    }
    if (f < T.massB) {
      this.fromUntil(o, day, T.massA, T.massB);
      doorStand(church!, this.door2);
      o.x = this.door2.x; o.z = this.door2.z; o.yaw = this.door2.yaw; o.building = church!.id; o.indoors = true;
      o.activity = 'church'; o.label = 'At Mass';
      return;
    }
    if (f < afterB) {
      this.fromUntil(o, day, T.massB, afterB);
      this.churchyardSpot(p, o, sp, day, 'Talking after Mass', wet < 0.5);
      return;
    }
    this.holyLeisure(p, o, day, f, T, age, wet, home, sp, j, false);
  }

  private churchyardSpot(p: Person, o: Intent, sp: SettlementPlaces, day: number, label: string, outdoors: boolean): void {
    const cy = sp.churchyard;
    o.activity = 'church'; o.label = label; o.building = -1; o.indoors = !outdoors && !!sp.church;
    // a ring of small groups spread over the churchyard, each facing its own centre
    const groups = 7;
    const g = Math.floor(hash01(p.id, 230 + (day % 3)) * groups);
    const ga = (g / groups) * Math.PI * 2 + 0.4;
    const gr = 4 + (g % 3) * 3.5;
    const cx = cy.x + Math.cos(ga) * gr * 0.9 + Math.sin(cy.yaw) * 6, cz = cy.z + Math.sin(ga) * gr * 0.9 + Math.cos(cy.yaw) * 6;
    const a = hash01(p.id, 231) * Math.PI * 2, r = 0.9 + 0.5 * hash01(p.id, 232);
    o.x = cx + Math.cos(a) * r; o.z = cz + Math.sin(a) * r;
    o.yaw = Math.atan2(cx - o.x, cz - o.z);
    o.anim = hash01(p.id, 233) < 0.8 ? 'talk' : 'idle';
    o.group = 3000 + g;
  }

  private holyLeisure(
    p: Person, o: Intent, day: number, f: number, T: DayTimes, age: number, wet: number,
    home: BuildingState | null, sp: SettlementPlaces | null, j: (k: number) => number, skippedMass: boolean,
  ): void {
    void skippedMass;
    const mid = T.mealA, afterMeal = T.mealB;
    if (f >= mid && f < afterMeal) { this.fromUntil(o, day, mid, afterMeal); this.atHome(o, home, true, 'eat', 'The holy-day dinner'); return; }
    if (f >= T.workEnd) { this.fromUntil(o, day, T.workEnd, T.bed); this.evening(p, o, day, age, wet, false, home, sp); return; }
    const first = f < mid;
    this.fromUntil(o, day, first ? T.afterB : afterMeal, first ? mid : T.workEnd);
    if (wet > 0.5 || !sp) { this.atHome(o, home, true, 'home', 'Resting indoors'); return; }
    const r = j(day % 6 + (first ? 0 : 30));
    const male = p.sex === 'm';
    const butts = sp.first('archery_butts');
    // archery: every able-bodied man and youth was bound to practise on Sundays and holidays (1363). Where the
    // settlement has butts many go; elsewhere a handful loose arrows along the green.
    if (male && age >= 14 && age <= 60 && r < (butts ? 0.42 : 0.1)) {
      o.activity = 'practice'; o.label = 'Archery practice';
      if (butts) { this.shootingLine(p, butts, o); return; }
      this.greenButts(p, o, sp);
      return;
    }
    if (male && r < (butts ? 0.62 : 0.5) && sp.alehouses.length) {
      const ale = sp.alehouses[Math.floor(hash01(p.id, 6) * sp.alehouses.length) % sp.alehouses.length];
      this.alehouseSpot(p, ale, o, sp, wet > 0.4);
      return;
    }
    if (age < 16) { this.playSpot(p, o, home, sp, 240, true); return; }
    if (r < 0.7) {
      // women and others: gossip in knots on the green or at doorsteps
      o.activity = 'talk'; o.label = 'Visiting neighbours'; o.anim = 'talk'; o.building = -1;
      const g = Math.floor(hash01(p.id, day % 3 + 250) * 6);
      const ga = (g / 6) * Math.PI * 2;
      const cx = sp.green.x + Math.cos(ga) * 9, cz = sp.green.z + Math.sin(ga) * 9;
      const a = hash01(p.id, 251) * Math.PI * 2, rr = 0.9 + 0.5 * hash01(p.id, 252);
      o.x = cx + Math.cos(a) * rr; o.z = cz + Math.sin(a) * rr; o.yaw = Math.atan2(cx - o.x, cz - o.z); o.group = 4000 + g + (first ? 0 : 10);
      return;
    }
    this.homeYard(p, home, sp, o, 260);
    o.activity = 'home'; o.label = 'Resting at the door'; o.anim = 'sit'; o.seat = 0.4; o.yaw = home ? home.rot : 0;
  }

  /** Where the men practise when the settlement has no butts: a lane across the green. */
  private greenButts(p: Person, o: Intent, sp: SettlementPlaces): void {
    const par = sp.pastures[0];
    let cx = sp.green.x, cz = sp.green.z;
    let ang = hash01(sp.settlement.id, 53) * Math.PI * 2;
    if (par) {
      const c = polyPoint(par.poly, 0, 0.0, this.pt);
      cx = c.x; cz = c.z;
      const a = par.poly[0], b = par.poly[1];
      ang = Math.atan2(b.x - a.x, b.z - a.z);
    }
    const lane = Math.floor(hash01(p.id, 54) * 6);
    o.x = cx + Math.cos(ang) * (lane - 2.5) * 1.8; o.z = cz - Math.sin(ang) * (lane - 2.5) * 1.8;
    o.yaw = ang + Math.PI / 2;
    o.anim = 'draw_bow'; o.main = 'longbow'; o.back = 'quiver'; o.mode = Mode.Shoot; o.building = -1;
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** What a career carries and holds when at work (shared with the player through ZoneApi.propsFor). */
export function workProps(career: CareerId): { main: HeldItem; off: HeldItem; carry: CarryLook } {
  const w = WORK[career];
  return { main: w?.main ?? 'none', off: w?.off ?? 'none', carry: w?.carry ?? 'none' };
}

/** A point inside a convex polygon: from the centroid towards vertex `u`, `v` of the way out. */
export function polyPoint(poly: readonly P2[], u: number, v: number, out: P2): P2 {
  let cx = 0, cz = 0;
  for (const q of poly) { cx += q.x; cz += q.z; }
  cx /= poly.length; cz /= poly.length;
  const k = Math.min(poly.length - 1, Math.floor(u * poly.length));
  const q = poly[k];
  out.x = cx + (q.x - cx) * v; out.z = cz + (q.z - cz) * v;
  return out;
}

export { dayPart };
