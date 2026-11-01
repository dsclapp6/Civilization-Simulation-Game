// Skills and stat training by use (SPEC §5). Shared by every system that grants experience
// (work, combat, persuasion…), so XP, level-ups and perk slots behave the same everywhere.
//
// Skills: Person.skills holds XP; level = skillLevel(xp) (0..20). A perk is chosen at levels 5, 10,
// 15 and 20 (pick 1 of 2); perk ids are "<skill>.<name>" so free slots can be counted per skill.
// Stats: trained = natural growth for the age (people.refreshTrained) + a training bonus earned by
// use, never above potential × the age decline. The bonus fades slowly when not exercised.
import type { SkillId, StatId } from '../core/domain';
import type { SimContext } from './context';
import { declineFactor, learnFactor, skillLevel } from './people';
import { ageYears, type Person } from './state';

export const PERK_LEVELS = [5, 10, 15, 20] as const;

/**
 * Growth by the bout. The tables of the work actions (experience and stat points per bout) were struck when a game day was
 * a minute of play and a player could fit about four bouts into it. A day is now ten minutes and holds about ten times as
 * many bouts, so each bout's growth is scaled back: a bout is half a game hour of the hero's work, who learns about twice
 * as fast per game hour as a capable adult (≈ 1.9 experience a game hour for an NPC, `XP_PER_YEAR`). A youth who practises
 * most days still reaches STR 10 and Archery 3 (the archers' test) at 14 or 15.
 */
export const XP_SCALE = 0.25;
export const TRAIN_SCALE = 0.5;

/** Adds XP (scaled by intellect and Quick learner). Emits `skillLevel` per level gained; returns levels gained. */
export function gainSkill(ctx: SimContext, p: Person, skill: SkillId, baseXp: number): number {
  if (baseXp <= 0 || p.death) return 0;
  const before = skillLevel(p.skills[skill]);
  p.skills[skill] = Math.round((p.skills[skill] + baseXp * learnFactor(p.trained.int, p.traits)) * 100) / 100;
  const after = skillLevel(p.skills[skill]);
  ctx.state.touch(p);
  for (let lv = before + 1; lv <= after; lv++) {
    ctx.events.emit('skillLevel', { person: p.id, skill, level: lv, perkChoice: (PERK_LEVELS as readonly number[]).includes(lv) });
  }
  return after - before;
}

export function skillOf(p: Person, skill: SkillId): number { return skillLevel(p.skills[skill]); }

/** Perk choices the person has earned in `skill` but not yet made. */
export function openPerkSlots(p: Person, skill: SkillId): number {
  const level = skillOf(p, skill);
  const earned = PERK_LEVELS.filter((l) => l <= level).length;
  const prefix = `${skill}.`;
  const chosen = p.perks.filter((id) => id.startsWith(prefix)).length;
  return Math.max(0, earned - chosen);
}

export function hasPerk(p: Person, perkId: string): boolean { return p.perks.includes(perkId); }

/** Training bonus ceiling: what the stat could be at full growth for this age. */
function statCeiling(p: Person, stat: StatId, age: number): number {
  return p.potential[stat] * declineFactor(stat, age);
}

/**
 * Exercise a stat: `amount` ≈ stat points gained from a full day of hard use by a well-fed person
 * (0.05–0.15 is typical per work bout). Gains shrink as the stat nears its ceiling.
 * Returns the trained value afterwards.
 */
export function trainStat(ctx: SimContext, p: Person, stat: StatId, amount: number): number {
  if (amount <= 0 || p.death) return p.trained[stat];
  const age = ageYears(p, ctx.absDay);
  const ceiling = statCeiling(p, stat, age);
  const gap = Math.max(0, ceiling - p.trained[stat]);
  if (gap <= 0) return p.trained[stat];
  const hungry = p.needs.hunger < 0.3 ? 0.25 : 1; // SPEC §5: hunger blocks training
  const gain = Math.min(gap, amount * hungry * Math.min(1, 0.25 + gap / 3));
  p.statBonus ??= {};
  p.statBonus[stat] = Math.round(((p.statBonus[stat] ?? 0) + gain) * 1000) / 1000;
  // three decimals: a bout of practice adds a few thousandths, which two decimals would round away
  p.trained[stat] = Math.round(Math.min(ceiling, p.trained[stat] + gain) * 1000) / 1000;
  ctx.state.touch(p);
  return p.trained[stat];
}

/** Neglect: bonuses fade by `fraction` (call yearly for everyone, or seasonally for the player). */
export function decayStatBonus(p: Person, fraction: number): void {
  if (!p.statBonus) return;
  for (const s of Object.keys(p.statBonus) as StatId[]) {
    const v = (p.statBonus[s] ?? 0) * (1 - fraction);
    if (v < 0.01) delete p.statBonus[s];
    else p.statBonus[s] = Math.round(v * 1000) / 1000;
  }
}
