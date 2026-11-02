// The in-game HUD: player plate, date/time dial and speed controls, interact prompt, action bar,
// message feed, gain chips, travel card, sleep/wait fade, danger vignette and the hotkey dock.
// It repaints only what changed (binders cache the last value), so it costs next to nothing per frame.
import { RANK_NAMES } from '../../core/domain';
import { SEASON_NAMES } from '../../core/time';
import { dayPart } from '../../sim/calendar';
import { roleLabel } from '../../sim/careers';
import type { Speed } from '../../core/time';
import { h, replace, textBinder, classBinder, attrBinder } from '../core/dom';
import { clockText, dayPartLabel, formatMoney, minuteOfDay, pct } from '../core/format';
import type { Feed, FeedLine, GainChip } from '../core/feed';
import { actionView, dayFlags, healthLevel, needViews, promptView, secondsText, travelView, type NeedView } from '../core/hudModel';
import { icon, type IconName } from '../core/icons';
import { DOCK_ENTRIES, type DockEntry, type PanelRequest } from '../core/requests';
import { dockBadges, hasModule } from '../core/modules';
import type { GameServices, UiHost } from '../types';
import { bar, button, chip, keycap, type BarHandle } from '../components/widgets';
import { settlementCard } from '../../sim/api';
import { fullName } from '../../sim/state';
import { arrivedAt, showPlace } from '../core/finder';
import type { PinStore } from '../core/pins';
import { foldButton, isCollapsed } from '../core/collapse';
import { Dial } from './dial';
import type { Toasts } from './toasts';
import type { Guide } from './guide';
import { Banner } from './banner';
import { Compass } from './compass';
import { Destination } from './destination';
import { EdgeArrows } from './edgearrows';
import { HoverCard } from './hover';
import { Minimap } from './minimap';
import { NavState } from './navstate';
import { Tracker } from './tracker';
import { WhatNow } from './whatnow';

export interface HudDeps {
  game(): GameServices | null;
  host: UiHost;
  feed: Feed;
  toasts: Toasts;
  guide: Guide;
  open(req: PanelRequest): void;
  isOpen(id: string): boolean;
  say(kind: 'info' | 'warn', text: string): void;
  placeName(id: number): string;
  /** The journey just ran into an encounter. */
  onEncounter?(): void;
  // ---- clarity pass ----
  /** Places the player asked to be shown (the journal's Find, "What now?"). */
  pins: PinStore;
  /** Screen pixels per interface pixel (the interface scale setting). */
  scale(): number;
  nameOf(id: number): string;
}

const NEED_ICON: Record<NeedView['id'], IconName> = { hunger: 'bread', rest: 'moon_z', warmth: 'flame', mood: 'face' };
const SPEEDS: readonly Speed[] = [1, 3, 8];

export class Hud {
  readonly el = h('div.mu-hud');

  // clarity pass: the stacked columns and the guidance pieces (CLARITY §2, §3, §5)
  readonly nav = new NavState();
  private readonly leftCol = h('div.mu-hud-left');
  private readonly rightCol = h('div.mu-hud-right');
  readonly tracker: Tracker;
  readonly whatNow: WhatNow;
  private readonly compass = new Compass();
  private readonly minimap: Minimap;
  private readonly edge = new EdgeArrows();
  readonly banner = new Banner();
  private readonly hoverCard = new HoverCard();
  private readonly dest = new Destination();
  private readonly dayTypeEl = h('div.mu-hud-daytype');
  private lastSettlementId = -2;
  private lastBannerId = -1;
  private lastBannerAt = -1000;
  private clockNow = 0;
  /** The first settlement of a new run is announced by the intro card, not the banner. */
  suppressBanner = false;

  // player plate
  private readonly plate = h('div.mu-hud-player.mu-plate');
  private readonly nameEl = h('span.mu-hud-name');
  private readonly metaEl = h('div.mu-hud-meta');
  private readonly moneyEl = h('span');
  private readonly hpBar: BarHandle = bar('hp');
  private readonly stBar: BarHandle = bar('sta');
  private readonly hpNum = h('span.mu-hud-num');
  private readonly stNum = h('span.mu-hud-num');
  private readonly needEls = new Map<NeedView['id'], HTMLElement>();
  private readonly perkBadge = h<HTMLButtonElement>('button.mu-hud-perk.mu-hide', { type: 'button' });

  // clock plate
  private readonly clockPlate = h('div.mu-hud-clock.mu-plate');
  private readonly dial = new Dial(54);
  private readonly dateEl = h('div.mu-hud-date');
  private readonly timeEl = h('span.mu-hud-time');
  private readonly partEl = h('span.mu-hud-part');
  private readonly flagsEl = h('div.mu-hud-flags');
  private readonly placeEl = h('div.mu-hud-place');
  private readonly speedBtns: HTMLButtonElement[] = [];
  private readonly pauseBtn = h<HTMLButtonElement>('button.mu-hud-speed.pause', { type: 'button', tip: 'Pause (P)', 'aria-label': 'Pause' }, icon('pause', 14));
  private readonly badgesEl = h('div.mu-hud-badges');
  private readonly dangerChip = h('div.mu-hud-danger-chip.mu-hide', { tip: 'A hostile is near: fast speeds and sleeping are refused.' }, icon('swords', 15), 'Danger nearby');

