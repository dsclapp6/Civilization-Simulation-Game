// The parchment window frame every panel uses: double-ruled border, gilded corners, a title bar with a
// close button, a scrolling body and an optional footer.
import { h } from '../core/dom';
import { icon, type IconName } from '../core/icons';
import { corners } from '../core/ornament';

export interface WindowOptions {
  title: string;
  subtitle?: string;
  icon?: IconName;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  tall?: boolean;
  /** Close button handler; omit for windows that must be answered (death, birth). */
  onClose?: () => void;
  /** No scrolling body padding (for windows that manage their own layout). */
  flush?: boolean;
}

export interface WindowParts {
  el: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  titleEl: HTMLElement;
  subEl: HTMLElement;
  setTitle(title: string, subtitle?: string): void;
  /** Show the footer (hidden until something is put in it). */
  showFoot(...children: Array<Node | string>): HTMLElement;
}

export function createWindow(o: WindowOptions): WindowParts {
  const titleEl = h('h2', null, o.title);
  const subEl = h('span.mu-win-sub', o.subtitle ?? '');
  if (!o.subtitle) subEl.classList.add('mu-hide');
  const head = h('header.mu-win-head', null,
    o.icon ? h('span.mu-win-ico', null, icon(o.icon, 22)) : null,
    titleEl, subEl,
    o.onClose ? h('button.mu-x', { type: 'button', 'aria-label': 'Close', tip: 'Close (Esc)', onclick: o.onClose }, icon('cross', 15)) : null,
  );
  const body = h('div.mu-win-body', { class: o.flush ? 'flush' : '' });
  const foot = h('footer.mu-win-foot.mu-hide');
  const el = h('section.mu-win', { class: `${o.size ?? 'md'}${o.tall ? ' tall' : ''}`, role: 'dialog', 'aria-label': o.title }, corners(), head, body, foot);
  return {
    el, head, body, foot, titleEl, subEl,
    setTitle(title, subtitle) {
      titleEl.textContent = title;
      if (subtitle !== undefined) { subEl.textContent = subtitle; subEl.classList.toggle('mu-hide', !subtitle); }
    },
    showFoot(...children) {
      foot.classList.remove('mu-hide');
      foot.replaceChildren(...children.map((c) => (typeof c === 'string' ? document.createTextNode(c) : c)));
      return foot;
    },
  };
}

/** Wraps a window in the dimmed, centred modal layer element. */
export function modalShell(win: HTMLElement, mode: '' | 'clear' | 'dock-bottom' | 'dock-right' = ''): HTMLElement {
  return h('div.mu-modal', { class: mode }, win);
}
