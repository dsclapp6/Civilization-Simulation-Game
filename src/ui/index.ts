// Placeholder (wave 2 UI replaces this file): a bare menu that can start or continue a run.
import type { CreateUI, GameUI, UiScreen } from './types';

export const createUI: CreateUI = (root, host) => {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#2b2116;font:16px serif;pointer-events:auto';
  root.appendChild(el);
  let screen: UiScreen = 'menu';
  const show = (s: UiScreen, label = ''): void => {
    screen = s;
    el.innerHTML = '';
    el.style.display = s === 'game' ? 'none' : 'flex';
    if (s === 'loading') { el.textContent = label || 'Loading…'; return; }
    if (s !== 'menu') return;
    const start = document.createElement('button');
    start.textContent = 'New run';
    start.onclick = () => { void host.startNewRun({ difficulty: 'knight', statUpgrades: {} }); };
    el.appendChild(start);
    void host.hasSavedRun().then((has) => {
      if (!has || screen !== 'menu') return;
      const cont = document.createElement('button');
      cont.textContent = 'Continue';
      cont.onclick = () => { void host.continueRun(); };
      el.appendChild(cont);
    });
  };
  show('menu');
  const ui: GameUI = {
    update: () => {},
    capturesInput: () => screen !== 'game',
    setScreen: (s, info) => show(s, info?.label),
    open: () => {},
    onEscape: () => false,
    dispose: () => el.remove(),
  };
  return ui;
};
