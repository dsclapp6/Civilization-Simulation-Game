// Shared helpers for the social tests: a running simulation with the social system installed, and
// small builders for people with known kinship, rank and traits.
import { expect, vi } from 'vitest';
import { Rng } from '../../../src/core/rng';
import type { Simulation } from '../../../src/sim/sim';
import { installSocial, socialInternals } from '../../../src/sim/social';
import type { SocialCore } from '../../../src/sim/social/core';
import type { Conversation, DialogueOption, SocialApi } from '../../../src/sim/social/types';
import { createPerson } from '../../../src/sim/people';
import { ageYears, type GameState, type Household, type House, type Person } from '../../../src/sim/state';
import { mkHouse, mkHousehold, mkPerson, makePlayer, type MkPerson } from '../builders';
import { newSim, type TestSimOptions } from '../helpers';

export interface Rig {
  sim: Simulation;
  social: SocialApi;
  core: SocialCore;
  player: Person;
}

/** A tiny (or other preset) world at midday of day 0 with the social system installed. */
export function rig(opts: TestSimOptions = {}): Rig {
  const sim = newSim({ preset: 'tiny', ...opts });
  const social = installSocial(sim);
  const core = socialInternals(sim) as SocialCore;
  const player = sim.state.persons.get(sim.state.run.playerId) as Person;
  setClock(sim, 0.5);
  return { sim, social, core, player };
}

/** Sets the time of day (fraction) on the current day without firing hooks. */
export function setClock(sim: Simulation, fraction: number, day = Math.floor(sim.absDay)): void {
  sim.state.clock.absDay = day + fraction;
  sim.state.clock.firedHour = Math.floor((day + fraction) * 24);
}

export { mkPerson, mkHousehold, mkHouse, makePlayer, createPerson, Rng };
export type { MkPerson };

/** A grown-up villager in a fresh household of their own, in the player's settlement. */
export function villager(r: Rig, o: MkPerson & { traits?: Person['traits']; money?: number } = {}): Person {
  const settlement = o.settlement ?? r.player.settlement;
  const hh = mkHousehold(r.sim, settlement);
  const p = mkPerson(r.sim, { age: 30, tier: 2, estate: 'free', household: hh.id, settlement: hh.settlement, house: mkHouse(r.sim, 'Villager').id, ...o });
  r.sim.state.setHead(hh, p);
  if (o.traits) p.traits = [...o.traits];
  if (o.money !== undefined) p.money = o.money;
  return p;
}

/** Makes every roll of the social RNG come out as `value` (0 = always succeed, 0.999 = always fail). Returns the restore function. */
export function forceRolls(r: Rig, value: number): () => void {
  const fake = new Rng('fixed');
  fake.next = () => value;
  const spy = vi.spyOn(r.core, 'rng').mockReturnValue(fake);
  return () => spy.mockRestore();
}

/** Starts a conversation or fails the test. */
export function begin(r: Rig, other: Person): Conversation {
  const open = r.social.current();
  if (open) r.social.end(open.id);
  const c = r.social.start(r.player.id, other.id);
  if ('ok' in c) throw new Error(`could not start: ${c.reason}`);
  return c;
}

export function option(c: Conversation, id: string): DialogueOption {
  const o = c.options.find((x) => x.id === id);
  if (!o) throw new Error(`no option ${id} among ${c.options.map((x) => x.id).join(', ')}`);
  return o;
}

/** Chooses a path of option ids in order (navigation then a topic) and returns the conversation. */
export function pick(r: Rig, c: Conversation, ...ids: string[]): Conversation {
  let cur = c;
  for (const id of ids) cur = r.social.choose(cur.id, id);
  return cur;
}

export function ageNow(r: Rig, p: Person): number { return ageYears(p, r.sim.absDay); }

export function lastNpcText(c: Conversation, npcId: number): string {
  for (let i = c.lines.length - 1; i >= 0; i--) if (c.lines[i].speaker === npcId) return c.lines[i].text;
  return '';
}

export type { Household, House };

/** The live derived indexes must equal what rebuilding them from the entities gives. */
export function indexSnapshot(st: GameState): string {
  const res = [...st.residents.entries()].map(([s, l]) => [s, l.map((p) => p.id)] as const).filter(([, l]) => l.length > 0).sort((a, b) => a[0] - b[0]);
  const hm = [...st.houseMembers.entries()].map(([h, s]) => [h, [...s].map((p) => p.id).sort((a, b) => a - b)] as const).filter(([, l]) => l.length > 0).sort((a, b) => a[0] - b[0]);
  const ha = [...st.householdsAt.entries()].map(([s, set]) => [s, [...set].map((h) => h.id).sort((a, b) => a - b)] as const).filter(([, l]) => l.length > 0).sort((a, b) => a[0] - b[0]);
  const bb = [...st.buildings.values()].map((b) => [b.id, b.household, b.occupied] as const);
  return JSON.stringify({ res, hm, ha, bb, living: st.living });
}

export function expectConsistent(st: GameState): void {
  const live = indexSnapshot(st);
  // the spouse links and household memberships must agree too
  for (const p of st.persons.values()) {
    if (p.death) continue;
    if (p.spouse) {
      const sp = st.persons.get(p.spouse);
      expect(sp && !sp.death && sp.spouse === p.id, `spouse link of ${p.first}`).toBe(true);
    }
    const hh = st.households.get(p.household);
    expect(hh, `household of ${p.first}`).toBeDefined();
    expect(hh!.members.includes(p.id), `${p.first} is listed in household ${p.household}`).toBe(true);
    expect(hh!.settlement, `${p.first} lives where the household does`).toBe(p.settlement);
  }
  for (const hh of st.households.values()) {
    for (const id of hh.members) expect(st.persons.get(id)?.household, `member ${id} of ${hh.id}`).toBe(hh.id);
    if (hh.members.length > 0) expect(hh.members.includes(hh.head), `head of ${hh.id}`).toBe(true);
  }
  st.rebuildIndexes();
  expect(indexSnapshot(st)).toBe(live);
}
