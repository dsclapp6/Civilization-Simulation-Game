// Development stand-in for the living village (`?devzone=1`): a handful of people standing around the
// player's home, a household horse, and buildings that stop the player — for screenshots and for trying
// the controls while the real agents module is not in the build. It wraps whatever zone the build has.
// Never used in normal play.
import type { AgentOrder, InteractCandidate, NavApi, ZoneAgent, ZoneAnimal, ZoneApi } from '../agents/types';
import { BUILDINGS } from '../content/types';
import { clamp, hash01, yawTo } from '../core/math';
import type { AnimalDrawItem, AnimState, CharacterDrawItem } from '../core/view';
import type { ActionProvider } from '../sim/actions';
import type { Simulation } from '../sim/sim';
import { fullName, type PersonId } from '../sim/state';
import { doorPoint } from '../sim/view-impl';

interface Box { cx: number; cz: number; hw: number; hd: number; cos: number; sin: number }

const NPC_ANIMS: AnimState[] = ['idle', 'work_hoe', 'talk', 'idle', 'work_hammer', 'idle', 'work_sickle', 'idle'];

export function wrapWithDevZone(sim: Simulation, base: ZoneApi): ZoneApi {
  const st = sim.state;
  const player = st.persons.get(st.run.playerId);
  const home = player ? st.households.get(player.household) : undefined;
  const homeB = home ? st.buildings.get(home.home) : undefined;
  const door = homeB ? doorPoint(homeB, 1.6) : { x: 100, z: 100, yaw: 0 };
  const settlement = player ? player.settlement : 0;

  // ---- buildings stop the player (circle against oriented boxes) ----
  const boxes: Box[] = [];
  for (const b of st.buildingsAt.get(settlement) ?? []) {
    const def = BUILDINGS[b.kind];
    if (!def.blocks) continue;
    boxes.push({ cx: b.x, cz: b.z, hw: def.w / 2, hd: def.d / 2, cos: Math.cos(b.rot), sin: Math.sin(b.rot) });
  }
  const hits = (x: number, z: number, r: number): boolean => {
    for (const q of boxes) {
      const px = x - q.cx, pz = z - q.cz;
      if (Math.abs(px) > 60 || Math.abs(pz) > 60) continue;
      const lx = px * q.cos - pz * q.sin, lz = px * q.sin + pz * q.cos;
      const cx = clamp(lx, -q.hw, q.hw), cz = clamp(lz, -q.hd, q.hd);
      if ((lx - cx) * (lx - cx) + (lz - cz) * (lz - cz) < r * r) return true;
    }
    return false;
  };
  const scratch = { x: 0, z: 0, blocked: false, wading: false };
  const nav: NavApi = {
    ...base.nav,
    walkable: (x, z) => base.nav.walkable(x, z) && !hits(x, z, 0.3),
    move(x, z, dx, dz, r, out) {
      base.nav.move(x, z, dx, dz, r, out);
      if (!hits(out.x, out.z, r)) return out;
      out.blocked = true;
      base.nav.move(x, z, dx, 0, r, scratch);
      if (!hits(scratch.x, scratch.z, r)) { out.x = scratch.x; out.z = scratch.z; return out; }
      base.nav.move(x, z, 0, dz, r, scratch);
      if (!hits(scratch.x, scratch.z, r)) { out.x = scratch.x; out.z = scratch.z; return out; }
      out.x = x; out.z = z;
      return out;
    },
    doorOf: (id) => {
      const b = st.buildings.get(id);
      return b ? doorPoint(b, 1.6) : null;
    },
  };

  // ---- people near the door ----
  const agents: ZoneAgent[] = [];
  const kin: PersonId[] = home ? home.members.filter((id) => id !== st.run.playerId) : [];
  const others = st.residentList(settlement).filter((p) => p.id !== st.run.playerId && !kin.includes(p.id) && (sim.absDay - p.birthDay) / 16 > 8);
  const picks = [...kin.slice(0, 3), ...others.slice(0, 9).map((p) => p.id)];
  picks.slice(0, 12).forEach((id, i) => {
    const p = st.persons.get(id);
    if (!p) return;
    const a = door.yaw + (hash01(id, 3) - 0.5) * 2.4 + (i % 2 ? 0.5 : -0.5);
    const rad = 4 + (i % 4) * 2.6 + hash01(id, 4) * 2;
    let x = door.x + Math.sin(a) * rad, z = door.z + Math.cos(a) * rad;
    if (hits(x, z, 0.6)) { x = door.x + Math.sin(a + 1.1) * rad; z = door.z + Math.cos(a + 1.1) * rad; }
    if (hits(x, z, 0.6)) return;
    const look = sim.view.appearance.get(st, p, sim.absDay);
    const anim = NPC_ANIMS[i % NPC_ANIMS.length];
    const draw: CharacterDrawItem = {
      id: p.id, x, y: base.nav.groundY(x, z), z, yaw: yawTo(x, z, door.x, door.z) + (hash01(id, 5) - 0.5),
      look: look.look, lookVersion: look.version,
      mainHand: anim === 'work_hoe' ? 'hoe' : anim === 'work_hammer' ? 'hammer' : anim === 'work_sickle' ? 'sickle' : 'none',
      offHand: 'none', back: 'none', carry: 'none', anim, animTime: hash01(id, 6) * 4, moveSpeed: 0, highlight: 0, label: p.first,
    };
    agents.push({ personId: p.id, x, y: draw.y, z, yaw: draw.yaw, speed: 0, activity: 'idle', goal: null, control: 'ai', visible: true, draw });
  });

  // ---- the household's horse ----
  const horse: ZoneAnimal = {
    id: 90001, kind: 'horse', x: door.x + Math.sin(door.yaw - 0.9) * 5, z: door.z + Math.cos(door.yaw - 0.9) * 5, owner: home ? home.id : 0, wild: false, hostile: false,
    draw: { id: 90001, kind: 'horse', x: 0, y: 0, z: 0, yaw: door.yaw + 0.6, anim: 'idle', animTime: 0, moveSpeed: 0, scale: 1, coat: 0x7a5032, highlight: 0 },
  };
  horse.draw.x = horse.x; horse.draw.z = horse.z; horse.draw.y = base.nav.groundY(horse.x, horse.z);
  let horseClaimed = false;

  let playerDraw: CharacterDrawItem | null = null;
  const chars: CharacterDrawItem[] = [];
  const beasts: ZoneAnimal[] = [];
  const beastDraws: AnimalDrawItem[] = [];
  const refreshBeasts = (): void => {
    beasts.length = 0; beastDraws.length = 0;
    if (!horseClaimed) { beasts.push(horse); beastDraws.push(horse.draw); }
  };
  refreshBeasts();
  sim.view.setSource('characters', () => {
    chars.length = 0;
    if (playerDraw) chars.push(playerDraw);
    for (const a of agents) chars.push(a.draw);
    return chars;
  });
  sim.view.setSource('animals', () => beastDraws);

  // people being talked to face the player and look busy again when released
  const held = new Set<PersonId>();
  sim.scheduler.register({
    name: 'devzone', phase: 'perStep', order: 60,
    run: () => {
      if (!playerDraw) return;
      for (const a of agents) if (held.has(a.personId)) { a.draw.yaw = yawTo(a.x, a.z, playerDraw.x, playerDraw.z); a.draw.anim = 'talk'; }
    },
  });

  // dev actions: digging the ground, a canned chat
  const dev: ActionProvider = {
    id: 'devzone',
    list(_ctx, actor, target, out) {
      if (actor !== st.run.playerId) return;
      if (target.kind === 'ground') {
        out.push({ id: 'dig', provider: '', label: 'Dig', category: 'work', target, enabled: true, seconds: 6, anim: 'work_dig', mainHand: 'spade', range: 3, priority: 4, preview: '+1 earth · Farming', repeat: true });
      }
      if (target.kind === 'person') {
        out.push({ id: 'greet', provider: '', label: 'Greet', category: 'social', target, enabled: true, seconds: 0, range: 3.5, priority: 9 });
      }
    },
    complete(_ctx, _actor, option) {
      if (option.id === 'greet' && option.target.kind === 'person') {
        const p = st.persons.get(option.target.id);
        sim.events.emit('ui', { panel: 'message', title: p ? fullName(p) : 'A villager', text: '"Good day to you. Fine weather for the work, if it holds."' });
        return { ok: true, message: 'You greet them.' };
      }
      return { ok: true, message: 'You turn the earth.', gains: [{ label: 'Earth', amount: 1 }] };
    },
    partial: true,
  };
  sim.actions.register(dev);

  const zone: ZoneApi = {
    ...base,
    nav,
    agents: () => agents,
    agent: (id) => agents.find((a) => a.personId === id) ?? null,
    animals: () => beasts,
    interactables(x, z, yaw, range, out) {
      out.length = 0;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const scored: Array<{ c: InteractCandidate; s: number }> = [];
      const consider = (target: InteractCandidate['target'], tx: number, tz: number, label: string): void => {
        const d = Math.hypot(tx - x, tz - z);
        if (d > range) return;
        const facing = d > 0.01 ? ((tx - x) * fx + (tz - z) * fz) / d : 1;
        if (facing < -0.1) return;
        scored.push({ c: { target, x: tx, z: tz, distance: d, label }, s: d - facing * 0.9 });
      };
      for (const a of agents) {
        const p = st.persons.get(a.personId);
        consider({ kind: 'person', id: a.personId }, a.x, a.z, p ? fullName(p) : 'Villager');
      }
      for (const b of beasts) consider({ kind: 'animal', id: b.id }, b.x, b.z, 'Horse');
      if (homeB) consider({ kind: 'building', id: homeB.id }, door.x, door.z, 'Your home');
      scored.sort((a, b) => a.s - b.s);
      if (scored.length === 0) consider({ kind: 'ground', x: x + fx * 1.8, z: z + fz * 1.8 }, x + fx * 1.8, z + fz * 1.8, 'Ground');
      for (const s of scored) out.push(s.c);
      return out;
    },
    hold: (id) => { held.add(id); },
    release: (id) => {
      held.delete(id);
      const a = agents.find((q) => q.personId === id);
      if (a) a.draw.anim = 'idle';
    },
    command: (_id: PersonId, _order: AgentOrder) => {},
    say: () => {},
    attachPlayer: (person, draw) => { playerDraw = draw; base.attachPlayer(person, draw); },
    detachPlayer: () => { playerDraw = null; base.detachPlayer(); },
    claimAnimal: (id) => { if (id !== horse.id || horseClaimed) return false; horseClaimed = true; refreshBeasts(); return true; },
    releaseAnimal: (id, x, z, yaw) => {
      if (id !== horse.id) return;
      horseClaimed = false;
      horse.x = x + Math.cos(yaw) * 1.2; horse.z = z - Math.sin(yaw) * 1.2;
      horse.draw.x = horse.x; horse.draw.z = horse.z; horse.draw.y = base.nav.groundY(horse.x, horse.z); horse.draw.yaw = yaw;
      refreshBeasts();
    },
  };
  return zone;
}
