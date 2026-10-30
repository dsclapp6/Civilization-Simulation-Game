// How techniques spread and die (SPEC §17): people work them out by doing the job, masters teach their
// apprentices and children, scribes write them into the abbey's books, readers recover them from the
// books, and a technique whose last holder dies unrecorded is lost.
//
// The NPC side runs once a year per settlement, on the settlement's own day and hour (spread across the
// calendar, like life.ts), so the cost is a few hundred checks per tick. The player's own practice is
// counted action by action (see `practice`).
import { dist2 } from '../../core/math';
import { ageYears, type Person, type PersonId } from '../state';
import type { Settlement } from '../../world/types';
import type { Adv } from './core';
import { LIBRARY_BUILDINGS, SCRIBE_CAREERS, TECHS, TECH_BY_ID } from './data';
import type { Result, TechDef } from './types';

/** Chance per year that a master with a teachable technique tries to pass it on. */
const TEACH_TRY = 0.6;
/** Chance a pupil picked by a master takes it in (apprentices of that master are likelier). */
const TEACH_TAKES = 0.5;
const TEACH_TAKES_APPRENTICE = 0.85;
/** Chance per year that a literate reader recovers a technique from the books of their library. */
const REDISCOVER = 0.3;
/** Chance per year that a library's scribes write down a technique known near them. */
const RECORD = 0.3;
const MAX_RECORDS = 4;

// ---------------------------------------------------------------------------------------------
// Yearly pass of one settlement
// ---------------------------------------------------------------------------------------------

export function settlementYear(A: Adv, s: Settlement): void {
  const res = A.state.residentList(s.id);
  if (res.length === 0) return;
  discover(A, res);
  teachAll(A, s, res);
  library(A, s, res);
}

function discover(A: Adv, res: readonly Person[]): void {
  const rng = A.rng();
  for (const p of res) {
    if (p.death || ageYears(p, A.day) < 14) continue;
    const cands = A.candidates(p);
    for (let i = 0; i < cands.length; i++) {
      const def = cands[i];
      if (A.knows(p.id, def.id)) continue;
      const f = Math.max(0.3, 0.7 + 0.06 * (p.trained.int - 10));
      if (!rng.chance(def.learn.rate * f)) continue;
      if (!A.qualifies(p, def) || !A.prereqsKnown(p, def)) continue;
      A.grant(p, def.id, 'practice');
    }
  }
}

/** Can this person, as a pupil, take up the technique (age, prerequisites, enough skill to follow the lessons)? */
export function canLearn(A: Adv, p: Person | undefined, def: TechDef | undefined): Result {
  if (!p || p.death) return { ok: false, reason: 'Nobody there' };
  if (!def) return { ok: false, reason: 'No such technique' };
  if (A.knows(p.id, def.id)) return { ok: false, reason: 'They know it already' };
  if (ageYears(p, A.day) < 12) return { ok: false, reason: 'Too young for such lessons' };
  if (def.year !== undefined && A.year < def.year) return { ok: false, reason: 'Nobody has yet worked this out' };
  if (!A.prereqsHeld(p, def)) {
    const missing = def.requires.filter((r) => !A.knows(p.id, r) && !A.houseHas(p.house, r)).map((r) => TECH_BY_ID.get(r)?.name ?? r);
    return { ok: false, reason: `First needs ${missing.join(' and ')}` };
  }
  const l = def.learn;
  if (l.skill && A.skillOf(p, l.skill) < Math.max(0, (l.minSkill ?? 0) - 3)) return { ok: false, reason: `Needs more ${l.skill} (${l.minSkill ?? 0})` };
  return { ok: true };
}

export function isMaster(A: Adv, p: Person, def: TechDef): boolean {
  const t = def.teach;
  if (t.skill) return A.skillOf(p, t.skill) >= (t.min ?? 0);
  return p.rankTier >= 2;
}

