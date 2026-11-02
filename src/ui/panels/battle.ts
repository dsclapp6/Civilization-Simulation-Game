// The battle command (the red button, bottom right, while the host is before the walls or storming them): a map of the
// place you attack — its walls, towers, gate and keep, your host, and where each company stands to its task — and the
// companies of the assault, each under its captain: set its task (bows on the walls, the ram at the gate, ladders, the
// charge, the reserve), move men between companies, name the captain. What the plan will do is said in one line, and
// before the walls in daylight the storm can be sent in at once.
import { BUILDINGS } from '../../content/types';
import type { MilitaryRuntime, UnitKind } from '../../sim/military/types';
import type { CompanyTask } from '../../sim/military/plan';
import { h } from '../core/dom';
import { icon, type IconName } from '../core/icons';
import { button, chip, empty } from '../components/widgets';
import { createWindow } from '../components/window';
import type { PanelCtx, UiPanel } from '../app/panel';
import { panelOf } from './base';
import { registerPanel } from './extRegistry';

const TASKS: ReadonlyArray<{ id: CompanyTask; label: string; icon: IconName; tip: string }> = [
  { id: 'loose', label: 'Bows on the walls', icon: 'archery', tip: 'Loose at the wall-walk: the defenders keep their heads down' },
  { id: 'ram', label: 'The ram at the gate', icon: 'hammer', tip: 'Batter the gate: twenty or more men, the heavier the better, break it' },
  { id: 'ladders', label: 'Ladders to the walls', icon: 'arrow_up', tip: 'Scale the walls: more men come to grips at once, at a heavy price' },
  { id: 'charge', label: 'Charge the breach', icon: 'swords', tip: 'Go in through the gate when it breaks (costly against a whole one)' },
  { id: 'reserve', label: 'Hold in reserve', icon: 'shield', tip: 'Stand back, ready: fewer in the first press, but steadier' },
];
const KIND_NAME: Record<UnitKind, string> = {
  levy: 'levy', archer: 'archers', crossbow: 'crossbows', man_at_arms: 'men-at-arms', sergeant: 'sergeants', knight: 'knights', mercenary: 'hired swords',
};
const TASK_COLOR: Record<CompanyTask, string> = { loose: '#2f7d32', ram: '#8a4b16', ladders: '#7a5ac8', charge: '#b3261e', reserve: '#55606a' };

