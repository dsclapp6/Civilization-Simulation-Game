// A stand-in for the objectives module (src/sim/objectives): a short tutorial chain with real places from the run —
// the household head, the well, the family's strip, the bed — that advances from sim events, a couple of chores and
// goals, suggestions from the hour and the day, and a day summary. It exists so the HUD, the journal and the day card
// can be built, tested and photographed before the real module is merged, and for the UI gallery. Never used in a
// normal game: `?fakeobjectives=1` (app) or the gallery turn it on.
import type { ZoneApi } from '../../agents/types';
import { BUILDINGS } from '../../content/types';
import { isNight } from '../../core/time';
import type { WorldMarker } from '../../core/view';
import { isHolyDay, isMarketDay } from '../../sim/calendar';
import type { Simulation } from '../../sim/sim';
import { fullName } from '../../sim/state';
import type { DaySummary, Objective, ObjectiveStep, ObjectivesApi, ObjectiveTarget, Suggestion } from '../../sim/objectives/types';

type Wanted = (sim: Simulation) => ObjectiveTarget | undefined;

export class MockObjectives implements ObjectivesApi {
  private objs: Objective[] = [];
  private seq = 1;
  private person = 0;
  private strips = 0;
  private readonly offs: Array<() => void> = [];
  private summary: DaySummary | null = null;
  private readonly day = { work: 0, earned: 0, skills: new Map<string, number>() };

  constructor(private readonly sim: Simulation, private readonly zone?: ZoneApi) {
    this.build();
    sim.view.setSource('worldMarkers', () => this.markers());
    const ev = sim.events;
    const me = (): number => sim.state.run.playerId;
    this.offs.push(
      ev.on('conversation', (e) => { if (e.phase === 'start' && e.actor === me()) this.step('first', 0); }),
      ev.on('action', (e) => {
        if (e.actor !== me() || e.type !== 'completed' || !e.outcome.ok) return;
        const id = e.option.id;
        if (/water|well|fetch/.test(id)) this.step('first', 1);
        if (e.option.category === 'work') {
          this.day.work++;
          if (e.option.target.kind === 'strip') this.progress('first', 2);
        }
      }),
      ev.on('skip', (e) => {
        if (e.phase !== 'end' || e.kind !== 'sleep') return;
        this.step('first', 3);
        this.closeDay();
      }),
    );
  }

  dispose(): void { for (const off of this.offs) off(); this.offs.length = 0; this.sim.view.setSource('worldMarkers', undefined); }

  // ---------------------------------------------------------------------------------------------

  private build(): void {
    const st = this.sim.state;
    const p = st.persons.get(st.run.playerId);
    const hh = p ? st.households.get(p.household) : undefined;
    const head = hh ? st.persons.get(hh.head) : undefined;
    this.person = head && head.id !== st.run.playerId ? head.id : hh?.members.find((m) => m !== st.run.playerId) ?? 0;
    const headName = this.person ? (st.persons.get(this.person) ? fullName(st.persons.get(this.person)!) : 'your family') : 'your family';
    const first = headName.split(' ')[0];
    const steps: ObjectiveStep[] = [
      { text: `Meet your family: speak to ${first}`, hint: 'Walk up to them and click, or press E. They are expecting you.', done: false, target: this.target('person') },
      { text: 'Fetch water from the well', hint: 'Stand at the well and press E, or click it.', done: false, target: this.target('well') },
      { text: 'Help on the family’s strip', hint: 'Walk onto the strip and click it: the work repeats until you walk away.', done: false, progress: 0, goal: 4, target: this.target('strip') },
      { text: 'Go home and sleep', hint: 'At your own door press E (or hold it) and choose Sleep until dawn.', done: false, target: this.target('home') },
    ];
    this.objs = [
      { id: this.seq++, source: 'tutorial', title: 'Your first day', giver: this.person || undefined, why: 'A household lives by everyone’s work. Learn how things are done here.', steps, reward: 'Your father’s thanks, and a little skill', state: 'active', tracked: true, dueDay: undefined },
      {
        id: this.seq++, source: 'chore', title: 'Gather firewood', giver: this.person || undefined, why: 'The hearth is low and the nights are cold.',
        steps: [{ text: 'Cut or gather 2 loads of firewood', hint: 'Click a tree or a pile of branches.', done: false, progress: 0, goal: 2 }, { text: 'Bring it home', done: false, target: this.target('home') }],
        reward: '2d and your mother’s thanks', state: 'active', tracked: false, dueDay: Math.floor(this.sim.absDay) + 1,
      },
      {
        id: this.seq++, source: 'goal', title: 'Join the archers at the butts', why: 'Archers are paid, and a good bowman is worth a lord’s notice.',
        steps: [{ text: 'Strength 8.9 of 10, Archery 1 of 3', hint: 'Work hard and practise at the butts on holy days.', done: false, progress: 1, goal: 3 }],
        reward: 'Opens the archers’ company', state: 'active', tracked: false,
      },
    ];
  }

