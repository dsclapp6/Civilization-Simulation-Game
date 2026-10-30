// Map-view labels: settlements (sized and filtered by kind and camera altitude), kingdom names
// and markers from view.mapMarkers(). Rendered with CSS2D in their own scene.
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { SettlementKind } from '../../core/domain';
import type { MapMarker } from '../../core/view';
import type { WorldModel } from '../../world/types';

interface KindStyle { maxAlt: number; font: string; badge: string }

const STYLE: Record<SettlementKind, KindStyle> = {
  city: { maxAlt: 1e9, font: '700 17px', badge: 'city' },
  town: { maxAlt: 26000, font: '700 14px', badge: 'town' },
  castle: { maxAlt: 14000, font: '600 12px', badge: 'castle' },
  abbey: { maxAlt: 11000, font: 'italic 600 12px', badge: 'abbey' },
  priory: { maxAlt: 8000, font: 'italic 600 11px', badge: 'abbey' },
  nunnery: { maxAlt: 8000, font: 'italic 600 11px', badge: 'abbey' },
  village: { maxAlt: 9000, font: '600 12px', badge: 'village' },
  hamlet: { maxAlt: 4200, font: 'italic 11px', badge: 'hamlet' },
};

function hex(c: number): string { return `#${c.toString(16).padStart(6, '0')}`; }

function badgeHtml(kind: string, color: string): string {
  switch (kind) {
    case 'city': return `<span style="display:inline-block;width:13px;height:13px;border-radius:2px 2px 7px 7px;background:${color};border:2px solid #e8c25a;box-shadow:0 0 0 1px #2a1d10;margin-right:5px;vertical-align:-2px"></span>`;
    case 'town': return `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};border:2px solid #f3e6c8;box-shadow:0 0 0 1px #2a1d10;margin-right:4px;vertical-align:-1px"></span>`;
    case 'castle': return `<span style="display:inline-block;width:9px;height:9px;background:#5a4a3a;border:1.5px solid #f3e6c8;box-shadow:0 0 0 1px #2a1d10;margin-right:4px;vertical-align:-1px;clip-path:polygon(0 25%,25% 25%,25% 0,40% 0,40% 25%,60% 25%,60% 0,75% 0,75% 25%,100% 25%,100% 100%,0 100%)"></span>`;
    case 'abbey': return `<span style="display:inline-block;position:relative;width:9px;height:11px;margin-right:4px;vertical-align:-1px"><span style="position:absolute;left:3px;top:0;width:3px;height:11px;background:#f3e6c8;box-shadow:0 0 0 1px #2a1d10"></span><span style="position:absolute;left:0;top:3px;width:9px;height:3px;background:#f3e6c8;box-shadow:0 0 0 1px #2a1d10"></span></span>`;
    case 'village': return `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f3e6c8;box-shadow:0 0 0 1.5px #2a1d10;margin-right:4px;vertical-align:0"></span>`;
    default: return `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:#e8dcc0;box-shadow:0 0 0 1px #2a1d10;margin-right:3px;vertical-align:1px"></span>`;
  }
}

interface LabelEntry { obj: CSS2DObject; maxAlt: number; minAlt: number; opacity: number }

export class MapLabels {
  readonly scene = new THREE.Scene();
  private readonly settlements: LabelEntry[] = [];
  private readonly kingdomLabels: LabelEntry[] = [];
  private readonly markers = new Map<number, { obj: CSS2DObject; seen: number; key: string }>();
  private frame = 0;

  constructor(world: WorldModel) {
    for (const s of world.settlements) {
      const st = STYLE[s.kind] ?? STYLE.village;
      const kd = world.kingdoms[s.kingdom];
      const el = document.createElement('div');
      el.style.cssText = `font: ${st.font} Georgia, 'Times New Roman', serif; color: #f6ecd2; white-space: nowrap; pointer-events: none;
        text-shadow: 0 1px 2px #1a120a, 0 0 4px #1a120a, 0 0 8px rgba(26,18,10,0.6); letter-spacing: ${s.kind === 'city' || s.kind === 'town' ? '0.08em' : '0.03em'};
        ${s.kind === 'city' ? 'font-variant: small-caps; font-size: 19px;' : ''} transition: opacity 0.2s;`;
      el.innerHTML = `${badgeHtml(st.badge, kd ? hex(kd.color) : '#888')}${s.name}`;
      const obj = new CSS2DObject(el);
      obj.position.set(s.x, 0, s.z);
      obj.center.set(0.08, 0.5);
      obj.visible = false;
      this.scene.add(obj);
      this.settlements.push({ obj, maxAlt: st.maxAlt, minAlt: 350, opacity: -1 });
    }
    for (const kd of world.kingdoms) {
      let sx = 0, sz = 0, n = 0;
      const m = world.macro;
      for (let c = 0; c < m.res * m.res; c += 7) {
        if (m.kingdom[c] === kd.id + 1) { sx += ((c % m.res) + 0.5) * m.cell; sz += (Math.floor(c / m.res) + 0.5) * m.cell; n++; }
      }
      if (!n) continue;
      const el = document.createElement('div');
      el.style.cssText = `font: 600 26px Georgia, 'Times New Roman', serif; font-variant: small-caps; letter-spacing: 0.35em; color: rgba(60, 22, 18, 0.78);
        text-shadow: 0 0 6px rgba(246,236,210,0.85), 0 0 2px rgba(246,236,210,0.9); white-space: nowrap; pointer-events: none;`;
      el.textContent = kd.name;
      const obj = new CSS2DObject(el);
      obj.position.set(sx / n, 0, sz / n);
      obj.visible = false;
      this.scene.add(obj);
      this.kingdomLabels.push({ obj, maxAlt: 1e9, minAlt: 7000, opacity: -1 });
    }
  }

