// The UI controller: screens (menu / loading / game), the panel stack, hotkeys, the HUD and the wiring
// from simulation events to the feed, toasts and the death / game-over screens.
import type { Difficulty } from '../../core/domain';
import type { UiRequest } from '../../sim/actions';
import { familyOf } from '../../sim/kin';
import { levelProfile, type StatUpgrades } from '../../sim/legacy';
import type { SimEvents } from '../../sim/events';
import { fullName, type ChronicleEntry, type PersonId } from '../../sim/state';
import { settlementName } from '../../sim/api';
import type { Command, CommandResult } from '../../sim/sim';
import { h, isTypingTarget } from '../core/dom';
import {
  Feed, feedForChronicle, feedForNotify, feedForOpinion, feedForSkip, feedForTrade, feedForTravel, gainChip, toastForPoints,
  toastForRank, toastForSkillLevel, type FeedKind, type ToastInput,
} from '../core/feed';
import { GOOD_ICON } from '../core/iconMap';
import { keyIntent, type KeyIntent, type PanelKey } from '../core/keys';
import { goldDefs } from '../core/ornament';
import { PauseController } from '../core/pause';
import { effectiveScale } from '../core/scale';
import type { PanelRequest } from '../core/requests';
import { PanelStack } from '../core/stack';
import { Hud } from '../hud/hud';
import { Toasts } from '../hud/toasts';
import { createPanel } from '../panels/registry';
import { LoadingLayer } from '../screens/loading';
import { MenuLayer, type MenuView } from '../screens/menu';
import type { GameServices, GameUIExt, UiHost, UiScreen } from '../types';
import type { ConfirmOptions, PanelCtx, PanelRecord, UiHooks, UiPanel } from './panel';
import { Tooltips } from './tooltips';

interface Bound { game: GameServices; offs: Array<() => void>; pause: PauseController }

const ESCAPE_DEBOUNCE_MS = 80;

/** A UI bug must never break the simulation: handlers that run inside `sim.events.emit` swallow and log their errors. */
function safe<T>(label: string, fn: (e: T) => void): (e: T) => void {
  return (e) => {
    try { fn(e); } catch (err) { console.error(`UI handler failed (${label})`, err); }
  };
}

export class UiApp implements GameUIExt {
  private readonly root = h('div.mu-root');
  private readonly panelLayer = h('div.mu-layer.mu-panels');
  private readonly hudLayer = h('div.mu-layer');
  private readonly tipLayer = h('div.mu-layer');
  private readonly feed = new Feed(6);
  private readonly toasts: Toasts;
  private readonly hud: Hud;
  private readonly menu: MenuLayer;
  private readonly loading = new LoadingLayer();
  private readonly tooltips: Tooltips;
  private readonly stack: PanelStack<UiPanel>;
  private readonly records = new Map<UiPanel, PanelRecord>();
  private readonly offs: Array<() => void> = [];

  private readonly hooks: UiHooks = {
    quitToMenu: () => { void this.leaveToMenu(); },
    newRun: () => { void this.leaveToMenu('difficulty'); },
    showBirth: () => this.openPanel({ panel: 'birth' }),
    pendingGameOver: () => this.pendingGameOver,
  };
  private pendingGameOver: SimEvents['gameOver'] | null = null;
  private screen: UiScreen = 'menu';
  private bound: Bound | null = null;
  private clock = 0;
  private scale = 1;
  private pendingBirth = false;
  private afterMenu: MenuView | null = null;
  private lastEscapeAt = -1000;
  private lastChronicle: ChronicleEntry | null = null;
  private chronicleTimer = 0;
  private lastEncounterKey = '';
  private lastMenuPause: boolean | null = null;

