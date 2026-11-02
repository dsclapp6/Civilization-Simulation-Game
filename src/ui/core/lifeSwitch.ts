// The change from one body to another (docs/CIV.md §2), without the DOM: decides between a glide of the camera (the new body is within
// 300 m and the street camera can be posed) and a fade (farther, or no camera to pose), keeps the clock of it, makes the change at the
// black of a fade, poses the camera for a glide and hands it back to the follow camera at the end, and remembers "Rule this town" so the
// seat of government can open once it is over. The UI app owns one; it feeds it the frame clock and the `playerSwitched` event.
import type { PersonId } from '../../sim/state';
import type { GameServices, UiHost } from '../types';
import { GLIDE_SECONDS, personSummary, switchKind, type LiveAsReason, type SwitchKind } from './liveAsModel';
import { SwitchFx, followPoseBehind, skipPlayerSwitchEffect } from './switchfx';

export interface LifeSwitchDeps {
  game(): GameServices | null;
  host: Pick<UiHost, 'renderer' | 'cameraPose'>;
  say(kind: 'info' | 'warn', text: string): void;
}

export interface Result { ok: boolean; reason?: string }

/** What the UI needs to know when the change has been made: who, what they were doing, why, and how it crosses. */
export interface Arrival { to: PersonId; doing: string; reason: LiveAsReason | null; kind: SwitchKind }

interface Pending { id: PersonId; reason: LiveAsReason; kind: SwitchKind; doing: string; pose: ReturnType<NonNullable<UiHost['cameraPose']>> }

export class LifeSwitcher {
  readonly fx = new SwitchFx();
  private pending: Pending | null = null;
  private ruleAfter: PersonId | null = null;
  /** Where the body was last seen (the place of death, the start of a glide). */
  private lastBody: { x: number; z: number } | null = null;

  constructor(private readonly deps: LifeSwitchDeps) {}

  /** A change is under way (the veil may be up, the camera gliding): another cannot begin. */
  get busy(): boolean { return this.fx.active || this.pending !== null; }

  /** 0 clear … 1 black. */
  get veil(): number { return this.fx.veil; }

  reset(): void {
    this.fx.cancel();
    this.pending = null;
    this.ruleAfter = null;
    this.lastBody = null;
  }

  /** Crosses to another life. A glide makes the change at once; a fade makes it at the black (`step` does, 0.32 s on). */
  liveAs(id: PersonId, reason: LiveAsReason = 'choose'): Result {
    const g = this.deps.game();
    if (!g) return { ok: false, reason: 'There is no game to change in.' };
    if (this.busy) return { ok: false, reason: 'A change of life is already under way.' };
    const sim = g.sim;
    if (!sim.canSwitchTo(id)) return { ok: false, reason: id === sim.state.run.playerId ? 'You are them already.' : 'They cannot be taken up now.' };
    const controls = this.deps.host.renderer();
    const pose = this.deps.host.cameraPose?.(this.headOf(g, this.lastBody)) ?? null;
    const canGlide = !!pose && !!controls?.setCameraPose && (controls.cameraMode?.() ?? 'follow') === 'follow';
    const at = positionOf(g, id);
    const from = this.lastBody;
    const dist = from && at ? Math.hypot(at.x - from.x, at.z - from.z) : null;
    const kind = switchKind(dist, canGlide);
    this.pending = { id, reason, kind, doing: personSummary(g, id)?.doing ?? '', pose };
    if (kind === 'fade') {
      this.fx.start('fade'); // the veil closes; `step` makes the change at the black
      return { ok: true };
    }
    return this.cut();
  }

