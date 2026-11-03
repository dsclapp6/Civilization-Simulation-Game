// Military: the forces of the House, recruiting (what each man costs, a preview of the whole, the realm's own refusals), the men on
// your pay (discharge, dub a knight), and armies: raise the levy, give orders in the command panel, take the field yourself (CIV §6.5).
import type { MilitaryRuntime, ArmyDetail } from '../../../sim/military/types';
import type { RealmTroop, RecruitOption } from '../../../sim/realm/types';
import { button, chip, empty, heading } from '../../components/widgets';
import { h } from '../../core/dom';
import { goodLine } from '../../builder/landsUi';
import { dubbable, kindName, knightsOf, recruitMax, recruitPreview, RESERVE_DAYS, troopCounts } from '../rulerModel';
import { line, money, statCard, type RulerEnv } from '../rulerUi';

interface Bag { settlement: number; counts: Record<string, number> }

const TASK: Record<string, string> = { muster: 'mustering', march: 'on the march', siege: 'besieging', raid: 'raiding', battle: 'in battle', garrison: 'in camp', disband: 'disbanding' };

export function buildMilitary(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const v = env.view();
  const sim = ctx.sim;
  const may = env.may();
  const mil = sim.services.military as MilitaryRuntime | undefined;
  const bag = env.state<Bag>('military', () => ({ settlement: v.seat ?? v.settlements[0] ?? 0, counts: {} }));
  if (!v.settlements.includes(bag.settlement)) bag.settlement = v.seat ?? v.settlements[0] ?? 0;
  const wrap = h('div.mu-rul-page.mu-rul-military');

  // ---- forces
  const f = mil?.forces?.(v.house);
  if (f) {
    wrap.append(h('div.mu-grid.mu-rul-stats', null,
      statCard('Retinue', f.retinue, 'knights, men-at-arms, archers', '', 'helm'), statCard('Garrison', f.garrison, 'hold the castles', '', 'shield'),
      statCard('Levy pool', f.levyPool, 'men of 15 to 60 on your manors', '', 'users'), statCard('Militia', f.militia, 'the towns’ crossbowmen', '', 'archery'),
      statCard('Hired', f.mercenaries, 'free swords on contract', '', 'coin'), statCard('In the field', f.afield, 'with the armies', f.afield ? 'gold' : '', 'flag'), statCard('Strength', Math.round(f.strength), 'the House’s weight', '', 'swords')));
  }

  // ---- your knights: take one's place and fight on your behalf
  wrap.append(knightsCard(env));

  // ---- recruiting
  wrap.append(heading('Raise and train', 'swords'));
  const places = v.settlements;
  if (!may.realm) wrap.append(line('Only the holder, or a steward while the lord cannot act, raises men.'));
  const sel = h<HTMLSelectElement>('select.mu-input', { 'aria-label': 'Where to raise men' }, places.map((id) => h('option', { value: String(id), selected: id === bag.settlement }, ctx.placeName(id))));
  sel.addEventListener('change', () => { bag.settlement = Number(sel.value); env.refresh(); });
  wrap.append(h('div.mu-row.mu-gap-8', { style: { marginBottom: '8px' } }, h('span.mu-small', null, 'Men of'), sel, h('span.mu-tiny.mu-dim', null, `Each man needs ${RESERVE_DAYS} days’ wages in hand as well as his fee and his gear.`)));
  const options = places.length ? realm.recruitOptions(me, bag.settlement) : [];
  wrap.append(options.length ? h('div.mu-rul-recruit', null, options.map((o) => recruitRow(env, o, bag))) : empty('No one can be raised here.'));

  // ---- the men on the roll
  const troops = realm.troops?.(me) ?? [];
  const counts = troopCounts(troops);
  wrap.append(heading(`On your pay · ${troops.length}`, 'users'));
  wrap.append(troops.length ? h('div.mu-col.mu-gap-8', null,
    h('div.mu-row.mu-wrap.mu-gap-6', null, counts.map((c) => chip(`${c.n} ${kindName(c.kind, c.n)} · ${money(c.wage)} a day`, 'gold'))),
    h('div.mu-list.mu-rul-troops.mu-scroll', null, troops.slice(0, 80).map((t) => troopRow(env, t)))) : line('No man is on your pay. Raise some above.'));

  // ---- the host against a hostile neighbour
  wrap.append(attackCard(env));

  // ---- any man of yours fit for the accolade
  wrap.append(dubCard(env));

  // ---- armies
  wrap.append(heading('Armies', 'flag'));
  wrap.append(armiesCard(env, mil, f?.levyPool ?? 0));
  return wrap;
}

