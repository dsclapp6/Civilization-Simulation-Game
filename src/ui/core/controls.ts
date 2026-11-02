// The controls and first-steps text of the Help page (SPEC §22), kept as data so a test can check it against
// KEYMAP and the page and the docs say the same thing.
import { KEYMAP } from '../../player/types';

export interface ControlRow { keys: string[]; what: string }
export interface ControlGroup { title: string; rows: ControlRow[] }

/** Human names for KeyboardEvent codes the keymap uses. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  switch (code) {
    case 'ShiftLeft': case 'ShiftRight': return 'Shift';
    case 'Space': return 'Space';
    case 'Escape': return 'Esc';
    default: return code;
  }
}

const K = KEYMAP;
const k = keyLabel;

export const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    title: 'Moving',
    rows: [
      { keys: [k(K.input.forward), k(K.input.left), k(K.input.back), k(K.input.right)], what: 'Walk, relative to the camera (the arrow keys work too). The default gait is a jog.' },
      { keys: [k(K.input.sprint)], what: 'Sprint; it costs stamina. On a horse: gallop.' },
      { keys: [k(K.input.walk)], what: 'Toggle a slow walk.' },
      { keys: [k(K.input.dodge)], what: 'Dodge roll (costs stamina).' },
      { keys: ['Mouse'], what: 'The cursor is free: point at a person, door, strip or tree and a label says what it is and what a click will do.' },
      { keys: ['LMB'], what: 'Click a thing to walk there (along the paths) and do its default action. Any movement key stops you.' },
      { keys: ['RMB'], what: 'Hold and drag to turn the camera: the cursor comes back where it was when you let go.' },
      { keys: ['Wheel'], what: 'Zoom the camera. Far out it becomes the map of the land.' },
      { keys: [k(K.input.mount)], what: 'Mount or dismount your household’s horse.' },
    ],
  },
  {
    title: 'Doing',
    rows: [
      { keys: [k(K.input.interact)], what: 'Tap: the default action on what you face (the prompt tells you which); the same as clicking it.' },
      { keys: ['Hold ' + k(K.input.interact)], what: 'The action wheel: every option on the target, with the reasons for the greyed ones.' },
      { keys: [k(K.input.cancel)], what: 'Stop the work you are doing (walking away stops it too).' },
      { keys: [k(K.ui.rest)], what: 'Sleep or wait until a time you choose.' },
      { keys: [k(K.ui.whatNow)], what: 'What now? The next step of your task and what else is worth doing; choose one to be shown the way.' },
      { keys: [k(K.ui.journal)], what: 'The journal: your tasks, what kind of day it is, the people you know and the places (each with Find).' },
      { keys: [k(K.ui.minimap)], what: 'Show or hide the minimap in the corner.' },
    ],
  },
  {
    title: 'Fighting',
    rows: [
      { keys: [k(K.input.weapon)], what: 'Draw or put away your weapon. While it is drawn the mouse looks around; a fight draws it by itself. Esc frees the mouse.' },
      { keys: ['LMB'], what: 'Strike (weapon drawn). A tap is a quick blow; hold it for a heavy overhead stroke. The click that takes the mouse is never a blow.' },
      { keys: ['RMB'], what: 'Guard with a weapon or shield (weapon drawn). With a bow: draw and aim along the camera.' },
      { keys: ['RMB then LMB'], what: 'Bow: hold RMB to draw, click LMB to loose. The reticle in the middle of the screen is where the arrow goes.' },
      { keys: [k(K.input.dodge)], what: 'Roll out of a blow; for a moment nothing can touch you.' },
      { keys: [k(K.input.sprint), 'LMB'], what: 'On a horse with a lance: gallop at someone and hold LMB to couch the lance.' },
    ],
  },
  {
    title: 'Time',
    rows: [
      { keys: [k(K.input.speed1), k(K.input.speed2), k(K.input.speed3)], what: 'Game speed 1×, 3×, 8× (refused while an enemy is close).' },
      { keys: [k(K.input.pause)], what: 'Pause.' },
    ],
  },
  {
    title: 'Books and pages',
    rows: [
      { keys: [k(K.ui.character)], what: 'Character: stats, skills, perks.' },
      { keys: [k(K.ui.inventory)], what: 'Inventory and equipment.' },
      { keys: [k(K.ui.family)], what: 'Family tree, household and House.' },
      { keys: [k(K.ui.ledger)], what: 'Ledger: holdings, dues, property, authority.' },
      { keys: [k(K.ui.map)], what: 'The map: pick a place and travel there.' },
      { keys: [k(K.ui.chronicle)], what: 'The chronicle of your House and the land.' },
      { keys: [k(K.ui.journal)], what: 'The journal: tasks, today, the people you know, places.' },
      { keys: [k(K.ui.requests)], what: 'Requests and news: favours people have asked of you.' },
      { keys: [k(K.ui.wounds)], what: 'Wounds: what the blows left, and bind them.' },
      { keys: [k(K.ui.techs)], what: 'House techniques: what your House knows.' },
      { keys: [k(K.ui.ruler)], what: 'The ruler’s seat: your lands and purse, the crop of each field, labour for your works, research, raising and knighting men, trade orders, rivals.' },
      { keys: [k(K.ui.politics)], what: 'Realm and politics: Houses, wars, claims, offices.' },
      { keys: [k(K.ui.command)], what: 'Command and army (the household page of the ledger when you have no troops).' },
      { keys: [k(K.ui.help)], what: 'This help.' },
      { keys: [k(K.ui.menu)], what: 'Leave mouse-look; else close the top page; with nothing open, the pause menu.' },
    ],
  },
  {
    title: 'Inside pages',
    rows: [
      { keys: ['← →'], what: 'Switch the tab of a page (or 1–9).' },
      { keys: ['↑ ↓', 'PgUp', 'PgDn'], what: 'Move down a list or scroll.' },
      { keys: ['Enter'], what: 'Confirm; with a notice showing at the top of the screen, open the page it points to.' },
    ],
  },
];

export interface HelpSection { title: string; paragraphs: string[] }

export const BASICS: readonly HelpSection[] = [
  {
    title: 'The first days',
    paragraphs: [
      'You begin as a child of twelve in a peasant household. Nobody expects glory of you yet: be useful. Your task is written in the top left corner of the screen, with the next step and how to do it; a gold marker in the world, the compass ribbon at the top and the minimap show where it is. Y asks “what now?” whenever you are lost; O opens the journal.',
      'Point the cursor at something: its name and what a click will do appear beside it. Click to walk there and do it, or stand close and press E. Reaping, hauling, tending beasts and fetching water earn the household’s keep, a few pence of your own, and skill that you will need later.',
      'Watch the four little signs under your name: hunger, rest, warmth and mood. A gold sign means you will soon need to eat, sleep, get warm or cheer up; a red one means now. Z sleeps; the bread in your inventory (I) feeds you.',
      'A day lasts ten minutes at normal speed (about seven of them in daylight) and a year is sixteen days. Do not hurry: use 3× or 8× when you are only waiting, and drop to 1× when you work or fight. When you sleep, the day is written up: what you did, what it earned and what tomorrow holds.',
    ],
  },
  {
    title: 'Growing up',
    paragraphs: [
      'At fourteen you choose a field: the Career page (the Career paths button on the Character page, Tab, or Think about your career in the action wheel) lists the trades, the Church, the army and service that your birth allows. Each rewards different skills; practice at the work raises them, and every fifth level offers a perk.',
      'On holy days (the fourth day of each season) men and youths practise archery at the butts after Mass. It is the cheapest way to learn the bow.',
      'You may talk to anybody. Opinion matters: people who like you will trade fairly, marry you, speak for you and take your side in a quarrel.',
    ],
  },
  {
    title: 'Money, land and the House',
    paragraphs: [
      'Coin is pence, shillings (12 pence) and pounds (20 shillings). Your household’s holdings, its dues to the lord and what you own are in the Ledger (J). Your family and the House that bears your name are on H.',
      'When you die the story goes on: choose an heir or a relation from the death screen and play on as them. Only when nobody is left does the run end, and your Legacy gold carries over.',
    ],
  },
];

export const COMBAT_HELP: readonly HelpSection[] = [
  {
    title: 'Blows and guards',
    paragraphs: [
      'There is no health bar that refills: blows leave wounds, and wounds bleed, fester and mend over days. The red drop under your health shows the blood you have left; bind your wounds on the Wounds page (B) or ask a healer. Stamina pays for every swing, guard and roll: when you are out of breath you can only walk.',
      'Tap the left mouse button for a quick blow, hold it for a heavy one that costs more breath. Hold the right button to guard; a shield helps a great deal, and armour turns edges. Space rolls out of the way.',
    ],
  },
  {
    title: 'Bows',
    paragraphs: [
      'With a bow or crossbow in hand, hold the right button to draw. A ring closes on the reticle as the string comes back; at the centre the aim is steady and holding on tires the arm. Click the left button to loose. Arrows drop over distance: aim a little high at a far target.',
    ],
  },
  {
    title: 'When you are down',
    paragraphs: [
      'A heavy blow can knock you down. While you lie there you cannot act; bleeding goes on. Friends, a lord’s men or the enemy’s mercy may decide how it ends. A yielded noble is held for ransom rather than killed.',
    ],
  },
];

export const REALM_HELP: readonly HelpSection[] = [
  {
    title: 'Lords, wars and levies',
    paragraphs: [
      'When your lord goes to war he calls the levy: every man from fifteen to sixty on his manors. A notice tells you; open Command and army (C) and march to the muster or refuse and pay for it. In an army you fight where your rank puts you, and your rank decides whom you command.',
      'Raiders burn villages and carry off herds and people; castles and walled towns are besieged and starved or stormed. Stay near the walls when armies are about.',
    ],
  },
  {
    title: 'Politics and techniques',
    paragraphs: [
      'The Realm page (K) shows where your House stands: its liege, vassals, claims, wars and the letters that reach you. Posts such as reeve or alderman are filled by election or appointment; you may stand for them. What you may command grows with your station: a household, a manor, a barony, a crown.',
      'Techniques live in people, not in books alone: the House tree (T) shows what your House knows and how to learn the next. Practise a craft or study at a school and the knowledge is yours; if its last master dies it can be lost.',
    ],
  },
  {
    title: 'Requests',
    paragraphs: [
      'People will ask you for things: a fetched sack, a quarrel settled, a debt. The Requests page (R) is your journal of them; a dot on its dock button means somebody waits. Doing right by people earns opinion, pence and points.',
    ],
  },
];