function teachAll(A: Adv, s: Settlement, res: readonly Person[]): void {
  const rng = A.rng();
  const econ = A.deps.economy;
  const byCareer = new Map<string, Person[]>();
  for (const q of res) {
    if (q.death || ageYears(q, A.day) < 12) continue;
    let g = byCareer.get(q.career);
    if (!g) { g = []; byCareer.set(q.career, g); }
    g.push(q);
  }
  for (const m of res) {
    if (m.death) continue;
    const known = A.techsOf(m.id);
    if (known.length === 0) continue;
    for (const id of known) {
      const def = TECH_BY_ID.get(id);
      if (!def || !isMaster(A, m, def) || !rng.chance(TEACH_TRY)) continue;
      // candidates: household members and apprentices first, then colleagues of the same trade
      const pool: Person[] = [];
      const hh = A.state.households.get(m.household);
      if (hh) for (const pid of hh.members) { const q = A.state.persons.get(pid); if (q && q !== m) pool.push(q); }
      for (const q of byCareer.get(m.career) ?? []) if (q !== m && !pool.includes(q)) pool.push(q);
      let apprentice = false;
      const eligible: Person[] = [];
      for (const q of pool) {
        if (q.death || A.knows(q.id, id)) continue;
        if (!canLearn(A, q, def).ok) continue;
        if (!A.candidates(q).includes(def)) continue;
        eligible.push(q);
      }
      if (eligible.length === 0) continue;
      let pupil = rng.pick(eligible);
      for (const q of eligible) {
        if (q.careerStage === 0 && econ.employment(q.id)?.employer === m.id) { pupil = q; apprentice = true; break; }
      }
      const takes = (apprentice ? TEACH_TAKES_APPRENTICE : TEACH_TAKES) + 0.03 * (pupil.trained.int - 10);
      if (rng.chance(Math.min(0.95, Math.max(0.2, takes)))) A.grant(pupil, id, 'taught');
    }
  }
  void s;
}

// ---------------------------------------------------------------------------------------------
// Books: scribes write techniques down, readers recover them
// ---------------------------------------------------------------------------------------------

function hasLibrary(A: Adv, settlement: number): boolean {
  const kinds = A.buildingKinds(settlement);
  for (const k of LIBRARY_BUILDINGS) if (kinds.has(k)) return true;
  return false;
}

function library(A: Adv, s: Settlement, res: readonly Person[]): void {
  if (!hasLibrary(A, s.id)) return;
  const rng = A.rng();
  let scribes = 0;
  let reader: Person | undefined;
  for (const p of res) {
    if (p.death || ageYears(p, A.day) < 14) continue;
    const letters = A.skillOf(p, 'letters');
    if (SCRIBE_CAREERS.has(p.career) && letters >= 4) scribes++;
    if (letters >= 3 && (!reader || letters > A.skillOf(reader, 'letters'))) reader = p;
  }
  if (scribes === 0 && !reader) return;
  const local = A.settlementCounts(s.id);
  const recBonus = 1 + Math.max(0, A.settlementBonus(s.id, 'records'));
  for (const def of TECHS) {
    const id = def.id;
    const list = A.save.rec[id];
    const written = !!list && list.includes(s.id);
    if (!written && scribes > 0) {
      let heard = (local.get(id) ?? 0) > 0;
      if (!heard) {
        // reports from near by: one holder somewhere within a few hours' ride
        const holders = A.holdersOf(id);
        if (holders.length > 0) {
          const h = A.state.persons.get(holders[Math.floor(rng.next() * holders.length)]);
          const hs = h && A.settlementById.get(h.settlement);
          heard = !!hs && dist2(hs.x, hs.z, s.x, s.z) < 6000 * 6000 && rng.chance(0.5);
        }
      }
      if (heard && rng.chance(RECORD * recBonus)) record(A, id, s.id);
    } else if (written && reader && !A.knownAnywhere(id) && rng.chance(REDISCOVER)) {
      // a preserved technique: someone literate reads it out of the books
      if (A.prereqsKnown(reader, def) && (def.year === undefined || A.year >= def.year)) A.grant(reader, id, 'books');
    }
  }
}

