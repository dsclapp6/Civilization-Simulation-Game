// Asset gallery (?mode=gallery): browse buildings, vegetation, crops, props and FX under the
// nominal game lighting, with culture/level/construction/damage, season/time/wind/snow controls
// and contact sheets. URL parameters reproduce any view (used by tools/gallery-shots.mjs).
import * as THREE from 'three';
import type { AppRoot } from '../main';
import { BUILDINGS, BUILDING_KINDS, type BuildingKind } from '../content/types';
import { CULTURES, type CropKind, type CultureId } from '../core/domain';
import type { Season } from '../core/time';
import { SEASON_NAMES } from '../core/time';
import type { ScatterKind } from '../world/types';
import type { PropKind } from '../assets/types';
import { createAssetLibrary } from '../assets/library';
import { PROP_KINDS } from '../assets/props/props';
import { CROP_KINDS } from '../assets/crops';
import { computeLighting, createStage } from './stage';
import { checkbox, el, injectCss, LabelLayer, select, slider } from './ui';
import {
  CATEGORIES, SCATTER_KINDS, decalSnow, disposeView, sheetCrops, sheetCulture, sheetCultures, sheetLevels, sheetProps, sheetStates,
  sheetVegetation, sheetVegLods, viewBuilding, viewCrop, viewFx, viewProp, viewVegetation, viewVillage, type ViewState,
} from './views';

type Cat = 'buildings' | 'vegetation' | 'crops' | 'props' | 'fx' | 'sheets';
const SHEETS = [
  'culture-home', 'culture-farm', 'culture-work', 'culture-social', 'culture-church', 'culture-defence',
  'levels', 'cultures', 'states', 'vegetation-seasons', 'vegetation-lods', 'crops', 'props', 'fx', 'village', 'village-night', 'village-winter',
] as const;

interface Params {
  cat: Cat; item: string; sheet: string;
  culture: CultureId; level: number; construction: number; damage: number; owner: number; seed: number;
  season: Season; sp: number; time: number; wind: number; snow: number; lod: 0 | 1 | 2;
  shot: boolean; shadows: boolean; az?: number; el?: number; k?: number; autoRotate: boolean;
  /** Lighting experiment multipliers (1 = nominal). */
  hemiK: number; sunK: number;
}

function parse(p: URLSearchParams): Params {
  const num = (k: string, d: number) => (p.has(k) ? Number(p.get(k)) : d);
  const culture = (p.get('culture') ?? 'anglo') as CultureId;
  return {
    cat: (p.get('cat') ?? 'buildings') as Cat,
    item: p.get('item') ?? 'cottage',
    sheet: p.get('sheet') ?? 'village',
    culture: CULTURES.includes(culture) ? culture : 'anglo',
    level: num('level', 1), construction: num('construction', 1), damage: num('damage', 0),
    owner: p.has('owner') ? parseInt(p.get('owner')!, 16) : 0xa8302a, seed: num('seed', 1),
    season: Math.max(0, Math.min(3, Math.round(num('season', 1)))) as Season, sp: num('sp', 0.5),
    time: num('time', 0.42), wind: num('wind', 3), snow: num('snow', -1), lod: Math.max(0, Math.min(2, num('lod', 0))) as 0 | 1 | 2,
    shot: p.get('shot') === '1', shadows: p.get('shadows') !== '0',
    az: p.has('az') ? num('az', 0) : undefined, el: p.has('el') ? num('el', 0) : undefined, k: p.has('k') ? num('k', 1) : undefined,
    autoRotate: p.get('rotate') === '1',
    hemiK: num('hemi', 1), sunK: num('sun', 1),
  };
}

