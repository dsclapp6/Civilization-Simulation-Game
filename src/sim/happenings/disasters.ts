// Disasters and trouble (SPEC §19): plague waves that creep along the roads, famine after bad harvests,
// town fires, floods, drought, hard winters with wolves, bandit gangs, peasant revolts and succession
// crises. Each starts from a seeded yearly hazard (scaled by difficulty, SPEC §1) or by hand
// (`trigger`), runs on the calendar hooks and acts on the world through the same state everything
// else uses: `SettlementState.epidemic` and `prosperity`, fatal `plague` conditions on people,
// `BuildingState.damage/onFire`, household stores, and the economy's harvest table.
import { DAYS_PER_YEAR, toDate } from '../../core/time';
import { dist2 } from '../../core/math';
import type { DayInfo, HourInfo, YearInfo } from '../clock';
import { killPerson, pickHome } from '../succession';
import { fullName, type BuildingState, type Person } from '../state';
import type { Settlement } from '../../world/types';
import type { Hap } from './core';
import { DATA, FIREPROOF } from './data';
import type { HappeningKind, HappeningRec } from './types';

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const ARMS_CAREERS = new Set(['man_at_arms', 'sergeant', 'soldier', 'archer', 'knight', 'squire']);
const GRAIN = ['wheat', 'rye', 'barley', 'oats', 'peas', 'beans', 'flour', 'bread', 'malt', 'seed_corn'];
const LIBRARY = ['cloister', 'abbey_church', 'cathedral', 'school'];

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/** Starts a disaster by hand (dev tools, tests, scenarios). Returns the id of the event or 0. */
export function trigger(H: Hap, kind: string, settlement: number): number {
  let rec: HappeningRec | null = null;
  switch (kind as HappeningKind) {
    case 'plague': rec = startPlague(H, settlement, 1); break;
    case 'famine': rec = startFamine(H, settlement, 0.7); break;
    case 'fire': rec = startFire(H, settlement); break;
    case 'flood': rec = startFlood(H, settlement); break;
    case 'drought': rec = startDrought(H, H.kingdomOf(settlement)); break;
    case 'winter': rec = startWinter(H, H.kingdomOf(settlement)); break;
    case 'bandits': rec = startBandits(H, settlement); break;
    case 'revolt': rec = startRevolt(H, settlement); break;
    default: rec = null;
  }
  return rec ? rec.id : 0;
}

/** The daily rolls and housekeeping of disasters: hazards drawn, events ended, repairs, the cold, succession crises. */
export function hazardsDaily(H: Hap, info: DayInfo): void {
  const doy = toDate(info.absDay).dayOfYear;
  expire(H);
  rollHazards(H, doy);
  winterDaily(H);
  repairDaily(H);
  successionWatch(H);
}

/** Plague waves and the fading of epidemics (a separate hour, so a bad day does not pile everything on one frame). */
export function plagueDailyPass(H: Hap): void {
  plagueDaily(H);
  epidemicDecay(H);
}

export function disastersYearly(H: Hap, _info: YearInfo): void {
  famineYearly(H);
  revoltRoll(H);
}

// ---------------------------------------------------------------------------------------------
// Hazards: seeded daily rolls from the yearly rates
// ---------------------------------------------------------------------------------------------

