import { it } from 'vitest';
import { appendFileSync } from 'node:fs';
const log = (...a: unknown[]): void => appendFileSync('/tmp/claude-0/-home-user-Civilization-Simulation-Game/0d36ad2b-006d-5c82-be4d-95f65d3a548e/scratchpad/dbg.log', a.join(' ') + '\n');
import { installAgents } from '../../src/agents';
import { interiorSource } from '../../src/app/interior';
import { installEconomy } from '../../src/sim/economy';
import { installSocial } from '../../src/sim/social';
import { installPlayer } from '../../src/player';
import { EMPTY_INPUT } from '../../src/player/types';
import { newSim } from '../sim/helpers';
it('dbg', () => {
  const sim = newSim({ preset: 'small', seed: 'interiors' });
  const social = installSocial(sim); const economy = installEconomy(sim, { social });
  const zone = installAgents(sim, { economy, social }); const player = installPlayer(sim, { zone, economy, social });
  zone.nav.setInteriorSource(interiorSource(sim.world));
  sim.state.clock.absDay = Math.floor(sim.absDay) + 0.45; sim.step(0.05);
  const b = [...sim.state.buildings.values()].find((q) => q.kind === (process.env.K ?? 'church'))!;
  const l = zone.nav.interiors.placed(b)!;
  const d = l.plan.doors[l.plan.main];
  log('door', JSON.stringify(d), 'base', l.y, 'lvl', JSON.stringify(l.plan.levels));
  const w = zone.nav.interiors.toWorld(l, d.x + d.nx * 1.6, d.z + d.nz * 1.6, { x: 0, z: 0 });
  const yaw = Math.atan2(-d.nx, -d.nz) + l.rot;
  player.placeAt(w.x, w.z, yaw); sim.step(0.05);
  for (let t = 0; t < 3; t += 0.05) {
    player.setInput({ ...EMPTY_INPUT, forward: 1, cameraYaw: yaw }); sim.step(0.05);
    const bd = player.body()!; const loc = zone.nav.interiors.toLocal(l, bd.x, bd.z, { x: 0, z: 0 });
    if (Math.round(t * 20) % 5 === 0) log(t.toFixed(2), loc.x.toFixed(2), loc.z.toFixed(2), (bd.y - l.y).toFixed(2), 'ground', (zone.nav.groundY(bd.x, bd.z) - l.y).toFixed(2), 'ang', zone.doors.angle(b.id, l.plan.main).toFixed(2));
  }
});
