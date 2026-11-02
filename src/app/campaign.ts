// Riding with the host (the ruler's seat: "Plan an attack"; or the scenario "The march on the castle"). While the player
// is one of the men of an army ordered against a place:
//   on the march — the days pass on the road (a wait that ends at nightfall or at the walls); the player goes with the host;
//   at nightfall short of the enemy — the host halts and makes camp: tents, fires, the men sitting round them, the player
//     among them; sleep (Z) or wait, and at first light the camp is struck and the march goes on;
//   before the walls — by day the storm goes in at once; by night the host camps before the walls and storms at dawn. The
//     player stands in the line before the gate when it begins (the military module's battle is fought round him), and
//     the battle command (the red button, src/ui/panels/battle.ts) sets the companies to their tasks.
// Saved in state.ext['campaign'].
import type { ZoneApi } from '../agents/types';
import { BUILDINGS } from '../content/types';
import type { WorldPropView } from '../core/view';
import { militaryContext } from '../sim/military';
import type { MilitaryRuntime } from '../sim/military/types';
import type { Simulation } from '../sim/sim';
import { NONE, fullName, type BuildingState, type PersonId } from '../sim/state';
import type { PlayerApi } from '../player/types';

export const CAMPAIGN_KEY = 'campaign';

export type CampaignPhase = 'march' | 'camp' | 'before' | 'storm' | 'done';

interface CampaignSave {
  v: 1;
  army: number;
  target: number;
  phase: CampaignPhase;
  /** The camp: its centre, its tents (temporary buildings) and fires. */
  camp?: { x: number; z: number; tents: number[]; fires: Array<{ x: number; z: number }> };
  /** The day the storm went in (to tell when it is over). */
  stormDay?: number;
}

const NIGHT_FROM = 19.5, DAWN = 5.5;

export class CampaignMode {
  private sitting: PersonId[] = [];
  private shooters: Array<{ id: PersonId; anim: 'shoot_bow' | 'work_lift' }> = [];
  private reissue = 0;
  private propVer = 0;
  private readonly props: WorldPropView[] = [];

  constructor(private readonly sim: Simulation, private readonly zone: ZoneApi, private readonly player: PlayerApi) {
    // camp fires join the world's props (the economy's feed stays as it was)
    const view = this.sim.view as unknown as { sources: { worldProps?: () => readonly WorldPropView[]; worldPropsVersion?: () => number } };
    const prevList = view.sources.worldProps, prevVer = view.sources.worldPropsVersion;
    this.sim.view.setSource('worldProps', () => {
      const base = prevList ? prevList() : [];
      return this.props.length ? [...base, ...this.props] : base;
    });
    this.sim.view.setSource('worldPropsVersion', () => (prevVer ? prevVer() : 0) * 1000 + this.propVer);
    this.rebuildProps();
  }

  private save(): CampaignSave | null { return (this.sim.state.ext[CAMPAIGN_KEY] as CampaignSave | undefined) ?? null; }
  private mil(): MilitaryRuntime | undefined { return this.sim.services.military as MilitaryRuntime | undefined; }
  get phase(): CampaignPhase | null { const s = this.save(); return s && s.phase !== 'done' ? s.phase : null; }
  get army(): number { return this.save()?.army ?? 0; }
  get target(): number { return this.save()?.target ?? -1; }

  /** The player rides with this army against this place (it has its orders already). */
  begin(army: number, target: number): void {
    this.sim.state.ext[CAMPAIGN_KEY] = { v: 1, army, target, phase: 'march' } satisfies CampaignSave;
    this.sim.state.touchExt(CAMPAIGN_KEY);
    const where = this.sim.world.settlements[target]?.name ?? 'the enemy';
    this.say(`The host marches on ${where}. The days pass on the road; if night falls first, we make camp.`);
    this.marchOn();
  }

  private say(text: string, kind: 'info' | 'danger' | 'gain' | 'warn' = 'info'): void {
    this.sim.events.emit('notify', { kind, text, person: this.sim.state.run.playerId });
  }

