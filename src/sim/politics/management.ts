// Management by authority (SPEC §7): what a lord, baron, earl or king may command, and the petitions
// that NPCs bring to whoever rules (SPEC §18). Manor: the villagers' work, rents and dues, local
// justice. Barony and county: grants and revocation of vassal titles. Realm: laws and taxes, war and
// peace (see wars.ts / diplomacy.ts). The player gets exactly what the titles he holds allow.
import { TITLE_RANK, ageYears, fullName, type PersonId, type Title, type TitleId } from '../state';
import { clamp, type PoliticsCore, YEAR } from './core';
import type { Offices } from './offices';
import { transferTitle } from './titles';
import type { Authority, ManorPolicy, Petition, PetitionKind, RealmLaws, Result } from './types';
import type { Wars } from './wars';

export class Management {
  constructor(private readonly core: PoliticsCore, private readonly offices: Offices, private readonly wars: Wars) {}

  // ---- who commands what ----

  authority(person: PersonId): Authority {
    const c = this.core;
    const p = c.person(person);
    const out: Authority = { household: false, manors: [], baronies: [], counties: [], kingdoms: [], offices: [] };
    if (!p) return out;
    const hh = c.state.households.get(p.household);
    out.household = !!hh && hh.head === p.id;
    const titles = [...c.state.titlesHeldBy(p.id)].sort((a, b) => a.id - b.id);
    for (const t of titles) {
      if (t.kind === 'manor' || t.kind === 'town' || t.kind === 'abbey') out.manors.push(t.id);
      else if (t.kind === 'barony') out.baronies.push(t.id);
      else if (t.kind === 'county') out.counties.push(t.id);
      else if (t.kind === 'kingdom') out.kingdoms.push(t.id);
    }
    out.offices = p.offices.map((o) => o.office);
    return out;
  }

  private holds(person: PersonId, kind: Title['kind'], place: number): boolean {
    const t = this.core.state.titleFor(kind, place);
    return !!t && (t.holder === person || t.regent === person);
  }

  // ---- manor ----

  manorPolicy(settlement: number): ManorPolicy { return { ...this.core.policyPeek(settlement) }; }

  setManorPolicy(person: PersonId, settlement: number, change: Partial<ManorPolicy>): Result {
    const c = this.core;
    if (!(this.holds(person, 'manor', settlement) || this.holds(person, 'abbey', settlement) || this.holds(person, 'barony', settlement))) {
      return { ok: false, reason: 'Only the lord of the manor commands its villagers.' };
    }
    const p = c.policyFor(settlement);
    const valid = (v: number | undefined): boolean => v === undefined || v === -1 || v === 0 || v === 1 || v === 2;
    if (!valid(change.rent) || !valid(change.labour)) return { ok: false, reason: 'No such measure.' };
    if (change.rent !== undefined) p.rent = change.rent;
    if (change.labour !== undefined) p.labour = change.labour;
    if (change.justice !== undefined) p.justice = change.justice;
    if (change.focus !== undefined) p.focus = change.focus;
    c.touch();
    // harsh measures harden a lord's name; mild ones soften it
    const lord = c.person(person);
    if (lord && (change.rent === 2 || change.labour === 2 || change.justice === 'harsh')) lord.rep.cruelty = clamp(lord.rep.cruelty + 1, -100, 100);
    if (lord && (change.rent === -1 || change.labour === -1 || change.justice === 'lenient')) lord.rep.generosity = clamp(lord.rep.generosity + 1, -100, 100);
    if (lord) c.state.touch(lord);
    return { ok: true };
  }

  // ---- realm ----

  realmLaws(kingdom: number): RealmLaws { return { ...this.core.lawsFor(kingdom) }; }

  setRealmLaw(person: PersonId, kingdom: number, change: Partial<RealmLaws>): Result {
    const c = this.core;
    if (!this.holds(person, 'kingdom', kingdom)) return { ok: false, reason: 'Only the crown makes the laws of the realm.' };
    const l = c.lawsFor(kingdom);
    if (change.privateWar !== undefined) l.privateWar = change.privateWar;
    if (change.tax !== undefined) {
      if (![0, 1, 2, 3].includes(change.tax)) return { ok: false, reason: 'No such rate.' };
      l.tax = change.tax;
    }
    c.touch();
    if (change.privateWar === true) {
      const head = c.person(person);
      if (head) c.log('law', `${fullName(head)} lets his barons wage private war.`, [head.id]);
    }
    return { ok: true };
  }

