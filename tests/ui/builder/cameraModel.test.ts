// Builder mode's camera: the pose of our own bird's-eye camera, dragging the ground, zoom and turn limits, the movement keys, and how
// the probe decides whether the renderer's overview camera took over — and the camera driver against a renderer that has one and one that has not.
import { describe, expect, it } from 'vitest';
import { BuilderCamera, cameraVerdict, newWatch, VERDICT, wideSpan, type CameraPorts, type Sight } from '../../../src/ui/builder/builderCamera';
import {
  CAM_LIMITS, clampToCircle, dragged, heldPan, initialCam, keyPanPixels, orbited, poseFor, stepToCentre, zoomed, type CamState,
} from '../../../src/ui/builder/cameraModel';
import type { UiRendererControls } from '../../../src/ui/types';

const cam = (over: Partial<CamState> = {}): CamState => ({ x: 100, z: 200, yaw: 0, pitch: CAM_LIMITS.defaultPitch, distance: 100, ...over });

describe('our own overhead camera', () => {
  it('stands the camera at its distance from the target, looking at it, above the ground', () => {
    const p = poseFor(cam({ yaw: 0.7 }), 30);
    const d = Math.hypot(p.position.x - p.lookAt.x, p.position.y - p.lookAt.y, p.position.z - p.lookAt.z);
    expect(d).toBeCloseTo(100, 6);
    expect(p.lookAt).toEqual({ x: 100, y: 30, z: 200 });
    expect(p.position.y).toBeCloseTo(30 + Math.sin(CAM_LIMITS.defaultPitch) * 100, 6);
  });

  it('looks along its yaw: yaw 0 faces +z, a quarter turn faces +x', () => {
    const a = poseFor(cam({ yaw: 0 }), 0);
    expect(a.position.z).toBeLessThan(a.lookAt.z);
    expect(a.position.x).toBeCloseTo(a.lookAt.x, 9);
    const b = poseFor(cam({ yaw: Math.PI / 2 }), 0);
    expect(b.position.x).toBeLessThan(b.lookAt.x);
    expect(b.position.z).toBeCloseTo(b.lookAt.z, 9);
  });

  it('drags the ground: dragging down brings what lies forward, dragging right moves the camera left', () => {
    const c = cam({ yaw: 0 });
    const down = dragged(c, 0, 100, 720);
    expect(down.z).toBeGreaterThan(c.z);
    expect(down.x).toBeCloseTo(c.x, 9);
    const right = dragged(c, 100, 0, 720);
    // facing +z the camera's right is −x, so moving left is +x
    expect(right.x).toBeGreaterThan(c.x);
    // turned a quarter (facing +x) dragging down moves +x
    const turned = dragged(cam({ yaw: Math.PI / 2 }), 0, 100, 720);
    expect(turned.x).toBeGreaterThan(100);
    expect(turned.z).toBeCloseTo(200, 6);
  });

  it('moves further per pixel the further the camera is', () => {
    const near = dragged(cam({ distance: 40 }), 0, 50, 720);
    const far = dragged(cam({ distance: 400 }), 0, 50, 720);
    expect(far.z - 200).toBeGreaterThan((near.z - 200) * 5);
  });

  it('keeps the target inside the circle', () => {
    const c = clampToCircle(cam({ x: 1000, z: 0 }), { x: 0, z: 0 }, 300);
    expect(Math.hypot(c.x, c.z)).toBeCloseTo(300, 6);
    expect(clampToCircle(cam({ x: 10, z: 10 }), { x: 0, z: 0 }, 300).x).toBe(10);
  });

  it('zooms between its limits and turns with the pitch held between its', () => {
    expect(zoomed(cam({ distance: 100 }), -50, 500).distance).toBe(CAM_LIMITS.minDistance);
    expect(zoomed(cam({ distance: 100 }), 80, 500).distance).toBeCloseTo(500 * CAM_LIMITS.maxDistanceFactor, 6);
    expect(zoomed(cam({ distance: 100 }), 1, 500).distance).toBeGreaterThan(100);
    expect(zoomed(cam({ distance: 100 }), -1, 500).distance).toBeLessThan(100);
    const o = orbited(cam({ pitch: 1 }), 0.2, 5);
    expect(o.pitch).toBe(CAM_LIMITS.maxPitch);
    expect(orbited(cam({ pitch: 1 }), 0, -5).pitch).toBe(CAM_LIMITS.minPitch);
    expect(orbited(cam({ yaw: 3 }), 1, 0).yaw).toBeLessThan(0);
    expect(initialCam({ x: 5, z: 6, distance: 77 }, 1)).toMatchObject({ x: 5, z: 6, distance: 77, yaw: 1 });
  });
});

