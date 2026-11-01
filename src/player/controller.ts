// The player controller: possession of one character. It owns the body (movement, stamina, mounting),
// the interaction target and prompt, the HUD model, map travel with encounters, and the hand-over when the
// character dies or the player switches to someone else. Input arrives as an InputState (src/app/input.ts);
// the body is advanced in the sim's fixed sub-steps and smoothed between them for drawing.
import type { InteractCandidate, ZoneApi } from '../agents/types';
import { angleDiff, clamp, dist, type P2, yawTo } from '../core/math';
import { SIM_DT, isNight } from '../core/time';
import type {
  AnimState, CarryLook, CharacterDrawItem, HeldItem, MapMarker, MountLook, PlayerView, ViewMode,
} from '../core/view';
import { sameTarget, type ActionOption, type ActionOutcome, type ActiveAction, type TargetRef } from '../sim/actions';
import type { EconomyApi } from '../sim/economy/types';
import type { SimEvents } from '../sim/events';
import { MAX_FRAME_DT, type Simulation } from '../sim/sim';
import { skillOf, gainSkill } from '../sim/skills';
import type { SocialApi } from '../sim/social/types';
import { ageYears, fullName, type Person, type PersonId } from '../sim/state';
import { doorPoint } from '../sim/view-impl';
import { formatMoney } from '../sim/money';
import type { FightResult, PlayerCombatFrame, PlayerCombatPort, PlayerCombatPose } from '../sim/wave3';
import type { PlayerCombatHud } from './types';
import type { WorldModel } from '../world/types';
import {
  DISMOUNT_SECONDS, MOUNT_SECONDS, createBody, placeBody, stepBody, type BodyEnv, type BodyState, type BodyTraits,
} from './body';
import {
  buildChoices, encounterRate, escapeChoice, makeEncounter, participantCount, payMoney, pickEncounterKind, pickParticipants, pressOnChoice, sampleDanger, takeGoods, type ChoiceDef, type DangerSample,
  type EncounterData, type EncounterEnv,
} from './encounters';
import { Interaction, SCAN_INTERVAL } from './interaction';
import { footAnim, rideAnim, maxStamina, workEffort, turnToward } from './movement';
import { PROVIDER_ID, createPlayerProvider, type ProviderHost } from './providers';
import { planRoute } from './route';
import { ARRIVED_SECONDS, Journey, journeyPace } from './travel';
import {
  EMPTY_INPUT, type EncounterKind, type InputState, type PlayerApi, type PlayerDebug, type PlayerHud, type Result, type TravelState,
} from './types';

export interface PlayerDeps {
  zone: ZoneApi;
  economy: EconomyApi;
  social: SocialApi;
  /** The renderer's camera mode; `'map'` tells the sim the strategic map is open (the zone goes quiet). */
  cameraMode?: () => string;
}

const EXT_KEY = 'player';
const TRAIT_INTERVAL = 1;
const PERSIST_INTERVAL = 1;
const CONVERSATION_RANGE = 4.5;
const MOUNT_RANGE = 6;
/** The camera rises to the map, slides to the new character and descends (seconds in the map view / in all). */
const SWITCH_MAP = 1.5;
const SWITCH_TOTAL = 1.9;
const DEAD_FALL_SECONDS = 1.3;

interface PlayerExt {
  v: 1;
  person: PersonId;
  x: number;
  z: number;
  yaw: number;
  mount?: { animal: number; coat: number };
}

const BENCH_KINDS: ReadonlySet<string> = new Set(['alehouse', 'tavern', 'inn', 'church', 'chapel', 'great_hall', 'market_hall', 'manor_house', 'guildhall']);

export class PlayerController implements PlayerApi {
  readonly debug: PlayerDebug;

  private readonly sim: Simulation;
  private readonly zone: ZoneApi;
  private readonly economy: EconomyApi;
  private readonly social: SocialApi;
  private readonly world: WorldModel;
  private readonly cameraModeFn: () => string;

  private personId: PersonId = 0;
  private avatar: BodyState;
  private draw: CharacterDrawItem;
  private dead = false;
  private deadFor = 0;

  // ---- input ----
  private readonly input: InputState = { ...EMPTY_INPUT };
  private edgeInteract = false;
  private edgeMount = false;
  private edgeDodge = false;
  private edgeCancel = false;

  // ---- combat (wave 3, src/combat): the port is looked up lazily, the module may be absent ----
  private readonly cframe: PlayerCombatFrame = {
    person: 0, x: 0, y: 0, z: 0, yaw: 0, speed: 0, mounted: false, dodgeT: 0, stamina: 0, staminaMax: 0, busy: false, dt: 0,
  };
  private readonly cpose: PlayerCombatPose = {
    engaged: false, anim: null, animTime: 0, mainHand: null, offHand: null, moveScale: 1, faceYaw: null, aimPitch: null, staminaCost: 0,
    effort: 0, noSprint: false, aiming: false, unhorse: false, armour: null, helmet: null,
  };
  /** The pose of the current step (null when nothing combat-like is asked of the body). */
  private combatPose: PlayerCombatPose | null = null;
  private readonly combatInput: InputState = { ...EMPTY_INPUT };
  /** What the HUD draws of the fight (reused object); `hitSeq` counts blows taken. */
  private readonly hudCombat: PlayerCombatHud = { engaged: false, state: 'ready', ranged: false, hitSeq: 0 };
  /** A road fight in progress: the journey it interrupted and the way to stop listening for its end. */
  private fighting: { journey: Journey; data: EncounterData; id: number; off: () => void } | null = null;
  private shownArmour = '';
  private shownVersion = -1;

  // ---- clocks ----
  private steps = 0;
  private stepsSinceFrame = 0;
  private acc = 0;
  private simTime = 0;
  private renderTime = 0;
  private scanT = 0;
  private traitT = 0;
  private persistT = 0;
  private lookT = 0;
  private markerT = 0;

  // ---- interaction ----
  private readonly interaction = new Interaction();
  private faceYaw: number | null = null;
  private followId: PersonId | null = null;
  private followRepath = 0;
  private followPath: P2[] | null = null;
  private followIndex = 0;
  private readonly followInput: InputState = { ...EMPTY_INPUT };

  // ---- travel ----
  private journey: Journey | null = null;
  private encounterChoicesCache: ChoiceDef[] = [];
  private hostileEncounter = false;
  private readonly danger: DangerSample = { forest: 0, wild: false, border: false, nearSettlement: false, night: false, winter: false, holyDay: false, leg: 'road' };
  private switchFx: { t: number; fromX: number; fromZ: number; toX: number; toZ: number } | null = null;
  private pendingAltitude: number | null = null;
  /** The view must read 'street' until the renderer's camera has left the map (see viewMode). */
  private streetPending = false;
  /** People and animals the zone was asked to show for the open encounter (dismissed when it ends). */
  private summonedPeople: PersonId[] = [];
  private summonedAnimals: number[] = [];

  // ---- derived, refreshed at intervals ----
  private readonly traits: BodyTraits = { agility: 10, endurance: 10, age: 12, ridingLevel: 0, weight: 0, capacity: 30, hunger: 1, rest: 1 };
  private dangerNear = false;
  private seatHeight = 0;
  private lastAnim: AnimState = 'idle';
  private animT = 0;

  // ---- reused objects ----
  private readonly hudObj: PlayerHud;
  private readonly hudAction: NonNullable<PlayerHud['action']> = { label: '', progress: 0, seconds: 0 };
  private readonly playerView: PlayerView = { personId: 0, x: 0, y: 0, z: 0, yaw: 0, mounted: false, alive: true };
  private readonly focusPoint: P2 = { x: 0, z: 0 };
  private readonly markers: MapMarker[] = [
    { id: 0, kind: 'player', x: 0, z: 0, color: 0xffd24a, size: 1, label: '' },
    { id: -1001, kind: 'home', x: 0, z: 0, color: 0x6fbf73, size: 1, label: 'Home' },
    { id: -1002, kind: 'work', x: 0, z: 0, color: 0x6fa8dc, size: 1, label: 'Work' },
  ];
  private readonly markerList: MapMarker[] = [];
  private readonly mapFocusObj: { x: number; z: number; altitude?: number } = { x: 0, z: 0 };
  private readonly walkOut: P2 = { x: 0, z: 0 };
  private readonly bodyView = { x: 0, y: 0, z: 0, yaw: 0 };
  private rideMark = 0;
  private readonly offs: Array<() => void> = [];
  private persisted: PlayerExt | null = null;

  constructor(sim: Simulation, deps: PlayerDeps) {
    this.sim = sim;
    this.zone = deps.zone;
    this.economy = deps.economy;
    this.social = deps.social;
    this.world = sim.world;
    this.cameraModeFn = deps.cameraMode ?? (() => 'follow');

    // placeholders until `attach` creates the real ones
    this.avatar = createBody(0, 0, 0, 0, 10);
    this.draw = this.emptyDraw();
    this.hudObj = this.emptyHud();
    this.debug = {
      forceEncounter: (kind) => this.forceEncounter(kind),
      forceMount: (coat) => { this.forceMount(coat); },
      setStamina: (v) => { this.avatar.stamina.value = clamp(v, 0, this.avatar.stamina.max); this.avatar.stamina.exhausted = v <= 0; },
      steps: () => this.steps,
    };

    this.install();
  }

  // ===========================================================================================
  // Installation
  // ===========================================================================================

