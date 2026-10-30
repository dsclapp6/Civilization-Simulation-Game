// Pausing the world while menus are open — only if the UI did the pausing. If the player had paused
// by hand (or the game paused itself, e.g. while choosing a successor) the UI neither takes over nor
// resumes it.

export interface PauseTarget {
  paused(): boolean;
  /** Returns false when refused. */
  pause(): boolean;
  resume(): boolean;
}

export class PauseController {
  private held = false;

  constructor(private readonly target: PauseTarget) {}

  /** Call whenever the wish changes (a panel opened/closed, the setting toggled). */
  sync(wantsPause: boolean): void {
    if (wantsPause && !this.held) {
      if (!this.target.paused() && this.target.pause()) this.held = true;
    } else if (!wantsPause && this.held) {
      this.held = false;
      if (this.target.paused()) this.target.resume();
    }
  }

  /** True while the UI is the one holding the pause. */
  get holding(): boolean { return this.held; }

  /** Drop ownership without resuming (the sim was replaced or the screen changed). */
  forget(): void { this.held = false; }
}
