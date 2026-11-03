// The lord's agenda: a ruler is not sent on errands, he manages. In place of tasks (chores, goals, the duty of a post) the tracker lists
// the matters of the realm that want his decision, under whatever steps are tracked: raiders on the lands, the host in the field, men too
// few for the threat, works standing idle, fields with no crop named at sowing time, no research under way, a thin treasury, a place in
// want, a petition from a vassal. Each opens the page where it is decided (the ruler's seat on its page, the build page, battle command,
// politics). Dangers come first and glow. Pure: reads the game's services, draws nothing (tests/ui/agenda.test.ts).
import { toDate } from '../../core/time';
import type { GameServices } from '../types';
import type { IconName } from './icons';
import type { PanelRequest } from './requests';

export interface AgendaItem {
  key: string;
  icon: IconName;
  text: string;
  /** 'danger' items glow and come first; the rest are plain. */
  tone: 'danger' | 'warn' | 'info';
  /** The page where it is decided. */
  open: PanelRequest;
}

const seat = (page?: string): PanelRequest => ({ panel: 'ext', name: 'ruler', ...(page ? { data: { page } } : {}) });
const TONE_ORDER = { danger: 0, warn: 1, info: 2 } as const;

const coins = (d: number): string => (d >= 240 ? `£${Math.floor(d / 240)}` : d >= 12 ? `${Math.floor(d / 12)}s` : `${Math.round(d)}d`);
const men = (troops: Readonly<Record<string, number>>): number => Object.values(troops).reduce((s, n) => s + n, 0);

interface Forces { retinue?: number; garrison?: number; afield?: number }
interface PetitionLike { id: number; from: number; kind: string; place: number }
type ExtMilitary = { forces?(house: number): Forces };
type ExtPolitics = { petitions?(person: number): readonly PetitionLike[] };

/** Does this person rule anything (so that he has an agenda)? */
export function rules(game: GameServices): boolean {
  const R = game.realm;
  return !!R && R.canRule(game.sim.state.run.playerId);
}

/** The matters of the realm for the player, most pressing first (empty when the player rules nothing). */
export function realmAgenda(game: GameServices): AgendaItem[] {
  const sim = game.sim;
  const me = sim.state.run.playerId;
  const R = game.realm;
  if (!R || !R.canRule(me)) return [];
  const v = R.view(me);
  if (!v) return [];
  const lands = new Set([...v.settlements, ...v.vassalSettlements]);
  const name = (sid: number): string => sim.world.settlements[sid]?.name ?? 'your lands';
  const out: AgendaItem[] = [];

  // raiders and enemies on the lands; the host of the House in the field
  const mil = sim.services.military;
  const ext = mil as unknown as ExtMilitary | undefined;
  let hostile = 0;
  for (const a of mil?.armies() ?? []) {
    const sid = a.target?.settlement;
    const live = a.task === 'march' || a.task === 'raid' || a.task === 'siege' || a.task === 'battle';
    if (a.house === v.house) {
      if (live) {
        const t = sid !== undefined ? name(sid) : 'the field';
        const verb = a.task === 'march' ? 'marches on' : a.task === 'siege' ? 'besieges' : a.task === 'battle' ? 'is fighting at' : 'is raiding';
        out.push({ key: `host:${a.id}`, icon: 'flag', tone: a.task === 'siege' || a.task === 'battle' ? 'danger' : 'warn', text: `Your host (${men(a.troops)} men) ${verb} ${t}: battle command`, open: { panel: 'ext', name: a.task === 'siege' || a.task === 'battle' ? 'battle' : 'army' } });
      }
      continue;
    }
    if (sid === undefined || !lands.has(sid) || !live) continue;
    const n = men(a.troops);
    hostile += n;
    const what = a.task === 'raid' ? 'Raiders burn' : a.task === 'siege' ? 'An enemy besieges' : a.task === 'battle' ? 'Fighting at' : 'Raiders ride on';
    out.push({ key: `army:${a.id}`, icon: 'swords', tone: 'danger', text: `${what} ${name(sid)} (${n} men): raise the men`, open: seat('military') });
  }
  // men too few for the threat
  if (hostile > 0 && ext?.forces) {
    const f = ext.forces(v.house);
    const ours = (f.retinue ?? 0) + (f.garrison ?? 0);
    if (ours < hostile) out.push({ key: 'few', icon: 'shield', tone: 'danger', text: `Your men are fewer than the raiders (${ours} against ${hostile}): raise more`, open: seat('military') });
  }
  // works standing idle
  const C = game.construction;
  if (C) {
    let idle = 0, first = -1;
    for (const sid of v.settlements) for (const s of C.sites(sid)) {
      if (s.house !== v.house || s.status === 'done' || s.status === 'cancelled') continue;
      if (s.status === 'stalled' || (s.status === 'waiting' && s.workers === 0)) { idle++; if (first < 0) first = s.settlement; }
    }
    if (idle) out.push({ key: 'works', icon: 'hammer', tone: 'warn', text: `${idle} ${idle === 1 ? 'work stands' : 'works stand'} idle at ${name(first)}: see to the labour and the goods`, open: { panel: 'ext', name: 'builder' } });
  }
  // fields with no crop named, when the sowing is at hand (autumn: winter corn; spring: the spring crop)
  const season = toDate(sim.absDay).season;
  if (R.cropPlanView) {
    let bare = 0, at = -1;
    for (const sid of v.settlements) for (const l of R.cropPlanView(sid)) {
      if (l.planned === 'fallow' && ((l.next === 'winter' && season === 2) || (l.next === 'spring' && season === 0))) { bare++; if (at < 0) at = sid; }
    }
    if (bare) out.push({ key: 'fields', icon: 'farming', tone: 'info', text: `${bare === 1 ? 'A field' : `${bare} fields`} at ${name(at)} ${bare === 1 ? 'has' : 'have'} no crop named for the sowing`, open: seat('fields') });
  }
  // the treasury
  if (v.treasury < 240) out.push({ key: 'treasury', icon: 'purse', tone: 'warn', text: `The treasury is thin (${coins(v.treasury)}): trade, rents, or less spending`, open: seat('overview') });
  // research
  const busy = R.projects(v.house).some((p) => p.state === 'active' || p.state === 'stalled');
  if (!busy && R.researchOptions(me).length > 0) out.push({ key: 'research', icon: 'book', tone: 'info', text: 'No research under way: set your scholars to work', open: seat('research') });
  // a place in want
  if (v.prosperity < 0.85) out.push({ key: 'want', icon: 'bread', tone: 'warn', text: `Your people are in want (prosperity ${Math.round(v.prosperity * 100)}%): see to the fields and stores`, open: seat('fields') });
  // a petition from a vassal or a subject
  const pol = sim.services.politics as unknown as ExtPolitics | undefined;
  const pets = pol?.petitions?.(me) ?? [];
  if (pets.length) {
    const from = sim.state.persons.get(pets[0].from);
    out.push({ key: 'petition', icon: 'quill', tone: 'info', text: `${pets.length === 1 ? 'A petition waits' : `${pets.length} petitions wait`}${from ? ` (${from.first} asks first)` : ''}: grant, refuse or compromise`, open: { panel: 'ext', name: 'politics', data: { tab: 'petitions' } } });
  }
  return out.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]);
}
