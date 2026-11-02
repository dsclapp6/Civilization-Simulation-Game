// The minimap (N toggles it): a small north-up chart of the ground around you, drawn from the world and the
// game state — roads, rivers and lakes, the buildings of the places near (your home in gold), the family's strips
// (gold) among the others, the people about (kin gold, household amber, the rest grey) and the places the HUD
// points at. A click opens the big map. Cheap: ~8 redraws a second of a few hundred shapes.
import { foldButton, isCollapsed } from '../core/collapse';
import { BUILDINGS, type BuildingCategory } from '../../content/types';
import type { ZoneAgent } from '../../agents/types';
import { familyOf } from '../../sim/kin';
import type { PersonId } from '../../sim/state';
import { settlementName } from '../../sim/api';
import type { WorldModel } from '../../world/types';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { hex } from '../core/nav';
import type { GameServices } from '../types';
import { COLOR, type NavMarker, type NavState } from './navstate';

const W = 266;
const H = 150;
/** Metres per pixel at each zoom step. */
const ZOOMS = [0.5, 0.75, 1.1, 1.7, 2.6];
const STORE = 'millennia.minimap.zoom';

const BUILDING_FILL: Record<BuildingCategory, string> = {
  home: '#a98a62', farm: '#b7a272', work: '#7d6c58', social: '#a05a3a', trade: '#b0643a', church: '#ebe3d0', civic: '#8d8a78', defence: '#6f6f6f', camp: '#a98a62',
};

function readZoom(): number {
  try { const v = Number(window.localStorage.getItem(STORE)); return Number.isInteger(v) && v >= 0 && v < ZOOMS.length ? v : 2; } catch { return 2; }
}

export class Minimap {
  readonly el = h('div.mu-minimap.mu-plate');
  private readonly canvas = h<HTMLCanvasElement>('canvas.mu-minimap-canvas');
  private readonly place = h('span.mu-minimap-place');
  private readonly caption = h('div.mu-minimap-caption');
  private g: CanvasRenderingContext2D | null = null;
  private zoom = readZoom();
  private last = -10;
  private roadBoxes: Float32Array | null = null;
  private waterBoxes: Float32Array | null = null;
  private worldRef: WorldModel | null = null;
  private kin = new Set<PersonId>();
  private household = new Set<PersonId>();
  private kinDay = -1;
  private kinOwner = 0;

