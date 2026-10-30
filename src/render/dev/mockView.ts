// Mock SimView for the world viewer: a controllable clock (time/season, auto day cycle), weather
// presets, buildings from world plots, strips that grow with the seasons, wandering villagers and
// animals (dummy draw items), a third-person test avatar and a few map markers.
import { BUILDINGS } from '../../content/types';
import type { AnimalKind, CropKind } from '../../core/domain';
import { clamp, hash01, hash3, pointInPolygon, type P2 } from '../../core/math';
import { DAY_SECONDS, DAYS_PER_SEASON, DAYS_PER_YEAR, isNight, toDate, type Season } from '../../core/time';
import type {
  AnimalDrawItem, AnimState, BuildingView, CharacterDrawItem, ClockView, FxEvent, MapMarker, PlayerView,
  ProjectileDrawItem, SimView, StripState, StripView, ViewMode, WeatherView,
} from '../../core/view';
import { PALETTE } from '../../assets/palette';
import type { Settlement, WorldModel } from '../../world/types';

export type WeatherPreset = 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog';

export interface MoveInput { forward: number; right: number; run: boolean; cameraYaw: number }

interface Walker {
  item: CharacterDrawItem;
  goal: P2;
  wait: number;
  home: Settlement;
  worker: boolean;
}

interface Beast { item: AnimalDrawItem; centre: P2; radius: number; goal: P2; wait: number; speed: number }

const NAMES = ['Alys', 'Wat', 'Hugh', 'Agnes', 'Robin', 'Maud', 'Geoffrey', 'Edith', 'Walter', 'Joan', 'Piers', 'Isabel', 'Simkin', 'Margery', 'Gilbert', 'Emma'];
const ROLES = ['the alewife', 'the smith', 'the reeve', 'the miller', 'the shepherd', 'the carter', 'the thatcher', 'the baker'];

export class MockView implements SimView {
  readonly world: WorldModel;
  absDay: number;
  daySpeed = 1;
  autoTime = false;
  private weatherState: WeatherView = { cloud: 0.15, rain: 0, snow: 0, fog: 0, windX: 2.5, windZ: 1.2, temperature: 16, snowCover: 0 };
  snowCoverOverride: number | null = null;
  private viewMode: ViewMode = 'street';
  private readonly buildingList: BuildingView[];
  private buildingsVer = 1;
  private readonly stripList: StripView[];
  private stripsVer = 1;
  private lastStripDay = -1;
  private readonly walkers: Walker[] = [];
  private readonly chars: CharacterDrawItem[] = [];
  private readonly beasts: Beast[] = [];
  private readonly beastItems: AnimalDrawItem[] = [];
  private readonly felledSet = new Set<number>();
  private felledVer = 0;
  private readonly markers: MapMarker[] = [];
  private readonly fx: FxEvent[] = [];
  readonly avatar: CharacterDrawItem;
  private readonly playerView: PlayerView;
  readonly village: Settlement;
  selectedId = -1;

  constructor(world: WorldModel, opts: { time?: number; season?: Season; weather?: WeatherPreset } = {}) {
    this.world = world;
    const season = opts.season ?? 1;
    this.absDay = DAYS_PER_YEAR + season * DAYS_PER_SEASON + 1 + (opts.time ?? 0.42);
    this.village = world.settlements.find((s) => s.kind === 'village' && s.strips.length > 0) ?? world.settlements[0];

    this.buildingList = world.plots.map((p) => {
      const cat = BUILDINGS[p.kind].cat;
      const k = world.kingdoms[world.settlements[p.settlement]?.kingdom ?? 0];
      return {
        id: p.id, kind: p.kind, level: p.level, x: p.x, z: p.z, rot: p.rot, culture: p.culture, seed: p.seed,
        settlement: p.settlement, construction: 1, damage: 0, onFire: false,
        ownerColor: cat === 'defence' || p.kind === 'manor_house' ? k?.color : undefined,
        occupied: cat === 'home' || cat === 'social' || p.kind === 'smithy' || p.kind === 'bakehouse' || p.kind === 'watermill',
      };
    });
    // one cottage being built in the main village for variety
    const building = this.buildingList.find((b) => b.settlement === this.village.id && b.kind === 'cottage');
    if (building) { building.construction = 0.55; building.occupied = false; }

    this.stripList = world.strips.map((s) => ({ id: s.id, poly: s.poly, crop: 'wheat' as CropKind, growth: 0, state: 'fallow' as StripState }));
    this.updateStrips(true);

    // avatar in the village street near the well
    const well = world.plots.find((p) => p.settlement === this.village.id && p.kind === 'well');
    const start = well ? { x: well.x + 3, z: well.z + 2 } : { x: this.village.x, z: this.village.z };
    this.avatar = this.makeChar(1, start.x, start.z, 0.4, 3);
    this.avatar.look.clothing.tunic = 0x4f6a8a;
    this.avatar.look.clothing.cloak = 0x6a3a2a;
    this.playerView = { personId: 1, x: start.x, y: 0, z: start.z, yaw: 0.4, mounted: false, alive: true };

    this.spawnVillagers(36);
    this.spawnAnimals();
    this.setWeather(opts.weather ?? 'clear');
  }