describe('the movement keys', () => {
  it('combine W A S D and the arrows, opposing keys cancelling', () => {
    expect(heldPan(new Set(['KeyW']))).toEqual({ forward: 1, right: 0 });
    expect(heldPan(new Set(['KeyW', 'ArrowUp']))).toEqual({ forward: 1, right: 0 });
    expect(heldPan(new Set(['KeyW', 'KeyS']))).toEqual({ forward: 0, right: 0 });
    expect(heldPan(new Set(['KeyD', 'ArrowLeft']))).toEqual({ forward: 0, right: 0 });
    expect(heldPan(new Set(['KeyA', 'KeyS']))).toEqual({ forward: -1, right: -1 });
    expect(heldPan(new Set(['KeyZ']))).toEqual({ forward: 0, right: 0 });
  });

  it('ask the camera for what the map\'s keys ask: W drags the ground down, D drags it left', () => {
    expect(keyPanPixels(1, 0, 0.1)).toEqual({ dx: -0, dy: 60 });
    expect(keyPanPixels(0, 1, 0.1).dx).toBeCloseTo(-60, 9);
    expect(keyPanPixels(0, 0, 0.1)).toEqual({ dx: -0, dy: 0 });
  });

  it('glides a point to the middle of the screen and stops there', () => {
    expect(stepToCentre(640, 360, 1280, 720)).toBeNull();
    expect(stepToCentre(644, 358, 1280, 720)).toBeNull();
    const s = stepToCentre(1000, 360, 1280, 720)!;
    expect(s.dx).toBeLessThan(0);
    expect(Math.abs(s.dy)).toBeLessThan(1e-9);
    // converges
    let x = 1000, y = 100;
    for (let i = 0; i < 200; i++) {
      const st = stepToCentre(x, y, 1280, 720);
      if (!st) break;
      x += st.dx; y += st.dy;
    }
    expect(Math.hypot(x - 640, y - 360)).toBeLessThanOrEqual(6);
    // a small remaining offset still moves at least a few pixels a frame (no endless crawl)
    expect(Math.hypot(stepToCentre(700, 360, 1280, 720)!.dx, 0)).toBeGreaterThanOrEqual(6 - 1e-9);
  });
});