  constructor(private readonly parent: HTMLElement, private readonly host: UiHost) {
    this.toasts = new Toasts((req) => this.openPanel(req));
    this.hud = new Hud({
      game: () => this.bound?.game ?? null,
      host,
      feed: this.feed,
      toasts: this.toasts,
      open: (req) => this.toggleOrOpen(req),
      isOpen: (id) => this.stack.has(id),
      say: (kind, text) => this.say(kind, text),
      placeName: (id) => this.placeName(id),
      onEncounter: () => this.onEncounter(),
    });
    this.menu = new MenuLayer({
      host,
      startRun: (opts) => this.startRun(opts),
      continueRun: () => { void this.continueRun(); },
      onSettingsChanged: () => this.onSettingsChanged(),
    });
    this.stack = new PanelStack<UiPanel>({
      onShow: (p) => this.onPanelShown(p),
      onHide: (p) => this.onPanelHidden(p),
      onChange: () => { this.syncPause(); this.syncHudDim(); },
    });
    this.hudLayer.appendChild(this.hud.el);
    this.hud.setVisible(false);
    // #ui > * is pointer-events:auto in base.css; the root must let clicks through to the 3D canvas (map picking, mouse look)
    this.root.style.pointerEvents = 'none';
    this.root.append(goldDefs(), this.menu.el, this.loading.el, this.hudLayer, this.panelLayer, this.tipLayer);
    parent.appendChild(this.root);
    this.tooltips = new Tooltips(this.root, this.tipLayer);

    const onKey = (e: KeyboardEvent): void => this.onKeyDown(e);
    window.addEventListener('keydown', onKey, true);
    this.offs.push(() => window.removeEventListener('keydown', onKey, true));
    const onResize = (): void => this.applySettings();
    window.addEventListener('resize', onResize);
    this.offs.push(() => window.removeEventListener('resize', onResize));
    this.applySettings();
    this.menu.open('main');
    this.root.classList.toggle('mu-still', new URLSearchParams(location.search).has('still'));
  }

  // ---------------------------------------------------------------------------------- GameUI

  update(dt: number): void {
    this.clock += Math.min(dt, 0.25);
    if (this.effectiveScale() !== this.scale) this.applySettings();
    if (this.screen === 'loading') this.loading.tick(dt);
    if (this.screen !== 'game') return;
    if (!this.bound) {
      const g = this.host.game();
      if (!g) return;
      this.bind(g);
      this.afterEnterGame();
    } else {
      const g = this.host.game();
      if (g && g.sim !== this.bound.game.sim) this.bind(g);
      else if (!g) return;
    }
    const sim = this.bound!.game.sim;
    if (sim.state.run.phase === 'alive') this.guardedHud();
    for (const p of [...this.stack.all()]) {
      try { p.tick?.(this.clock); } catch (err) {
        console.error(`panel "${p.id}" failed while updating; closing it`, err);
        this.stack.close(p.id);
      }
    }
    this.chronicleTimer += dt;
    if (this.chronicleTimer > 0.6) {
      this.chronicleTimer = 0;
      try { this.pollChronicle(); } catch (err) { console.error('chronicle poll failed', err); }
    }
    this.syncMenuPauseSetting();
  }

  private hudFailures = 0;

  /** The HUD repaints every frame: if something in the game data trips it, log a few times and keep the game running. */
  private guardedHud(): void {
    try {
      this.hud.update(this.clock);
    } catch (err) {
      if (this.hudFailures++ < 3) console.error('HUD update failed', err);
    }
  }

  capturesInput(): boolean {
    if (this.screen !== 'game') return true;
    if (this.stack.captures()) return true;
    const g = this.bound?.game;
    if (g && g.sim.view.clock().skipping) return true;
    return isTypingTarget(document.activeElement) && this.root.contains(document.activeElement);
  }

  setScreen(screen: UiScreen, info?: { progress?: number; label?: string }): void {
    const prev = this.screen;
    this.screen = screen;
    if (screen === 'menu') {
      this.unbind();
      this.loading.hide();
      this.hud.setVisible(false);
      this.pendingBirth = false;
      this.pendingGameOver = null;
      this.menu.open(this.afterMenu ?? 'main');
      this.afterMenu = null;
    } else if (screen === 'loading') {
      this.menu.hide();
      this.hud.setVisible(false);
      this.loading.show(info);
    } else {
      this.menu.hide();
      this.loading.hide();
      const g = this.host.game();
      const fresh = !!g && this.bound?.game.sim !== g.sim;
      if (g && fresh) this.bind(g);
      if (g && (prev !== 'game' || this.pendingBirth || fresh)) this.afterEnterGame();
    }
  }

