// The tooltip that follows the free cursor (CLARITY §5): what is under it, who or what it is, and what a left
// click will do — with the reason when it cannot be done. The same information as the cursor image, in words.
import type { LabelTone } from '../../core/view';
import type { HoverInfo } from '../../player/types';
import { h } from '../core/dom';
import { distanceText } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { CATEGORY_ICON } from '../core/iconMap';
import type { ActionCategory } from '../../sim/actions';

const TONE_CLASS: Partial<Record<LabelTone, string>> = {
  kin: 'kin', household: 'household', friend: 'friend', rival: 'foe', enemy: 'foe', lord: 'lord', clergy: 'clergy', quest: 'kin',
};

/** The pointer must rest on a thing this long (UI seconds) before its card appears; bare ground waits longer. */
const SHOW_AFTER = 0.14;
const GROUND_AFTER = 0.9;

export class HoverCard {
  readonly el = h('div.mu-hover.mu-hide');
  private readonly ico = h('span.mu-hover-ico');
  private readonly name = h('div.mu-hover-name');
  private readonly sub = h('div.mu-hover-sub.mu-hide');
  private readonly act = h('div.mu-hover-act');
  private readonly actLabel = h('b');
  private readonly actNote = h('span.mu-hover-note');
  private readonly dist = h('span.mu-hover-dist');
  private readonly head = h('div.mu-hover-head', null, this.ico, h('div.mu-hover-names', null, this.name, this.sub), this.dist);
  private version = -1;
  private since = 0;
  private sinceVersion = -1;
  private visible = false;

  constructor() {
    this.act.append(icon('mouse_l', 17, 'mu-hover-mouse'), this.actLabel, this.actNote);
    this.el.append(this.head, this.act);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.add('mu-hide');
    this.sinceVersion = -1;
  }

  /** `x`,`y` are in interface pixels (already divided by the interface scale); `w`,`hh` the interface size. */
  update(info: HoverInfo | null, now: number, x: number, y: number, w: number, hh: number): void {
    if (!info) { this.hide(); return; }
    const bare = info.target.kind === 'ground';
    if (info.version !== this.sinceVersion) { this.sinceVersion = info.version; this.since = now; }
    if (now - this.since < (bare ? GROUND_AFTER : SHOW_AFTER)) { if (this.visible) this.hide(); return; }
    if (info.version !== this.version || !this.visible) this.paint(info, bare);
    if (!this.visible) { this.visible = true; this.el.classList.remove('mu-hide'); }
    const tw = this.el.offsetWidth, th = this.el.offsetHeight;
    let px = x + 18, py = y + 22;
    if (px + tw + 8 > w) px = Math.max(8, x - tw - 14);
    if (py + th + 8 > hh) py = Math.max(8, y - th - 14);
    this.el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
  }

  private paint(info: HoverInfo, bare: boolean): void {
    this.version = info.version;
    const cat = info.category as ActionCategory;
    const ic: IconName = bare ? 'boot' : info.category ? CATEGORY_ICON[cat] ?? 'hand' : info.target.kind === 'person' ? 'user' : 'pin';
    this.ico.replaceChildren(icon(ic, 17));
    this.el.className = `mu-hover ${info.enabled ? '' : 'off'} ${bare ? 'bare' : ''} ${(info.tone && TONE_CLASS[info.tone]) ?? ''}`.replace(/\s+/g, ' ').trim();
    this.name.textContent = bare ? 'Open ground' : info.label;
    this.sub.textContent = info.sublabel;
    this.sub.classList.toggle('mu-hide', !info.sublabel);
    this.dist.textContent = info.distance >= 4 ? distanceText(info.distance) : '';
    if (bare) {
      this.actLabel.textContent = info.enabled ? 'Walk here' : '';
      this.actNote.textContent = info.enabled ? '' : info.preview;
    } else if (info.action) {
      this.actLabel.textContent = info.action;
      // "Talk · your sister" under a name that already says "your sister" is the same thing twice
      const again = info.preview !== '' && info.sublabel.toLowerCase().includes(info.preview.toLowerCase());
      this.actNote.textContent = again ? '' : info.preview;
    } else {
      this.actLabel.textContent = info.enabled ? 'Walk up to it' : '';
      this.actNote.textContent = info.enabled ? '' : info.preview;
    }
    this.act.classList.toggle('mu-hide', !this.actLabel.textContent && !this.actNote.textContent);
  }
}
