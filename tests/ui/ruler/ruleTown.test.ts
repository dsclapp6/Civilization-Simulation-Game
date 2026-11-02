// "Rule this town": the request the banner, the map's settlement card, the ruler's lists and the builder's card all open, and that it
// lands on the live-as panel registered by the other builder — tested against a fake registration, and against the real realm.
import { describe, expect, it } from 'vitest';
import type { PanelCtx, UiHooks, UiPanel } from '../../../src/ui/app/panel';
import { extPanel, registerPanel } from '../../../src/ui/panels/extRegistry';
import { ruleOffer, ruleRequest } from '../../../src/ui/ruler/ruleTown';
import type { GameServices } from '../../../src/ui/types';
import { realmSim } from '../../sim/realm/helpers';

function setup(opts: { keepPlayer?: boolean } = {}) {
  const s = realmSim({ seed: 'ui-rule-1', politics: true, military: true, keepPlayer: opts.keepPlayer ?? true });
  const game = { sim: s.sim, realm: s.realm } as unknown as GameServices;
  const settlement = s.sim.world.settlements.find((x) => x.kind === 'village' && s.sim.state.titleFor('manor', x.id))!;
  return { ...s, game, settlement };
}

describe('Rule this town', () => {
  it('asks the live-as panel for the person who rules the place, because the town asks to be ruled', () => {
    const { game, settlement, realm, sim } = setup();
    const offer = ruleOffer(game, settlement.id)!;
    expect(offer).toBeTruthy();
    const ruler = realm.rulerOf(settlement.id);
    expect(offer.ruler).toBe(ruler);
    expect(offer.self).toBe(false);
    expect(offer.request).toEqual({ panel: 'ext', name: 'liveAs', id: ruler, data: { reason: 'rule' } });
    expect(offer.request).toEqual(ruleRequest(ruler));
    expect(offer.label).toBe(`Rule ${settlement.name}`);
    expect(offer.tip).toContain(offer.rulerName);
    expect(offer.tip).toContain(settlement.name);
    expect(sim.canSwitchTo(ruler)).toBe(true);
  });

  it('lands on the registered live-as panel with the person and the reason (a fake registration)', () => {
    const { game, settlement } = setup();
    const seen: Array<{ name: string; id?: number; data?: unknown }> = [];
    registerPanel('liveAs', (_ctx, req) => { seen.push(req); return { id: 'liveAs', captures: true, pauses: 'never', escape: 'close', el: {} } as unknown as UiPanel; });
    const offer = ruleOffer(game, settlement.id)!;
    const req = offer.request as { panel: 'ext'; name: string; id?: number; data?: unknown };
    const factory = extPanel(req.name);
    expect(factory).toBeTypeOf('function');
    const panel = factory!({} as PanelCtx, req, {} as UiHooks);
    expect(panel.id).toBe('liveAs');
    expect(seen).toEqual([{ panel: 'ext', name: 'liveAs', id: offer.ruler, data: { reason: 'rule' } }]);
  });

  it('opens the seat of government instead when you already rule the place', () => {
    const { game, settlement, realm, sim } = setup();
    const ruler = realm.rulerOf(settlement.id);
    sim.switchTo(ruler);
    const offer = ruleOffer(game, settlement.id)!;
    expect(offer.self).toBe(true);
    expect(offer.request).toEqual({ panel: 'ext', name: 'ruler' });
    expect(offer.label).toMatch(/seat of government/i);
  });

  it('offers nothing where no one rules, the ruler cannot be taken, or there is no realm', () => {
    const { game, settlement, realm, sim } = setup();
    expect(ruleOffer({ sim, realm: undefined } as unknown as GameServices, settlement.id)).toBeNull();
    expect(ruleOffer(game, -1)).toBeNull();
    expect(ruleOffer(game, 99999)).toBeNull();
    // a dead ruler is not offered
    const ruler = sim.state.persons.get(realm.rulerOf(settlement.id))!;
    const fake = { sim, realm: { ...realm, rulerOf: () => ruler.id } } as unknown as GameServices;
    expect(ruleOffer(fake, settlement.id)).not.toBeNull();
    ruler.death = { day: 1, cause: 'old_age' };
    expect(ruleOffer(fake, settlement.id)).toBeNull();
  });

  it('names a regent or a steward for what he is', () => {
    const { game, settlement, realm } = setup();
    const rules = realm.rules?.(realm.rulerOf(settlement.id)) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    const offer = ruleOffer(game, settlement.id)!;
    expect(offer.role.length).toBeGreaterThan(2);
  });
});