function rollHazards(H: Hap, doy: number): void {
  const rng = H.rng();
  const season = Math.floor(doy / 4);
  const perDay = (perYear: number): number => perYear / DAYS_PER_YEAR;
  const R = DATA.rates;
  const settlements = H.world.settlements;

  // plague: any season, likelier in the damp
  if (H.activeOf('plague').length === 0 && rng.chance(perDay(R.plague * H.diff('plague')) * (season === 2 || season === 3 ? 1.3 : 0.8))) {
    const origin = pickSettlement(H, (s) => s.market || s.port, (s) => (s.port ? 3 : 1) * 1);
    if (origin) startPlague(H, origin.id, 1);
  }
  // drought in summer, hard winter in winter
  if (season === 1 && H.activeOf('drought').length === 0 && rng.chance(perDay(R.drought * H.diff('disaster') * 2))) {
    const k = H.world.kingdoms[Math.floor(rng.next() * H.world.kingdoms.length)];
    if (k && !H.cooling(`drought:k${k.id}`, 16)) startDrought(H, k.id);
  }
  if (season === 3 && H.activeOf('winter').length === 0 && rng.chance(perDay(R.winter * H.diff('disaster') * 3))) {
    const k = H.world.kingdoms[Math.floor(rng.next() * H.world.kingdoms.length)];
    if (k && !H.cooling(`winter:k${k.id}`, 16)) startWinter(H, k.id);
  }
  // floods in spring and autumn at places by water
  if (H.wet.length > 0 && (season === 0 || season === 2) && rng.chance(perDay(R.flood * H.diff('disaster') * 2))) {
    const sid = H.wet[Math.floor(rng.next() * H.wet.length)];
    if (!H.cooling(`flood:${sid}`, 12)) startFlood(H, sid);
  }
  // fires: more in the dry months
  const fireRate = R.fire * H.diff('disaster') * (season === 1 ? 1.5 : season === 3 ? 0.7 : 1);
  if (rng.chance(perDay(fireRate))) {
    const s = pickSettlement(H, (x) => x.kind !== 'castle', (x) => (x.kind === 'town' || x.kind === 'city' ? 2.5 : 1) * Math.sqrt(H.state.residentsOf(x.id).length + 1));
    if (s && !H.activeAtOf('fire', s.id)) startFire(H, s.id);
  }
  // bandits
  if (rng.chance(perDay(R.bandits * H.diff('bandits')))) {
    const s = pickSettlement(H, (x) => x.kind === 'village' || x.kind === 'hamlet' || x.kind === 'priory' || x.kind === 'abbey', (x) => 1 + (H.roads.get(x.id)?.length ?? 0) * 0.3);
    if (s && !H.activeAtOf('bandits', s.id) && !H.cooling(`bandits:${s.id}`, 6)) startBandits(H, s.id);
  }
  void settlements;
}

/** Picks a settlement by weight (and a bias towards the player's neighbourhood). */
export function pickSettlement(H: Hap, ok: (s: Settlement) => boolean, weight: (s: Settlement) => number): Settlement | null {
  const rng = H.rng();
  const list: Settlement[] = [];
  const w: number[] = [];
  for (const s of H.world.settlements) {
    if (!ok(s)) continue;
    list.push(s);
    w.push(Math.max(0.01, weight(s) * H.nearWeight(s.id)));
  }
  if (list.length === 0) return null;
  return rng.weighted(list, w);
}

