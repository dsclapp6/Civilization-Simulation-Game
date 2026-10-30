// Perks (SPEC §5): effects of the perks a person has chosen, and the choice flow.
import type { SkillId } from '../../core/domain';
import { skillLevel } from '../people';
import { PERK_LEVELS, openPerkSlots } from '../skills';
import type { Person } from '../state';
import type { Econ } from './core';
import { PERKS, PERK_BY_ID, perksAt } from './data';
import type { PerkChoice, PerkDef, Result } from './types';

/** Sum of one effect over the perks a person chose in `skill` (0 if none). */
export function perkSum(p: Person, skill: SkillId, effect: string): number {
  if (p.perks.length === 0) return 0;
  let v = 0;
  for (const id of p.perks) {
    const d = PERK_BY_ID.get(id);
    if (d && d.skill === skill) v += d.effects?.[effect] ?? 0;
  }
  return v;
}

/** Sum of one effect over every chosen perk, whatever the skill. */
export function perkTotal(p: Person, effect: string): number {
  if (p.perks.length === 0) return 0;
  let v = 0;
  for (const id of p.perks) v += PERK_BY_ID.get(id)?.effects?.[effect] ?? 0;
  return v;
}

/** The choices a person has earned but not yet made (one entry per open slot, lowest level first). */
export function openChoices(p: Person): PerkChoice[] {
  const out: PerkChoice[] = [];
  const skills = new Set<SkillId>();
  for (const d of PERKS) skills.add(d.skill);
  for (const skill of skills) {
    const level = skillLevel(p.skills[skill]);
    if (level < PERK_LEVELS[0]) continue;
    const open = openPerkSlots(p, skill);
    if (open <= 0) continue;
    // the slots not yet filled are the highest earned levels not covered by chosen perks
    const chosen = new Set(p.perks.map((id) => PERK_BY_ID.get(id)).filter((d): d is PerkDef => !!d && d.skill === skill).map((d) => d.level));
    for (const lv of PERK_LEVELS) {
      if (lv > level || chosen.has(lv)) continue;
      const options = perksAt(skill, lv);
      if (options.length === 2) out.push({ skill, level: lv, options: [options[0], options[1]] });
    }
  }
  return out;
}

export function choosePerk(E: Econ, p: Person, perkId: string): Result {
  const def = PERK_BY_ID.get(perkId);
  if (!def) return { ok: false, reason: 'No such perk' };
  if (p.perks.includes(perkId)) return { ok: false, reason: 'You already have that perk' };
  if (skillLevel(p.skills[def.skill]) < def.level) return { ok: false, reason: `Needs ${def.skill} ${def.level}` };
  const sameLevel = p.perks.some((id) => { const d = PERK_BY_ID.get(id); return d && d.skill === def.skill && d.level === def.level; });
  if (sameLevel) return { ok: false, reason: 'You have already chosen at that level' };
  if (openPerkSlots(p, def.skill) <= 0) return { ok: false, reason: 'No perk choice is open in that skill' };
  p.perks.push(perkId);
  E.state.touch(p);
  E.notify(`${def.name}: ${def.description}`, 'gain', p.id, `perk:${perkId}`);
  return { ok: true };
}

/** Announces a perk choice the moment a level earns one (the UI opens the perk panel on request). */
export function announcePerkChoices(E: Econ): () => void {
  return E.sim.events.on('skillLevel', (e) => {
    if (!e.perkChoice) return;
    E.notify(`You can choose a new ${e.skill} perk (level ${e.level}).`, 'quest', e.person, `perk:${e.skill}`);
  });
}
