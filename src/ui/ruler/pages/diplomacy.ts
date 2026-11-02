// Diplomacy: the existing politics panel (letters, marriages, truces, alliances, war and peace, claims) — here a summary of where the
// House stands and the doors into it (CIV §6.7).
import type { PoliticsRuntime } from '../../../sim/politics/types';
import { button, chip, empty } from '../../components/widgets';
import { h } from '../../core/dom';
import { politicsRuntime } from '../../panels/politics';
import { STANCE_WORDS, stanceTone, threatWords, sortRivals } from '../rulerModel';
import { line, section, statCard, type RulerEnv } from '../rulerUi';

export function buildDiplomacy(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const v = env.view();
  const pol: PoliticsRuntime | null = politicsRuntime(ctx);
  const wrap = h('div.mu-rul-page.mu-rul-diplomacy');
  if (!pol) return empty('No politics is being played in this run.', { icon: 'quill', title: 'No court to speak of' });
  const house = v.house;
  const view = pol.houseView(house);
  const letters = pol.inbox().filter((l) => l.to === house);
  const wars = pol.warsOf(house);
  const petitions = pol.petitions(me).length;
  const liege = view?.liege ? pol.houseView(view.liege) : null;
  wrap.append(h('div.mu-grid.mu-rul-stats', null,
    statCard('Letters', letters.length, letters.length ? 'wait for an answer' : 'none waiting', letters.length ? 'gold' : '', 'quill'),
    statCard('Wars', wars.length, wars.length ? 'under way' : 'the land is at peace', wars.length ? 'bad' : 'good', 'swords'),
    statCard('Overlord', liege ? `House ${liege.name}` : 'None', liege ? `${liege.headName}` : 'you answer to no one', '', 'crown'),
    statCard('Vassals', view?.vassals ?? 0, 'Houses that swear to you', '', 'shield'),
    statCard('Petitions', petitions, petitions ? 'at your door' : 'none', petitions ? 'gold' : '', 'hand')));
  wrap.append(h('div.mu-row.mu-gap-8.mu-wrap', { style: { margin: '4px 0 14px' } },
    button('Open Realm and politics', { variant: 'primary', icon: 'crown', tip: 'Letters, houses, wars, claims, offices, command (K)', onClick: () => ctx.open({ panel: 'ext', name: 'politics' }) }),
    button('Houses and treaties', { icon: 'shield', onClick: () => ctx.open({ panel: 'ext', name: 'politics', data: { tab: 'houses' } }) }),
    button('Wars and peace', { icon: 'swords', onClick: () => ctx.open({ panel: 'ext', name: 'politics', data: { tab: 'wars' } }) }),
    button('Claims', { icon: 'scroll', onClick: () => ctx.open({ panel: 'ext', name: 'politics', data: { tab: 'claims' } }) })));

  if (letters.length) {
    wrap.append(section(`Letters · ${letters.length}`, 'quill', h('div.mu-list', null, letters.slice(0, 6).map((l) => h('div.mu-li', null, h('div.mu-grow', null, h('b', null, l.text)),
      button('Read and answer', { size: 'small', icon: 'quill', onClick: () => ctx.open({ panel: 'ext', name: 'politics', data: { tab: 'standing' } }) }))))));
  }
  const neighbours = sortRivals(realm.rivals(me)).slice(0, 6);
  wrap.append(section('The Houses near you', 'shield', neighbours.length ? h('div.mu-list', null, neighbours.map((r) => {
    const t = threatWords(r.threat);
    return h('div.mu-li', null, h('div.mu-grow', null, h('b', null, `House ${r.name}`), h('div.mu-small.mu-dim', null, `${r.head ? ctx.nameOf(r.head) : ''}${r.seat !== undefined ? ` · ${ctx.placeName(r.seat)}` : ''}`)),
      chip(STANCE_WORDS[r.stance] ?? r.stance, stanceTone(r.stance)), chip(t.word, t.tone),
      button('Treat with them', { size: 'small', icon: 'hand', onClick: () => ctx.open({ panel: 'ext', name: 'politics', data: { tab: 'houses' } }) }));
  })) : line('No other House lies within reach.')));
  return wrap;
}
