// The verbs of the combat module (src/sim/actions.ts providers): striking a person who has not wronged you,
// binding wounds, looking at your own, and the training yard: the pell, the target and sparring.
// Attacks in the open are made with the mouse (src/combat/playerport.ts); these are the deliberate acts.
import { dist } from '../core/math';
import type { HeldItem } from '../core/view';
import type { ActionOption, ActionOutcome, ActionProvider, TargetRef } from '../sim/actions';
import type { SimContext } from '../sim/context';
import type { Simulation } from '../sim/sim';
import { gainSkill, skillOf, trainStat } from '../sim/skills';
import { ageYears, fullName, type Person, type PersonId } from '../sim/state';
import { weaponOfKey, rangedOfKey } from './weapons';
import type { Services } from './services';
import { shapeWound } from './wounds';

export const PROVIDER_ID = 'combat';

function opt(p: Pick<ActionOption, 'id' | 'label' | 'category' | 'target' | 'priority'> & Partial<ActionOption>): ActionOption {
  return { provider: PROVIDER_ID, enabled: true, seconds: 0, range: 3, ...p };
}

const SOLDIER_CAREERS: ReadonlySet<string> = new Set(['soldier', 'man_at_arms', 'sergeant', 'squire', 'knight', 'archer']);

export function createCombatProvider(sv: Services): ActionProvider {
  const sim: Simulation = sv.sim;
  const st = sim.state;

  const weaponHeld = (actor: PersonId): HeldItem => {
    const eq = sv.economy?.inventory(actor).equipment.main;
    const w = eq ? weaponOfKey(eq) : null;
    return w && w.def.held !== 'none' ? w.def.held : 'sword';
  };

  const bowOf = (actor: PersonId): { held: HeldItem; arrows: number } | null => {
    const inv = sv.economy?.inventory(actor);
    if (!inv) return null;
    const main = inv.equipment.main;
    const r = main ? rangedOfKey(main) : null;
    let bow = r;
    if (!bow) for (const it of inv.items) { const x = rangedOfKey(it.key); if (x && x.def.type === 'bow') { bow = x; break; } }
    if (!bow) return null;
    let n = 0;
    for (const it of inv.items) if (it.good.id === bow.def.ammo) n += it.qty;
    return { held: bow.def.held, arrows: n };
  };

  const yardNear = (p: Person): boolean => {
    for (const b of st.buildingsAt.get(p.settlement) ?? []) {
      if (b.kind !== 'training_yard') continue;
      const w = sv.zone?.nav.doorOf(b.id);
      const pos = sv.player?.body();
      if (pos && dist(pos.x, pos.z, w?.x ?? b.x, w?.z ?? b.z) < 22) return true;
    }
    return false;
  };

  return {
    id: PROVIDER_ID,

    list(_ctx: SimContext, actor: PersonId, target: TargetRef, out: ActionOption[]): void {
      if (actor !== st.run.playerId) return;
      const me = st.persons.get(actor);
      if (!me || me.death) return;
      const hurt = sv.book.isHurt(actor);
      switch (target.kind) {
        case 'self': {
          if (hurt) {
            out.push(opt({ id: 'wounds', label: 'Examine your wounds', category: 'rest', target, priority: 2, range: 999, preview: 'What the blows left, and what will mend them' }));
            const o = opt({ id: 'bind', label: 'Bind your wounds', category: 'rest', target, priority: sv.book.rec(actor)?.wounds.some((w) => w.rate > 0) ? 60 : 3, range: 999, seconds: 9, anim: 'kneel', preview: 'Stops the bleeding. Medicine helps', partial: true } as never);
            if (!sv.book.wounds(actor).some((w) => w.care < 1)) { o.enabled = false; o.reason = 'Your wounds are already bound'; }
            out.push(o);
          }
          break;
        }
        case 'person': {
          if (target.id === actor) break;
          const q = st.persons.get(target.id);
          if (!q || q.death) break;
          const age = ageYears(q, sim.absDay);
          const atk = opt({ id: 'attack', label: `Attack ${q.first}`, category: 'combat', target, priority: -20, range: 4.5, preview: 'Draw steel on them. There will be witnesses and consequences' });
          if (sv.arena.inFight(q.id)) { atk.enabled = false; atk.reason = 'They are already fighting'; }
          else if (sv.arena.inFight(actor) && sv.arena.fighterOf(actor)?.fight) { atk.enabled = false; atk.reason = 'You are in a fight already'; }
          else if (age < 12) { atk.enabled = false; atk.reason = 'You will not strike a child'; }
          else if (q.flags.captive) { atk.enabled = false; atk.reason = 'They are a prisoner'; }
          out.push(atk);
          if (sv.book.isHurt(q.id)) {
            const o = opt({ id: 'tend', label: `Bind ${q.first}'s wounds`, category: 'social', target, priority: 30, range: 3, seconds: 9, anim: 'kneel', preview: 'Stops the bleeding. Medicine helps' });
            if (!sv.book.wounds(q.id).some((w) => w.care < 1 + (skillOf(me, 'medicine') >= 5 ? 1 : 0))) { o.enabled = false; o.reason = 'Already well bound'; }
            out.push(o);
          }
          // sparring: at the yard, or with a soldier, between two who are fit and on decent terms
          if (age >= 14 && (SOLDIER_CAREERS.has(q.career) || yardNear(me)) && q.id !== actor) {
            const o = opt({
              id: 'spar', label: `Spar with ${q.first}`, category: 'combat', target, priority: 6, range: 3.5, seconds: 14, anim: 'attack_slash',
              mainHand: weaponHeld(actor), repeat: true, preview: 'Melee, Strength, Agility and Endurance grow',
            });
            if (me.health.hp < 0.55 || sv.book.isHurt(actor)) { o.enabled = false; o.reason = 'You are too hurt to spar'; }
            else if (q.health.hp < 0.6 || sv.book.isHurt(q.id)) { o.enabled = false; o.reason = `${q.first} is hurt`; }
            else if (sv.social && sv.social.opinion(q.id, actor) < -25) { o.enabled = false; o.reason = `${q.first} wants no part of you`; }
            else if (me.needs.hunger < 0.25) { o.enabled = false; o.reason = 'Too hungry to spar'; }
            out.push(o);
          }
          break;
        }
        case 'building': {
          const b = st.buildings.get(target.id);
          if (!b || b.kind !== 'training_yard') break;
          const drill = opt({
            id: 'pell', label: 'Drill at the pell', category: 'learn', target, priority: 28, range: 22, seconds: 10, anim: 'attack_overhead',
            mainHand: weaponHeld(actor), repeat: true, preview: 'Melee, Strength and Endurance grow with the practice',
          });
          if (me.health.hp < 0.45 || sv.book.isHurt(actor)) { drill.enabled = false; drill.reason = 'You are too hurt to drill'; }
          else if (me.needs.hunger < 0.25) { drill.enabled = false; drill.reason = 'Too hungry to drill'; }
          out.push(drill);
          const bow = bowOf(actor);
          const shoot = opt({
            id: 'target', label: 'Shoot at the yard target', category: 'learn', target, priority: 26, range: 22, seconds: 9, anim: 'shoot_bow',
            mainHand: bow ? bow.held : 'longbow', repeat: true, preview: 'Archery, Perception and Strength grow with the practice',
          });
          if (!bow) { shoot.enabled = false; shoot.reason = 'Needs a bow'; }
          else if (bow.arrows < 6) { shoot.enabled = false; shoot.reason = 'Needs at least six arrows'; }
          else if (me.health.hp < 0.45 || sv.book.isHurt(actor)) { shoot.enabled = false; shoot.reason = 'You are too hurt to shoot'; }
          out.push(shoot);
          break;
        }
        default: break;
      }
    },

    check(_ctx: SimContext, actor: PersonId, option: ActionOption): string | null {
      const me = st.persons.get(actor);
      if (!me || me.death) return 'You cannot do that now.';
      if (sv.arena.fighterOf(actor)?.fight) return 'Not in the middle of a fight';
      if (option.target.kind === 'person') {
        const q = st.persons.get(option.target.id);
        if (!q || q.death) return 'They are gone.';
      }
      return null;
    },

    complete(_ctx: SimContext, actor: PersonId, option: ActionOption, fraction: number): ActionOutcome {
      const me = st.persons.get(actor);
      if (!me) return { ok: false };
      switch (option.id) {
        case 'wounds': return { ok: true, ui: { panel: 'ext', name: 'wounds', id: actor } };
        case 'bind': {
          const r = sv.book.tend(me, skillOf(me, 'medicine'), sim.rng('combat'));
          if (r.tended > 0) gainSkill(sim, me, 'medicine', 3 * fraction + 1);
          return { ok: r.tended > 0, message: r.tended > 0 ? 'You bind your own wounds as best you can.' : r.message, gains: r.tended > 0 ? [{ label: 'Medicine', ref: 'medicine' }] : [] };
        }
        case 'tend': {
          if (option.target.kind !== 'person') return { ok: false };
          const q = st.persons.get(option.target.id);
          if (!q) return { ok: false };
          const r = sv.book.tend(q, skillOf(me, 'medicine'), sim.rng('combat'));
          if (r.tended > 0) {
            gainSkill(sim, me, 'medicine', 6);
            sv.social?.adjustOpinion(q.id, actor, 8, 'bound my wounds');
            me.rep.generosity = Math.min(100, me.rep.generosity + 1);
            st.touch(me);
          }
          return { ok: r.tended > 0, message: r.message, gains: r.tended > 0 ? [{ label: 'Medicine', ref: 'medicine' }] : [] };
        }
        case 'attack': {
          if (option.target.kind !== 'person') return { ok: false };
          return sv.assault(actor, option.target.id);
        }
        case 'pell': {
          gainSkill(sim, me, 'melee', 9);
          trainStat(sim, me, 'str', 0.011);
          trainStat(sim, me, 'end', 0.007);
          trainStat(sim, me, 'agi', 0.004);
          return { ok: true, message: 'You hammer the post until your arms burn.', gains: [{ label: 'Melee', ref: 'melee' }, { label: 'Strength', ref: 'str' }] };
        }
        case 'target': {
          gainSkill(sim, me, 'archery', 10);
          trainStat(sim, me, 'str', 0.009);
          trainStat(sim, me, 'per', 0.007);
          const inv = me.inventory;
          for (const k of Object.keys(inv)) if (k.startsWith('arrow') && inv[k] > 0 && sim.rng('combat').next() < 0.16) { inv[k] -= 1; if (inv[k] <= 0) delete inv[k]; break; }
          st.touch(me);
          const lvl = skillOf(me, 'archery');
          return { ok: true, message: `Your arrows ${lvl < 3 ? 'scatter across the target' : lvl < 8 ? 'cluster near the gold' : 'strike the gold'}.`, gains: [{ label: 'Archery', ref: 'archery' }, { label: 'Strength', ref: 'str' }] };
        }
        case 'spar': {
          if (option.target.kind !== 'person') return { ok: false };
          const q = st.persons.get(option.target.id);
          if (!q || q.death) return { ok: false };
          return spar(sv, me, q);
        }
        default: return { ok: false };
      }
    },
  };
}

