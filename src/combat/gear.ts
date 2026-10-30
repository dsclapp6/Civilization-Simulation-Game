// What a fighter carries and wears. People with equipment slots (the player, anyone the economy equipped)
// use them; everyone else fights with what their trade and their clothes say: the armour the renderer
// shows, the kit of their career, or an improvised weapon picked by a stable hash.
import { hash3 } from '../core/math';
import type { EconomyApi, Quality } from '../sim/economy/types';
import { parseItemKey } from '../sim/economy/types';
import type { GameState, Person } from '../sim/state';
import { ageYears } from '../sim/state';
import type { CachedLook } from '../sim/appearance';
import {
  ARMOUR, IMPROVISED, RANGED, SHIELDS, WEAPONS, armourGoodOfLook, armourOfKey, careerKit, helmetGoodOfLook, rangedOfKey,
  shieldOfKey, weaponOfKey, type RangedDef, type ShieldDef, type WeaponDef,
} from './weapons';
import type { ArmourPiece } from './wounds';

export interface Gear {
  weapon: WeaponDef;
  weaponQ: Quality;
  shield: ShieldDef | null;
  shieldQ: Quality;
  ranged: RangedDef | null;
  rangedQ: Quality;
  armour: ArmourPiece[];
  /** Arrows or bolts in the quiver. */
  ammo: number;
  /** Key of the ammunition stack in the person's inventory, if they carry real arrows. */
  ammoKey: string | null;
  /** Total weight of what is worn (kg): heavy mail tires. */
  worn: number;
}

export interface GearEnv {
  state: GameState;
  appearance: { get(state: GameState, p: Person, absDay: number): CachedLook };
  economy: EconomyApi | undefined;
  absDay: number;
}

function ammoStack(p: Person, good: string): { key: string | null; qty: number } {
  let best: string | null = null;
  let qty = 0;
  for (const [key, n] of Object.entries(p.inventory)) {
    if (n > 0 && parseItemKey(key).good === good) { qty += n; if (best === null || parseItemKey(key).quality! > parseItemKey(best).quality!) best = key; }
  }
  return { key: best, qty: Math.floor(qty) };
}

/** Equips a person for a fight. */
export function gearOf(env: GearEnv, p: Person): Gear {
  const eq = env.economy?.inventory(p.id).equipment ?? {};
  let weapon: WeaponDef | null = null;
  let weaponQ: Quality = 1;
  let shield: ShieldDef | null = null;
  let shieldQ: Quality = 1;
  let ranged: RangedDef | null = null;
  let rangedQ: Quality = 1;
  const armour: ArmourPiece[] = [];

  if (eq.main) {
    const w = weaponOfKey(eq.main);
    if (w) { weapon = w.def; weaponQ = w.quality; }
    const r = rangedOfKey(eq.main);
    if (r) { ranged = r.def; rangedQ = r.quality; }
  }
  if (eq.off) {
    const s = shieldOfKey(eq.off) ?? (parseItemKey(eq.off).good === 'shield' ? { def: SHIELDS.shield, quality: parseItemKey(eq.off).quality ?? 1 } : null);
    if (s) { shield = s.def; shieldQ = s.quality as Quality; }
  }
  if (eq.armour) { const a = armourOfKey(eq.armour); if (a) armour.push({ def: a.def, quality: a.quality }); }
  if (eq.helmet) { const a = armourOfKey(eq.helmet); if (a) armour.push({ def: a.def, quality: a.quality }); }

  const hasSlots = eq.main !== undefined || eq.off !== undefined || eq.armour !== undefined || eq.helmet !== undefined;
  const age = ageYears(p, env.absDay);
  const kit = careerKit(p.career);
  if (!hasSlots || (!weapon && !ranged)) {
    if (!weapon) {
      if (age < 12) weapon = WEAPONS.fists;
      else if (kit) {
        const pool = [kit.main, ...(kit.alt ?? [])];
        weapon = WEAPONS[pool[hash3(p.id, 31) % pool.length]] ?? WEAPONS.sword;
      } else if (p.rankTier >= 5 && p.sex === 'm') weapon = WEAPONS.sword;
      else if (age < 14 || p.estate === 'clergy') weapon = WEAPONS.fists;
      else weapon = WEAPONS[IMPROVISED[hash3(p.id, 29) % IMPROVISED.length]] ?? WEAPONS.staff;
    }
    if (!ranged && kit?.ranged) ranged = RANGED[kit.ranged] ?? null;
    if (!shield && kit?.off && !hasSlots) shield = SHIELDS[kit.off] ?? null;
  }
  if (!hasSlots || (!eq.armour && !eq.helmet)) {
    // what they are seen wearing
    const look = env.appearance.get(env.state, p, env.absDay).look;
    if (!eq.armour) {
      const g = armourGoodOfLook(look.armour );
      if (g && ARMOUR[g]) armour.push({ def: ARMOUR[g], quality: 1 });
    }
    if (!eq.helmet) {
      const g = helmetGoodOfLook(look.helmet );
      if (g && ARMOUR[g]) armour.push({ def: ARMOUR[g], quality: 1 });
    }
  }
  const w = weapon ?? WEAPONS.fists;
  let ammo = 0;
  let ammoKey: string | null = null;
  if (ranged) {
    const st = ammoStack(p, ranged.ammo);
    ammo = st.qty;
    ammoKey = st.key;
    if (ammo === 0 && !eq.main && ranged) ammo = ranged.type === 'bow' ? 18 : 12;
  }
  let worn = 0;
  for (const a of armour) worn += a.def.weight;
  if (shield) worn += shield.weight;
  return { weapon: w, weaponQ, shield, shieldQ, ranged, rangedQ, armour, ammo, ammoKey, worn };
}

/** Armour only, for off-screen harm: the pieces a person is wearing or seen wearing. */
export function armourOf(env: GearEnv, p: Person): ArmourPiece[] {
  const eq = env.economy?.inventory(p.id).equipment ?? {};
  const out: ArmourPiece[] = [];
  if (eq.armour) { const a = armourOfKey(eq.armour); if (a) out.push({ def: a.def, quality: a.quality }); }
  if (eq.helmet) { const a = armourOfKey(eq.helmet); if (a) out.push({ def: a.def, quality: a.quality }); }
  if (out.length === 0 && !eq.armour && !eq.helmet) {
    const look = env.appearance.get(env.state, p, env.absDay).look;
    const g = armourGoodOfLook(look.armour );
    if (g && ARMOUR[g]) out.push({ def: ARMOUR[g], quality: 1 });
    const h = helmetGoodOfLook(look.helmet );
    if (h && ARMOUR[h]) out.push({ def: ARMOUR[h], quality: 1 });
  }
  return out;
}
