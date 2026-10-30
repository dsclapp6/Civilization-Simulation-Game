// The main menu and run start: title screen → difficulty → Legacy stat shop (→ loading → birth reveal,
// which the controller shows). Also the records page and the settings page.
import type { Difficulty } from '../../core/domain';
import { STATS } from '../../core/domain';
import { levelProfile } from '../../sim/legacy';
import { h } from '../core/dom';
import { thousands, trim } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { STAT_ICON } from '../core/iconMap';
import { corners, divider } from '../core/ornament';
import { DIFFICULTIES, DIFFICULTY_NOTE, STAT_INFO } from '../core/text';
import { button, chip, heading, pips } from '../components/widgets';
import type { StatUpgrades } from '../../sim/legacy';
import type { UiHost } from '../types';
import { MAX_RANKS_PER_STAT, SHOP_BASE_STAT, StatShop } from './shop';
import { settingsBody } from './settings';

export type MenuView = 'main' | 'difficulty' | 'shop' | 'records' | 'settings';

export interface MenuDeps {
  host: UiHost;
  /** Start a run (the controller shows loading and the birth reveal). */
  startRun(opts: { difficulty: Difficulty; statUpgrades: StatUpgrades }): Promise<void>;
  continueRun(): void;
  onSettingsChanged(): void;
}

const TIER_ICON: Record<Difficulty, IconName> = { squire: 'shield', knight: 'helm', lord: 'castle', king: 'crown' };
export const VERSION_LINE = 'Millennia · a medieval life in three dimensions';

export class MenuLayer {
  readonly el = h('div.mu-menu.mu-hide');
  private readonly stage = h('div.mu-menu-stage');
  private view: MenuView = 'main';
  private difficulty: Difficulty = 'knight';
  private shop: StatShop;
  private saved = false;
  private starting = false;
  private error = '';

  constructor(private readonly deps: MenuDeps) {
    this.shop = new StatShop(this.gold());
    const embers = h('div.mu-embers');
    for (let i = 0; i < 18; i++) {
      const e = h('i');
      e.style.left = `${(i * 53 + 7) % 100}%`;
      e.style.animationDelay = `${-((i * 37) % 17)}s`;
      e.style.animationDuration = `${11 + ((i * 7) % 9)}s`;
      e.style.setProperty('--s', String(0.5 + ((i * 13) % 10) / 10));
      embers.appendChild(e);
    }
    this.el.append(h('div.mu-menu-bg'), embers, h('div.mu-menu-frame', null, corners()), this.stage);
  }

  private gold(): number { return levelProfile(this.deps.host.profile()).legacyGold; }

  show(): void { this.el.classList.remove('mu-hide'); }
  hide(): void { this.el.classList.add('mu-hide'); }
  get visible(): boolean { return !this.el.classList.contains('mu-hide'); }
  get current(): MenuView { return this.view; }

  /** Back one step. Returns true if the menu handled it. */
  back(): boolean {
    if (this.starting) return true;
    switch (this.view) {
      case 'main': return false;
      case 'shop': this.go('difficulty'); return true;
      default: this.go('main'); return true;
    }
  }

  /** Opens the menu at `view`, refreshing the saved-run flag. */
  open(view: MenuView = 'main'): void {
    this.starting = false;
    this.error = '';
    this.shop.setGold(this.gold());
    this.show();
    this.go(view);
    void this.deps.host.hasSavedRun().then((has) => {
      if (has !== this.saved) { this.saved = has; if (this.view === 'main') this.go('main'); }
    }).catch(() => undefined);
  }

  go(view: MenuView): void {
    this.view = view;
    this.stage.classList.toggle('wide', view === 'difficulty' || view === 'shop');
    this.stage.replaceChildren(this.build(view));
  }

  setError(text: string): void { this.error = text; this.starting = false; if (this.view === 'shop') this.go('shop'); }

  private build(view: MenuView): HTMLElement {
    switch (view) {
      case 'main': return this.mainView();
      case 'difficulty': return this.difficultyView();
      case 'shop': return this.shopView();
      case 'records': return this.recordsView();
      case 'settings': return this.settingsView();
    }
  }

  // ---- title ----

  private mainView(): HTMLElement {
    const crest = h('div.mu-crest', null, icon('crown', 30));
    const card = h('section.mu-win.sm.mu-menu-card', null, corners(), h('div.mu-menu-card-body', null,
      this.saved ? button('Continue', { variant: 'primary', size: 'big', icon: 'play', class: 'mu-wide', onClick: () => this.deps.continueRun() }) : null,
      button('New run', { variant: this.saved ? '' : 'primary', size: 'big', icon: 'sparkle', class: 'mu-wide', onClick: () => { this.shop.setGold(this.gold()); this.go('difficulty'); } }),
      button('Records', { size: 'big', icon: 'trend_up', class: 'mu-wide', onClick: () => this.go('records') }),
      button('Settings', { size: 'big', icon: 'cog', class: 'mu-wide', onClick: () => this.go('settings') }),
    ));
    return h('div.mu-menu-main', null,
      h('div.mu-title-block', null,
        crest,
        h('h1.mu-title', null, 'Millennia'),
        h('div.mu-tagline', null, 'Live one life at a time. Build a House that outlasts you.'),
        divider(),
      ),
      card,
      h('div.mu-menu-foot', null, VERSION_LINE),
    );
  }

