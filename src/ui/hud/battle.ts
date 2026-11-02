// The command HUD of a battle (civilization pass, wave B; docs/CIV.md §9, docs/WAR.md): the group bar (keys 4–7 select all / foot /
// archers / horse), banners floating over the groups, the order wheel (8; then 1–9), the storm's card (the gate, the rams and
// ladders, the men on the walls) and the hotkey for the tactical view (C in battle: src/ui/panels/battle.ts). It is a HUD part
// registered through `registerHudPart` and keys asked through `registerHotkey` (src/ui/core/extHud.ts), so the HUD and the key
// dispatch need no edit. All the rules — what a key selects, what the wheel offers, what an order is — are in
// src/sim/military/commandModel.ts; this is the DOM over them.
import { KEYMAP } from '../../player/types';
import type { SiegeStatus } from '../../sim/military/war';
import {
  ORDER_CHOICES, SELECT_KEYS, WHEEL_KEY, groupLine, groupsSignature, keycapOf, moraleTone, orderByDigit, orderWord, selectionAfter,
  type OrderChoice,
} from '../../sim/military/commandModel';
import type { BattleGroupView, GroupKey, GroupOrder, MilitaryApi } from '../../sim/wave3';
import { h } from '../core/dom';
import { registerHotkey, registerHudPart, type HudPart, type HudPartCtx } from '../core/extHud';
import { icon, type IconName } from '../core/icons';

/** What the HUD and the tactical panel share: the selected group, whether the tactical view is up, how to close it. */
export const battleBus = {
  selected: null as GroupKey | null,
  tactical: false,
  closeTactical: null as null | (() => void),
};

const GROUP_ICON: Record<GroupKey, IconName> = { all: 'flag', foot: 'shield', archers: 'archery', horse: 'horse' };
const SLOTS: readonly GroupKey[] = ['all', 'foot', 'archers', 'horse'];

// ---------------------------------------------------------------------------------------------
// Reading the battle
// ---------------------------------------------------------------------------------------------

export interface BattleView {
  own: readonly BattleGroupView[];
  enemy: readonly BattleGroupView[];
  storm: SiegeStatus | null;
}

const NONE: readonly BattleGroupView[] = [];

export function readBattle(ctx: Pick<HudPartCtx, 'game'>): BattleView {
  const game = ctx.game();
  const mil = game?.sim.services.military as MilitaryApi | undefined;
  const combat = game?.sim.services.combat as { siegeStatus?: () => SiegeStatus | null } | undefined;
  if (!game || !mil?.battleGroups) return { own: NONE, enemy: NONE, storm: null };
  const own = mil.battleGroups('own');
  const enemy = mil.battleGroups('enemy');
  return { own, enemy, storm: own.length + enemy.length > 0 ? combat?.siegeStatus?.() ?? null : null };
}

/** The point on the ground the player's sight falls on (the middle of the screen), or null. */
export function lookPoint(ctx: HudPartCtx): { x: number; z: number } | null {
  const r = ctx.host.renderer();
  return r ? r.screenToGround(window.innerWidth / 2, window.innerHeight * 0.46) : null;
}

/** The enemy man under the sight (a person id), or 0. */
export function sightedEnemy(ctx: HudPartCtx): number {
  const r = ctx.host.renderer();
  const game = ctx.game();
  if (!r?.pick || !game) return 0;
  const hit = r.pick(window.innerWidth / 2, window.innerHeight * 0.46);
  return hit.type === 'character' && hit.id !== undefined && isEnemy(game, hit.id) ? hit.id : 0;
}

/** Is this person on the other side of the fight the player is in? */
export function isEnemy(game: NonNullable<ReturnType<HudPartCtx['game']>>, person: number): boolean {
  const c = game.sim.services.combat as { sideOf?: (p: number) => number } | undefined;
  if (!c?.sideOf) return false;
  const mine = c.sideOf(game.sim.state.run.playerId);
  const his = c.sideOf(person);
  return mine >= 0 && his >= 0 && mine !== his;
}

