// Help and controls (pause menu, F1): the keys, the first steps, fighting and the realm, as parchment pages.
import { h } from '../core/dom';
import { BASICS, COMBAT_HELP, CONTROL_GROUPS, REALM_HELP, type HelpSection } from '../core/controls';
import { tabs } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { tabKeys } from '../core/tabkeys';
import { panelOf } from './base';

type Tab = 'controls' | 'basics' | 'combat' | 'realm';
const TABS: ReadonlyArray<{ id: Tab; label: string; icon: 'hand' | 'book' | 'swords' | 'crown' }> = [
  { id: 'controls', label: 'Controls', icon: 'hand' },
  { id: 'basics', label: 'First steps', icon: 'book' },
  { id: 'combat', label: 'Fighting', icon: 'swords' },
  { id: 'realm', label: 'Lords and wars', icon: 'crown' },
];

function sections(list: readonly HelpSection[]): HTMLElement {
  return h('div.mu-help-text', null, list.map((s) => h('section', null, h('h4', null, s.title), s.paragraphs.map((p) => h('p', null, p)))));
}

function controls(): HTMLElement {
  return h('div.mu-help-controls', null, CONTROL_GROUPS.map((g) => h('section.mu-help-group', null,
    h('h4', null, g.title),
    h('dl', null, g.rows.flatMap((r) => [
      h('dt', null, r.keys.map((k) => h('span.mu-key', null, k))),
      h('dd', null, r.what),
    ])))));
}

export function helpPanel(ctx: PanelCtx, start: Tab | undefined): UiPanel {
  const win = createWindow({ title: 'Help', subtitle: 'Controls and how to play', icon: 'help', size: 'xl', tall: true, onClose: () => ctx.close() });
  let tab: Tab = start ?? 'controls';
  const content = h('div.mu-scroll.mu-help', { style: { padding: '14px 20px 30px', maxHeight: '100%' } });
  const t = tabs(TABS, tab, (id) => select(id as Tab));
  win.body.classList.add('flush');
  win.body.append(t.el, h('div.mu-tabbar-rule'), content);
  const select = (id: Tab): void => {
    tab = id;
    t.set(id);
    content.scrollTop = 0;
    content.replaceChildren(id === 'controls' ? controls() : id === 'basics' ? sections(BASICS) : id === 'combat' ? sections(COMBAT_HELP) : sections(REALM_HELP));
  };
  select(tab);
  win.showFoot(h('span.mu-small.mu-dim', null, 'F1 opens this page at any time.'), h('div.mu-grow'),
    h('button.mu-btn.primary', { type: 'button', onclick: () => ctx.close() }, 'Close'));
  return panelOf({ id: 'help', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, {
    key: tabKeys(TABS.map((x) => x.id), () => tab, (id) => select(id as Tab), { scroller: content }),
  });
}