describe('did the renderer\'s overview camera take over?', () => {
  const seen = (x: number, y: number, span: number): Sight => ({ point: { x, y }, span });
  const own = seen(100, 100, 12); // the player's camera: a dozen metres across the middle of the screen

  it('yes when the camera looks down on a wide stretch of ground, and keeps doing so', () => {
    const w = newWatch();
    expect(cameraVerdict(w, seen(300, 200, 40), own, 150, 0.3)).toBe('wait');
    expect(cameraVerdict(w, seen(500, 300, 70), own, 150, 0.4)).toBe('wait'); // wide: the first of three frames
    expect(cameraVerdict(w, seen(640, 360, 85), own, 150, 0.5)).toBe('wait');
    expect(cameraVerdict(w, seen(640, 360, 86), own, 150, 0.6)).toBe('overview');
  });

  it('a camera that merely moves is not an overview camera', () => {
    // the follow camera settling after a change of character, or moving with a player who walks: the picture moves, the span stays small
    const w = newWatch();
    let v = 'wait';
    for (let i = 0; i < VERDICT.lateFrames - 1; i++) v = cameraVerdict(w, seen(100 + i * 9, 100, 11 + (i % 3)), own, 150, 0.2);
    expect(v).toBe('wait');
    // a wide look that does not last is not believed either
    for (let i = 0; i < 20; i++) cameraVerdict(w, seen(100 + i * 9, 100, i % 2 ? 90 : 12), own, 150, 0.5);
    // once the glide of an overview camera must have been and gone, it says none
    expect(cameraVerdict(w, seen(900, 100, 12), own, 150, 0.5)).toBe('wait');
    expect(cameraVerdict(w, seen(950, 100, 12), own, 150, VERDICT.lateSeconds)).toBe('none');
  });

  it('a picture that has not moved for a dozen frames and half a second says none', () => {
    const w = newWatch();
    let v: string = 'wait';
    for (let i = 0; i < VERDICT.stillFrames - 1; i++) v = cameraVerdict(w, own, own, 150, 1);
    expect(v).toBe('wait');
    expect(cameraVerdict(w, own, own, 150, 0.2)).toBe('wait');
    expect(cameraVerdict(w, own, own, 150, 0.6)).toBe('none');
    // a point that is off-screen both times is as still as one that stays on it
    const w2 = newWatch();
    for (let i = 0; i < VERDICT.stillFrames; i++) v = cameraVerdict(w2, { point: null, span: 0 }, { point: null, span: 0 }, 150, 1);
    expect(v).toBe('none');
  });

  it('a camera that already looked wide (the map) is not taken for an overview camera by looking as wide', () => {
    const w = newWatch();
    const wide = seen(640, 360, 80);
    let v = 'wait';
    for (let i = 0; i < 5; i++) v = cameraVerdict(w, wide, wide, 150, 0.2);
    expect(v).toBe('wait');
  });

  it('how wide is wide: scores of metres, a share of the distance asked for', () => {
    expect(wideSpan(120)).toBeCloseTo(36, 6);
    expect(wideSpan(170)).toBeCloseTo(51, 6);
    expect(wideSpan(20)).toBe(24);
    expect(wideSpan(2000)).toBe(60);
  });
});

// ---- the driver, against two kinds of renderer --------------------------------------------------

interface Fake extends UiRendererControls {
  calls: string[];
  mode: 'follow' | 'free';
  point: { x: number; y: number };
  /** Metres of ground per pixel on the screen: a few centimetres from the player's camera, a dozen from a bird's-eye one. */
  scale: number;
  poses: Array<{ position: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number }; seconds?: number }>;
}

/** A renderer that has an overview camera (it changes its mode and the picture when asked) or does not (the call does nothing). */
function fakeRenderer(hasOverview: boolean): Fake {
  const f: Fake = {
    calls: [], mode: 'follow', point: { x: 100, y: 100 }, scale: 0.01, poses: [],
    setQuality: () => undefined,
    setCameraMode(m) { f.calls.push(`mode:${m}`); f.mode = m === 'free' ? 'free' : 'follow'; },
    focusMap: () => undefined,
    project: () => ({ ...f.point }),
    screenToGround: (x, y) => ({ x: x * f.scale, z: y * f.scale }),
    cameraYaw: () => 0.25,
    cameraMode: () => f.mode,
    setCameraPose(position, lookAt, seconds) { f.calls.push('pose'); f.poses.push({ position, lookAt, seconds }); f.mode = 'free'; },
    setOverview(v) {
      f.calls.push(v ? 'overview:on' : 'overview:off');
      if (hasOverview && v) { f.mode = 'free'; f.point = { x: 640, y: 360 }; f.scale = 0.1; }
    },
    orbit: () => { f.calls.push('orbit'); },
    zoom: () => { f.calls.push('zoom'); },
    pan: () => { f.calls.push('pan'); },
  };
  return f;
}

