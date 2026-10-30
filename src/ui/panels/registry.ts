// Maps every panel request to the factory that builds it.
import { SKILLS, type SkillId } from '../../core/domain';
import type { PanelCtx, UiHooks, UiPanel } from '../app/panel';
import type { PanelRequest } from '../core/requests';
import { actionsPanel } from './actions';
import { birthPanel } from './birth';
import { careerPanel, jobsPanel } from './career';
import { characterPanel } from './character';
import { deathPanel, gameOverPanel } from './death';
import { dialoguePanel } from './dialogue';
import { familyPanel } from './family';
import { helpPanel } from './help';
import { inventoryPanel } from './inventory';
import { ledgerPanel } from './ledger';
import { mapPanel } from './map';
import { perkPanel } from './perk';
import { restPanel } from './rest';
import { tradePanel } from './trade';
import { buildingPanel, chroniclePanel, encounterPanel, personPanel } from './world';
import { confirmPanel, messagePanel, pausePanel, settingsPanel } from './system';
import { extPanel } from './extRegistry';
import './ext';

export function createPanel(ctx: PanelCtx, req: PanelRequest, hooks: UiHooks): UiPanel {
  switch (req.panel) {
    case 'ext': {
      const f = extPanel(req.name);
      return f ? f(ctx, req, hooks) : messagePanel(ctx, 'Not yet written', `The “${req.name}” page is still being illuminated.`);
    }
    case 'help': return helpPanel(ctx, req.tab);
    case 'message': return messagePanel(ctx, req.title, req.text);
    case 'confirm': return confirmPanel(ctx, req.options);
    case 'pause': return pausePanel(ctx, hooks);
    case 'settings': return settingsPanel(ctx);
    case 'birth': return birthPanel(ctx);
    case 'character': return characterPanel(ctx);
    case 'perk': return (SKILLS as readonly string[]).includes(req.skill)
      ? perkPanel(ctx, req.person, req.skill as SkillId)
      : messagePanel(ctx, 'No such skill', `“${req.skill}” is not a skill.`);
    case 'rest': return restPanel(ctx);
    case 'actions': return actionsPanel(ctx);
    case 'inventory': return inventoryPanel(ctx);
    case 'dialogue': return dialoguePanel(ctx, req.conversation);
    case 'trade': return tradePanel(ctx, req.partner);
    case 'career': return careerPanel(ctx, req.person);
    case 'jobs': return jobsPanel(ctx, req.settlement);
    case 'family': return familyPanel(ctx, req.tab);
    case 'household': return familyPanel(ctx, 'household');
    case 'ledger': return ledgerPanel(ctx, req.tab, req.settlement);
    case 'property': return ledgerPanel(ctx, 'property', req.settlement);
    case 'map': return mapPanel(ctx);
    case 'encounter': return encounterPanel(ctx);
    case 'chronicle': return chroniclePanel(ctx);
    case 'building': return buildingPanel(ctx, req.id);
    case 'person': return personPanel(ctx, req.id);
    case 'death': return deathPanel(ctx, hooks);
    case 'gameover': return gameOverPanel(ctx, hooks, req.summary);
    default:
      return messagePanel(ctx, 'Not yet written', `The “${(req as { panel: string }).panel}” page is still being illuminated.`);
  }
}
