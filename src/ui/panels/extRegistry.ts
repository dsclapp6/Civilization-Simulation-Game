// Registry for panels added by later modules (`{ panel: 'ext', name }` requests). Kept apart from
// registry.ts so module panel files can import it without an import cycle.
import type { PanelCtx, UiHooks, UiPanel } from '../app/panel';

export type ExtPanelFactory = (ctx: PanelCtx, req: { name: string; id?: number; data?: unknown }, hooks: UiHooks) => UiPanel;
const extPanels = new Map<string, ExtPanelFactory>();

/** Wave 3 modules add their panels here (each in src/ui/panels/<module>.ts, imported from ./ext.ts). */
export function registerPanel(name: string, factory: ExtPanelFactory): void { extPanels.set(name, factory); }

export function extPanel(name: string): ExtPanelFactory | undefined { return extPanels.get(name); }
