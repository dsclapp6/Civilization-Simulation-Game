// Characters gallery (?mode=chars): rank lineup, faces, every animation, riders and gaits,
// action vignettes, crowd stress test (300 people + 150 animals) and the animal pen.
// URL params: scene, anim, gait, aanim, tod (0..1), seed, cam (vignette or "px,py,pz,tx,ty,tz"),
// shot (deterministic capture: simulate `t` seconds at 30 fps, render once, set window.__charsReady).
import * as THREE from 'three';
import type { AppRoot } from '../main';
import type { AnimalAnim, AnimState, HorseAnim } from '../core/view';
import { PALETTE } from '../assets/palette';
import { createCharacterLayer } from '../assets/characters/layer';
import { createAnimalLayer } from '../assets/animals/layer';
import { createStage } from './characters/env';
import { ALL_ANIMAL_ANIMS, ALL_ANIMS, buildScene, type SceneDef, type SceneOptions, VIGNETTES } from './characters/scenes';

type LayerStats = { updateMs: number; animated: number; culled: number; built: number };

declare global {
  interface Window {
    __charsReady?: boolean;
    __chars?: { stats(): Record<string, number>; frame(dt?: number): void; setCamera(p: number[], t: number[]): void };
  }
}

const SCENES = ['lineup', 'faces', 'anims', 'riders', 'action', 'crowd', 'animals'] as const;

