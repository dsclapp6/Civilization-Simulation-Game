// Shared plumbing for panels: wrap a window in the modal layer and describe how it behaves
// (input capture, pausing, Esc, grouping).
import type { EscapePolicy } from '../core/stack';
import { modalShell } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';

export interface PanelBase {
  id: string;
  group?: string;
  captures?: boolean;
  pauses?: 'never' | 'menu' | 'always';
  escape?: EscapePolicy;
  mode?: '' | 'clear' | 'dock-bottom' | 'dock-right';
  /** Clicking the dimmed area outside the window closes the panel. */
  backdropCloses?: PanelCtx | null;
}

export type PanelExtras = Partial<Pick<UiPanel, 'mount' | 'tick' | 'key' | 'onEscape' | 'dispose'>>;

export function panelOf(base: PanelBase, content: HTMLElement, extras: PanelExtras = {}): UiPanel {
  const el = modalShell(content, base.mode ?? '');
  const ctx = base.backdropCloses;
  if (ctx) el.addEventListener('mousedown', (e) => { if (e.target === el) ctx.close(); });
  return {
    id: base.id,
    group: base.group,
    captures: base.captures ?? true,
    pauses: base.pauses ?? 'never',
    escape: base.escape ?? 'close',
    el,
    ...extras,
  };
}

/** Throttle helper for `tick`: runs `fn` at most every `period` seconds. */
export function every(period: number, fn: (now: number) => void): (now: number) => void {
  let last = -Infinity;
  return (now) => { if (now - last >= period) { last = now; fn(now); } };
}
