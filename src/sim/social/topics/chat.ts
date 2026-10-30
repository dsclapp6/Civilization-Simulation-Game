// Small talk (SPEC §18): weather, the harvest, prices, family, the lord, the Church, work, hopes.
// Each topic wins a little goodwill the first few times in a day, more when it is something the
// other cares about (a farmer on the harvest, a pious soul on the Church).
import { CAREERS } from '../../careers';
import type { Person } from '../../state';
import { joinNames } from '../util';
import type { TopicReply } from '../types';
import { chatGain, iSay, isTired, mkOption, npcSays, seen, type TopicCtx, type TopicGroup } from './kit';

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const numberWord = (n: number): string => WORDS[n] ?? String(n);

/** How much the other cares about a subject (multiplies the goodwill of talking of it). */
export function interest(other: Person, topic: string): number {
  const field = CAREERS[other.career]?.field ?? 'none';
  const has = (t: string): boolean => other.traits.includes(t as never);
  switch (topic) {
    case 'weather': return field === 'land' || field === 'husbandry' ? 1.1 : 0.8;
    case 'harvest': return field === 'land' || field === 'husbandry' || other.career === 'miller' ? 1.6 : field === 'trade' || field === 'brewing' ? 1.1 : 0.8;
    case 'prices': return (field === 'trade' || field === 'brewing' || field === 'craft' ? 1.5 : 1) * (has('greedy') ? 1.3 : 1);
    case 'family': return other.children.length > 0 ? 1.5 : other.spouse ? 1.2 : 0.9;
    case 'lord': return has('ambitious') ? 1.3 : 1;
    case 'church': return other.estate === 'clergy' ? 2 : has('pious') ? 1.8 : has('deceitful') ? 0.7 : 1;
    case 'work': return field === 'craft' ? 1.4 : has('ambitious') ? 1.3 : 1;
    case 'hopes': return has('ambitious') ? 1.5 : has('content') ? 0.7 : 1;
    case 'news': return 1.1;
    default: return 1;
  }
}

type Topic = 'weather' | 'harvest' | 'prices' | 'family' | 'lord' | 'church' | 'work' | 'hopes';

const BASE_GAIN: Record<Topic, number> = { weather: 1.0, harvest: 1.3, prices: 1.2, family: 1.6, lord: 1.2, church: 1.3, work: 1.4, hopes: 1.8 };

