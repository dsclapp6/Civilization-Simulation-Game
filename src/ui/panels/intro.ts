// The first minutes (CLARITY §6): after the birth reveal, a short scene-setting card, then — if you want it — the camera
// turns to show you home, the family's strip and the church, with their names written on them. Then the tutorial
// objective, already tracked, takes over.
import { h } from '../core/dom';
import { icon, type IconName } from '../core/icons';
import { introModel, tourViewpoint, type TourSpot } from '../core/introModel';
import { button } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';

const FLY = 1.7;
const HOLD = 2.5;

export function introPanel(ctx: PanelCtx): UiPanel {
  const m = introModel(ctx.game);
  const win = createWindow({ title: m ? m.title : 'Your life begins', subtitle: 'The first minutes', icon: 'sunrise', size: 'md' });
  win.el.classList.add('mu-intro-win');
  const go = (tour: boolean): void => {
    ctx.close();
    if (tour && m && m.spots.length) ctx.open({ panel: 'tour' });
  };
  if (!m) {
    win.body.append(h('p.mu-prose', null, 'You begin your life.'));
    win.showFoot(h('div.mu-grow'), button('Begin', { variant: 'primary', size: 'big', icon: 'play', onClick: () => go(false) }));
    return panelOf({ id: 'intro', group: 'screen', pauses: 'always', escape: 'ignore', mode: 'screen' }, win.el);
  }
  win.body.append(
    h('div.mu-prose.mu-intro-text', null, m.paragraphs.map((p, i) => h('p', { class: i === 0 ? 'mu-dropcap' : '' }, p))),
    h('div.mu-intro-keys', null,
      h('div.mu-intro-key', null, h('span.mu-key', null, 'W'), h('span.mu-key', null, 'A'), h('span.mu-key', null, 'S'), h('span.mu-key', null, 'D'), h('span', null, 'walk')),
      h('div.mu-intro-key', null, icon('mouse_r', 18), h('span', null, 'hold and drag to look round')),
      h('div.mu-intro-key', null, icon('mouse_l', 18), h('span', null, 'click a thing to go there and act'))),
    h('p.mu-small.mu-dim.mu-ital.mu-intro-note', null, 'Press O for the journal, and Y whenever you do not know what to do.'),
  );
  win.showFoot(
    h('div.mu-grow'),
    button('Straight in', { size: 'big', onClick: () => go(false) }),
    button('Show me round', { variant: 'primary', size: 'big', icon: 'compass', onClick: () => go(true) }));
  return panelOf({ id: 'intro', group: 'screen', pauses: 'always', escape: 'ignore', mode: 'screen' }, win.el, {
    key: (intent) => { if (intent.type === 'enter') { go(true); return true; } return false; },
  });
}

/** The camera tour: home, strip, church. A clear panel (no backdrop) that moves the camera and writes the names on the spots. */
export function tourPanel(ctx: PanelCtx, only?: number): UiPanel {
  const m = introModel(ctx.game);
  const all: TourSpot[] = m ? m.spots : [];
  // a tool may ask for one stop, held for ever, to photograph it
  const spots: TourSpot[] = only !== undefined ? all.slice(only, only + 1) : all;
  const hold = only !== undefined ? Infinity : HOLD;
  const renderer = ctx.host.renderer();
  const world = ctx.sim.world;
  const root = h('div.mu-tour');
  const label = h('div.mu-tour-label');
  const caption = h('div.mu-tour-caption.mu-hide');
  const capName = h('div.mu-tour-cap-name');
  const capText = h('div.mu-tour-cap-text');
  caption.append(capName, capText);
  const skip = button('Skip', { size: 'small', icon: 'cross', onClick: () => finish() });
  skip.classList.add('mu-tour-skip');
  root.append(label, caption, skip);

  let i = -1;
  let phaseAt = 0;
  let started = false;
  let done = false;

  const ico: Record<TourSpot['kind'], IconName> = { home: 'home', strip: 'farming', church: 'church' };
  const finish = (): void => {
    if (done) return;
    done = true;
    renderer?.setCameraMode('follow');
    ctx.close();
  };
  const aim = (s: TourSpot): void => {
    if (!renderer?.setCameraPose) return;
    const b = ctx.player.body();
    // a bigger thing is seen from further off and higher up; the camera avoids standing against or behind a house
    const r = s.kind === 'church' ? 32 : s.kind === 'strip' ? 30 : 20;
    const up = s.kind === 'church' ? 10 : s.kind === 'strip' ? 14 : 8;
    const lookUp = s.kind === 'church' ? 5 : s.kind === 'strip' ? 0.5 : 2.6;
    const at = tourViewpoint(ctx.game, s, b ? { x: b.x, z: b.z } : null, r);
    const gy = world.heightAt(s.x, s.z);
    renderer.setCameraPose({ x: at.x, y: world.heightAt(at.x, at.z) + up, z: at.z }, { x: s.x, y: gy + lookUp, z: s.z }, FLY);
  };
  const next = (now: number): void => {
    i++;
    phaseAt = now;
    if (i >= spots.length) { finish(); return; }
    const s = spots[i];
    aim(s);
    label.classList.remove('on');
    caption.classList.add('mu-hide');
    label.replaceChildren(icon(ico[s.kind], 16), s.label);
    capName.textContent = s.label;
    capText.textContent = s.caption;
  };

  return panelOf({ id: 'tour', group: 'screen', pauses: 'always', captures: true, mode: 'clear', hidesHud: true }, root, {
    key: (intent) => { if (intent.type === 'enter') { finish(); return true; } return false; },
    mount: () => { root.addEventListener('mousedown', () => { if (started && i >= 0) finish(); }); },
    tick: (now) => {
      if (!started) { started = true; next(now); return; }
      if (done || i < 0 || i >= spots.length) return;
      const s = spots[i];
      const t = now - phaseAt;
      // the name appears on the spot once the camera has arrived
      const on = t > FLY * 0.8;
      label.classList.toggle('on', on);
      caption.classList.toggle('mu-hide', !on);
      const scr = renderer?.project(s.x, world.heightAt(s.x, s.z) + 5, s.z);
      if (scr) { const l = ctx.toLocal(scr); label.style.transform = `translate(${Math.round(l.x)}px, ${Math.round(l.y)}px)`; }
      if (t > FLY + hold) next(now);
    },
    dispose: () => { if (!done) renderer?.setCameraMode('follow'); },
  });
}