  private makeChar(id: number, x: number, z: number, yaw: number, highlight: 0 | 1 | 2 | 3): CharacterDrawItem {
    const h = (k: number) => hash01(id, k);
    const tier = 1 + Math.floor(h(1) * 3);
    const dyes = PALETTE.dyes[tier];
    const female = h(2) < 0.5;
    const child = h(9) < 0.15;
    return {
      id, x, y: this.world.heightAt(x, z), z, yaw,
      look: {
        sex: female ? 'f' : 'm', age: child ? 9 : 18 + Math.floor(h(3) * 45), height: child ? 1.2 : female ? 1.62 + h(4) * 0.1 : 1.7 + h(4) * 0.14,
        build: h(5), skin: PALETTE.skinTones[Math.floor(h(6) * PALETTE.skinTones.length)],
        hair: PALETTE.hairColors[Math.floor(h(7) * PALETTE.hairColors.length)], hairStyle: Math.floor(h(8) * 8), beard: female ? 0 : Math.floor(h(10) * 4),
        culture: 'anglo',
        clothing: {
          tunic: dyes[Math.floor(h(11) * dyes.length)], tunicStyle: female ? 'gown' : 'short', legs: 0x5a4a3a,
          headwear: female ? 'coif' : h(12) < 0.4 ? 'hood' : 'none', shoes: tier > 1 ? 'shoes' : 'bare',
          apron: h(13) < 0.3 ? 0xd8cfb4 : undefined,
        },
        armour: 'none', helmet: 'none',
      },
      lookVersion: 1, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none',
      anim: 'idle', animTime: h(14) * 5, moveSpeed: 0, highlight,
    };
  }

  private spawnVillagers(n: number): void {
    const homes = this.world.plots.filter((p) => p.settlement === this.village.id);
    const nearStrips = this.village.strips.map((id) => this.world.strips[id]).filter(Boolean);
    for (let i = 0; i < n; i++) {
      const p = homes[i % Math.max(1, homes.length)];
      const def = p ? BUILDINGS[p.kind] : null;
      const x = p ? p.x + Math.sin(p.rot) * (def!.d / 2 + 2) : this.village.x;
      const z = p ? p.z + Math.cos(p.rot) * (def!.d / 2 + 2) : this.village.z;
      const id = 100 + i;
      const item = this.makeChar(id, x + (hash01(id, 30) - 0.5) * 4, z + (hash01(id, 31) - 0.5) * 4, hash01(id, 32) * 6.28, 0);
      if (i < 10) item.label = `${NAMES[i % NAMES.length]} ${ROLES[i % ROLES.length]}`;
      const worker = i % 4 === 3 && nearStrips.length > 0;
      if (worker) {
        const st = nearStrips[i % nearStrips.length];
        const c = st.poly[0];
        item.x = c.x + 2; item.z = c.z + 2;
        item.mainHand = 'hoe';
        item.anim = 'work_hoe';
      }
      if (i % 7 === 2) { item.carry = 'sack'; }
      this.walkers.push({ item, goal: { x: item.x, z: item.z }, wait: hash01(id, 40) * 4, home: this.village, worker });
      this.chars.push(item);
    }
    // a rider on the road
    const rider = this.makeChar(90, this.village.x + 30, this.village.z - 20, 1.2, 0);
    rider.mount = { coat: 0x5a3a22, anim: 'walk', animTime: 0 };
    rider.anim = 'ride_walk';
    rider.label = 'Sir Gilbert of Harrow';
    rider.look.clothing.tunic = PALETTE.dyes[5][0];
    this.walkers.push({ item: rider, goal: { x: rider.x, z: rider.z }, wait: 0, home: this.village, worker: false });
    this.chars.push(rider);
    this.chars.push(this.avatar);
  }