  private install(): void {
    const sim = this.sim;
    sim.registerSystem({ name: 'player.step', phase: 'perStep', order: 40, run: (_c, info) => this.step(info.dt) });
    sim.actions.register(createPlayerProvider(this.providerHost()));
    sim.view.setSource('player', () => this.viewPlayer());
    sim.view.setSource('focus', () => this.viewFocus());
    sim.view.setSource('mode', () => this.viewMode());
    sim.view.setSource('mapMarkers', () => this.viewMarkers());

    const ev = sim.events;
    this.offs.push(
      ev.on('playerDied', (e) => this.onPlayerDied(e)),
      ev.on('playerSwitched', (e) => this.onPlayerSwitched(e)),
      ev.on('gameOver', () => this.onGameOver()),
      ev.on('conversation', (e) => this.onConversation(e)),
      ev.on('action', () => this.interaction.invalidate()),
      ev.on('skip', (e) => { if (e.phase !== 'start') this.interaction.invalidate(); }),
    );
    // the encounter in progress counts as a hostile near: no hurrying, no sleeping
    const prev = sim.hostileNear;
    sim.hostileNear = () => this.hostileEncounter || prev();

    const run = sim.state.run;
    const ext = sim.state.ext[EXT_KEY] as PlayerExt | undefined;
    if (run.phase === 'choosing' && run.pendingSuccession) {
      // loaded in the middle of a succession: the dead character's body lies where it fell
      this.attach(run.pendingSuccession.person, 'load', ext);
      this.markDead();
      this.deadFor = DEAD_FALL_SECONDS + 1; // already on the ground
    } else if (run.phase === 'alive') {
      this.attach(run.playerId, ext && ext.person === run.playerId ? 'load' : 'home', ext);
    }
  }

  /** Takes the position, draw item and registration for a (new) character. */
  private attach(id: PersonId, how: 'home' | 'load' | 'whereabouts', ext?: PlayerExt): void {
    const p = this.sim.state.persons.get(id);
    this.personId = id;
    this.dead = false;
    this.combat()?.reset();
    this.combatPose = null;
    if (this.fighting) { this.fighting.off(); this.fighting = null; }
    this.journey = null;
    this.encounterChoicesCache = [];
    this.hostileEncounter = false;
    this.followId = null;
    if (!p) return;
    this.refreshTraits(p);
    const spot = this.spawnSpot(p, how, ext);
    this.avatar = createBody(spot.x, spot.z, spot.yaw, 0, this.traits.endurance);
    placeBody(this.avatar, spot.x, spot.z, spot.yaw, this.zone.nav);
    this.draw = this.makeDraw(p);
    if (how === 'load' && ext && ext.mount && ext.person === id) {
      // riding when the run was saved: take the same horse back if the zone still has it
      const claimed = this.zone.claimAnimal ? this.zone.claimAnimal(ext.mount.animal) : false;
      if (claimed || !this.zone.claimAnimal) this.avatar.mounted = { animal: ext.mount.animal, coat: ext.mount.coat, claimed };
    }
    this.syncDraw(1);
    this.zone.attachPlayer(id, this.draw);
    this.interaction.invalidate();
    this.scanT = SCAN_INTERVAL;
    this.persistT = PERSIST_INTERVAL;
    this.persistNow();
    this.zone.resync();
  }

  private spawnSpot(p: Person, how: 'home' | 'load' | 'whereabouts', ext?: PlayerExt): { x: number; z: number; yaw: number } {
    const nav = this.zone.nav;
    if (how === 'load' && ext && ext.person === p.id && Number.isFinite(ext.x) && Number.isFinite(ext.z)) {
      return { x: ext.x, z: ext.z, yaw: Number.isFinite(ext.yaw) ? ext.yaw : 0 };
    }
    let spot: { x: number; z: number; yaw: number } | null = null;
    if (how === 'whereabouts') {
      const w = this.zone.whereabouts(p.id);
      if (!w.indoors) spot = { x: w.x, z: w.z, yaw: 0 };
      else if (w.building >= 0) spot = nav.doorOf(w.building) ?? null;
    }
    spot ??= this.homeDoor(p);
    if (!spot) {
      const s = this.world.settlements.find((x) => x.id === p.settlement) ?? this.world.settlements[0];
      spot = { x: s ? s.x : this.world.size / 2, z: s ? s.z + 6 : this.world.size / 2, yaw: 0 };
    }
    if (!nav.walkable(spot.x, spot.z) && nav.nearestWalkable(spot.x, spot.z, 40, this.walkOut)) {
      spot = { x: this.walkOut.x, z: this.walkOut.z, yaw: spot.yaw };
    }
    return spot;
  }

  private homeDoor(p: Person): { x: number; z: number; yaw: number } | null {
    const st = this.sim.state;
    const hh = st.households.get(p.household);
    const b = hh ? st.buildings.get(hh.home) : undefined;
    if (!b) return null;
    return this.zone.nav.doorOf(b.id) ?? doorPoint(b, 1.6);
  }

  private providerHost(): ProviderHost {
    return {
      sim: this.sim,
      zone: this.zone,
      personId: () => this.personId,
      alive: () => !this.dead,
      isMounted: () => this.avatar.mounted !== null,
      isSitting: () => this.avatar.sitting,
      following: () => this.followId,
      home: () => {
        const p = this.person();
        const hh = p ? this.sim.state.households.get(p.household) : undefined;
        if (!hh || hh.home < 0) return null;
        const door = this.zone.nav.doorOf(hh.home);
        const b = this.sim.state.buildings.get(hh.home);
        const at = door ?? (b ? doorPoint(b, 1.6) : null);
        return { id: hh.home, distance: at ? dist(this.avatar.x, this.avatar.z, at.x, at.z) : Infinity };
      },
      ownsHorse: (id) => this.ownsHorse(id),
      mountAnimal: (id) => this.mountAnimal(id),
      dismount: () => this.dismountNow(),
      sit: (on) => this.sitNow(on),
      follow: (id) => this.followNow(id),
      encounterChoices: () => this.encounterChoicesCache,
      resolveEncounter: (id) => this.resolveEncounter(id),
    };
  }

  // ===========================================================================================
  // PlayerApi
  // ===========================================================================================

  setInput(input: InputState): void {
    const i = this.input;
    i.forward = input.forward; i.right = input.right; i.cameraYaw = input.cameraYaw;
    i.sprint = input.sprint; i.walk = input.walk; i.interactHeld = input.interactHeld;
    i.attack = input.attack; i.block = input.block; i.aim = input.aim ?? null;
    this.combat()?.input(input.attack, input.block, input.aim ?? null, input.cameraYaw);
    if (input.interact) this.edgeInteract = true;
    if (input.mount) this.edgeMount = true;
    if (input.dodge) this.edgeDodge = true;
    if (input.cancel) this.edgeCancel = true;
  }

  hud(): PlayerHud | null {
    const p = this.person();
    if (this.dead || !p) return null;
    const h = this.hudObj;
    const b = this.avatar;
    const trained = p.trained;
    const maxHp = Math.round(40 + 4 * trained.end);
    h.personId = p.id;
    h.name = fullName(p);
    h.age = Math.floor(this.traits.age);
    h.maxHp = maxHp;
    h.hp = Math.round(clamp(p.health.hp, 0, 1) * maxHp);
    h.stamina = Math.round(b.stamina.value);
    h.maxStamina = b.stamina.max;
    h.hunger = p.needs.hunger; h.rest = p.needs.rest; h.warmth = p.needs.warmth; h.mood = p.needs.mood;
    h.money = p.money;
    h.carried = Math.round(this.traits.weight * 10) / 10;
    h.capacity = this.traits.capacity;
    h.mounted = b.mounted !== null;
    // no "Talk" prompts in the middle of a fight
    const brawling = this.combatPose !== null && this.combatPose.engaged && (this.combat() ? this.sim.services.combat?.fightOf?.(this.personId) : 0);
    h.prompt = this.journey?.encounter || !this.interaction.hasPrompt || brawling ? null : this.interaction.prompt;
    const a = this.sim.actions.active(this.personId);
    if (a && a.option.seconds > 0) {
      const ha = this.hudAction;
      ha.label = a.option.label; ha.progress = a.progress; ha.seconds = a.option.seconds;
      h.action = ha;
    } else h.action = null;
    h.travel = this.journey ? this.journey.state : null;
    h.danger = this.dangerNear;
    h.exhausted = b.stamina.exhausted;
    h.speed = b.speed;
    h.gait = b.sitting ? 'sit' : b.gait;
    h.following = this.followId ? this.nameOf(this.followId) : null;
    h.combat = this.combat() ? this.hudCombat : undefined;
    return h;
  }

  /** Refreshes the fighting state for the HUD from the pose the combat module last asked of the body (every sub-step, so no blow is missed). */
  private combatHud(): PlayerCombatHud {
    const c = this.hudCombat;
    const cp = this.combatPose;
    const a = cp?.anim ?? null;
    let state: PlayerCombatHud['state'] = 'ready';
    if (this.avatar.dodgeT > 0) state = 'roll';
    else if (a === null) state = 'ready';
    else if (a.startsWith('attack_') || a === 'ride_charge') state = 'attack';
    else if (a === 'block') state = 'guard';
    else if (a === 'draw_bow') state = 'draw';
    else if (a === 'aim_bow' || a === 'aim_crossbow') state = 'aim';
    else if (a === 'shoot_bow' || a === 'shoot_crossbow') state = 'shoot';
    else if (a === 'reload_crossbow') state = 'reload';
    else if (a === 'hit') state = 'hit';
    else if (a === 'stagger') state = 'stagger';
    else if (a === 'fall' || a === 'dead') state = 'down';
    if ((state === 'hit' || state === 'stagger' || state === 'down') && c.state !== state && c.state !== 'stagger' && c.state !== 'down') c.hitSeq++;
    c.state = state;
    c.engaged = cp?.engaged ?? false;
    const main = cp?.mainHand ?? null;
    c.ranged = state === 'draw' || state === 'aim' || state === 'shoot' || state === 'reload' || main === 'longbow' || main === 'shortbow' || main === 'crossbow';
    return c;
  }