  /** Every frame (the UI's clock). Returns the person whose seat of government should open now ("Rule this town"), or null. */
  step(dt: number): PersonId | null {
    const g = this.deps.game();
    if (!g) return null;
    const body = g.player.body();
    if (body) this.lastBody = { x: body.x, z: body.z };
    if (this.fx.active) {
      for (const ev of this.fx.step(Math.min(dt, 0.25))) {
        if (ev === 'cut') this.cut();
        else if (ev === 'done') this.deps.host.renderer()?.setCameraMode('follow'); // the follow camera blends from where the glide ended
      }
    }
    if (this.ruleAfter !== null && !this.fx.active) {
      const id = this.ruleAfter;
      this.ruleAfter = null;
      if (g.sim.state.run.playerId === id) return id;
    }
    return null;
  }

  /**
   * The `playerSwitched` event: the character has changed (by `liveAs`, or by anything else). Runs inside the event, before the renderer
   * has moved the camera, so the old view can still be read. Poses the camera for a glide, or makes sure the change is under a veil.
   */
  arrived(e: { from: PersonId; to: PersonId; reason: 'death' | 'voluntary' }): Arrival | null {
    const g = this.deps.game();
    if (!g) return null;
    const pend = this.pending && this.pending.id === e.to ? this.pending : null;
    this.pending = null;
    const doing = pend?.doing ?? personSummary(g, e.to)?.doing ?? '';
    const controls = this.deps.host.renderer();
    const pose = pend ? pend.pose : this.deps.host.cameraPose?.(this.headOf(g, this.lastBody)) ?? null;
    const body = g.player.body();
    // the player module raises the camera to the map and brings it down again; ours replaces that
    skipPlayerSwitchEffect(g.player);
    const canGlide = !!pose && !!body && !!controls?.setCameraPose && (controls.cameraMode?.() ?? 'follow') === 'follow';
    const from = this.lastBody;
    const dist = from && body ? Math.hypot(body.x - from.x, body.z - from.z) : null;
    const kind: SwitchKind = pend ? pend.kind : switchKind(dist, canGlide);
    let glided = false;
    if (kind === 'glide' && canGlide && pose && body && controls?.setCameraPose) {
      const target = followPoseBehind(pose, body, controls.cameraYaw?.() ?? body.yaw);
      if (target) {
        controls.setCameraPose(target.position, target.lookAt, GLIDE_SECONDS);
        this.fx.start('glide');
        glided = true;
      }
    }
    // far, or no street camera to glide: the cut is under a veil that opens again (already up when we faded out first)
    if (!glided && this.fx.phase !== 'hold') this.fx.blackOut();
    if (pend?.reason === 'rule') this.ruleAfter = e.to;
    return { to: e.to, doing, reason: pend?.reason ?? null, kind: glided ? 'glide' : 'fade' };
  }

  /** Makes the change now (at the black of a fade, or at once for a glide). */
  private cut(): Result {
    const p = this.pending;
    const g = this.deps.game();
    if (!p || !g) { this.fx.cancel(); return { ok: false, reason: 'There is no game to change in.' }; }
    const r = g.sim.dispatch({ type: 'switchCharacter', personId: p.id });
    if (!r.ok) {
      this.pending = null;
      this.fx.cancel();
      this.deps.say('warn', r.reason ? `You cannot do that: ${r.reason}.` : 'You cannot take up that life.');
      return { ok: false, reason: r.reason };
    }
    return { ok: true };
  }

  /** The head of a body standing at `at`: what the follow camera looks at. */
  private headOf(g: GameServices, at: { x: number; z: number } | null): { x: number; y: number; z: number } | undefined {
    return at ? { x: at.x, y: g.sim.world.heightAt(at.x, at.z) + 1.55, z: at.z } : undefined;
  }
}

/** Where a person is (the zone's agent, else their schedule), or null. */
export function positionOf(g: Pick<GameServices, 'zone'>, id: PersonId): { x: number; z: number } | null {
  try {
    const a = g.zone.agent(id);
    if (a) return { x: a.x, z: a.z };
    const w = g.zone.whereabouts(id);
    return Number.isFinite(w.x) && Number.isFinite(w.z) ? { x: w.x, z: w.z } : null;
  } catch { return null; }
}