  // ---- records ----

  private recordsView(): HTMLElement {
    const lp = levelProfile(this.deps.host.profile());
    const stat = (ico: IconName, label: string, value: string, note: string): HTMLElement =>
      h('div.mu-record', null,
        h('div.mu-record-ico', null, icon(ico, 26)),
        h('div.mu-record-value', null, value),
        h('div.mu-record-label', null, label),
        h('div.mu-record-note', null, note));
    const win = h('section.mu-win.md', null, corners(),
      h('header.mu-win-head', null, h('span.mu-win-ico', null, icon('crown', 22)), h('h2', null, 'Records'), h('span.mu-win-sub', null, 'The Medieval level')),
      h('div.mu-win-body', null,
        h('div.mu-grid.c2', null,
          stat('star', 'Best score', thousands(lp.bestScore), 'Points at the end of your finest run'),
          stat('map', 'Most of the continent ruled', `${trim(lp.bestContinentPct, 1)}%`, 'Land under your House’s titles, vassals included'),
          stat('book', 'Runs played', thousands(lp.runsPlayed), 'Each run is a new continent and a new life'),
          stat('coin', 'Legacy gold', thousands(lp.legacyGold), 'Kept forever; buys stat ranks for your next birth'),
        ),
        h('p.mu-dim.mu-small.mu-ital', { style: { marginTop: '14px' } }, 'Points earned in a run become Legacy gold at one gold for every ten points, multiplied by the difficulty you chose.'),
      ),
      h('footer.mu-win-foot', null, button('Back', { icon: 'chev_left', onClick: () => this.go('main') })),
    );
    return h('div.mu-menu-single', null, win);
  }

  // ---- settings ----

  private settingsView(): HTMLElement {
    const win = h('section.mu-win.md', null, corners(),
      h('header.mu-win-head', null, h('span.mu-win-ico', null, icon('cog', 22)), h('h2', null, 'Settings')),
      h('div.mu-win-body', null, settingsBody(this.deps.host, () => this.deps.onSettingsChanged())),
      h('footer.mu-win-foot', null, button('Back', { icon: 'chev_left', onClick: () => this.go('main') })),
    );
    return h('div.mu-menu-single', null, win);
  }

  // ---- run start: difficulty ----

  private stepper(active: number): HTMLElement {
    const steps = ['Difficulty', 'Legacy shop', 'Your birth'];
    const el = h('ol.mu-stepper');
    steps.forEach((s, i) => el.appendChild(h('li', { class: i === active ? 'on' : i < active ? 'done' : '' }, h('b', null, String(i + 1)), s)));
    return el;
  }

  private difficultyView(): HTMLElement {
    const cards = DIFFICULTIES.map((d) => {
      const sel = d.id === this.difficulty;
      const card = h('div.mu-card.click.mu-tier', { class: sel ? 'sel' : '', role: 'radio', 'aria-checked': String(sel), tabindex: '0' },
        h('div.mu-tier-top', null,
          h('span.mu-tier-ico', null, icon(TIER_ICON[d.id], 24)),
          h('div', null, h('h4', null, d.name), h('div.mu-dim.mu-ital.mu-small', null, d.tagline))),
        chip(`Legacy gold ×${d.gold}`, 'gold', 'coin', 'Points convert to Legacy gold at this rate'),
        h('ul.mu-bullets', null, d.changes.map((c) => h('li', null, c))),
        sel ? h('span.mu-tier-check', null, icon('check', 16)) : null,
      );
      const pick = (): void => { this.difficulty = d.id; this.go('difficulty'); };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      return card;
    });
    const win = h('section.mu-win.xl', null, corners(),
      h('header.mu-win-head', null, h('span.mu-win-ico', null, icon('shield', 22)), h('h2', null, 'A New Run'), h('span.mu-win-sub', null, 'A new continent, a new life')),
      h('div.mu-win-body', null,
        this.stepper(0),
        heading('Choose your trial', 'swords'),
        h('div.mu-grid.c4.mu-tiers', { role: 'radiogroup' }, cards),
        h('p.mu-dim.mu-small.mu-ital', { style: { marginTop: '12px' } }, DIFFICULTY_NOTE),
        h('p.mu-small.mu-ink2', { style: { marginTop: '4px' } }, 'You are born into a random family of the period, weighted like the real world: most are peasants, a few are gentry or noble. You start at twelve.'),
      ),
      h('footer.mu-win-foot', null,
        button('Back', { icon: 'chev_left', onClick: () => this.go('main') }),
        h('div.mu-grow'),
        button('Legacy shop', { variant: 'primary', size: 'big', icon: 'chev_right', onClick: () => this.go('shop') }),
      ),
    );
    return h('div.mu-menu-single', null, win);
  }