  update(altitude: number, heightAt: (x: number, z: number) => number, markers: readonly MapMarker[], mapBlend: number): void {
    this.frame++;
    const show = mapBlend > 0.02;
    const fade = (e: LabelEntry, alt: number) => {
      let op = 0;
      if (show) {
        const inFade = Math.min(1, (alt - e.minAlt) / Math.max(1, e.minAlt * 0.6));
        const outFade = e.maxAlt >= 1e8 ? 1 : Math.min(1, (e.maxAlt - alt) / (e.maxAlt * 0.25));
        op = Math.max(0, Math.min(inFade, outFade)) * mapBlend;
      }
      e.obj.visible = op > 0.02;
      const r = Math.round(op * 50) / 50;
      if (r !== e.opacity) { e.opacity = r; e.obj.element.style.opacity = String(r); }
    };
    for (const e of this.settlements) {
      if (e.obj.position.y === 0) e.obj.position.y = heightAt(e.obj.position.x, e.obj.position.z) + 8;
      fade(e, altitude);
    }
    for (const e of this.kingdomLabels) {
      if (e.obj.position.y === 0) e.obj.position.y = Math.max(0, heightAt(e.obj.position.x, e.obj.position.z)) + 30;
      fade(e, altitude);
    }
    // markers (pooled by id)
    for (const mk of markers) {
      let ent = this.markers.get(mk.id);
      const key = `${mk.kind}|${mk.color}|${mk.label ?? ''}|${Math.round(Math.log2(1 + mk.size))}`;
      if (!ent || ent.key !== key) {
        if (ent) { this.scene.remove(ent.obj); ent.obj.element.remove(); }
        const el = document.createElement('div');
        const sz = mk.kind === 'player' ? 14 : Math.min(26, 9 + Math.log2(1 + mk.size) * 2.2);
        const shape = mk.kind === 'army' || mk.kind === 'bandits' ? 'transform: rotate(45deg); border-radius: 2px;'
          : mk.kind === 'battle' || mk.kind === 'siege' ? 'border-radius: 2px;' : 'border-radius: 50%;';
        const ring = mk.kind === 'player' ? 'border: 3px solid #f2c14e; background: rgba(0,0,0,0.25);' : `border: 2px solid #f6ecd2; background: ${hex(mk.color)};`;
        // icon centred on the position, caption underneath (settlement names sit to the right)
        el.style.cssText = 'pointer-events: none; white-space: nowrap; font: italic 600 11px Georgia, serif; color: #f6ecd2; text-shadow: 0 1px 2px #000, 0 0 5px #000; display: flex; flex-direction: column; align-items: center;';
        el.innerHTML = `<span style="display:block;width:${sz}px;height:${sz}px;${shape}${ring}box-shadow:0 0 0 1px #1a120a, 0 2px 4px rgba(0,0,0,0.5)"></span>${mk.label ? `<span style="margin-top:3px">${mk.label}</span>` : ''}`;
        const obj = new CSS2DObject(el);
        obj.center.set(0.5, mk.label ? 0.25 : 0.5);
        this.scene.add(obj);
        ent = { obj, seen: this.frame, key };
        this.markers.set(mk.id, ent);
      }
      ent.seen = this.frame;
      ent.obj.position.set(mk.x, heightAt(mk.x, mk.z) + 10, mk.z);
      ent.obj.visible = show;
      ent.obj.element.style.opacity = String(Math.min(1, mapBlend * 1.2));
    }
    for (const [id, ent] of this.markers) {
      if (ent.seen !== this.frame) { this.scene.remove(ent.obj); ent.obj.element.remove(); this.markers.delete(id); }
    }
  }

  dispose(): void {
    this.scene.traverse((o) => { if (o instanceof CSS2DObject) o.element.remove(); });
    this.scene.clear();
    this.markers.clear();
  }
}