  private spawnAnimals(): void {
    const v = this.village;
    let id = 5000;
    const add = (kind: AnimalKind, centre: P2, radius: number, n: number, coat: number, speed: number, scale = 1) => {
      for (let i = 0; i < n; i++) {
        const x = centre.x + (hash01(id, 1) - 0.5) * radius, z = centre.z + (hash01(id, 2) - 0.5) * radius;
        const item: AnimalDrawItem = {
          id, kind, x, y: this.world.heightAt(x, z), z, yaw: hash01(id, 3) * 6.28, anim: 'graze', animTime: hash01(id, 4) * 5,
          moveSpeed: 0, scale: scale * (0.9 + hash01(id, 5) * 0.2), coat: coat, young: hash01(id, 6) < 0.15, highlight: 0,
        };
        this.beasts.push({ item, centre, radius, goal: { x, z }, wait: hash01(id, 7) * 5, speed });
        this.beastItems.push(item);
        id++;
      }
    };
    const pasture = this.world.parcels.find((p) => p.settlement === v.id && p.use === 'pasture');
    const pc = pasture ? centroid(pasture.poly) : { x: v.x + 80, z: v.z + 80 };
    add('sheep', pc, 40, 12, 0xe8e2d0, 0.6);
    add('cow', pc, 30, 4, 0x6b4a32, 0.5);
    add('chicken', { x: v.x, z: v.z }, 30, 8, 0xd8c8a8, 0.8, 1);
    add('horse', { x: v.x + 20, z: v.z - 15 }, 10, 2, 0x7a5032, 0.7);
    // deer in the nearest wood
    let best: P2 = { x: v.x + 400, z: v.z }, bf = 0;
    for (let k = 0; k < 200; k++) {
      const a = hash01(k, 50) * 6.28, d = 300 + hash01(k, 51) * 900;
      const x = v.x + Math.sin(a) * d, z = v.z + Math.cos(a) * d;
      const f = this.world.forestAt(x, z);
      if (f > bf) { bf = f; best = { x, z }; }
    }
    add('deer', best, 60, 5, 0x8a5a32, 1.2);
    add('boar', { x: best.x + 80, z: best.z - 40 }, 50, 2, 0x3a2a20, 0.9);
  }

