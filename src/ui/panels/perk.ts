// Perk choice: two cards, pick one. Opens from a level-up toast, the HUD badge or the skill dots.
import type { SkillId } from '../../core/domain';
import type { PerkChoice, PerkDef } from '../../sim/economy/types';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { SKILL_ICON } from '../core/iconMap';
import { SKILL_NAMES } from '../core/text';
import { button, chip } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import type { PersonId } from '../../sim/state';
import { panelOf } from './base';

export function perkPanel(ctx: PanelCtx, person: PersonId, skill: SkillId): UiPanel {
  const win = createWindow({ title: 'Choose a perk', subtitle: SKILL_NAMES[skill], icon: 'star_f', size: 'md', onClose: () => ctx.close() });
  const body = win.body;
  let choice: PerkChoice | undefined;
  let picked: PerkDef | null = null;
  const confirm = button('Choose a perk', { variant: 'primary', size: 'big', icon: 'check', disabled: true });

  const load = (): void => {
    choice = ctx.eco.perkChoices(person).find((c) => c.skill === skill);
    picked = null;
    render();
  };

  const select = (p: PerkDef): void => {
    picked = p;
    confirm.disabled = false;
    confirm.replaceChildren(icon('check', 20), h('span', null, `Take ${p.name}`));
    render();
  };

  function render(): void {
    if (!choice) {
      body.replaceChildren(h('p.mu-empty', null, 'No perk is waiting in this skill.'));
      win.showFoot(h('div.mu-grow'), button('Close', { onClick: () => ctx.close() }));
      return;
    }
    win.setTitle('Choose a perk', `${SKILL_NAMES[skill]} · level ${choice.level}`);
    const cards = choice.options.map((p, i) => {
      const sel = picked?.id === p.id;
      const card = h('div.mu-card.click.mu-perk', { class: sel ? 'sel' : '', role: 'radio', 'aria-checked': String(sel), tabindex: '0' },
        h('div.mu-perk-ico', null, icon(SKILL_ICON[skill], 30)),
        h('div.mu-tiny.mu-dim', null, `${i + 1} · level ${p.level} perk`),
        h('h4', null, p.name),
        h('p.mu-perk-text', null, p.description),
        sel ? h('span.mu-tier-check', null, icon('check', 16)) : null);
      card.addEventListener('click', () => select(p));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p); } });
      return card;
    });
    body.replaceChildren(
      h('p.mu-small.mu-ink2', { style: { marginBottom: '12px' } }, 'You may take one now. The choice is for life: the other perk is lost to you.'),
      h('div.mu-grid.c2', null, cards),
    );
    win.showFoot(h('span.mu-dim.mu-small.mu-ital', null, chip('Skill', '', SKILL_ICON[skill]), ` ${SKILL_NAMES[skill]}`), h('div.mu-grow'), button('Later', { onClick: () => ctx.close() }), confirm);
  }

  confirm.addEventListener('click', () => {
    if (!picked) return;
    const r = ctx.eco.choosePerk(person, picked.id);
    if (!r.ok) { ctx.say('warn', r.reason ?? 'That perk cannot be taken.'); return; }
    ctx.toast({ tone: 'gold', icon: 'star_f', title: picked.name, text: `${SKILL_NAMES[skill]} perk chosen.`, ttl: 4, key: `perktaken:${skill}` });
    // another perk waiting in the same skill? continue; otherwise close
    const more = ctx.eco.perkChoices(person).find((c) => c.skill === skill);
    if (more) load(); else ctx.close();
  });

  load();
  return panelOf({ id: 'perk', group: 'overlay', pauses: 'menu', backdropCloses: ctx }, win.el, {
    key: (intent) => {
      if (intent.type === 'digit' && choice?.options[intent.n - 1]) { select(choice.options[intent.n - 1]); return true; }
      if (intent.type === 'enter' && picked) { confirm.click(); return true; }
      return false;
    },
  });
}
