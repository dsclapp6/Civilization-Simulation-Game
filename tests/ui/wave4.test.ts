// Wave 4 UI: the dock and hotkeys for the wave 3 panels, notices, the first-minutes guide, the help text and tab keys.
import { describe, expect, it } from 'vitest';
import { KEYMAP } from '../../src/player/types';
import { BASICS, COMBAT_HELP, CONTROL_GROUPS, REALM_HELP, keyLabel } from '../../src/ui/core/controls';
import { HINTS, pickHint, type GuideFacts } from '../../src/ui/core/guide';
import { keyIntent } from '../../src/ui/core/keys';
import { dockBadges, hasModule } from '../../src/ui/core/modules';
import {
  noticeForBattle, noticeForCall, noticeForHappening, noticeForRaid, noticeForRequest, noticeForSiege, noticeForWar, type NoticeCtx,
} from '../../src/ui/core/notices';
import { DOCK_ENTRIES, panelForKey } from '../../src/ui/core/requests';
import { tabKeys } from '../../src/ui/core/tabkeys';
import { DEFAULT_SETTINGS } from '../../src/ui/types';
import { readSettings } from '../../src/app/settings';
import type { Simulation } from '../../src/sim/sim';

const free = { typing: false, ctrl: false, alt: false, meta: false };

describe('hotkeys and the dock', () => {
  it('gives every wave 3 page a key that is not used by anything else', () => {
    const codes = [...Object.values(KEYMAP.ui), ...Object.values(KEYMAP.input)];
    expect(new Set(codes).size).toBe(codes.length);
    expect(keyIntent(KEYMAP.ui.politics, free)).toEqual({ type: 'toggle', panel: 'politics' });
    expect(keyIntent(KEYMAP.ui.techs, free)).toEqual({ type: 'toggle', panel: 'techs' });
    expect(keyIntent(KEYMAP.ui.requests, free)).toEqual({ type: 'toggle', panel: 'requests' });
    expect(keyIntent(KEYMAP.ui.wounds, free)).toEqual({ type: 'toggle', panel: 'wounds' });
    expect(keyIntent(KEYMAP.ui.help, free)).toEqual({ type: 'toggle', panel: 'help' });
    expect(keyIntent(KEYMAP.ui.politics, { ...free, typing: true })).toBeNull();
  });

  it('opens the ext panels by their registered names, and C is the army only with the military module', () => {
    const all = (): boolean => true;
    const none = (): boolean => false;
    expect(panelForKey('politics', all)).toEqual({ request: { panel: 'ext', name: 'politics' }, panelId: 'politics' });
    expect(panelForKey('techs', all)?.panelId).toBe('techs');
    expect(panelForKey('wounds', all)?.request).toEqual({ panel: 'ext', name: 'wounds' });
    expect(panelForKey('politics', none)).toBeNull();
    expect(panelForKey('command', all)?.panelId).toBe('army');
    expect(panelForKey('command', none)).toEqual({ request: { panel: 'ledger', tab: 'household' }, panelId: 'ledger' });
    expect(panelForKey('help', none)?.request).toEqual({ panel: 'help' });
  });

  it('lists a dock button per page, with the key that opens it', () => {
    const ids = DOCK_ENTRIES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['politics', 'techs', 'requests', 'wounds', 'army']) expect(ids).toContain(id);
    const keys = DOCK_ENTRIES.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(DOCK_ENTRIES.find((d) => d.id === 'army')!.key).toBe(keyLabel(KEYMAP.ui.command));
    expect(DOCK_ENTRIES.find((d) => d.id === 'politics')!.key).toBe(keyLabel(KEYMAP.ui.politics));
  });

  it('shows count dots from what the modules report', () => {
    const sim = {
      state: { persons: new Map([[1, { house: 7 }]]) },
      services: {
        happenings: { openRequests: () => [{ state: 'offered' }, { state: 'accepted' }, { state: 'offered' }] },
        politics: { inbox: () => [{ to: 7 }, { to: 8 }], petitions: () => [{}] },
        military: { service: () => ({ call: { house: 7 } }) },
        combat: { wounds: () => [{ bleeding: true }, { bleeding: false }] },
      },
    } as unknown as Simulation;
    const b = dockBadges(sim, 1);
    expect(b.get('requests')).toEqual({ count: 2, tone: 'gold' });
    expect(b.get('politics')).toEqual({ count: 2, tone: 'gold' });
    expect(b.get('army')).toEqual({ count: 1, tone: 'vermilion' });
    expect(b.get('wounds')).toEqual({ count: 1, tone: 'vermilion' });
    expect(hasModule(sim, 'politics')).toBe(true);
    expect(hasModule({ services: {} } as unknown as Simulation, 'politics')).toBe(false);
    expect(dockBadges({ state: { persons: new Map() }, services: {} } as unknown as Simulation, 1).size).toBe(0);
  });
});

const ctx = (over: Partial<NoticeCtx> = {}): NoticeCtx => ({
  homeSettlement: 5,
  houseConcerns: (h) => h === 1,
  houseName: (h) => `H${h}`,
  placeName: (s) => `Place${s}`,
  personName: (p) => `Person${p}`,
  inFight: () => false,
  requestPage: () => 'journal',
  ...over,
});

