// What a panel is and what it gets from the UI: services, a way to open other panels, and
// auto-cleaned event subscriptions. Panels are small factories returning a `UiPanel`.
import type { Command, CommandResult, Simulation } from '../../sim/sim';
import type { SimEvents } from '../../sim/events';
import type { PersonId } from '../../sim/state';
import type { EconomyApi } from '../../sim/economy/types';
import type { SocialApi } from '../../sim/social/types';
import type { ZoneApi } from '../../agents/types';
import type { PlayerApi } from '../../player/types';
import type { GameServices, Settings, UiHost } from '../types';
import type { FeedKind, ToastInput } from '../core/feed';
import type { KeyIntent } from '../core/keys';
import type { ConfirmOptions, PanelRequest } from '../core/requests';
export type { ConfirmOptions };
import type { StackPanel } from '../core/stack';

export interface UiPanel extends StackPanel {
  /** The element appended to the panel layer (usually a `.mu-modal`). */
  readonly el: HTMLElement;
  /** The HUD fades out while this panel is open. */
  readonly hidesHud?: boolean;
  /** Called once the element is in the DOM. */
  mount?(): void;
  /** Every frame while open; throttle inside (`now` is the UI clock in seconds). */
  tick?(now: number): void;
  /** Panel-specific keys (digits, arrows, Enter). Return true when consumed. */
  key?(intent: KeyIntent, e: KeyboardEvent): boolean;
  /** Esc: return true to consume it (leave a sub-view) instead of closing. */
  onEscape?(): boolean;
  dispose?(): void;
}

export interface PanelCtx {
  readonly host: UiHost;
  readonly game: GameServices;
  readonly sim: Simulation;
  readonly eco: EconomyApi;
  readonly social: SocialApi;
  readonly player: PlayerApi;
  readonly zone: ZoneApi;
  playerId(): PersonId;
  settings(): Settings;
  /** The UI clock (seconds since the UI was created). */
  now(): number;
  open(req: PanelRequest): void;
  /** Close this panel. */
  close(): void;
  /** Close another open panel by id. */
  closeId(id: string): void;
  /** Subscribe to a simulation event until this panel closes. */
  listen<K extends keyof SimEvents>(type: K, fn: (e: SimEvents[K]) => void): void;
  /** Run `fn` every `ms` while this panel is open. */
  interval(ms: number, fn: () => void): void;
  /** Add a line to the HUD feed. */
  say(kind: FeedKind, text: string): void;
  toast(t: ToastInput): void;
  confirm(o: ConfirmOptions): void;
  dispatch(cmd: Command): CommandResult;
  nameOf(id: PersonId): string;
  placeName(id: number): string;
  /** Screen (client) coordinates → this UI's own coordinate space (differs when the UI is scaled). */
  toLocal(p: { x: number; y: number }): { x: number; y: number };
  /** Display wording for an item key and quantity ("3 gallons of ale", "a good sickle"). */
  describe(key: string, qty?: number): string;
}

/** Controller actions panels can trigger (leaving the game, starting over). */
export interface UiHooks {
  /** Save and return to the main menu. */
  quitToMenu(): void;
  /** Leave the finished run and go straight to the new-run screens. */
  newRun(): void;
  /** Show the birth reveal for the current character (e.g. after taking over a successor). */
  showBirth(): void;
  /** The game-over summary received while the death screen was showing (extinct line), if any. */
  pendingGameOver(): SimEvents['gameOver'] | null;
}

export type PanelFactory<R extends PanelRequest = PanelRequest> = (ctx: PanelCtx, req: R, hooks: UiHooks) => UiPanel;

/** A panel record with its cleanup list (managed by the controller). */
export interface PanelRecord { panel: UiPanel; cleanups: Array<() => void> }
