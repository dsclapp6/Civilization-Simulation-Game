// Screenshots of the politics panel in the real game (headless Chromium): the peasant's view, then the same
// run with the player raised to a crown so the Command tab is unlocked, wars and letters on the table.
//
//   node tools/politics-shots.mjs [--seed=abc] [--size=1280x800]
//
// Saves docs/game/politics-<tab>.png. Uses the developer hooks on window.__game (src/app/game.ts).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/game');
const PORT = 5183;
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const seed = opt('seed', 'millennia');
const [W, H] = opt('size', '1280x800').split('x').map(Number);

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

const vite = (await serverUp()) ? null : await startVite();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(0);
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) console.log(`[browser error] ${m.text()}`); });

async function shot(name) {
  await page.waitForTimeout(250);
  const file = resolve(OUT, `politics-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`politics-${name}: ${Math.round(statSync(file).size / 1024)} KB`);
}
const openTab = async (tab) => {
  await page.evaluate((t) => { window.__ui.closePanel('politics'); window.__ui.open({ panel: 'ext', name: 'politics', data: { tab: t } }); }, tab);
};

try {
  await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=low&shots=1&autostart=1`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.evaluate(() => window.__game.freeze(true));
  // let the continent live for a few years so that there are wars, pacts and posts to show
  // (a day at a time, letting the autosave cycle finish in between so the calendar hooks fire as they would in play)
  await page.evaluate(async () => {
    const sim = window.__game.session.sim;
    for (let i = 0; i < 16 * 6; i++) { sim.advanceDays(1); await new Promise((r) => setTimeout(r, 15)); }
    for (let i = 0; i < 40; i++) { sim.step(0.001); await new Promise((r) => setTimeout(r, 15)); }
  });
  await openTab('standing');
  await shot('peasant-standing');
  await openTab('offices');
  await shot('peasant-offices');
  await openTab('manage');
  await shot('peasant-command');

  // raise the player to a crown (a screenshot device: the same thing happens to a successful climber)
  const who = await page.evaluate(() => {
    const s = window.__game.session; const st = s.sim.state;
    const pol = s.sim.services.politics;
    // the king of the strongest realm who has a vassal
    const kings = [...st.titles.values()].filter((t) => t.kind === 'kingdom').map((t) => st.persons.get(t.holder)).filter(Boolean);
    const king = kings.sort((a, b) => pol.strength(b.house) - pol.strength(a.house))[0];
    const old = st.persons.get(st.run.playerId);
    delete old.flags.player; king.flags.player = true; st.run.playerId = king.id; st.run.houseId = king.house;
    // some business on the table: a war against a neighbour and a letter
    const near = pol.neighbours(king.house).find((o) => pol.canDeclare(king.house, o, 'conquest').ok);
    let war = null;
    if (near) war = pol.declareWar(king.house, near, { cause: 'conquest' });
    const other = pol.neighbours(king.house).find((o) => o !== near && pol.stance(king.house, o) === 'neutral');
    s.sim.state.persons.get(king.id);
    return { king: king.first, house: king.house, near, war, other };
  });
  console.log('player is now', JSON.stringify(who));
  await page.evaluate(() => { window.__ui.closePanel('politics'); });
  for (const tab of ['standing', 'houses', 'wars', 'claims', 'offices', 'manage', 'petitions']) {
    await openTab(tab);
    await shot(`king-${tab}`);
  }
  // a baron's view: a small lord with a manor to run
  const lordInfo = await page.evaluate(() => {
    const s = window.__game.session; const st = s.sim.state;
    const t = [...st.titles.values()].find((x) => x.kind === 'manor');
    const lord = st.persons.get(t.holder);
    const old = st.persons.get(st.run.playerId);
    delete old.flags.player; lord.flags.player = true; st.run.playerId = lord.id; st.run.houseId = lord.house;
    s.sim.services.politics.setManorPolicy(lord.id, t.place, { rent: 2, justice: 'harsh' });
    return { lord: lord.first, place: t.place };
  });
  console.log('lord', JSON.stringify(lordInfo));
  await openTab('manage');
  await shot('lord-command');
  await openTab('offices');
  await shot('lord-offices');
} catch (err) {
  console.log('SHOTS ERROR', err && err.message ? err.message : err);
  process.exitCode = 1;
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid); } catch { /* already gone */ } }
}
