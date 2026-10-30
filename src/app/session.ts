// A running game: the simulation with its gameplay modules installed in the ARCHITECTURE §4b order, the
// asset library and the renderer. `buildSession` is the one place that knows how the pieces plug together;
// `dispose` lets the app go back to the menu and start another run.
import * as THREE from 'three';
import { installAgents } from '../agents';
import type { ZoneApi } from '../agents/types';
import { createAssetLibrary, type MillenniaAssetLibrary } from '../assets/library';
import { wrapAngle } from '../core/math';
import { installPlayer } from '../player';
import { createRenderer } from '../render/renderer';
import type { GameRenderer } from '../render/types';
import type { UiRequest } from '../sim/actions';
import { installEconomy } from '../sim/economy';
import type { Simulation } from '../sim/sim';
import { installSocial } from '../sim/social';
import type { GameServices, QualitySetting, UiRendererControls } from '../ui/types';
import { wrapWithDevZone } from './devZone';

/** Where the time of getting a run on screen went (ms). */
export interface LoadTimings { assets: number; renderer: number; modules: number; settle: number }

export interface Session {
  readonly loadMs: LoadTimings;
  readonly sim: Simulation;
  readonly services: GameServices;
  readonly renderer: GameRenderer;
  readonly assets: MillenniaAssetLibrary;
  readonly controls: UiRendererControls;
  dispose(): void;
}

export interface SessionOptions {
  container: HTMLElement;
  quality: QualitySetting;
  labels: boolean;
  /** Keep the drawing buffer so screenshots of the canvas work. */
  preserveDrawingBuffer: boolean;
  /** Stand-in villagers and a horse (`?devzone=1`). */
  devZone: boolean;
  /** `ui` events of the simulation (panels the game asks for) go here. */
  forwardUi(req: UiRequest): void;
  /** Loading screen progress; the promise lets the browser paint between the heavy steps. */
  progress(fraction: number, label: string): Promise<void>;
}

export async function buildSession(sim: Simulation, o: SessionOptions): Promise<Session> {
  await o.progress(0.5, 'Gathering the folk…');
  const t0 = performance.now();
  const assets = createAssetLibrary();
  const t1 = performance.now();
  const renderer = createRenderer(o.container, sim.world, assets, {
    quality: o.quality, labels: o.labels, preserveDrawingBuffer: o.preserveDrawingBuffer,
  });
  const t2 = performance.now();

  // modules, in the order of ARCHITECTURE §4b
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  let zone: ZoneApi = installAgents(sim, { economy, social });
  if (o.devZone) zone = wrapWithDevZone(sim, zone);
  const player = installPlayer(sim, { zone, economy, social, cameraMode: () => renderer.getCameraMode() });
  // the camera looks where the character faces: at the start, and after taking over someone else
  const alignCamera = (): void => {
    const b = player.body();
    if (b) renderer.orbit(wrapAngle(b.yaw - renderer.getCameraYaw()), 0);
  };
  alignCamera();
  renderer.zoom(-1.5); // a little closer than the rig's default boom
  const offs: Array<() => void> = [
    sim.events.on('ui', (req) => o.forwardUi(req)),
    sim.events.on('playerSwitched', alignCamera),
  ];

  const t3 = performance.now();
  await o.progress(0.7, 'Preparing the land…');
  const t4 = performance.now();
  renderer.settle(sim.view, 25000);
  const t5 = performance.now();
  await o.progress(0.95, 'Almost there…');

  const services: GameServices = { sim, economy, social, zone, player };
  return {
    loadMs: { assets: t1 - t0, renderer: t2 - t1, modules: t3 - t2, settle: t5 - t4 },
    sim, services, renderer, assets, controls: makeControls(renderer),
    dispose() {
      for (const off of offs) off();
      offs.length = 0;
      renderer.dispose();
      assets.dispose();
    },
  };
}

/** What the UI may do with the camera and the screen (map panel, settings). */
export function makeControls(renderer: GameRenderer): UiRendererControls {
  const v = new THREE.Vector3();
  return {
    setQuality: (q) => renderer.setQuality(q),
    setCameraMode: (mode) => renderer.setCameraMode(mode),
    focusMap: (x, z, altitude) => renderer.focusMap(x, z, altitude),
    project(x, y, z) {
      const cam = renderer.getCamera();
      v.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
      if (v.z >= -cam.near) return null; // behind the camera
      v.applyMatrix4(cam.projectionMatrix);
      const el = renderer.domElement;
      const px = (v.x * 0.5 + 0.5) * el.clientWidth, py = (-v.y * 0.5 + 0.5) * el.clientHeight;
      return Number.isFinite(px) && Number.isFinite(py) ? { x: px, y: py } : null;
    },
    screenToGround(x, y) {
      const g = renderer.screenToGround(x, y);
      return g ? { x: g.x, z: g.z } : null;
    },
  };
}
