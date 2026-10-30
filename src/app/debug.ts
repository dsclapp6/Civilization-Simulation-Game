// Developer overlay (`?debug=1`): frame timings, renderer and sim statistics, and a plain-text stand-in for
// the HUD (prompt, action bar, journey, road encounters, death chooser) so the game can be played and
// checked while the real UI is not in the build. Not part of normal play.
import type { GameRenderer } from '../render/types';
import type { PersonId } from '../sim/state';
import { fullName } from '../sim/state';
import { formatMoney } from '../sim/money';
import type { GameServices } from '../ui/types';

export interface FrameTimings {
  fps: number;
  frame: number;
  input: number;
  sim: number;
  player: number;
  render: number;
  ui: number;
  /** Worst frame of the last second. */
  worst: number;
}

export function emptyTimings(): FrameTimings {
  return { fps: 60, frame: 16, input: 0, sim: 0, player: 0, render: 0, ui: 0, worst: 0 };
}

interface Line { text: string; at: number; kind: string }

export class DebugOverlay {
  private readonly el: HTMLPreElement;
  private readonly hud: HTMLDivElement;
  private readonly choices: HTMLDivElement;
  private readonly feed: Line[] = [];
  private clock = 0;
  private acc = 1;
  private choiceKey = '';
  private offs: Array<() => void> = [];
  private bound: GameServices | null = null;

  constructor(parent: HTMLElement, private readonly show: { timings: boolean; hud: boolean }) {
    this.el = document.createElement('pre');
    this.el.style.cssText = 'position:fixed;left:6px;top:6px;margin:0;padding:6px 8px;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#e8f0d0;background:rgba(10,14,8,.62);border-radius:4px;pointer-events:none;z-index:50;white-space:pre';
    this.hud = document.createElement('div');
    this.hud.style.cssText = 'position:fixed;right:12px;bottom:12px;width:380px;padding:8px 12px;font:14px/1.4 Georgia,serif;color:#2b2116;background:rgba(240,228,200,.9);border:1px solid #6b5a3a;border-radius:6px;pointer-events:none;z-index:50;text-align:center';
    this.choices = document.createElement('div');
    this.choices.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px;pointer-events:auto';
    this.hud.appendChild(this.choices);
    if (show.timings) parent.append(this.el);
    if (show.hud) parent.append(this.hud);
    this.hud.style.display = 'none';
  }

