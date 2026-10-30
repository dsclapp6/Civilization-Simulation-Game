// Test doubles for the player module: a flat zone with rectangular walls, scripted interactables, agents
// and animals, plus helpers to build a simulation with the player installed.
import type {
  InteractCandidate, MoveResult, NavApi, ZoneAgent, ZoneAnimal, ZoneApi, AgentOrder, Whereabouts,
} from '../../src/agents/types';
import type { P2 } from '../../src/core/math';
import type { AnimalKind } from '../../src/core/domain';
import type { CharacterDrawItem } from '../../src/core/view';
import type { ActionOption, ActionProvider, TargetRef } from '../../src/sim/actions';
import { installPlayer } from '../../src/player';
import type { PlayerApi, InputState } from '../../src/player/types';
import { EMPTY_INPUT } from '../../src/player/types';
import { installEconomy } from '../../src/sim/economy';
import { installSocial } from '../../src/sim/social';
import type { EconomyApi } from '../../src/sim/economy/types';
import type { SocialApi } from '../../src/sim/social/types';
import type { Simulation } from '../../src/sim/sim';
import type { PersonId } from '../../src/sim/state';
import { newSim, type TestSimOptions } from '../sim/helpers';

export interface Wall { x0: number; z0: number; x1: number; z1: number }
export interface Thing { target: TargetRef; x: number; z: number; label: string }

export class FakeZone implements ZoneApi {
  walls: Wall[] = [];
  /** Shallow water rectangles (wading). */
  water: Wall[] = [];
  /** Ground height as a function of position (default flat 10 m, like the mock world). */
  heightFn: (x: number, z: number) => number = () => 10;
  things: Thing[] = [];
  agentList: ZoneAgent[] = [];
  animalList: ZoneAnimal[] = [];
  readonly held = new Map<PersonId, PersonId | undefined>();
  readonly released: PersonId[] = [];
  readonly commands: Array<{ person: PersonId; order: AgentOrder }> = [];
  attached: { person: PersonId; draw: CharacterDrawItem } | null = null;
  attachCount = 0;
  detachCount = 0;
  resyncCount = 0;
  claimed: number[] = [];
  releasedAnimals: Array<{ id: number; x: number; z: number; yaw: number }> = [];
  supportsClaims = true;
  whereaboutsFn: ((person: PersonId) => Whereabouts) | null = null;
  doors = new Map<number, { x: number; z: number; yaw: number }>();

  private hits(x: number, z: number, r: number): boolean {
    for (const w of this.walls) {
      const cx = Math.max(w.x0, Math.min(x, w.x1)), cz = Math.max(w.z0, Math.min(z, w.z1));
      if ((x - cx) * (x - cx) + (z - cz) * (z - cz) < r * r) return true;
    }
    return false;
  }

  readonly nav: NavApi = {
    groundY: (x, z) => this.heightFn(x, z),
    walkable: (x, z) => !this.hits(x, z, 0.3),
    speedFactor: () => 1,
    move: (x, z, dx, dz, radius, out: MoveResult) => {
      let nx = x + dx;
      let blocked = false;
      if (this.hits(nx, z, radius)) { nx = x; blocked = true; }
      let nz = z + dz;
      if (this.hits(nx, nz, radius)) { nz = z; blocked = true; }
      out.x = nx; out.z = nz; out.blocked = blocked;
      out.wading = this.water.some((w) => nx >= w.x0 && nx <= w.x1 && nz >= w.z0 && nz <= w.z1);
      return out;
    },
    findPath: (from: P2, to: P2) => [{ x: from.x, z: from.z }, { x: to.x, z: to.z }],
    nearestWalkable: (x, z, _d, out) => { out.x = x + 1; out.z = z; return true; },
    doorOf: (id) => this.doors.get(id) ?? null,
  };