describe('notices', () => {
  it('sends a request to the page it belongs on; a favour is only announced (it is heard in person)', () => {
    const e = { id: 4, from: 9, text: 'Help me.' };
    expect(noticeForRequest(e, ctx())!.action).toBeUndefined();
    expect(noticeForRequest(e, ctx())!.text).toMatch(/speak to them/);
    expect(noticeForRequest(e, ctx({ requestPage: () => 'letters' }))!.action!.request).toEqual({ panel: 'ext', name: 'politics', data: { tab: 'standing' } });
    expect(noticeForRequest(e, ctx({ requestPage: () => 'petitions' }))!.action!.request).toEqual({ panel: 'ext', name: 'politics', data: { tab: 'petitions' } });
    expect(noticeForRequest(e, ctx({ requestPage: () => null }))).toBeNull();
    expect(noticeForRequest(e, ctx())!.title).toBe('Person9 wants a word with you');
    expect(noticeForRequest(e, ctx({ inFight: () => true }))).toBeNull();
  });

  it('tells of wars that concern the player and opens the wars page', () => {
    const t = noticeForWar({ phase: 'declared', war: 3, attackers: [1], defenders: [2] }, ctx())!;
    expect(t.title).toMatch(/war/i);
    expect(t.urgent).toBe(true);
    expect(t.action!.request).toEqual({ panel: 'ext', name: 'politics', data: { tab: 'wars' } });
    expect(noticeForWar({ phase: 'declared', war: 3, attackers: [8], defenders: [9] }, ctx())).toBeNull();
    expect(noticeForWar({ phase: 'ended', war: 3, attackers: [1], defenders: [2], winner: 'attackers' }, ctx())!.text).toContain('H1');
  });

  it('tells of sieges, raids, battles and disasters at the home place only', () => {
    expect(noticeForSiege({ phase: 'start', settlement: 5, besieger: 9 }, ctx())!.title).toContain('besieged');
    expect(noticeForSiege({ phase: 'start', settlement: 6, besieger: 9 }, ctx())).toBeNull();
    expect(noticeForSiege({ phase: 'fell', settlement: 6, besieger: 1 }, ctx())!.title).toContain('fallen');
    expect(noticeForRaid({ settlement: 5, raider: 9, burned: 2, stolen: 30, captives: 1 }, ctx())!.text).toContain('2 buildings burned');
    expect(noticeForRaid({ settlement: 6, raider: 9, burned: 2, stolen: 30, captives: 1 }, ctx())).toBeNull();
    expect(noticeForBattle({ war: 1, x: 0, z: 0, settlement: 3, attacker: 1, defender: 2, attackerWon: true, dead: 12, playerPresent: false }, ctx())!.text).toContain('H1');
    expect(noticeForBattle({ war: 1, x: 0, z: 0, settlement: 3, attacker: 8, defender: 9, attackerWon: true, dead: 12, playerPresent: false }, ctx())).toBeNull();
    expect(noticeForHappening({ phase: 'start', id: 1, kind: 'plague', settlement: 5, text: 'Plague.' }, ctx())!.tone).toBe('vermilion');
    expect(noticeForHappening({ phase: 'start', id: 1, kind: 'fair', settlement: 5, text: 'A fair.' }, ctx())!.tone).toBe('gold');
    expect(noticeForHappening({ phase: 'end', id: 1, kind: 'plague', settlement: 5, text: '' }, ctx())).toBeNull();
    expect(noticeForHappening({ phase: 'start', id: 1, kind: 'plague', settlement: 6, text: '' }, ctx())).toBeNull();
  });

  it('makes a levy call that opens the army page and wins Enter', () => {
    const t = noticeForCall();
    expect(t.action!.request).toEqual({ panel: 'ext', name: 'army' });
    expect(t.urgent).toBe(true);
  });
});

const facts = (over: Partial<GuideFacts> = {}): GuideFacts => ({
  seconds: 10, moved: 0, age: 12, careerChosen: false, worked: 0, interacted: 0, opened: new Set(),
  needs: { hunger: 0.8, rest: 0.8, warmth: 0.8, mood: 0.8 }, holyDay: false, engaged: false, ranged: false, wounded: false,
  speedChanged: false, travelling: false, money: 0, ...over,
});

