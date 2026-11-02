// A toast for the news that matters (docs/CIV.md §10): when a neighbour builds a wall, raises an army or declares war, and the realm
// reads the threat to your House at half or more (`news` event, `threat` ≥ 0.5), a ribbon says so and, if you rule something, links
// to the Rivals page of the seat of government. A HUD part (src/ui/core/extHud.ts) of its own: the UI's toast queue is the UI
// controller's, and a news deed is not worth taking a place from the rest.
import { SEASON_NAMES, toDate } from '../../core/time';
import type { SimEvents } from '../../sim/events';
import { button } from '../components/widgets';
import { registerHudPart, type HudPart, type HudPartCtx } from '../core/extHud';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { NEWS_ICON, newsToastKey, newsToastWorthy, threatWords } from './rulerModel';
import type { NewsKind } from '../../sim/realm/types';

const TTL = 10;
const MAX_LIVE = 2;

interface Live { key: string; el: HTMLElement; until: number }

export class NewsToasts implements HudPart {
  readonly el = h('div.mu-toasts.mu-news-toasts');
  private live: Live[] = [];
  private off: (() => void) | null = null;
  private bound: object | null = null;
  private now = 0;

  constructor(private readonly ctx: HudPartCtx) {}

  update(now: number): void {
    this.now = now;
    const game = this.ctx.game();
    if (!game || !game.realm) { this.unbind(); this.clearAll(); return; }
    if (this.bound !== game.sim) {
      this.unbind();
      this.bound = game.sim;
      this.off = game.sim.events.on('news', (n) => { try { this.onNews(n); } catch (err) { console.error('news toast failed', err); } });
    }
    for (const l of [...this.live]) if (now >= l.until) this.remove(l);
  }

  /** Makes the ribbon for one piece of news (public for tests and tools). */
  onNews(n: SimEvents['news']): void {
    if (!newsToastWorthy(n)) return;
    const game = this.ctx.game();
    if (!game) return;
    const key = newsToastKey(n);
    if (this.live.some((l) => l.key === key)) return;
    const sim = game.sim;
    const house = sim.state.houses.get(n.house);
    const t = threatWords(n.threat);
    const d = toDate(Math.floor(sim.absDay));
    const canRule = !!game.realm?.canRule(sim.state.run.playerId);
    const el = h('div.mu-toast.vermilion', { 'data-news': String(n.id) },
      h('span.mu-toast-ico', null, icon(NEWS_ICON[n.kind as NewsKind] ?? 'warning', 20)),
      h('div.mu-toast-text', null,
        h('div.mu-toast-title', null, house ? `House ${house.name}: ${t.word.toLowerCase()}` : 'News of a neighbour'),
        h('div.mu-toast-sub', null, n.text),
        h('div.mu-toast-sub.mu-dim', null, `${SEASON_NAMES[d.season]} ${d.dayOfSeason}, Year ${d.year}`)));
    if (canRule) {
      el.classList.add('actionable');
      el.append(button('Rivals', { size: 'small', variant: 'primary', icon: 'shield', tip: 'The seat of government, on its Rivals page', onClick: () => {
        this.remove({ key, el, until: 0 });
        this.ctx.open({ panel: 'ext', name: 'ruler', data: { page: 'rivals', house: n.house } });
      } }));
    }
    this.el.appendChild(el);
    this.live.push({ key, el, until: this.now + TTL });
    while (this.live.length > MAX_LIVE) this.remove(this.live[0]);
  }

  private remove(l: Live): void {
    l.el.remove();
    this.live = this.live.filter((x) => x.key !== l.key);
  }

  private clearAll(): void { for (const l of [...this.live]) this.remove(l); }

  private unbind(): void { this.off?.(); this.off = null; this.bound = null; }

  dispose(): void { this.unbind(); this.clearAll(); }
}

registerHudPart('ruler.news', (ctx) => new NewsToasts(ctx));