/** Gives an order to the selected group (everyone when none is selected); says what came of it. */
export function giveOrder(ctx: HudPartCtx, order: GroupOrder, label: string): boolean {
  const game = ctx.game();
  const mil = game?.sim.services.military as MilitaryApi | undefined;
  if (!mil?.orderGroup) return false;
  const r = mil.orderGroup(battleBus.selected ?? 'all', order);
  ctx.say(r.ok ? 'info' : 'warn', r.ok ? `${label}!` : r.reason ?? 'That cannot be done.');
  return r.ok;
}

// ---------------------------------------------------------------------------------------------
// Styles (injected once; every rule is under .mu-bt-)
// ---------------------------------------------------------------------------------------------

const CSS = `
.mu-bt { position: absolute; inset: 0; pointer-events: none; }
.mu-bt.mu-hide { display: none; }
.mu-bt-bar { position: absolute; left: 50%; bottom: 74px; transform: translateX(-50%); display: flex; gap: 6px; pointer-events: auto; align-items: stretch; }
.mu-bt-g { position: relative; min-width: 108px; padding: 6px 9px 7px; border-radius: 6px; cursor: pointer; text-align: left;
  background: linear-gradient(180deg, rgba(246, 234, 208, 0.94), rgba(221, 198, 144, 0.94)); border: 1px solid var(--edge); color: var(--ink);
  box-shadow: 0 2px 8px rgba(10, 6, 2, 0.5); display: flex; flex-direction: column; gap: 2px; font: inherit; }
.mu-bt-g:hover { border-color: var(--gold-hi); }
.mu-bt-g.sel { border-color: var(--gold-hi); box-shadow: 0 0 0 2px rgba(236, 189, 66, 0.85), 0 2px 10px rgba(10, 6, 2, 0.6); background: linear-gradient(180deg, #fbefc4, #ecc95c); }
.mu-bt-g.off { opacity: 0.45; cursor: default; }
.mu-bt-g.hot::after { content: ''; position: absolute; right: 6px; top: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--vermilion); animation: mu-pulse 0.9s infinite; }
.mu-bt-g .top { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 13px; }
.mu-bt-g .top .n { margin-left: auto; font-variant-numeric: tabular-nums; }
.mu-bt-g .ord { font-size: 11px; color: var(--ink-2); font-style: italic; white-space: nowrap; }
.mu-bt-g .mor { height: 4px; border-radius: 2px; background: rgba(42, 27, 15, 0.25); overflow: hidden; margin-top: 2px; }
.mu-bt-g .mor i { display: block; height: 100%; background: var(--green); transform-origin: left; }
.mu-bt-g .mor.gold i { background: #c9961c; }
.mu-bt-g .mor.vermilion i { background: var(--vermilion); }
.mu-bt-g .cap { position: absolute; left: -5px; top: -7px; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 4px; background: #2a1b0f; color: #f6ead0; font-size: 11px; line-height: 18px; text-align: center; border: 1px solid #8c6b36; }
.mu-bt-hint { position: absolute; left: 50%; bottom: 52px; transform: translateX(-50%); font-size: 11.5px; color: #f6ead0; text-shadow: 0 1px 2px #000, 0 0 6px #000; white-space: nowrap; }
.mu-bt-hint b { color: var(--gold-hi); font-weight: 700; }
.mu-bt-banners { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.mu-bt-banner { position: absolute; left: 0; top: 0; transform: translate(-50%, -100%); pointer-events: none; display: flex; flex-direction: column; align-items: center; }
.mu-bt-banner .flag { display: flex; align-items: center; gap: 4px; padding: 2px 8px 3px; border-radius: 3px 3px 10px 10px; font-size: 12px; font-weight: 700; white-space: nowrap;
  color: #2a1b0f; background: linear-gradient(180deg, #f6dd8c, #d8a935); border: 1px solid #7a5410; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6); }
.mu-bt-banner .pole { width: 2px; height: calc(22px + var(--lift, 0px)); background: #3a2a1a; box-shadow: 0 0 2px #000; }
.mu-bt-banner .ord { font-size: 10.5px; font-weight: 400; font-style: italic; opacity: 0.85; }
.mu-bt-banner.enemy .flag { color: #fbeee9; background: linear-gradient(180deg, #d4503a, #8e1c10); border-color: #4b0c06; }
.mu-bt-banner.sel .flag { box-shadow: 0 0 0 2px #fff6cf, 0 1px 6px rgba(0, 0, 0, 0.7); }
.mu-bt-banner.drag { pointer-events: auto; cursor: grab; }
.mu-bt-banner.hot .flag::after { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #b81c0c; margin-left: 2px; }
.mu-bt-wheel { position: absolute; left: 50%; top: 46%; width: 0; height: 0; pointer-events: none; }
.mu-bt-wheel.mu-hide { display: none; }
.mu-bt-wheel .ring { position: absolute; left: -150px; top: -150px; width: 300px; height: 300px; border-radius: 50%; background: radial-gradient(circle, rgba(14, 9, 4, 0.55) 0, rgba(14, 9, 4, 0.1) 62%, rgba(14, 9, 4, 0) 71%); }
.mu-bt-wheel .title { position: absolute; left: -90px; top: -18px; width: 180px; text-align: center; color: #f6ead0; font-size: 12px; text-shadow: 0 1px 3px #000; }
.mu-bt-wheel .title b { display: block; color: var(--gold-hi); font-size: 14px; }
.mu-bt-op { position: absolute; width: 84px; height: 44px; margin: -22px 0 0 -42px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; cursor: pointer; pointer-events: auto;
  border-radius: 8px; border: 1px solid var(--edge); background: linear-gradient(180deg, rgba(246, 234, 208, 0.96), rgba(221, 198, 144, 0.96)); color: var(--ink); font: inherit; font-size: 12px; font-weight: 700; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.5); }
.mu-bt-op:hover { border-color: var(--gold-hi); background: linear-gradient(180deg, #fbefc4, #ecc95c); }
.mu-bt-op .k { position: absolute; left: -5px; top: -7px; min-width: 17px; height: 17px; padding: 0 3px; font-size: 10.5px; line-height: 17px; text-align: center; border-radius: 4px; background: #2a1b0f; color: #f6ead0; border: 1px solid #8c6b36; font-weight: 600; }
.mu-bt-storm { position: absolute; left: 50%; top: 82px; transform: translateX(-50%); padding: 6px 12px; border-radius: 6px; pointer-events: none; display: flex; gap: 12px; align-items: center;
  background: rgba(26, 17, 9, 0.82); border: 1px solid #8c6b36; color: #f6ead0; font-size: 12.5px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); }
.mu-bt-storm.mu-hide { display: none; }
.mu-bt-storm b { color: var(--gold-hi); }
.mu-bt-storm .gate { display: flex; align-items: center; gap: 6px; }
.mu-bt-storm .gbar { width: 70px; height: 7px; border-radius: 4px; background: rgba(246, 234, 208, 0.25); overflow: hidden; }
.mu-bt-storm .gbar i { display: block; height: 100%; background: #b0541c; }
.mu-bt-storm .gbar.broken i { background: #6a3b1c; }
`;

