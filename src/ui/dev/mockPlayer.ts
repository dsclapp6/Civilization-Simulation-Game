// A fake player controller for the gallery. It registers a small ActionProvider on the real
// ActionRegistry (so timed actions, outcomes, gains and notify events flow through the real pipeline)
// and exposes scenario switches (prompt, travel, danger…) for the screenshots.
import type { InteractCandidate } from '../../agents/types';
import type { ZoneApi } from '../../agents/types';
import type { ActionOption, ActionProvider, TargetRef } from '../../sim/actions';
import type { PlayerApi, PlayerHud, Result, TravelState } from '../../player/types';
import type { SocialApi } from '../../sim/social/types';
import { gainSkill } from '../../sim/skills';
import type { Simulation } from '../../sim/sim';
import { ageYears, fullName, type PersonId } from '../../sim/state';

export type MockTarget = 'strip' | 'person' | 'building' | 'none';

export class MockPlayer implements PlayerApi {
  prompt: PlayerHud['prompt'] = { label: 'Reap', targetLabel: 'strip of barley', enabled: true };
  danger = false;
  hpFraction = 0.82;
  staminaFraction = 0.68;
  needs = { hunger: 0.62, rest: 0.78, warmth: 0.9, mood: 0.7 };
  targetKind: MockTarget = 'strip';
  /** Scripted encounter when a journey passes this progress (0 disables). */
  encounterAt = 0;
  private travelState: TravelState | null = null;
  private pos = { x: 0, y: 0, z: 0, yaw: 0 };
  private clockTick = 0;

  constructor(private readonly sim: Simulation, private readonly social: SocialApi, zone: ZoneApi) {
    void zone;
    const p = sim.state.persons.get(sim.state.run.playerId);
    const s = sim.world.settlements.find((x) => x.id === p?.settlement);
    if (s) { this.pos.x = s.x + 14; this.pos.z = s.z + 9; }
    sim.actions.register(this.provider());
  }

  private pid(): PersonId { return this.sim.state.run.playerId; }

  // ---------------------------------------------------------------- PlayerApi

  setInput(): void { /* the gallery has no movement */ }

  hud(): PlayerHud | null {
    const p = this.sim.state.persons.get(this.pid());
    if (!p) return null;
    const maxHp = Math.round(30 + p.trained.end * 4);
    const maxSta = Math.round(24 + p.trained.end * 3 + p.trained.str);
    const active = this.sim.actions.active(this.pid());
    return {
      personId: p.id, name: fullName(p), age: Math.floor(ageYears(p, this.sim.absDay)),
      hp: Math.round(maxHp * this.hpFraction), maxHp, stamina: Math.round(maxSta * this.staminaFraction), maxStamina: maxSta,
      hunger: this.needs.hunger, rest: this.needs.rest, warmth: this.needs.warmth, mood: this.needs.mood,
      money: p.money, carried: 11, capacity: 52, mounted: false,
      prompt: active ? this.prompt : this.targetKind === 'none' ? null : this.prompt,
      action: active ? { label: active.option.label, progress: active.progress, seconds: active.option.seconds } : null,
      travel: this.travelState, danger: this.danger,
    };
  }

  target(): InteractCandidate | null {
    if (this.targetKind === 'none') return null;
    const t = this.targetRef();
    return { target: t, x: this.pos.x, z: this.pos.z, distance: 2.1, label: this.targetLabel() };
  }

  private targetRef(): TargetRef {
    switch (this.targetKind) {
      case 'person': return { kind: 'person', id: this.headOfHousehold() };
      case 'building': return { kind: 'building', id: this.sim.state.households.get(this.sim.state.persons.get(this.pid())?.household ?? 0)?.home ?? 0 };
      default: return { kind: 'strip', id: this.sim.world.strips[0]?.id ?? 0 };
    }
  }

  private targetLabel(): string {
    switch (this.targetKind) {
      case 'person': return this.sim.state.persons.get(this.headOfHousehold())?.first ?? 'neighbour';
      case 'building': return 'Parish church';
      default: return 'Strip of barley';
    }
  }

  private headOfHousehold(): PersonId {
    const p = this.sim.state.persons.get(this.pid());
    const hh = p ? this.sim.state.households.get(p.household) : undefined;
    return hh && hh.head !== this.pid() ? hh.head : (p?.father || p?.mother || this.pid());
  }

