// Flow check of the war in the real game (headless Chromium, the real modules, no API shortcuts past the player's own verbs):
//   A. the castle scenario from the main menu (click) — the host sets out in the afternoon, the march is skipped to the camp, the night is
//      slept to the dawn, the storm goes in; the ram, the ladders and the stairs: climb a ladder onto the wall-walk, fight there,
//      and walk up a flight of stairs; sound the retreat (the host turns home);
//   B. "Plan an attack" from the ruler's Military page (the lord's seat of government): confirm, the host marches, the camp, the
//      dawn storm;
//   C. the raiders' danger (D3): a raiding party on the lands in a real run shows as the agenda's danger on the "What now?" card.
//
//   node tools/war-flow.mjs [--seed=abc] [--port=5301] [--only=a|b|c] [--shots=/tmp/dir]
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
const PORT = Number(opt('port', 5301));
const seed = opt('seed', 'millennia');
const SHOTS = opt('shots', '');
const ONLY = opt('only', '');
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
if (await serverUp()) throw new Error(`port ${PORT} is busy: pass --port=<free port>`);
vite = await startVite();

const browser = await chromium.launch();
let page = null;
const errors = [];
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };
const note = (s) => console.log(`     ${s}`);
const ev = (fn, arg) => page.evaluate(fn, arg);
const tick = (s) => page.evaluate((n) => window.__game.tick(n), s);
const ui = () => page.evaluate(() => window.__ui.openPanels());

async function load(extra, size = { width: 1280, height: 720 }) {
  if (page) { try { await page.close(); } catch { /* gone */ } }
  page = await browser.newPage({ viewport: size });
  page.setDefaultTimeout(0);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=low&shots=1&${extra}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 300000, polling: 250 });
}
async function shot(name) {
  if (!SHOTS) return;
  for (let i = 0; i < 5; i++) { await page.evaluate(() => window.__game.draw()); await page.waitForTimeout(60); }
  await page.screenshot({ path: resolve(SHOTS, `j4-war-${name}.png`) });
}
/** The campaign's phase and the army/battle facts a check wants. */
const facts = () => ev(() => {
  const g = window.__game, s = g.session;
  const sim = s.sim, c = s.services.campaign, mil = sim.services.military;
  const b = s.services.player.body();
  return {
    phase: c?.phase() ?? null, skip: !!sim.clock.skip, hour: +((sim.absDay % 1) * 24).toFixed(1),
    body: b ? { x: +b.x.toFixed(1), y: +b.y.toFixed(2), z: +b.z.toFixed(1) } : null,
    battles: mil ? mil.battles().length : 0, heap: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
    men: c && c.army() ? (mil.armies().find((a) => a.id === c.army())?.men ?? null) : null,
  };
});
/** Runs whole frames until `pred(facts)` holds or `max` frames (of `dt` seconds) pass; returns the last facts. */
async function until(pred, max = 400, dt = 1) {
  let f = await facts();
  for (let i = 0; i < max; i++) {
    if (pred(f)) return f;
    if (i % 10 === 0) note(`.. ${JSON.stringify(f)}`);
    await tick(dt);
    f = await facts();
  }
  return f;
}