  // centre-bottom
  private readonly gainsEl = h('div.mu-hud-gains');
  private readonly actionEl = h('div.mu-hud-action.mu-hide');
  private readonly actionLabel = h('span');
  private readonly actionSecs = h('span.mu-num');
  private readonly actionBar: BarHandle = bar('gold');
  private readonly promptEl = h('div.mu-hud-prompt.mu-hide');
  private readonly promptKey = keycap('E');
  private readonly promptLabel = h('span.mu-hud-prompt-label');
  private readonly promptTarget = h('span.mu-hud-prompt-target');
  private readonly promptReason = h('div.mu-hud-prompt-reason');

  // feed, dock, travel, overlays
  private readonly feedEl = h('div.mu-feed');
  /** The lines themselves; the bar under them folds the feed away to a count of messages. */
  private readonly feedList = h('div.mu-feed-list');
  private readonly feedCount = h('span.mu-feed-bar-count');
  private readonly feedBar = h('div.mu-feed-bar.mu-hide');
  private readonly feedLines = new Map<number, { el: HTMLElement; count: HTMLElement; shown: number }>();
  private readonly dockEl = h('div.mu-dock.mu-plate');
  private readonly dockBtns = new Map<string, HTMLButtonElement>();
  private readonly dockEntries = new Map<string, DockEntry>();
  private readonly dockSeps: HTMLElement[] = [];
  private readonly travelEl = h('div.mu-hud-travel.mu-plate.mu-hide');
  private readonly travelTitle = h('div.mu-hud-travel-title');
  private readonly travelBar: BarHandle = bar('lapis');
  private readonly travelRemaining = h('span');
  private readonly travelPct = h('span.mu-num');
  private readonly travelEncounter = h('div.mu-hud-travel-enc.mu-hide');
  private readonly travelBtns = h('div.mu-row.mu-gap-6');
  private readonly dangerEl = h('div.mu-hud-danger');
  private readonly sleepEl = h('div.mu-hud-sleep');
  private readonly sleepTitle = h('div.mu-hud-sleep-title');
  private readonly sleepTime = h('div.mu-hud-sleep-time');
  private readonly savedEl = h('div.mu-hud-saved', null, icon('quill', 15), 'Saved');

  // fighting: reticle, hit flash, the "you are down" state, the blood bar
  private readonly reticle = h('div.mu-reticle.mu-hide', { 'aria-hidden': 'true' }, h('i.ring'), h('i.dot'), h('i.tick.t'), h('i.tick.b'), h('i.tick.l'), h('i.tick.r'));
  private readonly hitFlash = h('div.mu-hud-hit');
  private readonly downEl = h('div.mu-hud-down');
  private readonly downText = h('div.mu-hud-down-text');
  private readonly bloodRow = h('div.mu-hud-bar.mu-hud-blood.mu-hide', { tip: 'Blood: bleeding wounds drain it; bind them (B)' });
  private readonly bloodBar: BarHandle = bar('vermilion');
  private readonly bloodNum = h('span.mu-hud-num');
  private readonly stRow = h('div.mu-hud-bar', { tip: 'Stamina' });
  private readonly combatChip = h('div.mu-hud-combat.mu-hide');
  /** "Weapon drawn": what the mouse does now and how to put it away (clarity pass). */
  private readonly drawnChip = h('div.mu-hud-drawn.mu-hide');
  private lastDrawnKey = '';
  private lastHitSeq = -1;
  private lastCombatKey = '';

  // cached values
  private readonly setName = textBinder(this.nameEl);
  private readonly setMeta = textBinder(this.metaEl);
  private readonly setMoney = textBinder(this.moneyEl);
  private readonly setHpNum = textBinder(this.hpNum);
  private readonly setStNum = textBinder(this.stNum);
  private readonly setDate = textBinder(this.dateEl);
  private readonly setTime = textBinder(this.timeEl);
  private readonly setPart = textBinder(this.partEl);
  private readonly setActionLabel = textBinder(this.actionLabel);
  private readonly setActionSecs = textBinder(this.actionSecs);
  private readonly setPromptLabel = textBinder(this.promptLabel);
  private readonly setPromptTarget = textBinder(this.promptTarget);
  private readonly setPromptReason = textBinder(this.promptReason);
  private readonly setTravelTitle = textBinder(this.travelTitle);
  private readonly setTravelRemaining = textBinder(this.travelRemaining);
  private readonly setTravelPct = textBinder(this.travelPct);
  private readonly setSleepTitle = textBinder(this.sleepTitle);
  private readonly setSleepTime = textBinder(this.sleepTime);
  private readonly dangerOn = classBinder(this.el, 'danger');
  private readonly sleepOn = classBinder(this.sleepEl, 'on');
  private readonly promptDisabled = classBinder(this.promptEl, 'disabled');
  private readonly setNeedTip: Map<string, (v: string | null) => void> = new Map();

  private lastMoney = NaN;
  private lastHp = NaN;
  private lastHpMax = NaN;
  private lastSt = NaN;
  private lastStMax = NaN;
  private lastMinute = -1;
  private lastSpeedKey = '';
  private lastFlagsKey = '';
  private lastSlow = -10;
  private lastArrival = -10;
  private lastFeedSig = '';
  private lastPlace = '';
  private lastPerkCount = -1;
  private lastTravelPhase = '';
  private lastNeedSig = '';
  private savedUntil = 0;
  private promptShown = false;
  private skipLabel = '';
  private needScratch: NeedView[] = [];