export function battlePanel(ctx: PanelCtx): UiPanel {
  const sim = ctx.sim;
  const mil = sim.services.military as MilitaryRuntime | undefined;
  const camp = ctx.game.campaign;
  const win = createWindow({ title: 'Battle command', subtitle: '', icon: 'swords', size: 'xl', tall: true, onClose: () => ctx.close() });
  const base = { id: 'battle', group: 'main' as const, pauses: 'menu' as const, backdropCloses: ctx };
  const army = camp?.army() ?? 0;
  const info = army ? mil?.assaultPlan?.(army) : null;
  if (!mil || !camp || !army || !info) {
    win.body.append(empty('You command no assault just now. Plan an attack from the ruler’s seat (U), Men & arms.', { icon: 'swords' }));
    return panelOf(base, win.el);
  }
  const canvas = h<HTMLCanvasElement>('canvas.mu-battle-map', { width: 460, height: 460 });
  const side = h('div.mu-battle-side');
  win.body.append(h('div.mu-battle', null, h('div', null, canvas, h('div.mu-tiny.mu-dim', null, 'The place you attack: walls, towers, the gate (gold), the keep; your host (blue) and where each company goes.')), side));
  let message = '';

  const act = (r: { ok: boolean; reason?: string }, ok: string): void => {
    message = r.ok ? ok : r.reason ?? 'That cannot be done.';
    ctx.say(r.ok ? 'info' : 'warn', message);
    render();
  };

  const draw = (): void => {
    const plan = mil.assaultPlan!(army);
    const g = canvas.getContext('2d');
    const t = plan ? sim.world.settlements[plan.target] : undefined;
    const A = mil.armyDetail(army);
    if (!g || !plan || !t) return;
    const W = canvas.width, H = canvas.height;
    g.fillStyle = '#e9dfc4'; g.fillRect(0, 0, W, H);
    const cx = t.x, cz = t.z;
    const near = (sim.state.buildingsAt.get(t.id) ?? []).filter((b) => Math.hypot(b.x - cx, b.z - cz) < 150);
    const isWall = (k: string): boolean => k === 'wall' || k === 'tower' || k === 'gatehouse' || k === 'palisade';
    // the outer ring of the walls (or of the place itself when it has none)
    const walls = near.filter((b) => isWall(b.kind));
    const R = Math.max(25, ...(walls.length ? walls : near).map((b) => Math.hypot(b.x - cx, b.z - cz) + BUILDINGS[b.kind].d / 2));
    const scale = (Math.min(W, H) / 2 - 16) / (R + 95); // px per metre: the walls and the field before them fit
    const P = (x: number, z: number): [number, number] => [W / 2 + (x - cx) * scale, H / 2 + (z - cz) * scale];
    for (const b of near) {
      const d = BUILDINGS[b.kind];
      const strong = isWall(b.kind) || b.kind === 'keep_stone';
      g.save();
      const [px, pz] = P(b.x, b.z);
      g.translate(px, pz); g.rotate(-b.rot);
      g.fillStyle = b.kind === 'gatehouse' ? '#c9a227' : strong ? '#5b5047' : '#b8a888';
      g.fillRect((-d.w / 2) * scale, (-d.d / 2) * scale, d.w * scale, d.d * scale);
      g.restore();
    }
    // the host and its companies on the side it came from, outside the walls
    const ax = A?.x ?? cx, az = A?.z ?? cz + 200;
    const dx = ax - cx, dz = az - cz, dd = Math.hypot(dx, dz) || 1;
    const ux = dx / dd, uz = dz / dd;
    const gate = walls.find((b) => b.kind === 'gatehouse');
    // the ram goes at the gate when it faces the host, else at the wall nearest the host
    const gateFaces = gate && ((gate.x - cx) * ux + (gate.z - cz) * uz) > R * 0.4;
    const gx = gateFaces && gate ? gate.x : cx + ux * R, gz = gateFaces && gate ? gate.z : cz + uz * R;
    const ox = (k: number, side: number): [number, number] => [gx + ux * k - uz * side, gz + uz * k + ux * side];
    const spot: Record<CompanyTask, (i: number) => [number, number]> = {
      loose: (i) => ox(45, i * 14 - 18),
      ram: () => ox(5, 0),
      ladders: (i) => ox(10, 32 + i * 14),
      charge: () => ox(24, -6),
      reserve: () => ox(70, 0),
    };
    const seen: Partial<Record<CompanyTask, number>> = {};
    for (const c of plan.plan.companies) {
      const n = Object.values(c.men).reduce((s, v) => s + (v ?? 0), 0);
      const i = seen[c.task] ?? 0; seen[c.task] = i + 1;
      const [wx, wz] = spot[c.task](i);
      const [px, pz] = P(wx, wz);
      g.fillStyle = TASK_COLOR[c.task];
      const r = 6 + Math.sqrt(n) * 1.2;
      g.beginPath(); g.arc(px, pz, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1b1208'; g.font = '12px Georgia, serif'; g.textAlign = 'center';
      g.fillText(`${c.name} (${n})`, px, pz - r - 4);
    }
    // the host's camp mark
    const hd = Math.min(dd, R + 90);
    const [hx, hz] = P(cx + ux * hd, cz + uz * hd);
    g.fillStyle = '#1f4f9a'; g.beginPath(); g.arc(hx, hz, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1b1208'; g.fillText('your host', hx, hz + 18);
  };

  const render = (): void => {
    const plan = mil.assaultPlan!(army);
    const A = mil.armyDetail(army);
    if (!plan || !A) { side.replaceChildren(empty('The host is no more.')); return; }
    const t = sim.world.settlements[plan.target];
    win.setTitle('Battle command', `${A.size} men against ${t?.name ?? 'the enemy'} · about ${plan.defenders} defenders`);
    const roster = mil.roster(army);
    const captains = roster.filter((r) => r.kind === 'knight' || r.kind === 'sergeant').map((r) => r.person);
    if (!captains.includes(A.commander)) captains.unshift(A.commander);
    const main = plan.plan.companies.find((c) => c.task === 'charge') ?? plan.plan.companies[0];
    const phase = camp.phase();
    side.replaceChildren(...[
      h('p.mu-small.mu-ink2', { style: { margin: '0 0 8px' } }, icon('info', 13), ` ${plan.note || 'The plan is set.'}`),
      message ? h('p.mu-small.mu-ital', null, message) : null,
      ...plan.plan.companies.map((c) => {
        const n = Object.values(c.men).reduce((s, v) => s + (v ?? 0), 0);
        const taskSel = h<HTMLSelectElement>('select.mu-input', { 'aria-label': `Task of ${c.name}` },
          TASKS.map((x) => h('option', { value: x.id, selected: x.id === c.task, title: x.tip }, x.label)));
        taskSel.addEventListener('change', () => act(mil.setCompanyTask!(army, c.id, taskSel.value as CompanyTask), `${c.name}: ${TASKS.find((x) => x.id === taskSel.value)?.label.toLowerCase()}.`));
        const capSel = h<HTMLSelectElement>('select.mu-input', { 'aria-label': `Captain of ${c.name}` },
          captains.map((id) => h('option', { value: String(id), selected: id === c.captain }, ctx.nameOf(id))));
        capSel.addEventListener('change', () => act(mil.setCaptain!(army, c.id, Number(capSel.value)), `${ctx.nameOf(Number(capSel.value))} leads ${c.name.toLowerCase()}.`));
        const kinds = (Object.keys(KIND_NAME) as UnitKind[]).filter((k) => (c.men[k] ?? 0) > 0 || (c !== main && (main.men[k] ?? 0) > 0));
        const kindRow = (k: UnitKind): HTMLElement => {
          const less = button('−5', { size: 'small', disabled: (c.men[k] ?? 0) <= 0, tip: `Send five back to ${main.name.toLowerCase()}`,
            onClick: () => act(mil.moveMen!(army, c.id, main.id, k, 5), `Five ${KIND_NAME[k]} go back to ${main.name.toLowerCase()}.`) });
          const more = button('+5', { size: 'small', disabled: (main.men[k] ?? 0) <= 0, tip: `Take five from ${main.name.toLowerCase()}`,
            onClick: () => act(mil.moveMen!(army, main.id, c.id, k, 5), `Five ${KIND_NAME[k]} join ${c.name.toLowerCase()}.`) });
          return h('span.mu-battle-kind', null, `${c.men[k] ?? 0} ${KIND_NAME[k]}`, less, more);
        };
        const menLine = c === main
          ? h('div.mu-tiny.mu-dim', null, Object.entries(c.men).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => `${v} ${KIND_NAME[k as UnitKind]}`).join(', '))
          : h('div.mu-row.mu-wrap.mu-gap-4', null, kinds.map(kindRow));
        return h('div.mu-card', { style: { borderLeft: `4px solid ${TASK_COLOR[c.task]}` } },
          h('div.mu-row.mu-between', null, h('b', null, c.name), chip(`${n} men`, '', 'users')),
          h('div.mu-row.mu-wrap.mu-gap-6', { style: { margin: '6px 0' } }, h('span.mu-small', null, 'Task'), taskSel, h('span.mu-small', null, 'Captain'), capSel),
          menLine);
      }),
      phase === 'before' || phase === 'march'
        ? h('div', { style: { marginTop: '10px' } }, button('Storm now', { variant: 'danger', size: 'big', icon: 'swords', tip: 'Before the walls in daylight: send the storm in at once', onClick: () => { const r = camp.stormNow(); act(r, 'The storm goes in!'); if (r.ok) ctx.close(); } }))
        : phase === 'storm' ? h('p.mu-small.mu-bold', { style: { marginTop: '10px' } }, 'The storm is going in. Changes reach the companies at once.') : null,
    ].filter((x): x is HTMLElement => x !== null));
    draw();
  };
  render();
  ctx.interval(2000, render);
  return panelOf(base, win.el);
}

registerPanel('battle', (ctx) => battlePanel(ctx));
