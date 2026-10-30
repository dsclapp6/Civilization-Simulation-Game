// Dialogue topics the economy adds to the social system (src/sim/social): asking for work and
// wages, asking to be apprenticed, offering work, the dues of the manor, and opening a trade.
import type { Person, PersonId } from '../state';
import { CAREERS } from '../careers';
import type { Conversation, DialogueLine, DialogueOption, TopicProvider, TopicReply } from '../social/types';
import type { Econ } from './core';
import { careerEcon, pd } from './data';
import { applyForJob, jobId, jobsAt, JOB_KINDS } from './jobs';
import { hire, dismiss, standardWage } from './holdings';
import { manumissionPrice, obligationsOf } from './obligations';
import { ageYears } from '../state';

function say(speaker: PersonId, text: string, tone?: DialogueLine['tone']): DialogueLine { return tone ? { speaker, text, tone } : { speaker, text }; }

function isMaster(p: Person): boolean { return CAREERS[p.career].field === 'craft' && p.careerStage >= 2; }
function isHiringOfficer(E: Econ, p: Person): boolean {
  return p.offices.some((o) => o.office === 'reeve' || o.office === 'lord' || o.office === 'bailiff' || o.office === 'steward')
    || p.career === 'bailiff' || p.career === 'steward' || !!E.lordOf(p.settlement) && E.lordOf(p.settlement)?.person.id === p.id;
}

