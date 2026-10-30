// Interaction smoke test for the UI gallery (?mode=ui): drives the real keyboard and mouse through
// the run-start flow, hotkeys, Esc handling, dialogue, trade, rest, map, death and game over, and
// checks what the UI reports (open panels, input capture, pause) after each step.
//   node tools/ui-flow.mjs            (starts Vite on :5177 unless one is already serving the gallery)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5177;

async function serverIsOurs() {
  try { const r = await fetch(`http://localhost:${PORT}/src/ui/dev/gallery.ts`); return r.ok && (await r.text()).includes('__ui'); } catch { return false; }
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

const vite = (await serverIsOurs()) ? null : await startVite();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };
const state = () => page.evaluate(() => ({
  panels: window.__ui.ui.openPanels(),
  captures: window.__ui.ui.capturesInput(),
  paused: window.__ui.host.mock()?.sim.clock.paused ?? null,
  phase: window.__ui.host.mock()?.sim.state.run.phase ?? null,
  menu: !!document.querySelector('.mu-menu:not(.mu-hide)'),
}));
const wait = (ms = 250) => page.waitForTimeout(ms);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? '', sel);

try {
  await page.goto(`http://localhost:${PORT}/?mode=ui&still=1&chrome=0`);
  await page.waitForFunction(() => window.__ui && window.__ui.ready, null, { timeout: 120000 });
  await wait(500);

  // ---- title → run start → birth reveal
  check('title screen shows Continue and New run', (await page.locator('.mu-menu-card .mu-btn').allTextContents()).join('|').includes('Continue'));
  await page.getByRole('button', { name: 'New run' }).click();
  await page.waitForSelector('.mu-tier');
  await page.locator('.mu-tier').nth(2).click(); // Lord
  check('difficulty card selected', (await page.locator('.mu-tier.sel h4').textContent()) === 'Lord');
  await page.getByRole('button', { name: 'Legacy shop' }).click();
  await page.waitForSelector('.mu-shop-row');
  const goldBefore = await text('.mu-gold-num');
  await page.locator('.mu-shop-row .mu-btn.primary').nth(0).click();
  await page.locator('.mu-shop-row .mu-btn.primary').nth(0).click();
  check('stat shop spends gold (100 + 250)', (await text('.mu-gold-top + dl dd')) === '350', await text('.mu-gold-top + dl dd'));
  check('gold balance stays', (await text('.mu-gold-num')) === goldBefore);
  await page.keyboard.press('Escape');
  check('Esc steps back to the difficulty screen', await page.locator('.mu-tier').count() === 4);
  await page.getByRole('button', { name: 'Legacy shop' }).click();
  await page.getByRole('button', { name: 'Begin your life' }).click();
  await page.waitForSelector('.mu-loading:not(.mu-hide)', { timeout: 5000 });
  check('loading screen appears', true);
  await page.waitForSelector('.mu-birth', { timeout: 20000 });
  await wait(300);
  let s = await state();
  check('birth reveal is open, pauses the world, and captures input', s.panels.includes('birth') && s.paused === true && s.captures === true, JSON.stringify(s));
  await page.keyboard.press('Escape');
  s = await state();
  check('Esc does not dismiss the birth reveal', s.panels.includes('birth'));
  await page.getByRole('button', { name: 'Begin your life' }).click();
  await wait(300);
  s = await state();
  check('beginning the life resumes the world', s.panels.length === 0 && s.paused === false && s.captures === false, JSON.stringify(s));
  check('gold was spent on the shop ranks', await page.evaluate(() => window.__ui.host.profile().levels.medieval.legacyGold) === 1850 - 350);

  // ---- hotkeys and Esc
  await page.keyboard.press('Tab');
  await wait(200);
  s = await state();
  check('Tab opens the character sheet, pausing and capturing', s.panels.join() === 'character' && s.paused === true && s.captures === true, JSON.stringify(s));
  await page.keyboard.press('Tab');
  await wait(200);
  s = await state();
  check('Tab again closes it and resumes', s.panels.length === 0 && s.paused === false, JSON.stringify(s));
  await page.keyboard.press('KeyI');
  await page.keyboard.press('KeyH');
  await wait(200);
  s = await state();
  check('main panels replace each other (I then H leaves only the family panel)', s.panels.join() === 'family', JSON.stringify(s));
  await page.keyboard.press('Escape');
  await wait(200);
  s = await state();
  check('Esc closes the top panel, not the pause menu', s.panels.length === 0, JSON.stringify(s));
  await page.keyboard.press('Escape');
  await wait(200);
  s = await state();
  check('Esc with nothing open shows the pause menu and pauses', s.panels.join() === 'pause' && s.paused === true, JSON.stringify(s));
  await page.keyboard.press('KeyI');
  s = await state();
  check('panel hotkeys are ignored while the pause menu is up', s.panels.join() === 'pause');
  await page.keyboard.press('Escape');
  await wait(200);
  s = await state();
  check('Esc closes the pause menu and resumes', s.panels.length === 0 && s.paused === false, JSON.stringify(s));
  // a paused-by-hand game stays paused after a menu closes
  await page.keyboard.press('KeyP');
  await page.evaluate(() => window.__ui.host.mock().sim.dispatch({ type: 'pause' }));
  await page.keyboard.press('KeyI');
  await page.keyboard.press('KeyI');
  await wait(200);
  s = await state();
  check('a pause made by hand survives opening and closing a panel', s.paused === true);
  await page.evaluate(() => window.__ui.host.mock().sim.dispatch({ type: 'resume' }));

  // ---- speed buttons and refusal
  await page.locator('.mu-hud-speed', { hasText: '3×' }).click();
  check('3× button sets the speed', await page.evaluate(() => window.__ui.host.mock().sim.clock.speed) === 3);
  await page.evaluate(() => { window.__ui.host.mock().sim.hostileNear = () => true; });
  await page.locator('.mu-hud-speed', { hasText: '8×' }).click();
  await wait(100);
  check('a refused speed change tells the player why', (await page.locator('.mu-feed-line').allTextContents()).join('|').includes('too dangerous'));
  await page.evaluate(() => { window.__ui.host.mock().sim.hostileNear = () => false; });

  // ---- rest
  await page.keyboard.press('KeyZ');
  await wait(200);
  check('Z opens the rest panel', (await state()).panels.join() === 'rest');
  await page.keyboard.press('Digit4'); // wait an hour
  await wait(300);
  s = await state();
  check('choosing a rest option starts a skip and captures input', s.panels.length === 0 && (await page.evaluate(() => !!window.__ui.host.mock().sim.clock.skip)) && s.captures === true, JSON.stringify(s));
  await page.keyboard.press('Escape');
  await wait(200);
  check('Esc wakes the sleeper instead of opening the pause menu', (await state()).panels.length === 0 && !(await page.evaluate(() => !!window.__ui.host.mock().sim.clock.skip)));

  // ---- action wheel and dialogue
  await page.evaluate(() => { window.__ui.host.mock().player.targetKind = 'person'; });
  await page.evaluate(() => window.__ui.ui.openPanel({ panel: 'actions' }));
  await wait(200);
  check('the action wheel lists numbered options', (await page.locator('.mu-wheel-opt').count()) >= 4);
  await page.keyboard.press('Digit1'); // Talk
  await wait(400);
  s = await state();
  check('choosing Talk opens the dialogue and closes the wheel', s.panels.join() === 'dialogue', JSON.stringify(s));
  const optionsBefore = await page.locator('.mu-dopt').count();
  await page.keyboard.press('Digit2'); // the 2nd option
  await wait(300);
  check('a dialogue option adds lines to the transcript', (await page.locator('.mu-dlg-line').count()) >= 2);
  check('dialogue keeps its options', (await page.locator('.mu-dopt').count()) === optionsBefore);
  await page.keyboard.press('Escape');
  await wait(300);
  s = await state();
  check('Esc ends the conversation', s.panels.length === 0 && (await page.evaluate(() => window.__ui.host.mock().social.current())) === null, JSON.stringify(s));

  // ---- trade
  await page.evaluate(() => window.__ui.ui.openPanel({ panel: 'trade', partner: { kind: 'market', settlement: window.__ui.host.mock().sim.state.persons.get(window.__ui.host.mock().sim.state.run.playerId).settlement } }));
  await wait(300);
  const purseBefore = await page.evaluate(() => window.__ui.host.mock().sim.state.persons.get(window.__ui.host.mock().sim.state.run.playerId).money);
  await page.locator('.mu-trade-buy .mu-qty-plus').nth(5).click();
  await page.locator('.mu-trade-buy .mu-qty-plus').nth(5).click();
  await wait(100);
  check('the basket shows the line and a total', (await page.locator('.mu-basket-row').count()) === 1 && (await text('.mu-basket-net')).startsWith('You pay'), await text('.mu-basket-net'));
  await page.getByRole('button', { name: 'Confirm trade' }).click();
  await wait(300);
  const purseAfter = await page.evaluate(() => window.__ui.host.mock().sim.state.persons.get(window.__ui.host.mock().sim.state.run.playerId).money);
  check('confirming trades and spends money', purseAfter < purseBefore, `${purseBefore} -> ${purseAfter}`);
  check('the trade appears in the message feed', (await page.locator('.mu-feed-line').allTextContents()).join('|').includes('Bought'));
  await page.keyboard.press('Escape');

  // ---- map: click a settlement on the canvas
  await page.keyboard.press('KeyM');
  await wait(500);
  s = await state();
  check('M opens the map without capturing input (the map must stay draggable)', s.panels.join() === 'map' && s.captures === false, JSON.stringify(s));
  await page.mouse.click(439, 205); // Coldharbour on the map backdrop (1280x720 calibration)
  await wait(300);
  const sel = await text('.mu-map-place-name');
  check('clicking the map selects the nearest settlement', sel === 'Coldharbour', sel);
  await page.locator('.mu-map-row').nth(2).click();
  check('clicking a list row selects that place', (await text('.mu-map-place-name')) !== sel);
  await page.keyboard.press('Escape');
  await wait(200);
  check('Esc closes the map', (await state()).panels.length === 0);

  // ---- death → successor → game over
  await page.evaluate(() => window.__ui.run('death'));
  await wait(400);
  s = await state();
  check('death opens the succession screen, pauses, and ignores Esc', s.panels.join() === 'death' && s.paused === true && s.phase === 'choosing', JSON.stringify(s));
  await page.keyboard.press('Escape');
  check('Esc does not dismiss the death screen', (await state()).panels.join() === 'death');
  const cards = await page.locator('.mu-succ').count();
  check('successors are offered', cards >= 2, String(cards));
  await page.locator('.mu-succ').nth(0).click();
  await page.getByRole('button', { name: /Carry on as/ }).click();
  await wait(500);
  s = await state();
  check('choosing a successor resumes play as them', s.panels.length === 0 && s.phase === 'alive' && s.paused === false, JSON.stringify(s));
  check('the HUD is back', await page.locator('.mu-hud:not(.mu-hide):not(.dimmed)').count() === 1);
  await page.evaluate(() => window.__ui.run('gameover'));
  await wait(400);
  check('abandoning ends the run with the game over screen', (await state()).panels.join() === 'gameover');
  await page.getByRole('button', { name: 'New run' }).click();
  await wait(600);
  s = await state();
  check('"New run" leaves the finished run and shows the difficulty screen', s.menu && (await page.locator('.mu-tier').count()) === 4, JSON.stringify(s));
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