  target(): InteractCandidate | null { return this.dead || this.journey?.encounter ? null : this.interaction.target; }

  options(): ActionOption[] {
    if (this.dead) return [];
    const pid = this.personId;
    if (this.encounterChoicesCache.length > 0) {
      return this.sim.actions.list(pid, { kind: 'self' }).filter((o) => o.provider === PROVIDER_ID && o.id.startsWith('encounter.'));
    }
    const t = this.interaction.target;
    return this.sim.actions.list(pid, t ? t.target : { kind: 'self' });
  }

  perform(option: ActionOption): ActionOutcome {
    if (this.dead) return { ok: false, message: 'You cannot do that now.' };
    if (this.encounterChoicesCache.length > 0 && !(option.provider === PROVIDER_ID && option.id.startsWith('encounter.'))) {
      return { ok: false, message: 'Settle things on the road first.' };
    }
    const problem = this.rangeProblem(option);
    if (problem) return { ok: false, message: problem };
    if (option.seconds > 0 || option.target.kind === 'person') this.faceTarget(option.target);
    if (option.id !== 'stand' && option.id !== 'sit') this.avatar.sitting = false;
    return this.sim.actions.start(this.personId, option);
  }

  cancelAction(): void { this.sim.actions.cancel(this.personId, 'cancelled'); }

  talkTo(person: PersonId): Result {
    if (this.dead) return { ok: false, reason: 'You cannot speak now.' };
    if (person === this.personId) return { ok: false, reason: 'You talk to yourself.' };
    const agent = this.zone.agent(person);
    if (!agent) return { ok: false, reason: 'They are not close enough to speak to.' };
    if (dist(this.avatar.x, this.avatar.z, agent.x, agent.z) > CONVERSATION_RANGE) return { ok: false, reason: 'Too far away to speak.' };
    const target: TargetRef = { kind: 'person', id: person };
    const talk = this.sim.actions.list(this.personId, target).find((o) => o.category === 'talk' && (/^talk/i.test(o.label) || /talk/i.test(o.id)));
    if (talk) {
      if (!talk.enabled) return { ok: false, reason: talk.reason ?? 'They will not speak to you now.' };
      this.faceTarget(target);
      const r = this.sim.actions.start(this.personId, talk);
      return r.ok ? { ok: true } : { ok: false, reason: r.message };
    }
    // no Talk action registered (the social module is missing): open the conversation directly
    const conv = this.social.start(this.personId, person);
    if ('lines' in conv) {
      this.faceTarget(target);
      this.sim.events.emit('ui', { panel: 'dialogue', conversation: conv.id });
      return { ok: true };
    }
    return conv;
  }

  // ---- map travel ----

  travelTo(settlement: number): Result {
    const p = this.person();
    if (this.dead || !p) return { ok: false, reason: 'You cannot travel now.' };
    if (p.flags.captive) return { ok: false, reason: 'You are a prisoner; your ransom must be paid first.' };
    if (this.avatar.lock) return { ok: false, reason: 'Wait a moment.' };
    // an encounter is open: asking to go on (or elsewhere) settles it the way a traveller would — pressing on
    // runs past the outlaws or pays the patrol, going elsewhere gets away from them
    const open = this.journey?.encounter;
    if (open && this.journey) {
      const onwards = settlement === this.journey.state.to;
      const choice = onwards ? pressOnChoice(open.kind, this.encounterChoicesCache) : escapeChoice(open.kind, this.encounterChoicesCache);
      if (!choice) return { ok: false, reason: 'There is no getting past this by walking on.' };
      this.resolveEncounter(choice, { say: true });
      if (onwards) return this.journey ? { ok: true } : { ok: false, reason: 'The way is barred.' };
    }
    const dest = this.world.settlements.find((s) => s.id === settlement);
    if (!dest) return { ok: false, reason: 'You do not know the way.' };
    // inside the settlement is "there": the map is for going somewhere
    if (dist(this.avatar.x, this.avatar.z, dest.x, dest.z) < Math.max(40, dest.radius * 0.8)) return { ok: false, reason: 'You are already there.' };
    const plan = planRoute(this.world, { x: this.avatar.x, z: this.avatar.z }, settlement);
    if (!plan) return { ok: false, reason: 'You are already there.' };
    const sim = this.sim;
    const speedBefore = this.journey && this.journey.state.phase !== 'arrived' ? this.journey.speedBefore : sim.clock.speed;
    if (sim.clock.paused) sim.dispatch({ type: 'resume' });
    const r = sim.dispatch({ type: 'setSpeed', speed: 8 });
    if (!r.ok) return { ok: false, reason: speedRefusal(r.reason) };
    sim.actions.cancel(this.personId, 'cancelled');
    this.avatar.sitting = false;
    this.followId = null;
    this.interaction.clear(this.zone);
    const from = this.world.nearestSettlement(this.avatar.x, this.avatar.z).id;
    const j = new Journey(plan, from, settlement);
    j.speedBefore = speedBefore;
    this.journey = j;
    this.pendingAltitude = j.pendingAltitude;
    sim.events.emit('travel', { phase: 'start', to: settlement });
    return { ok: true };
  }

  cancelTravel(): void {
    const j = this.journey;
    if (!j) return;
    if (j.state.phase === 'arrived') { this.journey = null; return; }
    // stopping with hostile men or wolves in front of you means turning and running: it may cost you
    const open = j.encounter;
    if (open && open.hostile) {
      const choice = escapeChoice(open.kind, this.encounterChoicesCache);
      if (choice) { this.resolveEncounter(choice, { say: true, end: true }); return; }
    }
    this.stopJourney('cancel');
  }

  travel(): TravelState | null { return this.journey ? this.journey.state : null; }

  body(): { x: number; y: number; z: number; yaw: number } | null {
    return this.dead ? null : this.bodyView;
  }

  placeAt(x: number, z: number, yaw?: number): void {
    const b = this.avatar;
    placeBody(b, x, z, yaw ?? b.yaw, this.zone.nav);
    this.sim.actions.cancel(this.personId, 'cancelled');
    this.followId = null;
    this.syncDraw(1);
    this.zone.resync();
    this.scanT = SCAN_INTERVAL;
    this.persistNow();
  }

  chooseEncounter(choiceId: string): ActionOutcome {
    const opt = this.options().find((o) => o.id === `encounter.${choiceId}`);
    return opt ? this.perform(opt) : { ok: false, message: 'That is not an option now.' };
  }

  mountHorse(): Result {
    if (this.avatar.mounted) return { ok: false, reason: 'You are already mounted.' };
    const best = this.nearestOwnedHorse();
    if (!best) return { ok: false, reason: 'There is no horse of yours close by.' };
    const r = this.mountAnimal(best);
    return r.ok ? { ok: true } : { ok: false, reason: r.message };
  }

  dismount(): Result {
    const r = this.dismountNow();
    return r.ok ? { ok: true } : { ok: false, reason: r.message };
  }

  mounted(): boolean { return this.avatar.mounted !== null; }

  persist(): void { this.persistNow(true); }

  mapFocus(): { x: number; z: number; altitude?: number } | null {
    const f = this.mapFocusObj;
    const fx = this.switchFx;
    if (fx) {
      const t = clamp(fx.t / SWITCH_MAP, 0, 1);
      const e = t * t * (3 - 2 * t);
      f.x = fx.fromX + (fx.toX - fx.fromX) * e;
      f.z = fx.fromZ + (fx.toZ - fx.fromZ) * e;
      f.altitude = undefined;
      return f;
    }
    if (this.journey && this.journey.state.phase === 'travelling') {
      f.x = this.draw.x; f.z = this.draw.z;
      f.altitude = this.pendingAltitude ?? undefined;
      this.pendingAltitude = null;
      return f;
    }
    return null;
  }

  // ===========================================================================================
  // The sub-step (20 Hz × speed)
  // ===========================================================================================

