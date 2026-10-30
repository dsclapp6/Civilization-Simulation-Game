// Notices: what the simulation's wave 3 events mean to the player, as toasts that open the right page.
// Pure mappers (no DOM, no sim): the controller hands in a small context of lookups. A notice is a toast with
// an action; Enter takes the most recent one (see Toasts.pendingAction), so a request never needs the mouse.
import type { SimEvents } from '../../sim/events';
import type { ToastInput } from './feed';
import type { IconName } from './icons';
import type { PanelRequest } from './requests';

export interface NoticeCtx {
  /** The player's own settlement (home), or 0. */
  homeSettlement: number;
  /** Is this House the player's, or the player's liege or vassal (the player has a stake in its wars)? */
  houseConcerns(house: number): boolean;
  houseName(house: number): string;
  placeName(settlement: number): string;
  /** Which page a `request` event belongs on: the journal (a villager), the letters (a House) or the petitions (a tenant). */
  requestPage(e: SimEvents['request']): 'journal' | 'letters' | 'petitions' | null;
}

const politics = (tab: string): PanelRequest => ({ panel: 'ext', name: 'politics', data: { tab } });

export function noticeForRequest(e: SimEvents['request'], ctx: NoticeCtx): ToastInput | null {
  const page = ctx.requestPage(e);
  if (!page) return null;
  if (page === 'journal') {
    return { tone: 'gold', icon: 'quill', title: 'Someone asks a favour', text: e.text, ttl: 12, key: `req:${e.id}`, action: { label: 'Open the journal', request: { panel: 'ext', name: 'requests' } } };
  }
  if (page === 'letters') {
    return { tone: 'gold', icon: 'scroll', title: 'A letter has come', text: e.text, ttl: 14, key: `letter:${e.id}`, action: { label: 'Read the letters', request: politics('standing') } };
  }
  return { tone: 'gold', icon: 'quill', title: 'A tenant petitions you', text: e.text, ttl: 14, key: `petition:${e.id}`, action: { label: 'See the petitions', request: politics('petitions') } };
}

export function noticeForWar(e: SimEvents['war'], ctx: NoticeCtx): ToastInput | null {
  const mine = [...e.attackers, ...e.defenders].some((h) => ctx.houseConcerns(h));
  if (!mine) return null;
  const att = e.attackers.map((h) => `House ${ctx.houseName(h)}`).slice(0, 2).join(' and ');
  const def = e.defenders.map((h) => `House ${ctx.houseName(h)}`).slice(0, 2).join(' and ');
  if (e.phase === 'declared') {
    return { tone: 'vermilion', icon: 'swords', title: 'War is declared', text: `${att} against ${def}.`, ttl: 12, key: `war:${e.war}`, action: { label: 'See the wars', request: politics('wars') } };
  }
  const how = e.winner === 'attackers' ? `${att} prevail` : e.winner === 'defenders' ? `${def} prevail` : 'a white peace is made';
  return { tone: 'lapis', icon: 'scroll', title: 'The war is over', text: `${how}.`, ttl: 9, key: `war:${e.war}:end`, action: { label: 'See the wars', request: politics('wars') } };
}

export function noticeForSiege(e: SimEvents['siege'], ctx: NoticeCtx): ToastInput | null {
  const near = e.settlement === ctx.homeSettlement;
  if (!near && !ctx.houseConcerns(e.besieger)) return null;
  const place = ctx.placeName(e.settlement);
  const act = { label: 'Command and army', request: { panel: 'ext', name: 'army' } as PanelRequest };
  switch (e.phase) {
    case 'start': return { tone: 'vermilion', icon: 'castle', title: near ? `${place} is besieged` : `Siege of ${place}`, text: `${ctx.houseName(e.besieger)}'s army has closed the roads.`, ttl: 12, key: `siege:${e.settlement}`, action: act };
    case 'fell': return { tone: 'vermilion', icon: 'castle', title: `${place} has fallen`, text: `The gates open to ${ctx.houseName(e.besieger)}.`, ttl: 12, key: `siege:${e.settlement}:fell`, action: act };
    default: return { tone: 'lapis', icon: 'castle', title: `The siege of ${place} is lifted`, ttl: 8, key: `siege:${e.settlement}:lift` };
  }
}

export function noticeForRaid(e: SimEvents['raid'], ctx: NoticeCtx): ToastInput | null {
  if (e.settlement !== ctx.homeSettlement) return null;
  const bits: string[] = [];
  if (e.burned > 0) bits.push(`${e.burned} ${e.burned === 1 ? 'building' : 'buildings'} burned`);
  if (e.stolen > 0) bits.push('herds and stores taken');
  if (e.captives > 0) bits.push(`${e.captives} taken captive`);
  return { tone: 'vermilion', icon: 'flame', title: `Raiders at ${ctx.placeName(e.settlement)}`, text: bits.length ? bits.join(', ') + '.' : 'Armed men ride through the fields.', ttl: 12, key: `raid:${e.settlement}` };
}

export function noticeForBattle(e: SimEvents['battle'], ctx: NoticeCtx): ToastInput | null {
  if (!e.playerPresent && !ctx.houseConcerns(e.attacker) && !ctx.houseConcerns(e.defender)) return null;
  const side = e.attackerWon ? e.attacker : e.defender;
  return {
    tone: 'vermilion', icon: 'swords', title: `Battle near ${ctx.placeName(e.settlement)}`,
    text: `${ctx.houseName(side)} holds the field; ${e.dead} dead.`, ttl: 10, key: `battle:${e.war}:${e.settlement}`,
  };
}

const HAPPENING_NOTICE: Record<string, { icon: IconName; title: string }> = {
  plague: { icon: 'skull', title: 'Plague' }, famine: { icon: 'warning', title: 'Famine' }, fire: { icon: 'flame', title: 'Fire' },
  fair: { icon: 'bell', title: 'A fair' }, peasant_revolt: { icon: 'swords', title: 'Revolt' }, revolt: { icon: 'swords', title: 'Revolt' },
  bandits: { icon: 'warning', title: 'Outlaws' }, flood: { icon: 'warning', title: 'Flood' },
};

/** Disasters and feasts at the player's own place (and revolts anywhere the player rules). */
export function noticeForHappening(e: SimEvents['happening'], ctx: NoticeCtx): ToastInput | null {
  if (e.phase !== 'start' || e.settlement !== ctx.homeSettlement) return null;
  const k = HAPPENING_NOTICE[e.kind];
  if (!k) return null;
  const good = e.kind === 'fair';
  return { tone: good ? 'gold' : 'vermilion', icon: k.icon, title: `${k.title} at ${ctx.placeName(e.settlement)}`, text: e.text, ttl: 10, key: `hap:${e.id}` };
}

/** The lord calls the levy: the military module asks for its panel to open; as a toast it does not seize the screen. */
export function noticeForCall(): ToastInput {
  return { tone: 'vermilion', icon: 'flag', title: 'The levy is called', text: 'Your lord summons the fighting men to the muster.', ttl: 16, key: 'levy-call', action: { label: 'Answer the call', request: { panel: 'ext', name: 'army' } } };
}