function driver(r: Fake): BuilderCamera {
  const ports: CameraPorts = { renderer: () => r, heightAt: () => 0, viewport: () => ({ w: 1280, h: 720 }), clock: () => t };
  let t = 0;
  const cam = new BuilderCamera(ports, { x: 500, z: 600, radius: 800, distance: 150 });
  const tick = cam.tick.bind(cam);
  cam.tick = () => { t += 0.05; tick(); };
  return cam;
}

describe('the camera driver', () => {
  it('uses the renderer\'s overview camera when the renderer has one, and hands the controls to it', () => {
    const r = fakeRenderer(true);
    const c = driver(r);
    c.enter();
    expect(r.calls).toEqual(['overview:on']);
    for (let i = 0; i < 4; i++) c.tick();
    expect(c.kind).toBe('overview');
    c.pan(5, 5); c.orbit(0.1, 0); c.zoom(1);
    expect(r.calls.slice(1)).toEqual(['pan', 'orbit', 'zoom']);
    expect(r.poses).toHaveLength(0);
    c.leave();
    expect(r.calls[r.calls.length - 1]).toBe('overview:off');
  });

  it('lays its own bird\'s-eye camera when the renderer has none, and gives the follow camera back', () => {
    const r = fakeRenderer(false);
    const c = driver(r);
    c.enter();
    for (let i = 0; i < 40 && c.kind === 'pending'; i++) c.tick();
    expect(c.kind).toBe('pose');
    expect(r.poses).toHaveLength(1);
    expect(r.poses[0].lookAt).toMatchObject({ x: 500, z: 600 });
    expect(r.poses[0].position.y).toBeGreaterThan(50);
    // pan, zoom and turn move our camera and re-pose it
    const before = c.state();
    c.pan(0, 80); c.zoom(-2); c.orbit(0.3, 0.1);
    c.tick();
    expect(r.poses).toHaveLength(2);
    expect(c.state().z).toBeGreaterThan(before.z - 1e-9);
    expect(c.state().distance).toBeLessThan(before.distance);
    expect(c.state().yaw).not.toBe(before.yaw);
    // the circle holds
    for (let i = 0; i < 400; i++) c.pan(0, 400);
    expect(Math.hypot(c.state().x - 500, c.state().z - 600)).toBeLessThanOrEqual(800 + 1e-6);
    c.leave();
    expect(r.calls[r.calls.length - 1]).toBe('mode:follow');
    // leaving twice does nothing more
    const n = r.calls.length;
    c.leave();
    expect(r.calls).toHaveLength(n);
  });

  it('lays its own camera at once when the controls have no overview call at all', () => {
    const r = fakeRenderer(false);
    delete r.setOverview;
    const c = driver(r);
    c.enter();
    c.tick();
    expect(c.kind).toBe('pose');
    expect(r.poses).toHaveLength(1);
    expect(r.calls).toEqual(['pose']);
  });

  it('glides to a spot in either camera', () => {
    const own = fakeRenderer(false);
    const c = driver(own);
    c.enter();
    for (let i = 0; i < 40 && c.kind === 'pending'; i++) c.tick();
    c.panTo(600, 650);
    for (let i = 0; i < 200; i++) c.tick();
    expect(Math.hypot(c.state().x - 600, c.state().z - 650)).toBeLessThan(2);
    // with the renderer's camera the glide is made of pans toward the middle of the screen
    const r = fakeRenderer(true);
    const c2 = driver(r);
    c2.enter();
    for (let i = 0; i < 4; i++) c2.tick();
    r.point = { x: 900, y: 200 };
    c2.panTo(1, 1);
    c2.tick();
    expect(r.calls.filter((x) => x === 'pan').length).toBeGreaterThan(0);
  });

  it('can look over another circle of land', () => {
    const r = fakeRenderer(true);
    const c = driver(r);
    c.enter();
    c.recentre({ x: 1, z: 2, radius: 300, distance: 90 });
    expect(r.calls.filter((x) => x === 'overview:on')).toHaveLength(2);
    expect(c.centre()).toEqual({ x: 64, z: 36 });
  });
});
