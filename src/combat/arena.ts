// The arena: every fighter in every fight near the player, stepped at 20 Hz after the zone. Positions here are
// authoritative while a fight lasts; the zone's agents and beasts are puppets the arena writes every step
// (the zone is told to leave them alone with an idle order). Without a zone the same fight runs on its own,
// which is how headless runs and the tests exercise it.
import type { MoveResult, NavApi, ZoneAgent, ZoneAnimal, ZoneApi } from '../agents/types';
import type { AnimalKind } from '../core/domain';
import { angleDiff, clamp, dist, hash3, yawTo, type P2 } from '../core/math';
import type { Rng } from '../core/rng';
import type { AnimalDrawItem, AnimState, CharacterDrawItem, HeldItem } from '../core/view';
import type { SimContext } from '../sim/context';
import type { EconomyApi } from '../sim/economy/types';
import type { SimEvents } from '../sim/events';
import { skillOf } from '../sim/skills';
import type { SocialApi } from '../sim/social/types';
import { ageYears, fullName, type Person, type PersonId } from '../sim/state';
import type { FightResult, FightSide } from '../sim/wave3';
import { think } from './ai';
import { BEASTS, BEAST_KEY_BASE, Fighter, S, normAngle, turnTo } from './fighter';
import { FxQueue } from './fx';
import { gearOf, type Gear, type GearEnv } from './gear';
import { Projectiles } from './projectiles';
import { applyBlow, baseDamage, impact, meleeAccuracy, releaseShot, type Blow } from './strike';
import { ARMOUR, RANGED, SHIELDS, WEAPONS, type ArmourDef } from './weapons';
import { LOCATION_NAMES, WoundBook, maxHpOf, shapeWound } from './wounds';
import type { HitLocation } from '../sim/wave3';

export interface FightSideState { faction: string; members: Fighter[] }

export interface Fight {
  id: number;
  sides: FightSideState[];
  at: P2;
  yieldAllowed: boolean;
  reason: string;
  t: number;
  /** Seconds since anything was struck or shot. */
  quiet: number;
  ended: boolean;
  startDay: number;
  /** The player is one of the fighters. */
  playerIn: boolean;
  check: number;
}

/** Everything the arena needs from the rest of the game; all of it optional except the simulation context. */
export interface ArenaEnv {
  ctx: SimContext;
  book: WoundBook;
  zone: ZoneApi | undefined;
  economy: EconomyApi | undefined;
  social: SocialApi | undefined;
  gearEnv: GearEnv;
  fx: FxQueue;
  proj: Projectiles;
  /** The player's body, if the player module is installed. */
  playerBody(): { x: number; y: number; z: number; yaw: number } | null;
  notify(kind: SimEvents['notify']['kind'], text: string, person?: PersonId): void;
  /** Wind at the player (m/s). */
  wind(): { x: number; z: number };
  /** The hostile-near flag / action time follow the fights. */
  fightsChanged(): void;
  onKill?(killer: Fighter | null, victim: Fighter): void;
  /** A fight is over (before listeners hear of it): consequences for the player, crimes, rewards. */
  fightEnded?(fight: Fight, result: FightResult): void;
  /** The player's blow or arrow found a body. */
  playerHit?(f: Fighter, victim: Fighter, ranged: boolean, killed: boolean): void;
}

export interface KitOverride { weapon?: string; shield?: string | null; ranged?: string | null; armour?: string[] }
export interface Corpse { draw: CharacterDrawItem; until: number; born: number; person: PersonId }
export interface BeastCorpse { draw: AnimalDrawItem; until: number }

/** Edge-to-edge distance between two fighters. */
export function gap(a: Fighter, b: Fighter): number {
  return Math.max(0, Math.hypot(a.x - b.x, a.z - b.z) - a.radius - b.radius);
}

const FLEE_GONE = 55;
const FIGHT_QUIET_END = 45;
const MAX_FIGHT_SECONDS = 600;
const DISPERSE_RADIUS = 170;
const CORPSE_SECONDS = 110;

interface BodyExtras { dx: number; dz: number; dy: number }
interface BeastBody { x: number; z: number; y: number; yaw: number; dx: number; dz: number; dy: number; dead?: boolean }

export class Arena {
  readonly fighters: Fighter[] = [];
  readonly byKey = new Map<number, Fighter>();
  readonly fights = new Map<number, Fight>();
  readonly corpses: Corpse[] = [];
  readonly beastCorpses: BeastCorpse[] = [];
  private readonly beastView: AnimalDrawItem[] = [];
  readonly endListeners: Array<(r: FightResult) => void> = [];
  nextFight = 1;
  time = 0;
  private stepNo = 0;
  player: Fighter | null = null;
  lastResult: FightResult | null = null;
  private readonly mr: MoveResult = { x: 0, z: 0, blocked: false, wading: false };
  private readonly tmpP: P2 = { x: 0, z: 0 };
  private readonly beasts = new Map<number, ZoneAnimal>();
  private readonly corpseView: CharacterDrawItem[] = [];
  private checkT = 0;

  constructor(readonly env: ArenaEnv) {}

  get rng(): Rng { return this.env.ctx.rng('combat'); }
  get nav(): NavApi | null { return this.env.zone ? this.env.zone.nav : null; }
  get absDay(): number { return this.env.ctx.absDay; }

  groundY(x: number, z: number): number {
    const nav = this.nav;
    return nav ? nav.groundY(x, z) : this.env.ctx.world.heightAt(x, z);
  }

  // ---------------------------------------------------------------------------------------------
  // Fighters
  // ---------------------------------------------------------------------------------------------

  private readonly kitOverrides = new Map<PersonId, KitOverride>();

  /** Replaces what a person carries into fights (tests, screenshots, scripted scenes). */
  setKitOverride(person: PersonId, kit: KitOverride): void {
    this.kitOverrides.set(person, kit);
    const f = this.byKey.get(person);
    if (f?.person) { f.gear = this.gearFor(f.person); f.shotsLeft = f.gear.ammo; }
  }

