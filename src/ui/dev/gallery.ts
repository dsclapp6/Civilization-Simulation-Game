// UI gallery (?mode=ui): every screen and panel with mock services, a sidebar to open them, and URL
// parameters for screenshots:  ?mode=ui&panel=trade  &still=1 (freeze motion)  &chrome=0 (no sidebar)
// &bg=village|night|dusk|winter|forest|map  &time=0.58  &season=1  &scale=1.2
// Exposes window.__ui for tools/ui-shots.mjs.
import type { AppRoot } from '../../main';
import type { Difficulty } from '../../core/domain';
import type { PersonId } from '../../sim/state';
import { gainSkill } from '../../sim/skills';
import { killPerson } from '../../sim/succession';
import type { Simulation } from '../../sim/sim';
import { createUI } from '../index';
import type { PanelRequest } from '../core/requests';
import type { GameUIExt } from '../types';
import { MockHost, galleryWorld, type MockGame } from './mockHost';
import { MockPlayer } from './mockPlayer';
import { ICON_NAMES, icon } from '../core/icons';

type Bg = 'village' | 'night' | 'dusk' | 'winter' | 'forest' | 'map' | 'dawn' | 'rain';

const BG_FILES: Record<Bg, string> = {
  village: 'village.png', night: 'night.png', dusk: 'dusk.png', winter: 'winter.png', forest: 'forest.png', map: 'map.png', dawn: 'dawn.png', rain: 'rain.png',
};

interface EnterOptions { bg?: Bg; time?: number; season?: number; day?: number; fresh?: boolean; target?: 'strip' | 'person' | 'building' | 'none'; difficulty?: Difficulty }

interface Ctx {
  ui: GameUIExt;
  host: MockHost;
  enter(o?: EnterOptions): Promise<MockGame>;
  open(req: PanelRequest, o?: EnterOptions): Promise<MockGame>;
  frames(n?: number): Promise<void>;
  click(selector: string, times?: number, index?: number): void;
  setBg(bg: Bg): void;
}

interface Entry { id: string; label: string; group: string; run(c: Ctx): void | Promise<void> }

const q = new URLSearchParams(location.search);
const STILL = q.has('still');