describe('the first-minutes guide', () => {
  it('has unique hints with text', () => {
    expect(new Set(HINTS.map((h) => h.id)).size).toBe(HINTS.length);
    for (const h of HINTS) { expect(h.title.length).toBeGreaterThan(3); expect(h.text.length).toBeGreaterThan(30); }
  });

  it('walks a new player through moving, pointing and clicking, and where the tasks are, in order', () => {
    const seen = new Set<string>();
    expect(pickHint(facts({ seconds: 1 }), seen)).toBeNull();
    expect(pickHint(facts(), seen)!.id).toBe('move');
    expect(pickHint(facts({ moved: 20 }), seen)!.id).toBe('interact');
    seen.add('move');
    seen.add('interact');
    expect(pickHint(facts({ moved: 20, interacted: 1, seconds: 60 }), seen)!.id).toBe('tasks');
    expect(pickHint(facts({ moved: 20, interacted: 1, seconds: 60, opened: new Set(['journal']) }), seen)).toBeNull();
  });

  it('is answered by doing the thing', () => {
    const move = HINTS.find((h) => h.id === 'move')!;
    expect(move.done(facts({ moved: 3 }))).toBe(false);
    expect(move.done(facts({ moved: 9 }))).toBe(true);
    const tasks = HINTS.find((h) => h.id === 'tasks')!;
    expect(tasks.done(facts({ opened: new Set(['journal']) }))).toBe(true);
  });

  it('keeps to the controls: the old teaching hints are the objectives\u2019 business now', () => {
    const ids = HINTS.map((h) => h.id);
    expect(ids).toEqual(['move', 'interact', 'tasks', 'time', 'fight', 'bow', 'wounds', 'help']);
    for (const gone of ['work', 'character', 'hunger', 'rest', 'warmth', 'map', 'holy', 'career']) expect(ids).not.toContain(gone);
    // hunger and the like no longer interrupt
    const seen = new Set<string>(['move', 'interact', 'tasks']);
    expect(pickHint(facts({ moved: 20, interacted: 1, worked: 3, age: 13.6, needs: { hunger: 0.1, rest: 0.1, warmth: 0.1, mood: 0.1 } }), seen)).toBeNull();
  });

  it('speaks of the weapon only in a fight, and the mouse text names the weapon key and the free cursor', () => {
    const seen = new Set<string>(['move', 'interact', 'tasks']);
    expect(pickHint(facts({ engaged: true, needs: { hunger: 0.1, rest: 0.8, warmth: 0.8, mood: 0.8 } }), seen)!.id).toBe('fight');
    expect(pickHint(facts({ engaged: true, ranged: true }), seen)!.id).toBe('bow');
    seen.add('fight');
    seen.add('bow');
    expect(pickHint(facts({ engaged: true, needs: { hunger: 0.1, rest: 0.8, warmth: 0.8, mood: 0.8 } }), seen)).toBeNull();
    const fight = HINTS.find((h) => h.id === 'fight')!;
    expect(fight.keys).toContain(keyLabel(KEYMAP.input.weapon));
    expect(fight.text).toMatch(/Esc frees the mouse/);
    expect(HINTS.find((h) => h.id === 'move')!.text).toMatch(/right mouse button/);
    expect(HINTS.find((h) => h.id === 'interact')!.text).toMatch(/click/i);
  });

  it('is switched on by default and can be switched off in the settings', () => {
    expect(DEFAULT_SETTINGS.hints).toBe(true);
    expect(readSettings({ settings: {} } as never).hints).toBe(true);
    expect(readSettings({ settings: { hints: false } } as never).hints).toBe(false);
  });
});

describe('the help page text', () => {
  it('names every key of the keymap', () => {
    const shown = new Set(CONTROL_GROUPS.flatMap((g) => g.rows.flatMap((r) => r.keys.map((k) => k.replace('Hold ', '')))));
    for (const code of [...Object.values(KEYMAP.ui), ...Object.values(KEYMAP.input)]) {
      if (code === 'ShiftLeft') { expect(shown.has('Shift')).toBe(true); continue; }
      expect(shown.has(keyLabel(code)) || [...shown].some((s) => s.includes(keyLabel(code))), code).toBe(true);
    }
    for (const mouse of ['LMB', 'RMB']) expect(shown.has(mouse)).toBe(true);
  });

  it('has text for basics, fighting and the realm', () => {
    for (const list of [BASICS, COMBAT_HELP, REALM_HELP]) {
      expect(list.length).toBeGreaterThan(0);
      for (const s of list) { expect(s.title).toBeTruthy(); expect(s.paragraphs.join(' ').length).toBeGreaterThan(80); }
    }
  });
});

describe('tab keys', () => {
  const key = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra }) as never;
  it('switches with arrows and digits, skipping locked tabs', () => {
    let cur = 'a';
    const onKey = tabKeys(['a', 'b', 'c'], () => cur, (id) => { cur = id; }, { locked: (id) => id === 'b' });
    expect(onKey(key('arrow', { dir: 'right' }), {} as KeyboardEvent)).toBe(true);
    expect(cur).toBe('c');
    expect(onKey(key('arrow', { dir: 'right' }), {} as KeyboardEvent)).toBe(true);
    expect(cur).toBe('a');
    expect(onKey(key('digit', { n: 2 }), {} as KeyboardEvent)).toBe(false);
    expect(onKey(key('digit', { n: 3 }), {} as KeyboardEvent)).toBe(true);
    expect(cur).toBe('c');
    expect(onKey(key('enter'), {} as KeyboardEvent)).toBe(false);
  });

  it('leaves the digits alone when asked', () => {
    let cur = 'a';
    const onKey = tabKeys(['a', 'b'], () => cur, (id) => { cur = id; }, { digits: () => false });
    expect(onKey(key('digit', { n: 2 }), {} as KeyboardEvent)).toBe(false);
    expect(cur).toBe('a');
  });
});
