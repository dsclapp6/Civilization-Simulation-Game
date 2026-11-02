// Civilization pass, wave B (docs/CIV.md §4, §9): HUD parts and hotkeys that modules add from their own UI files
// (src/ui/hud/law.ts, src/ui/hud/battle.ts) without editing the HUD or the key dispatch. Each file registers itself when it
// is imported (one import line each in src/ui/panels/ext.ts, like the module panels).
//   registerHudPart(name, factory): the part's element goes into the HUD when the HUD is built; `update(now)` runs every
//     frame while a game is bound (throttle inside; `now` is the UI clock in seconds).
//   registerHotkey(code, handler): asked before the UI's own keys while the game screen is up, nothing is typed into and no
//     screen/conversation holds the keyboard; return true to consume the key (digits 4–7 and C while commanding in battle).
import type { GameServices, UiHost } from '../types';
import type { PanelRequest } from './requests';

export interface HudPartCtx {
  game(): GameServices | null;
  host: UiHost;
  open(req: PanelRequest): void;
  isOpen(id: string): boolean;
  say(kind: 'info' | 'warn', text: string): void;
  /** Screen pixels per interface pixel (the interface scale setting). */
  scale(): number;
}

export interface HudPart {
  readonly el: HTMLElement;
  update(now: number): void;
  dispose?(): void;
}

export type HudPartFactory = (ctx: HudPartCtx) => HudPart;
export type HotkeyHandler = (code: string, e: KeyboardEvent, ctx: HudPartCtx) => boolean;

const parts = new Map<string, HudPartFactory>();
const hotkeys: Array<{ code: string; fn: HotkeyHandler }> = [];

export function registerHudPart(name: string, factory: HudPartFactory): void { parts.set(name, factory); }
export function registerHotkey(code: string, fn: HotkeyHandler): void { hotkeys.push({ code, fn }); }
export function hudPartFactories(): ReadonlyMap<string, HudPartFactory> { return parts; }

/** True when a registered handler consumed the key. A failing handler is logged and skipped. */
export function runHotkeys(code: string, e: KeyboardEvent, ctx: HudPartCtx): boolean {
  for (const k of hotkeys) {
    if (k.code !== code) continue;
    try {
      if (k.fn(code, e, ctx)) return true;
    } catch (err) {
      console.error(`hotkey ${code} failed`, err);
    }
  }
  return false;
}
