// Build mode (B, docs/CIV.md §5): the camera rises over your land and anything in it can be changed. Grow your seat
// into a castle stage by stage; pick a building from the catalogue and place its ghost (green fits, red says why; Q/E
// turn it); click a building to raise it a level, repair it or pull it down; follow the works under way. Drag with the
// right button (or W A S D, the arrows) to move over the land, the wheel to come closer. Esc or B leaves.
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { BuildCategory, BuildOption, ConstructionApi } from '../../sim/construction/types';
import type { RealmApi } from '../../sim/realm/types';
import { h } from '../core/dom';
import { formatMoney, pct, plural } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { bar, button, chip, empty, heading } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

const CATS: ReadonlyArray<{ id: BuildCategory; label: string; icon: IconName }> = [
  { id: 'defence', label: 'Castle and defence', icon: 'castle' },
  { id: 'military', label: 'Arms', icon: 'swords' },
  { id: 'home', label: 'Homes', icon: 'home' },
  { id: 'farm', label: 'Farm', icon: 'wheat' },
  { id: 'food', label: 'Mills, ovens, ale', icon: 'bread' },
  { id: 'craft', label: 'Crafts', icon: 'hammer' },
  { id: 'resource', label: 'Quarries and mines', icon: 'ingot' },
  { id: 'civic', label: 'Town', icon: 'market' },
  { id: 'religion', label: 'Church', icon: 'church' },
];

function goodsLine(goods: Readonly<Record<string, number>>): string {
  return Object.entries(goods).filter(([, n]) => n > 0).map(([g, n]) => `${n} ${g}`).join(', ');
}