  // ---------- controls ----------
  setTimeOfDay(f: number): void { this.absDay = Math.floor(this.absDay) + clamp(f, 0, 0.9999); }
  setSeason(s: Season): void {
    const year = Math.floor(this.absDay / DAYS_PER_YEAR);
    const frac = this.absDay - Math.floor(this.absDay);
    const dayOfSeason = Math.floor(this.absDay) % DAYS_PER_SEASON;
    this.absDay = year * DAYS_PER_YEAR + s * DAYS_PER_SEASON + dayOfSeason + frac;
    this.updateStrips(true);
    if (this.snowCoverOverride === null) this.weatherState.snowCover = this.autoSnowCover();
  }
  setDayOfSeason(d: number): void {
    const base = Math.floor(this.absDay / DAYS_PER_SEASON) * DAYS_PER_SEASON;
    const frac = this.absDay - Math.floor(this.absDay);
    this.absDay = base + clamp(Math.floor(d), 0, DAYS_PER_SEASON - 1) + frac;
    this.updateStrips(true);
  }
  setMode(m: ViewMode): void { this.viewMode = m; }
  setWeather(w: WeatherPreset): void {
    const ws = this.weatherState;
    const set = (cloud: number, rain: number, snow: number, fog: number, wx: number, wz: number, t: number) => {
      ws.cloud = cloud; ws.rain = rain; ws.snow = snow; ws.fog = fog; ws.windX = wx; ws.windZ = wz; ws.temperature = t;
    };
    switch (w) {
      case 'clear': set(0.12, 0, 0, 0, 2.5, 1.2, 17); break;
      case 'cloudy': set(0.72, 0, 0, 0.05, 4, 1.5, 13); break;
      case 'rain': set(0.92, 0.75, 0, 0.1, 5, 2.5, 10); break;
      case 'storm': set(1, 1, 0, 0.15, 10, 4, 9); break;
      case 'snow': set(0.85, 0, 0.8, 0.1, 2, 1, -3); break;
      case 'fog': set(0.4, 0, 0, 0.75, 0.5, 0.2, 8); break;
    }
    if (this.snowCoverOverride === null) ws.snowCover = this.autoSnowCover();
  }
  private autoSnowCover(): number {
    const season = toDate(this.absDay).season;
    if (this.weatherState.snow > 0.2) return season === 3 ? 0.9 : 0.55;
    return season === 3 ? 0.7 : 0;
  }
  setSnowCover(v: number | null): void {
    this.snowCoverOverride = v;
    this.weatherState.snowCover = v ?? this.autoSnowCover();
  }
  fell(id: number): void { this.felledSet.add(id); this.felledVer++; }
  select(id: number): void {
    this.selectedId = id;
    for (const c of this.chars) if (c !== this.avatar) c.highlight = c.id === id ? 2 : 0;
    for (const a of this.beastItems) a.highlight = a.id === id ? 2 : 0;
  }

  // ---------- simulation ----------
  step(dt: number, move: MoveInput | null): void {
    if (this.autoTime) this.absDay += (dt * this.daySpeed) / DAY_SECONDS;
    const day = Math.floor(this.absDay * 4) / 4;
    if (day !== this.lastStripDay) this.updateStrips(false);
    this.stepAvatar(dt, move);
    this.stepWalkers(dt);
    this.stepBeasts(dt);
    this.updateMarkers();
  }

  private stepAvatar(dt: number, move: MoveInput | null): void {
    const a = this.avatar;
    a.animTime += dt;
    let speed = 0;
    if (move && (move.forward || move.right)) {
      const len = Math.hypot(move.forward, move.right);
      const f = move.forward / len, r = move.right / len;
      const yaw = move.cameraYaw;
      const dx = Math.sin(yaw) * f - Math.cos(yaw) * r;
      const dz = Math.cos(yaw) * f + Math.sin(yaw) * r;
      speed = move.run ? 5.2 : 1.6;
      a.x += dx * speed * dt;
      a.z += dz * speed * dt;
      const target = Math.atan2(dx, dz);
      let d = target - a.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      a.yaw += d * Math.min(1, dt * 10);
      const anim: AnimState = move.run ? 'run' : 'walk';
      if (a.anim !== anim) { a.anim = anim; a.animTime = 0; }
    } else if (a.anim !== 'idle') { a.anim = 'idle'; a.animTime = 0; }
    a.moveSpeed = speed;
    a.x = clamp(a.x, 5, this.world.size - 5);
    a.z = clamp(a.z, 5, this.world.size - 5);
    const ws = this.world.waterSurfaceAt(a.x, a.z);
    const h = this.world.heightAt(a.x, a.z);
    a.y = ws !== null && ws - h > 1.3 ? ws - 1.3 : h;
    const p = this.playerView;
    p.x = a.x; p.y = a.y; p.z = a.z; p.yaw = a.yaw;
  }

