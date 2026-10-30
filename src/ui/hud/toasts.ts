// Top-centre toasts: points earned, skill levels, rank changes, perks waiting. Short-lived gilded
// ribbons; a toast with an action (a perk to choose) can be clicked or confirmed with Enter.
import { h } from '../core/dom';
import type { ToastInput } from '../core/feed';
import { icon } from '../core/icons';
import type { PanelRequest } from '../core/requests';

interface Live { key: string; el: HTMLElement; input: ToastInput; born: number }

const MAX_TOASTS = 4;

export class Toasts {
  readonly el = h('div.mu-toasts');
  private live: Live[] = [];
  private seq = 0;

  constructor(private readonly open: (req: PanelRequest) => void) {}

  push(t: ToastInput, now: number): void {
    const key = t.key ?? `t${++this.seq}`;
    const existing = this.live.find((l) => l.key === key);
    if (existing) { existing.el.remove(); this.live = this.live.filter((l) => l !== existing); }
    const el = h('div.mu-toast', { class: t.tone },
      h('span.mu-toast-ico', null, icon(t.icon, 20)),
      h('div.mu-toast-text', null,
        h('div.mu-toast-title', null, t.title),
        t.text ? h('div.mu-toast-sub', null, t.text) : null,
      ),
    );
    if (t.action) {
      const a = t.action;
      el.classList.add('actionable');
      el.appendChild(h('div.mu-col.mu-gap-4', { style: { alignItems: 'center' } },
        h('button.mu-btn.small.primary', { type: 'button', onclick: () => { this.dismissKey(key); this.open(a.request); } }, a.label),
        h('span.mu-tiny.mu-dim', null, 'or press ', h('span.mu-key', null, 'Enter'))));
    }
    this.el.appendChild(el);
    this.live.push({ key, el, input: t, born: now });
    while (this.live.length > MAX_TOASTS) this.remove(this.live[0]);
  }

  /** The most recent toast that carries an action, if still showing. */
  pendingAction(): PanelRequest | null {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const a = this.live[i].input.action;
      if (a) return a.request;
    }
    return null;
  }

  dismissAction(): void {
    for (const l of [...this.live]) if (l.input.action) this.remove(l);
  }

  update(now: number): void {
    for (const l of [...this.live]) {
      const age = now - l.born;
      if (age >= l.input.ttl) this.remove(l);
      else if (age >= l.input.ttl - 0.5) l.el.classList.add('leaving');
    }
  }

  clear(): void {
    for (const l of [...this.live]) this.remove(l);
  }

  private dismissKey(key: string): void {
    const l = this.live.find((x) => x.key === key);
    if (l) this.remove(l);
  }

  private remove(l: Live): void {
    l.el.remove();
    this.live = this.live.filter((x) => x !== l);
  }
}
