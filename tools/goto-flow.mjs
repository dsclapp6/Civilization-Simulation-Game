// Flow check of "Go to…" (H1) in the real game, headless Chromium: breath comes back quickly after a sprint, ; opens the page,
// searching, "Go to the smithy" skips the walk (the clock moves on by the walking time and you stand at the door), the refusals
// (a fight near), the journal's "Go now"; and the castle scenario's march skipped (the host camped before the walls). With
// --shots=DIR it also writes the screenshots (the page, the arrival, the camp).
//
//   node tools/goto-flow.mjs [--seed=abc] [--port=5291] [--shots=/tmp/dir]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const PORT = Number(opt('port', 5291));
const seed = opt('seed', 'millennia');
const SHOTS = opt('shots', '');
const ONLY = opt('only', ''); // 'host': just the host's part
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

async function serverUp() { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } }
function startVite() {
  return new Promise((res, rej) => {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' }, detached: true });
    let done = false;
    proc.stdout.on('data', (d) => { if (!done && /Local:|ready in/i.test(d.toString())) { done = true; res(proc); } });
    proc.on('exit', (c) => { if (!done) rej(new Error(`vite exited (${c})`)); });
    setTimeout(() => { if (!done) { done = true; res(proc); } }, 25000);
  });
}
let vite = null;
if (await serverUp()) throw new Error(`port ${PORT} is busy: pass --port=<free port> (a server on it may be another worktree's)`);
vite = await startVite();

const browser = await chromium.launch();
let page = null;
const errors = [];
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };
const note = (s) => console.log(`     ${s}`);
const tick = (s) => page.evaluate((n) => window.__game.tick(n), s);
const ev = (fn, arg) => page.evaluate(fn, arg);
const panels = () => page.evaluate(() => window.__ui.openPanels());

async function load(extra) {
  if (!(await serverUp())) vite = await startVite(); // (another builder's cleanup may have taken the server)
  if (page) { try { await page.close(); } catch { /* gone */ } }
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=low&shots=1&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
}
async function shot(name) {
  if (!SHOTS) return;
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__game.draw()); await page.waitForTimeout(60); }
  await page.screenshot({ path: resolve(SHOTS, `h1-${name}.png`) });
}
/** Runs whole frames until the clock's skip is over (the walk passing), at most `max` seconds of frames. */
async function runSkip(max = 120) {
  for (let i = 0; i < max * 4; i++) {
    const on = await ev(() => { window.__game.tick(0.25); return !!window.__game.session.sim.clock.skip; });
    if (!on && i > 1) return true;
  }
  return false;
}