  options(): ActionOption[] { return this.sim.actions.list(this.pid(), this.targetRef()); }

  perform(option: ActionOption): ReturnType<PlayerApi['perform']> { return this.sim.actions.start(this.pid(), option); }

  cancelAction(): void { this.sim.actions.cancel(this.pid()); }

  talkTo(person: PersonId): Result {
    const r = this.social.start(this.pid(), person);
    if ('lines' in r) { this.sim.events.emit('ui', { panel: 'dialogue', conversation: r.id }); return { ok: true }; }
    return r;
  }

  travelTo(settlement: number): Result {
    const p = this.sim.state.persons.get(this.pid());
    if (!p) return { ok: false, reason: 'No one to send.' };
    if (this.travelState && this.travelState.phase === 'travelling') return { ok: false, reason: 'You are already on the road.' };
    if (settlement === p.settlement) return { ok: false, reason: 'You are already there.' };
    const from = this.sim.world.settlements.find((s) => s.id === p.settlement);
    const to = this.sim.world.settlements.find((s) => s.id === settlement);
    if (!from || !to) return { ok: false, reason: 'You do not know the way.' };
    const dist = Math.hypot(from.x - to.x, from.z - to.z);
    this.travelState = { phase: 'travelling', from: from.id, to: to.id, route: [{ x: from.x, z: from.z }, { x: to.x, z: to.z }], progress: 0, daysLeft: dist / 2800 };
    this.sim.events.emit('travel', { phase: 'start', to: to.id });
    return { ok: true };
  }

  cancelTravel(): void {
    if (!this.travelState) return;
    this.travelState = null;
    this.sim.events.emit('travel', { phase: 'cancel', to: -1 });
  }

  travel(): TravelState | null { return this.travelState; }

  body(): { x: number; y: number; z: number; yaw: number } | null { return this.pos; }

  placeAt(x: number, z: number, yaw = 0): void { this.pos.x = x; this.pos.z = z; this.pos.yaw = yaw; }

  // ---------------------------------------------------------------- scenario control

  /** Puts the player mid-journey (for the travel HUD shot). */
  startJourney(to: number, progress: number, phase: TravelState['phase'] = 'travelling', encounter?: TravelState['encounter']): void {
    const p = this.sim.state.persons.get(this.pid());
    const from = p?.settlement ?? 0;
    const f = this.sim.world.settlements.find((s) => s.id === from);
    const t = this.sim.world.settlements.find((s) => s.id === to);
    this.travelState = {
      phase, from, to, route: f && t ? [{ x: f.x, z: f.z }, { x: t.x, z: t.z }] : [], progress, daysLeft: Math.max(0, (1 - progress) * 1.6), encounter,
    };
  }

  clearJourney(): void { this.travelState = null; }

  /** Per-frame animation: journeys advance, stamina breathes. */
  update(dt: number): void {
    this.clockTick += dt;
    const t = this.travelState;
    if (t && t.phase === 'travelling') {
      t.progress = Math.min(1, t.progress + dt * 0.06);
      t.daysLeft = Math.max(0, (1 - t.progress) * 1.6);
      if (this.encounterAt > 0 && t.progress >= this.encounterAt) {
        t.phase = 'encounter';
        t.encounter = { kind: 'bandits', label: 'A band of outlaws blocks the road', hostile: true };
        this.encounterAt = 0;
        this.sim.events.emit('travel', { phase: 'encounter', to: t.to, encounter: t.encounter.label });
      } else if (t.progress >= 1) {
        t.phase = 'arrived';
        this.sim.events.emit('travel', { phase: 'arrive', to: t.to });
        const p = this.sim.state.persons.get(this.pid());
        if (p) this.sim.state.setSettlement(p, t.to);
        window.setTimeout(() => { this.travelState = null; }, 1800);
      }
    }
  }

  // ---------------------------------------------------------------- the mock action provider

