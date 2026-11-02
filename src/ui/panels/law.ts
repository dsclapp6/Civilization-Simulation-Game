// The law panel (docs/CIV.md §4, docs/LAW.md): the lord's men have halted you — what the leader says and the answers open to you — and, when
// you are taken, the prisoner's card: where you are held and why, what is asked, and the ways out (wait for the ransom, pay your own, serve
// a sentence, try to escape at night, live as someone else). Opened by the law module with `{ panel: 'ext', name: 'law', data: { mode } }`,
// and from the HUD's plaque ("Your options"). The cards are pure models (`patrolCard`, `captiveCard`), the DOM is built from them.
import { SEASON_NAMES, toDate } from '../../core/time';
import type { CaptivityView, LawChoice, PatrolView } from '../../sim/law/types';
import { h } from '../core/dom';
import { formatMoney, plural } from '../core/format';
import type { IconName } from '../core/icons';
import { button, chip, keycap } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { every, panelOf } from './base';
import { registerPanel } from './extRegistry';

// ---------------------------------------------------------------------------------------------
// Pure cards
// ---------------------------------------------------------------------------------------------

export interface CardChoice {
  id: string;
  /** "1" … "6": the digit key. */
  key: string;
  label: string;
  detail?: string;
  enabled: boolean;
  reason?: string;
  tone: '' | 'primary' | 'danger';
  icon: IconName;
}

export interface LawCard {
  kind: 'patrol' | 'captive' | 'free';
  title: string;
  subtitle: string;
  icon: IconName;
  /** What is said (the leader's line) or the headline of the case. */
  quote: string;
  /** Lines under it: why the land is closed, what is asked, how long. */
  facts: string[];
  /** A red warning (the lord may hang you). */
  warning?: string;
  choices: CardChoice[];
}

const CHOICE_ICON: Record<string, IconName> = {
  leave: 'boot', business: 'talk', bribe: 'coin', fine: 'purse', yield: 'hand', refuse: 'swords',
  wait: 'hourglass', pay: 'purse', serve: 'hammer', escape: 'door',
};
const CHOICE_TONE: Record<string, CardChoice['tone']> = { leave: 'primary', business: '', bribe: '', fine: '', yield: '', refuse: 'danger', pay: 'primary', serve: '', escape: 'danger', wait: '' };

function choices(list: readonly LawChoice[]): CardChoice[] {
  return list.map((c, i) => ({
    id: c.id, key: String(i + 1), label: c.label, detail: c.detail, enabled: c.ok, reason: c.reason,
    tone: CHOICE_TONE[c.id] ?? '', icon: CHOICE_ICON[c.id] ?? 'dot',
  }));
}

/** "the lord's deer park at Cyney" → the sentence the card shows. */
export function closedText(v: PatrolView): string {
  if (v.reason) return `${v.reason.charAt(0).toUpperCase()}${v.reason.slice(1)}.`;
  return v.level === 'hostile' ? 'Hostile land.' : 'The lord\'s private land.';
}

/** The card of a patrol halting the player. */
export function patrolCard(v: PatrolView, list: readonly LawChoice[]): LawCard {
  const facts: string[] = [closedText(v)];
  if (v.men.length > 0) facts.push(`${v.leaderName ?? 'The leader'} and ${plural(v.men.length, 'man', 'men')}${v.mounted ? ', mounted' : ' on foot'}.`);
  if (v.poaching) facts.push('They have found game or a hunting bow on you.');
  if (v.skipTalk) facts.push('At war, soldiers and nobles of the enemy are not heard: yield, or fight.');
  return {
    kind: 'patrol',
    title: v.level === 'hostile' ? 'Hostile land' : 'Halted',
    subtitle: v.lord ? `The lands of ${v.lord}` : 'The lord\'s men',
    icon: v.level === 'hostile' ? 'swords' : 'shield',
    quote: v.line,
    facts,
    choices: choices(list),
  };
}

/** Whole days held (the day taken counts as the first). */
export function daysHeld(v: CaptivityView, absDay: number): number {
  return Math.max(0, Math.floor(absDay) - Math.floor(v.since));
}