export const chatGroup: TopicGroup = {
  prefix: 'chat',

  options(t, out) {
    const { session, other, core } = t;
    if (session.page === 'root') {
      out.push(mkOption('nav.chat', 'Pass the time of day…', 'chat', { priority: 8.8 }));
      return;
    }
    if (session.page !== 'chat') return;
    const young = core.age(other) < 5;
    const add = (id: string, label: string, enabled = true, reason?: string): void => {
      out.push(mkOption(`chat.${id}`, label, 'chat', { enabled, reason, priority: 80 - out.length }));
    };
    add('weather', 'Talk of the weather');
    add('harvest', 'Talk of the harvest');
    add('prices', 'Talk of prices');
    if (!young) add('family', `Ask after ${other.first}'s family`);
    if (core.scene(other.settlement).lord && core.scene(other.settlement).lord!.id !== t.actor.id) add('lord', 'Talk of the lord');
    add('church', 'Talk of the Church');
    add('work', other.career === 'child' ? 'Ask what they do all day' : 'Ask about their work');
    add('hopes', 'Ask what they hope for');
  },

  choose(t, option): TopicReply {
    const topic = option.id.slice('chat.'.length) as Topic;
    if (!(topic in BASE_GAIN)) return { lines: [] };
    const lines = iSay(t, `chat.${topic}.ask`);
    if (isTired(t)) return { lines: [...lines, ...npcSays(t, 'chat.tired')], reason: 'chat' };
    if (seen(t, `chat.${topic}`) > 0) return { lines: [...lines, ...npcSays(t, 'chat.repeat')], reason: 'chat' };

    const { core, other } = t;
    const sc = core.scene(other.settlement);
    let pool = `chat.${topic}.reply`;
    switch (topic) {
      case 'harvest': {
        t.npc.tags.add(`stage_${sc.stage}`);
        const pros = core.state.settlements.get(other.settlement)?.prosperity ?? 1;
        t.npc.tags.add(pros < 0.85 ? 'year_lean' : pros > 1.1 ? 'year_plenty' : 'year_fair');
        break;
      }
      case 'prices': {
        const tips = core.hooks.priceTipsHook?.(other.settlement) ?? [];
        if (tips.length > 0) {
          const tip = tips[Math.floor(core.speech.hash01(other.id, 'tips') * tips.length)];
          t.npc.vars.good = tip.good.replace(/_/g, ' ');
          pool = tip.trend > 0.15 ? 'chat.prices.dear' : tip.trend < -0.15 ? 'chat.prices.cheap' : 'chat.prices.steady';
        } else {
          const pros = core.state.settlements.get(other.settlement)?.prosperity ?? 1;
          pool = pros < 0.85 ? 'chat.prices.lean' : pros > 1.1 ? 'chat.prices.plenty' : 'chat.prices.ordinary';
        }
        break;
      }
      case 'family': return familyTalk(t, lines);
      case 'lord': {
        const lord = sc.lord;
        if (!lord) return { lines: [...lines, ...npcSays(t, 'chat.repeat')] };
        if (lord.id === other.id) t.npc.tags.add('lord_self');
        else {
          const op = core.opinion.total(other, lord);
          t.npc.tags.add(op >= 25 ? 'lord_loved' : op >= 8 ? 'lord_liked' : op <= -25 ? 'lord_hated' : op <= -8 ? 'lord_resented' : 'lord_fair');
        }
        if (lord.rep.cruelty >= 15) t.npc.tags.add('lord_cruel');
        if (lord.rep.generosity >= 15) t.npc.tags.add('lord_generous');
        if (lord.settlement !== other.settlement) t.npc.tags.add('lord_away');
        break;
      }
      case 'church': {
        const priest = sc.priest;
        if (priest && priest.id === other.id) { t.npc.tags.add('self_priest'); t.me.tags.add('self_priest'); }
        else if (priest) t.npc.tags.add(core.opinion.total(other, priest) >= 8 ? 'priest_liked' : core.opinion.total(other, priest) <= -8 ? 'priest_disliked' : 'priest_fair');
        else t.npc.tags.add('no_priest');
        if (other.rep.piety >= 15 || other.traits.includes('pious')) t.npc.tags.add('devout');
        break;
      }
      default: break;
    }
    const gain = chatGain(t, BASE_GAIN[topic], interest(other, topic));
    const tone = gain >= 1.8 ? 'pleased' : 'friendly';
    return { lines: [...lines, ...npcSays(t, pool, tone)], opinion: gain, reason: 'chat', mood: gain > 0 ? 0.01 : 0 };
  },
};

function familyTalk(t: TopicCtx, lines: ReturnType<typeof iSay>): TopicReply {
  const { core, other } = t;
  const st = core.state;
  const spouse = other.spouse ? core.living(other.spouse) : undefined;
  const kids: Person[] = [];
  let lost = false;
  for (const id of other.children) {
    const c = st.persons.get(id);
    if (c && !c.death) kids.push(c); else lost = true;
  }
  const tags = t.npc.tags;
  const others = kids.filter((k) => k.id !== t.actor.id).length;
  tags.add(spouse && others > 0 ? 'fam_both' : others > 0 ? 'fam_kids' : spouse ? 'fam_spouse' : 'fam_alone');
  if (lost) tags.add('fam_lost');
  if (other.pregnancy) tags.add('fam_expecting');
  const age = core.age(other);
  if (age < 18) {
    const parents = [other.father, other.mother].map((id) => (id ? core.living(id) : undefined)).filter((p): p is Person => !!p);
    tags.add(parents.length > 0 ? 'fam_young' : 'fam_orphan');
    if (parents.length > 0) t.npc.vars.parents = joinNames(parents.map((p) => p.first));
  }
  const v = t.npc.vars;
  if (spouse) v.spouse = spouse.first;
  // speaking to one of their own children, the rest of the brood are "the others"
  const rest = kids.filter((k) => k.id !== t.actor.id);
  const shown = rest.length > 0 ? rest : kids;
  v.kids = joinNames(shown.slice(0, 4).map((k) => k.first));
  v.nkids = numberWord(shown.length);
  v.kidword = shown.length === 1 ? (shown[0].sex === 'm' ? 'son' : 'daughter') : 'children';
  v.theyword = shown.length === 1 ? 'is' : 'are';
  const gain = chatGain(t, BASE_GAIN.family, interest(other, 'family'));
  return { lines: [...lines, ...npcSays(t, 'chat.family.reply', gain >= 1.8 ? 'warm' : 'friendly')], opinion: gain, reason: 'chat', mood: 0.01 };
}

