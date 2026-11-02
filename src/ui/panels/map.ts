// The map panel (M): puts the renderer in map mode, lists and searches settlements, lets you click the
// map (or a list entry) to read about a place, travel there, follow the journey and answer encounters.
// Civilization pass (docs/CIV.md §2, §4, §7): the lands' borders coloured by whose they are, the deposits (iron, stone, clay, salt,
// silver, gold) and outposts drawn on the map with filters, *Rule this town* on a settlement's card, and **People here**: everyone
// who lives there, searchable by role, with *Live as*.
import type { SettlementKind } from '../../core/domain';
import type { P2 } from '../../core/math';
import { settlementCard } from '../../sim/api';
import { h, replace } from '../core/dom';
import { distanceText, plural, thousands } from '../core/format';
import { icon, type IconName } from '../core/icons';
import { SETTLEMENT_ICON } from '../core/iconMap';
import {
  DEPOSIT_COLOR, DEPOSIT_KINDS, DEPOSIT_NAME, KIND_FILTERS, ROLE_GROUPS, buildRows, cssColor, defaultLayers, depositShown, depositTip, distanceFrom, groupCounts, houseColor, kindWord,
  marketDayText, nearestPlace, onScreen, peopleOfSettlement, prosperityWords, richnessWords, rgba, searchPeople, searchRows, whoseLands, type DepositKind, type KindFilter, type MapLayers, type PeopleRow,
  type PlaceRow, type RoleGroup,
} from '../core/mapModel';
import { travelView } from '../core/hudModel';
import { bar, button, chip, empty } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { ruleOffer } from '../ruler/ruleTown';
import '../builder/lands.css';
import { every, panelOf } from './base';

const HEX = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/** Which layers of the map are on: kept while the game runs, so a reopened map looks as it was left. */
let layerState: MapLayers = defaultLayers();

const DEPOSIT_ICON: Record<DepositKind, IconName> = { iron: 'mining', stone: 'masonry', clay: 'cup', salt: 'drop', silver: 'sparkle', gold: 'star_f' };
/** The working a deposit is dug with. */
const DEPOSIT_WORKS: Record<DepositKind, string> = { iron: 'mine', silver: 'mine', gold: 'mine', stone: 'quarry', clay: 'clay_pit', salt: 'salt_pan' };

