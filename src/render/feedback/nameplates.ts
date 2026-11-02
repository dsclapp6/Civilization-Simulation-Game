// Nameplates over people (CharacterDrawItem.label/sublabel/labelTone/labelRange/mark, docs/CLARITY.md §3):
// the full name in small capitals in the colour of the relationship, the relation and role in italics
// below; a gold "!" badge for someone with a task for the player, a blue badge for the tracked person.
// Kin and quest people show from their labelRange (≈ 40 m), strangers from ≈ 15 m, the hovered or
// targeted person always; marks alone reach further. Crowds stay tidy: plates are ranked (hovered, marked,
// close kin first), drop their second line with distance, and a plate that would overlap a more
// important one shrinks to its name, to its mark, or stands down. People behind houses lose their plate
// (ray against the building boxes). A spoken line (the agents write it into `label` for a few seconds)
// shows as a quoted speech line. DOM (CSS2D) plates: real serif type, at most MAX_PLATES elements.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { CharacterDrawItem, LabelTone } from '../../core/view';

export const MAX_PLATES = 18;
/** Range when the sim gives none (m). */
export const DEFAULT_LABEL_RANGE = 20;
/** The mark over someone a task can be finished with: a pair of gilded wings (the "!" is for a task to give). */
const WINGS_SVG = '<svg viewBox="0 0 68 34" aria-hidden="true"><defs><linearGradient id="milw" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#fff4c8"/><stop offset=".55" stop-color="#e9b43a"/><stop offset="1" stop-color="#a8740f"/></linearGradient></defs>'
  + '<g fill="url(#milw)" stroke="#3a2408" stroke-width="1.6" stroke-linejoin="round">'
  + '<path d="M31 22 C24 8 12 3 2 4 C7 8 9 11 9 13 C5 13 3 15 2 17 C7 17 10 18 11 20 C8 21 6 23 6 26 C14 24 22 26 31 22 Z"/>'
  + '<path d="M37 22 C44 8 56 3 66 4 C61 8 59 11 59 13 C63 13 65 15 66 17 C61 17 58 18 57 20 C60 21 62 23 62 26 C54 24 46 26 37 22 Z"/></g>'
  + '<circle cx="34" cy="21" r="3.2" fill="#ffe9a0" stroke="#3a2408" stroke-width="1.4"/></svg>';

/** Quest/track marks show this far even when the name does not (m). */
export const MARK_RANGE = 75;
/** The hovered/targeted person is labelled up to this far (m). */
const FOCUS_RANGE = 160;
/** Spoken lines carry this far at least (m). */
const SPEECH_RANGE = 22;
/** Second line only within this distance (or for the focused person). */
const SUB_RANGE = 14;

export const TONE_COLORS: Record<LabelTone, string> = {
  player: '#a9d6ff',
  kin: '#f4c84f',
  household: '#f2a65a',
  friend: '#9fdc7c',
  rival: '#f38b5c',
  enemy: '#ff5b4d',
  lord: '#cfa6ff',
  clergy: '#f7f4ec',
  stranger: '#d8d0c0',
  quest: '#ffd76a',
};
const TONE_WEIGHT: Record<LabelTone, number> = {
  player: 0, kin: 4, household: 3, lord: 3, enemy: 3, friend: 2, rival: 2, clergy: 1, quest: 4, stranger: 0,
};

