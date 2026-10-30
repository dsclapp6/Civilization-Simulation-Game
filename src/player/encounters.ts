// Road encounters of map travel (SPEC §2, §19): how likely they are per kilometre (forest, heath, borders,
// night, winter wolves, difficulty), which kind turns up, and the choices each one offers. Everything is
// deterministic given the `travel` RNG stream. Combat arrives in wave 3, so a fight is never on offer:
// bandits are paid, outrun or talked round; wolves are scared off with fire or outrun.
import type { Difficulty } from '../core/domain';
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';
import { toDate } from '../core/time';
import { isHolyDay } from '../sim/calendar';
import { chronicle } from '../sim/api';
import type { SimContext } from '../sim/context';
import type { EconomyApi } from '../sim/economy/types';
import { formatMoney } from '../sim/money';
import { gainSkill, skillOf } from '../sim/skills';
import type { SocialApi } from '../sim/social/types';
import type { Person } from '../sim/state';
import { Biome, type WorldModel } from '../world/types';
import type { ActionOutcome } from '../sim/actions';
import type { EncounterKind } from './types';
import type { LegKind } from './route';

// ---------------------------------------------------------------------------------------------
// How dangerous is this stretch of road?
// ---------------------------------------------------------------------------------------------

export interface DangerSample {
  /** 0..1 woodland density. */
  forest: number;
  /** Heath, moor, upland, marsh: wild, empty country. */
  wild: boolean;
  /** A kingdom border within a few hundred metres. */
  border: boolean;
  /** Inside or hard by a settlement. */
  nearSettlement: boolean;
  night: boolean;
  winter: boolean;
  holyDay: boolean;
  leg: LegKind;
}

const DIFFICULTY_RATE: Record<Difficulty, number> = { squire: 0.7, knight: 1, lord: 1.25, king: 1.6 };
/** Bandits are the difficulty ladder's "heavy banditry" (SPEC §1). */
const DIFFICULTY_BANDITS: Record<Difficulty, number> = { squire: 0.5, knight: 1, lord: 1.4, king: 2.4 };
const DIFFICULTY_WOLVES: Record<Difficulty, number> = { squire: 0.6, knight: 1, lord: 1.2, king: 1.5 };
const LEG_RATE: Record<LegKind, number> = { highway: 0.8, road: 0.9, track: 1, path: 1.1, offroad: 1.3 };

/** Expected encounters per kilometre. */
export function encounterRate(s: DangerSample, difficulty: Difficulty): number {
  let r = 0.3 * (0.6 + 1.6 * s.forest);
  if (s.wild) r *= 1.3;
  if (s.border) r *= 1.4;
  if (s.night) r *= 1.7;
  if (s.nearSettlement) r *= 0.12;
  return r * DIFFICULTY_RATE[difficulty] * LEG_RATE[s.leg];
}

export function encounterWeights(s: DangerSample, difficulty: Difficulty): Array<[EncounterKind, number]> {
  const onRoad = s.leg === 'highway' || s.leg === 'road';
  const bandits = (0.5 + 1.5 * s.forest) * (s.wild ? 1.3 : 1) * (s.night ? 1.8 : 1) * DIFFICULTY_BANDITS[difficulty] * (onRoad ? 0.9 : 1.1);
  const wolfCountry = s.forest > 0.15 || s.wild;
  const wolves = wolfCountry ? 0.7 * (0.3 + s.forest) * (s.winter ? 3 : 0.7) * (s.night ? 1.8 : 0.6) * DIFFICULTY_WOLVES[difficulty] : 0.04;
  return [
    ['bandits', bandits],
    ['wolves', wolves],
    ['patrol', 0.8 * (s.border ? 2.5 : 1) * (onRoad ? 1.3 : 0.5)],
    ['travellers', 1.6 * (onRoad ? 1.4 : 0.6) * (s.night ? 0.2 : 1)],
    ['merchant', 0.7 * (onRoad ? 1.5 : 0.4) * (s.night ? 0.1 : 1)],
    ['pilgrims', 0.5 * (s.holyDay ? 2 : 1) * (s.night ? 0.2 : 1)],
    ['messenger', 0.3 * (s.night ? 0.3 : 1)],
  ];
}

