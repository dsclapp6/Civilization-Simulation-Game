// End-to-end flow check of the real game (app + player + UI) in headless Chromium: the run-start screens, the
// loading screen, the birth reveal, the hotkeys and Esc, speed keys and their refusals, holding E for the action
// wheel, the map, a journey with encounters answered through the UI's journey panel and through the wheel,
// death and succession, and leaving to the menu and continuing where the run was left.
//
//   node tools/game-flow.mjs [--seed=abc] [--devzone]
//
// The loop is driven through `window.__game` (src/app/game.ts): `tick(seconds)` runs whole frames — real held
// keys, the UI, the simulation — without drawing, so the software renderer does not slow the checks down.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5178;
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const seed = opt('seed', 'flow');
const devzone = args.includes('--devzone');

async function serverUp() { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } }
async function serverIsOurs() {
  try { const r = await fetch(`http://localhost:${PORT}/src/app/game.ts`); return r.ok && (await r.text()).includes('__game'); } catch { return false; }
}
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
if (!(await serverUp())) vite = await startVite();
else if (!(await serverIsOurs())) throw new Error(`port ${PORT} is busy with another server`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(0);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) errors.push(m.text()); });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };
const wait = (ms = 200) => page.waitForTimeout(ms);
const tick = (s) => page.evaluate((n) => window.__game.tick(n), s);
const ui = () => page.evaluate(() => ({ panels: window.__ui.openPanels(), captures: window.__ui.capturesInput() }));
const sim = (fn) => page.evaluate(fn);
const feed = () => page.locator('.mu-feed-line').allTextContents().then((l) => l.join(' | '));

