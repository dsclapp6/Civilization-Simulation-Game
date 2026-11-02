// The lord's agenda: a ruler is not sent on errands, he manages. In place of tasks the tracker lists the matters of
// the realm that want a decision — raiders on the lands, the host in the field, works standing idle, no research
// under way, an empty treasury, a place in want — each with the page where it is decided.
import type { GameServices } from '../types';
import type { PanelRequest } from './requests';
import type { IconName } from './icons';

export interface AgendaItem {
  key: string;
  icon: IconName;
  text: string;
  /** 'danger' items glow; the rest are plain. */
  tone: 'danger' | 'warn' | 'info';
  open: PanelRequest;
}

const RULER: PanelRequest = { panel: 'ext', name: 'ruler' };
const BUILD: PanelRequest = { panel: 'ext', name: 'build' };

const coins = (d: number): string => (d >= 240 ? `£${Math.floor(d / 240)}` : d >= 12 ? `${Math.floor(d / 12)}s` : `${Math.round(d)}d`);

/** The matters of the realm for the player, most pressing first (empty when the player rules nothing). */
export function realmAgenda(game: GameServices): AgendaItem[] {
  const sim = game.sim;
  const me = sim.state.run.playerId;
  const R = game.realm;
  if (!R || !R.canRule(me)) return [];
  const v = R.view(me);
  if (!v) return [];
  const lands = new Set(v.settlements);
  const name = (sid: number): string => sim.world.settlements[sid]?.name ?? 'your lands';
  const out: AgendaItem[] = [];

  // raiders and enemies riding on the lands
  const mil = sim.services.military;
  for (const a of mil?.armies() ?? []) {
    const sid = a.target?.settlement;
    if (a.house === v.house || sid === undefined || !lands.has(sid) || (a.task !== 'march' && a.task !== 'raid' && a.task !== 'siege' && a.task !== 'battle')) continue;
    const men = Object.values(a.troops).reduce((s, n) => s + n, 0);
    const what = a.task === 'raid' ? 'Raiders burn' : a.task === 'siege' ? 'An enemy besieges' : a.task === 'battle' ? 'Fighting at' : 'Raiders ride on';
    out.push({ key: `army:${a.id}`, icon: 'swords', tone: 'danger', text: `${what} ${name(sid)} (${men} men): raise the men`, open: RULER });
  }
  // the host in the field
  const phase = game.campaign?.phase();
  if (phase && phase !== 'done') {
    const t = game.campaign!.target();
    out.push({ key: 'campaign', icon: 'flag', tone: phase === 'storm' || phase === 'before' ? 'danger' : 'warn', text: `The host ${phase === 'march' ? 'marches on' : phase === 'storm' ? 'storms' : 'is before'} ${name(t)}: battle command`, open: { panel: 'ext', name: 'battle' } });
  }
  // works standing idle
  const C = game.construction;
  if (C) {
    let idle = 0, first = -1;
    for (const sid of v.settlements) for (const s of C.sites(sid)) {
      if (s.house !== v.house || s.status === 'done' || s.status === 'cancelled') continue;
      if (s.status === 'stalled' || (s.status === 'waiting' && s.workers === 0)) { idle++; if (first < 0) first = s.settlement; }
    }
    if (idle) out.push({ key: 'works', icon: 'hammer', tone: 'warn', text: `${idle} ${idle === 1 ? 'work stands' : 'works stand'} idle at ${name(first)}: set servants to them`, open: BUILD });
  }
  // the treasury
  if (v.treasury < 240) out.push({ key: 'treasury', icon: 'purse', tone: 'warn', text: `The treasury is thin (${coins(v.treasury)}): trade, rents, or less spending`, open: RULER });
  // research
  const busy = R.projects(v.house).some((p) => p.state === 'active' || p.state === 'stalled');
  if (!busy && R.researchOptions(me).length > 0) out.push({ key: 'research', icon: 'book', tone: 'info', text: 'No research under way: set your scholars to work', open: RULER });
  // a place in want
  if (v.prosperity < 0.85) out.push({ key: 'want', icon: 'bread', tone: 'warn', text: `Your people are in want (prosperity ${Math.round(v.prosperity * 100)}%): see to the fields and stores`, open: RULER });
  return out;
}
