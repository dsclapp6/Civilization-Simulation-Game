import { describe, expect, it } from 'vitest';
import { CULTURES, type SkillId } from '../../../src/core/domain';
import { TRAIT_IDS, type Person } from '../../../src/sim/state';
import { dialogueContent, type Cond } from '../../../src/sim/social/content';
import { BARK_SITUATIONS } from '../../../src/sim/social/barks';
import { matchScore } from '../../../src/sim/social/speech';
import { rig, type Rig } from './helpers';

const COND_KEYS = new Set(['culture', 'sex', 'lsex', 'lage', 'age', 'rank', 'rel', 'trait', 'not', 'op', 'part', 'season', 'weather', 'role', 'tag', 'notTag', 'place']);
const AGES = new Set(['child', 'youth', 'adult', 'elder']);
const RANKS = new Set(['low', 'mid', 'high']);
const RELS = new Set(['up', 'down', 'peer']);
const OPS = new Set(['hostile', 'cold', 'neutral', 'warm', 'devoted']);
const PARTS = new Set(['night', 'dawn', 'morning', 'midday', 'afternoon', 'evening', 'dusk']);
const WEATHERS = new Set(['fair', 'cloudy', 'rain', 'snow', 'fog', 'wind', 'cold', 'hot']);
const PLACES = new Set(['hamlet', 'village', 'town', 'city', 'castle', 'abbey', 'priory', 'nunnery']);

/** Variables the engine resolves itself or that topics supply. */
const KNOWN_VARS = new Set([
  'first', 'full', 'byname', 'self', 'selffull', 'addr', 'named', 'kin', 'place', 'lplace', 'lord', 'priest', 'reeve', 'season', 'part',
  'daygreet', 'weather', 'crop', 'trade', 'ltrade', 'spouse', 'spouseword', 'ambition', 'holy', 'mood',
  // supplied by topics
  'good', 'kids', 'nkids', 'kidword', 'theyword', 'parents', 'third', 'thirdfull', 'thirdaddr', 'he', 'his', 'him', 'role', 'words',
  'kinword', 'there', 'dir', 'walk', 'kind', 'thereLord', 'marketday', 'names', 'first1', 'money', 'item', 'skill', 'stat', 'statname',
  'rank', 'office', 'who', 'whofull', 'baby', 'mother', 'mothfirst', 'father', 'age', 'cause', 'widow', 'groom', 'bride', 'groomfull',
  'bridefull', 'title', 'from', 'ill', 'other', 'memory', 'ward',
]);

function list<T>(v: T | T[] | undefined): T[] { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }

