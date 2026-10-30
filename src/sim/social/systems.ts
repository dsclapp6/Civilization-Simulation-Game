// What the social system does by itself as time passes: opinions fade a little each season (every
// settlement on its own hour of its own day, like the life simulation), courtships cool when
// neglected, betrothed couples are wed on holy-day mornings, debts sour, and the parish notices who
// came to Mass. Plus listeners that keep records consistent when people die or marry.
import { isHolyDay } from '../calendar';
import type { Simulation } from '../sim';
import type { Conversations } from './conversation';
import type { SocialCore } from './core';

const CHURCH_KINDS: ReadonlySet<string> = new Set(['church', 'chapel', 'abbey_church', 'cathedral']);

export function registerSocialSystems(core: SocialCore, convs: Conversations): void {
  const sim: Simulation = core.sim;

  sim.registerSystem({
    name: 'social.hourly', phase: 'hourly', order: 40,
    run: (_ctx, info) => {
      for (const s of core.world.settlements) {
        if (s.id % 24 === info.hour && (info.day + s.id) % 4 === 0) core.opinion.decaySettlement(s.id);
      }
      if (info.hour === 10) core.courtship.weddings();
    },
  });

  sim.registerSystem({
    name: 'social.daily', phase: 'daily', order: 40,
    run: () => {
      core.courtship.daily();
      ageDebts(core);
      checkMass(core);
      prune(core);
    },
  });

  // ---- keeping records consistent ----
  sim.events.on('death', (e) => {
    if (convs.involves(e.person)) convs.endAny();
    core.courtship.forget(e.person);
    const store = core.store;
    const debts = store.read().debts;
    if (debts.some((d) => d.from === e.person || d.to === e.person)) {
      const d = store.write();
      d.debts = d.debts.filter((x) => x.from !== e.person && x.to !== e.person);
    }
  });
  sim.events.on('marriage', (e) => {
    const list = core.store.read().court;
    for (const rec of list.slice()) {
      const touches = rec.a === e.a || rec.b === e.a || rec.a === e.b || rec.b === e.b;
      const same = (rec.a === e.a && rec.b === e.b) || (rec.a === e.b && rec.b === e.a);
      if (touches && !same) core.store.removeCourt(rec);
      else if (same) core.store.removeCourt(rec);
    }
  });
  sim.events.on('playerSwitched', () => { convs.endAny(); core.barks.reset(); });
  sim.events.on('gameOver', () => convs.endAny());
  sim.events.on('inheritance', (e) => {
    const heir = core.person(e.to);
    if (heir) core.news.rumour('inherit', heir.settlement, e.to, e.from, String(e.title));
  });
}

/** Loans left unpaid sour the lender's regard, a little every few days. */
function ageDebts(core: SocialCore): void {
  const debts = core.store.read().debts;
  if (debts.length === 0) return;
  const day = core.day;
  for (const d of debts.slice()) {
    const lender = core.living(d.from), borrower = core.living(d.to);
    if (!lender || !borrower) { const w = core.store.write(); w.debts = w.debts.filter((x) => x !== d); continue; }
    const age = day - d.d;
    if (age > 8 && age % 4 === 0) core.opinion.adjust(lender.id, borrower.id, -1.5, 'overdue');
  }
}

/** The morning after a holy day: did the player go to church? The parish noticed. */
function checkMass(core: SocialCore): void {
  const st = core.state;
  if (st.run.phase !== 'alive') return;
  const player = core.living(core.playerId);
  if (!player) return;
  const y = core.day - 1;
  const rec = core.store.read().mass;
  if (y < 0 || !isHolyDay(y + 0.5) || rec.checked >= y) return;
  const w = core.store.write().mass;
  w.checked = y;
  if (core.age(player) < 7) return;
  const hasChurch = (st.buildingsAt.get(player.settlement) ?? []).some((b) => CHURCH_KINDS.has(b.kind));
  if (!hasChurch) return;
  if (w.last === y) {
    if (w.streak > 0 && w.streak % 4 === 0) {
      core.opinion.addRep(player, 'piety', 1);
      core.notify('The parish has marked your faithful attendance.', 'social');
    }
    return;
  }
  if (player.health.conditions.length > 0 || core.sim.clock.skip) return; // the sick are excused
  w.missed++;
  w.streak = 0;
  core.opinion.addRep(player, 'piety', -1);
  const priest = core.scene(player.settlement).priest;
  if (priest) core.opinion.adjust(priest.id, player.id, -1.5, 'missed_mass');
  core.notify(w.missed > 1 ? 'You have again missed Mass; folk have begun to talk.' : 'You missed Mass on the holy day.', 'warn');
  core.store.touch();
}

function prune(core: SocialCore): void {
  const d = core.store.read();
  const day = core.day;
  if (d.talk.some((t) => day - t.d > 3)) {
    const w = core.store.write();
    w.talk = w.talk.filter((t) => day - t.d <= 3);
  }
  if (d.rum.some((r) => day - r.d > 40)) {
    const w = core.store.write();
    w.rum = w.rum.filter((r) => day - r.d <= 40);
  }
  if (d.mem.some((m) => day - m.d > 200)) {
    const w = core.store.write();
    w.mem = w.mem.filter((m) => day - m.d <= 200);
  }
}
