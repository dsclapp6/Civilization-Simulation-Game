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
  // (clarity pass) the scene-setting intro card follows the birth reveal; "Straight in" starts the first day
  s = await ui();
  check('the birth reveal is followed by the scene-setting intro card, which holds the world', s.panels.join() === 'intro' && s.captures && await sim(() => window.__game.session.sim.clock.paused), JSON.stringify(s));
  check('the intro says where you wake', (await page.locator('.mu-intro-text').textContent()).includes('You wake in'));
  await page.getByRole('button', { name: 'Straight in' }).click();
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
  await page.waitForTimeout(120); // the UI debounces Esc (one press can arrive by two routes)
    await page.keyboard.press('Escape');
  await tick(0.2);
  s = await ui();
  check('Esc with nothing open shows the pause menu', s.panels.join() === 'pause', JSON.stringify(s));
  await page.getByRole('button', { name: 'Resume' }).click();
  await tick(0.2);
  check('Resume closes it', (await ui()).panels.length === 0);

  // ---- the wave 3 pages are reachable by key and from the dock; notices open the right page; the guide speaks
  for (const [key, id] of [['KeyK', 'politics'], ['KeyT', 'techs'], ['KeyR', 'requests'], ['KeyB', 'wounds'], ['KeyC', 'army'], ['F1', 'help']]) {
    await page.keyboard.press(key);
    await tick(0.2);
    s = await ui();
    check(`${key} opens ${id}`, s.panels.join() === id && s.captures, JSON.stringify(s));
    if (id === 'politics' || id === 'help') {
      await page.keyboard.press('ArrowRight');
      await tick(0.1);
      check(`${id}: the arrow keys switch tabs`, (await page.locator('.mu-tab.active').allTextContents()).join().length > 0 && (await page.locator('.mu-tab.active').first().textContent()) !== (id === 'politics' ? 'Standing' : 'Controls'), await page.locator('.mu-tab.active').first().textContent());
    }
    await page.waitForTimeout(120); // the UI debounces Esc (one press can arrive by two routes)
    await page.keyboard.press('Escape');
    await tick(0.2);
    check(`Esc closes ${id}`, (await ui()).panels.length === 0, JSON.stringify(await ui()));
  }
  const dockBtns = await page.locator('.mu-dock .mu-dockbtn:not(.mu-hide)').count();
  check('the dock has buttons for the core pages and the realm pages', dockBtns >= 12, String(dockBtns));
  await page.locator('.mu-dock .mu-dockbtn[aria-label="Realm and politics"]').click();
  await tick(0.2);
  check('the dock button opens the politics page', (await ui()).panels.join() === 'politics', JSON.stringify(await ui()));
  await page.waitForTimeout(120); // the UI debounces Esc (one press can arrive by two routes)
    await page.keyboard.press('Escape');
  await tick(0.2);
  await sim(() => { window.__game.session.sim.services.happenings.offerRequest('fetch'); window.__game.tick(0.3); });
  await tick(0.3);
  check('a request puts up a notice with a button', (await page.locator('.mu-toast.actionable').count()) >= 1, String(await page.locator('.mu-toast.actionable').count()));
  check('and a dot on the requests button', (await page.locator('.mu-dockbtn[aria-label="Requests and news"] .mu-dockdot').count()) === 1);
  await page.keyboard.press('Enter');
  await tick(0.2);
  check('Enter takes the notice to the requests journal', (await ui()).panels.join() === 'requests', JSON.stringify(await ui()));
  await page.waitForTimeout(120); // the UI debounces Esc (one press can arrive by two routes)
    await page.keyboard.press('Escape');
  await tick(0.2);
  await sim(() => window.__ui.showHint('interact'));
  await tick(0.2);
  check('the guide shows a hint card', (await page.locator('.mu-guide:not(.mu-hide)').count()) === 1 && (await page.locator('.mu-guide-title').textContent()) === 'Lend a hand');
  await page.locator('.mu-guide-x').click();
  await tick(0.2);
  check('the hint can be dismissed', (await page.locator('.mu-guide:not(.mu-hide)').count()) === 0);

  // ---- the free cursor (CLARITY §5): hover names things, a click walks there and acts, the right button turns the camera, G draws
  {
    await sim(() => { window.__game.session.sim.dispatch({ type: 'setSpeed', speed: 1 }); window.__game.session.sim.hostileNear = () => false; });
    // someone close by, on the screen
    const target = await sim(() => {
      const g = window.__game; const s = g.session; const z = s.services.zone; const p = s.services.player; const b = p.body();
      const a = [...z.agents()].filter((x) => x.visible && x.personId !== s.sim.state.run.playerId).sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z))[0];
      if (!a) return null;
      // stand 6 m from them, facing them, so they are in the middle of the view
      const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
      p.placeAt(a.x + (dx / d) * 6, a.z + (dz / d) * 6, Math.atan2(-dx, -dz));
      const r = s.renderer; const yaw = Math.atan2(-dx, -dz); r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
      return a.personId;
    });
    if (target !== null) {
      await tick(0.5);
      await page.evaluate(() => window.__game.settle());
      await page.evaluate(() => window.__game.draw());
      const pt = await page.evaluate((id) => { const s = window.__game.session; const a = s.services.zone.agent(id); return a ? s.controls.project(a.x, a.y + 1.0, a.z) : null; }, target);
      if (pt) {
        await page.mouse.move(pt.x - 12, pt.y - 12);
        await page.mouse.move(pt.x, pt.y, { steps: 3 });
        await page.waitForTimeout(500);
        await tick(0.4);
        const hv = await sim(() => { const h = window.__game.session.services.player.hover?.(); return h ? { kind: h.target.kind, label: h.label, action: h.action, cursor: h.cursor } : null; });
        check('hovering a person names them and what a click does', hv && hv.kind === 'person' && hv.label.length > 3 && hv.action === 'Talk', JSON.stringify(hv));
        await wait(300);
        check('the tooltip card shows the name and the action', (await page.locator('.mu-hover:not(.mu-hide)').count()) === 1 && (await page.locator('.mu-hover-name').textContent()).length > 3, await page.locator('.mu-hover').textContent());
        check('the cursor changes to the talk cursor', (await page.evaluate(() => document.getElementById('viewport').style.cursor)).includes('url('));
        // a click walks there and does the default action: the dialogue opens once they are reached
        await page.mouse.click(pt.x, pt.y);
        await tick(0.6);
        check('a left click starts the walk to them', !!(await sim(() => window.__game.session.services.player.hud().going)), JSON.stringify(await sim(() => window.__game.session.services.player.hud().going)));
        check('the destination ring is on the screen', (await page.locator('.mu-dest:not(.mu-hide)').count()) === 1);
        await tick(9);
        s = await ui();
        check('on arrival the default action runs (a conversation opens)', s.panels.includes('dialogue') || !(await sim(() => window.__game.session.services.player.hud().going)), JSON.stringify(s));
        if (s.panels.includes('dialogue')) { await page.waitForTimeout(120); await page.keyboard.press('Escape'); await tick(0.3); }
        await page.waitForTimeout(150);
        if ((await ui()).panels.length) { await page.keyboard.press('Escape'); await tick(0.3); }
      } else console.log('     (the person is off the screen: the hover and click checks are skipped)');
    } else console.log('     (nobody around: the hover and click checks are skipped)');
    await page.mouse.move(640, 80);
    await tick(0.3);

    // the right button turns the camera, and only while it is held; the cursor stays free
    const y0 = await sim(() => window.__game.session.renderer.getCameraYaw());
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(700, 360, { steps: 6 });
    await page.mouse.move(760, 360, { steps: 6 });
    await tick(0.2);
    const y1 = await sim(() => window.__game.session.renderer.getCameraYaw());
    check('holding the right button and dragging turns the camera', Math.abs(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0))) > 0.05, `${y0.toFixed(3)} -> ${y1.toFixed(3)}`);
    await page.mouse.up({ button: 'right' });
    await tick(0.2);
    check('the pointer is not locked once the button is up', await page.evaluate(() => document.pointerLockElement === null));
    const y2 = await sim(() => window.__game.session.renderer.getCameraYaw());
    await page.mouse.move(600, 340, { steps: 4 });
    await tick(0.2);
    check('moving the free cursor does not turn the camera', Math.abs(await sim(() => window.__game.session.renderer.getCameraYaw()) - y2) < 1e-6);

    // G draws and puts away; a drawn weapon takes the mouse for looking
    await page.keyboard.press('KeyG');
    await tick(0.2);
    check('G draws the weapon', (await sim(() => window.__game.session.services.player.drawn?.())) === true && (await sim(() => window.__game.session.services.player.hud().drawn)) === true);
    check('while drawn the hover card and click-to-act are off', (await sim(() => window.__game.session.services.player.hover?.())) === null);
    await page.keyboard.press('KeyG');
    await tick(0.2);
    check('G again puts it away', (await sim(() => window.__game.session.services.player.drawn?.())) === false);

    // the guidance keys: N hides the minimap, Y asks "what now?", O opens the journal
    check('the minimap is on by default', (await page.locator('.mu-minimap:not(.mu-hide)').count()) === 1);
    await page.keyboard.press('KeyN');
    await tick(0.2);
    check('N hides the minimap', (await page.locator('.mu-minimap:not(.mu-hide)').count()) === 0);
    await page.keyboard.press('KeyN');
    await tick(0.2);
    check('N shows it again', (await page.locator('.mu-minimap:not(.mu-hide)').count()) === 1);
    await page.keyboard.press('KeyY');
    await tick(0.2);
    check('Y opens the "What now?" card', (await page.locator('.mu-whatnow:not(.mu-hide)').count()) === 1);
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    await tick(0.2);
    check('Esc closes it before anything else', (await page.locator('.mu-whatnow:not(.mu-hide)').count()) === 0 && (await ui()).panels.length === 0, JSON.stringify(await ui()));
    await page.keyboard.press('KeyO');
    await tick(0.2);
    s = await ui();
    check('O opens the journal', s.panels.join() === 'journal' && s.captures, JSON.stringify(s));
    await page.keyboard.press('ArrowRight');
    await tick(0.1);
    check('the arrow keys switch the journal\'s pages', (await page.locator('.mu-tab.active').first().textContent()).includes('Today'));
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    await tick(0.2);
    check('Esc closes the journal', (await ui()).panels.length === 0);
  }

  // ---- hold E for the action wheel; tap E acts
  await page.keyboard.down('KeyE');
  await tick(0.6);
  await page.keyboard.up('KeyE');
  await tick(0.1);
  s = await ui();
  check('holding E opens the action wheel', s.panels.includes('actions'), JSON.stringify(s));
  check('the wheel lists the options on the target', (await page.locator('.mu-wheel-opt').count()) >= 2, String(await page.locator('.mu-wheel-opt').count()));
  await page.waitForTimeout(120); // the UI debounces Esc (one press can arrive by two routes)
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
  await page.waitForTimeout(120); // the UI debounces Esc (one press can arrive by two routes)
    await page.keyboard.press('Escape');
  await tick(0.2);
  await page.getByRole('button', { name: 'Save and quit to menu' }).click();
  await page.waitForFunction(() => window.__game.session === null && window.__game.host.screen === 'menu', null, { timeout: 60000 });
  // the menu adds "Continue" once its async saved-run lookup returns
  await page.locator('.mu-menu-card .mu-btn', { hasText: 'Continue' }).first().waitFor({ timeout: 15000 }).catch(() => {});
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
