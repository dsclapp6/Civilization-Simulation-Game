// Millennia render engine: draws a SimView each frame on top of the static WorldModel using the
// asset library. Owns the scene, camera rig, terrain streaming, water, sky/atmosphere, weather,
// vegetation, buildings, fields, dynamic layers, map view and post-processing.
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { clamp, smoothstep } from '../core/math';
import { DAYS_PER_SEASON } from '../core/time';
import type { CharacterDrawItem, AnimalDrawItem, BuildingView, SimView, StripView, ViewMode, WorldMarker, WorldPropView } from '../core/view';
import type { AssetLibrary } from '../assets/types';
import type { WorldModel } from '../world/types';
import { QUALITY, type QualitySettings } from './quality';
import type { CameraMode, GameRenderer, GroundPoint, HoverTarget, PickResult, QualityLevel, RenderStats, RendererOptions } from './types';
import { computeAtmosphere, createAtmosphereState } from './sky/atmosphere';
import { atmoUniforms, installAtmospherePatch } from './sky/atmospherePatch';
import { Sky } from './sky/sky';
import { Lighting } from './sky/lighting';
import { CameraRig } from './camera/cameraRig';
import { TerrainSystem } from './terrain/terrainSystem';
import { WaterSystem } from './water/waterSystem';
import { VegetationSystem } from './vegetation/vegetationSystem';
import { BuildingSystem } from './buildings';
import { FieldSystem } from './fields';
import { RoadSystem } from './roads';
import { DynamicLayers } from './dynamicLayers';
import { Precipitation } from './weather/precipitation';
import { buildMapBase, buildMapOverlay } from './map/mapOverlay';
import { MapLabels } from './map/mapLabels';
import { PostFx } from './post/postFx';
import { WorldPropsLayer } from './feedback/worldProps';
import { BeaconLayer } from './feedback/beacons';
import { FloaterLayer } from './feedback/floaters';
import { Nameplates } from './feedback/nameplates';
import { HoverLayer } from './feedback/hover';

export type { CameraMode, GameRenderer, GroundPoint, HoverTarget, PickResult, QualityLevel, RenderStats, RendererOptions } from './types';

const NO_PROPS: readonly WorldPropView[] = [];
const NO_MARKERS: readonly WorldMarker[] = [];

const AIM_ANIMS = new Set<string>(['draw_bow', 'aim_bow', 'shoot_bow', 'aim_crossbow', 'shoot_crossbow', 'reload_crossbow']);
const VIEW_TO_CAMERA: Record<ViewMode, CameraMode> = { street: 'follow', map: 'map', travel: 'map', cinematic: 'cinematic' };