  // ---- grants ----

  /** A liege puts a person in a title: a vassal's, or one of his own. */
  grantTitle(liege: PersonId, titleId: TitleId, to: PersonId): Result {
    const c = this.core;
    const t = c.state.titles.get(titleId);
    const l = c.living(liege);
    const p = c.living(to);
    if (!t || !l || !p) return { ok: false, reason: 'Nobody there.' };
    if (t.kind === 'kingdom' || t.kind === 'abbey' || t.kind === 'see') return { ok: false, reason: 'That title cannot be given away.' };
    const above = t.liege ? c.state.titles.get(t.liege) : undefined;
    const ownTitle = t.holder === liege;
    const mine = above && above.holder === liege;
    if (!ownTitle && !mine) return { ok: false, reason: 'It is not yours to give.' };
    if (ownTitle) {
      // grant a title of one's own to another: only if a higher title of one's own remains to hold it from
      const higher = [...c.state.titlesHeldBy(liege)].filter((x) => x.id !== t.id && TITLE_RANK[x.kind] > TITLE_RANK[t.kind]).sort((a, b) => TITLE_RANK[b.kind] - TITLE_RANK[a.kind] || a.id - b.id)[0];
      if (!higher && !(above && above.holder !== liege)) return { ok: false, reason: 'You have no higher title to hold it from.' };
      if (higher) { t.liege = higher.id; c.state.touchTitle(t); }
    }
    if (p.death || ageYears(p, c.day) < 16) return { ok: false, reason: 'The heir is too young.' };
    if (p.estate === 'clergy') return { ok: false, reason: 'A man of the Church holds no fief.' };
    if (p.estate === 'unfree') return { ok: false, reason: 'A serf cannot hold land by knight service.' };
    if (p.rankTier < TITLE_RANK[t.kind] - 2 && p.rankTier < 4) return { ok: false, reason: `${fullName(p)} is too lowly for ${t.name}.` };
    const old = t.holder ? c.person(t.holder) : undefined;
    transferTitle(c, t, p, `granted by ${fullName(l)}`);
    if (old && old.id !== liege) c.social.adjustOpinion(old.id, liege, -30, 'lost fief');
    c.social.adjustOpinion(p.id, liege, 12, 'granted fief');
    this.wars.swearOath(t);
    return { ok: true };
  }

  /** A liege takes a vassal's title back — a harsh act that his other vassals remember. */
  revokeTitle(liege: PersonId, titleId: TitleId): Result {
    const c = this.core;
    const t = c.state.titles.get(titleId);
    const l = c.living(liege);
    if (!t || !l) return { ok: false, reason: 'Nobody there.' };
    const above = t.liege ? c.state.titles.get(t.liege) : undefined;
    if (!above || above.holder !== liege) return { ok: false, reason: 'You are not his liege.' };
    const holder = t.holder ? c.living(t.holder) : undefined;
    if (!holder) return { ok: false, reason: 'No holder.' };
    if (holder.house === l.house) return { ok: false, reason: 'He is of your own House.' };
    if (t.kind === 'kingdom' || t.kind === 'county') return { ok: false, reason: 'A great vassal cannot be stripped by decree; it takes a war.' };
    transferTitle(c, t, l, `revoked by ${fullName(l)}`);
    c.addGrievance(holder.house, l.house, 40);
    c.social.adjustOpinion(holder.id, l.id, -50, 'stripped of land');
    l.rep.honour = clamp(l.rep.honour - 4, -100, 100);
    l.rep.cruelty = clamp(l.rep.cruelty + 3, -100, 100);
    c.state.touch(l);
    // the other vassals note it
    for (const v of c.vassalsOf(l.house)) {
      const vh = c.headOf(v);
      if (vh && vh.house !== holder.house) c.social.adjustOpinion(vh.id, l.id, -5, 'tyranny');
    }
    return { ok: true };
  }

  // ---- petitions ----

  petitions(person?: PersonId): readonly Petition[] {
    const list = this.core.save.petitions;
    return person === undefined ? list : list.filter((p) => p.to === person);
  }