  bind(game: GameServices | null): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.bound = game;
    this.feed.length = 0;
    if (!game || !this.show.hud) return;
    this.offs.push(
      game.sim.events.on('notify', (n) => this.push(n.text, n.kind)),
      game.sim.events.on('ui', (u) => this.push(`UI request: ${JSON.stringify(u).slice(0, 120)}`, 'ui')),
      game.sim.events.on('travel', (t) => this.push(`travel ${t.phase}${t.encounter ? ': ' + t.encounter : ''}`, 'travel')),
      game.sim.events.on('gameOver', (g) => this.push(`GAME OVER (${g.reason}) score ${g.score}`, 'danger')),
    );
  }

  private push(text: string, kind: string): void {
    this.feed.push({ text, at: this.clock, kind });
    if (this.feed.length > 6) this.feed.shift();
  }

  update(dt: number, t: FrameTimings, renderer: GameRenderer | null): void {
    this.clock += dt;
    this.acc += dt;
    if (this.acc < 0.2) return;
    this.acc = 0;
    const g = this.bound;
    const lines: string[] = [];
    lines.push(`${t.fps.toFixed(0)} fps  frame ${t.frame.toFixed(1)} ms (worst ${t.worst.toFixed(1)})`);
    lines.push(`input ${t.input.toFixed(2)} · sim ${t.sim.toFixed(2)} · player ${t.player.toFixed(2)} · render ${t.render.toFixed(2)} · ui ${t.ui.toFixed(2)}`);
    if (renderer) {
      const s = renderer.stats();
      lines.push(`${s.drawCalls} draws · ${(s.triangles / 1000).toFixed(0)}k tris · terrain ${s.chunks}/${s.chunksCached} (+${s.chunksPending}) · veg ${s.vegetationInstances} · ${s.cameraMode} · ${s.quality}`);
    }
    if (g) {
      const c = g.sim.view.clock();
      const hostile = g.sim.hostileNear() ? ' · HOSTILE NEAR' : '';
      lines.push(`day ${c.absDay.toFixed(2)} y${c.year} s${c.season} ${Math.floor(c.dayFraction * 24)}h · ${c.paused ? 'PAUSED' : c.speed + '×'}${c.skipping ? ' · skipping ' + c.skipping : ''}${hostile}`);
      const b = g.player.body();
      const h = g.player.hud();
      if (b) lines.push(`you ${b.x.toFixed(1)}, ${b.z.toFixed(1)}  y ${b.y.toFixed(1)}  ${h ? `${h.gait ?? ''} ${h.speed?.toFixed(1) ?? ''} m/s` : ''}`);
      lines.push(`agents ${g.zone.agents().length} · animals ${g.zone.animals().length} · mode ${g.sim.view.mode()} · profiling ${g.sim.scheduler.profiling ? 'on' : 'off'}`);
      if (g.sim.scheduler.profiling) {
        const rows = [...g.sim.scheduler.profile.entries()].sort((a, b2) => b2[1].totalMs - a[1].totalMs).slice(0, 4);
        lines.push(rows.map(([n, p]) => `${n} ${(p.totalMs / Math.max(1, p.calls)).toFixed(3)}/${p.maxMs.toFixed(2)}`).join(' · '));
      }
    }
    this.el.textContent = lines.join('\n');
    if (this.show.hud) this.updateHud();
  }

  private updateHud(): void {
    const g = this.bound;
    if (!g) { this.hud.style.display = 'none'; return; }
    const sim = g.sim;
    const run = sim.state.run;
    this.hud.style.display = '';
    const parts: string[] = [];
    let key = '';
    if (run.phase === 'choosing') {
      parts.push('<b>You have died.</b> Choose who carries on:');
      key = 'death:' + (run.pendingSuccession?.eligible.join(',') ?? '');
    } else if (run.phase === 'over') {
      parts.push('<b>Game over.</b> Your House is ended.');
      key = 'over';
    } else {
      const h = g.player.hud();
      if (h) {
        const trav = h.travel;
        if (h.prompt) {
          const p = h.prompt;
          parts.push(p.enabled ? `<b>E</b> &nbsp;${esc(p.label)} · ${esc(p.targetLabel)}` : `<span style="color:#8a2a1a">${esc(p.label)} · ${esc(p.targetLabel)} — ${esc(p.reason ?? 'not now')}</span>`);
        }
        if (h.action) parts.push(`${esc(h.action.label)} ${bar(h.action.progress)} ${Math.round(h.action.progress * 100)}%`);
        parts.push(`<small>HP ${h.hp}/${h.maxHp} · stamina ${h.stamina}/${h.maxStamina}${h.exhausted ? ' (winded)' : ''} · ${formatMoney(h.money)} · ${esc(h.name)}, ${h.age}${h.mounted ? ' · mounted' : ''}${h.following ? ' · following ' + esc(h.following) : ''}</small>`);
        if (trav) {
          const dest = sim.world.settlements.find((s) => s.id === trav.to)?.name ?? '?';
          if (trav.phase === 'encounter' && trav.encounter) {
            parts.push(`<b style="color:#8a2a1a">${esc(trav.encounter.label)}</b><br><small>${esc(trav.encounter.text ?? '')}</small>`);
            key = 'enc:' + trav.encounter.label + ':' + (trav.encounter.choices?.map((c) => c.id).join(',') ?? '');
          } else parts.push(`Journey to ${esc(dest)}: ${Math.round(trav.progress * 100)}% · ${trav.daysLeft.toFixed(1)} days left${trav.phase === 'arrived' ? ' — arrived' : ''}`);
        }
      }
    }
    const feed = this.feed.filter((l) => this.clock - l.at < 8).slice(-4).map((l) => `<div style="font-size:12px;color:${l.kind === 'danger' || l.kind === 'warn' ? '#8a2a1a' : l.kind === 'gain' ? '#2a5a1a' : '#4a3d2a'}">${esc(l.text)}</div>`);
    const body = document.createElement('div');
    body.innerHTML = parts.map((p) => `<div>${p}</div>`).join('') + feed.join('');
    this.hud.replaceChildren(body, this.choices);
    if (key !== this.choiceKey) {
      this.choiceKey = key;
      this.choices.replaceChildren();
      if (run.phase === 'choosing' && run.pendingSuccession) {
        for (const id of run.pendingSuccession.eligible.slice(0, 6)) this.choices.append(this.button(this.personLabel(id), () => { sim.dispatch({ type: 'switchCharacter', personId: id }); }));
      } else if (key.startsWith('enc:')) {
        for (const o of g.player.options()) {
          const b = this.button(`${o.label}${o.preview ? ' (' + o.preview + ')' : ''}`, () => { g.player.perform(o); });
          if (!o.enabled) { b.disabled = true; b.title = o.reason ?? ''; }
          this.choices.append(b);
        }
      }
    }
  }

  private personLabel(id: PersonId): string {
    const p = this.bound?.sim.state.persons.get(id);
    return p ? `Play as ${fullName(p)}` : `Play as #${id}`;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:13px Georgia,serif;padding:4px 10px;border:1px solid #6b5a3a;background:#f5ecd4;color:#2b2116;border-radius:4px;cursor:pointer';
    b.onclick = onClick;
    return b;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.el.remove();
    this.hud.remove();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

function bar(p: number): string {
  const n = 14;
  const f = Math.round(Math.max(0, Math.min(1, p)) * n);
  return '█'.repeat(f) + '░'.repeat(n - f);
}
