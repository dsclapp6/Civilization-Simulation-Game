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
export type JournalTab = 'objectives' | 'today' | 'people' | 'places';
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
  | { panel: 'help'; tab?: 'controls' | 'basics' | 'combat' | 'realm' }
  /** Clarity pass: the journal (objectives, today, people you know, places), the day summary card and the scene-setting intro. */
  | { panel: 'journal'; tab?: JournalTab }
  | { panel: 'daysummary'; day?: number }
  | { panel: 'intro' }
  /** The camera tour; `stop` shows only that stop (0 = home, 1 = strip, 2 = church) and holds it (tools and tests). */
  | { panel: 'tour'; stop?: number }
  | { panel: 'confirm'; options: ConfirmOptions };

export type PanelRequest = UiRequest | InternalRequest;

/** Which module a dock button needs: it is hidden while the module is not installed in this run. */
export type DockNeeds = 'politics' | 'military' | 'advancement' | 'happenings' | 'combat';

export interface DockEntry {
  id: string;
  label: string;
  key: string;
  /** The panel id the stack knows it by (for the pressed look and toggling). */
  panelId: string;
  request: PanelRequest;
  needs?: DockNeeds;
  /** 'realm' entries sit after a divider. */
  group: 'core' | 'realm';
}

/** The hotkey-toggled panels, in the order of the HUD dock: the book of the self, then the realm. */
export const DOCK_ENTRIES: readonly DockEntry[] = [
  { id: 'journal', label: 'Journal: tasks, the day, people, places', key: 'O', panelId: 'journal', request: { panel: 'journal' }, group: 'core' },
  { id: 'character', label: 'Character', key: 'Tab', panelId: 'character', request: { panel: 'character' }, group: 'core' },
  { id: 'inventory', label: 'Inventory', key: 'I', panelId: 'inventory', request: { panel: 'inventory' }, group: 'core' },
  { id: 'family', label: 'Family & House', key: 'H', panelId: 'family', request: { panel: 'family' }, group: 'core' },
  { id: 'ledger', label: 'Ledger', key: 'J', panelId: 'ledger', request: { panel: 'ledger' }, group: 'core' },
  { id: 'map', label: 'Map', key: 'M', panelId: 'map', request: { panel: 'map' }, group: 'core' },
  { id: 'chronicle', label: 'Chronicle', key: 'L', panelId: 'chronicle', request: { panel: 'chronicle' }, group: 'core' },
  { id: 'rest', label: 'Rest', key: 'Z', panelId: 'rest', request: { panel: 'rest' }, group: 'core' },
  { id: 'requests', label: 'Requests and news', key: 'R', panelId: 'requests', request: { panel: 'ext', name: 'requests' }, needs: 'happenings', group: 'realm' },
  { id: 'wounds', label: 'Wounds', key: 'B', panelId: 'wounds', request: { panel: 'ext', name: 'wounds' }, needs: 'combat', group: 'realm' },
  { id: 'techs', label: 'House techniques', key: 'T', panelId: 'techs', request: { panel: 'ext', name: 'techs' }, needs: 'advancement', group: 'realm' },
  { id: 'politics', label: 'Realm and politics', key: 'K', panelId: 'politics', request: { panel: 'ext', name: 'politics' }, needs: 'politics', group: 'realm' },
  { id: 'army', label: 'Command and army', key: 'C', panelId: 'army', request: { panel: 'ext', name: 'army' }, needs: 'military', group: 'realm' },
];

/** The panel a hotkey toggles. `C` is the army when the military module is there, else the household page. */
export function panelForKey(key: string, has: (needs: DockNeeds) => boolean): { request: PanelRequest; panelId: string } | null {
  switch (key) {
    case 'character': case 'inventory': case 'family': case 'chronicle': case 'rest': return { request: { panel: key }, panelId: key };
    case 'ledger': return { request: { panel: 'ledger' }, panelId: 'ledger' };
    case 'map': return { request: { panel: 'map' }, panelId: 'map' };
    case 'command': return has('military') ? { request: { panel: 'ext', name: 'army' }, panelId: 'army' } : { request: { panel: 'ledger', tab: 'household' }, panelId: 'ledger' };
    case 'politics': case 'techs': case 'requests': case 'wounds': {
      const e = DOCK_ENTRIES.find((d) => d.id === key);
      return e && (!e.needs || has(e.needs)) ? { request: e.request, panelId: e.panelId } : null;
    }
    case 'help': return { request: { panel: 'help' }, panelId: 'help' };
    case 'journal': return { request: { panel: 'journal' }, panelId: 'journal' };
    // civilization pass (wave B registers these ext panels: src/ui/builder, src/ui/ruler, the live-as flow)
    case 'builder': return { request: { panel: 'ext', name: 'builder' }, panelId: 'builder' };
    case 'ruler': return { request: { panel: 'ext', name: 'ruler' }, panelId: 'ruler' };
    case 'liveAs': return { request: { panel: 'ext', name: 'liveAs' }, panelId: 'liveAs' };
    default: return null;
  }
}