  constructor(private readonly deps: HudDeps) {
    const feedFold = foldButton('feed', 'the messages', () => { this.lastFeedSig = ''; this.paintFeedFold(); });
    this.feedBar.append(icon('scroll', 12), this.feedCount, feedFold);
    this.feedBar.addEventListener('click', () => feedFold.click());
    this.feedEl.append(this.feedList, this.feedBar);
    this.tracker = new Tracker({
      game: () => deps.game(), nav: this.nav, nameOf: (id) => deps.nameOf(id),
      openJournal: () => deps.open({ panel: 'journal' }), whatNow: () => this.whatNow.toggle(),
    });
    this.whatNow = new WhatNow({
      game: () => deps.game(), nav: this.nav, show: (spot) => { showPlace(deps.game(), deps.pins, spot); }, say: (text) => deps.say('info', text),
      openJournal: () => deps.open({ panel: 'journal' }),
    });
    this.minimap = new Minimap({ game: () => deps.game(), nav: this.nav, openMap: () => deps.open({ panel: 'map' }) });
    this.buildPlate();
    this.buildClock();
    this.buildCenter();
    this.buildDock();
    this.buildTravel();
    this.sleepEl.append(
      h('div.mu-hud-sleep-card', null,
        icon('moon_z', 38), this.sleepTitle, this.sleepTime,
        button('Wake up', { onClick: () => this.cancelSkip(), icon: 'sun', variant: 'primary' }),
        h('div.mu-dim.mu-small', null, keycap('Esc', true), ' also wakes you')),
    );
    this.leftCol.append(this.plate, this.tracker.el, this.whatNow.el, this.deps.guide.el);
    this.rightCol.append(this.clockPlate, this.minimap.el);
    this.el.append(
      this.leftCol, this.rightCol, this.compass.el, this.banner.el, this.dangerEl, this.deps.toasts.el, this.travelEl, this.edge.el, this.dest.el,
      this.gainsEl, this.actionEl, this.promptEl, this.feedEl, this.dockEl, this.savedEl, this.reticle, this.hitFlash, this.downEl, this.combatChip, this.drawnChip,
      this.hoverCard.el, this.sleepEl,
    );
    this.downEl.append(h('div.mu-hud-down-card', null, icon('skull', 30), h('div.mu-hud-down-title', null, 'You are down'), this.downText));
  }

  // ---------------------------------------------------------------- construction

  private buildPlate(): void {
    const money = h('span.mu-chip.gold.mu-hud-money', null, icon('coin', 14), this.moneyEl);
    const needs = h('div.mu-hud-needs');
    for (const id of ['hunger', 'rest', 'warmth', 'mood'] as const) {
      const el = h('span.mu-need.ok', { tip: id }, icon(NEED_ICON[id], 17));
      this.needEls.set(id, el);
      this.setNeedTip.set(id, attrBinder(el, 'data-tip'));
      needs.appendChild(el);
    }
    this.bloodRow.append(icon('drop', 15, 'blood'), this.bloodBar.el, this.bloodNum);
    this.stRow.append(icon('bolt', 15, 'sta'), this.stBar.el, this.stNum);
    this.perkBadge.append(icon('star_f', 14), h('span', null, 'Perk ready'));
    this.perkBadge.addEventListener('click', () => this.openPerk());
    this.plate.append(
      h('div.mu-hud-namerow', null, this.nameEl, money),
      this.metaEl,
      h('div.mu-hud-bar', { tip: 'Health' }, icon('heart', 15, 'hp'), this.hpBar.el, this.hpNum),
      this.bloodRow,
      this.stRow,
      h('div.mu-row.mu-between.mu-hud-lower', null, needs, this.perkBadge),
    );
  }

  private buildClock(): void {
    const mkSpeed = (label: string, tip: string, speed: Speed): HTMLButtonElement => {
      const b = h<HTMLButtonElement>('button.mu-hud-speed', { type: 'button', tip, 'aria-label': tip }, label);
      b.addEventListener('click', () => this.setSpeed(speed));
      this.speedBtns.push(b);
      return b;
    };
    this.pauseBtn.addEventListener('click', () => this.togglePause());
    this.clockPlate.addEventListener('click', (e) => { if (!(e.target as Element).closest('button')) this.deps.open({ panel: 'journal', tab: 'today' }); });
    this.clockPlate.classList.add('mu-click');
    // folded (the default), the card keeps the dial and the time; the day, the place and the speed buttons fold away
    this.clockPlate.classList.toggle('folded', isCollapsed('clock'));
    this.clockPlate.append(
      h('div.mu-hud-clockrow', null,
        this.dial.el,
        h('div.mu-hud-when', { tip: 'A day lasts ten minutes at normal speed. Four days make a season, sixteen a year. Click for today in the journal.' },
          this.dateEl,
          h('div.mu-hud-timerow', null, this.timeEl, this.partEl),
        ),
        h('span.mu-grow'),
        foldButton('clock', 'the day and speeds', (c) => this.clockPlate.classList.toggle('folded', c)),
      ),
      this.flagsEl,
      this.dayTypeEl,
      this.placeEl,
      h('div.mu-hud-speeds', null, this.pauseBtn, mkSpeed('1×', 'Normal speed (1)', 1), mkSpeed('3×', 'Fast (2)', 3), mkSpeed('8×', 'Fastest (3)', 8)),
      this.badgesEl,
      this.dangerChip,
    );
  }

