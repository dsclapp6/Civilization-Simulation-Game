// Village viewer (?mode=village&settlement=<id>&time=0..1&speed=1|3|8&seed=…&season=0..3&day=1..4&weather=…):
// the real continent, the real assets and renderer, a real Simulation with the detail zone and the
// placeholder economy/social modules, a free camera over a settlement, and an overlay with agent
// counts, activities, path and navigation statistics and timings. Also exposes window.__village for
// tools/village-shots.mjs, which captures the scenes listed in SCENES.
import { createAssetLibrary } from '../../assets/library';
import type { AppRoot } from '../../main';
import { BUILDINGS } from '../../content/types';
import { clamp, hash01 } from '../../core/math';
import { SEASON_NAMES, daylight, formatDate, toDate, type Season } from '../../core/time';
import type { WeatherView } from '../../core/view';
import { createRenderer } from '../../render/renderer';
import type { GameRenderer, QualityLevel } from '../../render/types';
import { newProfile } from '../../sim/legacy';
import { installEconomy } from '../../sim/economy';
import { installSocial } from '../../sim/social';
import { Simulation } from '../../sim/sim';
import { generateWorld } from '../../world/generate';
import type { Settlement, WorldModel } from '../../world/types';
import { installAgents } from '../index';
import type { Zone } from '../zone';

interface Pose { pos: { x: number; y: number; z: number }; look: { x: number; y: number; z: number } }

export interface SceneSpec {
  id: string;
  describe: string;
  /** Picks the settlement. */
  settlement: (w: WorldModel, zone: Zone) => Settlement | null;
  season: Season;
  /** Day of the week, 1..4 (4 is the holy day); 'market' uses the settlement's market day. */
  day: number | 'market';
  /** Day fraction, or a function of the settlement and season. */
  time: number | ((s: Settlement, season: Season, zone: Zone) => number);
  /** Simulated seconds to run before the picture, so people have settled into their day. */
  warm: number;
  camera: (ctx: SceneCtx) => Pose;
  weather?: 'clear' | 'rain' | 'snow';
}

interface SceneCtx { world: WorldModel; zone: Zone; s: Settlement; g: (x: number, z: number) => number }

const WEATHER: Record<string, Partial<WeatherView>> = {
  clear: { cloud: 0.12, rain: 0, snow: 0, fog: 0, windX: 2, windZ: 1, temperature: 16, snowCover: 0 },
  rain: { cloud: 0.92, rain: 0.7, snow: 0, fog: 0.1, windX: 5, windZ: 2, temperature: 10, snowCover: 0 },
  snow: { cloud: 0.85, rain: 0, snow: 0.7, fog: 0.1, windX: 2, windZ: 1, temperature: -3, snowCover: 0.8 },
};

function pickVillage(w: WorldModel, zone: Zone): Settlement | null {
  const ok = (s: Settlement): boolean => {
    if (s.kind !== 'village' || s.strips.length === 0 || s.market) return false;
    const sp = zone.places.of(s.id);
    return !!sp && !!sp.church && sp.alehouses.length > 0 && sp.pastures.length > 0;
  };
  return w.settlements.find(ok) ?? w.settlements.find((s) => s.kind === 'village') ?? null;
}

function pickTown(w: WorldModel, zone: Zone): Settlement | null {
  return w.settlements.find((s) => s.kind === 'town' && !!zone.places.of(s.id)?.hasMarketBuildings && (zone.places.of(s.id)?.stalls.length ?? 0) >= 4)
    ?? w.settlements.find((s) => s.kind === 'town') ?? null;
}

function pickWithButts(w: WorldModel, zone: Zone): Settlement | null {
  return w.settlements.find((s) => (s.kind === 'castle' || s.kind === 'city') && !!zone.places.of(s.id)?.first('archery_butts')) ?? null;
}

const lookFrom = (c: SceneCtx, tx: number, tz: number, yaw: number, dist: number, height: number, up = 1.2): Pose => {
  const x = tx - Math.sin(yaw) * dist, z = tz - Math.cos(yaw) * dist;
  return { pos: { x, y: Math.max(0, c.g(x, z)) + height, z }, look: { x: tx, y: Math.max(0, c.g(tx, tz)) + up, z: tz } };
};

const sunrise = (_s: Settlement, season: Season): number => daylight(season).sunrise;

