// Builder mode (B; docs/CIV.md §5): the camera lifts over your land, the land you may build on is tinted, a catalogue of what
// you may raise (and, for what you may not, why), a ghost that follows the cursor — green where it fits, red with the reason where
// it does not —, a click that stakes a site out, "Place for me", the buildings and sites you click, and a queue of all your works.
// The world keeps running; the HUD keeps its clock and feed. Esc or B leaves and the camera goes back.
import techsJson from '../../content/techs.json';
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { BuildCategory, BuildOption, BuildScope, PlacementCheck, PlaceOptions, SiteView } from '../../sim/construction/types';
import type { PanelCtx, UiPanel } from '../app/panel';
import { bar, button, chip, empty, iconButton, seg, tabs, type TabsHandle } from '../components/widgets';
import { createWindow } from '../components/window';
import { append, clear, h, isTypingTarget, replace } from '../core/dom';
import { icon } from '../core/icons';
import { every, panelOf } from '../panels/base';
import { registerPanel } from '../panels/extRegistry';
import { ruleOffer } from '../ruler/ruleTown';
import { BuilderCamera } from './builderCamera';
import {
  CATEGORY_ICON, CATEGORY_LABEL, CATEGORY_ORDER, ROTATE_STEP, categoryCounts, cleanOutpostName, conditionWords, costLines, costSummary, cursorTip,
  defaultOutpostName, filterCatalogue, ghostFrom, manageOptions, nearestOf, noBuildCard, overviewPlan, ownerWords, priorityFor, queueRows,
  requirementLines, rotate, shortfall, siteCard, whereOptions, STATUS_TONE, type CursorTip, type ManageWork,
} from './builderModel';
import { heldPan, keyPanPixels } from './cameraModel';
import { caption, describeGood, goodLine, holdOf, reasonLine } from './landsUi';
import './lands.css';

/** What opens builder mode in a particular place: the ruler's "Open builder mode here", the map's deposit card. */
export interface BuilderOpen {
  settlement?: number;
  at?: { x: number; z: number };
  kind?: BuildingKind;
}

type Tab = 'build' | 'sites';
type CatFilter = BuildCategory | 'all';

const TECH_NAMES = new Map<string, string>((techsJson.techs as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]));
const techName = (id: string): string => TECH_NAMES.get(id) ?? id.replace(/_/g, ' ');

const ORBIT_K = 0.0022;

export function builderPanel(ctx: PanelCtx, open?: BuilderOpen): UiPanel {
  const cons = ctx.game.construction;
  if (!cons) return unavailable(ctx, 'Nobody raises buildings in this run.');
  const scope0 = cons.scope(ctx.playerId());
  if (scope0.role === 'none') return cannotBuild(ctx, scope0);
  return new BuilderMode(ctx, cons, open).panel();
}

registerPanel('builder', (ctx, req) => builderPanel(ctx, req.data as BuilderOpen | undefined));

// ---------------------------------------------------------------------------------------------
// The two small cards: no module, and no right to build
// ---------------------------------------------------------------------------------------------

function unavailable(ctx: PanelCtx, text: string): UiPanel {
  const win = createWindow({ title: 'Builder', icon: 'hammer', size: 'sm', onClose: () => ctx.close() });
  win.body.append(empty(text));
  win.showFoot(h('div.mu-grow'), button('Close', { variant: 'primary', onClick: () => ctx.close() }));
  return panelOf({ id: 'builder', group: 'builder', pauses: 'never', backdropCloses: ctx }, win.el);
}

/** "You cannot build yet": the module's reason, what would let you, and a way to be someone who can. */
function cannotBuild(ctx: PanelCtx, scope: BuildScope): UiPanel {
  const model = noBuildCard(scope);
  const sim = ctx.sim;
  const me = sim.state.persons.get(ctx.playerId());
  const win = createWindow({ title: 'Builder', subtitle: 'Raising, improving and mending buildings', icon: 'hammer', size: 'md', onClose: () => ctx.close() });
  const near = me ? nearestSettlementId(ctx) : -1;
  const offer = near >= 0 ? ruleOffer(ctx.game, near) : null;
  const hh = me ? sim.state.households.get(me.household) : undefined;
  const head = hh && hh.head && hh.head !== me?.id ? sim.state.persons.get(hh.head) : undefined;
  win.body.append(
    h('div.mu-card.mu-bld-why', null,
      h('div.mu-row.mu-gap-8', null, icon('lock', 20), h('h4', null, model.title)),
      h('p.mu-bold.mu-bad', null, model.why),
      h('p.mu-small.mu-dim', null, 'What lets a person build, by what they are:'),
      h('ul.mu-bld-ways', null, model.ways.map((w) => h('li', null, icon(w.icon, 16), h('span', null, w.text))))),
    h('div.mu-col.mu-gap-6', { style: { marginTop: '12px' } },
      offer ? button(offer.label, { variant: 'primary', size: 'big', icon: 'crown', tip: offer.tip, onClick: () => { ctx.close(); ctx.open(offer.request); } }) : null,
      head && !head.death && sim.canSwitchTo(head.id) ? button(`Live as the head of the household: ${ctx.nameOf(head.id)}`, {
        icon: 'user', tip: 'Take over the head of your household, who may build for it', onClick: () => { ctx.close(); ctx.open({ panel: 'ext', name: 'liveAs', id: head.id, data: { reason: 'choose' } }); },
      }) : null,
      offer && !offer.self ? h('p.mu-tiny.mu-dim', null, `${offer.rulerName} rules ${offer.placeName}; you would carry on as them, and your own life goes on without you.`) : null));
  win.showFoot(h('div.mu-grow'), button('Close', { onClick: () => ctx.close() }));
  return panelOf({ id: 'builder', group: 'builder', pauses: 'never', backdropCloses: ctx }, win.el);
}

function nearestSettlementId(ctx: PanelCtx): number {
  const body = ctx.player.body();
  const me = ctx.sim.state.persons.get(ctx.playerId());
  const at = body ?? (me ? ctx.sim.world.settlements.find((s) => s.id === me.settlement) : undefined);
  if (!at) return -1;
  const s = ctx.sim.world.settlementAt(at.x, at.z) ?? ctx.sim.world.nearestSettlement(at.x, at.z);
  return s ? s.id : -1;
}

// ---------------------------------------------------------------------------------------------
// The mode itself
// ---------------------------------------------------------------------------------------------

type Cons = NonNullable<PanelCtx['game']['construction']>;