  open(req: UiRequest): void { this.openPanel(req); }

  onEscape(): boolean {
    return this.handleEscape();
  }

  dispose(): void {
    this.unbind();
    this.tooltips.dispose();
    for (const off of this.offs) off();
    this.root.remove();
  }

  // ---------------------------------------------------------------------------------- GameUIExt

  openPanel(req: PanelRequest): void {
    if (this.screen !== 'game' || !this.bound) return;
    const holder: { panel: UiPanel | null; cleanups: Array<() => void> } = { panel: null, cleanups: [] };
    const ctx = this.makeCtx(holder);
    let panel: UiPanel;
    try {
      panel = createPanel(ctx, req, this.hooks);
    } catch (err) {
      console.error('panel failed', req, err);
      this.say('warn', 'That page of the book will not open.');
      return;
    }
    holder.panel = panel;
    this.records.set(panel, { panel, cleanups: holder.cleanups });
    try {
      this.stack.open(panel);
    } catch (err) {
      console.error('panel failed to open', req, err);
      this.stack.close(panel.id);
      this.say('warn', 'That page of the book will not open.');
    }
  }

  closePanel(id: string): void { this.stack.close(id); }
  isOpen(id: string): boolean { return this.stack.has(id); }
  openPanels(): string[] { return this.stack.all().map((p) => p.id); }

  showMenu(view: MenuView): void {
    this.setScreen('menu');
    this.menu.go(view);
  }

  showBirth(): void { this.openPanel({ panel: 'birth' }); }

  // ---------------------------------------------------------------------------------- screens

  private afterEnterGame(): void {
    const g = this.bound?.game;
    if (!g) return;
    this.hud.reset();
    this.feed.clear();
    this.toasts.clear();
    this.lastEncounterKey = '';
    const run = g.sim.state.run;
    if (run.phase === 'choosing') { this.hud.setVisible(false); this.openPanel({ panel: 'death' }); return; }
    this.hud.setVisible(true);
    if (this.pendingBirth) {
      this.pendingBirth = false;
      this.openPanel({ panel: 'birth' });
    }
    this.lastChronicle = g.sim.state.chronicle[g.sim.state.chronicle.length - 1] ?? null;
  }

  private async startRun(opts: { difficulty: Difficulty; statUpgrades: StatUpgrades }): Promise<void> {
    this.pendingBirth = true;
    try {
      await this.host.startNewRun(opts);
    } catch (err) {
      this.pendingBirth = false;
      throw err;
    }
  }

  private async continueRun(): Promise<void> {
    try {
      await this.host.continueRun();
    } catch (err) {
      console.error(err);
    }
  }

  /** From the pause menu and the game-over screen. The panels stay up (and the world paused) until the host has saved. */
  async leaveToMenu(then?: MenuView): Promise<void> {
    this.afterMenu = then ?? null;
    try {
      await this.host.quitToMenu();
    } finally {
      if (this.screen === 'game') this.setScreen('menu');
    }
  }

  // ---------------------------------------------------------------------------------- binding

