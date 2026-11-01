// The sound director: listens to the game and asks the synthesiser for the right effect — the swing of the tool the
// player is working with, coins on a trade, the level-up chime, a task done, the church bell at Mass (louder the
// nearer the church), and a soft click on interface buttons.
import { isHolyDay } from '../../sim/calendar';
import type { SimEvents } from '../../sim/events';
import { carry, massBellDay, workSound } from '../core/soundModel';
import type { GameServices, UiHost } from '../types';
import { Sfx } from './sfx';

const CLICKABLE = '.mu-btn, .mu-dockbtn, .mu-tab, .mu-hud-speed, .mu-jrow, .mu-whatnow-row, .mu-minimap-btn, .mu-seg button, .mu-switch, .mu-x';
const BELL_REACH = 520;

export class SoundDirector {
  readonly sfx = new Sfx();
  private game: GameServices | null = null;
  private offs: Array<() => void> = [];
  private nextWork = 0;
  private lastWorkAnim = '';
  private bellDay = -1;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly host: UiHost, root: HTMLElement) {
    const wake = (): void => this.sfx.unlock();
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
    this.cleanups.push(() => { window.removeEventListener('pointerdown', wake, true); window.removeEventListener('keydown', wake, true); });
    // a soft tick on every button of the interface
    const onClick = (e: Event): void => {
      const t = e.target as Element | null;
      if (t && t.closest && t.closest(CLICKABLE)) this.sfx.play('click', 1);
    };
    root.addEventListener('click', onClick, true);
    this.cleanups.push(() => root.removeEventListener('click', onClick, true));
  }

  /** A run starts (or ends: null). */
  bind(game: GameServices | null): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.game = game;
    this.nextWork = 0;
    this.bellDay = -1;
    if (!game) return;
    const ev = game.sim.events;
    const me = (): number => game.sim.state.run.playerId;
    const guard = <K extends keyof SimEvents>(type: K, fn: (e: SimEvents[K]) => void): void => {
      this.offs.push(ev.on(type, (e) => { try { fn(e); } catch (err) { console.error(`sound handler failed (${String(type)})`, err); } }));
    };
    guard('trade', (e) => { if (e.buyer === me() || e.seller === me()) this.sfx.play('coins', 0.9); });
    guard('skillLevel', (e) => { if (e.person === me()) this.sfx.play('chime', 1); });
    guard('rankChanged', (e) => { if (e.person === me()) this.sfx.play('chime', 1, 0.8); });
    guard('objective', (e) => { if (e.phase === 'done') this.sfx.play('ding', 1); else if (e.phase === 'added') this.sfx.play('ding', 0.5, 0.7); });
    guard('action', (e) => {
      if (e.actor !== me() || e.type !== 'completed' || !e.outcome.ok) return;
      if (e.outcome.gains?.some((g) => g.ref === 'money' && (g.amount ?? 0) > 0)) this.sfx.play('coins', 0.55, 1.1, 0.12);
    });
  }

  /** Every frame (UI clock `now`, seconds). */
  update(now: number): void {
    this.sfx.volume = this.host.settings().volume;
    const game = this.game;
    if (!game) return;
    const sim = game.sim;
    const clock = sim.view.clock();
    if (clock.paused || clock.skipping) { this.nextWork = 0; return; }
    // the tool the player is swinging
    const a = sim.actions.active(sim.state.run.playerId);
    const w = a && a.option.seconds > 0 ? workSound(a.option.anim) : null;
    if (w && a) {
      if (a.option.anim !== this.lastWorkAnim || this.nextWork === 0) { this.lastWorkAnim = a.option.anim ?? ''; this.nextWork = now + w.period * 0.55; }
      if (now >= this.nextWork) {
        this.sfx.play(w.sfx, w.gain, 0.94 + Math.random() * 0.12);
        this.nextWork = now + w.period;
      }
    } else this.nextWork = 0;
    // the bell for Mass
    const day = massBellDay(sim.absDay, isHolyDay(sim.absDay));
    if (day >= 0 && day !== this.bellDay) {
      this.bellDay = day;
      const near = this.churchDistance(game);
      const g = carry(near, BELL_REACH);
      if (g > 0.02) for (let i = 0; i < 3; i++) this.sfx.play('bell', 0.9 * g, 1, i * 1.5);
    }
  }

  /** Metres to the nearest church from the player. */
  private churchDistance(game: GameServices): number {
    const body = game.player.body();
    if (!body) return Infinity;
    const s = game.sim.world.nearestSettlement(body.x, body.z);
    let best = Infinity;
    for (const b of game.sim.state.buildingsAt.get(s.id) ?? []) {
      if (b.kind === 'church' || b.kind === 'abbey_church' || b.kind === 'cathedral' || b.kind === 'chapel') best = Math.min(best, Math.hypot(b.x - body.x, b.z - body.z));
    }
    return best;
  }

  dispose(): void {
    for (const off of this.offs) off();
    for (const c of this.cleanups) c();
    this.offs = [];
  }
}