export async function start(root: AppRoot): Promise<void> {
  document.title = 'Millennia · UI gallery';
  const boot = document.getElementById('boot');
  if (boot) boot.textContent = 'Preparing the gallery…';
  await new Promise((r) => window.setTimeout(r, 30));
  galleryWorld();

  const host = new MockHost();
  const scaleParam = Number(q.get('scale'));
  if (scaleParam) host.setSettings({ uiScale: scaleParam });
  const viewport = root.viewport;
  const setBg = (bg: Bg): void => {
    viewport.style.cssText = `position:fixed;inset:0;background:#101820 url(/docs/render/${BG_FILES[bg]}) center / cover no-repeat;`;
    viewport.dataset.bg = bg;
  };
  setBg('village');
  const ui = createUI(root.ui, host) as GameUIExt;
  host.ui = ui;
  host.onCameraMode = (mode) => { if (mode === 'map') setBg('map'); else if (viewport.dataset.bg === 'map') setBg(currentBg); };
  let currentBg: Bg = 'village';

  const frames = (n = 2): Promise<void> => new Promise((resolve) => {
    let left = n;
    const step = (): void => { if (--left <= 0) resolve(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });

  const closeAll = (): void => { for (const id of [...ui.openPanels()].reverse()) ui.closePanel(id); };

  const setClock = (sim: Simulation, time: number, season: number, day: number): void => {
    const abs = 16 + season * 4 + (day - 1) + time;
    sim.state.clock.absDay = abs;
    sim.state.clock.firedHour = Math.floor(abs * 24);
  };

  const ctx: Ctx = {
    ui, host, frames, setBg: (bg) => { currentBg = bg; setBg(bg); },
    async enter(o = {}) {
      let mock = host.mock();
      if (!mock || o.fresh || mock.sim.state.run.phase !== 'alive') mock = await host.create(o.difficulty ?? 'knight', true);
      ui.setScreen('game');
      closeAll();
      const time = o.time ?? Number(q.get('time') ?? 0.58);
      const season = o.season ?? Number(q.get('season') ?? 0);
      setClock(mock.sim, time, season, o.day ?? 2);
      const p = mock.player;
      p.cancelAction();
      if (p instanceof MockPlayer) { // not with ?services=repo, which brings the repo's own player
        p.hpFraction = 0.82; p.staminaFraction = 0.68; p.danger = false;
        p.needs = { hunger: 0.62, rest: 0.78, warmth: 0.9, mood: 0.7 };
        p.targetKind = o.target ?? 'strip';
        p.clearJourney();
        p.encounterAt = 0;
        p.prompt = p.targetKind === 'person' ? { label: 'Talk', targetLabel: 'Hugh Hayward', enabled: true }
          : p.targetKind === 'building' ? { label: 'Go in', targetLabel: 'Parish church', enabled: true }
            : { label: 'Reap', targetLabel: 'strip of barley', enabled: true };
      }
      const night = time < 0.22 || time > 0.78;
      const bg = (q.get('bg') as Bg | null) ?? o.bg ?? (night ? 'night' : 'village');
      currentBg = bg === 'map' ? 'village' : bg;
      setBg(bg);
      ui.update(0.6); // let the HUD's slow refresh pick up the new date
      await frames(2);
      return mock;
    },
    async open(req, o) {
      const mock = await ctx.enter(o);
      ui.openPanel(req);
      await frames(3);
      return mock;
    },
    click(selector, times = 1, index = 0) {
      const els = document.querySelectorAll<HTMLElement>(selector);
      const el = els[index];
      if (el) for (let i = 0; i < times; i++) el.click();
    },
  };

  const me = (mock: MockGame): { id: PersonId; sim: Simulation } => ({ id: mock.sim.state.run.playerId, sim: mock.sim });

  const stepSim = (mock: MockGame, seconds: number): void => { for (let i = 0; i < Math.round(seconds * 20); i++) mock.sim.step(0.05); };

  /** Decorates the player so sheets and panels have something to show. */
  const richCharacter = (mock: MockGame): void => {
    const { id, sim } = me(mock);
    const p = sim.state.persons.get(id);
    if (!p) return;
    gainSkill(sim, p, 'farming', 1900);
    gainSkill(sim, p, 'husbandry', 700);
    gainSkill(sim, p, 'woodcutting', 380);
    gainSkill(sim, p, 'archery', 260);
    gainSkill(sim, p, 'brewing', 120);
    gainSkill(sim, p, 'persuasion', 60);
    for (const t of ['quick_learner', 'pious', 'brave'] as const) if (!p.traits.includes(t)) p.traits.push(t);
    p.rep = { honour: 14, generosity: 6, piety: 22, cruelty: -4, valour: 3 };
    p.prestige = 38;
    p.health.conditions.length = 0;
    p.health.conditions.push({ id: 'fever', since: sim.absDay - 1, until: sim.absDay + 2.5, severity: 0.4 });
    sim.state.touch(p);
  };

  const logLife = (mock: MockGame): void => {
    const { id, sim } = me(mock);
    const p = sim.state.persons.get(id);
    const day = sim.absDay;
    const chron = (d: number, kind: string, text: string, persons: PersonId[]): void => sim.state.log(day - d, kind, text, persons);
    const hh = p ? sim.state.households.get(p.household) : undefined;
    const kin = hh ? hh.members.filter((m) => m !== id).slice(0, 3) : [];
    chron(14, 'marriage', `${kin[0] ? sim.state.persons.get(kin[0])?.first : 'Wat'} Thatcher married Alice Hayward.`, kin.slice(0, 1));
    chron(11, 'birth', `${p ? p.first : 'Hugh'} was baptised in the parish church.`, [id]);
    chron(9, 'death', 'Old Walter Reeve died aged 71 (old age).', []);
    chron(6, 'birth', 'A daughter was born to your neighbours.', kin.slice(0, 1));
    chron(4, 'inheritance', 'Sir Reginald inherited the manor from his father.', []);
    chron(2, 'death', `${kin[1] ? sim.state.persons.get(kin[1])?.first : 'Maud'} died in childbirth.`, kin.slice(1, 2));
    chron(1, 'marriage', 'The miller’s son was wed at the church door.', []);
  };

  // ---------------------------------------------------------------- entries

  const entries: Entry[] = [
    // screens
    { id: 'menu', label: 'Main menu', group: 'Screens', run: async (c) => { await c.host.quitToMenu(); c.ui.showMenu('main'); await c.frames(); } },
    { id: 'difficulty', label: 'Difficulty', group: 'Screens', run: async (c) => { await c.host.quitToMenu(); c.ui.showMenu('difficulty'); await c.frames(); } },
    { id: 'records', label: 'Records', group: 'Screens', run: async (c) => { await c.host.quitToMenu(); c.ui.showMenu('records'); await c.frames(); } },
    { id: 'menu-settings', label: 'Settings (menu)', group: 'Screens', run: async (c) => { await c.host.quitToMenu(); c.ui.showMenu('settings'); await c.frames(); } },
    { id: 'loading', label: 'Loading', group: 'Screens', run: async (c) => { await c.host.quitToMenu(); c.ui.setScreen('loading', { progress: 0.62, label: 'Settling villages and towns…' }); await c.frames(); } },
    // game
    {
      id: 'hud', label: 'HUD', group: 'Game', run: async (c) => {
        const mock = await c.enter();
        const sim = mock.sim;
        sim.events.emit('notify', { kind: 'info', text: 'The barley is nearly ripe on the east strip.' });
        sim.events.emit('notify', { kind: 'gain', text: 'You reap a quarter of the strip.' });
        sim.events.emit('notify', { kind: 'gain', text: 'You reap a quarter of the strip.' });
        sim.events.emit('notify', { kind: 'warn', text: 'The reeve is looking for you.' });
        sim.events.emit('notify', { kind: 'social', text: 'Agnes thinks better of you (+4) — a kind word' });
        sim.events.emit('points', { kind: 'deed', amount: 25, reason: 'Your first harvest', total: 25 });
        const p = sim.state.persons.get(sim.state.run.playerId);
        if (p) gainSkill(sim, p, 'farming', 640);
        const opts = mock.player.options();
        if (opts[0]) mock.player.perform(opts[0]);
        stepSim(mock, 3.4);
        await c.frames(3);
      },
    },
    {
      id: 'hud-night', label: 'HUD (night, holy day)', group: 'Game', run: async (c) => {
        const mock = await c.enter({ time: 0.9, day: 4, season: 3, bg: 'night', target: 'building' });
        mock.sim.events.emit('notify', { kind: 'info', text: 'The church bell rings for compline.' });
        mock.player.needs = { hunger: 0.5, rest: 0.34, warmth: 0.42, mood: 0.66 };
        await c.frames(3);
      },
    },
    {
      id: 'hud-alert', label: 'HUD (hurt, hungry, danger)', group: 'Game', run: async (c) => {
        const mock = await c.enter({ time: 0.42, target: 'person' });
        const p = mock.player;
        p.hpFraction = 0.2; p.staminaFraction = 0.25; p.danger = true;
        p.needs = { hunger: 0.1, rest: 0.3, warmth: 0.55, mood: 0.3 };
        p.prompt = { label: 'Talk', targetLabel: 'Wolf-hunter', enabled: false, reason: 'They are busy fighting' };
        mock.sim.events.emit('notify', { kind: 'danger', text: 'Wolves! They are closing on you.' });
        mock.sim.events.emit('notify', { kind: 'warn', text: 'You are starving.' });
        mock.sim.dispatch({ type: 'setSpeed', speed: 3 });
        await c.frames(3);
      },
    },
    {
      id: 'hud-travel', label: 'HUD (travelling)', group: 'Game', run: async (c) => {
        const mock = await c.enter({ bg: 'map', target: 'none' });
        c.host.renderer()?.setCameraMode('map');
        mock.player.startJourney?.(4, 0.42);
        mock.sim.events.emit('travel', { phase: 'start', to: 4 });
        await c.frames(3);
      },
    },
    {
      id: 'tracker', label: 'HUD: tracker, compass, minimap', group: 'Clarity', run: async (c) => {
        const mock = await c.enter({ time: 0.36 });
        mock.objectives.advance();
        mock.sim.events.emit('objective', { phase: 'progress', id: 1, title: 'Your first day' });
        await c.frames(4);
      },
    },
    {
      id: 'whatnow', label: 'What now? card', group: 'Clarity', run: async (c) => {
        await c.enter({ time: 0.7 });
        c.ui.toggleWhatNow?.();
        await c.frames(4);
      },
    },
    { id: 'journal-tasks', label: 'Journal: tasks', group: 'Clarity', run: async (c) => { await c.open({ panel: 'journal', tab: 'objectives' }); } },
    { id: 'journal-today', label: 'Journal: today', group: 'Clarity', run: async (c) => { await c.open({ panel: 'journal', tab: 'today' }); } },
    { id: 'journal-people', label: 'Journal: people', group: 'Clarity', run: async (c) => { await c.open({ panel: 'journal', tab: 'people' }); } },
    { id: 'journal-places', label: 'Journal: places', group: 'Clarity', run: async (c) => { await c.open({ panel: 'journal', tab: 'places' }); } },
    {
      id: 'daysummary', label: 'Day summary', group: 'Clarity', run: async (c) => {
        const mock = await c.enter({ time: 0.3 });
        mock.objectives.endDay();
        c.ui.openPanel({ panel: 'daysummary' });
        await c.frames(4);
      },
    },
    { id: 'intro', label: 'Intro card', group: 'Clarity', run: async (c) => { await c.open({ panel: 'intro' }, { time: 0.3 }); } },
    { id: 'banner', label: 'Settlement banner', group: 'Clarity', run: async (c) => { await c.enter({ time: 0.4 }); c.ui.showBanner?.(); await c.frames(8); } },
    {
      id: 'sleep', label: 'Sleeping', group: 'Game', run: async (c) => {
        const mock = await c.enter({ time: 0.92 });
        mock.sim.dispatch({ type: 'sleep' });
        mock.sim.step(0.1);
        await c.frames(3);
      },
    },
    { id: 'birth', label: 'Birth reveal', group: 'Game', run: async (c) => { await c.enter({ fresh: true }); c.ui.showBirth(); await c.frames(3); } },
    { id: 'pause', label: 'Pause menu', group: 'Game', run: async (c) => { await c.open({ panel: 'pause' }); } },
    { id: 'help', label: 'Help and controls', group: 'Game', run: async (c) => { await c.open({ panel: 'help' }); } },
    { id: 'help-combat', label: 'Help: fighting', group: 'Game', run: async (c) => { await c.open({ panel: 'help', tab: 'combat' }); } },
    { id: 'settings', label: 'Settings (in game)', group: 'Game', run: async (c) => { await c.open({ panel: 'settings' }); } },
    {
      id: 'confirm', label: 'Confirm (abandon)', group: 'Game', run: async (c) => {
        await c.open({ panel: 'pause' });
        c.click('.mu-btn.danger');
        await c.frames(3);
      },
    },
    {
      id: 'death', label: 'Death & succession', group: 'Game', run: async (c) => {
        const mock = await c.enter({ fresh: true, bg: 'night', time: 0.3 });
        const sim = mock.sim;
        const p = sim.state.persons.get(sim.state.run.playerId);
        const hh = p ? sim.state.households.get(p.household) : undefined;
        if (hh && hh.head !== sim.state.run.playerId) sim.dispatch({ type: 'switchCharacter', personId: hh.head });
        logLife(mock);
        sim.state.run.maxTier = 3;
        sim.score.award('deed', 480, 'Gallery deeds');
        const who = sim.state.persons.get(sim.state.run.playerId);
        if (who) killPerson(sim, who, 'plague', sim.absDay);
        await c.frames(4);
      },
    },
    {
      id: 'death-extinct', label: 'Death (last of the House)', group: 'Game', run: async (c) => {
        const mock = await c.enter({ fresh: true, bg: 'night', time: 0.3 });
        const sim = mock.sim;
        const player = sim.state.persons.get(sim.state.run.playerId);
        if (!player) return;
        // everyone who could carry on dies first; then the player
        for (let round = 0; round < 8; round++) {
          const targets = sim.eligibleSwitchTargets();
          if (!targets.length) break;
          for (const id of targets) { const p = sim.state.persons.get(id); if (p && !p.death) killPerson(sim, p, 'plague', sim.absDay); }
        }
        sim.score.award('deed', 150, 'Gallery deeds');
        killPerson(sim, player, 'plague', sim.absDay);
        await c.frames(4);
      },
    },
    {
      id: 'gameover', label: 'Game over', group: 'Game', run: async (c) => {
        const mock = await c.enter({ fresh: true, bg: 'night', time: 0.2 });
        mock.sim.score.award('rank', 900, 'Gallery rank');
        mock.sim.score.award('deed', 2650, 'Gallery deeds');
        mock.sim.state.score.continentPct = 1.8;
        mock.sim.dispatch({ type: 'abandonRun' });
        await c.frames(4);
      },
    },
    // panels
    { id: 'actions', label: 'Action wheel', group: 'Panels', run: async (c) => { await c.open({ panel: 'actions' }); } },
    { id: 'actions-person', label: 'Action wheel (person)', group: 'Panels', run: async (c) => { await c.open({ panel: 'actions' }, { target: 'person' }); } },
    { id: 'character', label: 'Character sheet', group: 'Panels', run: async (c) => { const mock = await c.enter(); richCharacter(mock); c.ui.openPanel({ panel: 'character' }); await c.frames(3); } },
    {
      id: 'inventory', label: 'Inventory', group: 'Panels', run: async (c) => {
        const mock = await c.open({ panel: 'inventory' });
        await c.frames(2);
        c.click('.mu-inv-item', 1, 2);
        await c.frames(2);
      },
    },
    {
      id: 'dialogue', label: 'Dialogue', group: 'Panels', run: async (c) => {
        const mock = await c.enter({ target: 'person' });
        const sim = mock.sim;
        const p = sim.state.persons.get(sim.state.run.playerId);
        const other = p ? sim.state.households.get(p.household)?.head ?? 0 : 0;
        const r = mock.social.start(sim.state.run.playerId, other);
        if ('lines' in r) {
          mock.social.choose(r.id, 'news');
          mock.social.choose(r.id, 'flatter');
          c.ui.openPanel({ panel: 'dialogue', conversation: r.id });
        }
        await c.frames(4);
      },
    },
    {
      id: 'trade', label: 'Trade', group: 'Panels', run: async (c) => {
        const mock = await c.enter();
        const p = mock.sim.state.persons.get(mock.sim.state.run.playerId);
        c.ui.openPanel({ panel: 'trade', partner: { kind: 'market', settlement: p?.settlement ?? 0 } });
        await c.frames(3);
        c.click('.mu-trade-buy .mu-qty-plus', 3, 5);
        c.click('.mu-trade-buy .mu-qty-plus', 1, 6);
        c.click('.mu-trade-sell .mu-qty-plus', 2, 1);
        await c.frames(3);
      },
    },
    { id: 'career', label: 'Career paths', group: 'Panels', run: async (c) => { const mock = await c.enter(); c.ui.openPanel({ panel: 'career', person: mock.sim.state.run.playerId }); await c.frames(3); } },
    { id: 'jobs', label: 'Jobs board', group: 'Panels', run: async (c) => { const mock = await c.enter(); c.ui.openPanel({ panel: 'jobs', settlement: mock.sim.state.persons.get(mock.sim.state.run.playerId)?.settlement ?? 0 }); await c.frames(3); } },
    { id: 'family', label: 'Family tree', group: 'Panels', run: async (c) => { await c.open({ panel: 'family', tab: 'tree' }); } },
    { id: 'household', label: 'Household', group: 'Panels', run: async (c) => { await c.open({ panel: 'family', tab: 'household' }); } },
    { id: 'house', label: 'House', group: 'Panels', run: async (c) => { await c.open({ panel: 'family', tab: 'house' }); } },
    { id: 'ledger', label: 'Ledger: holdings', group: 'Panels', run: async (c) => { await c.open({ panel: 'ledger', tab: 'holdings' }); } },
    { id: 'ledger-household', label: 'Ledger: household', group: 'Panels', run: async (c) => { await c.open({ panel: 'ledger', tab: 'household' }); } },
    { id: 'ledger-obligations', label: 'Ledger: obligations', group: 'Panels', run: async (c) => { await c.open({ panel: 'ledger', tab: 'obligations' }); } },
    { id: 'ledger-property', label: 'Ledger: property', group: 'Panels', run: async (c) => { await c.open({ panel: 'ledger', tab: 'property' }); } },
    { id: 'ledger-accounts', label: 'Ledger: accounts', group: 'Panels', run: async (c) => { await c.open({ panel: 'ledger', tab: 'ledger' }); } },
    { id: 'ledger-authority', label: 'Ledger: authority', group: 'Panels', run: async (c) => { await c.open({ panel: 'ledger', tab: 'authority' }); } },
    {
      id: 'map', label: 'Map', group: 'Panels', run: async (c) => {
        const mock = await c.enter({ bg: 'map', target: 'none' });
        c.ui.openPanel({ panel: 'map' });
        await c.frames(3);
        c.click('.mu-map-row', 1, 1);
        await c.frames(3);
      },
    },
    {
      id: 'encounter', label: 'Encounter', group: 'Panels', run: async (c) => {
        const mock = await c.enter({ bg: 'forest', target: 'none' });
        mock.player.startJourney?.(4, 0.5, 'encounter', { kind: 'bandits', label: 'A band of outlaws blocks the road', hostile: true });
        await c.frames(4);
      },
    },
    { id: 'chronicle', label: 'Chronicle', group: 'Panels', run: async (c) => { const mock = await c.enter(); logLife(mock); c.ui.openPanel({ panel: 'chronicle' }); await c.frames(3); } },
    { id: 'rest', label: 'Rest', group: 'Panels', run: async (c) => { await c.open({ panel: 'rest' }, { time: 0.62, bg: 'dusk' }); } },
    {
      id: 'perk', label: 'Perk choice', group: 'Panels', run: async (c) => {
        const mock = await c.enter();
        richCharacter(mock);
        c.ui.openPanel({ panel: 'perk', person: mock.sim.state.run.playerId, skill: 'farming' });
        await c.frames(3);
      },
    },
    { id: 'building', label: 'Building info', group: 'Panels', run: async (c) => { const mock = await c.enter(); const hh = mock.sim.state.households.get(mock.sim.state.persons.get(mock.sim.state.run.playerId)?.household ?? 0); c.ui.openPanel({ panel: 'building', id: hh?.home ?? 0 }); await c.frames(3); } },
    { id: 'person', label: 'Person info', group: 'Panels', run: async (c) => { const mock = await c.enter(); const p = mock.sim.state.persons.get(mock.sim.state.run.playerId); c.ui.openPanel({ panel: 'person', id: p?.father || p?.mother || 0 }); await c.frames(3); } },
    { id: 'message', label: 'Message', group: 'Panels', run: async (c) => { await c.open({ panel: 'message', title: 'A Letter from the Steward', text: 'By the lord’s command, all tenants of the manor are to attend the harvest boon-work at first light on the morrow, bringing their own sickles.\n\nThose who fail to attend shall answer to the reeve, and pay a fine of fourpence for each day missed.' }); } },
    {
      id: 'icons', label: 'Icon sheet', group: 'Dev', run: async (c) => {
        await c.host.quitToMenu();
        const sheet = document.createElement('div');
        sheet.id = 'icon-sheet';
        sheet.style.cssText = 'position:fixed;inset:0;overflow:auto;background:#efe0b8;color:#2a1b0f;padding:20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px;z-index:50;font:12px sans-serif';
        for (const name of ICON_NAMES) {
          const cell = document.createElement('div');
          cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px;border:1px solid #b99a5e;border-radius:4px;background:#f6ead0';
          cell.append(icon(name, 40), document.createTextNode(name));
          sheet.appendChild(cell);
        }
        document.body.appendChild(sheet);
        await c.frames(2);
      },
    },
  ];

  // ---------------------------------------------------------------- sidebar and driver

  const byId = new Map(entries.map((e) => [e.id, e]));
  let running = Promise.resolve();
  const run = (id: string): Promise<void> => {
    running = running.then(async () => {
      document.getElementById('icon-sheet')?.remove();
      const e = byId.get(id);
      if (!e) throw new Error(`unknown gallery entry ${id}`);
      document.documentElement.dataset.shot = '';
      await e.run(ctx);
      await ctx.frames(2);
      document.documentElement.dataset.shot = id;
    });
    return running;
  };

  const gallery = window as unknown as { __ui: unknown };
  /** Timing of the UI's own JavaScript: the HUD per frame, and what opening each panel costs. */
  const bench = async (): Promise<unknown> => {
    await run('hud');
    const stat = (xs: number[]): { mean: number; p95: number; max: number } => {
      const s = [...xs].sort((a, b) => a - b);
      return { mean: xs.reduce((n, x) => n + x, 0) / xs.length, p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
    };
    const frame: number[] = [];
    for (let i = 0; i < 600; i++) { const t0 = performance.now(); ui.update(1 / 60); frame.push(performance.now() - t0); }
    const mock = host.mock()!;
    const pid = mock.sim.state.run.playerId;
    const settlement = mock.sim.state.persons.get(pid)?.settlement ?? 0;
    const panels: Record<string, { open: number; update: number }> = {};
    const reqs: Array<[string, PanelRequest]> = [
      ['character', { panel: 'character' }], ['inventory', { panel: 'inventory' }], ['family', { panel: 'family', tab: 'tree' }],
      ['ledger', { panel: 'ledger', tab: 'holdings' }], ['chronicle', { panel: 'chronicle' }], ['career', { panel: 'career', person: pid }],
      ['trade', { panel: 'trade', partner: { kind: 'market', settlement } }], ['map', { panel: 'map' }], ['rest', { panel: 'rest' }],
      ['actions', { panel: 'actions' }], ['birth', { panel: 'birth' }],
    ];
    for (const [name, req] of reqs) {
      const t0 = performance.now();
      ui.openPanel(req);
      const t1 = performance.now();
      ui.update(0.6);
      const t2 = performance.now();
      panels[name] = { open: Math.round((t1 - t0) * 100) / 100, update: Math.round((t2 - t1) * 100) / 100 };
      closeAll();
    }
    return { frameMs: stat(frame), panels };
  };

  gallery.__ui = { entries: entries.map((e) => e.id), run, ui, host, ctx, bench, ready: true };

  if (q.get('chrome') !== '0') buildSidebar(entries, run);

  // frame loop: the sim ticks (so the clock, actions and journeys move) unless still
  let last = performance.now();
  const loop = (): void => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const mock = host.mock();
    if (mock && !STILL) { mock.sim.step(dt); mock.player.update?.(dt); }
    ui.update(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  // a few of the input layer's keys, so the gallery can be played with
  window.addEventListener('keydown', (e) => {
    const mock = host.mock();
    if (!mock || ui.capturesInput() || e.repeat) return;
    if (e.code === 'KeyE') { const o = mock.player.options().find((x) => x.enabled); if (o) mock.player.perform(o); }
    if (e.code === 'KeyP') mock.sim.dispatch({ type: 'togglePause' });
    if (e.code === 'Digit1') mock.sim.dispatch({ type: 'setSpeed', speed: 1 });
    if (e.code === 'Digit2') mock.sim.dispatch({ type: 'setSpeed', speed: 3 });
    if (e.code === 'Digit3') mock.sim.dispatch({ type: 'setSpeed', speed: 8 });
  });
  // the app forwards `ui` events to the UI; the gallery does the same
  const forward = (m: MockGame): void => { m.sim.events.on('ui', (req) => ui.open(req)); };
  const origCreate = host.create.bind(host);
  host.create = async (...args) => { const m = await origCreate(...args); forward(m); return m; };

  root.ready();

  const panel = q.get('panel');
  if (panel && byId.has(panel)) await run(panel);
  else if (!panel) ui.setScreen('menu');
}

function buildSidebar(entries: Entry[], run: (id: string) => Promise<void>): void {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:0;top:0;bottom:0;width:178px;z-index:9999;background:rgba(18,12,6,.93);color:#e8d9b4;font:12px/1.3 Georgia,serif;overflow:auto;padding:8px 6px;border-right:1px solid #8a6a3a;transition:transform .15s';
  const toggle = document.createElement('button');
  toggle.textContent = '◂ gallery';
  toggle.style.cssText = 'position:fixed;left:178px;top:6px;z-index:9999;font:11px Georgia,serif;background:#2b1d10;color:#e8d9b4;border:1px solid #8a6a3a;border-radius:0 4px 4px 0;padding:3px 6px;cursor:pointer;transition:left .15s';
  let open = true;
  toggle.onclick = () => {
    open = !open;
    bar.style.transform = open ? '' : 'translateX(-178px)';
    toggle.style.left = open ? '178px' : '0';
    toggle.textContent = open ? '◂ gallery' : '▸ gallery';
  };
  let group = '';
  for (const e of entries) {
    if (e.group !== group) {
      group = e.group;
      const h = document.createElement('div');
      h.textContent = group;
      h.style.cssText = 'margin:10px 0 4px;color:#e0b840;letter-spacing:.1em;font-variant:small-caps;font-weight:bold';
      bar.appendChild(h);
    }
    const b = document.createElement('button');
    b.textContent = e.label;
    b.style.cssText = 'display:block;width:100%;text-align:left;margin:1px 0;padding:3px 6px;background:transparent;color:#e8d9b4;border:1px solid transparent;border-radius:3px;font:12px Georgia,serif;cursor:pointer';
    b.onmouseenter = () => { b.style.background = '#3a2a18'; };
    b.onmouseleave = () => { b.style.background = 'transparent'; };
    b.onclick = () => { void run(e.id); };
    bar.appendChild(b);
  }
  document.body.append(bar, toggle);
}