export function economyTopics(E: Econ): TopicProvider {
  const opt = (id: string, label: string, kind: DialogueOption['kind'], enabled = true, reason?: string, priority = 5): DialogueOption => ({
    id, provider: '', label, kind, enabled, reason, priority,
  });
  const self = (conv: Readonly<Conversation>): Person | undefined => E.person(conv.actor);
  const other = (conv: Readonly<Conversation>): Person | undefined => E.person(conv.with);

  return {
    id: 'economy',
    options(conv, out) {
      const a = self(conv), b = other(conv);
      if (!a || !b || b.death) return;
      const age = ageYears(a, E.day);
      const ce = careerEcon(b.career);
      // work
      if (isHiringOfficer(E, b) || b.career === 'steward' || isMaster(b) || b.career === 'alewife' || b.career === 'merchant') {
        const jobs = jobsAt(E, b.settlement, a.id).filter((j) => j.employer === b.id || (j.employer === 0));
        out.push(opt('econ.work', 'Ask for work', 'work', true, undefined, 8));
        void jobs;
      }
      out.push(opt('econ.wages', 'Ask about wages and prices', 'ask', true, undefined, 3));
      if (isMaster(b)) {
        const ok = age >= 12 && age <= 18;
        out.push(opt('econ.apprentice', 'Ask to be apprenticed', 'work', ok, ok ? undefined : 'Apprentices are taken between twelve and eighteen', 9));
      }
      if ((ce.sells?.length ?? 0) + (ce.buys?.length ?? 0) > 0) out.push(opt('econ.trade', 'Trade…', 'trade', true, undefined, 7));
      // hiring
      const hh = E.hhOf(a);
      if (hh && hh.head === a.id && b.household !== hh.id && ageYears(b, E.day) >= 14 && !b.flags.player) {
        const hired = E.save.helpers.some((h) => h.w === b.id && h.e === a.id);
        if (hired) out.push(opt('econ.dismiss', `Let ${b.first} go`, 'manage', true, undefined, 2));
        else if (['labourer', 'cottar', 'farmer', 'woodward', 'shepherd', 'swineherd', 'servant', 'none'].includes(b.career) && !E.isHired(b.id)) {
          out.push(opt('econ.hire', `Offer ${b.first} work at ${pd(standardWage(E, b))} a day`, 'work', true, undefined, 6));
        }
      }
      // the manor
      if (b.offices.some((o) => o.office === 'reeve' || o.office === 'lord') || b.career === 'bailiff' || b.career === 'steward') {
        out.push(opt('econ.dues', 'Ask what you owe', 'ask', true, undefined, 4));
        if (a.estate === 'unfree') {
          const hh2 = E.hhOf(a);
          const price = manumissionPrice(E, a);
          const ok = !!hh2 && hh2.head === a.id && E.canAfford(a, price);
          out.push(opt('econ.freedom', `Ask to buy your freedom (${pd(price)})`, 'request', ok, !hh2 || hh2.head !== a.id ? 'Only the head of the household may ask' : ok ? undefined : `Freedom costs ${pd(price)}`, 3));
        }
      }
    },

    choose(conv, option): TopicReply {
      const a = self(conv) as Person, b = other(conv) as Person;
      const bid = b.id;
      switch (option.id) {
        case 'econ.work': {
          const jobs = jobsAt(E, b.settlement, a.id).filter((j) => j.employer === b.id || j.employer === 0 || E.person(j.employer)?.household === b.household);
          if (jobs.length === 0) return { lines: [say(bid, 'I have nothing for you just now. Try the reeve at the manor, or ask the masters in town.', 'neutral')] };
          const best = jobs.find((j) => j.requirements.every((r) => r.met)) ?? jobs[0];
          const lacking = best.requirements.find((r) => !r.met);
          const lines = [say(bid, lacking ? `I could use a ${best.title.toLowerCase()}, but ${lacking.label.toLowerCase()} is wanting.` : `I need a ${best.title.toLowerCase()}. ${best.wage > 0 ? `${pd(best.wage)} a day` : 'Board and lodging'}${best.premium ? `, and a premium of ${pd(best.premium)}` : ''}.`, lacking ? 'wary' : 'friendly')];
          return { lines, ui: { panel: 'jobs', settlement: b.settlement } };
        }
        case 'econ.wages': {
          const lines = [
            say(bid, `A farmhand earns 2d a day here, a boy half that. A journeyman might have 3d, a master 5d or more. Ale is ${pd(Math.round(E.dayOfYear * 0 + 1.2 * 10) / 10)} a gallon, and a good sickle a few days' wages.`, 'neutral'),
          ];
          return { lines };
        }
        case 'econ.apprentice': {
          const kind = JOB_KINDS.apprentice;
          const id = jobId(bid, b.settlement, kind);
          const r = applyForJob(E, a.id, id);
          if (r.ok) return { lines: [say(bid, `Very well. You will live under my roof and learn the ${CAREERS[b.career].label.toLowerCase()}'s trade for seven years. Work hard.`, 'pleased')], opinion: 3 };
          return { lines: [say(bid, r.reason ?? 'I cannot take you on.', 'wary')] };
        }
        case 'econ.trade':
          return { lines: [say(bid, 'Let us see what we can do.', 'friendly')], ui: { panel: 'trade', partner: { kind: 'person', id: bid } } };
        case 'econ.hire': {
          const wage = standardWage(E, b);
          const r = hire(E, a.id, bid, wage, 'auto');
          return r.ok ? { lines: [say(bid, `Done. I will work for you at ${pd(wage)} a day, so long as you pay.`, 'pleased')], opinion: 2 } : { lines: [say(bid, r.reason ?? 'No.', 'wary')] };
        }
        case 'econ.dismiss': {
          const r = dismiss(E, a.id, bid);
          return { lines: [say(bid, r.ok ? 'As you wish.' : (r.reason ?? 'Hm.'), 'sad')], opinion: -1 };
        }
        case 'econ.dues': {
          const obs = obligationsOf(E, a.id);
          const text = obs.length === 0 ? 'You owe nothing that I know of.' : obs.slice(0, 5).map((o) => o.label).join('. ') + '.';
          return { lines: [say(bid, text, 'neutral')] };
        }
        case 'econ.freedom': {
          const price = manumissionPrice(E, a);
          return { lines: [say(bid, `The lord will sell you and yours your freedom for ${pd(price)}. Say the word and it is done.`, 'neutral')], ui: { panel: 'message', title: 'Freedom', text: `Buying your freedom costs ${pd(price)}. Use "Buy your freedom" on yourself to pay.` } };
        }
      }
      return { lines: [] };
    },
  };
}
