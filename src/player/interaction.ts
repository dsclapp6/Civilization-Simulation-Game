// What the player is looking at: every ~0.1 s the zone is asked for the interactables in front of the
// body, the best one that has any actions becomes the target, its default action becomes the prompt, and
// the hovered person or animal gets the highlight ring. Option lists are cached per target (providers are
// asked to be cheap, but a scan runs ten times a second).
import type { InteractCandidate, ZoneApi } from '../agents/types';
import { sameTarget, targetKey, type ActionOption, type ActionRegistry, type TargetRef } from '../sim/actions';
import type { PersonId } from '../sim/state';
import type { PlayerHud } from './types';

/** How far in front of the body things can be targeted (m). */
export const TARGET_RANGE = 2.6;
export const SCAN_INTERVAL = 0.1;
const CACHE_SECONDS = 1;
const CANDIDATES_TRIED = 4;

type Prompt = NonNullable<PlayerHud['prompt']>;

export class Interaction {
  /** The current target (a stable object, mutated in place); null when nothing is in reach. */
  target: InteractCandidate | null = null;
  /** All actions on the target, enabled first. */
  options: ActionOption[] = [];
  /** The interact-key action: the best enabled option, or null. */
  defaultOption: ActionOption | null = null;
  /** The HUD prompt; `hasPrompt` says whether it is shown. */
  readonly prompt: Prompt = { label: '', targetLabel: '', enabled: true };
  hasPrompt = false;

  private readonly targetObj: InteractCandidate = { target: { kind: 'self' }, x: 0, z: 0, distance: 0, label: '' };
  private readonly scratch: InteractCandidate[] = [];
  private readonly cache = new Map<string, { at: number; list: ActionOption[] }>();
  private highlighted: { kind: 'person' | 'animal'; id: number } | null = null;
  private clock = 0;

  /** Forget cached option lists (an action finished, something was bought, the world changed). */
  invalidate(): void { this.cache.clear(); }

  /** Re-scans the surroundings. `dt` is the sim time since the last scan (cache aging). */
  scan(actions: ActionRegistry, zone: ZoneApi, actor: PersonId, x: number, z: number, yaw: number, dt: number): void {
    this.clock += dt;
    const found = zone.interactables(x, z, yaw, TARGET_RANGE, this.scratch);
    let chosen: InteractCandidate | null = null;
    let list: ActionOption[] = [];
    const n = Math.min(found.length, CANDIDATES_TRIED);
    for (let i = 0; i < n; i++) {
      const c = found[i];
      if (c.target.kind === 'self') continue;
      const l = this.listFor(actions, actor, c.target);
      if (l.length > 0) { chosen = c; list = l; break; }
    }
    // nothing actionable: still point at the nearest thing so the HUD can name it
    if (!chosen && found.length > 0 && found[0].target.kind !== 'self') chosen = found[0];
    this.apply(chosen, list, zone);
  }

  /** Drops the target (the body died, travel started…). */
  clear(zone: ZoneApi): void { this.apply(null, [], zone); }

  private listFor(actions: ActionRegistry, actor: PersonId, target: TargetRef): ActionOption[] {
    const key = targetKey(target);
    const hit = this.cache.get(key);
    if (hit && this.clock - hit.at < CACHE_SECONDS) return hit.list;
    const list = actions.list(actor, target);
    this.cache.set(key, { at: this.clock, list });
    if (this.cache.size > 24) {
      for (const [k, v] of this.cache) if (this.clock - v.at >= CACHE_SECONDS) this.cache.delete(k);
    }
    return list;
  }

  private apply(chosen: InteractCandidate | null, list: ActionOption[], zone: ZoneApi): void {
    const prevTarget = this.target ? this.target.target : null;
    if (!chosen) {
      this.target = null;
      this.options = [];
      this.defaultOption = null;
      this.hasPrompt = false;
      this.setHighlight(zone, null);
      return;
    }
    const t = this.targetObj;
    if (!sameTarget(prevTarget, chosen.target)) t.target = { ...chosen.target };
    t.x = chosen.x; t.z = chosen.z; t.distance = chosen.distance; t.label = chosen.label;
    this.target = t;
    this.options = list;
    const def = list.find((o) => o.enabled) ?? null;
    this.defaultOption = def;
    const shown = def ?? list[0] ?? null;
    if (shown) {
      this.prompt.label = shown.label;
      this.prompt.targetLabel = chosen.label;
      this.prompt.enabled = shown.enabled;
      this.prompt.reason = shown.enabled ? undefined : shown.reason;
      this.hasPrompt = true;
    } else {
      this.hasPrompt = false;
    }
    this.setHighlight(zone, chosen.target);
  }

  private setHighlight(zone: ZoneApi, target: TargetRef | null): void {
    const want = target && (target.kind === 'person' || target.kind === 'animal') ? { kind: target.kind, id: target.id } : null;
    const cur = this.highlighted;
    if (cur && (!want || cur.kind !== want.kind || cur.id !== want.id)) {
      if (cur.kind === 'person') { const a = zone.agent(cur.id); if (a && a.draw.highlight === 1) a.draw.highlight = 0; }
      else { const a = zone.animals().find((x) => x.id === cur.id); if (a && a.draw.highlight === 1) a.draw.highlight = 0; }
    }
    this.highlighted = want;
    if (!want) return;
    // re-applied on every scan: the zone may reset the ring when it refreshes its draw items
    if (want.kind === 'person') { const a = zone.agent(want.id); if (a && a.draw.highlight < 2) a.draw.highlight = 1; }
    else { const a = zone.animals().find((x) => x.id === want.id); if (a && a.draw.highlight < 2) a.draw.highlight = 1; }
  }
}
