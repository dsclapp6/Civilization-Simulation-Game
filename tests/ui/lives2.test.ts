// Civilization pass, B6 (lives UI), part 2: the accolade, the wheel's "Live as" and its icons, the settings key.
import { describe, expect, it } from 'vitest';
import type { ChronicleEntry } from '../../src/sim/state';
import type { ActionOption } from '../../src/sim/actions';
import { accoladeScene, classifyAccolade, isKnighting } from '../../src/ui/core/accolade';
import { optionIcon } from '../../src/ui/core/iconMap';
import { ICON_NAMES } from '../../src/ui/core/icons';
import { LIVE_AS_OPTION_ID, LIVE_AS_PROVIDER_ID, liveAsProvider } from '../../src/ui/core/liveAsAction';
import { DEFAULT_SETTINGS } from '../../src/ui/types';
import { readSettings } from '../../src/app/settings';
import { rig } from '../player/fakes';

const entry = (text: string, persons: number[], kind = 'career'): ChronicleEntry => ({ day: 5, kind, text, persons } as ChronicleEntry);

describe('the accolade', () => {
  it('knows a knighting from the career a person changed to', () => {
    expect(isKnighting({ to: 'knight' })).toBe(true);
    expect(isKnighting({ to: 'sergeant' })).toBe(false);
  });

  it('reads how it came from the line the chronicle wrote', () => {
    const me = 10;
    expect(classifyAccolade([entry('Wat was knighted for valour in the service of House Avenel.', [10])], 10, me, 'sergeant')).toEqual({ kind: 'valour', knight: 10, by: 0 });
    expect(classifyAccolade([entry('Hugh Avenel has been knighted by his liege.', [10, 10])], 10, me, 'squire')).toEqual({ kind: 'liege', knight: 10, by: 0 });
    expect(classifyAccolade([entry('Sir Ralph has dubbed Wat knight.', [10, 20])], 10, me, 'squire')).toEqual({ kind: 'lord', knight: 10, by: 20 });
    // the player's own hand: one of their men
    expect(classifyAccolade([entry('Hugh has dubbed Wat knight.', [33, 10])], 33, 10, 'squire')).toEqual({ kind: 'player', knight: 33, by: 10 });
    // other people's chronicle lines and other kinds are not about this knight
    expect(classifyAccolade([entry('Gil has dubbed Hob knight.', [7, 8]), entry('Wat died.', [10], 'death')], 10, me, 'sergeant')).toEqual({ kind: 'valour', knight: 10, by: 0 });
    expect(classifyAccolade([], 10, me, 'squire')).toEqual({ kind: 'lord', knight: 10, by: 0 });
  });

  it('tells the vigil and the accolade, for the player and for one of their men', () => {
    const r = rig({ preset: 'small' });
    const me = r.sim.state.persons.get(r.pid)!;
    me.sex = 'm';
    const place = r.sim.world.settlements.find((s) => s.id === me.settlement)!.name;
    const a = accoladeScene(r.sim, { kind: 'lord', knight: r.pid, by: 0 })!;
    expect(a.title).toBe('The accolade');
    expect(a.beats).toHaveLength(3);
    expect(a.beats.join(' ')).toContain(`the church of ${place}`);
    expect(a.beats.join(' ')).toMatch(/vigil/);
    expect(a.beats.join(' ')).toMatch(/shoulders/);
    expect(a.arise).toBe(`Arise, Sir ${me.first}.`);
    expect(a.name).toBe(`Sir ${me.first}${me.byname ? ` ${me.byname}` : ''}`);
    const v = accoladeScene(r.sim, { kind: 'valour', knight: r.pid, by: 0 })!;
    expect(v.title).toBe('Knighted on the field');
    expect(v.beats.join(' ')).toMatch(/battle is won/i);
    const l = accoladeScene(r.sim, { kind: 'liege', knight: r.pid, by: 0 })!;
    expect(l.title).toBe('Knighted by your liege');
    expect(l.by).toBe('your liege');
    // one of the player's men
    const other = [...r.sim.state.persons.values()].find((p) => !p.death && p.id !== r.pid && p.sex === 'm')!;
    const p = accoladeScene(r.sim, { kind: 'player', knight: other.id, by: r.pid })!;
    expect(p.title).toBe(`You make ${other.first} a knight`);
    expect(p.beats.join(' ')).toContain('you laid the sword');
    expect(p.arise).toBe(`Arise, Sir ${other.first}.`);
    expect(accoladeScene(r.sim, { kind: 'lord', knight: 99999999, by: 0 })).toBeNull();
  });
});