  /** Seasonal: villagers bring their troubles to the lord (the player; AI lords settle theirs unseen). */
  seasonal(): void {
    const c = this.core;
    const me = c.living(c.playerId);
    if (!me || c.state.run.phase !== 'alive') return;
    const rng = c.rng('petition');
    // old petitions lapse unanswered: counted as a refusal
    for (let i = c.save.petitions.length - 1; i >= 0; i--) {
      if (c.day - c.save.petitions[i].day > 2 * YEAR) {
        const p = c.save.petitions[i];
        c.save.petitions.splice(i, 1);
        c.social.adjustOpinion(p.from, me.id, -2, 'ignored petition');
      }
    }
    if (c.save.petitions.length >= 4) return;
    const mine = [...c.state.titlesHeldBy(me.id)].filter((t) => t.kind === 'manor' || t.kind === 'barony' || t.kind === 'town').sort((a, b) => a.id - b.id);
    for (const t of mine) {
      if (!rng.chance(0.35)) continue;
      const place = c.demesnePlace(t);
      const residents = c.state.residentsOf(place).filter((p) => ageYears(p, c.day) >= 16 && p.estate !== 'noble' && p.id !== me.id);
      if (!residents.length) continue;
      const from = residents[Math.floor(rng.next() * residents.length)];
      const st = c.state.settlements.get(place);
      const policy = c.policyPeek(place);
      const u = c.save.unrest[String(place)] ?? 0;
      const roll = rng.next();
      let kind: PetitionKind;
      if (st && st.prosperity < 0.85 && roll < 0.5) kind = roll < 0.25 ? 'grain' : 'relief';
      else if (policy.rent > 0 && roll < 0.6) kind = 'relief';
      else if (u > 35 && roll < 0.7) kind = 'protection';
      else kind = (['poacher', 'strips', 'marriage', 'alms', 'office'] as PetitionKind[])[Math.floor(rng.next() * 5)];
      if (kind === 'office' && this.offices.holders('reeve', place).length > 0 && this.offices.mode('reeve', place) === 'elected') kind = 'alms';
      this.add(kind, from.id, place, me.id);
      break;
    }
  }

  private add(kind: PetitionKind, from: PersonId, place: number, to: PersonId): void {
    const c = this.core;
    const f = c.person(from);
    if (!f) return;
    const name = f.first;
    const place_ = c.placeName(place);
    let text = '';
    let amount = 0;
    switch (kind) {
      case 'relief': text = `${name} and the other tenants of ${place_} beg you to ease their dues after a hard year.`; amount = 0; break;
      case 'grain': text = `${name} asks for grain from your barns: the stores of ${place_} are empty.`; amount = 60; break;
      case 'poacher': text = `${name} pleads for a poacher taken in your woods at ${place_}: the family will starve without him.`; amount = 24; break;
      case 'strips': text = `${name} asks you to settle a quarrel over strips in the fields of ${place_}.`; amount = 0; break;
      case 'marriage': text = `${name} asks your leave to marry outside the manor and begs you to waive the merchet.`; amount = 36; break;
      case 'protection': text = `${name} begs your protection against the outlaws who prey on ${place_}.`; amount = 90; break;
      case 'alms': text = `${name} asks alms for the sick and the old of ${place_}.`; amount = 48; break;
      default: text = `${name} asks to be made reeve of ${place_}.`; amount = 0;
    }
    const id = c.save.seq.petition++;
    c.save.petitions.push({ id, kind, from, place, to, day: Math.floor(c.day), text, amount });
    c.touch();
    c.sim.events.emit('request', { id, from, text });
    c.notify(text, 'quest');
  }

