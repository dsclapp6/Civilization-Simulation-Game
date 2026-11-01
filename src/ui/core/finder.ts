// "Find" and "Show me": putting a person or a place on the compass, the minimap, the screen edge and (in the world)
// a beacon. The objectives module does this itself when it can (`trackPerson`, `trackPlace`, `found`: its markers
// follow the person about and show in 3D); without those members — an older module, a test double — the UI keeps a
// pin of its own (`PinStore`) for a place. Pure: no DOM.
import type { ObjectiveTarget } from '../../sim/objectives/types';
import type { GameServices } from '../types';
import type { PinStore } from './pins';

/** A place to point at. `kind`/`id` say what it is when the module knows (a building, a strip…); a bare spot is a `place`. */
export interface Spot { x: number; z: number; label: string; kind?: ObjectiveTarget['kind']; id?: number }

/** Stand this close to a found place (or person) and it has done its job. */
export const FOUND_ARRIVED = 7;

export function targetOf(s: Spot): ObjectiveTarget {
  return { kind: s.kind ?? 'place', id: s.id ?? -1, x: s.x, z: s.z, label: s.label };
}

/** Marks a place. Returns true when the objectives module took it (so a 3D beacon stands there too). */
export function showPlace(game: GameServices | null, pins: PinStore, spot: Spot): boolean {
  const api = game?.objectives;
  if (api?.trackPlace) {
    api.trackPlace(targetOf(spot));
    pins.set(null);
    return true;
  }
  pins.set({ x: spot.x, z: spot.z, label: spot.label });
  return false;
}

/** Marks a person ("Find" in the people list): the module's marker follows them wherever they go. */
export function showPerson(game: GameServices | null, pins: PinStore, id: number): void {
  game?.objectives?.trackPerson(id);
  pins.set(null);
}

/** Clears whatever "Find" and "Show me" were pointing at. */
export function stopFinding(game: GameServices | null, pins: PinStore): void {
  const api = game?.objectives;
  if (api) {
    api.trackPlace?.(null);
    if (api.found ? api.found().person : true) api.trackPerson(0);
  }
  pins.set(null);
}

export interface FindState {
  /** The person being looked for (0 for none). */
  person: number;
  /** The place being looked for, if any. */
  place: Spot | null;
}

/** What "Find" currently points at: the module's answer, else the UI's own pin. */
export function findState(game: GameServices | null, pins: PinStore): FindState {
  const api = game?.objectives;
  const f = api?.found?.();
  if (f) return { person: f.person, place: f.place ? { x: f.place.x, z: f.place.z, label: f.place.label, kind: f.place.kind, id: f.place.id } : null };
  const pin = pins.get();
  return { person: 0, place: pin ? { x: pin.x, z: pin.z, label: pin.label } : null };
}

/** Is this the place "Find" points at? (Same thing, or the same spot to within a few metres.) */
export function isFound(state: FindState, t: { x: number; z: number; kind?: ObjectiveTarget['kind']; id?: number }): boolean {
  const p = state.place;
  if (!p) return false;
  if (p.kind && t.kind && p.id !== undefined && p.id >= 0 && t.id !== undefined && t.id >= 0) return p.kind === t.kind && p.id === t.id;
  return Math.hypot(p.x - t.x, p.z - t.z) < 3;
}

/**
 * Called as the body moves: when it has reached what was found, clears the marker and says what to tell the player
 * ("You have arrived." / "You have found Wat."), else null.
 */
export function arrivedAt(game: GameServices, pins: PinStore, x: number, z: number): string | null {
  if (pins.arrive(x, z)) return 'You have arrived.';
  const api = game.objectives;
  const f = api?.found?.();
  if (!api || !f) return null;
  if (f.place && Math.hypot(f.place.x - x, f.place.z - z) <= FOUND_ARRIVED) {
    api.trackPlace?.(null);
    return 'You have arrived.';
  }
  if (f.person) {
    const a = game.zone.agent(f.person);
    if (a && Math.hypot(a.x - x, a.z - z) <= FOUND_ARRIVED - 2) {
      api.trackPerson(0);
      const p = game.sim.state.persons.get(f.person);
      return p ? `You have found ${p.first}.` : 'You have found them.';
    }
  }
  return null;
}
