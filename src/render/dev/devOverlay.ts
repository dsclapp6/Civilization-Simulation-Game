// Dev overlay for the world viewer: performance stats and controls for time, season, weather,
// snow, quality and camera mode.
import { SEASON_NAMES, formatDate, type Season } from '../../core/time';
import type { CameraMode, GameRenderer, QualityLevel } from '../types';
import type { MockView, WeatherPreset } from './mockView';

export class DevOverlay {
  readonly el: HTMLDivElement;
  private readonly statsEl: HTMLPreElement;
  private readonly timeInput: HTMLInputElement;
  private readonly pickEl: HTMLDivElement;
  private acc = 1;

  constructor(parent: HTMLElement, private readonly renderer: GameRenderer, private readonly view: MockView, onMapToggle: () => void) {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;left:10px;top:10px;width:270px;padding:10px 12px;border-radius:6px;
      background:rgba(28,22,16,0.78);color:#efe4cc;font:12px/1.35 Georgia,serif;box-shadow:0 2px 10px rgba(0,0,0,0.4);
      border:1px solid rgba(214,180,110,0.45);user-select:none;`;
    el.innerHTML = `<div style="font-size:14px;letter-spacing:0.08em;color:#e8c25a;margin-bottom:6px">MILLENNIA · world viewer</div>`;
    this.statsEl = document.createElement('pre');
    this.statsEl.style.cssText = 'margin:0 0 8px;font:11px/1.35 ui-monospace,Menlo,monospace;color:#f1e8d4;white-space:pre-wrap';
    el.appendChild(this.statsEl);

    const row = (label: string) => {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;flex-wrap:wrap';
      const l = document.createElement('span');
      l.textContent = label;
      l.style.cssText = 'width:58px;color:#d8c9a4';
      r.appendChild(l);
      el.appendChild(r);
      return r;
    };
    const button = (parentEl: HTMLElement, text: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.style.cssText = 'font:11px Georgia,serif;padding:2px 6px;background:#4a3a28;color:#f3e6c8;border:1px solid #8a6a3a;border-radius:3px;cursor:pointer';
      b.onclick = fn;
      parentEl.appendChild(b);
      return b;
    };

    const tr = row('Time');
    this.timeInput = document.createElement('input');
    this.timeInput.type = 'range'; this.timeInput.min = '0'; this.timeInput.max = '1'; this.timeInput.step = '0.001';
    this.timeInput.style.width = '150px';
    this.timeInput.oninput = () => view.setTimeOfDay(Number(this.timeInput.value));
    tr.appendChild(this.timeInput);
    const auto = document.createElement('label');
    auto.innerHTML = `<input type="checkbox"> auto`;
    const cb = auto.querySelector('input')!;
    cb.onchange = () => { view.autoTime = cb.checked; };
    tr.appendChild(auto);

    const sr = row('Season');
    const sel = document.createElement('select');
    SEASON_NAMES.forEach((n, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = n; sel.appendChild(o); });
    sel.value = String(view.clock().season);
    sel.onchange = () => view.setSeason(Number(sel.value) as Season);
    sr.appendChild(sel);
    const ds = document.createElement('select');
    for (let d = 1; d <= 4; d++) { const o = document.createElement('option'); o.value = String(d - 1); o.textContent = `day ${d}`; ds.appendChild(o); }
    ds.value = String(view.clock().dayOfSeason - 1);
    ds.onchange = () => view.setDayOfSeason(Number(ds.value));
    sr.appendChild(ds);

    const wr = row('Weather');
    for (const w of ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'] as WeatherPreset[]) button(wr, w, () => view.setWeather(w));
    const snr = row('Snow');
    const snow = document.createElement('input');
    snow.type = 'range'; snow.min = '-0.05'; snow.max = '1'; snow.step = '0.01'; snow.value = '-0.05';
    snow.style.width = '150px';
    snow.title = 'snow cover (left = automatic)';
    snow.oninput = () => view.setSnowCover(Number(snow.value) < 0 ? null : Number(snow.value));
    snr.appendChild(snow);

    const qr = row('Quality');
    for (const q of ['low', 'medium', 'high'] as QualityLevel[]) button(qr, q, () => renderer.setQuality(q));
    const cr = row('Camera');
    for (const m of ['follow', 'free', 'cinematic'] as CameraMode[]) button(cr, m, () => renderer.setCameraMode(m));
    button(cr, 'map (M)', onMapToggle);

    this.pickEl = document.createElement('div');
    this.pickEl.style.cssText = 'margin-top:6px;color:#e8c25a;min-height:14px';
    el.appendChild(this.pickEl);
    const help = document.createElement('div');
    help.style.cssText = 'margin-top:6px;color:#b9aa88;font-size:11px';
    help.textContent = 'WASD move · Shift run · drag orbit · wheel zoom · M map · F free (QE up/down) · C cinematic · T auto time · click pick';
    el.appendChild(help);
    parent.appendChild(el);
    this.el = el;
  }

  showPick(text: string): void { this.pickEl.textContent = text; }

  update(dt: number): void {
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc = 0;
    const s = this.renderer.stats();
    const c = this.view.clock();
    if (document.activeElement !== this.timeInput) this.timeInput.value = String(c.dayFraction);
    this.statsEl.textContent =
      `${formatDate(c.absDay)}\n` +
      `fps ${s.fps.toFixed(0)}  cpu ${s.frameMs.toFixed(1)} ms  gen ${s.generationMs.toFixed(1)} ms\n` +
      `draw calls ${s.drawCalls}  tris ${(s.triangles / 1e6).toFixed(2)} M\n` +
      `terrain ${s.chunks} drawn / ${s.chunksCached} cached / ${s.chunksPending} pending\n` +
      `node build avg ${s.chunkBuildMs.toFixed(2)} ms  max ${s.chunkBuildMaxMs.toFixed(1)} ms\n` +
      `veg ${(s.vegetationInstances / 1000).toFixed(1)}k inst / ${s.vegetationChunks} chunks\n` +
      `buildings ${s.buildingsDetailed}/${s.buildings}  crops ${(s.cropInstances / 1000).toFixed(1)}k\n` +
      `camera ${s.cameraMode}  quality ${s.quality}`;
  }

  dispose(): void { this.el.remove(); }
}