  agents(): readonly ZoneAgent[] { return this.agentList; }
  agent(person: PersonId): ZoneAgent | null { return this.agentList.find((a) => a.personId === person) ?? null; }
  animals(): readonly ZoneAnimal[] { return this.animalList; }
  whereabouts(person: PersonId): Whereabouts {
    if (this.whereaboutsFn) return this.whereaboutsFn(person);
    return { activity: 'home', settlement: 0, building: -1, indoors: false, x: 100, z: 100, label: 'At home' };
  }
  interactables(x: number, z: number, yaw: number, range: number, out: InteractCandidate[]): InteractCandidate[] {
    out.length = 0;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const scored: Array<{ c: InteractCandidate; s: number }> = [];
    for (const t of this.things) {
      const d = Math.hypot(t.x - x, t.z - z);
      if (d > range) continue;
      const facing = d > 0.01 ? ((t.x - x) * fx + (t.z - z) * fz) / d : 1;
      if (facing < -0.2) continue;
      scored.push({ c: { target: t.target, x: t.x, z: t.z, distance: d, label: t.label }, s: d - facing });
    }
    scored.sort((a, b) => a.s - b.s);
    for (const s of scored) out.push(s.c);
    return out;
  }
  hold(person: PersonId, face?: PersonId): void { this.held.set(person, face); }
  release(person: PersonId): void { this.held.delete(person); this.released.push(person); }
  command(person: PersonId, order: AgentOrder): void { this.commands.push({ person, order }); }
  say(): void {}
  attachPlayer(person: PersonId, draw: CharacterDrawItem): void { this.attached = { person, draw }; this.attachCount++; }
  detachPlayer(): void { this.attached = null; this.detachCount++; }
  resync(): void { this.resyncCount++; }
  propsFor(): ReturnType<ZoneApi['propsFor']> { return { mainHand: 'none', offHand: 'none', carry: 'none' }; }
  claimAnimal = (id: number): boolean => {
    if (!this.supportsClaims) return false;
    this.claimed.push(id);
    return true;
  };
  releaseAnimal = (id: number, x: number, z: number, yaw: number): void => {
    this.releasedAnimals.push({ id, x, z, yaw });
  };

  addAgent(personId: PersonId, x: number, z: number): ZoneAgent {
    const a: ZoneAgent = {
      personId, x, y: 10, z, yaw: 0, speed: 0, activity: 'idle', goal: null, control: 'ai', visible: true,
      draw: {
        id: personId, x, y: 10, z, yaw: 0, look: undefined as never, lookVersion: 1, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none',
        anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 0,
      },
    };
    this.agentList.push(a);
    return a;
  }

  addAnimal(id: number, kind: AnimalKind, x: number, z: number, owner: number): ZoneAnimal {
    const a: ZoneAnimal = {
      id, kind, x, z, owner, wild: owner === 0, hostile: false,
      draw: { id, kind, x, y: 10, z, yaw: 0, anim: 'idle', animTime: 0, moveSpeed: 0, scale: 1, coat: 0x7a5032, highlight: 0 },
    };
    this.animalList.push(a);
    return a;
  }
}

/** A provider with a timed "Work" and an instant "Chat" action on anything, plus a disabled "Locked" one. */
export function workProvider(opts: { seconds?: number; repeat?: boolean } = {}): ActionProvider & { done: number[]; started: number } {
  const state = { done: [] as number[], started: 0 };
  return Object.assign(state, {
    id: 'testwork',
    list(_ctx: unknown, _actor: PersonId, target: TargetRef, out: ActionOption[]): void {
      if (target.kind === 'self') return;
      out.push({
        id: 'work', provider: '', label: 'Work', category: 'work' as const, target, enabled: true, seconds: opts.seconds ?? 4, anim: 'work_hoe' as const,
        mainHand: 'hoe' as const, range: 2.6, priority: 5, repeat: opts.repeat,
      });
      out.push({ id: 'chat', provider: '', label: 'Chat', category: 'social' as const, target, enabled: true, seconds: 0, range: 3, priority: 3 });
    },
    start() { state.started++; },
    complete(_c: unknown, _a: PersonId, _o: ActionOption, fraction: number) { state.done.push(fraction); return { ok: true, message: 'Worked.' }; },
    partial: true,
  });
}

export interface Rig {
  sim: Simulation;
  zone: FakeZone;
  player: PlayerApi;
  economy: EconomyApi;
  social: SocialApi;
  pid: PersonId;
}

/** A simulation (mock world) with the placeholder economy/social, a fake zone and the player installed. */
export function rig(opts: TestSimOptions & { zone?: (z: FakeZone) => void } = {}): Rig {
  const sim = newSim(opts);
  const zone = new FakeZone();
  opts.zone?.(zone);
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const player = installPlayer(sim, { zone, economy, social });
  return { sim, zone, player, economy, social, pid: sim.state.run.playerId };
}

export function input(over: Partial<InputState> = {}): InputState {
  return { ...EMPTY_INPUT, ...over };
}

/** Runs `n` fixed sub-steps' worth of real time at 1× (steps of 1/20 s), feeding the same input. */
export function run(r: Rig, seconds: number, inp: Partial<InputState> = {}, frameDt = 1 / 20): void {
  const frames = Math.round(seconds / frameDt);
  for (let i = 0; i < frames; i++) {
    r.player.setInput(input(inp));
    r.sim.step(frameDt);
    r.player.frame?.(frameDt);
  }
}