export function mapPanel(ctx: PanelCtx): UiPanel {
  const sim = ctx.sim;
  const world = sim.world;
  const terr = ctx.game.territory;
  const cons = ctx.game.construction;
  const win = createWindow({ title: 'The Realm', subtitle: 'Choose where to go', icon: 'map', size: 'sm', tall: true, onClose: () => ctx.close() });
  win.el.classList.add('mu-map-win');
  win.body.classList.add('flush');

  let query = '';
  let filter: KindFilter = 'all';
  let selected = -1;
  let selectedDeposit = -1;
  let view: 'places' | 'people' = 'places';
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
  const layerRow = h('div.mu-row.mu-wrap.mu-gap-4.mu-map-layers');
  const list = h('div.mu-map-list.mu-scroll');
  const detail = h('div.mu-map-detail');
  const markers = h('div.mu-map-markers');
  const borders = h<HTMLCanvasElement>('canvas.mu-map-borders');
  const depLayer = h('div.mu-map-deps');
  const outLayer = h('div.mu-map-outs');
  const selRing = h('div.mu-map-ring.sel.mu-hide');
  const youRing = h('div.mu-map-ring.you.mu-hide', null, h('span', null, 'You'));
  markers.append(borders, depLayer, outLayer, selRing, youRing);

  const topEl = h('div.mu-map-top', null, search, filters, layerRow);
  const peopleEl = h('div.mu-map-people.mu-hide');
  win.body.append(topEl, list, peopleEl, detail);

  const renderFilters = (): void => {
    replace(filters, KIND_FILTERS.map((f) => {
      const b = h<HTMLButtonElement>('button.mu-chip.mu-click', { type: 'button', class: f.id === filter ? 'lapis' : '' }, f.label);
      b.addEventListener('click', () => { filter = f.id; renderFilters(); renderList(); });
      return b;
    }));
  };

  // ---- the layers: borders, outposts, deposits by kind
  let layersVer = 1;
  const touchLayers = (): void => { layersVer++; renderLayers(); };
  const renderLayers = (): void => {
    if (!terr && !cons && !(world.deposits ?? []).length) { layerRow.classList.add('mu-hide'); return; }
    const toggle = (label: string, on: boolean, tip: string, flip: () => void, dot?: number): HTMLElement => {
      const b = h<HTMLButtonElement>('button.mu-chip.mu-click.mu-map-layer', { type: 'button', class: on ? 'lapis' : '', tip, 'aria-pressed': String(on) },
        dot !== undefined ? h('i.mu-dot', { style: { background: cssColor(dot) } }) : null, label);
      b.addEventListener('click', () => { flip(); touchLayers(); });
      return b;
    };
    const chips: HTMLElement[] = [];
    if (terr?.landsPolygon) chips.push(toggle('Borders', layerState.borders, 'The lands of each place, coloured by the House that holds them', () => { layerState = { ...layerState, borders: !layerState.borders }; }));
    if (cons) chips.push(toggle('Outposts', layerState.outposts, 'Named camps founded in the wild', () => { layerState = { ...layerState, outposts: !layerState.outposts }; }));
    if ((world.deposits ?? []).length) {
      chips.push(toggle('Deposits', layerState.deposits, 'Where the ground holds iron, stone, clay, salt, silver and gold', () => { layerState = { ...layerState, deposits: !layerState.deposits }; }));
      if (layerState.deposits) for (const k of DEPOSIT_KINDS) chips.push(toggle(DEPOSIT_NAME[k], layerState.kinds[k], `${DEPOSIT_NAME[k]} deposits`, () => { layerState = { ...layerState, kinds: { ...layerState.kinds, [k]: !layerState.kinds[k] } }; }, DEPOSIT_COLOR[k]));
    }
    replace(layerRow, chips);
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

  /** Whose lands a settlement's are, in words and colour. */
  const landsOf = (id: number): { text: string; color: number; house: string | null } => {
    const s = world.settlements.find((x) => x.id === id);
    const owner = terr?.ownerOf?.(id);
    const house = owner && owner.house ? sim.state.houses.get(owner.house) : undefined;
    const fallback = kingdomOf(s?.kingdom ?? -1).color;
    return { text: whoseLands(ctx.placeName(id), house?.name ?? null), color: houseColor(house?.heraldry?.field, fallback), house: house?.name ?? null };
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
    if (selectedDeposit >= 0) { renderDeposit(); return; }
    if (selected < 0) { replace(detail, h('p.mu-dim.mu-ital.mu-small', { style: { padding: '12px 16px' } }, 'Click a place on the map, or in the list.')); return; }
    const c = settlementCard(sim, selected);
    const row = rows().find((r) => r.id === selected);
    if (!c || !row) return;
    const lord = c.lord ? ctx.nameOf(c.lord) : '';
    const lands = landsOf(c.id);
    const offer = ruleOffer(ctx.game, c.id);
    const works = (cons?.outposts() ?? []).filter((o) => o.settlement === c.id);
    replace(detail,
      h('div.mu-map-place', null,
        h('div.mu-row.mu-between.mu-top', null,
          h('div', null, h('div.mu-map-place-name', null, c.name), h('div.mu-dim.mu-small', null, `${kindWord(c.kind as SettlementKind)} in ${c.county || c.kingdom}`)),
          h('span.mu-map-kind.big', { style: { color: HEX(row.kingdomColor) } }, icon(SETTLEMENT_ICON[row.kind], 30))),
        h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '6px 0' } },
          chip(c.kingdom, '', 'crown'), c.market ? chip('Market town', 'lapis', 'market', marketDayText(c.id)) : null,
          terr?.ownerOf ? h('span.mu-chip', { tip: lands.text }, h('i.mu-dot', { style: { background: cssColor(lands.color) } }), lands.house ? `House ${lands.house}` : 'No House holds it') : null),
        h('dl.mu-kv', null,
          h('dt', null, 'People'), h('dd', null, `about ${thousands(c.population)} in ${plural(c.households, 'household')}`),
          lord ? h('dt', null, c.lordTitle || 'Lord') : null, lord ? h('dd', null, lord) : null,
          h('dt', null, 'Fortunes'), h('dd', null, prosperityWords(c.prosperity)),
          works.length ? h('dt', null, 'Outposts') : null, works.length ? h('dd', null, works.map((o) => o.name).join(', ')) : null,
          h('dt', null, 'From you'), h('dd', null, row.here ? 'where you are' : `${distanceText(row.distance)} ${row.direction}`)),
        message ? h('div.mu-bad.mu-small.mu-bold', { style: { marginTop: '6px' } }, message) : null,
        h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '10px' } },
          button(row.here ? 'You are here' : 'Travel there', { variant: 'primary', size: 'big', icon: 'signpost', disabled: row.here, onClick: () => travel(c.id) }),
          row.here ? button('Jobs here', { icon: 'hammer', onClick: () => ctx.open({ panel: 'jobs', settlement: c.id }) }) : null),
        h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '6px' } },
          button('People here', { icon: 'users', tip: 'Everyone who lives in this place, by calling: live as any of them', onClick: () => showPeople(c.id) }),
          offer ? button(offer.label, { icon: 'crown', tip: offer.tip, onClick: () => { ctx.close(); ctx.open(offer.request); } }) : null)));
  };

  // ---- a deposit's card
  const renderDeposit = (): void => {
    const d = (world.deposits ?? []).find((x) => x.id === selectedDeposit);
    if (!d) { selectedDeposit = -1; renderDetail(); return; }
    const kind = d.kind as DepositKind;
    const lands = d.settlement >= 0 ? landsOf(d.settlement) : null;
    const outpost = (cons?.outposts() ?? []).find((o) => o.deposit === d.id);
    const scope = cons?.scope(ctx.playerId());
    const mayFound = !!scope?.outposts && d.settlement < 0;
    const mayDig = !!scope && (scope.outposts || (d.settlement >= 0 && scope.settlements.includes(d.settlement)));
    replace(detail,
      h('div.mu-map-place', null,
        h('div.mu-row.mu-between.mu-top', null,
          h('div', null, h('div.mu-map-place-name', null, `${DEPOSIT_NAME[kind]} deposit`), h('div.mu-dim.mu-small', null, `${richnessWords(d.richness)} · ${Math.round(d.radius * 2)} m across`)),
          h('span.mu-dep-badge', { style: { background: cssColor(DEPOSIT_COLOR[kind]) } }, icon(DEPOSIT_ICON[kind], 20))),
        h('p.mu-small.mu-ink2', { style: { margin: '6px 0' } }, lands ? lands.text : whoseLands(null, null)),
        h('p.mu-small.mu-dim', null, `${depositTip({ kind, richness: d.richness }, '', outpost?.name).split('\n').slice(-1)[0]}`),
        outpost ? h('p.mu-small.mu-bold', null, `${outpost.name} works it.`) : null,
        h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '10px' } },
          mayDig && !outpost ? button(mayFound ? 'Found an outpost here' : 'Build a working here', {
            variant: 'primary', icon: 'hammer', tip: 'Builder mode, over this deposit with the right building chosen',
            onClick: () => { ctx.close(); ctx.open({ panel: 'ext', name: 'builder', data: { at: { x: d.x, z: d.z }, kind: DEPOSIT_WORKS[kind] } }); },
          }) : null,
          button('Close', { onClick: () => { selectedDeposit = -1; renderDetail(); } }))));
  };

  // ---- people here
  let peopleCache: { settlement: number; rows: PeopleRow[]; ruler: number } | null = null;
  let peopleQuery = '';
  let peopleGroup: RoleGroup | 'all' = 'all';

  const peopleOf = (settlement: number): { rows: PeopleRow[]; ruler: number } => {
    if (peopleCache && peopleCache.settlement === settlement) return peopleCache;
    const ruler = ctx.game.realm?.rulerOf(settlement) ?? 0;
    peopleCache = { settlement, rows: peopleOfSettlement(sim.state, settlement, sim.absDay, ruler), ruler };
    return peopleCache;
  };

  const showPeople = (settlement: number): void => {
    selected = settlement;
    view = 'people';
    peopleQuery = '';
    peopleGroup = 'all';
    peopleCache = null;
    applyView();
  };

  const renderPeople = (): void => {
    const { rows: all, ruler } = peopleOf(selected);
    const counts = groupCounts(all);
    const found = searchPeople(all, peopleQuery, peopleGroup, 60);
    const name = ctx.placeName(selected);
    const offer = ruleOffer(ctx.game, selected);
    const input = h<HTMLInputElement>('input.mu-input.mu-grow', { type: 'search', placeholder: `Search the people of ${name}…`, 'aria-label': 'Search people', value: peopleQuery });
    input.addEventListener('input', () => { peopleQuery = input.value; refill(); });
    const chips = h('div.mu-map-pchips');
    for (const g of ROLE_GROUPS) {
      if (g.id !== 'all' && !counts[g.id]) continue;
      const b = h<HTMLButtonElement>('button.mu-chip.mu-click', { type: 'button', class: g.id === peopleGroup ? 'lapis' : '' }, g.label, h('b', null, String(counts[g.id])));
      b.addEventListener('click', () => { peopleGroup = g.id; renderPeople(); });
      chips.append(b);
    }
    const body = h('div.mu-map-plist.mu-scroll');
    const refill = (): void => {
      const f = searchPeople(all, peopleQuery, peopleGroup, 60);
      replace(body, f.rows.length ? [...f.rows.map((r) => personRow(r, r.id === ruler)), f.total > f.rows.length ? h('p.mu-tiny.mu-dim', { style: { padding: '8px 12px' } }, `${thousands(f.total - f.rows.length)} more: search by name or calling to narrow it down.`) : null] : [empty('No one by that name or calling lives here.')]);
    };
    refill();
    replace(peopleEl,
      h('div.mu-map-phead', null,
        button('Places', { size: 'small', icon: 'chev_left', onClick: () => { view = 'places'; applyView(); } }),
        h('div.mu-grow', null, h('b.mu-big', null, `People of ${name}`), h('div.mu-tiny.mu-dim', null, `${thousands(all.length)} living there${found.total !== all.length ? ` · ${thousands(found.total)} shown` : ''}`)),
        offer ? button(offer.self ? 'Seat' : 'Rule', { size: 'small', icon: 'crown', tip: offer.tip, onClick: () => { ctx.close(); ctx.open(offer.request); } }) : null),
      h('div.mu-row.mu-gap-6', { style: { padding: '0 26px 6px 28px' } }, input),
      h('div', { style: { padding: '0 26px 6px 28px' } }, chips),
      body);
  };

  const personRow = (r: PeopleRow, ruler: boolean): HTMLElement => {
    const row = h('div.mu-li.mu-map-prow', null,
      h('div.mu-grow.mu-trunc', null, h('b', null, r.name), h('div.mu-tiny.mu-dim.mu-trunc', null, `${r.role} · ${r.age}${ruler ? ' · rules here' : ''}`)),
      ruler ? chip('rules', 'gold', 'crown') : null,
      button('Live as', { size: 'small', icon: 'user', tip: `Take over ${r.name} and go on as them`, onClick: () => { ctx.close(); ctx.open({ panel: 'ext', name: 'liveAs', id: r.id, data: { reason: 'choose' } }); } }));
    return row;
  };

  const applyView = (): void => {
    const people = view === 'people';
    list.classList.toggle('mu-hide', people);
    topEl.classList.toggle('mu-hide', people);
    detail.classList.toggle('mu-hide', people);
    peopleEl.classList.toggle('mu-hide', !people);
    if (people) renderPeople(); else renderList();
    renderDetail();
  };

  function select(id: number, focus: boolean): void {
    selected = id;
    selectedDeposit = -1;
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
    if (view === 'people') return;
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

  // ---- the layers on the map: borders on a canvas, deposits and outposts as little DOM markers placed when the camera moves
  const depEls = new Map<number, { el: HTMLElement; shown: boolean }>();
  const outEls = new Map<number, { el: HTMLElement; shown: boolean }>();
  let colours = new Map<number, number>();
  let coloursVer = -1;
  const colourOf = (id: number): number => {
    const v = terr?.version() ?? 0;
    if (v !== coloursVer) { colours = new Map(); coloursVer = v; }
    let c = colours.get(id);
    if (c === undefined) {
      const owner = terr?.ownerOf?.(id);
      const house = owner && owner.house ? sim.state.houses.get(owner.house) : undefined;
      const s = world.settlements.find((x) => x.id === id);
      c = houseColor(house?.heraldry?.field, kingdomOf(s?.kingdom ?? -1).color);
      colours.set(id, c);
    }
    return c;
  };

  const viewSize = (): { w: number; h: number } => {
    const k = ctx.toLocal({ x: window.innerWidth, y: window.innerHeight });
    return { w: k.x, h: k.y };
  };

  const drawBorders = (): void => {
    const r = renderer();
    const g2 = borders.getContext('2d');
    if (!g2) return;
    const { w, h: hh } = viewSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(w * dpr), ph = Math.round(hh * dpr);
    if (borders.width !== pw || borders.height !== ph) { borders.width = pw; borders.height = ph; }
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, w, hh);
    if (!r || !terr?.landsPolygon || !layerState.borders) return;
    const seen = new Set<readonly P2[]>();
    g2.lineJoin = 'round';
    for (const s of world.settlements) {
      const poly = terr.landsPolygon(s.id);
      if (!poly || poly.length < 3 || seen.has(poly)) continue;
      seen.add(poly);
      const pts: Array<{ x: number; y: number }> = [];
      let ok = true;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const v of poly) {
        const p = r.project(v.x, 0, v.z);
        if (!p) { ok = false; break; }
        const l = ctx.toLocal(p);
        pts.push(l);
        if (l.x < minX) minX = l.x; if (l.x > maxX) maxX = l.x; if (l.y < minY) minY = l.y; if (l.y > maxY) maxY = l.y;
      }
      if (!ok || maxX < 0 || minX > w || maxY < 0 || minY > hh) continue;
      const col = colourOf(s.id);
      g2.beginPath();
      pts.forEach((p, i) => (i ? g2.lineTo(p.x, p.y) : g2.moveTo(p.x, p.y)));
      g2.closePath();
      g2.fillStyle = rgba(col, s.id === selected ? 0.24 : 0.12);
      g2.fill();
      g2.lineWidth = s.id === selected ? 3 : 1.6;
      g2.strokeStyle = rgba(col, 0.85);
      g2.stroke();
    }
    // the land the outposts claim in the wild
    if (layerState.outposts) {
      for (const c of terr.outpostPolygons?.() ?? []) {
        if (c.poly.length < 3) continue;
        const pts: Array<{ x: number; y: number }> = [];
        let ok = true;
        for (const v of c.poly) { const p = r.project(v.x, 0, v.z); if (!p) { ok = false; break; } pts.push(ctx.toLocal(p)); }
        if (!ok) continue;
        g2.beginPath();
        pts.forEach((p, i) => (i ? g2.lineTo(p.x, p.y) : g2.moveTo(p.x, p.y)));
        g2.closePath();
        g2.fillStyle = 'rgba(227, 154, 69, 0.18)';
        g2.fill();
        g2.setLineDash([6, 4]);
        g2.lineWidth = 1.6;
        g2.strokeStyle = 'rgba(227, 154, 69, 0.95)';
        g2.stroke();
        g2.setLineDash([]);
      }
    }
  };

  /** The HUD plates the markers would be drawn over (the panel layer is above the HUD): the clock and the dock. */
  const hudRects = (): DOMRect[] => {
    const out: DOMRect[] = [];
    for (const el of document.querySelectorAll('.mu-hud-right, .mu-dock')) { const b = el.getBoundingClientRect(); if (b.width > 0) out.push(b); }
    return out;
  };
  const covered = (s: { x: number; y: number } | null, rects: readonly DOMRect[]): boolean => !!s && rects.some((b) => s.x >= b.left - 6 && s.x <= b.right + 6 && s.y >= b.top - 6 && s.y <= b.bottom + 6);

  const placeMarkers = (): void => {
    const r = renderer();
    const { w, h: hh } = viewSize();
    const occluders = hudRects();
    // deposits
    for (const d of world.deposits ?? []) {
      let rec = depEls.get(d.id);
      const show = !!r && depositShown(layerState, d.kind as DepositKind);
      if (!rec) {
        if (!show) continue;
        const kind = d.kind as DepositKind;
        const owner = d.settlement >= 0 ? landsOf(d.settlement) : null;
        const outpost = (cons?.outposts() ?? []).find((o) => o.deposit === d.id);
        const el = h('div.mu-map-dep', { tip: depositTip({ kind, richness: d.richness }, owner ? owner.text : whoseLands(null, null), outpost?.name), style: { '--c': cssColor(DEPOSIT_COLOR[kind]) } }, icon(DEPOSIT_ICON[kind], 11));
        el.addEventListener('click', () => { selectedDeposit = d.id; view = 'places'; applyView(); });
        depLayer.appendChild(el);
        rec = { el, shown: true }; // on the screen until the first look says it is not (it would sit at the corner otherwise)
        depEls.set(d.id, rec);
      }
      const s = show && r ? r.project(d.x, 0, d.z) : null;
      const l = s ? ctx.toLocal(s) : null;
      const vis = onScreen(l, w, hh, 12) && !covered(s, occluders);
      if (vis && l) { rec.el.style.transform = `translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`; }
      if (vis !== rec.shown) { rec.shown = vis; rec.el.classList.toggle('mu-hide', !vis); }
    }
    // outposts
    const list2 = layerState.outposts ? cons?.outposts() ?? [] : [];
    const live = new Set<number>();
    for (const o of list2) {
      live.add(o.id);
      let rec = outEls.get(o.id);
      if (!rec) {
        const el = h('div.mu-map-out', { tip: `${o.name}: an outpost of ${ctx.placeName(o.settlement)}` }, icon('flag', 13), h('span', null, o.name));
        outLayer.appendChild(el);
        rec = { el, shown: true };
        outEls.set(o.id, rec);
      }
      const s = r ? r.project(o.x, 0, o.z) : null;
      const l = s ? ctx.toLocal(s) : null;
      const vis = onScreen(l, w, hh, 40) && !covered(s, occluders);
      if (vis && l) rec.el.style.transform = `translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`;
      if (vis !== rec.shown) { rec.shown = vis; rec.el.classList.toggle('mu-hide', !vis); }
    }
    for (const [id, rec] of outEls) if (!live.has(id)) { rec.el.remove(); outEls.delete(id); }
  };

  let lastCam = '';
  const cameraKey = (): string => {
    const r = renderer();
    if (!r) return '';
    const parts = [r.project(0, 0, 0), r.project(8000, 0, 8000), r.project(16000, 0, 0)].map((p) => (p ? `${Math.round(p.x * 2)},${Math.round(p.y * 2)}` : 'n'));
    return `${parts.join('|')}|${window.innerWidth}x${window.innerHeight}|${terr?.version() ?? 0}|${cons?.version() ?? 0}|${layersVer}|${selected}`;
  };
  const tickLayers = (): void => {
    const k = cameraKey();
    if (k === lastCam) return;
    lastCam = k;
    drawBorders();
    placeMarkers();
  };

  const tickMarkers = (): void => {
    place(selRing, selected >= 0 && view === 'places' ? world.settlements.find((s) => s.id === selected) ?? null : null);
    place(youRing, from());
  };

  renderFilters();
  renderLayers();
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
    tick: (now) => { tickMarkers(); tickLayers(); refreshDetail(now); },
    dispose: () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      if (!travelling) renderer()?.setCameraMode('follow');
    },
  });
}