class BuilderMode {
  private readonly sim: PanelCtx['sim'];
  private readonly eco: PanelCtx['eco'];
  private readonly win: ReturnType<typeof createWindow>;
  private readonly root = h('div.mu-bld-root');
  private readonly tabsEl: TabsHandle;
  private readonly body = h('div.mu-bld-body');
  private readonly cursor = h('div.mu-bld-cursor.mu-hide');
  private readonly hint = h('div.mu-bld-hint');
  private readonly confirmBar = h('div.mu-bld-confirm.mu-hide');
  private readonly nameCard = h('div.mu-bld-name.mu-hide');
  private readonly toastEl = h('div.mu-bld-toast.mu-hide');
  private readonly inspector = h('div.mu-bld-inspector.mu-hide');

  private scope: BuildScope;
  private tab: Tab = 'build';
  private category: CatFilter = 'all';
  private query = '';
  private showUnavailable = true;
  private where: number;
  private options: BuildOption[] = [];
  private optionsAt = -1e9;
  private selected: BuildOption | null = null;
  private rot = 0;
  private occupant: 'builder' | 'vacant';
  private suggestion: { kind: BuildingKind; check: PlacementCheck; tries: number } | null = null;
  private picked: { type: 'building' | 'site'; id: number } | null = null;
  private naming: { kind: BuildingKind; check: PlacementCheck; name: string } | null = null;
  private lastCheck: { check: PlacementCheck; at: number } | null = null;
  private readonly camera: BuilderCamera;
  private readonly cleanups: Array<() => void> = [];
  private readonly held = new Set<string>();
  private readonly ptr = { x: 0, y: 0, seen: false, overView: false };
  private downAt: { x: number; y: number; button: number } | null = null;
  private orbiting = false;
  private lastPickAt = 0;
  private lastSig = '';
  private lastAreaAt = -1e9;
  private lastNow = 0;
  private toastUntil = 0;
  private disposed = false;
  private readonly feedback = every(0.4, () => this.refreshLive());

  constructor(private readonly ctx: PanelCtx, private readonly cons: Cons, private readonly open?: BuilderOpen) {
    this.sim = ctx.sim;
    this.eco = ctx.eco;
    this.win = createWindow({ title: 'Builder', subtitle: '', icon: 'hammer', size: 'sm', onClose: () => ctx.close() });
    this.scope = cons.scope(ctx.playerId());
    const me = this.sim.state.persons.get(ctx.playerId());
    const home = me?.settlement ?? 0;
    this.occupant = this.scope.role === 'head' ? 'builder' : 'vacant';
    const places = whereOptions(this.scope, home, (id) => ctx.placeName(id));
    const body = ctx.player.body();
    const wanted = open?.settlement !== undefined && places.some((p) => p.id === open.settlement) ? open.settlement : undefined;
    const nearest = body ? nearestOf(places.filter((p) => p.id >= 0).map((p) => { const s = this.sim.world.settlements.find((x) => x.id === p.id); return { id: p.id, x: s?.x ?? 0, z: s?.z ?? 0 }; }), body.x, body.z) : -1;
    this.where = wanted ?? (places.some((p) => p.id === home) ? home : nearest >= 0 ? nearest : places[0]?.id ?? home);

    const centre = this.startCentre(open);
    const plan = overviewPlan(centre.at, centre.landsRadius, this.scope.role);
    this.camera = new BuilderCamera({
      renderer: () => ctx.host.renderer(),
      heightAt: (x, z) => this.sim.world.heightAt(x, z),
      viewport: () => ({ w: window.innerWidth, h: window.innerHeight }),
      clock: () => performance.now() / 1000,
    }, plan);

    this.tabsEl = tabs([
      { id: 'build', label: 'Build', icon: 'hammer' },
      { id: 'sites', label: 'Works', icon: 'ledger' },
    ], this.tab, (id) => this.setTab(id as Tab));
    this.win.el.classList.add('mu-bld-win');
    this.win.body.classList.add('flush');
    this.win.body.append(this.tabsEl.el, h('div.mu-tabbar-rule'), this.body);
    this.win.setTitle('Builder', this.scope.label);
    this.root.append(this.win.el, this.inspector, this.cursor, this.hint, this.confirmBar, this.nameCard, this.toastEl);
    this.hint.append(...hintKeys());
    this.refreshOptions(true);
    this.render();
  }

  /** The circle of land to look over, and the radius of the lands there. */
  private startCentre(open?: BuilderOpen): { at: { x: number; z: number }; landsRadius: number } {
    const world = this.sim.world;
    const body = this.ctx.player.body();
    const terr = this.ctx.game.territory;
    if (open?.at) return { at: open.at, landsRadius: 900 };
    const s = world.settlements.find((x) => x.id === this.where);
    if (this.scope.role === 'head') {
      const me = this.sim.state.persons.get(this.ctx.playerId());
      const hh = me ? this.sim.state.households.get(me.household) : undefined;
      const home = hh && hh.home >= 0 ? this.sim.state.buildings.get(hh.home) : undefined;
      if (home) return { at: { x: home.x, z: home.z }, landsRadius: 450 };
    }
    if (s) return { at: { x: s.x, z: s.z }, landsRadius: terr?.landsRadius(s.id) ?? 1200 };
    return { at: body ? { x: body.x, z: body.z } : { x: 8000, z: 8000 }, landsRadius: 900 };
  }

  panel(): UiPanel {
    return panelOf({ id: 'builder', group: 'builder', captures: true, pauses: 'never', mode: 'clear', backdropCloses: null }, this.root, {
      mount: () => this.mount(),
      tick: (now) => this.tick(now),
      key: (intent) => this.onUiKey(intent),
      onEscape: () => this.onEscape(),
      dispose: () => this.dispose(),
    });
  }

  // -------------------------------------------------------------------------------- lifecycle

