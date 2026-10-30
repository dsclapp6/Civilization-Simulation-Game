// Relationships (SPEC §5): who someone is to someone else — kin from the family graph (the labels of
// sim/api.ts), friends/rivals/enemies/lovers from opinions and courtships, lord and vassal from
// titles, master and apprentice from households, neighbours from the street.
import { kinshipLabel } from '../api';
import { dist2 } from '../../core/math';
import { roleLabel } from '../careers';
import { familyOf } from '../kin';
import { fullName, NONE, type Person, type PersonId } from '../state';
import type { SocialCore } from './core';
import { OPINION } from './tuning';
import type { RelationKind, RelationView } from './types';

const ORDER: RelationKind[] = [
  'spouse', 'betrothed', 'lover', 'parent', 'child', 'sibling', 'master', 'apprentice', 'employer', 'employee',
  'lord', 'vassal', 'in_law', 'kin', 'friend', 'rival', 'enemy', 'neighbour',
];

const MAX_LIST = 40;
const NEIGHBOUR_RADIUS = 40;

export class Relations {
  constructor(private readonly core: SocialCore) {}

  // ---- kinds ----

  kinds(viewer: Person, other: Person, mine = -999, theirs = -999): RelationKind[] {
    const core = this.core;
    const st = core.state;
    const out: RelationKind[] = [];
    if (viewer.id === other.id) return out;
    if (viewer.spouse === other.id) out.push('spouse');
    const court = core.store.courtOf(viewer.id, other.id);
    if (court && !viewer.spouse) out.push(court.be ? 'betrothed' : court.p >= 0.2 ? 'lover' : 'friend');
    const kin = kinshipLabel(st, viewer, other);
    if (kin) {
      if (kin === 'father' || kin === 'mother') out.push('parent');
      else if (kin === 'son' || kin === 'daughter') out.push('child');
      else if (kin === 'brother' || kin === 'sister') out.push('sibling');
      else if (kin.endsWith('-in-law')) out.push('in_law');
      else if (kin !== 'husband' && kin !== 'wife') out.push('kin');
    }
    // lord and vassal: the holder of the settlement's lordship, and of the title one's own is held from
    const lordOfViewer = core.lordTitleOf(viewer.settlement);
    if (lordOfViewer && lordOfViewer.holder === other.id && viewer.id !== other.id) out.push('lord');
    else {
      for (const t of st.titlesHeldBy(viewer.id)) {
        const liege = t.liege ? st.titles.get(t.liege) : undefined;
        if (liege && liege.holder === other.id) { out.push('lord'); break; }
      }
    }
    if (!out.includes('lord')) {
      const lordOfOther = core.lordTitleOf(other.settlement);
      if (lordOfOther && lordOfOther.holder === viewer.id) out.push('vassal');
      else {
        for (const t of st.titlesHeldBy(other.id)) {
          const liege = t.liege ? st.titles.get(t.liege) : undefined;
          if (liege && liege.holder === viewer.id) { out.push('vassal'); break; }
        }
      }
    }
    // household service and apprenticeships
    const vh = st.households.get(viewer.household);
    const oh = st.households.get(other.household);
    if (oh && oh.head === other.id && viewer.household === other.household && viewer.id !== other.id) {
      const house = st.houses.get(viewer.house);
      if (house && house.sworn.includes(viewer.id)) out.push(isCraftTie(viewer, other) ? 'master' : 'employer');
    }
    if (vh && vh.head === viewer.id && viewer.household === other.household) {
      const house = st.houses.get(other.house);
      if (house && house.sworn.includes(other.id)) out.push(isCraftTie(other, viewer) ? 'apprentice' : 'employee');
    }
    // feelings
    const my = mine === -999 ? core.opinion.total(viewer, other) : mine;
    const their = theirs === -999 ? core.opinion.total(other, viewer) : theirs;
    if (my <= OPINION.enemyAtOrBelow || their <= OPINION.enemyAtOrBelow) out.push('enemy');
    else if (my <= OPINION.rivalAtOrBelow || their <= OPINION.rivalAtOrBelow) out.push('rival');
    else if (Math.min(my, their) >= OPINION.friendFrom - 8 && (my + their) / 2 >= OPINION.friendFrom && !out.includes('friend') && kin === '') out.push('friend');
    return out;
  }

  // ---- lists ----