/** "Your knights": the knights of the House, vassals and men in pay, each with Fight as him (the sim's `fightAs`). */
function knightsCard(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const paid = (realm.troops?.(me) ?? []).map((t) => t.person);
  const combat = ctx.sim.services.combat as unknown as { wounds?(p: number): unknown[] } | undefined;
  const knights = knightsOf(ctx.sim.state, me, paid, (id) => (combat?.wounds?.(id)?.length ?? 0) > 0);
  const wrap = h('div.mu-rul-knights');
  wrap.append(heading(`Your knights · ${knights.length}`, 'helm'));
  wrap.append(h('p.mu-small.mu-dim', { style: { margin: '0 0 6px' } }, 'Take a knight’s place and fight on your behalf: you play him, with his sword, his skill and his wounds, while your lord carries on. Press U as the knight (or the button at the top of the screen) to return to your lord.'));
  if (!knights.length) { wrap.append(empty('No knight serves you yet. Knight a man below, or win a knight’s fealty.')); return wrap; }
  wrap.append(h('div.mu-list.mu-scroll', null, knights.slice(0, 24).map((k) => h('div.mu-li', null,
    h('div.mu-grow', null, h('b', null, ctx.nameOf(k.id)), h('div.mu-tiny.mu-dim', null, `${k.why}${k.hurt ? ' · hurt' : ''} · at ${ctx.placeName(ctx.sim.state.persons.get(k.id)?.settlement ?? 0)}`)),
    button('Fight as him', { size: 'small', variant: 'primary', icon: 'swords', disabled: k.hurt, tip: k.hurt ? 'He is hurt and cannot fight' : `Take ${ctx.nameOf(k.id)}’s place`,
      onClick: () => {
        const r = ctx.dispatch({ type: 'fightAs', personId: k.id });
        if (r.ok) { ctx.say('quest', `You are ${ctx.nameOf(k.id)}, your lord’s knight. Press U to return to your lord.`); ctx.close(); } else env.done(r, '');
      } })))));
  return wrap;
}

/**
 * The army campaign's call (`game.campaign`, `CampaignApi` of src/ui/types.ts, wired by the war builder; absent in a base without it,
 * so it is declared loosely here and everything is guarded).
 */
export type CampaignCall = { plan(target: number, rideAs?: number): { ok: boolean; reason?: string } };
export function campaignOf(env: Pick<RulerEnv, 'ctx'>): CampaignCall | undefined { return (env.ctx.game as unknown as { campaign?: CampaignCall }).campaign; }

/** "Plan an attack": the lord raises his host against a hostile neighbour's seat and rides with it (the campaign mode of the war builder). */
export function planAttackButton(env: RulerEnv, target: number, house: string): HTMLElement | null {
  const c = campaignOf(env);
  if (!c) return null;
  return button('Plan an attack', { icon: 'swords', variant: 'danger', disabled: !env.may().realm,
    tip: env.may().realm ? `Raise your host against ${house} and ride with it` : 'Only the holder, or a steward while the lord cannot act, raises the host',
    onClick: () => env.ctx.confirm({
      title: `Plan an attack on ${env.ctx.placeName(target)}?`, text: `Your banners are raised and an army musters to march on ${house}'s seat. You ride with it.`,
      confirmLabel: 'Raise the host', cancelLabel: 'Not yet', danger: true,
      onConfirm: () => { const r = c.plan(target); if (r.ok) { env.ctx.say('info', `Your host marches on ${env.ctx.placeName(target)}.`); env.ctx.close(); } else env.done(r, ''); },
    }) });
}

/** Hostile Houses near, each with Plan an attack. */
function attackCard(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const wrap = h('div.mu-rul-attack');
  if (!campaignOf(env)) return wrap;
  const foes = realm.rivals(env.me()).filter((r) => (r.stance === 'hostile' || r.stance === 'war') && r.seat !== undefined);
  wrap.append(heading(`Hostile neighbours · ${foes.length}`, 'swords'));
  if (!foes.length) { wrap.append(line('No House near you stands against you.')); return wrap; }
  wrap.append(h('div.mu-list', null, foes.map((r) => h('div.mu-li', null,
    h('div.mu-grow', null, h('b', null, `House ${r.name}`), h('div.mu-tiny.mu-dim', null, `${r.stance === 'war' ? 'At war' : 'Hostile'} · seat ${ctx.placeName(r.seat as number)} · ${Math.round(r.distance / 100) / 10} km · strength ${Math.round(r.strength)}`)),
    planAttackButton(env, r.seat as number, `House ${r.name}`)))));
  return wrap;
}

