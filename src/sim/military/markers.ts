// Map markers (core/view MapMarker kinds 'army', 'battle', 'siege'): wraps the player's marker source and
// appends armies, battles and sieges. The army marker slides between its position an hour ago and now so it
// moves smoothly on the map.
import type { MapMarker } from '../../core/view';
import { lerp } from '../../core/math';
import type { Mil } from './store';

const ARMY_ID = 5_000_000;
const BATTLE_ID = 6_000_000;
const SIEGE_ID = 7_000_000;

interface ViewWithSources {
  sources: { mapMarkers?: () => readonly MapMarker[] };
  setSource(key: 'mapMarkers', fn: (() => readonly MapMarker[]) | undefined): void;
  mapMarkers(): readonly MapMarker[];
}

export function installMarkers(M: Mil): () => void {
  const view = M.sim.view as unknown as ViewWithSources;
  const prev = view.sources.mapMarkers;
  const pool = new Map<number, MapMarker>();
  const counts = new Map<number, number>();
  const combined: MapMarker[] = [];

  const marker = (id: number, kind: MapMarker['kind']): MapMarker => {
    let m = pool.get(id);
    if (!m) { m = { id, kind, x: 0, z: 0, color: 0xc0392b, size: 1 }; pool.set(id, m); }
    m.kind = kind;
    return m;
  };

  const colorOf = (house: number): number => {
    const h = M.state.houses.get(house);
    if (h?.heraldry) return h.heraldry.field;
    const k = M.world.kingdoms.find((x) => x.culture === h?.culture);
    return k ? k.color : 0xc0392b;
  };

  const wrapper = (): readonly MapMarker[] => {
    let base: readonly MapMarker[];
    if (prev) base = prev();
    else {
      delete view.sources.mapMarkers;
      try { base = view.mapMarkers(); } finally { view.setSource('mapMarkers', wrapper); }
    }
    const data = M.data;
    if (data.armies.length === 0 && data.battles.length === 0 && data.sieges.length === 0) return base;
    combined.length = 0;
    for (const m of base) combined.push(m);
    const frac = ((M.sim.absDay * 24) % 1 + 1) % 1;
    for (const a of data.armies) {
      if (a.reason === 'sally') continue;
      const m = marker(ARMY_ID + a.id, 'army');
      m.x = lerp(a.px, a.x, frac);
      m.z = lerp(a.pz, a.z, frac);
      m.size = a.men.length;
      m.color = colorOf(a.house);
      if (counts.get(m.id) !== a.men.length || !m.label) {
        counts.set(m.id, a.men.length);
        m.label = `${M.houseName(a.house)} · ${a.men.length}`;
      }
      combined.push(m);
    }
    for (const b of data.battles) {
      const m = marker(BATTLE_ID + b.id, 'battle');
      m.x = b.x; m.z = b.z; m.size = 30; m.color = 0xd24b2a;
      m.label = `Battle near ${M.placeName(b.settlement)}`;
      combined.push(m);
    }
    for (const s of data.sieges) {
      const st = M.settlementById.get(s.settlement);
      if (!st) continue;
      const m = marker(SIEGE_ID + s.settlement, 'siege');
      m.x = st.x; m.z = st.z; m.size = 24; m.color = colorOf(s.house);
      m.label = `Siege of ${st.name}`;
      combined.push(m);
    }
    return combined;
  };
  view.setSource('mapMarkers', wrapper);
  return () => view.setSource('mapMarkers', prev);
}
