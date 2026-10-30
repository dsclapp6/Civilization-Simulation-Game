// How the player meets politics in the world: an action on himself that opens the realm panel, and
// conversation topics with lords and electors — ask for a post, canvass a vote, treat with a House.
import type { ActionProvider } from '../actions';
import type { Conversation, DialogueLine, DialogueOption, TopicProvider, TopicReply } from '../social/types';
import { fullName, type PersonId } from '../state';
import type { PoliticsCore } from './core';
import { MANAGED, OFFICE_LABEL, type Offices } from './offices';
import type { PoliticsRuntime, ProposalKind } from './types';

const say = (speaker: PersonId, text: string, tone?: DialogueLine['tone']): DialogueLine => (tone ? { speaker, text, tone } : { speaker, text });

export function politicsActions(core: PoliticsCore): ActionProvider {
  return {
    id: 'politics',
    list(_ctx, actor, target, out) {
      if (target.kind !== 'self' || actor !== core.playerId) return;
      out.push({
        id: 'politics.open', provider: '', label: 'Realm, offices and politics', category: 'manage', target, enabled: true, seconds: 0,
        range: 99, priority: 2, preview: 'Houses, wars, claims, elections and what your rank lets you command',
      });
    },
    complete() {
      return { ok: true, ui: { panel: 'ext', name: 'politics' } };
    },
  };
}

const LADDER_LABEL: Partial<Record<ProposalKind, string>> = {
  truce: 'Propose a truce', trade: 'Propose trade between our lands', alliance: 'Propose an alliance', marriage: 'Propose a marriage between our Houses',
};

export function politicsTopics(core: PoliticsCore, api: PoliticsRuntime, offices: Offices): TopicProvider {
  const opt = (id: string, label: string, kind: DialogueOption['kind'], enabled = true, reason?: string, priority = 4, chance?: number): DialogueOption => ({
    id, provider: '', label, kind, enabled, reason, priority, ...(chance !== undefined ? { chance } : {}),
  });
  return {
    id: 'politics',
    options(conv: Readonly<Conversation>, out: DialogueOption[]) {
      if (conv.actor !== core.playerId) return;
      const a = core.living(conv.actor), b = core.living(conv.with);
      if (!a || !b) return;
      // posts the other is patron of
      for (const seat of offices.officeSeats(a.settlement)) {
        if (seat.patron !== b.id || seat.mode !== 'appointed' || seat.holder) continue;
        const r = api.petitionChance(a.id, seat.office, seat.place);
        out.push(opt(`pol.office:${seat.office}:${seat.place}`, `Ask for the post of ${OFFICE_LABEL[seat.office]?.toLowerCase() ?? seat.office}`, 'request', true, undefined, 6, r));
      }
      // canvassing for votes
      for (const cy of core.save.candidacies) {
        if (cy.person !== a.id) continue;
        if (!offices.electors(cy.office as never, cy.place).some((e) => e.id === b.id)) continue;
        const done = cy.promised.includes(b.id);
        out.push(opt(`pol.vote:${cy.office}:${cy.place}`, `Ask for ${b.first}’s vote for ${OFFICE_LABEL[cy.office]?.toLowerCase() ?? cy.office}`, 'persuade', !done, done ? 'They have promised already' : undefined, 6));
      }
      // treating with a great House
      const mine = a.house, theirs = b.house;
      const sameHead = core.headOf(mine)?.id === a.id && core.headOf(theirs)?.id === b.id;
      if (sameHead && mine !== theirs && core.isActor(mine) && core.isActor(theirs)) {
        const step = api.ladderStep(mine, theirs);
        if (step) {
          const chance = Math.round(api.acceptChance(mine, theirs, step) * 100) / 100;
          out.push(opt(`pol.step:${step}`, LADDER_LABEL[step] ?? 'Treat with them', 'favour', true, undefined, 5, chance));
        }
        if (core.strengthOf(theirs) > core.strengthOf(mine) * 1.4 && !core.liegeOf(mine)) {
          out.push(opt('pol.homage', `Offer to swear fealty to House ${core.houseName(theirs)}`, 'favour', true, undefined, 2, api.acceptChance(mine, theirs, 'homage')));
        }
        if (core.strengthOf(mine) > core.strengthOf(theirs) * 1.8 && core.liegeOf(theirs) === 0 && core.primaryTitle(theirs) && core.primaryTitle(mine)) {
          out.push(opt('pol.submit', `Demand that House ${core.houseName(theirs)} kneel`, 'threaten', true, undefined, 1, api.acceptChance(mine, theirs, 'submit')));
        }
      }
    },

    choose(conv, option): TopicReply {
      const a = core.living(conv.actor), b = core.living(conv.with);
      if (!a || !b) return { lines: [] };
      const [kind, p1, p2] = option.id.split(':');
      switch (kind) {
        case 'pol.office': {
          const r = api.petitionOffice(a.id, p1, Number(p2));
          return r.ok
            ? { lines: [say(b.id, `Very well. The post is yours, ${a.first}. Do not shame me.`, 'pleased')], opinion: 3, reason: 'office' }
            : { lines: [say(b.id, r.reason ?? 'I have someone else in mind.', 'wary')] };
        }
        case 'pol.vote': {
          const r = api.campaign(a.id, p1, Number(p2), b.id);
          return r.ok
            ? { lines: [say(b.id, 'You have my vote, and I will speak for you.', 'warm')], opinion: 2 }
            : { lines: [say(b.id, 'I will think on it. I promise nothing.', 'wary')] };
        }
        case 'pol.step': {
          const step = p1 as ProposalKind;
          const r = api.propose(a.house, b.house, step);
          return r.ok
            ? { lines: [say(b.id, step === 'marriage' ? 'A match may be made. Let our families speak.' : 'So be it. Let there be peace between our Houses.', 'pleased')], opinion: 2 }
            : { lines: [say(b.id, r.reason ?? 'No.', 'cold')], opinion: -1 };
        }
        case 'pol.homage': {
          const r = api.propose(a.house, b.house, 'homage');
          return r.ok
            ? { lines: [say(b.id, `Kneel, then, ${fullName(a)}, and be my man.`, 'pleased')] }
            : { lines: [say(b.id, r.reason ?? 'I do not want your oath.', 'cold')] };
        }
        case 'pol.submit': {
          const r = api.propose(a.house, b.house, 'submit');
          return r.ok
            ? { lines: [say(b.id, 'I have no choice. I kneel.', 'sad')], opinion: -10 }
            : { lines: [say(b.id, 'Come and take it, if you can!', 'angry')], opinion: -15, reason: 'demanded homage' };
        }
        default: return { lines: [] };
      }
    },
  };
}

void MANAGED;
