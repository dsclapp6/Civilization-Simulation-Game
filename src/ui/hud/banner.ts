// The settlement banner: when you walk into a village or town, its name appears across the top of the screen for a
// few seconds — "DROMORE — a village in Mornia, lord: Sir Hugh of Dromore" — so you always know where you are.
import { h } from '../core/dom';
import { icon } from '../core/icons';

export interface BannerInfo { name: string; kind: string; county: string; kingdom: string; lord: string }

const SHOW_SECONDS = 6;

export class Banner {
  readonly el = h('div.mu-banner');
  private readonly name = h('div.mu-banner-name');
  private readonly sub = h('div.mu-banner-sub');
  private until = 0;

  constructor() {
    this.el.append(h('div.mu-banner-orn', null, icon('village', 22)), h('div.mu-banner-text', null, this.name, this.sub));
  }

  show(info: BannerInfo, now: number): void {
    const where = info.county || info.kingdom;
    const article = /^[aeiou]/i.test(info.kind) ? 'an' : 'a';
    this.name.textContent = info.name;
    this.sub.textContent = [`${article} ${info.kind}${where ? ` in ${where}` : ''}`, info.lord ? `lord: ${info.lord}` : ''].filter(Boolean).join(', ');
    this.until = now + SHOW_SECONDS;
    this.el.classList.remove('on');
    void this.el.offsetWidth;
    this.el.classList.add('on');
  }

  update(now: number): void {
    if (this.until && now > this.until) { this.until = 0; this.el.classList.remove('on'); }
  }

  /** Is the banner on the screen at this UI time? (The toasts move down out of its way.) */
  isOn(now: number): boolean { return this.until > now; }

  hide(): void { this.until = 0; this.el.classList.remove('on'); }
}
