// Entry point: picks a mode from the URL (?mode=game|world|gallery|chars).
export interface AppRoot {
  viewport: HTMLElement;
  ui: HTMLElement;
  params: URLSearchParams;
  /** Hide the boot/loading screen. */
  ready(): void;
}

const params = new URLSearchParams(location.search);
const root: AppRoot = {
  viewport: document.getElementById('viewport')!,
  ui: document.getElementById('ui')!,
  params,
  ready: () => document.getElementById('boot')?.classList.add('hidden'),
};

const mode = params.get('mode') ?? 'game';
const boot =
  mode === 'gallery' ? import('./gallery/main') :
  mode === 'chars' ? import('./gallery/characters-main') :
  mode === 'world' ? import('./render/worldViewer') :
  import('./app/game');

boot.then((m) => m.start(root)).catch((err) => {
  console.error(err);
  const el = document.getElementById('boot');
  if (el) el.textContent = `Failed to start: ${String(err)}`;
});
