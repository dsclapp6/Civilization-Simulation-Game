// The accolade (docs/CIV.md §9), pure: when someone is made a knight — the player (by their liege, by a lord's dubbing, for valour on
// the field) or one of the player's own men — what happened and what the scene card says: the vigil in the church, the accolade.
import { settlementName } from '../../sim/api';
import type { Simulation } from '../../sim/sim';
import type { ChronicleEntry, PersonId } from '../../sim/state';
import { styledName } from './titles';

/** How the knighthood came: for valour on the field, dubbed by one's liege, by a lord, or by the player's own hand. */
export type AccoladeKind = 'valour' | 'liege' | 'lord' | 'player';

export interface AccoladeData {
  kind: AccoladeKind;
  /** Who becomes a knight. */
  knight: PersonId;
  /** Who laid the sword on their shoulders (0 = not known). */
  by: PersonId;
}

export interface AccoladeScene {
  kind: AccoladeKind;
  knight: PersonId;
  /** The knight's name with the honorific ("Sir Godwin Smith"). */
  name: string;
  first: string;
  /** Who dubbed: "Sir Ralph of Dromore", "your liege". */
  by: string;
  place: string;
  title: string;
  /** What is told, one paragraph after another. */
  beats: string[];
  /** The line the scene ends on: "Arise, Sir Godwin." */
  arise: string;
}

/** Is this a knighting (a `careerChanged` event whose new career is knight)? */
export function isKnighting(e: { to: string }): boolean { return e.to === 'knight'; }

/**
 * Reads what the chronicle says about a knighthood just made (the careerChanged event comes a moment before the line is written, so
 * ask a frame later): "X was knighted for valour…", "X has been knighted by his liege", "Y has dubbed X knight".
 */
export function classifyAccolade(chronicle: readonly ChronicleEntry[], knight: PersonId, player: PersonId, fromCareer: string): AccoladeData {
  for (let i = chronicle.length - 1; i >= Math.max(0, chronicle.length - 14); i--) {
    const e = chronicle[i];
    if (e.kind !== 'career' || !e.persons.includes(knight)) continue;
    if (/for valour/i.test(e.text)) return { kind: 'valour', knight, by: 0 };
    if (/by his liege/i.test(e.text)) return { kind: 'liege', knight, by: e.persons.find((p) => p !== knight) ?? 0 };
    if (/dubbed/i.test(e.text)) {
      const dubber = e.persons.find((p) => p !== knight) ?? 0;
      return { kind: dubber === player && knight !== player ? 'player' : 'lord', knight, by: dubber };
    }
  }
  // no line to go by: a sergeant or captain knighted was knighted on the field, anyone else was dubbed
  return { kind: fromCareer === 'sergeant' || fromCareer === 'captain' ? 'valour' : 'lord', knight, by: 0 };
}

/** The scene card for a knighthood: a vigil in the church and the accolade. Null when the person is not known. */
export function accoladeScene(sim: Pick<Simulation, 'state' | 'world'>, data: AccoladeData): AccoladeScene | null {
  const st = sim.state;
  const k = st.persons.get(data.knight);
  if (!k) return null;
  const you = k.id === st.run.playerId;
  const dubber = data.by ? st.persons.get(data.by) : undefined;
  const first = k.first;
  const place = settlementName(sim.world, k.settlement) || 'the district';
  const church = `the church of ${place}`;
  const subj = you ? 'You' : first;
  const poss = you ? 'your' : k.sex === 'f' ? 'her' : 'his';
  const by = dubber ? styledName(dubber) : data.kind === 'valour' ? 'the army’s lord' : data.kind === 'liege' ? (you ? 'your liege' : `${poss} liege`) : 'the lord';
  const vigil = `${subj} kept the vigil through the night, kneeling before the altar with sword and spurs laid on it, bathed and fasting, while the candles burned down.`;
  let title: string;
  const beats: string[] = [];
  switch (data.kind) {
    case 'valour':
      title = you ? 'Knighted on the field' : `${first} is knighted on the field`;
      beats.push(
        `The battle is won, and the field is quiet but for the wounded. The captains look over the day and say that no one fought harder than ${you ? 'you' : first}.`,
        `That night ${you ? 'you' : first} kept the vigil as the knights of the camp do, kneeling by a sword before a cross set up in the chapel tent, fasting and praying.`,
        `At first light the army gathered. ${subj} knelt in the trampled grass and ${by} laid the flat of a sword on ${poss} shoulders.`,
      );
      break;
    case 'liege':
      title = you ? 'Knighted by your liege' : `${first} is knighted by ${poss} liege`;
      beats.push(
        `${subj} rode to court, and ${by} thought well enough of ${you ? 'you' : first} to grant what was asked. At dusk ${you ? 'you' : first} went into ${church}.`,
        vigil,
        `At dawn, with the household looking on, ${by} laid the sword on ${poss} shoulders.`,
      );
      break;
    case 'player':
      title = `You make ${first} a knight`;
      beats.push(
        `${first} came to ${church} at dusk, bathed and in a white shirt, and knelt before the altar with sword and spurs laid on it.`,
        `${first} kept the vigil alone through the night, fasting and praying, while the candles burned down.`,
        `At dawn, with your household looking on, you laid the sword on ${poss} shoulders.`,
      );
      break;
    default:
      title = you ? 'The accolade' : `${first} is dubbed a knight`;
      beats.push(
        `${subj} came to ${church} at dusk, bathed and in a white shirt, and knelt before the altar with sword and spurs laid on it.`,
        vigil,
        `At dawn, with the household looking on, ${by} laid the sword on ${poss} shoulders.`,
      );
  }
  const arise = you || data.kind === 'player' ? `Arise, Sir ${first}.` : `Sir ${first} rises.`;
  return { kind: data.kind, knight: k.id, name: styledName({ ...k, career: 'knight' }), first, by, place, title, beats, arise };
}
