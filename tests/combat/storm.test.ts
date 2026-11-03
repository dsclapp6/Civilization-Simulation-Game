// Walls defended, assaults (docs/CIV.md §9, docs/WAR.md): archers on the wall stations, a ram at the gate, ladders, breaches.
import { describe, expect, it } from 'vitest';
import { R, S } from '../../src/combat/fighter';
import { SIM_DT } from '../../src/core/time';
import type { FightResult } from '../../src/sim/wave3';
import { stepFor } from './helpers';
import { storm } from './stormHelpers';

describe('a walled place stormed: set-up', () => {
  it('the defending archers stand on the wall stations at the height of the walk; the rest hold the gate from inside', () => {
    const t = storm('st-setup', { archers: 4, foot: 18 }, { archers: 6, foot: 8 });
    const arena = t.r.combat.arena;
    const fight = arena.fights.get(t.id)!;
    expect(fight.scene).toBeTruthy();
    const scene = fight.scene!;
    expect(scene.stations.length).toBeGreaterThanOrEqual(10);
    const defs = t.defenders.map((id) => arena.fighterOf(id)!);
    const archers = defs.filter((f) => f.gear.ranged && f.preferRanged);
    expect(archers).toHaveLength(6);
    for (const f of archers) {
      expect(f.station).toBeTruthy();
      expect(f.onWall).toBe(true);
      expect(f.role).toBe(R.Wall);
      // on the walk: well above the ground (the fake zone is flat at 10 m)
      expect(f.y).toBeGreaterThan(10 + 2.5);
      expect(f.station!.holder).toBe(f);
    }
    // the others are inside the walls near the gate, on the ground
    const foot = defs.filter((f) => !archers.includes(f));
    for (const f of foot) {
      expect(f.onWall).toBe(false);
      expect(Math.abs(f.x - t.fort.cx)).toBeLessThan(t.fort.half);
      expect(f.z).toBeLessThan(t.fort.cz + t.fort.half);
      expect(f.z).toBeGreaterThan(t.fort.cz);
    }
    // the attackers are outside the walls, south of the gate
    for (const id of t.attackers) {
      const f = arena.fighterOf(id)!;
      expect(f.z).toBeGreaterThan(t.fort.cz + t.fort.half + 20);
    }
    // the works
    const kinds = scene.works.map((w) => w.kind).sort();
    expect(kinds).toEqual(['ladder', 'ladder', 'ladder', 'ram']);
    expect(scene.status().gate).toBe('shut');
    expect(scene.status().stationed).toBe(6);
    // the siege works reach the renderer's source
    const works = t.r.sim.view.siegeWorks!();
    expect(works.map((w) => w.kind).sort()).toEqual(['ladder', 'ladder', 'ladder', 'ram']);
    for (const w of works) expect(Number.isFinite(w.x + w.y + w.z + w.yaw)).toBe(true);
  });

  it('a garrison without archers still has bows in its armoury: its lowest men shoot from the wall, the better armed hold the gate', () => {
    const t = storm('st-armoury', { archers: 0, foot: 24 }, { archers: 0, foot: 15 });
    const arena = t.r.combat.arena;
    const scene = arena.fights.get(t.id)!.scene!;
    const defs = t.defenders.map((id) => arena.fighterOf(id)!);
    const bows = defs.filter((f) => f.gear.ranged && f.preferRanged);
    expect(bows).toHaveLength(6); // two in five of the garrison
    for (const f of bows) {
      expect(f.onWall).toBe(true);
      expect(f.station).toBeTruthy();
      expect(f.gear.ammo).toBeGreaterThan(0);
      expect(f.shotsLeft).toBeGreaterThan(0);
      expect(f.gear.shield).toBeNull();
    }
    expect(scene.status().stationed).toBe(6);
    // nobody on the attackers' side is armed from the defenders' armoury
    for (const id of t.attackers) expect(arena.fighterOf(id)!.gear.ranged).toBeNull();
    // and the walls shoot: the bowmen loose at the host that comes to the gate
    let loosed = false;
    for (let i = 0; i < 20 * 60 && !loosed; i++) { t.r.sim.step(SIM_DT); loosed = arena.env.proj.flying.length > 0; }
    expect(loosed).toBe(true);
  });

  it('the ram has a crew, the ladders have squads; the rest of the line is the commander\'s', () => {
    const t = storm('st-roles', { archers: 4, foot: 24 }, { archers: 4, foot: 6 });
    const arena = t.r.combat.arena;
    const scene = arena.fights.get(t.id)!.scene!;
    const ram = scene.works.find((w) => w.kind === 'ram')!;
    expect(ram.crew.length).toBe(6);
    for (const m of ram.crew) expect(m.role).toBe(R.Ram);
    for (const l of scene.works.filter((w) => w.kind === 'ladder')) {
      expect(l.crew.length).toBe(5);
      expect(l.phase).toBe('carry');
      expect(l.station).toBeTruthy();
    }
    // archers have no job in the works
    for (const id of t.attackers) {
      const f = arena.fighterOf(id)!;
      if (f.gear.ranged && f.preferRanged) expect(f.role).toBe(R.None);
    }
  });
});