  private bind(game: GameServices): void {
    this.unbind();
    const sim = game.sim;
    const ev = sim.events;
    const pid = (): PersonId => sim.state.run.playerId;
    const pause = new PauseController({
      paused: () => sim.clock.paused,
      pause: () => sim.dispatch({ type: 'pause' }).ok,
      resume: () => sim.dispatch({ type: 'resume' }).ok,
    });
    const offs: Array<() => void> = [];
    this.bound = { game, offs, pause };
    const eco = game.economy;
    const on = <K extends keyof SimEvents>(type: K, fn: (e: SimEvents[K]) => void): (() => void) => ev.on(type, safe(type, fn));
    offs.push(
      on('notify', (n) => { const f = feedForNotify(n, pid()); if (f) this.feed.push(f, this.clock); }),
      on('points', (p) => this.toasts.push(toastForPoints(p), this.clock)),
      on('skillLevel', (e) => { const t = toastForSkillLevel(e, pid()); if (t) this.toasts.push(t, this.clock); }),
      on('rankChanged', (e) => { const t = toastForRank(e, pid()); if (t) this.toasts.push(t, this.clock); }),
      on('action', (e) => {
        if (e.type !== 'completed' || e.actor !== pid() || !e.outcome.gains?.length) return;
        this.hud.addGains(e.outcome.gains.map((g) => gainChip(g, (ref) => { const good = eco.good(ref); return good ? GOOD_ICON[good.category] : undefined; })));
      }),
      on('trade', (e) => { const f = feedForTrade(e, pid(), (item, qty) => eco.describe(item, qty)); if (f) this.feed.push(f, this.clock); }),
      on('opinion', (e) => { const f = feedForOpinion(e, pid(), (id) => this.nameOf(id)); if (f) this.feed.push(f, this.clock); }),
      on('travel', (e) => { const f = feedForTravel(e, (id) => this.placeName(id)); if (f) this.feed.push(f, this.clock); }),
      on('skip', (e) => {
        if (e.phase === 'start') this.hud.setSkipLabel(e.label);
        const f = feedForSkip(e);
        if (f) this.feed.push(f, this.clock);
      }),
      on('saved', () => this.hud.flashSaved(this.clock)),
      on('chronicle', (e) => this.feedChronicle(e)),
      on('playerDied', () => this.onPlayerDied()),
      on('playerSwitched', (e) => this.onPlayerSwitched(e)),
      on('gameOver', (e) => this.onGameOver(e)),
    );
    this.seenChronicle.clear();
    this.hud.reset();
  }

  private unbind(): void {
    const b = this.bound;
    if (!b) { this.stack.clear(); return; }
    // close the panels while still bound so a pause the UI is holding is released with them
    this.stack.clear();
    b.pause.sync(false);
    this.bound = null;
    for (const off of b.offs) off();
    b.pause.forget();
    this.feed.clear();
    this.toasts.clear();
  }

  // ---------------------------------------------------------------------------------- events

  private onPlayerDied(): void {
    this.stack.clear();
    this.hud.setVisible(false);
    this.openPanel({ panel: 'death' });
  }

  private onPlayerSwitched(e: SimEvents['playerSwitched']): void {
    this.stack.close('death');
    for (const p of [...this.stack.all()]) if (p.group === 'main' || p.group === 'dialogue' || p.group === 'trade') this.stack.close(p.id);
    this.hud.setVisible(true);
    this.hud.reset();
    const g = this.bound?.game;
    if (g) {
      const to = g.sim.state.persons.get(e.to);
      if (to) this.toasts.push({ tone: 'gold', icon: 'user', title: e.reason === 'death' ? 'You carry on' : 'A new life', text: `You are now ${fullName(to)}.`, ttl: 6, key: 'switched' }, this.clock);
    }
  }

  private onGameOver(e: SimEvents['gameOver']): void {
    this.pendingGameOver = e;
    // the last of the line dies first: the death screen stays, and its Continue leads here
    if (this.stack.has('death')) return;
    this.stack.clear();
    this.hud.setVisible(false);
    this.openPanel({ panel: 'gameover', summary: e });
  }

  private onEncounter(): void {
    const t = this.bound?.game.player.hud()?.travel;
    if (!t || t.phase !== 'encounter') return;
    const key = `${t.to}:${t.encounter?.label ?? ''}:${Math.round(t.progress * 100)}`;
    if (key === this.lastEncounterKey) return;
    this.lastEncounterKey = key;
    if (!this.stack.has('encounter')) this.openPanel({ panel: 'encounter' });
  }

  private readonly seenChronicle = new Set<string>();

  private feedChronicle(e: ChronicleEntry): void {
    const g = this.bound?.game;
    if (!g) return;
    // the same entry can arrive as an event and again through the poll
    const key = `${e.day}|${e.kind}|${e.text}`;
    if (this.seenChronicle.has(key)) return;
    this.seenChronicle.add(key);
    if (this.seenChronicle.size > 200) this.seenChronicle.delete(this.seenChronicle.values().next().value as string);
    const player = g.sim.state.persons.get(g.sim.state.run.playerId);
    if (!player) return;
    const family = new Set(familyOf(g.sim.state, player, 3).keys());
    const f = feedForChronicle(e, family);
    if (f) this.feed.push(f, this.clock);
  }