  private step(dt: number): void {
    this.steps++;
    this.stepsSinceFrame++;
    this.simTime += dt;
    const p = this.person();
    if (this.dead || !p || p.death) return;
    const b = this.avatar;

    // ---- latched key edges ----
    const eInteract = this.edgeInteract, eMount = this.edgeMount, eDodge = this.edgeDodge, eCancel = this.edgeCancel;
    this.edgeInteract = this.edgeMount = this.edgeDodge = this.edgeCancel = false;

    this.traitT += dt;
    if (this.traitT >= TRAIT_INTERVAL) { this.traitT = 0; this.refreshTraits(p); }

    // ---- on the road ----
    const j = this.journey;
    if (j) {
      if (j.state.phase === 'arrived') {
        j.arrivedFor += dt;
        if (j.arrivedFor > ARRIVED_SECONDS) this.journey = null;
      } else if (j.state.phase === 'travelling') {
        this.stepJourney(j, dt);
        return;
      }
    }

    const pending = this.journey?.encounter != null;
    const conv = this.social.current();
    const talking = conv !== null && !conv.ended && conv.actor === this.personId;
    const input = this.input;
    const wantsMove = Math.hypot(input.forward, input.right) > 0.2;

    // ---- the action in progress ----
    let active = this.sim.actions.active(this.personId);
    if (active && !pending) {
      if (eCancel) this.sim.actions.cancel(this.personId, 'cancelled');
      else if ((wantsMove || eDodge) && active.option.seconds > 0) this.sim.actions.cancel(this.personId, 'moved');
      else if (this.outOfReach(active)) this.sim.actions.cancel(this.personId, 'moved');
    }
    if (!pending && !talking) {
      if (eInteract) this.tapInteract();
      if (eMount) this.toggleMount();
    } else if (pending && eInteract) {
      // face the standoff: the wheel lists what can be done (tap or hold E)
      this.sim.events.emit('ui', { panel: 'actions' });
    }
    active = this.sim.actions.active(this.personId);
    const working = active !== null && active.option.seconds > 0;

    // ---- the body ----
    const wasLocked = b.lock;
    const combatPose = this.stepCombat(p, working, talking || pending, dt);
    const frozen = working || talking || pending || (combatPose !== null && combatPose.moveScale <= 0.001);
    let driver: InputState = input;
    if (combatPose !== null && combatPose.noSprint && input.sprint) { driver = this.combatInput; Object.assign(driver, input); driver.sprint = false; }
    if (this.followId !== null && !frozen) {
      if (wantsMove) this.followId = null;
      else driver = this.followDriver(dt) ?? input;
    }
    const env: BodyEnv = {
      nav: this.zone.nav, traits: this.traits, frozen, effort: working && active ? workEffort(active.option.anim) : 0,
      dodge: eDodge && !frozen,
    };
    if (combatPose !== null) {
      env.speedScale = combatPose.moveScale;
      env.effort = Math.max(env.effort, combatPose.effort);
      // the roll costs breath in the body; the combat port only says whether this is the moment for one
      if (env.dodge && !(this.combat()?.dodge() ?? true)) env.dodge = false;
      if (combatPose.staminaCost > 0) b.stamina.value = Math.max(0, b.stamina.value - combatPose.staminaCost);
    }
    if (this.faceYaw !== null && frozen) {
      b.yaw = turnToward(b.yaw, this.faceYaw, 12, dt);
      if (Math.abs(angleDiff(b.yaw, this.faceYaw)) < 0.02) this.faceYaw = null;
    } else if (!frozen) this.faceYaw = null;
    stepBody(b, driver, env, dt);
    if (combatPose !== null) {
      if (combatPose.faceYaw !== null && !b.mounted && b.dodgeT <= 0) b.yaw = turnToward(b.yaw, combatPose.faceYaw, 15, dt);
      if (combatPose.unhorse && b.mounted) this.throwRider();
    }
    if (wasLocked && !b.lock && wasLocked.kind === 'dismount') this.finishDismount();
    if (b.mounted && b.odometer - this.rideMark > 100) { this.rideMark = b.odometer; gainSkill(this.sim, p, 'riding', 2); }

    // ---- what is in front ----
    this.scanT += dt;
    if (this.scanT >= SCAN_INTERVAL) {
      this.scanT = 0;
      if (pending) this.interaction.clear(this.zone);
      else this.interaction.scan(this.sim.actions, this.zone, this.personId, b.x, b.z, b.yaw, SCAN_INTERVAL);
    }

    this.persistT += dt;
    if (this.persistT >= PERSIST_INTERVAL) { this.persistT = 0; this.persistNow(); }
    this.syncDraw(1);
  }

  // ---------------------------------------------------------------------------------------------
  // Combat (src/combat is the brain: attacks, guards, bows and hurts; this only lends it the body)
  // ---------------------------------------------------------------------------------------------

  private combat(): PlayerCombatPort | undefined { return this.sim.services.combat?.player; }

  /** One sub-step of the combat port; returns the pose it asks for, or null when it asks nothing. */
  private stepCombat(p: Person, working: boolean, held: boolean, dt: number): PlayerCombatPose | null {
    const port = this.combat();
    this.combatPose = null;
    if (!port || this.journey?.state.phase === 'travelling') { this.combatHud(); return null; }
    const b = this.avatar;
    const f = this.cframe;
    f.person = p.id; f.x = b.x; f.y = b.y; f.z = b.z; f.yaw = b.yaw; f.speed = b.speed; f.mounted = b.mounted !== null;
    f.dodgeT = b.dodgeT; f.stamina = b.stamina.value; f.staminaMax = b.stamina.max;
    f.busy = working || held || b.lock !== null || b.sitting;
    f.dt = dt;
    port.step(f, this.cpose);
    const pose = this.cpose;
    if (!pose.engaged && pose.anim === null && pose.moveScale === 1 && pose.staminaCost === 0 && pose.effort === 0 && pose.faceYaw === null) { this.combatHud(); return null; }
    this.combatPose = pose;
    this.combatHud();
    return pose;
  }

  /** The horse went down under the rider. */
  private throwRider(): void {
    const b = this.avatar;
    const m = b.mounted;
    if (!m) return;
    if (m.animal >= 0) this.zone.releaseAnimal?.(m.animal, b.x, b.z, b.yaw);
    b.mounted = null;
    b.speed = 0;
    this.interaction.invalidate();
  }

  private outOfReach(a: ActiveAction): boolean {
    const t = a.option.target;
    if (t.kind === 'self' || a.option.range >= 900) return false;
    // the scan keeps the distance to the current target fresh; anything else is looked up
    const cur = this.interaction.target;
    let d: number | null = null;
    if (cur && sameTarget(cur.target, t)) d = cur.distance;
    else {
      const pos = this.positionOf(t);
      if (pos) d = dist(this.avatar.x, this.avatar.z, pos.x, pos.z);
    }
    return d !== null && d > a.option.range * 1.5 + 2;
  }

  // ---------------------------------------------------------------------------------------------
  // Interact, mount, sit, follow
  // ---------------------------------------------------------------------------------------------

  private tapInteract(): void {
    const sim = this.sim;
    if (sim.actions.active(this.personId)) { sim.actions.cancel(this.personId, 'cancelled'); return; }
    const t = this.interaction.target;
    if (!t) return;
    const def = this.interaction.defaultOption;
    if (def) {
      const r = this.perform(def);
      if (!r.ok && r.message) this.notify('warn', r.message);
    } else if (this.interaction.options.length > 0) {
      const o = this.interaction.options[0];
      this.notify('warn', o.reason ?? 'You cannot do that now.');
    }
  }

  private toggleMount(): void {
    if (this.avatar.mounted) {
      const r = this.dismountNow();
      if (r.message) this.notify(r.ok ? 'info' : 'warn', r.message);
      return;
    }
    const best = this.nearestOwnedHorse();
    if (best === null) { this.notify('info', 'None of your horses is close by.'); return; }
    const r = this.mountAnimal(best);
    if (r.message) this.notify(r.ok ? 'info' : 'warn', r.message);
  }

  private ownsHorse(animalId: number): { owned: boolean; reason?: string } {
    const a = this.zone.animals().find((x) => x.id === animalId);
    const p = this.person();
    if (!a || a.kind !== 'horse') return { owned: false, reason: 'That is not a horse.' };
    if (a.wild || a.owner === 0) return { owned: false, reason: 'That horse belongs to no one you know.' };
    if (!p || a.owner !== p.household) return { owned: false, reason: 'That horse is not your household\'s.' };
    return { owned: true };
  }

  private nearestOwnedHorse(): number | null {
    let best: number | null = null;
    let bestD = MOUNT_RANGE;
    for (const a of this.zone.animals()) {
      if (a.kind !== 'horse' || !this.ownsHorse(a.id).owned) continue;
      const d = dist(this.avatar.x, this.avatar.z, a.x, a.z);
      if (d < bestD) { bestD = d; best = a.id; }
    }
    return best;
  }

  private mountAnimal(animalId: number): ActionOutcome {
    const b = this.avatar;
    if (b.mounted) return { ok: false, message: 'You are already mounted.' };
    if (b.lock) return { ok: false, message: 'Wait a moment.' };
    const own = this.ownsHorse(animalId);
    const a = this.zone.animals().find((x) => x.id === animalId);
    if (!own.owned || !a) return { ok: false, message: own.reason ?? 'You cannot ride that.' };
    if (dist(b.x, b.z, a.x, a.z) > MOUNT_RANGE) return { ok: false, message: 'The horse is too far away.' };
    let claimed = false;
    if (this.zone.claimAnimal) {
      claimed = this.zone.claimAnimal(a.id);
      if (!claimed) return { ok: false, message: 'The horse will not be ridden now.' };
    }
    this.sim.actions.cancel(this.personId, 'cancelled');
    this.followId = null;
    b.sitting = false;
    // the rider steps up on the horse's near side: the body takes the horse's place
    placeBody(b, a.x, a.z, a.draw.yaw, this.zone.nav);
    b.mounted = { animal: a.id, coat: a.draw.coat, claimed };
    b.lock = { kind: 'mount', t: 0, dur: MOUNT_SECONDS * this.lockScale() };
    this.interaction.invalidate();
    return { ok: true, message: 'You swing up into the saddle.' };
  }

