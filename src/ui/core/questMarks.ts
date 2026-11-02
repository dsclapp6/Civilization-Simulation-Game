// Quest marks in the HUD (docs/CIV.md §1), pure apart from reading the game: who has something for the player ("!") or can be
// handed a finished task ("?"), what they want, and where they are. The zone knows who is marked and where (`markedPeople`,
// in the zone or by their schedule, indoors or not); the objectives module says what each is about (`marks`). Either may be
// missing: the other fills in. The compass shows the ones within 150 m, the minimap dots them, the hover card and the journal
// say what they want.
import { fullName, type PersonId } from '../../sim/state';
import type { GameServices } from '../types';

/** The compass shows marks this near (m). */
export const COMPASS_RANGE = 150;

export type QuestKind = 'quest' | 'turnin';

export interface QuestRow {
  person: PersonId;
  name: string;
  kind: QuestKind;
  /** "Maire wants 7 bundles of firewood", "Hand the firewood to Maire". */
  text: string;
  x: number;
  z: number;
  /** Metres from the body (Infinity when the place is not known). */
  dist: number;
  /** They are an agent in the zone (drawn, with the mark over their head). */
  inZone: boolean;
  /** Not out in the open: the mark is not drawn over their head, but the compass and the minimap still show them. */
  indoors: boolean;
  /** The objective it belongs to (0 for a request the zone knows alone). */
  objective: number;
}

/** What to say when the objectives module has not said. */
export function defaultMarkText(name: string, kind: QuestKind): string {
  return kind === 'turnin' ? `Report to ${name}: your task can be handed in` : `${name} has something for you`;
}

/** The glyph and colour of a mark: a gold "!" for a task offered, a silver "?" for one to hand in. */
export const MARK_GLYPH: Record<QuestKind, string> = { quest: '!', turnin: '?' };
export const MARK_COLOR: Record<QuestKind, number> = { quest: 0xf2c14e, turnin: 0xd2d8de };

const TEXT_REFRESH = 0.5;

/** The marked people as rows, refreshed cheaply: positions every call, the words twice a second. The row objects are reused. */
export class QuestMarkView {
  readonly rows: QuestRow[] = [];
  private pool: QuestRow[] = [];
  private texts = new Map<PersonId, { text: string; objective: number; kind: QuestKind }>();
  private textsAt = -1e9;
  private names = new Map<PersonId, string>();
  private count = 0;

  /** `now` is any steady clock in seconds. Returns the same array every time. */
  update(game: GameServices, from: { x: number; z: number }, now: number): readonly QuestRow[] {
    if (now - this.textsAt >= TEXT_REFRESH || now < this.textsAt) this.refreshTexts(game, now);
    this.count = 0;
    const zone = game.zone;
    const persons = game.sim.state.persons;
    const put = (person: PersonId, kind: QuestKind, x: number, z: number, inZone: boolean, indoors: boolean): void => {
      const p = persons.get(person);
      if (!p || p.death) return;
      let r = this.pool[this.count];
      if (!r) { r = { person, name: '', kind, text: '', x: 0, z: 0, dist: Infinity, inZone: false, indoors: false, objective: 0 }; this.pool[this.count] = r; }
      this.count++;
      let name = this.names.get(person);
      if (name === undefined) { name = fullName(p); this.names.set(person, name); }
      const t = this.texts.get(person);
      r.person = person; r.name = name; r.kind = kind;
      r.text = t && t.kind === kind ? t.text : defaultMarkText(name, kind);
      r.objective = t ? t.objective : 0;
      r.x = x; r.z = z; r.inZone = inZone; r.indoors = indoors;
      r.dist = Number.isFinite(x) && Number.isFinite(z) ? Math.hypot(x - from.x, z - from.z) : Infinity;
    };
    let listed = false;
    if (zone.markedPeople) {
      try {
        for (const m of zone.markedPeople()) put(m.person, m.kind, m.x, m.z, m.inZone, m.indoors);
        listed = true;
      } catch { this.count = 0; }
    }
    if (!listed) {
      // a zone without markedPeople: the objectives module's marks, placed by the zone's agents and schedules
      for (const [person, t] of this.texts) {
        let x = NaN, z = NaN, inZone = false, indoors = false;
        try {
          const a = zone.agent(person);
          if (a) { x = a.x; z = a.z; inZone = true; } else { const w = zone.whereabouts(person); x = w.x; z = w.z; indoors = w.indoors; }
        } catch { /* unknown place */ }
        put(person, t.kind, x, z, inZone, indoors);
      }
    }
    this.rows.length = this.count;
    for (let i = 0; i < this.count; i++) this.rows[i] = this.pool[i];
    return this.rows;
  }

  rowFor(person: PersonId): QuestRow | undefined {
    for (let i = 0; i < this.count; i++) if (this.pool[i].person === person) return this.pool[i];
    return undefined;
  }

  /** The rows sorted by distance (a fresh array: for lists, not for the frame loop). */
  sorted(): QuestRow[] {
    return this.rows.map((r) => ({ ...r })).sort((a, b) => a.dist - b.dist || a.person - b.person);
  }

  private refreshTexts(game: GameServices, now: number): void {
    this.textsAt = now;
    this.texts.clear();
    try {
      for (const m of game.objectives?.marks?.() ?? []) {
        // a hand-in outranks a task (the zone does the same), so a person with both shows the "?" words
        const had = this.texts.get(m.person);
        if (had && had.kind === 'turnin' && m.kind === 'quest') continue;
        this.texts.set(m.person, { text: m.text, objective: m.objective, kind: m.kind });
      }
    } catch { /* the objectives are mid-change */ }
  }
}
