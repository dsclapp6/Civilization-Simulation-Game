// Gallery DOM: parchment side panels, controls, stats and 3D-anchored labels.
import * as THREE from 'three';
import type { Label } from './views';

const CSS = `
.gal-panel { position: fixed; top: 12px; bottom: 12px; width: 250px; overflow-y: auto; padding: 12px 14px;
  background: linear-gradient(#f1e7cc, #e6d6b0); color: #2b2015; border: 1px solid #8a6a3a; border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,.35), inset 0 0 30px rgba(120,80,30,.12); font: 13px Georgia, 'Times New Roman', serif; }
.gal-left { left: 12px; } .gal-right { right: 12px; width: 236px; }
.gal-panel h1 { font: 600 17px Georgia, serif; margin: 0 0 2px; letter-spacing: .04em; color: #5a1a12; }
.gal-panel h2 { font: 600 11px Georgia, serif; text-transform: uppercase; letter-spacing: .14em; color: #7a2a1a; margin: 14px 0 6px;
  border-bottom: 1px solid rgba(138,106,58,.5); padding-bottom: 3px; }
.gal-sub { font-style: italic; color: #6a5236; margin-bottom: 8px; }
.gal-tabs { display: flex; flex-wrap: wrap; gap: 4px; }
.gal-tab, .gal-item { cursor: pointer; border: 1px solid #a88a5a; background: #f7efda; color: #3a2a18; border-radius: 3px; padding: 3px 7px; font: 12px Georgia, serif; }
.gal-tab.on, .gal-item.on { background: #7a2a1a; color: #f7efda; border-color: #5a1a12; }
.gal-list { display: flex; flex-direction: column; gap: 3px; margin-top: 8px; }
.gal-item { text-align: left; }
.gal-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 5px 0; }
.gal-row label { flex: 0 0 86px; color: #4a3520; }
.gal-row input[type=range] { flex: 1; accent-color: #7a2a1a; }
.gal-row select, .gal-row input[type=color] { flex: 1; font: 12px Georgia, serif; background: #f7efda; border: 1px solid #a88a5a; }
.gal-val { width: 38px; text-align: right; font-variant-numeric: tabular-nums; color: #5a4028; }
.gal-stats { font: 12px/1.5 Georgia, serif; color: #3a2a18; white-space: pre; }
.gal-label { position: fixed; transform: translate(-50%, 0); pointer-events: none; font: 600 12px Georgia, serif; color: #2b2015;
  background: rgba(241,231,204,.88); border: 1px solid rgba(138,106,58,.7); border-radius: 3px; padding: 1px 6px; white-space: nowrap; }
.gal-label small { font-weight: 400; color: #6a5236; margin-left: 4px; }
.gal-caption { position: fixed; left: 14px; top: 12px; font: 600 15px Georgia, serif; color: #2b2015; background: rgba(241,231,204,.9);
  border: 1px solid rgba(138,106,58,.8); border-radius: 4px; padding: 4px 10px; letter-spacing: .03em; }
.gal-season { position: fixed; font: 600 13px Georgia, serif; color: #2b2015; background: rgba(241,231,204,.9); border: 1px solid rgba(138,106,58,.8);
  border-radius: 3px; padding: 2px 8px; }
`;

export function injectCss(): void {
  if (document.getElementById('gal-css')) return;
  const s = document.createElement('style');
  s.id = 'gal-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

export class LabelLayer {
  private els: HTMLDivElement[] = [];
  private root: HTMLElement;
  private v = new THREE.Vector3();
  constructor(root: HTMLElement) { this.root = root; }
  set(labels: Label[]): void {
    for (const e of this.els) e.remove();
    this.els = labels.map((l) => {
      const d = document.createElement('div');
      d.className = 'gal-label';
      d.innerHTML = l.sub ? `${escape(l.text)}<small>${escape(l.sub)}</small>` : escape(l.text);
      if (!l.text && l.sub) d.innerHTML = `<small style="margin:0">${escape(l.sub)}</small>`;
      this.root.appendChild(d);
      return d;
    });
    this.labels = labels;
  }
  private labels: Label[] = [];
  update(camera: THREE.Camera, w: number, h: number, ox = 0, oy = 0): void {
    this.labels.forEach((l, i) => {
      const el = this.els[i];
      this.v.copy(l.pos).project(camera);
      const vis = this.v.z < 1 && this.v.z > -1 && Math.abs(this.v.x) < 1.1 && Math.abs(this.v.y) < 1.1;
      el.style.display = vis ? 'block' : 'none';
      if (!vis) return;
      el.style.left = `${ox + (this.v.x * 0.5 + 0.5) * w}px`;
      el.style.top = `${oy + (-this.v.y * 0.5 + 0.5) * h}px`;
    });
  }
  clear(): void { this.set([]); }
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void, fmt = (v: number) => v.toFixed(2)): HTMLInputElement {
  const row = el('div', 'gal-row');
  row.appendChild(el('label', undefined, label));
  const input = el('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  const val = el('span', 'gal-val', fmt(value));
  input.addEventListener('input', () => { const v = Number(input.value); val.textContent = fmt(v); onInput(v); });
  row.append(input, val);
  parent.appendChild(row);
  return input;
}

export function select(parent: HTMLElement, label: string, options: string[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const row = el('div', 'gal-row');
  row.appendChild(el('label', undefined, label));
  const s = el('select');
  for (const o of options) { const op = el('option', undefined, o); op.value = o; if (o === value) op.selected = true; s.appendChild(op); }
  s.addEventListener('change', () => onChange(s.value));
  row.appendChild(s);
  parent.appendChild(row);
  return s;
}

export function checkbox(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const row = el('div', 'gal-row');
  row.appendChild(el('label', undefined, label));
  const c = el('input');
  c.type = 'checkbox';
  c.checked = value;
  c.addEventListener('change', () => onChange(c.checked));
  row.appendChild(c);
  parent.appendChild(row);
  return c;
}