const WILD_BIOMES: ReadonlySet<number> = new Set([Biome.Heath, Biome.Moor, Biome.Upland, Biome.Marsh, Biome.Mountain]);

/** Fills `out` with the danger of the road at a point and time. */
export function sampleDanger(world: WorldModel, x: number, z: number, absDay: number, leg: LegKind, nightNow: boolean, out: DangerSample): DangerSample {
  const date = toDate(absDay);
  out.forest = world.forestAt(x, z);
  out.wild = WILD_BIOMES.has(world.biomeAt(x, z));
  const k = world.kingdomAt(x, z);
  out.border = false;
  if (k) {
    // a border is close if another realm lies within ~400 m in any of four directions
    const d = 400;
    out.border = [world.kingdomAt(x + d, z), world.kingdomAt(x - d, z), world.kingdomAt(x, z + d), world.kingdomAt(x, z - d)].some((o) => o !== null && o.id !== k.id);
  }
  const s = world.nearestSettlement(x, z);
  out.nearSettlement = (x - s.x) * (x - s.x) + (z - s.z) * (z - s.z) < (s.radius * 1.4) * (s.radius * 1.4);
  out.night = nightNow;
  out.winter = date.season === 3;
  out.holyDay = isHolyDay(absDay);
  out.leg = leg;
  return out;
}

export function pickEncounterKind(rng: Rng, s: DangerSample, difficulty: Difficulty): EncounterKind {
  const w = encounterWeights(s, difficulty);
  return rng.weighted(w.map((e) => e[0]), w.map((e) => e[1]));
}

// ---------------------------------------------------------------------------------------------
// The encounter and its choices
// ---------------------------------------------------------------------------------------------

export interface EncounterData {
  kind: EncounterKind;
  label: string;
  text: string;
  hostile: boolean;
  /** How many of them (bandits, wolves, riders). */
  count: number;
  /** Pence asked (bandits' demand, a patrol's toll). */
  demand: number;
  /** Where it happened. */
  x: number;
  z: number;
  /** The settlement the news is about / the nearest market town. */
  nearSettlement: number;
  kingdom: string;
}

export interface ChoiceDef {
  id: string;
  label: string;
  preview?: string;
  enabled: boolean;
  reason?: string;
  /** Resolves the encounter. `resume` = the journey carries on; `end` = the journey is over (turned back). */
  run(): ActionOutcome & { resume: boolean; end?: boolean };
}

export interface EncounterEnv {
  ctx: SimContext;
  person: Person;
  social: SocialApi;
  economy: EconomyApi;
  mounted: boolean;
  /** Stamina 0..1. */
  stamina: number;
  rng: Rng;
}

const LIGHT_SOURCES = ['torch', 'candle', 'candles', 'tallow', 'firewood', 'charcoal'];

function rollCount(kind: EncounterKind, rng: Rng, difficulty: Difficulty): number {
  switch (kind) {
    case 'bandits': return rng.int(2, 4) + (difficulty === 'king' ? 1 : 0) + (difficulty === 'squire' ? -1 : 0);
    case 'wolves': return rng.int(2, 4);
    case 'patrol': return rng.int(3, 5);
    default: return rng.int(1, 4);
  }
}

