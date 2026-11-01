// A place the player asked to be shown ("Find" in the journal's Places, "Show me" on a suggestion): a pin on the
// compass, the minimap and the screen edge until they get there or ask for another. Held by the UI itself; the
// people the objectives module tracks have beacons of their own.
export interface Pin {
  x: number;
  z: number;
  label: string;
  /** Pinned from the objectives module's suggestions, for the "What now?" card to tick off. */
  from?: string;
}

/** Stand this close and the pin has done its job. */
export const PIN_ARRIVED = 7;

export class PinStore {
  private current: Pin | null = null;
  private version = 0;

  get(): Pin | null { return this.current; }
  stamp(): number { return this.version; }

  set(pin: Pin | null): void {
    this.current = pin ? { ...pin } : null;
    this.version++;
  }

  /** Called with the player's position: clears the pin when they have arrived. Returns true when it did. */
  arrive(x: number, z: number): boolean {
    const p = this.current;
    if (!p || Math.hypot(p.x - x, p.z - z) > PIN_ARRIVED) return false;
    this.set(null);
    return true;
  }
}
