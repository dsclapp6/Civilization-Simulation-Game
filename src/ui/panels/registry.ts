// Maps every panel request to the factory that builds it.
import type { PanelCtx, UiHooks, UiPanel } from '../app/panel';
import type { PanelRequest } from '../core/requests';
import { confirmPanel, messagePanel, pausePanel, settingsPanel } from './system';

export function createPanel(ctx: PanelCtx, req: PanelRequest, hooks: UiHooks): UiPanel {
  switch (req.panel) {
    case 'message': return messagePanel(ctx, req.title, req.text);
    case 'confirm': return confirmPanel(ctx, req.options);
    case 'pause': return pausePanel(ctx, hooks);
    case 'settings': return settingsPanel(ctx);
    default:
      return messagePanel(ctx, 'Not yet written', `The “${req.panel}” page is still being illuminated.`);
  }
}