  // ---- run start: stat shop ----

  private shopView(): HTMLElement {
    const shop = this.shop;
    const diff = DIFFICULTIES.find((d) => d.id === this.difficulty)!;
    const refresh = (): void => this.go('shop');

    const rows = STATS.map((id) => {
      const info = STAT_INFO[id];
      const rank = shop.rank(id);
      const next = shop.nextPrice(id);
      const last = shop.lastPrice(id);
      const minus = button('', { icon: 'minus', size: 'small', class: 'icon', disabled: !shop.canRemove(id), tip: last !== null ? `Remove a rank (refunds ${thousands(last)})` : 'No ranks to remove',
        onClick: () => { shop.remove(id); refresh(); } });
      const plus = button('', { icon: 'plus', size: 'small', class: 'icon', variant: 'primary', disabled: !shop.canAdd(id),
        tip: next === null ? 'Fully upgraded' : shop.canAdd(id) ? `Buy a rank for ${thousands(next)} gold` : `Needs ${thousands(next)} gold`,
        onClick: () => { shop.add(id); refresh(); } });
      return h('div.mu-shop-row', null,
        h('span.mu-shop-ico', null, icon(STAT_ICON[id], 22)),
        h('div.mu-shop-name', null, h('b', null, info.name), h('span.mu-dim.mu-small', null, info.affects)),
        pips(rank, MAX_RANKS_PER_STAT, 'mu-shop-pips'),
        h('div.mu-shop-pot', { tip: `An average roll of ${SHOP_BASE_STAT} becomes ${shop.expectedPotential(id)}. The cap is 18.` },
          rank > 0 ? [h('span.mu-dim', null, `+${rank}`), icon('chev_right', 12, 'mu-dim'), h('b', null, String(shop.expectedPotential(id)))] : h('span.mu-dim', null, '—')),
        minus, plus,
        h('div.mu-shop-price.mu-num', null, next === null ? 'max' : `${thousands(next)}`, next === null ? null : icon('coin', 13)),
      );
    });

    const left = h('div.mu-shop-side', null,
      h('div.mu-gold-card', null,
        h('div.mu-gold-top', null, icon('coin', 24), h('span.mu-gold-num', null, thousands(shop.balance)), h('span.mu-dim', null, 'Legacy gold')),
        h('dl.mu-kv', null,
          h('dt', null, 'Spending'), h('dd', null, `${thousands(shop.spent())}`),
          h('dt', null, 'Left after'), h('dd.mu-bold', { class: shop.remaining() === shop.balance ? '' : 'mu-gold' }, `${thousands(shop.remaining())}`),
          h('dt', null, 'Difficulty'), h('dd', null, `${diff.name} (×${diff.gold})`),
        )),
      h('div.mu-prose.mu-small.mu-ink2', null,
        h('p', null, 'Gold you earned in earlier runs buys ',
          h('b', null, 'ranks'), ' in the six stats of your next character. Each rank raises that stat’s ',
          h('b', null, 'potential'), ' by one, never above the cap of 18; training then grows the stat toward it, and your children inherit it.'),
        h('p', null, 'Ranks are bought fresh for every run and are used up with it. Stats are rolled at birth around ten, so a rank on a lucky roll may be wasted at the cap.'),
      ),
    );

    const win = h('section.mu-win.xl', null, corners(),
      h('header.mu-win-head', null, h('span.mu-win-ico', null, icon('coin', 22)), h('h2', null, 'The Legacy Shop'), h('span.mu-win-sub', null, 'Spend gold on your next life')),
      h('div.mu-win-body', null,
        this.stepper(1),
        h('div.mu-shop', null, left, h('div.mu-shop-main', null, heading('Raise your potential', 'sparkle'), h('div.mu-shop-rows', null, rows))),
        this.error ? h('p.mu-bad.mu-bold', { style: { marginTop: '10px' } }, this.error) : null,
      ),
      h('footer.mu-win-foot', null,
        button('Back', { icon: 'chev_left', onClick: () => this.go('difficulty') }),
        button('Reset', { icon: 'refresh', disabled: shop.totalRanks() === 0, onClick: () => { shop.reset(); refresh(); } }),
        h('div.mu-grow'),
        h('span.mu-dim.mu-small', null, shop.totalRanks() > 0 ? `${shop.totalRanks()} ranks for ${thousands(shop.spent())} gold` : 'No ranks: you will be born as you are'),
        button(this.starting ? 'Making the world…' : 'Begin your life', {
          variant: 'primary', size: 'big', icon: 'play', disabled: this.starting,
          onClick: () => this.begin(),
        }),
      ),
    );
    return h('div.mu-menu-single', null, win);
  }

  private begin(): void {
    if (this.starting) return;
    this.starting = true;
    this.error = '';
    this.go('shop');
    void this.deps.startRun({ difficulty: this.difficulty, statUpgrades: this.shop.selection() }).catch((err: unknown) => {
      this.setError(`The world could not be made: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
