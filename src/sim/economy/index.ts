// The economy (wave 2): goods, markets, households, farming, work, careers, obligations and perks.
// `installEconomy(sim, { social })` registers the macro systems on the scheduler, the action
// providers on `sim.actions`, the dialogue topics on the social system, and returns the API the UI,
// the player controller, social and the agents use. Everything works headless.
import type { Simulation } from '../sim';
import type { PriceTip, SocialApi } from '../social/types';
import { Econ } from './core';
import { PERK_BY_ID, GOODS, GOOD_LIST, ENTRY_TESTS, MACRO_INDEX, basePriceOf, describeItem } from './data';
import { holdingsDaily, holding, householdPlan, ledger, listingsAt, buyOrRent, setTask, hire, dismiss, stackList } from './holdings';
import { applyForJob, careerPaths, employmentDaily, employmentOf, jobsAt, quitJob, workSpot } from './jobs';
import { bagWeight, bagTake, bagAdd, bagGet } from './items';
import { apiPrice, doTrade, marketView, partnerLines, quoteTrade } from './market';
import { clothingStatus, consume, playerHour, seasonalNeeds } from './needs';
import { attachObligationEvents, obligationsDaily, obligationsOf } from './obligations';
import { addOwned, capacityOf, ownedQty, takeOwned, weightOf, canCarry } from './own';
import { announcePerkChoices, choosePerk, openChoices } from './perks';
import { initFresh, registerSystems } from './systems';
import { cartsHourly, deliveriesOf, procureGoods, sellGoods, stockAtMarket } from './trade-house';
import { FloatFeed } from './floatfeed';
import { PropFeed } from './propfeed';
import { StripFeed } from './stripfeed';
import { economyTopics } from './topics';
import { craftProvider } from './work-craft';
import { farmProvider } from './work-farm';
import { miscProvider, stockProvider } from './work-misc';
import { giveKit } from './macro';
import { attachConstructionEvents } from './supply';
import { goodOf } from './data';
import type { PersonId } from '../state';
import type { EconomyApi, EquipSlot, InventoryView, ItemKey, ItemStack, Result } from './types';
import { parseItemKey } from './types';

export interface EconomyDeps { social: SocialApi }

/** The API plus the runtime, for tools, tests and the dev pages. */
export interface EconomyRuntime extends EconomyApi {
  /** Throws goods away (the inventory's Drop button); `give(person, 0, key, qty)` does the same. */
  drop(person: PersonId, key: ItemKey | 'money', qty: number): Result;
  readonly econ: Econ;
  /** The floating texts of the player's gains (view source `drainFloaters`); tests and tools can drive its clock. */
  readonly floaters: FloatFeed;
  /** Removes every system, provider, topic and listener the economy installed. */
  dispose(): void;
}