  private hour(): number { return (this.sim.absDay % 1) * 24; }
  private night(): boolean { const h = this.hour(); return h >= NIGHT_FROM || h < DAWN; }

  /** The host on the road: the time passes until nightfall or the walls. */
  private marchOn(): void {
    const s = this.save();
    if (!s) return;
    const M = militaryContext(this.sim);
    const reached = (): boolean => {
      const a = M.army(s.army);
      if (!a) return true;
      const t = this.sim.world.settlements[s.target];
      // arrived: at the walls (besieging, fighting) or close by; still mustering is not arriving
      return a.task === 'siege' || a.task === 'battle' || (!!t && Math.hypot(a.x - t.x, a.z - t.z) < 160);
    };
    if (reached()) { this.arrive(); return; }
    // the hours pass on the road until nightfall or about when the walls come in sight, whichever is first (a set time:
    // the clock always stops at one, where a test is looked at only between the hours' work); then we look again
    const now = this.sim.absDay;
    const day = Math.floor(now);
    const nightfall = (now % 1) * 24 < NIGHT_FROM ? day + NIGHT_FROM / 24 : day + 1 + NIGHT_FROM / 24;
    const a = M.army(s.army);
    const t = this.sim.world.settlements[s.target];
    const left = a && t ? Math.max(0, Math.hypot(a.x - t.x, a.z - t.z) - 150) : 0;
    const eta = now + Math.max(1 / 24, left / 700);
    this.sim.dispatch({ type: 'waitUntil', until: { at: Math.min(nightfall, eta), label: 'On the march…' } });
  }

  /** Every frame: follow the host, camp at night, strike camp at dawn, storm before the walls. */
  update(dt: number): void {
    const s = this.save();
    if (!s || s.phase === 'done') return;
    const M = militaryContext(this.sim);
    const a = M.army(s.army);
    const pid = this.sim.state.run.playerId;
    if (!a || !a.men.includes(pid)) { this.end(a ? 'You have left the host.' : 'The host is no more.'); return; }
    if (this.sim.clock.skip) return;
    this.reissue -= dt;
    switch (s.phase) {
      case 'march': {
        const t = this.sim.world.settlements[s.target];
        const near = !!t && Math.hypot(a.x - t.x, a.z - t.z) < 160;
        if (a.task === 'siege' || a.task === 'battle' || near) { this.arrive(); return; }
        // night on the road: camp; within sight of the walls the camp is before them, and the storm goes in at dawn
        if (this.night()) { this.makeCamp(a.x, a.z, !!t && Math.hypot(a.x - t.x, a.z - t.z) < 800); return; }
        this.marchOn();
        return;
      }
      case 'camp': case 'before':
        if (!this.night()) { this.strikeCamp(); return; }
        if (this.reissue <= 0) { this.reissue = 20; for (const id of this.sitting) this.zone.command(id, { kind: 'perform', anim: 'sit', seconds: 30 }); }
        return;
      case 'storm': {
        const battle = this.mil()?.battles().find((b) => b.playerPresent);
        if (!battle && this.sim.absDay - (s.stormDay ?? 0) > 0.02) {
          const fallen = this.mil()?.siegeAt(s.target) === null && M.realm.holderOf(s.target) === a.house;
          this.end(fallen ? `${this.sim.world.settlements[s.target]?.name} is ours!` : 'The storm is over.');
          return;
        }
        if (this.reissue <= 0) {
          this.reissue = 2.5;
          for (const sh of this.shooters) this.zone.command(sh.id, { kind: 'perform', anim: sh.anim, mainHand: sh.anim === 'shoot_bow' ? 'longbow' : 'none', seconds: 3 });
        }
        return;
      }
    }
  }

  /** At the walls: storm now by day, or camp before them and storm at dawn. */
  private arrive(): void {
    const s = this.save();
    if (!s) return;
    const M = militaryContext(this.sim);
    const a = M.army(s.army);
    if (!a) return;
    if (this.night()) { this.makeCamp(a.x, a.z, true); return; }
    this.storm();
  }

