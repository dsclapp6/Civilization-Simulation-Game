// The builder's catalogue: every kind of building with what it costs, what it needs and whether this person may raise it in
// this place (and, if not, why: "What you may not build is shown and says why", CIV §5).
import { BUILDINGS, BUILDING_KINDS } from '../../content/types';
import type { PersonId } from '../state';
import { permitReason, type Standing } from './check';
import type { Construction } from './core';
import { levelCost, maxPerSettlement, rulesOf } from './data';
import { noScopeReason, scopeInfo } from './scope';
import type { BuildOption, BuildRequirement } from './types';

export function catalogue(C: Construction, personId: PersonId, settlement: number): BuildOption[] {
  const si = scopeInfo(C, personId);
  const out: BuildOption[] = [];
  let st: Standing | null = null;
  let whyNot = '';
  if (!si) whyNot = noScopeReason(C, personId);
  else if (settlement < 0) {
    if (si.outposts) st = { mode: 'found', settlement: -1 };
    else whyNot = 'Open country: only a baron or greater may found an outpost here';
  } else {
    const a = si.auth.get(settlement);
    if (a) st = { mode: a.kind, auth: a, settlement };
    else if (si.isHead && si.own && si.own.settlement === settlement) st = { mode: 'own', settlement };
    else whyNot = `You hold no land in ${C.settlementName(settlement)}`;
  }
  for (const kind of BUILDING_KINDS) {
    const rules = rulesOf(kind);
    const def = BUILDINGS[kind];
    const requires: BuildRequirement = {};
    if (rules.tech) requires.tech = rules.tech;
    if (rules.terrain) requires.terrain = rules.terrain;
    if (rules.deposits && rules.deposits.length) { requires.deposit = rules.deposits[0]; requires.deposits = [...rules.deposits]; }
    requires.rank = st?.mode === 'own' ? rules.own : rules.rank;
    const cap = maxPerSettlement(kind, settlement >= 0 ? C.settlementKind(settlement) : undefined);
    if (cap !== Infinity) requires.max = cap;
    let reason: string | null = whyNot || null;
    if (!reason && si && st) reason = permitReason(C, si, st, kind, rules);
    const opt: BuildOption = {
      kind, name: def.name, category: rules.cat, level: 1, cost: levelCost(kind, 1), requires, does: rules.does, ok: !reason,
    };
    if (reason) opt.reason = reason;
    out.push(opt);
  }
  return out;
}
