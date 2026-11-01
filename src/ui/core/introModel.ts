// The first minutes (CLARITY §6): the scene-setting paragraph shown after the birth reveal ("Spring. You wake in your
// father's cottage in Dromore; the barley must go in.") and the places the camera visits to show you round — home,
// the family's strip, the church. Built from the run's state; pure (no DOM).
import { BUILDINGS } from '../../content/types';
import { SEASON_NAMES, toDate } from '../../core/time';
import { settlementCard } from '../../sim/api';
import type { BuildingState } from '../../sim/state';
import type { GameServices } from '../types';

export interface TourSpot { kind: 'home' | 'strip' | 'church'; x: number; z: number; label: string; caption: string }

export interface IntroModel {
  /** "Spring, the first day" */
  title: string;
  paragraphs: string[];
  spots: TourSpot[];
}

const SEASON_LINES = [
  'The year has only begun, and the barley must go in before the rain.',
  'The days are long and warm; the hay stands nearly ready for the scythe.',
  'The harvest is ripe in the fields and every hand is wanted.',
  'The frost lies on the thatch, and wood must be fetched before the fire dies.',
] as const;

const CLASS_LINES: Record<string, string> = {
  serf: 'Your family holds its strips of the lord, and pays for them in work and in kind.',
  free: 'Your family works its own strips and answers to nobody but the reeve and the lord.',
  craftsman: 'Your family keeps a workshop, and everyone has a hand in it.',
  merchant: 'Your family lives by buying and selling, and by being believed.',
  gentry: 'Your family is of some standing, and more is expected of you than of the villagers.',
  knightly: 'Your family holds land by knight service, and the sword is not far from the door.',
  baronial: 'Your family holds great lands, and the whole district looks to your house.',
};

const CHURCH_KINDS = new Set(['church', 'abbey_church', 'cathedral', 'chapel']);

/** The nearest church of the place, for the tour. */
function churchOf(game: GameServices, settlement: number, from: { x: number; z: number }): BuildingState | null {
  let best: BuildingState | null = null;
  let bd = Infinity;
  for (const b of game.sim.state.buildingsAt.get(settlement) ?? []) {
    if (!CHURCH_KINDS.has(b.kind)) continue;
    const d = Math.hypot(b.x - from.x, b.z - from.z) - (b.kind === 'church' ? 30 : 0);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

export function introModel(game: GameServices): IntroModel | null {
  const sim = game.sim;
  const st = sim.state;
  const me = st.persons.get(st.run.playerId);
  if (!me) return null;
  const hh = st.households.get(me.household);
  const home = hh ? st.buildings.get(hh.home) : undefined;
  const head = hh ? st.persons.get(hh.head) : undefined;
  const d = toDate(sim.absDay);
  const card = settlementCard(sim, me.settlement);
  const place = card ? card.name : 'the village';
  const where = card ? `${card.name}, ${/^[aeiou]/i.test(card.kind) ? 'an' : 'a'} ${card.kind}${card.county || card.kingdom ? ` in ${card.county || card.kingdom}` : ''}` : place;

  const rel = head && head.id !== me.id ? game.social.relationLabel(me.id, head.id).replace(/^your /, '') : '';
  const parent = rel === 'father' || rel === 'mother';
  const homeWord = home ? (BUILDINGS[home.kind]?.name ?? 'home').toLowerCase() : 'home';
  const whose = parent ? `your ${rel}’s` : head && head.id === me.id ? 'your own' : 'your family’s';
  const wake = `You wake in ${whose} ${homeWord} in ${where}.`;

  const paragraphs = [`${SEASON_NAMES[d.season]}. ${wake} ${SEASON_LINES[d.season]}`];
  const why = game.objectives?.tracked()?.why;
  const classLine = CLASS_LINES[st.run.birthClass];
  paragraphs.push([classLine, why].filter(Boolean).join(' '));
  paragraphs.push('Look about you. Whatever there is to do is written in the top left corner of the screen, and a gold marker shows you where.');

  const spots: TourSpot[] = [];
  if (home) spots.push({ kind: 'home', x: home.x, z: home.z, label: 'Your home', caption: 'Where you eat and sleep. Come back here at dusk.' });
  const holding = hh ? game.economy.holding(hh.id) : null;
  const sid = holding?.strips[0]?.id;
  const strip = sid !== undefined ? sim.world.strips.find((s) => s.id === sid) : undefined;
  if (strip) {
    const cx = strip.poly.reduce((a, q) => a + q.x, 0) / strip.poly.length, cz = strip.poly.reduce((a, q) => a + q.z, 0) / strip.poly.length;
    spots.push({ kind: 'strip', x: cx, z: cz, label: 'Your family’s strip', caption: 'The family’s field. Most of the work, and most of the food, comes from here.' });
  }
  const church = churchOf(game, me.settlement, home ?? { x: 0, z: 0 });
  if (church) spots.push({ kind: 'church', x: church.x, z: church.z, label: church.kind === 'church' ? 'The church' : 'The chapel', caption: 'Mass is said here on holy days, and the village gathers after it.' });

  return { title: `${SEASON_NAMES[d.season]}, the first day`, paragraphs, spots };
}