  private stepWalkers(dt: number): void {
    const night = isNight(this.absDay);
    for (const w of this.walkers) {
      const it = w.item;
      it.animTime += dt;
      if (w.worker && !night) { it.moveSpeed = 0; continue; }
      if (w.wait > 0) {
        w.wait -= dt;
        if (it.mount) it.mount.anim = 'idle';
        if (it.anim !== (it.mount ? 'ride_idle' : 'idle')) { it.anim = it.mount ? 'ride_idle' : 'idle'; it.animTime = 0; }
        it.moveSpeed = 0;
        if (w.wait <= 0) {
          const r = it.mount ? 160 : w.home.radius * 0.8;
          const k = hash3(it.id, Math.floor(this.absDay * 50));
          w.goal = { x: w.home.x + ((k % 1000) / 1000 - 0.5) * 2 * r, z: w.home.z + (((k >>> 10) % 1000) / 1000 - 0.5) * 2 * r };
        }
        continue;
      }
      const dx = w.goal.x - it.x, dz = w.goal.z - it.z;
      const d = Math.hypot(dx, dz);
      const speed = it.mount ? 1.8 : 1.25;
      if (d < 0.6) { w.wait = 2 + hash01(it.id, Math.floor(this.absDay * 100)) * 6; continue; }
      it.x += (dx / d) * speed * dt;
      it.z += (dz / d) * speed * dt;
      it.y = this.world.heightAt(it.x, it.z);
      const target = Math.atan2(dx, dz);
      let dy = target - it.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      it.yaw += dy * Math.min(1, dt * 6);
      const anim: AnimState = it.mount ? 'ride_walk' : it.carry !== 'none' ? 'carry_walk' : 'walk';
      if (it.anim !== anim) { it.anim = anim; it.animTime = 0; }
      if (it.mount) it.mount.anim = 'walk';
      it.moveSpeed = speed;
    }
  }