  gearFor(p: Person): Gear {
    const g = gearOf(this.env.gearEnv, p);
    const k = this.kitOverrides.get(p.id);
    if (!k) return g;
    if (k.weapon !== undefined) g.weapon = WEAPONS[k.weapon] ?? g.weapon;
    if (k.shield !== undefined) g.shield = k.shield ? SHIELDS[k.shield] ?? null : null;
    if (k.ranged !== undefined) { g.ranged = k.ranged ? RANGED[k.ranged] ?? null : null; g.rangedMain = !!g.ranged; g.ammo = g.ranged ? Math.max(g.ammo, 30) : 0; }
    if (k.armour) { g.armour = k.armour.map((id) => ARMOUR[id]).filter((d): d is ArmourDef => !!d).map((def) => ({ def, quality: 1 as const })); }
    g.worn = g.armour.reduce((s, x) => s + x.def.weight, 0) + (g.shield?.weight ?? 0);
    return g;
  }

  makePerson(p: Person): Fighter {
    const env = this.env;
    const gear: Gear = this.gearFor(p);
    const f = new Fighter({ person: p, gear });
    const look = env.gearEnv.appearance.get(env.ctx.state, p, this.absDay).look;
    const age = ageYears(p, this.absDay);
    f.height = clamp(look.height, 1.0, 2.0);
    f.radius = age < 12 ? 0.24 : 0.32;
    this.refreshStats(f);
    f.stamina = f.staminaMax;
    f.moraleBase = this.baseMorale(p, gear);
    f.morale = f.moraleBase;
    f.aggression = clamp(0.55 + 0.03 * (f.melee - 3) + (p.traits.includes('hot_tempered') ? 0.18 : 0) + (p.traits.includes('brave') ? 0.1 : 0)
      - (p.traits.includes('craven') ? 0.25 : 0) + (p.rankTier >= 5 ? 0.08 : 0), 0.25, 1.1);
    f.strafe = hash3(p.id, 3) % 2 === 0 ? 1 : -1;
    f.preferRanged = !!gear.ranged && gear.ammo > 0 && (gear.rangedMain || p.career === 'archer' || gear.weapon === WEAPONS.fists);
    f.shotsLeft = gear.ammo;
    return f;
  }

  makeBeast(an: ZoneAnimal): Fighter | null {
    const info = BEASTS[an.kind];
    if (!info) return null;
    const gear: Gear = { weapon: WEAPONS[info.weapon], weaponQ: 1, shield: null, shieldQ: 1, ranged: null, rangedQ: 1, armour: [], ammo: 0, ammoKey: null, worn: 0, rangedMain: false };
    const f = new Fighter({ animalId: an.id, animalKind: an.kind, gear });
    f.radius = info.radius;
    f.height = info.height;
    f.beastMax = info.hp * (0.9 + 0.2 * ((hash3(an.id, 5) % 100) / 100));
    f.beastHp = f.beastMax;
    f.str = 10; f.agi = 11; f.end = 10; f.melee = 4; f.per = 12;
    f.staminaMax = 120; f.stamina = 120;
    f.moraleBase = info.courage + ((hash3(an.id, 9) % 20) - 10);
    f.morale = f.moraleBase;
    f.aggression = 0.8;
    f.strafe = hash3(an.id, 3) % 2 === 0 ? 1 : -1;
    return f;
  }

  refreshStats(f: Fighter): void {
    const p = f.person;
    if (!p) return;
    f.str = p.trained.str; f.agi = p.trained.agi; f.end = p.trained.end; f.per = p.trained.per;
    f.melee = skillOf(p, 'melee');
    f.archery = skillOf(p, 'archery');
    f.maxHp = maxHpOf(p);
    f.staminaMax = Math.round(30 + 7 * p.trained.end);
  }

  private baseMorale(p: Person, gear: Gear): number {
    let m = 52 + 2.2 * (p.trained.cha - 10) + 1.5 * (p.trained.end - 10);
    if (p.traits.includes('brave')) m += 24;
    if (p.traits.includes('craven')) m -= 26;
    m += 3 * Math.min(8, skillOf(p, 'melee'));
    m += gear.armour.length > 0 ? 6 : 0;
    if (p.rankTier >= 5) m += 12;
    if (p.career === 'outlaw') m -= 6;
    return clamp(m, 15, 98);
  }

  // ---------------------------------------------------------------------------------------------
  // Starting and ending fights
  // ---------------------------------------------------------------------------------------------

  /** A fighter by person id, or the player's. */
  fighterOf(person: PersonId): Fighter | undefined { return this.byKey.get(person); }

  inFight(person: PersonId): boolean {
    const f = this.byKey.get(person);
    return !!f && f.fight !== 0 && !f.gone;
  }

  engage(sides: FightSide[], opts: { at?: P2; yieldAllowed?: boolean; reason?: string } = {}): number {
    const env = this.env;
    const fight: Fight = {
      id: this.nextFight++, sides: [], at: opts.at ?? this.focus(), yieldAllowed: opts.yieldAllowed ?? true,
      reason: opts.reason ?? 'fight', t: 0, quiet: 0, ended: false, startDay: this.absDay, playerIn: false, check: 0,
    };
    const created: Fighter[] = [];
    sides.forEach((s, si) => {
      const side: FightSideState = { faction: s.faction, members: [] };
      fight.sides.push(side);
      for (const pid of s.people) {
        const p = env.ctx.state.persons.get(pid);
        if (!p || p.death) continue;
        let f = this.byKey.get(pid);
        // the player's body is the controller's: the port's fighter is the one that fights
        if (!f && pid === env.ctx.state.run.playerId && env.playerBody()) f = this.ensurePlayer(pid) ?? undefined;
        if (f && f.fight !== 0 && !f.gone) continue; // already fighting somewhere else
        if (!f) {
          f = this.makePerson(p);
          this.addFighter(f);
          created.push(f);
        } else this.refreshStats(f);
        f.side = si; f.fight = fight.id; f.faction = s.faction;
        side.members.push(f);
        if (f.isPlayer) fight.playerIn = true;
      }
      for (const aid of s.animals ?? []) {
        const an = env.zone?.animals().find((a) => a.id === aid);
        if (!an) continue;
        const key = BEAST_KEY_BASE + aid;
        if (this.byKey.has(key)) continue;
        const f = this.makeBeast(an);
        if (!f) continue;
        f.side = si; f.fight = fight.id; f.faction = s.faction;
        this.addFighter(f);
        this.beasts.set(aid, an);
        side.members.push(f);
        created.push(f);
      }
    });
    if (fight.sides.filter((s) => s.members.length > 0).length < 2) {
      // nobody to fight: undo
      for (const f of created) this.removeFighter(f);
      for (const s of fight.sides) for (const f of s.members) { if (f.fight === fight.id) { f.fight = 0; f.side = 0; } }
      return 0;
    }
    this.place(fight, created);
    this.fights.set(fight.id, fight);
    for (const s of fight.sides) for (const f of s.members) { f.target = null; f.cooldown = 0.3 + (hash3(f.key, fight.id) % 100) / 100; }
    env.fightsChanged();
    return fight.id;
  }