/** What is asked of a prisoner, in words. */
export function askedText(v: CaptivityView): string[] {
  const out: string[] = [];
  if (v.war || v.ransom > 0) out.push(`Ransom asked: ${formatMoney(v.ransom)}. Your House or family may pay it if able and caring.`);
  if (v.fine > 0) out.push(`Fine owed: ${formatMoney(v.fine)}.`);
  if (v.serving) out.push(`You are serving your sentence: ${plural(v.sentenceDays, 'day')} of labour left on the lord's works.`);
  else if (v.sentenceDays > 0 && !v.war) out.push(`The lord may set you ${plural(v.sentenceDays, 'day')} of labour on his works.`);
  return out;
}

/** The prisoner's card. */
export function captiveCard(v: CaptivityView, list: readonly LawChoice[], absDay: number, captorName: string): LawCard {
  const held = daysHeld(v, absDay);
  const d = toDate(v.since);
  const facts: string[] = [
    `${v.led ? 'Taken' : 'Held'} by ${captorName} since ${SEASON_NAMES[d.season]} ${d.dayOfSeason}${held > 0 ? ` (${plural(held, 'day')})` : ''}.`,
    ...askedText(v),
    'Sleep or wait (Z) to let the days pass.',
  ];
  return {
    kind: 'captive',
    title: v.led ? 'Taken' : 'Prisoner',
    subtitle: v.place ?? 'In the lord\'s hands',
    icon: 'lock',
    quote: v.text,
    facts,
    warning: v.danger ? 'The lord is a cruel man and your hands are red with his men\'s blood. He may hang you at dawn.' : undefined,
    choices: choices(list),
  };
}

export function freeCard(): LawCard {
  return { kind: 'free', title: 'Free', subtitle: 'Nobody holds you', icon: 'key', quote: 'No patrol is after you, and no cell holds you.', facts: [], choices: [] };
}

/** The seconds left to be off the land, as the HUD says it ("Off the land in 42 s"). */
export function escortText(v: PatrolView): string {
  if (!Number.isFinite(v.deadline)) return '';
  const s = Math.max(0, Math.ceil(v.deadline));
  return `Off the land in ${s} s`;
}

// ---------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------

