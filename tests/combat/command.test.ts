// Troops you direct (docs/CIV.md §9, docs/WAR.md): groups, formations, orders, the AI commander.
import { describe, expect, it } from 'vitest';
import { slotOffset } from '../../src/combat/command';
import { D, S } from '../../src/combat/fighter';
import { SIM_DT } from '../../src/core/time';
import type { FightResult, GroupOrder } from '../../src/sim/wave3';
import { adultMen, combatRig, setStats, stepFor, type CombatRig } from './helpers';

const out = { lx: 0, lz: 0 };

describe('formation slots', () => {
  it('a line is centred on the anchor, the front rank first, ranks behind; a shield wall is tighter; a wedge has its tip in front', () => {
    const xs: number[] = [];
    for (let i = 0; i < 6; i++) { slotOffset('line', i, 12, false, out); xs.push(out.lx); expect(out.lz).toBeCloseTo(0, 9); }
    // twelve men: two ranks of six, centred
    expect(xs.reduce((s, x) => s + x, 0)).toBeCloseTo(0, 6);
    slotOffset('line', 6, 12, false, out);
    expect(out.lz).toBeLessThan(0);
    const width = (f: 'line' | 'shield_wall'): number => { slotOffset(f, 0, 12, false, out); const a = out.lx; slotOffset(f, 5, 12, false, out); return Math.abs(out.lx - a); };
    expect(width('shield_wall')).toBeLessThan(width('line'));
    // wedge: row r has 2r+1 men, behind the tip
    slotOffset('wedge', 0, 9, false, out);
    expect(out.lx).toBeCloseTo(0, 9); expect(out.lz).toBeCloseTo(0, 9);
    slotOffset('wedge', 1, 9, false, out); const a = { ...out };
    slotOffset('wedge', 4, 9, false, out);
    expect(a.lz).toBeLessThan(0);
    expect(out.lz).toBeLessThan(a.lz);
    // horse stand wider apart than men on foot
    slotOffset('line', 0, 8, true, out); const h0 = out.lx; slotOffset('line', 1, 8, true, out); const h1 = out.lx;
    slotOffset('line', 0, 8, false, out); const f0 = out.lx; slotOffset('line', 1, 8, false, out); const f1 = out.lx;
    expect(Math.abs(h1 - h0)).toBeGreaterThan(Math.abs(f1 - f0));
  });
});

const KITS = {
  foot: { weapon: 'sword', shield: 'shield', armour: ['padded_armour'] },
  spear: { weapon: 'spear', armour: [] as string[] },
  bow: { weapon: 'dagger', ranged: 'longbow', armour: [] as string[] },
  horse: { weapon: 'sword', armour: ['mail_hauberk'] },
};

interface Battle { r: CombatRig; a: number[]; b: number[]; id: number; results: FightResult[] }

/** Two small armies facing each other at 60 m: foot, archers and a few horse each. */
function battle(seed: string, opts: { player?: boolean; commandSpan?: number; foot?: number; bows?: number; horse?: number } = {}): Battle {
  const r = combatRig({ seed, player: opts.player });
  const foot = opts.foot ?? 10, bows = opts.bows ?? 4, horse = opts.horse ?? 2;
  const per = foot + bows + horse;
  const men = adultMen(r.sim, per * 2, 17, 45);
  men.forEach((p) => { setStats(p, { str: 12, agi: 11, end: 12 }); p.needs.hunger = 1; p.needs.rest = 1; p.rankTier = 2; p.traits = []; });
  const sideOf = (list: typeof men): { ids: number[]; mounted: number[] } => {
    const ids = list.map((p) => p.id);
    list.forEach((p, i) => {
      const kit = i < foot ? (i % 2 ? KITS.foot : KITS.spear) : i < foot + bows ? KITS.bow : KITS.horse;
      r.combat.arena.setKitOverride(p.id, kit);
    });
    return { ids, mounted: list.slice(foot + bows).map((p) => p.id) };
  };
  const A = sideOf(men.slice(0, per)), B = sideOf(men.slice(per));
  const results: FightResult[] = [];
  r.combat.onFightEnded((res) => results.push(res));
  const pid = r.sim.state.run.playerId;
  const body = r.player?.body();
  const at = body ? { x: body.x, z: body.z } : { x: 600, z: 600 };
  const sidesA = opts.player ? [pid, ...A.ids] : A.ids;
  const id = r.combat.engage([
    { faction: 'house:1', people: sidesA, mounted: A.mounted },
    { faction: 'house:2', people: B.ids, mounted: B.mounted },
  ], { at, reason: 'battle', ...(opts.player ? { command: { side: 0, span: opts.commandSpan ?? 8 } } : {}) });
  expect(id).toBeGreaterThan(0);
  return { r, a: A.ids, b: B.ids, id, results };
}