/** Creates the encounter record for a kind at a place. */
export function makeEncounter(kind: EncounterKind, env: Pick<EncounterEnv, 'ctx' | 'person' | 'rng'>, x: number, z: number): EncounterData {
  const { ctx, person, rng } = env;
  const world = ctx.world;
  const count = Math.max(1, rollCount(kind, rng, ctx.state.difficulty));
  const kingdom = world.kingdomAt(x, z)?.name ?? 'the realm';
  const near = world.nearestSettlement(x, z);
  let market = near.id;
  let bestD = Infinity;
  for (const s of world.settlements) {
    if (!s.market) continue;
    const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (d < bestD) { bestD = d; market = s.id; }
  }
  const n = ['', 'A lone', 'Two', 'Three', 'Four', 'Five', 'Six'][Math.min(count, 6)] ?? 'Several';
  let label: string, text: string, hostile = false, demand = 0;
  switch (kind) {
    case 'bandits':
      hostile = true;
      demand = person.money <= 0 ? 0 : clamp(Math.round(person.money * 0.35), Math.min(6, person.money), 480);
      label = 'Outlaws bar the road';
      text = `${n === 'A lone' ? 'A rough man' : `${n} rough men`} step out of the trees ahead, cudgels and a rusty axe in their hands. "Your purse, friend," says the tallest, "and no trouble."`;
      break;
    case 'wolves':
      hostile = true;
      label = 'Wolves!';
      text = `A grey shape, then another, slips between the trees. ${count === 1 ? 'A wolf' : `${n} wolves`}, thin and bold with hunger, circle closer.`;
      break;
    case 'patrol':
      demand = clamp(Math.round(2 + person.money * 0.04), 2, 60);
      label = 'A patrol stops you';
      text = `Men-at-arms in the livery of ${kingdom} lean on their spears across the road. "Toll for the road," says the sergeant, "and state your business."`;
      break;
    case 'merchant':
      label = 'A travelling merchant';
      text = 'A merchant with laden pack-ponies slows beside you and offers to open his packs at fair prices.';
      break;
    case 'pilgrims':
      label = 'Pilgrims on the road';
      text = 'A small band of pilgrims in sun-faded cloaks, bound for a shrine, comes up the road singing a hymn. They greet you and slow their pace.';
      break;
    case 'messenger':
      label = 'A messenger';
      text = `A rider in the colours of ${kingdom} reins in, dusty and breathless, glad to pass on what he has heard.`;
      break;
    case 'army':
      hostile = true;
      label = 'An army on the march';
      text = 'Banners and a long dust cloud: an army is on the road.';
      break;
    default:
      label = 'Travellers on the road';
      text = 'A few country folk going the other way stop to rest in the shade and share the day\'s news.';
  }
  return { kind, label, text, hostile, count, demand, x, z, nearSettlement: near.id, kingdom };
}

// ---------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------

/** Takes a share of the person's goods (bandits). Returns how many units were taken. */
export function takeGoods(env: Pick<EncounterEnv, 'ctx' | 'person'>, fraction: number): number {
  const inv = env.person.inventory;
  let taken = 0;
  for (const key of Object.keys(inv)) {
    const qty = inv[key];
    if (!(qty > 0)) continue;
    const t = Math.min(qty, Math.max(1, Math.floor(qty * fraction)));
    inv[key] = qty - t;
    if (inv[key] <= 0) delete inv[key];
    taken += t;
  }
  if (taken > 0) env.ctx.state.touch(env.person);
  return taken;
}

/** A flesh wound: a loss of health and an injury that mends in a few days. */
export function wound(env: Pick<EncounterEnv, 'ctx' | 'person'>, severity: number): void {
  const p = env.person;
  p.health.hp = Math.max(0.15, Math.round((p.health.hp - 0.08 - 0.22 * severity) * 100) / 100);
  const day = env.ctx.absDay;
  p.health.conditions.push({ id: 'injury', since: day, until: day + 3 + Math.round(severity * 5), severity: 0.3 + severity * 0.4 });
  env.ctx.state.touch(p);
}

export function payMoney(env: Pick<EncounterEnv, 'ctx' | 'person'>, pence: number): number {
  const p = env.person;
  const paid = Math.max(0, Math.min(p.money, Math.round(pence)));
  p.money -= paid;
  env.ctx.state.touch(p);
  return paid;
}

// ---------------------------------------------------------------------------------------------
// Chances
// ---------------------------------------------------------------------------------------------

