// Happenings (SPEC §18-§21): events and disasters, festivals and gatherings, and the requests NPCs
// make of the player. `HappeningsApi` (sim/wave3.ts) is the surface other modules use; this file adds
// the records and the runtime the UI, the tests and the pacing tool read.
import type { PersonId } from '../state';
import type { HappeningsApi } from '../wave3';

export type HappeningKind =
  | 'plague' | 'famine' | 'fire' | 'flood' | 'drought' | 'winter' | 'bandits' | 'revolt' | 'succession'
  | 'tournament' | 'fair' | 'progress' | 'midsummer' | 'harvest' | 'christmas'
  | 'wedding' | 'funeral' | 'christening';

/** One event in progress (or just ended). */
export interface HappeningRec {
  id: number;
  kind: HappeningKind;
  /** World settlement id, or -1 for events of a whole kingdom or of every settlement. */
  settlement: number;
  /** Kingdom id the event covers (-1 = all). */
  kingdom: number;
  start: number;
  /** Absolute day it ends. */
  end: number;
  /** 0..1 how bad (plagues, famines, fires) or how large. */
  level: number;
  text: string;
  /** Kind-specific numbers (plague wave id, people involved, building ids…). */
  data?: Record<string, number | number[] | string>;
}

export type RequestType = 'fetch' | 'loan' | 'work' | 'message' | 'lost_animal' | 'watch' | 'godparent' | 'marriage';
export type RequestState = 'offered' | 'accepted' | 'done' | 'failed' | 'declined' | 'expired';

export interface RequestRec {
  id: number;
  type: RequestType;
  from: PersonId;
  settlement: number;
  state: RequestState;
  offered: number;
  /** Offer lapses / accepted request is due on this day. */
  expires: number;
  /** The player has heard the ask in conversation. */
  heard?: boolean;
  /** What the NPC says. */
  text: string;
  /** Short line for the journal ("Bring 6 firewood to Wat"). */
  summary: string;
  data: {
    good?: string; qty?: number; pence?: number; interest?: number; due?: number;
    target?: PersonId; place?: number; x?: number; z?: number; animal?: string;
    count?: number; done?: number; hours?: number; watched?: number;
    ward?: PersonId; child?: PersonId; at?: number;
  };
  reward: { pence: number; opinion: number; points: number };
  resolved?: number;
  /** How it ended ("Paid back with interest", "Not answered in time"). */
  note?: string;
}

/** How the journal shows a request. */
export interface RequestView extends RequestRec {
  fromName: string;
  placeName: string;
  /** Days left on the offer or the deadline. */
  daysLeft: number;
}

export interface HappeningsRuntime extends HappeningsApi {
  /** Events in progress. */
  active(): readonly HappeningRec[];
  /** The most recent finished events, newest first. */
  recent(limit?: number): readonly HappeningRec[];
  requests(): RequestView[];
  /** Journal lines still open (offered or accepted). */
  openRequests(): RequestView[];
  acceptRequest(id: number): { ok: boolean; reason?: string };
  declineRequest(id: number): { ok: boolean; reason?: string };
  /** Offer a request of a given type now (tests, tools, scenarios); returns its id or 0. */
  offerRequest(type: RequestType, from?: PersonId): number;
  /** Counters for the pacing tool: events started per kind and requests per outcome. */
  stats(): { started: Record<string, number>; requests: Record<string, number> };
}
