import { describe, expect, it } from 'vitest';
import type { PlayerCombatFrame, PlayerCombatPort, PlayerCombatPose } from '../../src/sim/wave3';
import type { AnimState } from '../../src/core/view';
import { rig, run } from './fakes';

/** A combat module that always asks for the same pose: enough to see what the controller tells the HUD. */
function fakePort(pose: Partial<PlayerCombatPose>): PlayerCombatPort & { set(p: Partial<PlayerCombatPose>): void } {
  let current = pose;
  return {
    input() { /* held buttons are not needed here */ },
    step(_f: PlayerCombatFrame, out: PlayerCombatPose) {
      out.engaged = false; out.anim = null; out.mainHand = null; out.offHand = null; out.moveScale = 1; out.faceYaw = null;
      out.aimPitch = null; out.staminaCost = 0; out.effort = 0; out.noSprint = false; out.aiming = false; out.unhorse = false;
      Object.assign(out, current);
    },
    dodge: () => true,
    reset() { /* nothing held */ },
    set(p) { current = p; },
  };
}

function withCombat(pose: Partial<PlayerCombatPose>) {
  const r = rig();
  const port = fakePort(pose);
  (r.sim.services as { combat?: unknown }).combat = { player: port, wounds: () => [], blood: () => 1, engage: () => 0, isFighting: () => false, harm: () => 'unhurt', onFightEnded: () => () => undefined };
  return { r, port };
}

describe('the combat state the HUD reads', () => {
  it('is absent without the combat module', () => {
    const r = rig();
    run(r, 0.2);
    expect(r.player.hud()!.combat).toBeUndefined();
  });

  it('reports a drawn bow as ranged and aiming', () => {
    const { r } = withCombat({ engaged: true, anim: 'aim_bow' as AnimState, mainHand: 'longbow', aiming: true });
    run(r, 0.3);
    const c = r.player.hud()!.combat!;
    expect(c.engaged).toBe(true);
    expect(c.ranged).toBe(true);
    expect(c.state).toBe('aim');
  });

  it('maps blows, guards and rolls to stances', () => {
    const { r, port } = withCombat({ engaged: true, anim: 'block' as AnimState, mainHand: 'sword' });
    run(r, 0.2);
    expect(r.player.hud()!.combat!.state).toBe('guard');
    expect(r.player.hud()!.combat!.ranged).toBe(false);
    port.set({ engaged: true, anim: 'attack_slash' as AnimState, mainHand: 'sword' });
    run(r, 0.2);
    expect(r.player.hud()!.combat!.state).toBe('attack');
  });

  it('counts each blow taken once, and the fall to the ground', () => {
    const { r, port } = withCombat({ engaged: true, anim: 'hit' as AnimState, mainHand: 'sword' });
    run(r, 0.2);
    const first = r.player.hud()!.combat!.hitSeq;
    run(r, 0.2);
    expect(r.player.hud()!.combat!.hitSeq).toBe(first); // still the same hit
    port.set({ engaged: true, anim: 'block' as AnimState });
    run(r, 0.2);
    port.set({ engaged: true, anim: 'hit' as AnimState });
    run(r, 0.2);
    expect(r.player.hud()!.combat!.hitSeq).toBe(first + 1);
    port.set({ engaged: true, anim: 'fall' as AnimState });
    run(r, 0.2);
    const down = r.player.hud()!.combat!;
    expect(down.state).toBe('down');
    expect(down.hitSeq).toBe(first + 2);
  });
});