  private addFighter(f: Fighter): void {
    this.fighters.push(f);
    this.byKey.set(f.key, f);
  }

  removeFighter(f: Fighter): void {
    const i = this.fighters.indexOf(f);
    if (i >= 0) this.fighters.splice(i, 1);
    this.byKey.delete(f.key);
    if (f.isAnimal) this.beasts.delete(f.animalId);
    if (this.player === f) this.player = null;
  }

  focus(): P2 {
    const b = this.env.playerBody();
    if (b) return { x: b.x, z: b.z };
    const f = this.env.ctx.state.run.playerId;
    void f;
    return { x: 0, z: 0 };
  }

  /** Puts each side where it can be seen: kept where the zone already has them, else a loose line facing the others. */
  private place(fight: Fight, created: readonly Fighter[]): void {
    const zone = this.env.zone;
    const at = fight.at;
    const n = fight.sides.length;
    const base = (hash3(fight.id, 17) % 628) / 100;
    fight.sides.forEach((side, si) => {
      const ang = base + (si * Math.PI * 2) / n;
      const cx = at.x + Math.cos(ang) * 6.5, cz = at.z + Math.sin(ang) * 6.5;
      const px = -Math.sin(ang), pz = Math.cos(ang);
      side.members.forEach((f, mi) => {
        if (f.isPlayer) return;
        let x: number, z: number, yaw: number, y: number;
        const agent = f.person ? zone?.agent(f.personId) ?? null : null;
        const beast = f.isAnimal ? this.beasts.get(f.animalId) ?? null : null;
        if (agent) { x = agent.x; z = agent.z; y = agent.y; yaw = agent.yaw; }
        else if (beast) { const b = beast as unknown as BeastBody; x = b.x; z = b.z; y = b.y; yaw = b.yaw; }
        else {
          const off = (mi - (side.members.length - 1) / 2) * 1.9;
          x = cx + px * off; z = cz + pz * off;
          yaw = yawTo(x, z, at.x, at.z);
          if (this.nav && !this.nav.walkable(x, z) && this.nav.nearestWalkable(x, z, 12, this.tmpP)) { x = this.tmpP.x; z = this.tmpP.z; }
          y = this.groundY(x, z);
          if (f.person && zone?.summon && created.includes(f)) { zone.summon(f.personId, x, z, yaw); f.summonedByUs = true; }
        }
        f.x = f.px = x; f.z = f.pz = z; f.y = y; f.yaw = yaw;
        this.tame(f);
      });
    });
    // everyone turns towards the nearest enemy
    for (const side of fight.sides) for (const f of side.members) {
      if (f.isPlayer) continue;
      const e = this.nearestEnemy(f, fight);
      if (e) f.yaw = yawTo(f.x, f.z, e.x, e.z);
    }
  }

  /** Tells the zone to leave a person's body alone: an idle order for people, nothing needed for summoned beasts. */
  private tame(f: Fighter): void {
    const zone = this.env.zone;
    if (!zone || !f.person) return;
    const a = zone.agent(f.personId);
    if (a && a.control !== 'script') zone.command(f.personId, { kind: 'perform', anim: 'idle', seconds: 1e7 });
  }

  /** Releases a fighter's body back to the zone's routines (or dismisses it if the arena summoned it). */
  private free(f: Fighter): void {
    const zone = this.env.zone;
    if (!zone || !f.person) return;
    if (f.summonedByUs) zone.dismiss?.(f.personId);
    else if (!f.isPlayer) {
      const a = zone.agent(f.personId);
      if (a && !f.person.death) {
        a.activity = 'idle';
        zone.command(f.personId, { kind: 'resume' });
      }
    }
  }

  nearestEnemy(f: Fighter, fight: Fight | undefined = this.fights.get(f.fight), activeOnly = true): Fighter | null {
    if (!fight) return null;
    let best: Fighter | null = null;
    let bd = Infinity;
    for (const side of fight.sides) {
      if (side === fight.sides[f.side]) continue;
      for (const e of side.members) {
        if (activeOnly && !e.active) continue;
        const d = (e.x - f.x) * (e.x - f.x) + (e.z - f.z) * (e.z - f.z);
        if (d < bd) { bd = d; best = e; }
      }
    }
    return best;
  }

  /** Is a fighter hostile to another (different side of the same fight)? */
  hostile(a: Fighter, b: Fighter): boolean { return a !== b && a.fight !== 0 && a.fight === b.fight && a.side !== b.side; }

  // ---------------------------------------------------------------------------------------------
  // The player's fighter
  // ---------------------------------------------------------------------------------------------

  ensurePlayer(personId: PersonId): Fighter | null {
    if (this.player && this.player.personId === personId && !this.player.person?.death) return this.player;
    if (this.player) this.dropPlayer();
    const p = this.env.ctx.state.persons.get(personId);
    if (!p || p.death) return null;
    const f = this.makePerson(p);
    f.isPlayer = true;
    f.external = true;
    const b = this.env.playerBody();
    if (b) { f.x = f.px = b.x; f.z = f.pz = b.z; f.y = b.y; f.yaw = b.yaw; }
    this.player = f;
    this.addFighter(f);
    return f;
  }

  dropPlayer(): void {
    const f = this.player;
    if (!f) return;
    const fight = this.fights.get(f.fight);
    if (fight) {
      const side = fight.sides[f.side];
      const i = side.members.indexOf(f);
      if (i >= 0) side.members.splice(i, 1);
    }
    this.removeFighter(f);
    this.player = null;
  }