  private buildCenter(): void {
    this.actionEl.append(h('div.mu-hud-action-top', null, this.actionLabel, this.actionSecs), this.actionBar.el);
    this.promptEl.append(
      h('div.mu-hud-prompt-main', null, this.promptKey, this.promptLabel, h('span.mu-hud-prompt-dot', null, '·'), this.promptTarget),
      this.promptReason,
    );
  }

  private buildDock(): void {
    let lastGroup = '';
    for (const d of DOCK_ENTRIES) {
      if (lastGroup && d.group !== lastGroup) {
        const sep = h('span.mu-dock-break');
        this.dockSeps.push(sep);
        this.dockEl.appendChild(sep);
      }
      lastGroup = d.group;
      const b = h<HTMLButtonElement>('button.mu-dockbtn', { type: 'button', tip: `${d.label}  (${d.key})`, 'aria-label': d.label },
        icon(dockIcon(d), 19));
      b.addEventListener('click', () => this.deps.open(d.request));
      this.dockBtns.set(d.panelId, b);
      this.dockEntries.set(d.panelId, d);
      this.dockEl.appendChild(b);
    }
    const menu = h<HTMLButtonElement>('button.mu-dockbtn', { type: 'button', tip: 'Menu  (Esc)', 'aria-label': 'Menu' }, icon('cog', 19));
    menu.addEventListener('click', () => this.deps.open({ panel: 'pause' }));
    this.dockEl.append(menu);
  }

  /** Hides the buttons of modules this run does not have, and puts the little count dots on the others. */
  private updateDock(game: GameServices): void {
    const sim = game.sim;
    const badges = dockBadges(sim, sim.state.run.playerId);
    let anyRealm = false;
    for (const [pid, b] of this.dockBtns) {
      const d = this.dockEntries.get(pid) as DockEntry;
      const present = hasModule(sim, d.needs);
      b.classList.toggle('mu-hide', !present);
      if (present && d.group === 'realm') anyRealm = true;
      b.classList.toggle('on', this.deps.isOpen(pid));
      const badge = badges.get(d.id);
      let dot = b.querySelector('.mu-dockdot');
      if (!badge || !present) { dot?.remove(); b.classList.remove('alert'); continue; }
      if (!dot) { dot = h('span.mu-dockdot'); b.appendChild(dot); }
      dot.textContent = badge.count > 9 ? '9+' : String(badge.count);
      dot.className = `mu-dockdot ${badge.tone}`;
      b.classList.toggle('alert', badge.tone === 'vermilion');
    }
    for (const sep of this.dockSeps) sep.classList.toggle('mu-hide', !anyRealm);
    this.dockEl.classList.toggle('compact', !anyRealm);
  }

  private buildTravel(): void {
    this.travelEl.append(
      h('div.mu-row.mu-gap-8', null, icon('signpost', 20), this.travelTitle),
      this.travelBar.el,
      h('div.mu-row.mu-between.mu-small', null, this.travelRemaining, this.travelPct),
      this.travelEncounter,
      this.travelBtns,
    );
  }

  // ---------------------------------------------------------------- commands

  private setSpeed(speed: Speed): void {
    const game = this.deps.game();
    if (!game) return;
    if (game.sim.clock.paused) game.sim.dispatch({ type: 'resume' });
    const r = game.sim.dispatch({ type: 'setSpeed', speed });
    if (!r.ok) {
      this.deps.say('warn', `Cannot hurry: ${r.reason ?? 'not now'}`);
      const btn = this.speedBtns[SPEEDS.indexOf(speed)];
      btn.classList.remove('refused');
      void btn.offsetWidth;
      btn.classList.add('refused');
    }
  }

  private togglePause(): void {
    this.deps.game()?.sim.dispatch({ type: 'togglePause' });
  }

  private cancelSkip(): void {
    this.deps.game()?.sim.dispatch({ type: 'cancelSkip' });
  }

  private openPerk(): void {
    const game = this.deps.game();
    if (!game) return;
    const choice = game.economy.perkChoices(game.sim.state.run.playerId)[0];
    if (choice) this.deps.open({ panel: 'perk', person: game.sim.state.run.playerId, skill: choice.skill });
  }

  /** Pops the little quill when the game saves. */
  flashSaved(now: number): void {
    this.savedUntil = now + 1.6;
    this.savedEl.classList.add('on');
  }

  /** Floating "+3 sheaves" chips above the prompt. */
  addGains(chips: readonly GainChip[]): void {
    for (const c of chips.slice(0, 5)) {
      const el = h('div.mu-hud-gain', null, icon(c.icon, 15), c.text);
      this.gainsEl.appendChild(el);
      el.addEventListener('animationend', () => el.remove());
      while (this.gainsEl.childElementCount > 6) this.gainsEl.firstElementChild?.remove();
    }
  }

  setVisible(v: boolean): void { this.el.classList.toggle('mu-hide', !v); }

  /** Fades the whole HUD out (birth reveal, death, game over). */
  setDimmed(on: boolean): void { this.el.classList.toggle('dimmed', on); }