  /** The sim core only appends to `state.chronicle`; new entries about the family become feed lines. */
  private pollChronicle(): void {
    const g = this.bound?.game;
    if (!g) return;
    const list = g.sim.state.chronicle;
    if (!list.length) return;
    let i = list.length - 1;
    const fresh: ChronicleEntry[] = [];
    while (i >= 0 && list[i] !== this.lastChronicle && fresh.length < 12) { fresh.push(list[i]); i--; }
    if (!fresh.length) return;
    this.lastChronicle = list[list.length - 1];
    for (let k = fresh.length - 1; k >= 0; k--) this.feedChronicle(fresh[k]);
  }

  // ---------------------------------------------------------------------------------- panels

  private makeCtx(holder: { panel: UiPanel | null; cleanups: Array<() => void> }): PanelCtx {
    const g = (this.bound as Bound).game;
    const sim = g.sim;
    return {
      host: this.host, game: g, sim, eco: g.economy, social: g.social, player: g.player, zone: g.zone,
      playerId: () => sim.state.run.playerId,
      settings: () => this.host.settings(),
      now: () => this.clock,
      open: (req) => this.openPanel(req),
      close: () => { if (holder.panel) this.stack.close(holder.panel.id); },
      closeId: (id) => { this.stack.close(id); },
      listen: (type, fn) => { holder.cleanups.push(sim.events.on(type, safe(`panel ${type}`, fn))); },
      interval: (ms, fn) => { const t = window.setInterval(fn, ms); holder.cleanups.push(() => window.clearInterval(t)); },
      say: (kind, text) => this.say(kind, text),
      toast: (t) => this.toasts.push(t, this.clock),
      confirm: (o) => this.confirm(o),
      dispatch: (cmd: Command): CommandResult => sim.dispatch(cmd),
      nameOf: (id) => this.nameOf(id),
      placeName: (id) => this.placeName(id),
      describe: (key, qty) => g.economy.describe(key, qty),
      toLocal: (p) => { const s = this.scale || 1; return { x: p.x / s, y: p.y / s }; },
    };
  }

  private confirm(o: ConfirmOptions): void {
    this.openPanel({ panel: 'confirm', options: o });
  }

  private onPanelShown(p: UiPanel): void {
    this.panelLayer.appendChild(p.el);
    p.mount?.();
    if (p.captures && document.pointerLockElement) document.exitPointerLock?.();
  }

