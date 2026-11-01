// Headless pacing check (SPEC §21): runs a player-free continent (the character just lives in the village)
// and reports how often something turns up for the player, so the targets can be tuned. Times are minutes of play at 1x:
// a game day is DAY_SECONDS / 60 = ten of them, a year 2 h 40 min. Objectives (tutorial, chores, a job, goals: sim/objectives)
// fill the gaps between what happenings bring, so this tool measures only the happenings:
//   - a request from a neighbour about every 5-10 minutes; a disaster, feast or notice near by about every 10-15 (SPEC §21)
//   - something to improve (a technique within reach) every 15-45 minutes early on
//   npx tsx tools/pacing.ts [--years 10] [--preset tiny|small|large] [--seed x] [--difficulty knight] [--answer]
// `--answer` makes the character say yes to every request (a polite player), to see how the journal fills.
import { DAYS_PER_YEAR, DAY_SECONDS } from '../src/core/time';
import type { Difficulty } from '../src/core/domain';
import { installAdvancement } from '../src/sim/advancement';
import { installEconomy } from '../src/sim/economy';
import { newProfile } from '../src/sim/legacy';
import { Simulation } from '../src/sim/sim';
import { installSocial } from '../src/sim/social';
import { createMockWorld } from '../src/sim/testing/mockWorld';
import { generateWorld } from '../src/world/generate';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
/** Minutes of play at 1x in one game day. */
const MIN_PER_DAY = DAY_SECONDS / 60;

const seed = arg('seed', 'pacing');
const years = Number(arg('years', '10'));
const preset = arg('preset', 'small') as 'tiny' | 'small' | 'large' | 'real';
const difficulty = arg('difficulty', 'knight') as Difficulty;

const sim = Simulation.newGame({
  seed, difficulty, profile: newProfile(),
  generateWorld: (s) => (preset === 'real' ? generateWorld(s) : createMockWorld({ seed: s, preset })),
});
const social = installSocial(sim);
const economy = installEconomy(sim, { social });
const adv = installAdvancement(sim, { economy, social });
const hap = adv.happenings;

interface Item { day: number; kind: string }

/** What turns up for the player: requests, trouble (disasters), occasions (feasts, fairs, tournaments); gatherings are colour. */
const TROUBLE = new Set(['plague', 'famine', 'fire', 'flood', 'drought', 'winter', 'bandits', 'revolt', 'succession']);
const OCCASION = new Set(['tournament', 'fair', 'progress', 'midsummer', 'harvest', 'christmas']);
const category = (kind: string): 'request' | 'trouble' | 'occasion' | 'gathering' => (kind === 'request' ? 'request' : TROUBLE.has(kind) ? 'trouble' : OCCASION.has(kind) ? 'occasion' : 'gathering');
const items: Item[] = [];
const perYear: Array<{ events: Record<string, number>; requests: number; notices: number; techs: number; deaths: number }> = [];
const bucket = (day: number): (typeof perYear)[number] => {
  const y = Math.floor(day / DAYS_PER_YEAR);
  while (perYear.length <= y) perYear.push({ events: {}, requests: 0, notices: 0, techs: 0, deaths: 0 });
  return perYear[y];
};

sim.events.on('request', (e) => { items.push({ day: sim.absDay, kind: 'request' }); bucket(sim.absDay).requests++; if (flag('answer')) { hap.acceptRequest(e.id); } });
sim.events.on('happening', (e) => {
  if (e.phase !== 'start') return;
  const b = bucket(sim.absDay);
  b.events[e.kind] = (b.events[e.kind] ?? 0) + 1;
  const kingdom = e.settlement >= 0 ? sim.world.settlements.find((s) => s.id === e.settlement)?.kingdom ?? -1 : -1;
  if (adv.happenings.hap.relevant(e.settlement, kingdom)) { items.push({ day: sim.absDay, kind: e.kind }); b.notices++; }
});
sim.events.on('tech', () => { bucket(sim.absDay).techs++; });
sim.events.on('death', () => { bucket(sim.absDay).deaths++; });
sim.events.on('playerDied', (e) => { if (e.eligible.length) sim.switchTo(e.eligible[0]); });