  /** Clears transient state (new run, back to menu). */
  reset(): void {
    this.feedList.replaceChildren();
    this.feedLines.clear();
    this.gainsEl.replaceChildren();
    this.lastFeedSig = '';
    this.lastPerkCount = -1;
    this.lastMoney = NaN;
    this.lastMinute = -1;
    this.lastFlagsKey = '';
    this.lastSpeedKey = '';
    this.lastSlow = -10;
    this.lastPlace = '';
    this.lastSettlementId = -2;
    this.banner.hide();
    this.whatNow.close();
    this.hoverCard.hide();
    this.sleepOn(false);
  }

  // ---------------------------------------------------------------- per-frame update

  update(now: number): void {
    const game = this.deps.game();
    if (!game) return;
    const sim = game.sim;
    const hud = game.player.hud();
    const clock = sim.view.clock();

    this.updateClock(clock, now);
    this.updatePlayer(hud);
    this.updatePrompt(hud);
    this.updateAction(hud);
    this.updateTravel(hud);
    this.updateCombat(game, hud);
    this.updateOverlays(clock, hud);
    this.updateFeed(now);
    this.clockNow = now;
    this.updateGuidance(game, hud, now);
    this.deps.guide.update(now);
    if (this.savedUntil && now > this.savedUntil) { this.savedUntil = 0; this.savedEl.classList.remove('on'); }

    if (now - this.lastSlow >= 0.5) {
      this.lastSlow = now;
      this.updateSlow(game);
    }
  }

  /** The compass, the minimap, the tracker, the screen-edge arrows, the destination ring and the cursor's tooltip. */
  private updateGuidance(game: GameServices, hud: ReturnType<GameServices['player']['hud']>, now: number): void {
    const nav = this.nav;
    nav.update(game, this.deps.host, this.deps.pins);
    if (now - this.lastArrival >= 0.25) {
      this.lastArrival = now;
      const arrived = arrivedAt(game, this.deps.pins, nav.x, nav.z);
      if (arrived) this.deps.say('info', arrived);
    }
    const showGuides = nav.street && !!hud && !hud.travel;
    this.compass.setVisible(showGuides);
    if (showGuides) this.compass.update(nav);
    const showMap = nav.street && !!hud && this.deps.host.settings().minimap !== false;
    this.minimap.setVisible(showMap);
    if (showMap) this.minimap.update(now);
    this.tracker.update(now);
    this.whatNow.update(now);
    const scale = this.deps.scale() || 1;
    if (showGuides) this.edge.update(nav, this.deps.host, scale);
    this.edge.el.classList.toggle('mu-hide', !showGuides);
    this.dest.update(game, this.deps.host, scale);
    const hov = game.player.hover?.() ?? null;
    this.hoverCard.update(hov, now, hov ? hov.x / scale : 0, hov ? hov.y / scale : 0, window.innerWidth / scale, window.innerHeight / scale);
    this.el.classList.toggle('with-banner', this.banner.isOn(now));
    this.banner.update(now);
  }

  /** The window or the interface scale changed. */
  resized(): void { this.compass.resize(); }

  /** Shows the settlement banner for where the body stands (tools and tests). */
  announce(): void { this.lastSettlementId = -2; this.lastBannerId = -1; this.suppressBanner = false; this.lastSlow = -10; }

  private updateClock(clock: ReturnType<GameServices['sim']['view']['clock']>, _now: number): void {
    const minute = minuteOfDay(clock.dayFraction);
    if (minute !== this.lastMinute) {
      this.lastMinute = minute;
      this.setTime(clockText(clock.dayFraction));
      this.setPart(dayPartLabel(dayPart(clock.absDay)));
      this.dial.set(clock.season, clock.dayFraction);
    }
    this.setDate(`${SEASON_NAMES[clock.season]} ${clock.dayOfSeason}, Year ${clock.year}`);
    const skipping = clock.skipping ?? '';
    const speedKey = `${clock.paused ? 'p' : clock.speed}|${clock.calendarRate < 1 ? 'a' : ''}|${skipping}`;
    if (speedKey !== this.lastSpeedKey) {
      this.lastSpeedKey = speedKey;
      const effective = clock.paused ? 0 : clock.speed;
      this.speedBtns.forEach((b, i) => b.classList.toggle('on', effective === SPEEDS[i] && !skipping));
      this.pauseBtn.classList.toggle('on', clock.paused);
      this.badgesEl.replaceChildren();
      if (clock.paused) this.badgesEl.append(chip('Paused', 'lapis', 'pause'));
      if (clock.calendarRate < 1) this.badgesEl.append(chip('Action time', 'vermilion', 'hourglass', 'The calendar crawls while you fight, talk or trade.'));
      if (skipping) this.badgesEl.append(chip(skipping === 'sleep' ? 'Sleeping' : 'Waiting', 'gold', skipping === 'sleep' ? 'moon_z' : 'hourglass'));
    }
  }