try {
  await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=low&shots=1${devzone ? '&devzone=1' : ''}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 120000, polling: 250 });
  await wait(600);

  // ---- title → run start → loading → birth reveal
  check('the title screen offers New run', (await page.locator('.mu-menu-card .mu-btn').allTextContents()).join('|').includes('New run'));
  check('no run is loaded at the menu', await sim(() => window.__game.session === null && window.__game.host.screen === 'menu'));
  await page.getByRole('button', { name: 'New run' }).click();
  await page.waitForSelector('.mu-tier');
  await page.locator('.mu-tier').nth(1).click();
  await page.getByRole('button', { name: 'Legacy shop' }).click();
  await page.waitForSelector('.mu-shop-row');
  // the world is made on the main thread, so a poll could miss the loading screen: watch the DOM instead
  await page.evaluate(() => {
    window.__sawLoading = false;
    const el = document.querySelector('.mu-loading');
    new MutationObserver(() => { if (!el.classList.contains('mu-hide')) window.__sawLoading = true; }).observe(el, { attributes: true, attributeFilter: ['class'] });
  });
  await page.getByRole('button', { name: 'Begin your life' }).click();
  const t0 = Date.now();
  await page.waitForSelector('.mu-birth', { timeout: 240000 });
  check('the loading screen appears while the world is made', await page.evaluate(() => window.__sawLoading));
  console.log(`     new run ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.evaluate(() => window.__game.freeze(true));
  let s = await ui();
  check('the birth reveal pauses the world and holds the input', s.panels.includes('birth') && s.captures && await sim(() => window.__game.session.sim.clock.paused), JSON.stringify(s));
  check('the host is on the game screen with a running session', await sim(() => window.__game.host.screen === 'game' && !!window.__game.session));
  await page.getByRole('button', { name: 'Begin your life' }).click();
  await wait(300);
  s = await ui();
  check('beginning the life resumes the world', s.panels.length === 0 && !s.captures && !(await sim(() => window.__game.session.sim.clock.paused)), JSON.stringify(s));
  await tick(0.6);

  // ---- HUD and prompt
  check('the HUD is shown', (await page.locator('.mu-hud:not(.mu-hide)').count()) === 1);
  const hud = await sim(() => { const h = window.__game.session.services.player.hud(); return { name: h.name, age: h.age, stamina: h.stamina, max: h.maxStamina }; });
  check('the player has a name, 12 years, and a full stamina pool', hud.name.length > 2 && hud.age === 12 && hud.stamina === hud.max, JSON.stringify(hud));

  // ---- real keys move the character; Shift sprints
  const p0 = await sim(() => ({ ...window.__game.session.services.player.body() }));
  await page.keyboard.down('KeyW');
  await tick(1.2);
  await page.keyboard.up('KeyW');
  const p1 = await sim(() => ({ ...window.__game.session.services.player.body() }));
  const walked = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  // (ground underfoot slows the placeholder navigation: a marshy yard halves the pace)
  check('holding W runs along the camera', walked > 1 && walked < 4.6, `walked ${walked.toFixed(2)} m`);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await tick(1.5);
  const g1 = await sim(() => window.__game.session.services.player.hud());
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  check('Shift sprints and drains stamina', g1.gait === 'sprint' && g1.stamina < g1.maxStamina - 5, `${g1.gait} ${g1.stamina}/${g1.maxStamina}`);
  await tick(0.5);

  // ---- speed keys, refusal, pause
  await page.keyboard.press('Digit2');
  await tick(0.1);
  check('2 sets 3× speed', (await sim(() => window.__game.session.sim.clock.speed)) === 3);
  await sim(() => { window.__game.session.sim.hostileNear = () => true; });
  await page.keyboard.press('Digit3');
  await tick(0.1);
  await wait(150);
  check('a refused speed key says why', (await feed()).includes('enemy is near'), await feed());
  check('the refused speed stays at 3×', (await sim(() => window.__game.session.sim.clock.speed)) === 3);
  await sim(() => { window.__game.session.sim.hostileNear = () => false; });
  await page.keyboard.press('Digit1');
  await page.keyboard.press('KeyP');
  await tick(0.1);
  check('P pauses', await sim(() => window.__game.session.sim.clock.paused));
  await page.keyboard.press('KeyP');
  await tick(0.1);
  check('P resumes', !(await sim(() => window.__game.session.sim.clock.paused)));

  // ---- hotkeys and Esc belong to the UI; the game stops reading input while a panel has it
  await page.keyboard.press('Tab');
  await tick(0.2);
  s = await ui();
  check('Tab opens the character sheet and captures input', s.panels.join() === 'character' && s.captures, JSON.stringify(s));
  const z0 = (await sim(() => window.__game.session.services.player.body())).z;
  await page.keyboard.down('KeyW');
  await tick(1);
  await page.keyboard.up('KeyW');
  const z1 = (await sim(() => window.__game.session.services.player.body())).z;
  check('W does nothing while a panel is open', Math.abs(z1 - z0) < 0.05, `${z0} -> ${z1}`);
  await page.keyboard.press('Tab');
  await tick(0.2);
  check('Tab closes it again', (await ui()).panels.length === 0);
  await page.keyboard.press('Escape');
  await tick(0.2);
  s = await ui();
  check('Esc with nothing open shows the pause menu', s.panels.join() === 'pause', JSON.stringify(s));
  await page.getByRole('button', { name: 'Resume' }).click();
  await tick(0.2);
  check('Resume closes it', (await ui()).panels.length === 0);

  // ---- hold E for the action wheel; tap E acts
  await page.keyboard.down('KeyE');
  await tick(0.6);
  await page.keyboard.up('KeyE');
  await tick(0.1);
  s = await ui();
  check('holding E opens the action wheel', s.panels.includes('actions'), JSON.stringify(s));
  check('the wheel lists the options on the target', (await page.locator('.mu-wheel-opt').count()) >= 2, String(await page.locator('.mu-wheel-opt').count()));
  await page.keyboard.press('Escape');
  await tick(0.2);
  check('Esc closes the wheel', (await ui()).panels.length === 0);

  // ---- map
  await page.keyboard.press('KeyM');
  await tick(0.3);
  s = await ui();
  const camMap = await sim(() => window.__game.session.renderer.getCameraMode());
  check('M opens the map without capturing input and puts the camera on the map', s.panels.join() === 'map' && !s.captures && camMap === 'map', JSON.stringify({ s, camMap }));
  check('the world knows the map is open (the zone goes quiet)', (await sim(() => window.__game.session.sim.view.mode())) === 'map');
  await page.keyboard.press('KeyM');
  await tick(0.3);
  check('M again closes it and returns the camera to the character', (await ui()).panels.length === 0 && (await sim(() => window.__game.session.renderer.getCameraMode())) === 'follow');

  // ---- a journey with encounters
  const dest = await sim(() => {
    const g = window.__game.session; const w = g.sim.world; const b = g.services.player.body();
    const c = w.settlements.filter((x) => { const d = Math.hypot(x.x - b.x, x.z - b.z); return d > 2500 && d < 6000; })
      .sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z))[0];
    return c.id;
  });
  const res = await page.evaluate((d) => window.__game.session.services.player.travelTo(d), dest);
  check('travelTo starts a journey at 8× in the travel view', res.ok && (await sim(() => window.__game.session.sim.clock.speed)) === 8 && (await sim(() => window.__game.session.sim.view.mode())) === 'travel', JSON.stringify(res));
  await tick(0.5);
  check('the HUD shows the journey', (await page.locator('.mu-hud-travel:not(.mu-hide)').count()) === 1);
  const prog0 = await sim(() => window.__game.session.services.player.travel().progress);
  await tick(20);
  const t1 = await sim(() => { const t = window.__game.session.services.player.travel(); return t && { phase: t.phase, progress: t.progress }; });
  check('the party moves along the road (or has met someone)', t1 && (t1.progress > prog0 || t1.phase === 'encounter'), JSON.stringify(t1));
  // settle any random encounter so the forced ones below start from a clean state
  await sim(() => { const p = window.__game.session.services.player; if (p.travel()?.phase === 'encounter') p.perform(p.options().find((o) => o.enabled)); });
  await page.evaluate(() => window.__ui.closePanel('encounter'));

  await sim(() => window.__game.session.services.player.debug.forceEncounter('bandits'));
  await tick(0.6);
  s = await ui();
  check('an encounter opens the journey panel and drops to street level', s.panels.includes('encounter') && (await sim(() => window.__game.session.sim.view.mode())) === 'street', JSON.stringify(s));
  check('a hostile encounter blocks hurrying', !(await sim(() => window.__game.session.sim.dispatch({ type: 'setSpeed', speed: 3 }).ok)));
  await page.getByRole('button', { name: /Press on to/ }).click();
  await tick(0.3);
  const t2 = await sim(() => window.__game.session.services.player.travel());
  check('"Press on" settles it and the journey goes on at 8×', t2 && t2.phase === 'travelling' && (await sim(() => window.__game.session.sim.clock.speed)) === 8 && (await ui()).panels.length === 0, JSON.stringify(t2 && t2.phase));

  await sim(() => window.__game.session.services.player.debug.forceEncounter('merchant'));
  await tick(0.6);
  await page.getByRole('button', { name: 'Face them' }).click();
  await tick(0.2);
  await page.keyboard.down('KeyE');
  await tick(0.6);
  await page.keyboard.up('KeyE');
  await tick(0.1);
  const labels = await page.locator('.mu-wheel-label').allTextContents();
  check('holding E in a standoff lists the road choices', (await ui()).panels.includes('actions') && labels.some((l) => /wares|news|Move on/i.test(l)), labels.join('|'));
  await page.locator('.mu-wheel-opt', { hasText: 'Move on' }).click();
  await tick(0.3);
  const t3 = await sim(() => window.__game.session.services.player.travel());
  check('choosing "Move on" from the wheel resumes the journey', t3 && t3.phase === 'travelling', JSON.stringify(t3 && t3.phase));

  await page.getByRole('button', { name: 'Cancel journey' }).click();
  await tick(0.3);
  check('"Cancel journey" stops where the party is and gives the speed back', (await sim(() => window.__game.session.services.player.travel())) === null && (await sim(() => window.__game.session.sim.clock.speed)) === 1);

  // ---- death and succession
  const before = await sim(() => window.__game.session.sim.state.run.playerId);
  await sim(() => window.__game.killPlayer());
  await tick(0.5);
  s = await ui();
  check('death opens the succession screen and the body falls', s.panels.join() === 'death' && (await sim(() => window.__game.session.services.player.body())) === null, JSON.stringify(s));
  await page.locator('.mu-succ').nth(0).click();
  await page.getByRole('button', { name: /Carry on as/ }).click();
  await tick(0.6);
  const after = await sim(() => ({ id: window.__game.session.sim.state.run.playerId, body: window.__game.session.services.player.body(), phase: window.__game.session.sim.state.run.phase }));
  check('choosing a successor plays on as them, standing in the world', after.id !== before && after.phase === 'alive' && after.body !== null && (await ui()).panels.length === 0, JSON.stringify(after));

  // ---- leave to the menu and continue where the run was left
  await tick(1.5);
  const spot = await sim(() => ({ ...window.__game.session.services.player.body() }));
  await page.keyboard.press('Escape');
  await tick(0.2);
  await page.getByRole('button', { name: 'Save and quit to menu' }).click();
  await page.waitForFunction(() => window.__game.session === null && window.__game.host.screen === 'menu', null, { timeout: 60000 });
  check('saving and quitting returns to the menu with no session', await page.locator('.mu-menu-card .mu-btn', { hasText: 'Continue' }).count() === 1);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForFunction(() => window.__game.session !== null && window.__game.host.screen === 'game', null, { timeout: 240000 });
  await page.evaluate(() => window.__game.freeze(true));
  await tick(0.3);
  const back = await sim(() => ({ id: window.__game.session.sim.state.run.playerId, body: { ...window.__game.session.services.player.body() } }));
  check('Continue puts the same character back where they were', back.id === after.id && Math.hypot(back.body.x - spot.x, back.body.z - spot.z) < 1, JSON.stringify({ back, spot }));
} catch (e) {
  console.log('FLOW ERROR', e.message);
  failures++;
} finally {
  await browser.close();
  if (vite) { try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); } }
}
if (errors.length) { console.log(`\n${errors.length} page errors:`); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); failures++; }
console.log(failures ? `\n${failures} failure(s)` : '\nall flow checks passed');
process.exit(failures ? 1 : 0);
