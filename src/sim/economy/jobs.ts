// Jobs and careers (SPEC §6 "Choosing a field", §13 recruitment): the ladder of every field as it
// applies to one person, the posts on offer in a settlement and who may take them, taking and
// leaving a post, the pay and the promotions that follow, and where everyone works on a given day.
import { BUILDINGS } from '../../content/types';
import type { Sex } from '../../core/domain';
import { hash01 } from '../../core/math';
import { DAYS_PER_YEAR } from '../../core/time';
import { dayPart, isHolyDay } from '../calendar';
import { CAREERS, type CareerField, type CareerId } from '../careers';
import { skillLevel } from '../people';
import { setRank, shiftFamilyRank } from '../succession';
import { ageYears, NONE, type BuildingState, type Household, type Person, type PersonId } from '../state';
import type { Econ, EmploymentSave } from './core';
import { CAREER_ECON, ENTRY_TESTS, FIELD_INFO, careerEcon, pd } from './data';
import { nextTask } from './farm';
import { bagGet } from './items';
import { manumissionPrice } from './obligations';
import { countGoodOf } from './own';
import type {
  CareerPath, Employment, JobOffer, Requirement, Result, WorkSpot,
} from './types';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const req = (label: string, met: boolean): Requirement => ({ label, met });

const ids = {
  farmhand: 0, herd: 1, shepherd: 2, apprentice: 3, journeyman: 4, servant: 5, potboy: 6, shopboy: 7, novice: 8,
  archer: 9, manAtArms: 10, sergeant: 11, clerk: 12, healer: 13, woodhand: 14,
} as const;
type JobKindId = (typeof ids)[keyof typeof ids];

/** Job ids stay the same for the same employer and kind: employer × 20 + kind, institutions after 1e9. */
export function jobId(employer: PersonId, settlement: number, kind: JobKindId): number {
  return employer > 0 ? employer * 20 + kind : 1_000_000_000 + settlement * 20 + kind;
}

export function employmentOf(E: Econ, personId: PersonId): Employment | null {
  const e = E.save.emp[String(personId)];
  if (!e) return null;
  return { employer: e.e, career: e.c, title: e.t, wage: e.w, since: e.s, building: e.b >= 0 ? e.b : undefined, settlement: e.st, terms: e.tm, until: e.u };
}

function setEmployment(E: Econ, personId: PersonId, e: Employment): void {
  const rec: EmploymentSave = { e: e.employer, c: e.career, t: e.title, w: e.wage, s: e.since, b: e.building ?? -1, st: e.settlement, tm: e.terms, u: e.until };
  E.save.emp[String(personId)] = rec;
  E.touchSave();
}

function clearEmployment(E: Econ, personId: PersonId): void {
  delete E.save.emp[String(personId)];
  E.touchSave();
}

function buildingsOf(E: Econ, sid: number, kinds: readonly string[]): BuildingState[] {
  const out: BuildingState[] = [];
  for (const b of E.state.buildingsAt.get(sid) ?? []) if (kinds.includes(b.kind)) out.push(b);
  return out;
}

function money(E: Econ, p: Person): number {
  const hh = E.hhOf(p);
  return p.money + (hh ? hh.purse : 0);
}

// ---------------------------------------------------------------------------------------------
// Career paths (the SPEC §6 table, for one person)
// ---------------------------------------------------------------------------------------------

const PATH_FIELDS: ReadonlyArray<{ field: CareerField | 'freedom'; key: string }> = [
  { field: 'land', key: 'land' }, { field: 'husbandry', key: 'husbandry' }, { field: 'brewing', key: 'brewing' },
  { field: 'craft', key: 'craft' }, { field: 'trade', key: 'trade' }, { field: 'arms', key: 'arms' },
  { field: 'knighthood', key: 'knighthood' }, { field: 'church', key: 'church' }, { field: 'service', key: 'service' },
  { field: 'healing', key: 'healing' }, { field: 'outlaw', key: 'outlaw' }, { field: 'freedom', key: 'freedom' },
];

/** Stats and skills against an entry test; labels name what is lacking. */
export function testRequirements(E: Econ, p: Person, test: (typeof ENTRY_TESTS)[number]): Requirement[] {
  const out: Requirement[] = [];
  const age = ageYears(p, E.day);
  out.push(req(`Aged ${test.minAge}${test.maxAge ? ` to ${test.maxAge}` : ' or more'}`, age >= test.minAge && (!test.maxAge || age <= test.maxAge)));
  if (test.sex) out.push(req('A man (the lords muster men only)', p.sex === test.sex));
  for (const [stat, v] of Object.entries(test.stats)) out.push(req(`${stat.toUpperCase()} ${v}`, p.trained[stat as keyof typeof p.trained] >= (v as number)));
  for (const [skill, v] of Object.entries(test.skills)) out.push(req(`${skill[0].toUpperCase()}${skill.slice(1)} ${v}`, skillLevel(p.skills[skill as keyof typeof p.skills]) >= (v as number)));
  for (const k of test.kit) {
    if (k === 'bow') out.push(req('A bow of your own', countGoodOf(p, 'longbow') + countGoodOf(p, 'shortbow') > 0));
    else if (k === 'armour') out.push(req('Armour (own or issued)', true));
    else if (k === 'horse') {
      const hh = E.hhOf(p);
      out.push(req('A horse of your own', !!hh && (bagGet(hh.stores, 'horse#1') + bagGet(hh.stores, 'horse#2') + bagGet(hh.stores, 'horse#0') + bagGet(hh.stores, 'horse#3') > 0)));
    }
  }
  return out;
}