export const SCENES: SceneSpec[] = [
  {
    id: 'dawn', describe: 'dawn: the village wakes and sets off to work', settlement: pickVillage, season: 1, day: 2,
    time: (s, season) => sunrise(s, season) + 0.028, warm: 14,
    camera: (c) => {
      const sp = c.zone.places.of(c.s.id)!;
      const ch = sp.church!;
      return lookFrom(c, sp.green.x, sp.green.z, ch.rot + 0.9, 26, 2.6, 1.3);
    },
  },
  {
    id: 'midday-fields', describe: 'midday: field workers on the open-field strips', settlement: pickVillage, season: 1, day: 1, time: 0.43, warm: 6,
    camera: (c) => {
      const sp = c.zone.places.of(c.s.id)!;
      // the strip with the most work going on: look along it from a few metres off
      const st = sp.strips[Math.floor(sp.strips.length / 2)];
      const a = st.poly[0], b = st.poly[1], d = st.poly[3];
      const l1 = Math.hypot(b.x - a.x, b.z - a.z), l2 = Math.hypot(d.x - a.x, d.z - a.z);
      const e = l1 >= l2 ? b : d;
      const mx = (a.x + e.x) / 2, mz = (a.z + e.z) / 2;
      return lookFrom(c, mx, mz, Math.atan2(e.x - a.x, e.z - a.z) + 0.5, 34, 3.2, 1);
    },
  },
  {
    id: 'market', describe: 'market day in a town', settlement: pickTown, season: 1, day: 'market', time: 0.41, warm: 10,
    camera: (c) => {
      const sp = c.zone.places.of(c.s.id)!;
      return lookFrom(c, sp.marketCentre.x, sp.marketCentre.z, 0.7, 20, 3.4, 1.2);
    },
  },
  {
    id: 'mass', describe: 'holy day: the crowd gathers at the church before Mass', settlement: pickVillage, season: 1, day: 4,
    time: (s, season) => sunrise(s, season) + 0.085 + 0.012 * hash01(s.id, 5) - 0.012, warm: 10,
    camera: (c) => {
      const sp = c.zone.places.of(c.s.id)!;
      const cy = sp.churchyard;
      return lookFrom(c, cy.x + Math.sin(cy.yaw) * 4, cy.z + Math.cos(cy.yaw) * 4, cy.yaw + Math.PI + 0.5, 15, 2.8, 1.2);
    },
  },
  {
    id: 'butts', describe: 'holy day afternoon: archery at the butts', settlement: pickWithButts, season: 1, day: 4, time: 0.62, warm: 12,
    camera: (c) => {
      const sp = c.zone.places.of(c.s.id)!;
      const b = sp.first('archery_butts')!;
      return lookFrom(c, b.x + Math.sin(b.rot) * 3, b.z + Math.cos(b.rot) * 3, b.rot + Math.PI * 0.82, 15, 2.2, 1.3);
    },
  },
  {
    id: 'alehouse', describe: 'evening at the alehouse', settlement: pickVillage, season: 1, day: 2, time: 0.8, warm: 12,
    camera: (c) => {
      const sp = c.zone.places.of(c.s.id)!;
      const a = sp.alehouses[0];
      const def = BUILDINGS[a.kind];
      const dx = Math.sin(a.rot), dz = Math.cos(a.rot);
      return lookFrom(c, a.x + dx * (def.d / 2 + 2), a.z + dz * (def.d / 2 + 2), a.rot + Math.PI - 0.5, 10, 2.0, 1.2);
    },
  },
  {
    id: 'night', describe: 'night: the watch walks the streets, a few revellers go home', settlement: pickTown, season: 0, day: 2, time: 0.015, warm: 8,
    camera: (c) => {
      const sp = c.zone.places.of(c.s.id)!;
      return lookFrom(c, sp.marketCentre.x, sp.marketCentre.z, 2.2, 24, 3.2, 1.3);
    },
  },
  {
    id: 'pens', describe: 'livestock: a herd on the pasture and beasts about the crofts', settlement: pickVillage, season: 1, day: 1, time: 0.36, warm: 8,
    camera: (c) => {
      const sp = c.zone.places.of(c.s.id)!;
      const par = sp.pastures[0];
      let cx = 0, cz = 0;
      for (const q of par.poly) { cx += q.x / par.poly.length; cz += q.z / par.poly.length; }
      return lookFrom(c, cx, cz, 0.9, 38, 4.2, 0.6);
    },
  },
  {
    id: 'wildlife', describe: 'wildlife in a wood: deer, boar, foxes', settlement: pickVillage, season: 0, day: 1, time: 0.3, warm: 4,
    camera: (c) => {
      const spot = c.zone.fauna.findWildlife('deer', c.s.x, c.s.z, 900) ?? { x: c.s.x + 200, z: c.s.z };
      const yaw = Math.atan2(spot.x - c.s.x, spot.z - c.s.z);
      return lookFrom(c, spot.x, spot.z, yaw + 0.3, 30, 1.9, 0.8);
    },
  },
];