function expire(H: Hap): void {
  const now = H.day;
  for (const rec of H.save.active.slice()) {
    if (now < rec.end) continue;
    switch (rec.kind) {
      case 'plague': break; // ends in plagueDaily
      case 'famine': case 'fire': break; // end on their conditions
      case 'bandits': resolveBandits(H, rec); break;
      case 'revolt': resolveRevolt(H, rec); break;
      case 'tournament': case 'fair': case 'progress': case 'midsummer': case 'harvest': case 'christmas':
      case 'wedding': case 'funeral': case 'christening':
        break; // festivals end themselves (festivals.ts)
      default: H.end(rec);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Plague
// ---------------------------------------------------------------------------------------------

export function startPlague(H: Hap, origin: number, strengthMul: number): HappeningRec | null {
  if (!H.settlementById.has(origin) || H.activeAtOf('plague', origin) || H.cooling(`plague:${origin}`, 32)) return null;
  const rng = H.rng();
  const wave = { id: H.save.nextWave++, strength: clamp(rng.range(0.6, 1) * strengthMul * Math.min(1.3, 0.7 + 0.3 * H.diff('plague')), 0.3, 1.1), start: H.day };
  H.save.waves.push(wave);
  H.touch();
  return infect(H, wave.id, wave.strength, origin, true);
}

function infect(H: Hap, waveId: number, strength: number, sid: number, first: boolean): HappeningRec {
  const [lo, hi] = DATA.plague.duration;
  const dur = H.rng().int(lo, hi);
  return H.begin('plague', { settlement: sid, days: dur, level: strength, data: { wave: waveId, peak: strength }, important: first });
}

function plagueDaily(H: Hap): void {
  const recs = H.activeOf('plague');
  if (recs.length === 0) return;
  const rng = H.rng();
  const cfg = DATA.plague;
  const now = H.day;
  for (const rec of recs) {
    const sid = rec.settlement;
    const wave = H.save.waves.find((w) => w.id === rec.data?.wave);
    const strength = wave ? wave.strength : rec.level;
    const dur = Math.max(2, rec.end - rec.start);
    const age = now - rec.start;
    const ramp = age < 2 ? (age + 0.5) / 2.5 : Math.max(0, 1 - (age - 2) / Math.max(1, dur - 2));
    const level = clamp(strength * ramp, 0, 1);
    rec.level = Math.round(level * 100) / 100;
    const ss = H.state.settlements.get(sid);
    if (ss) {
      const epi = clamp(0.05 + 0.75 * level, 0, 1);
      if (epi > ss.epidemic + 0.01) { ss.epidemic = Math.round(epi * 100) / 100; H.state.touchSettlement(ss); }
    }
    infectResidents(H, sid, level);
    // spread along the roads
    if (level > 0.25) {
      for (const e of H.roads.get(sid) ?? []) {
        if (H.activeAtOf('plague', e.to) || H.cooling(`plague:${e.to}`, 32)) continue;
        const lenF = clamp(4500 / (e.len + 2000), 0.5, 1.6);
        const trade = (H.settlementById.get(e.to)?.market || H.settlementById.get(sid)?.market) ? 1.4 : 1;
        if (rng.chance(cfg.spread * level * lenF * trade * (0.6 + 0.4 * H.diff('plague')))) {
          if (wave) wave.strength = Math.max(0.3, wave.strength * 0.985);
          infect(H, rec.data?.wave as number ?? 0, strength * 0.97, e.to, false);
        }
      }
    }
    if (now >= rec.end) {
      H.end(rec);
      if (!H.save.active.some((r) => r.kind === 'plague' && r.data?.wave === rec.data?.wave)) {
        const i = H.save.waves.findIndex((w) => w.id === rec.data?.wave);
        if (i >= 0) {
          H.save.waves.splice(i, 1);
          H.touch();
          H.state.log(now, 'happening', 'The plague has run its course across the land.', []);
        }
      }
    }
  }
}

/** A few residents a day fall ill with a fatal plague; herbal medicine and the infirmary let more of them recover. */
function infectResidents(H: Hap, sid: number, level: number): void {
  const res = H.state.residentsOf(sid);
  if (res.length === 0 || level <= 0) return;
  const rng = H.rng();
  const adv = H.adv;
  const med = adv?.settlementBonus?.(sid, 'plague.fatality') ?? 0;
  const expected = res.length * DATA.plague.infect * level;
  let k = Math.floor(expected + rng.next());
  let tries = 0;
  const now = H.day;
  while (k > 0 && tries++ < k * 4 + 8) {
    const p = res[Math.floor(rng.next() * res.length)];
    if (p.death || p.health.conditions.length > 0) continue;
    k--;
    const recover = clamp(DATA.plague.recover + 0.02 * (p.potential.end - 10) - med + (p.traits.includes('sickly') ? -0.1 : 0), 0.05, 0.85);
    p.health.conditions.push({ id: 'plague', since: now, until: now + rng.int(4, 8), severity: recover, fatal: true });
    p.health.hp = Math.min(p.health.hp, 0.8);
    H.state.touch(p);
    if (p.id === H.playerId) H.notifyPlayer('You have fallen ill with the plague.', 'danger');
  }
}

function epidemicDecay(H: Hap): void {
  const adv = H.adv;
  for (const ss of H.state.settlements.values()) {
    if (ss.epidemic <= 0 || H.activeAtOf('plague', ss.id)) continue;
    const decay = 0.14 + (adv?.settlementBonus?.(ss.id, 'epidemic.decay') ?? 0);
    ss.epidemic = ss.epidemic * (1 - decay) < 0.02 ? 0 : Math.round(ss.epidemic * (1 - decay) * 100) / 100;
    H.state.touchSettlement(ss);
  }
}

// ---------------------------------------------------------------------------------------------
// Famine
// ---------------------------------------------------------------------------------------------

export function startFamine(H: Hap, sid: number, level: number): HappeningRec | null {
  if (!H.settlementById.has(sid) || H.activeAtOf('famine', sid)) return null;
  const ss = H.state.settlements.get(sid);
  if (ss && ss.prosperity > DATA.famine.start) { ss.prosperity = DATA.famine.start - 0.05; H.state.touchSettlement(ss); }
  return H.begin('famine', { settlement: sid, days: 40, level });
}

/** After the economy has set the year's prosperity (order 20): a poor harvest becomes a famine. */
function famineYearly(H: Hap): void {
  const adv = H.adv;
  for (const s of H.world.settlements) {
    const ss = H.state.settlements.get(s.id);
    if (!ss) continue;
    const rec = H.activeAtOf('famine', s.id);
    if (!rec) {
      if (ss.prosperity >= DATA.famine.start || H.cooling(`famine:${s.id}`, 6)) continue;
      const resist = adv?.settlementBonus?.(s.id, 'famine.resist') ?? 0;
      if (resist > 0) {
        ss.prosperity = Math.round((ss.prosperity + resist * (0.9 - ss.prosperity) * 0.5) * 1000) / 1000;
        H.state.touchSettlement(ss);
        if (ss.prosperity >= DATA.famine.start) continue;
      }
      H.begin('famine', { settlement: s.id, days: 40, level: clamp((DATA.famine.start - ss.prosperity) / 0.4, 0.1, 1) });
    } else if (ss.prosperity >= DATA.famine.end || H.day - rec.start > 50) {
      H.end(rec);
    } else {
      rec.level = clamp((DATA.famine.start - ss.prosperity) / 0.4, 0.1, 1);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Fire
// ---------------------------------------------------------------------------------------------

const FIRE_WEIGHT: Record<string, number> = { bakehouse: 3, smithy: 3, brewhouse: 3, tavern: 2, alehouse: 2, tannery: 2, chandler: 2 };

export function startFire(H: Hap, sid: number): HappeningRec | null {
  const list = (H.state.buildingsAt.get(sid) ?? []).filter((b) => !FIREPROOF.has(b.kind) && b.construction >= 1 && b.damage < 0.5 && !b.onFire);
  if (list.length === 0) return null;
  const rng = H.rng();
  const b = rng.weighted(list, list.map((x) => FIRE_WEIGHT[x.kind] ?? 1));
  ignite(H, b);
  const rec = H.activeAtOf('fire', sid) ?? H.begin('fire', { settlement: sid, days: 2, level: 0.4, data: { first: b.id } });
  if (b.household && H.relevant(sid, -1)) {
    const hh = H.state.households.get(b.household);
    if (hh && H.state.persons.get(H.playerId)?.household === hh.id) H.notifyPlayer('Fire! Your own roof is burning.', 'danger');
  }
  return rec;
}

function ignite(H: Hap, b: BuildingState): void {
  b.onFire = true;
  H.state.touchBuilding(b);
  H.save.fires[String(b.id)] = H.day;
  H.touch();
}

export function fireHourly(H: Hap, _info: HourInfo): void {
  const ids = Object.keys(H.save.fires);
  if (ids.length === 0) return;
  const rng = H.rng();
  const adv = H.adv;
  const dry = H.activeOf('drought').length > 0;
  const hour = Math.floor(toDate(H.day).dayFraction * 24);
  for (const key of ids) {
    const b = H.state.buildings.get(Number(key));
    if (!b || !b.onFire) { delete H.save.fires[key]; H.touch(); continue; }
    b.damage = Math.min(1, Math.round((b.damage + 0.11) * 100) / 100);
    H.state.touchBuilding(b);
    const spread = 0.16 * (1 + (adv?.settlementBonus?.(b.settlement, 'fire.spread') ?? 0)) * (dry ? 1.5 : 1);
    for (const n of H.state.buildingsAt.get(b.settlement) ?? []) {
      if (n === b || n.onFire || FIREPROOF.has(n.kind) || n.damage >= 0.9 || n.construction < 1) continue;
      if (dist2(n.x, n.z, b.x, b.z) > 15 * 15) continue;
      if (rng.chance(spread)) ignite(H, n);
    }
    if (b.damage >= 0.95) burntOut(H, b, hour < 6 || hour > 20);
  }
  // an event ends when its last fire is out
  for (const rec of H.activeOf('fire')) {
    const burning = (H.state.buildingsAt.get(rec.settlement) ?? []).some((b) => b.onFire);
    if (!burning) H.end(rec);
  }
}

function burntOut(H: Hap, b: BuildingState, night: boolean): void {
  b.onFire = false;
  b.damage = 0.95;
  H.state.touchBuilding(b);
  delete H.save.fires[String(b.id)];
  markRepair(H, b.id);
  const rng = H.rng();
  const hh = b.household ? H.state.households.get(b.household) : undefined;
  if (hh) {
    // the household loses most of what it kept indoors and moves in with neighbours
    for (const k of Object.keys(hh.stores)) if (rng.chance(0.6)) delete hh.stores[k];
    for (const id of hh.members.slice()) {
      const p = H.state.persons.get(id);
      if (!p || p.death) continue;
      if (rng.chance(night ? 0.07 : 0.025)) killPerson(H.sim, p, 'accident', H.day);
    }
    const home = pickHome(H.state, rng, b.settlement);
    if (home && home.id !== b.id) H.state.relocateHousehold(hh, b.settlement, home.id);
    H.state.touchHousehold(hh);
    const me = H.state.persons.get(H.playerId);
    if (me && me.household === hh.id) {
      H.notifyPlayer('Your house has burnt to the ground. Neighbours take you in.', 'loss');
      H.state.log(H.day, 'happening', `${fullName(me)}'s house burnt down.`, [me.id]);
    }
  }
  if (LIBRARY.includes(b.kind) && !H.state.buildingsAt.get(b.settlement)?.some((x) => x !== b && LIBRARY.includes(x.kind) && x.damage < 0.9)) {
    const lost = H.adv?.libraryLost?.(b.settlement) ?? 0;
    if (lost > 0) H.state.log(H.day, 'happening', `The books of ${H.placeName(b.settlement)} burnt with the library.`, []);
  }
}

function markRepair(H: Hap, id: number): void {
  if (!H.save.repair.includes(id)) { H.save.repair.push(id); H.touch(); }
}

/** Neighbours rebuild: burnt and flooded buildings mend over a couple of weeks. */
function repairDaily(H: Hap): void {
  if (H.save.repair.length === 0) return;
  const keep: number[] = [];
  for (const id of H.save.repair) {
    const b = H.state.buildings.get(id);
    if (!b) continue;
    if (b.onFire) { keep.push(id); continue; }
    if (b.damage > 0) {
      b.damage = Math.max(0, Math.round((b.damage - 0.07) * 100) / 100);
      H.state.touchBuilding(b);
    }
    if (b.damage > 0) keep.push(id);
  }
  if (keep.length !== H.save.repair.length || keep.length > 0) { H.save.repair = keep; H.touch(); }
}

// ---------------------------------------------------------------------------------------------
// Flood, drought, winter
// ---------------------------------------------------------------------------------------------

export function startFlood(H: Hap, sid: number): HappeningRec | null {
  if (!H.settlementById.has(sid) || H.activeAtOf('flood', sid)) return null;
  const rng = H.rng();
  const list = (H.state.buildingsAt.get(sid) ?? []).filter((b) => b.construction >= 1 && b.kind !== 'church' && !b.onFire);
  list.sort((a, b) => H.world.heightAt(a.x, a.z) - H.world.heightAt(b.x, b.z) || a.id - b.id);
  const n = Math.max(1, Math.floor(list.length * 0.25));
  for (const b of list.slice(0, n)) {
    b.damage = Math.min(0.9, Math.round((b.damage + rng.range(0.15, 0.4)) * 100) / 100);
    H.state.touchBuilding(b);
    markRepair(H, b.id);
    const hh = b.household ? H.state.households.get(b.household) : undefined;
    if (hh) {
      for (const k of GRAIN) if (hh.stores[k]) hh.stores[k] = Math.round(hh.stores[k] * 0.6 * 100) / 100;
      H.state.touchHousehold(hh);
    }
  }
  scaleHarvest(H, H.kingdomOf(sid), 0.96);
  return H.begin('flood', { settlement: sid, days: 3, level: 0.5 });
}

export function startDrought(H: Hap, kingdom: number): HappeningRec | null {
  if (kingdom < 0 || H.activeOf('drought').some((r) => r.kingdom === kingdom)) return null;
  scaleHarvest(H, kingdom, H.rng().range(0.78, 0.9));
  return H.begin('drought', { settlement: -1, kingdom, days: 8, level: 0.6, important: true });
}

export function startWinter(H: Hap, kingdom: number): HappeningRec | null {
  if (kingdom < 0 || H.activeOf('winter').some((r) => r.kingdom === kingdom)) return null;
  return H.begin('winter', { settlement: -1, kingdom, days: 8, level: 0.6, important: true });
}

/** The economy keeps this year's harvest quality per kingdom; weather events dent it. */
export function scaleHarvest(H: Hap, kingdom: number, factor: number): void {
  const econ = H.state.ext['econ'] as { harvest?: { f?: number[] } } | undefined;
  const f = econ?.harvest?.f;
  if (!f || f[kingdom] === undefined) return;
  f[kingdom] = Math.round(Math.max(0.35, f[kingdom] * factor) * 1000) / 1000;
  H.state.touchExt('econ');
}

function winterDaily(H: Hap): void {
  const rng = H.rng();
  for (const rec of H.activeOf('winter')) {
    // the cold takes the old and the very young among the poor
    const pool: number[] = [];
    for (const s of H.world.settlements) if (s.kingdom === rec.kingdom) pool.push(s.id);
    if (pool.length === 0) continue;
    let pop = 0;
    for (const id of pool) pop += H.state.residentsOf(id).length;
    let k = Math.floor(pop * 0.00018 * rec.level + rng.next());
    let tries = 0;
    while (k > 0 && tries++ < 20) {
      const res = H.state.residentsOf(pool[Math.floor(rng.next() * pool.length)]);
      if (res.length === 0) continue;
      const p = res[Math.floor(rng.next() * res.length)];
      const age = (H.day - p.birthDay) / DAYS_PER_YEAR;
      if (p.rankTier > 2 || !(age < 5 || age >= 55)) continue;
      k--;
      killPerson(H.sim, p, 'exposure', H.day);
    }
    if (H.day >= rec.end) H.end(rec);
  }
}

// ---------------------------------------------------------------------------------------------
// Wolves of a hard winter, in the detail zone near the player
// ---------------------------------------------------------------------------------------------

export function wolvesHourly(H: Hap, info: HourInfo): void {
  const zone = H.deps.zone;
  if (!zone?.summonAnimal || !zone.dismissAnimal) return;
  const dismiss = (): void => { for (const id of H.wolves.splice(0)) zone.dismissAnimal?.(id); };
  const active = H.activeOf('winter').some((r) => r.kingdom === H.playerKingdom());
  if (!active || info.hour === 6) { if (H.wolves.length) dismiss(); return; }
  if (info.hour !== 21 || H.wolves.length > 0) return;
  const body = H.deps.player?.body();
  if (!body) return;
  const rng = H.rng();
  const ang = rng.range(0, Math.PI * 2);
  const n = rng.int(2, 3);
  for (let i = 0; i < n; i++) {
    const a = ang + i * 0.5, d = rng.range(110, 160);
    H.wolves.push(zone.summonAnimal('wolf', body.x + Math.cos(a) * d, body.z + Math.sin(a) * d, true));
  }
  H.notifyPlayer('Wolves are howling close to the village tonight.', 'warn');
}

// ---------------------------------------------------------------------------------------------
// Bandits
// ---------------------------------------------------------------------------------------------

function lordOf(H: Hap, sid: number): Person | undefined {
  const t = H.state.titleFor('manor', sid) ?? H.state.titleFor('town', sid) ?? H.state.titleFor('abbey', sid);
  return t ? H.state.persons.get(t.holder) : undefined;
}

function garrison(H: Hap, sid: number): number {
  let n = 0;
  for (const p of H.state.residentsOf(sid)) if (ARMS_CAREERS.has(p.career) && p.health.hp > 0.5) n++;
  return n;
}

export function startBandits(H: Hap, sid: number): HappeningRec | null {
  if (!H.settlementById.has(sid) || H.activeAtOf('bandits', sid)) return null;
  const rng = H.rng();
  const strength = Math.round(rng.range(5, 12) * Math.sqrt(H.diff('bandits')));
  const rec = H.begin('bandits', { settlement: sid, days: rng.int(2, 4), level: clamp(strength / 14, 0.2, 1), data: { strength, raised: 0 } });
  // the lord calls out his men if the military module is installed
  const lord = lordOf(H, sid);
  const m = H.sim.services.military;
  if (m && lord && lord.house) {
    try { if (m.raise(lord.house, 'bandits') > 0) (rec.data as Record<string, number>).raised = 1; } catch { /* the military module declined */ }
  }
  return rec;
}

/** Chance the village drives the bandits off: the garrison, the lord's raised men and a watch the player kept, against the gang. */
export function banditOdds(H: Hap, rec: HappeningRec): number {
  const sid = rec.settlement;
  const strength = Number(rec.data?.strength ?? 6);
  let defence = garrison(H, sid) + (rec.data?.raised ? 6 : 0);
  // villagers who stood watch with the player fight better prepared
  for (const r of H.save.reqs) if (r.type === 'watch' && r.settlement === sid && r.state === 'done' && H.day - (r.resolved ?? -99) < 6) defence += 3;
  const lord = lordOf(H, sid);
  if (lord && lord.settlement === sid) defence += 2;
  return defence / (defence + strength * 0.9);
}

function resolveBandits(H: Hap, rec: HappeningRec): void {
  const sid = rec.settlement;
  const rng = H.rng();
  const strength = Number(rec.data?.strength ?? 6);
  const lord = lordOf(H, sid);
  if (rng.chance(banditOdds(H, rec))) {
    H.end(rec, {}, true);
    const text = `The bandits near ${H.placeName(sid)} were driven off.`;
    if (H.relevant(sid, -1)) { H.notifyPlayer(text, 'info'); H.state.log(H.day, 'happening', text, [H.playerId]); }
    if (lord) { lord.prestige += 1; H.state.touch(lord); }
    return;
  }
  // a raid: stores stolen, a barn burnt, people hurt
  let stolen = 0;
  const hhs = H.state.householdList(sid);
  for (let i = 0; i < Math.min(hhs.length, strength); i++) {
    const hh = hhs[Math.floor(rng.next() * hhs.length)];
    for (const g of GRAIN) {
      const q = hh.stores[g];
      if (q && q > 0) { const take = Math.round(q * 0.35 * 100) / 100; hh.stores[g] = Math.round((q - take) * 100) / 100; stolen += take; }
    }
    const coin = Math.floor(hh.purse * 0.1);
    if (coin > 0) { hh.purse -= coin; stolen += coin / 12; }
    H.state.touchHousehold(hh);
  }
  let burned = 0;
  if (rng.chance(0.5)) {
    const barns = (H.state.buildingsAt.get(sid) ?? []).filter((b) => !b.onFire && !FIREPROOF.has(b.kind) && b.damage < 0.5 && ['barn', 'granary', 'tithe_barn', 'stable', 'cowshed', 'hovel', 'cottage'].includes(b.kind));
    if (barns.length) { ignite(H, rng.pick(barns)); burned = 1; if (!H.activeAtOf('fire', sid)) H.begin('fire', { settlement: sid, days: 2, level: 0.3, quiet: true }); }
  }
  const victims = rng.int(0, 2);
  const res = H.state.residentList(sid).filter((p) => !p.death && p.rankTier <= 3);
  for (let i = 0; i < victims && res.length > 0; i++) {
    const p = res[Math.floor(rng.next() * res.length)];
    const combat = H.sim.services.combat;
    if (combat) combat.harm(p.id, 0.6, 'bandits');
    else if (rng.chance(0.3)) killPerson(H.sim, p, 'violence', H.day);
  }
  H.sim.events.emit('raid', { settlement: sid, raider: 0, burned, stolen: Math.round(stolen), captives: 0 });
  H.end(rec, {}, true);
  const text = `Bandits raided ${H.placeName(sid)}, carrying off ${Math.round(stolen)} measures of stores${burned ? ' and burning a barn' : ''}.`;
  if (H.relevant(sid, -1)) { H.notifyPlayer(text, 'loss'); H.state.log(H.day, 'happening', text, [H.playerId]); }
  else H.state.log(H.day, 'happening', text, []);
}

// ---------------------------------------------------------------------------------------------
// Peasant revolt
// ---------------------------------------------------------------------------------------------

function unfreeShare(H: Hap, sid: number): number {
  const res = H.state.residentsOf(sid);
  if (res.length === 0) return 0;
  let n = 0;
  for (const p of res) if (p.estate === 'unfree') n++;
  return n / res.length;
}

export function startRevolt(H: Hap, sid: number): HappeningRec | null {
  if (!H.settlementById.has(sid) || H.activeAtOf('revolt', sid)) return null;
  const rebels = Math.round(H.state.residentsOf(sid).filter((p) => p.estate === 'unfree' && p.health.hp > 0.5).length * 0.3);
  return H.begin('revolt', { settlement: sid, days: 4, level: 0.6, data: { rebels }, important: true });
}

function revoltRoll(H: Hap): void {
  const rng = H.rng();
  for (const s of H.world.settlements) {
    if (s.kind === 'castle' || s.kind === 'city') continue;
    const ss = H.state.settlements.get(s.id);
    if (!ss || ss.prosperity > 0.72 || unfreeShare(H, s.id) < 0.2) continue;
    if (H.activeAtOf('revolt', s.id) || H.cooling(`revolt:${s.id}`, 24)) continue;
    if (rng.chance(0.22 * H.diff('revolt'))) startRevolt(H, s.id);
  }
}

function resolveRevolt(H: Hap, rec: HappeningRec): void {
  const sid = rec.settlement;
  const rng = H.rng();
  const rebels = Number(rec.data?.rebels ?? 5);
  const defence = garrison(H, sid) + (H.sim.services.military ? 2 : 0);
  const pSuppress = (defence + 4) / (defence + 4 + rebels * 0.25);
  const ss = H.state.settlements.get(sid);
  const lord = lordOf(H, sid);
  if (rng.chance(pSuppress)) {
    // the lord's men break the rising; the ringleaders hang
    const leaders = H.state.residentList(sid).filter((p) => p.estate === 'unfree' && !p.death && p.trained.cha >= 11).slice(0, rng.int(1, 3));
    for (const p of leaders) killPerson(H.sim, p, 'execution', H.day);
    if (ss) { ss.prosperity = Math.max(0.35, ss.prosperity - 0.04); H.state.touchSettlement(ss); }
    H.end(rec, {}, true);
    const text = `The rising at ${H.placeName(sid)} was put down; ${leaders.length} were hanged.`;
    if (H.relevant(sid, -1)) { H.notifyPlayer(text, 'warn'); H.state.log(H.day, 'happening', text, [H.playerId]); }
    else H.state.log(H.day, 'happening', text, []);
  } else {
    // the lord gives way: some villeins are made free
    let freed = 0;
    for (const p of H.state.residentList(sid)) {
      if (p.estate === 'unfree' && !p.death && rng.chance(0.12)) { p.estate = 'free'; if (p.rankTier < 2) p.rankTier = 2; H.state.touch(p); freed++; }
    }
    if (lord) { lord.prestige -= 2; H.state.touch(lord); }
    const manor = (H.state.buildingsAt.get(sid) ?? []).find((b) => b.kind === 'manor_house' || b.kind === 'great_hall');
    if (manor) { manor.damage = Math.min(0.6, manor.damage + 0.2); H.state.touchBuilding(manor); markRepair(H, manor.id); }
    H.end(rec, {}, true);
    const text = `The villagers of ${H.placeName(sid)} won their demands; ${freed} were freed from the manor.`;
    if (H.relevant(sid, -1)) { H.notifyPlayer(text, 'info'); H.state.log(H.day, 'happening', text, [H.playerId]); }
    else H.state.log(H.day, 'happening', text, []);
  }
}

// ---------------------------------------------------------------------------------------------
// Succession crises
// ---------------------------------------------------------------------------------------------

/** A realm, county or barony in the hands of a child (regency), shared among coheiresses, or without a holder is in crisis. */
function successionWatch(H: Hap): void {
  for (const t of H.state.titles.values()) {
    if (t.kind !== 'kingdom' && t.kind !== 'county' && t.kind !== 'barony') continue;
    const trouble = t.holder === 0 ? 'vacant' : t.regent !== 0 ? 'regency' : t.coholders.length > 1 ? 'coheiresses' : '';
    if (!trouble) continue;
    if (H.save.active.some((r) => r.kind === 'succession' && r.data?.title === t.id) || H.cooling(`succession:t${t.id}`, 64)) continue;
    const seat = t.kind === 'kingdom' ? H.world.kingdoms.find((k) => k.id === t.place)?.capital
      : t.kind === 'county' ? H.world.counties.find((c) => c.id === t.place)?.seat : t.place;
    if (seat === undefined || !H.settlementById.has(seat)) continue;
    const holder = H.state.persons.get(t.holder);
    const who = holder ? (trouble === 'regency' ? `The young ${fullName(holder)}` : fullName(holder)) : `The ${t.name}`;
    H.save.cool[`succession:t${t.id}`] = H.day;
    H.begin('succession', { settlement: seat, days: 8, level: t.kind === 'kingdom' ? 1 : 0.5, vars: { who, place: t.name }, data: { title: t.id }, important: t.kind !== 'barony' });
  }
  for (const rec of H.activeOf('succession')) if (H.day >= rec.end) H.end(rec, { place: H.placeName(rec.settlement) });
}