  private storm(): void {
    const s = this.save();
    if (!s) return;
    const M = militaryContext(this.sim);
    const a = M.army(s.army);
    const t = this.sim.world.settlements[s.target];
    if (!a || !t) return;
    // the line forms before the gate (or before the walls, on the side the host came from)
    const gate = (this.sim.state.buildingsAt.get(t.id) ?? []).find((b) => b.kind === 'gatehouse');
    const from = gate ?? { x: t.x, z: t.z };
    let dx = a.x - from.x, dz = a.z - from.z;
    if (Math.hypot(dx, dz) < 1) { dx = 0; dz = 1; }
    const d = Math.hypot(dx, dz);
    // the host draws up a bowshot before the gate
    a.x = from.x + (dx / d) * 120; a.z = from.z + (dz / d) * 120; a.px = a.x; a.pz = a.z;
    const at = { x: from.x + (dx / d) * 30, z: from.z + (dz / d) * 30 };
    this.player.placeAt(at.x, at.z, Math.atan2(-dx, -dz));
    s.phase = 'storm';
    s.stormDay = this.sim.absDay;
    this.sim.state.touchExt(CAMPAIGN_KEY);
    const r = this.mil()?.stormNow?.(s.army);
    if (!r?.ok) { this.end(`The storm could not go in: ${r?.reason ?? ''}`); return; }
    this.say(`The trumpets sound: the host goes against the walls of ${t.name}! (The battle button, bottom right, commands the companies.)`, 'danger');
    this.placeCompanies(a.men, from, dx / d, dz / d);
  }

  /** The archers in a line loosing at the walls, the ram crew at the gate: seen working while the storm goes on. */
  private placeCompanies(men: readonly PersonId[], gate: { x: number; z: number }, ux: number, uz: number): void {
    const plan = this.mil()?.assaultPlan?.(this.army)?.plan;
    // men already in the fight before the gate stay in it
    const combat = this.sim.services.combat as unknown as { isFighting?(p: PersonId): boolean } | undefined;
    const busy = { has: (id: PersonId): boolean => !!combat?.isFighting?.(id) };
    const st = this.sim.state;
    const archers = men.filter((id) => { const p = st.persons.get(id); return p && (p.career === 'archer') && !busy.has(id); }).slice(0, 10);
    const ram = men.filter((id) => { const p = st.persons.get(id); return p && (p.career === 'man_at_arms' || p.career === 'soldier'); }).slice(-8);
    const looseOn = plan?.companies.some((c) => c.task === 'loose') ?? true;
    const ramOn = plan?.companies.some((c) => c.task === 'ram') ?? true;
    this.shooters = [];
    const px = -uz, pz = ux; // along the line
    if (looseOn) archers.forEach((id, i) => {
      const off = (i - archers.length / 2) * 2.2;
      const x = gate.x + ux * 60 + px * off, z = gate.z + uz * 60 + pz * off;
      this.zone.summon?.(id, x, z, Math.atan2(-ux, -uz));
      this.shooters.push({ id, anim: 'shoot_bow' });
    });
    if (ramOn) ram.forEach((id, i) => {
      const x = gate.x + ux * (4 + (i % 2) * 1.2) + px * ((i >> 1) - 1.5) * 1.1, z = gate.z + uz * (4 + (i % 2) * 1.2) + pz * ((i >> 1) - 1.5) * 1.1;
      this.zone.summon?.(id, x, z, Math.atan2(-ux, -uz));
      this.shooters.push({ id, anim: 'work_lift' });
    });
  }

  // ---- the camp ----

