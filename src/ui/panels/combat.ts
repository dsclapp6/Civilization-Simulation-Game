// The wounds panel (wave 3 combat): what the blows left on a body, drawn in the character sheet's style: a
// figure with each hit location shaded by how bad it is, the blood left, and a list of wounds with their state
// (bleeding, broken, festering, bound) and what will mend them. Open it with
// `{ panel: 'ext', name: 'wounds', id: personId }`. It reads the combat module through `sim.services.combat`.
import { relativeDay } from '../core/format';
import { h, svgEl } from '../core/dom';
import { bar, button, chip } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiHooks, UiPanel } from '../app/panel';
import { every, panelOf } from './base';
import { registerPanel } from './extRegistry';
import type { HitLocation, Wound } from '../../sim/wave3';
import { ageYears, fullName, type Person } from '../../sim/state';
import { skillOf } from '../../sim/skills';

const LOCATION_NAMES: Record<HitLocation, string> = {
  head: 'Head', torso: 'Torso', arm_l: 'Left arm', arm_r: 'Right arm', leg_l: 'Left leg', leg_r: 'Right leg',
};
const KIND_NAMES: Record<string, string> = {
  cut: 'Cut', pierce: 'Stab', blunt: 'Bruise', arrow: 'Arrow wound', burn: 'Burn', bite: 'Bite',
};

/** Rich view of a wound the book keeps (the contract's `Wound` plus the running state). */
interface WoundView extends Wound { id?: number; rate?: number; care?: number; lodged?: boolean; by?: string }

function severityWord(s: number): string {
  return s < 0.12 ? 'Scratch' : s < 0.28 ? 'Light' : s < 0.5 ? 'Deep' : s < 0.75 ? 'Grievous' : 'Mortal';
}

function severityColour(s: number): string {
  if (s <= 0) return 'rgba(125, 100, 68, 0.22)';
  const a = 0.35 + 0.55 * Math.min(1, s * 1.4);
  return s < 0.3 ? `rgba(196, 140, 30, ${a})` : s < 0.55 ? `rgba(200, 90, 24, ${a})` : `rgba(172, 40, 24, ${a})`;
}