  private stepBeasts(dt: number): void {
    for (const b of this.beasts) {
      const it = b.item;
      it.animTime += dt;
      if (b.wait > 0) {
        b.wait -= dt;
        it.moveSpeed = 0;
        if (it.anim === 'walk') { it.anim = hash01(it.id, Math.floor(this.absDay * 30)) < 0.6 ? 'graze' : 'idle'; it.animTime = 0; }
        if (b.wait <= 0) {
          const k = hash3(it.id, Math.floor(this.absDay * 80), 3);
          b.goal = { x: b.centre.x + ((k % 1000) / 1000 - 0.5) * b.radius, z: b.centre.z + (((k >>> 10) % 1000) / 1000 - 0.5) * b.radius };
        }
        continue;
      }
      const dx = b.goal.x - it.x, dz = b.goal.z - it.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.4) { b.wait = 3 + hash01(it.id, Math.floor(this.absDay * 70)) * 8; continue; }
      it.x += (dx / d) * b.speed * dt;
      it.z += (dz / d) * b.speed * dt;
      it.y = this.world.heightAt(it.x, it.z);
      it.yaw = Math.atan2(dx, dz);
      if (it.anim !== 'walk') { it.anim = 'walk'; it.animTime = 0; }
      it.moveSpeed = b.speed;
    }
  }

  /** Strip states follow a three-field rotation through the seasons, with per-strip timing jitter. */
  private updateStrips(force: boolean): void {
    const day = Math.floor(this.absDay * 4) / 4;
    if (!force && day === this.lastStripDay) return;
    this.lastStripDay = day;
    const d = toDate(this.absDay);
    const p = clamp((d.dayOfSeason - 1 + d.dayFraction) / DAYS_PER_SEASON, 0, 1);
    for (const sv of this.stripList) {
      const st = this.world.strips[sv.id];
      const role = ((st?.field ?? 0) + d.year) % 3;
      const j = (hash01(sv.id, 77) - 0.5) * 0.3;
      const t = clamp(p + j, 0, 1);
      const winterCrop: CropKind = hash01(sv.id, 5) < 0.7 ? 'wheat' : 'rye';
      const springCrops: CropKind[] = ['barley', 'barley', 'oats', 'oats', 'peas', 'beans'];
      const springCrop = springCrops[Math.floor(hash01(sv.id, 6) * springCrops.length)];
      let state: StripState = 'fallow', growth = 0, crop: CropKind = role === 0 ? winterCrop : role === 1 ? springCrop : 'fallow';
      switch (d.season) {
        case 0:
          if (role === 0) { state = 'growing'; growth = 0.15 + 0.4 * t; }
          else if (role === 1) { state = t < 0.3 ? 'ploughed' : t < 0.55 ? 'sown' : 'growing'; growth = Math.max(0, t - 0.55) * 0.5; }
          else state = 'fallow';
          break;
        case 1:
          if (role === 0) { state = t < 0.45 ? 'growing' : t < 0.85 ? 'ripe' : 'harvested'; growth = 0.55 + t * 0.9; }
          else if (role === 1) { state = t < 0.7 ? 'growing' : 'ripe'; growth = 0.3 + t; }
          else state = t > 0.7 ? 'ploughed' : 'fallow';
          break;
        case 2:
          if (role === 0) { state = t < 0.5 ? 'stubble' : t < 0.75 ? 'ploughed' : 'sown'; crop = winterCrop; }
          else if (role === 1) { state = t < 0.3 ? 'harvested' : 'stubble'; }
          else state = t > 0.5 ? 'ploughed' : 'fallow';
          break;
        default:
          if (role === 0) { state = 'sown'; growth = 0.05; crop = winterCrop; }
          else if (role === 1) state = 'stubble';
          else state = 'ploughed';
      }
      if (sv.state !== state || sv.crop !== crop || Math.abs(sv.growth - growth) > 0.01) {
        sv.state = state; sv.crop = crop; sv.growth = clamp(growth, 0, 1);
      }
    }
    this.stripsVer++;
  }

  private updateMarkers(): void {
    this.markers.length = 0;
    this.markers.push({ id: 1, kind: 'player', x: this.avatar.x, z: this.avatar.z, color: 0xf2c14e, size: 1, label: 'You' });
    const castle = this.world.settlements.find((s) => s.kind === 'castle');
    if (castle) this.markers.push({ id: 2, kind: 'army', x: castle.x + 400, z: castle.z + 250, color: this.world.kingdoms[castle.kingdom]?.color ?? 0xaa3333, size: 220, label: 'Host of Wessmark' });
    const hw = this.world.roads.find((r) => r.kind === 'highway');
    if (hw) {
      const k = Math.floor(((this.absDay * 2) % 1) * (hw.points.length - 1));
      const p = hw.points[k];
      this.markers.push({ id: 3, kind: 'caravan', x: p.x, z: p.z, color: 0xd9a441, size: 12, label: 'Wool caravan' });
    }
    this.markers.push({ id: 4, kind: 'bandits', x: this.village.x - 1800, z: this.village.z + 900, color: 0x3a3a3a, size: 15, label: 'Outlaws' });
  }

  // ---------- SimView ----------
  clock(): ClockView {
    const d = toDate(this.absDay);
    return {
      absDay: this.absDay, dayFraction: d.dayFraction, season: d.season, year: d.year, dayOfSeason: d.dayOfSeason,
      isNight: isNight(this.absDay), calendarRate: 1, speed: 1, paused: !this.autoTime,
    };
  }
  weather(): WeatherView { return this.weatherState; }
  mode(): ViewMode { return this.viewMode; }
  player(): PlayerView | null { return this.playerView; }
  focus(): P2 { return { x: this.avatar.x, z: this.avatar.z }; }
  characters(): readonly CharacterDrawItem[] { return this.chars; }
  animals(): readonly AnimalDrawItem[] { return this.beastItems; }
  projectiles(): readonly ProjectileDrawItem[] { return []; }
  drainFx(): readonly FxEvent[] { const out = this.fx.slice(); this.fx.length = 0; return out; }
  buildingsVersion(): number { return this.buildingsVer; }
  buildings(): readonly BuildingView[] { return this.buildingList; }
  stripsVersion(): number { return this.stripsVer; }
  strips(): readonly StripView[] { return this.stripList; }
  felledVersion(): number { return this.felledVer; }
  felled(): ReadonlySet<number> { return this.felledSet; }
  mapMarkers(): readonly MapMarker[] { return this.markers; }

  /** Is (x, z) inside any strip (dev helper). */
  inStrip(x: number, z: number): boolean {
    return this.stripList.some((s) => pointInPolygon(x, z, s.poly));
  }
  teleportAvatar(x: number, z: number, yaw?: number): void {
    this.avatar.x = x; this.avatar.z = z;
    if (yaw !== undefined) this.avatar.yaw = yaw;
    this.stepAvatar(0, null);
  }
  bumpBuildings(): void { this.buildingsVer++; }
}

function centroid(poly: readonly P2[]): P2 {
  let x = 0, z = 0;
  for (const p of poly) { x += p.x; z += p.z; }
  return { x: x / poly.length, z: z / poly.length };
}
