// The main menu and run start: title screen → difficulty (→ loading → the reveal of the lord you are, which the
// controller shows). Also the records page and the settings page. Nothing is bought or carried between runs.
import type { Difficulty } from '../../core/domain';
import { levelProfile } from '../../sim/legacy';
import { h } from '../core/dom';
import { thousands, trim } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { corners, divider } from '../core/ornament';
import { DIFFICULTIES, DIFFICULTY_NOTE } from '../core/text';
import { button, chip, heading } from '../components/widgets';
import type { UiHost } from '../types';
import { settingsBody } from './settings';

export type MenuView = 'main' | 'difficulty' | 'records' | 'settings';

export interface MenuDeps {
  host: UiHost;
  /** Start a run (the controller shows loading and the birth reveal). */
  startRun(opts: { difficulty: Difficulty }): Promise<void>;
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
  private saved = false;
  private starting = false;
  private error = '';

  constructor(private readonly deps: MenuDeps) {
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

  show(): void { this.el.classList.remove('mu-hide'); }
  hide(): void { this.el.classList.add('mu-hide'); }
  get visible(): boolean { return !this.el.classList.contains('mu-hide'); }
  get current(): MenuView { return this.view; }

  /** Back one step. Returns true if the menu handled it. */
  back(): boolean {
    if (this.starting) return true;
    switch (this.view) {
      case 'main': return false;
      default: this.go('main'); return true;
    }
  }

  /** Opens the menu at `view`, refreshing the saved-run flag. */
  open(view: MenuView = 'main'): void {
    this.starting = false;
    this.error = '';
    this.show();
    this.go(view);
    void this.deps.host.hasSavedRun().then((has) => {
      if (has !== this.saved) { this.saved = has; if (this.view === 'main') this.go('main'); }
    }).catch(() => undefined);
  }

  go(view: MenuView): void {
    this.view = view;
    this.stage.classList.toggle('wide', view === 'difficulty');
    this.stage.replaceChildren(this.build(view));
  }

  setError(text: string): void { this.error = text; this.starting = false; if (this.view === 'difficulty') this.go('difficulty'); }

  private build(view: MenuView): HTMLElement {
    switch (view) {
      case 'main': return this.mainView();
      case 'difficulty': return this.difficultyView();
      case 'records': return this.recordsView();
      case 'settings': return this.settingsView();
    }
  }

  // ---- title ----

  private mainView(): HTMLElement {
    const crest = h('div.mu-crest', null, icon('crown', 30));
    const card = h('section.mu-win.sm.mu-menu-card', null, corners(), h('div.mu-menu-card-body', null,
      this.saved ? button('Continue', { variant: 'primary', size: 'big', icon: 'play', class: 'mu-wide', onClick: () => this.deps.continueRun() }) : null,
      button('New run', { variant: this.saved ? '' : 'primary', size: 'big', icon: 'sparkle', class: 'mu-wide', onClick: () => this.go('difficulty') }),
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
        ),
        h('p.mu-dim.mu-small.mu-ital', { style: { marginTop: '14px' } }, 'Records only: nothing is carried from one run into the next.'),
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

  private difficultyView(): HTMLElement {
    const cards = DIFFICULTIES.map((d) => {
      const sel = d.id === this.difficulty;
      const card = h('div.mu-card.click.mu-tier', { class: sel ? 'sel' : '', role: 'radio', 'aria-checked': String(sel), tabindex: '0' },
        h('div.mu-tier-top', null,
          h('span.mu-tier-ico', null, icon(TIER_ICON[d.id], 24)),
          h('div', null, h('h4', null, d.name), h('div.mu-dim.mu-ital.mu-small', null, d.tagline))),
        chip(`Points ×${d.gold}`, 'gold', 'star_f', 'Your score is multiplied by this'),
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
        heading('Choose your trial', 'swords'),
        h('div.mu-grid.c4.mu-tiers', { role: 'radiogroup' }, cards),
        h('p.mu-dim.mu-small.mu-ital', { style: { marginTop: '12px' } }, DIFFICULTY_NOTE),
        h('p.mu-small.mu-ink2', { style: { marginTop: '4px' } }, 'You begin as the lord of a manor: you rule its fields, purse and men from the first morning, and you are also a man or woman of flesh who must be made strong. You can live as anyone else at any time.'),
        this.error ? h('p.mu-bad.mu-bold', { style: { marginTop: '10px' } }, this.error) : null,
      ),
      h('footer.mu-win-foot', null,
        button('Back', { icon: 'chev_left', onClick: () => this.go('main') }),
        h('div.mu-grow'),
        button(this.starting ? 'Making the world…' : 'Take up your lordship', {
          variant: 'primary', size: 'big', icon: 'play', disabled: this.starting, onClick: () => this.begin(),
        }),
      ),
    );
    return h('div.mu-menu-single', null, win);
  }

  private begin(): void {
    if (this.starting) return;
    this.starting = true;
    this.error = '';
    this.go('difficulty');
    void this.deps.startRun({ difficulty: this.difficulty }).catch((err: unknown) => {
      this.setError(`The world could not be made: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}