const STYLE_ID = 'mu-combat-style';
const CSS = `
.mu-wounds { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 22px; align-items: start; }
.mu-wounds-fig { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.mu-wounds-fig svg { width: 130px; height: 250px; overflow: visible; }
.mu-wounds-fig .part { stroke: var(--ink-2); stroke-width: 1.4; transition: fill 0.4s; }
.mu-wounds-fig .part.hot { stroke: var(--vermilion); stroke-width: 2; }
.mu-wounds-list { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mu-wound { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 10px; padding: 7px 10px; border: 1px solid var(--rule-soft); border-radius: 4px; background: rgba(255, 250, 232, 0.35); }
.mu-wound.bleeding { border-color: var(--vermilion); background: rgba(172, 40, 24, 0.08); }
.mu-wound b { font-size: 15px; }
.mu-wound .mu-wound-tags { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 5px; }
.mu-wounds-blood { display: grid; grid-template-columns: 62px minmax(0, 1fr) 44px; gap: 8px; align-items: center; font-size: 14px; }
.mu-wounds-blood .mu-bar { height: 10px; }
.mu-wounds-note { font-size: 13.5px; color: var(--ink-2); }
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** A schematic figure: one shape per hit location, shaded by the worst wound there. */
function figure(worst: Record<HitLocation, number>): { el: SVGElement; update(w: Record<HitLocation, number>): void } {
  const parts: Record<HitLocation, SVGElement> = {
    head: svgEl('ellipse', { cx: 65, cy: 26, rx: 17, ry: 20, class: 'part' }),
    torso: svgEl('path', { d: 'M42 52 Q65 44 88 52 L84 128 Q65 134 46 128 Z', class: 'part' }),
    arm_l: svgEl('path', { d: 'M40 54 L26 60 L14 116 L26 120 L38 78 Z', class: 'part' }),
    arm_r: svgEl('path', { d: 'M90 54 L104 60 L116 116 L104 120 L92 78 Z', class: 'part' }),
    leg_l: svgEl('path', { d: 'M46 132 L65 134 L62 238 L46 240 L40 190 Z', class: 'part' }),
    leg_r: svgEl('path', { d: 'M84 132 L65 134 L68 238 L84 240 L90 190 Z', class: 'part' }),
  };
  const el = svgEl('svg', { viewBox: '0 0 130 250', 'aria-label': 'Wounds on the body' });
  for (const k of Object.keys(parts) as HitLocation[]) el.appendChild(parts[k]);
  const update = (w: Record<HitLocation, number>): void => {
    for (const k of Object.keys(parts) as HitLocation[]) {
      parts[k].setAttribute('fill', severityColour(w[k]));
      parts[k].classList.toggle('hot', w[k] > 0.3);
    }
  };
  update(worst);
  return { el, update };
}

function tags(w: WoundView): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (w.bleeding) out.push(chip('Bleeding', 'vermilion', 'heart'));
  if (w.fracture) out.push(chip('Broken bone', 'vermilion', 'warning'));
  if (w.infected) out.push(chip('Festering', 'vermilion', 'warning'));
  if (w.lodged) out.push(chip('Arrowhead in', '', 'warning'));
  if ((w.care ?? 0) >= 2) out.push(chip('Skilfully dressed', 'green', 'sparkle'));
  else if ((w.care ?? 0) === 1) out.push(chip('Bound', 'green', 'sparkle'));
  return out;
}

export function woundsPanel(ctx: PanelCtx, req: { id?: number }): UiPanel {
  ensureStyle();
  const id = req.id ?? ctx.playerId();
  const sim = ctx.sim;
  const combat = sim.services.combat;
  const person = (): Person | undefined => sim.state.persons.get(id);
  const win = createWindow({ title: 'Wounds', subtitle: '', icon: 'heart', size: 'lg', onClose: () => ctx.close() });
  const body = h('div.mu-wounds');
  win.body.append(body);
  const fig = figure({ head: 0, torso: 0, arm_l: 0, arm_r: 0, leg_l: 0, leg_r: 0 });
  const bloodBar = bar('vermilion', 1, { thin: true });
  const hpBar = bar('hp', 1, { thin: true });
  const bloodNum = h('span.mu-num.mu-small');
  const hpNum = h('span.mu-num.mu-small');
  const list = h('div.mu-wounds-list');
  const note = h('p.mu-wounds-note');
  const msg = h('p.mu-small.mu-bold.mu-hide');
  let sig = '';
  let bindBtn: HTMLButtonElement | undefined;

  body.append(
    h('div.mu-wounds-fig', null, fig.el, h('div.mu-small.mu-dim.mu-ital', null, 'Each part is shaded by its worst wound')),
    h('div.mu-col.mu-gap-8', null,
      h('div.mu-wounds-blood', null, h('span', null, 'Health'), hpBar.el, hpNum),
      h('div.mu-wounds-blood', null, h('span', null, 'Blood'), bloodBar.el, bloodNum),
      list, note, msg),
  );

  const render = (): void => {
    const p = person();
    if (!p) { list.replaceChildren(h('p.mu-empty', null, 'No one to examine.')); return; }
    const wounds = (combat?.wounds(id) ?? []) as readonly WoundView[];
    const blood = combat?.blood?.(id) ?? 1;
    const maxHp = 1;
    const key = JSON.stringify([wounds.map((w) => [w.location, w.kind, Math.round(w.severity * 100), w.bleeding, w.fracture, w.infected, w.care, w.lodged]), Math.round(blood * 100), Math.round(p.health.hp * 100), p.traits.length]);
    if (key === sig) return;
    sig = key;
    win.setTitle(id === ctx.playerId() ? 'Your wounds' : `${fullName(p)}'s wounds`, `Age ${Math.floor(ageYears(p, sim.absDay))}`);
    const worst: Record<HitLocation, number> = { head: 0, torso: 0, arm_l: 0, arm_r: 0, leg_l: 0, leg_r: 0 };
    for (const w of wounds) worst[w.location] = Math.max(worst[w.location], w.severity);
    fig.update(worst);
    hpBar.set(p.health.hp, maxHp);
    hpNum.textContent = `${Math.round(p.health.hp * 100)}%`;
    bloodBar.set(blood, 1);
    bloodNum.textContent = `${Math.round(blood * 100)}%`;
    const rows = wounds.length
      ? [...wounds].sort((a, b) => b.severity - a.severity).map((w) => h('div.mu-wound', { class: w.bleeding ? 'bleeding' : '' },
        h('div', null, h('b', null, `${LOCATION_NAMES[w.location]}: ${KIND_NAMES[w.kind] ?? w.kind}`), ' ', h('span.mu-dim.mu-small', null, `${severityWord(w.severity)} · ${relativeDay(w.since, sim.absDay)}`)),
        h('span.mu-num.mu-small.mu-dim', null, `${Math.round(w.severity * 100)}%`),
        h('div.mu-wound-tags', null, tags(w))))
      : [h('p.mu-small.mu-good', null, `${id === ctx.playerId() ? 'You are' : 'They are'} unhurt.`)];
    list.replaceChildren(...rows);
    if (bindBtn) bindBtn.disabled = wounds.length === 0;
    const marks: string[] = [];
    if (p.traits.includes('lame')) marks.push('a lasting limp');
    if (p.traits.includes('scarred')) marks.push('scars that will not fade');
    const bleeding = wounds.some((w) => w.bleeding && (w.care ?? 0) === 0);
    const lines: string[] = [];
    if (bleeding) lines.push('Bleeding wounds must be bound or the blood will run out. Pressure and a clean cloth help.');
    if (wounds.some((w) => w.infected)) lines.push('A festering wound needs a healer, rest and food.');
    if (wounds.length > 0) lines.push('Wounds mend over days with rest and food; a healer or the infirmary speeds it and lowers the risk of fever.');
    if (marks.length > 0) lines.push(`Old wounds have left ${marks.join(' and ')}.`);
    note.textContent = lines.join(' ');
  };
  render();

  const foot: Array<HTMLElement | null> = [];
  const mine = id === ctx.playerId();
  const me = sim.state.persons.get(ctx.playerId());
  const skill = me ? skillOf(me, 'medicine') : 0;
  bindBtn = button(mine ? 'Bind your wounds' : 'Bind their wounds', {
    variant: 'primary', icon: 'heart', tip: `Medicine ${skill}: binding stops the bleeding and helps the wounds mend`,
    onClick: () => {
      if (!combat?.tend) { msg.textContent = 'There is no one to tend wounds.'; msg.classList.remove('mu-hide'); return; }
      const r = combat.tend(ctx.playerId(), id);
      msg.textContent = r.message;
      msg.classList.remove('mu-hide');
      msg.classList.toggle('mu-good', r.ok);
      msg.classList.toggle('mu-bad', !r.ok);
      sig = '';
      render();
    },
  });
  foot.push(bindBtn);
  sig = '';
  render();
  foot.push(h('div.mu-grow'));
  foot.push(button('Close', { onClick: () => ctx.close() }));
  win.showFoot(...foot);
  return panelOf({ id: 'wounds', group: 'main', pauses: 'menu', backdropCloses: ctx }, win.el, {
    tick: every(0.5, render),
    key: (intent) => { if (intent.type === 'enter') { bindBtn?.click(); return true; } return false; },
  });
}

registerPanel('wounds', (ctx, req, _hooks: UiHooks) => woundsPanel(ctx, req));