  private target(kind: 'person' | 'well' | 'strip' | 'home'): ObjectiveTarget | undefined {
    const sim = this.sim, st = sim.state;
    const p = st.persons.get(st.run.playerId);
    const hh = p ? st.households.get(p.household) : undefined;
    const home = hh ? st.buildings.get(hh.home) : undefined;
    if (kind === 'person' && this.person) {
      const w = this.zone?.agent(this.person) ?? this.zone?.whereabouts(this.person);
      const per = st.persons.get(this.person);
      if (w && per) return { kind: 'person', id: this.person, x: w.x, z: w.z, label: fullName(per) };
    }
    if (kind === 'home' && home) return { kind: 'building', id: home.id, x: home.x, z: home.z, label: 'Your home' };
    if (kind === 'well' && home) {
      let best: { id: number; x: number; z: number } | null = null;
      let bd = Infinity;
      for (const b of st.buildingsAt.get(home.settlement) ?? []) {
        if (b.kind !== 'well') continue;
        const d = Math.hypot(b.x - home.x, b.z - home.z);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) return { kind: 'building', id: best.id, x: best.x, z: best.z, label: 'The well' };
      void BUILDINGS;
    }
    if (kind === 'strip' && hh) {
      for (const s of sim.world.strips) {
        if (st.strips.get(s.id)?.holder !== hh.id) continue;
        const cx = s.poly.reduce((a, q) => a + q.x, 0) / s.poly.length, cz = s.poly.reduce((a, q) => a + q.z, 0) / s.poly.length;
        this.strips = s.id;
        return { kind: 'strip', id: s.id, x: cx, z: cz, label: 'Your family’s strip' };
      }
    }
    return undefined;
  }

  private markers(): WorldMarker[] {
    const out: WorldMarker[] = [];
    const o = this.tracked();
    if (o) {
      const s = o.steps.find((x) => !x.done);
      let t = s?.target;
      if (t && t.kind === 'person') { const a = this.zone?.agent(t.id); if (a) t = { ...t, x: a.x, z: a.z }; }
      if (t) out.push({ id: o.id, kind: 'objective', x: t.x, z: t.z, y: t.kind === 'person' ? 2.4 : undefined, label: t.label, color: 0xf2c14e, primary: true });
    }
    const home = this.target('home');
    if (home) out.push({ id: 9001, kind: 'home', x: home.x, z: home.z, label: 'Home', color: 0x6fbf73 });
    return out;
  }

  private find(key: 'first'): Objective | undefined { return key === 'first' ? this.objs[0] : undefined; }

  private step(key: 'first', i: number): void {
    const o = this.find(key);
    const s = o?.steps[i];
    if (!o || !s || s.done || o.state !== 'active') return;
    // steps are done in order
    if (o.steps.slice(0, i).some((x) => !x.done)) return;
    s.done = true;
    this.after(o);
  }