  private makeCamp(x: number, z: number, beforeWalls: boolean): void {
    const s = this.save();
    if (!s) return;
    const st = this.sim.state;
    this.mil()?.order(s.army, { kind: 'hold' });
    const near = this.sim.world.nearestSettlement(x, z);
    const tents: number[] = [];
    const fires: Array<{ x: number; z: number }> = [];
    // a ring of tents round three fires, the commander's tent at the head
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2;
      const r = i === 0 ? 0 : 15 + (i % 2) * 4;
      const tx = x + Math.cos(ang) * r, tz = z + Math.sin(ang) * r;
      if (i === 0) continue; // the middle stays open for the fires
      const id = st.nextBuildingId++;
      const b: BuildingState = {
        id, plot: -1, kind: 'tent', level: 1, settlement: near.id, construction: 1, damage: 0, onFire: false, owner: NONE, household: NONE,
        occupied: false, x: tx, z: tz, rot: -ang + Math.PI / 2, culture: near.culture, seed: id,
      };
      st.buildings.set(id, b);
      (st.buildingsAt.get(near.id) ?? st.buildingsAt.set(near.id, []).get(near.id)!).push(b);
      st.touchBuilding(b);
      tents.push(id);
    }
    for (let i = 0; i < 3; i++) { const ang = (i / 3) * Math.PI * 2 + 0.5; fires.push({ x: x + Math.cos(ang) * 6, z: z + Math.sin(ang) * 6 }); }
    s.camp = { x, z, tents, fires };
    s.phase = beforeWalls ? 'before' : 'camp';
    this.sim.state.touchExt(CAMPAIGN_KEY);
    this.rebuildProps();
    // the men round the fires; the player among them by the first fire
    const a = militaryContext(this.sim).army(s.army);
    const pid = st.run.playerId;
    this.sitting = (a?.men ?? []).filter((id) => id !== pid).slice(0, 24);
    this.sitting.forEach((id, i) => {
      const f = fires[i % fires.length];
      const ang = (i / Math.ceil(this.sitting.length / fires.length)) * Math.PI * 2 + i;
      const sx = f.x + Math.cos(ang) * 2.4, sz = f.z + Math.sin(ang) * 2.4;
      this.zone.summon?.(id, sx, sz, Math.atan2(f.x - sx, f.z - sz));
      this.zone.command(id, { kind: 'perform', anim: 'sit', seconds: 30 });
    });
    const f0 = fires[0];
    this.player.placeAt(f0.x + 3, f0.z, -Math.PI / 2);
    const t = this.sim.world.settlements[s.target];
    this.say(beforeWalls
      ? `Night has fallen before the walls of ${t?.name ?? 'the enemy'}. The host camps out of bowshot; we storm at first light. Sleep (Z) to wait for the dawn; the battle button (bottom right) sets the companies.`
      : `Night falls before we reach ${t?.name ?? 'the enemy'}: the host makes camp. Sleep (Z) and at first light we march on.`, 'info');
  }

  private strikeCamp(): void {
    const s = this.save();
    if (!s) return;
    this.clearCamp();
    const before = s.phase === 'before';
    if (before) { this.say('First light. To arms!', 'danger'); this.storm(); return; }
    s.phase = 'march';
    this.sim.state.touchExt(CAMPAIGN_KEY);
    this.mil()?.order(s.army, { kind: 'attack', settlement: s.target });
    this.say('First light: the camp is struck and the host marches on.');
    this.marchOn();
  }

  private clearCamp(): void {
    const s = this.save();
    const st = this.sim.state;
    for (const id of this.sitting) this.zone.dismiss?.(id);
    this.sitting = [];
    if (s?.camp) {
      for (const id of s.camp.tents) {
        const b = st.buildings.get(id);
        if (!b) continue;
        st.buildings.delete(id);
        const list = st.buildingsAt.get(b.settlement);
        if (list) { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); }
        st.touchBuilding(b);
      }
      s.camp = undefined;
      this.sim.state.touchExt(CAMPAIGN_KEY);
    }
    this.rebuildProps();
  }

  private rebuildProps(): void {
    this.props.length = 0;
    const c = this.save()?.camp;
    if (c) c.fires.forEach((f, i) => this.props.push({ id: 8_800_000 + i, kind: 'campfire', x: f.x, z: f.z, rot: 0, scale: 1.2 }));
    this.propVer++;
  }

  private end(text: string): void {
    const s = this.save();
    if (!s) return;
    this.clearCamp();
    for (const sh of this.shooters) this.zone.dismiss?.(sh.id);
    this.shooters = [];
    s.phase = 'done';
    this.sim.state.touchExt(CAMPAIGN_KEY);
    this.say(text, 'gain');
  }

  /** Sound the retreat (the battle command's button): the host breaks off and turns for home; you fall back with it. */
  retreat(): { ok: boolean; reason?: string } {
    const s = this.save();
    if (!s || s.phase === 'done') return { ok: false, reason: 'There is no host in the field' };
    const M = militaryContext(this.sim);
    const a = M.army(s.army);
    const t = this.sim.world.settlements[s.target];
    const r = this.mil()?.retreat?.(s.army) ?? { ok: false, reason: 'No such army' };
    if (!r.ok) return r;
    // in the storm you fall back with the rearguard, out of bowshot
    if (s.phase === 'storm' && t) {
      const me = this.player.body() ?? { x: a?.x ?? t.x, z: a?.z ?? t.z };
      const dx = me.x - t.x, dz = me.z - t.z, d = Math.hypot(dx, dz) || 1;
      this.player.placeAt(t.x + (dx / d) * (d + 160), t.z + (dz / d) * (d + 160), Math.atan2(dx, dz));
    }
    void a;
    this.end(s.phase === 'march' ? 'The host turns back for home.' : 'We fall back from the walls. Another day.');
    return { ok: true };
  }

  /** "Storm now": before the walls in daylight the commander need not wait (the battle command's button). */
  stormEarly(): { ok: boolean; reason?: string } {
    const s = this.save();
    if (!s || (s.phase !== 'before' && s.phase !== 'march')) return { ok: false, reason: 'We are not before the walls' };
    if (this.night()) return { ok: false, reason: 'Not in the dark: at first light' };
    const M = militaryContext(this.sim);
    const a = M.army(s.army);
    const t = this.sim.world.settlements[s.target];
    if (!a || !t || Math.hypot(a.x - t.x, a.z - t.z) > 600) return { ok: false, reason: 'We are not yet before the walls' };
    this.clearCamp();
    this.storm();
    return { ok: true };
  }

  /** Who the player is with, for the HUD. */
  describe(): string {
    const s = this.save();
    if (!s || s.phase === 'done') return '';
    const me = this.sim.state.persons.get(this.sim.state.run.playerId);
    return `${me ? fullName(me) : ''}, with the host against ${this.sim.world.settlements[s.target]?.name ?? ''}`;
  }

  /** For the camp's look: a tent is a building of the world while it stands. */
  static isTent(kind: string): boolean { return kind === 'tent' && !!BUILDINGS.tent; }
}

