// The HUD's plaque of the law (docs/CIV.md §4, docs/LAW.md): whose land you stand on when it is not yours ("Lands of Sir Hugh · private",
// "Hostile: House Avenel, at war with yours"), the riders coming, the escort's countdown with the way to the edge of the land, what binds
// you and where you are held (with a button to your options), and the horse that was called. It also keeps one thing that belongs to the
// body and the horse: holding F (about half a second) calls your horse to you. The plaque is a pure model (`plaque`) and a small DOM part.
import { dist } from '../../core/math';
import type { Restraint } from '../../player/types';
import { titled } from '../../sim/law/names';
import type { CaptivityView, PatrolView } from '../../sim/law/types';
import type { TrespassLevel } from '../../sim/territory/types';
import { h } from '../core/dom';
import { formatMoney } from '../core/format';
import { registerHotkey, registerHudPart, type HudPart, type HudPartCtx } from '../core/extHud';
import { icon, type IconName } from '../core/icons';
import { escortText } from '../panels/law';

export type PlaqueKind = 'land' | 'coming' | 'escort' | 'bound' | 'held' | 'horse';
export interface Plaque {
  kind: PlaqueKind;
  tone: 'gold' | 'vermilion' | 'ink' | 'green';
  icon: IconName;
  title: string;
  sub: string;
  /** A button on the plaque: opens the law panel. */
  action: string | null;
}