  /** Mount and dismount clips run in real time, so the lock lasts longer in sim seconds at 3×/8×. */
  private lockScale(): number { return Math.max(1, this.sim.clock.speed); }

  private forceMount(coat = 0x7a5032): void {
    const b = this.avatar;
    if (b.mounted) return;
    b.mounted = { animal: -1, coat, claimed: false };
    b.lock = { kind: 'mount', t: 0, dur: MOUNT_SECONDS * this.lockScale() };
  }

  private dismountNow(): ActionOutcome {
    const b = this.avatar;
    if (!b.mounted) return { ok: false, message: 'You are not mounted.' };
    if (b.lock) return { ok: false, message: 'Wait a moment.' };
    if (b.speed > 4.5) return { ok: false, message: 'Slow down before you dismount.' };
    b.lock = { kind: 'dismount', t: 0, dur: DISMOUNT_SECONDS * this.lockScale() };
    return { ok: true, message: 'You slip down from the saddle.' };
  }

  private finishDismount(): void {
    const b = this.avatar;
    const m = b.mounted;
    if (!m) return;
    const hx = b.x, hz = b.z, hy = b.yaw;
    // the rider ends beside the horse (on its left), the horse stays where it stood
    const side = 0.8;
    const lx = Math.cos(hy) * side, lz = -Math.sin(hy) * side;
    const out = { x: b.x, z: b.z, blocked: false, wading: false };
    this.zone.nav.move(b.x, b.z, lx, lz, 0.35, out);
    b.x = b.px = out.x; b.z = b.pz = out.z;
    b.y = b.py = this.zone.nav.groundY(b.x, b.z);
    b.mounted = null;
    if (m.animal >= 0) this.zone.releaseAnimal?.(m.animal, hx, hz, hy);
    this.interaction.invalidate();
    this.scanT = SCAN_INTERVAL;
  }

  private sitNow(on: boolean): ActionOutcome {
    const b = this.avatar;
    if (!on) { b.sitting = false; return { ok: true }; }
    if (b.mounted) return { ok: false, message: 'You cannot sit on a horse.' };
    this.sim.actions.cancel(this.personId, 'cancelled');
    this.followId = null;
    b.sitting = true;
    b.speed = 0;
    this.seatHeight = this.benchNear() ? 0.45 : 0;
    return { ok: true, message: this.seatHeight > 0 ? 'You sit on a bench.' : 'You sit down.' };
  }

  private benchNear(): boolean {
    const st = this.sim.state;
    const s = this.world.nearestSettlement(this.avatar.x, this.avatar.z);
    for (const id of s.plots) {
      const b = st.buildings.get(id);
      if (b && BENCH_KINDS.has(b.kind) && dist(this.avatar.x, this.avatar.z, b.x, b.z) < 14) return true;
    }
    return false;
  }

  private followNow(id: PersonId | null): ActionOutcome {
    if (id === null) { this.followId = null; return { ok: true, message: 'You stop following.' }; }
    const a = this.zone.agent(id);
    if (!a) return { ok: false, message: 'They are not here.' };
    this.sim.actions.cancel(this.personId, 'cancelled');
    this.avatar.sitting = false;
    this.followId = id;
    this.followPath = null;
    this.followRepath = 0;
    return { ok: true, message: `You follow ${this.nameOf(id)}.` };
  }

  /** Walks after the person being followed: a synthetic input for the body. */
  private followDriver(dt: number): InputState | null {
    const id = this.followId;
    if (id === null) return null;
    const a = this.zone.agent(id);
    const b = this.avatar;
    if (!a) { this.followId = null; this.notify('info', 'You lose sight of them.'); return null; }
    const d = dist(b.x, b.z, a.x, a.z);
    if (d > 70) { this.followId = null; this.notify('info', 'You lose sight of them.'); return null; }
    const f = this.followInput;
    f.forward = 0; f.right = 0; f.sprint = false; f.walk = false; f.cameraYaw = b.yaw;
    if (d <= 2.6) return f;
    this.followRepath -= dt;
    let tx = a.x, tz = a.z;
    if (d > 7) {
      if (this.followRepath <= 0 || !this.followPath) {
        this.followRepath = 0.8;
        this.followPath = this.zone.nav.findPath({ x: b.x, z: b.z }, { x: a.x, z: a.z }, 90);
        this.followIndex = 1;
      }
      const path = this.followPath;
      if (path) {
        while (this.followIndex < path.length - 1 && dist(b.x, b.z, path[this.followIndex].x, path[this.followIndex].z) < 1.2) this.followIndex++;
        const w = path[Math.min(this.followIndex, path.length - 1)];
        tx = w.x; tz = w.z;
      }
    } else this.followPath = null;
    f.forward = 1;
    f.cameraYaw = yawTo(b.x, b.z, tx, tz);
    f.sprint = d > 24;
    f.walk = d < 5 && a.speed < 1.8;
    return f;
  }

  // ---------------------------------------------------------------------------------------------
  // Targets and ranges
  // ---------------------------------------------------------------------------------------------

  private positionOf(t: TargetRef): P2 | null {
    switch (t.kind) {
      case 'self': return { x: this.avatar.x, z: this.avatar.z };
      case 'ground': return { x: t.x, z: t.z };
      case 'person': { const a = this.zone.agent(t.id); return a ? { x: a.x, z: a.z } : null; }
      case 'animal': { const a = this.zone.animals().find((x) => x.id === t.id); return a ? { x: a.x, z: a.z } : null; }
      case 'building': {
        const d = this.zone.nav.doorOf(t.id);
        if (d) return d;
        const b = this.sim.state.buildings.get(t.id);
        return b ? { x: b.x, z: b.z } : null;
      }
      case 'strip': {
        const s = this.world.strips[t.id]?.id === t.id ? this.world.strips[t.id] : this.world.strips.find((x) => x.id === t.id);
        return s ? nearestOnPolygon(s.poly, this.avatar.x, this.avatar.z) : null;
      }
      case 'parcel': {
        const s = this.world.parcels.find((x) => x.id === t.id);
        return s ? nearestOnPolygon(s.poly, this.avatar.x, this.avatar.z) : null;
      }
      case 'settlement': return null;
      default: return null;
    }
  }

  private rangeProblem(option: ActionOption): string | null {
    if (option.range >= 900 || option.target.kind === 'self' || option.target.kind === 'settlement') return null;
    const cur = this.interaction.target;
    let d: number | null = null;
    if (cur && sameTarget(cur.target, option.target)) d = cur.distance;
    else {
      const pos = this.positionOf(option.target);
      if (pos) d = dist(this.avatar.x, this.avatar.z, pos.x, pos.z);
    }
    if (d === null) return null;
    if (d <= option.range + 0.75) return null;
    return 'You are too far away.';
  }

  private faceTarget(t: TargetRef): void {
    const cur = this.interaction.target;
    const pos = cur && sameTarget(cur.target, t) ? { x: cur.x, z: cur.z } : this.positionOf(t);
    if (!pos || t.kind === 'self') return;
    if (dist(this.avatar.x, this.avatar.z, pos.x, pos.z) < 0.3) return;
    this.faceYaw = yawTo(this.avatar.x, this.avatar.z, pos.x, pos.z);
  }

  private nameOf(id: PersonId): string {
    const p = this.sim.state.persons.get(id);
    return p ? p.first : 'someone';
  }

  // ===========================================================================================
  // Map travel
  // ===========================================================================================

  private stepJourney(j: Journey, dt: number): void {
    const b = this.avatar;
    const p = this.person();
    if (!p) return;
    b.px = b.x; b.pz = b.z; b.py = b.y; b.pyaw = b.yaw;
    const weather = this.sim.view.weather();
    const pace = journeyPace({
      mounted: b.mounted !== null, agility: this.traits.agility, age: this.traits.age, ridingLevel: this.traits.ridingLevel,
      weight: this.traits.weight, capacity: this.traits.capacity, weather, legFactor: j.legFactor,
    });
    const covered = j.advance(pace, dt);
    b.odometer += covered;
    b.x = j.cursor.pos.x; b.z = j.cursor.pos.z;
    b.yaw = j.cursor.yaw;
    b.y = this.zone.nav.groundY(b.x, b.z);
    b.speed = pace;
    b.baseSpeed = pace;
    b.gait = b.mounted ? 'trot' : 'run';
    if (b.mounted && b.odometer - this.rideMark > 100) { this.rideMark = b.odometer; gainSkill(this.sim, p, 'riding', 2); }
    this.syncDraw(1);
    if (j.arrived) { this.arrive(j); return; }
    if (j.rollDue()) this.rollEncounter(j, p);
    this.persistT += dt;
    if (this.persistT >= PERSIST_INTERVAL) { this.persistT = 0; this.persistNow(); }
  }

  private rollEncounter(j: Journey, p: Person): void {
    const rng = this.sim.rng('travel');
    const b = this.avatar;
    sampleDanger(this.world, b.x, b.z, this.sim.absDay, j.cursor.kind, isNight(this.sim.absDay), this.danger);
    this.danger.risk = this.sim.services.advancement?.bonus?.(p.house, 'road.risk') ?? 0;
    const rate = encounterRate(this.danger, this.sim.state.difficulty); // per km
    if (!rng.chance(rate * 0.12)) return;
    const kind = pickEncounterKind(rng, this.danger, this.sim.state.difficulty);
    this.beginEncounter(j, p, kind);
  }

