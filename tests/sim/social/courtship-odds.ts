// How long does a courtship take, and how often does it succeed, with honest dice?
//   npx tsx tests/sim/social/courtship-odds.ts [trials]
// Plays the obvious strategy (compliment, walk out and a small token each day, then propose) against a
// villager of the same standing, for suitors of different charm, and prints the days it took.
import { createPerson } from '../../../src/sim/people';
import { installSocial, socialInternals } from '../../../src/sim/social';
import type { Person } from '../../../src/sim/state';
import { mkHouse, mkHousehold, mkPerson, makePlayer } from '../builders';
import { newSim } from '../helpers';

void createPerson;
const trials = Number(process.argv[2] ?? '40');

function trial(seed: string, cha: number, comely: boolean, herTier: 2 | 3 = 2, ambitious = false): { days: number; ok: boolean; wed: boolean } {
  const sim = newSim({ seed, preset: 'tiny' });
  const social = installSocial(sim);
  const core = socialInternals(sim)!;
  const st = sim.state;
  const old = st.persons.get(st.run.playerId)!;
  const me = mkPerson(sim, { sex: 'm', age: 19, household: old.household, father: st.persons.get(old.father) ?? null, mother: st.persons.get(old.mother) ?? null, byname: 'Hero' });
  makePlayer(sim, me);
  me.trained.cha = cha;
  if (comely) me.traits.push('comely');
  me.money = 600;
  const hh = mkHousehold(sim, me.settlement);
  const her = mkPerson(sim, { sex: 'f', age: 18, household: hh.id, settlement: hh.settlement, house: mkHouse(sim, 'Belove').id, byname: 'Belove', tier: herTier });
  if (ambitious) her.traits = ['ambitious'];
  st.setHead(hh, her);
  st.clock.absDay = 0.5; st.clock.firedHour = 12;
  for (let day = 1; day <= 60; day++) {
    st.clock.absDay = day + 0.5; st.clock.firedHour = Math.floor(st.clock.absDay * 24);
    me.money = Math.max(me.money, 100);
    const c = social.start(me.id, her.id);
    if ('ok' in c) continue;
    let cur = social.choose(c.id, 'nav.court');
    for (const g of ['romance.compliment', 'romance.walk', 'romance.token']) {
      const o = cur.options.find((x) => x.id === g);
      if (o && o.enabled && !cur.ended) cur = social.choose(cur.id, g);
    }
    social.end(cur.id);
    const rec = social.courtship(me.id, her.id);
    if (rec && rec.progress >= 1) {
      const res = social.propose(me.id, her.id);
      if (res.ok) return { days: day, ok: true, wed: true };
    }
  }
  void core;
  return { days: 60, ok: false, wed: false };
}

for (const [label, cha, comely, tier, amb] of [['plain (CHA 8)', 8, false, 2, false], ['average (CHA 10)', 10, false, 2, false], ['charming (CHA 14)', 14, false, 2, false], ['charming and comely', 14, true, 2, false], ['average -> higher rank', 10, false, 3, false], ['average -> ambitious higher', 10, false, 3, true]] as const) {
  const results = Array.from({ length: trials }, (_, i) => trial(`odds-${label}-${i}`, cha, comely, tier, amb));
  const wed = results.filter((r) => r.wed);
  const days = wed.map((r) => r.days).sort((a, b) => a - b);
  console.log(`${label.padEnd(22)} wed ${wed.length}/${trials}  median ${days[Math.floor(days.length / 2)] ?? '-'} days  (min ${days[0] ?? '-'}, max ${days[days.length - 1] ?? '-'})`);
}
export type { Person };