  private updatePlayer(hud: ReturnType<GameServices['player']['hud']>): void {
    this.plate.classList.toggle('mu-hide', !hud);
    if (!hud) return;
    this.setName(hud.name);
    if (hud.money !== this.lastMoney) { this.lastMoney = hud.money; this.setMoney(formatMoney(hud.money)); }
    if (hud.hp !== this.lastHp || hud.maxHp !== this.lastHpMax) {
      this.lastHp = hud.hp; this.lastHpMax = hud.maxHp;
      this.hpBar.set(hud.hp, hud.maxHp);
      this.setHpNum(`${Math.ceil(hud.hp)}`);
      const lvl = healthLevel(hud.hp, hud.maxHp);
      this.plate.classList.toggle('hurt', lvl !== 'ok');
      this.plate.classList.toggle('critical', lvl === 'critical');
    }
    if (hud.stamina !== this.lastSt || hud.maxStamina !== this.lastStMax) {
      this.lastSt = hud.stamina; this.lastStMax = hud.maxStamina;
      this.stBar.set(hud.stamina, hud.maxStamina);
      this.setStNum(`${Math.ceil(hud.stamina)}`);
    }
    const views = needViews(hud, this.needScratch);
    let sig = '';
    for (const v of views) sig += `${v.level[0]}${Math.round(v.value * 20)}`;
    if (sig !== this.lastNeedSig) {
      this.lastNeedSig = sig;
      for (const v of views) {
        const el = this.needEls.get(v.id);
        if (!el) continue;
        el.className = `mu-need ${v.level}`;
        el.style.setProperty('--v', `${Math.round(v.value * 100)}%`);
        this.setNeedTip.get(v.id)?.(`${v.hint} (${pct(v.value)})`);
      }
    }
  }

  /** The reticle, the hit flash, "you are down", the blood row and the stance chip. */
  private updateCombat(game: GameServices, hud: ReturnType<GameServices['player']['hud']>): void {
    const c = hud?.combat;
    const state = c?.state ?? 'ready';
    // reticle: with a bow in hand and the weapon out
    const showReticle = !!c && c.ranged && (c.engaged || state === 'draw' || state === 'aim' || state === 'shoot' || state === 'reload');
    this.reticle.classList.toggle('mu-hide', !showReticle);
    if (showReticle) this.reticle.className = `mu-reticle ${state}`;
    // a blow taken: a red flash that fades
    if (c && c.hitSeq !== this.lastHitSeq) {
      if (this.lastHitSeq >= 0) { this.hitFlash.classList.remove('on'); void this.hitFlash.offsetWidth; this.hitFlash.classList.add('on'); }
      this.lastHitSeq = c.hitSeq;
    }
    const down = state === 'down';
    this.downEl.classList.toggle('on', down);
    // blood and wounds
    const cb = game.sim.services.combat;
    const pid = game.sim.state.run.playerId;
    const blood = cb?.blood?.(pid) ?? 1;
    const wounds = cb?.wounds(pid) ?? [];
    let bleeding = 0;
    for (const w of wounds) if (w.bleeding) bleeding++;
    const showBlood = blood < 0.995 || bleeding > 0;
    this.bloodRow.classList.toggle('mu-hide', !showBlood);
    this.plate.classList.toggle('bleeding', bleeding > 0);
    if (showBlood) { this.bloodBar.set(blood); this.bloodNum.textContent = `${Math.round(blood * 100)}`; }
    if (down) this.downText.textContent = bleeding > 0 || blood < 0.5 ? 'You are bleeding. You cannot act until you are on your feet again.' : 'Knocked flat. Catch your breath; you will be up in a moment.';
    // out of breath
    this.stRow.classList.toggle('winded', !!hud?.exhausted);
    // the weapon is out: say what the mouse does now, and how to put it away
    const drawnState = !hud?.drawn || state === 'down' ? '' : this.deps.host.mouseLooking?.() === false ? 'free' : 'look';
    if (drawnState !== this.lastDrawnKey) {
      this.lastDrawnKey = drawnState;
      this.drawnChip.classList.toggle('mu-hide', !drawnState);
      this.drawnChip.classList.toggle('free', drawnState === 'free');
      if (drawnState) {
        this.drawnChip.replaceChildren(
          icon('swords', 15), h('b', null, 'Weapon drawn'),
          h('span', null, drawnState === 'free' ? 'Click the view to take the mouse' : 'Left strikes, right guards'),
          h('span.mu-dim', null, keycap('G', true), ' puts it away', drawnState === 'look' ? [' · ', keycap('Esc', true), ' frees the mouse'] : null));
      }
    }
    // stance chip
    const label = state === 'down' ? '' : stateLabel(state, !!hud?.exhausted);
    const key = `${c?.engaged ? 1 : 0}|${label}`;
    if (key !== this.lastCombatKey) {
      this.lastCombatKey = key;
      this.combatChip.classList.toggle('mu-hide', !label);
      if (label) this.combatChip.replaceChildren(icon(state === 'draw' || state === 'aim' || state === 'shoot' ? 'target' : state === 'guard' ? 'shield' : 'swords', 14), label);
      this.combatChip.className = `mu-hud-combat${label ? '' : ' mu-hide'}${state === 'hit' || state === 'stagger' || state === 'down' ? ' hurt' : ''}`;
    }
  }

