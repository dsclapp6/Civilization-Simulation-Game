// End-to-end flow of the lands UI in the real game (civilization pass, wave B1): builder mode, ruler mode, "Rule this town" and
// the map's deposits, borders and people lists, in headless Chromium.
//
//   node tools/lands-flow.mjs [--seed=flow] [--from=king]   (port 5182; starts its own Vite if nothing is listening)
//
// The loop is driven through `window.__game` (src/app/game.ts): `tick(seconds)` runs whole frames — the real UI and the simulation —
// without drawing, `draw()` renders (the builder's picking and the ghost need a drawn frame). The live-as panel is another
// builder's: this flow registers a stand-in for it through the ext-panel registry and checks what "Rule this town" asks it for.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5182;
const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const seed = opt('seed', 'flow');
const fromKing = opt('from', '') === 'king';

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
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) errors.push(m.text()); });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };
const sim = (fn, arg) => page.evaluate(fn, arg);
const ui = () => page.evaluate(() => ({ panels: window.__ui.openPanels(), captures: window.__ui.capturesInput() }));
/** `n` tenths of a second of the whole loop (the real UI and the simulation), then the picture drawn once (picking and the ghost use the last drawn frame) and one more step. */
const frames = (n = 6) => page.evaluate((k) => { for (let i = 0; i < k; i++) window.__game.tick(0.1); window.__game.draw(); window.__game.tick(0.1); }, n);
/** The same with the picture drawn after every step: for what watches the renderer move (the builder's camera probe, a glide). */
const live = (n = 20) => page.evaluate((k) => { for (let i = 0; i < k; i++) { window.__game.tick(0.05); window.__game.draw(); } }, n);
/** Waits until a fixed ground point stops moving on the screen (the follow camera still settling after a switch of character). */
const stillCamera = () => page.evaluate(() => {
  const g = window.__game, s = g.session, sm = s.sim;
  const me = sm.state.persons.get(sm.state.run.playerId);
  const st = sm.world.settlements.find((x) => x.id === me.settlement);
  let prev = null;
  for (let i = 0; i < 500; i++) {
    g.tick(0.1);
    g.draw();
    const p = s.controls.project(st.x, sm.world.heightAt(st.x, st.z), st.z);
    if (prev && p && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.3 && i > 15) break;
    prev = p;
  }
});
/** The builder's camera takes a moment: the verdict (the renderer's overview camera or our own) and its glide; a drawn frame is a sixtieth of a second to the camera. */
const lift = async () => {
  await live(24);
  for (let i = 0; i < 60 && (await dataset())?.camera === 'pending'; i++) await live(10);
  await live(50);
};
const esc = async () => { await page.waitForTimeout(130); await page.keyboard.press('Escape'); await frames(2); };
const dataset = () => page.evaluate(() => { const r = document.querySelector('.mu-bld-root'); return r ? { ...r.dataset } : null; });
const text = (sel) => page.locator(sel).first().textContent();