export function start(root: AppRoot): void {
  injectCss();
  const P = parse(root.params);
  const stage = createStage(root.viewport);
  const lib = createAssetLibrary();
  const labels = new LabelLayer(root.ui);
  let view: ViewState | null = null;
  const win = window as unknown as { __galleryReady?: boolean; __galleryStats?: unknown };
  win.__galleryReady = false;
  (window as unknown as { __galleryDebug?: unknown }).__galleryDebug = { stage, lib };

  const content = stage.content;
  const effSnow = () => (P.snow >= 0 ? P.snow : P.season === 3 ? 0.85 : 0);

  function build(): void {
    if (view) disposeView(view);
    content.clear();
    labels.clear();
    const o = { culture: P.culture, level: P.level, construction: P.construction, damage: P.damage, owner: P.owner, seed: P.seed };
    const kind = (BUILDING_KINDS.includes(P.item as BuildingKind) ? P.item : 'cottage') as BuildingKind;
    switch (P.cat) {
      case 'buildings': view = viewBuilding(lib, content, kind, o); break;
      case 'vegetation': view = viewVegetation(lib, content, (SCATTER_KINDS.includes(P.item as ScatterKind) ? P.item : 'oak') as ScatterKind, P.lod); break;
      case 'crops': view = viewCrop(lib, content, (CROP_KINDS.includes(P.item as CropKind) ? P.item : 'wheat') as CropKind); break;
      case 'props': view = viewProp(lib, content, (PROP_KINDS.includes(P.item as PropKind) ? P.item : 'cart') as PropKind, P.seed); break;
      case 'fx': view = viewFx(lib, content); break;
      default: {
        const s = P.sheet;
        const base = { construction: P.construction, damage: P.damage, owner: P.owner, seed: P.seed };
        if (s.startsWith('culture-')) {
          const g = s.slice(8);
          const cats = g === 'social' ? ['social', 'trade', 'civic'] : g === 'defence' ? ['defence', 'camp'] : [g];
          view = sheetCulture(lib, content, P.culture, cats as never, base, P.level !== 1 || !root.params.has('level'));
        } else if (s === 'levels') view = sheetLevels(lib, content, kind, [...CULTURES], base);
        else if (s === 'cultures') view = sheetCultures(lib, content, kind, P.level, base);
        else if (s === 'states') view = sheetStates(lib, content, kind, P.culture, P.level, { owner: P.owner, seed: P.seed });
        else if (s === 'vegetation-seasons') view = sheetVegetation(lib, content, true, P.lod);
        else if (s === 'vegetation-lods') view = sheetVegLods(lib, content);
        else if (s === 'crops') view = sheetCrops(lib, content);
        else if (s === 'props') view = sheetProps(lib, content);
        else if (s === 'fx') view = viewFx(lib, content);
        else view = viewVillage(lib, content, P.culture, { owner: P.owner });
      }
    }
    if (P.cat === 'sheets' && P.sheet === 'village-night') { P.time = 0.9; }
    if (P.cat === 'sheets' && P.sheet === 'village-winter') { P.season = 3; P.sp = 0.4; }
    labels.set(view.labels);
    frameCamera();
    stage.fit(view.bounds);
    updateStats();
    caption.textContent = view.title;
  }

  function frameCamera(): void {
    if (!view) return;
    const box = view.bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 5, 5)) : view.bounds;
    const c = view.cam ?? { az: -30, el: 25, k: 1 };
    const centre = c.target ? c.target.clone() : box.getCenter(new THREE.Vector3());
    if (!c.target) centre.y = Math.min(centre.y, box.max.y * 0.4);
    const az = ((P.az ?? c.az) * Math.PI) / 180, elv = ((P.el ?? c.el) * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elv), Math.sin(elv), Math.cos(az) * Math.cos(elv));
    // Fit: the smallest distance at which all 8 box corners project inside ~88% of the view.
    const corners: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const cam = stage.camera;
    // Wide frustum during the search so the predicate is monotonic in distance.
    cam.near = 0.05;
    cam.far = 1e7;
    cam.updateProjectionMatrix();
    const fits = (d: number) => {
      cam.position.copy(centre).addScaledVector(dir, d);
      cam.lookAt(centre);
      cam.updateMatrixWorld();
      for (const p of corners) {
        const v = p.clone().project(cam);
        if (v.z > 1 || Math.abs(v.x) > 0.88 || Math.abs(v.y) > 0.86) return false;
      }
      return true;
    };
    let lo = 0.5, hi = 20000;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
    const dist = hi * (P.k ?? c.fit ?? 1);
    stage.controls.target.copy(centre);
    stage.camera.position.copy(centre).addScaledVector(dir, dist);
    stage.camera.near = Math.max(0.1, dist / 400);
    stage.camera.far = Math.max(4000, dist * 20);
    stage.camera.updateProjectionMatrix();
    stage.controls.update();
  }

  // ---------- UI ----------
  const left = el('div', 'gal-panel gal-left');
  const right = el('div', 'gal-panel gal-right');
  const caption = el('div', 'gal-caption');
  root.ui.append(left, right, caption);
  if (P.shot) { left.style.display = 'none'; right.style.display = 'none'; }
  else caption.style.display = 'none';

  function rebuildUi(): void {
    left.innerHTML = '';
    left.appendChild(el('h1', undefined, 'Millennia'));
    left.appendChild(el('div', 'gal-sub', 'Asset gallery'));
    const tabs = el('div', 'gal-tabs');
    (['buildings', 'vegetation', 'crops', 'props', 'fx', 'sheets'] as Cat[]).forEach((c) => {
      const t = el('button', `gal-tab${P.cat === c ? ' on' : ''}`, c);
      t.onclick = () => { P.cat = c; if (c === 'vegetation') P.item = 'oak'; if (c === 'crops') P.item = 'wheat'; if (c === 'props') P.item = 'cart'; if (c === 'buildings') P.item = 'cottage'; rebuildUi(); build(); };
      tabs.appendChild(t);
    });
    left.appendChild(tabs);
    const list = el('div', 'gal-list');
    let items: string[] = [];
    if (P.cat === 'buildings') {
      for (const cat of CATEGORIES) {
        list.appendChild(el('h2', undefined, cat));
        for (const k of BUILDING_KINDS.filter((x) => BUILDINGS[x].cat === cat)) list.appendChild(itemButton(k, BUILDINGS[k].name));
      }
    } else if (P.cat === 'sheets') {
      for (const s of SHEETS) {
        const b = el('button', `gal-item${P.sheet === s ? ' on' : ''}`, s);
        b.onclick = () => { P.sheet = s; rebuildUi(); build(); };
        list.appendChild(b);
      }
    } else {
      items = P.cat === 'vegetation' ? SCATTER_KINDS : P.cat === 'crops' ? CROP_KINDS : P.cat === 'props' ? PROP_KINDS : [];
      for (const k of items) list.appendChild(itemButton(k, k.replace('_', ' ')));
    }
    left.appendChild(list);

    right.innerHTML = '';
    if (P.cat === 'buildings' || P.cat === 'sheets') {
      right.appendChild(el('h2', undefined, 'Building'));
      select(right, 'Culture', [...CULTURES], P.culture, (v) => { P.culture = v as CultureId; build(); });
      const kind = (BUILDING_KINDS.includes(P.item as BuildingKind) ? P.item : 'cottage') as BuildingKind;
      if (P.cat === 'sheets') select(right, 'Kind', BUILDING_KINDS, kind, (v) => { P.item = v; build(); });
      slider(right, 'Level', 1, 3, 1, P.level, (v) => { P.level = v; build(); }, (v) => String(v));
      slider(right, 'Construction', 0, 1, 0.05, P.construction, (v) => { P.construction = v; build(); });
      slider(right, 'Damage', 0, 1, 0.25, P.damage, (v) => { P.damage = v; build(); });
      slider(right, 'Seed', 0, 3, 1, P.seed, (v) => { P.seed = v; build(); }, (v) => String(v));
      const row = el('div', 'gal-row'); row.appendChild(el('label', undefined, 'Owner'));
      const ci = el('input'); ci.type = 'color'; ci.value = `#${P.owner.toString(16).padStart(6, '0')}`;
      ci.oninput = () => { P.owner = parseInt(ci.value.slice(1), 16); build(); };
      row.appendChild(ci); right.appendChild(row);
    }
    if (P.cat === 'vegetation') {
      right.appendChild(el('h2', undefined, 'Vegetation'));
      slider(right, 'LOD', 0, 2, 1, P.lod, (v) => { P.lod = v as 0; build(); }, (v) => String(v));
    }
    right.appendChild(el('h2', undefined, 'Environment'));
    select(right, 'Season', [...SEASON_NAMES], SEASON_NAMES[P.season], (v) => { P.season = SEASON_NAMES.indexOf(v as never) as Season; });
    slider(right, 'Progress', 0, 1, 0.05, P.sp, (v) => { P.sp = v; });
    slider(right, 'Time', 0, 1, 0.005, P.time, (v) => { P.time = v; }, (v) => { const h = Math.floor(v * 24), m = Math.floor((v * 24 - h) * 60); return `${h}:${String(m).padStart(2, '0')}`; });
    slider(right, 'Wind m/s', 0, 14, 0.5, P.wind, (v) => { P.wind = v; });
    slider(right, 'Snow', -1, 1, 0.05, P.snow, (v) => { P.snow = v; }, (v) => (v < 0 ? 'auto' : v.toFixed(2)));
    checkbox(right, 'Shadows', P.shadows, (v) => { P.shadows = v; });
    checkbox(right, 'Rotate', P.autoRotate, (v) => { P.autoRotate = v; });
    const wire = checkbox(right, 'Wireframe', false, (v) => {
      content.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m && 'wireframe' in m) m.wireframe = v; });
    });
    void wire;
    right.appendChild(el('h2', undefined, 'Stats'));
    right.appendChild(statsEl);
  }
  const statsEl = el('div', 'gal-stats');
  function itemButton(k: string, label: string): HTMLButtonElement {
    const b = el('button', `gal-item${P.item === k ? ' on' : ''}`, label);
    b.onclick = () => { P.item = k; rebuildUi(); build(); };
    return b;
  }
  function updateStats(): void {
    if (!view) return;
    const tris = view.buildings.reduce((s, b) => s + b.triangles, 0);
    const info = stage.renderer.info;
    const txt = `buildings ${view.buildings.length}\nbuilding tris ${tris}\ndraw calls ${info.render.calls}\nframe tris ${info.render.triangles}\ngeometries ${info.memory.geometries}\nprograms ${info.programs?.length ?? 0}\ncache ${lib.cacheSize()}`;
    statsEl.textContent = txt;
    win.__galleryStats = { buildings: view.buildings.length, buildingTris: tris, calls: info.render.calls, frameTris: info.render.triangles, perBuilding: view.buildings.map((b) => b.triangles) };
  }

  rebuildUi();
  build();
  window.addEventListener('resize', () => { stage.resize(); frameCamera(); });

  // ---------- loop ----------
  let last = performance.now();
  let t = 0;
  let frames = 0;
  const seasonLabels: HTMLDivElement[] = [];
  function render(): void {
    const now = performance.now();
    const dt = P.shot ? 1 / 30 : Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    stage.controls.autoRotate = P.autoRotate;
    stage.controls.update();
    stage.renderer.shadowMap.enabled = P.shadows;
    const v = view!;
    const seasons: Season[] = v.seasonSplit ?? [P.season];
    const W = stage.renderer.domElement.clientWidth, H = stage.renderer.domElement.clientHeight;
    // Fire FX emitters
    if (v.fx) {
      for (const em of v.fx.emitters) {
        em.next -= dt;
        if (em.next <= 0) { v.fx.layer.emit([em.e]); em.next += em.every; }
      }
    }
    const split = seasons.length > 1;
    stage.renderer.setScissorTest(split);
    while (seasonLabels.length < seasons.length) { const d = el('div', 'gal-season'); root.ui.appendChild(d); seasonLabels.push(d); }
    seasonLabels.forEach((d, i) => { d.style.display = split && i < seasons.length ? 'block' : 'none'; });
    seasons.forEach((season, i) => {
      const l = computeLighting(P.time, season);
      l.hemiIntensity *= P.hemiK;
      l.sunIntensity *= P.sunK;
      stage.applyLighting(l);
      const snow = P.snow >= 0 ? P.snow : season === 3 ? 0.85 : 0;
      lib.setEnvironment({ time: t, season, seasonProgress: P.sp, snowCover: snow, windX: P.wind * 0.8, windZ: P.wind * 0.6, nightLight: l.night });
      stage.setGroundSnow(snow);
      decalSnow.value = snow;
      for (const b of v.buildings) { b.update?.(t, i === 0 ? dt : 0); b.setLit?.(1); }
      if (i === 0) v.fx?.layer.update(dt, stage.camera);
      if (split) {
        const cols = 2, rows = Math.ceil(seasons.length / 2);
        const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
        const x = (i % cols) * cw, y = H - (Math.floor(i / cols) + 1) * ch;
        stage.renderer.setViewport(x, y, cw, ch);
        stage.renderer.setScissor(x, y, cw, ch);
        stage.camera.aspect = cw / ch;
        stage.camera.updateProjectionMatrix();
        const d = seasonLabels[i];
        d.textContent = SEASON_NAMES[season];
        d.style.left = `${x + 12}px`;
        d.style.top = `${H - y - ch + 10}px`;
      }
      stage.renderer.render(stage.scene, stage.camera);
    });
    if (split) { stage.renderer.setViewport(0, 0, W, H); stage.camera.aspect = W / H; stage.camera.updateProjectionMatrix(); }
    if (!split) labels.update(stage.camera, W, H);
    void effSnow;
    frames++;
    if (frames % 20 === 1) updateStats();
    const need = v.fx ? 75 : 3;
    if (frames === need) { updateStats(); win.__galleryReady = true; }
    requestAnimationFrame(render);
  }
  root.ready();
  requestAnimationFrame(render);
}