  private updatePrompt(hud: ReturnType<GameServices['player']['hud']>): void {
    const p = hud && hud.combat?.state !== 'down' ? promptView(hud.prompt) : null;
    if (!p) {
      if (this.promptShown) { this.promptShown = false; this.promptEl.classList.add('mu-hide'); }
      return;
    }
    if (!this.promptShown) { this.promptShown = true; this.promptEl.classList.remove('mu-hide'); }
    this.setPromptLabel(p.label);
    this.setPromptTarget(p.target);
    this.setPromptReason(p.reason);
    this.promptReason.classList.toggle('mu-hide', !p.reason);
    this.promptDisabled(!p.enabled);
  }

  private updateAction(hud: ReturnType<GameServices['player']['hud']>): void {
    const a = hud?.action ? actionView(hud.action) : null;
    this.actionEl.classList.toggle('mu-hide', !a);
    if (!a) return;
    this.setActionLabel(a.label);
    this.setActionSecs(secondsText(a.secondsLeft));
    this.actionBar.set(a.progress);
  }

  private updateTravel(hud: ReturnType<GameServices['player']['hud']>): void {
    const t = hud?.travel ?? null;
    this.travelEl.classList.toggle('mu-hide', !t);
    if (!t) { this.lastTravelPhase = ''; return; }
    const v = travelView(t, this.deps.placeName);
    this.setTravelTitle(v.title);
    this.setTravelRemaining(v.remaining);
    this.setTravelPct(pct(v.progress));
    this.travelBar.set(v.progress);
    this.travelEl.classList.toggle('encounter', v.phase === 'encounter');
    if (v.phase !== this.lastTravelPhase) {
      const entering = v.phase === 'encounter';
      this.lastTravelPhase = v.phase;
      if (entering) this.deps.onEncounter?.();
      this.travelBtns.replaceChildren();
      if (v.phase === 'encounter') {
        this.travelEncounter.classList.remove('mu-hide');
        this.travelBtns.append(
          button('Journey options', { size: 'small', variant: 'primary', icon: 'signpost', onClick: () => this.deps.open({ panel: 'encounter' }) }),
        );
      } else {
        this.travelEncounter.classList.add('mu-hide');
        this.travelBtns.append(
          button('Cancel journey', { size: 'small', variant: 'danger', icon: 'cross', onClick: () => this.deps.game()?.player.cancelTravel() }),
          button('Map', { size: 'small', icon: 'map', onClick: () => this.deps.open({ panel: 'map' }) }),
        );
      }
    }
    if (v.encounter) this.travelEncounter.textContent = `${v.hostile ? 'Hostile: ' : ''}${v.encounter}`;
  }

  private updateOverlays(clock: ReturnType<GameServices['sim']['view']['clock']>, hud: ReturnType<GameServices['player']['hud']>): void {
    this.dangerOn(!!hud?.danger);
    this.dangerChip.classList.toggle('mu-hide', !hud?.danger);
    const skipping = clock.skipping ?? null;
    this.sleepOn(!!skipping);
    this.sleepEl.classList.toggle('sleep', skipping === 'sleep');
    if (skipping) {
      this.setSleepTitle(this.skipLabel || (skipping === 'sleep' ? 'Sleeping…' : 'Waiting…'));
      this.setSleepTime(`${SEASON_NAMES[clock.season]} ${clock.dayOfSeason} · ${clockText(clock.dayFraction)}`);
    }
  }

  setSkipLabel(label: string): void { this.skipLabel = label; }

  private updateFeed(now: number): void {
    this.deps.feed.prune(now);
    this.deps.toasts.update(now);
    const lines = this.deps.feed.list();
    let sig = '';
    for (const l of lines) sig += `${l.id}.${l.count};`;
    if (sig !== this.lastFeedSig) {
      this.lastFeedSig = sig;
      const live = new Set<number>();
      for (const l of lines) {
        live.add(l.id);
        let rec = this.feedLines.get(l.id);
        if (!rec) {
          rec = this.makeFeedLine(l);
          this.feedLines.set(l.id, rec);
          this.feedList.appendChild(rec.el);
        }
        if (rec.shown !== l.count) {
          rec.shown = l.count;
          rec.count.textContent = l.count > 1 ? `×${l.count}` : '';
          rec.el.classList.remove('bump');
          void rec.el.offsetWidth;
          rec.el.classList.add('bump');
        }
      }
      for (const [id, rec] of this.feedLines) if (!live.has(id)) { rec.el.remove(); this.feedLines.delete(id); }
      this.paintFeedFold();
    }
    for (const l of lines) {
      const rec = this.feedLines.get(l.id);
      if (!rec) continue;
      const op = this.deps.feed.opacity(l, now);
      const css = op >= 1 ? '' : String(Math.round(op * 20) / 20);
      if (rec.el.style.opacity !== css) rec.el.style.opacity = css;
    }
  }

  /** Folded: the lines are hidden and the bar says how many are waiting; open: the bar offers to fold them. */
  private paintFeedFold(): void {
    const folded = isCollapsed('feed');
    const n = this.deps.feed.list().length;
    this.feedList.classList.toggle('mu-hide', folded);
    this.feedEl.classList.toggle('folded', folded);
    this.feedBar.classList.toggle('mu-hide', n === 0 && !folded);
    this.feedCount.textContent = folded ? (n ? `${n} ${n === 1 ? 'message' : 'messages'}` : 'Messages') : 'Fold messages';
  }

