// Helpers for the law tests: a simulation on the stand-in world with the real territory, economy and social modules, the zone, the player
// and the combat module as fakes we can drive (the law finds every one of them lazily), and the lord's men and a stranger to play
// the trespasser.
import { FakeZone } from '../../player/fakes';
import type { Rng } from '../../../src/core/rng';
import { dist } from '../../../src/core/math';
import { installEconomy } from '../../../src/sim/economy';
import { installLaw, lawContext } from '../../../src/sim/law';
import type { LawRuntime } from '../../../src/sim/law/types';
import { newProfile } from '../../../src/sim/legacy';
import type { PlayerApi, Restraint } from '../../../src/player/types';
import { Simulation } from '../../../src/sim/sim';
import { installSocial } from '../../../src/sim/social';
import type { Person } from '../../../src/sim/state';
import { installTerritory } from '../../../src/sim/territory';
import type { TerritoryRuntime } from '../../../src/sim/territory/types';
import { createMockWorld } from '../../../src/sim/testing/mockWorld';
import type { CombatApi, FightResult, FightSide, MilitaryApi, PoliticsApi, Wound } from '../../../src/sim/wave3';
import type { Plot, WorldModel } from '../../../src/world/types';
import { mkHouse, mkHousehold, mkPerson, makePlayer } from '../builders';
import { scriptedMilitary, scriptedPolitics, type ScriptedMilitary, type ScriptedPolitics } from '../territory/helpers';

/** A player body we drive: where it stands and what binds it. */
export class FakePlayer {
  pos = { x: 0, y: 0, z: 0, yaw: 0 };
  bound: Restraint | null = null;
  placed: Array<{ x: number; z: number; yaw?: number }> = [];
  body(): { x: number; y: number; z: number; yaw: number } { return this.pos; }
  restrain(r: Restraint | null): void { this.bound = r; }
  restraint(): Restraint | null { return this.bound; }
  placeAt(x: number, z: number, yaw?: number): void { this.pos.x = x; this.pos.z = z; this.placed.push({ x, z, yaw }); if (yaw !== undefined) this.pos.yaw = yaw; }
  asApi(): PlayerApi { return this as unknown as PlayerApi; }
}

/** A combat module that only records the fights asked for; the test ends them. */
export class FakeCombat implements CombatApi {
  engaged: Array<{ id: number; sides: FightSide[]; opts: Parameters<CombatApi['engage']>[1] }> = [];
  private next = 100;
  fighting = new Set<number>();
  tended: Array<{ healer: number; patient: number }> = [];
  harmed: Array<{ person: number; intensity: number; cause: string }> = [];
  engage(sides: FightSide[], opts?: Parameters<CombatApi['engage']>[1]): number {
    const id = this.next++;
    this.engaged.push({ id, sides, opts });
    for (const s of sides) for (const p of s.people) this.fighting.add(p);
    return id;
  }
  isFighting(person: number): boolean { return this.fighting.has(person); }
  harm(person: number, intensity: number, cause: string): ReturnType<CombatApi['harm']> { this.harmed.push({ person, intensity, cause }); return 'wounded'; }
  wounds(): readonly Wound[] { return []; }
  onFightEnded(): () => void { return () => undefined; }
  anyFight(): boolean { return this.fighting.size > 0; }
  tend(healer: number, patient: number): { ok: boolean; message: string } { this.tended.push({ healer, patient }); return { ok: true, message: '' }; }
}

export interface LawRig {
  sim: Simulation;
  world: WorldModel;
  terr: TerritoryRuntime;
  law: LawRuntime;
  zone: FakeZone;
  player: FakePlayer;
  combat: FakeCombat;
  pol: ScriptedPolitics;
  mil: ScriptedMilitary;
  /** The manor of a village (the lord's closes), its lord, a stranger from another village, and the stranger's House. */
  court: { x: number; z: number };
  village: WorldModel['settlements'][number];
  lord: Person;
  lordHouse: number;
  stranger: Person;
  strangerHouse: number;
  /** Sets what the `law` random stream will answer (0..1), one value per draw, then repeats the last. */
  rig(...values: number[]): void;
  /** Runs sim sub-steps of 1/20 s. */
  run(seconds: number): void;
}

/** Puts a fake RNG stream in place of the law's: the values it will give, in order. */
function fakeRng(values: number[]): Rng {
  let i = 0;
  const next = (): number => values[Math.min(i++, values.length - 1)];
  return { next, chance: (p: number) => next() < p, pick: <T>(a: readonly T[]) => a[Math.floor(next() * a.length) % a.length], int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) } as unknown as Rng;
}

