import { describe, expect, it } from 'vitest';
import { KEYMAP } from '../../src/player/types';
import { keyIntent } from '../../src/ui/core/keys';
import { PauseController } from '../../src/ui/core/pause';
import { PanelStack, type StackPanel } from '../../src/ui/core/stack';

const panel = (id: string, over: Partial<StackPanel> = {}): StackPanel => ({ id, captures: true, pauses: 'never', escape: 'close', ...over });

describe('panel stack', () => {
  it('opens on top, closes the top on Esc, and reports what happened', () => {
    const shown: string[] = [];
    const hidden: string[] = [];
    const stack = new PanelStack<StackPanel>({ onShow: (p) => shown.push(p.id), onHide: (p) => hidden.push(p.id) });
    expect(stack.escape()).toBe('empty');
    stack.open(panel('character', { group: 'main' }));
    stack.open(panel('dialogue'));
    expect(stack.top()?.id).toBe('dialogue');
    expect(stack.escape()).toBe('closed');
    expect(stack.top()?.id).toBe('character');
    expect(shown).toEqual(['character', 'dialogue']);
    expect(hidden).toEqual(['dialogue']);
  });

  it('replaces panels of the same group or id, so browse panels do not pile up', () => {
    const hidden: string[] = [];
    const stack = new PanelStack<StackPanel>({ onHide: (p) => hidden.push(p.id) });
    stack.open(panel('character', { group: 'main' }));
    const replaced = stack.open(panel('inventory', { group: 'main' }));
    expect(replaced.map((p) => p.id)).toEqual(['character']);
    expect(stack.all().map((p) => p.id)).toEqual(['inventory']);
    stack.open(panel('inventory', { group: 'main' }));
    expect(stack.size).toBe(1);
    expect(hidden).toEqual(['character', 'inventory']);
  });

  it('lets a panel that ignores Esc stay (death screen, birth reveal)', () => {
    const stack = new PanelStack<StackPanel>();
    stack.open(panel('death', { escape: 'ignore' }));
    expect(stack.escape()).toBe('blocked');
    expect(stack.has('death')).toBe(true);
    expect(stack.close('death')?.id).toBe('death');
    expect(stack.close('death')).toBeNull();
  });

  it('captures game input only while a capturing panel is open', () => {
    const stack = new PanelStack<StackPanel>();
    expect(stack.captures()).toBe(false);
    stack.open(panel('map', { captures: false }));
    expect(stack.captures()).toBe(false);
    stack.open(panel('rest'));
    expect(stack.captures()).toBe(true);
    stack.close('rest');
    expect(stack.captures()).toBe(false);
  });

  it('wants a pause for always-panels, and for menu-panels when the setting allows', () => {
    const stack = new PanelStack<StackPanel>();
    stack.open(panel('character', { pauses: 'menu' }));
    expect(stack.wantsPause(true)).toBe(true);
    expect(stack.wantsPause(false)).toBe(false);
    stack.open(panel('pause', { pauses: 'always' }));
    expect(stack.wantsPause(false)).toBe(true);
    stack.clear();
    expect(stack.size).toBe(0);
    expect(stack.wantsPause(true)).toBe(false);
  });
});

describe('pause controller', () => {
  const fakeClock = (paused = false): { target: ConstructorParameters<typeof PauseController>[0]; state: { paused: boolean; calls: string[] } } => {
    const state = { paused, calls: [] as string[] };
    return {
      state,
      target: {
        paused: () => state.paused,
        pause: () => { state.calls.push('pause'); state.paused = true; return true; },
        resume: () => { state.calls.push('resume'); state.paused = false; return true; },
      },
    };
  };

  it('pauses and resumes the world around a menu', () => {
    const c = fakeClock();
    const ctl = new PauseController(c.target);
    ctl.sync(true);
    expect(c.state.paused).toBe(true);
    ctl.sync(true);
    ctl.sync(false);
    expect(c.state.paused).toBe(false);
    expect(c.state.calls).toEqual(['pause', 'resume']);
  });

  it('does not take over a pause the player made, and does not undo it', () => {
    const c = fakeClock(true);
    const ctl = new PauseController(c.target);
    ctl.sync(true);
    ctl.sync(false);
    expect(c.state.paused).toBe(true);
    expect(c.state.calls).toEqual([]);
  });

  it('does not resume what someone else already resumed', () => {
    const c = fakeClock();
    const ctl = new PauseController(c.target);
    ctl.sync(true);
    c.state.paused = false; // the player pressed P while the menu was open
    ctl.sync(false);
    expect(c.state.calls).toEqual(['pause']);
  });

  it('gives up ownership without resuming when the game is replaced', () => {
    const c = fakeClock();
    const ctl = new PauseController(c.target);
    ctl.sync(true);
    ctl.forget();
    ctl.sync(false);
    expect(c.state.calls).toEqual(['pause']);
    expect(ctl.holding).toBe(false);
  });
});

describe('keys', () => {
  const free = { typing: false, ctrl: false, alt: false, meta: false };

  it('maps the UI keys of the key map to panel toggles', () => {
    expect(keyIntent(KEYMAP.ui.character, free)).toEqual({ type: 'toggle', panel: 'character' });
    expect(keyIntent(KEYMAP.ui.inventory, free)).toEqual({ type: 'toggle', panel: 'inventory' });
    expect(keyIntent(KEYMAP.ui.ledger, free)).toEqual({ type: 'toggle', panel: 'ledger' });
    expect(keyIntent(KEYMAP.ui.map, free)).toEqual({ type: 'toggle', panel: 'map' });
    expect(keyIntent(KEYMAP.ui.family, free)).toEqual({ type: 'toggle', panel: 'family' });
    expect(keyIntent(KEYMAP.ui.chronicle, free)).toEqual({ type: 'toggle', panel: 'chronicle' });
    expect(keyIntent(KEYMAP.ui.rest, free)).toEqual({ type: 'toggle', panel: 'rest' });
    expect(keyIntent(KEYMAP.ui.command, free)).toEqual({ type: 'toggle', panel: 'command' });
    expect(keyIntent(KEYMAP.ui.menu, free)).toEqual({ type: 'escape' });
  });

  it('leaves the game keys alone', () => {
    for (const code of Object.values(KEYMAP.input)) {
      const i = keyIntent(code, free);
      // movement, interact, mount, dodge, pause and speed keys are the input layer's; digits are menu navigation only
      if (!/^Digit[1-3]$/.test(code)) expect(i).toBeNull();
    }
  });

  it('reads digits, Enter and arrows for menus', () => {
    expect(keyIntent('Digit4', free)).toEqual({ type: 'digit', n: 4 });
    expect(keyIntent('Numpad9', free)).toEqual({ type: 'digit', n: 9 });
    expect(keyIntent('Digit0', free)).toBeNull();
    expect(keyIntent('Enter', free)).toEqual({ type: 'enter' });
    expect(keyIntent('ArrowDown', free)).toEqual({ type: 'arrow', dir: 'down' });
  });

  it('only Esc is ours while typing, and shortcuts with modifiers pass through', () => {
    const typing = { ...free, typing: true };
    expect(keyIntent(KEYMAP.ui.inventory, typing)).toBeNull();
    expect(keyIntent('Digit1', typing)).toBeNull();
    expect(keyIntent(KEYMAP.ui.menu, typing)).toEqual({ type: 'escape' });
    expect(keyIntent(KEYMAP.ui.inventory, { ...free, ctrl: true })).toBeNull();
    expect(keyIntent(KEYMAP.ui.map, { ...free, alt: true })).toBeNull();
  });
});