  private makeFeedLine(l: FeedLine): { el: HTMLElement; count: HTMLElement; shown: number } {
    const count = h('span.mu-feed-count');
    const el = h('div.mu-feed-line', { class: l.kind }, l.icon ? h('span.mu-feed-ico', null, icon(l.icon, 14)) : null, h('span.mu-feed-text', null, l.text), count);
    return { el, count, shown: 0 };
  }

  private updateSlow(game: GameServices): void {
    const sim = game.sim;
    const id = sim.state.run.playerId;
    const p = sim.state.persons.get(id);
    if (p) {
      const meta = `Age ${Math.floor((sim.absDay - p.birthDay) / 16)} · ${roleLabel(p.career, p.careerStage, p.sex)} · ${RANK_NAMES[p.rankTier]}`;
      this.setMeta(meta);
    }
    // location and market day
    let placeKey = '';
    let marketId: number | null = null;
    const body = game.player.body();
    const pos = body ?? (p ? sim.world.settlements.find((s) => s.id === p.settlement) ?? null : null);
    if (pos) {
      const s = sim.world.settlementAt(pos.x, pos.z);
      const near = s ?? sim.world.nearestSettlement(pos.x, pos.z);
      const kingdom = sim.world.kingdomAt(pos.x, pos.z);
      if (s?.market) marketId = s.id;
      placeKey = `${s ? '' : 'near '}${near.name}|${kingdom?.name ?? ''}`;
      if (placeKey !== this.lastPlace) {
        this.lastPlace = placeKey;
        replace(this.placeEl,icon('pin', 14), h('span.mu-hud-placename', null, `${s ? '' : 'Near '}${near.name}`), kingdom ? h('span.mu-dim', null, ` · ${kingdom.name}`) : '');
      }
    }
    const flags = dayFlags(sim.absDay, marketId);
    const placeWord = marketId !== null ? this.deps.placeName(marketId) : '';
    const fkey = `${flags.holy}${flags.market}${flags.dayOfWeek}|${placeWord}`;
    if (fkey !== this.lastFlagsKey) {
      this.lastFlagsKey = fkey;
      replace(this.flagsEl,
        h('span.mu-hud-dow', null, `Day ${flags.dayOfWeek} of 4`),
        flags.holy ? chip('Holy day', 'gold', 'cross_holy', 'A holy day: church, then games and archery practice at the butts.') : null,
        flags.market ? chip('Market day', 'lapis', 'market', 'The stalls are full today.') : null,
      );
      // what kind of day it is, in words (CLARITY §3: the clock explains the day)
      const type = flags.holy
        ? 'Holy day: everyone goes to Mass in the morning; afterwards men and youths practise at the butts.'
        : flags.market
          ? `Market day${placeWord ? ` at ${placeWord}` : ''}: the stalls are open, a good day to buy and sell.`
          : `A working day. The holy day ${flags.daysToHoly === 1 ? 'is tomorrow' : `is in ${flags.daysToHoly} days`}.`;
      this.dayTypeEl.textContent = type;
    }
    // announce a settlement when you walk into it
    const nav = this.nav;
    if (nav.settlementId !== this.lastSettlementId) {
      const prev = this.lastSettlementId;
      this.lastSettlementId = nav.settlementId;
      if (nav.settlementId >= 0 && !(this.suppressBanner && prev === -2) && !(nav.settlementId === this.lastBannerId && this.clockNow - this.lastBannerAt < 120)) {
        this.lastBannerId = nav.settlementId;
        this.lastBannerAt = this.clockNow;
        const c = settlementCard(sim, nav.settlementId);
        const lord = c && c.lord ? sim.state.persons.get(c.lord) : undefined;
        if (c) this.banner.show({ name: c.name, kind: c.kind, county: c.county, kingdom: c.kingdom, lord: lord ? fullName(lord) : '' }, this.clockNow);
      }
      this.suppressBanner = false;
    }
    // perk badge
    const perks = game.economy.perkChoices(id).length;
    if (perks !== this.lastPerkCount) {
      this.lastPerkCount = perks;
      this.perkBadge.classList.toggle('mu-hide', perks === 0);
      this.perkBadge.setAttribute('data-tip', perks > 1 ? `${perks} perks waiting` : 'A perk is waiting: choose one of two');
    }
    this.updateDock(game);
  }

}

function stateLabel(state: string, winded: boolean): string {
  switch (state) {
    case 'guard': return 'On guard';
    case 'attack': return 'Striking';
    case 'draw': return 'Drawing';
    case 'aim': return 'Aiming';
    case 'shoot': return 'Loosed';
    case 'reload': return 'Spanning the crossbow';
    case 'roll': return 'Rolling';
    case 'hit': return 'Hit';
    case 'stagger': return 'Staggered';
    case 'down': return 'Down';
    default: return winded ? 'Out of breath' : '';
  }
}

function dockIcon(d: DockEntry): IconName {
  switch (d.id) {
    case 'journal': return 'compass';
    case 'character': return 'user';
    case 'inventory': return 'bag';
    case 'family': return 'tree';
    case 'ledger': return 'ledger';
    case 'map': return 'map';
    case 'chronicle': return 'scroll';
    case 'rest': return 'bed';
    case 'requests': return 'quill';
    case 'wounds': return 'heart';
    case 'techs': return 'book';
    case 'politics': return 'crown';
    case 'army': return 'swords';
    default: return 'dot';
  }
}
