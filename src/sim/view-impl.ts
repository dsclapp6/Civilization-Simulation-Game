// SimView implementation (core/view.ts): what the renderer sees each frame. Objects and arrays are
// reused between calls. In this wave the "street" shows the player and their household standing
// at the door of their home; wave 2 replaces `characters()` with real agents.
import { BUILDINGS } from '../content/types';
import type { P2 } from '../core/math';
import { yawTo } from '../core/math';
import { DAY_SECONDS, isNight, toDate } from '../core/time';
import type {
  AnimalDrawItem, BuildingView, CharacterDrawItem, ClockView, FxEvent, MapMarker, PlayerView, ProjectileDrawItem,
  SimView, StripView, ViewMode, WeatherView,
} from '../core/view';
import type { WorldModel } from '../world/types';
import { AppearanceCache } from './appearance';
import type { Clock } from './clock';
import type { BuildingState, GameState, Person } from './state';
import { fullName } from './state';
import { weatherView, type WeatherSample } from './weather';

/** Wave 2 modules plug their live data into the view (agents, player, travel…). Unset = built-in fallback. */
export interface ViewSources {
  characters?: () => readonly CharacterDrawItem[];
  animals?: () => readonly AnimalDrawItem[];
  projectiles?: () => readonly ProjectileDrawItem[];
  drainFx?: () => readonly FxEvent[];
  player?: () => PlayerView | null;
  focus?: () => P2;
  mode?: () => ViewMode;
  mapMarkers?: () => readonly MapMarker[];
}

export interface ViewHost {
  readonly state: GameState;
  readonly world: WorldModel;
  readonly clock: Clock;
}

const EMPTY_ANIMALS: readonly AnimalDrawItem[] = [];
const EMPTY_PROJECTILES: readonly ProjectileDrawItem[] = [];
const EMPTY_FX: readonly FxEvent[] = [];

/** World position in front of a building's door (door is on local +z, yaw `rot`). */
export function doorPoint(b: BuildingState, extra = 1.5): { x: number; z: number; yaw: number } {
  const d = BUILDINGS[b.kind].d;
  const dx = Math.sin(b.rot), dz = Math.cos(b.rot);
  return { x: b.x + dx * (d / 2 + extra), z: b.z + dz * (d / 2 + extra), yaw: b.rot };
}

export class SimViewImpl implements SimView {
  readonly appearance = new AppearanceCache();
  private readonly sources: ViewSources = {};

  /** Install (or with undefined, remove) a live data source for one part of the view. */
  setSource<K extends keyof ViewSources>(key: K, fn: ViewSources[K] | undefined): void {
    if (fn) this.sources[key] = fn; else delete this.sources[key];
  }

  private readonly clockView: ClockView = {
    absDay: 0, dayFraction: 0, season: 0, year: 1, dayOfSeason: 1, isNight: false, calendarRate: 1, speed: 1, paused: false, skipping: null,
  };
  private readonly weatherViewObj: WeatherView = {
    cloud: 0, rain: 0, snow: 0, fog: 0, windX: 0, windZ: 0, temperature: 10, snowCover: 0,
  };
  private readonly weatherScratch: WeatherSample = { cloud: 0, rain: 0, snow: 0, fog: 0, windX: 0, windZ: 0, temperature: 10 };
  private lastWeatherDay = NaN;
  private readonly playerView: PlayerView = { personId: 0, x: 0, y: 0, z: 0, yaw: 0, mounted: false, alive: true };
  private readonly focusPoint: P2 = { x: 0, z: 0 };
  private readonly drawItems = new Map<number, CharacterDrawItem>();
  private readonly drawList: CharacterDrawItem[] = [];
  private readonly othersScratch: Person[] = [];
  private readonly markers: MapMarker[] = [{ id: 0, kind: 'player', x: 0, z: 0, color: 0xffd24a, size: 1 }];

  private buildingList: BuildingView[] = [];
  private readonly buildingViews = new Map<number, BuildingView>();
  private buildingsVer = 0;
  private lastBuildingRev = -1;

  private stripList: StripView[] = [];
  private readonly stripViews = new Map<number, StripView & { stage: number }>();
  private stripsVer = 0;
  private lastStripRev = -1;
  private lastStripDay = NaN;

  private readonly felledSet = new Set<number>();
  private felledVer = 0;

