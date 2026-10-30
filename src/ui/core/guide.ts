// The first-minutes guide: small, dismissable hints driven by what the player has and has not done yet.
// Pure model (no DOM, no sim): `HINTS` say when each one applies and when it has been answered; `pickHint`
// chooses the one to show. The card that shows it lives in hud/guide.ts.
import { KEYMAP } from '../../player/types';
import type { IconName } from './icons';
import type { PanelRequest } from './requests';
import { keyLabel } from './controls';

export interface GuideFacts {
  /** Seconds of play (UI clock) since the run was entered. */
  seconds: number;
  /** Metres walked on foot since then. */
  moved: number;
  /** Age in years of the character (fractional). */
  age: number;
  careerChosen: boolean;
  /** Timed actions the player has finished (reaping, hauling…). */
  worked: number;
  /** Things the player has done with E: actions begun, talks held. */
  interacted: number;
  /** Panel ids that have been opened this run. */
  opened: ReadonlySet<string>;
  needs: { hunger: number; rest: number; warmth: number; mood: number };
  holyDay: boolean;
  /** The weapon is out (a fight is on). */
  engaged: boolean;
  ranged: boolean;
  wounded: boolean;
  speedChanged: boolean;
  /** On the road or otherwise not walking the streets. */
  travelling: boolean;
  /** Money in pence. */
  money: number;
}

export interface HintDef {
  id: string;
  icon: IconName;
  title: string;
  text: string;
  /** Key caps shown on the card. */
  keys?: string[];
  link?: { label: string; request: PanelRequest };
  /** Does it apply now? */
  when(f: GuideFacts): boolean;
  /** Has the player done what it asked? (Then it goes away by itself.) */
  done(f: GuideFacts): boolean;
  /** Shown at most this many seconds, then counted as seen. */
  maxSeconds?: number;
}

const k = keyLabel;
const LOW = 0.38;