  private mount(): void {
    const r = this.ctx.host.renderer();
    this.camera.enter();
    r?.setBuildArea?.(this.cons.buildArea?.(this.ctx.playerId()) ?? []);
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): void => {
      window.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => window.removeEventListener(type, fn as EventListener, opts));
    };
    on('pointerdown', (e) => this.onPointerDown(e), true);
    on('pointermove', (e) => this.onPointerMove(e), true);
    on('pointerup', (e) => this.onPointerUp(e), true);
    on('wheel', (e) => this.onWheel(e), { capture: true, passive: false });
    on('keydown', (e) => this.onKeyDown(e), true);
    on('keyup', (e) => this.onKeyUp(e), true);
    on('blur', () => this.held.clear());
    on('contextmenu', (e) => { if (!inUi(e.target)) e.preventDefault(); }, true);
    this.ctx.listen('playerSwitched', () => this.ctx.close());
    this.ctx.listen('construction', () => { this.lastSig = ''; });
    if (this.open?.kind) {
      const o = this.options.find((x) => x.kind === this.open?.kind);
      if (o) this.select(o);
    }
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.cleanups.splice(0)) c();
    const r = this.ctx.host.renderer();
    r?.setGhost?.(null);
    r?.setBuildArea?.(null);
    this.camera.leave();
  }

  // -------------------------------------------------------------------------------- frame

  private tick(now: number): void {
    const dt = Math.min(0.1, this.lastNow ? now - this.lastNow : 0.016);
    this.lastNow = now;
    const r = this.ctx.host.renderer();
    if (!r) return;
    const pan = heldPan(this.held);
    if (pan.forward || pan.right) {
      const d = keyPanPixels(pan.forward, pan.right, dt);
      this.camera.pan(d.dx, d.dy);
    }
    this.camera.tick();
    this.feedback(now);
    if (now - this.lastAreaAt > 1) {
      this.lastAreaAt = now;
      r.setBuildArea?.(this.cons.buildArea?.(this.ctx.playerId()) ?? []);
    }
    if (this.toastUntil && now > this.toastUntil) { this.toastUntil = 0; this.toastEl.classList.add('mu-hide'); }
    this.updateGhost(r);
    this.publish();
  }

  /** The mode's state on its root element, for the flow tool and the curious (no globals). */
  private publish(): void {
    const d = this.root.dataset;
    const sel = this.selected?.kind ?? '';
    if (d.camera !== this.camera.kind) d.camera = this.camera.kind;
    if (d.tab !== this.tab) d.tab = this.tab;
    if (d.selected !== sel) d.selected = sel;
    const sug = this.suggestion ? 'yes' : 'no';
    if (d.suggestion !== sug) d.suggestion = sug;
    const pk = this.picked ? `${this.picked.type}:${this.picked.id}` : '';
    if (d.picked !== pk) d.picked = pk;
    const w = String(this.where);
    if (d.where !== w) d.where = w;
    const g = this.lastCheck ? (this.lastCheck.check.ok ? 'ok' : 'bad') : '';
    if (d.ghost !== g) d.ghost = g;
  }

  /** Puts the ghost under the cursor (or at the suggested spot) and says by the cursor what it will do. */
  private updateGhost(r: NonNullable<ReturnType<PanelCtx['host']['renderer']>>): void {
    const sel = this.selected;
    if (!sel || !sel.ok || this.naming) {
      // (with no tool the label by the cursor is the hover's, set as the pointer moves)
      r.setGhost?.(null);
      if (sel || this.naming) this.setCursor(null);
      return;
    }
    if (this.suggestion) {
      r.setGhost?.(ghostFrom(sel.kind, sel.level, this.suggestion.check));
      this.setCursor(null);
      return;
    }
    if (!this.ptr.seen || !this.ptr.overView) {
      r.setGhost?.(null);
      this.setCursor(null);
      return;
    }
    const g = r.screenToGround(this.ptr.x, this.ptr.y);
    if (!g) { r.setGhost?.(null); this.setCursor(null); return; }
    const check = this.cons.check(this.ctx.playerId(), sel.kind, g.x, g.z, this.rot);
    this.lastCheck = { check, at: this.lastNow };
    r.setGhost?.(ghostFrom(sel.kind, sel.level, check));
    this.setCursor(cursorTip(sel.name, check, costSummary(sel.cost, (g2, q) => describeGood(this.eco, g2, q), 3)));
  }

  private setCursor(tip: CursorTip | null, kind: 'ghost' | 'hover' = 'ghost'): void {
    if (!tip || !this.ptr.seen) { this.cursor.classList.add('mu-hide'); return; }
    this.cursor.classList.remove('mu-hide');
    this.cursor.className = `mu-bld-cursor ${tip.tone} ${kind}`;
    replace(this.cursor, h('div', { class: 'mu-bld-cursor-main' }, tip.text), tip.sub ? h('div.mu-bld-cursor-sub', null, tip.sub) : null);
    const l = this.ctx.toLocal({ x: this.ptr.x, y: this.ptr.y });
    this.cursor.style.transform = `translate(${Math.round(l.x + 18)}px, ${Math.round(l.y + 20)}px)`;
  }

  // -------------------------------------------------------------------------------- pointer, wheel, keys

  private onView(e: Event): boolean { return !inUi(e.target); }

  private onPointerDown(e: PointerEvent): void {
    this.ptr.x = e.clientX; this.ptr.y = e.clientY; this.ptr.seen = true;
    this.ptr.overView = this.onView(e);
    if (!this.ptr.overView || this.naming) { this.downAt = null; return; }
    this.downAt = { x: e.clientX, y: e.clientY, button: e.button };
    this.orbiting = e.button === 1 || e.button === 2;
    if (this.orbiting) e.preventDefault();
  }

  private onPointerMove(e: PointerEvent): void {
    this.ptr.x = e.clientX; this.ptr.y = e.clientY; this.ptr.seen = true;
    this.ptr.overView = this.onView(e);
    if (this.orbiting && (e.movementX || e.movementY)) {
      this.camera.orbit(-e.movementX * ORBIT_K * (this.ctx.settings().mouseSensitivity || 1) * 1.4, e.movementY * ORBIT_K * (this.ctx.settings().mouseSensitivity || 1) * 1.4);
      return;
    }
    // no tool: say what is under the cursor, now and then
    if (!this.selected && this.ptr.overView && !this.naming && this.lastNow - this.lastPickAt > 0.12) {
      this.lastPickAt = this.lastNow;
      this.hoverTip();
    } else if (!this.ptr.overView && !this.selected) this.setCursor(null);
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.downAt;
    this.downAt = null;
    const wasOrbiting = this.orbiting;
    this.orbiting = false;
    if (!d || !this.onView(e) || this.naming) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6;
    if (moved) return;
    if (d.button === 2 || d.button === 1) {
      // a right click that did not turn the camera puts the tool down
      if (wasOrbiting && d.button === 2) this.cancelTool();
      return;
    }
    if (d.button !== 0) return;
    this.click(e.clientX, e.clientY);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.onView(e) || this.naming) return;
    e.preventDefault();
    const delta = e.deltaY || e.deltaX;
    if (!delta) return;
    if (e.shiftKey && this.selected) {
      this.rot = rotate(this.rot, delta > 0 ? 1 : -1);
      this.suggestion = null;
      this.confirmBar.classList.add('mu-hide');
      return;
    }
    this.camera.zoom(Math.sign(delta) * Math.min(3, Math.abs(delta) / 60 + 0.5));
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.naming) return;
    if (e.code === 'KeyQ' || e.code === 'KeyE') {
      if (this.selected) {
        this.rot = rotate(this.rot, e.code === 'KeyE' ? 1 : -1);
        if (this.suggestion) { this.suggestion = null; this.confirmBar.classList.add('mu-hide'); }
      }
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyR' && this.selected) { e.preventDefault(); return; }
    if (e.code === 'Enter' && this.suggestion) { e.preventDefault(); this.confirmSuggestion(); return; }
    if (!e.repeat || !this.held.has(e.code)) this.held.add(e.code);
  }

  private onKeyUp(e: KeyboardEvent): void { this.held.delete(e.code); }

  private onUiKey(intent: { type: string }): boolean {
    if (this.naming) return false;
    // the arrow keys pan the camera (the key listener holds them), so the UI must not scroll anything with them
    return intent.type === 'arrow' || intent.type === 'page';
  }

  private onEscape(): boolean {
    if (this.naming) { this.closeNaming(); return true; }
    if (this.suggestion) { this.clearSuggestion(); return true; }
    if (this.selected) { this.cancelTool(); return true; }
    if (this.picked) { this.picked = null; this.render(); return true; }
    return false;
  }

  // -------------------------------------------------------------------------------- clicking in the world

  private click(x: number, y: number): void {
    const r = this.ctx.host.renderer();
    if (!r) return;
    const sel = this.selected;
    if (sel && sel.ok) {
      if (this.suggestion) this.clearSuggestion();
      const g = r.screenToGround(x, y);
      if (!g) return;
      const check = this.cons.check(this.ctx.playerId(), sel.kind, g.x, g.z, this.rot);
      this.stake(sel, check);
      return;
    }
    const hit = r.pick?.(x, y);
    if (hit && hit.type === 'building' && hit.id !== undefined) {
      this.pickBuilding(hit.id);
      return;
    }
    if (this.picked) { this.picked = null; this.render(); }
  }

  private stake(sel: BuildOption, check: PlacementCheck): void {
    if (!check.ok) {
      this.ctx.say('warn', check.reason || 'You cannot build there.');
      return;
    }
    if (check.outpost && check.outpost.id === 0) {
      const dep = this.ctx.game.territory?.depositAt(check.x, check.z) ?? null;
      this.openNaming(sel.kind, check, defaultOutpostName(dep?.kind, sel.kind, check.outpost.name));
      return;
    }
    this.place(sel, check, undefined);
  }

  private place(sel: BuildOption, check: PlacementCheck, outpost: string | undefined): void {
    const opts: PlaceOptions = {};
    if (sel.category === 'home') opts.occupant = this.occupant;
    if (outpost) opts.outpost = outpost;
    const res = this.cons.place(this.ctx.playerId(), sel.kind, check.x, check.z, check.rot, opts);
    if (!res.ok) { this.ctx.say('warn', res.reason ?? 'It cannot be done.'); this.flash(res.reason ?? 'It cannot be done.', 'bad'); return; }
    this.ctx.say('gain', outpost ? `${outpost} is founded; the ${sel.name.toLowerCase()} is staked out.` : `The ${sel.name.toLowerCase()} is staked out.`);
    this.flash(`Staked out: ${sel.name}`, 'ok');
    this.lastSig = '';
    this.refreshOptions(true);
    this.clearSuggestion();
    this.renderTabsBadge();
    if (this.tab === 'sites') this.renderSites();
    this.renderList();
    this.renderInspector();
  }

  private pickBuilding(id: number): void {
    const site = this.cons.siteOf(id);
    this.cancelTool(false);
    this.picked = site ? { type: 'site', id: site.id } : { type: 'building', id };
    this.render();
  }

  private hoverTip(): void {
    const r = this.ctx.host.renderer();
    const hit = r?.pick?.(this.ptr.x, this.ptr.y);
    if (!hit || hit.type !== 'building' || hit.id === undefined) { this.setCursor(null); return; }
    const b = this.sim.state.buildings.get(hit.id);
    if (!b) { this.setCursor(null); return; }
    const site = this.cons.siteOf(hit.id);
    const me = this.sim.state.persons.get(this.ctx.playerId());
    const name = BUILDINGS[b.kind]?.name ?? b.kind;
    const own = me ? ownerWords(b, { house: me.house, household: me.household }, (id) => this.sim.state.houses.get(id)?.name ?? '?') : '';
    this.setCursor({ tone: 'info', text: site ? `${name} (a work under way)` : name, sub: `${own}${site ? '' : ' · click for details'}` }, 'hover');
  }

  // -------------------------------------------------------------------------------- the tool

  private select(o: BuildOption): void {
    this.selected = o;
    this.picked = null;
    this.clearSuggestion();
    this.renderList();
    this.renderInspector();
  }

  /** Puts the tool down (the ghost goes); `redraw` false when the caller redraws anyway. */
  private cancelTool(redraw = true): void {
    this.selected = null;
    this.clearSuggestion();
    this.ctx.host.renderer()?.setGhost?.(null);
    this.setCursor(null);
    if (redraw) { this.renderList(); this.renderInspector(); }
  }

  private clearSuggestion(): void {
    this.suggestion = null;
    this.confirmBar.classList.add('mu-hide');
  }

  /** "Place for me": the module's suggestion near where the camera looks; the camera goes there and asks to confirm. */
  private placeForMe(another = false): void {
    const sel = this.selected;
    if (!sel || !sel.ok) return;
    const centre = this.camera.centre();
    let near = centre ?? undefined;
    const prev = this.suggestion;
    if (another && prev) {
      // a different spot: look from a point 45 m off the last one, turning a little each time
      const a = (prev.tries + 1) * 2.4;
      near = { x: prev.check.x + Math.cos(a) * 45, z: prev.check.z + Math.sin(a) * 45 };
    }
    const settlement = this.where;
    const chk = this.cons.suggestSpot(this.ctx.playerId(), sel.kind, settlement, near);
    if (!chk || !chk.ok) { this.ctx.say('warn', `No fitting place for the ${sel.name.toLowerCase()} was found${settlement >= 0 ? ` in ${this.ctx.placeName(settlement)}` : ' here'}.`); this.flash('No fitting place was found', 'bad'); return; }
    this.suggestion = { kind: sel.kind, check: chk, tries: (prev?.tries ?? 0) + 1 };
    this.rot = chk.rot;
    this.camera.panTo(chk.x, chk.z);
    this.showConfirm(sel, chk);
  }

  private showConfirm(sel: BuildOption, chk: PlacementCheck): void {
    this.confirmBar.classList.remove('mu-hide');
    replace(this.confirmBar,
      h('div.mu-bld-confirm-text', null, icon('pin', 16), h('span', null, `A fitting place for the ${sel.name.toLowerCase()}`),
        chk.outpost && chk.outpost.id === 0 ? h('span.mu-dim', null, ' — it would found an outpost') : null),
      h('div.mu-row.mu-gap-6', null,
        button('Stake it out', { variant: 'primary', icon: 'check', onClick: () => this.confirmSuggestion() }),
        button('Another spot', { icon: 'refresh', onClick: () => this.placeForMe(true) }),
        button('Cancel', { onClick: () => this.clearSuggestion() })));
  }

  private confirmSuggestion(): void {
    const s = this.suggestion;
    const sel = this.selected;
    if (!s || !sel) return;
    // the spot may have been taken since it was suggested: ask again
    const check = this.cons.check(this.ctx.playerId(), sel.kind, s.check.x, s.check.z, s.check.rot);
    this.stake(sel, check);
  }

  // -------------------------------------------------------------------------------- naming an outpost

  private openNaming(kind: BuildingKind, check: PlacementCheck, name: string): void {
    this.naming = { kind, check, name };
    this.nameCard.classList.remove('mu-hide');
    const input = h<HTMLInputElement>('input.mu-input', { type: 'text', value: name, maxlength: '32', 'aria-label': 'Name of the outpost' });
    const go = (): void => {
      const n = this.naming;
      const sel = this.selected;
      if (!n || !sel) return;
      const chosen = cleanOutpostName(input.value) || n.name;
      this.closeNaming();
      this.place(sel, n.check, chosen);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } else if (e.key === 'Escape') { e.stopPropagation(); this.closeNaming(); } });
    replace(this.nameCard,
      h('div.mu-row.mu-gap-8', null, icon('flag', 20), h('h4', null, 'Found an outpost')),
      h('p.mu-small.mu-dim', null, `A new settlement of ${this.ctx.placeName(check.outpost?.parent ?? this.where)} in the wild, named on the map. Its land reaches 600 m round.`),
      h('label.mu-col.mu-gap-4', null, h('span.mu-small', null, 'Name'), input),
      h('div.mu-row.mu-gap-6', { style: { marginTop: '8px' } },
        button('Found it', { variant: 'primary', icon: 'check', onClick: go }),
        button('Cancel', { onClick: () => this.closeNaming() })));
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  private closeNaming(): void {
    this.naming = null;
    this.nameCard.classList.add('mu-hide');
    clear(this.nameCard);
  }

  private flash(text: string, tone: 'ok' | 'bad'): void {
    this.toastEl.className = `mu-bld-toast ${tone}`;
    this.toastEl.textContent = text;
    this.toastUntil = this.lastNow + 2.4;
  }

  // -------------------------------------------------------------------------------- data

  private refreshOptions(force = false): void {
    if (!force && this.lastNow - this.optionsAt < 2) return;
    this.optionsAt = this.lastNow;
    this.scope = this.cons.scope(this.ctx.playerId());
    this.options = this.cons.catalogue(this.ctx.playerId(), this.where);
    if (this.selected) this.selected = this.options.find((o) => o.kind === this.selected?.kind) ?? null;
  }

  private payerStores(): ReturnType<PanelCtx['eco']['stores']> {
    try { return this.eco.stores(this.scope.household); } catch { return []; }
  }

  /** Re-draws the lists that change with the world (the works, the card, the catalogue's counts). */
  private refreshLive(): void {
    const v = this.cons.version();
    const hour = Math.floor(this.sim.absDay * 24);
    const sig = `${v}|${hour}|${this.tab}|${this.picked?.type}${this.picked?.id}`;
    if (sig === this.lastSig) return;
    this.lastSig = sig;
    this.refreshOptions(this.tab === 'build');
    this.renderTabsBadge();
    if (this.tab === 'sites') this.renderSites();
    if (this.picked) this.renderInspector();
  }

  // -------------------------------------------------------------------------------- rendering

  private setTab(t: Tab): void {
    this.tab = t;
    this.tabsEl.set(t);
    this.lastSig = '';
    this.render();
  }

  private render(): void {
    this.renderTabsBadge();
    if (this.tab === 'build') this.renderBuild(); else this.renderSites();
    this.renderInspector();
  }

  /** Is this work the player's to order? (The module's `canManage`; a stand-in without it goes by who ordered and who pays.) */
  private isMine = (s: SiteView): boolean => (this.cons.canManage ? this.cons.canManage(this.ctx.playerId(), s.id) : s.builder === this.ctx.playerId() || s.household === this.scope.household);

  /** The player's works, and the works of others in the places they have a say in (not every lord's on the continent). */
  private visibleSites(): SiteView[] {
    const relevant = new Set<number>([...this.scope.settlements, this.where]);
    const out: SiteView[] = [];
    let others = 0;
    for (const s of this.cons.sites()) {
      if (this.isMine(s)) out.push(s);
      else if (relevant.has(s.settlement) && others++ < 40) out.push(s);
    }
    return out;
  }

  private queue(onlyMine = false): ReturnType<typeof queueRows> {
    const mineIds = new Map<number, boolean>();
    const sites = this.visibleSites();
    for (const s of sites) mineIds.set(s.id, this.isMine(s));
    return queueRows(sites, (id) => mineIds.get(id) ?? false, this.sim.absDay, (id) => this.ctx.placeName(id), onlyMine);
  }

  private renderTabsBadge(): void {
    this.tabsEl.badge('sites', this.queue(true).length);
    this.win.setTitle('Builder', this.scope.label);
  }

  // ---- build tab: where, filters, the catalogue
  private renderBuild(): void {
    const places = whereOptions(this.scope, this.sim.state.persons.get(this.ctx.playerId())?.settlement ?? 0, (id) => this.ctx.placeName(id));
    const counts = categoryCounts(this.options);
    const whereSel = h<HTMLSelectElement>('select.mu-input.mu-grow', { 'aria-label': 'Where to build' },
      places.map((p) => h('option', { value: String(p.id), selected: p.id === this.where }, `${p.label}${p.hint ? ` (${p.hint})` : ''}`)));
    whereSel.addEventListener('change', () => this.setWhere(Number(whereSel.value)));
    const search = h<HTMLInputElement>('input.mu-input.mu-grow', { type: 'search', placeholder: 'Search the catalogue…', 'aria-label': 'Search buildings', value: this.query });
    search.addEventListener('input', () => { this.query = search.value; this.renderList(); });
    const cats = h('div.mu-bld-cats');
    const mkCat = (id: CatFilter, label: string, n: number, ico?: Parameters<typeof icon>[0]): HTMLElement => {
      const b = h<HTMLButtonElement>('button.mu-chip.mu-click', { type: 'button', class: id === this.category ? 'lapis' : '', tip: `${label}: ${n} you can raise here` }, ico ? icon(ico, 13) : null, label, n ? h('b', null, String(n)) : null);
      b.addEventListener('click', () => { this.category = id; this.renderBuild(); });
      return b;
    };
    cats.append(mkCat('all', 'All', counts.all));
    for (const c of CATEGORY_ORDER) if (this.options.some((o) => o.category === c)) cats.append(mkCat(c, CATEGORY_LABEL[c], counts[c], CATEGORY_ICON[c]));
    const unavail = iconButton(this.showUnavailable ? 'eye_off' : 'per', this.showUnavailable ? 'Hide what you cannot raise here' : 'Show what you cannot raise here, with the reason why not', () => { this.showUnavailable = !this.showUnavailable; this.renderBuild(); }, { small: true });
    const top = h('div.mu-bld-top', null,
      places.length > 1 ? h('div.mu-row.mu-gap-6', null, icon('pin', 16), whereSel) : null,
      h('div.mu-row.mu-gap-6', null, search, unavail),
      cats);
    const list = h('div.mu-bld-scroll.mu-scroll.mu-bld-list');
    const foot = h('div.mu-bld-foot', null, icon('hammer', 15), h('span', null, 'Pick a building, then click the land. Click a building or a site in the world to look at it.'));
    replace(this.body, top, list, foot);
    this.listEl = list;
    this.renderList();
  }

  private listEl: HTMLElement | null = null;

  private setWhere(id: number): void {
    this.where = id;
    this.selected = null;
    this.clearSuggestion();
    this.refreshOptions(true);
    const s = this.sim.world.settlements.find((x) => x.id === id);
    if (s) {
      const radius = this.ctx.game.territory?.landsRadius(id) ?? 1200;
      this.camera.recentre(overviewPlan({ x: s.x, z: s.z }, radius, this.scope.role));
    }
    this.render();
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    const shown = filterCatalogue(this.options, { category: this.category, query: this.query, showUnavailable: this.showUnavailable });
    if (!shown.length) {
      replace(list, empty(this.options.length ? 'Nothing in the catalogue matches.' : this.where < 0 ? 'Only a baron or greater may found an outpost here.' : 'There is nothing you may build here.'));
      return;
    }
    const d = (g: string, q: number): string => describeGood(this.eco, g, q);
    replace(list, shown.map((o) => {
      const row = h('div.mu-bld-row', { class: `${o.ok ? 'click' : 'dis'}${this.selected?.kind === o.kind ? ' sel' : ''}`, 'data-kind': o.kind },
        h('span.mu-bld-ico', null, icon(CATEGORY_ICON[o.category], 20)),
        h('div.mu-grow.mu-bld-main', null,
          h('b', null, o.name),
          h('div.mu-tiny.mu-dim.mu-trunc', null, costSummary(o.cost, d, 3)),
          !o.ok && o.reason ? h('div.mu-tiny.mu-bad.mu-bld-why-not', null, o.reason) : null),
        o.ok && o.requires.tech ? h('span', { tip: `Needs the technique ${techName(o.requires.tech)}, which your House has` }, icon('book', 14, 'mu-dim')) : null);
      row.addEventListener('click', () => { if (this.selected?.kind === o.kind) this.cancelTool(); else this.select(o); });
      row.addEventListener('dblclick', () => { if (o.ok) { this.select(o); this.placeForMe(); } });
      return row;
    }));
  }

  // ---- works tab: the queue
  private renderSites(): void {
    const rows = this.queue();
    const mine = rows.filter((r) => r.mine);
    const scroll = h('div.mu-bld-scroll.mu-scroll.mu-bld-queue');
    const keep = this.body.querySelector('.mu-bld-queue')?.scrollTop ?? 0;
    if (!rows.length) scroll.append(empty('No work is under way. Pick a building on the Build tab and stake it out.', { icon: 'hammer', title: 'The land lies quiet' }));
    else {
      scroll.append(h('p.mu-small.mu-dim', { style: { margin: '2px 4px 8px' } }, `${mine.length} of your own works${rows.length > mine.length ? `, ${rows.length - mine.length} of others` : ''}. The first in the list is worked first.`));
      scroll.append(...rows.map((r) => {
        const b = bar(r.status === 'stalled' ? 'vermilion' : r.status === 'waiting' ? 'gold' : 'green', r.progress, { thin: true });
        const row = h('div.mu-bld-qrow', { class: `${r.mine ? '' : 'dis'}${this.picked?.type === 'site' && this.picked.id === r.id ? ' sel' : ''}`, 'data-site': String(r.id) },
          h('span.mu-bld-qn', null, r.mine ? String(mine.indexOf(r) + 1) : '·'),
          h('div.mu-grow', null,
            h('div.mu-row.mu-between.mu-gap-6', null, h('b.mu-trunc', null, r.title), chip(r.statusWord, STATUS_TONE[r.status])),
            h('div.mu-tiny.mu-dim.mu-trunc', null, `${r.place} · ${r.line}`),
            b.el),
          button('', { icon: 'pin', size: 'small', tip: 'Go to this work', onClick: (e) => { e.stopPropagation(); this.camera.panTo(r.x, r.z); } }));
        row.addEventListener('click', () => { this.cancelTool(false); this.picked = { type: 'site', id: r.id }; this.camera.panTo(r.x, r.z); this.render(); });
        return row;
      }));
    }
    replace(this.body, scroll);
    scroll.scrollTop = keep;
  }

  // ---- the inspector: the kind chosen in the catalogue, or the building or site that was clicked
  private renderInspector(): void {
    const el = this.inspector;
    let content: HTMLElement | null = null;
    if (this.picked) content = this.pickedCard(this.picked);
    if (!this.picked && this.selected) content = this.kindCard(this.selected);
    if (!content) { el.classList.add('mu-hide'); clear(el); return; }
    const keep = el.scrollTop;
    el.classList.remove('mu-hide');
    replace(el, iconButton('cross', 'Put it down (Esc)', () => this.onEscape(), { small: true }), content);
    el.scrollTop = keep;
  }

  private pickedCard(p: { type: 'building' | 'site'; id: number }): HTMLElement | null {
    if (p.type === 'site') {
      const site = this.cons.site(p.id);
      if (!site || site.status === 'cancelled') { this.picked = null; return null; }
      // finished: show the building it made
      if (site.status === 'done') { this.picked = { type: 'building', id: site.building }; return this.buildingCard(site.building); }
      return this.siteCardEl(site);
    }
    return this.buildingCard(p.id);
  }

  private kindCard(o: BuildOption): HTMLElement {
    const stores = this.payerStores();
    const lack = shortfall(o.cost, (g) => holdOf(stores, g));
    const goods = costLines(o.cost, (g, q) => describeGood(this.eco, g, q));
    const req = requirementLines(o.requires, techName, (t) => this.sim.services.advancement?.houseHas(this.scope.house, t) ?? false);
    const home = o.category === 'home';
    const wrap = h('div.mu-bld-card');
    append(wrap,
      h('div.mu-row.mu-between.mu-top', { style: { paddingRight: '26px' } }, h('h4', null, o.name), h('span.mu-chip', null, icon(CATEGORY_ICON[o.category], 13), CATEGORY_LABEL[o.category])),
      h('div.mu-small.mu-ink2', null, o.does),
      reasonLine(o.ok ? null : o.reason),
      h('div.mu-bld-cost', null,
        caption('Costs'),
        h('div.mu-row.mu-wrap.mu-gap-6', null,
          goods.map((l) => l.kind === 'good' && l.good ? goodLine(this.eco, l.good, l.qty, holdOf(stores, l.good)) : h('span.mu-good-line', null, icon(l.kind === 'labour' ? 'hammer' : 'coin', 15), h('span', null, l.text)))),
        Object.keys(lack).length ? h('div.mu-tiny.mu-dim', { style: { marginTop: '4px' } }, `Short in your stores: ${Object.entries(lack).map(([g, q]) => describeGood(this.eco, g, q)).join(', ')} — bought at the nearest market and carted in.`) : h('div.mu-tiny.mu-good', { style: { marginTop: '4px' } }, 'Your stores hold all the materials.')),
      req.length ? h('div.mu-bld-req', null, req.map((r) => h('span.mu-bld-reqline', { class: r.tone ?? '' }, icon(r.icon, 14), r.text))) : null,
      home && o.ok ? h('div.mu-col.mu-gap-4', { style: { marginTop: '8px', alignItems: 'flex-start' } }, h('span.mu-small', null, 'When it is built:'),
        seg([{ id: 'builder' as const, label: 'Our household moves in' }, { id: 'vacant' as const, label: 'Let to a family' }], this.occupant, (v) => { this.occupant = v; })) : null,
      o.ok ? h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '10px' } },
        button('Place for me', { variant: 'primary', icon: 'pin', tip: 'The builders find a fitting spot near where you are looking; you confirm it', onClick: () => this.placeForMe() }),
        h('span.mu-tiny.mu-dim', null, `or click the land; Q and E turn it (${Math.round((ROTATE_STEP * 180) / Math.PI)}°)`)) : null);
    return wrap;
  }

  private siteCardEl(site: SiteView): HTMLElement {
    const me = this.ctx.playerId();
    const m = siteCard(site, this.deliveriesOf(site), this.sim.absDay, (g, q) => describeGood(this.eco, g, q), (id) => this.ctx.placeName(id));
    const can = this.isMine(site);
    const wrap = h('div.mu-bld-card');
    const pb = bar(site.status === 'stalled' ? 'vermilion' : 'green', m.progress);
    const mb = bar('lapis', m.materialShare, { thin: true });
    append(wrap,
      h('div.mu-row.mu-between.mu-top', { style: { paddingRight: '26px' } }, h('h4', null, m.title), chip(m.statusWord, STATUS_TONE[site.status])),
      h('div.mu-row.mu-between.mu-small', null, h('span', null, m.stage), h('span.mu-num', null, `${Math.round(m.progress * 100)}%`)),
      pb.el,
      m.note ? h('p.mu-small.mu-ink2.mu-ital', { style: { margin: '6px 0 2px' } }, m.note) : null,
      h('div.mu-bld-facts', null,
        h('div', null, icon('hammer', 14), h('span', null, m.labour)),
        h('div', null, icon('users', 14), h('span', null, m.workers)),
        h('div', null, icon('calendar', 14), h('span', null, m.eta))),
      caption('Materials', h('span.mu-dim', null, ` ${Math.round(m.materialShare * 100)}% in`)),
      mb.el,
      m.materials.length
        ? h('ul.mu-bld-mats', null, m.materials.map((l) => h('li', null, icon('box', 14), h('span', null, l.text))))
        : h('p.mu-small.mu-good', null, 'All the materials are in the pile.'),
      h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '10px' } },
        button('Go there', { icon: 'pin', size: 'small', onClick: () => this.camera.panTo(site.x, site.z) }),
        button('Open the building', { icon: 'info', size: 'small', tip: 'The ordinary page of the building', onClick: () => this.ctx.open({ panel: 'building', id: site.building }) })));
    if (can) {
      const hired = site.hired ?? 0;
      const rows = this.queue(true);
      append(wrap,
        caption('Orders'),
        h('div.mu-row.mu-gap-8.mu-wrap', null,
          h('span.mu-small', null, 'Hired hands'),
          h('div.mu-row.mu-gap-4', null,
            button('', { icon: 'minus', size: 'small', disabled: hired <= 0, onClick: () => this.order(this.cons.setHired?.(me, site.id, Math.max(0, hired - 1))) }),
            h('b.mu-num', { style: { minWidth: '22px', textAlign: 'center' } }, String(hired)),
            button('', { icon: 'plus', size: 'small', onClick: () => this.order(this.cons.setHired?.(me, site.id, hired + 1)) }),
            button('Auto', { size: 'small', tip: 'As many as the work, the purse and the crew rule allow', onClick: () => this.order(this.cons.setHired?.(me, site.id, 'auto')) }))),
        h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '6px' } },
          button('Work this first', { size: 'small', icon: 'arrow_up', onClick: () => this.order(this.cons.setPriority(me, site.id, priorityFor(rows, 'first'))) }),
          button('Work it last', { size: 'small', icon: 'arrow_down', onClick: () => this.order(this.cons.setPriority(me, site.id, priorityFor(rows, 'last'))) }),
          button('Cancel the work', { size: 'small', variant: 'danger', icon: 'cross', onClick: () => this.ctx.confirm({
            title: 'Cancel this work?', text: site.progress > 0.02 ? 'Most of the materials delivered come back to your stores (70 %); the labour already put in is lost.' : 'Nothing has been built yet: all the materials delivered come back.',
            confirmLabel: 'Cancel the work', cancelLabel: 'Keep it', danger: true, onConfirm: () => { this.order(this.cons.cancel(me, site.id), 'The work is cancelled.'); this.picked = null; this.render(); },
          }) })));
    } else append(wrap, h('p.mu-tiny.mu-dim', { style: { marginTop: '8px' } }, 'It is not your work to order.'));
    return wrap;
  }

  private order(r: { ok: boolean; reason?: string } | undefined, okText?: string): void {
    if (!r) { this.ctx.say('warn', 'That cannot be ordered here.'); return; }
    if (!r.ok) { this.ctx.say('warn', r.reason ?? 'It cannot be done.'); this.flash(r.reason ?? 'It cannot be done.', 'bad'); } else if (okText) this.ctx.say('info', okText);
    this.lastSig = '';
    this.render();
  }

  private deliveriesOf(site: SiteView): Array<{ good: string; qty: number; arrive: number; from: number }> {
    try { return [...(this.eco.deliveries?.(site.household) ?? [])]; } catch { return []; }
  }

  private buildingCard(id: number): HTMLElement {
    const b = this.sim.state.buildings.get(id);
    const wrap = h('div.mu-bld-card');
    if (!b) { append(wrap, empty('That building is gone.')); this.picked = null; return wrap; }
    const me = this.sim.state.persons.get(this.ctx.playerId());
    const def = BUILDINGS[b.kind];
    const cond = conditionWords(b.damage);
    const cb = bar(cond.tone === 'vermilion' ? 'vermilion' : cond.tone === 'gold' ? 'gold' : 'green', cond.share, { thin: true });
    const pid = this.ctx.playerId();
    const none = { ok: false, reason: 'No one is building here' };
    const quotes = {
      upgrade: this.cons.quote?.(pid, 'upgrade', id) ?? none,
      repair: this.cons.quote?.(pid, 'repair', id) ?? none,
      demolish: this.cons.quote?.(pid, 'demolish', id) ?? none,
    };
    const manage = manageOptions(quotes, (g, q) => describeGood(this.eco, g, q));
    const owner = me ? ownerWords(b, { house: me.house, household: me.household }, (hid) => this.sim.state.houses.get(hid)?.name ?? '?') : '';
    const rules = this.cons.catalogue(pid, b.settlement).find((o) => o.kind === b.kind);
    append(wrap,
      h('div.mu-row.mu-between.mu-top', { style: { paddingRight: '26px' } }, h('h4', null, def?.name ?? b.kind), chip(`Level ${b.level}${def?.maxLevel ? ` of ${def.maxLevel}` : ''}`, 'lapis')),
      rules ? h('p.mu-small.mu-ink2', null, rules.does) : null,
      h('dl.mu-kv', null,
        h('dt', null, 'Belongs to'), h('dd', null, owner),
        h('dt', null, 'In'), h('dd', null, this.ctx.placeName(b.settlement)),
        h('dt', null, 'Condition'), h('dd', null, cond.word)),
      cb.el,
      caption('What can be done'),
      h('div.mu-bld-manage', null, manage.map((m) => h('div.mu-bld-mrow', { class: m.ok ? '' : 'dis' },
        button(m.label, {
          size: 'small', variant: m.work === 'demolish' ? 'danger' : m.work === 'upgrade' ? 'primary' : '', disabled: !m.ok, tip: m.ok ? m.detail : m.reason,
          icon: m.work === 'upgrade' ? 'arrow_up' : m.work === 'repair' ? 'hammer' : 'cross',
          onClick: () => this.doManage(m.work, id, def?.name ?? b.kind),
        }),
        h('div.mu-tiny', { class: m.ok ? 'mu-dim' : 'mu-bad' }, m.detail)))),
      h('div.mu-row.mu-gap-6', { style: { marginTop: '10px' } },
        button('Look at it', { size: 'small', icon: 'pin', onClick: () => this.camera.panTo(b.x, b.z) }),
        button('Open the building', { size: 'small', icon: 'info', onClick: () => this.ctx.open({ panel: 'building', id }) })));
    return wrap;
  }

  private doManage(work: ManageWork, building: number, name: string): void {
    const pid = this.ctx.playerId();
    const go = (): void => {
      const r = work === 'upgrade' ? this.cons.upgrade(pid, building) : work === 'repair' ? this.cons.repair(pid, building) : this.cons.demolish(pid, building);
      if (!r.ok) { this.ctx.say('warn', r.reason ?? 'It cannot be done.'); this.flash(r.reason ?? 'It cannot be done.', 'bad'); return; }
      this.flash(work === 'upgrade' ? `Improving the ${name.toLowerCase()}` : work === 'repair' ? `Mending the ${name.toLowerCase()}` : `Pulling down the ${name.toLowerCase()}`, 'ok');
      this.lastSig = '';
      this.picked = r.site ? { type: 'site', id: r.site } : null;
      this.render();
    };
    if (work === 'demolish') {
      this.ctx.confirm({ title: `Pull down the ${name.toLowerCase()}?`, text: 'The building is taken apart for its timber, planks and stone: a share of them comes back to your stores. It cannot be undone.', confirmLabel: 'Pull it down', cancelLabel: 'Keep it', danger: true, onConfirm: go });
    } else go();
  }
}

// ---------------------------------------------------------------------------------------------

function inUi(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.('.mu-root');
}

function hintKeys(): HTMLElement[] {
  const k = (label: string): HTMLElement => h('span.mu-key', null, label);
  const item = (keys: HTMLElement[], text: string): HTMLElement => h('span.mu-bld-hintitem', null, ...keys, h('span', null, text));
  return [
    item([k('W'), k('A'), k('S'), k('D')], 'move'),
    item([k('Wheel')], 'zoom'),
    item([k('Right drag')], 'turn'),
    item([k('Q'), k('E')], 'rotate'),
    item([k('Esc')], 'put down / leave'),
    item([k('B')], 'leave'),
  ];
}