/** A bout with blunted weapons: both learn, the weaker takes a bruise now and then, a rare accident goes deeper. */
function spar(sv: Services, me: Person, q: Person): ActionOutcome {
  const sim = sv.sim;
  const rng = sim.rng('combat');
  const power = (p: Person): number => p.trained.str * 0.35 + p.trained.agi * 0.45 + p.trained.end * 0.2 + skillOf(p, 'melee') * 1.1 + rng.range(-2.5, 2.5);
  const mine = power(me), theirs = power(q);
  const won = mine >= theirs;
  gainSkill(sim, me, 'melee', won ? 7 : 8);
  gainSkill(sim, q, 'melee', won ? 6 : 5);
  trainStat(sim, me, 'agi', 0.007);
  trainStat(sim, me, 'str', 0.006);
  trainStat(sim, me, 'end', 0.006);
  trainStat(sim, q, 'agi', 0.004);
  trainStat(sim, q, 'str', 0.004);
  sv.social?.adjustOpinion(q.id, me.id, 1, 'sparred');
  const loser = won ? q : me;
  if (rng.next() < 0.22) {
    const where = rng.pick<'arm_l' | 'arm_r' | 'leg_l' | 'leg_r' | 'torso'>(['arm_l', 'arm_r', 'leg_l', 'leg_r', 'torso']);
    sv.book.inflict(loser, shapeWound(rng, where, 'blunt', rng.range(4, 9), Math.round(40 + 4 * loser.trained.end)), 'a practice bout', 'accident');
  }
  const gains = [{ label: 'Melee', ref: 'melee' }];
  return { ok: true, message: won ? `You get the better of ${q.first} in the bout.` : `${q.first} gets the better of you in the bout.`, gains };
}

export function nameOf(p: Person): string { return fullName(p); }
