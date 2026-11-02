// The People page (V): everyone of your town, the ruler first, then the knights and men of arms, the clergy, the
// masters and craftsmen, the merchants and the commons, with "Live as" on each. You may be whoever you want; the one
// you leave goes on with their life. Any other place can be looked at from the list of settlements.
import { roleLabel } from '../../sim/careers';
import type { RealmApi } from '../../sim/realm/types';
import { ageYears, fullName, type Person } from '../../sim/state';
import { h } from '../core/dom';
import { icon, type IconName } from '../core/icons';
import { button, empty } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

interface Group { id: string; label: string; icon: IconName }
const GROUPS: readonly Group[] = [
  { id: 'rule', label: 'Ruling', icon: 'crown' },
  { id: 'arms', label: 'Knights and men of arms', icon: 'helm' },
  { id: 'church', label: 'Clergy', icon: 'cross_holy' },
  { id: 'craft', label: 'Masters and craftsmen', icon: 'hammer' },
  { id: 'trade', label: 'Merchants and keepers', icon: 'market' },
  { id: 'land', label: 'The land', icon: 'wheat' },
  { id: 'young', label: 'The young', icon: 'users' },
];
const ARMS = new Set(['knight', 'squire', 'man_at_arms', 'sergeant', 'soldier', 'archer']);
const TRADE = new Set(['merchant', 'shopkeeper', 'tavern_keeper', 'alewife']);

function groupOf(p: Person, age: number, rulers: ReadonlySet<number>, titled: boolean): string {
  if (rulers.has(p.id) || titled) return 'rule';
  if (age < 16) return 'young';
  if (ARMS.has(p.career)) return 'arms';
  if (p.estate === 'clergy') return 'church';
  if (TRADE.has(p.career)) return 'trade';
  if (p.rankTier >= 3) return 'craft';
  return 'land';
}

export function peoplePanel(ctx: PanelCtx): UiPanel {
  const sim = ctx.sim;
  const win = createWindow({ title: 'People', subtitle: 'Be whoever you want', icon: 'users', size: 'lg', tall: true, onClose: () => ctx.close() });
  const me0 = sim.state.persons.get(ctx.playerId());
  let place = me0?.settlement ?? 0;
  let query = '';
  const search = h<HTMLInputElement>('input.mu-input', { type: 'search', placeholder: 'Search by name or trade…', 'aria-label': 'Search people', style: { flex: '1' } });
  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  const places = h<HTMLSelectElement>('select.mu-input', { 'aria-label': 'Town' },
    [...sim.world.settlements].sort((a, b) => (a.id === place ? -1 : b.id === place ? 1 : a.name.localeCompare(b.name)))
      .map((s) => h('option', { value: String(s.id), selected: s.id === place }, s.id === me0?.settlement ? `${s.name} (yours)` : s.name)));
  places.addEventListener('change', () => { place = Number(places.value); render(); });
  const list = h('div.mu-people');
  win.body.append(h('div.mu-row.mu-gap-8', { style: { marginBottom: '10px' } }, places, search), list);

  const render = (): void => {
    const now = sim.absDay;
    const R = sim.services.realm as RealmApi | undefined;
    const rulers = new Set<number>();
    const ruler = R?.rulerOf(place) ?? 0;
    if (ruler) rulers.add(ruler);
    const people = sim.state.residentsOf(place).filter((p) => !p.death && ageYears(p, now) >= 6);
    const rows = new Map<string, HTMLElement[]>();
    const me = ctx.playerId();
    for (const p of people) {
      const age = Math.floor(ageYears(p, now));
      const role = roleLabel(p.career, p.careerStage, p.sex);
      const titles = [...sim.state.titlesHeldBy(p.id)].map((t) => t.name);
      const text = `${fullName(p)} ${role} ${titles.join(' ')}`.toLowerCase();
      if (query && !text.includes(query)) continue;
      const g = groupOf(p, age, rulers, titles.length > 0);
      const row = h('div.mu-people-row', { class: p.id === me ? 'me' : '' },
        h('div.mu-people-who', null,
          h('b', null, fullName(p)),
          h('span.mu-dim.mu-small', null, ` · ${role}, ${age}${titles.length ? ` · ${titles.join(', ')}` : ''}${p.id === ruler ? ' · rules here' : ''}`)),
        p.id === me ? h('span.mu-small.mu-dim', null, 'you') : button('Live as', {
          size: 'small', icon: 'user', onClick: () => {
            const r = ctx.dispatch({ type: 'switchCharacter', personId: p.id });
            if (r.ok) ctx.close(); else ctx.say('warn', r.reason ?? 'Not now.');
          },
        }));
      (rows.get(g) ?? rows.set(g, []).get(g)!).push(row);
    }
    const out: HTMLElement[] = [];
    for (const g of GROUPS) {
      const r = rows.get(g.id);
      if (!r?.length) continue;
      out.push(h('div.mu-people-head', null, icon(g.icon, 14), ` ${g.label}`, h('span.mu-dim', null, ` ${r.length}`)), ...r.slice(0, 120));
    }
    list.replaceChildren(...(out.length ? out : [empty(query ? 'Nobody by that name here.' : 'Nobody lives here.')]));
  };
  render();
  ctx.listen('playerSwitched', () => render());
  return panelOf({ id: 'people', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el);
}

registerPanel('people', (ctx) => peoplePanel(ctx));