  // ---------------------------------------------------------------------------------------------
  // The step
  // ---------------------------------------------------------------------------------------------

  step(dt: number): void {
    const env = this.env;
    if (this.fighters.length === 0 && env.proj.count === 0 && this.corpses.length === 0 && env.proj.landed.length === 0) return;
    this.time += dt;
    const list = this.fighters;
    // who acts first rotates every step, so neither side gets the first blow of every exchange
    const n = list.length;
    const start = n > 0 ? this.stepNo++ % n : 0;
    for (let k = 0; k < n; k++) {
      const f = list[(start + k) % n];
      if (f.gone) continue;
      if (f.external) {
        this.followPlayerBody(f);
        if (f.person?.death && f.st !== S.Dead) this.markDead(f, null);
        continue;
      }
      if (f.fight === 0) continue;
      this.advance(f, dt);
    }
    this.stepProjectiles(dt);
    this.bleed(dt);
    this.checkT -= dt;
    if (this.checkT <= 0) { this.checkT = 0.4; this.checkFights(0.4); }
    this.writeBodies(dt);
    for (let i = this.corpses.length - 1; i >= 0; i--) if (this.time > this.corpses[i].until) this.corpses.splice(i, 1);
    for (let i = this.beastCorpses.length - 1; i >= 0; i--) if (this.time > this.beastCorpses[i].until) this.beastCorpses.splice(i, 1);
    this.sweep();
  }

  /** The player's controller moves the body; the arena only reads it. */
  followPlayerBody(f: Fighter): void {
    const b = this.env.playerBody();
    if (!b) return;
    f.px = f.x; f.pz = f.z;
    f.x = b.x; f.z = b.z; f.y = b.y; f.yaw = b.yaw;
  }

  private advance(f: Fighter, dt: number): void {
    f.px = f.x; f.pz = f.z;
    const st = f.st;
    if (st !== S.Dead && st !== S.Gone) {
      if (!f.isAnimal && f.person && f.person.death) { this.markDead(f, null); return; }
      this.refreshHealth(f);
      think(this, f, dt);
      this.tickShared(f, dt);
      this.integrate(f, dt);
    }
  }

  /** Reads hit points and wounds into the fighter's state: down, dying, or dead. */
  refreshHealth(f: Fighter): void {
    const p = f.person;
    if (p) {
      if (p.death) { this.markDead(f, null); return; }
      if (f.st === S.Down || f.st === S.Dead || f.st === S.Gone) return;
      if (this.env.book.down(p.id) && f.st !== S.Yield) this.fall(f);
    } else if (f.beastHp <= 0 && f.st !== S.Dead) this.markDead(f, null);
  }

  /** Knocked down: falls, lies, may rise again later if not dying. */
  fall(f: Fighter): void {
    if (f.st === S.Down || f.st === S.Dead) return;
    f.set(S.Down, 'fall', 1.3);
    f.riseAt = f.person ? 3 + (this.rng.next() * 4) : 99;
    f.downT = 0;
    f.speed = 0; f.wantSpeed = 0;
    this.env.fx.add('dust', f.x, f.y + 0.1, f.z, 0.6);
  }

  markDead(f: Fighter, killer: Fighter | null): void {
    if (f.st === S.Dead) return;
    f.killedBy = killer ? killer.key : null;
    f.set(S.Dead, 'fall', 1.3);
    f.speed = 0; f.wantSpeed = 0;
    f.corpseAt = this.time;
    if (killer) killer.kills++;
    if (f.person && !f.isPlayer) this.addCorpse(f);
    else if (f.isAnimal) this.addBeastCorpse(f);
    this.env.onKill?.(killer, f);
    // the others notice
    const fight = this.fights.get(f.fight);
    if (fight) {
      for (const side of fight.sides) for (const m of side.members) {
        if (m === f || !m.active) continue;
        const ally = m.side === f.side;
        m.morale -= ally ? 9 : -3;
        if (!ally && killer === m) m.morale += 6;
      }
    }
  }

  private addCorpse(f: Fighter): void {
    const zone = this.env.zone;
    const agent = zone ? zone.agent(f.personId) : null;
    const p = f.person;
    if (!p) return;
    const base = agent?.draw;
    const look = base ? base.look : this.env.gearEnv.appearance.get(this.env.ctx.state, p, this.absDay).look;
    const draw: CharacterDrawItem = {
      id: f.personId, x: f.x, y: f.y, z: f.z, yaw: f.yaw, look, lookVersion: base ? base.lookVersion : 1,
      mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'fall', animTime: 0, moveSpeed: 0, highlight: 0,
    };
    this.corpses.push({ draw, until: this.time + CORPSE_SECONDS, born: this.time, person: f.personId });
  }

  private addBeastCorpse(f: Fighter): void {
    const an = this.beasts.get(f.animalId);
    if (!an || !f.animalKind) return;
    const d = an.draw;
    const draw: AnimalDrawItem = {
      id: 30_000_000 + f.animalId, kind: f.animalKind, x: f.x, y: f.y, z: f.z, yaw: f.yaw, anim: 'dead', animTime: 0, moveSpeed: 0,
      scale: d.scale, coat: d.coat, young: d.young, male: d.male, highlight: 0,
    };
    this.beastCorpses.push({ draw, until: this.time + CORPSE_SECONDS });
    // the live animal leaves the zone's care: dismissed if the game summoned it, else moved out of range so the zone drops it
    this.env.zone?.dismissAnimal?.(f.animalId);
    const b = an as unknown as BeastBody;
    b.x += 4000;
  }

  beastCorpseDraws(): readonly AnimalDrawItem[] {
    const out = this.beastView;
    out.length = 0;
    for (const c of this.beastCorpses) { c.draw.animTime = 0; out.push(c.draw); }
    return out;
  }

  corpseDraws(): readonly CharacterDrawItem[] {
    const out = this.corpseView;
    out.length = 0;
    for (const c of this.corpses) {
      const age = this.time - c.born;
      c.draw.anim = age < 1.3 ? 'fall' : 'dead';
      c.draw.animTime = age < 1.3 ? age : age - 1.3;
      out.push(c.draw);
    }
    return out;
  }