let styled = false;
export function ensureBattleStyle(): void {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.id = 'mu-battle-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

// ---------------------------------------------------------------------------------------------
// Banners over the groups (shared with the tactical view)
// ---------------------------------------------------------------------------------------------

export class BannerLayer {
  readonly el = h('div.mu-bt-banners');
  private readonly items = new Map<string, HTMLElement>();
  constructor(private readonly ctx: HudPartCtx, private readonly draggable = false) {}

  /** The world's own height (the zone's navigation knows the ground only where it has loaded it). The game is looked up each time: the HUD is built before a run exists. */
  private groundY(x: number, z: number): number { return this.ctx.game()?.sim.world.heightAt(x, z) ?? 0; }

  /** Puts a banner over each group at its place on the screen; hides those behind the camera or off it. */
  update(own: readonly BattleGroupView[], enemy: readonly BattleGroupView[], selected: GroupKey | null): void {
    const r = this.ctx.host.renderer();
    const seen = new Set<string>();
    const scale = Math.max(0.5, this.ctx.scale());
    const placed: Array<{ el: HTMLElement; x: number; y: number; lift: number }> = [];
    const put = (g: BattleGroupView, side: 'own' | 'enemy'): void => {
      if (g.count === 0 || (side === 'own' && g.key === 'all')) return;
      const id = `${side}:${g.key}`;
      seen.add(id);
      let el = this.items.get(id);
      const hot = g.engaged;
      if (!el) {
        el = h('div.mu-bt-banner', { class: `${side}${this.draggable && side === 'own' ? ' drag' : ''}` });
        el.dataset.key = g.key;
        this.items.set(id, el);
        this.el.append(el);
      }
      const text = `${g.label} ${g.count}`;
      const word = orderWord(g.order);
      if (el.dataset.text !== `${text}|${word}|${hot}`) {
        el.dataset.text = `${text}|${word}|${hot}`;
        el.replaceChildren(
          h('div.flag', null, icon(GROUP_ICON[g.key], 13), h('span', null, text), h('span.ord', null, word)),
          h('div.pole'),
        );
      }
      el.classList.toggle('sel', side === 'own' && (selected === g.key || selected === 'all'));
      el.classList.toggle('hot', hot);
      // just over the heads of the group: a banner higher than the camera would be thrown off the top of the screen from behind a man's shoulder
      const y = this.groundY(g.x, g.z) + 2.1;
      const p = r?.project(g.x, y, g.z) ?? null;
      if (!p || p.x < -80 || p.y < -80 || p.x > window.innerWidth + 80 || p.y > window.innerHeight + 80) {
        el.style.display = 'none';
      } else {
        el.style.display = '';
        placed.push({ el, x: Math.round(p.x / scale), y: Math.round(p.y / scale), lift: 0 });
      }
    };
    for (const g of own) put(g, 'own');
    for (const g of enemy) put(g, 'enemy');
    // the groups of a side start with their men in one place: banners over the same spot rise one above another, on a longer pole
    placed.sort((a, b) => b.y - a.y || a.x - b.x);
    for (let i = 1; i < placed.length; i++) {
      const a = placed[i];
      for (let tries = 0; tries < 8 && placed.slice(0, i).some((b) => Math.abs(a.x - b.x) < 100 && Math.abs((a.y - a.lift) - (b.y - b.lift)) < 24); tries++) a.lift += 24;
    }
    for (const a of placed) {
      a.el.style.left = `${a.x}px`;
      a.el.style.top = `${a.y}px`;
      a.el.style.setProperty('--lift', `${a.lift}px`);
    }
    for (const [id, el] of this.items) if (!seen.has(id)) { el.remove(); this.items.delete(id); }
  }

  /** The banner element of an own group (the tactical view drags it). */
  bannerOf(key: GroupKey): HTMLElement | undefined { return this.items.get(`own:${key}`); }

  clear(): void { for (const el of this.items.values()) el.remove(); this.items.clear(); }
}

// ---------------------------------------------------------------------------------------------
// The group bar (shared with the tactical view)
// ---------------------------------------------------------------------------------------------

export class GroupBar {
  readonly el = h('div.mu-bt-bar');
  private readonly buttons = new Map<GroupKey, HTMLButtonElement>();

  constructor(private readonly onPick: (key: GroupKey) => void) {
    for (const key of SLOTS) {
      const b = h<HTMLButtonElement>('button.mu-bt-g.off', { type: 'button', 'aria-label': key });
      b.addEventListener('click', () => this.onPick(key));
      this.buttons.set(key, b);
      this.el.append(b);
    }
  }

  paint(own: readonly BattleGroupView[], selected: GroupKey | null): void {
    for (const key of SLOTS) {
      const b = this.buttons.get(key)!;
      const g = own.find((x) => x.key === key);
      const has = !!g && g.count > 0;
      b.className = `mu-bt-g${has ? '' : ' off'}${selected === key ? ' sel' : ''}${g?.engaged ? ' hot' : ''}`;
      b.disabled = !has;
      if (!g || !has) {
        b.title = '';
        b.replaceChildren(h('span.cap', null, keycapOf(key)), h('div.top', null, icon(GROUP_ICON[key], 15), h('span', null, key === 'all' ? 'All' : key[0].toUpperCase() + key.slice(1))));
        continue;
      }
      b.title = groupLine(g);
      b.replaceChildren(
        h('span.cap', null, keycapOf(key)),
        h('div.top', null, icon(GROUP_ICON[key], 15), h('span', null, g.label), h('span.n', null, String(g.count))),
        h('div.ord', null, orderWord(g.order)),
        h('div.mor', { class: moraleTone(g.morale) }, h('i', { style: { transform: `scaleX(${Math.max(0.04, g.morale).toFixed(2)})` } })),
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The HUD part
// ---------------------------------------------------------------------------------------------

let current: BattleHud | null = null;

export class BattleHud implements HudPart {
  readonly el = h('div.mu-bt.mu-hide');
  private readonly bar: GroupBar;
  private readonly hint = h('div.mu-bt-hint');
  private readonly wheel = h('div.mu-bt-wheel.mu-hide');
  private readonly storm = h('div.mu-bt-storm.mu-hide');
  private readonly banners: BannerLayer;
  private view: BattleView = { own: NONE, enemy: NONE, storm: null };
  private sig = '';
  private nextRead = 0;
  private shown = false;
  wheelOpen = false;

  constructor(private readonly ctx: HudPartCtx) {
    ensureBattleStyle();
    this.banners = new BannerLayer(ctx);
    this.bar = new GroupBar((key) => this.pick(key));
    this.buildWheel();
    this.hint.append(
      h('span', null, h('b', null, '4'), '–', h('b', null, '7'), ' choose a group  ·  ', h('b', null, '8'), ' order wheel  ·  ', h('b', null, 'C'), ' tactical view'),
    );
    this.el.append(this.banners.el, this.storm, this.bar.el, this.hint, this.wheel);
    current = this;
  }

  dispose(): void { if (current === this) current = null; }

  /** Is there a battle in which the player commands men? */
  inBattle(): boolean { return this.view.own.length > 0; }
  get groups(): BattleView { return this.view; }

  update(now: number): void {
    if (now >= this.nextRead) {
      this.nextRead = now + 0.12;
      this.view = readBattle(this.ctx);
      const sig = groupsSignature(this.view.own, this.view.enemy) + `|${battleBus.selected}|${battleBus.tactical}|${this.wheelOpen}`;
      if (sig !== this.sig) { this.sig = sig; this.paint(); }
      this.paintStorm();
    }
    const active = (this.view.own.length > 0 || this.view.enemy.length > 0 || !!this.view.storm) && !battleBus.tactical;
    if (active !== this.shown) { this.shown = active; this.el.classList.toggle('mu-hide', !active); if (!active) this.closeWheel(); }
    if (!active) return;
    this.banners.update(this.view.own, this.view.enemy, battleBus.selected);
  }

  private paint(): void {
    const own = this.view.own;
    // drop a selection whose group is gone
    if (battleBus.selected && !own.some((g) => g.key === battleBus.selected && g.count > 0)) battleBus.selected = null;
    this.bar.paint(own, battleBus.selected);
  }

  private paintStorm(): void {
    const s = this.view.storm;
    if (!s) { this.storm.classList.add('mu-hide'); return; }
    this.storm.classList.remove('mu-hide');
    const gate = s.gate === 'broken' ? 'The gate is broken' : s.gate === 'open' ? 'The gate is open' : s.gate === 'none' ? 'No gate' : 'The gate holds';
    const bits: Array<string | HTMLElement> = [
      h('span.gate', null, icon('door', 14), h('b', null, gate), h('span.gbar', { class: s.gate === 'broken' ? 'broken' : '' }, h('i', { style: { width: `${Math.round(s.gateIntegrity * 100)}%` } }))),
    ];
    if (s.rams) bits.push(h('span', null, h('b', null, String(s.rams)), s.rams === 1 ? ' ram' : ' rams'));
    if (s.ladders) bits.push(h('span', null, h('b', null, String(s.ladders)), s.ladders === 1 ? ' ladder up' : ' ladders up'));
    if (s.engines) bits.push(h('span', null, h('b', null, String(s.engines)), s.engines === 1 ? ' engine' : ' engines'));
    if (s.onWalls) bits.push(h('span', null, h('b', null, String(s.onWalls)), ' on the walls'));
    if (s.breaches) bits.push(h('span', null, h('b', null, String(s.breaches)), s.breaches === 1 ? ' breach' : ' breaches'));
    if (s.stationed) bits.push(h('span', null, h('b', null, String(s.stationed)), ' shooting from the walls'));
    this.storm.replaceChildren(...bits);
  }

  // ---- groups ----

  pick(key: GroupKey): boolean {
    const next = selectionAfter(battleBus.selected, key, this.view.own);
    if (next === battleBus.selected && battleBus.selected !== key) return false;
    battleBus.selected = next;
    this.sig = '';
    this.paint();
    return true;
  }

  // ---- the order wheel ----

  private buildWheel(): void {
    const n = ORDER_CHOICES.length;
    this.wheel.append(h('div.ring'), h('div.title', null, h('b', null, 'Orders'), h('span', null, 'press 1–9 · Esc closes')));
    ORDER_CHOICES.forEach((o, i) => {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const b = h<HTMLButtonElement>('button.mu-bt-op', { type: 'button', title: o.hint }, h('span.k', null, String(o.n)), icon(o.icon as IconName, 15), h('span', null, o.label));
      b.style.left = `${Math.round(Math.cos(a) * 118)}px`;
      b.style.top = `${Math.round(Math.sin(a) * 104)}px`;
      b.addEventListener('click', () => this.give(o));
      this.wheel.append(b);
    });
  }

  openWheel(): void {
    if (!this.inBattle()) return;
    this.wheelOpen = true;
    this.wheel.classList.remove('mu-hide');
    this.sig = '';
  }
  closeWheel(): void {
    if (!this.wheelOpen && this.wheel.classList.contains('mu-hide')) return;
    this.wheelOpen = false;
    this.wheel.classList.add('mu-hide');
    this.sig = '';
  }
  toggleWheel(): void { if (this.wheelOpen) this.closeWheel(); else this.openWheel(); }

  give(o: OrderChoice): void {
    giveOrder(this.ctx, o.order({ ahead: lookPoint(this.ctx), target: sightedEnemy(this.ctx) }), o.label);
    this.closeWheel();
  }
}

// ---------------------------------------------------------------------------------------------
// Registration (at import)
// ---------------------------------------------------------------------------------------------

registerHudPart('battle', (ctx) => new BattleHud(ctx));

for (const code of Object.keys(SELECT_KEYS)) {
  registerHotkey(code, () => {
    const hud = current;
    if (!hud || !hud.inBattle()) return false;
    if (hud.wheelOpen) { const k = orderByDigit(Number(code.replace('Digit', ''))); if (k) { hud.give(k); return true; } }
    hud.pick(SELECT_KEYS[code]);
    return true;
  });
}
registerHotkey(WHEEL_KEY, () => {
  const hud = current;
  if (!hud || !hud.inBattle()) return false;
  if (hud.wheelOpen) { const k = orderByDigit(8); if (k) hud.give(k); return true; }
  hud.openWheel();
  return true;
});
for (const n of [1, 2, 3, 9]) {
  registerHotkey(`Digit${n}`, () => {
    const hud = current;
    if (!hud || !hud.wheelOpen) return false;
    const k = orderByDigit(n);
    if (k) hud.give(k);
    return true;
  });
}
registerHotkey(KEYMAP.ui.menu, () => {
  const hud = current;
  if (!hud || !hud.wheelOpen) return false;
  hud.closeWheel();
  return true;
});
registerHotkey(KEYMAP.battle.tactical, (_code, _e, ctx) => {
  if (battleBus.closeTactical) { battleBus.closeTactical(); return true; }
  const hud = current;
  if (!hud || !hud.inBattle()) return false; // outside a battle (or commanding no one) C is the command panel, as before
  ctx.open({ panel: 'ext', name: 'battle' });
  return true;
});