export function record(A: Adv, tech: string, settlement: number): void {
  let list = A.save.rec[tech];
  if (!list) { list = []; A.save.rec[tech] = list; }
  if (list.includes(settlement)) return;
  list.push(settlement);
  if (list.length > MAX_RECORDS) list.shift();
  delete A.save.lost[tech];
  A.touch();
}

/** A library burnt or looted: whatever only it kept may now be lost. Returns the number of techniques it held. */
export function libraryLost(A: Adv, settlement: number): number {
  let n = 0;
  for (const [tech, list] of Object.entries(A.save.rec)) {
    const i = list.indexOf(settlement);
    if (i < 0) continue;
    list.splice(i, 1);
    n++;
    A.touch();
    if (list.length === 0) delete A.save.rec[tech];
    A.checkLost(tech, 'the books that kept it were burnt');
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------------------------

/** Heritable techniques pass to the eldest grown child, else the spouse, else the head of the House. */
function heirOf(A: Adv, p: Person): Person | null {
  const st = A.state;
  const kids: Person[] = [];
  for (const id of p.children) {
    const c = st.persons.get(id);
    if (c && !c.death && ageYears(c, A.day) >= 14) kids.push(c);
  }
  if (kids.length) return kids.sort((a, b) => a.birthDay - b.birthDay || a.id - b.id)[0];
  const sp = p.spouse ? st.persons.get(p.spouse) : undefined;
  if (sp && !sp.death) return sp;
  const house = st.houses.get(p.house);
  const head = house && house.head !== p.id ? st.persons.get(house.head) : undefined;
  return head && !head.death ? head : null;
}

export function onDeath(A: Adv, personId: PersonId): void {
  const p = A.state.persons.get(personId);
  const techs = A.techsOf(personId);
  if (techs.length === 0) return;
  const list = techs.slice();
  for (const id of list) {
    const def = TECH_BY_ID.get(id);
    if (def?.heritable && p) {
      const heir = heirOf(A, p);
      if (heir) A.grant(heir, id, 'inherited');
    }
    A.removeHolder(personId, id);
    A.checkLost(id, `its last master, ${p ? p.first : 'its holder'}, died`);
  }
}

// ---------------------------------------------------------------------------------------------
// The player's practice
// ---------------------------------------------------------------------------------------------

/** One unit of practice (a completed action, a study session) towards a technique. Returns true if it was learned. */
export function practice(A: Adv, p: Person, def: TechDef, amount: number): boolean {
  const need = def.learn.player?.need ?? 0;
  if (need <= 0 || A.knows(p.id, def.id)) return false;
  if (def.year !== undefined && A.year < def.year) return false;
  if (!A.prereqsHeld(p, def)) return false;
  const before = A.save.prog[def.id] ?? 0;
  const after = Math.min(need, before + amount * (1 + 0.04 * (p.trained.int - 10)));
  A.save.prog[def.id] = Math.round(after * 100) / 100;
  A.touch();
  const l = def.learn;
  const skillOk = !l.skill || A.skillOf(p, l.skill) >= (l.minSkill ?? 0);
  if (after >= need && skillOk) {
    A.save.prog[def.id] = 0;
    return A.grant(p, def.id, 'practice');
  }
  if (p.id === A.playerId) {
    const q = (x: number): number => Math.floor((x / need) * 4);
    if (after >= need && !skillOk && before < need) {
      A.sim.events.emit('notify', { kind: 'info', text: `You understand ${def.name} in theory; your ${l.skill} (${l.minSkill ?? 0} needed) is not yet up to it.`, person: p.id });
    } else if (q(after) > q(before) && after < need) {
      A.sim.events.emit('notify', { kind: 'info', text: `You are getting the hang of ${def.name.toLowerCase()} (${Math.round((after / need) * 100)}%).`, person: p.id });
    }
  }
  return false;
}
