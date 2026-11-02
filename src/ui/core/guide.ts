// The first-minutes guide: small, dismissable hints about the CONTROLS (clarity pass: what to do is the objectives'
// business — the tracker, "What now?" and the journal), driven by what the player has and has not done yet.
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

export const HINTS: readonly HintDef[] = [
  {
    id: 'move', icon: 'boot', title: 'Walk and look', keys: [k(KEYMAP.input.forward), k(KEYMAP.input.left), k(KEYMAP.input.back), k(KEYMAP.input.right), 'RMB'],
    text: 'Walk about with W A S D (Shift sprints). Hold the right mouse button and drag to turn the camera; the wheel zooms. Your cursor stays free.',
    when: (f) => f.seconds > 2 && f.moved < 8, done: (f) => f.moved >= 8,
  },
  {
    id: 'interact', icon: 'hand', title: 'Point and click', keys: ['LMB', k(KEYMAP.input.interact)],
    text: 'Move the cursor over a person, a door, a strip or a tree: a label says what it is and what a click will do. Click to walk there and do it, or stand close and press E. Hold E for every option.',
    when: (f) => f.moved >= 8 && f.interacted === 0, done: (f) => f.interacted > 0,
  },
  {
    id: 'tasks', icon: 'flag', title: 'What to do', keys: [k(KEYMAP.ui.whatNow), k(KEYMAP.ui.journal)],
    text: 'Your task is written in the top left corner and a gold marker shows where it is. When you do not know what to do, press Y; O opens the journal with everything you could do.',
    link: { label: 'Open the journal', request: { panel: 'journal' } },
    when: (f) => f.seconds > 20 && f.interacted > 0 && !f.opened.has('journal'), done: (f) => f.opened.has('journal'), maxSeconds: 22,
  },
  {
    id: 'time', icon: 'hourglass', title: 'Time is yours', keys: [k(KEYMAP.input.speed1), k(KEYMAP.input.speed2), k(KEYMAP.input.speed3), k(KEYMAP.input.pause)],
    text: 'A day lasts ten minutes; a year is sixteen days. 1, 2 and 3 set the speed (use the fast ones when you are only waiting) and P pauses. Panels pause the world while they are open.',
    when: (f) => f.seconds > 150 && f.worked >= 1 && !f.speedChanged, done: (f) => f.speedChanged, maxSeconds: 20,
  },
  {
    id: 'fight', icon: 'swords', title: 'Steel is out', keys: ['LMB', 'RMB', k(KEYMAP.input.dodge), k(KEYMAP.input.weapon)],
    text: 'The mouse looks around while the weapon is drawn: tap the left button to strike, hold it for a heavy blow, hold the right to guard, Space rolls out of the way. G puts the weapon away; Esc frees the mouse.',
    link: { label: 'Fighting help', request: { panel: 'help', tab: 'combat' } },
    when: (f) => f.engaged && !f.ranged, done: () => false, maxSeconds: 16,
  },
  {
    id: 'bow', icon: 'archery', title: 'Drawing the bow', keys: ['RMB', 'LMB', k(KEYMAP.input.weapon)],
    text: 'Hold the right button to draw: the ring closes and holds steady. Aim the centre of the screen at the target and click the left button to loose. A long shot drops, so aim a little high.',
    when: (f) => f.engaged && f.ranged, done: () => false, maxSeconds: 14,
  },
  {
    id: 'wounds', icon: 'heart', title: 'You are wounded', keys: [k(KEYMAP.ui.character)],
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