export interface PlanAttackOptions {
  /** Who the player rides as (one of the lord's knights: "Fight as him"); default the player as they are. */
  rideAs?: PersonId;
  /** Fresh men to bring the host up to strength (the scenario). */
  reinforce?: Partial<Record<import('../sim/military/types').UnitKind, number>>;
  /** Men to put into the place's garrison (the scenario). */
  garrison?: Partial<Record<import('../sim/military/types').UnitKind, number>>;
  /** Start the host this far (m) from the place along the road from home, rather than at home (the scenario). */
  startAt?: number;
  /** Bring the host up to this many men, and the place's defenders up to that many (the scenario: 250 against 300). */
  armyTo?: number;
  defendersTo?: number;
  /** Ride as one of the knights of the host (the scenario: you start as a knight among the men). */
  asKnight?: boolean;
  /** The defenders stay behind their walls (no field army of their own): the scenario's siege, 300 within. */
  holdDefenders?: boolean;
}

/** A mix of fresh men making up `n`: mostly levy spearmen, a quarter bowmen, men-at-arms, a few sergeants and knights. */
function mixOf(n: number): Partial<Record<import('../sim/military/types').UnitKind, number>> {
  if (n <= 0) return {};
  const archer = Math.round(n * 0.25), man_at_arms = Math.round(n * 0.2), sergeant = Math.round(n * 0.04), knight = Math.max(1, Math.round(n * 0.02));
  return { archer, man_at_arms, sergeant, knight, levy: Math.max(0, n - archer - man_at_arms - sergeant - knight) };
}