  private beginEncounter(j: Journey, p: Person, kind: EncounterKind): void {
    const sim = this.sim;
    const b = this.avatar;
    const rng = sim.rng('travel');
    // street level at that spot: somewhere a person can stand
    if (!this.zone.nav.walkable(b.x, b.z) && this.zone.nav.nearestWalkable(b.x, b.z, 80, this.walkOut)) {
      placeBody(b, this.walkOut.x, this.walkOut.z, b.yaw, this.zone.nav);
    } else placeBody(b, b.x, b.z, b.yaw, this.zone.nav);
    const data = makeEncounter(kind, { ctx: sim, person: p, rng }, b.x, b.z);
    j.encounter = data;
    j.state.phase = 'encounter';
    this.streetPending = true;
    this.hostileEncounter = data.hostile;
    this.summonParty(data, p);
    // a standoff runs in action time (the world slows to a crawl, speed drops to 1×)
    sim.dispatch({ type: 'setActionTime', on: true });
    this.refreshEncounter(j, data);
    this.syncDraw(1);
    this.zone.resync();
    this.persistNow();
    sim.events.emit('travel', { phase: 'encounter', to: j.state.to, encounter: data.label });
  }

  private encounterEnv(): EncounterEnv | null {
    const p = this.person();
    if (!p) return null;
    const combat = this.sim.services.combat;
    const main = combat ? this.economy.inventory(p.id).equipment.main : undefined;
    return {
      ctx: this.sim, person: p, social: this.social, economy: this.economy, mounted: this.avatar.mounted !== null,
      stamina: this.avatar.stamina.value / this.avatar.stamina.max, rng: this.sim.rng('travel'),
      canFight: !!combat && !!this.zone.summon && this.summonedPeople.length + this.summonedAnimals.length > 0,
      weaponName: main ? this.economy.describe(main).replace(/^an? /, '') : undefined,
    };
  }

  /** Builds the choices (with current chances) and publishes them in the travel state. */
  private refreshEncounter(j: Journey, data: EncounterData): void {
    const env = this.encounterEnv();
    if (!env) return;
    this.encounterChoicesCache = buildChoices(env, data);
    const choices = this.sim.actions.list(this.personId, { kind: 'self' })
      .filter((o) => o.provider === PROVIDER_ID && o.id.startsWith('encounter.'));
    j.state.encounter = { kind: data.kind, label: data.label, hostile: data.hostile, text: data.text, choices };
  }

  /**
   * Settles the open encounter with one of its choices. `say`: report the outcome to the HUD (choices run
   * through the action registry are reported by the registry itself); `end`: the journey is over whatever
   * the choice was (a hostile encounter walked away from).
   */
  private resolveEncounter(choiceId: string, opts: { say?: boolean; end?: boolean } = {}): ActionOutcome {
    const j = this.journey;
    const data = j?.encounter;
    if (!j || !data) return { ok: false, message: 'There is nothing to settle.' };
    const env = this.encounterEnv();
    if (!env) return { ok: false };
    const choice = buildChoices(env, data).find((c) => c.id === choiceId);
    if (!choice || !choice.enabled) return { ok: false, message: choice?.reason ?? 'That is not an option now.' };
    const out = choice.run();
    if (out.fight) {
      const started = this.beginFight(j, data);
      if (started) return started;
    }
    // the encounter is over; the road goes on (unless the party turned back)
    j.encounter = null;
    j.state.encounter = undefined;
    this.dismissParty();
    this.encounterChoicesCache = [];
    this.hostileEncounter = false;
    this.interaction.invalidate();
    this.sim.dispatch({ type: 'setActionTime', on: false });
    if (out.end || opts.end) this.stopJourney('cancel');
    else this.resumeJourney(j); // never leave the party standing in the road
    const { resume: _resume, end: _end, ...outcome } = out;
    void _resume; void _end;
    if (opts.say) {
      if (outcome.message) this.notify(outcome.ok ? 'info' : 'warn', outcome.message);
      if (outcome.ui) this.sim.events.emit('ui', outcome.ui);
    }
    return outcome;
  }

  /**
   * "Fight": the party the encounter showed becomes the other side of a fight in the combat module. The journey
   * waits (phase stays 'encounter' without an open encounter, so the body moves freely) until the fight is over.
   */
  private beginFight(j: Journey, data: EncounterData): ActionOutcome | null {
    const combat = this.sim.services.combat;
    if (!combat) return null;
    const b = this.avatar;
    const id = combat.engage([
      { faction: 'player', people: [this.personId] },
      { faction: data.kind === 'wolves' ? 'wolves' : 'outlaws', people: this.summonedPeople.slice(), animals: this.summonedAnimals.slice() },
    ], { at: { x: b.x, z: b.z }, yieldAllowed: false, reason: data.kind });
    if (id === 0) return null;
    j.encounter = null;
    j.state.encounter = undefined;
    this.encounterChoicesCache = [];
    this.interaction.invalidate();
    this.scanT = SCAN_INTERVAL;
    const off = combat.onFightEnded((r) => { if (r.id === id) this.endFight(r, data); });
    this.fighting = { journey: j, data, id, off };
    return { ok: true, message: 'You set your feet and draw.' };
  }

  /** The road fight is over: the outlaws take what the winner takes, the party disperses and the journey resumes. */
  private endFight(r: FightResult, data: EncounterData): void {
    const f = this.fighting;
    if (!f) return;
    f.off();
    this.fighting = null;
    const j = f.journey;
    const p = this.person();
    const won = r.winner === 'player';
    this.dismissParty();
    this.hostileEncounter = false;
    if (!p || p.death || this.dead) return;
    const env = this.encounterEnv();
    if (won) {
      // what the beaten carried
      let coin = 0;
      for (const id of r.dead) { const q = this.sim.state.persons.get(id); if (q && q.money > 0) { coin += q.money; q.money = 0; } }
      if (coin > 0) { p.money += coin; this.sim.state.touch(p); }
      this.notify('gain', coin > 0 ? `The road is clear. You take ${formatMoney(coin)} from the fallen.` : 'The road is clear.');
    } else if (r.winner !== null && env) {
      // beaten but alive: they take their pick and leave you lying in the road
      const lost = payMoney(env, p.money * 0.6);
      const taken = takeGoods(env, 0.4);
      this.notify('loss', `They strip you of ${formatMoney(lost)}${taken > 0 ? ' and much of what you carried' : ''} and leave you in the road.`);
    } else this.notify('info', 'It is over. The road is quiet again.');
    if (this.journey === j && j.state.phase === 'encounter') {
      this.sim.dispatch({ type: 'setActionTime', on: false });
      this.resumeJourney(j);
    }
  }

  private resumeJourney(j: Journey): void {
    j.state.phase = 'travelling';
    this.sim.dispatch({ type: 'resume' });
    const r = this.sim.dispatch({ type: 'setSpeed', speed: 8 });
    if (!r.ok) this.notify('info', speedRefusal(r.reason));
    this.pendingAltitude = null;
  }

  private arrive(j: Journey): void {
    const dest = this.world.settlements.find((s) => s.id === j.state.to);
    const b = this.avatar;
    if (dest) {
      // stand on the road a little way inside the settlement, facing in
      const inside = Math.min(dest.radius * 0.5, 70);
      let best = { x: dest.x, z: dest.z };
      const pts = j.plan.points;
      for (let i = pts.length - 1; i >= 0; i--) {
        if (dist(pts[i].x, pts[i].z, dest.x, dest.z) > inside) { best = pts[Math.min(pts.length - 1, i + 1)]; break; }
      }
      let x = best.x, z = best.z;
      if (!this.zone.nav.walkable(x, z) && this.zone.nav.nearestWalkable(x, z, 60, this.walkOut)) { x = this.walkOut.x; z = this.walkOut.z; }
      placeBody(b, x, z, yawTo(x, z, dest.x, dest.z), this.zone.nav);
    }
    j.state.phase = 'arrived';
    this.streetPending = true;
    j.state.progress = 1;
    j.state.daysLeft = 0;
    j.arrivedFor = 0;
    this.restoreSpeed(j);
    this.syncDraw(1);
    this.zone.resync();
    this.interaction.invalidate();
    this.scanT = SCAN_INTERVAL;
    this.persistNow();
    this.sim.events.emit('travel', { phase: 'arrive', to: j.state.to });
  }

  private restoreSpeed(j: Journey): void {
    this.sim.dispatch({ type: 'setSpeed', speed: j.speedBefore });
  }

  private stopJourney(phase: 'cancel'): void {
    const j = this.journey;
    if (!j) return;
    this.restoreSpeed(j);
    if (j.encounter) this.sim.dispatch({ type: 'setActionTime', on: false });
    if (this.fighting) { const id = this.fighting.id; this.fighting.off(); this.fighting = null; this.sim.services.combat?.disperse?.(id); }
    this.journey = null;
    this.streetPending = true;
    this.dismissParty();
    this.encounterChoicesCache = [];
    this.hostileEncounter = false;
    const b = this.avatar;
    if (!this.zone.nav.walkable(b.x, b.z) && this.zone.nav.nearestWalkable(b.x, b.z, 80, this.walkOut)) placeBody(b, this.walkOut.x, this.walkOut.z, b.yaw, this.zone.nav);
    b.speed = 0;
    this.syncDraw(1);
    this.zone.resync();
    this.interaction.invalidate();
    this.scanT = SCAN_INTERVAL;
    this.persistNow();
    this.sim.events.emit('travel', { phase, to: j.state.to });
  }