describe('"Live as" in the action wheel', () => {
  it('is offered on every other living person, never as the default, and opens the card', () => {
    const r = rig({ preset: 'small' });
    const provider = liveAsProvider();
    const unregister = r.sim.actions.register(provider);
    const other = [...r.sim.state.persons.values()].find((p) => !p.death && p.id !== r.pid)!;
    const list = r.sim.actions.list(r.pid, { kind: 'person', id: other.id });
    const o = list.find((x) => x.id === LIVE_AS_OPTION_ID)!;
    expect(o).toBeDefined();
    expect(o.provider).toBe(LIVE_AS_PROVIDER_ID);
    expect(o.label).toBe(`Live as ${other.first}`);
    expect(o.enabled).toBe(true);
    expect(o.seconds).toBe(0);
    expect(o.category).toBe('social');
    // other options outrank it
    expect(list.find((x) => x.enabled)!.id === LIVE_AS_OPTION_ID && list.filter((x) => x.enabled).length > 1).toBe(false);
    // nobody to live as on yourself, a thing or the ground
    expect(r.sim.actions.list(r.pid, { kind: 'person', id: r.pid }).some((x) => x.id === LIVE_AS_OPTION_ID)).toBe(false);
    expect(r.sim.actions.list(r.pid, { kind: 'ground', x: 1, z: 1 }).some((x) => x.id === LIVE_AS_OPTION_ID)).toBe(false);
    // the dead are not offered
    other.death = { day: 1, cause: 'illness' };
    expect(r.sim.actions.list(r.pid, { kind: 'person', id: other.id }).some((x) => x.id === LIVE_AS_OPTION_ID)).toBe(false);
    other.death = null;
    // choosing it asks the UI for the card (an instant action with a `ui` outcome), and changes nothing in the simulation
    const seen: unknown[] = [];
    const off = r.sim.events.on('ui', (req) => seen.push(req));
    const before = r.sim.state.run.playerId;
    const outcome = r.sim.actions.start(r.pid, o);
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([{ panel: 'ext', name: 'liveAs', id: other.id, data: { reason: 'choose' } }]);
    expect(r.sim.state.run.playerId).toBe(before);
    off();
    unregister();
    expect(r.sim.actions.list(r.pid, { kind: 'person', id: other.id }).some((x) => x.id === LIVE_AS_OPTION_ID)).toBe(false);
  });

  it('is only for the player’s own wheel', () => {
    const r = rig({ preset: 'small' });
    r.sim.actions.register(liveAsProvider());
    const [a, b] = [...r.sim.state.persons.values()].filter((p) => !p.death && p.id !== r.pid);
    expect(r.sim.actions.list(a.id, { kind: 'person', id: b.id }).some((x) => x.id === LIVE_AS_OPTION_ID)).toBe(false);
  });
});

describe('the wheel’s icons', () => {
  const o = (id: string, category: ActionOption['category'] = 'use', data?: unknown): Pick<ActionOption, 'id' | 'category' | 'data'> => ({ id, category, data });

  it('gives lead, let go, work on the building, slaughter, butchery, the digs, crafts and living as someone their own icons', () => {
    expect(optionIcon(o('lead.start'))).toBe('lead');
    expect(optionIcon(o('lead.letgo'))).toBe('letgo');
    expect(optionIcon(o('lead.letgo.all'))).toBe('letgo');
    expect(optionIcon(o('build.work', 'work', { skill: 'carpentry' }))).toBe('carpentry');
    expect(optionIcon(o('build.work', 'work', { skill: 'masonry' }))).toBe('masonry');
    expect(optionIcon(o('build.work', 'work'))).toBe('carpentry');
    expect(optionIcon(o('stock.slaughter.pig'))).toBe('knife');
    expect(optionIcon(o('stock.butcher.cow'))).toBe('cleaver');
    expect(optionIcon(o('dig.ore'))).toBe('mining');
    expect(optionIcon(o('dig.timber'))).toBe('woodcutting');
    expect(optionIcon(o('craft.sword', 'work'))).toBe('anvil');
    expect(optionIcon(o('live.as', 'social'))).toBe('user');
  });

  it('falls back to the category icon, and every icon it names exists', () => {
    expect(optionIcon(o('farm.reap', 'work'))).toBe('hammer');
    expect(optionIcon(o('x.talk', 'talk'))).toBe('talk');
    const names = new Set<string>(ICON_NAMES);
    for (const id of ['lead.start', 'lead.letgo', 'build.work', 'stock.slaughter.pig', 'stock.butcher.cow', 'dig.ore', 'dig.timber', 'craft.sword', 'live.as', 'farm.reap']) {
      expect(names.has(optionIcon(o(id))), id).toBe(true);
    }
  });
});

describe('the setting', () => {
  it('asks before living as someone by default, and keeps a stored answer', () => {
    expect(DEFAULT_SETTINGS.askBeforeLiveAs).toBe(true);
    expect(readSettings({ settings: {} } as never).askBeforeLiveAs).toBe(true);
    expect(readSettings({ settings: { askBeforeLiveAs: false } } as never).askBeforeLiveAs).toBe(false);
    expect(readSettings({ settings: { askBeforeLiveAs: 'no' } } as never).askBeforeLiveAs).toBe(true);
  });
});
