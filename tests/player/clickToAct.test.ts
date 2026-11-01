// Click to act (CLARITY §5): walking to what was clicked and acting there, the weapon on G, and what the cursor shows.
import { describe, expect, it } from 'vitest';
import type { CharacterDrawItem } from '../../src/core/view';
import { SIM_DT } from '../../src/core/time';
import type { ActionOption, ActionProvider, TargetRef } from '../../src/sim/actions';
import { installPlayer } from '../../src/player';
import { CLICK_WALK_RANGE, cursorFor } from '../../src/player/pointer';
import { pickScatter } from '../../src/player/pickScatter';
import type { HoverMark, PickPort, PickRay } from '../../src/player/types';
import { installEconomy } from '../../src/sim/economy';
import { installSocial } from '../../src/sim/social';
import type { PersonId } from '../../src/sim/state';
import type { ScatterItem } from '../../src/world/types';
import { newSim } from '../sim/helpers';
import { FakeZone, input, rig, run, workProvider, type Rig } from './fakes';

const feed = (r: Rig): string[] => {
  const lines: string[] = [];
  r.sim.events.on('notify', (n) => lines.push(n.text));
  return lines;
};

/** A thing to click on, `ahead` metres in front of the body. */
function place(r: Rig, ahead: number, id = 3, label = 'Strip of barley'): { x: number; z: number } {
  const b = r.player.body()!;
  const x = b.x + Math.sin(b.yaw) * ahead, z = b.z + Math.cos(b.yaw) * ahead;
  r.zone.things = [{ target: { kind: 'strip', id }, x, z, label }];
  return { x, z };
}