  resolvePetition(id: number, choice: 'grant' | 'refuse' | 'compromise'): Result {
    const c = this.core;
    const i = c.save.petitions.findIndex((p) => p.id === id);
    if (i < 0) return { ok: false, reason: 'That petition is closed.' };
    const pet = c.save.petitions[i];
    const lord = c.living(pet.to);
    const from = c.living(pet.from);
    if (!lord) return { ok: false, reason: 'Nobody to decide.' };
    const hh = c.state.households.get(lord.household);
    const spend = (n: number): boolean => {
      if (!hh) return n <= 0;
      if (hh.purse + lord.money < n) return false;
      const fromPurse = Math.min(hh.purse, n);
      hh.purse -= fromPurse;
      lord.money -= n - fromPurse;
      c.state.touchHousehold(hh);
      c.state.touch(lord);
      return true;
    };
    const op = (d: number, why: string): void => { if (from) c.social.adjustOpinion(from.id, lord.id, d, why); };
    const policy = c.policyFor(pet.place);
    const reason = (r: string): Result => ({ ok: false, reason: r });
    switch (pet.kind) {
      case 'relief':
        if (choice === 'grant') { policy.rent = clamp(policy.rent - 1, -1, 2) as ManorPolicy['rent']; policy.labour = clamp(policy.labour - 1, -1, 2) as ManorPolicy['labour']; c.raiseUnrest(pet.place, -10); op(8, 'eased dues'); }
        else if (choice === 'compromise') { if (!spend(30)) return reason('You cannot afford the feast.'); c.raiseUnrest(pet.place, -4); op(3, 'harvest feast'); }
        else { c.raiseUnrest(pet.place, 5); op(-5, 'refused relief'); }
        break;
      case 'grain':
        if (choice === 'grant') { if (!spend(pet.amount)) return reason('Your purse is too thin.'); c.raiseUnrest(pet.place, -6); op(10, 'grain'); lord.rep.generosity = clamp(lord.rep.generosity + 2, -100, 100); }
        else if (choice === 'compromise') { if (!spend(pet.amount / 3)) return reason('Your purse is too thin.'); c.raiseUnrest(pet.place, -2); op(3, 'some grain'); }
        else { c.raiseUnrest(pet.place, 4); op(-6, 'refused grain'); }
        break;
      case 'poacher':
        if (choice === 'grant') { op(8, 'pardon'); lord.rep.generosity = clamp(lord.rep.generosity + 1, -100, 100); c.raiseUnrest(pet.place, -2); }
        else if (choice === 'compromise') { if (hh) { hh.purse += pet.amount; c.state.touchHousehold(hh); } op(1, 'fined'); }
        else { op(-4, 'hanged'); c.raiseUnrest(pet.place, 3); lord.rep.cruelty = clamp(lord.rep.cruelty + 2, -100, 100); }
        break;
      case 'marriage':
        if (choice === 'grant') { op(8, 'merchet waived'); }
        else if (choice === 'compromise') { if (hh) { hh.purse += pet.amount / 2; c.state.touchHousehold(hh); } op(2, 'merchet halved'); }
        else { if (hh) { hh.purse += pet.amount; c.state.touchHousehold(hh); } op(-4, 'merchet'); }
        break;
      case 'protection':
        if (choice === 'grant') { if (!spend(pet.amount)) return reason('Your purse is too thin.'); c.raiseUnrest(pet.place, -10); op(8, 'protection'); this.huntBand(pet.place); }
        else if (choice === 'compromise') { if (!spend(pet.amount / 3)) return reason('Your purse is too thin.'); c.raiseUnrest(pet.place, -3); op(2, 'a watch'); }
        else { c.raiseUnrest(pet.place, 6); op(-5, 'refused protection'); }
        break;
      case 'office':
        if (choice === 'grant') {
          const r = this.offices.appoint(lord.id, 'reeve', pet.place, pet.from);
          if (!r.ok) return reason(r.reason ?? 'He cannot be made reeve.');
          op(10, 'office');
        } else op(choice === 'refuse' ? -3 : 1, 'office');
        break;
      default: // alms, strips
        if (choice === 'grant') { if (!spend(pet.amount || 12)) return reason('Your purse is too thin.'); op(7, 'alms'); lord.rep.generosity = clamp(lord.rep.generosity + 1, -100, 100); c.raiseUnrest(pet.place, -2); }
        else if (choice === 'compromise') { op(2, 'judgement'); }
        else op(-3, 'refused');
    }
    c.state.touch(lord);
    c.save.petitions.splice(i, 1);
    c.touch();
    return { ok: true };
  }

  /** The lord's men run the outlaws of a village to ground. */
  private huntBand(place: number): void {
    const c = this.core;
    for (const b of c.save.bands) {
      if (b.home !== place) continue;
      const id = b.members[0];
      const p = id ? c.living(id) : undefined;
      if (p && p.id !== c.playerId) { delete p.flags.outlaw; p.career = 'labourer'; c.state.touch(p); b.members.shift(); }
    }
  }
}