const STYLE_ID = 'mu-law-style';
const CSS = `
.mu-law { display: flex; flex-direction: column; gap: 12px; }
.mu-law-quote { margin: 0; padding: 12px 16px; font-size: 20px; font-style: italic; line-height: 1.35; border-left: 4px solid var(--vermilion); background: rgba(255, 250, 232, 0.5); }
.mu-law.captive .mu-law-quote { border-left-color: var(--ink-2); font-size: 17.5px; }
.mu-law-facts { display: flex; flex-direction: column; gap: 3px; font-size: 14.5px; color: var(--ink-2); }
.mu-law-warn { padding: 8px 12px; border: 1px solid var(--vermilion); background: rgba(172, 40, 24, 0.1); color: #7c1d12; font-weight: 700; border-radius: 4px; }
.mu-law-choices { display: flex; flex-direction: column; gap: 7px; margin-top: 4px; }
.mu-law-choice { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; padding: 7px 10px; border: 1px solid var(--rule-soft); border-radius: 4px; background: rgba(255, 250, 232, 0.35); text-align: left; cursor: pointer; font: inherit; color: inherit; }
.mu-law-choice:hover:not(:disabled) { background: rgba(236, 189, 66, 0.25); border-color: #8a5f10; }
.mu-law-choice:disabled { opacity: 0.55; cursor: not-allowed; }
.mu-law-choice b { font-size: 16.5px; }
.mu-law-choice .mu-law-detail { grid-column: 2 / 4; font-size: 13.5px; color: var(--ink-2); }
.mu-law-choice .mu-law-why { grid-column: 2 / 4; font-size: 13px; color: var(--vermilion); font-style: italic; }
.mu-law-choice.primary b { color: #4a3205; }
.mu-law-choice.danger b { color: #7c1d12; }
.mu-law-msg { min-height: 20px; font-size: 14.5px; font-weight: 700; }
.mu-law-msg.bad { color: var(--vermilion); }
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

export function lawPanel(ctx: PanelCtx, req: { data?: unknown }): UiPanel {
  ensureStyle();
  const law = ctx.game.law;
  const sim = ctx.sim;
  const win = createWindow({ title: 'The law', subtitle: '', icon: 'shield', size: 'md', onClose: () => ctx.close() });
  const body = h('div.mu-law');
  win.body.append(body);
  let sig = '';
  let message = '';
  let bad = false;
  let freeSince = -1;
  let card: LawCard = freeCard();
  const startMode = (req.data as { mode?: string } | undefined)?.mode;
  void startMode;

  const answer = (choiceId: string): void => {
    if (!law) return;
    const me = ctx.playerId();
    const inPatrol = !!law.patrolFor(me) && card.kind === 'patrol';
    const r = inPatrol ? law.answerPatrol(me, choiceId) : law.chooseInCaptivity(me, choiceId);
    message = r.ok ? (r.message ?? '') : (r.reason ?? r.message ?? 'That cannot be done.');
    bad = !r.ok;
    if (message) ctx.say(r.ok ? 'info' : 'warn', message);
    sig = '';
    render();
  };

  const choiceRow = (c: CardChoice): HTMLElement => {
    const row = h<HTMLButtonElement>('button.mu-law-choice', { class: c.tone, type: 'button', disabled: !c.enabled, 'data-choice': c.id },
      keycap(c.key),
      h('b', null, c.label),
      h('span.mu-small.mu-dim', null, ''),
      c.detail ? h('span.mu-law-detail', null, c.detail) : null,
      !c.enabled && c.reason ? h('span.mu-law-why', null, c.reason) : null);
    row.addEventListener('click', () => { if (c.enabled) answer(c.id); });
    return row;
  };

  const render = (): void => {
    if (!law) { body.replaceChildren(h('p.mu-empty', null, 'There is no law in this land.')); return; }
    const me = ctx.playerId();
    const pv = law.patrolFor(me);
    const cv = law.captivity(me);
    if (pv && pv.phase === 'halt') card = patrolCard(pv, law.patrolChoices(me));
    else if (cv) card = captiveCard(cv, law.captivityChoices(me), sim.absDay, ctx.nameOf(cv.captor) || 'the lord\'s men');
    else card = freeCard();
    const key = JSON.stringify([card.kind, card.quote, card.facts, card.warning, card.choices.map((c) => [c.id, c.enabled, c.detail, c.reason]), message, bad]);
    if (key === sig) return;
    sig = key;
    win.setTitle(card.title, card.subtitle);
    const ch = card.choices.map(choiceRow);
    body.className = `mu-law ${card.kind}`;
    const parts: Node[] = [h('blockquote.mu-law-quote', null, card.quote)];
    if (card.facts.length) parts.push(h('div.mu-law-facts', null, card.facts.map((f) => h('div', null, f))));
    if (card.warning) parts.push(h('div.mu-law-warn', null, card.warning));
    if (ch.length) parts.push(h('div.mu-law-choices', null, ch));
    if (card.kind === 'captive') {
      parts.push(h('div.mu-row.mu-wrap.mu-gap-6', null,
        button('Live as someone else', { icon: 'users', tip: 'Go on as another person; your body stays in the cell', onClick: () => ctx.open({ panel: 'ext', name: 'liveAs', data: { reason: 'choose' } }) }),
        button('Sleep or wait…', { icon: 'hourglass', tip: 'Let the days pass', onClick: () => ctx.open({ panel: 'rest' }) })));
    }
    parts.push(h('div.mu-law-msg', { class: bad ? 'bad' : '' }, message));
    body.replaceChildren(...parts);
    if (card.kind === 'patrol') win.showFoot(chip('The riders wait for your answer', 'vermilion', 'warning'));
    else win.foot.classList.add('mu-hide');
  };

  const tick = every(0.25, (now) => {
    render();
    // a case that is over: the card says so and goes
    if (card.kind === 'free') {
      if (freeSince < 0) freeSince = now;
      else if (now - freeSince > 2.2) ctx.close();
    } else freeSince = -1;
  });
  render();

  return panelOf({ id: 'law', group: 'law', captures: true, pauses: 'never', escape: 'close', backdropCloses: null }, win.el, {
    tick,
    key(intent) {
      if (intent.type !== 'digit') return false;
      const c = card.choices[intent.n - 1];
      if (!c || !c.enabled) return false;
      answer(c.id);
      return true;
    },
  });
}

registerPanel('law', (ctx, req) => lawPanel(ctx, req));
