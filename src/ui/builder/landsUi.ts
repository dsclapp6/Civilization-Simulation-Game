// Small DOM pieces builder mode, ruler mode and the map share: goods with their icons, a labelled money chip, a refusal line.
import type { EconomyApi } from '../../sim/economy/types';
import { formatMoney } from '../../sim/money';
import { h, type Child } from '../core/dom';
import { icon } from '../core/icons';
import { GOOD_ICON } from '../core/iconMap';

/** The icon of a good (by its category), a plain box for a good the economy does not know. */
export function goodIcon(eco: Pick<EconomyApi, 'good'>, good: string, size = 15): SVGElement {
  const def = eco.good(good);
  return icon(def ? GOOD_ICON[def.category] : 'box', size);
}

/** "20 planks" in the economy's words. */
export function describeGood(eco: Pick<EconomyApi, 'describe' | 'good'>, good: string, qty: number): string {
  try { return eco.describe(good, qty); } catch { return `${Math.round(qty)} ${good.replace(/_/g, ' ')}`; }
}

/** The plain name of a good ("Planks", "Iron ore"). */
export function goodName(eco: Pick<EconomyApi, 'good'>, good: string): string {
  return eco.good(good)?.name ?? good.replace(/_/g, ' ');
}

/** A goods chip: icon, amount and name; `have` (when given) says how much the payer already holds, red when it falls short. */
export function goodLine(eco: Pick<EconomyApi, 'describe' | 'good'>, good: string, qty: number, have?: number): HTMLElement {
  const short = have !== undefined && have + 0.0001 < qty;
  const tip = have === undefined ? undefined : short ? `You have ${Math.floor(have)}; ${Math.ceil(qty - have)} more must be bought or made` : `You have ${Math.floor(have)}`;
  return h('span.mu-good-line', { class: short ? 'short' : have !== undefined ? 'have' : '', tip },
    goodIcon(eco, good), h('span', null, describeGood(eco, good, qty)));
}

/** A refusal in the UI's red ink, or nothing. */
export function reasonLine(reason: string | undefined | null): HTMLElement | null {
  return reason ? h('div.mu-bad.mu-small.mu-reason', null, reason) : null;
}

export function moneyText(pence: number): string { return formatMoney(Math.round(pence)); }

/** A section label inside a card. */
export function caption(text: string, ...extra: Child[]): HTMLElement {
  return h('div.mu-tiny.mu-dim.mu-caps.mu-caption', null, text, ...extra);
}

/** What a stack list holds of a good, qualities summed. */
export function holdOf(stacks: ReadonlyArray<{ good: { id: string }; qty: number }>, good: string): number {
  let n = 0;
  for (const s of stacks) if (s.good.id === good) n += s.qty;
  return n;
}
