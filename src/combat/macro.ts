// Harm outside the detail zone (battles, raids, accidents, beasts) and the daily care of the wounded by the
// healers of their settlement. The same wound model as in a fight: armour, location, bleeding, infection.
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import type { DeathCause, GameState, Person } from '../sim/state';
import type { HarmResult, HitLocation, WoundKind } from '../sim/wave3';
import { armourOf, type GearEnv } from './gear';
import { absorb, rollLocation, shapeWound, WoundBook, maxHpOf } from './wounds';
import { skillOf } from '../sim/skills';

const KIND_MIX: Record<string, Array<[WoundKind, number]>> = {
  battle: [['cut', 0.34], ['pierce', 0.16], ['arrow', 0.28], ['blunt', 0.22]],
  raid: [['cut', 0.4], ['pierce', 0.2], ['arrow', 0.12], ['blunt', 0.28]],
  murder: [['pierce', 0.5], ['cut', 0.35], ['blunt', 0.15]],
  accident: [['blunt', 0.55], ['cut', 0.3], ['pierce', 0.15]],
  fire: [['burn', 1]],
  beast: [['bite', 0.8], ['pierce', 0.2]],
  siege: [['arrow', 0.35], ['blunt', 0.35], ['cut', 0.15], ['pierce', 0.15]],
};

function mixFor(cause: string): Array<[WoundKind, number]> {
  const c = cause.toLowerCase();
  for (const key of Object.keys(KIND_MIX)) if (c.includes(key)) return KIND_MIX[key];
  if (c.includes('wolf') || c.includes('boar') || c.includes('bite')) return KIND_MIX.beast;
  if (c.includes('war') || c.includes('skirmish')) return KIND_MIX.battle;
  return KIND_MIX.battle;
}

function deathCauseOf(cause: string): DeathCause {
  const c = cause.toLowerCase();
  if (c.includes('battle') || c.includes('war') || c.includes('siege') || c.includes('skirmish')) return 'battle';
  if (c.includes('accident') || c.includes('fire') || c.includes('fall')) return 'accident';
  if (c.includes('execut')) return 'execution';
  return 'violence';
}

/** Wounds a person by `intensity` (0 a scuffle … 1 the thick of a battle) from the named cause. */
export function harmPerson(gear: GearEnv, book: WoundBook, rng: Rng, p: Person, intensity: number, cause: string): HarmResult {
  if (p.death) return 'dead';
  const k = clamp(intensity, 0, 1.5);
  const escape = clamp(0.62 - 0.75 * k + 0.012 * (p.trained.agi - 10), 0.02, 0.7);
  if (rng.next() < escape) return 'unhurt';
  const blows = 1 + Math.floor(k * 3 * rng.next());
  const pieces = armourOf(gear, p);
  const mix = mixFor(cause);
  const kinds = mix.map((m) => m[0]);
  const weights = mix.map((m) => m[1]);
  const dc = deathCauseOf(cause);
  let wounded = false;
  for (let i = 0; i < blows && !p.death; i++) {
    const kind = rng.weighted(kinds, weights);
    const how = kind === 'arrow' ? 'arrow' : kind === 'pierce' ? 'thrust' : kind === 'burn' ? 'low' : 'slash';
    const where: HitLocation = rollLocation(rng, { how });
    const raw = (13 + 38 * k) * (0.7 + 0.6 * rng.next());
    const ab = absorb(rng, pieces, where, kind, raw, kind === 'arrow' ? 0.25 : 0.1);
    const shaped = shapeWound(rng, where, kind, ab.through, maxHpOf(p));
    const out = book.inflict(p, shaped, cause, dc);
    if (out.wound) wounded = true;
    if (out.dead) return 'dead';
  }
  if (p.death) return 'dead';
  if (book.down(p.id)) return p.rankTier >= 5 && dc === 'battle' ? 'yielded' : 'down';
  return wounded ? 'wounded' : 'unhurt';
}

// ---------------------------------------------------------------------------------------------
// Care
// ---------------------------------------------------------------------------------------------

/** Best Medicine skill among a settlement's healers, midwives, monks and priests (cached for the day). */
export class Healers {
  private day = -1;
  private readonly best = new Map<number, number>();

  skillIn(state: GameState, settlement: number, absDay: number): number {
    const d = Math.floor(absDay);
    if (d !== this.day) { this.day = d; this.best.clear(); }
    let v = this.best.get(settlement);
    if (v !== undefined) return v;
    v = 0;
    for (const r of state.residentsOf(settlement)) {
      if (r.career === 'healer' || r.career === 'midwife' || r.career === 'monk' || r.career === 'nun' || r.career === 'priest') {
        const s = skillOf(r, 'medicine') + (r.career === 'healer' ? 2 : 0);
        if (s > v) v = s;
      }
    }
    this.best.set(settlement, v);
    return v;
  }

  hasInfirmary(state: GameState, settlement: number): boolean {
    for (const b of state.buildingsAt.get(settlement) ?? []) if (b.kind === 'infirmary' && b.construction >= 1) return true;
    return false;
  }
}

/** The daily round: healers bind the wounds of the people of their settlement, an infirmary tends them well. */
export function dailyCare(state: GameState, book: WoundBook, healers: Healers, rng: Rng, absDay: number): void {
  const ext = book.ext();
  for (const key of Object.keys(ext.hurt)) {
    const p = state.persons.get(+key);
    if (!p || p.death) continue;
    const skill = healers.skillIn(state, p.settlement, absDay);
    const infirm = healers.hasInfirmary(state, p.settlement);
    const rec = ext.hurt[+key];
    if (skill <= 0 && !infirm) continue;
    // not everyone is reached at once: the sicker are tended first, the rest by chance
    const sev = rec.wounds.reduce((m, w) => Math.max(m, w.severity), 0);
    if (rng.next() > clamp(0.35 + sev + (infirm ? 0.4 : 0), 0, 1)) continue;
    book.tend(p, infirm ? Math.max(5, skill) : skill, rng);
  }
}