describe('the assault', () => {
  it('a shut gate is solid: nobody walks through it; a ram batters it to pieces and the forts view shows it shut, then broken', () => {
    const t = storm('st-ram', { archers: 0, foot: 24 }, { archers: 0, foot: 4 }, { ladders: 0 });
    const arena = t.r.combat.arena;
    const scene = arena.fights.get(t.id)!.scene!;
    const sim = t.r.sim;
    expect(sim.view.forts!().find((f) => f.building === t.fort.gate.id)).toBeUndefined(); // no military module: the view is the combat module's concern
    // a man walking at the shut gate from outside is stopped before it
    const probe = arena.fighterOf(t.attackers[t.attackers.length - 1])!;
    probe.role = R.None; probe.work = null; probe.dMode = 0; probe.think = 1e9;
    probe.x = probe.px = t.fort.cx; probe.z = probe.pz = t.fort.cz + t.fort.half + 6;
    for (let i = 0; i < 60; i++) { probe.wantX = 0; probe.wantZ = -1; probe.wantSpeed = 2; sim.step(SIM_DT); }
    expect(probe.z).toBeGreaterThan(t.fort.cz + t.fort.half + 3.5);
    // the ram marches to the gate and starts to batter
    let battering = false, broke = false;
    let steps = 0;
    for (; steps < 20 * 200 && arena.anyFight(); steps++) {
      sim.step(SIM_DT);
      const ram = scene.works.find((w) => w.kind === 'ram')!;
      if (ram.phase === 'batter') battering = true;
      if (scene.gateBroken()) { broke = true; break; }
    }
    expect(battering).toBe(true);
    expect(broke).toBe(true);
    expect(t.fort.gate.damage).toBeGreaterThanOrEqual(0.6);
    expect(scene.status().gate).toBe('broken');
    expect(steps * SIM_DT).toBeLessThan(180);
  });

  it('the attackers pour in through a broken gate and win against a handful', () => {
    const t = storm('st-pour', { archers: 2, foot: 26 }, { archers: 2, foot: 5 }, { ladders: 0 });
    const results: FightResult[] = [];
    t.r.combat.onFightEnded((res) => results.push(res));
    stepFor(t.r.sim, 330);
    expect(results).toHaveLength(1);
    expect(results[0].winner).toBe('house:1');
    expect(t.fort.gate.damage).toBeGreaterThanOrEqual(0.6);
    // the works are gone with the fight
    expect(t.r.sim.view.siegeWorks!()).toHaveLength(0);
  });

  it('ladders go up and men climb them to fight on the wall-walk', () => {
    const t = storm('st-ladder', { archers: 0, foot: 30 }, { archers: 4, foot: 10 }, { rams: 0, ladders: 3 });
    const arena = t.r.combat.arena;
    const scene = arena.fights.get(t.id)!.scene!;
    let planted = 0, climbed = 0, onWall = 0, sawClimb = false;
    for (let i = 0; i < 20 * 180 && arena.anyFight(); i++) {
      t.r.sim.step(SIM_DT);
      planted = Math.max(planted, scene.works.filter((w) => w.kind === 'ladder' && w.phase === 'up').length);
      for (const id of t.attackers) {
        const f = arena.fighterOf(id)!;
        if (f.role === R.Climb) {
          sawClimb = true;
          // a climber who is struck flinches or falls; otherwise he is drawn climbing
          if (f.st !== S.Hit && f.st !== S.Stagger && f.st !== S.Down && f.st !== S.Dead) expect(f.anim).toBe('climb');
          expect(f.y).toBeGreaterThanOrEqual(10 - 0.01);
        }
      }
      climbed = Math.max(climbed, scene.works.reduce((s, w) => s + w.landed, 0));
      onWall = Math.max(onWall, t.attackers.filter((id) => arena.fighterOf(id)!.onWall).length);
    }
    expect(planted).toBeGreaterThanOrEqual(2);
    expect(sawClimb).toBe(true);
    expect(climbed).toBeGreaterThanOrEqual(1);
    expect(onWall).toBeGreaterThanOrEqual(1);
  });

  it('a wall battered down is a breach: men walk through the rubble, whatever the navigation says', () => {
    const t = storm('st-breach', { archers: 0, foot: 20 }, { archers: 0, foot: 3 }, { rams: 0, ladders: 0 });
    const arena = t.r.combat.arena;
    const scene = arena.fights.get(t.id)!.scene!;
    // break a segment of the north wall by hand (the macro engines would)
    const seg = t.fort.walls.find((w) => w.z < t.fort.cz - 10 && Math.abs(w.x - t.fort.cx) < 12)!;
    seg.damage = 0.8;
    t.r.sim.state.touchBuilding(seg);
    expect(scene.breached()).toBe(true);
    const f = arena.fighterOf(t.attackers[0])!;
    f.role = R.None; f.work = null; f.dMode = 0; f.think = 1e9;
    f.x = f.px = seg.x; f.z = f.pz = seg.z - 8;
    for (let i = 0; i < 160; i++) { f.wantX = 0; f.wantZ = 1; f.wantSpeed = 2.2; t.r.sim.step(SIM_DT); }
    // he is through the wall and inside
    expect(f.z).toBeGreaterThan(seg.z + 1.5);
    // and the same walk against an unbroken segment stops at the stone
    const whole = t.fort.walls.find((w) => w.z < t.fort.cz - 10 && Math.abs(w.x - seg.x) > 18 && w.damage === 0)!;
    const g = arena.fighterOf(t.attackers[1])!;
    g.role = R.None; g.work = null; g.dMode = 0; g.think = 1e9;
    g.x = g.px = whole.x; g.z = g.pz = whole.z - 8;
    for (let i = 0; i < 160; i++) { g.wantX = 0; g.wantZ = 1; g.wantSpeed = 2.2; t.r.sim.step(SIM_DT); }
    expect(g.z).toBeLessThan(whole.z);
  });
});