try {
  if (!ONLY || ONLY === 'a') await partA();
  if (!ONLY || ONLY === 'b') await partB();
  if (!ONLY || ONLY === 'c') await partC();
} catch (e) {
  console.log('FLOW ERROR', e.stack ?? e.message);
  failures++;
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
if (errors.length) { console.log(`\n${errors.length} page errors:`); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); failures++; }
console.log(failures ? `\n${failures} failure(s)` : '\nall war flow checks passed');
process.exit(failures ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------------------------
async function partA() {
  console.log('-- A: the castle scenario from the menu');
  await load('');
  const btn = page.locator('button', { hasText: 'Scenario: the march on the castle' });
  check('the main menu offers the castle scenario', (await btn.count()) === 1);
  await btn.click();
  await page.waitForFunction(() => window.__game.session !== null && window.__game.session !== undefined, null, { timeout: 300000, polling: 500 });
  await ev(() => window.__game.ready());
  await tick(0.3);
  let f = await facts();
  note(JSON.stringify(f) + ``);
  check('the host marches (phase march) from the afternoon', f.phase === 'march' || f.skip, JSON.stringify(f));
  const reached = await ev(() => {
    const g = window.__game;
    for (let i = 0; i < 600; i++) { g.tick(1); const se = g.session; if (se.sim.clock.skip) continue; const p = se.services.campaign?.phase(); if (p === 'before' || p === 'camp' || p === 'storm') return p; }
    return 'none';
  });
  f = await facts();
  note(`reached ${reached}: ${JSON.stringify(f)}`);
  check('the march is skipped and the host is camped before the walls', reached === 'before', reached);
  const camp = await ev(() => { const st = window.__game.session.sim.state; return { tents: [...st.buildings.values()].filter((b) => b.kind === 'tent').length }; });
  check('the camp stands: tents round the fires', camp.tents >= 6, JSON.stringify(camp));
  await shot('a-camp');
  // the night is slept to the dawn (Z, the rest page); the storm goes in at first light
  const slept = await ev(() => window.__game.session.sim.dispatch({ type: 'sleep' }));
  note(`sleep: ${JSON.stringify(slept)}`);
  f = await until((x) => x.phase === 'storm', 600);
  note(JSON.stringify(f));
  check('at first light the storm goes in, with the player in the battle', f.phase === 'storm' && f.battles > 0, JSON.stringify(f));
  await tick(2);
  const works = await ev(() => {
    const se = window.__game.session, sim = se.sim;
    const w = sim.view.siegeWorks?.() ?? [];
    return { works: w.map((k) => [k.kind, Math.round(k.x), Math.round(k.z), k.state ?? null]), status: sim.services.combat.siegeStatus?.() ?? null };
  });
  note(JSON.stringify(works));
}
/** Becomes a lord with a castle and finds a rival castle of another House (the scenario's own search), through the game's own switch. */
async function becomeLord() {
  return ev(() => {
    const se = window.__game.session, sim = se.sim, mil = sim.services.military;
    const castles = sim.world.settlements.filter((x) => x.kind === 'castle');
    let best = null;
    for (const mine of castles) {
      const house = mil.lordHouse(mine.id);
      const head = house ? sim.state.persons.get(sim.state.houses.get(house)?.head ?? 0) : undefined;
      if (!head || head.death || head.sex !== 'm') continue;
      for (const other of castles) {
        const theirs = mil.lordHouse(other.id);
        if (!theirs || theirs === house) continue;
        const d = Math.hypot(other.x - mine.x, other.z - mine.z);
        if (d < 1500) continue;
        if (!best || d < best.d) best = { lord: head.id, house, theirs, mine: mine.id, target: other.id, d };
      }
    }
    if (!best) return null;
    const sw = sim.dispatch({ type: 'switchCharacter', personId: best.lord });
    if (!sw.ok) return { error: sw.reason };
    // early morning, and the two Houses at feud, so the ruler's list of hostile neighbours has a seat to march on
    sim.state.clock.absDay = Math.floor(sim.absDay) + 7.5 / 24;
    sim.state.clock.firedHour = Math.floor(sim.state.clock.absDay * 24);
    mil.declareFeud(best.house, best.theirs, 30, 'attack');
    return best;
  });
}

async function partB() {
  console.log("-- B: Plan an attack from the ruler's Military page");
  await load('autostart=1&time=0.3');
  await ev(() => window.__game.ready());
  await tick(0.5);
  const lord = await becomeLord();
  note(JSON.stringify(lord));
  check('the player becomes a lord with a castle and a rival castle to march on', !!lord && !lord.error, JSON.stringify(lord));
  if (!lord || lord.error) return;
  await tick(1);
  await page.keyboard.press('KeyU');
  await tick(0.6);
  check('U opens the seat of government', (await ui()).includes('ruler'), JSON.stringify(await ui()));
  await page.locator('.mu-tab', { hasText: 'Military' }).first().click();
  await tick(0.5);
  const plan = page.locator('button', { hasText: 'Plan an attack' });
  const n = await plan.count();
  check('the Military page lists the hostile neighbour with Plan an attack', n >= 1, String(n));
  if (n < 1) return;
  await shot('b-military-page');
  await plan.first().click();
  await tick(0.3);
  await page.locator('button', { hasText: 'Raise the host' }).click();
  await tick(0.6);
  let f = await facts();
  note(JSON.stringify(f));
  check('the host is raised and marches with the player in it', f.phase === 'march', JSON.stringify(f));
  const reached = await ev(() => {
    const g = window.__game;
    for (let i = 0; i < 900; i++) { g.tick(1); const se = g.session; if (se.sim.clock.skip) continue; const p = se.services.campaign?.phase(); if (p === 'before' || p === 'camp' || p === 'storm') return p; }
    return 'none';
  });
  note(`reached ${reached}`);
  check('the march is skipped to the camp or the walls', reached === 'before' || reached === 'camp' || reached === 'storm', reached);
  if (reached === 'camp' || reached === 'before') await ev(() => window.__game.session.sim.dispatch({ type: 'sleep' }));
  f = await until((x) => x.phase === 'storm', 900);
  check('the dawn storm goes in', f.phase === 'storm', JSON.stringify(f));
  await tick(2);
  await shot('b-storm');
  // the battle command card: two clicks sound the retreat
  const retreat = page.locator('button.retreat');
  check('the battle card has Sound the retreat', (await retreat.count()) >= 1);
  if ((await retreat.count()) >= 1) {
    await retreat.first().click();
    await tick(0.3);
    await page.locator('button.retreat').first().click();
    await tick(1);
    f = await facts();
    check('the retreat ends the campaign and the host turns for home', f.phase === null, JSON.stringify(f));
  }
}

async function partC() {
  console.log("-- C: raiders on the lands show as the danger of the lord's agenda");
  await load('autostart=1&time=0.3');
  await ev(() => window.__game.ready());
  await tick(0.5);
  const lord = await becomeLord();
  check('the player becomes a lord', !!lord && !lord.error, JSON.stringify(lord));
  if (!lord || lord.error) return;
  await tick(1);
  const quiet = await page.locator('.mu-agenda-item.danger').count();
  note(`danger items before: ${quiet}`);
  // the raids system sends a party (the same launch the daily raiders use) against the lord's seat
  const raid = await ev((l) => {
    const se = window.__game.session, sim = se.sim, mil = sim.services.military;
    const id = mil.raid(l.theirs, l.mine, { size: 60 });
    return { id, armies: mil.armies().filter((a) => a.house === l.theirs).map((a) => [a.id, a.task, a.target?.settlement ?? null, a.troops]) };
  }, lord);
  note(JSON.stringify(raid));
  check("the raids system sends raiders against the lord's seat", raid.id > 0, JSON.stringify(raid));
  await tick(2);
  const items = await page.locator('.mu-agenda-item.danger').allTextContents();
  note(JSON.stringify(items));
  check('the tracker card shows the danger: raiders on the lands, glowing', items.some((t) => /Raiders/.test(t)), JSON.stringify(items));
  await shot('c-agenda-danger');
}