  // ---- the shared state machine ----

  /** Timers, stamina and the end of windups and recoveries. Everything an NPC or the player does passes through here. */
  tickShared(f: Fighter, dt: number): void {
    f.t += dt;
    f.animT += dt;
    f.cooldown -= dt;
    f.dodgeI -= dt;
    f.dodgeCd -= dt;
    f.lastBlow += dt;
    f.guardT += dt;
    f.staminaIdle += dt;
    if (!f.external) this.regen(f, dt);
    switch (f.st) {
      case S.Windup:
        if (!f.impacted && f.t >= f.dur) {
          f.impacted = true;
          impact(this, f);
          // the blow may have been parried or the fighter struck: only a swing still under way recovers
          if (f.st === S.Windup) {
            const a = f.attack;
            if (a) this.toRecover(f, a.recover);
            else this.toIdle(f);
          }
        }
        break;
      case S.Recover:
        if (f.t >= f.dur) this.toIdle(f);
        break;
      case S.Hit: case S.Stagger: case S.Dodge:
        if (f.t >= f.dur) this.toIdle(f);
        break;
      case S.Draw:
        if (f.t >= f.dur) { f.nocked = true; f.set(S.Aim, f.gear.ranged?.type === 'crossbow' ? 'aim_crossbow' : 'aim_bow', 99); }
        break;
      case S.Shoot:
        if (!f.impacted && f.t >= 0.22) { f.impacted = true; releaseShot(this, f); }
        if (f.t >= f.dur) {
          f.nocked = false;
          if (f.gear.ranged?.type === 'crossbow') { f.loaded = false; f.set(S.Reload, 'reload_crossbow', f.gear.ranged.reload * this.speedOf(f, false)); }
          else this.toIdle(f);
        }
        break;
      case S.Reload:
        if (f.t >= f.dur) { f.loaded = true; this.toIdle(f); }
        break;
      case S.Down:
        f.downT += dt;
        if (f.person && f.downT >= f.riseAt && this.canRise(f)) { f.set(S.Idle, 'idle'); f.cooldown = 0.8; f.stamina = Math.max(f.stamina, f.staminaMax * 0.2); }
        break;
      default:
        break;
    }
    // a swing that never lands in the animation clip has ended
    if (f.st === S.Idle && f.anim !== 'idle' && f.anim !== 'walk' && f.anim !== 'run' && f.anim !== 'block' && f.anim !== 'kneel') f.anim = 'idle';
  }

  private canRise(f: Fighter): boolean {
    const p = f.person;
    if (!p) return false;
    const rec = this.env.book.rec(p.id);
    if (rec && rec.dying !== undefined) return false;
    return !this.env.book.down(p.id);
  }

  private regen(f: Fighter, dt: number): void {
    let r: number;
    switch (f.st) {
      case S.Idle: r = f.moving ? 5 : 9; break;
      case S.Recover: r = 3; break;
      case S.Block: r = 2.2; break;
      case S.Down: r = 6; break;
      case S.Windup: case S.Dodge: r = 0; break;
      default: r = 4;
    }
    if (f.person) {
      const hunger = f.person.needs.hunger;
      r *= 0.5 + 0.5 * clamp(hunger * 1.5, 0, 1);
      // heavy armour tires
      r *= clamp(1 - f.gear.worn * 0.007, 0.6, 1);
    }
    f.stamina = clamp(f.stamina + r * dt, 0, f.staminaMax);
  }

  speedOf(f: Fighter, attack: boolean): number {
    // quicker with Agility, slower in heavy weapons and when tired or hurt
    let s = 1 - 0.022 * (f.agi - 10);
    s += clamp(f.gear.weapon.weight - f.str * 0.22, 0, 3) * 0.05;
    s += (1 - f.breath) * 0.25;
    if (f.person) s += this.env.book.limbPenalty(f.personId, 'arms') * 0.5;
    if (attack) s -= 0.01 * Math.min(f.melee, 12);
    return clamp(s, 0.7, 1.7);
  }

  toIdle(f: Fighter): void {
    f.set(S.Idle, 'idle');
    f.impacted = false;
    f.attack = null;
  }

  toRecover(f: Fighter, recover: number): void {
    f.st = S.Recover;
    f.t = 0;
    f.dur = recover * this.speedOf(f, true);
  }

  /** Starts a blow. Returns false if the fighter cannot (state, breath). */
  startAttack(f: Fighter, key: 'slash' | 'overhead' | 'thrust', rangedSidearm = false): boolean {
    if (f.st !== S.Idle && f.st !== S.Block && f.st !== S.Recover) return false;
    void rangedSidearm;
    const w = f.gear.weapon;
    const a = w.attacks[key];
    const cost = a.stamina * (1 + f.gear.worn * 0.012);
    if (f.stamina < cost * 0.25) return false;
    f.stamina = Math.max(0, f.stamina - cost);
    f.staminaIdle = 0;
    f.attackKey = key;
    f.attack = a;
    f.heavy = key === 'overhead';
    f.impacted = false;
    f.serial++;
    const sp = this.speedOf(f, true);
    f.set(S.Windup, a.anim, a.windup * sp);
    f.lunge = key === 'thrust' ? 1.7 : key === 'slash' ? 0.9 : 0.6;
    f.charge = 1;
    return true;
  }

  /** A couched lance meets a body at the gallop: speed is the whole weapon. */
  lanceStrike(f: Fighter, e: Fighter, speed: number): void {
    const atk = f.gear.weapon.attacks.thrust;
    const mult = clamp(Math.pow(speed / 11, 1.3) * 2.3, 0.6, 2.5);
    f.attackKey = 'thrust'; f.attack = atk; f.heavy = true;
    const blow: Blow = {
      kind: atk.kind, dmg: baseDamage(f, atk.dmg, false, this.rng.next()) * mult, ap: atk.ap + 0.15, how: 'thrust', weapon: f.gear.weapon.id,
      fromX: f.x, fromZ: f.z, melee: true, heightDiff: 0.9, accuracy: meleeAccuracy(f) + 0.2,
    };
    const r = applyBlow(this, f, e, blow);
    if (r.outcome === 'hit') {
      f.hitsLanded++;
      if (!r.killed && mult > 1.2 && this.rng.next() < 0.7) this.fall(e);
      if (this.rng.next() < 0.4) {
        f.gear.weapon = WEAPONS.sword;
        this.env.notify('info', 'Your lance shatters on the blow.', f.personId);
      }
    }
  }

