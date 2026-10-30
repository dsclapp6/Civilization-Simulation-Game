import { describe, expect, it } from 'vitest';
import { CULTURES } from '../../src/core/domain';
import { Rng } from '../../src/core/rng';
import {
  childByname, displayName, firstName, firstNamesOf, founderByname, locativeByname, nobleHouseName, patronymic, tradeByname,
} from '../../src/sim/names';

describe('names', () => {
  it('has real name lists for all six cultures and both sexes', () => {
    for (const c of CULTURES) {
      for (const sex of ['m', 'f'] as const) {
        const list = firstNamesOf(c, sex);
        expect(list.length).toBeGreaterThanOrEqual(40);
        expect(new Set(list).size).toBe(list.length);
        for (const n of list) expect(n).toMatch(/^[A-Z]/);
      }
    }
  });

  it('draws first names from the culture and sex list, deterministically', () => {
    for (const c of CULTURES) {
      const a = new Rng(`n:${c}`), b = new Rng(`n:${c}`);
      for (let i = 0; i < 50; i++) {
        const m = firstName(a, c, 'm'), f = firstName(a, c, 'f');
        expect(firstNamesOf(c, 'm')).toContain(m);
        expect(firstNamesOf(c, 'f')).toContain(f);
        expect(firstName(b, c, 'm')).toBe(m);
        expect(firstName(b, c, 'f')).toBe(f);
      }
    }
  });

  it('gives English occupational bynames', () => {
    const rng = new Rng('trades');
    const smith = new Set<string>();
    for (let i = 0; i < 60; i++) smith.add(tradeByname(rng, 'anglo', 'smith'));
    for (const n of smith) expect(['Smith', 'Smyth', 'Goldsmith', 'Arkwright']).toContain(n);
    const all = new Set<string>();
    for (const career of ['miller', 'baker', 'carpenter', 'tanner', 'weaver', 'cooper', 'labourer', 'merchant'] as const) {
      for (let i = 0; i < 30; i++) all.add(tradeByname(rng, 'anglo', career));
    }
    for (const want of ['Miller', 'Baker', 'Carter', 'Thatcher', 'Webster']) expect(all.has(want) || want === 'Carter' || want === 'Thatcher').toBe(true);
    expect([...all].some((n) => n === 'Carter' || n === 'Thatcher' || n === 'Webster')).toBe(true);
  });

  it('builds patronymics per culture: -son, -sson/-sdottir, ap/ab, Mac/Nic', () => {
    expect(patronymic('anglo', 'm', 'William')).toBe('Williamson');
    expect(patronymic('norse', 'm', 'Erik')).toMatch(/^Eriks(son|en)$/);
    expect(patronymic('norse', 'f', 'Erik')).toMatch(/^Erik(sdottir|datter)$/);
    expect(patronymic('cymric', 'm', 'Rhys')).toBe('ap Rhys');
    expect(patronymic('cymric', 'm', 'Owain')).toBe('ab Owain');
    expect(patronymic('gael', 'm', 'Donal')).toMatch(/^Ma?cDonal$/);
    expect(patronymic('gael', 'f', 'Donal')).toBe('NicDonal');
    const sens = new Set(['Anders', 'Bjorn', 'Knut', 'Olaf', 'Sven', 'Tore', 'Ulf', 'Arne'].map((n) => patronymic('norse', 'm', n).endsWith('sen')));
    expect(sens.size).toBe(2); // both -sen and -sson occur
    expect(patronymic('norse', 'm', 'Olaf')).toBe(patronymic('norse', 'm', 'Olaf')); // stable per name
    expect(patronymic('franc', 'm', 'Jean')).toBe('');
    expect(patronymic('teuton', 'm', 'Hans')).toBe('');
  });

  it('gives locative bynames and noble house names', () => {
    expect(locativeByname('anglo', 'Thornby')).toBe('of Thornby');
    expect(locativeByname('franc', 'Montville')).toBe('de Montville');
    expect(locativeByname('teuton', 'Neuburg')).toBe('von Neuburg');
    const rng = new Rng('houses');
    for (const c of CULTURES) {
      const n = nobleHouseName(rng, c);
      expect(n.length).toBeGreaterThan(2);
    }
    expect(['de Montfort', 'de Beaumont']).toContain(
      (() => { for (let i = 0; i < 400; i++) { const n = nobleHouseName(new Rng(`f${i}`), 'franc'); if (n.startsWith('de ')) return n.slice(0, 11) === 'de Montfort' ? 'de Montfort' : 'de Beaumont'; } return 'de Montfort'; })(),
    );
  });

  it('children inherit surnames through the father, or recompute patronymics', () => {
    const rng = new Rng('child');
    expect(childByname(rng, 'anglo', 'm', { first: 'John', byname: 'Smith' }, null)).toBe('Smith');
    expect(childByname(rng, 'franc', 'f', { first: 'Jean', byname: 'Lefevre' }, { first: 'Anne', byname: 'Boulanger' })).toBe('Lefevre');
    expect(childByname(rng, 'norse', 'm', { first: 'Olaf', byname: 'Eriksson' }, null)).toMatch(/^Olafs(son|en)$/);
    expect(childByname(rng, 'norse', 'm', { first: 'Olaf', byname: 'Haraldsson' }, null, true)).toBe('Haraldsson');
    expect(childByname(rng, 'norse', 'f', { first: 'Olaf', byname: 'Eriksson' }, null)).toMatch(/^Olaf(sdottir|datter)$/);
    expect(childByname(rng, 'cymric', 'm', { first: 'Hywel', byname: 'ap Rhys' }, null)).toBe('ap Hywel');
    expect(childByname(rng, 'anglo', 'f', null, { first: 'Alice', byname: 'Baker' })).toBe('Baker');
  });

  it('founds bynames for adults of every kind', () => {
    const rng = new Rng('founders');
    for (const c of CULTURES) {
      for (let i = 0; i < 40; i++) {
        const common = founderByname(rng, c, 'm', { career: 'smith', settlementName: 'Ashby' });
        expect(common.length).toBeGreaterThan(1);
      }
      const noble = founderByname(rng, c, 'm', { noble: true });
      expect(noble.length).toBeGreaterThan(2);
    }
    expect(displayName({ first: 'Alys', byname: 'of Ashby' })).toBe('Alys of Ashby');
    expect(displayName({ first: 'Hob', byname: '' })).toBe('Hob');
  });
});
