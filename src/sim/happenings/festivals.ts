// Festivals and gatherings (SPEC §18): the harvest festival, midsummer and Christmas, yearly fairs at
// chartered towns, tournaments, royal progresses, and the weddings, funerals and christenings of the
// player's own village as visible gatherings (the detail zone is asked to walk people to the church).
import { toDate } from '../../core/time';
import type { DayInfo, HourInfo } from '../clock';
import { fullName, ageYears, type Person, type PersonId } from '../state';
import type { Hap } from './core';
import { DATA } from './data';
import type { HappeningKind, HappeningRec } from './types';

const cheer = (H: Hap, sid: number, amount: number): void => {
  for (const p of H.state.residentsOf(sid)) {
    if (p.death) continue;
    const next = Math.min(1, p.needs.mood + amount);
    if (next !== p.needs.mood) { p.needs.mood = Math.round(next * 100) / 100; H.state.touch(p); }
  }
};

/** Mood lifts only where the player lives and near by (the rest of the continent keeps its own counsel). */
function cheerNear(H: Hap, amount: number): void {
  for (const s of H.world.settlements) if (H.nearPlayer(s.id, 3000)) cheer(H, s.id, amount);
}

// ---------------------------------------------------------------------------------------------
// Daily: the calendar of feasts, fairs, tournaments and progresses
// ---------------------------------------------------------------------------------------------

export function festivalsDaily(H: Hap, info: DayInfo): void {
  const doy = toDate(info.absDay).dayOfYear;
  const cal = DATA.calendar;
  if (doy === cal.midsummer) allFeast(H, 'midsummer', 0.12);
  if (doy === cal.harvest) allFeast(H, 'harvest', 0.15);
  if (doy === cal.christmas) allFeast(H, 'christmas', 0.12);
  for (const s of H.world.settlements) {
    if (doy === (cal.fair + (s.id % 3)) % 16 && (s.kind === 'town' || s.kind === 'city') && s.market && hasFairCharter(H, s.id)) startFair(H, s.id);
  }
  if (doy === cal.tournament) for (const c of H.world.counties) if (hasTournament(H, c.seat)) startTournament(H, c.seat);
  for (const k of H.world.kingdoms) if (doy === (cal.progress + (k.id % 3)) % 16) startProgress(H, k.id);
  // festivals end after their days
  for (const rec of H.save.active.slice()) {
    if (H.day < rec.end) continue;
    if (rec.kind === 'fair' || rec.kind === 'tournament' || rec.kind === 'progress' || rec.kind === 'midsummer' || rec.kind === 'harvest' || rec.kind === 'christmas') H.end(rec);
  }
}

function allFeast(H: Hap, kind: HappeningKind, mood: number): void {
  if (H.activeOf(kind).length > 0) return;
  H.begin(kind, { settlement: -1, kingdom: -1, days: 1, level: 0.5, quiet: false });
  cheerNear(H, mood);
}

// ---------------------------------------------------------------------------------------------
// Fairs
// ---------------------------------------------------------------------------------------------

/** The town's lord (or a resident) holds a fair charter: the yearly fair is lawful there. */
export function hasFairCharter(H: Hap, sid: number): boolean {
  const adv = H.adv;
  if (!adv) return false;
  if (adv.settlementHas?.(sid, 'fair_charter')) return true;
  const t = H.state.titleFor('town', sid);
  return !!t && t.holder > 0 && adv.knows(t.holder, 'fair_charter');
}

function startFair(H: Hap, sid: number): void {
  if (H.activeAtOf('fair', sid) || H.cooling(`fair:${sid}`, 12)) return;
  H.begin('fair', { settlement: sid, days: 3, level: 0.6 });
  if (H.nearPlayer(sid, 3000)) cheer(H, sid, 0.1);
  const t = H.state.titleFor('town', sid);
  const holder = t ? H.state.persons.get(t.holder) : undefined;
  if (holder && holder.house === H.state.run.houseId) H.sim.score.award('deed', 5, 'A fair was held in your town');
}

// ---------------------------------------------------------------------------------------------
// Tournaments
// ---------------------------------------------------------------------------------------------

function hasTournament(H: Hap, sid: number): boolean {
  const adv = H.adv;
  return !!adv && !!adv.settlementHas?.(sid, 'tournaments');
}

