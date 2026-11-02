// The tactical view (civilization pass, wave B; docs/CIV.md §9, docs/WAR.md): C in a battle in which you command men. The camera
// rises over the field (the renderer's overview), the world runs slow (a quarter pace), the groups are banners over their men with
// their orders drawn on the ground, and the mouse commands: click the ground to march the selected group there in order (Alt or
// Shift: just move, without engaging on the way), click an enemy to send them at him, drag a banner to move its group, wheel to
// zoom, right button to turn the view, WASD or the arrows to pan. C or Esc leaves; the camera and the speed are put back.
// Registered as the ext panel 'battle'; the group bar, banners and order buttons are the HUD part's (src/ui/hud/battle.ts).
import { SLOW_SPEED } from '../../core/time';
import {
  ORDER_CHOICES, clickOrder, dragOrder, orderMarks, overviewFor, selectionAfter, type OrderMarkShape, type OrderChoice,
} from '../../sim/military/commandModel';
import type { BattleGroupView, GroupKey, MilitaryApi } from '../../sim/wave3';
import type { PanelCtx, UiPanel } from '../app/panel';
import { h } from '../core/dom';
import type { HudPartCtx } from '../core/extHud';
import { icon, type IconName } from '../core/icons';
import { BannerLayer, GroupBar, battleBus, ensureBattleStyle, isEnemy, readBattle } from '../hud/battle';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