const CSS = `
.mil-plate{pointer-events:none;white-space:nowrap;}
.mil-plate-in{display:flex;flex-direction:column;align-items:center;transform-origin:50% 100%;
 font-family:Georgia,"Palatino Linotype","Book Antiqua","Times New Roman",serif;
 text-shadow:0 1px 1px rgba(0,0,0,.95),0 0 3px rgba(0,0,0,.85),0 0 8px rgba(0,0,0,.5);}
.mil-plate-name{font-weight:700;font-size:15px;line-height:16px;letter-spacing:.04em;font-variant:small-caps;color:var(--tone,#d8d0c0);}
.mil-plate-sub{font-style:italic;font-size:12px;line-height:14px;color:#efe6d2;opacity:.9;letter-spacing:.01em;}
.mil-plate.speech .mil-plate-name{font-variant:normal;font-style:italic;font-weight:600;font-size:13px;letter-spacing:.01em;color:#fbf3df;
 background:rgba(24,17,10,.62);border:1px solid rgba(232,206,150,.38);border-radius:7px;padding:2px 8px 3px;max-width:300px;white-space:normal;text-align:center;}
.mil-plate.focus .mil-plate-in{background:rgba(22,15,8,.5);border:1px solid color-mix(in srgb,var(--tone,#d8d0c0) 55%,transparent);border-radius:4px;padding:2px 8px 3px;}
.mil-plate.focus .mil-plate-name{font-size:16px;}
.mil-plate-mark{display:none;width:15px;height:15px;margin-bottom:4px;transform:rotate(45deg);border-radius:2px;
 box-shadow:0 0 0 1px rgba(30,18,6,.9),0 0 7px rgba(0,0,0,.6);}
.mil-plate-mark>span{display:block;transform:rotate(-45deg);font:700 12px/15px Georgia,serif;text-align:center;text-shadow:none;}
.mil-plate.quest .mil-plate-mark{display:block;background:linear-gradient(135deg,#ffe9a0,#e9b43a 60%,#b98319);}
.mil-plate.quest .mil-plate-mark>span{color:#3a2408;}
.mil-plate.turnin .mil-plate-mark{display:block;transform:none;width:42px;height:21px;margin-bottom:3px;background:none;box-shadow:none;border-radius:0;
 filter:drop-shadow(0 0 1px rgba(30,18,6,.95)) drop-shadow(0 0 4px rgba(255,236,170,.65));}
.mil-plate.turnin .mil-plate-mark>span{transform:none;width:42px;height:21px;}
.mil-plate.turnin .mil-plate-mark svg{display:block;width:42px;height:21px;}
.mil-plate.track .mil-plate-mark{display:block;background:linear-gradient(135deg,#d9f1ff,#7cc4ff 60%,#3f86c9);}
.mil-plate.track .mil-plate-mark>span{color:#0d2440;}
.mil-plate.markonly .mil-plate-name,.mil-plate.markonly .mil-plate-sub,.mil-plate.nosub .mil-plate-sub{display:none;}
`;