  constructor(private readonly deps: { game(): GameServices | null; nav: NavState; openMap(): void }) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.g = this.canvas.getContext('2d');
    this.g?.setTransform(dpr, 0, 0, dpr, 0, 0);
    const zoomBtn = (name: 'plus' | 'minus', tip: string, d: number): HTMLElement => {
      const b = h<HTMLButtonElement>('button.mu-minimap-btn', { type: 'button', tip, 'aria-label': tip }, icon(name, 12));
      b.addEventListener('click', (e) => { e.stopPropagation(); this.setZoom(this.zoom + d); });
      return b;
    };
    this.canvas.addEventListener('click', () => this.deps.openMap());
    this.canvas.setAttribute('data-tip', 'Click to open the map (M)');
    this.el.append(
      h('div.mu-minimap-head', null, icon('pin', 13), this.place, h('span.mu-grow'), zoomBtn('minus', 'Zoom out', 1), zoomBtn('plus', 'Zoom in', -1),
        foldButton('minimap', 'the minimap', (c) => this.el.classList.toggle('folded', c))),
      h('div.mu-minimap-frame', null, this.canvas, h('div.mu-minimap-shade')),
      this.caption,
    );
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('mu-hide', !v);
    this.el.classList.toggle('folded', isCollapsed('minimap'));
  }

  private setZoom(i: number): void {
    this.zoom = Math.max(0, Math.min(ZOOMS.length - 1, i));
    try { window.localStorage.setItem(STORE, String(this.zoom)); } catch { /* private window: the zoom just resets */ }
    this.last = -10;
  }

  update(now: number): void {
    const game = this.deps.game();
    if (!game || !this.g || now - this.last < 0.12) return;
    this.last = now;
    this.draw(game, now);
  }

  // ---------------------------------------------------------------------------------------------

  private index(world: WorldModel): void {
    if (this.worldRef === world) return;
    this.worldRef = world;
    const boxes = (polys: ReadonlyArray<ReadonlyArray<{ x: number; z: number }>>): Float32Array => {
      const out = new Float32Array(polys.length * 4);
      polys.forEach((pts, i) => {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
        out[i * 4] = x0; out[i * 4 + 1] = z0; out[i * 4 + 2] = x1; out[i * 4 + 3] = z1;
      });
      return out;
    };
    this.roadBoxes = boxes(world.roads.map((r) => r.points));
    this.waterBoxes = boxes([...world.lakes.map((l) => l.outline), ...world.rivers.map((r) => r.points)]);
  }

  private refreshKin(game: GameServices): void {
    const sim = game.sim;
    const day = Math.floor(sim.absDay);
    const pid = sim.state.run.playerId;
    if (day === this.kinDay && pid === this.kinOwner) return;
    this.kinDay = day; this.kinOwner = pid;
    const p = sim.state.persons.get(pid);
    this.kin = p ? new Set(familyOf(sim.state, p, 3).keys()) : new Set();
    const hh = p ? sim.state.households.get(p.household) : undefined;
    this.household = new Set(hh ? hh.members : []);
  }

  private draw(game: GameServices, now: number): void {
    const g = this.g as CanvasRenderingContext2D;
    const sim = game.sim;
    const world = sim.world;
    const nav = this.deps.nav;
    this.index(world);
    this.refreshKin(game);
    const mpp = ZOOMS[this.zoom];
    const px = nav.x, pz = nav.z;
    const cx = W / 2, cy = H / 2;
    const sx = (x: number): number => cx + (x - px) / mpp;
    const sy = (z: number): number => cy + (z - pz) / mpp;
    const halfW = (W / 2) * mpp + 12, halfH = (H / 2) * mpp + 12;
    const x0 = px - halfW, x1 = px + halfW, z0 = pz - halfH, z1 = pz + halfH;

    // the ground
    g.fillStyle = '#e6d6a4';
    g.fillRect(0, 0, W, H);

    // water: lakes (filled) and rivers (stroked)
    const wb = this.waterBoxes as Float32Array;
    g.fillStyle = '#9fbfce';
    g.strokeStyle = '#8fb3c6';
    g.lineJoin = 'round';
    let wi = 0;
    for (const lake of world.lakes) {
      const o = wi++ * 4;
      if (wb[o + 2] < x0 || wb[o] > x1 || wb[o + 3] < z0 || wb[o + 1] > z1) continue;
      g.beginPath();
      lake.outline.forEach((p, i) => { if (i) g.lineTo(sx(p.x), sy(p.z)); else g.moveTo(sx(p.x), sy(p.z)); });
      g.closePath();
      g.fill();
    }
    for (const river of world.rivers) {
      const o = wi++ * 4;
      if (wb[o + 2] < x0 || wb[o] > x1 || wb[o + 3] < z0 || wb[o + 1] > z1) continue;
      g.lineWidth = Math.max(1.6, (river.widths[0] ?? 6) / mpp);
      g.beginPath();
      river.points.forEach((p, i) => { if (i) g.lineTo(sx(p.x), sy(p.z)); else g.moveTo(sx(p.x), sy(p.z)); });
      g.stroke();
    }

    // the places near: their commons and strips, then their roads and buildings
    const near = world.settlements.filter((s) => Math.abs(s.x - px) < halfW + s.radius + 220 && Math.abs(s.z - pz) < halfH + s.radius + 220);
    const holder = sim.state.persons.get(sim.state.run.playerId)?.household ?? 0;
    for (const s of near) {
      g.fillStyle = 'rgba(160, 176, 98, 0.32)';
      for (const id of s.parcels) {
        const poly = world.parcels[id]?.poly;
        if (!poly) continue;
        this.polygon(g, poly, sx, sy);
        g.fill();
      }
      for (const id of s.strips) {
        const poly = world.strips[id]?.poly;
        if (!poly) continue;
        const mine = holder !== 0 && sim.state.strips.get(id)?.holder === holder;
        if (mine) {
          g.fillStyle = 'rgba(226, 178, 52, 0.72)';
          g.strokeStyle = '#946a0b';
          g.lineWidth = 1.2;
          this.polygon(g, poly, sx, sy);
          g.fill();
          g.stroke();
        } else {
          g.fillStyle = 'rgba(206, 192, 120, 0.55)';
          g.strokeStyle = 'rgba(138, 110, 60, 0.45)';
          g.lineWidth = 0.7;
          this.polygon(g, poly, sx, sy);
          g.fill();
          g.stroke();
        }
      }
    }
    // roads
    const rb = this.roadBoxes as Float32Array;
    g.lineCap = 'round';
    world.roads.forEach((r, i) => {
      const o = i * 4;
      if (rb[o + 2] < x0 || rb[o] > x1 || rb[o + 3] < z0 || rb[o + 1] > z1) return;
      const wpx = Math.max(1.3, Math.min(5, (r.kind === 'path' ? 2 : r.width) / mpp));
      g.beginPath();
      r.points.forEach((p, k) => { if (k) g.lineTo(sx(p.x), sy(p.z)); else g.moveTo(sx(p.x), sy(p.z)); });
      g.strokeStyle = '#8a6a38';
      g.lineWidth = wpx + 1.4;
      g.stroke();
      g.strokeStyle = r.kind === 'path' || r.kind === 'track' ? '#d2b67c' : '#e9d29a';
      g.lineWidth = wpx;
      g.stroke();
    });
    // buildings
    const home = sim.state.households.get(holder)?.home ?? -1;
    for (const s of near) {
      for (const b of sim.state.buildingsAt.get(s.id) ?? []) {
        if (b.x < x0 - 20 || b.x > x1 + 20 || b.z < z0 - 20 || b.z > z1 + 20) continue;
        const def = BUILDINGS[b.kind];
        if (!def || def.segment) continue;
        const w = Math.max(2.6, def.w / mpp), d = Math.max(2.6, def.d / mpp);
        g.save();
        g.translate(sx(b.x), sy(b.z));
        g.rotate(-b.rot);
        const mine = b.id === home;
        g.fillStyle = mine ? '#e8b92c' : BUILDING_FILL[def.cat];
        g.fillRect(-w / 2, -d / 2, w, d);
        g.strokeStyle = mine ? '#2a1b0f' : 'rgba(42, 27, 15, 0.55)';
        g.lineWidth = mine ? 1.6 : 0.8;
        g.strokeRect(-w / 2, -d / 2, w, d);
        g.restore();
      }
    }

    // people
    const agents = game.zone.agents();
    for (let i = 0; i < agents.length; i++) {
      const a: ZoneAgent = agents[i];
      if (!a.visible || a.x < x0 || a.x > x1 || a.z < z0 || a.z > z1) continue;
      if (a.personId === sim.state.run.playerId) continue;
      const kin = this.kin.has(a.personId);
      const hh = this.household.has(a.personId);
      g.fillStyle = kin ? '#f0b82a' : hh ? '#e08a2a' : 'rgba(86, 78, 70, 0.8)';
      g.beginPath();
      g.arc(sx(a.x), sy(a.z), kin || hh ? 2.6 : 1.8, 0, Math.PI * 2);
      g.fill();
      if (kin || hh) { g.strokeStyle = 'rgba(42, 27, 15, 0.8)'; g.lineWidth = 0.8; g.stroke(); }
    }

    // markers (the tracked objective last, on top)
    const marks = nav.markers.slice().sort((a, b) => Number(a.primary) - Number(b.primary));
    for (const m of marks) this.marker(g, m, sx(m.x), sy(m.z), now);

    // you, and where the camera looks
    const cam = nav.camYaw;
    g.fillStyle = 'rgba(255, 244, 205, 0.34)';
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, 34, Math.PI / 2 - cam - 0.62, Math.PI / 2 - cam + 0.62);
    g.closePath();
    g.fill();
    const by = nav.bodyYaw;
    g.save();
    g.translate(cx, cy);
    g.rotate(Math.PI - by);
    g.fillStyle = '#c9301e';
    g.strokeStyle = '#2a1b0f';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(0, -6.5); g.lineTo(4.6, 5); g.lineTo(0, 2.6); g.lineTo(-4.6, 5); g.closePath();
    g.fill(); g.stroke();
    g.restore();

    // north
    g.font = '700 11px "Iowan Old Style", Palatino, Georgia, serif';
    g.textAlign = 'center';
    g.fillStyle = '#ac2818';
    g.fillText('N', cx, 11);

    const sName = nav.settlementId >= 0 ? settlementName(world, nav.settlementId) : '';
    const text = sName || `near ${world.nearestSettlement(px, pz).name}`;
    if (this.place.textContent !== text) this.place.textContent = text;
    const scaleM = Math.round(60 * mpp / 10) * 10;
    const cap = `${scaleM} m ▬ · gold: your home and strips`;
    if (this.caption.textContent !== cap) this.caption.textContent = cap;
  }

  private polygon(g: CanvasRenderingContext2D, poly: ReadonlyArray<{ x: number; z: number }>, sx: (x: number) => number, sy: (z: number) => number): void {
    g.beginPath();
    for (let i = 0; i < poly.length; i++) { if (i) g.lineTo(sx(poly[i].x), sy(poly[i].z)); else g.moveTo(sx(poly[i].x), sy(poly[i].z)); }
    g.closePath();
  }

  private marker(g: CanvasRenderingContext2D, m: NavMarker, x: number, y: number, now: number): void {
    const pad = 9;
    const inside = x >= pad && x <= W - pad && y >= pad && y <= H - pad;
    const col = m.primary ? hex(COLOR.objective) : hex(m.color);
    if (!inside) {
      // pinned to the edge, pointing the way
      const ang = Math.atan2(y - H / 2, x - W / 2);
      const k = Math.min((W / 2 - pad) / Math.max(1e-3, Math.abs(Math.cos(ang))), (H / 2 - pad) / Math.max(1e-3, Math.abs(Math.sin(ang))));
      const ex = W / 2 + Math.cos(ang) * k, ey = H / 2 + Math.sin(ang) * k;
      g.save();
      g.translate(ex, ey);
      g.rotate(ang);
      g.fillStyle = col;
      g.strokeStyle = '#2a1b0f';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(6, 0); g.lineTo(-3.5, 4.6); g.lineTo(-3.5, -4.6); g.closePath();
      g.fill(); g.stroke();
      g.restore();
      return;
    }
    g.save();
    g.translate(x, y);
    if (m.primary) {
      const pulse = 1 + 0.25 * Math.sin(now * 4);
      g.strokeStyle = 'rgba(242, 193, 78, 0.8)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(0, 0, 9 * pulse, 0, Math.PI * 2);
      g.stroke();
    }
    g.rotate(Math.PI / 4);
    const r = m.primary ? 5.4 : 4;
    g.fillStyle = col;
    g.strokeStyle = '#2a1b0f';
    g.lineWidth = 1.4;
    g.fillRect(-r, -r, r * 2, r * 2);
    g.strokeRect(-r, -r, r * 2, r * 2);
    g.restore();
  }
}