/** Outrunning bandits or wolves: Agility and Endurance, a fresh body, a horse (SPEC §2). */
export function fleeChance(p: Person, mounted: boolean, stamina01: number, pursuers: number, ridingLevel: number): number {
  let c = 0.38 + 0.035 * (p.trained.agi - 10) + 0.02 * (p.trained.end - 10) + 0.18 * (stamina01 - 0.5) - 0.04 * (pursuers - 3);
  if (mounted) c += 0.25 + 0.01 * ridingLevel;
  return clamp(c, 0.08, 0.92);
}

/** Talking your way past armed men: Charisma, Persuasion, standing. */
export function parleyChance(p: Person, base: number): number {
  const persuasion = skillOf(p, 'persuasion');
  return clamp(base + 0.03 * (p.trained.cha - 10) + 0.03 * persuasion + 0.05 * (p.rankTier - 1), 0.05, 0.9);
}

function pct(c: number): string { return `${Math.round(c * 100)}% chance`; }

function newsLines(env: EncounterEnv, settlement: number, limit: number): string[] {
  const lines = env.social.news(settlement, limit);
  if (lines.length > 0) return lines;
  const rumours = chronicle(env.ctx.state, limit).map((e) => e.text);
  return rumours.length > 0 ? rumours : ['They have little news: the harvest, the weather, the price of ale.'];
}

function lightSource(p: Person): string | null {
  for (const key of LIGHT_SOURCES) if ((p.inventory[key] ?? 0) > 0) return key;
  return null;
}

function use(env: Pick<EncounterEnv, 'ctx' | 'person'>, key: string, qty = 1): void {
  const p = env.person;
  p.inventory[key] = (p.inventory[key] ?? 0) - qty;
  if (p.inventory[key] <= 0) delete p.inventory[key];
  env.ctx.state.touch(p);
}

const ok = (message: string, resume = true, extra: Partial<ActionOutcome> = {}): ActionOutcome & { resume: boolean } => ({ ok: true, message, resume, ...extra });

// ---------------------------------------------------------------------------------------------
// Choices
// ---------------------------------------------------------------------------------------------

