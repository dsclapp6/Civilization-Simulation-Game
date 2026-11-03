// "Fight as him" (CIV §6.5): while you play one of your knights in your lord's stead (`RunState.liege` set by the `fightAs` command),
// a ribbon at the top of the screen says whose place you have taken, with a button back to your lord; U does the same from the
// keyboard (the ruler's key: a knight rules nothing, so the key is free to mean "back to my lord"). The sim's `returnToLiege` does
// the switching; this file is the face of it. A HUD part and a hotkey (src/ui/core/extHud.ts) of its own.
import type { Simulation } from '../../sim/sim';
import { fullName } from '../../sim/state';
import { button } from '../components/widgets';
import { registerHotkey, registerHudPart, type HudPart, type HudPartCtx } from '../core/extHud';
import { h } from '../core/dom';
import { icon } from '../core/icons';

/** The lord the player would go back to, when they are playing a knight in his place (null otherwise). */
export function liegeOf(sim: Simulation): { id: number; name: string } | null {
  const run = sim.state.run;
  if (!run.liege) return null;
  const lord = sim.state.persons.get(run.liege);
  if (!lord || lord.death) return null;
  return { id: lord.id, name: fullName(lord) };
}

/** Back to the lord; false when there is no lord to go back to. */
export function returnToLiege(ctx: HudPartCtx): boolean {
  const game = ctx.game();
  if (!game || !liegeOf(game.sim)) return false;
  const r = game.sim.dispatch({ type: 'returnToLiege' });
  ctx.say(r.ok ? 'info' : 'warn', r.ok ? 'You are your own lord again.' : r.reason ?? 'You cannot go back now.');
  return r.ok;
}

export class LiegeBar implements HudPart {
  readonly el = h('div.mu-liege-bar.mu-hide');
  private key = '';

  constructor(private readonly ctx: HudPartCtx) {}

  update(): void {
    const game = this.ctx.game();
    const lord = game ? liegeOf(game.sim) : null;
    const me = game?.sim.state.persons.get(game.sim.state.run.playerId);
    const key = lord ? `${lord.id}|${me?.id ?? 0}` : '';
    if (key === this.key) return;
    this.key = key;
    this.el.classList.toggle('mu-hide', !lord);
    if (!lord || !me) { this.el.replaceChildren(); return; }
    this.el.replaceChildren(
      icon('helm', 18),
      h('span', null, `You are ${fullName(me)}, ${lord.name}’s knight`),
      button('Return to your lord (U)', { size: 'small', variant: 'primary', icon: 'crown', onClick: () => returnToLiege(this.ctx) }));
  }
}

registerHudPart('ruler.liege', (ctx) => new LiegeBar(ctx));
registerHotkey('KeyU', (_code, _e, ctx) => returnToLiege(ctx));
