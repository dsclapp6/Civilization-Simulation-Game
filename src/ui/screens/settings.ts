// The settings form, shared by the main menu and the pause menu.
import { h } from '../core/dom';
import { button, seg, slider, toggle } from '../components/widgets';
import { DEFAULT_SETTINGS, type QualitySetting, type Settings, type UiHost } from '../types';

export function settingsBody(host: UiHost, onChange: () => void): HTMLElement {
  const root = h('div.mu-col.mu-gap-4.mu-settings');
  const render = (): void => {
    const s = host.settings();
    const set = (change: Partial<Settings>): void => {
      host.setSettings(change);
      if (change.quality) host.renderer()?.setQuality(change.quality);
      onChange();
    };
    const field = (label: string, control: HTMLElement, value?: HTMLElement, hint?: string): HTMLElement =>
      h('div.mu-field', null, h('label', null, label), control, value ?? null, hint ? h('div.mu-tiny.mu-dim.mu-field-hint', null, hint) : null);

    const sens = h('span.mu-val', null, `${s.mouseSensitivity.toFixed(2)}×`);
    const vol = h('span.mu-val', null, `${Math.round(s.volume * 100)}%`);
    const scale = h('span.mu-val', null, `${Math.round(s.uiScale * 100)}%`);

    root.replaceChildren(
      field('Graphics quality', seg<QualitySetting>([
        { id: 'low', label: 'Low', tip: 'Fewer shadows and a shorter view distance' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High', tip: 'Soft shadows and full draw distance' },
      ], s.quality, (q) => set({ quality: q }))),
      field('Mouse sensitivity', slider(0.2, 3, 0.05, s.mouseSensitivity, (v) => { sens.textContent = `${v.toFixed(2)}×`; set({ mouseSensitivity: v }); }), sens),
      field('Invert vertical look', toggle(s.invertY, (v) => set({ invertY: v }), 'Invert vertical look')),
      field('Always use mouse-look', toggle(s.alwaysLook ?? false, (v) => set({ alwaysLook: v }), 'Always use mouse-look'), undefined,
        'Off: a free cursor; point and click to act, hold the right button to turn the camera. On: the old way: the mouse always turns the camera, left strikes, right guards, E acts'),
      field('Sound volume', slider(0, 1, 0.05, s.volume, (v) => { vol.textContent = `${Math.round(v * 100)}%`; set({ volume: v }); }), vol),
      field('Names and labels', toggle(s.labels, (v) => set({ labels: v }), 'Names and labels'), undefined, 'Names over people and place names on the map'),
      field('Minimap', toggle(s.minimap ?? true, (v) => set({ minimap: v }), 'Minimap'), undefined, 'The little chart of the ground around you, in the corner (N shows or hides it)'),
      field('Interface size', slider(0.8, 1.4, 0.05, s.uiScale, (v) => { scale.textContent = `${Math.round(v * 100)}%`; set({ uiScale: v }); }), scale),
      field('Pause in menus', toggle(s.pauseInMenus ?? true, (v) => set({ pauseInMenus: v }), 'Pause in menus'), undefined, 'Time stands still while the character sheet, inventory and similar panels are open'),
      field('Hints for new players', toggle(s.hints ?? true, (v) => set({ hints: v }), 'Hints for new players'), undefined, 'Small notes in the first minutes: what to do and which key does it'),
      h('div.mu-row.mu-end', { style: { marginTop: '10px' } },
        button('Restore defaults', { size: 'small', onClick: () => { host.setSettings({ ...DEFAULT_SETTINGS }); host.renderer()?.setQuality(DEFAULT_SETTINGS.quality); onChange(); render(); } })),
    );
  };
  render();
  return root;
}
