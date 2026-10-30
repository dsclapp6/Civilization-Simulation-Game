// Social (wave 2): conversations, opinions, relationships, courtship and marriage, barks and news.
// `installSocial(sim)` is installed first; the economy (and later politics) add topics through
// `registerTopic` and link themselves in with `setHooks`. See docs/SOCIAL.md.
import type { Simulation } from '../sim';
import { createSocialActions } from './actions';
import { Barks } from './barks';
import { Conversations } from './conversation';
import { SocialCore } from './core';
import { CourtshipEngine } from './courtship';
import { NewsEngine } from './news';
import { OpinionModel } from './opinion';
import { Relations } from './relations';
import { Speech } from './speech';
import { registerSocialSystems } from './systems';
import type { SocialApi } from './types';

export type {
  BarkSituation, Conversation, Courtship, DialogueLine, DialogueOption, OptionKind, PriceTip, RelationKind, RelationView, Result,
  SocialApi, SocialHooks, Tone, TopicProvider, TopicReply,
} from './types';

const installed = new WeakMap<Simulation, { api: SocialApi; core: SocialCore }>();

export function installSocial(sim: Simulation): SocialApi {
  const existing = installed.get(sim);
  if (existing) return existing.api;

  const core = new SocialCore(sim);
  core.speech = new Speech(core);
  core.opinion = new OpinionModel(core);
  core.relations = new Relations(core);
  core.courtship = new CourtshipEngine(core);
  core.barks = new Barks(core);
  core.news = new NewsEngine(core);
  const convs = new Conversations(core);

  sim.actions.register(createSocialActions(core, convs));
  registerSocialSystems(core, convs);

  // a loaded game never resumes in the middle of a conversation
  if (sim.state.clock.actionTime) sim.clock.setActionTime(false);

  const api: SocialApi = {
    start: (actor, other) => convs.start(actor, other),
    choose: (conversation, optionId) => convs.choose(conversation, optionId),
    end: (conversation) => convs.end(conversation),
    current: () => convs.current(),
    registerTopic: (provider) => convs.registerTopic(provider),

    opinion: (of, about) => core.opinion.opinion(of, about),
    adjustOpinion: (of, about, delta, reason) => core.opinion.adjust(of, about, delta, reason),
    relations: (person) => core.relations.list(person),
    relationLabel: (viewer, other) => core.relations.relationLabel(viewer, other),

    courtship: (a, b) => core.courtship.courtship(a, b),
    propose: (a, b) => core.courtship.propose(a, b),
    arrangeMatch: (head, ward, partner) => core.courtship.arrangeMatch(head, ward, partner),
    matchCandidates: (person, limit) => core.courtship.matchCandidates(person, limit),

    bark: (speaker, situation, listener) => core.barks.bark(speaker, situation, listener),
    news: (settlement, limit) => core.news.news(settlement, limit),

    setHooks: (hooks) => { Object.assign(core.hooks, hooks); },
  };
  installed.set(sim, { api, core });
  return api;
}

/** Internals for tests and tools (the dialogue content checker, the demo). Not part of the contract. */
export function socialInternals(sim: Simulation): SocialCore | null {
  return installed.get(sim)?.core ?? null;
}