  private onPanelHidden(p: UiPanel): void {
    if (p.id === 'dialogue' && this.bound) {
      // a conversation must not outlive its panel — unless the panel was only replaced by a fresh one for the same talk
      const social = this.bound.game.social;
      queueMicrotask(() => {
        if (this.stack.has('dialogue')) return;
        const cur = social.current();
        if (cur) social.end(cur.id);
      });
    }
    const rec = this.records.get(p);
    this.records.delete(p);
    if (rec) for (const c of rec.cleanups) c();
    p.dispose?.();
    this.tooltips.hide();
    if (this.root.classList.contains('mu-still')) { p.el.remove(); return; }
    // fading out: no longer clickable or focusable, so a panel opened right after cannot be confused with it
    p.el.classList.add('leaving');
    p.el.inert = true;
    p.el.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => p.el.remove(), 130);
  }

  private toggleOrOpen(req: PanelRequest): void {
    const id = req.panel;
    if (this.stack.has(id)) { this.stack.close(id); return; }
    this.openPanel(req);
  }

  private say(kind: FeedKind, text: string): void { this.feed.push({ kind, text }, this.clock); }

  private nameOf(id: PersonId): string {
    const p = this.bound?.game.sim.state.persons.get(id);
    return p ? fullName(p) : 'someone';
  }

  private placeName(id: number): string {
    const sim = this.bound?.game.sim;
    return sim ? settlementName(sim.world, id) || 'the road' : 'the road';
  }

  // ---------------------------------------------------------------------------------- pause and settings

  private menuPauseSetting(): boolean { return this.host.settings().pauseInMenus ?? true; }

  private syncPause(): void {
    const b = this.bound;
    if (!b) return;
    b.pause.sync(this.stack.wantsPause(this.menuPauseSetting()));
  }

  private syncHudDim(): void {
    this.hud.setDimmed(this.stack.all().some((p) => p.hidesHud));
  }

  private syncMenuPauseSetting(): void {
    const v = this.menuPauseSetting();
    if (v !== this.lastMenuPause) { this.lastMenuPause = v; this.syncPause(); }
  }

  private onSettingsChanged(): void {
    this.applySettings();
    this.syncPause();
  }

  private effectiveScale(): number { return effectiveScale(this.host.settings().uiScale, window.innerWidth, window.innerHeight); }

  private applySettings(): void {
    const s = this.effectiveScale();
    this.scale = s;
    const r = this.root.style;
    if (Math.abs(s - 1) < 0.001) {
      r.transform = '';
      r.width = '';
      r.height = '';
    } else {
      r.transformOrigin = '0 0';
      r.transform = `scale(${s})`;
      r.width = `${100 / s}%`;
      r.height = `${100 / s}%`;
    }
    this.tooltips.setScale(s);
  }

  // ---------------------------------------------------------------------------------- keyboard

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat && e.code !== 'ArrowUp' && e.code !== 'ArrowDown') {
      if (e.code === 'Tab' && this.screen === 'game') e.preventDefault();
      return;
    }
    const intent = keyIntent(e.code, { typing: isTypingTarget(e.target), ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
    if (this.screen === 'game' && e.code === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !isTypingTarget(e.target)) e.preventDefault();
    if (!intent) return;
    if (this.screen === 'menu') {
      if (intent.type === 'escape' && this.menu.back()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (this.screen !== 'game' || !this.bound) return;
    if (intent.type === 'escape') {
      if (this.handleEscape()) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (this.dispatchKey(intent, e)) { e.preventDefault(); e.stopPropagation(); }
  }

  private dispatchKey(intent: KeyIntent, e: KeyboardEvent): boolean {
    const top = this.stack.top();
    if (intent.type === 'toggle') {
      // screens (pause, death, birth…) and conversations own the keyboard
      if (top && (top.group === 'screen' || top.group === 'dialogue' || top.group === 'trade' || top.escape === 'ignore')) return false;
      if (this.bound?.game.sim.state.run.phase !== 'alive') return false;
      this.togglePanelKey(intent.panel);
      return true;
    }
    try {
      if (top?.key?.(intent, e)) return true;
    } catch (err) {
      console.error(`panel "${top?.id}" failed on a key`, err);
      return false;
    }
    if (intent.type === 'enter' && !top) {
      const req = this.toasts.pendingAction();
      if (req) { this.toasts.dismissAction(); this.openPanel(req); return true; }
    }
    return false;
  }

  private togglePanelKey(key: PanelKey): void {
    const req: PanelRequest =
      key === 'command' ? { panel: 'ledger', tab: 'household' } :
      key === 'map' ? { panel: 'map' } :
      { panel: key } as PanelRequest;
    const id = key === 'command' ? 'ledger' : key;
    if (this.stack.has(id)) this.stack.close(id);
    else this.openPanel(req);
  }

  /** Esc: wake from a skip, close the top panel (or step back inside it), else open the pause menu. */
  private handleEscape(): boolean {
    if (this.screen === 'menu') return this.menu.back();
    if (this.screen !== 'game' || !this.bound) return false;
    const now = performance.now();
    if (now - this.lastEscapeAt < ESCAPE_DEBOUNCE_MS) return true;
    this.lastEscapeAt = now;
    const g = this.bound.game;
    if (g.sim.view.clock().skipping) { g.sim.dispatch({ type: 'cancelSkip' }); return true; }
    const top = this.stack.top();
    if (top) {
      if (top.onEscape?.()) return true;
      this.stack.escape();
      return true;
    }
    if (g.sim.state.run.phase !== 'alive') return true;
    this.openPanel({ panel: 'pause' });
    return true;
  }

  // used by panels through the pause menu
  get game(): GameServices | null { return this.bound?.game ?? null; }

  profileGold(): number { return levelProfile(this.host.profile()).legacyGold; }
}

export function createUiApp(parent: HTMLElement, host: UiHost): UiApp { return new UiApp(parent, host); }