const fighterOf = (b: Battle, id: number) => b.r.combat.arena.fighterOf(id)!;
const centre = (b: Battle, ids: number[]): { x: number; z: number } => {
  let sx = 0, sz = 0, n = 0;
  for (const id of ids) { const f = fighterOf(b, id); if (f.active) { sx += f.x; sz += f.z; n++; } }
  return { x: sx / Math.max(1, n), z: sz / Math.max(1, n) };
};

describe('a battle has groups and an AI commander', () => {
  it('sorts each side into foot, archers and horse and gives them orders; the fight runs to a result', () => {
    const b = battle('cmd-ai');
    const fight = b.r.combat.arena.fights.get(b.id)!;
    expect(fight.cmd).toBeTruthy();
    stepFor(b.r.sim, 3);
    const cmd = fight.cmd!;
    for (const side of [0, 1]) {
      const kinds = cmd.groups.filter((g) => g.side === side && g.count > 0).map((g) => g.gk).sort();
      expect(kinds).toEqual([0, 1, 2]);
    }
    // the attackers advance, the defenders hold
    const a0 = cmd.find(0, 0, 0)!, d0 = cmd.find(1, 0, 0)!;
    expect(a0.order).toBe('advance');
    expect(['hold', 'charge']).toContain(d0.order);
    // the archers are in loose order, loosing at will or holding back
    expect(['loose', 'hold', 'advance']).toContain(cmd.find(0, 0, 1)!.order);
    stepFor(b.r.sim, 120);
    expect(b.results).toHaveLength(1);
    expect(b.results[0].winner === 'house:1' || b.results[0].winner === 'house:2' || b.results[0].winner === null).toBe(true);
  });

  it('is deterministic', () => {
    const run = (): string => { const b = battle('cmd-det'); stepFor(b.r.sim, 60); return b.r.sim.stateHash(); };
    expect(run()).toBe(run());
  });

  it('a line advances as a line: the foot arrive together, not one by one', () => {
    const b = battle('cmd-line', { foot: 12, bows: 0, horse: 0 });
    const fight = b.r.combat.arena.fights.get(b.id)!;
    stepFor(b.r.sim, 8);
    const g = fight.cmd!.find(0, 0, 0)!;
    expect(g.order).toBe('advance');
    // how stretched are they across their line of march? Within a few metres of each other, not strung out
    const fs = b.a.map((id) => fighterOf(b, id)).filter((f) => f.active);
    const dir = { x: Math.sin(g.yaw), z: Math.cos(g.yaw) };
    const along = fs.map((f) => f.x * dir.x + f.z * dir.z);
    const spread = Math.max(...along) - Math.min(...along);
    expect(spread).toBeLessThan(12);
  });
});