let cssInstalled = false;
function installCss(): void {
  if (cssInstalled || typeof document === 'undefined') return;
  cssInstalled = true;
  const s = document.createElement('style');
  s.id = 'mil-plates-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

interface Plate {
  obj: CSS2DObject;
  inner: HTMLElement;
  name: HTMLElement;
  sub: HTMLElement;
  mark: HTMLElement;
  cls: string;
  nameText: string;
  subText: string;
  tone: string;
  scale: string;
  opacity: string;
}

/** A spoken line rather than a name (the agents put speech into `label` for a few seconds). */
export function isSpeech(label: string): boolean {
  return label.length > 34 || /[.!?,;…"“”]/.test(label);
}

interface Cand { it: CharacterDrawItem; d: number; pri: number; text: boolean; sub: boolean; focus: boolean; speech: boolean; sx: number; sy: number }

/** One plate to show: whose, which form, and a lift in px (a spoken line clearing a plate in front). */
export interface PlateLayout { it: CharacterDrawItem; mode: 'full' | 'name' | 'mark'; focus: boolean; speech: boolean; d: number; dy: number; dx: number }

/** Plate choice for one frame (pure; exported for tests). `project` returns CSS px or null when off screen. */
export function layoutPlates(
  chars: readonly CharacterDrawItem[], cam: { x: number; y: number; z: number }, focusId: number,
  project: (x: number, y: number, z: number) => { x: number; y: number } | null,
  occluded: ((it: CharacterDrawItem, h: number) => boolean) | null, max = MAX_PLATES, screenW = Infinity,
): PlateLayout[] {
  const cands: Cand[] = [];
  for (const it of chars) {
    if (it.highlight === 3 || !it.label) continue;
    const d = Math.hypot(it.x - cam.x, it.y + 1.6 - cam.y, it.z - cam.z);
    const focus = it.highlight === 1 || it.highlight === 2 || it.id === focusId;
    const speech = isSpeech(it.label);
    const range = Math.max(it.labelRange ?? DEFAULT_LABEL_RANGE, speech ? SPEECH_RANGE : 0);
    const text = focus ? d < FOCUS_RANGE : d < range;
    const markOk = !!it.mark && d < MARK_RANGE;
    if (!text && !markOk) continue;
    const tone = it.labelTone ?? 'stranger';
    // the hovered one, then people with a task for the player or tracked, then a spoken line (it steps up over
    // others), then kin and the like, nearest first
    const pri = (focus ? 1e6 : 0) + (it.mark === 'quest' ? 3e4 : it.mark === 'turnin' ? 2.8e4 : it.mark === 'track' ? 2.5e4 : 0) + (speech ? 2e4 : 0) + TONE_WEIGHT[tone] * 900 - d * 10;
    cands.push({ it, d, pri, text, sub: !!it.sublabel && !speech && (focus || d < SUB_RANGE), focus, speech, sx: 0, sy: 0 });
  }
  cands.sort((a, b) => b.pri - a.pri);
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out: PlateLayout[] = [];
  const hit = (x0: number, y0: number, x1: number, y1: number) => boxes.some((b) => x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0);
  /** Top of the highest box overlapping a span (to lift a spoken line clear of it). */
  const topOf = (x0: number, y0: number, x1: number, y1: number) => {
    let top = Infinity;
    for (const b of boxes) if (x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0) top = Math.min(top, b.y0);
    return top;
  };
  // names first (best first), then marks for whoever is left: a far mark never pushes a near name out
  const later: Cand[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const c of pass === 0 ? cands : later) {
      if (out.length >= max) break;
      const it = c.it;
      const h = it.look.height + (it.mount ? 1.25 : 0) + 0.3;
      if (pass === 0) {
        const s = project(it.x, it.y + h, it.z);
        if (!s) continue;
        if (occluded && occluded(it, h)) continue;
        c.sx = s.x; c.sy = s.y;
      }
      const k = plateScale(c.d, c.focus);
      const nameW = Math.min(it.label!.length, c.speech ? 44 : 40) * (c.speech ? 6.6 : 8.2) * k + 8;
      const subW = c.sub ? (it.sublabel!.length * 6.1 * k + 8) : 0;
      const markH = it.mark ? 19 * k : 0;
      const lines = c.speech ? Math.ceil(it.label!.length / 44) : 1;
      const tries: ('full' | 'name' | 'mark')[] = pass === 1 ? ['mark'] : c.text ? (c.sub ? ['full', 'name'] : ['name']) : [];
      let placed = false;
      for (const mode of tries) {
        const w = mode === 'mark' ? 18 * k : Math.max(nameW, mode === 'full' ? subW : 0);
        const hh = mode === 'mark' ? markH : markH + (15 * lines + (mode === 'full' ? 13 : 0)) * k + 4;
        // keep the plate on screen (someone at the edge of the view keeps a whole plate)
        const dx = c.sx - w / 2 < 4 ? 4 - (c.sx - w / 2) : c.sx + w / 2 > screenW - 4 ? screenW - 4 - (c.sx + w / 2) : 0;
        const x0 = c.sx + dx - w / 2, x1 = c.sx + dx + w / 2;
        let y1 = c.sy, dy = 0;
        if (!c.focus && hit(x0, y1 - hh, x1, y1)) {
          // a spoken line steps up over what is in the way (twice at most); names give way instead
          if (!c.speech) continue;
          for (let k2 = 0; k2 < 2 && hit(x0, y1 - hh, x1, y1); k2++) y1 = topOf(x0, y1 - hh, x1, y1) - 3;
          if (hit(x0, y1 - hh, x1, y1) || c.sy - y1 > 90) continue;
          dy = y1 - c.sy;
        }
        boxes.push({ x0, y0: y1 - hh, x1, y1 });
        out.push({ it, mode, focus: c.focus, speech: c.speech, d: c.d, dy, dx });
        placed = true;
        break;
      }
      if (pass === 0 && !placed && it.mark && !c.speech) later.push(c);
    }
  }
  return out;
}

/** Plates shrink a little with distance (≥ 0.8) and a focused one stays full size. */
export function plateScale(d: number, focus: boolean): number {
  if (focus) return 1;
  return Math.max(0.8, Math.min(1, 1.06 - d / 70));
}

export class Nameplates {
  readonly scene = new THREE.Group();
  private readonly plates: Plate[] = [];
  /** Someone the UI marks as hovered/targeted (setHover on a person): always labelled. */
  focusId = -1;
  /** True when something solid stands between the camera and the point (labels are DOM and never depth-tested). */
  occluded?: (from: THREE.Vector3, to: THREE.Vector3) => boolean;
  private readonly v = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  /** Plates shown this frame (stats/tests). */
  shown = 0;

  constructor(enabled: boolean) {
    this.scene.name = 'nameplates';
    if (!enabled || typeof document === 'undefined') return;
    installCss();
    for (let i = 0; i < MAX_PLATES; i++) {
      const el = document.createElement('div');
      el.className = 'mil-plate';
      const inner = document.createElement('div');
      inner.className = 'mil-plate-in';
      const mark = document.createElement('div');
      mark.className = 'mil-plate-mark';
      const markGlyph = document.createElement('span');
      mark.appendChild(markGlyph);
      const name = document.createElement('div');
      name.className = 'mil-plate-name';
      const sub = document.createElement('div');
      sub.className = 'mil-plate-sub';
      inner.append(mark, name, sub);
      el.appendChild(inner);
      const obj = new CSS2DObject(el);
      obj.center.set(0.5, 1);
      obj.visible = false;
      this.scene.add(obj);
      this.plates.push({ obj, inner, name, sub, mark: markGlyph, cls: '', nameText: '', subText: '', tone: '', scale: '', opacity: '' });
    }
  }

  /** Occlusion answers per person, refreshed every few frames (each test is a ray against the buildings). */
  private readonly occCache = new Map<number, { f: number; v: boolean }>();
  private frame = 0;

  update(chars: readonly CharacterDrawItem[], camera: THREE.PerspectiveCamera, width: number, height: number, show: boolean): void {
    if (!this.plates.length) return;
    this.frame++;
    const cp = camera.position;
    const occ = this.occluded;
    const cached = (it: CharacterDrawItem, h: number): boolean => {
      const c = this.occCache.get(it.id);
      if (c && this.frame - c.f < 4) return c.v;
      const v = occ!(cp, this.to.set(it.x, it.y + h * 0.7, it.z));
      if (c) { c.f = this.frame; c.v = v; } else this.occCache.set(it.id, { f: this.frame - (it.id & 3), v });
      return v;
    };
    if (this.occCache.size > 400) this.occCache.clear();
    const layout = show ? layoutPlates(chars, cp, this.focusId, (x, y, z) => {
      this.v.set(x, y, z).project(camera);
      if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) return null;
      return { x: (this.v.x * 0.5 + 0.5) * width, y: (-this.v.y * 0.5 + 0.5) * height };
    }, occ ? cached : null, MAX_PLATES, width) : [];
    this.shown = layout.length;
    for (let i = 0; i < this.plates.length; i++) {
      const p = this.plates[i];
      const l = layout[i];
      if (!l) { if (p.obj.visible) p.obj.visible = false; continue; }
      const it = l.it;
      const h = it.look.height + (it.mount ? 1.25 : 0) + 0.3;
      p.obj.position.set(it.x, it.y + h, it.z);
      p.obj.visible = true;
      const mark = l.speech ? '' : it.mark ?? '';
      const cls = `mil-plate${l.focus ? ' focus' : ''}${l.speech ? ' speech' : ''}${mark ? ` ${mark}` : ''}${l.mode === 'mark' ? ' markonly' : l.mode === 'name' ? ' nosub' : ''}`;
      if (p.cls !== cls) {
        p.obj.element.className = cls;
        p.cls = cls;
        if (mark === 'turnin') p.mark.innerHTML = WINGS_SVG;
        else p.mark.textContent = mark === 'quest' ? '!' : mark === 'track' ? '•' : '';
      }
      const name = l.speech ? `“${it.label}”` : it.label ?? '';
      if (p.nameText !== name) { p.name.textContent = name; p.nameText = name; }
      const sub = it.sublabel ?? '';
      if (p.subText !== sub) { p.sub.textContent = sub; p.subText = sub; }
      const tone = TONE_COLORS[it.labelTone ?? 'stranger'] ?? TONE_COLORS.stranger;
      if (p.tone !== tone) { p.obj.element.style.setProperty('--tone', tone); p.tone = tone; }
      const k = plateScale(l.d, l.focus).toFixed(2);
      const tf = l.dy || l.dx ? `translate(${Math.round(l.dx)}px, ${Math.round(l.dy)}px) scale(${k})` : `scale(${k})`;
      if (p.scale !== tf) { p.inner.style.transform = tf; p.scale = tf; }
      // fade in over the last few metres of the range
      const range = l.focus ? FOCUS_RANGE : l.mode === 'mark' ? MARK_RANGE : Math.max(it.labelRange ?? DEFAULT_LABEL_RANGE, l.speech ? SPEECH_RANGE : 0);
      const op = Math.max(0.15, Math.min(1, (range - l.d) / 5)).toFixed(2);
      if (p.opacity !== op) { p.obj.element.style.opacity = op; p.opacity = op; }
    }
  }

  dispose(): void {
    for (const p of this.plates) p.obj.element.remove();
    this.scene.clear();
  }
}
