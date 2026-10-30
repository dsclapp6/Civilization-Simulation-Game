// Placeholder (wave 2 SOCIAL replaces this file): a social system that knows nobody.
import type { Simulation } from '../sim';
import type { Conversation, SocialApi } from './types';

export function installSocial(_sim: Simulation): SocialApi {
  const none = { ok: false, reason: 'Not available yet' };
  return {
    start: () => none,
    choose: (): Conversation => { throw new Error('no conversation'); },
    end: () => {},
    current: () => null,
    registerTopic: () => () => {},
    opinion: () => 0,
    adjustOpinion: () => {},
    relations: () => [],
    relationLabel: () => '',
    courtship: () => null,
    propose: () => none,
    arrangeMatch: () => none,
    matchCandidates: () => [],
    bark: () => null,
    news: () => [],
  };
}
