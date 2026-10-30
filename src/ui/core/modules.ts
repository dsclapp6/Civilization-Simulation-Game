// Which optional game modules are installed in this run, and the small counts the dock shows on its buttons.
// Everything is defensive: a module may be absent (tests, mock hosts) or half-built.
import type { Simulation } from '../../sim/sim';
import type { PersonId } from '../../sim/state';
import type { DockNeeds } from './requests';

export function hasModule(sim: Simulation, needs: DockNeeds | undefined): boolean {
  if (!needs) return true;
  const services = (sim as unknown as { services?: Record<string, unknown> }).services;
  return !!services && !!services[needs];
}

export interface DockBadge { count: number; tone: 'gold' | 'vermilion' }

type Dyn = Record<string, ((...a: unknown[]) => unknown) | undefined>;
const svc = (sim: Simulation, name: string): Dyn | null => {
  const s = (sim as unknown as { services?: Record<string, unknown> }).services?.[name];
  return s ? (s as Dyn) : null;
};

/** Counts that deserve a dot on the dock: requests waiting, letters and petitions, a levy call, a wound that bleeds. */
export function dockBadges(sim: Simulation, player: PersonId): Map<string, DockBadge> {
  const out = new Map<string, DockBadge>();
  try {
    const hap = svc(sim, 'happenings');
    if (hap?.openRequests) {
      const open = (hap.openRequests() as Array<{ state: string }>).filter((r) => r.state === 'offered').length;
      if (open > 0) out.set('requests', { count: open, tone: 'gold' });
    }
  } catch { /* a module in the middle of a change: no badge */ }
  try {
    const pol = svc(sim, 'politics');
    const me = sim.state.persons.get(player);
    if (pol && me) {
      const letters = (pol.inbox?.() as Array<{ to: number }> | undefined)?.filter((p) => p.to === me.house).length ?? 0;
      const petitions = (pol.petitions?.(player) as unknown[] | undefined)?.length ?? 0;
      if (letters + petitions > 0) out.set('politics', { count: letters + petitions, tone: 'gold' });
    }
  } catch { /* ignore */ }
  try {
    const mil = svc(sim, 'military');
    const call = (mil?.service?.() as { call?: unknown } | undefined)?.call;
    if (call) out.set('army', { count: 1, tone: 'vermilion' });
  } catch { /* ignore */ }
  try {
    const cb = svc(sim, 'combat');
    const wounds = (cb?.wounds?.(player) as Array<{ bleeding: boolean }> | undefined) ?? [];
    const bleeding = wounds.filter((w) => w.bleeding).length;
    if (bleeding > 0) out.set('wounds', { count: bleeding, tone: 'vermilion' });
    else if (wounds.length > 0) out.set('wounds', { count: wounds.length, tone: 'gold' });
  } catch { /* ignore */ }
  return out;
}
