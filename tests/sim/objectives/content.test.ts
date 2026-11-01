// The wording is data (src/content/objectives/*.json): every text is whole, its placeholders are known, and
// nothing a player reads is ever left with a {placeholder}.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAINS, hasText, rawText, textKeys, type DictName } from '../../../src/sim/objectives/data';
import { active, allText, objSim, playObjectives, playerOf, runTo, skipTutorial, walkTo } from './helpers';

const DICTS: DictName[] = ['tutorial', 'chores', 'goals', 'text'];
const KNOWN = new Set([
  'head', 'headFull', 'headDesc', 'headRel', 'village', 'home', 'place', 'strip', 'nb', 'nbDesc', 'shop', 'shopDesc', 'keeper', 'church', 'priest', 'priestDesc',
  'steward', 'stewardDesc', 'pay', 'label', 'player', 'list', 'side', 'n', 'kind', 'title', 'days', 'employer', 'years', 'trade', 'master',
  'recruiter', 'price', 'tool', 'Tool', 'value', 'stat', 'skill', 'pct', 'name', 'town', 'goods', 'season', 'from', 'what', 'when', 'lord', 'have', 'to', 'day',
  'animal', 'dir', 'money', 'meet', 'meetDesc',
]);

describe('the wording', () => {
  for (const d of DICTS) {
    it(`${d}: no empty text, only known placeholders, balanced braces`, () => {
      for (const k of textKeys(d)) {
        const t = rawText(d, k)!;
        expect(t.trim().length, `${d}/${k}`).toBeGreaterThan(2);
        expect(t.split('{').length, `${d}/${k} braces`).toBe(t.split('}').length);
        for (const m of t.matchAll(/\{(\w+)\}/g)) expect(KNOWN.has(m[1]), `${d}/${k}: unknown placeholder {${m[1]}}`).toBe(true);
        expect(t, `${d}/${k} ends cleanly`).not.toMatch(/\s{2,}|\s$/);
      }
    });
  }

  it('every tutorial stage of every chain has its title and reason', () => {
    for (const [chain, stages] of Object.entries(CHAINS)) {
      expect(stages[0]).toBe('meet');
      expect(stages[stages.length - 1]).toBe('night');
      for (const id of stages) {
        expect(rawText('tutorial', `${id}.title`) ?? rawText('tutorial', `${id}.title.${chain}`), `${chain}/${id}.title`).toBeTruthy();
        if (id !== 'work') expect(rawText('tutorial', `${id}.why`) ?? rawText('tutorial', `${chain}:${id}.why`), `${chain}/${id}.why`).toBeTruthy();
      }
    }
  });

  it('every key the code asks for exists (literal keys by scanning the sources, built keys by listing them)', () => {
    const dir = join(__dirname, '../../../src/sim/objectives');
    const missing: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(/\bT\(\s*'(tutorial|chores|goals|text)'\s*,\s*'([^'$]+)'/g)) {
        const [, d, k] = m;
        // a chain may give its own variant, so any chain's prefix counts
        const ok = hasText(d as DictName, k) || Object.keys(CHAINS).some((c) => hasText(d as DictName, k, c));
        if (!ok) missing.push(`${f}: ${d}/${k}`);
      }
    }
    const tasks = ['plough', 'harrow', 'sow', 'weed', 'reap', 'bind', 'carry'];
    const kinds = ['strip', 'garden', 'stock', 'herd', 'craft', 'barn', 'dig'];
    const need: Array<[DictName, string]> = [];
    for (const t of tasks) need.push(['chores', `strip.${t}`], ['chores', `strip.title.${t}`], ['chores', `strip.why.${t}`]);
    for (const k of kinds) {
      need.push(['tutorial', `work.title.${k}`], ['tutorial', `work.why.${k}`]);
      if (k !== 'strip') need.push(['chores', `work.title.${k}`], ['chores', `work.why.${k}`]);
    }
    for (let i = 0; i < 3; i++) need.push(['chores', `say.set.${i}`]);
    for (let i = 0; i < 4; i++) need.push(['chores', `say.done.${i}`]);
    for (const id of ['farm.plough', 'farm.harrow', 'farm.sow', 'farm.weed', 'farm.reap', 'farm.bind']) need.push(['text', `verb.${id}.part`]);
    for (const [d, k] of need) if (!hasText(d, k)) missing.push(`built: ${d}/${k}`);
    expect(missing).toEqual([]);
  });

  it('nothing the player reads carries a {placeholder} over a few days of play', () => {
    const o = objSim({ seed: 's1' });
    const seen = new Set<string>();
    const collect = (): void => { for (const t of allText(o.obj.list())) seen.add(t); };
    collect();
    playObjectives(o, ['tutorial']);
    collect();
    for (let d = 0; d < 5; d++) {
      runTo(o, Math.floor(o.sim.absDay) + 1, 6);
      o.adv.happenings.offerRequest('fetch');
      collect();
      playObjectives(o, ['chore', 'job']);
      for (const s of o.obj.suggestions(8)) { seen.add(s.text); if (s.target) seen.add(s.target.label); }
      const sum = o.obj.daySummary();
      if (sum) for (const t of [...sum.work, ...sum.household, ...sum.tomorrow, ...sum.objectivesDone]) seen.add(t);
    }
    expect(seen.size).toBeGreaterThan(30);
    for (const t of seen) expect(t, t).not.toMatch(/\{\w+\}/);
  });
});

describe('while the player is away', () => {
  it('no chores are set for a player on the road, and an untouched one costs nothing', () => {
    const o = objSim({ seed: 's1' });
    skipTutorial(o);
    walkTo(o, o.at.x + 5000, o.at.z); // days from home
    runTo(o, 1, 6);
    expect(active(o, 'chore')).toHaveLength(0);
    // back home the same day: the chores are set at the next hour
    const home = o.sim.state.buildings.get(o.sim.state.households.get(playerOf(o.sim).household)!.home)!;
    walkTo(o, home.x, home.z);
    o.sim.advanceHours(1);
    expect(active(o, 'chore').length).toBeGreaterThan(0);
    // away again with chores open: they lapse without a fine
    const head = o.sim.state.persons.get(o.sim.state.households.get(playerOf(o.sim).household)!.head)!;
    const op0 = o.social.opinion(head.id, playerOf(o.sim).id);
    walkTo(o, home.x + 5000, home.z);
    runTo(o, 2, 6);
    expect(o.social.opinion(head.id, playerOf(o.sim).id)).toBeGreaterThanOrEqual(op0 - 0.01);
  });

  it('none in the map view either', () => {
    const o = objSim({ seed: 's1' });
    skipTutorial(o);
    o.sim.view.setSource('mode', () => 'map');
    runTo(o, 1, 6);
    expect(active(o, 'chore')).toHaveLength(0);
    o.sim.view.setSource('mode', () => 'street');
    o.sim.advanceHours(1);
    expect(active(o, 'chore').length).toBeGreaterThan(0);
  });
});
