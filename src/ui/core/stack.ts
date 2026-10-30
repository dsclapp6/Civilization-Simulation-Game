// Panel stack logic, free of DOM so it can be tested: which panels are open, which one Esc closes,
// whether input is captured, whether the world should be paused.

export type EscapePolicy = 'close' | 'ignore';

export interface StackPanel {
  /** Unique among open panels; opening an id that is already open replaces it. */
  readonly id: string;
  /** Panels of the same group replace each other (the main browse panels: character, inventory…). */
  readonly group?: string;
  /** While open, the input layer must not move the player or the camera. */
  readonly captures: boolean;
  /** 'menu': the world pauses while open if the player's setting allows; 'always': it always does. */
  readonly pauses: 'never' | 'menu' | 'always';
  /** 'ignore': Esc does nothing (death screen, birth reveal) — the panel has its own buttons. */
  readonly escape: EscapePolicy;
}

export interface StackHooks<P> {
  onShow?(panel: P): void;
  onHide?(panel: P): void;
  onChange?(): void;
}

export type EscapeResult = 'closed' | 'blocked' | 'empty';

export class PanelStack<P extends StackPanel> {
  private items: P[] = [];

  constructor(private readonly hooks: StackHooks<P> = {}) {}

  /** Opens a panel on top. Returns the panels it replaced (same id or same group). */
  open(panel: P): P[] {
    const replaced: P[] = [];
    this.items = this.items.filter((p) => {
      const clash = p.id === panel.id || (panel.group !== undefined && p.group === panel.group);
      if (clash) replaced.push(p);
      return !clash;
    });
    for (const p of replaced) this.hooks.onHide?.(p);
    this.items.push(panel);
    this.hooks.onShow?.(panel);
    this.hooks.onChange?.();
    return replaced;
  }

  close(id: string): P | null {
    const i = this.items.findIndex((p) => p.id === id);
    if (i < 0) return null;
    const [p] = this.items.splice(i, 1);
    this.hooks.onHide?.(p);
    this.hooks.onChange?.();
    return p;
  }

  /** Esc: closes the top panel unless it ignores Esc. */
  escape(): EscapeResult {
    const top = this.top();
    if (!top) return 'empty';
    if (top.escape === 'ignore') return 'blocked';
    this.close(top.id);
    return 'closed';
  }

  clear(): void {
    const all = this.items;
    this.items = [];
    for (let i = all.length - 1; i >= 0; i--) this.hooks.onHide?.(all[i]);
    if (all.length) this.hooks.onChange?.();
  }

  top(): P | null { return this.items.length ? this.items[this.items.length - 1] : null; }
  has(id: string): boolean { return this.items.some((p) => p.id === id); }
  get(id: string): P | undefined { return this.items.find((p) => p.id === id); }
  all(): readonly P[] { return this.items; }
  get size(): number { return this.items.length; }

  /** True while any open panel blocks game input. */
  captures(): boolean { return this.items.some((p) => p.captures); }

  /** True while an open panel wants the world paused (`menuPause` = the "pause in menus" setting). */
  wantsPause(menuPause: boolean): boolean {
    return this.items.some((p) => p.pauses === 'always' || (menuPause && p.pauses === 'menu'));
  }
}