export interface PlaqueInput {
  trespass: { level: TrespassLevel; reason: string; lord: string; hostileHouse?: string } | null;
  patrol: PatrolView | null;
  captive: CaptivityView | null;
  restraint: Restraint | null;
  horse: { eta: number } | null;
  /** Metres and compass bearing (radians clockwise from north) to the edge of the land while escorted. */
  exit: { metres: number; bearing: number } | null;
}

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;
/** "north-east" for a bearing in radians clockwise from north. */
export function bearingWord(bearing: number): string {
  const t = (((bearing % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
  return DIRS[Math.round(t * 8) % 8];
}

/** The bearing from a body to a point, clockwise from north (+z is south in this world). */
export function bearingTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, -(toZ - fromZ));
}

function lowerFirst(s: string): string { return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

/** What the plaque says, or null when there is nothing to say. The most pressing thing wins: bound, held, riders, escort, land, horse. */
export function plaque(i: PlaqueInput): Plaque | null {
  if (i.captive) {
    const days = i.captive.sentenceDays;
    return i.captive.led || i.restraint?.kind === 'led'
      ? { kind: 'bound', tone: 'vermilion', icon: 'lock', title: i.restraint?.reason ?? i.captive.text, sub: 'Your hands are bound. Keep up, or you are dragged.', action: 'Your options' }
      : {
        kind: 'held', tone: 'vermilion', icon: 'lock', title: `Held in ${i.captive.place ?? 'the lord\'s cell'}`,
        sub: i.captive.danger ? 'The lord may hang you.'
          : i.captive.war ? `Ransom asked: ${formatMoney(i.captive.ransom)}`
            : i.captive.serving ? `Serving: ${days} ${days === 1 ? 'day' : 'days'} left`
              : i.captive.fine > 0 ? `Fine owed: ${formatMoney(i.captive.fine)}` : 'Waiting on the lord\'s pleasure',
        action: 'Your options',
      };
  }
  if (i.restraint) return { kind: 'bound', tone: 'vermilion', icon: 'lock', title: i.restraint.reason, sub: 'You are bound.', action: null };
  const p = i.patrol;
  if (p && p.phase === 'coming') return { kind: 'coming', tone: 'vermilion', icon: 'horse', title: 'Riders are coming', sub: p.level === 'hostile' ? 'Armed men of a hostile House ride at you.' : 'The lord\'s men are after you.', action: null };
  if (p && p.phase === 'halt') return { kind: 'coming', tone: 'vermilion', icon: 'shield', title: 'The riders have halted you', sub: p.line, action: 'Answer them' };
  if (p && p.phase === 'escort') {
    const where = i.exit ? `${Math.round(i.exit.metres)} m to the edge, ${bearingWord(i.exit.bearing)}` : 'Make for the edge of the land';
    return { kind: 'escort', tone: 'vermilion', icon: 'boot', title: escortText(p) || 'Leave the land', sub: where, action: null };
  }
  if (p && p.phase === 'attack') return { kind: 'coming', tone: 'vermilion', icon: 'swords', title: 'They are on you', sub: 'Fight, flee or yield.', action: null };
  const t = i.trespass;
  if (t && t.level === 'hostile') return { kind: 'land', tone: 'vermilion', icon: 'swords', title: `Hostile: ${t.hostileHouse ?? lowerFirst(t.reason)}`, sub: 'Armed men will ride at you if you are seen.', action: null };
  if (t && t.level === 'private') return { kind: 'land', tone: 'gold', icon: 'lock', title: `Lands of ${t.lord} · private`, sub: t.reason ? `${t.reason.charAt(0).toUpperCase()}${t.reason.slice(1)}.` : '', action: null };
  if (i.horse) return { kind: 'horse', tone: 'green', icon: 'horse', title: 'Your horse is coming', sub: i.horse.eta > 1 ? `About ${i.horse.eta} s` : 'It is here', action: null };
  return null;
}

const STYLE_ID = 'mu-law-hud-style';
const CSS = `
.mu-hud > .mu-law-plaque { left: 50%; bottom: 150px; transform: translateX(-50%); max-width: 520px; min-width: 260px; padding: 8px 14px 9px; display: flex; align-items: center; gap: 12px; pointer-events: none; }
.mu-law-plaque.mu-hide { display: none; }
.mu-law-plaque .mu-law-ico { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: rgba(26, 17, 9, 0.92); color: #f2c14e; box-shadow: 0 0 0 1px rgba(255, 244, 205, 0.55); }
.mu-law-plaque.vermilion .mu-law-ico { color: #ff8f7c; animation: mu-throb 1.6s ease-in-out infinite; }
.mu-law-plaque.green .mu-law-ico { color: #9fd47c; }
.mu-law-plaque .mu-law-title { font-weight: 700; font-size: 16px; letter-spacing: 0.01em; }
.mu-law-plaque.vermilion .mu-law-title { color: #7c1d12; }
.mu-law-plaque .mu-law-sub { font-size: 13px; color: var(--ink-2); font-style: italic; }
.mu-law-plaque .mu-btn { pointer-events: auto; margin-left: 6px; flex: none; }
`;

function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** How long F is held before the whistle (s). */
export const WHISTLE_SECONDS = 0.55;

/**
 * Hold F to call the horse. The UI asks the hotkey when F goes down (only when the game screen is up, nothing is typed into and no
 * screen or conversation holds the keyboard) and never again while it is held; the key is not consumed, so the press still reaches the
 * player (a tap mounts a horse that is by). The HUD part watches the clock and the key coming up.
 */
const hold = { since: -1, fired: false };
registerHotkey('KeyF', () => { hold.since = performance.now(); hold.fired = false; return false; });

function build(ctx: HudPartCtx): HudPart {
  ensureStyle();
  const el = h('div.mu-plate.mu-law-plaque.mu-hide', { role: 'status', 'aria-live': 'polite' });
  let last = '';
  let nextAt = 0;
  const onUp = (e: KeyboardEvent): void => { if (e.code === 'KeyF') hold.since = -1; };
  const onBlur = (): void => { hold.since = -1; };
  if (typeof window !== 'undefined') {
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
  }

  const read = (): PlaqueInput | null => {
    const g = ctx.game();
    if (!g) return null;
    const me = g.sim.state.run.playerId;
    const hud = g.player.hud();
    const body = g.player.body();
    if (!hud || !body) return null;
    let trespass: PlaqueInput['trespass'] = null;
    const t = g.territory;
    if (t && !g.sim.state.persons.get(me)?.flags.captive) {
      const c = t.trespass(me, body.x, body.z);
      if (c.level !== 'none') {
        const lordId = c.lord ?? 0;
        const lord = lordId ? g.sim.state.persons.get(lordId) : undefined;
        const hostileHouse = c.level === 'hostile' ? c.reason.replace(/^(the )?lands of /i, '') : undefined;
        trespass = { level: c.level, reason: c.reason, lord: titled(lord), hostileHouse };
      }
    }
    const patrol = g.law?.patrolFor(me) ?? null;
    let exit: PlaqueInput['exit'] = null;
    if (patrol && patrol.phase === 'escort' && patrol.exit) {
      exit = { metres: dist(body.x, body.z, patrol.exit.x, patrol.exit.z), bearing: bearingTo(body.x, body.z, patrol.exit.x, patrol.exit.z) };
    }
    return { trespass, patrol, captive: g.law?.captivity(me) ?? null, restraint: hud.restraint ?? null, horse: hud.horseCall ?? null, exit };
  };

  const openLaw = (): void => ctx.open({ panel: 'ext', name: 'law', data: { mode: 'hud' } });

  return {
    el,
    update(now: number) {
      // the whistle: F held long enough, with no horse at hand (the controller says so quietly when there is one)
      if (hold.since >= 0 && !hold.fired && performance.now() - hold.since >= WHISTLE_SECONDS * 1000) {
        hold.fired = true;
        ctx.game()?.player.callHorse?.();
      }
      if (now < nextAt) return;
      nextAt = now + 0.2;
      const model = read();
      const p = model ? plaque(model) : null;
      const sig = p ? `${p.kind}|${p.title}|${p.sub}|${p.action ?? ''}` : '';
      if (sig === last) return;
      last = sig;
      if (!p) { el.classList.add('mu-hide'); el.replaceChildren(); return; }
      el.className = `mu-plate mu-law-plaque ${p.tone}`;
      el.replaceChildren(
        h('span.mu-law-ico', null, icon(p.icon, 20)),
        h('div', null, h('div.mu-law-title', null, p.title), p.sub ? h('div.mu-law-sub', null, p.sub) : null),
        ...(p.action ? [h<HTMLButtonElement>('button.mu-btn.small', { type: 'button', onclick: openLaw }, p.action)] : []),
      );
    },
    dispose() {
      if (typeof window !== 'undefined') {
        window.removeEventListener('keyup', onUp);
        window.removeEventListener('blur', onBlur);
      }
    },
  };
}

registerHudPart('law', build);
