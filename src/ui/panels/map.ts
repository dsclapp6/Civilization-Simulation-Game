// The map panel (M): puts the renderer in map mode, lists and searches settlements, lets you click the
// map (or a list entry) to read about a place, travel there, follow the journey and answer encounters.
import type { SettlementKind } from '../../core/domain';
import { settlementCard } from '../../sim/api';
import { h, replace } from '../core/dom';
import { distanceText, plural, thousands } from '../core/format';
import { icon } from '../core/icons';
import { SETTLEMENT_ICON } from '../core/iconMap';
import { KIND_FILTERS, buildRows, distanceFrom, kindWord, marketDayText, nearestPlace, prosperityWords, searchRows, type KindFilter, type PlaceRow } from '../core/mapModel';
import { travelView } from '../core/hudModel';
import { bar, button, chip, empty, heading } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { every, panelOf } from './base';

const HEX = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

export function mapPanel(ctx: PanelCtx): UiPanel {
  const sim = ctx.sim;
  const world = sim.world;
  const win = createWindow({ title: 'The Realm', subtitle: 'Choose where to go', icon: 'map', size: 'sm', tall: true, onClose: () => ctx.close() });
  win.el.classList.add('mu-map-win');
  win.body.classList.add('flush');

  let query = '';
  let filter: KindFilter = 'all';
  let selected = -1;
  let travelling = false;
  let message = '';
  const renderer = (): ReturnType<PanelCtx['host']['renderer']> => ctx.host.renderer();

  const me = sim.state.persons.get(ctx.playerId());
  const here = me?.settlement ?? -1;
  const from = (): { x: number; z: number } => {
    const b = ctx.player.body();
    if (b) return b;
    const s = world.settlements.find((x) => x.id === here);
    return s ? { x: s.x, z: s.z } : { x: 0, z: 0 };
  };
  const kingdomOf = (id: number): { name: string; color: number } => {
    const k = world.kingdoms.find((x) => x.id === id);
    return { name: k?.name ?? '', color: k?.color ?? 0x888888 };
  };

  const rows = (): PlaceRow[] => buildRows(world.settlements, from(), here, kingdomOf);

  const search = h<HTMLInputElement>('input.mu-input.mu-map-search', { type: 'search', placeholder: 'Search places…', 'aria-label': 'Search places' });
  search.addEventListener('input', () => { query = search.value; renderList(); });
  const filters = h('div.mu-row.mu-wrap.mu-gap-4');
  const list = h('div.mu-map-list.mu-scroll');
  const detail = h('div.mu-map-detail');
  const markers = h('div.mu-map-markers');
  const selRing = h('div.mu-map-ring.sel.mu-hide');
  const youRing = h('div.mu-map-ring.you.mu-hide', null, h('span', null, 'You'));
  markers.append(selRing, youRing);

  win.body.append(h('div.mu-map-top', null, search, filters), list, detail);

  const renderFilters = (): void => {
    replace(filters, KIND_FILTERS.map((f) => {
      const b = h<HTMLButtonElement>('button.mu-chip.mu-click', { type: 'button', class: f.id === filter ? 'lapis' : '' }, f.label);
      b.addEventListener('click', () => { filter = f.id; renderFilters(); renderList(); });
      return b;
    }));
  };

  const renderList = (): void => {
    const shown = searchRows(rows(), query, filter);
    replace(list, shown.length ? shown.map((r) => {
      const row = h('div.mu-li.click.mu-map-row', { class: r.id === selected ? 'sel' : '' },
        h('span.mu-map-kind', { style: { color: HEX(r.kingdomColor) } }, icon(SETTLEMENT_ICON[r.kind], 18)),
        h('div.mu-grow.mu-trunc', null, h('b', null, r.name), h('div.mu-tiny.mu-dim', null, `${kindWord(r.kind)} · ${r.kingdomName}`)),
        r.market ? icon('market', 14, 'mu-dim') : null,
        r.here ? chip('Here', 'lapis') : h('span.mu-small.mu-dim.mu-nowrap', null, distanceFrom(r)));
      row.addEventListener('click', () => select(r.id, true));
      return row;
    }) : [empty('No such place is known.')]);
  };

  const renderDetail = (): void => {
    const t = ctx.player.travel();
    if (t) {
      const v = travelView(t, (id) => ctx.placeName(id));
      const b = bar('lapis', v.progress);
      replace(detail,
        h('div.mu-map-journey', null,
          h('div.mu-row.mu-gap-8', null, icon('signpost', 20), h('b.mu-big', null, v.title)),
          b.el,
          h('div.mu-row.mu-between.mu-small', null, h('span', null, v.remaining), h('span.mu-num', null, `${Math.round(v.progress * 100)}%`)),
          v.encounter ? h('div.mu-vermilion.mu-bold.mu-small', null, `${v.hostile ? 'Hostile: ' : ''}${v.encounter}`) : null,
          h('div.mu-row.mu-gap-6', null,
            v.phase === 'encounter' ? button('Journey options', { variant: 'primary', icon: 'signpost', onClick: () => ctx.open({ panel: 'encounter' }) })
              : button('Cancel journey', { variant: 'danger', icon: 'cross', onClick: () => { ctx.player.cancelTravel(); renderDetail(); } }))));
      return;
    }
    if (selected < 0) { replace(detail, h('p.mu-dim.mu-ital.mu-small', { style: { padding: '12px 16px' } }, 'Click a place on the map, or in the list.')); return; }
    const c = settlementCard(sim, selected);
    const row = rows().find((r) => r.id === selected);
    if (!c || !row) return;
    const lord = c.lord ? ctx.nameOf(c.lord) : '';
    replace(detail,
      h('div.mu-map-place', null,
        h('div.mu-row.mu-between.mu-top', null,
          h('div', null, h('div.mu-map-place-name', null, c.name), h('div.mu-dim.mu-small', null, `${kindWord(c.kind as SettlementKind)} in ${c.county || c.kingdom}`)),
          h('span.mu-map-kind.big', { style: { color: HEX(row.kingdomColor) } }, icon(SETTLEMENT_ICON[row.kind], 30))),
        h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '6px 0' } },
          chip(c.kingdom, '', 'crown'), c.market ? chip('Market town', 'lapis', 'market', marketDayText(c.id)) : null),
        h('dl.mu-kv', null,
          h('dt', null, 'People'), h('dd', null, `about ${thousands(c.population)} in ${plural(c.households, 'household')}`),
          lord ? h('dt', null, c.lordTitle || 'Lord') : null, lord ? h('dd', null, lord) : null,
          h('dt', null, 'Fortunes'), h('dd', null, prosperityWords(c.prosperity)),
          h('dt', null, 'From you'), h('dd', null, row.here ? 'where you are' : `${distanceText(row.distance)} ${row.direction}`)),
        message ? h('div.mu-bad.mu-small.mu-bold', { style: { marginTop: '6px' } }, message) : null,
        h('div.mu-row.mu-gap-6', { style: { marginTop: '10px' } },
          button(row.here ? 'You are here' : 'Travel there', { variant: 'primary', size: 'big', icon: 'signpost', disabled: row.here, onClick: () => travel(c.id) }),
          row.here ? button('Jobs here', { icon: 'hammer', onClick: () => ctx.open({ panel: 'jobs', settlement: c.id }) }) : null)));
  };

  function select(id: number, focus: boolean): void {
    selected = id;
    message = '';
    const c = world.settlements.find((s) => s.id === id);
    if (c && focus) renderer()?.focusMap(c.x, c.z);
    renderList();
    renderDetail();
  }

  function travel(id: number): void {
    const r = ctx.player.travelTo(id);
    if (!r.ok) { message = r.reason ?? 'You cannot go there now.'; renderDetail(); return; }
    travelling = true;
    ctx.say('info', `You set out for ${ctx.placeName(id)}.`);
    ctx.close();
  }

  // clicks on the map itself (the canvas): pick the nearest settlement
  let downAt: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent): void => { downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; };
  const onUp = (e: PointerEvent): void => {
    const d = downAt;
    downAt = null;
    if (!d || e.button !== 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    if ((e.target as Element | null)?.closest?.('.mu-root')) return;
    const g = renderer()?.screenToGround(e.clientX, e.clientY);
    if (!g) return;
    const p = nearestPlace(world.settlements, g.x, g.z, 650);
    if (p) select(p.id, false);
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);

  const place = (el: HTMLElement, p: { x: number; z: number } | null): void => {
    const r = renderer();
    const s = p && r ? r.project(p.x, 0, p.z) : null;
    if (!s) { el.classList.add('mu-hide'); return; }
    const l = ctx.toLocal(s);
    el.classList.remove('mu-hide');
    el.style.transform = `translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`;
  };

  const tickMarkers = (): void => {
    place(selRing, selected >= 0 ? world.settlements.find((s) => s.id === selected) ?? null : null);
    place(youRing, from());
  };

  renderFilters();
  renderList();
  renderDetail();
  const refreshDetail = every(0.5, () => { if (ctx.player.travel() || travelling) renderDetail(); });

  return panelOf({ id: 'map', group: 'main', captures: false, pauses: 'never', mode: 'clear', backdropCloses: null }, h('div.mu-map-root', null, markers, win.el), {
    mount: () => {
      const r = renderer();
      r?.setCameraMode('map');
      const f = from();
      r?.focusMap(f.x, f.z);
    },
    tick: (now) => { tickMarkers(); refreshDetail(now); },
    dispose: () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      if (!travelling) renderer()?.setCameraMode('follow');
    },
  });
}