function sexRuleOk(sex: Sex, rule?: Sex): boolean { return !rule || rule === sex; }

/** Fields whose door is shut to one sex (SPEC §6). */
const SEX_BARRED: Partial<Record<string, Sex>> = { arms: 'f', knighthood: 'f' };

export function careerPaths(E: Econ, personId: PersonId): CareerPath[] {
  const p = E.person(personId);
  if (!p) return [];
  const age = ageYears(p, E.day);
  const own = CAREERS[p.career].field;
  const out: CareerPath[] = [];
  for (const { field, key } of PATH_FIELDS) {
    const info = FIELD_INFO[key];
    if (!info) continue;
    let requirements: Requirement[] = [];
    let open = true;
    switch (field) {
      case 'land':
        requirements = [req('Aged 12 or more', age >= 12), req('Strips to work: your family\'s, a farmhand\'s post, or rented from the reeve', true)];
        break;
      case 'husbandry':
        requirements = [req('Aged 12 or more', age >= 12)];
        break;
      case 'brewing':
        requirements = [req('Aged 14 or more', age >= 14), req('A hearth and some malt', true)];
        break;
      case 'craft': {
        const female = p.sex === 'f';
        requirements = [
          req('Aged 12 to 18 for an apprenticeship', age >= 12 && age <= 18 || own === 'craft'),
          req(`A master who will take you on (kin, a good name, or a premium of about ${pd(100)})`, true),
          req(female ? 'Women: spinning and weaving, or a widow\'s workshop' : 'Men in most trades', true),
        ];
        if (female) open = true;
        break;
      }
      case 'trade':
        requirements = [req('Aged 16 or more', age >= 16), req(`Capital: ${pd(24)} for a peddler's pack`, money(E, p) >= 24 || own === 'trade'), req('Letters 1 helps', skillLevel(p.skills.letters) >= 1)];
        break;
      case 'arms':
        requirements = ENTRY_TESTS.length ? testRequirements(E, p, ENTRY_TESTS[0]) : [];
        open = p.sex === 'm';
        break;
      case 'knighthood':
        requirements = [req('Born to a knightly house', p.estate === 'noble' && p.rankTier >= 4), req('A man', p.sex === 'm')];
        open = p.sex === 'm' && p.estate === 'noble';
        break;
      case 'church':
        requirements = [req('Aged 14 or more', age >= 14), req(`Letters 1 or a gift of ${pd(24)} to the house`, skillLevel(p.skills.letters) >= 1 || money(E, p) >= 24)];
        break;
      case 'service':
        requirements = [req('Aged 11 or more', age >= 11), req('Clerks need Letters 3', skillLevel(p.skills.letters) >= 3)];
        break;
      case 'healing':
        requirements = [req('Aged 16 or more', age >= 16), req('A healer to teach you, or Medicine 1', skillLevel(p.skills.medicine) >= 1)];
        break;
      case 'outlaw':
        requirements = [req('Nothing but nerve (and the lord\'s law against you)', true)];
        break;
      case 'freedom': {
        const unfree = p.estate === 'unfree';
        requirements = [req('Unfree', unfree), req(`${pd(manumissionPrice(E, p))} for manumission, or a year and a day in a chartered town`, money(E, p) >= manumissionPrice(E, p))];
        open = unfree;
        break;
      }
    }
    if (field !== 'freedom' && field !== 'knighthood' && field !== 'arms') open = requirements.every((r) => r.met) || own === field;
    else if (field === 'arms') open = open && requirements.every((r) => r.met);
    const stage = field === own ? p.careerStage : -1;
    const path: CareerPath = {
      field: field as CareerField, label: info.label, entry: info.entry, ladder: info.ladder, stage, requirements, open,
    };
    // the note explains a closed door, so it is given only where the person's sex is what bars them
    if (info.sexRule && SEX_BARRED[field] === p.sex) path.sexRule = info.sexRule;
    out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Jobs on offer
// ---------------------------------------------------------------------------------------------

interface Spec {
  kind: JobKindId;
  career: CareerId;
  stage: number;
  title: string;
  terms: JobOffer['terms'];
  wage: number;
  premium?: number;
  employer: PersonId;
  building?: number;
  sex?: Sex;
  requirements: Requirement[];
}

function offerFrom(s: Spec, settlement: number): JobOffer {
  const o: JobOffer = {
    id: jobId(s.employer, settlement, s.kind), employer: s.employer, settlement, career: s.career, title: s.title,
    wage: Math.round(s.wage * 100) / 100, terms: s.terms, requirements: s.requirements,
  };
  if (s.building !== undefined) o.building = s.building;
  if (s.premium !== undefined) o.premium = s.premium;
  if (s.sex) o.sex = s.sex;
  return o;
}

const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function residentsWith(E: Econ, sid: number, pred: (p: Person) => boolean): Person[] {
  const out: Person[] = [];
  for (const p of E.state.residentsOf(sid)) if (!p.death && pred(p)) out.push(p);
  return out;
}

/** Apprentices, journeymen and servants living in a household of the settlement. */
function dependants(E: Econ, hh: Household, career: CareerId, stage: number): number {
  let n = 0;
  const house = E.state.houses.get(E.state.persons.get(hh.head)?.house ?? 0);
  for (const id of hh.members) {
    const m = E.state.persons.get(id);
    if (m && !m.death && m.career === career && m.careerStage === stage && house?.sworn.includes(m.id)) n++;
  }
  return n;
}

/** The posts on offer in a settlement, with what `forPerson` lacks for each. */
export function jobsAt(E: Econ, sid: number, forPerson: PersonId): JobOffer[] {
  const s = E.settlementById.get(sid);
  const p = E.person(forPerson);
  if (!s || !p) return [];
  const day = E.day;
  const age = ageYears(p, day);
  const specs: Spec[] = [];
  const free = p.estate !== 'unfree';
  const lord = E.lordOf(sid);
  const reeve = E.state.residentsOf(sid).find((r) => !r.death && r.offices.some((o) => o.office === 'reeve' && o.place === sid));
  const villageLike = s.kind === 'village' || s.kind === 'hamlet';
  const strong = (v: number): Requirement => req(`Strength ${v}`, p.trained.str >= v);

  // ---- the land: day labour for the manor, the village herd ----
  if (villageLike || s.kind === 'abbey' || s.kind === 'town') {
    const employer = reeve?.id ?? lord?.person.id ?? 0;
    const adult = age >= 14;
    specs.push({
      kind: ids.farmhand, career: 'labourer', stage: 0, title: adult ? 'Farmhand (day labour for the manor)' : 'Farm boy (day labour)', terms: 'day',
      wage: adult ? 2 : 1, employer, requirements: [req('Aged 12 or more', age >= 12), strong(7)],
    });
    if (villageLike) {
      specs.push({
        kind: ids.herd, career: 'shepherd', stage: 0, title: p.sex === 'f' ? 'Herd girl' : 'Herd boy', terms: 'season', wage: 1,
        employer, requirements: [req('Aged 12 to 16', age >= 12 && age <= 16)],
      });
      specs.push({
        kind: ids.shepherd, career: 'shepherd', stage: 1, title: 'Shepherd', terms: 'year', wage: 1.5, employer,
        requirements: [req('Aged 14 or more', age >= 14), req('Husbandry 2', skillLevel(p.skills.husbandry) >= 2)],
      });
      const woodward = residentsWith(E, sid, (r) => r.career === 'woodward')[0];
      if (woodward) {
        specs.push({
          kind: ids.woodhand, career: 'woodward', stage: 0, title: "Woodward's hand", terms: 'day', wage: 2, employer: woodward.id,
          requirements: [req('Aged 14 or more', age >= 14), strong(8)],
        });
      }
    }
  }

  // ---- craft: masters with room for an apprentice or a journeyman ----
  for (const m of residentsWith(E, sid, (r) => CAREERS[r.career].field === 'craft' && r.careerStage >= 2)) {
    const hh = E.state.households.get(m.household);
    if (!hh || hh.head !== m.id || m.id === p.id || hh.members.includes(p.id)) continue;
    const ce = careerEcon(m.career);
    const def = CAREERS[m.career];
    const label = def.label.toLowerCase();
    const workplace = buildingsOf(E, sid, ce.workplace.filter((k) => k !== 'home'))[0];
    const kin = isKin(E, p, m);
    const premium = Math.round((ce.premium ?? 100) * (kin ? 0 : 1) * (E.social.opinion(m.id, p.id) > 20 ? 0.7 : 1));
    if (dependants(E, hh, m.career, 0) < 2) {
      const sexOk = sexRuleOk(p.sex, def.sex) || (p.sex === 'f' && (m.career === 'weaver' || m.career === 'tailor' || m.career === 'potter'));
      specs.push({
        kind: ids.apprentice, career: m.career, stage: 0, title: `Apprentice ${label}`, terms: 'apprenticeship', wage: 0, premium,
        employer: m.id, building: workplace?.id, sex: def.sex,
        requirements: [
          req('Aged 12 to 18', age >= 12 && age <= 18),
          req(def.sex === 'm' ? 'A boy (the trade takes men)' : 'Boys and girls alike', sexOk),
          req(premium > 0 ? `A premium of ${pd(premium)}${kin ? '' : ' (kin pay nothing)'}` : 'Kin of the master: no premium', premium <= 0 || money(E, p) >= premium + (free ? 0 : 24)),
          req(free ? 'Free born' : `Your lord's leave (${pd(24)})`, free || money(E, p) >= premium + 24),
          req('Not already bound', employmentOf(E, p.id)?.terms !== 'apprenticeship'),
        ],
      });
    }
    if (dependants(E, hh, m.career, 1) < 1) {
      specs.push({
        kind: ids.journeyman, career: m.career, stage: 1, title: `Journeyman ${label}`, terms: 'year', wage: ce.wage[1], employer: m.id, building: workplace?.id,
        requirements: [
          req('Served your apprenticeship, or Skill 4 in the trade', (CAREERS[p.career].field === 'craft' && p.careerStage >= 1) || skillLevel(p.skills[ce.skill]) >= 4),
          req('Aged 16 or more', age >= 16), req(def.sex === 'm' ? 'A man' : 'Open to both', sexRuleOk(p.sex, def.sex)),
        ],
      });
    }
  }

  // ---- brewing, trade and service in the town ----
  for (const m of residentsWith(E, sid, (r) => r.career === 'alewife' || r.career === 'tavern_keeper')) {
    const hh = E.state.households.get(m.household);
    if (!hh || hh.head !== m.id || m.id === p.id || hh.members.includes(p.id)) continue;
    specs.push({
      kind: ids.potboy, career: 'cook', stage: 0, title: m.career === 'alewife' ? "Alewife's potboy" : 'Potboy at the tavern', terms: 'day', wage: 1,
      employer: m.id, building: buildingsOf(E, sid, ['tavern', 'alehouse'])[0]?.id, requirements: [req('Aged 12 or more', age >= 12)],
    });
    break;
  }
  for (const m of residentsWith(E, sid, (r) => r.career === 'merchant' || r.career === 'shopkeeper')) {
    const hh = E.state.households.get(m.household);
    if (!hh || hh.head !== m.id || m.id === p.id || hh.members.includes(p.id)) continue;
    specs.push({
      kind: ids.shopboy, career: 'shopkeeper', stage: 0, title: m.career === 'merchant' ? "Merchant's shop boy" : 'Shop boy', terms: 'season', wage: 1,
      employer: m.id, building: buildingsOf(E, sid, ['market_hall', 'market_stall', 'warehouse'])[0]?.id,
      requirements: [req('Aged 13 or more', age >= 13), req('Quick with figures (Intellect 8)', p.trained.int >= 8)],
    });
    break;
  }
  const great = lord?.household && (s.kind === 'castle' || lord.person.rankTier >= 5);
  if (great && lord) {
    specs.push({
      kind: ids.servant, career: 'servant', stage: 0, title: `Servant in ${lord.person.first}'s household`, terms: 'service', wage: 0.8, employer: lord.person.id,
      requirements: [req('Aged 11 or more', age >= 11), req('Not tied to another household as head', E.hhOf(p)?.head !== p.id || (E.hhOf(p)?.members.length ?? 0) <= 1)],
    });
  }
  const clerkMaster = residentsWith(E, sid, (r) => r.career === 'steward' || r.career === 'bailiff' || r.career === 'priest')[0];
  if (clerkMaster) {
    specs.push({
      kind: ids.clerk, career: 'clerk', stage: 0, title: `Clerk to ${clerkMaster.first}`, terms: 'year', wage: careerEcon('clerk').wage[1], employer: clerkMaster.id,
      requirements: [req('Letters 3', skillLevel(p.skills.letters) >= 3), req('Aged 16 or more', age >= 16)],
    });
  }
  const healer = residentsWith(E, sid, (r) => r.career === 'healer' || r.career === 'midwife')[0];
  if (healer) {
    specs.push({
      kind: ids.healer, career: 'healer', stage: 0, title: `${titleCase(CAREERS[healer.career].label.toLowerCase())}'s apprentice`, terms: 'apprenticeship', wage: 0,
      premium: 60, employer: healer.id, requirements: [req('Aged 14 or more', age >= 14), req(`A premium of ${pd(60)}`, money(E, p) >= 60)],
    });
  }

  // ---- the church ----
  if (s.kind === 'abbey' || s.kind === 'priory' || s.kind === 'nunnery') {
    const house = E.state.householdList(sid).find((h) => h.kind === 'monastic');
    const head = house ? E.state.persons.get(house.head) : undefined;
    if (head) {
      const nun = s.kind === 'nunnery';
      specs.push({
        kind: ids.novice, career: nun ? 'nun' : 'monk', stage: 0, title: nun ? 'Novice at the nunnery' : 'Novice', terms: 'service', wage: 0, premium: 24,
        employer: head.id, building: buildingsOf(E, sid, ['cloister', 'church', 'abbey_church'])[0]?.id,
        requirements: [
          req('Aged 14 or more', age >= 14), req(nun ? 'A woman' : 'A man', nun ? p.sex === 'f' : p.sex === 'm'),
          req(`Letters 1 or a gift of ${pd(24)}`, skillLevel(p.skills.letters) >= 1 || money(E, p) >= 24),
        ],
      });
    }
  }

  // ---- arms: the recruiter's tests (SPEC §13) at castles and towns ----
  if (s.kind === 'castle' || s.kind === 'town' || s.kind === 'city') {
    const garrison = E.state.householdList(sid).find((h) => h.kind === 'garrison');
    const captain = garrison ? E.state.persons.get(garrison.head) : undefined;
    const recruiter = captain ?? lord?.person;
    if (recruiter) {
      for (const t of ENTRY_TESTS) {
        const kind = t.career === 'archer' ? ids.archer : t.career === 'man_at_arms' ? ids.manAtArms : ids.sergeant;
        specs.push({
          kind, career: t.career, stage: t.career === 'archer' ? 1 : 1, title: t.label.split(':')[0], terms: 'service', wage: CAREER_ECON[t.career].wage[1], employer: recruiter.id,
          building: buildingsOf(E, sid, ['barracks', 'training_yard'])[0]?.id, sex: 'm', requirements: testRequirements(E, p, t),
        });
      }
    }
  }
  return specs.map((sp) => offerFrom(sp, sid));
}

function isKin(E: Econ, a: Person, b: Person): boolean {
  if (a.father === b.id || a.mother === b.id || b.father === a.id || b.mother === a.id) return true;
  if (a.father && a.father === b.father) return true;
  if (a.mother && a.mother === b.mother) return true;
  return a.spouse === b.id || (!!a.father && E.state.persons.get(a.father)?.father === b.id);
}

// ---------------------------------------------------------------------------------------------
// Taking and leaving a post
// ---------------------------------------------------------------------------------------------

function findJob(E: Econ, jobIdNum: number, person: PersonId): JobOffer | null {
  const sid = jobIdNum >= 1_000_000_000 ? Math.floor((jobIdNum - 1_000_000_000) / 20) : -1;
  const candidates: number[] = [];
  if (sid >= 0) candidates.push(sid);
  else {
    const employer = E.person(Math.floor(jobIdNum / 20));
    if (employer) candidates.push(employer.settlement);
    const p = E.person(person);
    if (p) candidates.push(p.settlement);
  }
  for (const c of candidates) {
    const hit = jobsAt(E, c, person).find((j) => j.id === jobIdNum);
    if (hit) return hit;
  }
  return null;
}

export function applyForJob(E: Econ, personId: PersonId, id: number, opts: { premiumPaid?: boolean } = {}): Result {
  const p = E.person(personId);
  if (!p || p.death) return { ok: false, reason: 'Nobody to take the post' };
  const job = findJob(E, id, personId);
  if (!job) return { ok: false, reason: 'That post is no longer on offer' };
  const filledUntil = E.save.filled[String(id)];
  if (filledUntil !== undefined && filledUntil > E.day) return { ok: false, reason: 'That post has been taken' };
  const lacking = job.requirements.find((r) => !r.met && !(opts.premiumPaid && /premium|leave/i.test(r.label)));
  if (lacking && !(E.isPlayer(personId) === false && job.terms === 'day')) return { ok: false, reason: `Needs: ${lacking.label}` };
  if (employmentOf(E, personId) && job.terms !== 'day') return { ok: false, reason: 'You are already bound to a master. Leave that post first' };
  const employer = job.employer ? E.person(job.employer) : undefined;
  const sid = job.settlement;
  const day = E.day;
  const kindOf = (job.id >= 1_000_000_000 ? (job.id - 1_000_000_000) % 20 : job.id % 20) as JobKindId;
  const from = p.career;
  const premium = job.premium ?? 0;

  // the fee: the youth's pocket first, then the family purse (SPEC §6: the family pays a master a premium)
  const unfreeLicence = p.estate === 'unfree' && kindOf === ids.apprentice ? 24 : 0;
  const fee = premium > 0 && E.isPlayer(personId) ? premium + unfreeLicence : 0;
  if (fee > 0 && !E.payWithFamily(p, fee, 'Premium for the post')) return { ok: false, reason: `You cannot pay ${pd(fee)}` };
  const joinsHousehold = kindOf === ids.apprentice || kindOf === ids.healer || kindOf === ids.servant || kindOf === ids.novice
    || kindOf === ids.archer || kindOf === ids.manAtArms || kindOf === ids.sergeant;

  // career and rank
  if (employer && joinsHousehold) {
    const empHH = E.state.households.get(employer.household);
    if (empHH) {
      E.state.leaveHousehold(p);
      E.state.joinHousehold(p, empHH);
      const house = E.state.houses.get(employer.house);
      if (house) {
        E.state.setHouse(p, house.id);
        if (!house.sworn.includes(p.id)) { house.sworn.push(p.id); E.state.touchHouse(house); }
      }
      if (empHH.settlement !== p.settlement) E.state.setSettlement(p, empHH.settlement);
      if (premium > 0 && !E.isPlayer(personId)) E.credit(empHH, premium);
    }
  }
  if (premium > 0 && employer && E.isPlayer(personId)) {
    const empHH = E.state.households.get(employer.household);
    if (empHH) E.credit(empHH, premium);
    const lord = unfreeLicence > 0 ? E.lordOf(p.settlement)?.household : undefined;
    if (lord) E.credit(lord, unfreeLicence);
  }
  p.career = job.career;
  p.careerStage = kindOf === ids.apprentice || kindOf === ids.healer ? 0 : kindOf === ids.journeyman ? 1 : kindOf === ids.archer || kindOf === ids.manAtArms || kindOf === ids.sergeant ? 1 : 0;
  if (kindOf === ids.novice) { p.estate = 'clergy'; setRank(E.sim, p, 2); }
  else if (kindOf === ids.apprentice || kindOf === ids.journeyman || kindOf === ids.healer) {
    if (p.estate === 'unfree') p.estate = 'free';
    if (p.rankTier < 2) setRank(E.sim, p, 2);
  } else if (kindOf === ids.archer || kindOf === ids.manAtArms || kindOf === ids.sergeant) {
    if (p.estate === 'unfree') p.estate = 'free';
    if (p.rankTier < 2) setRank(E.sim, p, 2);
  }
  const term = (careerEcon(job.career).term ?? 7) * DAYS_PER_YEAR;
  const until = job.terms === 'apprenticeship' ? Math.floor(day) + term : job.terms === 'year' ? Math.floor(day) + DAYS_PER_YEAR : job.terms === 'season' ? Math.floor(day) + 4 : -1;
  setEmployment(E, personId, {
    employer: job.employer, career: job.career, title: job.title, wage: job.wage, since: Math.floor(day), building: job.building,
    settlement: sid, terms: job.terms, until,
  });
  if (job.terms !== 'day') { E.save.filled[String(id)] = Math.floor(day) + (job.terms === 'apprenticeship' ? term : job.terms === 'year' ? 16 : 4); }
  E.state.touch(p);
  E.sim.events.emit('careerChanged', { person: personId, from, to: job.career, stage: p.careerStage });
  if (E.isPlayer(personId)) {
    E.notify(`You are taken on: ${job.title}.`, 'gain', personId);
    E.state.log(day, 'career', `${p.first} took the post of ${job.title.toLowerCase()}.`, [personId]);
    if (employer) E.social.adjustOpinion(employer.id, personId, 4, 'took the post');
  }
  return { ok: true };
}

export function quitJob(E: Econ, personId: PersonId): Result {
  const p = E.person(personId);
  const emp = employmentOf(E, personId);
  if (!p || !emp) return { ok: false, reason: 'You have no post to leave' };
  clearEmployment(E, personId);
  const employer = emp.employer ? E.person(emp.employer) : undefined;
  if (emp.terms === 'apprenticeship' || emp.terms === 'year' || emp.terms === 'service') {
    if (employer) E.social.adjustOpinion(employer.id, personId, -12, 'left before the term');
    p.rep.honour = Math.max(-100, p.rep.honour - (emp.terms === 'apprenticeship' ? 6 : 3));
    // back to the family if they will have you, else to a lodging of your own
    const hh = E.hhOf(p);
    if (hh && employer && hh.id === employer.household) {
      const home = [p.father, p.mother].map((id) => E.person(id)).find((q) => q && !q.death && q.household && q.household !== hh.id);
      const target = home ? E.household(home.household) : undefined;
      E.state.leaveHousehold(p);
      if (target) E.state.joinHousehold(p, target);
      else {
        const fresh = E.state.addHousehold({ id: E.state.households.alloc(), kind: 'family', head: NONE, members: [], home: -1, settlement: p.settlement, purse: 0, stores: {} });
        E.state.joinHousehold(p, fresh);
        E.state.setHead(fresh, p);
      }
      const house = E.state.houses.get(p.house);
      if (house) { const i = house.sworn.indexOf(p.id); if (i >= 0) { house.sworn.splice(i, 1); E.state.touchHouse(house); } }
    }
    p.career = 'labourer';
    p.careerStage = 0;
  }
  E.state.touch(p);
  E.sim.events.emit('careerChanged', { person: personId, from: emp.career, to: p.career, stage: p.careerStage });
  if (E.isPlayer(personId)) E.notify(`You leave your post: ${emp.title}.`, 'info', personId);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Pay and promotion (daily, for everyone with a recorded post)
// ---------------------------------------------------------------------------------------------

export function employmentDaily(E: Econ): void {
  const day = Math.floor(E.day);
  for (const key of Object.keys(E.save.emp)) {
    const pid = Number(key);
    const p = E.person(pid);
    const rec = E.save.emp[key];
    if (!p || p.death) { delete E.save.emp[key]; E.touchSave(); continue; }
    const employer = rec.e ? E.person(rec.e) : undefined;
    if (rec.e && (!employer || employer.death)) {
      // the master died: the post ends, an apprentice keeps what he learned
      delete E.save.emp[key]; E.touchSave();
      if (E.isPlayer(pid)) E.notify(`Your master is dead. You are free to seek another.`, 'warn', pid);
      continue;
    }
    // wages for posts by the season or the year (day labour is paid per bout)
    if ((rec.tm === 'season' || rec.tm === 'year' || rec.tm === 'service') && rec.w > 0 && !isHolyDay(E.day)) {
      const eh = employer ? E.hhOf(employer) : undefined;
      const pay = Math.min(rec.w, eh ? eh.purse : rec.w);
      if (pay > 0) {
        if (eh) E.debit(eh, pay);
        E.earn(p, pay, `Wages: ${rec.t}`);
      }
    }
    if (rec.tm === 'season' && rec.u > 0 && day >= rec.u) { delete E.save.emp[key]; E.touchSave(); if (E.isPlayer(pid)) E.notify(`Your season as ${rec.t.toLowerCase()} is over.`, 'info', pid); continue; }
    if (rec.tm === 'apprenticeship' && rec.u > 0 && day >= rec.u) finishApprenticeship(E, p, rec);
    if (rec.tm === 'year' && rec.u > 0 && day >= rec.u) { rec.u = day + DAYS_PER_YEAR; E.touchSave(); } // the year is renewed
  }
}

function finishApprenticeship(E: Econ, p: Person, rec: EmploymentSave): void {
  const ce = careerEcon(rec.c);
  const skill = skillLevel(p.skills[ce.skill]);
  const player = E.isPlayer(p.id);
  if (skill < 3) {
    rec.u += DAYS_PER_YEAR;
    E.touchSave();
    if (player) E.notify('Your master keeps you another year: your work is not yet good enough (skill 3 needed).', 'warn', p.id);
    return;
  }
  // journeyman
  p.careerStage = 1;
  rec.tm = 'year';
  rec.w = ce.wage[1] ?? 3;
  rec.t = rec.t.replace('Apprentice', 'Journeyman');
  rec.u = Math.floor(E.day) + DAYS_PER_YEAR;
  E.touchSave();
  E.state.touch(p);
  E.sim.events.emit('careerChanged', { person: p.id, from: rec.c, to: rec.c, stage: 1 });
  if (player) {
    E.notify(`Your apprenticeship is done: you are a journeyman ${CAREERS[rec.c].label.toLowerCase()} on ${pd(rec.w)} a day.`, 'gain', p.id);
    E.state.log(E.day, 'career', `${p.first} finished his apprenticeship and became a journeyman.`, [p.id]);
    E.sim.score.award('deed', 10, 'Journeyman');
  }
}

/** Land ladder of a household head: tenant (strips), free tenant, yeoman (SPEC §6). Called daily for the player. */
export function landLadder(E: Econ, p: Person): void {
  const hh = E.hhOf(p);
  if (!hh || hh.head !== p.id) return;
  const field = CAREERS[p.career].field;
  if (field !== 'land' && p.career !== 'child' && p.career !== 'none') return;
  let held = 0, owned = 0;
  const strips = E.world.settlements.find((s) => s.id === hh.settlement)?.strips ?? [];
  for (const id of strips) {
    const st = E.state.strips.get(id);
    if (st && st.holder === hh.id) { held++; if (E.save.lease[String(id)] === 0) owned++; }
  }
  if (held === 0) return;
  let stage = p.careerStage;
  if (p.career === 'child' || p.career === 'none' || p.career === 'labourer' || p.career === 'cottar') {
    p.career = 'farmer';
    stage = Math.max(1, stage);
    E.sim.events.emit('careerChanged', { person: p.id, from: 'labourer', to: 'farmer', stage });
  }
  if (p.estate !== 'unfree' && held >= 6) stage = Math.max(stage, 2);
  if (p.estate !== 'unfree' && (held >= 12 || owned >= 6) && E.age(p) >= 18) {
    if (p.career !== 'yeoman') {
      p.career = 'yeoman';
      E.sim.events.emit('careerChanged', { person: p.id, from: 'farmer', to: 'yeoman', stage: 3 });
      E.deed('yeoman', 60, 'Became a yeoman');
      E.notify('You are a yeoman now: a freeman of substance with land of your own.', 'gain');
      if (p.rankTier < 3) shiftFamilyRank(E.sim, p, 3);
    }
    stage = 3;
  }
  if (stage !== p.careerStage) { p.careerStage = stage; E.state.touch(p); }
}

// ---------------------------------------------------------------------------------------------
// Where everyone works (agents walk there; the renderer shows the work)
// ---------------------------------------------------------------------------------------------

export function aiTask(E: Econ, p: Person, hh: Household | undefined, age: number, sea: number): string {
  const set = E.save.plan[String(p.id)];
  if (set && set !== 'auto') return set;
  if (age < 8) return 'play';
  const field = CAREERS[p.career].field;
  if (age < 12) return p.sex === 'f' ? 'garden' : 'livestock';
  if (age < 14 && field !== 'craft') return p.sex === 'f' ? 'garden' : 'livestock';
  switch (field) {
    case 'craft': return 'craft';
    case 'brewing': return 'brew';
    case 'trade': return 'market';
    case 'church': case 'service': case 'healing': case 'arms': case 'knighthood': case 'noble': return 'service';
    case 'husbandry': return 'livestock';
    case 'land': case 'none': {
      if (p.sex === 'f') return sea === 3 ? 'spin' : sea === 1 || (hh && hh.id % 2 === 0) ? 'garden' : 'fields';
      return sea === 3 ? (p.id % 3 === 0 ? 'wood' : 'livestock') : 'fields';
    }
    default: return 'service';
  }
}

function centre(E: Econ, sid: number): { x: number; z: number } {
  const s = E.settlementById.get(sid);
  return s ? { x: s.x, z: s.z } : { x: 0, z: 0 };
}

const TASK_ANIM: Record<string, { anim: WorkSpot['anim']; held: WorkSpot['mainHand']; carry?: WorkSpot['carry']; label: string }> = {
  plough: { anim: 'work_hoe', held: 'staff', label: 'Ploughing' },
  harrow: { anim: 'work_hoe', held: 'hoe', label: 'Harrowing' },
  sow: { anim: 'work_sow', held: 'basket', label: 'Sowing' },
  weed: { anim: 'work_hoe', held: 'hoe', label: 'Weeding' },
  reap: { anim: 'work_sickle', held: 'sickle', label: 'Reaping' },
  bind: { anim: 'work_lift', held: 'none', carry: 'sheaf', label: 'Binding sheaves' },
  carry: { anim: 'carry_walk', held: 'none', carry: 'sheaf', label: 'Carrying sheaves' },
};

export function workSpot(E: Econ, personId: PersonId, absDay: number): WorkSpot | null {
  const p = E.person(personId);
  if (!p || p.death) return null;
  const age = ageYears(p, absDay);
  if (age < 7 || isHolyDay(absDay)) return null;
  const part = dayPart(absDay);
  if (part !== 'morning' && part !== 'afternoon') return null;
  const state = E.state;
  const hh = state.households.get(p.household);
  const sid = p.settlement;
  const sea = Math.floor((((absDay % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR) / 4);
  const task = aiTask(E, p, hh, age, sea);
  const ce = careerEcon(p.career);
  const emp = employmentOf(E, personId);
  const dayNo = Math.floor(absDay);

  const home = hh ? state.buildings.get(hh.home) : undefined;
  const buildingSpot = (b: BuildingState, anim: WorkSpot['anim'], held: WorkSpot['mainHand'], label: string, carry?: WorkSpot['carry']): WorkSpot => {
    const spot: WorkSpot = { kind: 'building', id: b.id, x: b.x, z: b.z, anim, mainHand: held, label };
    if (carry) spot.carry = carry;
    return spot;
  };

  switch (task) {
    case 'fields': {
      const s = E.settlementById.get(sid);
      if (s && s.strips.length > 0) {
        const mine: number[] = [];
        const demesne: number[] = [];
        for (const id of s.strips) {
          const st = state.strips.get(id);
          if (!st) continue;
          if (hh && st.holder === hh.id) mine.push(id);
          else if (st.holder === 0) demesne.push(id);
        }
        const serf = p.estate === 'unfree' && dayNo % 4 === 1; // week-work on the first day of the week
        const pools = serf && demesne.length > 0 ? [demesne, mine] : [mine, emp && emp.employer ? [] : []];
        for (const pool of pools) {
          const busy = pool.filter((id) => nextTask(E, state.strips.get(id) as never) !== null);
          if (busy.length === 0) continue;
          const id = busy[Math.floor(hash01(personId, dayNo, 5) * busy.length)];
          const st = state.strips.get(id) as ReturnType<typeof state.strips.get> & object;
          const c = E.stripCentre.get(id) ?? centre(E, sid);
          const task2 = nextTask(E, st) ?? 'weed';
          const a = TASK_ANIM[task2];
          const spot: WorkSpot = { kind: 'strip', id, x: c.x, z: c.z, anim: a.anim, mainHand: a.held, label: a.label };
          if (a.carry) spot.carry = a.carry;
          return spot;
        }
      }
      if (home) return buildingSpot(home, 'work_dig', 'spade', 'Tending the garden');
      return null;
    }
    case 'garden':
      return home ? buildingSpot(home, 'work_dig', 'spade', 'Tending the garden') : null;
    case 'livestock': {
      const parcel = E.world.parcels.find((q) => q.settlement === sid && (q.use === 'pasture' || q.use === 'meadow'));
      if (parcel && parcel.poly.length > 0) {
        let x = 0, z = 0;
        for (const q of parcel.poly) { x += q.x; z += q.z; }
        return { kind: 'pasture', id: parcel.id, x: x / parcel.poly.length, z: z / parcel.poly.length, anim: 'idle', mainHand: 'crook', label: 'Minding the beasts' };
      }
      return home ? buildingSpot(home, 'work_milk', 'bucket', 'Seeing to the animals') : null;
    }
    case 'wood': {
      const c = centre(E, sid);
      const a = hash01(personId, 3, 9) * Math.PI * 2;
      const r = (E.settlementById.get(sid)?.radius ?? 100) * 1.4;
      return { kind: 'wood', id: -1, x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r, anim: 'work_axe', mainHand: 'axe', label: 'Gathering wood' };
    }
    case 'spin':
      return home ? buildingSpot(home, 'work_spin', 'distaff', 'Spinning') : null;
    case 'brew': {
      const b = buildingsOf(E, sid, ['alehouse', 'tavern', 'brewhouse'])[0] ?? home;
      return b ? buildingSpot(b, 'work_stir', 'ladle', 'Brewing') : null;
    }
    case 'market': {
      const b = buildingsOf(E, sid, ['market_hall', 'market_stall', 'market_cross', 'warehouse'])[0];
      if (b) return { kind: 'market', id: b.id, x: b.x, z: b.z, anim: 'talk', mainHand: 'none', label: 'Trading' };
      const c = centre(E, sid);
      return { kind: 'market', id: -1, x: c.x, z: c.z, anim: 'talk', mainHand: 'none', label: 'Trading' };
    }
    case 'school': {
      const b = buildingsOf(E, sid, ['school'])[0];
      return b ? buildingSpot(b, 'sit', 'book', 'At lessons') : null;
    }
    case 'craft': case 'service': {
      const kinds = emp?.building !== undefined ? [] : ce.workplace.filter((k) => BUILDINGS[k as keyof typeof BUILDINGS]);
      let b: BuildingState | undefined = emp?.building !== undefined ? state.buildings.get(emp.building) : undefined;
      if (!b) {
        const list = buildingsOf(E, sid, kinds);
        // prefer the workshop that is theirs, else the first
        b = list.find((x) => hh && x.household === hh.id) ?? list[Math.floor(hash01(personId, 1, 4) * Math.max(1, list.length)) % Math.max(1, list.length)];
      }
      if (!b) b = home;
      if (!b) return null;
      const label = emp?.title ?? `${CAREERS[p.career].label}`;
      return buildingSpot(b, ce.anim, ce.held, label);
    }
    default:
      return null;
  }
}

export { ids as JOB_KINDS };