  /** The blow fell on the player's horse instead of the rider; a horse that goes down throws its rider. */
  horseStruck(rider: Fighter, dmg: number, fromX: number, fromZ: number): void {
    rider.mountHp -= dmg;
    const ang = yawTo(rider.x, rider.z, fromX, fromZ);
    this.env.fx.add('blood', rider.x + Math.sin(ang) * 0.5, rider.y + 0.9, rider.z + Math.cos(ang) * 0.5, 1.2);
    if (rider.mountHp <= 0) {
      rider.unhorse = true;
      rider.mounted = false;
      this.env.notify('danger', 'Your horse goes down and throws you!', rider.personId);
      // the fall hurts: a blunt blow to a limb or the back
      const p = rider.person;
      if (p) {
        const where = this.rng.pick<HitLocation>(['arm_l', 'arm_r', 'leg_l', 'leg_r', 'torso']);
        this.env.book.inflict(p, shapeWound(this.rng, where, 'blunt', 8 + this.rng.next() * 12, rider.maxHp), 'a fall from the saddle', 'accident');
        this.fall(rider);
      }
    }
  }

  // ---- movement ----

  private integrate(f: Fighter, dt: number): void {
    let sp = f.wantSpeed;
    let dx = f.wantX, dz = f.wantZ;
    const st = f.st;
    if (st === S.Windup) {
      // lunge a short step into the blow, towards where the fighter faces
      sp = f.t < f.dur * 0.9 ? f.lunge : 0;
      dx = Math.sin(f.yaw); dz = Math.cos(f.yaw);
      const t = f.target;
      if (t && gap(f, t) < Math.max(0.2, f.gear.weapon.reach * 0.55)) sp = 0;
    } else if (st === S.Hit || st === S.Stagger || st === S.Down || st === S.Dead || st === S.Reload || st === S.Yield || st === S.Shoot) {
      sp = st === S.Stagger ? -0.8 : 0;
      if (st === S.Stagger) { dx = Math.sin(f.yaw); dz = Math.cos(f.yaw); if (f.t > 0.4) sp = 0; }
    } else if (st === S.Recover) sp *= 0.25;
    else if (st === S.Block) sp *= 0.5;
    else if (st === S.Draw || st === S.Aim) sp *= 0.45;
    else if (st === S.Dodge) {
      const k = clamp(1 - f.t / Math.max(0.01, f.dur), 0, 1);
      sp = 5.2 * Math.sqrt(k);
      dx = f.dodgeDx; dz = f.dodgeDz;
    }
    if (sp > 0) sp *= this.mobility(f);
    f.speed = Math.abs(sp);
    f.moving = sp > 0.2;
    // facing
    if (!Number.isNaN(f.wantYaw) && st !== S.Down && st !== S.Dead && st !== S.Dodge && st !== S.Stagger && st !== S.Hit) {
      const rate = (st === S.Windup || st === S.Recover ? 4.5 : 9.5) * clamp(1 + 0.02 * (f.agi - 10), 0.7, 1.3);
      f.yaw = turnTo(f.yaw, f.wantYaw, rate * dt);
    }
    if (Math.abs(sp) > 1e-3) this.move(f, dx * sp * dt, dz * sp * dt);
    this.separate(f, dt);
    f.vx = (f.x - f.px) / dt; f.vz = (f.z - f.pz) / dt;
    f.y = this.groundY(f.x, f.z);
  }

  /** How well the body moves: legs, wounds, tiredness and weight on the back. */
  mobility(f: Fighter): number {
    let m = clamp(1 + 0.02 * (f.agi - 10), 0.85, 1.12);
    if (f.person) {
      m *= 1 - this.env.book.limbPenalty(f.personId, 'legs') * 0.55;
      if (f.person.health.hp < 0.5) m *= 0.88;
      m *= clamp(1 - f.gear.worn * 0.004, 0.7, 1);
    } else if (f.beastMax > 0 && f.beastHp < f.beastMax * 0.4) m *= 0.8;
    if (f.stamina < 5) m *= 0.8;
    return m;
  }

  move(f: Fighter, dx: number, dz: number): void {
    const nav = this.nav;
    if (nav) {
      nav.move(f.x, f.z, dx, dz, f.radius, this.mr);
      f.x = this.mr.x; f.z = this.mr.z;
    } else { f.x += dx; f.z += dz; }
  }