describe('the player\'s orders', () => {
  it('gives battle groups for the commanded men and orders them; others keep to the AI', () => {
    const b = battle('cmd-player', { player: true, commandSpan: 8, foot: 6, bows: 4, horse: 0 });
    const api = b.r.combat as unknown as { groups(s: 'own' | 'enemy'): Array<{ key: string; count: number; order: string }>; orderGroup(k: string, o: GroupOrder): { ok: boolean; reason?: string } };
    stepFor(b.r.sim, 1);
    const own = api.groups('own');
    expect(own[0].key).toBe('all');
    expect(own.map((g) => g.key).sort()).toEqual(['all', 'archers', 'foot']);
    // eight men are commanded: the first eight of the side's list (foot, then bows)
    const total = own.filter((g) => g.key !== 'all').reduce((s, g) => s + g.count, 0);
    expect(total).toBe(8);
    expect(own[0].count).toBe(8);
    const r1 = api.orderGroup('foot', { kind: 'hold' });
    expect(r1.ok).toBe(true);
    expect(api.groups('own').find((g) => g.key === 'foot')!.order).toBe('hold');
    // the AI's own groups are untouched: it advanced them
    const fight = b.r.combat.arena.fights.get(b.id)!;
    const rest = fight.cmd!.find(0, 0, 1)!;
    expect(rest.count).toBeGreaterThan(0);
    expect(rest.byPlayer).toBe(false);
    expect(['loose', 'advance', 'hold']).toContain(rest.order);
    expect(fight.cmd!.find(0, 1, 0)!.order).toBe('hold');
    expect(fight.cmd!.find(0, 1, 0)!.byPlayer).toBe(true);
    // the enemy's groups are seen from the player's place
    expect(api.groups('enemy').length).toBeGreaterThan(0);
  });

  it('a man who commands no one gets no groups and no obedience', () => {
    const b = battle('cmd-none', { player: true, commandSpan: 0, foot: 6, bows: 2, horse: 0 });
    const api = b.r.combat as unknown as { groups(s: 'own' | 'enemy'): unknown[]; orderGroup(k: string, o: GroupOrder): { ok: boolean; reason?: string } };
    expect(api.groups('own')).toHaveLength(0);
    const r = api.orderGroup('all', { kind: 'charge' });
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('hold keeps the men where they stand; advance to a point walks them there in formation; retreat takes them away', () => {
    const b = battle('cmd-orders', { player: true, commandSpan: 12, foot: 12, bows: 0, horse: 0 });
    const api = b.r.combat as unknown as { orderGroup(k: string, o: GroupOrder): { ok: boolean; reason?: string } };
    const fight = b.r.combat.arena.fights.get(b.id)!;
    // keep the enemy out of it: it stands still
    for (const id of b.b) { const f = fighterOf(b, id); f.think = 1e9; f.wantSpeed = 0; f.morale = f.moraleBase = 900; }
    stepFor(b.r.sim, 1);
    const g = fight.cmd!.find(0, 1, 0)!;
    expect(g.count).toBe(12);
    const c0 = centre(b, b.a);
    expect(api.orderGroup('foot', { kind: 'hold' }).ok).toBe(true);
    stepFor(b.r.sim, 5);
    const c1 = centre(b, b.a);
    expect(Math.hypot(c1.x - c0.x, c1.z - c0.z)).toBeLessThan(4);
    // march 24 m to the side: they arrive, as a body
    const to = { x: c1.x + 24, z: c1.z };
    expect(api.orderGroup('foot', { kind: 'advance', at: to }).ok).toBe(true);
    stepFor(b.r.sim, 22);
    const c2 = centre(b, b.a);
    expect(Math.hypot(c2.x - to.x, c2.z - to.z)).toBeLessThan(5);
    for (const id of b.a) expect(fighterOf(b, id).dMode).toBe(D.Slot);
    // and they are in a line: two ranks across the facing
    const fs = b.a.map((id) => fighterOf(b, id));
    const spreadX = Math.max(...fs.map((f) => f.x)) - Math.min(...fs.map((f) => f.x));
    const spreadZ = Math.max(...fs.map((f) => f.z)) - Math.min(...fs.map((f) => f.z));
    expect(Math.max(spreadX, spreadZ)).toBeGreaterThan(5);
    expect(Math.max(spreadX, spreadZ)).toBeLessThan(16);
    // retreat: they leave the field
    expect(api.orderGroup('all', { kind: 'retreat' }).ok).toBe(true);
    stepFor(b.r.sim, 30);
    const gone = b.a.filter((id) => fighterOf(b, id)?.gone || !fighterOf(b, id)?.active).length;
    expect(gone).toBeGreaterThan(6);
  });

  it('shield wall packs the line tighter than line order', () => {
    const spacing = (formation: 'line' | 'shield_wall'): number => {
      const b = battle(`cmd-form-${formation}`, { player: true, commandSpan: 12, foot: 12, bows: 0, horse: 0 });
      const api = b.r.combat as unknown as { orderGroup(k: string, o: GroupOrder): { ok: boolean } };
      for (const id of b.b) { const f = fighterOf(b, id); f.think = 1e9; f.wantSpeed = 0; f.morale = f.moraleBase = 900; }
      stepFor(b.r.sim, 1);
      api.orderGroup('foot', { kind: 'formation', formation });
      api.orderGroup('foot', { kind: 'hold' });
      stepFor(b.r.sim, 14);
      const fs = b.a.map((id) => fighterOf(b, id)).filter((f) => f.active);
      let sum = 0, n = 0;
      for (const f of fs) {
        let best = Infinity;
        for (const g of fs) if (g !== f) best = Math.min(best, Math.hypot(f.x - g.x, f.z - g.z));
        sum += best; n++;
      }
      return sum / n;
    };
    expect(spacing('shield_wall')).toBeLessThan(spacing('line'));
  });

  it("'follow me' keeps the group about the player as he walks", () => {
    const b = battle('cmd-follow', { player: true, commandSpan: 8, foot: 8, bows: 0, horse: 0 });
    const api = b.r.combat as unknown as { orderGroup(k: string, o: GroupOrder): { ok: boolean } };
    for (const id of b.b) { const f = fighterOf(b, id); f.think = 1e9; f.wantSpeed = 0; f.morale = f.moraleBase = 900; }
    stepFor(b.r.sim, 1);
    expect(api.orderGroup('all', { kind: 'follow' }).ok).toBe(true);
    const pf = b.r.combat.arena.player!;
    // the player walks 30 m, the men come after
    const body = b.r.player!.body()!;
    for (let i = 0; i < 20 * 30; i++) {
      b.r.player!.setInput({ forward: 1, right: 0, cameraYaw: body.yaw, sprint: false, walk: false, interact: false, interactHeld: 0, mount: false, dodge: false, cancel: false, attack: false, block: false });
      b.r.sim.step(SIM_DT);
    }
    const c = centre(b, b.a);
    expect(Math.hypot(c.x - pf.x, c.z - pf.z)).toBeLessThan(14);
    expect(S.Dead).toBeGreaterThan(0);
  });
});