  /** Shows the encounter in the 3D view when the zone can summon people and animals (otherwise only the choices exist). */
  private summonParty(data: EncounterData, p: Person): void {
    const z = this.zone;
    if (!z.summon && !z.summonAnimal) return;
    const b = this.avatar;
    const rng = this.sim.rng('travel');
    // a loose arc 9-14 m ahead on the road, everyone turned towards the player
    const place = (i: number, n: number): { x: number; z: number; yaw: number } => {
      const spread = (i - (n - 1) / 2) * 0.55;
      const r = 9 + (i % 2) * 3 + rng.next() * 2;
      let x = b.x + Math.sin(b.yaw + spread) * r, zz = b.z + Math.cos(b.yaw + spread) * r;
      if (!z.nav.walkable(x, zz) && z.nav.nearestWalkable(x, zz, 12, this.walkOut)) { x = this.walkOut.x; zz = this.walkOut.z; }
      return { x, z: zz, yaw: yawTo(x, zz, b.x, b.z) };
    };
    if (data.kind === 'wolves' && z.summonAnimal) {
      const n = Math.min(4, data.count);
      for (let i = 0; i < n; i++) { const at = place(i, n); this.summonedAnimals.push(z.summonAnimal('wolf', at.x, at.z, true)); }
      return;
    }
    if (!z.summon) return;
    const env = { ctx: this.sim, person: p, rng };
    const people = pickParticipants(data.kind, env, b.x, b.z, participantCount(data.kind, data.count));
    people.forEach((id, i) => {
      const at = place(i, people.length);
      z.summon!(id, at.x, at.z, at.yaw);
      this.summonedPeople.push(id);
    });
  }

  private dismissParty(): void {
    const z = this.zone;
    for (const id of this.summonedPeople) z.dismiss?.(id);
    for (const id of this.summonedAnimals) z.dismissAnimal?.(id);
    this.summonedPeople = [];
    this.summonedAnimals = [];
  }

  private forceEncounter(kind: EncounterKind): void {
    const p = this.person();
    if (!p || this.dead) return;
    let j = this.journey;
    if (!j) {
      // no journey: start one to the nearest other settlement so the encounter has a road to resume
      const near = this.world.settlements.filter((s) => s.id !== p.settlement).sort((a, c) => dist(a.x, a.z, this.avatar.x, this.avatar.z) - dist(c.x, c.z, this.avatar.x, this.avatar.z))[0];
      if (!near || !this.travelTo(near.id).ok) return;
      j = this.journey;
      if (!j) return;
      // move a little way along the road
      j.cursor.advance(Math.min(300, j.plan.total * 0.2));
      this.avatar.x = j.cursor.pos.x; this.avatar.z = j.cursor.pos.z;
    }
    if (j.encounter) return;
    this.beginEncounter(j, p, kind);
  }

  // ===========================================================================================
  // Death and switching
  // ===========================================================================================

  private onPlayerDied(e: SimEvents['playerDied']): void {
    if (e.person !== this.personId) return;
    this.sim.actions.cancel(this.personId, 'cancelled');
    if (this.journey) this.stopJourney('cancel');
    this.markDead();
  }

  private markDead(): void {
    this.combatPose = null;
    this.dead = true;
    this.deadFor = 0;
    this.followId = null;
    this.avatar.speed = 0;
    this.avatar.sitting = false;
    this.interaction.clear(this.zone);
    this.persistNow();
  }

  private onPlayerSwitched(e: SimEvents['playerSwitched']): void {
    const oldX = this.draw.x, oldZ = this.draw.z;
    this.sim.actions.cancel(e.from, 'cancelled');
    if (this.journey) this.stopJourney('cancel');
    const old = this.avatar;
    if (old.mounted && old.mounted.animal >= 0) this.zone.releaseAnimal?.(old.mounted.animal, old.x, old.z, old.yaw);
    this.zone.detachPlayer();
    this.attach(e.to, 'whereabouts');
    this.switchFx = { t: 0, fromX: oldX, fromZ: oldZ, toX: this.draw.x, toZ: this.draw.z };
      }

  private onGameOver(): void {
    this.dead = true;
    this.interaction.clear(this.zone);
  }

  private onConversation(e: SimEvents['conversation']): void {
    if (e.actor !== this.personId) return;
    if (e.phase === 'start') {
      this.zone.hold(e.with, e.actor);
      this.faceTarget({ kind: 'person', id: e.with });
      this.followId = null;
    } else this.zone.release(e.with);
  }

  // ===========================================================================================
  // Frame hook, draw item, view sources
  // ===========================================================================================

  frame(dt: number): void {
    this.renderTime += dt;
    const clock = this.sim.clock;
    // replicate the sim's sub-step accumulator to know how far into the next step the frame is
    if (!clock.paused && !clock.skip && this.sim.state.run.phase === 'alive') this.acc += Math.min(dt, MAX_FRAME_DT) * clock.speed;
    this.acc -= this.stepsSinceFrame * SIM_DT;
    if (this.stepsSinceFrame >= 48 || this.acc < 0) this.acc = 0;
    this.stepsSinceFrame = 0;
    const alpha = clamp(this.acc / SIM_DT, 0, 1);
    if (clock.paused) { this.edgeInteract = this.edgeMount = this.edgeDodge = this.edgeCancel = false; }

    if (this.dead) this.deadFor += dt;
    if (this.switchFx) {
      const before = this.switchFx.t;
      this.switchFx.t += dt;
      if (before < SWITCH_MAP && this.switchFx.t >= SWITCH_MAP) this.streetPending = true; // the camera comes down now
      if (this.switchFx.t > SWITCH_TOTAL) this.switchFx = null;
    }
    this.lookT += dt;
    if (this.lookT > 1) { this.lookT = 0; this.refreshLook(); }
    this.syncDraw(this.dead || this.journey?.state.phase === 'travelling' ? 1 : alpha, dt);
  }

  private refreshLook(): void {
    const p = this.person() ?? this.sim.state.persons.get(this.personId);
    if (!p) return;
    const c = this.sim.view.appearance.get(this.sim.state, p, this.sim.absDay);
    const cp = this.cpose;
    const wear = `${cp.armour ?? ''}|${cp.helmet ?? ''}`;
    if (c.version !== this.shownVersion || wear !== this.shownArmour) {
      this.shownArmour = wear;
      this.shownVersion = c.version;
      let h = 5381;
      for (let k = 0; k < wear.length; k++) h = ((h * 33) ^ wear.charCodeAt(k)) >>> 0;
      // the armour in the equipment slots is what the character is seen wearing
      if (cp.armour !== null || cp.helmet !== null) {
        this.draw.look = {
          ...c.look,
          armour: (cp.armour as CharacterDrawItem['look']['armour'] | null) ?? c.look.armour,
          helmet: (cp.helmet as CharacterDrawItem['look']['helmet'] | null) ?? c.look.helmet,
        };
        this.draw.lookVersion = c.version * 100003 + (h % 99991) + 1;
      } else { this.draw.look = c.look; this.draw.lookVersion = c.version; }
    }
  }

  private emptyHud(): PlayerHud {
    return {
      personId: 0, name: '', age: 0, hp: 0, maxHp: 0, stamina: 0, maxStamina: 0, hunger: 1, rest: 1, warmth: 1, mood: 1,
      money: 0, carried: 0, capacity: 0, mounted: false, prompt: null, action: null, travel: null, danger: false,
    };
  }

  private emptyDraw(): CharacterDrawItem {
    return {
      id: 0, x: 0, y: 0, z: 0, yaw: 0, look: {
        sex: 'm', age: 12, height: 1.4, build: 0.4, skin: 0xe0b090, hair: 0x5a3a22, hairStyle: 0, beard: 0, culture: 'anglo',
        clothing: { tunic: 0x8a7a5a, tunicStyle: 'short', legs: 0x5a4a3a, headwear: 'none', shoes: 'shoes' }, armour: 'none', helmet: 'none',
      },
      lookVersion: 0, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 3,
    };
  }

  private makeDraw(p: Person): CharacterDrawItem {
    const c = this.sim.view.appearance.get(this.sim.state, p, this.sim.absDay);
    const d = this.emptyDraw();
    d.id = p.id;
    d.look = c.look;
    d.lookVersion = c.version;
    return d;
  }

