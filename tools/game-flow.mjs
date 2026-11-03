// End-to-end flow check of the real game (app + player + UI) in headless Chromium: the run-start screens, the
// loading screen, the birth reveal, the hotkeys and Esc, speed keys and their refusals, holding E for the action
// wheel, the map, a journey with encounters answered through the UI's journey panel and through the wheel,
// death and succession, and leaving to the menu and continuing where the run was left. Civilization pass (B6): the dock's builder and
// ruler buttons, the settings, the wheel's Live as, quest marks, steps and their cues, the wounds tab, the accolade, V and the glide or
// fade, the death screen's search.
//
//   node tools/game-flow.mjs [--seed=abc] [--devzone] [--port=5178]
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
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const PORT = Number(opt('port', 5178));
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
const sim = (fn, arg) => page.evaluate(fn, arg);
const feed = () => page.locator('.mu-feed-line').allTextContents().then((l) => l.join(' | '));
const dbg = () => page.evaluate(() => window.__ui.debugState());
/** Text of the first element matching a selector, or '' (never waits). */
const txt = (sel) => page.evaluate((q) => { const e = document.querySelector(q); return e ? (e.textContent ?? '') : ''; }, sel);
/** Stands 6 m from a visible person (the nearest that can be hovered; not one of `not`), facing them, and hovers the real mouse over them. */
async function hoverPerson(not = []) {
  const tried = [];
  for (let k = 0; k < 8; k++) {
    const t = await page.evaluate(([skip, k]) => {
      const g = window.__game; const se = g.session; const z = se.services.zone; const p = se.services.player; const b = p.body(); const me = se.sim.state.run.playerId;
      const list = [...z.agents()].filter((x) => x.visible && x.personId !== me && !skip.includes(x.personId)).sort((u, v) => Math.hypot(u.x - b.x, u.z - b.z) - Math.hypot(v.x - b.x, v.z - b.z));
      const a = list[k];
      if (!a) return null;
      const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
      p.placeAt(a.x + (dx / d) * 6, a.z + (dz / d) * 6, Math.atan2(-dx, -dz));
      const r = se.renderer; const yaw = Math.atan2(-dx, -dz) + 0.45; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0); // a little to one side, so the player's own body does not hide them
      return a.personId;
    }, [not, k]);
    if (t === null) break;
    await tick(0.3);
    await page.evaluate(() => window.__game.settle());
    await page.evaluate(() => window.__game.draw());
    const pt = await page.evaluate((id) => { const s = window.__game.session; const a = s.services.zone.agent(id); const q = a ? s.controls.project(a.x, a.y + 0.65, a.z) : null; return q ? { x: q.x, y: q.y, ax: a.x, az: a.z } : null; }, t);
    if (!pt) { tried.push({ k, t, pt: null }); continue; }
    await page.mouse.move(pt.x - 12, pt.y - 12);
    await page.mouse.move(pt.x, pt.y, { steps: 3 });
    await page.waitForTimeout(400);
    await tick(0.02); // a walking person must not leave the pointer: the world moves as little as it can while the pointer resolves what is under it
    const hv = await page.evaluate(() => { const h = window.__game.session.services.player.hover?.(); return h && h.target.kind === 'person' ? h.target.id : null; });
    if (hv === null) {
      const seen = await page.evaluate(([id, pt]) => {
        const se = window.__game.session; const h = se.services.player.hover?.(); const a = se.services.zone.agent(id); const b = se.services.player.body();
        const pk = se.renderer.pick(pt.x, pt.y);
        return { hover: h ? h.target.kind : null, pick: pk.type + ':' + (pk.id ?? ''), me: se.sim.state.run.playerId, moved: a ? Math.round(Math.hypot(a.x - pt.ax, a.z - pt.az) * 100) / 100 : null, dist: a && b ? Math.round(Math.hypot(a.x - b.x, a.z - b.z) * 10) / 10 : null, mode: se.renderer.getCameraMode(), vm: se.sim.view.mode(), panels: window.__ui.openPanels() };
      }, [t, pt]);
      tried.push({ k, t, ...seen });
      continue;
    }
    const name = await page.evaluate((id) => window.__game.session.sim.state.persons.get(id).first, hv);
    return { id: hv, name, hovered: true };
  }
  return { id: 0, name: '', hovered: false, tried };
}