  constructor(private readonly host: ViewHost) {
    const ids = host.state.ext['felled'];
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'number') this.felledSet.add(id);
  }

  get world(): WorldModel { return this.host.world; }

  // ---- clock & weather ----
  clock(): ClockView {
    const c = this.host.clock;
    const v = this.clockView;
    const d = toDate(c.absDay);
    v.absDay = c.absDay;
    v.dayFraction = d.dayFraction;
    v.season = d.season;
    v.year = d.year;
    v.dayOfSeason = d.dayOfSeason;
    v.isNight = isNight(c.absDay);
    v.calendarRate = c.calendarRate();
    v.speed = c.speed;
    v.paused = c.paused;
    v.skipping = c.skip ? c.skip.kind : null;
    return v;
  }

  weather(): WeatherView {
    const day = this.host.clock.absDay;
    if (day !== this.lastWeatherDay) {
      this.lastWeatherDay = day;
      const p = this.playerPosition();
      const alt = p ? this.world.heightAt(p.x, p.z) : 0;
      weatherView(this.host.state.seed, day, this.host.state.weather.snowCover, alt, this.weatherScratch, this.weatherViewObj);
    }
    return this.weatherViewObj;
  }

  mode(): ViewMode { return this.sources.mode ? this.sources.mode() : 'street'; }

  // ---- player ----
  private playerPerson(): Person | undefined {
    const st = this.host.state;
    return st.persons.get(st.run.playerId);
  }

  /** The door of the player's home building (or the settlement centre). */
  private playerPosition(): { x: number; z: number; yaw: number } | null {
    const st = this.host.state;
    const p = this.playerPerson();
    if (!p) return null;
    const hh = st.households.get(p.household);
    const b = hh ? st.buildings.get(hh.home) : undefined;
    if (b) return doorPoint(b, 1.4);
    const s = this.world.settlements.find((x) => x.id === p.settlement);
    return s ? { x: s.x, z: s.z, yaw: 0 } : { x: 0, z: 0, yaw: 0 };
  }

  player(): PlayerView | null {
    if (this.sources.player) return this.sources.player();
    const st = this.host.state;
    const p = this.playerPerson();
    if (!p) return null;
    const pos = this.playerPosition();
    if (!pos) return null;
    const v = this.playerView;
    v.personId = p.id;
    v.x = pos.x;
    v.z = pos.z;
    v.y = this.world.heightAt(pos.x, pos.z);
    v.yaw = pos.yaw;
    v.mounted = false;
    v.alive = !p.death && st.run.phase !== 'over';
    return v;
  }

  focus(): P2 {
    if (this.sources.focus) return this.sources.focus();
    const pos = this.playerPosition();
    if (pos) { this.focusPoint.x = pos.x; this.focusPoint.z = pos.z; }
    return this.focusPoint;
  }

  // ---- characters ----
  private drawItemFor(p: Person): CharacterDrawItem {
    let item = this.drawItems.get(p.id);
    if (!item) {
      item = {
        id: p.id, x: 0, y: 0, z: 0, yaw: 0, look: this.appearance.get(this.host.state, p, this.host.clock.absDay).look, lookVersion: 0,
        mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 0,
      };
      this.drawItems.set(p.id, item);
    }
    return item;
  }

  characters(): readonly CharacterDrawItem[] {
    if (this.sources.characters) return this.sources.characters();
    const st = this.host.state;
    const list = this.drawList;
    list.length = 0;
    const player = this.playerPerson();
    if (!player) return list;
    const day = this.host.clock.absDay;
    const door = this.playerPosition();
    if (!door) return list;
    const hh = st.households.get(player.household);
    const others = this.othersScratch;
    others.length = 0;
    if (hh) {
      for (const id of hh.members) {
        const m = st.persons.get(id);
        if (m && !m.death && m.id !== player.id) others.push(m);
      }
    }
    const t = day * DAY_SECONDS;
    const fill = (p: Person, x: number, z: number, yaw: number, highlight: 0 | 3): void => {
      const item = this.drawItemFor(p);
      const cached = this.appearance.get(st, p, day);
      item.x = x;
      item.z = z;
      item.y = this.world.heightAt(x, z);
      item.yaw = yaw;
      if (item.look !== cached.look) item.look = cached.look;
      item.lookVersion = cached.version;
      item.anim = p.id === player.id ? 'idle' : 'idle';
      item.animTime = t;
      item.moveSpeed = 0;
      item.highlight = highlight;
      item.label = highlight === 3 ? undefined : p.first;
      list.push(item);
    };
    fill(player, door.x, door.z, door.yaw, 3);
    // the household stands in a loose fan in front of the door
    const n = others.length;
    for (let i = 0; i < n; i++) {
      const a = door.yaw + (i - (n - 1) / 2) * 0.5;
      const r = 3.2 + (i % 2) * 1.3;
      const x = door.x + Math.sin(a) * r;
      const z = door.z + Math.cos(a) * r;
      fill(others[i], x, z, yawTo(x, z, door.x, door.z), 0);
    }
    // forget people who are no longer around so the pool stays small
    if (this.drawItems.size > 96) {
      const keep = new Set(list.map((c) => c.id));
      for (const id of this.drawItems.keys()) if (!keep.has(id)) this.drawItems.delete(id);
    }
    return list;
  }

  animals(): readonly AnimalDrawItem[] { return this.sources.animals ? this.sources.animals() : EMPTY_ANIMALS; }
  projectiles(): readonly ProjectileDrawItem[] { return this.sources.projectiles ? this.sources.projectiles() : EMPTY_PROJECTILES; }
  drainFx(): readonly FxEvent[] { return this.sources.drainFx ? this.sources.drainFx() : EMPTY_FX; }

  // ---- buildings ----
  private refreshBuildings(): void {
    const st = this.host.state;
    if (st.buildingRevision === this.lastBuildingRev) return;
    this.lastBuildingRev = st.buildingRevision;
    const list: BuildingView[] = [];
    for (const b of st.buildings.values()) {
      let v = this.buildingViews.get(b.id);
      if (!v) {
        v = {
          id: b.id, kind: b.kind, level: b.level, x: b.x, z: b.z, rot: b.rot, culture: b.culture, seed: b.seed,
          settlement: b.settlement, construction: b.construction, damage: b.damage, onFire: b.onFire, occupied: b.occupied,
        };
        this.buildingViews.set(b.id, v);
      }
      v.kind = b.kind; v.level = b.level; v.construction = b.construction; v.damage = b.damage;
      v.onFire = b.onFire; v.occupied = b.occupied;
      const house = b.owner ? st.houses.get(b.owner) : undefined;
      if (house?.heraldry) v.ownerColor = house.heraldry.field; else delete v.ownerColor;
      list.push(v);
    }
    this.buildingList = list;
    this.buildingsVer++;
  }

  buildingsVersion(): number { this.refreshBuildings(); return this.buildingsVer; }
  buildings(): readonly BuildingView[] { this.refreshBuildings(); return this.buildingList; }

  // ---- strips ----
  private refreshStrips(): void {
    const st = this.host.state;
    const day = Math.floor(this.host.clock.absDay);
    if (st.stripRevision === this.lastStripRev && day === this.lastStripDay) return;
    const revChanged = st.stripRevision !== this.lastStripRev;
    this.lastStripRev = st.stripRevision;
    this.lastStripDay = day;
    let changed = revChanged || this.stripList.length === 0;
    if (this.stripViews.size === 0) {
      const list: StripView[] = [];
      const worldStrips = new Map(this.world.strips.map((w) => [w.id, w] as const));
      for (const s of st.strips.values()) {
        const ws = worldStrips.get(s.id);
        const v = { id: s.id, poly: ws ? ws.poly : [], crop: s.crop, growth: s.growth, state: s.state, stage: 0 };
        this.stripViews.set(s.id, v);
        list.push(v);
      }
      this.stripList = list;
    }
    for (const s of st.strips.values()) {
      const v = this.stripViews.get(s.id);
      if (!v) continue;
      const stage = Math.min(3, Math.floor(s.growth * 4));
      if (stage !== v.stage) { v.stage = stage; changed = true; }
      v.crop = s.crop; v.growth = s.growth; v.state = s.state;
    }
    if (changed) this.stripsVer++;
  }

  stripsVersion(): number { this.refreshStrips(); return this.stripsVer; }
  strips(): readonly StripView[] { this.refreshStrips(); return this.stripList; }

  // ---- felled scatter ----
  felledVersion(): number { return this.felledVer; }
  felled(): ReadonlySet<number> { return this.felledSet; }
  /** Records trees/rocks removed by anyone (saved with the run). */
  markFelled(id: number): void {
    if (this.felledSet.has(id)) return;
    this.felledSet.add(id);
    this.felledVer++;
    this.host.state.ext['felled'] = [...this.felledSet];
    this.host.state.touchExt('felled');
  }

  // ---- map ----
  mapMarkers(): readonly MapMarker[] {
    if (this.sources.mapMarkers) return this.sources.mapMarkers();
    const p = this.playerPerson();
    const pos = this.playerPosition();
    const m = this.markers[0];
    if (p && pos) {
      m.id = p.id;
      m.x = pos.x;
      m.z = pos.z;
      m.label = fullName(p);
      const k = this.world.kingdoms.find((x) => x.id === this.world.settlements.find((s) => s.id === p.settlement)?.kingdom);
      m.color = k ? k.color : 0xffd24a;
    }
    return this.markers;
  }
}
