// The change from one body to another (docs/CIV.md §2): a glide when the new body is near, a fade when it is far or the camera cannot be
// posed, the change made at the black, the camera handed back, "Rule this town" waiting for the end. Real simulation and player module,
// a fake zone, and a fake renderer that records what the UI asks of the camera.
import { describe, expect, it } from 'vitest';
import type { Whereabouts } from '../../src/agents/types';
import { LifeSwitcher } from '../../src/ui/core/lifeSwitch';
import { FADE_HOLD_SECONDS, FADE_IN_SECONDS, FADE_OUT_SECONDS, GLIDE_SECONDS } from '../../src/ui/core/liveAsModel';
import type { CameraPose, GameServices, UiHost, UiRendererControls } from '../../src/ui/types';
import { rig, type Rig } from '../player/fakes';

interface Cam { poses: Array<{ pos: unknown; look: unknown; seconds: number | undefined }>; modes: string[]; mode: 'follow' | 'map' | 'free' | 'cinematic'; yaw: number }

function setup(opts: { canPose?: boolean; mode?: Cam['mode'] } = {}): {
  r: Rig; game: GameServices; sw: LifeSwitcher; cam: Cam; said: string[]; frames: number[]; arrivals: unknown[];
} {
  const r = rig({ preset: 'small' });
  const frames: number[] = [];
  const realFrame = r.player.frame?.bind(r.player);
  r.player.frame = (dt: number): void => { frames.push(dt); realFrame?.(dt); };
  const game = { sim: r.sim, economy: r.economy, social: r.social, zone: r.zone, player: r.player } as unknown as GameServices;
  const cam: Cam = { poses: [], modes: [], mode: opts.mode ?? 'follow', yaw: 0 };
  const controls = {
    setCameraPose: (pos: unknown, look: unknown, seconds?: number): void => { cam.poses.push({ pos, look, seconds }); cam.mode = 'free'; },
    setCameraMode: (m: Cam['mode']): void => { cam.modes.push(m); cam.mode = m; },
    cameraMode: () => cam.mode,
    cameraYaw: () => cam.yaw,
  } as unknown as UiRendererControls;
  const canPose = opts.canPose ?? true;
  const host: Pick<UiHost, 'renderer' | 'cameraPose'> = {
    renderer: () => controls,
    cameraPose: canPose
      ? (focus): CameraPose | null => (focus ? { position: { x: focus.x + 3, y: focus.y + 4, z: focus.z - 6 }, lookAt: focus } : null)
      : undefined,
  };
  const said: string[] = [];
  const sw = new LifeSwitcher({ game: () => game, host, say: (_k, t) => said.push(t) });
  const arrivals: unknown[] = [];
  r.sim.events.on('playerSwitched', (e) => { cam.yaw = r.player.body()?.yaw ?? 0; arrivals.push(sw.arrived(e)); });
  sw.step(0.05); // the first frame: the body's place is noted
  return { r, game, sw, cam, said, frames, arrivals };
}

/** Runs the switcher's clock for `seconds` in frames of 1/20 s (a frame is never longer than a quarter second); returns the rulers it handed back. */
function run(sw: LifeSwitcher, seconds: number): Array<number | null> {
  const out: Array<number | null> = [];
  for (let t = 0; t < seconds - 1e-9; t += 0.05) out.push(sw.step(Math.min(0.05, seconds - t)));
  return out;
}

/** Puts a person at a distance from the player, in the zone and on the schedule. */
function place(s: ReturnType<typeof setup>, metres: number): number {
  const me = s.r.sim.state.persons.get(s.r.pid)!;
  const other = [...s.r.sim.state.persons.values()].find((p) => !p.death && p.id !== s.r.pid && p.settlement === me.settlement)!;
  const b = s.r.player.body()!;
  s.r.zone.addAgent(other.id, b.x + metres, b.z);
  s.r.zone.whereaboutsFn = (): Whereabouts => ({ activity: 'work', settlement: me.settlement, building: -1, indoors: false, x: b.x + metres, z: b.z, label: 'Digging the garden' });
  return other.id;
}

describe('a glide to someone near', () => {
  it('makes the change at once, poses the camera to look behind the new body, and hands it back at the end', () => {
    const s = setup();
    const id = place(s, 40);
    const res = s.sw.liveAs(id);
    expect(res.ok).toBe(true);
    expect(s.r.sim.state.run.playerId).toBe(id);
    // the camera: one pose, over the glide's seconds, then nothing more until the end
    expect(s.cam.poses).toHaveLength(1);
    expect(s.cam.poses[0].seconds).toBe(GLIDE_SECONDS);
    const look = s.cam.poses[0].look as { x: number; y: number; z: number };
    const body = s.r.player.body()!;
    expect(look.x).toBeCloseTo(body.x, 3);
    expect(look.z).toBeCloseTo(body.z, 3);
    expect(look.y).toBeCloseTo(body.y + 1.55, 3);
    expect(s.sw.fx.phase).toBe('glide');
    expect(s.sw.veil).toBe(0);
    expect(s.arrivals).toHaveLength(1);
    expect(s.arrivals[0]).toMatchObject({ to: id, reason: 'choose', kind: 'glide' });
    expect((s.arrivals[0] as { doing: string }).doing).toBe('digging the garden');
    // the player module's own rise to the map is skipped (its clock is run past the effect)
    expect(s.frames).toContain(2);
    expect(s.cam.modes).toEqual([]);
    run(s.sw, GLIDE_SECONDS - 0.1);
    expect(s.cam.modes).toEqual([]);
    run(s.sw, 0.2);
    expect(s.sw.fx.active).toBe(false);
    expect(s.cam.modes).toEqual(['follow']);
  });

  it('refuses to change twice at once, to be yourself, and to take up the dead', () => {
    const s = setup();
    const id = place(s, 20);
    expect(s.sw.liveAs(s.r.pid)).toEqual({ ok: false, reason: 'You are them already.' });
    const dead = [...s.r.sim.state.persons.values()].find((p) => !p.death && p.id !== s.r.pid && p.id !== id)!;
    dead.death = { day: 1, cause: 'illness' };
    expect(s.sw.liveAs(dead.id).ok).toBe(false);
    expect(s.sw.liveAs(id).ok).toBe(true);
    expect(s.sw.busy).toBe(true);
    const again = s.sw.liveAs(s.r.pid);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/already under way/);
  });
});