export function buildChoices(env: EncounterEnv, d: EncounterData): ChoiceDef[] {
  const { person: p, ctx, rng } = env;
  const riding = skillOf(p, 'riding');
  switch (d.kind) {
    case 'bandits': {
      const pay = Math.min(p.money, d.demand);
      const flee = fleeChance(p, env.mounted, env.stamina, d.count, riding);
      const parley = parleyChance(p, 0.12);
      return [
        {
          id: 'pay',
          label: pay > 0 ? `Hand over ${formatMoney(pay)}` : 'Show them your empty purse',
          preview: pay > 0 ? 'They let you go.' : 'They may search you for goods.',
          enabled: true,
          run() {
            if (pay > 0) {
              const paid = payMoney(env, pay);
              return ok(`You hand over ${formatMoney(paid)}. The outlaws laugh and wave you on.`, true);
            }
            const taken = takeGoods(env, 0.3);
            return ok(taken > 0 ? 'They find nothing worth taking but a few of your goods, and grudgingly let you pass.' : 'They find nothing, spit, and let you pass.', true);
          },
        },
        {
          id: 'flee',
          label: env.mounted ? 'Spur your horse and ride for it' : 'Run for it',
          preview: pct(flee),
          enabled: true,
          run() {
            if (rng.chance(flee)) {
              gainSkill(ctx, p, env.mounted ? 'riding' : 'stealth', 6);
              return ok('You break through and leave them cursing behind you.', true);
            }
            const lost = payMoney(env, Math.max(0, p.money * 0.5));
            const taken = takeGoods(env, 0.5);
            wound(env, rng.next());
            return ok(`They run you down. You lose ${formatMoney(lost)}${taken > 0 ? ' and half your goods' : ''}, and take a beating before they let you go.`, true, { ok: false });
          },
        },
        {
          id: 'parley',
          label: 'Talk your way out',
          preview: pct(parley),
          enabled: true,
          run() {
            if (rng.chance(parley)) {
              gainSkill(ctx, p, 'persuasion', 8);
              return ok('You talk of friends in high places and a magistrate expecting you. The outlaws shrug and step aside.', true);
            }
            const paid = payMoney(env, Math.min(p.money, Math.round(d.demand * 1.5)));
            return ok(`Your words only anger them. It costs you ${formatMoney(paid)} to be rid of them.`, true, { ok: false });
          },
        },
      ];
    }
    case 'patrol': {
      const noble = p.rankTier >= 5;
      const parley = parleyChance(p, 0.25);
      if (noble) {
        return [{ id: 'pass', label: 'Ride on', enabled: true, run: () => ok('The sergeant salutes and waves you through.', true) }];
      }
      return [
        {
          id: 'pay',
          label: `Pay the toll (${formatMoney(d.demand)})`,
          enabled: p.money >= d.demand,
          reason: p.money >= d.demand ? undefined : 'You cannot afford the toll.',
          run() {
            payMoney(env, d.demand);
            return ok(`You pay ${formatMoney(d.demand)}. The sergeant waves you on.`, true);
          },
        },
        {
          id: 'parley',
          label: 'Talk your way past',
          preview: pct(parley),
          enabled: true,
          run() {
            if (rng.chance(parley)) {
              gainSkill(ctx, p, 'persuasion', 6);
              return ok('You convince the sergeant you are expected at the next town. He lets you pass.', true);
            }
            return { ok: false, message: '"Not good enough." The sergeant bars the road. You turn back.', resume: false, end: true };
          },
        },
        { id: 'turn', label: 'Turn back', enabled: true, run: () => ({ ok: true, message: 'You turn back from the patrol.', resume: false, end: true }) },
      ];
    }
    case 'merchant': {
      return [
        {
          id: 'trade',
          label: 'Look over his wares',
          enabled: true,
          run: () => ok('The merchant opens his packs.', true, { ui: { panel: 'trade', partner: { kind: 'market', settlement: d.nearSettlement } } }),
        },
        {
          id: 'news',
          label: 'Ask for news',
          enabled: true,
          run() {
            const lines = newsLines(env, d.nearSettlement, 3);
            return ok('The merchant tells you what he has heard.', true, { ui: { panel: 'message', title: 'News from the merchant', text: lines.join('\n\n') } });
          },
        },
        { id: 'go', label: 'Move on', enabled: true, run: () => ok('You nod and walk on.', true) },
      ];
    }
    case 'travellers': {
      return [
        {
          id: 'news',
          label: 'Share the day\'s news',
          enabled: true,
          run() {
            const lines = newsLines(env, d.nearSettlement, 3);
            return ok('You rest a while and trade news with the travellers.', true, { ui: { panel: 'message', title: 'Travellers\' talk', text: lines.join('\n\n') } });
          },
        },
        { id: 'go', label: 'Move on', enabled: true, run: () => ok('You wish them well and walk on.', true) },
      ];
    }
    case 'pilgrims': {
      return [
        {
          id: 'walk',
          label: 'Walk with them a while',
          enabled: true,
          run() {
            p.rep.piety = clamp(p.rep.piety + 1, -100, 100);
            ctx.state.touch(p);
            const lines = newsLines(env, d.nearSettlement, 2);
            return ok('You walk with the pilgrims, and they bless your road.', true, { ui: { panel: 'message', title: 'The pilgrims\' tidings', text: lines.join('\n\n') } });
          },
        },
        {
          id: 'alms',
          label: 'Give alms (2d)',
          enabled: p.money >= 2,
          reason: p.money >= 2 ? undefined : 'You have nothing to give.',
          run() {
            payMoney(env, 2);
            p.rep.piety = clamp(p.rep.piety + 2, -100, 100);
            p.rep.generosity = clamp(p.rep.generosity + 1, -100, 100);
            ctx.state.touch(p);
            return ok('The pilgrims bless you and press a pilgrim\'s badge into your hand.', true);
          },
        },
        { id: 'go', label: 'Move on', enabled: true, run: () => ok('You nod to the pilgrims and walk on.', true) },
      ];
    }
    case 'wolves': {
      const flee = fleeChance(p, env.mounted, env.stamina, d.count + 1, riding);
      const light = lightSource(p);
      const fireChance = clamp(0.8 + 0.02 * (p.trained.per - 10) + (p.traits.includes('brave') ? 0.08 : 0), 0.4, 0.95);
      const stand = clamp(0.2 + 0.03 * (p.trained.str - 10) + (p.traits.includes('brave') ? 0.15 : 0) - (p.traits.includes('craven') ? 0.1 : 0) - 0.05 * (d.count - 2), 0.05, 0.7);
      return [
        {
          id: 'fire',
          label: light ? 'Light a brand and drive them off' : 'Light a brand and drive them off',
          preview: light ? pct(fireChance) : undefined,
          enabled: light !== null,
          reason: light ? undefined : 'You have nothing to make a fire with.',
          run() {
            use(env, light as string, 1);
            if (rng.chance(fireChance)) {
              p.rep.valour = clamp(p.rep.valour + 1, -100, 100);
              ctx.state.touch(p);
              gainSkill(ctx, p, 'hunting', 6);
              return ok('You wave the burning brand and the wolves slink back into the trees.', true);
            }
            wound(env, rng.next() * 0.6);
            return ok('The brand gutters in the wind and a wolf lunges. You drive them off, bitten and bloodied.', true, { ok: false });
          },
        },
        {
          id: 'flee',
          label: env.mounted ? 'Spur your horse away' : 'Run for it',
          preview: pct(flee),
          enabled: true,
          run() {
            if (rng.chance(flee)) {
              gainSkill(ctx, p, env.mounted ? 'riding' : 'stealth', 6);
              return ok('You run until your lungs burn, and the howling falls behind.', true);
            }
            wound(env, 0.4 + rng.next() * 0.6);
            const taken = takeGoods(env, 0.15);
            return ok(`The wolves catch you and tear at you before you shake them off.${taken > 0 ? ' You drop some of your goods in the scramble.' : ''}`, true, { ok: false });
          },
        },
        {
          id: 'stand',
          label: 'Stand your ground',
          preview: pct(stand),
          enabled: true,
          run() {
            if (rng.chance(stand)) {
              p.rep.valour = clamp(p.rep.valour + 2, -100, 100);
              ctx.state.touch(p);
              return ok('You stand firm, shouting. The wolves hesitate, then melt away into the trees.', true);
            }
            wound(env, 0.5 + rng.next() * 0.5);
            return ok('The wolves rush you. By the time they lose interest you are badly mauled.', true, { ok: false });
          },
        },
      ];
    }
    case 'messenger': {
      return [
        {
          id: 'news',
          label: 'Hear his news',
          enabled: true,
          run() {
            const lines = newsLines(env, d.nearSettlement, 3);
            return ok('The messenger tells you what is happening in the realm.', true, { ui: { panel: 'message', title: `News from ${d.kingdom}`, text: lines.join('\n\n') } });
          },
        },
        { id: 'go', label: 'Let him pass', enabled: true, run: () => ok('The messenger gallops on.', true) },
      ];
    }
    default:
      return [{ id: 'go', label: 'Move on', enabled: true, run: () => ok('You carry on.', true) }];
  }
}

