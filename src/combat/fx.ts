// Visual side effects of fights: sparks, blood, dust and impacts queued for the renderer, and the lingering
// corpses and arrows. The renderer drains FX once per frame (`view.drainFx`), so the queue is bounded; other
// modules (military, advancement) may drain through the same view, so this module chains onto whatever
// source is already there instead of replacing it.
import type { AnimalDrawItem, CharacterDrawItem, FxEvent, ProjectileDrawItem, SimView } from '../core/view';

const MAX_FX = 160;

export class FxQueue {
  private readonly items: FxEvent[] = [];
  private readonly out: FxEvent[] = [];
  private pool: FxEvent[] = [];

  add(kind: FxEvent['kind'], x: number, y: number, z: number, intensity: number): void {
    if (this.items.length >= MAX_FX) this.items.shift();
    const e = this.pool.pop() ?? { kind, x, y, z, intensity };
    e.kind = kind; e.x = x; e.y = y; e.z = z; e.intensity = intensity;
    this.items.push(e);
  }

  /** Everything queued since the last call (the array is reused). */
  drain(into: FxEvent[]): void {
    for (const e of this.items) into.push(e);
    this.pool.push(...this.items);
    this.items.length = 0;
    if (this.pool.length > 400) this.pool.length = 400;
  }

  get size(): number { return this.items.length; }
  list(): readonly FxEvent[] { return this.out; }
}

/**
 * Appends this module's draw items to a view method that may already be fed by another module. `SimViewImpl`
 * keeps one source per slot and does not expose the previous one, so the method itself is wrapped; wrapping
 * twice composes.
 */
export function chainCharacters(view: SimView, extra: () => readonly CharacterDrawItem[]): void {
  const prev = view.characters.bind(view);
  const merged: CharacterDrawItem[] = [];
  view.characters = (): readonly CharacterDrawItem[] => {
    const base = prev();
    const more = extra();
    if (more.length === 0) return base;
    merged.length = 0;
    for (let i = 0; i < base.length; i++) merged.push(base[i]);
    for (let i = 0; i < more.length; i++) merged.push(more[i]);
    return merged;
  };
}

export function chainFx(view: SimView, drain: (into: FxEvent[]) => void): void {
  const prev = view.drainFx.bind(view);
  const merged: FxEvent[] = [];
  view.drainFx = (): readonly FxEvent[] => {
    const base = prev();
    merged.length = 0;
    for (let i = 0; i < base.length; i++) merged.push(base[i]);
    drain(merged);
    return merged;
  };
}

export function chainProjectiles(view: SimView, extra: () => readonly ProjectileDrawItem[]): void {
  const prev = view.projectiles.bind(view);
  const merged: ProjectileDrawItem[] = [];
  view.projectiles = (): readonly ProjectileDrawItem[] => {
    const base = prev();
    const more = extra();
    if (base.length === 0) return more;
    merged.length = 0;
    for (let i = 0; i < base.length; i++) merged.push(base[i]);
    for (let i = 0; i < more.length; i++) merged.push(more[i]);
    return merged;
  };
}

export function chainAnimals(view: SimView, extra: () => readonly AnimalDrawItem[]): void {
  const prev = view.animals.bind(view);
  const merged: AnimalDrawItem[] = [];
  view.animals = (): readonly AnimalDrawItem[] => {
    const base = prev();
    const more = extra();
    if (more.length === 0) return base;
    merged.length = 0;
    for (let i = 0; i < base.length; i++) merged.push(base[i]);
    for (let i = 0; i < more.length; i++) merged.push(more[i]);
    return merged;
  };
}
