// The lord's agenda (src/ui/core/agenda.ts): the matters of the realm that want his decision, dangers first, each opening the page where
// it is decided; nothing for someone who rules nothing.
import { describe, expect, it } from 'vitest';
import { installRealm } from '../../src/sim/realm';
import { realmAgenda } from '../../src/ui/core/agenda';
import type { GameServices } from '../../src/ui/types';
import { objSim, playerOf } from '../sim/objectives/helpers';
import { readSettings } from '../../src/app/settings';
import { newProfile } from '../../src/sim/legacy';

function lordGame(seed: string): { game: GameServices; o: ReturnType<typeof objSim> } {
  const o = objSim({ seed, preset: 'small', start: 'lord', install: false });
  const realm = installRealm(o.sim, o.deps);
  const game = { sim: o.sim, realm, construction: o.sim.services.construction } as unknown as GameServices;
  return { game, o };
}

describe('the lord\'s agenda', () => {
  it('is empty for someone who rules nothing, and lists the realm\'s matters for a lord', () => {
    const born = objSim({ seed: 'ag-b', preset: 'small', install: false });
    const realm0 = installRealm(born.sim, born.deps);
    expect(realmAgenda({ sim: born.sim, realm: realm0 } as unknown as GameServices)).toEqual([]);

    const { game, o } = lordGame('ag-a');
    const me = playerOf(o.sim);
    const v = game.realm!.view(me.id)!;
    // a purse run dry is a matter for the seat's overview
    o.sim.state.households.get(v.household)!.purse = 10;
    const items = realmAgenda(game);
    const thin = items.find((i) => i.key === 'treasury');
    expect(thin, items.map((i) => i.key).join(',')).toBeTruthy();
    expect(thin!.open).toEqual({ panel: 'ext', name: 'ruler', data: { page: 'overview' } });
  });

  it('puts dangers first and sends them to the page where they are met', () => {
    const { game, o } = lordGame('ag-c');
    const me = playerOf(o.sim);
    const v = game.realm!.view(me.id)!;
    const sid = v.settlements[0];
    o.sim.services.military = {
      armies: () => [{ id: 7, house: v.house + 99, commander: 1, x: 0, z: 0, troops: { levy: 20 }, task: 'raid', target: { x: 0, z: 0, settlement: sid } }],
      raise: () => 0, armyOf: () => 0,
    } as never;
    o.sim.state.households.get(v.household)!.purse = 10;
    const items = realmAgenda(game);
    expect(items[0].tone).toBe('danger');
    expect(items[0].key).toBe('army:7');
    expect(items[0].text).toMatch(/Raiders burn .* \(20 men\)/);
    expect(items[0].open).toEqual({ panel: 'ext', name: 'ruler', data: { page: 'military' } });
    // dangers sort ahead of the plain matters
    const tones = items.map((i) => i.tone);
    expect(tones).toEqual([...tones].sort((a, b) => ['danger', 'warn', 'info'].indexOf(a) - ['danger', 'warn', 'info'].indexOf(b)));
  });

  it('lists a petition waiting on the lord, opening the petitions page', () => {
    const { game, o } = lordGame('ag-d');
    const me = playerOf(o.sim);
    o.sim.services.politics = { strength: () => 1, petitions: () => [{ id: 1, from: me.id, kind: 'relief', place: 0 }] } as never;
    const p = realmAgenda(game).find((i) => i.key === 'petition');
    expect(p).toBeTruthy();
    expect(p!.open).toEqual({ panel: 'ext', name: 'politics', data: { tab: 'petitions' } });
  });
});

describe('the compact HUD setting', () => {
  it('is off by default, and is read back from the profile', () => {
    const prof = newProfile();
    expect(readSettings(prof).compactHud).toBe(false);
    prof.settings = { compactHud: true };
    expect(readSettings(prof).compactHud).toBe(true);
  });
});