// ---------------------------------------------------------------------------------------------
// "Press on" and "get away" for panels that offer only those two (the UI's journey panel)
// ---------------------------------------------------------------------------------------------

function firstEnabled(choices: readonly ChoiceDef[], ids: readonly string[]): string | null {
  for (const id of ids) if (choices.some((c) => c.id === id && c.enabled)) return id;
  return null;
}

/** The choice that means "carry on towards the destination": run past outlaws and wolves, pay a patrol, nod to the harmless. */
export function pressOnChoice(kind: EncounterKind, choices: readonly ChoiceDef[]): string | null {
  switch (kind) {
    case 'bandits': case 'wolves': return firstEnabled(choices, ['flee']);
    case 'patrol': return firstEnabled(choices, ['pass', 'pay', 'parley']);
    default: return firstEnabled(choices, ['go', 'pass']);
  }
}

/** The choice that means "get away from here": outrun the hostile, turn back from a patrol, walk away from the harmless. */
export function escapeChoice(kind: EncounterKind, choices: readonly ChoiceDef[]): string | null {
  switch (kind) {
    case 'bandits': case 'wolves': return firstEnabled(choices, ['flee']);
    case 'patrol': return firstEnabled(choices, ['turn', 'pass']);
    default: return firstEnabled(choices, ['go', 'pass']);
  }
}

