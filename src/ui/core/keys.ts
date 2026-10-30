// Keyboard → UI intent, pure. The input layer owns movement keys; the UI owns the panel keys of
// KEYMAP.ui (Tab, I, J, M, C, H, L, Z, Esc) plus menu navigation (digits, arrows, Enter).
import { KEYMAP } from '../../player/types';

export type PanelKey =
  | 'character' | 'inventory' | 'ledger' | 'map' | 'command' | 'family' | 'chronicle' | 'rest'
  | 'politics' | 'techs' | 'requests' | 'wounds' | 'help';

export type KeyIntent =
  | { type: 'toggle'; panel: PanelKey }
  | { type: 'escape' }
  | { type: 'digit'; n: number }
  | { type: 'enter' }
  | { type: 'arrow'; dir: 'up' | 'down' | 'left' | 'right' }
  | { type: 'page'; dir: 'up' | 'down' };

export interface KeyState {
  /** A text field has focus: only Esc is ours. */
  typing: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

const TOGGLES: ReadonlyArray<readonly [string, PanelKey]> = [
  [KEYMAP.ui.character, 'character'],
  [KEYMAP.ui.inventory, 'inventory'],
  [KEYMAP.ui.ledger, 'ledger'],
  [KEYMAP.ui.map, 'map'],
  [KEYMAP.ui.command, 'command'],
  [KEYMAP.ui.family, 'family'],
  [KEYMAP.ui.chronicle, 'chronicle'],
  [KEYMAP.ui.rest, 'rest'],
  [KEYMAP.ui.politics, 'politics'],
  [KEYMAP.ui.techs, 'techs'],
  [KEYMAP.ui.requests, 'requests'],
  [KEYMAP.ui.wounds, 'wounds'],
  [KEYMAP.ui.help, 'help'],
];

export function keyIntent(code: string, state: KeyState): KeyIntent | null {
  if (state.ctrl || state.alt || state.meta) return null;
  if (code === KEYMAP.ui.menu) return { type: 'escape' };
  if (state.typing) return null;
  for (const [k, panel] of TOGGLES) if (code === k) return { type: 'toggle', panel };
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  if (digit) return { type: 'digit', n: Number(digit[1]) };
  switch (code) {
    case 'Enter': case 'NumpadEnter': return { type: 'enter' };
    case 'ArrowUp': return { type: 'arrow', dir: 'up' };
    case 'ArrowDown': return { type: 'arrow', dir: 'down' };
    case 'ArrowLeft': return { type: 'arrow', dir: 'left' };
    case 'ArrowRight': return { type: 'arrow', dir: 'right' };
    case 'PageUp': return { type: 'page', dir: 'up' };
    case 'PageDown': return { type: 'page', dir: 'down' };
    default: return null;
  }
}