/**
 * The lord raises his host against a place, the player rides with it, and the campaign begins: the same step whether it
 * is planned from the ruler's seat or set up by the scenario.
 */
export function planAttack(sim: Simulation, camp: CampaignMode, lord: PersonId, target: number, opts: PlanAttackOptions = {}): { ok: boolean; reason?: string; army?: number } {
  const mil = sim.services.military as MilitaryRuntime | undefined;
  if (!mil) return { ok: false, reason: 'There is no war in this world' };
  const M = militaryContext(sim);
  const lp = sim.state.persons.get(lord);
  const t = sim.world.settlements[target];
  if (!lp || !t) return { ok: false, reason: 'No such place' };
  const theirs = M.realm.holderOf(target);
  if (!theirs || theirs === lp.house) return { ok: false, reason: `${t.name} is your own` };
  if (camp.phase) return { ok: false, reason: 'A campaign is already under way' };
  const armyId = mil.raiseArmy(lp.house, 'war', { vassals: true, commander: lord });
  if (!armyId) return { ok: false, reason: 'There are not enough men to raise' };
  const a = M.army(armyId)!;
  a.readyDay = sim.absDay; // the host marches at once
  a.objective = target;
  if (opts.reinforce) mil.reinforce?.(armyId, opts.reinforce);
  if (opts.garrison) mil.garrison?.(target, opts.garrison);
  if (opts.armyTo) mil.reinforce?.(armyId, mixOf(opts.armyTo - a.men.length));
  if (opts.defendersTo) {
    const have = mil.assaultPlan?.(armyId)?.defenders ?? 0;
    mil.garrison?.(target, mixOf(opts.defendersTo - have));
  }
  a.plan = undefined; // the plan is made from the host as it now stands
  a.supplies = Math.max(a.supplies, a.men.length * 30);
  a.morale = Math.max(a.morale, 0.8);
  if (opts.startAt) {
    const home = sim.world.settlements[a.home] ?? sim.world.nearestSettlement(a.x, a.z);
    const dx = home.x - t.x, dz = home.z - t.z, d = Math.hypot(dx, dz) || 1;
    a.x = t.x + (dx / d) * opts.startAt; a.z = t.z + (dz / d) * opts.startAt; a.px = a.x; a.pz = a.z;
  }
  mil.declareFeud(lp.house, theirs, 30, 'attack');
  if (opts.holdDefenders) { M.data.think[`d${theirs}`] = sim.absDay + 9999; M.data.think[`r${theirs}`] = sim.absDay + 9999; }
  const ordered = mil.order(armyId, { kind: 'attack', settlement: target });
  if (!ordered.ok) return { ok: false, reason: ordered.reason };
  // the player among the men: as one of the lord's knights, or as themselves
  let rider = opts.rideAs ?? sim.state.run.playerId;
  if (opts.asKnight) {
    const knight = mil.roster(armyId).find((r) => r.kind === 'knight' && r.person !== lord && r.person !== a.commander);
    if (knight) rider = knight.person;
  }
  if (rider !== sim.state.run.playerId) {
    const r = sim.dispatch({ type: 'fightAs', personId: rider });
    if (!r.ok) return { ok: false, reason: r.reason };
  }
  if (!a.men.includes(rider)) {
    const j = mil.joinArmy(armyId, rider);
    if (!j.ok && !a.men.includes(rider)) return { ok: false, reason: j.reason };
  }
  camp.begin(armyId, target);
  return { ok: true, army: armyId };
}