export function installEconomy(sim: Simulation, deps: EconomyDeps): EconomyRuntime {
  const E = new Econ(sim, deps.social);
  if (E.save.init === 0) initFresh(E);

  const offs: Array<() => void> = [];
  offs.push(registerSystems(E, sim.scheduler, {
    hourly: [playerHour, cartsHourly],
    daily: [employmentDaily, obligationsDaily, holdingsDaily],
    seasonal: [seasonalNeeds],
    yearly: [],
  }));
  offs.push(sim.actions.register(farmProvider(E)));
  offs.push(sim.actions.register(craftProvider(E)));
  offs.push(sim.actions.register(stockProvider(E)));
  offs.push(sim.actions.register(miscProvider(E)));
  offs.push(deps.social.registerTopic(economyTopics(E)));
  offs.push(attachObligationEvents(E));
  offs.push(attachConstructionEvents(E));
  offs.push(announcePerkChoices(E));
  offs.push(sim.events.on('playerSwitched', (e) => {
    const np = E.person(e.to);
    if (np) giveKit(E, np);
  }));

  // the view's strip work (ploughing, sowing, reaping… in progress, by the player or the household farm)
  const stripFeed = new StripFeed(E);
  sim.view.setSource('stripWork', () => stripFeed.list());
  sim.view.setSource('stripWorkVersion', () => stripFeed.version());
  offs.push(() => { sim.view.setSource('stripWork', undefined); sim.view.setSource('stripWorkVersion', undefined); });
  // and its world props: stooks, hay cocks, woodpiles, sacks, stone, stumps and logs
  const propFeed = new PropFeed(E);
  sim.view.setSource('worldProps', () => propFeed.list());
  sim.view.setSource('worldPropsVersion', () => propFeed.version());
  offs.push(() => { sim.view.setSource('worldProps', undefined); sim.view.setSource('worldPropsVersion', undefined); });

  // and floating texts for what the player's actions and trades bring
  const floatFeed = new FloatFeed(E);
  sim.view.setSource('drainFloaters', () => floatFeed.drain());
  offs.push(() => { sim.view.setSource('drainFloaters', undefined); floatFeed.dispose(); });

  const noPerson: Result = { ok: false, reason: 'Nobody there' };

  /** Throws goods (or coins) away: they leave the pack and are gone. Whatever is no longer carried is also taken off the body. */
  const dropGoods = (person: PersonId, key: ItemKey | 'money', qty: number): Result => {
    const p = E.person(person);
    if (!p || p.death) return noPerson;
    if (!(qty > 0)) return { ok: false, reason: 'Drop something' };
    if (key === 'money') {
      if (p.money + 1e-9 < qty) return { ok: false, reason: 'You do not have that much' };
      p.money = Math.round((p.money - qty) * 100) / 100;
      E.state.touch(p);
      return { ok: true };
    }
    if (!goodOf(key)) return { ok: false, reason: 'No such item' };
    if (goodOf(key)?.category === 'livestock') return { ok: false, reason: 'Animals are not carried: sell them or leave them with the household' };
    if (!bagTake(p.inventory, key, qty)) return { ok: false, reason: 'You do not carry that much' };
    if (bagGet(p.inventory, key) <= 0) {
      const eq = E.save.eq[String(person)];
      if (eq) {
        let changed = false;
        for (const slot of Object.keys(eq) as EquipSlot[]) if (eq[slot] === key) { delete eq[slot]; changed = true; }
        if (changed) E.touchSave();
      }
    }
    E.state.touch(p);
    return { ok: true };
  };

  const api: EconomyRuntime = {
    econ: E,
    floaters: floatFeed,
    dispose() { for (const o of offs.splice(0)) o(); },

    // ---- goods ----
    goods: () => GOOD_LIST,
    good: (id) => GOODS[id],
    describe: (key, qty) => describeItem(key, qty),

    // ---- inventories ----
    inventory(person): InventoryView {
      const p = E.person(person);
      if (!p) return { owner: person, items: [], money: 0, weight: 0, capacity: 0, equipment: {} };
      const eq: Partial<Record<EquipSlot, ItemKey>> = {};
      const saved = E.save.eq[String(person)];
      if (saved) for (const [slot, key] of Object.entries(saved)) if (key && (p.inventory[key] ?? 0) > 0) eq[slot as EquipSlot] = key;
      return { owner: person, items: stackList(E, p.inventory, p.settlement), money: p.money, weight: bagWeight(p.inventory), capacity: capacityOf(p), equipment: eq };
    },
    stores(household): ItemStack[] {
      const hh = E.household(household);
      return hh ? stackList(E, hh.stores, hh.settlement) : [];
    },
    stash(person, key, qty): Result {
      const p = E.person(person);
      const hh = p ? E.hhOf(p) : undefined;
      if (!p || !hh) return noPerson;
      if (key === 'money') {
        if (qty > 0) { if (p.money + 1e-9 < qty) return { ok: false, reason: 'You do not have that much' }; p.money = Math.round((p.money - qty) * 100) / 100; hh.purse = Math.round((hh.purse + qty) * 100) / 100; }
        else { if (hh.head !== p.id) return { ok: false, reason: 'Only the head draws on the household purse' }; const q = -qty; if (hh.purse + 1e-9 < q) return { ok: false, reason: 'The purse holds less' }; hh.purse = Math.round((hh.purse - q) * 100) / 100; p.money = Math.round((p.money + q) * 100) / 100; }
        E.state.touch(p); E.state.touchHousehold(hh);
        return { ok: true };
      }
      if (goodOf(key)?.category === 'livestock') return { ok: false, reason: 'Animals are kept, not carried' };
      if (qty > 0) {
        if (!bagTake(p.inventory, key, qty)) return { ok: false, reason: 'You do not carry that much' };
        bagAdd(hh.stores, key, qty);
      } else {
        const q = -qty;
        if (!canCarry(p, weightOf(key, q))) return { ok: false, reason: `Too heavy to carry (you can bear ${capacityOf(p)} kg)` };
        if (!bagTake(hh.stores, key, q)) return { ok: false, reason: 'The stores hold less' };
        bagAdd(p.inventory, key, q);
      }
      E.state.touch(p); E.state.touchHousehold(hh);
      return { ok: true };
    },
    equip(person, slot, key): Result {
      const p = E.person(person);
      if (!p) return noPerson;
      const k = String(person);
      const cur = E.save.eq[k] ?? (E.save.eq[k] = {});
      if (key === null) { delete cur[slot]; E.touchSave(); return { ok: true }; }
      const def = goodOf(key);
      if (!def) return { ok: false, reason: 'No such item' };
      if (ownedQty(E, p, key) <= 0) return { ok: false, reason: 'You do not have that' };
      const fits = def.slot === slot || (slot === 'main' && !!def.held) || (slot === 'off' && def.slot === 'off');
      if (!fits) return { ok: false, reason: `That does not go in the ${slot} slot` };
      cur[slot] = key;
      E.touchSave();
      return { ok: true };
    },
    consume(person, key, qty = 1): Result {
      const p = E.person(person);
      return p ? consume(E, p, key, qty) : noPerson;
    },
    drop: dropGoods,
    give(from, to, key, qty): Result {
      // "to nobody" is the inventory's Drop button
      if (to === 0) return dropGoods(from, key, qty);
      const a = E.person(from), b = E.person(to);
      if (!a || !b || b.death) return noPerson;
      if (qty <= 0) return { ok: false, reason: 'Give something' };
      if (key === 'money') {
        if (a.money + 1e-9 < qty) return { ok: false, reason: 'You do not have that much' };
        a.money = Math.round((a.money - qty) * 100) / 100;
        b.money = Math.round((b.money + qty) * 100) / 100;
        E.state.touch(a); E.state.touch(b);
        const hh = E.hhOf(a);
        if (hh) E.ledgerLine(hh.id, `A gift to ${b.first}`, -qty);
        if (qty >= 1) E.social.adjustOpinion(to, from, Math.min(8, Math.ceil(qty / 6)), 'a gift');
        return { ok: true };
      }
      if (ownedQty(E, a, key) + 1e-9 < qty) return { ok: false, reason: 'You do not have that' };
      if (E.isPlayer(to) && !canCarry(b, weightOf(key, qty))) return { ok: false, reason: 'They cannot carry it' };
      takeOwned(E, a, key, qty);
      addOwned(E, b, key, qty);
      const worth = (goodOf(key)?.basePrice ?? 0) * qty;
      if (worth >= 0.5) E.social.adjustOpinion(to, from, Math.min(8, Math.ceil(worth / 6)), 'a gift');
      return { ok: true };
    },

    // ---- markets and trade ----
    market: (settlement) => marketView(E, settlement, E.person(E.playerId) ?? null),
    price: (settlement, key, side) => apiPrice(E, settlement, key, side),
    partnerStock: (partner, actor) => partnerLines(E, partner, E.person(actor) ?? null),
    quote: (actor, partner, lines) => quoteTrade(E, actor, partner, lines),
    trade: (actor, partner, lines) => doTrade(E, actor, partner, lines),

    // ---- work and careers ----
    jobs: (settlement, forPerson) => jobsAt(E, settlement, forPerson),
    applyForJob: (person, jobId) => applyForJob(E, person, jobId),
    quitJob: (person) => quitJob(E, person),
    employment: (person) => employmentOf(E, person),
    careerPaths: (person) => careerPaths(E, person),
    entryTests: () => ENTRY_TESTS,
    workSpot: (person, absDay) => workSpot(E, person, absDay),

    // ---- land, property, obligations ----
    holding: (household) => holding(E, household),
    listings: (settlement, forPerson) => listingsAt(E, settlement, forPerson),
    buyOrRent: (person, listingId, mode) => buyOrRent(E, person, listingId, mode),
    obligations: (person) => obligationsOf(E, person),
    ledger: (household) => ledger(E, household),

    // ---- household management ----
    householdPlan: (household) => householdPlan(E, household),
    setTask: (head, member, task) => setTask(E, head, member, task),
    hire: (employer, worker, wage, task) => hire(E, employer, worker, wage, task),
    dismiss: (employer, worker) => dismiss(E, employer, worker),

    // ---- household trade (civilization pass): construction's materials and the steward's trade orders ----
    procure: (household, good, qty, opts) => procureGoods(E, household, good, qty, opts),
    sell: (household, good, qty, opts) => sellGoods(E, household, good, qty, opts),
    deliveries: (household) => deliveriesOf(E, household),
    stockAt: (settlement, good) => stockAtMarket(E, settlement, good),

    // ---- skills and perks ----
    perk: (id) => PERK_BY_ID.get(id),
    perkChoices: (person) => { const p = E.person(person); return p ? openChoices(p) : []; },
    choosePerk: (person, perkId) => { const p = E.person(person); return p ? choosePerk(E, p, perkId) : noPerson; },
  };
  // ---- links into the social system (docs/SOCIAL.md) ----
  deps.social.setHooks?.({
    giveHook: (from, to, key, qty) => api.give(from, to, key as ItemKey | 'money', qty),
    itemInfoHook: (key) => {
      if (key === 'money') return { name: 'coin', value: 1 };
      const g = goodOf(key);
      return g ? { name: describeItem(key), value: basePriceOf(key) } : null;
    },
    priceTipsHook: (settlement) => {
      const mid = E.marketFor(settlement);
      const view = mid >= 0 ? marketView(E, mid, null) : null;
      if (!view) return [];
      const tips: PriceTip[] = [];
      for (const l of view.lines) {
        if (MACRO_INDEX[parseItemKey(l.key).good] === undefined || Math.abs(l.trend) < 0.15) continue;
        tips.push({ good: parseItemKey(l.key).good, trend: l.trend, price: l.buy });
      }
      return tips;
    },
    dressTierHook: (person) => {
      const p = E.person(person);
      if (!p) return 1;
      // only the player's clothes are modelled; everyone else dresses to their rank
      if (!E.save.eq[String(person)]) return p.rankTier;
      const status = clothingStatus(E, p);
      return Math.max(1, Math.min(8, Math.round(1 + status * 1.4)));
    },
    apprenticeHook: (youth, master, dryRun) => {
      const y = E.person(youth), m = E.person(master);
      if (!y || !m || y.death || m.death) return noPerson;
      const job = jobsAt(E, m.settlement, youth).find((j) => j.employer === master && j.terms === 'apprenticeship');
      if (!job) return { ok: false, reason: `${m.first} takes no apprentices just now` };
      const premium = job.premium ?? 0;
      const lacking = job.requirements.find((r) => !r.met && !/premium|leave/i.test(r.label));
      if (lacking) return { ok: false, reason: lacking.label, premium };
      if (dryRun) return { ok: true, premium };
      if (!E.isPlayer(youth) && premium > 0) {
        // the youth's family pays the master out of its purse
        const hh = E.hhOf(y);
        if (!hh || hh.purse + 1e-9 < premium) return { ok: false, reason: 'The family cannot pay the premium', premium };
        E.debit(hh, premium);
      }
      const r = applyForJob(E, youth, job.id, { premiumPaid: !E.isPlayer(youth) });
      return { ...r, premium };
    },
  });

  return api;
}

export type { EconomyApi } from './types';