const CSS = `
.mu-tac { position: absolute; inset: 0; pointer-events: none; }
.mu-tac-field { position: absolute; inset: 0; pointer-events: auto; cursor: crosshair; }
.mu-tac-head { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); padding: 6px 14px; border-radius: 6px; background: rgba(26, 17, 9, 0.85); border: 1px solid #8c6b36;
  color: #f6ead0; font-size: 12.5px; text-align: center; pointer-events: none; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); }
.mu-tac-head b { color: var(--gold-hi); font-size: 14px; letter-spacing: 0.04em; }
.mu-tac-head .keys { margin-top: 2px; opacity: 0.85; }
.mu-tac-leave { position: absolute; right: 18px; top: 14px; pointer-events: auto; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--edge); cursor: pointer; font: inherit; font-size: 13px; font-weight: 700;
  background: linear-gradient(180deg, rgba(246, 234, 208, 0.96), rgba(221, 198, 144, 0.96)); color: var(--ink); }
.mu-tac-orders { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; gap: 5px; pointer-events: auto; }
.mu-tac-orders .mu-bt-op { position: relative; margin: 0; width: 84px; height: 44px; left: auto; top: auto; }
.mu-tac .mu-bt-bar { bottom: 70px; }
.mu-tac .mu-bt-banner.own { pointer-events: auto; cursor: grab; }
.mu-tac .mu-bt-banner.own.dragging { cursor: grabbing; opacity: 0.85; }
`;
let styled = false;
function style(): void {
  ensureBattleStyle();
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.id = 'mu-tactical-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function tacticalPanel(ctx: PanelCtx): UiPanel {
  style();
  const game = ctx.game;
  const mil = game.sim.services.military as MilitaryApi | undefined;
  const r = ctx.host.renderer();
  // PanelCtx → what the banner layer and the reading helpers want
  const k = ctx.toLocal({ x: 1000, y: 1000 }).x / 1000;
  const hudCtx: HudPartCtx = {
    game: () => game, host: ctx.host, open: (req) => ctx.open(req), isOpen: () => false, say: (kind, text) => ctx.say(kind, text), scale: () => (k > 0 ? 1 / k : 1),
  };

  let own: readonly BattleGroupView[] = [];
  let enemy: readonly BattleGroupView[] = [];
  let sig = '';
  let drag: { key: GroupKey; sx: number; sy: number; moved: boolean; ground: { x: number; z: number } | null } | null = null;
  let orbit: { x: number; y: number } | null = null;
  const held = new Set<string>();
  let prevSpeed = 1;
  let usedPose = false;
  let field0: { x: number; z: number; radius: number; distance: number } | null = null;
  let verifyAt = 0;

  /** Is the overhead camera really up (the field's centre near the middle of the screen)? If the renderer has none, a free camera does it. */
  function verifyOverview(): void {
    if (!r || !field0) return;
    const gy = game.sim.world.heightAt(field0.x, field0.z);
    const p = r.project(field0.x, gy, field0.z);
    const w = window.innerWidth, hh = window.innerHeight;
    if (p && Math.abs(p.x - w / 2) < w * 0.22 && Math.abs(p.y - hh / 2) < hh * 0.28) return;
    r.setCameraPose?.({ x: field0.x, y: gy + field0.distance * 0.9, z: field0.z - field0.distance * 0.55 }, { x: field0.x, y: gy, z: field0.z }, 0.8);
    usedPose = true;
  }

  const bar = new GroupBar((key) => pick(key));
  const banners = new BannerLayer(hudCtx, true);
  const field = h('div.mu-tac-field');
  const head = h('div.mu-tac-head', null, h('b', null, 'Tactical view'), h('div', null, 'The world runs slow while you give your orders'),
    h('div.keys', null, 'Click ground: advance · Alt-click: move · click an enemy: attack · drag a banner · wheel: zoom · right-drag: turn · WASD: pan · C or Esc: leave'));
  const leave = h<HTMLButtonElement>('button.mu-tac-leave', { type: 'button' }, 'Leave  (C)');
  leave.addEventListener('click', () => ctx.close());
  const orders = h('div.mu-tac-orders');
  for (const o of ORDER_CHOICES) {
    const b = h<HTMLButtonElement>('button.mu-bt-op', { type: 'button', title: o.hint }, h('span.k', null, String(o.n)), icon(o.icon as IconName, 15), h('span', null, o.label));
    b.addEventListener('click', () => give(o));
    orders.append(b);
  }
  const root = h('div.mu-tac', null, field, banners.el, head, leave, bar.el, orders);

  function pick(key: GroupKey): void {
    battleBus.selected = selectionAfter(battleBus.selected, key, own);
    sig = '';
  }

  function give(o: OrderChoice): void {
    if (!mil?.orderGroup) return;
    const key = battleBus.selected ?? 'all';
    // in this view "advance" and "charge" without a point go where the group already looks, or at the enemy
    const order = o.order({ ahead: null, target: 0 });
    const res = mil.orderGroup(key, order);
    ctx.say(res.ok ? 'info' : 'warn', res.ok ? `${o.label}!` : res.reason ?? 'That cannot be done.');
  }

  const local = (e: PointerEvent | MouseEvent): { x: number; y: number } => ({ x: e.clientX, y: e.clientY });

  function onFieldDown(e: PointerEvent): void {
    if (e.button === 2 || e.button === 1) { orbit = { x: e.clientX, y: e.clientY }; field.setPointerCapture?.(e.pointerId); e.preventDefault(); return; }
    if (e.button !== 0 || !mil?.orderGroup || !r) return;
    const key = battleBus.selected ?? 'all';
    const p = local(e);
    const ground = r.screenToGround(p.x, p.y);
    const hit = r.pick?.(p.x, p.y);
    const target = hit && hit.type === 'character' && hit.id !== undefined && isEnemy(game, hit.id) ? hit.id : 0;
    const order = clickOrder(key, ground, target, e.altKey || e.shiftKey);
    if (!order) return;
    const res = mil.orderGroup(key, order);
    ctx.say(res.ok ? 'info' : 'warn', res.ok ? (order.kind === 'advance' ? 'Advance!' : order.kind === 'move' ? 'Move!' : order.kind === 'loose' ? 'Loose!' : 'Charge!') : res.reason ?? 'That cannot be done.');
  }
  function onFieldMove(e: PointerEvent): void {
    if (orbit && r?.orbit) {
      r.orbit(-(e.clientX - orbit.x) * 0.006, -(e.clientY - orbit.y) * 0.004);
      orbit = { x: e.clientX, y: e.clientY };
    }
  }
  function onFieldUp(e: PointerEvent): void { if (orbit) { orbit = null; field.releasePointerCapture?.(e.pointerId); } }
  field.addEventListener('pointerdown', onFieldDown);
  field.addEventListener('pointermove', onFieldMove);
  field.addEventListener('pointerup', onFieldUp);
  field.addEventListener('contextmenu', (e) => e.preventDefault());
  field.addEventListener('wheel', (e) => { e.preventDefault(); r?.zoom?.(e.deltaY > 0 ? 1 : -1); }, { passive: false });

  // dragging a banner moves its group
  banners.el.addEventListener('pointerdown', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.mu-bt-banner.own');
    if (!el || e.button !== 0) return;
    const key = el.dataset.key as GroupKey | undefined;
    if (!key) return;
    drag = { key, sx: e.clientX, sy: e.clientY, moved: false, ground: null };
    el.classList.add('dragging');
    banners.el.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  banners.el.addEventListener('pointermove', (e) => {
    if (!drag || !r) return;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) drag.moved = true;
    if (drag.moved) drag.ground = r.screenToGround(e.clientX, e.clientY);
  });
  banners.el.addEventListener('pointerup', (e) => {
    const d = drag;
    drag = null;
    banners.el.releasePointerCapture?.(e.pointerId);
    for (const el of banners.el.querySelectorAll('.dragging')) el.classList.remove('dragging');
    if (!d) return;
    if (!d.moved || !d.ground) { pick(d.key); return; }
    const res = mil?.orderGroup?.(d.key, dragOrder(d.ground));
    if (res) ctx.say(res.ok ? 'info' : 'warn', res.ok ? 'Move!' : res.reason ?? 'That cannot be done.');
  });

  // panning with the keys while the view is up (the UI holds the keyboard for the panel, so the panel listens itself)
  const onKeyDown = (e: KeyboardEvent): void => { if (/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(e.code)) { held.add(e.code); e.preventDefault(); } };
  const onKeyUp = (e: KeyboardEvent): void => { held.delete(e.code); };

  function marks(): OrderMarkShape[] {
    const list = orderMarks(own, enemy, battleBus.selected, (id) => { const a = game.zone.agent(id); return a ? { x: a.x, z: a.z } : null; });
    if (drag?.moved && drag.ground) {
      const g = own.find((x) => x.key === drag!.key);
      if (g) list.push({ id: 9999, kind: 'move', from: { x: g.x, z: g.z }, to: { ...drag.ground }, tone: 'selected' });
    }
    return list;
  }

  function enter(): void {
    const b = ctx.player.body();
    const view = readBattle({ game: () => game });
    own = view.own; enemy = view.enemy;
    const ov = overviewFor(own, enemy, b ? { x: b.x, z: b.z } : null);
    field0 = ov;
    if (r && ov) {
      r.setOverview?.({ x: ov.x, z: ov.z, radius: ov.radius, distance: ov.distance });
      // the UI's renderer controls always have a setOverview; whether the renderer behind it draws one is found out in a moment (tick)
      verifyAt = performance.now() / 1000 + 1.8;
    }
    // the world slows
    prevSpeed = game.sim.view.clock().speed;
    ctx.dispatch({ type: 'setSpeed', speed: SLOW_SPEED });
    ctx.host.releaseMouseLook?.();
    battleBus.tactical = true;
    battleBus.closeTactical = () => ctx.close();
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
  }

  function leaveView(): void {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    if (r) {
      r.setOrderMarks?.(null);
      r.setOverview?.(null);
      if (usedPose) r.setCameraMode('follow');
    }
    battleBus.tactical = false;
    battleBus.closeTactical = null;
    banners.clear();
    // the world runs at its own pace again
    const back = prevSpeed >= 1 ? prevSpeed : 1;
    if (!ctx.dispatch({ type: 'setSpeed', speed: back as 1 | 3 | 8 }).ok) ctx.dispatch({ type: 'setSpeed', speed: 1 });
  }

  let nextRead = 0;
  const panel = panelOf({ id: 'battle', captures: true, pauses: 'never', escape: 'close', mode: 'clear' }, root, {
    mount: () => enter(),
    tick: (now) => {
      if (now >= nextRead) {
        nextRead = now + 0.1;
        const view = readBattle({ game: () => game });
        own = view.own; enemy = view.enemy;
        if (own.length === 0 && enemy.length === 0) { ctx.close(); return; } // the battle is over
        const s = own.map((g) => `${g.key}:${g.count}:${g.order}:${Math.round(g.morale * 10)}:${g.engaged ? 1 : 0}`).join(';') + `|${battleBus.selected}`;
        if (s !== sig) { sig = s; bar.paint(own, battleBus.selected); }
        r?.setOrderMarks?.(marks());
      }
      banners.update(own, enemy, battleBus.selected);
      if (verifyAt > 0 && performance.now() / 1000 >= verifyAt) { verifyAt = 0; verifyOverview(); }
      // pan with the keys
      if (r?.pan && held.size > 0) {
        const dx = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
        const dy = (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0) - (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0);
        if (dx || dy) r.pan(dx * 14, dy * 14);
      }
    },
    dispose: () => leaveView(),
  });
  return panel;
}

registerPanel('battle', (ctx) => tacticalPanel(ctx));
