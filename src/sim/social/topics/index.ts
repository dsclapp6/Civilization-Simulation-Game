// The built-in topics as one TopicProvider. The conversation is a small menu: the root page offers
// the main kinds of talk (small talk, news, asking about, speaking your mind, favours, gifts,
// courting, family matters, farewell); most open a page of their own with a "Back" entry.
// Other modules' providers (the economy's "Ask for work", "Trade…") appear on the root page.
import type { SocialCore } from '../core';
import type { Conversation, DialogueOption, TopicProvider, TopicReply } from '../types';
import { askGroup } from './ask';
import { chatGroup } from './chat';
import { familyGroup } from './family';
import { favoursGroup, giftsGroup } from './favours';
import { mkOption, npcSays, iSay, type Session, type TopicCtx, type TopicGroup } from './kit';
import { mannersGroup } from './manners';
import { romanceGroup } from './romance';

export const PAGE_LABELS: Record<string, string> = {
  root: '',
  chat: 'Pass the time of day',
  ask: 'Ask about…',
  say: 'Speak your mind',
  favour: 'Ask a favour',
  gift: 'Give a gift',
  court: 'Courting',
  family: 'Family matters',
};

const GROUPS: readonly TopicGroup[] = [chatGroup, askGroup, mannersGroup, favoursGroup, giftsGroup, romanceGroup, familyGroup];
const BY_PREFIX: Record<string, TopicGroup> = {
  chat: chatGroup, ask: askGroup, news: askGroup, say: mannersGroup, favour: favoursGroup, gift: giftsGroup,
  romance: romanceGroup, family: familyGroup,
};

export class BuiltinTopics implements TopicProvider {
  readonly id = 'social';

  constructor(private readonly core: SocialCore, private readonly sessionOf: (conversation: number) => Session | undefined) {}

  context(s: Session): TopicCtx {
    const core = this.core;
    return {
      core, session: s, actor: s.actor, other: s.other,
      op: core.opinion.total(s.other, s.actor),
      npc: core.speech.ctx(s.other, s.actor),
      me: core.speech.ctx(s.actor, s.other),
    };
  }

  options(conv: Readonly<Conversation>, out: DialogueOption[]): void {
    const s = this.sessionOf(conv.id);
    if (!s) return;
    const t = this.context(s);
    if (s.page !== 'root') out.push(mkOption('nav.back', 'Back', 'chat', { priority: -50 }));
    for (const g of GROUPS) g.options(t, out);
    if (s.page === 'root') out.push(mkOption('farewell', 'Farewell', 'leave', { priority: -100 }));
  }

  choose(conv: Readonly<Conversation>, option: DialogueOption): TopicReply {
    const s = this.sessionOf(conv.id);
    if (!s) return { lines: [] };
    if (option.id.startsWith('nav.')) {
      const page = option.id.slice('nav.'.length);
      s.page = page === 'back' ? 'root' : PAGE_LABELS[page] !== undefined ? page : 'root';
      return { lines: [] };
    }
    const t = this.context(s);
    if (option.id === 'farewell') {
      return { lines: [...iSay(t, 'farewell.ask'), ...npcSays(t, 'farewell.reply')], end: true };
    }
    const group = BY_PREFIX[option.id.split('.')[0]];
    if (!group) return { lines: [] };
    return group.choose(t, option);
  }
}
