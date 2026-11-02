// What every page of the seat of government is given (`RulerEnv`), and the little DOM pieces they share: stat cards, section cards,
// a money amount, the empty line, a person's name that can be clicked to live as them.
import type { PersonId } from '../../sim/state';
import type { RealmApi, RealmView } from '../../sim/realm/types';
import { formatMoney } from '../../sim/money';
import type { PanelCtx } from '../app/panel';
import { h, type Child } from '../core/dom';
import { icon, type IconName } from '../core/icons';
import type { PanelRequest } from '../core/requests';
import type { RulerPage } from './rulerModel';

export interface RulerEnv {
  readonly ctx: PanelCtx;
  readonly realm: RealmApi;
  me(): PersonId;
  /** The realm as it stands (re-read twice a second: the treasury moves without a version bump). */
  view(): RealmView;
  /** What the person's role lets them do (REALM.md "Who rules"). */
  may(): { plan: boolean; trade: boolean; realm: boolean };
  /** A bag a page keeps its choices in (a selected branch, a form) so a rebuild of the page does not lose them. */
  state<T extends object>(page: string, init: () => T): T;
  /** Shows the outcome of a command — a refusal in red with its reason, a success in gold — and rebuilds the page. */
  done(r: { ok: boolean; reason?: string } | undefined | null, ok?: string): boolean;
  /** Shows a line in the notice strip without rebuilding. */
  notice(text: string, tone: 'ok' | 'bad' | 'info'): void;
  /** Rebuilds the page now. */
  refresh(): void;
  go(page: RulerPage): void;
  open(req: PanelRequest): void;
  describe(good: string, qty: number): string;
  now(): number;
}

/** A figure with a label, for the row of stats at the top of a page. */
export function statCard(label: string, value: Child, sub?: Child, tone: '' | 'good' | 'bad' | 'gold' = '', ico?: IconName, tip?: string): HTMLElement {
  return h('div.mu-card.mu-rul-stat', { class: tone, tip },
    h('div.mu-tiny.mu-dim.mu-caps.mu-row.mu-gap-4', null, ico ? icon(ico, 13) : null, label),
    h('div.mu-rul-stat-v.mu-num', null, value),
    sub ? h('div.mu-small.mu-dim', null, sub) : null);
}

/** A section: an icon, a title, the things in it. */
export function section(title: string, ico: IconName | null, ...children: Child[]): HTMLElement {
  return h('section.mu-card.mu-rul-sec', null,
    h('h4.mu-row.mu-gap-6', null, ico ? icon(ico, 17) : null, title),
    ...children);
}

/** "£3 4s" in the pence the realm counts in. */
export function money(pence: number): string { return formatMoney(Math.round(pence)); }

/** A signed amount of money: "+£3" in green, "−£1 2s" in red. */
export function signedMoney(pence: number): HTMLElement {
  const v = Math.round(pence);
  if (v === 0) return h('span.mu-dim', null, '£0');
  return h('span', { class: v > 0 ? 'mu-good' : 'mu-bad' }, `${v > 0 ? '+' : ''}${formatMoney(v)}`);
}

export function line(text: string): HTMLElement { return h('p.mu-small.mu-dim.mu-ital', null, text); }

/** A person's name as a link that opens their page. */
export function personLink(env: Pick<RulerEnv, 'ctx'>, id: PersonId): HTMLElement {
  const el = h('span.mu-link', { tip: 'Open their page' }, env.ctx.nameOf(id));
  el.addEventListener('click', () => env.ctx.open({ panel: 'person', id }));
  return el;
}
