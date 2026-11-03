// Ruler mode (U; docs/CIV.md §6): the seat of government. For anyone who rules something — the holder of a manor, town, abbey,
// barony, county or kingdom, a regent for a minor, a steward for the parts his office covers, a village's reeve — a full-screen
// page over the world with the eight pages of the design. Every figure and every order is a call of the realm module
// (docs/REALM.md "For wave B"): the AI's rulers use exactly the same calls. The world pauses while it is open (like the other
// full pages) unless the player unpauses.
import type { RealmView } from '../../sim/realm/types';
import type { PanelCtx, UiPanel } from '../app/panel';
import { button, empty, tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import { clear, h, isTypingTarget, replace } from '../core/dom';
import { icon } from '../core/icons';
import type { PanelRequest } from '../core/requests';
import { tabKeys } from '../core/tabkeys';
import { every, panelOf } from '../panels/base';
import { registerPanel } from '../panels/extRegistry';
import { ruleOffer } from './ruleTown';
import { isPage, PAGES, roleMay, roleWords, housesWords, type RulerPage } from './rulerModel';
import { money, type RulerEnv } from './rulerUi';
import { buildDiplomacy } from './pages/diplomacy';
import { buildFields } from './pages/fields';
import { buildLands } from './pages/lands';
import { buildMilitary } from './pages/military';
import { buildOverview } from './pages/overview';
import { buildResearch } from './pages/research';
import { buildRivals } from './pages/rivals';
import { buildTrade } from './pages/trade';
import '../builder/lands.css';
import './liegeBar';
import './newsToast';
import './ruler.css';

/** What opens the seat on a page: from the news toast (rivals), from a link (lands, research). */
export interface RulerOpen { page?: RulerPage; house?: number }

registerPanel('ruler', (ctx, req) => rulerPanel(ctx, req.data as RulerOpen | undefined));

const BUILDERS: Record<RulerPage, (env: RulerEnv) => HTMLElement> = {
  overview: buildOverview, lands: buildLands, fields: buildFields, research: buildResearch, military: buildMilitary, trade: buildTrade,
  diplomacy: buildDiplomacy, rivals: buildRivals,
};

/** The page last looked at stays the page the seat opens on (until the run ends). */
let lastPage: RulerPage = 'overview';

export function rulerPanel(ctx: PanelCtx, open?: RulerOpen): UiPanel {
  const realm = ctx.game.realm;
  if (!realm) return card(ctx, 'Seat of government', 'No one rules anything in this run: there is no realm to govern.');
  if (!realm.canRule(ctx.playerId())) return cannotRule(ctx);
  return new Seat(ctx, realm, open).panel();
}

// ---------------------------------------------------------------------------------------------

function card(ctx: PanelCtx, title: string, text: string): UiPanel {
  const win = createWindow({ title, icon: 'crown', size: 'sm', onClose: () => ctx.close() });
  win.body.append(empty(text));
  win.showFoot(h('div.mu-grow'), button('Close', { variant: 'primary', onClick: () => ctx.close() }));
  return panelOf({ id: 'ruler', group: 'ruler', pauses: 'never', backdropCloses: ctx }, win.el);
}

/** "You rule nothing": a card that says so, and offers the places nearby with someone to rule them. */
function cannotRule(ctx: PanelCtx): UiPanel {
  const sim = ctx.sim;
  const win = createWindow({ title: 'Seat of government', subtitle: 'You rule nothing yet', icon: 'crown', size: 'md', onClose: () => ctx.close() });
  const me = sim.state.persons.get(ctx.playerId());
  const body = ctx.player.body() ?? (me ? sim.world.settlements.find((s) => s.id === me.settlement) : undefined);
  const near = body ? [...sim.world.settlements].sort((a, b) => Math.hypot(a.x - body.x, a.z - body.z) - Math.hypot(b.x - body.x, b.z - body.z)) : [];
  const offers = [];
  const seen = new Set<number>();
  for (const s of near) {
    if (offers.length >= 4) break;
    const o = ruleOffer(ctx.game, s.id);
    if (!o || seen.has(o.ruler)) continue;
    seen.add(o.ruler);
    offers.push({ o, d: body ? Math.hypot(s.x - body.x, s.z - body.z) : 0 });
  }
  win.body.append(
    h('div.mu-card', null,
      h('div.mu-row.mu-gap-8', null, icon('lock', 20), h('h4', null, 'Only those who rule may sit in the seat of government')),
      h('p.mu-small.mu-ink2', null, 'It opens for the holder of a manor, a town, an abbey, a barony, a county or a kingdom; for a regent ruling for a boy lord; for a steward on the lord’s business; for a village’s reeve. You hold no land and no office that rules anything.'),
      h('p.mu-small.mu-dim', null, 'Win a title, take an office, or take up the rule of a town now:')),
    h('div.mu-col.mu-gap-8', { style: { marginTop: '12px' } }, offers.length ? offers.map(({ o, d }) => h('div.mu-card.mu-row.mu-gap-12', null,
      h('div.mu-grow', null, h('b', null, o.placeName), h('div.mu-small.mu-dim', null, `${o.rulerName}, ${o.role}${d > 40 ? ` · ${d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`} away` : ''}`)),
      button(o.label, { variant: 'primary', icon: 'crown', tip: o.tip, onClick: () => { ctx.close(); ctx.open(o.request); } }))) : [h('p.mu-dim.mu-ital', null, 'No town near you has anyone to take over.')]));
  win.showFoot(h('div.mu-grow'), button('Close', { onClick: () => ctx.close() }));
  return panelOf({ id: 'ruler', group: 'ruler', pauses: 'never', backdropCloses: ctx }, win.el);
}

// ---------------------------------------------------------------------------------------------

class Seat {
  private readonly win = createWindow({ title: 'Seat of government', subtitle: '', icon: 'crown', size: 'xl', tall: true, onClose: () => this.ctx.close() });
  private readonly content = h('div.mu-rul-content.mu-scroll');
  private readonly noteEl = h('div.mu-rul-note.mu-hide');
  private readonly tabsEl: ReturnType<typeof tabs>;
  private readonly status = h('div.mu-rul-status');
  private readonly bag = new Map<string, object>();
  private page: RulerPage;
  private sig = '';
  private noteUntil = 0;
  private lastNow = 0;
  private statusSig = '';
  private readonly env: RulerEnv;
  private viewNow: RealmView | null;
  private readonly poll = every(0.5, () => this.update());

  constructor(private readonly ctx: PanelCtx, private readonly realm: NonNullable<PanelCtx['game']['realm']>, open?: RulerOpen) {
    const me = ctx.playerId();
    this.viewNow = realm.view(me);
    this.page = open?.page && isPage(open.page) ? open.page : lastPage;
    if (open?.house !== undefined) this.bag.set('rivals', { selected: open.house });
    this.env = {
      ctx, realm,
      me: () => ctx.playerId(),
      view: () => this.viewNow as RealmView,
      may: () => roleMay(this.viewNow?.role, this.acting()),
      state: <T extends object>(page: string, init: () => T): T => {
        let b = this.bag.get(page) as T | undefined;
        if (!b) { b = init(); this.bag.set(page, b); }
        return b;
      },
      done: (r, okText) => {
        if (!r) { this.say('That cannot be ordered now.', 'bad'); return false; }
        if (!r.ok) { this.say(r.reason ?? 'It cannot be done.', 'bad'); ctx.say('warn', r.reason ?? 'It cannot be done.'); return false; }
        if (okText) { this.say(okText, 'ok'); ctx.say('gain', okText); }
        this.rebuild();
        return true;
      },
      notice: (text, tone) => this.say(text, tone),
      refresh: () => this.rebuild(),
      go: (page) => this.setPage(page),
      open: (req: PanelRequest) => ctx.open(req),
      describe: (g, q) => { try { return ctx.eco.describe(g, q); } catch { return `${Math.round(q)} ${g}`; } },
      now: () => ctx.sim.absDay,
    };
    this.tabsEl = tabs(PAGES.map((p) => ({ id: p.id, label: p.label, icon: p.icon, tip: p.blurb })), this.page, (id) => this.setPage(id as RulerPage));
    this.win.el.classList.add('mu-rul-win');
    this.win.body.classList.add('flush');
    this.win.body.append(this.tabsEl.el, h('div.mu-tabbar-rule'), this.noteEl, this.content);
    this.win.showFoot(this.status);
    this.updateTitle();
    this.rebuild();
  }

  /** A steward rules for the lord only while the lord cannot act (REALM.md); the realm's own `rules` says. */
  private acting(): boolean {
    const rules = this.realm.rules?.(this.ctx.playerId()) ?? [];
    return rules.length === 0 || rules.some((r) => r.acting || r.role !== 'steward');
  }

  panel(): UiPanel {
    const ids = PAGES.map((p) => p.id);
    return panelOf({ id: 'ruler', group: 'ruler', pauses: 'menu', mode: 'screen', backdropCloses: null }, this.win.el, {
      mount: () => {
        this.ctx.listen('playerSwitched', () => this.ctx.close());
        this.ctx.listen('construction', () => { this.sig = ''; });
        this.ctx.listen('research', () => { this.sig = ''; });
        this.ctx.listen('news', () => { this.sig = ''; });
        this.ctx.listen('war', () => { this.sig = ''; });
      },
      tick: (now) => { this.lastNow = now; this.poll(now); },
      key: tabKeys(ids, () => this.page, (id) => this.setPage(id as RulerPage), { scroller: () => this.content }),
      dispose: () => { lastPage = this.page; },
    });
  }

  private updateTitle(): void {
    const v = this.viewNow;
    this.win.setTitle('Seat of government', v ? `${v.name} · ${roleWords(v.role)}${housesWords(v) ? ` · ${housesWords(v)}` : ''}` : '');
  }

  private setPage(p: RulerPage): void {
    this.page = p;
    lastPage = p;
    this.tabsEl.set(p);
    this.noteEl.classList.add('mu-hide');
    this.content.scrollTop = 0;
    this.rebuild();
  }

  private say(text: string, tone: 'ok' | 'bad' | 'info'): void {
    this.noteEl.className = `mu-rul-note ${tone}`;
    this.noteEl.replaceChildren(icon(tone === 'bad' ? 'warning' : tone === 'ok' ? 'check' : 'info', 16), h('span', null, text));
    this.noteUntil = this.lastNow + 9;
  }

  /** The signature of what the page shows: it is rebuilt when this changes (and nothing in it is being typed into). */
  private signature(): string {
    const g = this.ctx.game;
    return `${this.page}|${this.realm.version()}|${g.construction?.version() ?? 0}|${Math.floor(this.ctx.sim.absDay)}|${g.territory?.version() ?? 0}`;
  }

  private rebuild(): void {
    this.viewNow = this.realm.view(this.ctx.playerId());
    if (!this.viewNow) { this.ctx.close(); return; }
    this.sig = this.signature();
    const keep = this.content.scrollTop;
    clear(this.content);
    try {
      this.content.append(BUILDERS[this.page](this.env));
    } catch (err) {
      console.error(`ruler page "${this.page}" failed`, err);
      this.content.append(empty('This page of the book will not open.', { icon: 'warning', title: 'Something is wrong here' }));
    }
    this.content.scrollTop = keep;
    this.updateTitle();
    this.renderStatus(true);
  }

  /** Twice a second: the treasury and the other figures of the footer; the page when the world under it has moved on. */
  private update(): void {
    const v = this.realm.view(this.ctx.playerId());
    if (!v) { this.ctx.close(); return; }
    this.viewNow = v;
    this.renderStatus(false);
    if (this.noteUntil && this.lastNow > this.noteUntil) { this.noteUntil = 0; this.noteEl.classList.add('mu-hide'); }
    const active = document.activeElement;
    const typing = !!active && this.content.contains(active) && (isTypingTarget(active) || active.tagName === 'SELECT');
    if (!typing && this.signature() !== this.sig) this.rebuild();
  }

  private renderStatus(force: boolean): void {
    const v = this.viewNow;
    if (!v) return;
    const key = `${Math.round(v.treasury)}|${Math.round(v.income)}|${Math.round(v.spending)}|${v.population}|${v.prosperity.toFixed(2)}|${Math.round(v.strength)}`;
    if (!force && key === this.statusSig) return;
    this.statusSig = key;
    const open = this.ctx.game.construction?.sites().filter((s) => v.settlements.includes(s.settlement) || v.vassalSettlements.includes(s.settlement)).length ?? 0;
    const item = (ico: Parameters<typeof icon>[0], label: string, value: string, tone = ''): HTMLElement => h('span.mu-rul-status-item', { class: tone, tip: label }, icon(ico, 15), h('b', null, value), h('span.mu-dim', null, label));
    replace(this.status,
      item('purse', 'treasury', money(v.treasury), v.treasury < 0 ? 'mu-bad' : ''),
      item('trend_up', 'a year in', money(v.income)),
      item('trend_down', 'a year out', money(v.spending)),
      item('users', 'people', v.population.toLocaleString('en-GB')),
      item('sparkle', 'strength', String(Math.round(v.strength))),
      item('hammer', 'works under way', String(open)),
    );
  }
}