export function createRenderer(container: HTMLElement, world: WorldModel, assets: AssetLibrary, opts: RendererOptions = {}): GameRenderer {
  installAtmospherePatch();
  let quality: QualitySettings = QUALITY[opts.quality ?? 'medium'];
  const palette = assets.palette;

  const renderer = new THREE.WebGLRenderer({
    antialias: quality.antialias,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  renderer.setClearColor(0x000000, 1);
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.left = '0';
  labelRenderer.domElement.style.top = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);
  const showLabels = opts.labels !== false;

  const scene = new THREE.Scene();
  scene.name = 'world';
  const fog = new THREE.FogExp2(0xc8dcea, 1 / 16000);
  scene.fog = fog;

  const heightAt = (x: number, z: number) => world.heightAt(clamp(x, 0, world.size), clamp(z, 0, world.size));
  // permanent snow sits on the upper part of the world's highest range, whatever its scale
  let maxHeight = 0;
  for (let i = 0; i < world.macro.height.length; i++) maxHeight = Math.max(maxHeight, world.macro.height[i]);
  const snowLineBase = Math.max(500, maxHeight * 0.74);

  // ---- systems ----
  // the sea material comes from the water system, which needs the terrain's coverage mask
  const bootSea = new THREE.MeshBasicMaterial();
  const terrain = new TerrainSystem(world, palette, bootSea, terrainSettings(quality));
  const water = new WaterSystem(world, palette, terrain.mask);
  terrain.seaMaterial = water.seaMaterial;
  bootSea.dispose();
  const vegetation = new VegetationSystem(world, assets, vegSettings(quality));
  const buildings = new BuildingSystem(world, assets, { detailDistance: quality.buildingDetail, drawBudget: quality.buildingDrawBudget });
  const roads = new RoadSystem(world, palette, quality.roadRadius);
  roads.weather = { uSnowCover: terrain.uniforms.uSnowCover, uWetness: terrain.uniforms.uWetness };
  const fields = new FieldSystem(world, assets, terrain.uniforms, { stripDistance: quality.stripDistance, cropRadius: quality.cropRadius, cropMax: quality.cropMax, cropTris: quality.cropTris });
  const dynamic = new DynamicLayers(assets, heightAt);
  // clarity & feedback: results of work, where to go, gains, who is who, what the cursor is on
  const worldProps = new WorldPropsLayer(assets, heightAt);
  const beacons = new BeaconLayer(heightAt, showLabels);
  const floaters = new FloaterLayer();
  const plates = new Nameplates(showLabels);
  let lastBuildings: readonly BuildingView[] = [];
  let lastStrips: readonly StripView[] = [];
  const hover = new HoverLayer({
    world, heightAt,
    building: (id) => lastBuildings.find((b) => b.id === id) ?? null,
    strip: (id) => lastStrips.find((s) => s.id === id) ?? null,
    prop: (id) => worldProps.find(id),
  });
  let hoverKey = '';
  let hoverStripsVer = -1;
  const occRay = new THREE.Ray();
  plates.occluded = (from, to) => {
    const d = from.distanceTo(to);
    occRay.origin.copy(from);
    occRay.direction.subVectors(to, from).normalize();
    const hit = buildings.raycast(occRay, d);
    return hit !== null && hit.distance < d - 0.6;
  };
  const precip = new Precipitation(quality.rainDrops, quality.snowFlakes);
  const overlayTex = buildMapOverlay(world);
  const mapBaseTex = buildMapBase(world, palette);
  terrain.uniforms.uOverlay.value = overlayTex;
  terrain.uniforms.uMapBase.value = mapBaseTex;
  const mapLabels = new MapLabels(world);
  const overlayScene = new THREE.Scene();
  if (showLabels) overlayScene.add(plates.scene, beacons.labelScene, mapLabels.scene);

  const rig = new CameraRig(1, {
    heightAt,
    worldSize: world.size,
    raycastBuildings: (ray, maxDist, pad) => buildings.raycast(ray, maxDist, pad)?.distance ?? null,
  });
  rig.autoMapZoom = opts.autoMapZoom !== false;
  const camera = rig.camera;
  const sky = new Sky(38000);
  const lighting = new Lighting(scene);
  lighting.configure(quality.shadows, quality.shadowMapSize, quality.shadowRadius);

  scene.add(sky.stars, sky.dome, terrain.root, water.root, roads.root, vegetation.root, buildings.root, fields.root, dynamic.root,
    worldProps.root, hover.root, beacons.root, precip.rain, precip.snow);

  let post: PostFx | null = null;
  const atmo = createAtmosphereState();
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const focusVec = new THREE.Vector3();
  const wind = new THREE.Vector2();
  const tmpColor = new THREE.Color();
  const sunFogOut = new THREE.Color();
  const cloudOff = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let time = 0;
  let wetness = 0;
  let lastViewMode: ViewMode | null = null;
  let fpsAvg = 60;
  let frameMsAvg = 0;
  let genMs = 0;
  let terrainMs = 0;
  let feedbackMs = 0;
  let floaterMs = 0;
  let lastChars: readonly CharacterDrawItem[] = [];
  let lastAnimals: readonly AnimalDrawItem[] = [];
  let width = 1, height = 1;
  let disposed = false;

  function terrainSettings(q: QualitySettings) {
    return { maxLevel: q.terrainMaxLevel, splitFactor: q.terrainSplit, drawDistance: q.terrainDistance, cacheNodes: q.terrainCacheNodes, roadRibbons: true };
  }
  function vegSettings(q: QualitySettings) {
    return { near: q.vegNear, mid: q.vegMid, far: q.vegFar, grass: q.vegGrass, maxPerKind: q.vegMaxPerKind, kindTris: q.vegKindTris };
  }

  function applyPixelRatio(): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const pr = opts.pixelRatio ?? Math.min(dpr, quality.pixelRatioCap) * quality.pixelRatioScale;
    renderer.setPixelRatio(pr);
    post?.setSize(width, height, pr);
  }

  function resize(): void {
    width = Math.max(1, container.clientWidth || window.innerWidth);
    height = Math.max(1, container.clientHeight || window.innerHeight);
    renderer.setSize(width, height, true);
    labelRenderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    applyPixelRatio();
    post?.setSize(width, height, renderer.getPixelRatio());
  }

  function setQuality(q: QualityLevel): void {
    quality = QUALITY[q];
    applyPixelRatio();
    lighting.configure(quality.shadows, quality.shadowMapSize, quality.shadowRadius);
    terrain.configure(terrainSettings(quality));
    vegetation.configure(vegSettings(quality));
    buildings.configure({ detailDistance: quality.buildingDetail, drawBudget: quality.buildingDrawBudget });
    fields.configure({ stripDistance: quality.stripDistance, cropRadius: quality.cropRadius, cropMax: quality.cropMax, cropTris: quality.cropTris });
    roads.radius = quality.roadRadius;
    if (quality.postFx && !post) {
      post = new PostFx(renderer, scene, camera, width, height);
      post.setSize(width, height, renderer.getPixelRatio());
    } else if (!quality.postFx && post) {
      post.dispose();
      post = null;
    }
  }

  function focusFor(view: SimView): THREE.Vector3 {
    const p = view.player();
    if (p && p.alive) return focusVec.set(p.x, p.y, p.z);
    const f = view.focus();
    return focusVec.set(f.x, Math.max(0, heightAt(f.x, f.z)), f.z);
  }

  function frame(view: SimView, dt: number, budgetScale: number, draw = true): void {
    const t0 = performance.now();
    dt = clamp(dt, 0, 0.25);
    time += dt;
    const clock = view.clock();
    const weather = view.weather();
    const seasonProgress = clamp((clock.dayOfSeason - 1 + clock.dayFraction) / DAYS_PER_SEASON, 0, 1);
    computeAtmosphere({
      dayFraction: clock.dayFraction, season: clock.season, seasonProgress, absDay: clock.absDay,
      cloud: weather.cloud, rain: weather.rain, snow: weather.snow, fog: weather.fog,
    }, palette, atmo);

    // camera
    const vm = view.mode();
    if (vm !== lastViewMode) {
      // the sim's view mode drives the camera, except an explicitly posed free camera (dev, cut-scenes)
      if ((lastViewMode !== null || vm !== 'street') && rig.mode !== 'free') rig.setMode(VIEW_TO_CAMERA[vm], lastViewMode === null ? 0 : 1.4);
      lastViewMode = vm;
    }
    // aiming a bow or crossbow: over-the-shoulder camera (the reticle must not sit on the head)
    {
      const pl = view.player();
      let aiming = false, held = 0;
      if (pl && pl.alive && vm === 'street') {
        for (const c of view.characters()) if (c.id === pl.personId) { aiming = AIM_ANIMS.has(c.anim); held = c.anim === 'draw_bow' ? c.animTime : 1; break; }
      }
      rig.setAim(aiming, held);
    }
    rig.update(dt, focusFor(view));
    const mapBlend = rig.mapBlend();
    const above = rig.heightAboveGround();

    // fog + atmosphere uniforms (display space unless post-processing renders in linear HDR)
    const linearOut = !!post;
    fog.color.copy(atmo.fogColor);
    fog.density = atmo.fogDensity * (1 - 0.8 * mapBlend);
    const sf = atmoUniforms.atmoSunFog.value;
    if (linearOut) sunFogOut.copy(atmo.sunFog);
    else atmo.sunFog.getRGB(sunFogOut, THREE.SRGBColorSpace);
    sf[0] = sunFogOut.r; sf[1] = sunFogOut.g; sf[2] = sunFogOut.b;
    const sd = atmoUniforms.atmoSunDir.value;
    sd[0] = atmo.sunDir.x; sd[1] = atmo.sunDir.y; sd[2] = atmo.sunDir.z;
    const ap = atmoUniforms.atmoParams.value;
    const groundBelow = Math.max(0, heightAt(camera.position.x, camera.position.z));
    ap[0] = atmo.mistDensity * (1 - mapBlend);
    ap[1] = 1 / atmo.mistFalloff;
    ap[2] = groundBelow - 6;
    ap[3] = atmo.sunFogExponent;
    sky.cloudOffsetMetres(cloudOff);
    const ag = atmoUniforms.atmoGrade.value;
    // the lift is display-space (fog runs after tone mapping); post-processing renders linear HDR
    const gt = atmo.gradeTint;
    ag[0] = atmo.gradeDesat;
    ag[1] = linearOut ? Math.pow(gt.r, 2.2) : gt.r;
    ag[2] = linearOut ? Math.pow(gt.g, 2.2) : gt.g;
    ag[3] = linearOut ? Math.pow(gt.b, 2.2) : gt.b;
    const ac = atmoUniforms.atmoCloud.value;
    ac[0] = atmo.cloudCover; ac[1] = cloudOff.x; ac[2] = cloudOff.y; ac[3] = atmo.cloudShadow;

    // lights
    const shadowsOn = quality.shadows && above < 600;
    lighting.update(atmo, shadowsOn);
    if (quality.shadows) lighting.fitShadow(camera, atmo.lightDir, quality.shadowDistance);
    renderer.toneMappingExposure = atmo.exposure;
    wind.set(weather.windX, weather.windZ);
    const fogOut = tmpColor;
    if (linearOut) fogOut.copy(atmo.fogColor); else atmo.fogColor.getRGB(fogOut, THREE.SRGBColorSpace);
    sky.update(atmo, camera, time, clock.absDay, wind, fogOut, sunFogOut, dt, renderer.getPixelRatio());

    // terrain shading uniforms
    const season = clock.season;
    const next = ((season + 1) % 4) as 0 | 1 | 2 | 3;
    const fol = palette.foliage;
    const seasonHex = [fol.spring, fol.summer, fol.autumn, fol.winter];
    const tint = terrain.uniforms.uGrassTint.value.setHex(seasonHex[season]).lerp(tmpColor.setHex(seasonHex[next]), smoothstep(0.6, 1, seasonProgress));
    const lum = tint.r * 0.2126 + tint.g * 0.7152 + tint.b * 0.0722;
    tint.multiplyScalar(1 / Math.max(1e-3, lum));
    // golden hour: open ground turns honey-gold instead of staying a dark green
    const goldenAmt = atmo.dusk * (1 - atmo.night) * (1 - atmo.overcast);
    if (goldenAmt > 0.001) tint.lerp(tmpColor.setRGB(1.75, 1.3, 0.5).multiplyScalar(1.12), goldenAmt * 0.85);
    terrain.uniforms.uGrassTintStrength.value = 0.38 + 0.4 * goldenAmt;
    terrain.uniforms.uSnowCover.value = weather.snowCover;
    const targetWet = clamp(weather.rain * 1.3, 0, 1);
    wetness += (targetWet - wetness) * (1 - Math.exp(-dt * (targetWet > wetness ? 0.25 : 0.04)));
    terrain.uniforms.uWetness.value = wetness;
    terrain.uniforms.uOverlayStrength.value = mapBlend * 0.92;
    terrain.uniforms.uSnowLine.value = snowLineBase * [0.86, 1.0, 0.9, 0.66][season];
    // canopy colour follows the seasonal foliage tint (darker: crowns are partly in shadow)
    terrain.uniforms.uCanopy.value.setHex(seasonHex[season]).lerp(tmpColor.setHex(seasonHex[next]), smoothstep(0.6, 1, seasonProgress)).multiplyScalar(0.42);
    terrain.uniforms.uCanopyDist.value = quality.vegFar;

    assets.setEnvironment({
      time, season: clock.season, seasonProgress, snowCover: weather.snowCover,
      windX: weather.windX, windZ: weather.windZ, nightLight: atmo.nightLight,
    });

    // culling frustum
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);

    // streaming (time-sliced)
    const budget = (opts.generationBudgetMs ?? quality.generationBudgetMs) * budgetScale;
    // one streaming budget per frame: terrain first (3/4), scatter, roads and fields share the rest
    let g = terrain.update(camera, frustum, budget * 0.75);
    terrainMs = g;
    g += vegetation.update(camera, Math.max(0.4 * budgetScale, budget - g));
    vegetation.setFelled(view.felledVersion(), view.felled());
    // angle of one screen pixel, so thin water ribbons can fade before they alias
    const pixelAngle = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, height * renderer.getPixelRatio());
    water.update(atmo, time, weather.rain, mapBlend, pixelAngle);
    g += roads.update(camera, Math.max(0.5 * budgetScale, budget - g));
    buildings.nightLight = atmo.nightLight * (1 - mapBlend);
    lastBuildings = view.buildings();
    const bfx = buildings.update(lastBuildings, view.buildingsVersion(), camera, time, dt, Math.max(1.5, budget * 0.6), budgetScale > 1);
    lastStrips = view.strips();
    const sv = view.stripsVersion();
    g += fields.update(lastStrips, sv, camera, Math.max(0.5 * budgetScale, budget - g), dt);
    genMs = g;

    // dynamic content
    const chars = view.characters();
    const animals = view.animals();
    lastChars = chars;
    lastAnimals = animals;
    const streetView = mapBlend < 0.98;
    dynamic.root.visible = streetView;
    dynamic.update(streetView ? chars : [], streetView ? animals : [], view.projectiles(), view.drainFx(), bfx, camera, dt);

    // results of work, beacons, floating gains, nameplates, hover outline
    const tf = performance.now();
    worldProps.root.visible = streetView;
    beacons.root.visible = streetView;
    hover.root.visible = streetView;
    worldProps.update(view.worldProps?.() ?? NO_PROPS, view.worldPropsVersion?.() ?? 0, dt);
    const pl = view.player();
    beacons.update(view.worldMarkers?.() ?? NO_MARKERS, camera, pl && pl.alive ? pl : null, dt, height, streetView && mapBlend < 0.5);
    const tfl = performance.now();
    const fl = view.drainFloaters?.();
    if (fl && fl.length && streetView) floaters.spawn(fl, camera);
    floaters.update(dt, camera, height);
    floaterMs = performance.now() - tfl;
    plates.update(streetView ? chars : [], camera, width, height, showLabels && mapBlend < 0.3);
    if (hoverKey && sv !== hoverStripsVer) { hoverStripsVer = sv; hover.refresh(); }
    hover.update(dt);
    feedbackMs = performance.now() - tf;
    precip.update(camera, dt, time, weather.rain, weather.snow, weather.windX, weather.windZ, 0.25 + 0.75 * atmo.day, renderer.getPixelRatio() * height / 1080, above);
    mapLabels.update(camera.position.y, heightAt, mapBlend > 0.02 ? view.mapMarkers() : [], mapBlend);

    // draw
    if (!draw) return;
    renderer.info.reset();
    if (post) {
      post.update(atmo.dusk, atmo.night);
      post.render(dt);
    } else {
      renderer.render(scene, camera);
    }
    // floating texts over everything, untouched by fog, bloom or tone mapping
    if (floaters.active > 0) {
      renderer.autoClear = false;
      renderer.render(floaters.scene, camera);
      renderer.autoClear = true;
    }
    if (showLabels) labelRenderer.render(overlayScene, camera);

    const ms = performance.now() - t0;
    frameMsAvg = frameMsAvg * 0.9 + ms * 0.1;
    if (dt > 0) fpsAvg = fpsAvg * 0.92 + (1 / dt) * 0.08;
  }

  function screenRay(x: number, y: number): THREE.Ray {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray;
  }

  function groundHit(ray: THREE.Ray, maxDist = 30000): { point: THREE.Vector3; distance: number } | null {
    const f = (t: number) => {
      const x = ray.origin.x + ray.direction.x * t, z = ray.origin.z + ray.direction.z * t;
      return ray.origin.y + ray.direction.y * t - Math.max(heightAt(x, z), 0);
    };
    let t0 = 0, f0 = f(0);
    if (f0 < 0) return null;
    let t = 0.5;
    while (t < maxDist) {
      const ft = f(t);
      if (ft <= 0) {
        let a = t0, b = t;
        for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; }
        const tm = (a + b) / 2;
        return { point: ray.at(tm, new THREE.Vector3()), distance: tm };
      }
      t0 = t; f0 = ft;
      t += Math.max(0.5, t * 0.02);
    }
    void f0;
    return null;
  }

  resize();
  setQuality(quality.level);
  const onResize = () => resize();
  window.addEventListener('resize', onResize);

  const api: GameRenderer = {
    domElement: renderer.domElement,
    render(view: SimView, dt: number): void {
      if (disposed) return;
      frame(view, dt, 1);
    },
    setCameraMode(mode: CameraMode): void { rig.setMode(mode); },
    getCameraMode(): CameraMode { return rig.mode; },
    orbit(dYaw: number, dPitch: number): void { rig.orbit(dYaw, dPitch); },
    zoom(steps: number): void { rig.zoom(steps); },
    pan(dx: number, dy: number): void { rig.pan(dx, dy, height); },
    moveFree(f: number, r: number, u: number, dt: number, fast?: boolean): void { rig.moveFree(f, r, u, dt, fast); },
    getCameraYaw(): number { return rig.getYaw(); },
    setCameraPose(position: GroundPoint, lookAt: GroundPoint, transitionSeconds = 0): void { rig.setPose(position, lookAt, transitionSeconds); },
    focusMap(x: number, z: number, altitude?: number): void { rig.focusMap(x, z, altitude); },
    getCamera(): THREE.PerspectiveCamera { return camera; },
    debugBreakdown() {
      const draw = () => {
        renderer.info.reset();
        if (post) post.render(0); else renderer.render(scene, camera);
        return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      };
      const all = draw();
      const out: Record<string, { calls: number; triangles: number }> = { total: all };
      const groups: [string, THREE.Object3D][] = [
        ['terrain', terrain.root], ['water', water.root], ['roads', roads.root], ['vegetation', vegetation.root],
        ['buildings', buildings.root], ['fields', fields.root], ['dynamic', dynamic.root], ['sky', sky.dome],
        ['props', worldProps.root], ['beacons', beacons.root], ['hover', hover.root],
      ];
      for (const [name, obj] of groups) {
        const was = obj.visible;
        obj.visible = false;
        const r = draw();
        obj.visible = was;
        out[name] = { calls: all.calls - r.calls, triangles: all.triangles - r.triangles };
      }
      draw();
      return out;
    },
    screenToGround(x: number, y: number): GroundPoint | null {
      const hit = groundHit(screenRay(x, y));
      return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null;
    },
    pick(x: number, y: number): PickResult {
      const ray = screenRay(x, y);
      const ground = groundHit(ray);
      const bHit = buildings.raycast(ray, ground ? ground.distance : 3000);
      const limit = Math.min(bHit ? bHit.distance : Infinity, ground ? ground.distance + 1 : Infinity);
      const cid = dynamic.characters.pick(raycaster);
      if (cid >= 0) {
        const c = lastChars.find((it) => it.id === cid);
        const d = c ? ray.origin.distanceTo(new THREE.Vector3(c.x, c.y + 1, c.z)) : 0;
        if (d <= limit + 1) return { type: 'character', id: cid, point: c ? { x: c.x, y: c.y, z: c.z } : undefined };
      }
      const aid = dynamic.animals.pick(raycaster);
      if (aid >= 0) {
        const a = lastAnimals.find((it) => it.id === aid);
        const d = a ? ray.origin.distanceTo(new THREE.Vector3(a.x, a.y + 0.5, a.z)) : 0;
        if (d <= limit + 1) return { type: 'animal', id: aid, point: a ? { x: a.x, y: a.y, z: a.z } : undefined };
      }
      if (bHit && (!ground || bHit.distance <= ground.distance)) {
        const p = ray.at(bHit.distance, new THREE.Vector3());
        return { type: 'building', id: bHit.id, point: { x: p.x, y: p.y, z: p.z } };
      }
      if (ground) return { type: 'ground', point: { x: ground.point.x, y: ground.point.y, z: ground.point.z } };
      return { type: 'none' };
    },
    setHover(target: HoverTarget | null): void {
      const key = target ? `${target.kind}:${target.id ?? ''}` : '';
      if (key === hoverKey) return;
      hoverKey = key;
      const id = target?.id ?? -1;
      dynamic.hoverPerson = target?.kind === 'person' ? id : -1;
      dynamic.hoverAnimal = target?.kind === 'animal' ? id : -1;
      plates.focusId = target?.kind === 'person' ? id : -1;
      hover.set(target && target.kind !== 'person' && target.kind !== 'animal' ? target : null);
    },
    setQuality,
    getQuality(): QualityLevel { return quality.level; },
    resize,
    settle(view: SimView, maxMs = 20000): void {
      const t0 = performance.now();
      // finish camera transitions, let the follow camera converge, then stream everything the
      // final view needs, without drawing
      frame(view, 0, 1, false);
      rig.skipTransition();
      for (let i = 0; i < 4; i++) frame(view, 0.25, 1, false);
      for (let i = 0; i < 3; i++) {
        terrain.settle(camera, frustum, Math.max(100, maxMs - (performance.now() - t0)));
        vegetation.settle(camera, Math.max(100, maxMs - (performance.now() - t0)));
        frame(view, 0, 40, false);
        fields.settle(camera);
        if (terrain.pending === 0 || performance.now() - t0 > maxMs) break;
      }
      for (let i = 0; i < 4; i++) frame(view, 0, 40, false);
      // bodies are built a few per frame in play; build them all now
      dynamic.warm(view.characters(), view.animals(), camera, 60);
      // a few seconds of animation so chimney smoke, mill wheels and flags have settled in
      for (let i = 0; i < 30; i++) frame(view, 0.1, 1, false);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('resize', onResize);
      post?.dispose();
      terrain.dispose();
      water.dispose();
      vegetation.dispose();
      buildings.dispose();
      fields.dispose();
      roads.dispose();
      dynamic.dispose();
      worldProps.dispose();
      beacons.dispose();
      floaters.dispose();
      plates.dispose();
      hover.dispose();
      precip.dispose();
      mapLabels.dispose();
      overlayTex.dispose();
      mapBaseTex.dispose();
      sky.dispose();
      lighting.dispose();
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
    },
    stats(): RenderStats {
      return {
        fps: fpsAvg,
        frameMs: frameMsAvg,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        chunks: terrain.drawn,
        chunksCached: terrain.cached,
        chunksPending: terrain.pending,
        chunkBuildMs: terrain.avgBuildMs,
        chunkBuildMaxMs: terrain.maxBuildMs,
        generationMs: genMs,
        terrainGenMs: terrainMs,
        vegetationInstances: vegetation.instances,
        vegetationChunks: vegetation.loadedChunks,
        buildings: buildings.count,
        buildingsDetailed: buildings.detailedCount,
        cropInstances: fields.cropInstances,
        cameraMode: rig.mode,
        quality: quality.level,
        worldProps: worldProps.count,
        beacons: beacons.drawn,
        floaters: floaters.active,
        nameplates: plates.shown,
        workingStrips: fields.workingStrips,
        feedbackMs,
        floaterMs,
      };
    },
  };
  return api;
}