  list(personId: PersonId): RelationView[] {
    const core = this.core;
    const p = core.person(personId);
    if (!p) return [];
    const ids = new Set<PersonId>();
    if (p.spouse) ids.add(p.spouse);
    for (const [id] of familyOf(core.state, p, 4)) ids.add(id);
    for (const key in p.opinions) ids.add(Number(key));
    for (const c of core.store.courtsInvolving(p.id)) ids.add(c.a === p.id ? c.b : c.a);
    const lord = core.scene(p.settlement).lord;
    if (lord) ids.add(lord.id);
    for (const t of core.state.titlesHeldBy(p.id)) {
      const liege = t.liege ? core.state.titles.get(t.liege) : undefined;
      if (liege && liege.holder) ids.add(liege.holder);
      for (const v of core.state.titles.values()) if (v.liege === t.id && v.holder) ids.add(v.holder);
    }
    const hh = core.state.households.get(p.household);
    if (hh) for (const id of hh.members) ids.add(id);
    if (hh && hh.head) ids.add(hh.head);
    for (const id of this.neighbours(p, 4)) ids.add(id);
    ids.delete(p.id);

    const out: RelationView[] = [];
    for (const id of ids) {
      const o = core.person(id);
      if (!o || o.death) continue;
      const my = core.opinion.total(p, o);
      const their = core.opinion.total(o, p);
      const kinds = this.kinds(p, o, my, their);
      if (core.settlement(p.settlement) && o.settlement === p.settlement && !kinds.includes('neighbour') && this.isNeighbour(p, o)) kinds.push('neighbour');
      if (kinds.length === 0) continue;
      out.push({ person: id, kinds, label: this.label(p, o, kinds), theirOpinion: their, myOpinion: my });
    }
    out.sort((a, b) => rankOf(a.kinds) - rankOf(b.kinds) || Math.abs(b.myOpinion) + Math.abs(b.theirOpinion) - Math.abs(a.myOpinion) - Math.abs(a.theirOpinion) || a.person - b.person);
    return out.length > MAX_LIST ? out.slice(0, MAX_LIST) : out;
  }

  // ---- neighbours ----

  /** Household heads living within a few paces of someone's door, nearest first. */
  neighbours(p: Person, limit: number): PersonId[] {
    const st = this.core.state;
    const hh = st.households.get(p.household);
    const home = hh ? st.buildings.get(hh.home) : undefined;
    if (!home) return [];
    const near: Array<{ id: PersonId; d: number }> = [];
    for (const b of st.buildingsAt.get(p.settlement) ?? []) {
      if (b.id === home.id || !b.household) continue;
      const d = dist2(b.x, b.z, home.x, home.z);
      if (d > NEIGHBOUR_RADIUS * NEIGHBOUR_RADIUS) continue;
      const nh = st.households.get(b.household);
      if (!nh || nh.id === p.household || nh.kind !== 'family') continue;
      near.push({ id: nh.head, d });
    }
    near.sort((a, b) => a.d - b.d || a.id - b.id);
    const out: PersonId[] = [];
    for (const n of near) { if (n.id !== NONE && !out.includes(n.id)) out.push(n.id); if (out.length >= limit) break; }
    return out;
  }

  private isNeighbour(p: Person, o: Person): boolean {
    return this.neighbours(p, 6).includes(o.id);
  }

  // ---- labels ----

  /** "your father", "your lord", "Agnes, the alewife" — how `viewer` would describe `other`. */
  relationLabel(viewerId: PersonId, otherId: PersonId): string {
    const v = this.core.person(viewerId), o = this.core.person(otherId);
    if (!v || !o || v.id === o.id) return '';
    return this.label(v, o, this.kinds(v, o), true);
  }