/** "Dub a knight" for any man of the House, its oath or its lands who is fit for it, however he came to your service. */
function dubCard(env: RulerEnv): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const may = env.may();
  const wrap = h('div.mu-rul-dub');
  const list = may.realm ? realm.dubCandidates?.(me, 24) ?? [] : [];
  wrap.append(heading(`Men fit for the accolade · ${list.length}`, 'sparkle'));
  if (!may.realm) { wrap.append(line('Only the holder, or a steward while the lord cannot act, knights a man.')); return wrap; }
  if (!list.length) { wrap.append(empty('No man of your House, your oath or your lands is ready for the accolade.')); return wrap; }
  wrap.append(h('div.mu-list.mu-scroll', null, list.map((c) => h('div.mu-li', null,
    h('div.mu-grow', null, h('b', null, ctx.nameOf(c.person)), h('div.mu-tiny.mu-dim', null, `${c.career}, ${c.age} · ${c.why}${c.melee > 0 ? ` · melee ${c.melee}` : ''}`)),
    button('Dub a knight', { size: 'small', icon: 'sparkle', tip: 'The accolade: a vigil, a feast and the gift of a horse and arms', onClick: () => ctx.confirm({
      title: `Knight ${ctx.nameOf(c.person)}?`, text: 'He keeps a vigil in the church and is dubbed. His horse and armour come from his own stores, then yours, else are bought, and the vigil and the feast cost 5s. He becomes a knight of your House for life.',
      confirmLabel: 'Dub him', cancelLabel: 'Not yet', onConfirm: () => env.done(realm.dub(me, c.person), `${ctx.nameOf(c.person)} is knighted.`),
    }) })))));
  return wrap;
}

function recruitRow(env: RulerEnv, o: RecruitOption, bag: Bag): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const v = env.view();
  const max = recruitMax(o);
  const count = Math.max(1, Math.min(max || 1, bag.counts[o.kind] ?? Math.min(5, max || 1)));
  bag.counts[o.kind] = count;
  const prev = recruitPreview(o, count, v.treasury);
  const input = h<HTMLInputElement>('input.mu-input.mu-rul-count', { type: 'number', min: '1', max: String(Math.max(1, max)), value: String(count), 'aria-label': `How many ${kindName(o.kind)}` });
  const previewEl = h('div.mu-small');
  const showPreview = (n: number): void => {
    const p = recruitPreview(o, n, v.treasury);
    previewEl.replaceChildren(h('span', null, `${n} ${kindName(o.kind, n)}: fees ${money(p.fees)}${p.gear > 0 ? ` · gear to buy ${money(p.gear)}` : ' · armed from the stores'} · wages in hand ${money(p.reserve)} — `),
      h('b', { class: p.affordable ? '' : 'mu-bad' }, `${money(p.total)}`), h('span.mu-dim', null, `; then ${money(p.perDay)} a day (${money(p.perYear)} a year)`));
  };
  showPreview(count);
  input.addEventListener('input', () => { const n = Math.max(1, Math.min(Math.max(1, max), Math.floor(Number(input.value) || 1))); bag.counts[o.kind] = n; showPreview(n); });
  const go = (): void => {
    const n = Math.max(1, Math.min(Math.max(1, max), Math.floor(Number(input.value) || 1)));
    const r = realm.recruit(me, bag.settlement, o.kind, n);
    env.done(r, `${r.raised ?? n} ${kindName(o.kind, r.raised ?? n)} take your pay.`);
  };
  const gear = Object.entries(o.goods).slice(0, 5);
  return h('div.mu-card.mu-rul-rrow', { class: o.ok ? '' : 'locked' },
    h('div.mu-row.mu-between.mu-top.mu-gap-12', null,
      h('div.mu-grow', null, h('h4', null, o.label),
        h('div.mu-row.mu-wrap.mu-gap-4', null, gear.length ? gear.map(([g, q]) => goodLine(ctx.eco, g, q)) : h('span.mu-small.mu-dim', null, 'brings his own gear')),
        h('div.mu-tiny.mu-dim', { style: { marginTop: '4px' } }, `${o.available} could be raised here · fee ${money(o.pence)} · ${money(o.upkeep)} a day${o.equipped ? ` · the stores arm ${o.equipped}` : ''}${o.tech ? '' : ''}`)),
      o.ok ? h('div.mu-col.mu-gap-6', { style: { alignItems: 'flex-end' } }, h('div.mu-row.mu-gap-6', null, input, button('Raise', { variant: 'primary', icon: 'check', disabled: !prev.affordable && false, onClick: go }))) : null),
    o.ok ? previewEl : h('div.mu-small.mu-bad', null, o.reason ?? 'Not now'));
}