// ---------------------------------------------------------------------------------------------
// Who is there: real people from the nearest settlements, for zones that can summon them
// ---------------------------------------------------------------------------------------------

const SOLDIERS: ReadonlySet<string> = new Set(['soldier', 'archer', 'man_at_arms', 'sergeant']);
const WANDERERS: ReadonlySet<string> = new Set(['peddler', 'merchant', 'beggar', 'outlaw']);

/** How many people an encounter puts in the 3D view (wolves are animals, see `wolfCount`). */
export function participantCount(kind: EncounterKind, count: number): number {
  switch (kind) {
    case 'bandits': case 'patrol': return Math.min(5, count);
    case 'travellers': return Math.min(3, Math.max(2, count));
    case 'pilgrims': return Math.min(4, Math.max(2, count));
    case 'merchant': case 'messenger': return 1;
    default: return 0;
  }
}

function fits(kind: EncounterKind, p: Person, age: number): boolean {
  if (p.death || p.flags.player || p.flags.captive) return false;
  switch (kind) {
    case 'bandits': return p.sex === 'm' && age >= 16 && age <= 45 && p.rankTier <= 2 && p.estate !== 'clergy';
    case 'patrol': return p.sex === 'm' && age >= 18 && age <= 50 && (SOLDIERS.has(p.career) || p.rankTier <= 2) && p.estate !== 'clergy';
    case 'merchant': return age >= 18 && age <= 60 && (WANDERERS.has(p.career) || p.rankTier === 3);
    case 'pilgrims': return age >= 16 && p.estate !== 'noble';
    case 'messenger': return p.sex === 'm' && age >= 16 && age <= 45;
    default: return age >= 14 && p.rankTier <= 3 && p.estate !== 'noble';
  }
}

/**
 * Picks `n` real people from the settlements nearest to (x, z) who fit the encounter (outlaws from poor
 * young men, a patrol from soldiers, pilgrims…), never the player's own household. Deterministic given the rng.
 */
export function pickParticipants(kind: EncounterKind, env: Pick<EncounterEnv, 'ctx' | 'person' | 'rng'>, x: number, z: number, n: number): number[] {
  if (n <= 0) return [];
  const { ctx, person, rng } = env;
  const world = ctx.world;
  const near = [...world.settlements].sort((a, b) => (a.x - x) ** 2 + (a.z - z) ** 2 - ((b.x - x) ** 2 + (b.z - z) ** 2)).slice(0, 4);
  const pool: number[] = [];
  const fallback: number[] = [];
  for (const s of near) {
    for (const p of ctx.state.residentsOf(s.id)) {
      if (p.household === person.household || p.id === person.id) continue;
      const age = (ctx.absDay - p.birthDay) / 16;
      if (fits(kind, p, age)) pool.push(p.id);
      else if (!p.death && age >= 16 && age <= 50) fallback.push(p.id);
      if (pool.length >= 60) break;
    }
    if (pool.length >= 60) break;
  }
  const from = pool.length >= n ? pool : [...pool, ...fallback.slice(0, 20)];
  const out: number[] = [];
  const pickFrom = from.slice();
  while (out.length < n && pickFrom.length > 0) {
    const i = Math.floor(rng.next() * pickFrom.length);
    out.push(pickFrom[i]);
    pickFrom.splice(i, 1);
  }
  return out;
}