function startTournament(H: Hap, seat: number): void {
  if (H.activeAtOf('tournament', seat) || H.cooling(`tournament:${seat}`, 10)) return;
  const county = H.world.counties.find((c) => c.seat === seat);
  const places = new Set<number>(county ? [seat, ...county.settlements] : [seat]);
  const rng = H.rng();
  const entries: Array<{ p: Person; score: number }> = [];
  for (const sid of places) {
    for (const p of H.state.residentsOf(sid)) {
      if (p.death || p.sex !== 'm' || p.rankTier < 4) continue;
      const age = ageYears(p, H.day);
      if (age < 16 || age > 45 || p.health.hp < 0.7) continue;
      if (!(p.career === 'knight' || p.career === 'squire' || p.career === 'lord' || p.career === 'noble')) continue;
      entries.push({ p, score: 0 });
    }
  }
  const rec = H.begin('tournament', { settlement: seat, days: 2, level: 0.7 });
  if (entries.length < 2) return;
  for (const e of entries) e.score = (e.p.skills.melee >= 0 ? Math.sqrt(e.p.skills.melee / 40) : 0) * 2 + e.p.trained.str + e.p.trained.agi * 0.5 + rng.range(0, 7);
  entries.sort((a, b) => b.score - a.score || a.p.id - b.p.id);
  const winner = entries[0].p;
  winner.prestige += 6;
  winner.rep.valour += 3;
  winner.money += 240;
  H.state.touch(winner);
  const text = `${fullName(winner)} won the tournament at ${H.placeName(seat)}.`;
  H.state.log(H.day, 'happening', text, [winner.id]);
  if (winner.id === H.playerId) H.sim.score.award('deed', 15, 'Won a tournament');
  else if (H.relevant(seat, -1)) H.notifyPlayer(text, 'info');
  const me = entries.findIndex((e) => e.p.id === H.playerId);
  if (me > 0) H.notifyPlayer(`You took part in the tournament at ${H.placeName(seat)} and finished ${me + 1}${me === 1 ? 'nd' : me === 2 ? 'rd' : 'th'} of ${entries.length}.`, 'info');
  rec.data = { winner: winner.id, entries: entries.length };
}

// ---------------------------------------------------------------------------------------------
// Royal progress
// ---------------------------------------------------------------------------------------------

function startProgress(H: Hap, kingdom: number): void {
  const t = H.state.titleFor('kingdom', kingdom);
  if (!t || t.holder === 0 || H.activeOf('progress').some((r) => r.kingdom === kingdom)) return;
  const list = H.world.settlements.filter((s) => s.kingdom === kingdom && (s.kind === 'town' || s.kind === 'city' || s.kind === 'castle' || s.kind === 'abbey'));
  if (list.length === 0) return;
  const w = list.map((s) => H.nearWeight(s.id) * (s.kind === 'city' ? 0.5 : 1));
  const dest = H.rng().weighted(list, w);
  const rec = H.begin('progress', { settlement: dest.id, days: 2, level: 0.6, vars: { who: fullName(H.state.persons.get(t.holder) as Person) } });
  // the host pays for the court's hospitality and gains standing by it
  const host = H.state.titleFor('town', dest.id) ?? H.state.titleFor('manor', dest.id) ?? H.state.titleFor('abbey', dest.id);
  const lord = host ? H.state.persons.get(host.holder) : undefined;
  if (lord && !lord.death) { lord.money = Math.max(0, lord.money - 480); lord.prestige += 3; H.state.touch(lord); }
  if (H.nearPlayer(dest.id, 3000)) cheer(H, dest.id, 0.08);
  void rec;
}

// ---------------------------------------------------------------------------------------------
// Weddings, funerals, christenings
// ---------------------------------------------------------------------------------------------

function relevantPerson(H: Hap, p: Person | undefined): boolean {
  if (!p) return false;
  return p.house === H.state.run.houseId || p.settlement === H.playerSettlement();
}

/** Called from the marriage / death / birth events. Only the player's village and House get gatherings you can see. */
export function schedule(H: Hap, kind: 'wedding' | 'funeral' | 'christening', persons: PersonId[], settlement: number): void {
  if (H.state.run.phase !== 'alive') return;
  const people = persons.map((id) => H.state.persons.get(id));
  if (!people.some((p) => relevantPerson(H, p))) return;
  const nameOf = (p: Person | undefined): string => (p ? fullName(p) : 'Someone');
  const name = kind === 'wedding' ? `${nameOf(people[0])} and ${nameOf(people[1])}` : nameOf(people[0]);
  const delay = kind === 'wedding' ? 1 + 10 / 24 : kind === 'funeral' ? 1 + 9 / 24 : 2 + 11 / 24;
  H.save.queue.push({ at: Math.floor(H.day) + delay, kind, settlement, persons, name });
  H.touch();
}