export function buildPanel(ctx: PanelCtx): UiPanel {
  const sim = ctx.sim;
  const C = sim.services.construction as ConstructionApi | undefined;
  const R = sim.services.realm as RealmApi | undefined;
  const ctl = ctx.host.renderer();
  const win = createWindow({ title: 'Build', subtitle: '', icon: 'hammer', size: 'sm', tall: true, onClose: () => ctx.close() });
  win.el.classList.add('mu-build-win');
  const content = h('div.mu-build');
  win.body.append(content);
  const me = (): number => ctx.playerId();
  const scope = C ? C.scope(me()) : null;

  // ---- the builder's view ----
  const p0 = ctx.player.body();
  const seatPlan = C?.seatPlan?.(me());
  const seat = seatPlan ? sim.state.buildings.get(seatPlan.seat) : undefined;
  const cam = { x: seat?.x ?? p0?.x ?? 0, z: seat?.z ?? p0?.z ?? 0, dist: 120, yaw: ctl?.cameraYaw?.() ?? 0 };
  const placeCamera = (): void => {
    if (!ctl?.setCameraPose) return;
    const y = Math.max(0, sim.world.heightAt(cam.x, cam.z));
    const back = cam.dist * 0.75;
    ctl.setCameraPose(
      { x: cam.x - Math.sin(cam.yaw) * back, y: y + cam.dist * 0.8, z: cam.z - Math.cos(cam.yaw) * back },
      { x: cam.x, y, z: cam.z }, 0);
  };

  // ---- state ----
  let placing: BuildOption | null = null;
  /** A wall or palisade is laid in a line: the first click sets where it starts. */
  let lineFrom: { x: number; z: number } | null = null;
  let rot = cam.yaw + Math.PI;
  let mouse: { x: number; y: number } | null = null;
  let selected = -1;
  let tab: 'seat' | 'build' | 'works' = 'seat';
  let message = '';
  let sig = '';

  const say = (r: { ok: boolean; reason?: string }, ok: string): void => {
    message = r.ok ? ok : r.reason ?? 'That cannot be done.';
    ctx.say(r.ok ? 'info' : 'warn', message);
    sig = '';
    render();
  };

  const updateGhost = (): void => {
    if (!ctl?.setGhost || !C) return;
    if (!placing || !mouse) { ctl.setGhost(null); return; }
    const g = ctl.screenToGround(mouse.x, mouse.y);
    if (!g) { ctl.setGhost(null); return; }
    const segment = !!BUILDINGS[placing.kind].segment;
    // a wall follows the line from where it starts to the cursor
    const r0 = segment && lineFrom ? Math.atan2(-(g.z - lineFrom.z), g.x - lineFrom.x) : rot;
    const chk = C.check(me(), placing.kind, g.x, g.z, r0);
    ghostReason = chk.ok ? '' : chk.reason ?? '';
    ctl.setGhost({ kind: placing.kind, level: 1, x: g.x, z: g.z, rot: r0, ok: chk.ok, footprint: chk.footprint });
    if (segment) {
      const len = lineFrom ? Math.hypot(g.x - lineFrom.x, g.z - lineFrom.z) : 0;
      const n = lineFrom ? Math.max(1, Math.round(len / (BUILDINGS[placing.kind].w + 0.05))) : 0;
      ctl.setBuildArea?.(lineFrom ? [[lineFrom, { x: g.x, z: g.z }, { x: g.x + 0.01, z: g.z + 0.01 }]] : null);
      tipEl.textContent = lineFrom
        ? `${Math.round(len)} m: ${n} lengths, ${formatMoney(placing.cost.pence * n)} · click to lay it`
        : `${BUILDINGS[placing.kind].name}: click where it starts, then where it ends`;
    } else tipEl.textContent = chk.ok ? `${BUILDINGS[placing.kind].name}: click to stake it out · Q / E turn it` : ghostReason;
    tipEl.classList.toggle('bad', !chk.ok);
    tipEl.style.left = `${mouse.x + 16}px`;
    tipEl.style.top = `${mouse.y + 14}px`;
  };
  let ghostReason = '';
  const tipEl = h('div.mu-build-tip');

  // ---- the panel's pages ----
  const seatPage = (): HTMLElement => {
    const plan = C?.seatPlan?.(me());
    if (!plan) return empty('You hold no seat. Rule a manor to raise a castle.', { icon: 'castle' });
    const next = plan.next;
    return h('div.mu-col.mu-gap-8', null,
      h('ul.mu-build-stages', null, plan.stages.map((s) => h('li', { class: s.done ? 'done' : next && s.label === next.label ? 'next' : '' },
        icon(s.done ? 'check' : 'dot', 12), ' ', s.label))),
      plan.underway ? h('div.mu-card', null,
        h('b', null, 'Under way'), h('div.mu-small.mu-dim', null, plan.underway.note ?? ''), bar('gold', plan.underway.progress, { thin: true }).el) : null,
      next ? h('div.mu-card', null,
        h('b', null, next.label),
        h('div.mu-small.mu-dim', null, `${formatMoney(next.cost.pence)} · ${goodsLine(next.cost.goods)} · ${plural(next.cost.labour, 'worker-day')}`),
        h('div', { style: { marginTop: '6px' } }, button('Begin', { variant: 'primary', icon: 'hammer', onClick: () => {
          const r = C!.expandSeat!(me());
          if (r.ok) { const s = C!.site(r.site!); if (s) { cam.x = s.x; cam.z = s.z; placeCamera(); } }
          say(r, `Work begins: ${next.label.toLowerCase()}.`);
        } }))) : !plan.underway ? h('p.mu-small.mu-ital', null, 'Your castle is complete.') : null,
    );
  };

  const buildPage = (): HTMLElement => {
    if (!C || !scope) return empty('Nothing can be built here.');
    const here = sim.world.settlementAt(cam.x, cam.z)?.id ?? scope.settlements[0] ?? ctx.sim.state.persons.get(me())?.settlement ?? 0;
    const cat = C.catalogue(me(), here);
    return h('div.mu-col.mu-gap-6', null, CATS.map((c) => {
      const items = cat.filter((o) => o.category === c.id);
      if (!items.length) return null;
      return h('div', null, h('div.mu-build-cat', null, icon(c.icon, 13), ` ${c.label}`),
        h('div.mu-build-grid', null, items.map((o) => h('button.mu-build-item', {
          type: 'button', class: `${o.ok ? '' : 'off'}${placing?.kind === o.kind ? ' sel' : ''}`,
          tip: `${o.does}\n${formatMoney(o.cost.pence)} · ${goodsLine(o.cost.goods)} · ${plural(o.cost.labour, 'worker-day')}${o.ok ? '' : `\n${o.reason}`}`,
          onclick: () => { placing = placing?.kind === o.kind ? null : o; lineFrom = null; selected = -1; sig = ''; render(); updateGhost(); },
        }, h('span.mu-build-name', null, o.name), h('span.mu-build-cost', null, formatMoney(o.cost.pence))))));
    }));
  };

  /** Who of your own is set to a site, and buttons to set more to it or send them home. */
  const peopleRow = (site: number): HTMLElement => {
    const on = C!.workersAt(site);
    const free = C!.assignable?.(me(), site) ?? [];
    const names = on.slice(0, 4).map((id) => ctx.nameOf(id).split(' ')[0]).join(', ');
    return h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '6px' } },
      h('span.mu-small', null, icon('users', 13), on.length ? ` ${names}${on.length > 4 ? ` and ${on.length - 4} more` : ''} at work` : ' None of your people at it'),
      button(`Set ${Math.min(4, free.length)} to it`, { size: 'small', icon: 'plus', disabled: free.length === 0,
        tip: free.length ? 'Your servants first, then the serfs and labourers of the place' : 'Nobody free to set to it',
        onClick: () => say(C!.assign!(me(), site, [...on, ...free.slice(0, 4)]), 'They go to the work.') }),
      on.length ? button('Send them home', { size: 'small', onClick: () => say(C!.assign!(me(), site, []), 'They go back to their day.') }) : null);
  };

  const worksPage = (): HTMLElement => {
    const sites = C ? C.sites().filter((s) => scope?.settlements.includes(s.settlement) || s.household === scope?.household) : [];
    if (!sites.length) return empty('No works under way.');
    return h('div.mu-col.mu-gap-6', null, sites.map((s) => h('div.mu-card', null,
      h('div.mu-row.mu-between', null, h('b', null, `${s.work === 'build' ? '' : `${s.work[0].toUpperCase()}${s.work.slice(1)}: `}${BUILDINGS[s.kind].name}`),
        s.status === 'working' ? button('Stop', { size: 'small', variant: 'danger', onClick: () => say(C!.cancel(me(), s.id), 'The work is stopped.') }) : chip(s.status, s.status === 'done' ? 'green' : '')),
      h('div.mu-small.mu-dim', null, s.note ?? `${pct(s.progress)} done`),
      bar(s.status === 'done' ? 'green' : 'gold', s.progress, { thin: true }).el,
      s.status === 'working' && C?.assign ? peopleRow(s.id) : null,
      h('button.mu-link.mu-small', { type: 'button', onclick: () => { cam.x = s.x; cam.z = s.z; placeCamera(); } }, 'Look at it'))));
  };

  const selectedCard = (): HTMLElement | null => {
    if (selected < 0 || !C) return null;
    const b = sim.state.buildings.get(selected);
    if (!b) return null;
    const def = BUILDINGS[b.kind];
    const site = C.siteOf(b.id);
    const up = b.level < def.maxLevel ? C.cost(b.kind, b.level + 1) : null;
    return h('div.mu-card.sel', null,
      h('div.mu-row.mu-between', null, h('b', null, def.name), chip(`Level ${b.level} of ${def.maxLevel}`, '', 'trend_up')),
      h('div.mu-small.mu-dim', null, `${sim.world.settlements[b.settlement]?.name ?? ''}${b.construction < 1 ? ` · ${pct(b.construction)} built` : ''}${b.damage > 0.01 ? ` · ${pct(b.damage)} damaged` : ''}${site ? ` · ${site.note ?? ''}` : ''}`),
      h('div.mu-row.mu-wrap.mu-gap-6', { style: { marginTop: '8px' } },
        up ? button(`Raise to level ${b.level + 1} · ${formatMoney(up.pence)}`, { size: 'small', variant: 'primary', icon: 'trend_up', onClick: () => say(C.upgrade(me(), b.id), `Work begins to enlarge the ${def.name.toLowerCase()}.`) }) : null,
        b.damage > 0.01 ? button('Repair', { size: 'small', icon: 'hammer', onClick: () => say(C.repair(me(), b.id), 'Repairs begin.') }) : null,
        button('Pull down', { size: 'small', variant: 'danger', icon: 'cross', onClick: () => ctx.confirm({
          title: `Pull down the ${def.name.toLowerCase()}?`, text: 'It will be gone for good.', confirmLabel: 'Pull it down', danger: true,
          onConfirm: () => { const r = C.demolish(me(), b.id); if (r.ok) selected = -1; say(r, `The ${def.name.toLowerCase()} is to be pulled down.`); },
        }) })));
  };

  const tabsEl = h('div.mu-build-tabs');
  const render = (): void => {
    const purse = scope ? sim.state.households.get(scope.household)?.purse ?? 0 : 0;
    const key = `${tab}|${C?.version() ?? 0}|${R?.version() ?? 0}|${placing?.kind ?? ''}|${selected}|${Math.floor(purse)}|${sim.state.buildingRevision}`;
    if (key === sig) return;
    sig = key;
    win.setTitle('Build', scope ? `${scope.label} · ${formatMoney(purse)}` : '');
    tabsEl.replaceChildren(...(['seat', 'build', 'works'] as const).map((t) => h('button.mu-build-tab', {
      type: 'button', class: t === tab ? 'on' : '', onclick: () => { tab = t; sig = ''; render(); },
    }, t === 'seat' ? 'Your seat' : t === 'build' ? 'New building' : 'Works')));
    content.replaceChildren(
      tabsEl,
      h('p.mu-tiny.mu-dim', { style: { margin: '2px 0 8px' } }, 'Click a building to change it. Drag with the right button or W A S D to move; wheel to zoom.'),
      ...[selectedCard()].filter((x): x is HTMLElement => !!x),
      heading(tab === 'seat' ? 'Your seat becomes a castle' : tab === 'build' ? 'Choose, then place it' : 'Works under way', tab === 'seat' ? 'castle' : tab === 'build' ? 'hammer' : 'hourglass'),
      tab === 'seat' ? seatPage() : tab === 'build' ? buildPage() : worksPage(),
    );
  };

  // ---- input on the land ----
  const panel = panelOf({ id: 'build', group: 'main', pauses: 'never', mode: 'clear' }, h('div.mu-build-dock', null, win.el));
  const land = panel.el;
  land.classList.add('mu-build-land');
  land.append(tipEl);
  let drag: { x: number; y: number; button: number; moved: number } | null = null;
  land.addEventListener('contextmenu', (e) => e.preventDefault());
  land.addEventListener('mousedown', (e) => {
    if (e.target !== land) return;
    drag = { x: e.clientX, y: e.clientY, button: e.button, moved: 0 };
  });
  window.addEventListener('mouseup', onUp);
  window.addEventListener('mousemove', onMove);
  land.addEventListener('wheel', (e) => {
    if (e.target !== land) return;
    e.preventDefault();
    cam.dist = Math.max(30, Math.min(420, cam.dist * (e.deltaY > 0 ? 1.12 : 0.89)));
    placeCamera(); updateGhost();
  }, { passive: false });
  function onMove(e: MouseEvent): void {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.button === 2 || drag.button === 1) {
        // grab the land: it follows the mouse (camera forward = (sin, cos) of the yaw, camera right = (−cos, sin))
        const k = cam.dist / 600;
        const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
        cam.x += (c * dx + s * dy) * k;
        cam.z += (-s * dx + c * dy) * k;
        placeCamera();
      }
      drag.x = e.clientX; drag.y = e.clientY;
    }
    if (e.target === land || placing) { mouse = { x: e.clientX, y: e.clientY }; updateGhost(); }
    else if (!placing) tipEl.textContent = '';
  }
  function onUp(e: MouseEvent): void {
    const d = drag;
    drag = null;
    if (!d || d.moved > 6 || e.target !== land) return;
    if (d.button === 0 && placing && C) {
      const g = ctl?.screenToGround(e.clientX, e.clientY);
      if (!g) return;
      if (BUILDINGS[placing.kind].segment && C.placeLine) {
        if (!lineFrom) { lineFrom = { x: g.x, z: g.z }; updateGhost(); return; }
        const r = C.placeLine(me(), placing.kind, lineFrom, g);
        say(r, `The ${placing.name.toLowerCase()} is laid out.`);
        if (r.ok) { lineFrom = e.shiftKey ? { x: g.x, z: g.z } : null; if (!e.shiftKey) { placing = null; ctl?.setGhost?.(null); tipEl.textContent = ''; } }
        ctl?.setBuildArea?.(null);
        return;
      }
      const r = C.place(me(), placing.kind, g.x, g.z, rot);
      say(r, `The ${placing.name.toLowerCase()} is staked out.`);
      if (r.ok && !e.shiftKey) { placing = null; ctl?.setGhost?.(null); tipEl.textContent = ''; }
      return;
    }
    if (d.button === 0) {
      const id = ctl?.buildingAt?.(e.clientX, e.clientY);
      selected = id ?? -1;
      sig = ''; render();
    }
    if (d.button === 2 && placing) { placing = null; lineFrom = null; ctl?.setGhost?.(null); ctl?.setBuildArea?.(null); tipEl.textContent = ''; sig = ''; render(); }
  }
  const keys = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const step = cam.dist * 0.12;
    const c = Math.cos(cam.yaw), s = Math.sin(cam.yaw);
    const move = (f: number, r: number): void => { cam.x += (s * f - c * r) * step; cam.z += (c * f + s * r) * step; placeCamera(); updateGhost(); };
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': move(1, 0); break;
      case 'KeyS': case 'ArrowDown': move(-1, 0); break;
      case 'KeyA': case 'ArrowLeft': move(0, -1); break;
      case 'KeyD': case 'ArrowRight': move(0, 1); break;
      case 'KeyQ': rot -= Math.PI / 12; updateGhost(); break;
      case 'KeyE': rot += Math.PI / 12; updateGhost(); break;
      case 'KeyR': cam.yaw += Math.PI / 8; placeCamera(); updateGhost(); break;
      case 'KeyB': ctx.close(); break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', keys, true);

  // the land you may build on
  const area = (scope?.settlements ?? []).map((sid) => {
    const st = sim.world.settlements[sid];
    if (!st) return [];
    return Array.from({ length: 40 }, (_, i) => ({ x: st.x + Math.cos((i / 40) * Math.PI * 2) * 700, z: st.z + Math.sin((i / 40) * Math.PI * 2) * 700 }));
  });

  return {
    ...panel,
    mount() {
      placeCamera();
      ctl?.setBuildArea?.(area.filter((a) => a.length));
      render();
    },
    tick() { render(); },
    onEscape() {
      if (lineFrom) { lineFrom = null; ctl?.setBuildArea?.(null); updateGhost(); return true; }
      if (placing) { placing = null; ctl?.setGhost?.(null); tipEl.textContent = ''; sig = ''; render(); return true; }
      return false;
    },
    dispose() {
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', keys, true);
      ctl?.setGhost?.(null);
      ctl?.setBuildArea?.(null);
      ctl?.setCameraMode('follow');
    },
  };
}

registerPanel('build', (ctx) => buildPanel(ctx));
