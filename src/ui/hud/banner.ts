// The settlement banner: when you walk into a village or town, its name appears across the top of the screen for a
// few seconds — "DROMORE — a village in Mornia, lord: Sir Hugh of Dromore" — so you always know where you are.
// Civilization pass (docs/CIV.md §2, §6): below the name, **Rule this town** — one click puts you into the person who rules it
// (the live-as flow) — or, where you already rule, a way into the seat of government. The banner stays while the cursor is on it.
import { button } from '../components/widgets';
import { registerHudPart, type HudPartCtx } from '../core/extHud';
import { h, replace } from '../core/dom';
import { icon } from '../core/icons';
import { ruleOffer } from '../ruler/ruleTown';
import '../builder/lands.css';

export interface BannerInfo { name: string; kind: string; county: string; kingdom: string; lord: string; /** The place's id when the caller has it (else it is found by name). */ settlement?: number }

const SHOW_SECONDS = 6;

export class Banner {
  /** The banner of the HUD that was built last (the one on the screen): the HUD part below attaches the services to it. */
  static current: Banner | null = null;

  readonly el = h('div.mu-banner');
  private readonly name = h('div.mu-banner-name');
  private readonly sub = h('div.mu-banner-sub');
  private readonly act = h('div.mu-banner-act');
  private until = 0;
  private hover = false;
  private ctx: HudPartCtx | null = null;

  constructor() {
    this.el.append(h('div.mu-banner-orn', null, icon('village', 22)), h('div.mu-banner-text', null, this.name, this.sub, this.act));
    this.el.addEventListener('mouseenter', () => { this.hover = true; });
    this.el.addEventListener('mouseleave', () => { this.hover = false; });
    Banner.current = this;
  }

  /** Gives the banner the game and a way to open pages (the HUD part below). */
  attach(ctx: HudPartCtx): void { this.ctx = ctx; }

  show(info: BannerInfo, now: number): void {
    const where = info.county || info.kingdom;
    const article = /^[aeiou]/i.test(info.kind) ? 'an' : 'a';
    this.name.textContent = info.name;
    this.sub.textContent = [`${article} ${info.kind}${where ? ` in ${where}` : ''}`, info.lord ? `lord: ${info.lord}` : ''].filter(Boolean).join(', ');
    this.until = now + SHOW_SECONDS;
    this.offer(info);
    this.el.classList.remove('on');
    void this.el.offsetWidth;
    this.el.classList.add('on');
  }

  /** The "Rule this town" button, if someone rules the place and the live-as flow can take you there. */
  private offer(info: BannerInfo): void {
    const ctx = this.ctx;
    const game = ctx?.game();
    let offer: ReturnType<typeof ruleOffer> = null;
    if (ctx && game && game.realm) {
      const id = info.settlement ?? game.sim.world.settlements.find((s) => s.name === info.name && s.kind === info.kind)?.id ?? -1;
      try { offer = ruleOffer(game, id); } catch { offer = null; }
    }
    this.el.classList.toggle('act', !!offer);
    if (!offer || !ctx) { replace(this.act); return; }
    const o = offer;
    replace(this.act, button(o.label, { size: 'small', variant: 'primary', icon: 'crown', tip: o.tip, onClick: () => { this.until = 0; this.el.classList.remove('on'); ctx.open(o.request); } }),
      o.self ? null : h('span.mu-tiny.mu-dim', null, `${o.rulerName} rules it`));
  }

  update(now: number): void {
    if (this.until && this.hover) this.until = Math.max(this.until, now + 1.5);
    if (this.until && now > this.until) { this.until = 0; this.el.classList.remove('on'); }
  }

  /** Is the banner on the screen at this UI time? (The toasts move down out of its way.) */
  isOn(now: number): boolean { return this.until > now; }

  hide(): void { this.until = 0; this.el.classList.remove('on'); }
}

// The HUD builds its banner before its module parts: this part hands the banner the game and the page opener.
registerHudPart('lands.banner', (ctx) => {
  Banner.current?.attach(ctx);
  return { el: h('span.mu-hide'), update: () => undefined };
});