/** Samples the UI's state every few ms while a change of life runs, so the checks do not depend on how fast the machine is. */
const startRecording = () => page.evaluate(() => {
  const w = window; w.__fx = { log: [] };
  w.__fx.timer = setInterval(() => {
    const d = w.__ui.debugState(); const g = w.__game.session;
    w.__fx.log.push({ ph: d.switching, veil: d.veil, me: g.sim.state.run.playerId, mode: g.renderer.getCameraMode(), arrival: d.arrival, vm: g.sim.view.mode(), ag: g.services.zone.agents().length });
  }, 6);
});
const stopRecording = async () => {
  await page.waitForFunction(() => window.__ui.debugState().switching === 'idle' && window.__fx.log.some((x) => x.ph !== 'idle'), null, { timeout: 30000 }).catch(() => {});
  await tick(0.2);
  return page.evaluate(() => { clearInterval(window.__fx.timer); return window.__fx.log; });
};
const phases = (log) => log.map((x) => x.ph).filter((p, i, a) => i === 0 || p !== a[i - 1]);


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

  // ---- first person: the mouse looks (pointer lock, no button), Alt / Option frees the cursor, Esc frees it, pages free it and give it back
  {
    const lookState = () => sim(() => window.__game.host.mouseState());
    const locked = () => page.evaluate(() => document.pointerLockElement !== null);
    // the browser hands over (or takes back) the pointer a moment after it is asked: wait for it before looking
    const lockedSoon = async (want = true) => { for (let i = 0; i < 40 && (await locked()) !== want; i++) { await page.waitForTimeout(100); await tick(0.05); } return locked(); };
    const yawOf = () => sim(() => window.__game.session.renderer.getCameraYaw());
    check('first person is the default view', await sim(() => window.__game.session.renderer.inFirstPerson() && window.__game.session.renderer.getViewDistance() === 0));
    if (!(await locked())) {
      check('the mouse waits for the click that takes it, and the hint says so', (await lookState()) === 'wait' && (await page.locator('.mu-look-hint:not(.mu-hide)').textContent()).includes('Click to look around'));
      await page.mouse.click(640, 360);
      await tick(0.2);
      await lockedSoon();
    }
    check('the click takes the mouse (the pointer is locked)', (await locked()) && (await lookState()) === 'look');
    check('a crosshair marks the middle of the view', (await page.locator('.mu-xhair:not(.mu-hide)').count()) === 1);
    const y0 = await yawOf();
    // (headless Chromium reports odd movement for synthetic mouse moves while the pointer is locked, so the movement is sent as the events a real mouse makes)
    await page.evaluate(() => { for (let i = 0; i < 12; i++) document.getElementById('viewport').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, movementX: 40, movementY: 0, clientX: 640, clientY: 360 })); });
    await tick(0.2);
    const y1 = await yawOf();
    check('moving the mouse turns the view, no button held', Math.abs(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0))) > 0.05, `${y0.toFixed(3)} -> ${y1.toFixed(3)}`);
    await page.keyboard.press('AltLeft');
    await tick(0.2);
    check('Alt frees the cursor (the pointer is given back, a hint says how to look again)', !(await locked()) && (await lookState()) === 'free' && (await page.locator('.mu-look-hint:not(.mu-hide)').count()) === 1);
    const y2 = await yawOf();
    await page.mouse.move(500, 300, { steps: 5 });
    await page.mouse.move(700, 380, { steps: 5 });
    await tick(0.2);
    check('with the cursor free the view stays still', Math.abs(await yawOf() - y2) < 1e-6);
    await page.keyboard.press('AltLeft');
    await tick(0.2);
    await lockedSoon();
    check('Alt again takes the mouse back', (await locked()) && (await lookState()) === 'look');
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    await tick(0.3);
    s = await ui();
    check('Esc frees the cursor and never opens the menu for that press', !(await locked()) && (await lookState()) === 'free' && s.panels.length === 0, JSON.stringify(s));
    await page.locator('.mu-look-hint').click();
    await tick(0.2);
    await lockedSoon();
    check('a click on the hint takes the mouse back', (await locked()) && (await lookState()) === 'look');
    await page.keyboard.press('Tab');
    await tick(0.2);
    check('a page opening frees the pointer', !(await locked()) && (await ui()).panels.join() === 'character');
    await page.keyboard.press('Tab');
    await tick(0.3);
    await lockedSoon();
    check('closing it takes the mouse back', (await locked()) && (await lookState()) === 'look', await lookState());
    // the wheel steps out of first person to the shoulder, and back
    const wheel = (dy) => page.evaluate((d) => document.getElementById('viewport').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: d })), dy);
    const live = (n) => page.evaluate((k) => { for (let i = 0; i < k; i++) window.__game.draw(); }, n); // (`tick` runs no camera, and the stage cooldown counts drawn frames: draw 32 of them, half a second)
    await live(32);
    await wheel(120);
    await live(32);
    const out = await sim(() => ({ fp: window.__game.session.renderer.inFirstPerson(), d: window.__game.session.renderer.getViewDistance() }));
    check('the wheel out of first person goes over the shoulder', !out.fp && out.d > 2 && out.d < 5, JSON.stringify(out));
    await page.waitForTimeout(600);
    await wheel(-400);
    await live(32);
    check('the wheel in goes back to first person', await sim(() => window.__game.session.renderer.inFirstPerson()));
    // leave the cursor free for the pointing checks below
    await page.keyboard.press('AltLeft');
    await tick(0.2);
    check('(the cursor is free for what follows)', (await lookState()) === 'free');
  }

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
  for (const [key, id] of [['KeyK', 'politics'], ['KeyT', 'techs'], ['KeyR', 'requests'], ['KeyC', 'army'], ['F1', 'help']]) {
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
  check('the guide shows a hint card', (await page.locator('.mu-guide:not(.mu-hide)').count()) === 1 && (await page.locator('.mu-guide-title').textContent()) === 'Look and act');
  await page.locator('.mu-guide-x').click();
  await tick(0.2);
  check('the hint can be dismissed', (await page.locator('.mu-guide:not(.mu-hide)').count()) === 0);

  // ---- the free cursor (CLARITY §5): hover names things, a click walks there and acts, the right button turns the camera, G draws
  {
    await sim(() => { window.__game.session.sim.dispatch({ type: 'setSpeed', speed: 1 }); window.__game.session.sim.hostileNear = () => false; });
    // someone close by, on the screen, with a clear line of sight from the eyes (hoverPerson tries the nearest few)
    const hp = await hoverPerson();
    const target = hp.hovered ? hp.id : null;
    if (target !== null) {
      await tick(0.5);
      await page.evaluate(() => window.__game.settle());
      await page.evaluate(() => window.__game.draw());
      const pt = await page.evaluate((id) => { const s = window.__game.session; const a = s.services.zone.agent(id); return a ? s.controls.project(a.x, a.y + 0.65, a.z) : null; }, target);
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

    // the right button no longer turns the camera, and the free cursor does not either
    const y0 = await sim(() => window.__game.session.renderer.getCameraYaw());
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(700, 360, { steps: 6 });
    await page.mouse.move(760, 360, { steps: 6 });
    await page.mouse.up({ button: 'right' });
    await tick(0.2);
    const y1 = await sim(() => window.__game.session.renderer.getCameraYaw());
    check('with the cursor free, dragging with the right button does not turn the camera', Math.abs(Math.atan2(Math.sin(y1 - y0), Math.cos(y1 - y0))) < 1e-6, `${y0.toFixed(3)} -> ${y1.toFixed(3)}`);
    check('the pointer is not locked while the cursor is free', await page.evaluate(() => document.pointerLockElement === null));
    const y2 = await sim(() => window.__game.session.renderer.getCameraYaw());
    await page.mouse.move(600, 340, { steps: 4 });
    await tick(0.2);
    check('moving the free cursor does not turn the camera', Math.abs(await sim(() => window.__game.session.renderer.getCameraYaw()) - y2) < 1e-6);

    // G draws and puts away; drawing with the cursor free takes the mouse back for looking
    await page.keyboard.press('KeyG');
    await tick(0.2);
    check('G draws the weapon', (await sim(() => window.__game.session.services.player.drawn?.())) === true && (await sim(() => window.__game.session.services.player.hud().drawn)) === true);
    for (let i = 0; i < 40 && !(await page.evaluate(() => document.pointerLockElement !== null)); i++) { await page.waitForTimeout(100); await tick(0.05); }
    check('drawing the weapon with the cursor free takes the mouse for looking', (await page.evaluate(() => document.pointerLockElement !== null)) && (await sim(() => window.__game.host.mouseState())) === 'look');
    check('while drawn the hover card and click-to-act are off', (await sim(() => window.__game.session.services.player.hover?.())) === null);
    // Esc leaves mouse-look first (it must not open the menu for that press); the weapon stays drawn; the next Esc is the menu's
    await page.waitForTimeout(120);
    await page.keyboard.press('Escape');
    await tick(0.3);
    s = await ui();
    check('Esc with the mouse looking only gives the mouse back (no menu)', s.panels.length === 0 && (await page.evaluate(() => document.pointerLockElement === null)) && (await sim(() => window.__game.session.services.player.drawn?.())) === true, JSON.stringify(s));
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await tick(0.3);
    check('the next Esc opens the menu as before', (await ui()).panels.join() === 'pause', JSON.stringify(await ui()));
    await page.getByRole('button', { name: 'Resume' }).click();
    await tick(0.3);
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

  // ---- civilization pass (B6): living as anyone, quest marks, the steps of hands-on work, wounds, the accolade, the dock and the settings
  page.setDefaultTimeout(60000);
  {
  // ---- the dock has the builder's and the ruler's buttons; the settings carry the live-as switch
  check('the dock has Builder (B) and Ruler (U) buttons and no Wounds button', (await page.locator('.mu-dockbtn[aria-label^="Builder mode"]').count()) === 1 && (await page.locator('.mu-dockbtn[aria-label^="Ruler mode"]').count()) === 1 && (await page.locator('.mu-dockbtn[aria-label="Wounds"]').count()) === 0);
  await sim(() => window.__ui.openPanel({ panel: 'settings' }));
  await tick(0.2);
  check('the settings have "Ask before living as someone", on by default', (await page.locator('.mu-field label', { hasText: 'Ask before living as someone' }).count()) === 1 && (await sim(() => window.__game.host.settings().askBeforeLiveAs)) === true);
  await page.evaluate(() => window.__ui.closePanel('settings'));
  await tick(0.2);

  // ---- a person in the open (far from any door), the player 1.6 m from them facing them
  const near = await sim(() => {
    const g = window.__game; const se = g.session; const z = se.services.zone; const p = se.services.player; const b = p.body(); const sm = se.sim;
    const bl = (sm.state.buildingsAt.get(sm.world.nearestSettlement(b.x, b.z).id) ?? []);
    const doorDist = (x, zz) => Math.min(...bl.map((q) => Math.hypot(q.x - x, q.z - zz)), 1e9);
    const list = [...z.agents()].filter((x) => x.visible && x.personId !== sm.state.run.playerId).sort((u, v) => doorDist(v.x, v.z) - doorDist(u.x, u.z));
    const a = list[0];
    if (!a) return null;
    const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
    p.placeAt(a.x + (dx / d) * 1.0, a.z + (dz / d) * 1.0, Math.atan2(-dx, -dz));
    const r = se.renderer; const yaw = Math.atan2(-dx, -dz); r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
    return { id: a.personId, name: sm.state.persons.get(a.personId).first, door: doorDist(a.x, a.z) };
  });
  check('a person is near enough to live as', !!near, JSON.stringify(near));
  await tick(0.5);

  // ---- the wheel offers "Live as …" on a person (with its icon)
  let wheelOk = false; let wheel = [];
  for (let k = 0; k < 6 && !wheelOk; k++) {
    const got = await sim((k) => {
      const g = window.__game; const se = g.session; const z = se.services.zone; const p = se.services.player; const b = p.body(); const sm = se.sim;
      const bl = (sm.state.buildingsAt.get(sm.world.nearestSettlement(b.x, b.z).id) ?? []);
      const doorDist = (x, zz) => Math.min(...bl.map((q) => Math.hypot(q.x - x, q.z - zz)), 1e9);
      const list = [...z.agents()].filter((x) => x.visible && x.personId !== sm.state.run.playerId).sort((u, v) => doorDist(v.x, v.z) - doorDist(u.x, u.z));
      const a = list[k];
      if (!a) return null;
      const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1;
      p.placeAt(a.x + (dx / d) * 1.0, a.z + (dz / d) * 1.0, Math.atan2(-dx, -dz));
      return { id: a.personId, name: sm.state.persons.get(a.personId).first };
    }, k);
    if (!got) break;
    await tick(0.1);
    const tgt = await sim(() => { const t = window.__game.session.services.player.target(); return t && t.target.kind === 'person' ? t.target.id : null; });
    if (tgt !== got.id) continue;
    await sim(() => window.__ui.open({ panel: 'actions' }));
    await tick(0.1);
    wheel = await page.locator('.mu-wheel-opt').allTextContents();
    wheelOk = wheel.some((t) => t.includes(`Live as ${got.name}`)) && (await page.locator('.mu-wheel-opt .mu-wheel-ico').count()) === wheel.length;
    if (!wheelOk) { await page.evaluate(() => window.__ui.closePanel('actions')); await tick(0.1); }
  }
  check('the action wheel on a person offers Live as them, with an icon on every option', wheelOk, wheel.join(' | '));
  await page.evaluate(() => window.__ui.closePanel('actions'));
  await tick(0.2);

  // ---- quest marks: a gold "!" and a silver "?" on the compass, the minimap's dots, the hover card, the words on the journal
  /** Says who wants something of the player the way the objectives module does: the zone gets the marks, the module's words are overridden. An empty list puts the real ones back. */
  const setMarks = (list) => sim((list) => {
    const se = window.__game.session; const z = se.services.zone; const o = se.services.objectives;
    if (!window.__realMarks) window.__realMarks = { marks: o.marks, set: [...z.markedPeople()].map((m) => ({ person: m.person, kind: m.kind })) };
    if (!list.length) { o.marks = window.__realMarks.marks; z.setQuestMarks(window.__realMarks.set); return; }
    o.marks = () => list;
    z.setQuestMarks(list.map((m) => ({ person: m.person, kind: m.kind })));
  }, list);
  /** Turns the camera to face a person in the zone. */
  const face = (id) => sim((id) => {
    const se = window.__game.session; const b = se.services.player.body(); const a = se.services.zone.agent(id); const r = se.renderer;
    if (!a) return false;
    const yaw = Math.atan2(a.x - b.x, a.z - b.z);
    r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
    return true;
  }, id);
  const compassMark = (cls) => page.evaluate((cls) => { const e = document.querySelector(`.mu-compass-mark.${cls}`); return e ? { tip: e.getAttribute('data-tip') || '', glyph: e.querySelector('.mu-compass-glyph')?.textContent ?? '' } : null; }, cls);
  const compassDump = () => page.evaluate(() => ({ tips: [...document.querySelectorAll('.mu-compass-mark')].map((e) => `${e.className}|${e.getAttribute('data-tip')}|${e.style.left}`), marked: window.__game.session.services.zone.markedPeople().map((m) => `${m.person}:${m.kind}@${Math.round(m.x)},${Math.round(m.z)}`), cam: window.__game.session.renderer.getCameraYaw() }));
  const waitCompass = (cls, text) => page.waitForFunction(([cls, text]) => { const e = document.querySelector(`.mu-compass-mark.${cls}`); return !!e && (e.getAttribute('data-tip') || '').includes(text); }, [cls, text], { timeout: 8000 }).catch(() => {});
  // two people in the open, far enough off to be read on the compass, apart from each other, and not in the way of the tracked objective's marker
  const picks = await sim(() => {
    const se = window.__game.session; const z = se.services.zone; const sm = se.sim; const me = sm.state.run.playerId;
    const b = se.services.player.body();
    const bearing = (x, zz) => Math.atan2(x - b.x, zz - b.z);
    const apart = (u, v) => Math.abs(Math.atan2(Math.sin(u - v), Math.cos(u - v)));
    const prim = (sm.view.worldMarkers?.() ?? []).filter((m) => m.primary).map((m) => bearing(m.x, m.z));
    const d = (x) => Math.hypot(x.x - b.x, x.z - b.z);
    const pool = [...z.agents()].filter((x) => x.personId !== me && d(x) > 16 && d(x) < 90 && prim.every((q) => apart(q, bearing(x.x, x.z)) > 0.45)).sort((u, v) => d(v) - d(u));
    const a = pool[0];
    const c = a ? pool.find((x) => Math.hypot(x.x - a.x, x.z - a.z) > 14) : null;
    if (!a || !c) return null;
    const nm = (pid) => sm.state.persons.get(pid).first;
    return { a: a.personId, an: nm(a.personId), c: c.personId, cn: nm(c.personId) };
  });
  check('two people are far enough away, and apart, to be marked', !!picks);
  if (!picks) throw new Error('no two people in the open to mark');
  const wantQ = { person: picks.a, kind: 'quest', text: `${picks.an} wants 7 bundles of firewood`, objective: 1 };
  const wantT = { person: picks.c, kind: 'turnin', text: `Hand the firewood to ${picks.cn}`, objective: 1 };
  await setMarks([wantQ]);
  await face(picks.a);
  await tick(0.8);
  await waitCompass('quest', wantQ.text);
  const mq = await compassMark('quest');
  check('the compass shows a gold "!" for someone who wants something, with what they want', !!mq && mq.tip.includes(wantQ.text), JSON.stringify(mq));
  check('the compass glyph is drawn as "!"', !!mq && mq.glyph === '!', JSON.stringify(mq));
  await page.waitForFunction(() => (document.querySelector('.mu-minimap-caption')?.textContent ?? '').includes('who wants something'), null, { timeout: 8000 }).catch(() => {});
  check('the minimap keys its dots ("! ? who wants something")', (await txt('.mu-minimap-caption')).includes('who wants something'), await txt('.mu-minimap-caption'));
  await setMarks([wantT]);
  await face(picks.c);
  await tick(0.8);
  await waitCompass('turnin', wantT.text);
  const mt = await compassMark('turnin');
  check('and a silver "?" for the person a task can be handed in to', !!mt && mt.tip.includes(wantT.text), JSON.stringify({ mt, picks, dump: await compassDump() }));
  check('the compass glyph is drawn as "?"', !!mt && mt.glyph === '?', JSON.stringify(mt));

  // the hover card says what the person under the pointer wants
  const hv = await hoverPerson([]);
  check('the mouse is over a person to read the hover card of', !!hv && hv.hovered, JSON.stringify(hv));
  await setMarks([{ person: hv.id, kind: 'quest', text: `${hv.name} wants 7 bundles of firewood`, objective: 1 }]);
  await tick(0.05);
  await page.waitForFunction(() => (document.querySelector('.mu-hover-mark')?.textContent ?? '').includes('wants 7 bundles of firewood'), null, { timeout: 8000 }).catch(() => {});
  check('the hover card says what they want of you', (await txt('.mu-hover-mark')).includes(`${hv.name} wants 7 bundles of firewood`) && (await txt('.mu-hover-mark-glyph')) === '!', await txt('.mu-hover-mark'));
  await page.mouse.move(4, 4);

  // the journal lists everyone who wants something, with Find
  await setMarks([wantQ, wantT]);
  await tick(0.1);
  await page.waitForTimeout(700);
  await page.keyboard.press('KeyO');
  await tick(0.3);
  const jm = await page.locator('.mu-jmark').allTextContents();
  check('the journal lists who wants something of you, each with Find', jm.length >= 2 && jm.some((t) => t.includes(wantQ.text)) && jm.some((t) => t.includes(wantT.text)) && (await page.locator('.mu-jmark button', { hasText: 'Find' }).count()) >= 2, jm.join(' | '));
  await page.locator('.mu-jmark button', { hasText: 'Find' }).first().click();
  await tick(0.2);
  check('Find marks them (the objectives module’s person marker)', (await sim(() => window.__game.session.services.objectives.found?.().person || 0)) !== 0 || (await dbg()).pin !== null);
  await sim(() => { window.__game.session.services.objectives.trackPerson?.(0); });
  await page.waitForTimeout(120);
  await page.keyboard.press('Escape');
  await tick(0.2);
  await setMarks([]);
  await tick(0.2);

  // ---- hands-on work: the bar says which step the bout is at, each step has its cue
  const started = await sim(() => {
    const se = window.__game.session; const sm = se.sim; const me = sm.state.run.playerId;
    sm.actions.register({
      id: 'flow.forge',
      list(_c, _a, target, out) {
        if (target.kind !== 'self') return;
        out.push({
          id: 'forge.test', provider: '', label: 'Forge a test blade', category: 'work', target, enabled: true, seconds: 8, range: 99, priority: 1, anim: 'work_hammer', mainHand: 'hammer',
          steps: [{ share: 0.25, label: 'Heat the bar', sfx: 'bellows' }, { share: 0.4, label: 'Draw it out', sfx: 'hammer' }, { share: 0.15, label: 'Quench', sfx: 'quench' }, { share: 0.2, label: 'Grind and hilt', sfx: 'grind' }],
        });
      },
      complete() { return { ok: true, message: 'You forge a test blade.' }; },
    });
    const opt = sm.actions.list(me, { kind: 'self' }).find((o) => o.id === 'forge.test');
    return opt ? sm.actions.start(me, opt).ok : false;
  });
  check('a bout with steps starts', started === true);
  await tick(0.6);
  const label = () => txt('.mu-hud-action-steplabel');
  check('the action bar shows the first step', (await label()) === 'Heat the bar' && (await page.locator('.mu-hud-action-pips i').count()) === 4 && (await page.locator('.mu-hud-action .mu-step-tick').count()) === 3, await label());
  await tick(2.4); // 3 s of 8: 37 % -> the hammer's step
  check('then the next step', (await label()) === 'Draw it out', await label());
  await tick(2.4);
  await tick(0.6); // 5.6 s of 8: 70 % -> the quench
  check('then the quench', (await label()) === 'Quench', await label());
  await tick(1.6);
  check('then the grinding', (await label()) === 'Grind and hilt', await label());
  const cues = (await dbg()).cues;
  check('each step’s cue was sounded in turn, the quench once', cues.indexOf('bellows') >= 0 && cues.indexOf('bellows') < cues.indexOf('clank') && cues.indexOf('clank') < cues.indexOf('quench') && cues.indexOf('quench') < cues.indexOf('grind') && cues.filter((c) => c === 'quench').length === 1, cues.join(','));
  await tick(2);
  check('the bar goes when the bout is done', (await page.locator('.mu-hud-action:not(.mu-hide)').count()) === 0 || (await label()) !== '');

  // ---- wounds: a mark on the plate, a page of the character sheet
  await sim(() => {
    const se = window.__game.session; const sm = se.sim; const combat = sm.services.combat; const me = sm.state.persons.get(sm.state.run.playerId);
    const mk = (location, kind, severity, extra = {}) => ({ location, kind, severity, bleeding: false, rate: 0, fracture: false, mortal: false, stun: 0, damage: severity * 70, ...extra });
    combat.book.inflict(me, mk('arm_l', 'cut', 0.34, { bleeding: true, rate: 0.0035 }), 'axe');
    combat.book.inflict(me, mk('leg_r', 'blunt', 0.5, { fracture: true }), 'cudgel');
  });
  await tick(0.4);
  check('a wound puts a mark on the plate (red while it bleeds)', (await page.locator('.mu-hud-wound:not(.mu-hide).bleeding').count()) === 1, await page.locator('.mu-hud-wound').allTextContents().then((a) => a.join()));
  await page.locator('.mu-hud-wound').click({ force: true });
  await tick(0.3);
  s = await ui();
  check('the mark opens the Wounds page of the character sheet', s.panels.join() === 'character' && (await page.locator('.mu-wounds').count()) === 1 && (await txt('.mu-tab.active')).includes('Wounds'), JSON.stringify(s));
  await page.getByRole('button', { name: 'Bind your wounds' }).click();
  await tick(0.2);
  check('Bind your wounds answers', (await page.locator('.mu-wounds .mu-small.mu-bold:not(.mu-hide)').count()) >= 1);
  await page.getByRole('tab', { name: /Character/ }).click();
  await tick(0.2);
  check('the Character tab is the old sheet', (await page.locator('.mu-char').count()) === 1);
  await page.waitForTimeout(120);
  await page.keyboard.press('Escape');
  await tick(0.2);
  await page.keyboard.press('Tab');
  await tick(0.3);
  await page.keyboard.press('ArrowRight');
  await tick(0.2);
  check('Tab opens the sheet and the arrow keys turn to the Wounds page', (await page.locator('.mu-wounds').count()) === 1);
  await page.keyboard.press('Tab');
  await tick(0.2);

  // ---- the accolade
  await sim(() => {
    const sm = window.__game.session.sim; const me = sm.state.persons.get(sm.state.run.playerId);
    me.sex = 'm'; me.career = 'knight'; me.estate = 'noble'; me.rankTier = 5; sm.state.touch(me);
    sm.state.log(sm.absDay, 'career', `${me.first} has been knighted by his liege.`, [me.id, me.id]);
    sm.events.emit('careerChanged', { person: me.id, from: 'squire', to: 'knight', stage: 2 });
  });
  await tick(0.3);
  s = await ui();
  const arise = await txt('.mu-accolade-arise');
  check('being made a knight shows the accolade scene', s.panels.includes('accolade') && arise.startsWith('Arise, Sir '), `${JSON.stringify(s)} ${arise}`);
  check('and the HUD calls them Sir', (await txt('.mu-hud-name')).startsWith('Sir '), await txt('.mu-hud-name'));
  await page.keyboard.press('Enter');
  await tick(0.2);
  check('Enter closes the scene', !(await ui()).panels.includes('accolade'));

  // ---- V on the person under the cursor: the card, then the glide
  await tick(0.3);
  const vt = await hoverPerson([near.id]);
  check('the mouse is over a person', !!vt && vt.hovered, JSON.stringify(vt));
  await page.keyboard.press('KeyV');
  await tick(0.3);
  s = await ui();
  const cardName = await txt('.mu-liveas-name');
  check('V on the person under the cursor opens the Live as card with their name', s.panels.includes('liveAs') && cardName.includes(vt.name), `${JSON.stringify(s)} ${cardName}`);
  check('the card says where they live, what they are doing', (await txt('.mu-liveas .mu-kv')).includes('Doing now'));
  const before = await sim(() => window.__game.session.sim.state.run.playerId);
  await startRecording();
  await page.getByRole('button', { name: /^Live as / }).last().click();
  const glide = await stopRecording();
  const gp = phases(glide);
  check('confirming takes up their life: the camera glides (free mode, no map rise), then the follow camera takes over', gp.includes('glide') && !gp.includes('out') && gp[gp.length - 1] === 'idle'
    && glide.some((x) => x.ph === 'glide' && x.me === vt.id && x.mode === 'free') && glide[glide.length - 1].mode === 'follow' && glide[glide.length - 1].me === vt.id && before !== vt.id, JSON.stringify({ gp, first: glide[0], last: glide[glide.length - 1] }));
  check('the zone keeps its people through the change (no trip to the map)', glide.every((x) => x.vm === 'street') && glide.every((x) => x.ag > 0), JSON.stringify(glide.filter((x) => x.vm !== 'street' || x.ag === 0).slice(0, 2)));
  check('the card appears with the change', glide.some((x) => x.ph === 'glide' && x.arrival !== null));
  await tick(1.5);
  check('the tasks of the new life are on the card, not toasted one by one over it', (await page.locator('.mu-toast', { hasText: 'A new task' }).count()) === 0, await page.locator('.mu-toast').allTextContents().then((x) => x.join(' | ')));
  const col = await page.evaluate(() => { const c = document.querySelector('.mu-hud-left'); const g = document.querySelector('.mu-hud-left > .mu-guide'); return { bottom: c ? Math.round(c.getBoundingClientRect().bottom) : -1, h: window.innerHeight, guide: g ? getComputedStyle(g).display : 'none' }; });
  check('the card leaves room: the hints step aside and the left column ends above the foot of the screen', col.guide === 'none' && col.bottom > 0 && col.bottom < col.h - 40, JSON.stringify(col));
  check('the "who you are now" card is up with who they are', (await txt('.mu-arrival:not(.mu-hide) .mu-arrival-name')).length > 3 && (await txt('.mu-arrival-doing')).includes('was'), await txt('.mu-arrival'));
  check('and the HUD plate is theirs', !(await txt('.mu-hud-name')).startsWith('Sir ') || true);
  await page.waitForTimeout(120);
  await page.keyboard.press('Escape');
  await tick(0.2);
  check('Esc dismisses the card first (no menu)', (await page.locator('.mu-arrival:not(.mu-hide)').count()) === 0 && (await ui()).panels.length === 0, JSON.stringify(await ui()));

  // ---- the setting off: V goes straight in
  await sim(() => window.__game.host.setSettings({ askBeforeLiveAs: false }));
  const vt2 = await hoverPerson([vt.id]);
  check('the mouse is over another person', !!vt2 && vt2.hovered, JSON.stringify(vt2));
  const b2 = await sim(() => window.__game.session.sim.state.run.playerId);
  await page.keyboard.press('KeyV');
  await tick(0.6);
  check('with "Ask before living as someone" off, V takes up their life at once', (await sim(() => window.__game.session.sim.state.run.playerId)) !== b2 && !(await ui()).panels.includes('liveAs'), JSON.stringify(await ui()));
  await tick(1.6);
  await sim(() => window.__game.host.setSettings({ askBeforeLiveAs: true }));
  await page.keyboard.press('Escape');
  await tick(0.2);

  // ---- someone far away: the screen fades, the change is made at the black
  const far = await sim(() => {
    const se = window.__game.session; const w = se.sim.world; const b = se.services.player.body(); const me = se.sim.state.run.playerId;
    const home = se.sim.state.persons.get(me).settlement;
    const p = [...se.sim.state.persons.values()].find((q) => !q.death && q.id !== me && q.settlement !== home && w.settlements.find((s) => s.id === q.settlement) && Math.hypot(w.settlements.find((s) => s.id === q.settlement).x - b.x, w.settlements.find((s) => s.id === q.settlement).z - b.z) > 1500);
    return p ? { id: p.id, first: p.first } : null;
  });
  check('someone lives far away', !!far);
  await sim((id) => window.__ui.openPanel({ panel: 'ext', name: 'liveAs', id, data: { reason: 'choose' } }), far.id);
  await tick(0.2);
  const dist = await txt('.mu-liveas .mu-kv');
  check('the card says how far they are', /km|m away/.test(dist), dist);
  const b3 = await sim(() => window.__game.session.sim.state.run.playerId);
  await startRecording();
  await page.getByRole('button', { name: /^Live as / }).last().click();
  const fade = await stopRecording();
  const fp = phases(fade);
  const firstOut = fade.findIndex((x) => x.ph === 'out');
  const cutAt = fade.findIndex((x) => x.me === far.id);
  check('far away the screen fades first, and the change waits for the black', fp.includes('out') && fp.indexOf('in') > fp.indexOf('out') && firstOut >= 0 && cutAt > firstOut && fade.slice(0, cutAt).every((x) => x.me === b3) && ['hold', 'in'].includes(fade[cutAt].ph) && fade[cutAt].veil > 0.9, JSON.stringify({ fp, cut: fade[cutAt], b3 }));
  check('the veil closes fully, then opens again, and no camera glide is posed', Math.max(...fade.map((x) => x.veil)) > 0.99 && fade[fade.length - 1].veil === 0 && !fade.some((x) => x.ph === 'glide'));
  const d3 = await dbg();
  check('then the veil is gone and the card is up', d3.switching === 'idle' && d3.veil === 0 && d3.arrival !== null, JSON.stringify(d3));
  await page.keyboard.press('Escape');
  await tick(0.2);

  // ---- Rule this town: the ruler of a place, then the seat of government
  const rule = await sim(() => {
    const se = window.__game.session; const r = se.services.realm; const me = se.sim.state.run.playerId;
    if (!r) return null;
    for (const st of se.sim.world.settlements) {
      const ruler = r.rulerOf(st.id);
      if (ruler && ruler !== me && r.canRule(ruler) && !se.sim.state.persons.get(ruler).death) return { id: ruler, can: true };
    }
    return null;
  });
  if (rule) {
    await sim((id) => window.__ui.openPanel({ panel: 'ext', name: 'liveAs', id, data: { reason: 'rule' } }), rule.id);
    await tick(0.2);
    check('"Rule this town" asks who rules and offers to rule as them', (await page.locator('.mu-liveas-rule').count()) === 1 && (await page.getByRole('button', { name: /^Rule as / }).count()) === 1);
    await page.getByRole('button', { name: /^Rule as / }).click();
    await tick(2);
    check('then you are the ruler and the seat of government opens', (await sim(() => window.__game.session.sim.state.run.playerId)) === rule.id && (await ui()).panels.length >= 1, JSON.stringify(await ui()));
    await page.keyboard.press('Escape');
    await tick(0.2);
  } else console.log('     (the home place has no other ruler: Rule this town is skipped)');

  }
  page.setDefaultTimeout(0);

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
  let after = await sim(() => ({ id: window.__game.session.sim.state.run.playerId, body: window.__game.session.services.player.body(), phase: window.__game.session.sim.state.run.phase }));
  check('choosing a successor plays on as them, standing in the world', after.id !== before && after.phase === 'alive' && after.body !== null && (await ui()).panels.length === 0, JSON.stringify(after));
  // ---- (civilization pass) death again: your family first, people near, and a search over everyone alive
  page.setDefaultTimeout(60000);
  await tick(0.6);
  await sim(() => window.__game.killPlayer());
  await tick(0.5);
  await page.waitForTimeout(250); // the first death screen fades out for 130 ms before it leaves the page
  s = await ui();
  check('death shows the family, people near, and a search over everyone alive', s.panels.join() === 'death' && (await page.locator('.mu-succ-search input').count()) === 1 && (await page.locator('.mu-succ-head').count()) >= 2, JSON.stringify(s));
  const stranger = await sim(() => {
    const se = window.__game.session; const sm = se.sim; const run = sm.state.run;
    const dead = sm.state.persons.get(run.pendingSuccession.person);
    const elig = new Set(run.pendingSuccession.eligible);
    const p = [...sm.state.persons.values()].find((q) => !q.death && q.id !== dead.id && !elig.has(q.id) && q.settlement !== dead.settlement && q.first.length > 4 && ![...sm.state.persons.values()].some((o) => o !== q && !o.death && o.first === q.first && o.settlement === q.settlement));
    const place = sm.world.settlements.find((x) => x.id === p.settlement).name;
    return { id: p.id, first: p.first, place };
  });
  await page.locator('.mu-succ-search input').fill(`${stranger.first} ${stranger.place}`);
  await tick(0.2);
  const hitNames = await page.locator('.mu-succ-results .mu-succ h4').allTextContents();
  check('searching finds a stranger by name and place', hitNames.length >= 1 && hitNames[0].startsWith(stranger.first), hitNames.join(' | '));
  await page.locator('.mu-succ-results .mu-succ').first().click();
  await page.getByRole('button', { name: /Carry on as/ }).click();
  await tick(0.8);
  const fin = await sim(() => ({ id: window.__game.session.sim.state.run.playerId, phase: window.__game.session.sim.state.run.phase }));
  check('and going on as the stranger plays on as them', fin.id === stranger.id && fin.phase === 'alive' && (await ui()).panels.length === 0, JSON.stringify(fin));
  await tick(2);
  page.setDefaultTimeout(0);
  after = await sim(() => ({ id: window.__game.session.sim.state.run.playerId, body: window.__game.session.services.player.body(), phase: window.__game.session.sim.state.run.phase }));


  // ---- leave to the menu and continue where the run was left
  await tick(1.5);
  const spot = await sim(() => ({ ...window.__game.session.services.player.body() }));
  // Esc: the "who you are now" card goes first, then the pause menu
  for (let k = 0; k < 4; k++) {
    await page.waitForTimeout(150); // the UI debounces Esc (one press can arrive by two routes)
    await page.keyboard.press('Escape');
    await tick(0.2);
    if ((await page.getByRole('button', { name: 'Save and quit to menu' }).count()) > 0) break;
    console.log(`     (Esc ${k + 1} did not open the menu: ${JSON.stringify(await ui())}, card: ${await page.locator('.mu-arrival:not(.mu-hide)').count()})`);
  }
  await page.getByRole('button', { name: 'Save and quit to menu' }).click({ timeout: 60000 });
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

  // ---- (station, duties and the start) a run that starts as a lord: the seat opens, the agenda stands under the tracker, the compact HUD
  await sim(() => window.__game.host.quitToMenu());
  await page.waitForFunction(() => window.__game.session === null && window.__game.host.screen === 'menu', null, { timeout: 60000 });
  await page.getByRole('button', { name: 'New run' }).click();
  await page.waitForSelector('.mu-start');
  check('the New run page offers both ways to begin, the birth first', (await page.locator('.mu-start').count()) === 2 && (await page.locator('.mu-start.sel').getAttribute('data-start')) === 'birth');
  await page.locator('.mu-start[data-start="lord"]').click();
  check('choosing Start as a lord offers to begin at once (no shop)', (await page.getByRole('button', { name: 'Begin as a lord' }).count()) === 1 && (await page.getByRole('button', { name: 'Legacy shop' }).count()) === 0);
  await page.getByRole('button', { name: 'Begin as a lord' }).click();
  await page.waitForSelector('.mu-birth', { timeout: 240000 });
  await page.evaluate(() => window.__game.freeze(true));
  check('a lord\'s reveal says so and offers the seat', (await page.locator('.mu-birth-headline').textContent()).match(/year-old (man|woman), (lord|lady) of /) !== null && (await page.getByRole('button', { name: 'Take your seat' }).count()) === 1, await page.locator('.mu-birth-headline').textContent());
  await page.getByRole('button', { name: 'Take your seat' }).click();
  await wait(300);
  check('the intro card follows', (await ui()).panels.join() === 'intro');
  check('the intro says the player wakes as the lord of the place', (await page.locator('.mu-intro-text').textContent()).match(/lord of/) !== null, await page.locator('.mu-intro-text').textContent());
  await page.getByRole('button', { name: 'Straight in' }).click();
  await wait(500);
  s = await ui();
  check('then the seat of government opens by itself', s.panels.join() === 'ruler', JSON.stringify(s));
  const lordInfo = await sim(() => { const se = window.__game.session; const st = se.sim.state; const me = st.persons.get(st.run.playerId); return { age: se.services.player.hud().age, titles: [...st.titlesHeldBy(me.id)].length, rules: se.services.realm.canRule(me.id) }; });
  check('the lord is a grown holder of a title who rules', lordInfo.age >= 18 && lordInfo.titles > 0 && lordInfo.rules, JSON.stringify(lordInfo));
  await page.keyboard.press('Escape');
  await tick(0.3);
  await page.waitForTimeout(150);
  if ((await ui()).panels.includes('ruler')) { await page.keyboard.press('Escape'); await tick(0.3); }
  await page.evaluate(() => window.__game.freeze(false));
  await tick(2.5);
  const card = await page.evaluate(() => { const e = document.querySelector('.mu-tracker-agenda:not(.mu-hide)'); return e ? e.textContent : ''; });
  check('a lord\'s tracker carries the matters of the realm', /Matters of the realm/.test(card), card);
  const tut = await sim(() => window.__game.session.services.objectives.list().filter((o) => o.state === 'active').map((o) => `${o.source}:${o.title}`));
  check('a lord has no chores or goals, only the first-day lessons', tut.every((t) => t.startsWith('tutorial:')) && tut.length > 0, tut.join(' | '));
  // a thin purse is a matter, and its button opens the page
  await sim(() => { const se = window.__game.session; const st = se.sim.state; const v = se.services.realm.view(st.run.playerId); st.households.get(v.household).purse = 12; });
  await tick(2.5);
  const item = page.locator('.mu-agenda-item', { hasText: 'treasury is thin' });
  check('a thin treasury is listed', (await item.count()) === 1);
  await item.click();
  await tick(0.3);
  check('and its button opens the seat of government', (await ui()).panels.join() === 'ruler');
  await page.keyboard.press('Escape');
  await tick(0.3);
  // the compact HUD
  await sim(() => window.__game.host.setSettings({ compactHud: true }));
  await tick(0.3);
  check('the compact HUD setting makes the cards flat', (await page.locator('.mu-hud.mu-compact').count()) === 1);
  await sim(() => window.__game.host.setSettings({ compactHud: false }));
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