function troopRow(env: RulerEnv, t: RealmTroop): HTMLElement {
  const { ctx, realm } = env;
  const me = env.me();
  const may = env.may();
  return h('div.mu-li', null,
    h('div.mu-grow', null, h('b', null, ctx.nameOf(t.person)), h('div.mu-tiny.mu-dim', null, `${kindName(t.kind, 1)} · at ${ctx.placeName(t.settlement)} · ${money(t.wage)} a day`)),
    may.realm && dubbable(t) ? button('Dub a knight', { size: 'small', icon: 'sparkle', tip: 'The accolade: a vigil, a feast and the gift of a horse and arms', onClick: () => ctx.confirm({
      title: `Knight ${ctx.nameOf(t.person)}?`, text: 'He keeps a vigil in the church and is dubbed. His horse and armour come from his own stores, then yours, else are bought, and the vigil and the feast cost 5s. He becomes a knight of your House for life.',
      confirmLabel: 'Dub him', cancelLabel: 'Not yet', onConfirm: () => env.done(realm.dub(me, t.person), `${ctx.nameOf(t.person)} is knighted.`),
    }) }) : null,
    may.realm ? button('Discharge', { size: 'small', variant: 'danger', icon: 'door', onClick: () => ctx.confirm({
      title: `Send ${ctx.nameOf(t.person)} home?`, text: 'His wage stops; a knight keeps his knighthood.', confirmLabel: 'Discharge', cancelLabel: 'Keep him', danger: true,
      onConfirm: () => env.done(realm.discharge?.(me, t.person), 'He goes home.'),
    }) }) : null);
}

function armiesCard(env: RulerEnv, mil: MilitaryRuntime | undefined, levyPool: number): HTMLElement {
  const { ctx } = env;
  const v = env.view();
  const may = env.may();
  const wrap = h('div.mu-col.mu-gap-8');
  if (!mil) return h('div', null, line('No army has ever been raised in this run.'));
  const armies = (mil.armiesOf?.(v.house) ?? []).map((a) => mil.armyDetail(a.id)).filter((a): a is ArmyDetail => !!a);
  wrap.append(h('div.mu-row.mu-gap-8.mu-wrap', null,
    may.realm ? button(`Call the levy${levyPool ? ` (up to ${levyPool} men)` : ''}`, { variant: 'primary', icon: 'flag', tip: 'Raise your banners: the men of your manors answer, and an army musters', onClick: () => env.done(mil.callLevy(), 'You raise your banners.') }) : null,
    button('Command and army', { icon: 'swords', tip: 'Orders for the armies: march, besiege, raid, garrison, hold (C)', onClick: () => ctx.open({ panel: 'ext', name: 'army' }) })));
  wrap.append(armies.length ? h('div.mu-grid.c2', null, armies.map((a) => h('div.mu-card', null,
    h('div.mu-row.mu-between.mu-top', null, h('div', null, h('h4', null, `Army of ${a.houseName}`), h('div.mu-small.mu-dim', null, `${a.size} men · led by ${a.commanderName} · ${TASK[a.task] ?? a.task}${a.destination ? ` → ${a.destination}` : ''}`)),
      chip(`morale ${Math.round(a.morale * 100)}%`, a.morale > 0.55 ? 'green' : a.morale > 0.3 ? 'gold' : 'vermilion', 'heart')),
    h('div.mu-row.mu-gap-6.mu-wrap', { style: { marginTop: '8px' } },
      button('Orders…', { size: 'small', icon: 'flag', onClick: () => ctx.open({ panel: 'ext', name: 'army' }) }),
      button('Take the field', { size: 'small', icon: 'swords', tip: 'Join this army and fight in it yourself', onClick: () => env.done(mil.joinArmy(a.id), 'You take your place in the ranks.') }))))) : line('No army of yours is in the field. Call the levy to muster one, then give it orders in the command panel — or ride with it yourself.'));
  return wrap;
}
