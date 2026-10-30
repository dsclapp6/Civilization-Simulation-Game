// What can be opened: the simulation's UiRequests plus the panels only the UI itself knows about
// (character sheet, inventory, pause menu, death screen…). The gallery and the key handler use these too.
import type { UiRequest } from '../../sim/actions';
import type { SimEvents } from '../../sim/events';

export interface ConfirmOptions {
  title: string;
  text: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel?: () => void;
}

export type FamilyTab = 'tree' | 'household' | 'house';
export type LedgerTab = 'holdings' | 'household' | 'obligations' | 'property' | 'ledger' | 'authority';

export type InternalRequest =
  | { panel: 'character' }
  | { panel: 'inventory' }
  | { panel: 'family'; tab?: FamilyTab }
  | { panel: 'ledger'; tab?: LedgerTab; settlement?: number }
  | { panel: 'chronicle' }
  | { panel: 'pause' }
  | { panel: 'settings' }
  | { panel: 'birth' }
  | { panel: 'death' }
  | { panel: 'gameover'; summary?: SimEvents['gameOver'] }
  | { panel: 'encounter' }
  | { panel: 'confirm'; options: ConfirmOptions };

export type PanelRequest = UiRequest | InternalRequest;

/** The hotkey-toggled panels, in the order of the HUD dock. */
export const DOCK_PANELS: ReadonlyArray<{ id: 'character' | 'inventory' | 'family' | 'ledger' | 'map' | 'chronicle' | 'rest'; label: string; key: string }> = [
  { id: 'character', label: 'Character', key: 'Tab' },
  { id: 'inventory', label: 'Inventory', key: 'I' },
  { id: 'family', label: 'Family & House', key: 'H' },
  { id: 'ledger', label: 'Ledger', key: 'J' },
  { id: 'map', label: 'Map', key: 'M' },
  { id: 'chronicle', label: 'Chronicle', key: 'L' },
  { id: 'rest', label: 'Rest', key: 'Z' },
];
