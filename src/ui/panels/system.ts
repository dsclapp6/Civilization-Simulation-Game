// System panels: message, confirm, pause menu and in-game settings.
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { createWindow } from '../components/window';
import { button } from '../components/widgets';
import type { PanelCtx, UiHooks, UiPanel } from '../app/panel';
import type { ConfirmOptions } from '../core/requests';
import { levelProfile } from '../../sim/legacy';
import { thousands } from '../core/format';
import { runCard } from '../../sim/api';
import { settingsBody } from '../screens/settings';
import { panelOf } from './base';

let messageSeq = 0;

/** The generic parchment message: a title, a few paragraphs (drop cap on the first) and an OK button. */
export function messagePanel(ctx: PanelCtx, title: string, text: string): UiPanel {
  const win = createWindow({ title, size: 'sm', onClose: () => ctx.close() });
  const paragraphs = text.split(/\n{2,}/);
  win.body.append(h('div.mu-prose', null, paragraphs.map((p, i) => h('p', { class: i === 0 ? 'mu-dropcap' : '' }, p))));
  win.showFoot(h('div.mu-grow'), button('Close', { variant: 'primary', onClick: () => ctx.close() }));
  return panelOf({ id: `message:${++messageSeq}`, pauses: 'menu', backdropCloses: ctx }, win.el);
}

export function confirmPanel(ctx: PanelCtx, o: ConfirmOptions): UiPanel {
  const win = createWindow({ title: o.title, size: 'sm', onClose: () => { o.onCancel?.(); ctx.close(); } });
  win.body.append(h('div.mu-prose', null, o.text.split(/\n{2,}/).map((p) => h('p', null, p))));
  win.showFoot(
    h('div.mu-grow'),
    button(o.cancelLabel ?? 'Cancel', { onClick: () => { o.onCancel?.(); ctx.close(); } }),
    button(o.confirmLabel ?? 'Confirm', { variant: o.danger ? 'danger' : 'primary', onClick: () => { ctx.close(); o.onConfirm(); } }),
  );
  return panelOf({ id: `confirm:${++messageSeq}`, pauses: 'never' }, win.el, {
    key: (intent) => { if (intent.type === 'enter') { ctx.close(); o.onConfirm(); return true; } return false; },
  });
}

export function pausePanel(ctx: PanelCtx, hooks: UiHooks): UiPanel {
  const card = runCard(ctx.sim);
  const gold = levelProfile(ctx.sim.profile).legacyGold;
  const win = createWindow({ title: 'Paused', subtitle: 'The world waits', icon: 'pause', size: 'sm', onClose: () => ctx.close() });
  const abandon = (): void => {
    ctx.confirm({
      title: 'Abandon this run?',
      text: 'Your House’s story ends here. The run is over for good; there is no way back.\n\nYour score so far is recorded and the Legacy gold you have earned is kept.',
      confirmLabel: 'Yes, I may abandon it', cancelLabel: 'Keep playing', danger: true,
      onConfirm: () => ctx.confirm({
        title: 'Really abandon it?',
        text: `You will end with ${thousands(card.score)} points. This cannot be undone.`,
        confirmLabel: 'Abandon the run', cancelLabel: 'No, go back', danger: true,
        onConfirm: () => { ctx.dispatch({ type: 'abandonRun' }); },
      }),
    });
  };
  win.body.append(
    h('div.mu-col.mu-gap-8', null,
      button('Resume', { variant: 'primary', size: 'big', icon: 'play', class: 'mu-wide', onClick: () => ctx.close() }),
      button('Help and controls', { size: 'big', icon: 'help', class: 'mu-wide', onClick: () => ctx.open({ panel: 'help' }) }),
      button('Settings', { size: 'big', icon: 'cog', class: 'mu-wide', onClick: () => ctx.open({ panel: 'settings' }) }),
      button('Save and quit to menu', { size: 'big', icon: 'door', class: 'mu-wide', onClick: () => hooks.quitToMenu() }),
      button('Abandon run', { size: 'big', icon: 'skull', variant: 'danger', class: 'mu-wide', onClick: abandon }),
    ),
    h('div.mu-rule'),
    h('div.mu-row.mu-between.mu-small.mu-dim', null,
      h('span', null, icon('star', 14), ` ${thousands(card.score)} points this run`),
      h('span', null, icon('coin', 14), ` ${thousands(gold)} Legacy gold`)),
  );
  return panelOf({ id: 'pause', group: 'screen', pauses: 'always', backdropCloses: ctx }, win.el);
}

export function settingsPanel(ctx: PanelCtx): UiPanel {
  const win = createWindow({ title: 'Settings', icon: 'cog', size: 'md', onClose: () => ctx.close() });
  win.body.append(settingsBody(ctx.host, () => { /* the controller re-reads the settings each frame */ }));
  win.showFoot(h('div.mu-grow'), button('Done', { variant: 'primary', onClick: () => ctx.close() }));
  return panelOf({ id: 'settings', pauses: 'always', backdropCloses: ctx }, win.el);
}