  private provider(): ActionProvider {
    const sim = this.sim;
    const social = this.social;
    const base = { range: 3, provider: '' } as const;
    return {
      id: 'mock',
      list: (_ctx, actor, target, out) => {
        const opt = (o: Omit<ActionOption, 'provider' | 'range' | 'target'> & Partial<Pick<ActionOption, 'range'>>): void => {
          out.push({ ...base, target, ...o });
        };
        if (target.kind === 'strip') {
          opt({ id: 'reap', label: 'Reap', category: 'work', enabled: true, seconds: 8, anim: 'work_sickle', mainHand: 'sickle', preview: '+3 sheaves · Farming', priority: 10, repeat: true });
          opt({ id: 'weed', label: 'Weed the strip', category: 'work', enabled: true, seconds: 5, anim: 'work_hoe', mainHand: 'hoe', preview: 'Better yield · Farming', priority: 6 });
          opt({ id: 'glean', label: 'Gather gleanings', category: 'work', enabled: false, reason: 'Needs a basket', seconds: 6, preview: '+1 bushel', priority: 4 });
          opt({ id: 'inspect', label: 'Inspect the crop', category: 'use', enabled: true, seconds: 0, preview: 'Reveals when it will ripen', priority: 2 });
          opt({ id: 'claim', label: 'Claim as your own', category: 'manage', enabled: false, reason: 'Not your strip', seconds: 0, priority: 1 });
        } else if (target.kind === 'person') {
          opt({ id: 'talk', label: 'Talk', category: 'talk', enabled: true, seconds: 0, priority: 10 });
          opt({ id: 'trade', label: 'Trade', category: 'trade', enabled: true, seconds: 0, preview: 'Buy, sell or barter', priority: 8 });
          opt({ id: 'help', label: 'Offer to help with their work', category: 'work', enabled: true, seconds: 6, preview: '+1d · Farming', priority: 6 });
          opt({ id: 'gift', label: 'Give a gift', category: 'social', enabled: true, seconds: 0, preview: 'They will remember it', priority: 4 });
          opt({ id: 'court', label: 'Pay court', category: 'social', enabled: false, reason: 'You are too young', seconds: 0, priority: 3 });
          opt({ id: 'duel', label: 'Challenge to a bout', category: 'combat', enabled: true, seconds: 0, preview: 'Wrestling, for sport', priority: 1 });
        } else if (target.kind === 'building') {
          opt({ id: 'enter', label: 'Go in', category: 'use', enabled: true, seconds: 0, priority: 10 });
          opt({ id: 'pray', label: 'Pray', category: 'rest', enabled: true, seconds: 6, anim: 'pray', preview: 'Mood up · Piety', priority: 8 });
          opt({ id: 'info', label: 'Look closer', category: 'learn', enabled: true, seconds: 0, priority: 6 });
          opt({ id: 'jobs', label: 'Ask about work here', category: 'work', enabled: true, seconds: 0, priority: 5 });
          opt({ id: 'rent', label: 'Ask to rent', category: 'manage', enabled: false, reason: 'Nothing to let', seconds: 0, priority: 1 });
        }
        void actor;
      },
      complete: (ctx, actor, option) => {
        const person = ctx.state.persons.get(actor);
        switch (option.id) {
          case 'reap':
            if (person) gainSkill(ctx, person, 'farming', 14);
            return { ok: true, message: 'You reap a quarter of the strip.', gains: [{ label: 'sheaves', amount: 3, ref: 'wheat' }, { label: 'Farming', amount: 14, ref: 'farming' }] };
          case 'weed':
            return { ok: true, message: 'The strip is cleaner for your labour.', gains: [{ label: 'Farming', amount: 6, ref: 'farming' }] };
          case 'inspect': return { ok: true, message: 'The barley will ripen in about two days.' };
          case 'talk': {
            const r = social.start(actor, option.target.kind === 'person' ? option.target.id : 0);
            return 'lines' in r ? { ok: true, ui: { panel: 'dialogue', conversation: r.id } } : { ok: false, message: r.reason };
          }
          case 'trade': return { ok: true, ui: { panel: 'trade', partner: { kind: 'person', id: option.target.kind === 'person' ? option.target.id : 0 } } };
          case 'help': return { ok: true, message: 'You lend a hand and earn a penny.', gains: [{ label: '', amount: 1, ref: 'money' }] };
          case 'gift': return { ok: true, message: 'They thank you warmly.' };
          case 'enter': case 'info': return { ok: true, ui: { panel: 'building', id: option.target.kind === 'building' ? option.target.id : 0 } };
          case 'jobs': return { ok: true, ui: { panel: 'jobs', settlement: person?.settlement ?? 0 } };
          case 'pray': return { ok: true, message: 'You feel a quiet comfort.', gains: [{ label: 'Mood', amount: 2 }] };
          default: return { ok: true };
        }
      },
    };
  }
}