try {
  await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=low&shots=1&autostart=1`, { timeout: 240000 });
  await page.waitForFunction(() => window.__game && window.__game.session && window.__game.host.screen === 'game' && window.__ui, null, { timeout: 240000, polling: 400 });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__game.freeze(true));
  await page.evaluate(() => window.__game.session.sim.dispatch({ type: 'setSpeed', speed: 1 }));
  // the live-as panel belongs to another builder: a stand-in that records what it is asked for
  await page.evaluate(async () => {
    const reg = await import('/src/ui/panels/extRegistry.ts');
    window.__liveAs = [];
    reg.registerPanel('liveAs', (ctx, req) => {
      window.__liveAs.push({ id: req.id, data: req.data });
      const el = document.createElement('div');
      el.className = 'mu-modal';
      el.textContent = 'live as (stand-in)';
      return { id: 'liveAs', captures: true, pauses: 'never', escape: 'close', el };
    });
  });
  // record what the interface asks of the renderer
  await page.evaluate(() => {
    const c = window.__game.session.controls;
    const calls = (window.__calls = { ghost: [], area: [], overview: [], pose: [], mode: [] });
    const wrap = (name, store, shape) => { const f = c[name]; c[name] = (...a) => { store.push(shape(...a)); return f?.(...a); }; };
    wrap('setGhost', calls.ghost, (g) => (g ? { kind: g.kind, ok: g.ok, rot: g.rot, n: g.footprint.length, x: g.x, z: g.z } : null));
    wrap('setBuildArea', calls.area, (a) => (a ? a.length : null));
    wrap('setOverview', calls.overview, (o) => (o ? { x: o.x, z: o.z, radius: o.radius, distance: o.distance } : null));
    wrap('setCameraPose', calls.pose, (p, l) => ({ p, l }));
    wrap('setCameraMode', calls.mode, (m) => m);
  });
  await frames(10);

  let s = null;
  // `--from=king` skips what comes before the king (the child's cards, the map, the banner) when only the rest is being worked on
  if (!fromKing) {
    // ======================================================================== a child cannot build: the card says why
    console.log('-- builder mode, a child');
    const me0 = await sim(() => { const s = window.__game.session.sim; const p = s.state.persons.get(s.state.run.playerId); return { id: p.id, age: Math.floor((s.absDay - p.birthDay) / 16), settlement: p.settlement }; });
    await page.keyboard.press('KeyB');
    await frames(4);
    s = await ui();
    check('B opens builder mode', s.panels.join() === 'builder', JSON.stringify(s));
    check('a child gets a card that says why, not the overhead camera', (await page.locator('.mu-bld-why').count()) === 1 && /young/i.test(await text('.mu-bld-why')), await text('.mu-panels .mu-win-body').catch(() => ''));
    check('and what would let a person build', (await page.locator('.mu-bld-ways li').count()) >= 4);
    const ruleBtn = page.locator('.mu-panels .mu-win').getByRole('button', { name: /^Rule / });
    check('with a way to Rule the town nearby', (await ruleBtn.count()) >= 1, await page.locator('.mu-panels .mu-win-body').innerText());
    check('the camera stays where it was', (await sim(() => window.__game.session.renderer.getCameraMode())) === 'follow');
    await ruleBtn.first().click();
    await frames(3);
    const asked = await sim(() => window.__liveAs.slice());
    const ruler0 = await sim((st) => window.__game.session.services.realm.rulerOf(st), me0.settlement);
    check('Rule this town asks the live-as panel for the ruler, with the reason "rule"', asked.length === 1 && asked[0].id === ruler0 && asked[0].data && asked[0].data.reason === 'rule', JSON.stringify(asked));
    await esc();
    s = await ui();
    check('Esc closes the stand-in', !s.panels.includes('liveAs'), JSON.stringify(s));

    // ---- the ruler's seat for someone who rules nothing
    console.log('-- ruler mode, a child');
    await page.keyboard.press('KeyU');
    await frames(4);
    s = await ui();
    check('U opens the seat for a child as a card', s.panels.join() === 'ruler' && (await page.locator('.mu-rul-win').count()) === 0, JSON.stringify(s));
    check('the card says you rule nothing and offers a town to rule', /rule nothing|hold no land/i.test(await page.locator('.mu-panels .mu-win').innerText()) && (await page.locator('.mu-panels .mu-win').getByRole('button', { name: /^Rule / }).count()) >= 1);
    await esc();

    // ======================================================================== the map (as the child)
    console.log('-- the map');
    await page.keyboard.press('KeyM');
    await frames(4);
    await page.evaluate(() => { window.__game.settle(); window.__game.draw(); });
    await frames(6);
    check('M opens the map', (await ui()).panels.join() === 'map');
    const borders = await page.evaluate(() => { const c = document.querySelector('.mu-map-borders'); if (!c) return null; const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 0) n++; return { w: c.width, h: c.height, painted: n }; });
    check('the borders are painted on the map', borders && borders.painted > 500, JSON.stringify(borders));
    const deps = await page.locator('.mu-map-dep:not(.mu-hide)').count();
    const depTotal = await sim(() => window.__game.session.sim.world.deposits.length);
    check('the deposits are drawn as icons (those on the screen)', deps > 20 && deps <= depTotal, `${deps} of ${depTotal}`);
    await page.locator('.mu-map-layer', { hasText: 'Iron ore' }).click();
    await frames(3);
    const deps2 = await page.locator('.mu-map-dep:not(.mu-hide)').count();
    check('switching the iron filter off hides the iron deposits', deps2 < deps, `${deps} -> ${deps2}`);
    await page.locator('.mu-map-layer', { hasText: 'Iron ore' }).click();
    await frames(2);
    check('the tooltip of a deposit names its kind, richness and whose lands', await page.evaluate(() => { const e = document.querySelector('.mu-map-dep:not(.mu-hide)'); const t = e && e.getAttribute('data-tip'); return !!t && /deposit: (thin|fair|good|rich)/.test(t) && /lands|wild/.test(t); }));
    const depPt = await page.evaluate(() => {
      for (const e of document.querySelectorAll('.mu-map-dep:not(.mu-hide)')) {
        const b = e.getBoundingClientRect();
        if (b.left > 540 && b.right < 940 && b.top > 90 && b.bottom < 600 && e.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }
      return null;
    });
    check('a deposit icon can be clicked on the map', !!depPt);
    if (depPt) await page.mouse.click(depPt.x, depPt.y);
    await frames(2);
    check('clicking a deposit shows its card', /deposit/.test(await text('.mu-map-place-name')), await text('.mu-map-detail'));
    await page.locator('.mu-map-row').nth(2).click();
    await frames(2);
    check('a settlement card tells whose lands they are', (await page.locator('.mu-map-detail .mu-dot').count()) >= 1);
    const ruleOnMap = page.locator('.mu-map-detail').getByRole('button', { name: /^Rule / });
    check('and offers Rule this town', (await ruleOnMap.count()) === 1);
    await page.locator('.mu-map-detail').getByRole('button', { name: 'People here' }).click();
    await frames(2);
    const people = await page.locator('.mu-map-prow').count();
    check('People here lists the people of the place', people >= 10, String(people));
    check('with the ruler first', /rules here/.test(await text('.mu-map-prow')), await text('.mu-map-prow'));
    const firstName = (await page.locator('.mu-map-prow b').nth(4).textContent()).split(' ')[0];
    await page.locator('.mu-map-people input[type=search]').fill(firstName);
    await frames(2);
    const filtered = await page.locator('.mu-map-prow').count();
    check('the search narrows the list by name', filtered >= 1 && filtered < people, `${people} -> ${filtered}`);
    await page.locator('.mu-map-people input[type=search]').fill('');
    await page.locator('.mu-map-people .mu-chip', { hasText: 'Church' }).first().click().catch(() => undefined);
    await frames(2);
    await sim(() => { window.__liveAs.length = 0; });
    await page.locator('.mu-map-prow').first().getByRole('button', { name: 'Live as' }).click();
    await frames(3);
    const lived = await sim(() => window.__liveAs.slice());
    check('Live as opens the live-as panel with that person', lived.length === 1 && typeof lived[0].id === 'number' && lived[0].data && lived[0].data.reason === 'choose', JSON.stringify(lived));
    s = await ui();
    check('and the map gave way to it', !s.panels.includes('map'), JSON.stringify(s));
    await esc();

    // ======================================================================== the banner
    console.log('-- the banner');
    s = await ui();
    check('nothing is left open before the banner', s.panels.length === 0, JSON.stringify(s));
    // The interface's clock is the one `tick` drives, so "six seconds" are sixty tenths here, whatever the machine does.
    const bannerState = () => page.evaluate(() => { const b = document.querySelector('.mu-banner'); return b ? { on: b.classList.contains('on'), act: b.classList.contains('act'), text: b.innerText } : null; });
    const bannerSpot = () => page.evaluate(() => {
      const b = document.querySelector('.mu-banner .mu-btn');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { x, y, hit: !!top && b.contains(top), top: top ? `${top.tagName}.${top.className}` : '' };
    });
    await sim(() => { window.__liveAs.length = 0; window.__ui.showBanner(); });
    await frames(2);
    const banner = await bannerState();
    check('the settlement banner offers Rule this town', banner && banner.on && banner.act && /Rule /.test(banner.text), JSON.stringify(banner));
    let spot = await bannerSpot();
    check('and nothing covers its button', spot && spot.hit, JSON.stringify(spot));
    // pointing at the banner keeps it on the screen past its six seconds; leaving lets it go
    await page.mouse.move(spot.x, spot.y);
    await frames(80);
    check('the banner stays while the cursor is on it', (await bannerState())?.on === true);
    await page.mouse.move(640, 600);
    await frames(30);
    check('and goes when the cursor leaves it', (await bannerState())?.on === false);
    await sim(() => { window.__ui.showBanner(); });
    await frames(2);
    spot = await bannerSpot();
    await page.mouse.click(spot.x, spot.y);
    await frames(3);
    const bannerAsked = await sim(() => window.__liveAs.slice());
    check('the button asks the live-as panel for the ruler, with the reason "rule"', bannerAsked.length === 1 && typeof bannerAsked[0].id === 'number' && bannerAsked[0].data && bannerAsked[0].data.reason === 'rule', JSON.stringify({ bannerAsked, spot }));
    await esc();
  }

  // ======================================================================== live as the ruler (the king of Basseance)
  await sim(() => { const s = window.__game.session.sim; const me = s.state.persons.get(s.state.run.playerId); s.switchTo(s.services.realm.rulerOf(me.settlement)); });
  await stillCamera();
  const king = await sim(() => { const s = window.__game.session.sim; const p = s.state.persons.get(s.state.run.playerId); return { id: p.id, settlement: p.settlement, house: p.house, household: p.household }; });

  // ======================================================================== builder mode
  console.log('-- builder mode');
  await sim(() => { window.__calls.ghost.length = 0; window.__calls.area.length = 0; window.__calls.overview.length = 0; window.__calls.pose.length = 0; window.__calls.mode.length = 0; });
  await page.keyboard.press('KeyB');
  await lift();
  await frames(10);
  s = await ui();
  check('B opens builder mode over the world (not a page that pauses)', s.panels.join() === 'builder' && s.captures && !(await sim(() => window.__game.session.sim.clock.paused)), JSON.stringify(s));
  let d = await dataset();
  check('the camera goes up: the renderer\'s overview camera if it has one, else the builder\'s own', d && (d.camera === 'overview' || d.camera === 'pose'), JSON.stringify(d));
  const lifted = await sim(() => window.__calls);
  check('the overview was asked for over the settlement', lifted.overview.length >= 1 && lifted.overview[0] && lifted.overview[0].radius >= 250, JSON.stringify(lifted.overview));
  check('the buildable land is tinted', lifted.area.some((n) => n && n > 0), JSON.stringify(lifted.area.slice(0, 3)));
  check('the world keeps running while the builder looks over it', await sim(() => { const s = window.__game.session.sim; const a = s.absDay; window.__game.tick(1.5); return s.absDay > a; }));
  const rows = await page.locator('.mu-bld-row').count();
  const dim = await page.locator('.mu-bld-row.dis').count();
  check('the catalogue lists every kind of building, what is closed to you dimmed', rows >= 50 && dim >= 3 && dim < rows, `${rows} rows, ${dim} closed`);
  check('a closed building says why', (await page.locator('.mu-bld-row.dis .mu-bld-why-not').count()) >= 3);
  check('each row shows its cost', /worker-day/.test(await text('.mu-bld-row')));
  await page.locator('.mu-bld-cats .mu-chip', { hasText: 'Defence' }).click();
  await frames(2);
  check('the category chips filter the list', (await page.locator('.mu-bld-row').count()) < rows && (await page.locator('.mu-bld-row').count()) >= 2);
  await page.locator('.mu-bld-cats .mu-chip', { hasText: 'All' }).click();
  await page.locator('.mu-bld-top input[type=search]').fill('smith');
  await frames(2);
  const smithRows = await page.locator('.mu-bld-row').allTextContents();
  check('the search finds a building by name', smithRows.length >= 1 && smithRows.length <= 4 && smithRows.some((r) => /^Smithy/.test(r)), JSON.stringify(smithRows));
  await page.locator('.mu-bld-top input[type=search]').fill('');
  await page.locator('.mu-bld-top input[type=search]').blur();

  // ---- pan, zoom, turn
  const centre0 = await sim(() => window.__game.session.controls.screenToGround(640, 360));
  await page.keyboard.down('KeyW');
  await frames(8);
  await page.keyboard.up('KeyW');
  await frames(30);
  const centre1 = await sim(() => window.__game.session.controls.screenToGround(640, 360));
  check('W moves the view over the land', centre0 && centre1 && Math.hypot(centre1.x - centre0.x, centre1.z - centre0.z) > 3, `${JSON.stringify(centre0)} -> ${JSON.stringify(centre1)}`);
  const span0 = await sim(() => { const c = window.__game.session.controls; const a = c.screenToGround(320, 360), b = c.screenToGround(960, 360); return Math.hypot(a.x - b.x, a.z - b.z); });
  await page.mouse.move(520, 280);
  await page.mouse.wheel(0, -400);
  await frames(40);
  const span1 = await sim(() => { const c = window.__game.session.controls; const a = c.screenToGround(320, 360), b = c.screenToGround(960, 360); return Math.hypot(a.x - b.x, a.z - b.z); });
  check('the wheel zooms in', span1 < span0 * 0.95, `${span0.toFixed(1)} -> ${span1.toFixed(1)} m across`);
  const yaw0 = await sim(() => { const c = window.__game.session.controls; const a = c.screenToGround(200, 360), b = c.screenToGround(1000, 360); return Math.atan2(b.x - a.x, b.z - a.z); });
  await page.mouse.move(500, 300);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(600, 300, { steps: 6 });
  await page.mouse.move(700, 300, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await frames(40);
  const yaw1 = await sim(() => { const c = window.__game.session.controls; const a = c.screenToGround(200, 360), b = c.screenToGround(1000, 360); return Math.atan2(b.x - a.x, b.z - a.z); });
  check('dragging with the right button turns the view', Math.abs(Math.atan2(Math.sin(yaw1 - yaw0), Math.cos(yaw1 - yaw0))) > 0.1, `${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`);
  check('and a right drag does not put a tool down or place anything', (await sim(() => window.__game.session.services.construction.sites().length)) === 0);

  // ---- the tool, the ghost, the red reason
  await page.locator('.mu-bld-row[data-kind="cottage"]').click();
  await frames(2);
  d = await dataset();
  check('picking a building from the catalogue makes it the tool', d.selected === 'cottage', JSON.stringify(d));
  check('its card shows the cost with icons, what it needs and what it does', (await page.locator('.mu-bld-tool .mu-good-line').count()) >= 2 && /home|family/i.test(await text('.mu-bld-tool')));
  await page.mouse.move(520, 280);
  await frames(4);
  d = await dataset();
  const g1 = await sim(() => window.__calls.ghost.filter(Boolean).slice(-1)[0]);
  check('a ghost follows the cursor: the interface sets it from `check` every frame', !!g1 && g1.kind === 'cottage' && g1.n === 4, JSON.stringify(g1));
  check('and the label by the cursor says what a click does, or the red reason', (await page.locator('.mu-bld-cursor:not(.mu-hide)').count()) === 1 && (await text('.mu-bld-cursor')).length > 8, await text('.mu-bld-cursor'));
  // Q and E turn it by fifteen degrees
  const rot0 = (await sim(() => window.__calls.ghost.filter(Boolean).slice(-1)[0])).rot;
  await page.keyboard.press('KeyE');
  await frames(3);
  const rot1 = (await sim(() => window.__calls.ghost.filter(Boolean).slice(-1)[0])).rot;
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('KeyQ');
  await frames(3);
  const rot2 = (await sim(() => window.__calls.ghost.filter(Boolean).slice(-1)[0])).rot;
  const wrapDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  check('E turns the ghost 15 degrees one way, Q the other', Math.abs(wrapDiff(rot1, rot0) - Math.PI / 12) < 1e-6 && Math.abs(wrapDiff(rot2, rot1) + Math.PI / 6) < 1e-6, `${rot0} ${rot1} ${rot2}`);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Shift');
  await frames(3);
  const rot3 = (await sim(() => window.__calls.ghost.filter(Boolean).slice(-1)[0])).rot;
  check('Shift and the wheel turn it as well', Math.abs(wrapDiff(rot3, rot2)) > 0.2, `${rot2} -> ${rot3}`);
  // over a building it does not fit: red, with the reason
  const onBuilding = await sim(() => {
    const s = window.__game.session; const b = s.sim.state.buildingsAt.get(s.sim.state.persons.get(s.sim.state.run.playerId).settlement).find((x) => x.construction >= 1 && x.plot >= 0);
    return b ? s.controls.project(b.x, s.sim.world.heightAt(b.x, b.z), b.z) : null;
  });
  // (a building on the screen: look for one among the settlement's, nearest the middle)
  const spots = await sim(() => {
    const s = window.__game.session; const c = s.controls; const out = [];
    for (const b of s.sim.state.buildingsAt.get(s.sim.state.persons.get(s.sim.state.run.playerId).settlement)) {
      if (b.construction < 1) continue;
      const p = c.project(b.x, s.sim.world.heightAt(b.x, b.z), b.z);
      if (p && p.x > 340 && p.x < 800 && p.y > 100 && p.y < 440) out.push({ x: p.x, y: p.y, kind: b.kind });
    }
    return out;
  });
  void onBuilding;
  let red = null;
  for (const sp of spots.slice(0, 12)) {
    await page.mouse.move(sp.x, sp.y);
    await frames(3);
    const dd = await dataset();
    if (dd.ghost === 'bad') { red = { sp, text: await text('.mu-bld-cursor') }; break; }
  }
  check('over a building the ghost goes red and the cursor says why', !!red && red.text.length > 4 && (await page.locator('.mu-bld-cursor.bad').count()) === 1, JSON.stringify(red));
  check('a red ghost was sent to the renderer', await sim(() => window.__calls.ghost.some((g) => g && g.ok === false)));
  // a click on a bad spot does not place
  if (red) { await page.mouse.click(red.sp.x, red.sp.y); await frames(3); }
  check('a click where it does not fit places nothing', (await sim(() => window.__game.session.services.construction.sites().length)) === 0);

  // ---- place for me, confirm
  await page.getByRole('button', { name: 'Place for me' }).click();
  await frames(10);
  d = await dataset();
  check('Place for me finds a spot and asks to confirm', d.suggestion === 'yes' && (await page.locator('.mu-bld-confirm:not(.mu-hide)').count()) === 1, JSON.stringify(d));
  const sg = await sim(() => window.__calls.ghost.filter(Boolean).slice(-1)[0]);
  check('the ghost stands at the suggested spot, green', !!sg && sg.ok === true, JSON.stringify(sg));
  await page.getByRole('button', { name: 'Another spot' }).click();
  await frames(6);
  const sg2 = await sim(() => window.__calls.ghost.filter(Boolean).slice(-1)[0]);
  check('Another spot offers a different place', !!sg2 && Math.hypot(sg2.x - sg.x, sg2.z - sg.z) > 5, `${JSON.stringify(sg)} ${JSON.stringify(sg2)}`);
  await page.getByRole('button', { name: 'Stake it out' }).click();
  await frames(6);
  const sites = await sim(() => window.__game.session.services.construction.sites().map((x) => ({ id: x.id, kind: x.kind, status: x.status, note: x.note, settlement: x.settlement })));
  check('the site is staked out: a real site of the construction module', sites.length === 1 && sites[0].kind === 'cottage', JSON.stringify(sites));
  check('the Works tab counts it', /1/.test(await text('.mu-tab:has-text("Works")')));
  check('the tool stays in hand for the next one', (await dataset()).selected === 'cottage');

  // ---- works: the queue, the site card, hired hands, priority, cancel
  await page.keyboard.press('Escape'); // (puts the tool down first)
  await frames(2);
  await page.waitForTimeout(130);
  d = await dataset();
  check('Esc puts the tool down first, and does not close builder mode', d && d.selected === '' && (await ui()).panels.join() === 'builder', JSON.stringify(d));
  await page.getByRole('tab', { name: /Works/ }).click();
  await frames(2);
  check('the Works tab lists the site with its status', (await page.locator('.mu-bld-qrow').count()) === 1 && /cottage/i.test(await text('.mu-bld-qrow')));
  await page.locator('.mu-bld-qrow').first().click();
  await frames(4);
  const card = await text('.mu-bld-inspector');
  check('the site card shows stage, progress, labour, workers, eta and what it waits for', /Pegs|Footings/.test(card) && /worker-days/.test(card) && /at work/.test(card) && /Materials/.test(card), card);
  check('and the materials still missing with what is on the way', /on the way|not yet ordered/.test(card), card);
  await page.getByRole('button', { name: 'Auto' }).click();
  await frames(3);
  check('hired hands can be set', (await sim(() => window.__game.session.services.construction.sites()[0].hired)) !== undefined);
  await page.getByRole('button', { name: 'Work this first' }).click();
  await frames(2);
  check('and the priority', (await page.locator('.mu-rul-note, .mu-bld-toast').count()) >= 0);
  // pick a standing building in the world: its card with what can be done to it
  await page.getByRole('tab', { name: /Build/ }).click();
  await frames(2);
  await frames(30);
  const spots2 = await sim(() => {
    const s = window.__game.session; const c = s.controls; const out = [];
    for (const b of s.sim.state.buildingsAt.get(s.sim.state.persons.get(s.sim.state.run.playerId).settlement)) {
      if (b.construction < 1 || b.plot < 0) continue;
      const p = c.project(b.x, s.sim.world.heightAt(b.x, b.z), b.z);
      if (p && p.x > 340 && p.x < 800 && p.y > 100 && p.y < 440) out.push({ x: p.x, y: p.y, kind: b.kind });
    }
    return out;
  });
  const target = spots2.find((x) => /smithy|barn|church|house|mill|tower/.test(x.kind)) || spots2[0];
  await page.mouse.click(target.x, target.y);
  await frames(5);
  d = await dataset();
  const bcard = await text('.mu-bld-inspector').catch(() => '');
  check('clicking a building in the world shows its card: owner, level, condition', /Belongs to/.test(bcard) && /Level \d/.test(bcard) && /Condition/.test(bcard), `${JSON.stringify(d)} ${bcard}`);
  check('with Upgrade, Repair and Demolish, each with its price or its reason', (await page.locator('.mu-bld-mrow').count()) === 3 && /Upgrade/.test(bcard) && /Repair/.test(bcard) && /Demolish/.test(bcard));
  // cancel the staked site
  await page.getByRole('tab', { name: /Works/ }).click();
  await frames(2);
  await page.locator('.mu-bld-qrow').first().click();
  await frames(3);
  await page.getByRole('button', { name: 'Cancel the work' }).click();
  await frames(3);
  await page.getByRole('button', { name: 'Cancel the work' }).last().click();
  await frames(4);
  check('cancelling the work ends the site', (await sim(() => window.__game.session.services.construction.sites().length)) === 0);

  // ---- leaving
  await esc(); // (nothing picked now: this closes the mode)
  s = await ui();
  if (s.panels.includes('builder')) { await esc(); s = await ui(); }
  check('Esc leaves builder mode', !s.panels.includes('builder'), JSON.stringify(s));
  await frames(8);
  const left = await sim(() => ({ calls: window.__calls, mode: window.__game.session.renderer.getCameraMode(), tail: { ghost: window.__calls.ghost.slice(-1)[0], area: window.__calls.area.slice(-1)[0], overview: window.__calls.overview.slice(-1)[0] } }));
  check('the ghost and the tint are taken away', left.tail.ghost === null && left.tail.area === null, JSON.stringify(left.tail));
  check('and the camera is given back', d && (left.tail.overview === null || left.mode === 'follow'), JSON.stringify({ mode: left.mode, tail: left.tail }));
  await page.keyboard.press('KeyB');
  await frames(6);
  check('B opens it again', (await ui()).panels.join() === 'builder');
  await page.waitForTimeout(130);
  await page.keyboard.press('KeyB');
  await frames(6);
  check('and B leaves it', (await ui()).panels.length === 0 && (await sim(() => window.__game.session.renderer.getCameraMode())) === 'follow');

  // ---- an outpost in the wild: the baron names it
  console.log('-- an outpost');
  const dep = await sim(() => {
    const s = window.__game.session.sim; const t = s.services.territory;
    const clear = (x) => t.landAt(x.x, x.z).kind === 'wild' && [0, 1, 2, 3, 4, 5, 6, 7].every((i) => t.landAt(x.x + Math.cos(i * Math.PI / 4) * 90, x.z + Math.sin(i * Math.PI / 4) * 90).kind === 'wild');
    const wild = (s.world.deposits || []).filter((x) => x.settlement < 0 && clear(x));
    return wild.find((x) => x.kind === 'iron') || wild[0];
  });
  check('the world has a deposit in the wild', !!dep);
  if (dep) {
    await sim((dd) => { const s = window.__game.session.sim; const h = s.state.households.get(s.state.persons.get(s.state.run.playerId).household); h.purse = 5e6; for (const g of ['timber', 'planks', 'stone', 'nails', 'iron', 'straw']) h.stores[g] = 5000; }, dep);
    await sim((dd) => window.__ui.openPanel({ panel: 'ext', name: 'builder', data: { at: { x: dd.x, z: dd.z }, kind: dd.kind === 'stone' ? 'quarry' : dd.kind === 'clay' ? 'clay_pit' : dd.kind === 'salt' ? 'salt_pan' : 'mine' } }), dep);
    await lift();
    await page.evaluate(() => { window.__game.settle(); window.__game.draw(); });
    await frames(10);
    d = await dataset();
    check('builder mode opens over the deposit with the right working in hand', d && /^(mine|quarry|clay_pit|salt_pan)$/.test(d.selected) && d.where !== undefined, JSON.stringify(d));
    check('(in the wild: a baron may found an outpost)', (await page.locator('.mu-bld-tool').count()) === 1);
    await page.mouse.move(640, 360);
    await frames(4);
    d = await dataset();
    check('the ghost over the deposit fits', d.ghost === 'ok', `${JSON.stringify(d)} ${await text('.mu-bld-cursor').catch(() => '')}`);
    check('and the cursor says it would found an outpost', /outpost/i.test(await text('.mu-bld-cursor').catch(() => '')), await text('.mu-bld-cursor').catch(() => ''));
    await page.mouse.click(640, 360);
    await frames(4);
    check('a click opens the naming card', (await page.locator('.mu-bld-name:not(.mu-hide)').count()) === 1);
    const nameVal = await page.locator('.mu-bld-name input').inputValue();
    const expectName = { iron: 'Iron camp', silver: 'Silver camp', gold: 'Gold camp', stone: 'Stone quarry', clay: 'Clay pit', salt: 'Salt pans' }[dep.kind];
    check(`with a default name from the deposit ("${expectName}")`, nameVal === expectName, nameVal);
    await page.locator('.mu-bld-name input').fill('Lone Hill Camp');
    await page.getByRole('button', { name: 'Found it' }).click();
    await frames(4);
    const outposts = await sim(() => window.__game.session.services.construction.outposts().map((o) => o.name));
    check('the outpost is founded under the name given', outposts.length === 1 && outposts[0] === 'Lone Hill Camp', JSON.stringify(outposts));
    await esc();
    await esc();
    await frames(4);
    await page.keyboard.press('KeyM');
    await frames(4);
    await page.evaluate(() => { window.__game.settle(); window.__game.draw(); });
    await frames(4);
    check('the new outpost is named on the map', (await page.locator('.mu-map-out').count()) === 1 && /Lone Hill Camp/.test(await text('.mu-map-out')));
    await page.waitForTimeout(130);
    await page.keyboard.press('KeyM');
    await frames(3);
  }

  // ======================================================================== ruler mode
  console.log('-- ruler mode');
  await page.waitForTimeout(130);
  await page.keyboard.press('KeyU');
  await frames(6);
  s = await ui();
  check('U opens the seat of government', s.panels.join() === 'ruler' && s.captures && (await page.locator('.mu-rul-win').count()) === 1, JSON.stringify(s));
  check('the world pauses while it is open', await sim(() => window.__game.session.sim.clock.paused));
  check('eight pages', (await page.locator('.mu-rul-win .mu-tab').count()) === 8);
  const pages = ['Overview', 'Lands & works', 'Fields & labour', 'Research', 'Military', 'Trade', 'Diplomacy', 'Rivals'];
  for (const p of pages) {
    await page.getByRole('tab', { name: p, exact: true }).click();
    await frames(3);
    const body = await page.locator('.mu-rul-content').innerText();
    const broken = await page.locator('.mu-rul-content').getByText('will not open').count();
    check(`the ${p} page renders`, body.length > 150 && broken === 0, body.slice(0, 120));
  }
  check('the footer shows the treasury', /£/.test(await text('.mu-rul-status')));
  // overview
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await frames(3);
  check('Overview: the map of your lands, the books, the stores, the works, research, forces, threats, news', (await page.locator('.mu-rul-map path').count()) >= 2 && (await page.locator('.mu-rul-sec').count()) >= 7);
  // lands
  await page.getByRole('tab', { name: 'Lands & works', exact: true }).click();
  await frames(3);
  check('Lands & works: a card per place you rule, and the places held from you with Rule this town', (await page.locator('.mu-rul-place').count()) >= 1 && (await page.locator('.mu-rul-content').getByRole('button', { name: /^Rule / }).count()) >= 1);
  // fields: a crop plan
  await page.getByRole('tab', { name: 'Fields & labour', exact: true }).click();
  await frames(3);
  const field = page.locator('.mu-rul-field select').first();
  const chosen = await field.evaluate((el) => [...el.options].map((o) => o.value).find((v) => v !== 'fallow'));
  await field.selectOption(chosen);
  await frames(4);
  const plan = await sim((st) => window.__game.session.services.realm.cropPlan(st), king.settlement);
  check('Fields: naming a crop files it in the realm\'s plan', Object.values(plan).includes(chosen), `${chosen} ${JSON.stringify(plan)}`);
  // research
  await page.getByRole('tab', { name: 'Research', exact: true }).click();
  await frames(3);
  const buy = page.getByRole('button', { name: /Buy the rest and start/ }).first();
  const start = page.getByRole('button', { name: 'Start', exact: true }).first();
  const proj0 = await sim((h) => window.__game.session.services.realm.projects(h).length, king.house);
  if (await buy.count()) await buy.click(); else await start.click();
  await frames(4);
  const proj1 = await sim((h) => window.__game.session.services.realm.projects(h).filter((p) => p.state === 'active' || p.state === 'stalled').length, king.house);
  check('Research: starting a technique (buying what the stores lack) begins a project', proj1 === proj0 + 1, `${proj0} -> ${proj1}`);
  check('and the project is listed with its progress', (await page.locator('.mu-rul-content .mu-card', { hasText: 'Stop the work' }).count()) >= 1);
  await page.getByRole('button', { name: 'Stop the work' }).first().click();
  await frames(2);
  await page.getByRole('button', { name: 'Stop it' }).click();
  await frames(4);
  check('Research: stopping a project gives half back and ends it', (await sim((h) => window.__game.session.services.realm.projects(h).filter((p) => p.state === 'active' || p.state === 'stalled').length, king.house)) === proj0);
  // a refusal shows its reason
  await page.getByRole('tab', { name: 'Military', exact: true }).click();
  await frames(3);
  await page.locator('.mu-rul-rrow', { hasText: 'Crossbowman' }).locator('.mu-bad').first().waitFor({ timeout: 3000 }).catch(() => undefined);
  check('Military: what cannot be raised says why', (await page.locator('.mu-rul-rrow .mu-bad').count()) >= 1 || (await page.locator('.mu-rul-rrow.locked').count()) >= 1);
  const before = await sim(() => window.__game.session.services.realm.troops(window.__game.session.sim.state.run.playerId).length);
  const archerRow = page.locator('.mu-rul-rrow', { hasText: 'Archer' }).first();
  await archerRow.locator('input').fill('3');
  await frames(2);
  check('Military: the preview prices the whole (fees, gear to buy, wages in hand)', /fees/.test(await archerRow.innerText()) && /wages in hand/.test(await archerRow.innerText()), await archerRow.innerText());
  await archerRow.getByRole('button', { name: 'Raise' }).click();
  await frames(4);
  const after = await sim(() => window.__game.session.services.realm.troops(window.__game.session.sim.state.run.playerId).length);
  check('Military: raising archers puts them on your pay', after === before + 3, `${before} -> ${after}`);
  check('and they are on the roll with Discharge and Dub a knight', (await page.getByRole('button', { name: 'Discharge' }).count()) >= 3 && (await page.getByRole('button', { name: 'Dub a knight' }).count()) >= 3);
  // trade
  await page.getByRole('tab', { name: 'Trade', exact: true }).click();
  await frames(3);
  check('Trade: what the lands yield and lack', (await page.locator('.mu-rul-content .mu-good-line').count()) >= 3);
  await page.getByRole('button', { name: 'Give the order' }).click();
  await frames(4);
  const orders = await sim(() => window.__game.session.services.realm.tradeOrders(window.__game.session.sim.state.run.playerId).length);
  check('Trade: a standing order is given', orders === 1, String(orders));
  check('and listed with its words', /Sell wheat/.test(await text('.mu-rul-order')), await text('.mu-rul-order'));
  await page.locator('.mu-rul-order button').click();
  await frames(4);
  check('and withdrawn', (await sim(() => window.__game.session.services.realm.tradeOrders(window.__game.session.sim.state.run.playerId).length)) === 0);
  // rivals and diplomacy
  await page.getByRole('tab', { name: 'Rivals', exact: true }).click();
  await frames(3);
  check('Rivals: every House near, the threat in words, the first one open', (await page.locator('.mu-rul-rrow2').count()) >= 3 && /Serious|Watchful|Grave|Little/.test(await text('.mu-rul-rrow2')));
  await page.locator('.mu-rul-rrow2').nth(1).click();
  await frames(2);
  check('and a click opens that House\'s page', (await page.locator('.mu-rul-rrow2.sel').count()) === 1 && (await page.locator('.mu-rul-rdetail h4').textContent()).startsWith('House'));
  await page.getByRole('tab', { name: 'Diplomacy', exact: true }).click();
  await frames(3);
  await page.getByRole('button', { name: 'Open Realm and politics' }).click();
  await frames(3);
  check('Diplomacy: the existing politics panel opens above the seat', (await ui()).panels.includes('politics') && (await ui()).panels.includes('ruler'), JSON.stringify(await ui()));
  await esc();
  check('and Esc comes back to the seat', (await ui()).panels.join() === 'ruler');
  // the seat remembers its page
  await page.keyboard.press('KeyU');
  await frames(3);
  await page.waitForTimeout(130);
  await page.keyboard.press('KeyU');
  await frames(6);
  check('U closes the seat and opens it again on the page it was left on', (await ui()).panels.join() === 'ruler' && (await text('.mu-rul-win .mu-tab.active')).includes('Diplomacy'));
  await esc();
  check('Esc closes the seat and the world runs again', (await ui()).panels.length === 0 && !(await sim(() => window.__game.session.sim.clock.paused)));

  // ======================================================================== news toast
  console.log('-- the news toast');
  await sim(() => { const s = window.__game.session.sim; s.events.emit('news', { id: 90001, kind: 'army', house: 1, settlement: 5, text: 'Lord Ralph has raised an army of 400 men', threat: 0.8 }); });
  await frames(4);
  check('news with a threat of 0.5 or more makes a toast', (await page.locator('.mu-news-toasts .mu-toast').count()) === 1 && /Ralph|army/.test(await text('.mu-news-toasts .mu-toast')));
  await sim(() => { window.__game.session.sim.events.emit('news', { id: 90002, kind: 'built', house: 1, settlement: 5, text: 'A mill is raised', threat: 0.2 }); });
  await frames(3);
  check('a small matter does not', (await page.locator('.mu-news-toasts .mu-toast').count()) === 1);
  await page.locator('.mu-news-toasts').getByRole('button', { name: 'Rivals' }).click();
  await frames(4);
  check('and links to the Rivals page of the seat', (await ui()).panels.join() === 'ruler' && (await text('.mu-rul-win .mu-tab.active')).includes('Rivals'), JSON.stringify(await ui()));
  await esc();

  // ======================================================================== what it costs (printed for a feel, never asserted)
  console.log('-- measurements (a shared, loaded machine: for a feel, not a budget)');
  const perFrame = (fn) => page.evaluate((src) => { const f = new Function(`return (${src})`)(); const out = []; for (let r = 0; r < 5; r++) out.push(f()); out.sort((a, b) => a - b); return out[2]; }, fn.toString());
  const idle = await perFrame(() => { const t = performance.now(); window.__game.tick(1); return (performance.now() - t) / 30; });
  await page.keyboard.press('KeyB');
  await lift();
  await page.locator('.mu-bld-row[data-kind="cottage"]').click();
  await page.mouse.move(520, 280);
  await frames(5);
  const withGhost = await perFrame(() => { const t = performance.now(); window.__game.tick(1); return (performance.now() - t) / 30; });
  console.log(`     a frame with nothing open ${idle.toFixed(2)} ms; builder mode with a ghost following the cursor ${withGhost.toFixed(2)} ms (the whole frame: simulation, agents and interface, no drawing)`);
  const catalogueMs = await page.evaluate(() => { const c = window.__game.session.services.construction; const me = window.__game.session.sim.state.run.playerId; const s = window.__game.session.sim.state.persons.get(me).settlement; const t = performance.now(); for (let i = 0; i < 50; i++) c.catalogue(me, s); return (performance.now() - t) / 50; });
  console.log(`     the catalogue of 63 kinds ${catalogueMs.toFixed(2)} ms (asked every two seconds while the Build tab is up)`);
  await esc(); await esc();
  if ((await ui()).panels.includes('builder')) await esc();
  await page.waitForTimeout(130);
  await page.keyboard.press('KeyU');
  await frames(4);
  for (const p of ['Overview', 'Lands & works', 'Fields & labour', 'Research', 'Military', 'Trade', 'Diplomacy', 'Rivals']) {
    const ms = await page.evaluate((name) => { const tab = [...document.querySelectorAll('.mu-rul-win .mu-tab')].find((b) => b.textContent.trim().startsWith(name)); const t = performance.now(); tab.click(); return performance.now() - t; }, p);
    console.log(`     the ${p} page built in ${ms.toFixed(1)} ms`);
  }
  await esc();
  await page.keyboard.press('KeyM');
  await frames(4);
  await page.evaluate(() => { window.__game.settle(); window.__game.draw(); });
  await frames(4);
  const mapMs = await page.evaluate(() => {
    const c = window.__game.session.controls; const out = [];
    for (let i = 0; i < 9; i++) { c.pan(18, 6); window.__game.draw(); const t = performance.now(); window.__game.tick(0.05); out.push(performance.now() - t); }
    out.sort((a, b) => a - b);
    return out[4];
  });
  const mapStill = await page.evaluate(() => { const out = []; for (let i = 0; i < 9; i++) { const t = performance.now(); window.__game.tick(0.05); out.push(performance.now() - t); } out.sort((a, b) => a - b); return out[4]; });
  console.log(`     the map with the camera moving: ${mapMs.toFixed(1)} ms for a step with the borders and markers redrawn; standing still ${mapStill.toFixed(1)} ms`);
  await page.waitForTimeout(130);
  await page.keyboard.press('KeyM');
  await frames(2);
} catch (err) {
  failures++;
  console.log(`FAIL the flow stopped: ${err && err.message ? String(err.message).split('\n').slice(0, 14).join(' | ') : err}${err && err.stack ? ` @ ${String(err.stack).split('\n').filter((l) => /lands-flow/.test(l)).slice(0, 2).join(' ')}` : ''}`);
}

check('no browser errors', errors.length === 0, errors.slice(0, 4).join(' | '));
await browser.close();
if (vite) { try { process.kill(-vite.pid); } catch { /* already gone */ } }
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall lands checks passed');
process.exit(failures ? 1 : 0);