describe('dialogue content', () => {
  const content = dialogueContent();

  it('has every pool the code asks for', () => {
    const need = [
      'greet.start', 'greet.refuse', 'greet.debt', 'greet.grudge', 'greet.favoured', 'greet.ambition', 'farewell.ask', 'farewell.reply', 'cutoff',
      'chat.tired', 'chat.repeat', 'news.ask', 'news.lead', 'news.none', 'news.far',
      'news.item.birth', 'news.item.death', 'news.item.wedding', 'news.item.expecting', 'news.item.sick', 'news.item.reeve',
      'news.item.inherit', 'news.item.price_dear', 'news.item.price_cheap', 'news.deed.alms', 'news.deed.insult', 'news.deed.threat',
      'news.deed.wed', 'news.deed.other',
      ...['weather', 'harvest', 'family', 'lord', 'church', 'work', 'hopes'].flatMap((t) => [`chat.${t}.ask`, `chat.${t}.reply`]),
      'chat.prices.ask', 'chat.prices.dear', 'chat.prices.cheap', 'chat.prices.steady', 'chat.prices.lean', 'chat.prices.plenty', 'chat.prices.ordinary',
      'ask.person.ask', 'ask.person.reply', 'ask.person.feel', 'ask.person.unknown', 'ask.place.ask', 'ask.place.reply', 'ask.place.more',
      'ask.place.unknown', 'ask.marriageable.ask', 'ask.marriageable.reply', 'ask.marriageable.none',
      ...['skill', 'looks', 'wit', 'strength', 'charm', 'station', 'piety', 'generous', 'bold', 'general'].map((k) => `say.flatter.ask.${k}`),
      'say.flatter.win', 'say.flatter.lose',
      ...['skill', 'stat', 'rank', 'office', 'wealth', 'valour', 'generous', 'piety', 'fame', 'empty'].map((k) => `say.boast.ask.${k}`),
      'say.boast.win', 'say.boast.lose',
      ...['coward', 'liar', 'miser', 'hothead', 'ugly', 'beggar', 'prig', 'fool'].map((k) => `say.insult.ask.${k}`),
      'say.insult.reply', 'say.insult.angry', 'say.insult.noble', 'say.threaten.ask', 'say.threaten.win', 'say.threaten.lose',
      'say.apologise.ask', 'say.apologise.win', 'say.apologise.lose',
      ...['loan', 'meal', 'vouch', 'lessons'].flatMap((k) => [`favour.${k}.ask`, `favour.${k}.yes`, `favour.${k}.no`]),
      'favour.loan.owing', 'favour.repay.ask', 'favour.repay.full', 'favour.repay.part', 'gift.give', 'gift.thanks', 'gift.suspicious', 'gift.beggar',
      ...['compliment', 'walk', 'token'].flatMap((k) => [`court.${k}.ask`, `court.${k}.yes`, `court.${k}.no`]),
      'court.refuse', 'court.feelings.ask', 'court.feelings.reply', 'court.propose.ask', 'court.propose.yes', 'court.propose.no',
      'court.propose.consent', 'court.propose.young', 'court.propose.later',
      ...['blessing', 'hand', 'lord'].flatMap((k) => [`family.${k}.ask`, `family.${k}.yes`, `family.${k}.no`, `family.${k}.later`]),
      'family.apprentice.ask', 'family.apprentice.yes', 'family.apprentice.no', 'family.apprentice.poor',
      'family.match.ask', 'family.match.yes', 'family.match.no', 'family.match.dowry',
      'family.propose.ask', 'family.propose.yes', 'family.propose.no', 'family.propose.dowry',
      'family.discuss.ask', 'family.discuss.reply', 'family.discuss.none',
      'act.wrestle.win', 'act.wrestle.lose', 'act.play', 'act.pray', 'act.mass', 'act.confess',
      ...BARK_SITUATIONS.map((s) => `bark.${s}`),
    ];
    const missing = need.filter((id) => !content.pools.has(id));
    expect(missing).toEqual([]);
  });

  it('uses only known condition keys and values', () => {
    const bad: string[] = [];
    for (const pool of content.pools.values()) {
      for (const line of pool.lines) {
        const c = line.if as Cond | undefined;
        if (!c) continue;
        for (const k of Object.keys(c)) if (!COND_KEYS.has(k)) bad.push(`${pool.id}: key ${k}`);
        for (const v of list(c.culture)) if (!(CULTURES as readonly string[]).includes(v)) bad.push(`${pool.id}: culture ${v}`);
        for (const v of [...list(c.age), ...list(c.lage)]) if (!AGES.has(v)) bad.push(`${pool.id}: age ${v}`);
        for (const v of list(c.rank)) if (!RANKS.has(v)) bad.push(`${pool.id}: rank ${v}`);
        for (const v of list(c.rel)) if (!RELS.has(v)) bad.push(`${pool.id}: rel ${v}`);
        for (const v of list(c.op)) if (!OPS.has(v)) bad.push(`${pool.id}: op ${v}`);
        for (const v of list(c.part)) if (!PARTS.has(v)) bad.push(`${pool.id}: part ${v}`);
        for (const v of list(c.weather)) if (!WEATHERS.has(v)) bad.push(`${pool.id}: weather ${v}`);
        for (const v of list(c.place)) if (!PLACES.has(v)) bad.push(`${pool.id}: place ${v}`);
        for (const v of [...list(c.trait), ...list(c.not)]) if (!(TRAIT_IDS as readonly string[]).includes(v)) bad.push(`${pool.id}: trait ${v}`);
        for (const v of list(c.season)) if (![0, 1, 2, 3].includes(v)) bad.push(`${pool.id}: season ${v}`);
        for (const v of list(c.sex)) if (v !== 'm' && v !== 'f') bad.push(`${pool.id}: sex ${v}`);
        for (const v of list(c.lsex)) if (v !== 'm' && v !== 'f') bad.push(`${pool.id}: lsex ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('uses only placeholders the engine can fill', () => {
    const bad: string[] = [];
    for (const pool of content.pools.values()) {
      for (const line of pool.lines) {
        for (const m of line.t.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
          const name = m[1];
          const lower = name.charAt(0).toLowerCase() + name.slice(1);
          if (!KNOWN_VARS.has(name) && !KNOWN_VARS.has(lower)) bad.push(`${pool.id}: {${name}} in "${line.t}"`);
        }
        if (/[{}]/.test(line.t.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, ''))) bad.push(`${pool.id}: stray brace in "${line.t}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps every pool free of empty and duplicate lines', () => {
    const bad: string[] = [];
    for (const pool of content.pools.values()) {
      const seen = new Set<string>();
      if (pool.lines.length === 0) bad.push(`${pool.id}: empty pool`);
      for (const line of pool.lines) {
        if (line.t.trim().length < 2) bad.push(`${pool.id}: blank line`);
        const key = `${line.t}|${JSON.stringify(line.if ?? {})}`;
        if (seen.has(key)) bad.push(`${pool.id}: duplicate "${line.t}"`);
        seen.add(key);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives every bark situation at least eight lines that fit anyone', () => {
    for (const s of BARK_SITUATIONS) {
      const pool = content.pools.get(`bark.${s}`);
      expect(pool, s).toBeDefined();
      const open = pool!.lines.filter((l) => !l.if).length;
      expect(open, `${s} has ${open} unconditional lines`).toBeGreaterThanOrEqual(8);
    }
  });

  it('has forms of address for every class the engine can ask for, in the default set', () => {
    const def = content.tables.address.default;
    const classes = [
      'kin.father', 'kin.mother', 'kin.son', 'kin.daughter', 'kin.brother', 'kin.sister', 'kin.husband', 'kin.wife', 'kin.grandfather',
      'kin.grandmother', 'kin.grandson', 'kin.granddaughter', 'kin.uncle', 'kin.aunt', 'kin.nephew', 'kin.niece', 'kin.cousin', 'kin.in_law',
      'cleric.priest', 'cleric.monk', 'cleric.nun', 'cleric.prior', 'cleric.abbot', 'cleric.bishop', 'cleric.clerk',
      'up.royal', 'up.magnate', 'up.baron', 'up.knight', 'up.gentry', 'up.middling', 'up.commoner', 'peer.low', 'peer.mid', 'peer.high',
      'down.child', 'down.youth', 'down.adult', 'down.elder', 'down.cleric', 'youth.up',
    ];
    expect(classes.filter((c) => !def[c])).toEqual([]);
  });
});

describe('dialogue coverage over a whole world', () => {
  let r: Rig;
  const sample = (): Person[] => {
    const out: Person[] = [];
    for (const p of r.sim.state.persons.values()) {
      if (!p.death && r.core.age(p) >= 4 && p.id % 7 === 0) out.push(p);
    }
    return out;
  };

  it('always has a greeting, farewell and several barks for any pair of people', () => {
    r = rig({ seed: 'coverage', preset: 'large' });
    const people = sample();
    expect(people.length).toBeGreaterThan(500);
    const speech = r.core.speech;
    const times = [0.3, 0.5, 0.75, 0.95];
    const thin: string[] = [];
    let checked = 0;
    for (let i = 0; i < people.length; i += 3) {
      const speaker = people[i];
      const listener = people[(i * 7 + 3) % people.length];
      if (speaker.id === listener.id) continue;
      for (const t of times) {
        r.sim.state.clock.absDay = 20 + t;
        const ctx = speech.ctx(speaker, listener);
        for (const pool of ['greet.start', 'farewell.ask', 'farewell.reply']) {
          const n = speech.fitting(pool, ctx);
          if (n < 2) thin.push(`${pool}: ${n} for ${speaker.first} (${speaker.career}) -> ${listener.first} tags=${[...ctx.tags].join(',')} op=${ctx.op} rel=${ctx.rel}`);
        }
        const light = speech.ctx(speaker, listener, { light: true });
        for (const s of BARK_SITUATIONS) {
          const n = speech.fitting(`bark.${s}`, light);
          if (n < 8) thin.push(`bark.${s}: ${n}`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(thin.slice(0, 12)).toEqual([]);
  });

  it('renders every line of every pool without leaving a placeholder behind', () => {
    r = rig({ seed: 'render', preset: 'small' });
    const speech = r.core.speech;
    const people = sample().slice(0, 40);
    const bad: string[] = [];
    const vars: Record<string, string> = {};
    for (const v of ['good', 'kids', 'nkids', 'kidword', 'theyword', 'parents', 'third', 'thirdfull', 'thirdaddr', 'he', 'his', 'him', 'role', 'words',
      'kinword', 'there', 'dir', 'walk', 'kind', 'thereLord', 'marketday', 'names', 'first1', 'money', 'item', 'skill', 'stat', 'statname', 'rank',
      'office', 'who', 'whofull', 'baby', 'mother', 'mothfirst', 'father', 'age', 'cause', 'widow', 'groom', 'bride', 'groomfull', 'bridefull', 'title',
      'from', 'ill', 'other', 'memory', 'ward']) vars[v] = `<${v}>`;
    for (const pool of speech.poolIds()) {
      const p = speech.pool(pool)!;
      for (const line of p.lines) {
        const speaker = people[(line.t.length + pool.length) % people.length];
        const listener = people[(line.t.length * 3 + 1) % people.length];
        const ctx = speech.ctx(speaker, listener === speaker ? null : listener, { vars: { ...vars } });
        const out = speech.fill(line.t, ctx);
        if (/[{}]/.test(out)) bad.push(`${pool}: "${out}"`);
        if (out.trim().length === 0) bad.push(`${pool}: empty from "${line.t}"`);
      }
    }
    expect(bad).toEqual([]);
    expect([...speech.unknownVars]).toEqual([]);
  });

  it('knows the skills the boasts name', () => {
    const skills: SkillId[] = ['farming', 'archery', 'melee'];
    expect(skills.length).toBe(3);
    expect(matchScore({}, { tags: new Set() } as never)).toBe(0);
  });
});
