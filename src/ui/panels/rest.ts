// Rest (Z): sleep until dawn, or wait until noon / dusk / a market day / the crops are ripe.
import { toDate } from '../../core/time';
import { dayPart, nextMarketDay } from '../../sim/calendar';
import { nextTimeOfDay } from '../../sim/clock';
import { h } from '../core/dom';
import { clockText, dayPartLabel, dateText, pct, relativeDay } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { bar, button } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import type { WaitUntil } from '../../sim/sim';
import { every, panelOf } from './base';

interface RestOption {
  id: string;
  label: string;
  detail: string;
  icon: IconName;
  until: WaitUntil | 'sleep';
  disabled?: string;
  primary?: boolean;
}

export function restPanel(ctx: PanelCtx): UiPanel {
  const win = createWindow({ title: 'Rest', subtitle: 'Let the hours pass', icon: 'bed', size: 'sm', onClose: () => ctx.close() });
  const body = win.body;
  const status = h('div.mu-rest-status');
  const list = h('div.mu-col.mu-gap-6');
  const message = h('p.mu-bad.mu-small.mu-bold.mu-hide');
  body.append(status, list, message);

  const options = (): RestOption[] => {
    const now = ctx.sim.absDay;
    const hostile = ctx.sim.hostileNear();
    const settlement = ctx.sim.state.persons.get(ctx.playerId())?.settlement ?? -1;
    const market = ctx.sim.world.settlements.find((s) => s.id === settlement)?.market ?? false;
    const at = (day: number): string => `until ${clockText(toDate(day).dayFraction)}, ${relativeDay(day, now)}`;
    const dawn = nextTimeOfDay(now, 'dawn');
    const noon = nextTimeOfDay(now, 'noon');
    const dusk = nextTimeOfDay(now, 'dusk');
    const mkt = market ? nextMarketDay(now, settlement) + 0.3 : 0;
    const refuse = hostile ? 'Enemies are near.' : ctx.sim.state.clock.actionTime ? 'Not while you are in the thick of things.' : undefined;
    return [
      { id: 'sleep', label: 'Sleep until dawn', detail: `${at(dawn)}; you wake rested`, icon: 'moon_z', until: 'sleep', disabled: refuse, primary: true },
      { id: 'noon', label: 'Wait until noon', detail: at(noon), icon: 'sun', until: 'noon', disabled: refuse },
      { id: 'dusk', label: 'Wait until dusk', detail: at(dusk), icon: 'moon', until: 'dusk', disabled: refuse },
      { id: 'hour', label: 'Wait an hour', detail: `until ${clockText(toDate(now + 1 / 24).dayFraction)}`, icon: 'hourglass', until: now + 1 / 24, disabled: refuse },
      { id: 'market', label: 'Wait for market day', detail: market ? `${dateText(mkt)}, ${relativeDay(mkt, now)}` : 'There is no market here', icon: 'market', until: mkt, disabled: refuse ?? (market ? undefined : 'There is no market in this settlement.') },
      { id: 'crops', label: 'Wait for the crops to ripen', detail: 'Until a strip near you is ready to reap', icon: 'wheat', until: 'cropRipe', disabled: refuse },
    ];
  };

  const go = (o: RestOption): void => {
    if (o.disabled) { message.textContent = o.disabled; message.classList.remove('mu-hide'); return; }
    const r = o.until === 'sleep' ? ctx.dispatch({ type: 'sleep' }) : ctx.dispatch({ type: 'waitUntil', until: o.until });
    if (!r.ok) { message.textContent = r.reason ?? 'You cannot do that now.'; message.classList.remove('mu-hide'); return; }
    ctx.close();
  };

  let opts: RestOption[] = [];
  const render = (): void => {
    const now = ctx.sim.absDay;
    const d = toDate(now);
    const person = ctx.sim.state.persons.get(ctx.playerId());
    const rest = person?.needs.rest ?? 1;
    const b = bar(rest < 0.38 ? 'vermilion' : 'green', rest, { thin: true });
    status.replaceChildren(
      h('div.mu-row.mu-between', null,
        h('div', null, h('div.mu-rest-time', null, clockText(d.dayFraction)), h('div.mu-dim', null, `${dayPartLabel(dayPart(now))} · ${dateText(now)}`)),
        h('div.mu-rest-need', null, h('div.mu-small.mu-dim', null, `Rest ${pct(rest)}`), b.el)),
    );
    opts = options();
    list.replaceChildren(...opts.map((o, i) => {
      const b2 = h<HTMLButtonElement>('button.mu-rest-opt', { type: 'button', class: `${o.primary ? 'primary' : ''}${o.disabled ? ' is-disabled' : ''}`, tip: o.disabled },
        h('span.mu-key', null, String(i + 1)), h('span.mu-rest-ico', null, icon(o.icon, 20)),
        h('span.mu-rest-text', null, h('b', null, o.label), h('span.mu-dim.mu-small', null, o.disabled ?? o.detail)));
      b2.addEventListener('click', () => go(o));
      return b2;
    }));
  };
  render();
  win.showFoot(h('span.mu-dim.mu-small.mu-ital', null, 'At normal speed a day is a minute long.'), h('div.mu-grow'), button('Never mind', { onClick: () => ctx.close() }));
  return panelOf({ id: 'rest', group: 'main', pauses: 'never', backdropCloses: ctx }, win.el, {
    tick: every(1, render),
    key: (intent) => { if (intent.type === 'digit' && opts[intent.n - 1]) { go(opts[intent.n - 1]); return true; } return false; },
  });
}