export function gatheringsHourly(H: Hap, _info: HourInfo): void {
  // start the due ones
  if (H.save.queue.length > 0) {
    const due = H.save.queue.filter((q) => q.at <= H.day);
    if (due.length > 0) {
      H.save.queue = H.save.queue.filter((q) => q.at > H.day);
      H.touch();
      for (const q of due) startGathering(H, q.kind as 'wedding' | 'funeral' | 'christening', q.settlement, q.persons, q.name);
    }
  }
  // and close the finished ones
  for (const rec of H.save.active.slice()) {
    if ((rec.kind === 'wedding' || rec.kind === 'funeral' || rec.kind === 'christening') && H.day >= rec.end) {
      release(H, rec);
      H.end(rec);
    }
  }
}

function startGathering(H: Hap, kind: 'wedding' | 'funeral' | 'christening', settlement: number, persons: PersonId[], name: string): void {
  if (!H.settlementById.has(settlement)) return;
  const rec = H.begin(kind, { settlement, days: 0.14, level: 0.4, vars: { name }, data: { persons }, quiet: true });
  const att = attendees(H, persons, settlement, kind);
  rec.data = { persons, att };
  if (kind === 'wedding') {
    for (const id of att) { const p = H.state.persons.get(id); if (p && !p.death) { p.needs.mood = Math.min(1, p.needs.mood + 0.15); H.state.touch(p); } }
  }
  if (H.relevant(settlement, -1)) {
    H.notifyPlayer(rec.text, 'info');
    H.state.log(H.day, 'happening', rec.text, persons);
  }
  gather(H, settlement, att, kind);
}

function attendees(H: Hap, persons: PersonId[], sid: number, kind: HappeningKind): number[] {
  const out = new Set<number>();
  const alive = (p: Person | undefined): p is Person => !!p && !p.death && p.settlement === sid;
  for (const id of persons) {
    const p = H.state.persons.get(id);
    if (kind !== 'funeral' && alive(p)) out.add(id);
    if (!p) continue;
    for (const kin of [p.father, p.mother, p.spouse, ...p.children]) { const q = kin ? H.state.persons.get(kin) : undefined; if (alive(q) && ageYears(q, H.day) >= 5) out.add(q.id); }
    const sp = p.household ? H.state.households.get(p.household) : undefined;
    if (sp) for (const m of sp.members) { const q = H.state.persons.get(m); if (alive(q) && ageYears(q, H.day) >= 5) out.add(q.id); }
  }
  const res = H.state.residentList(sid).filter((p) => !p.death && ageYears(p, H.day) >= 14);
  const priest = res.find((p) => p.career === 'priest');
  if (priest) out.add(priest.id);
  const rng = H.rng();
  for (let i = 0; i < 5 && res.length > 0; i++) out.add(res[Math.floor(rng.next() * res.length)].id);
  return Array.from(out).slice(0, 14);
}

/** Walks the people to the church door, if the detail zone has them as agents. */
function gather(H: Hap, sid: number, people: number[], kind: HappeningKind): void {
  const zone = H.deps.zone;
  if (!zone) return;
  const church = (H.state.buildingsAt.get(sid) ?? []).find((b) => b.kind === 'church' || b.kind === 'chapel' || b.kind === 'abbey_church');
  if (!church) return;
  const door = zone.nav.doorOf(church.id) ?? { x: church.x, z: church.z, yaw: 0 };
  const rng = H.rng();
  let i = 0;
  for (const id of people) {
    if (!zone.agent(id)) continue;
    const a = (i / Math.max(1, people.length)) * Math.PI * 1.2 - Math.PI * 0.6;
    const r = 3 + (i % 3) * 1.4;
    zone.command(id, { kind: 'goto', x: door.x + Math.sin(door.yaw + a) * r + rng.range(-0.4, 0.4), z: door.z + Math.cos(door.yaw + a) * r + rng.range(-0.4, 0.4) });
    i++;
  }
  const first = people.find((id) => zone.agent(id));
  if (first !== undefined) {
    const line = kind === 'wedding' ? 'A blessing on the bride and groom!' : kind === 'funeral' ? 'Rest in peace.' : 'A fine, healthy child.';
    zone.say(first, line, 8);
  }
}

function release(H: Hap, rec: HappeningRec): void {
  const zone = H.deps.zone;
  const att = rec.data?.att;
  if (!zone || !Array.isArray(att)) return;
  for (const id of att) if (zone.agent(id)) zone.command(id, { kind: 'resume' });
}