describe('a fade to someone far', () => {
  it('closes the veil first, makes the change at the black, holds a beat and opens again', () => {
    const s = setup();
    const id = place(s, 1500);
    const before = s.r.sim.state.run.playerId;
    expect(s.sw.liveAs(id).ok).toBe(true);
    expect(s.sw.fx.phase).toBe('out');
    expect(s.r.sim.state.run.playerId).toBe(before);
    expect(s.cam.poses).toEqual([]);
    run(s.sw, FADE_OUT_SECONDS / 2);
    expect(s.r.sim.state.run.playerId).toBe(before);
    expect(s.sw.veil).toBeGreaterThan(0.3);
    expect(s.sw.veil).toBeLessThan(1);
    run(s.sw, FADE_OUT_SECONDS / 2 + 0.02);
    expect(s.r.sim.state.run.playerId).toBe(id); // made at the black
    expect(s.sw.veil).toBe(1);
    expect(s.arrivals[0]).toMatchObject({ to: id, kind: 'fade' });
    expect(s.cam.poses).toEqual([]); // no glide: the camera is not posed
    run(s.sw, FADE_HOLD_SECONDS + FADE_IN_SECONDS / 2);
    expect(s.sw.veil).toBeLessThan(1);
    expect(s.sw.veil).toBeGreaterThan(0);
    run(s.sw, FADE_IN_SECONDS);
    expect(s.sw.fx.active).toBe(false);
    expect(s.sw.veil).toBe(0);
    expect(s.cam.modes).toEqual(['follow']);
  });

  it('fades when the street camera cannot be posed, even for someone beside you', () => {
    const noPose = setup({ canPose: false });
    expect(noPose.sw.liveAs(place(noPose, 5)).ok).toBe(true);
    expect(noPose.sw.fx.phase).toBe('out');
    const onMap = setup({ mode: 'map' });
    expect(onMap.sw.liveAs(place(onMap, 5)).ok).toBe(true);
    expect(onMap.sw.fx.phase).toBe('out');
  });

  it('takes the glide at 300 m exactly and the fade beyond it', () => {
    const edge = setup();
    edge.sw.liveAs(place(edge, 299));
    expect(edge.sw.fx.phase).toBe('glide');
    const past = setup();
    past.sw.liveAs(place(past, 301));
    expect(past.sw.fx.phase).toBe('out');
  });
});

describe('a change nobody asked the UI for', () => {
  it('is seen across all the same: a glide when near, a black screen that opens when far', () => {
    const near = setup();
    const id = place(near, 60);
    near.r.sim.switchTo(id);
    expect(near.arrivals[0]).toMatchObject({ to: id, reason: null, kind: 'glide' });
    expect(near.sw.fx.phase).toBe('glide');
    const far = setup();
    const f = place(far, 2000);
    // the player module attaches the new body where the schedule has them
    far.r.sim.switchTo(f);
    expect(far.arrivals[0]).toMatchObject({ to: f, reason: null });
    expect(far.sw.fx.phase === 'hold' || far.sw.fx.phase === 'glide').toBe(true);
  });
});

describe('"Rule this town"', () => {
  it('gives the ruler back once the change is over, and only once', () => {
    const s = setup();
    const id = place(s, 30);
    expect(s.sw.liveAs(id, 'rule').ok).toBe(true);
    expect(s.arrivals[0]).toMatchObject({ reason: 'rule' });
    expect(run(s.sw, 0.5).every((x) => x === null)).toBe(true); // the glide is still on
    expect(run(s.sw, GLIDE_SECONDS).filter((x) => x === id)).toHaveLength(1);
    expect(run(s.sw, 0.2).every((x) => x === null)).toBe(true);
  });

  it('forgets it when the player is not the ruler any more', () => {
    const s = setup();
    const id = place(s, 30);
    s.sw.liveAs(id, 'rule');
    s.r.sim.state.run.playerId = s.r.pid;
    expect(run(s.sw, GLIDE_SECONDS + 0.1).every((x) => x === null)).toBe(true);
  });
});

describe('resetting', () => {
  it('drops everything under way', () => {
    const s = setup();
    s.sw.liveAs(place(s, 1200));
    expect(s.sw.busy).toBe(true);
    s.sw.reset();
    expect(s.sw.busy).toBe(false);
    expect(s.sw.veil).toBe(0);
    expect(s.sw.step(5)).toBeNull();
  });
});