  /** Bodies do not overlap: a soft push apart from everyone within touching distance. */
  private separate(f: Fighter, dt: number): void {
    const list = this.fighters;
    let sx = 0, sz = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === f || o.gone || o.st === S.Dead || o.st === S.Down) continue;
      const ddx = f.x - o.x, ddz = f.z - o.z;
      const rr = f.radius + o.radius + 0.06;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.01;
      const push = (rr - d) / rr;
      sx += (ddx / d) * push; sz += (ddz / d) * push;
    }
    if (sx !== 0 || sz !== 0) this.move(f, sx * 2.6 * dt, sz * 2.6 * dt);
  }

  // ---- bleeding ----

  private bleedT = 0;
  private bleed(dt: number): void {
    this.bleedT += dt;
    if (this.bleedT < 0.25) return;
    const span = this.bleedT;
    this.bleedT = 0;
    const book = this.env.book;
    for (const f of this.fighters.slice()) {
      if (!f.person || f.st === S.Dead) continue;
      const p = f.person;
      if (p.death) continue;
      if (book.isHurt(p.id)) book.advance(p, span, f.fight ? 'battle' : 'violence');
      if (p.death) this.markDead(f, f.killedBy !== null ? this.byKey.get(f.killedBy) ?? null : this.lastAttackerOf(f));
    }
  }

  private lastAttackerOf(f: Fighter): Fighter | null {
    const fight = this.fights.get(f.fight);
    if (!fight) return null;
    return this.nearestEnemy(f, fight, false);
  }

  // ---- projectiles ----

  private stepProjectiles(dt: number): void {
    const proj = this.env.proj;
    if (proj.flying.length === 0 && proj.landed.length === 0) return;
    const nav = this.nav;
    proj.step(dt, (x, z) => this.groundY(x, z), nav ? (x, _y, z) => !nav.walkable(x, z) : null, (s, x0, y0, z0, x1, y1, z1) => this.shotHits(s, x0, y0, z0, x1, y1, z1));
  }

  private shotHits(s: import('./projectiles').Shot, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    let bestT = 2;
    let victim: Fighter | null = null;
    let hitY = 0;
    const dx = x1 - x0, dz = z1 - z0, dy = y1 - y0;
    const len2 = dx * dx + dz * dz;
    const list = this.fighters;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f.gone || f.st === S.Dead || f.key === s.shooter && s.age < 0.25) continue;
      if (f.st === S.Yield) continue;
      // closest approach in the ground plane
      let t = len2 > 1e-9 ? ((f.x - x0) * dx + (f.z - z0) * dz) / len2 : 0;
      t = clamp(t, 0, 1);
      const cx = x0 + dx * t, cz = z0 + dz * t;
      const rr = f.radius + 0.12;
      if ((cx - f.x) * (cx - f.x) + (cz - f.z) * (cz - f.z) > rr * rr) continue;
      const cy = y0 + dy * t;
      const foot = f.y;
      const top = f.st === S.Down ? foot + 0.45 : foot + f.height;
      if (cy < foot - 0.05 || cy > top + 0.08) continue;
      if (t < bestT) { bestT = t; victim = f; hitY = cy; }
    }
    if (!victim) return false;
    const shooter = this.byKey.get(s.shooter) ?? null;
    s.x = x0 + dx * bestT; s.y = hitY; s.z = z0 + dz * bestT;
    return arrowStrike(this, s, shooter, victim, hitY);
  }

  // ---------------------------------------------------------------------------------------------
  // Ending
  // ---------------------------------------------------------------------------------------------

  private checkFights(span: number): void {
    for (const fight of [...this.fights.values()]) {
      if (fight.ended) continue;
      fight.t += span;
      fight.quiet += span;
      this.updateMorale(fight);
      const alive = fight.sides.map((s) => s.members.filter((m) => m.active && !m.gone).length);
      const standing = alive.filter((n) => n > 0).length;
      let why: string | null = null;
      if (standing <= 1) why = standing === 1 ? 'won' : 'mutual';
      else if (fight.quiet > FIGHT_QUIET_END) why = 'stalemate';
      else if (fight.t > MAX_FIGHT_SECONDS) why = 'stalemate';
      else {
        const b = this.env.playerBody();
        if (b && !fight.playerIn && dist(b.x, b.z, fight.at.x, fight.at.z) > DISPERSE_RADIUS) why = 'dispersed';
      }
      if (why) this.endFight(fight, why);
    }
  }

  /** Courage rises and falls with the odds. */
  private updateMorale(fight: Fight): void {
    for (const side of fight.sides) {
      const mine = side.members.filter((m) => m.active).length;
      let theirs = 0;
      for (const o of fight.sides) if (o !== side) theirs += o.members.filter((m) => m.active).length;
      for (const f of side.members) {
        if (!f.active) continue;
        const hp = f.person ? f.person.health.hp : f.beastMax > 0 ? f.beastHp / f.beastMax : 1;
        const odds = mine - theirs;
        const target = f.moraleBase - 48 * Math.pow(1 - clamp(hp, 0, 1), 1.4) - (odds < 0 ? 5 * -odds : -1.5 * odds)
          - (f.person ? 14 * this.env.book.limbPenalty(f.personId, 'legs') : 0);
        // morale drifts to the level the situation deserves; blows and deaths push it down at once (see strike/markDead)
        f.morale += clamp(target - f.morale, -1.5, 1.2);
      }
    }
  }

  endFight(fight: Fight, why: string): void {
    if (fight.ended) return;
    fight.ended = true;
    const env = this.env;
    const state = env.ctx.state;
    const live = fight.sides.map((s) => s.members.filter((m) => m.active && !m.gone));
    let winnerSide = -1;
    if (why === 'won') winnerSide = live.findIndex((l) => l.length > 0);
    const result: FightResult = {
      id: fight.id, winner: winnerSide >= 0 ? fight.sides[winnerSide].faction : null,
      dead: [], wounded: [], captured: [], fled: [],
    };
    for (let si = 0; si < fight.sides.length; si++) {
      for (const f of fight.sides[si].members) {
        if (f.person) {
          const p = f.person;
          if (p.death) { result.dead.push(p.id); continue; }
          if (f.fled || f.gone) result.fled.push(p.id);
          else if (env.book.isHurt(p.id)) result.wounded.push(p.id);
          // the beaten noble who yielded (or was struck down) is taken for ransom
          if (winnerSide >= 0 && si !== winnerSide && (f.yielded || f.st === S.Down) && fight.yieldAllowed && p.rankTier >= 5 && !f.fled) {
            const captor = this.captorFor(f, live[winnerSide]);
            if (captor && captor.person) result.captured.push({ captive: p.id, captor: captor.personId });
          }
        } else if (f.beastHp <= 0) { /* beasts die in the dirt */ }
      }
    }
    for (const c of result.captured) {
      const captive = state.persons.get(c.captive);
      if (!captive) continue;
      captive.flags.captive = true;
      state.touch(captive);
      const ransom = ransomOf(captive);
      env.ctx.events.emit('captured', { captive: c.captive, captor: c.captor, ransom });
      state.log(this.absDay, 'captured', `${fullName(captive)} yielded and was taken for ransom.`, [c.captive, c.captor]);
    }
    // everyone goes back to their lives
    for (const side of fight.sides) for (const f of side.members) {
      f.fight = 0;
      if (f.isPlayer) { f.target = null; if (f.st !== S.Dead && f.st !== S.Down) this.toIdle(f); continue; }
      this.free(f);
      if (!f.isAnimal || f.st === S.Dead) { /* keep the fighter record until swept */ }
      f.gone = true;
    }
    env.fightEnded?.(fight, result);
    this.fights.delete(fight.id);
    this.lastResult = result;
    env.fightsChanged();
    env.ctx.events.emit('fightEnded', result);
    for (const fn of [...this.endListeners]) fn(result);
  }

  private captorFor(captive: Fighter, winners: readonly Fighter[]): Fighter | null {
    let best: Fighter | null = null;
    let bd = Infinity;
    for (const w of winners) {
      if (!w.person) continue;
      const d = Math.hypot(w.x - captive.x, w.z - captive.z);
      if (d < bd) { bd = d; best = w; }
    }
    return best;
  }

  /** Drops finished fighters from the list. */
  private sweep(): void {
    const list = this.fighters;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f.gone && f.fight === 0) { this.byKey.delete(f.key); if (f.isAnimal) this.beasts.delete(f.animalId); continue; }
      list[w++] = f;
    }
    list.length = w;
  }

  // ---------------------------------------------------------------------------------------------
  // Bodies: writing the fighters into the zone's agents and beasts
  // ---------------------------------------------------------------------------------------------

  private writeBodies(dt: number): void {
    const zone = this.env.zone;
    if (!zone) return;
    const list = this.fighters;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f.external || f.fight === 0 || f.gone) continue;
      if (f.person) {
        const a = zone.agent(f.personId);
        if (!a) continue;
        this.writeAgent(f, a, dt);
      } else {
        const an = this.beasts.get(f.animalId);
        if (an) this.writeBeast(f, an, dt);
      }
    }
  }

  private writeAgent(f: Fighter, a: ZoneAgent, dt: number): void {
    const b = a as unknown as ZoneAgent & BodyExtras;
    a.x = f.x; a.z = f.z; a.y = f.y; a.yaw = f.yaw;
    a.speed = f.speed;
    a.activity = 'fight';
    b.dx = f.x - f.px; b.dz = f.z - f.pz; b.dy = 0;
    const d = a.draw;
    d.anim = f.anim;
    d.animTime = this.clipTime(f, dt);
    d.moveSpeed = f.st === S.Idle || f.st === S.Block || f.st === S.Recover || f.st === S.Draw || f.st === S.Aim ? f.speed : 0;
    const h = f.hands();
    d.mainHand = h.main; d.offHand = h.off;
    d.aimPitch = f.st === S.Aim || f.st === S.Draw || f.st === S.Shoot ? f.pitch : undefined;
    d.lookYaw = 0;
    d.highlight = 0;
    d.carry = 'none';
    d.back = f.gear.ranged && !f.rangedOut() ? 'quiver' : 'none';
  }

  private writeBeast(f: Fighter, an: ZoneAnimal, _dt: number): void {
    const b = an as unknown as BeastBody;
    b.x = f.x; b.z = f.z; b.y = f.y; b.yaw = f.yaw;
    b.dx = f.x - f.px; b.dz = f.z - f.pz; b.dy = 0;
    const d = an.draw;
    d.moveSpeed = f.speed;
    d.animTime = f.animT;
    switch (f.st) {
      case S.Dead: case S.Down: d.anim = 'dead'; break;
      case S.Windup: case S.Recover: d.anim = 'attack'; break;
      case S.Hit: case S.Stagger: d.anim = 'hit'; break;
      default: d.anim = f.speed > 4.5 ? 'run' : f.speed > 1.8 ? 'trot' : f.speed > 0.3 ? 'walk' : 'idle';
    }
    if (f.st === S.Windup) d.animTime = f.t;
  }

  /**
   * Clip time for the draw item. Looping combat clips start at a per-person phase (the animator adds
   * `(seed % 17) × 0.13` s and plays at a per-person tempo), so the clock is skewed to make the visible
   * blow land when the damage does.
   */
  clipTime(f: Fighter, _dt: number): number {
    if (f.st === S.Windup || f.st === S.Recover) {
      const { off, tempo } = loopPhase(f.key);
      const impactClip = f.attackKey === 'overhead' ? 0.5 : f.attackKey === 'thrust' ? 0.4 : 0.45;
      const windup = f.attack ? f.attack.windup * this.speedOf(f, true) : impactClip;
      const skew = impactClip / tempo - windup;
      const elapsed = f.st === S.Windup ? f.t : windup + f.t;
      return elapsed + skew - off / tempo;
    }
    if (f.anim === 'block') return f.animT - loopPhase(f.key).off / loopPhase(f.key).tempo;
    return f.animT;
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------

  anyFight(): boolean { return this.fights.size > 0; }

  fightNearPlayer(): boolean {
    for (const f of this.fights.values()) if (f.playerIn) return true;
    const b = this.env.playerBody();
    if (!b) return this.fights.size > 0;
    for (const f of this.fights.values()) if (dist(b.x, b.z, f.at.x, f.at.z) < 150) return true;
    return false;
  }

  /** Called when the player's character changes or the run ends. */
  reset(): void {
    for (const fight of [...this.fights.values()]) this.endFight(fight, 'dispersed');
    this.fighters.length = 0;
    this.byKey.clear();
    this.beasts.clear();
    this.player = null;
    this.corpses.length = 0;
    this.beastCorpses.length = 0;
    this.env.proj.clear();
  }
}

export function loopPhase(id: number): { off: number; tempo: number } {
  // the character layer's seed is hash3(id, 7919) & 0x7fffffff (assets/characters/layer.ts)
  const seed = hash3(id, 7919) & 0x7fffffff;
  return { off: (seed % 17) * 0.13, tempo: 0.94 + ((seed >>> 3) % 13) * 0.01 };
}

/** Ransom a captive's House can be made to pay: a year of a gentleman's income, by rank (pence). */
export function ransomOf(p: Person): number {
  return [0, 0, 0, 0, 120, 480, 2400, 9000, 24000][p.rankTier] ?? 480;
}

// Imported late: strike.ts needs the Arena type, the arena needs its functions.
import { arrowStrike } from './strike';
void angleDiff; void normAngle; void LOCATION_NAMES;
export type { AnimState, HeldItem, AnimalKind };