export const HINTS: readonly HintDef[] = [
  {
    id: 'move', icon: 'boot', title: 'Find your feet', keys: [k(KEYMAP.input.forward), k(KEYMAP.input.left), k(KEYMAP.input.back), k(KEYMAP.input.right)],
    text: 'Walk about with W A S D. Click the view to take the mouse and look around (Esc gives it back). Hold Shift to sprint.',
    when: (f) => f.seconds > 2 && f.moved < 8, done: (f) => f.moved >= 8,
  },
  {
    id: 'interact', icon: 'hand', title: 'Lend a hand', keys: [k(KEYMAP.input.interact)],
    text: 'Walk up to something or someone: the prompt at the bottom names what E will do. Hold E to see every option. At twelve, your best use is to help the household.',
    when: (f) => f.moved >= 8 && f.interacted === 0, done: (f) => f.interacted > 0,
  },
  {
    id: 'work', icon: 'farming', title: 'Work earns',
    text: 'Reaping, hauling, tending beasts and fetching water earn your keep, a few pence of your own and skill. Keep at a job: it repeats in bouts until you walk away or press Q.',
    keys: [k(KEYMAP.input.cancel)],
    when: (f) => f.interacted > 0 && f.worked === 0 && f.seconds > 25, done: (f) => f.worked >= 1,
  },
  {
    id: 'character', icon: 'user', title: 'See how you grow', keys: [k(KEYMAP.ui.character), k(KEYMAP.ui.inventory)],
    text: 'Work trains skills and every fifth level offers a perk. Tab shows your stats and skills; I your purse and belongings.',
    link: { label: 'Open the character page', request: { panel: 'character' } },
    when: (f) => f.worked >= 2, done: (f) => f.opened.has('character'),
  },
  {
    id: 'hunger', icon: 'bread', title: 'You are hungry', keys: [k(KEYMAP.ui.inventory)],
    text: 'Eat before the hunger turns to weakness: open your inventory and eat what you carry, or find the household’s food. Bread and ale keep a peasant going.',
    link: { label: 'Open inventory', request: { panel: 'inventory' } },
    when: (f) => f.needs.hunger < LOW, done: (f) => f.needs.hunger >= LOW + 0.1, maxSeconds: 25,
  },
  {
    id: 'rest', icon: 'moon_z', title: 'You are tired', keys: [k(KEYMAP.ui.rest)],
    text: 'Go home and sleep: at your own door the wheel offers Sleep until dawn, and Z lets you sleep or wait anywhere you are safe.',
    link: { label: 'Sleep or wait…', request: { panel: 'rest' } },
    when: (f) => f.needs.rest < LOW, done: (f) => f.needs.rest >= LOW + 0.1, maxSeconds: 25,
  },
  {
    id: 'warmth', icon: 'flame', title: 'You are cold',
    text: 'Get indoors, by a hearth, or put on warmer clothes. Winter is hard on a child in a thin tunic.',
    when: (f) => f.needs.warmth < LOW, done: (f) => f.needs.warmth >= LOW + 0.1, maxSeconds: 20,
  },
  {
    id: 'time', icon: 'hourglass', title: 'Time is yours', keys: [k(KEYMAP.input.speed1), k(KEYMAP.input.speed2), k(KEYMAP.input.speed3), k(KEYMAP.input.pause)],
    text: 'A day is a minute; a year is sixteen days. 1, 2 and 3 set the speed (use the fast ones when you are only waiting) and P pauses. Panels pause the world while they are open.',
    when: (f) => f.seconds > 100 && f.worked >= 1 && !f.speedChanged, done: (f) => f.speedChanged, maxSeconds: 20,
  },
  {
    id: 'map', icon: 'map', title: 'Beyond the village', keys: [k(KEYMAP.ui.map)],
    text: 'M opens the map of the land. Pick a town and travel there: you ride the roads at speed, and may meet travellers, patrols or worse on the way.',
    link: { label: 'Open the map', request: { panel: 'map' } },
    when: (f) => f.seconds > 190 && f.worked >= 2, done: (f) => f.opened.has('map'), maxSeconds: 25,
  },
  {
    id: 'holy', icon: 'cross_holy', title: 'A holy day',
    text: 'On the fourth day of every season the village goes to Mass; afterwards men and youths practise archery at the butts. It is the cheapest way to learn the bow, and a skilled archer is worth a lord’s notice.',
    when: (f) => f.holyDay && f.seconds > 40 && f.worked >= 1 && !f.engaged, done: () => false, maxSeconds: 18,
  },
  {
    id: 'career', icon: 'signpost', title: 'Soon you must choose', keys: [k(KEYMAP.ui.character)],
    text: 'At fourteen a youth takes up a trade, goes into service, the Church or arms. See which fields are open to you and what each asks of you: Character, then Career paths.',
    link: { label: 'See the career paths', request: { panel: 'character' } },
    when: (f) => f.age >= 13.4 && !f.careerChosen && !f.travelling, done: (f) => f.opened.has('career'), maxSeconds: 40,
  },
  {
    id: 'fight', icon: 'swords', title: 'Steel is out', keys: ['LMB', 'RMB', k(KEYMAP.input.dodge)],
    text: 'Tap the left button to strike, hold it for a heavy blow. Hold the right button to guard. Space rolls out of the way. Watch your stamina, and your blood: wounds do not simply heal at once.',
    link: { label: 'Fighting help', request: { panel: 'help', tab: 'combat' } },
    when: (f) => f.engaged && !f.ranged, done: () => false, maxSeconds: 14,
  },
  {
    id: 'bow', icon: 'archery', title: 'Drawing the bow', keys: ['RMB', 'LMB'],
    text: 'Hold the right button to draw: the ring closes and holds steady. Aim the centre of the screen at the target and click the left button to loose. A long shot drops, so aim a little high.',
    when: (f) => f.engaged && f.ranged, done: () => false, maxSeconds: 14,
  },
  {
    id: 'wounds', icon: 'heart', title: 'You are wounded', keys: [k(KEYMAP.ui.wounds)],
    text: 'Bleeding wounds must be bound or the blood runs out. Open the Wounds page and bind them; rest and food do the rest, and a healer helps.',
    link: { label: 'Open Wounds', request: { panel: 'ext', name: 'wounds' } },
    when: (f) => f.wounded && !f.engaged, done: (f) => f.opened.has('wounds'), maxSeconds: 30,
  },
  {
    id: 'help', icon: 'help', title: 'Everything is written down', keys: [k(KEYMAP.ui.help)],
    text: 'F1 opens the help pages (all the keys, how to fight, lords and wars) at any time. You can turn these hints off in the settings.',
    when: (f) => f.seconds > 330 && f.worked >= 3, done: (f) => f.opened.has('help'), maxSeconds: 20,
  },
];

/** The hint to show now: the first applicable one that is not already answered or seen. */
export function pickHint(f: GuideFacts, seen: ReadonlySet<string>): HintDef | null {
  for (const h of HINTS) {
    if (seen.has(h.id)) continue;
    // in a fight only the fighting hints speak
    if (f.engaged && h.id !== 'fight' && h.id !== 'bow') continue;
    if (h.when(f)) return h;
  }
  return null;
}