export function start(root: AppRoot): void {
  const params = root.params;
  const seed = params.get('seed') ?? 'millennia';
  const shots = params.has('shots');
  const quality = (params.get('quality') ?? 'medium') as QualityLevel;
  const world = generateWorld(seed);
  const assets = createAssetLibrary();
  const sim = Simulation.newGame({ seed, difficulty: 'knight', generateWorld: () => world, profile: newProfile() });
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const zone = installAgents(sim, { economy, social });
  const focus = { x: 0, z: 0 };
  sim.view.setSource('focus', () => focus);
  sim.view.setSource('mode', () => 'street');
  root.viewport.style.position = 'fixed';
  const renderer: GameRenderer = createRenderer(root.viewport, world, assets, { quality, preserveDrawingBuffer: shots });
  renderer.setCameraMode('free');

  // ---- weather: the viewer can fix the weather the renderer and the schedules see ----
  const view = sim.view as unknown as { weather: () => WeatherView };
  const baseWeather = view.weather.bind(sim.view);
  let forcedWeather: Partial<WeatherView> | null = null;
  const weatherOut: WeatherView = { cloud: 0, rain: 0, snow: 0, fog: 0, windX: 0, windZ: 0, temperature: 10, snowCover: 0 };
  view.weather = () => (forcedWeather ? Object.assign(weatherOut, baseWeather(), forcedWeather) : baseWeather());
  const setWeather = (name: string | null): void => {
    if (!name || name === 'sim') { forcedWeather = null; zone.sched.forceWeather(null); return; }
    const w = WEATHER[name] ?? WEATHER.clear;
    forcedWeather = w;
    zone.sched.forceWeather({ rain: w.rain ?? 0, snow: w.snow ?? 0, temperature: w.temperature ?? 14 });
  };
  setWeather(params.get('weather') ?? (shots ? 'clear' : 'sim'));

  // ---- the settlement and the clock ----
  const byId = (id: number): Settlement | undefined => world.settlements.find((s) => s.id === id);
  let settlement: Settlement = (params.has('settlement') ? byId(Number(params.get('settlement'))) : undefined) ?? pickVillage(world, zone) ?? world.settlements[0];
  const g = (x: number, z: number): number => world.heightAt(clamp(x, 0, world.size), clamp(z, 0, world.size));

  const setClock = (season: Season, dayOfWeek: number | 'market', frac: number): void => {
    const dow = dayOfWeek === 'market' ? 1 + (settlement.id % 3) : dayOfWeek;
    const day = season * 4 + (dow - 1);
    const abs = Math.max(0, day + Math.min(frac, 0.999));
    sim.state.clock.absDay = abs;
    sim.state.clock.firedHour = Math.floor(abs * 24);
    sim.state.clock.paused = false;
    zone.needResync = true;
  };
  const seasonParam = params.has('season') ? (clamp(Number(params.get('season')), 0, 3) as Season) : 1;
  setClock(seasonParam, params.has('day') ? Number(params.get('day')) : 1, params.has('time') ? Number(params.get('time')) : 0.4);
  const speed = Number(params.get('speed') ?? 1);
  if (speed === 3 || speed === 8) sim.dispatch({ type: 'setSpeed', speed });

  const placeFocus = (x: number, z: number): void => { focus.x = x; focus.z = z; };
  const lookAtSettlement = (): void => {
    placeFocus(settlement.x, settlement.z);
    const sp = zone.places.of(settlement.id);
    const green = sp ? sp.green : { x: settlement.x, z: settlement.z };
    const x = green.x - 22, z = green.z + 22;
    renderer.setCameraPose({ x, y: g(x, z) + 3.2, z }, { x: green.x, y: g(green.x, green.z) + 1.4, z: green.z }, 0);
    placeFocus(x, z);
  };
  lookAtSettlement();

  // ---- running the sim without drawing (shots, warm-up) ----
  const run = (seconds: number): void => {
    const n = Math.round(seconds * 20);
    for (let i = 0; i < n; i++) sim.step(1 / 20);
  };

  // ---- scenes ----
  const scene = (id: string): string => {
    const spec = SCENES.find((s) => s.id === id);
    if (!spec) return `unknown scene ${id}`;
    const s = spec.settlement(world, zone);
    if (!s) return `no settlement for ${id}`;
    settlement = s;
    const time = typeof spec.time === 'function' ? spec.time(s, spec.season, zone) : spec.time;
    setWeather(spec.weather ?? 'clear');
    sim.dispatch({ type: 'setSpeed', speed: 1 });
    // start early enough that the warm-up ends at the wanted time of day
    setClock(spec.season, spec.day, time - spec.warm / 60);
    const ctx: SceneCtx = { world, zone, s, g };
    const pose = spec.camera(ctx);
    placeFocus(pose.look.x, pose.look.z);
    renderer.setCameraPose(pose.pos, pose.look, 0);
    zone.resync();
    run(spec.warm);
    placeFocus(pose.look.x, pose.look.z);
    renderer.setCameraPose(pose.pos, pose.look, 0);
    const t0 = performance.now();
    renderer.settle(sim.view, 90000);
    renderer.render(sim.view, 1 / 60);
    const tally = zone.tally();
    return `${spec.id}: ${s.name} (${s.kind}) ${formatDate(sim.absDay)} agents ${zone.agentsArr.length} animals ${zone.fauna.count} ${JSON.stringify(tally)} settle ${(performance.now() - t0).toFixed(0)} ms`;
  };

  // ---- overlay ----
  const el = document.createElement('div');
  el.style.cssText = `position:absolute;left:10px;top:10px;width:330px;padding:9px 11px;border-radius:6px;background:rgba(28,22,16,0.8);color:#efe4cc;
    font:11px/1.35 Georgia,serif;box-shadow:0 2px 10px rgba(0,0,0,0.4);border:1px solid rgba(214,180,110,0.45);user-select:none;z-index:5`;
  const title = document.createElement('div');
  title.style.cssText = 'font-size:13px;letter-spacing:0.08em;color:#e8c25a;margin-bottom:4px';
  title.textContent = 'MILLENNIA · village viewer';
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0 0 6px;font:10.5px/1.35 ui-monospace,Menlo,monospace;color:#f1e8d4;white-space:pre-wrap';
  const keys = document.createElement('div');
  keys.style.cssText = 'color:#cdbf9f;font-size:10.5px';
  keys.innerHTML = 'WASD fly · Q/E down/up · Shift fast · drag look · [ ] time · 1 2 3 speed · P pause · N next day · L labels · R resync · F fix settlement';
  el.append(title, pre, keys);
  if (!shots) root.ui.appendChild(el);
  const status = (): string => {
    const s = zone.stats;
    const t = zone.tally();
    const acts = Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(' · ');
    const d = toDate(sim.absDay);
    const rs = renderer.stats();
    return [
      `${settlement.name} (${settlement.kind}, id ${settlement.id}) · ${formatDate(sim.absDay)}`,
      `${SEASON_NAMES[d.season]} day ${d.dayOfSeason}${d.dayOfSeason === 4 ? ' (holy day)' : ''}${d.dayOfSeason === 1 + (settlement.id % 3) && settlement.market ? ' (market)' : ''} · speed ${sim.clock.speed}×${sim.clock.paused ? ' paused' : ''}`,
      `agents ${s.agents} · animals ${s.animals} · candidates ${s.candidates}`,
      acts,
      `zone step ${s.stepMs.toFixed(2)} ms (max ${s.stepMaxMs.toFixed(1)}) · agents ${s.agentMs.toFixed(2)} · scan ${s.scanMs.toFixed(2)}`,
      `paths ${s.pathSearches} (fail ${s.pathFailures}) avg ${s.pathAvgMs.toFixed(2)} ms max ${s.pathMaxMs.toFixed(1)} · queue ${s.pathPending}`,
      `nav tiles built ${s.navTiles} (max ${s.navTileMaxMs.toFixed(1)} ms) · pending ${s.navPending}`,
      `render ${rs.fps.toFixed(0)} fps · draw calls ${rs.drawCalls}`,
    ].join('\n');
  };

  (window as unknown as { __village: unknown }).__village = {
    sim, zone, renderer, world, scenes: SCENES.map((s) => s.id), scene, run, setWeather, setClock,
    describe: (id: string) => SCENES.find((s) => s.id === id)?.describe ?? '',
    frame: (dt = 1 / 60) => { sim.step(dt); renderer.render(sim.view, dt); return zone.stats; },
    /** Camera at (px, pz) `hy` metres above the ground, looking at (lx, lz) `ly` metres above the ground. */
    pose: (px: number, hy: number, pz: number, lx: number, ly: number, lz: number) => {
      renderer.setCameraPose({ x: px, y: Math.max(0, g(px, pz)) + hy, z: pz }, { x: lx, y: Math.max(0, g(lx, lz)) + ly, z: lz }, 0);
      // a new area: place everyone for the focus and let them take a few steps
      if (Math.hypot(lx - focus.x, lz - focus.z) > 60) { placeFocus(lx, lz); zone.resync(); run(3); }
      placeFocus(lx, lz); renderer.settle(sim.view, 60000); renderer.render(sim.view, 1 / 60);
    },
    get center() { return { x: settlement.x, z: settlement.z }; },
    /** Dev: where the agents are, relative to the settlement centre (for choosing camera positions). */
    agentsList: () => zone.agentsArr.map((a) => ({ id: a.personId, name: a.person.first, career: a.person.career, activity: a.activity, label: a.intentLabel, st: a.st, anim: a.draw.anim, x: +(a.x - settlement.x).toFixed(1), z: +(a.z - settlement.z).toFixed(1) })),
    animalsList: () => zone.fauna.list().map((a) => ({ id: a.id, kind: a.kind, x: +(a.x - settlement.x).toFixed(1), z: +(a.z - settlement.z).toFixed(1) })),
    buildingsList: () => (zone.state.buildingsAt.get(settlement.id) ?? []).map((b) => ({ id: b.id, kind: b.kind, x: +(b.x - settlement.x).toFixed(1), z: +(b.z - settlement.z).toFixed(1), rot: +b.rot.toFixed(2) })),
    status,
    timeFrames: (n = 20) => { const t0 = performance.now(); for (let i = 0; i < n; i++) { sim.step(1 / 60); renderer.render(sim.view, 1 / 60); } return (performance.now() - t0) / n; },
  };

  // ---- interactive loop ----
  root.ready();
  if (shots) return;
  const held = new Set<string>();
  let dragging = false, lx = 0, ly = 0;
  const cv = renderer.domElement;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointerup', () => { dragging = false; });
  cv.addEventListener('pointermove', (e) => { if (!dragging) return; renderer.orbit(-(e.clientX - lx) * 0.005, -(e.clientY - ly) * 0.004); lx = e.clientX; ly = e.clientY; });
  cv.addEventListener('wheel', (e) => { e.preventDefault(); renderer.zoom(Math.sign(e.deltaY)); }, { passive: false });
  window.addEventListener('keydown', (e) => {
    held.add(e.code);
    const d = toDate(sim.absDay);
    if (e.code === 'BracketRight' || e.code === 'BracketLeft') setClock(d.season, d.dayOfSeason, (d.dayFraction + (e.code === 'BracketRight' ? 0.04 : -0.04) + 1) % 1);
    if (e.code === 'Digit1') sim.dispatch({ type: 'setSpeed', speed: 1 });
    if (e.code === 'Digit2') sim.dispatch({ type: 'setSpeed', speed: 3 });
    if (e.code === 'Digit3') sim.dispatch({ type: 'setSpeed', speed: 8 });
    if (e.code === 'KeyP') sim.dispatch({ type: 'togglePause' });
    if (e.code === 'KeyN') setClock(d.season, (d.dayOfSeason % 4) + 1, d.dayFraction);
    if (e.code === 'KeyL') zone.debugLabels = !zone.debugLabels;
    if (e.code === 'KeyR') zone.needResync = true;
    if (e.code === 'KeyF') lookAtSettlement();
  });
  window.addEventListener('keyup', (e) => held.delete(e.code));
  let last = performance.now();
  let acc = 0;
  const loop = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const f = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0);
    const r = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
    const u = (held.has('KeyE') ? 1 : 0) - (held.has('KeyQ') ? 1 : 0);
    renderer.moveFree(f, r, u, dt, held.has('ShiftLeft') || held.has('ShiftRight'));
    const cam = renderer.getCamera().position;
    placeFocus(cam.x, cam.z);
    sim.step(dt);
    renderer.render(sim.view, dt);
    acc += dt;
    if (acc > 0.25) { acc = 0; pre.textContent = status(); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