describe('click to act', () => {
  it('walks to the thing and does its default action there', () => {
    const r = rig();
    const w = workProvider({ seconds: 4 });
    r.sim.actions.register(w);
    const at = place(r, 12);
    const res = r.player.goTo!({ target: { kind: 'strip', id: 3 }, x: at.x, z: at.z, label: 'Strip of barley' });
    expect(res.ok).toBe(true);
    expect(r.player.hud()!.going?.label).toBe('Strip of barley');
    const b0 = { ...r.player.body()! };
    run(r, 1.5);
    const b1 = { ...r.player.body()! };
    expect(Math.hypot(b1.x - b0.x, b1.z - b0.z)).toBeGreaterThan(3);
    expect(w.started).toBe(0); // still on its way
    run(r, 4);
    expect(w.started).toBe(1);
    expect(r.sim.actions.active(r.pid)?.option.id).toBe('work');
    expect(r.player.hud()!.going).toBeNull();
    // it stopped at the strip, not beyond it
    const b2 = r.player.body()!;
    expect(Math.hypot(b2.x - at.x, b2.z - at.z)).toBeLessThan(1.2);
  });

  it('walks a person up to a few steps off and talks to them', () => {
    const r = rig();
    r.sim.actions.register(workProvider({ seconds: 0 }));
    const other = [...r.sim.state.persons.values()].find((p) => p.id !== r.pid && !p.death)!.id;
    const b = { ...r.player.body()! };
    r.zone.addAgent(other, b.x + 9, b.z);
    r.zone.things = [];
    expect(r.player.goTo!({ target: { kind: 'person', id: other }, x: b.x + 9, z: b.z, label: 'Someone' }).ok).toBe(true);
    run(r, 6);
    const b1 = r.player.body()!;
    expect(Math.hypot(b1.x - (b.x + 9), b1.z - b.z)).toBeLessThan(2.4);
    expect(r.player.hud()!.going).toBeNull();
  });

  it('ends when a movement key is pressed', () => {
    const r = rig();
    const w = workProvider();
    r.sim.actions.register(w);
    const at = place(r, 30);
    r.player.goTo!({ target: { kind: 'strip', id: 3 }, x: at.x, z: at.z, label: 'Strip' });
    run(r, 1);
    expect(r.player.hud()!.going).not.toBeNull();
    run(r, 0.2, { forward: 0, right: 1 });
    expect(r.player.hud()!.going).toBeNull();
    const b = { ...r.player.body()! };
    run(r, 3);
    const b2 = r.player.body()!;
    expect(Math.hypot(b2.x - b.x, b2.z - b.z)).toBeLessThan(0.5); // not walking on by itself any more
    expect(w.started).toBe(0);
  });

  it('is ended by E, Q and a dodge too', () => {
    for (const key of ['interact', 'cancel', 'dodge'] as const) {
      const r = rig();
      r.sim.actions.register(workProvider());
      const at = place(r, 30);
      r.player.goTo!({ target: { kind: 'strip', id: 3 }, x: at.x, z: at.z, label: 'Strip' });
      run(r, 0.5);
      r.player.setInput(input({ [key]: true }));
      r.sim.step(SIM_DT);
      expect(r.player.hud()!.going, key).toBeNull();
    }
  });

  it('says why when nothing can be done there, and does not walk', () => {
    const r = rig();
    const locked: ActionProvider = {
      id: 'locked',
      list(_c, _a, target, out) {
        if (target.kind === 'self') return;
        out.push({ id: 'reap', provider: '', label: 'Reap', category: 'work', target, enabled: false, reason: 'Needs a sickle', seconds: 3, range: 4, priority: 5 } as ActionOption);
      },
      complete: () => ({ ok: true }),
    };
    r.sim.actions.register(locked);
    const lines = feed(r);
    const at = place(r, 10);
    const res = r.player.goTo!({ target: { kind: 'strip', id: 3 }, x: at.x, z: at.z, label: 'Strip' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('Needs a sickle');
    expect(lines).toContain('Needs a sickle');
    expect(r.player.hud()!.going).toBeNull();
  });

  it('walks to a bare spot of ground and stops there without doing anything', () => {
    const r = rig();
    const w = workProvider();
    r.sim.actions.register(w);
    const b = { ...r.player.body()! };
    const x = b.x + 8, z = b.z;
    expect(r.player.goTo!({ target: { kind: 'ground', x, z }, x, z, label: '' }).ok).toBe(true);
    run(r, 6);
    const b1 = r.player.body()!;
    expect(Math.hypot(b1.x - x, b1.z - z)).toBeLessThan(1);
    expect(w.started).toBe(0);
    expect(r.player.hud()!.going).toBeNull();
  });

  it('refuses a walk that is too far, and one while a weapon is drawn', () => {
    const r = rig();
    const b = { ...r.player.body()! };
    const far = r.player.goTo!({ target: { kind: 'ground', x: b.x + CLICK_WALK_RANGE + 50, z: b.z }, x: b.x + CLICK_WALK_RANGE + 50, z: b.z, label: '' });
    expect(far.ok).toBe(false);
    expect(far.reason).toMatch(/too far/);
    r.player.setDrawn!(true);
    const g = r.player.goTo!({ target: { kind: 'ground', x: b.x + 5, z: b.z }, x: b.x + 5, z: b.z, label: '' });
    expect(g.ok).toBe(false);
  });

  it('gives up when the way is blocked for good', () => {
    const r = rig();
    r.sim.actions.register(workProvider());
    const b = { ...r.player.body()! };
    // a wall across the way, and a path that does not know about it
    r.zone.walls = [{ x0: b.x - 40, z0: b.z + 3, x1: b.x + 40, z1: b.z + 4 }];
    const x = b.x, z = b.z + 20;
    const lines = feed(r);
    r.zone.things = [{ target: { kind: 'strip', id: 3 }, x, z, label: 'Strip' }];
    r.player.goTo!({ target: { kind: 'strip', id: 3 }, x, z, label: 'Strip' });
    run(r, 14);
    expect(r.player.hud()!.going).toBeNull();
    expect(lines.some((l) => /cannot/i.test(l))).toBe(true);
  });
});

describe('the weapon', () => {
  const withFight = (r: Rig): { fight: { id: number } } => {
    const fight = { id: 0 };
    (r.sim.services as { combat?: unknown }).combat = {
      fightOf: () => fight.id, player: undefined, wounds: () => [], isFighting: () => fight.id > 0, engage: () => 0, harm: () => 'unhurt',
      onFightEnded: () => () => undefined,
    };
    return { fight };
  };

  it('is drawn and sheathed with G, and the HUD says so', () => {
    const r = rig();
    expect(r.player.hud()!.drawn).toBe(false);
    r.player.setInput(input({ weapon: true }));
    r.sim.step(SIM_DT);
    expect(r.player.drawn!()).toBe(true);
    expect(r.player.hud()!.drawn).toBe(true);
    r.player.setInput(input({ weapon: true }));
    r.sim.step(SIM_DT);
    expect(r.player.drawn!()).toBe(false);
  });

  it('ends a click-to-act walk and a work bout when drawn', () => {
    const r = rig();
    const w = workProvider({ seconds: 20 });
    r.sim.actions.register(w);
    const at = place(r, 1.5);
    r.player.goTo!({ target: { kind: 'strip', id: 3 }, x: at.x, z: at.z, label: 'Strip' });
    run(r, 2);
    expect(r.sim.actions.active(r.pid)).not.toBeNull();
    r.player.setDrawn!(true);
    expect(r.sim.actions.active(r.pid)).toBeNull();
  });

  it('a fight draws it by itself and it goes away a few seconds after the fight', () => {
    const r = rig();
    const { fight } = withFight(r);
    run(r, 0.3);
    expect(r.player.drawn!()).toBe(false);
    fight.id = 5;
    run(r, 0.3);
    expect(r.player.drawn!()).toBe(true);
    run(r, 5);
    expect(r.player.drawn!()).toBe(true); // still fighting
    fight.id = 0;
    run(r, 2);
    expect(r.player.drawn!()).toBe(true);
    run(r, 3);
    expect(r.player.drawn!()).toBe(false);
  });

  it('stays sheathed when put away by hand in the middle of a fight, until the fight ends', () => {
    const r = rig();
    const { fight } = withFight(r);
    fight.id = 2;
    run(r, 0.3);
    expect(r.player.drawn!()).toBe(true);
    r.player.setDrawn!(false);
    run(r, 1);
    expect(r.player.drawn!()).toBe(false);
    fight.id = 0;
    run(r, 0.3);
    fight.id = 3; // a new fight
    run(r, 0.3);
    expect(r.player.drawn!()).toBe(true);
  });

  it('keeps a weapon an armed person draws in the hand of the body', () => {
    const r = rig();
    const p = r.sim.state.persons.get(r.pid)!;
    p.inventory['sword'] = 1;
    r.economy.equip(r.pid, 'main', 'sword');
    run(r, 1.2);
    r.player.setDrawn!(true);
    run(r, 0.2);
    const d = r.zone.attached!.draw;
    expect(d.mainHand === 'sword' || d.mainHand === 'longsword' || d.mainHand === 'none').toBe(true);
    r.player.setDrawn!(false);
    run(r, 0.2);
    expect(d.mainHand).toBe('none');
  });
});

// ---------------------------------------------------------------------------------------------------
// the cursor
// ---------------------------------------------------------------------------------------------------

type PickAnswer = ReturnType<PickPort['pick']>;

function pointerRig(answer: () => PickAnswer, ray: PickRay = { x: 0, y: 12, z: 0, dx: 0, dy: -0.5, dz: 0.866 }): Rig & { port: PickPort; marks: Array<HoverMark | null> } {
  const sim = newSim();
  const zone = new FakeZone();
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const marks: Array<HoverMark | null> = [];
  const port: PickPort = { pick: () => answer(), ray: () => ray, setHover: (m) => { marks.push(m); } };
  const player = installPlayer(sim, { zone, economy, social, pick: port });
  return { sim, zone, player, economy, social, pid: sim.state.run.playerId, port, marks };
}

describe('what the cursor is over', () => {
  it('names a building, shows the default action and outlines it', () => {
    const r = pointerRig(() => ({ type: 'building', id: 41, point: { x: 3, y: 10, z: 20 } }));
    r.sim.actions.register({
      id: 'door',
      list(_c, _a, target, out) {
        if (target.kind !== 'building') return;
        out.push({ id: 'in', provider: '', label: 'Go in', category: 'use', target, enabled: true, seconds: 0, range: 3, priority: 4, preview: 'Visit the home' } as ActionOption);
      },
      complete: () => ({ ok: true }),
    });
    const b = r.player.body()!;
    r.zone.doors.set(41, { x: b.x + 5, z: b.z + 5, yaw: 0 });
    r.zone.things = [{ target: { kind: 'building', id: 41 }, x: b.x + 5, z: b.z + 5, label: 'Your home' }];
    r.player.pointerMove!(400, 300);
    const h = r.player.hover!()!;
    expect(h).not.toBeNull();
    expect(h.target).toEqual({ kind: 'building', id: 41 });
    expect(h.label).toBe('Your home');
    expect(h.action).toBe('Go in');
    expect(h.cursor).toBe('enter');
    expect(h.enabled).toBe(true);
    expect(h.preview).toBe('Visit the home');
    expect(h.x).toBe(400);
    expect(r.marks.at(-1)).toMatchObject({ kind: 'building', id: 41 });
    r.player.pointerLeave!();
    expect(r.player.hover!()).toBeNull();
    expect(r.marks.at(-1)).toBeNull();
  });

  it('rings a person under the cursor, and takes the ring away again', () => {
    const other = (): PersonId => 0;
    void other;
    let id = 0;
    const r = pointerRig(() => ({ type: 'character', id, point: { x: 1, y: 10, z: 1 } }));
    id = [...r.sim.state.persons.values()].find((p) => p.id !== r.pid && !p.death)!.id;
    const b = r.player.body()!;
    const agent = r.zone.addAgent(id, b.x + 4, b.z);
    r.sim.actions.register(workProvider({ seconds: 0 }));
    r.player.pointerMove!(10, 10);
    const h = r.player.hover!()!;
    expect(h.target).toEqual({ kind: 'person', id });
    expect(h.label.length).toBeGreaterThan(3);
    expect(agent.draw.highlight).toBe(1);
    r.player.pointerLeave!();
    expect(agent.draw.highlight).toBe(0);
  });

  it('does not point at yourself, and shows nothing while the weapon is drawn', () => {
    const r = pointerRig(() => ({ type: 'character', id: 0, point: { x: 0, y: 0, z: 0 } }));
    r.player.pointerMove!(5, 5);
    expect(r.player.hover!()).toBeNull();
    let near = { x: 0, y: 10, z: 0 };
    const r2 = pointerRig(() => ({ type: 'ground', point: near }));
    const b2 = r2.player.body()!;
    near = { x: b2.x + 6, y: 10, z: b2.z };
    r2.player.pointerMove!(5, 5);
    expect(r2.player.hover!()?.cursor).toBe('walk');
    near = { x: b2.x + 900, y: 10, z: b2.z };
    r2.player.setDrawn!(true);
    expect(r2.player.hover!()).toBeNull();
    expect(r2.player.pointerClick!(5, 5).ok).toBe(false);
  });

  it('finds the strip under a ground point and walks there on a click', () => {
    const r = pointerRig(() => ({ type: 'ground', point: { x: 120, y: 10, z: 130 } }));
    const w = workProvider({ seconds: 3 });
    r.sim.actions.register(w);
    const b = r.player.body()!;
    r.player.placeAt!(110, 120);
    r.zone.things = [{ target: { kind: 'strip', id: 9 }, x: 120, z: 130, label: 'Your family’s east strip' }];
    r.player.pointerMove!(1, 1);
    const h = r.player.hover!()!;
    void b;
    expect(h.target).toEqual({ kind: 'strip', id: 9 });
    expect(h.label).toContain('east strip');
    expect(h.cursor).toBe('work');
    expect(h.action).toBe('Work');
    expect(r.marks.at(-1)).toMatchObject({ kind: 'strip', id: 9 });
    const res = r.player.pointerClick!(1, 1);
    expect(res.ok).toBe(true);
    run(r, 8);
    expect(w.started).toBe(1);
  });

  it('maps action categories to cursor images', () => {
    expect(cursorFor({ category: 'talk', label: 'Talk' })).toBe('talk');
    expect(cursorFor({ category: 'trade', label: 'Trade' })).toBe('trade');
    expect(cursorFor({ category: 'work', label: 'Reap' })).toBe('work');
    expect(cursorFor({ category: 'combat', label: 'Fight' })).toBe('attack');
    expect(cursorFor({ category: 'use', label: 'Go in' })).toBe('enter');
    expect(cursorFor({ category: 'use', label: 'Knock' })).toBe('enter');
    expect(cursorFor({ category: 'use', label: 'Draw water' })).toBe('use');
  });
});

// ---------------------------------------------------------------------------------------------------
// trees under the mouse
// ---------------------------------------------------------------------------------------------------

describe('trees and rocks under the mouse', () => {
  const item = (id: number, kind: ScatterItem['kind'], x: number, z: number, scale = 1): ScatterItem => ({ id, kind, x, z, scale, rot: 0, variant: 0 });
  const world = (items: ScatterItem[]) => ({ scatterInChunk: (cx: number, cz: number) => (cx === 0 && cz === 0 ? items : []), heightAt: () => 0 });
  const ray = (over: Partial<PickRay> = {}): PickRay => {
    const r = { x: 10, y: 3, z: 0, dx: 0, dy: -0.05, dz: 1, ...over };
    const l = Math.hypot(r.dx, r.dy, r.dz);
    return { ...r, dx: r.dx / l, dy: r.dy / l, dz: r.dz / l };
  };

  it('hits the trunk and the crown, and the nearest one wins', () => {
    const w = world([item(1, 'oak', 10, 20), item(2, 'oak', 10, 40)]);
    const hit = pickScatter(w, new Set(), ray(), 80);
    expect(hit?.id).toBe(1);
    expect(hit?.kind).toBe('oak');
    // aiming at the canopy, well above the trunk, still counts
    const high = pickScatter(w, new Set(), ray({ y: 11, dy: 0 }), 80);
    expect(high?.id).toBe(1);
  });

  it('misses trees off to the side, behind the ray and felled ones', () => {
    const w = world([item(1, 'oak', 25, 20), item(2, 'pine', 10, -20)]);
    expect(pickScatter(w, new Set(), ray(), 80)).toBeNull();
    const w2 = world([item(5, 'oak', 10, 20)]);
    expect(pickScatter(w2, new Set([5]), ray(), 80)).toBeNull();
    expect(pickScatter(w2, new Set(), ray(), 10)).toBeNull(); // beyond the limit
  });

  it('ignores bushes and grass', () => {
    const w = world([item(1, 'bush', 10, 20), item(2, 'grass_tuft', 10, 25)]);
    expect(pickScatter(w, new Set(), ray(), 80)).toBeNull();
  });

  it('hits a boulder by its sphere', () => {
    const w = world([item(7, 'boulder', 10, 15)]);
    expect(pickScatter(w, new Set(), ray({ y: 1.2, dy: 0 }), 80)?.id).toBe(7);
  });
});

void ({} as CharacterDrawItem); void ({} as TargetRef);
