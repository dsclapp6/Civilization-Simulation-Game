// The dialogue panel: who you are talking to, how they feel, the running lines and your options
// (keys 1–9). Docked at the bottom so the speaker stays in view.
import type { Conversation, DialogueLine, DialogueOption } from '../../sim/social/types';
import { ageYears, fullName } from '../../sim/state';
import { RANK_NAMES } from '../../core/domain';
import { h } from '../core/dom';
import { MOOD_LABEL, chanceBand, moodTone, opinionFraction, opinionWords, orderOptions } from '../core/dialogueModel';
import { signed } from '../core/format';
import { icon } from '../core/icons';
import { OPTION_ICON, OPTION_LABEL } from '../core/iconMap';
import { chip } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { every, panelOf } from './base';

export function dialoguePanel(ctx: PanelCtx, conversationId: number): UiPanel {
  let conv: Conversation | null = ctx.social.current();
  const sim = ctx.sim;
  const win = createWindow({ title: '…', icon: 'talk', size: 'lg', onClose: () => close() });
  const heads = h('div.mu-dlg-head');
  const transcript = h('div.mu-dlg-lines.mu-scroll');
  const optsEl = h('div.mu-dlg-opts.mu-scroll');
  const note = h('div.mu-dlg-note.mu-small.mu-ital.mu-dim');
  win.body.classList.add('flush');
  win.body.append(heads, h('div.mu-dlg-main', null, h('div.mu-dlg-left', null, transcript, note), optsEl));
  win.head.classList.add('mu-hide');

  let shown = 0;
  let ordered: DialogueOption[] = [];
  let ended = false;

  function close(): void {
    if (conv && !ended) { ended = true; ctx.social.end(conv.id); }
    ctx.close();
  }

  const lineEl = (l: DialogueLine, fresh: boolean): HTMLElement => {
    const mine = conv ? l.speaker === conv.actor : false;
    const who = mine ? 'You' : ctx.nameOf(l.speaker).split(' ')[0];
    return h('div.mu-dlg-line', { class: `${mine ? 'mine' : 'theirs'}${fresh ? ' fresh' : ''}${l.tone ? ` tone-${l.tone}` : ''}` },
      h('span.mu-dlg-who', null, who),
      h('span.mu-dlg-text', null, l.text),
      l.tone && !mine && l.tone !== 'neutral' ? h('span.mu-dlg-tone', null, `(${l.tone})`) : null);
  };

  const run = (o: DialogueOption): void => {
    if (!conv || ended) return;
    if (!o.enabled) { note.textContent = o.reason ?? 'That is not possible now.'; return; }
    note.textContent = '';
    const before = conv.lines.length;
    try {
      conv = ctx.social.choose(conv.id, o.id);
    } catch {
      close();
      return;
    }
    if (conv.ended) { ended = true; ctx.close(); return; }
    shown = Math.min(shown, before);
    render();
  };

  function render(): void {
    if (!conv) return;
    const other = sim.state.persons.get(conv.with);
    const name = other ? fullName(other) : 'Someone';
    const age = other ? Math.floor(ageYears(other, sim.absDay)) : 0;
    const op = opinionFraction(conv.opinion);
    heads.replaceChildren(
      h('div.mu-dlg-who-big', null,
        h('div.mu-dlg-name', null, name),
        h('div.mu-dim.mu-small', null, `${conv.relation || ctx.social.relationLabel(conv.actor, conv.with)}${other ? ` · ${age} years old · ${RANK_NAMES[other.rankTier]}` : ''}`)),
      h('div.mu-dlg-mood', null,
        chip(MOOD_LABEL[conv.mood], moodTone(conv.mood), conv.mood === 'hostile' ? 'swords' : conv.mood === 'friendly' ? 'heart' : conv.mood === 'wary' ? 'warning' : 'face'),
        h('div.mu-opinion', { tip: `${opinionWords(conv.opinion, name.split(' ')[0])} (${signed(conv.opinion)})` },
          h('div.mu-opinion-track', null, h('i.mid'), h('b.mu-opinion-mark', { style: { left: `${op * 100}%` } })),
          conv.opinionDelta !== 0 ? h('span.mu-opinion-delta', { class: conv.opinionDelta > 0 ? 'up' : 'down' }, signed(conv.opinionDelta)) : null),
        h('div.mu-tiny.mu-dim', null, opinionWords(conv.opinion, name.split(' ')[0]))),
      h('button.mu-x', { type: 'button', tip: 'End the conversation (Esc)', 'aria-label': 'End the conversation', onclick: () => close() }, icon('cross', 15)),
    );
    // transcript: only new lines are appended so the scroll position stays put
    if (shown > conv.lines.length) { transcript.replaceChildren(); shown = 0; }
    for (let i = shown; i < conv.lines.length; i++) transcript.appendChild(lineEl(conv.lines[i], i > 0));
    shown = conv.lines.length;
    transcript.scrollTop = transcript.scrollHeight;
    // options
    ordered = orderOptions(conv.options);
    optsEl.replaceChildren(...ordered.map((o, i) => {
      const band = o.chance !== undefined ? chanceBand(o.chance) : null;
      const b = h<HTMLButtonElement>('button.mu-dopt', { type: 'button', class: o.enabled ? '' : 'is-disabled', tip: o.enabled ? undefined : o.reason },
        h('span.mu-key', { class: i < 9 ? '' : 'mu-hide' }, String(i + 1)),
        h('span.mu-dopt-ico', null, icon(OPTION_ICON[o.kind], 17)),
        h('span.mu-dopt-main', null,
          h('span.mu-dopt-label', null, o.label),
          !o.enabled && o.reason ? h('span.mu-dopt-reason', null, o.reason) : null),
        band && o.chance !== undefined
          ? h('span.mu-chance', { class: band, tip: 'Chance of success' }, `${Math.round(o.chance * 100)}%`)
          : h('span.mu-dopt-kind', null, OPTION_LABEL[o.kind]));
      b.addEventListener('click', () => run(o));
      return b;
    }));
  }

  if (!conv || conv.id !== conversationId) {
    win.head.classList.remove('mu-hide');
    win.setTitle('The conversation is over');
    win.body.replaceChildren(h('p.mu-empty', null, 'They have gone about their business.'));
    return panelOf({ id: 'dialogue', group: 'dialogue', pauses: 'never', mode: 'dock-bottom', backdropCloses: ctx }, win.el);
  }

  ctx.listen('conversation', (e) => { if (e.phase === 'end' && e.id === conversationId) { ended = true; ctx.close(); } });
  render();
  const refresh = every(0.5, () => {
    const cur = ctx.social.current();
    if (!cur || cur.id !== conversationId) return;
    if (cur.options.length !== conv?.options.length || cur.lines.length !== shown || cur.opinion !== conv?.opinion) { conv = cur; render(); }
  });

  return panelOf({ id: 'dialogue', group: 'dialogue', pauses: 'never', mode: 'dock-bottom', backdropCloses: null }, win.el, {
    tick: refresh,
    onEscape: () => { close(); return true; },
    key: (intent) => {
      if (intent.type === 'digit' && ordered[intent.n - 1]) { run(ordered[intent.n - 1]); return true; }
      return false;
    },
  });
}
