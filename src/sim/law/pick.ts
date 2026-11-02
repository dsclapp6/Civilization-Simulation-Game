// Who rides: the lord's men for a patrol — a knight or sergeant with one to three men from the castle, manor or watch of the land
// (CIV §4). A pure choice from the state (by hash, never the random streams), so asking twice gives the same men.
import { hash01 } from '../../core/math';
import type { HouseId, Person, PersonId } from '../state';
import { LAW, LAW_OFFICES, LEADER_ORDER } from './config';
import type { Law } from './context';

export interface Squad {
  leader: PersonId;
  men: PersonId[];
  /** Which of them ride (the lord keeps horses for so many). */
  mounted: PersonId[];
  /** The settlement they come from. */
  from: number;
}

/** Is this person fit and free to be sent after a trespasser? */
function fit(L: Law, p: Person, busy: ReadonlySet<PersonId>): boolean {
  if (p.death || busy.has(p.id) || p.flags.captive || p.flags.outlaw || p.flags.player || p.id === L.playerId) return false;
  if (p.estate === 'clergy' || p.sex !== 'm') return false;
  const age = L.age(p);
  if (age < 17 || age > 58 || p.health.hp < 0.5) return false;
  return !L.combat?.isFighting(p.id);
}

function rankOf(p: Person): number {
  const i = LEADER_ORDER.indexOf(p.career);
  if (i >= 0) return LEADER_ORDER.length - i;
  return p.offices.some((o) => LAW_OFFICES.has(o.office)) ? 1 : 0;
}

/** The horses a household keeps (the economy's holding), 0 when it cannot say. */
function horsesOf(L: Law, p: Person): number {
  try { return L.economy?.holding(p.household)?.livestock.horse ?? 0; } catch { return 0; }
}

/**
 * Chooses the squad for a trespass on `settlement`'s lands held by `house`. The pool is the settlement's own people (and, when it
 * keeps no soldiers, the nearest places of the same House); `seed` varies the choice between cases; `near` is an armed man who has
 * seen the trespass himself and leads if he is fit. Null when there is nobody to send.
 */
export function pickSquad(
  L: Law, settlement: number, house: HouseId,
  opts: { seed: number; hostile: boolean; busy?: ReadonlySet<PersonId>; near?: PersonId },
): Squad | null {
  const busy = opts.busy ?? new Set<PersonId>();
  const pools: Array<{ settlement: number; people: Person[] }> = [{ settlement, people: L.state.residentList(settlement) }];
  const armedCount = (list: Person[]): number => list.filter((p) => L.armed(p)).length;
  if (armedCount(pools[0].people) < 2 && house) {
    // few soldiers at home: the nearest places of the same House send men (the barony's castle, the neighbouring manor)
    const from = L.world.settlements.find((s) => s.id === settlement);
    if (from) {
      const near = L.world.settlements
        .filter((s) => s.id !== settlement && L.houseOf(s.id) === house && Math.hypot(s.x - from.x, s.z - from.z) < 4500)
        .sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z) || a.id - b.id)
        .slice(0, 3);
      for (const s of near) pools.push({ settlement: s.id, people: L.state.residentList(s.id) });
    }
  }
  const candidates: Array<{ p: Person; from: number }> = [];
  // the lord has better things to do than ride after a poacher: he goes only when there is nobody else
  const lordId = L.lordOf(settlement);
  let lordHimself: { p: Person; from: number } | null = null;
  for (const pool of pools) {
    for (const p of pool.people) {
      if (!fit(L, p, busy)) continue;
      if (p.id === lordId && lordId !== 0) { lordHimself = { p, from: pool.settlement }; continue; }
      candidates.push({ p, from: pool.settlement });
    }
  }
  if (candidates.length === 0 && lordHimself) candidates.push(lordHimself);
  if (candidates.length === 0) return null;

  // leader: the witness if he is armed and fit, else the best of the lord's armed men, else an officer, else the strongest man
  const armed = candidates.filter((c) => L.armed(c.p));
  const officers = candidates.filter((c) => rankOf(c.p) > 0);
  const byRank = (a: { p: Person }, b: { p: Person }): number => rankOf(b.p) - rankOf(a.p) || hash01(opts.seed, a.p.id) - hash01(opts.seed, b.p.id) || a.p.id - b.p.id;
  let leader = opts.near ? candidates.find((c) => c.p.id === opts.near) : undefined;
  if (!leader) leader = [...(armed.length ? armed : officers)].sort(byRank)[0];
  if (!leader) leader = [...candidates].sort((a, b) => b.p.trained.str - a.p.trained.str || a.p.id - b.p.id)[0];
  if (!leader) return null;

  const want = Math.max(LAW.menMin, Math.min(LAW.menMax, LAW.menMin + Math.floor(hash01(opts.seed, 77) * (LAW.menMax - LAW.menMin + 1)) + (opts.hostile ? 1 : 0)));
  const rest = candidates.filter((c) => c.p.id !== leader!.p.id);
  const sameBase = rest.filter((c) => c.from === leader!.from);
  const order = (list: typeof rest): typeof rest => [...list].sort((a, b) => Number(L.armed(b.p)) - Number(L.armed(a.p)) || hash01(opts.seed, a.p.id, 3) - hash01(opts.seed, b.p.id, 3) || a.p.id - b.p.id);
  const men = [...order(sameBase), ...order(rest.filter((c) => c.from !== leader!.from))].slice(0, want).map((c) => c.p.id);
  if (men.length === 0 && !L.armed(leader.p)) return null;

  // the lord keeps horses: so many of them ride
  const lord = L.person(L.lordOf(settlement));
  const horses = Math.max(horsesOf(L, leader.p), lord ? horsesOf(L, lord) : 0);
  const all = [leader.p.id, ...men];
  const mounted = all.slice(0, Math.max(0, Math.min(all.length, horses)));
  return { leader: leader.p.id, men, mounted, from: leader.from };
}