try {
  // ---- breath after a sprint
  if (ONLY !== 'host') {
  await load('autostart=1&time=0.42');
  // (the flow's own steps move the world; the real-time loop would draw every frame in software GL and take gigabytes)
  await ev(() => window.__game.freeze(true));
  await ev(() => window.__game.host.setSettings({ labels: false }));
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  let ex = false, maxSt = 0;
  for (let i = 0; i < 40 && !ex; i++) { await tick(0.5); const h = await ev(() => window.__game.session.services.player.hud()); maxSt = h.maxStamina; ex = h.stamina < h.maxStamina * 0.2; }
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  check('a long sprint runs the wind down', ex);
  await tick(3.5);
  const rest = await ev(() => window.__game.session.services.player.hud());
  check('a few seconds standing and the breath is back to the best part of the pool', rest.stamina > maxSt * 0.5, `${rest.stamina}/${rest.maxStamina}`);

  // ---- the page
  await tick(0.3);
  await page.keyboard.press('Semicolon');
  await tick(0.3);
  check('; opens Go to…', (await panels()).join() === 'goto', (await panels()).join());
  const names = await page.locator('.mu-prow-name').allTextContents();
  check('it lists Home and the village by what they are', names.includes('Home') && names.length >= 4, names.join(' | '));
  check('and the page groups them', (await page.locator('.mu-jhead').allTextContents()).join('|').includes('Home'));
  await shot('goto-page');
  await page.locator('input[type=search]').fill('smithy');
  await tick(0.2);
  const found = await page.locator('.mu-prow-name').allTextContents();
  check('searching narrows to the smithy', found.length === 1 && /smithy/i.test(found[0]), found.join(' | '));
  const sub = await page.locator('.mu-prow-sub').first().textContent();
  console.log(`     smithy row: ${sub}`);

  // ---- go
  const target = await ev(() => { const g = window.__game.session.services.goto; const p = g.places().find((q) => /smithy/i.test(q.name)); return p ? { id: p.id, x: p.stand.x, z: p.stand.z } : null; });
  const day0 = await ev(() => window.__game.session.sim.absDay);
  const b0 = await ev(() => ({ ...window.__game.session.services.player.body() }));
  await page.locator('.mu-prow button').first().click();
  await tick(0.1);
  check('choosing it closes the page', (await panels()).length === 0);
  const done = await runSkip();
  check('the walk passes and ends', done);
  const day1 = await ev(() => window.__game.session.sim.absDay);
  const b1 = await ev(() => ({ ...window.__game.session.services.player.body() }));
  const walk = Math.hypot(b1.x - b0.x, b1.z - b0.z);
  console.log(`     ${walk.toFixed(0)} m, ${((day1 - day0) * 24 * 60).toFixed(0)} game minutes passed`);
  check('the clock moved on by about the walking time', day1 - day0 > 0.003, `${day1 - day0}`);
  check('and you stand at the smithy door', Math.hypot(b1.x - target.x, b1.z - target.z) < 4, `${Math.hypot(b1.x - target.x, b1.z - target.z)} m`);
  await tick(0.5);
  await ev(() => { const g = window.__game; const r = g.session.renderer; r.orbit(0, 0); });
  await shot('goto-arrival');

  // ---- the refusals
  await ev(() => { window.__game.session.sim.hostileNear = () => true; });
  await page.keyboard.press('Semicolon');
  await tick(0.3);
  const disabled = await page.locator('.mu-prow button:disabled').count();
  const total = await page.locator('.mu-prow button').count();
  check('with a fight near every Go is refused, with the reason', disabled === total && total > 0 && /fight|hostile/i.test(await page.locator('.mu-prow-sub').nth(1).textContent()), `${disabled}/${total}`);
  await page.keyboard.press('Escape');
  await tick(0.3);
  await ev(() => { window.__game.session.sim.hostileNear = () => false; });

  // ---- J4: a short hop takes the walk's own time, not a floor
  {
    const hop = await ev(() => {
      const se = window.__game.session, p = se.services.player, g = se.services.goto;
      const places = g.places().filter((q) => q.kind === 'building');
      const target = places.sort((a, b) => Math.hypot(a.stand.x - p.body().x, a.stand.z - p.body().z) - Math.hypot(b.stand.x - p.body().x, b.stand.z - p.body().z))[1] ?? places[0];
      // stand 30 m from its door, on the side away from the building
      const bx = target.x, bz = target.z; const dx = target.stand.x - bx, dz = target.stand.z - bz, d = Math.hypot(dx, dz) || 1;
      p.placeAt(target.stand.x + (dx / d) * 30, target.stand.z + (dz / d) * 30, 0);
      se.zone && window.__game.tick(0.3);
      const c = g.check(target);
      return { id: target.id, name: target.name, ok: c.ok, seconds: c.seconds, metres: c.metres, reason: c.reason };
    });
    note(`hop: ${JSON.stringify(hop)}`);
    check('a 30 m hop is allowed and counts the walk, not a floor of 20 s', hop.ok && hop.seconds < 18 && hop.seconds > 6, JSON.stringify(hop));
    const d0 = await ev(() => window.__game.session.sim.absDay);
    await ev((id) => { const g = window.__game.session.services.goto; return g.go(g.places().find((q) => q.id === id)); }, hop.id);
    for (let i = 0; i < 20 && !(await ev(() => !!window.__game.session.sim.clock.skip)); i++) await tick(0.1);
    await runSkip();
    const d1 = await ev(() => window.__game.session.sim.absDay);
    const bodySeconds = (d1 - d0) * 1800;
    check('and the clock moved by about the walk (not 16 minutes)', bodySeconds > 5 && bodySeconds < hop.seconds + 10, `${bodySeconds.toFixed(1)} s for a walk of ${hop.seconds.toFixed(1)} s`);
  }

  // ---- J4: the people who follow you and the animals you lead come along
  {
    // (first, if the household keeps no beast that can be led, we become a person of one that does: the same switch as the game's)
    await ev(() => {
      const se = window.__game.session, z = se.services.zone, sim = se.sim;
      const pid = sim.state.run.playerId;
      const me = sim.state.persons.get(pid);
      const tame = [...z.animals()].filter((a) => !a.wild && !a.hostile && !a.summoned && a.owner && !/chicken|goose|duck|hen|bird/.test(String(a.kind)));
      if (tame.some((a) => a.owner === me.household)) return;
      const beast = tame[0];
      const hh = beast ? sim.state.households.get(beast.owner) : null;
      const who = hh ? [hh.head, ...hh.members].find((id) => { const q = sim.state.persons.get(id); return q && !q.death && id !== pid; }) : 0;
      if (who) sim.dispatch({ type: 'switchCharacter', personId: who });
    });
    await tick(1);
    const setup = await ev(() => {
      const se = window.__game.session, z = se.services.zone, p = se.services.player, sim = se.sim;
      const pid = sim.state.run.playerId;
      const b = p.body();
      const me = sim.state.persons.get(pid);
      const mine = [...z.animals()].filter((a) => !a.wild && !a.hostile && !a.summoned && a.owner === me.household && !/chicken|goose|duck|hen|bird/.test(String(a.kind)));
      let led = null;
      for (const a of mine) {
        // bring the animal to the player, then take it on the halter (the verb of the wheel: Lead)
        a.x = b.x + 1.5; a.z = b.z + 1.5;
        const r = z.leadAnimal(a.id, pid);
        if (r.ok) { led = a.id; break; }
        (window.__ledWhy ??= []).push(`${a.kind}:${r.reason}`);
      }
      const folk = [...z.agents()].filter((a) => a.visible && a.personId !== pid && !a.summoned).sort((a, c) => Math.hypot(a.x - b.x, a.z - b.z) - Math.hypot(c.x - b.x, c.z - b.z))[0];
      if (folk) z.command(folk.personId, { kind: 'follow', leader: pid, distance: 3 });
      return { led, why: window.__ledWhy ?? [], mineCount: mine.length, folk: folk ? folk.personId : null };
    });
    note(`followers: ${JSON.stringify(setup)}`);
    check('a villager follows the player (the zone\'s follow order)', setup.folk !== null);
    await tick(0.5);
    const far = await ev(() => {
      const se = window.__game.session, g = se.services.goto, p = se.services.player;
      const b = p.body();
      const cands = g.places().filter((q) => q.kind === 'building' && Math.hypot(q.stand.x - b.x, q.stand.z - b.z) > 60).sort((a, c) => Math.hypot(a.stand.x - b.x, a.stand.z - b.z) - Math.hypot(c.stand.x - b.x, c.stand.z - b.z));
      const t = cands[0];
      return t ? { id: t.id, name: t.name, x: t.stand.x, z: t.stand.z } : null;
    });
    check('a far place to go to', !!far);
    const r = await ev((id) => { const g = window.__game.session.services.goto; return g.go(g.places().find((q) => q.id === id)); }, far.id);
    check('Go is allowed with a follower and a led animal', r.ok, JSON.stringify(r));
    await runSkip(200);
    await tick(0.6);
    const after = await ev(([folkId, ledId]) => {
      const se = window.__game.session, z = se.services.zone, p = se.services.player;
      const b = p.body();
      const f = folkId ? z.agent(folkId) : null;
      const an = ledId !== null ? (z.ledBy(se.sim.state.run.playerId)[0] ?? null) : null;
      return {
        folk: f ? { d: Math.hypot(f.x - b.x, f.z - b.z), control: f.control, order: f.order ? f.order.kind : null } : null,
        animal: an ? { d: Math.hypot(an.x - b.x, an.z - b.z), led: z.ledBy(se.sim.state.run.playerId).length > 0 } : { led: false, led0: ledId },
      };
    }, [setup.folk, setup.led]);
    note(`after: ${JSON.stringify(after)}`);
    check('the follower arrives with the player and keeps following', !!after.folk && after.folk.d < 12 && after.folk.order === 'follow', JSON.stringify(after.folk));
    if (setup.led !== null) check('the led animal is brought up behind and is still led', !!after.animal && after.animal.d < 12 && after.animal.led, JSON.stringify(after.animal));
    else console.log(`     (no animal of the household stands in the zone to lead: ${setup.mineCount} found; the led-animal path is covered by tests/app/goto.test.ts)`);
    await ev(() => { const se = window.__game.session; se.services.zone.fauna?.unleadAll?.(se.sim.state.run.playerId); });
  }

  // ---- J4: what you know — a far village is not a place you know until you have been there or been told
  {
    const k = await ev(() => {
      const se = window.__game.session, sim = se.sim, g = se.services.goto;
      const me = sim.state.persons.get(sim.state.run.playerId);
      const home = sim.world.settlements.find((s) => s.id === me.settlement);
      const far = sim.world.settlements.filter((s) => s.id !== me.settlement && (s.kind === 'village' || s.kind === 'hamlet' || s.kind === 'town'))
        .map((s) => ({ s, d: Math.hypot(s.x - home.x, s.z - home.z) })).filter((q) => q.d > 1700 && q.d < 4400).sort((a, b) => a.d - b.d)[0];
      if (!far) return null;
      const listed = () => g.places().some((p) => p.id === `t${far.s.id}`);
      const before = listed();
      const ext0 = sim.state.ext.goto ?? null;
      // a traveller's tale (the sim's own news about the place), as it reaches the player
      sim.events.emit('news', { id: 99999, kind: 'test', house: 0, settlement: far.s.id, text: 'tale', threat: 0 });
      return { name: far.s.name, before, after: listed(), saved: (sim.state.ext.goto?.seen ?? []).includes(far.s.id), ext0 };
    });
    if (k) {
      note(`known: ${JSON.stringify(k)}`);
      check('a far village is not listed until you have been told of it; then it is, and the record is saved', k.before === false && k.after === true && k.saved === true, JSON.stringify(k));
    } else console.log('     (no village 1.7-4.4 km away in this world: the known-places record is covered by tests/app/goto.test.ts)');
  }

  // ---- J4: "Go there now" on a far building in the action wheel (the provider's own option, performed as the wheel does)
  {
    const w = await ev(() => {
      const se = window.__game.session, sim = se.sim, p = se.services.player, pid = sim.state.run.playerId;
      const b = p.body();
      const g = se.services.goto;
      const listed = new Set(g.places().map((q) => q.ref));
      const me = sim.state.persons.get(pid);
      const cand = [...sim.state.buildings.values()].filter((q) => q.settlement === me.settlement && q.construction >= 1 && Math.hypot(q.x - b.x, q.z - b.z) > 65 && Math.hypot(q.x - b.x, q.z - b.z) < 400)
        .sort((x, y) => Number(listed.has(x.id)) - Number(listed.has(y.id)))[0];
      if (!cand) return null;
      const opts = sim.actions.list(pid, { kind: 'building', id: cand.id });
      const o = opts.find((q) => q.id === 'goto');
      return o ? { id: cand.id, kind: cand.kind, listed: listed.has(cand.id), enabled: o.enabled, preview: o.preview ?? '', label: o.label } : { id: cand.id, kind: cand.kind, none: true };
    });
    note(`wheel: ${JSON.stringify(w)}`);
    check('the wheel offers "Go there now" on a far building (even one that is not on the page)', !!w && !w.none && w.enabled && w.label === 'Go there now', JSON.stringify(w));
    if (w && !w.none) {
      const d0 = await ev(() => window.__game.session.sim.absDay);
      await ev((id) => { const se = window.__game.session; const o = se.sim.actions.list(se.sim.state.run.playerId, { kind: 'building', id }).find((q) => q.id === 'goto'); const r = se.services.player.perform(o); window.__wr = r; return r; }, w.id);
      note('perform: ' + JSON.stringify(await ev(() => window.__wr)));
      for (let i = 0; i < 60 && !(await ev(() => !!window.__game.session.sim.clock.skip)); i++) await tick(0.2);
      const done = await runSkip(400);
      const at = await ev((id) => { const se = window.__game.session; const b = se.services.player.body(); const bd = se.sim.state.buildings.get(id); return Math.hypot(bd.x - b.x, bd.z - b.z); }, w.id);
      check('performing it skips the walk and you stand at that building', done && at < 14, `${at.toFixed(1)} m`);
    }
  }

  // ---- the journal's Go now
  await page.keyboard.press('KeyO');
  await tick(0.3);
  await page.locator('.mu-tab', { hasText: 'Places' }).click();
  await tick(0.2);
  const goNow = await page.locator('button', { hasText: 'Go now' }).count();
  check('the journal\'s places carry a Go now beside Find', goNow >= 2, String(goNow));
  await page.keyboard.press('Escape');
  await tick(0.3);

  }
  // ---- the host
  await load('scenario=castle');
  await ev(() => window.__game.tick(0.3));
  const phase = await ev(() => {
    const g = window.__game;
    for (let i = 0; i < 600; i++) { g.tick(1); if (g.session.sim.clock.skip) continue; const p = g.session.services.campaign?.phase(); if (p === 'before' || p === 'camp' || p === 'storm') return p; }
    return g.session.services.campaign?.phase() ?? 'none';
  });
  check('riding with the host: the march is skipped and you are at its camp before the walls (or the storm)', phase === 'before' || phase === 'camp' || phase === 'storm', phase);
  await tick(1);
  await shot('host-camp');
} catch (e) {
  console.log('FLOW ERROR', e.message);
  failures++;
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
if (errors.length) { console.log(`\n${errors.length} page errors:`); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); failures++; }
console.log(failures ? `\n${failures} failure(s)` : '\nall goto flow checks passed');
process.exit(failures ? 1 : 0);