/** A village with a manor court (the lord's closes, and his lock-up) and, if asked, a gaol: the stand-in world has them by chance only. */
function ensureLockup(w: WorldModel, gaol: boolean): void {
  const plots = w.plots as Plot[];
  let manor = plots.find((p) => p.kind === 'manor_house' && p.role === 'lord_seat' && w.settlements[p.settlement].kind === 'village');
  const village = manor ? w.settlements[manor.settlement] : w.settlements.find((s) => s.kind === 'village')!;
  if (!manor) {
    const id = plots.length;
    manor = { id, kind: 'manor_house', level: 2, x: village.x + 60, z: village.z + 60, rot: 0, settlement: village.id, culture: village.culture, seed: 5, role: 'lord_seat' } as Plot;
    plots.push(manor);
    village.plots.push(id);
  }
  if (gaol) {
    const id = plots.length;
    plots.push({ id, kind: 'gaol', level: 1, x: manor.x + 25, z: manor.z, rot: 0, settlement: village.id, culture: village.culture, seed: 6, role: 'gaol' } as Plot);
    village.plots.push(id);
  }
}

export interface LawRigOptions {
  seed?: string;
  /** Add a gaol building to the village with the manor. */
  gaol?: boolean;
  zone?: boolean;
  combat?: boolean;
  /** Give the zone summon support (patrols are put in it). Default true. */
  summons?: boolean;
}

export function lawRig(o: LawRigOptions = {}): LawRig {
  const sim = Simulation.newGame({
    seed: o.seed ?? 'law', difficulty: 'knight', profile: newProfile(),
    generateWorld: (seed) => {
      const w = createMockWorld({ seed, preset: 'small' });
      ensureLockup(w, !!o.gaol);
      return w;
    },
  });
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const terr = installTerritory(sim, { social, economy });
  const pol = scriptedPolitics(sim);
  const mil = scriptedMilitary(sim);
  const zone = new FakeZone();
  if (o.summons !== false) {
    zone.enableSummons();
    // a summoned person is an agent the test can move
    const summon = zone.summon!, dismiss = zone.dismiss!;
    zone.summon = (person, x, z, yaw, opts) => {
      summon(person, x, z, yaw, opts);
      const a = zone.agent(person) ?? zone.addAgent(person, x, z);
      a.x = x; a.z = z;
      zone.summonOpts.set(person, opts ?? {});
    };
    zone.dismiss = (person) => {
      dismiss(person);
      const i = zone.agentList.findIndex((a) => a.personId === person);
      if (i >= 0) zone.agentList.splice(i, 1);
    };
  }
  const player = new FakePlayer();
  const combat = new FakeCombat();
  if (o.combat !== false) sim.services.combat = combat;
  const law = installLaw(sim, { economy, social, zone: o.zone === false ? undefined : zone, player: player.asApi() });
  const world = sim.world;
  const st = sim.state;
  const manor = world.plots.find((p: Plot) => p.kind === 'manor_house' && p.role === 'lord_seat' && world.settlements[p.settlement].kind === 'village')!;
  const village = world.settlements[manor.settlement];
  const owner = terr.ownerOf!(village.id);
  const lord = st.persons.get(owner.lord)!;
  const other = world.settlements.find((s) => s.kind === 'village' && s.id !== village.id)!;
  const strangerHouse = mkHouse(sim, 'Stranger').id;
  const stranger = mkPerson(sim, { settlement: other.id, house: strangerHouse, tier: 2, estate: 'free', career: 'merchant' });
  sim.state.joinHousehold(stranger, mkHousehold(sim, other.id));
  makePlayer(sim, stranger);
  const court = { x: manor.x, z: manor.z };
  player.pos.x = court.x; player.pos.z = court.z; player.pos.y = 10;
  zone.attachPlayer(stranger.id, { id: stranger.id } as never);
  const rig: LawRig = {
    sim, world, terr, law, zone, player, combat, pol, mil, court, village, lord, lordHouse: owner.house, stranger, strangerHouse,
    rig: (...values) => { sim.state.rngs.set('law', fakeRng(values)); },
    run: (seconds) => { for (let i = 0; i < Math.round(seconds * 20); i++) sim.step(1 / 20); },
  };
  return rig;
}

/** Everyone the patrol sent: the people the fake zone was told to summon. */
export function summoned(r: LawRig): number[] { return [...r.zone.summoned.keys()]; }

/** Puts the patrol's leader (and men) next to the player, as if they had ridden up. */
export function rideUp(r: LawRig): void {
  const leader = r.law.patrolFor(r.stranger.id)!.leader;
  for (const id of [leader, ...r.law.patrolFor(r.stranger.id)!.men]) {
    const a = r.zone.agent(id) ?? r.zone.addAgent(id, r.player.pos.x, r.player.pos.z);
    a.x = r.player.pos.x + 2.5; a.z = r.player.pos.z + 1;
  }
}

/** Moves the player's body to a point off the lord's land (the wild, far from every settlement). */
export function offLand(r: LawRig): { x: number; z: number } {
  for (let x = 200; x < 15800; x += 400) for (let z = 200; z < 15800; z += 400) {
    if (r.world.settlements.every((s) => dist(s.x, s.z, x, z) > 3300)) return { x, z };
  }
  throw new Error('no wild land');
}

export { lawContext };
export type { CombatApi, FightResult, MilitaryApi, PoliticsApi };
