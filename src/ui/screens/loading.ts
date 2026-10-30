// The loading screen shown while a continent is generated: an illuminated progress bar and a hint.
import { h, textBinder } from '../core/dom';
import { pct } from '../core/format';
import { icon } from '../core/icons';
import { corners } from '../core/ornament';
import { LOADING_TIPS } from '../core/text';

export class LoadingLayer {
  readonly el = h('div.mu-loading.mu-hide');
  private readonly fill = h('i');
  private readonly bar = h('div.mu-loadbar', null, this.fill);
  private readonly labelEl = h('div.mu-loading-label');
  private readonly pctEl = h('div.mu-loading-pct.mu-num');
  private readonly tipEl = h('div.mu-loading-tip');
  private readonly setLabel = textBinder(this.labelEl);
  private readonly setPct = textBinder(this.pctEl);
  private tipTimer = 0;
  private tipIndex = 0;

  constructor() {
    this.el.append(
      h('div.mu-menu-bg'),
      h('div.mu-menu-frame', null, corners()),
      h('div.mu-loading-card', null,
        h('div.mu-crest', null, icon('crown', 30)),
        h('h1.mu-title.small', null, 'Millennia'),
        this.labelEl,
        this.bar,
        this.pctEl,
        h('div.mu-loading-tipwrap', null, h('span.mu-tip-mark', null, 'Hint'), this.tipEl),
      ),
    );
  }

  show(info?: { progress?: number; label?: string }): void {
    if (this.el.classList.contains('mu-hide')) {
      this.el.classList.remove('mu-hide');
      this.tipIndex = Math.floor(Math.random() * LOADING_TIPS.length);
      this.tipEl.textContent = LOADING_TIPS[this.tipIndex];
      this.tipTimer = 0;
    }
    this.set(info?.progress, info?.label);
  }

  hide(): void { this.el.classList.add('mu-hide'); }

  get visible(): boolean { return !this.el.classList.contains('mu-hide'); }

  set(progress?: number, label?: string): void {
    this.setLabel(label ?? 'Making the world…');
    if (progress === undefined) {
      this.bar.classList.add('indeterminate');
      this.fill.style.transform = '';
      this.setPct('');
    } else {
      this.bar.classList.remove('indeterminate');
      this.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;
      this.setPct(pct(progress));
    }
  }

  /** Rotates the hint every few seconds. */
  tick(dt: number): void {
    if (!this.visible) return;
    this.tipTimer += dt;
    if (this.tipTimer > 6.5) {
      this.tipTimer = 0;
      this.tipIndex = (this.tipIndex + 1) % LOADING_TIPS.length;
      this.tipEl.textContent = LOADING_TIPS[this.tipIndex];
    }
  }
}