const t0 = performance.now();
sim.scheduler.profiling = true;
for (let y = 0; y < years; y++) {
  sim.advanceDays(DAYS_PER_YEAR);
  if (sim.state.run.phase !== 'alive') { console.log(`(the line died out in year ${y + 1})`); break; }
}
const secs = (performance.now() - t0) / 1000;

// ---- report ----
const kinds = new Set<string>();
for (const y of perYear) for (const k of Object.keys(y.events)) kinds.add(k);
const cols = [...kinds].sort();
console.log(`pacing: ${preset} world, seed ${seed}, ${difficulty}, ${perYear.length} years (${perYear.length * DAYS_PER_YEAR * MIN_PER_DAY} minutes of play at 1x)`);
console.log(['year', 'requests', 'near', ...cols, 'techs', 'deaths'].map((h) => h.padStart(11)).join(''));
perYear.forEach((y, i) => {
  console.log([String(i + 1), String(y.requests), String(y.notices), ...cols.map((k) => String(y.events[k] ?? 0)), String(y.techs), String(y.deaths)].map((c) => c.padStart(11)).join(''));
});

// the gaps between things that turn up for the player, in minutes of play at 1x
items.sort((a, b) => a.day - b.day);
const total = perYear.length * DAYS_PER_YEAR * MIN_PER_DAY;
const count = (c: string): number => items.filter((i) => category(i.kind) === c).length;
const every = (n: number): string => (n ? `one every ${(total / n).toFixed(1)} minutes` : 'none');
console.log('');
console.log(`in ${total} minutes of play at 1x, near the player (3.5 km):`);
console.log(`  requests ${count('request')} (${every(count('request'))}), trouble ${count('trouble')} (${every(count('trouble'))}), occasions ${count('occasion')} (${every(count('occasion'))}), gatherings ${count('gathering')} (colour: ${every(count('gathering'))})`);
const dealt = items.filter((i) => category(i.kind) !== 'gathering');
const dgaps: number[] = [];
for (let i = 1; i < dealt.length; i++) dgaps.push((dealt[i].day - dealt[i - 1].day) * MIN_PER_DAY);
dgaps.sort((a, b) => a - b);
const dpct = (q: number): number => (dgaps.length ? dgaps[Math.min(dgaps.length - 1, Math.floor(dgaps.length * q))] : 0);
console.log(`something to deal with (request, trouble or occasion): ${dealt.length}, ${every(dealt.length)}; gaps (min) median ${dpct(0.5).toFixed(1)}, 90% ${dpct(0.9).toFixed(1)}, longest ${(dgaps[dgaps.length - 1] ?? 0).toFixed(1)}; ${dgaps.length ? Math.round((dgaps.filter((g) => g > 8).length / dgaps.length) * 100) : 0}% of gaps longer than 8 minutes (happenings alone: about one every 5-8 minutes; the objectives, the road's encounters and your own errands come on top, SPEC §21 wants something every 2-3 minutes)`);
const nearBy: Record<string, number> = {};
for (const i of items) nearBy[i.kind] = (nearBy[i.kind] ?? 0) + 1;
console.log(`near the player by kind: ${JSON.stringify(nearBy)}`);
const st = hap.stats();
console.log(`requests: ${JSON.stringify(st.requests)}`);
console.log(`events started in the world: ${JSON.stringify(st.started)}`);
const techs = adv.techs();
const known = techs.filter((t) => adv.holders(t.id).length > 0).length;
console.log(`techniques known by someone: ${known}/${techs.length}; preserved in books only: ${techs.filter((t) => adv.isPreserved(t.id)).length}; lost: ${techs.filter((t) => adv.isLost(t.id)).length}`);
for (const b of adv.branches()) {
  console.log(`  ${b.name.padEnd(20)} ${techs.filter((t) => t.branch === b.id).map((t) => `${t.id}:${adv.holders(t.id).length}`).join(' ')}`);
}
console.log(`\n${perYear.length} years in ${secs.toFixed(1)} s`);
for (const [name, p] of sim.scheduler.profile) {
  if (/^(tech|happenings)\./.test(name)) console.log(`  ${name.padEnd(22)} avg ${(p.totalMs / p.calls).toFixed(3)} ms  max ${p.maxMs.toFixed(2)} ms  calls ${p.calls}`);
}