  /**
   * Writes the body into the draw item: position (interpolated between the last two sub-steps by `alpha`),
   * animation and held items from what the body is doing.
   */
  private syncDraw(alpha: number, frameDt = 0): void {
    const b = this.avatar;
    const d = this.draw;
    const clock = this.sim.clock;
    d.x = b.px + (b.x - b.px) * alpha;
    d.z = b.pz + (b.z - b.pz) * alpha;
    d.y = b.py + (b.y - b.py) * alpha;
    d.yaw = b.pyaw + angleDiff(b.pyaw, b.yaw) * alpha;
    d.highlight = 3;
    d.seatHeight = b.sitting ? this.seatHeight : undefined;

    let anim: AnimState = 'idle';
    let main: HeldItem = 'none', off: HeldItem = 'none', carry: CarryLook = 'none';
    let horse: MountLook['anim'] = 'idle';
    const mounted = b.mounted !== null;
    // the sim runs faster at 3×/8×: strides keep up with the ground (capped, or the legs blur)
    const scale = Math.max(1, clock.paused ? 1 : clock.speed);
    const moveSpeed = Math.min(7, b.speed * scale);
    const active = this.dead ? null : this.sim.actions.active(this.personId);
    const working = active !== null && active.option.seconds > 0;
    const travelling = this.journey !== null && this.journey.state.phase === 'travelling';

    const cp = this.dead ? null : this.combatPose;
    const cpAnim = cp !== null && cp.anim !== null && !b.lock && (!mounted || cp.anim === 'ride_charge' || cp.anim === 'hit' || cp.anim === 'stagger' || cp.anim === 'fall' || cp.anim === 'dead');
    if (this.dead) anim = this.deadFor < DEAD_FALL_SECONDS ? 'fall' : 'dead';
    else if (b.lock) anim = b.lock.kind === 'mount' ? 'mount' : 'dismount';
    else if (clock.skip?.kind === 'sleep') anim = 'sleep';
    else if (cpAnim && cp !== null && cp.anim !== null && !working) {
      anim = cp.anim;
      if (mounted && anim === 'ride_charge') horse = 'gallop';
    } else if (working && active) {
      anim = active.option.anim ?? 'idle';
      main = active.option.mainHand ?? 'none';
      off = active.option.offHand ?? 'none';
      carry = active.option.carry ?? 'none';
    } else if (b.sitting) anim = 'sit';
    else if (b.dodgeT > 0) anim = 'dodge';
    else if (mounted) {
      const r = rideAnim(travelling ? b.baseSpeed : b.speed);
      anim = r.human;
      horse = r.horse;
    } else {
      anim = footAnim(travelling ? b.baseSpeed : b.speed, false);
    }
    if (b.lock) horse = 'idle';

    const combatAnim = cpAnim && cp !== null && cp.anim === anim && !working;
    if (anim !== this.lastAnim) {
      this.lastAnim = anim;
      this.animT = 0;
    } else this.animT += frameDt;
    d.anim = anim;
    d.animTime = combatAnim && cp !== null ? cp.animTime : this.animT;
    d.moveSpeed = this.dead || b.lock || working || b.sitting || (combatAnim && !mounted && anim !== 'walk') ? 0 : moveSpeed;
    if (cp !== null && !working) {
      if (cp.mainHand !== null) main = cp.mainHand;
      if (cp.offHand !== null) off = cp.offHand;
    }
    d.aimPitch = cp !== null && cp.aimPitch !== null ? cp.aimPitch : undefined;
    d.mainHand = main; d.offHand = off; d.carry = carry;
    // a heavy load shows as a pack on the back
    d.back = !mounted && this.traits.capacity > 0 && this.traits.weight > 0.25 * this.traits.capacity ? 'pack' : 'none';
    if (mounted && b.mounted) {
      const ml = d.mount;
      if (ml) { ml.coat = b.mounted.coat; ml.anim = horse; ml.animTime = this.animT; ml.barding = b.mounted.barding; }
      else d.mount = { coat: b.mounted.coat, anim: horse, animTime: this.animT };
    } else if (d.mount) d.mount = undefined;

    // keep the plain-data views current
    const bv = this.bodyView;
    bv.x = b.x; bv.y = b.y; bv.z = b.z; bv.yaw = b.yaw;
  }

  private viewPlayer(): PlayerView | null {
    const p = this.sim.state.persons.get(this.personId);
    if (!p) return null;
    const v = this.playerView;
    v.personId = this.personId;
    v.x = this.draw.x; v.y = this.draw.y; v.z = this.draw.z; v.yaw = this.draw.yaw;
    v.mounted = this.avatar.mounted !== null;
    v.alive = !this.dead && !p.death;
    return v;
  }

  private viewFocus(): P2 {
    this.focusPoint.x = this.draw.x;
    this.focusPoint.z = this.draw.z;
    return this.focusPoint;
  }

  private viewMode(): ViewMode {
    if (this.switchFx && this.switchFx.t < SWITCH_MAP) return 'map';
    const j = this.journey;
    if (j && j.state.phase === 'travelling') return 'travel';
    // After a journey stops (an encounter, arrival, cancel) or a character switch the camera is still on the
    // map. Reading that back as "the map is open" would keep it there, so say 'street' until the renderer has
    // actually come down.
    if (this.streetPending) {
      if (this.cameraModeFn() !== 'map') this.streetPending = false;
      return 'street';
    }
    return this.cameraModeFn() === 'map' ? 'map' : 'street';
  }

  private viewMarkers(): readonly MapMarker[] {
    const p = this.person() ?? this.sim.state.persons.get(this.personId);
    const list = this.markerList;
    list.length = 0;
    if (!p) return list;
    const me = this.markers[0];
    const travelling = this.journey !== null && this.journey.state.phase === 'travelling';
    me.id = this.personId;
    me.kind = travelling ? 'party' : 'player';
    me.x = this.draw.x; me.z = this.draw.z;
    me.label = travelling ? 'Your party' : p.first;
    const k = this.world.kingdomAt(this.draw.x, this.draw.z);
    me.color = k ? k.color : 0xffd24a;
    list.push(me);
    // home and workplace change rarely: refreshed twice a second
    this.markerT -= 0.016;
    const st = this.sim.state;
    if (this.markerT <= 0) {
      this.markerT = 0.5;
      const hh = st.households.get(p.household);
      const hb = hh ? st.buildings.get(hh.home) : undefined;
      const home = this.markers[1];
      home.x = hb ? hb.x : 0; home.z = hb ? hb.z : 0;
      home.size = hb ? 1 : 0;
      const emp = this.economy.employment(this.personId);
      const wb = emp && emp.building !== undefined ? st.buildings.get(emp.building) : undefined;
      const work = this.markers[2];
      work.x = wb ? wb.x : 0; work.z = wb ? wb.z : 0;
      work.size = wb ? 1 : 0;
    }
    if (this.markers[1].size > 0) list.push(this.markers[1]);
    if (this.markers[2].size > 0) list.push(this.markers[2]);
    return list;
  }

  // ===========================================================================================
  // Small things
  // ===========================================================================================

  private person(): Person | undefined { return this.sim.state.persons.get(this.personId); }

  private notify(kind: SimEvents['notify']['kind'], text: string): void {
    this.sim.events.emit('notify', { kind, text, person: this.personId });
  }

  private refreshTraits(p: Person): void {
    const t = this.traits;
    t.agility = p.trained.agi;
    t.endurance = p.trained.end;
    t.age = ageYears(p, this.sim.absDay);
    t.ridingLevel = skillOf(p, 'riding');
    t.hunger = p.needs.hunger;
    t.rest = p.needs.rest;
    const inv = this.economy.inventory(p.id);
    t.weight = inv.weight;
    t.capacity = inv.capacity;
    const max = maxStamina(p.trained.end);
    const s = this.avatar.stamina;
    if (max !== s.max) { s.value = s.max > 0 ? s.value * (max / s.max) : max; s.max = max; }
    this.dangerNear = this.sim.hostileNear();
  }

  private persistNow(force = false): void {
    const st = this.sim.state;
    const b = this.avatar;
    const id = this.personId;
    if (!id) return;
    const prev = this.persisted;
    const mount = b.mounted && b.mounted.animal >= 0 ? { animal: b.mounted.animal, coat: b.mounted.coat } : undefined;
    const moved = !prev || prev.person !== id || Math.hypot(prev.x - b.x, prev.z - b.z) > 0.75 || Math.abs(angleDiff(prev.yaw, b.yaw)) > 0.15
      || (prev.mount?.animal ?? -2) !== (mount?.animal ?? -2);
    if (!moved && !force) return;
    if (prev && !moved && Math.hypot(prev.x - b.x, prev.z - b.z) < 1e-9) return;
    const next: PlayerExt = { v: 1, person: id, x: Math.round(b.x * 100) / 100, z: Math.round(b.z * 100) / 100, yaw: Math.round(b.yaw * 100) / 100 };
    if (mount) next.mount = mount;
    if (prev && prev.person === next.person && prev.x === next.x && prev.z === next.z && prev.yaw === next.yaw && (prev.mount?.animal ?? -2) === (next.mount?.animal ?? -2)) return;
    this.persisted = next;
    st.ext[EXT_KEY] = next;
    st.touchExt(EXT_KEY);
  }

  dispose(): void {
    this.dismissParty();
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.zone.detachPlayer();
  }
}

/** The point of a polygon's boundary (or inside it) closest to (x, z). */
export function nearestOnPolygon(poly: readonly P2[], x: number, z: number): P2 {
  let inside = false;
  let best: P2 = { x: poly[0].x, z: poly[0].z };
  let bd = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], c = poly[j];
    if ((a.z > z) !== (c.z > z) && x < ((c.x - a.x) * (z - a.z)) / (c.z - a.z) + a.x) inside = !inside;
    const abx = c.x - a.x, abz = c.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1) : 0;
    const px = a.x + abx * t, pz = a.z + abz * t;
    const d = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (d < bd) { bd = d; best = { x: px, z: pz }; }
  }
  return inside ? { x, z } : best;
}

/** Plain words for the sim's refusal reasons. */
export function speedRefusal(reason?: string): string {
  switch (reason) {
    case 'too dangerous to hurry': return 'Too dangerous to hurry: an enemy is near.';
    case 'not during action': return 'Not now: you are in the middle of something.';
    case 'choose a successor first': return 'Choose who carries on first.';
    case 'the run is over': return 'The run is over.';
    default: return reason ?? 'Not now.';
  }
}