describe('the walls shoot', () => {
  it('archers on the wall loose at the attackers and hit them; the wall covers them from arrows below the parapet', () => {
    const t = storm('st-shoot', { archers: 0, foot: 20 }, { archers: 8, foot: 4 }, { rams: 0, ladders: 0 });
    const arena = t.r.combat.arena;
    const proj = arena.env.proj;
    let shots = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 20 * 40 && arena.anyFight(); i++) {
      t.r.sim.step(SIM_DT);
      for (const s of proj.flying) if (!seen.has(s.id)) { seen.add(s.id); shots++; expect(s.y).toBeGreaterThan(10 + 4); }
    }
    expect(shots).toBeGreaterThan(6);
    const hurt = t.attackers.filter((id) => t.r.sim.state.persons.get(id)!.death || arena.env.book.isHurt(id)).length;
    expect(hurt).toBeGreaterThan(0);
    // the archers did not leave their stations
    for (const id of t.defenders) {
      const f = arena.fighterOf(id)!;
      if (f.station && f.st !== S.Dead) expect(f.onWall).toBe(true);
    }
  });

  it('an arrow from the ground that meets the wall below its top is stopped', () => {
    const t = storm('st-cover', { archers: 0, foot: 4 }, { archers: 0, foot: 3 }, { rams: 0, ladders: 0 });
    const arena = t.r.combat.arena;
    const scene = arena.fights.get(t.id)!.scene!;
    const z = t.fort.cz - t.fort.half;
    // across the north wall at 3 m is stopped; at 12 m passes
    expect(scene.blocksShot(null, t.fort.cx + 9, 13, z - 6, t.fort.cx + 9, 13, z + 6)).toBeGreaterThanOrEqual(0);
    expect(scene.blocksShot(null, t.fort.cx + 9, 22, z - 6, t.fort.cx + 9, 22, z + 6)).toBe(-1);
  });
});