  private progress(key: 'first', i: number): void {
    const o = this.find(key);
    const s = o?.steps[i];
    if (!o || !s || s.done || o.state !== 'active' || o.steps.slice(0, i).some((x) => !x.done)) return;
    s.progress = (s.progress ?? 0) + 1;
    if (s.goal !== undefined && s.progress >= s.goal) s.done = true;
    this.after(o, s.done ? undefined : 'progress');
  }

  private after(o: Objective, phase?: 'progress'): void {
    if (o.steps.every((x) => x.done)) { o.state = 'done'; this.sim.events.emit('objective', { phase: 'done', id: o.id, title: o.title }); }
    else this.sim.events.emit('objective', { phase: phase ?? 'progress', id: o.id, title: o.title });
    if (o.state === 'done' && o.tracked) { o.tracked = false; const next = this.objs.find((x) => x.state === 'active'); if (next) next.tracked = true; }
  }

  /** Dev/test: the player's day closes (as when they sleep): writes the summary and emits `dayEnd`. */
  endDay(): void { this.closeDay(); }

  private closeDay(): void {
    this.summary = {
      day: Math.floor(this.sim.absDay),
      work: this.day.work ? [`${this.day.work} bouts of work`] : [],
      earned: 6, spent: 2,
      goods: [{ label: 'sheaves of barley', amount: 12 }, { label: 'eggs', amount: 3 }],
      skills: [{ skill: 'Farming', xp: 42, level: 2 }, { skill: 'Woodcutting', xp: 9 }],
      stats: [{ stat: 'Strength', from: 8.6, to: 8.9 }],
      objectivesDone: this.objs.filter((o) => o.state === 'done').map((o) => o.title),
      household: ['The household is fed.', 'Firewood is running low.'],
      tomorrow: ['Market day at your village.', 'Your father wants the barley sown.'],
    };
    this.sim.events.emit('dayEnd', { day: this.summary.day });
    this.day.work = 0;
  }

  // ---------------------------------------------------------------------------------------------

  list(): readonly Objective[] { return this.objs; }
  tracked(): Objective | null { return this.objs.find((o) => o.tracked && o.state === 'active') ?? null; }
  track(id: number): void { for (const o of this.objs) o.tracked = o.id === id && o.state === 'active'; }

  suggestions(limit = 4): Suggestion[] {
    const out: Suggestion[] = [];
    const o = this.tracked();
    const s = o?.steps.find((x) => !x.done);
    if (o && s) out.push({ text: s.text, target: s.target, objective: o.id });
    const day = this.sim.absDay;
    const home = this.target('home');
    if (isNight(day) && home) out.push({ text: 'Go home: it is getting dark', target: home });
    const st = this.sim.state;
    const settlement = st.persons.get(st.run.playerId)?.settlement ?? 0;
    if (isHolyDay(day)) out.push({ text: 'It is a holy day: hear Mass at the church, then try the butts' });
    else if (isMarketDay(day, settlement)) out.push({ text: 'It is market day: sell what you can spare at the stalls' });
    for (const other of this.objs) if (other !== o && other.state === 'active') out.push({ text: other.title, objective: other.id, target: other.steps.find((x) => !x.done)?.target });
    return out.slice(0, limit);
  }

  daySummary(day?: number): DaySummary | null {
    return this.summary && (day === undefined || day === this.summary.day) ? this.summary : null;
  }

  trackPerson(person: number): void {
    this.person = person || this.person;
  }

  /** Dev/test: finish the next step of the first-day chain. */
  advance(): void {
    const o = this.objs[0];
    const i = o.steps.findIndex((s) => !s.done);
    if (i < 0) return;
    if (o.steps[i].goal) { o.steps[i].progress = o.steps[i].goal; }
    o.steps[i].done = true;
    this.after(o);
  }
}