  private label(v: Person, o: Person, kinds: RelationKind[], named = false): string {
    const own = v.id === this.core.playerId ? 'your' : `${v.first}'s`;
    const kin = kinshipLabel(this.core.state, v, o);
    const court = this.core.store.courtOf(v.id, o.id);
    if (kinds.includes('spouse') && kin) return `${own} ${kin}`;
    if (kinds.includes('betrothed')) return `${own} betrothed`;
    if (kinds.includes('lover') && !kin) {
      const word = court && court.p >= 0.6 ? 'sweetheart' : court && court.a === v.id ? 'beloved' : 'suitor';
      return `${own} ${word}`;
    }
    if (kin) return `${own} ${kin}`;
    if (kinds.includes('lord')) return `${own} lord`;
    if (kinds.includes('vassal')) return `${own} vassal`;
    if (kinds.includes('master')) return `${own} master`;
    if (kinds.includes('apprentice')) return `${own} apprentice`;
    if (kinds.includes('employer')) return `${own} ${o.sex === 'f' ? 'mistress' : 'master'}`;
    if (kinds.includes('employee')) return `${own} servant`;
    if (kinds.includes('friend')) return `${own} friend`;
    if (kinds.includes('rival')) return `${own} rival`;
    if (kinds.includes('enemy')) return `${own} enemy`;
    return this.describe(v, o, named);
  }

  /** A short phrase for the conversation header: "your father", "the reeve", "a stranger". */
  brief(viewer: Person, other: Person): string {
    return this.label(viewer, other, this.kinds(viewer, other), false);
  }

  /** Who `other` is to `viewer` in a few words: "the reeve", "a neighbour", "Agnes, the alewife", "a stranger". */
  describe(v: Person, o: Person, named: boolean): string {
    const core = this.core;
    const role = this.roleNoun(o);
    let base: string;
    if (role) base = role;
    else if (!core.knows(v, o)) base = o.settlement === v.settlement ? 'a stranger' : `a stranger from ${core.placeName(o.settlement)}`;
    else if (o.settlement === v.settlement) base = 'a neighbour';
    else base = `someone from ${core.placeName(o.settlement)}`;
    return named ? `${o.first}, ${base}` : base;
  }

  /** The office or trade that identifies someone: "the reeve", "the priest", "the lord of Ashburn", "the alewife". */
  roleNoun(o: Person): string {
    const core = this.core;
    for (const off of o.offices) {
      if (off.office === 'reeve') return 'the reeve';
      if (off.office === 'mayor') return `the mayor of ${core.placeName(off.place)}`;
      if (off.office === 'alderman') return 'an alderman';
      if (off.office === 'king') return 'the king';
    }
    const held = core.state.titlesHeldBy(o.id);
    if (held.size > 0) {
      let best = null as null | { kind: string; name: string; rank: number };
      for (const t of held) {
        const rank = ['manor', 'town', 'abbey', 'barony', 'see', 'county', 'kingdom'].indexOf(t.kind);
        if (!best || rank > best.rank) best = { kind: t.kind, name: t.name, rank };
      }
      if (best) {
        switch (best.kind) {
          case 'kingdom': return o.sex === 'f' ? 'the queen' : 'the king';
          case 'county': return `the ${o.sex === 'f' ? 'countess' : 'earl'}`;
          case 'barony': return `the ${o.sex === 'f' ? 'baroness' : 'baron'}`;
          case 'abbey': return o.sex === 'f' ? 'the abbess' : 'the abbot';
          case 'see': return 'the bishop';
          default: return `${o.sex === 'f' ? 'the lady' : 'the lord'} of ${core.placeName(o.settlement)}`;
        }
      }
    }
    switch (o.career) {
      case 'priest': return 'the priest';
      case 'abbot': return o.sex === 'f' ? 'the abbess' : 'the abbot';
      case 'prior': return o.sex === 'f' ? 'the prioress' : 'the prior';
      case 'bishop': return 'the bishop';
      case 'bailiff': return 'the bailiff';
      case 'steward': return 'the steward';
      case 'child': case 'none': case 'labourer': case 'cottar': case 'farmer': return '';
      default: break;
    }
    const label = roleLabel(o.career, o.careerStage, o.sex).toLowerCase();
    if (!label) return '';
    const article = /^[aeiou]/.test(label) ? 'an' : 'a';
    return `${article} ${label}`.replace(/^an? (master|journeyman|apprentice|warden) /, 'the $1 ');
  }
}

function rankOf(kinds: RelationKind[]): number {
  let best = ORDER.length;
  for (const k of kinds) { const i = ORDER.indexOf(k); if (i >= 0 && i < best) best = i; }
  return best;
}

function isCraftTie(apprentice: Person, master: Person): boolean {
  return master.career === apprentice.career && apprentice.careerStage < master.careerStage && master.careerStage >= 2;
}

/** For tests and docs. */
export function describeName(p: Person): string { return fullName(p); }