export function start(root: AppRoot): void {
  const params = root.params;
  const shot = params.get('shot');
  const stage = createStage(root.viewport, shot ? 1 : undefined);
  const { renderer, scene, camera, controls } = stage;
  const chars = createCharacterLayer(PALETTE) as ReturnType<typeof createCharacterLayer> & { stats: LayerStats; options: { buildBudgetMs: number; lod: boolean; animLod: boolean }; crowd: { stats(): { vertices: number; triangles: number } } };
  const animals = createAnimalLayer(PALETTE) as ReturnType<typeof createAnimalLayer> & { stats: LayerStats; options: { buildBudgetMs: number; animLod: boolean }; crowd: { stats(): { vertices: number; triangles: number } } };
  if (shot) { chars.options.buildBudgetMs = Infinity; animals.options.buildBudgetMs = Infinity; }
  if (params.get('lod') === '0') chars.options.lod = false;
  if (params.get('animlod') === '0') { chars.options.animLod = false; animals.options.animLod = false; }
  let benchStats: Record<string, number> = {};
  scene.add(chars.object, animals.object);

  const opts: SceneOptions = {
    seed: Number(params.get('seed') ?? 3),
    anim: (params.get('anim') as AnimState | null) ?? '',
    gait: (params.get('gait') as HorseAnim | null) ?? 'walk',
    animalAnim: (params.get('aanim') as AnimalAnim | null) ?? '',
    armour: params.get('armour') !== '0',
    items: params.get('items') !== '0',
    count: params.get('count') ? Number(params.get('count')) : undefined,
    animals: params.get('animals') ? Number(params.get('animals')) : undefined,
  };
  let sceneName: string = params.get('scene') ?? 'lineup';
  let current: SceneDef | null = null;
  const propGroup = new THREE.Group();
  scene.add(propGroup);
  let simTime = 0;

  // ---------------------------------------------------------------- labels
  const labelLayer = document.createElement('div');
  labelLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;';
  root.ui.appendChild(labelLayer);
  let labelEls: HTMLDivElement[] = [];
  function buildLabels(): void {
    labelLayer.innerHTML = '';
    labelEls = [];
    for (const l of current?.labels ?? []) {
      const el = document.createElement('div');
      el.textContent = l.text;
      el.style.cssText = `position:absolute;transform:translate(-50%,-50%);white-space:nowrap;font:${l.small ? '12px' : 'bold 14px'} Georgia,serif;color:${l.small ? '#3b2d1c' : '#2a1c0c'};text-shadow:0 0 4px #f4ead2,0 0 2px #f4ead2;`;
      labelLayer.appendChild(el);
      labelEls.push(el);
    }
  }
  const _lp = new THREE.Vector3();
  function placeLabels(): void {
    const ls = current?.labels ?? [];
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    for (let i = 0; i < ls.length; i++) {
      _lp.set(ls[i].x, ls[i].y, ls[i].z).project(camera);
      const el = labelEls[i];
      if (_lp.z > 1 || _lp.z < -1) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.left = `${(_lp.x * 0.5 + 0.5) * w}px`;
      el.style.top = `${(-_lp.y * 0.5 + 0.5) * h}px`;
    }
  }

  function setCam(pos: readonly number[], target: readonly number[]): void {
    camera.position.set(pos[0], pos[1], pos[2]);
    controls.target.set(target[0], target[1], target[2]);
    camera.lookAt(controls.target);
    controls.update();
  }

  function load(name: string): void {
    sceneName = name;
    current = buildScene(name, opts);
    propGroup.clear();
    for (const p of current.props) propGroup.add(p);
    setCam(current.camera.pos, current.camera.target);
    const camParam = params.get('cam');
    if (camParam) {
      const v = VIGNETTES.find((x) => x.name === camParam);
      if (v) { setCam(v.cam.pos, v.cam.target); stage.setShadowFocus(v.cam.target[0], v.cam.target[2], 8); }
      else {
        const n = camParam.split(',').map(Number);
        if (n.length === 6 && n.every(Number.isFinite)) setCam(n.slice(0, 3), n.slice(3));
      }
    }
    if (!camParam || !VIGNETTES.find((x) => x.name === camParam)) stage.setShadowFocus(current.shadow.x, current.shadow.z, current.shadow.r);
    buildLabels();
    simTime = 0;
    refreshUi();
  }

  // ---------------------------------------------------------------- simulation step
  const charItems = (): SceneDef['chars'][number]['item'][] => current!.chars.map((c) => c.item);
  let charList = [] as ReturnType<typeof charItems>;
  let animalList = [] as SceneDef['animals'][number]['item'][];
  function step(dt: number): void {
    if (!current) return;
    simTime += dt;
    for (const c of current.chars) c.tick?.(simTime, dt);
    for (const a of current.animals) a.tick?.(simTime, dt);
    charList = current.chars.map((c) => c.item);
    animalList = current.animals.map((a) => a.item);
    chars.update(charList, dt, camera);
    animals.update(animalList, dt, camera);
  }

  // ---------------------------------------------------------------- UI
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:10px;top:10px;width:260px;padding:10px 12px;background:rgba(244,234,210,0.93);color:#2a1c0c;border:1px solid #8a6a3a;border-radius:6px;font:13px Georgia,serif;box-shadow:0 2px 10px rgba(0,0,0,0.3);max-height:94vh;overflow:auto;';
  const statsEl = document.createElement('div');
  statsEl.style.cssText = 'position:fixed;right:10px;top:10px;padding:8px 10px;background:rgba(20,16,10,0.72);color:#f4ead2;font:12px monospace;border-radius:5px;white-space:pre;';
  if (!shot) { root.ui.appendChild(panel); root.ui.appendChild(statsEl); }
  function select(label: string, values: readonly string[], value: string, onChange: (v: string) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:block;margin:6px 0;';
    wrap.textContent = label + ' ';
    const s = document.createElement('select');
    s.style.cssText = 'width:100%;font:13px Georgia,serif;background:#fbf5e6;border:1px solid #8a6a3a;';
    for (const v of values) { const o = document.createElement('option'); o.value = v; o.textContent = v || '(default)'; s.appendChild(o); }
    s.value = value;
    s.onchange = () => onChange(s.value);
    wrap.appendChild(s);
    return wrap;
  }
  function button(label: string, onClick: () => void): HTMLElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:4px 4px 4px 0;font:13px Georgia,serif;background:#e8d6aa;border:1px solid #8a6a3a;border-radius:4px;padding:3px 8px;cursor:pointer;';
    b.onclick = onClick;
    return b;
  }
  function check(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const l = document.createElement('label');
    l.style.cssText = 'display:inline-block;margin:4px 10px 4px 0;';
    const c = document.createElement('input');
    c.type = 'checkbox'; c.checked = value; c.onchange = () => onChange(c.checked);
    l.appendChild(c); l.append(' ' + label);
    return l;
  }
  function refreshUi(): void {
    panel.innerHTML = '<div style="font:bold 16px Georgia,serif;margin-bottom:4px;color:#6a1a1a">Millennia — People &amp; Beasts</div>';
    panel.appendChild(select('Scene', SCENES, sceneName, (v) => load(v)));
    if (sceneName === 'lineup' || sceneName === 'faces') {
      panel.appendChild(select('Animation', ['', ...ALL_ANIMS], opts.anim ?? '', (v) => { opts.anim = v as AnimState; load(sceneName); }));
    }
    if (sceneName === 'riders') {
      panel.appendChild(select('Gait', ['idle', 'walk', 'trot', 'gallop', 'rear', 'graze', 'fall', 'dead'], opts.gait ?? 'walk', (v) => { opts.gait = v as HorseAnim; load(sceneName); }));
    }
    if (sceneName === 'animals') {
      panel.appendChild(select('Animal animation', ['', ...ALL_ANIMAL_ANIMS], opts.animalAnim ?? '', (v) => { opts.animalAnim = v as AnimalAnim; load(sceneName); }));
    }
    if (sceneName === 'action') {
      panel.appendChild(select('Vignette', VIGNETTES.map((v) => v.name), VIGNETTES[0]?.name ?? '', (v) => {
        const vg = VIGNETTES.find((x) => x.name === v);
        if (vg) { setCam(vg.cam.pos, vg.cam.target); stage.setShadowFocus(vg.cam.target[0], vg.cam.target[2], 8); }
      }));
    }
    const row = document.createElement('div');
    row.appendChild(check('armour', opts.armour !== false, (v) => { opts.armour = v; load(sceneName); }));
    row.appendChild(check('held items', opts.items !== false, (v) => { opts.items = v; load(sceneName); }));
    panel.appendChild(row);
    panel.appendChild(button('Randomise looks', () => { opts.seed = (opts.seed * 7 + 13) % 9973; load(sceneName); }));
    panel.appendChild(button('Highlight', () => {
      const cs = current?.chars ?? [];
      cs.forEach((c, i) => { c.item.highlight = (((c.item.highlight + 1) % 4) as 0 | 1 | 2 | 3); if (i > 3) c.item.highlight = 0; });
    }));
    const tl = document.createElement('label');
    tl.style.cssText = 'display:block;margin:8px 0 2px;';
    tl.textContent = 'Time of day';
    const ts = document.createElement('input');
    ts.type = 'range'; ts.min = '0'; ts.max = '1'; ts.step = '0.005'; ts.value = String(params.get('tod') ?? 0.42); ts.style.width = '100%';
    ts.oninput = () => stage.setTimeOfDay(Number(ts.value));
    tl.appendChild(ts);
    panel.appendChild(tl);
    const help = document.createElement('div');
    help.style.cssText = 'margin-top:6px;font-size:11px;color:#5a4a30;';
    help.textContent = 'Drag to orbit, wheel to zoom. Click a person or animal to select.';
    panel.appendChild(help);
  }

  // picking
  const ray = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(v, camera);
    const id = chars.pick(ray), aid = animals.pick(ray);
    for (const c of current?.chars ?? []) c.item.highlight = c.item.id === id ? 2 : 0;
    for (const a of current?.animals ?? []) a.item.highlight = a.item.id === aid && id < 0 ? 2 : 0;
  });

  stage.setTimeOfDay(Number(params.get('tod') ?? 0.42));
  load(sceneName);

  const statsNow = (): Record<string, number> => ({
    ...benchStats,
    charTris: chars.crowd.stats().triangles,
    animalTris: animals.crowd.stats().triangles,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    charMs: chars.stats.updateMs,
    animalMs: animals.stats.updateMs,
    characters: charList.length,
    animals: animalList.length,
    charAnimated: chars.stats.animated,
    animalAnimated: animals.stats.animated,
  });
  window.__chars = {
    stats: statsNow,
    frame: (dt = 1 / 30) => { step(dt); renderer.render(scene, camera); },
    setCamera: (p, t) => setCam(p, t),
  };

  if (shot) {
    // deterministic capture
    const T = Number(params.get('t') ?? 1.0);
    const dt = 1 / 30;
    const n = Math.max(1, Math.round(T / dt));
    for (let i = 0; i < n; i++) step(dt);
    const bench = Number(params.get('bench') ?? 0);
    if (bench > 0) {
      // CPU cost of the two layers' update() at 60 Hz (rendering excluded)
      const cs: number[] = [], as: number[] = [];
      for (let i = 0; i < bench; i++) { step(1 / 60); cs.push(chars.stats.updateMs); as.push(animals.stats.updateMs); }
      const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
      const p95 = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)];
      benchStats = { benchFrames: bench, charAvg: avg(cs), charP95: p95(cs), animalAvg: avg(as), animalP95: p95(as) };
    }
    renderer.render(scene, camera);
    placeLabels();
    renderer.render(scene, camera);
    window.__charsReady = true;
    root.ready();
    return;
  }

  root.ready();
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0, fps = 0, msC = 0, msA = 0;
  function loop(): void {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    step(dt);
    controls.update();
    renderer.render(scene, camera);
    placeLabels();
    fpsAcc += dt; fpsN++;
    msC += chars.stats.updateMs; msA += animals.stats.updateMs;
    if (fpsAcc > 0.5) {
      fps = fpsN / fpsAcc;
      const s = statsNow();
      statsEl.textContent =
        `FPS ${fps.toFixed(0)}\n` +
        `people  ${s.characters}  update ${(msC / fpsN).toFixed(2)} ms\n` +
        `animals ${s.animals}  update ${(msA / fpsN).toFixed(2)} ms\n` +
        `draw calls ${s.calls}  tris ${(s.triangles / 1000).toFixed(0)}k`;
      fpsAcc = 0; fpsN = 0; msC = 0; msA = 0;
    }
  }
  loop();
}