describe('the whole storm', () => {
  it('is deterministic', () => {
    const run = (): string => { const t = storm('st-det', { archers: 3, foot: 16 }, { archers: 4, foot: 6 }); stepFor(t.r.sim, 70); return t.r.sim.stateHash(); };
    expect(run()).toBe(run());
  });

  it('the siege engines throw stones that damage the walls, and the damage lands on the buildings', () => {
    const t = storm('st-engine', { archers: 0, foot: 6 }, { archers: 0, foot: 3 }, { rams: 0, ladders: 0, engines: 2 });
    const arena = t.r.combat.arena;
    for (const id of [...t.attackers, ...t.defenders]) { const f = arena.fighterOf(id)!; f.think = 1e9; f.morale = f.moraleBase = 900; f.wantSpeed = 0; }
    const before = [...t.fort.walls, t.fort.gate, ...t.fort.towers].reduce((s, b) => s + b.damage, 0);
    let stones = 0;
    for (let i = 0; i < 20 * 120; i++) {
      t.r.sim.step(SIM_DT);
      stones = Math.max(stones, arena.env.proj.flying.filter((s) => s.kind === 'stone').length);
      const f = arena.fights.get(t.id);
      if (f) f.quiet = 0;
    }
    const after = [...t.fort.walls, t.fort.gate, ...t.fort.towers].reduce((s, b) => s + b.damage, 0);
    expect(stones).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(before);
  });
});

describe('the assault plan in the zone', () => {
  const planned = (seed: string) => {
    // the plan's tasks are filled in once we know who the attackers are: a first storm only to read their ids
    const probe = storm(seed, { archers: 0, foot: 24 }, { archers: 4, foot: 6 });
    const ids = probe.attackers;
    const tasks: Record<number, number> = {}, companies: Record<number, number> = {};
    ids.forEach((id, i) => { tasks[id] = i < 8 ? 2 : i < 18 ? 3 : i < 24 ? 5 : 4; companies[id] = i < 8 ? 2 : i < 18 ? 3 : 5; });
    return storm(seed, { archers: 0, foot: 24 }, { archers: 4, foot: 6 }, { tasks, companies, present: [2, 3, 4, 5], captains: { 5: ids[20] } });
  };

  it('the ram is worked by the ram company, the ladders by the ladder company, and the reserve holds back until the way is open', () => {
    const t = planned('st-plan');
    const arena = t.r.combat.arena;
    const scene = arena.fights.get(t.id)!.scene!;
    const ram = scene.works.find((w) => w.kind === 'ram')!;
    expect(ram.crew.length).toBeGreaterThan(0);
    for (const m of ram.crew) expect(m.task).toBe(2);
    for (const l of scene.works.filter((w) => w.kind === 'ladder')) for (const m of l.crew) expect(m.task).toBe(3);
    stepFor(t.r.sim, 14);
    const gate = { x: t.fort.gate.x, z: t.fort.gate.z };
    const reserve = t.attackers.map((id) => arena.fighterOf(id)!).filter((f) => f.task === 5 && f.active);
    expect(reserve.length).toBeGreaterThan(0);
    for (const f of reserve) expect(Math.hypot(f.x - gate.x, f.z - gate.z)).toBeGreaterThan(40);
    // the commander calls the reserve in: the company is re-tasked to the charge
    const tasks: Record<number, number> = {};
    for (const f of reserve) tasks[f.personId] = 4;
    arena.retask(t.id, tasks);
    for (const f of reserve) expect(f.task).toBe(4);
  });

  it('a captain who falls takes the heart out of his company', () => {
    const t = planned('st-captain');
    const arena = t.r.combat.arena;
    const cap = arena.fighterOf(t.attackers[20])!;
    const mate = arena.fighterOf(t.attackers[21])!;
    const other = arena.fighterOf(t.attackers[12])!;
    const gap0 = other.morale - mate.morale;
    cap.fled = true;
    stepFor(t.r.sim, 2);
    // the man of another company is not touched; the captain's own lose heart
    expect(other.morale - mate.morale).toBeGreaterThan(gap0 + 4);
  });
});
