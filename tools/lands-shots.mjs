// Screenshots of the lands UI in the real game (civilization pass, wave B1): builder mode, ruler mode, "Rule this town", the map's
// layers and people lists, the banner and the news toast. One run per size; the files go to docs/ui/lands-<name>-<W>x<H>.jpg.
//
//   node tools/lands-shots.mjs [--seed=flow] [--sizes=1280x720,1920x1080] [--out=docs/ui] [--only=builder,ruler,map]
//
// Port 5182 (starts its own Vite if nothing is listening). The loop is driven through `window.__game` (src/app/game.ts): `tick`
// runs whole frames without drawing, `draw` renders. The live-as panel belongs to another builder: a stand-in is registered so
// "Rule this town" has somewhere to go.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
const sizes = opt('sizes', '1280x720,1920x1080').split(',').map((z) => z.split('x').map(Number));
const out = resolve(ROOT, opt('out', 'docs/ui'));
const only = new Set(opt('only', 'builder,ruler,map,hud').split(','));
mkdirSync(out, { recursive: true });

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
let failed = 0;

for (const [W, H] of sizes) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/GPU stall|ReadPixels|WebGL/.test(m.text())) errors.push(m.text()); });
  /** `n` tenths of a second of the whole loop, then the picture drawn once (picking and the ghost use the last drawn frame). */
  const frames = (n = 6) => page.evaluate((k) => { for (let i = 0; i < k; i++) window.__game.tick(0.1); window.__game.draw(); window.__game.tick(0.05); window.__game.draw(); }, n);
  /** The same with the picture drawn after every step: for what watches the renderer move (the builder's camera probe, a glide). */
  const live = (n = 20) => page.evaluate((k) => { for (let i = 0; i < k; i++) { window.__game.tick(0.05); window.__game.draw(); } }, n);
  /** The builder's camera takes a moment: the verdict (the renderer's overview camera or our own) and its glide; a drawn frame is a sixtieth of a second to the camera. */
  const lift = async () => {
    await live(24);
    for (let i = 0; i < 60 && (await page.evaluate(() => document.querySelector('.mu-bld-root')?.dataset.camera)) === 'pending'; i++) await live(10);
    await live(50);
  };
  const settleMap = async () => { await frames(4); await page.evaluate(() => { window.__game.settle(); window.__game.draw(); }); await frames(6); };
  const ui = () => page.evaluate(() => window.__ui.openPanels());
  const esc = async () => { await page.waitForTimeout(130); await page.keyboard.press('Escape'); await frames(2); };
  const shot = async (name) => {
    await frames(3);
    await page.screenshot({ path: resolve(out, `lands-${name}-${W}x${H}.jpg`), type: 'jpeg', quality: 76 });
    console.log(`  ${name}-${W}x${H}`);
  };
  const stillCamera = () => page.evaluate(() => {
    const g = window.__game, s = g.session, sm = s.sim;
    const me = sm.state.persons.get(sm.state.run.playerId);
    const st = sm.world.settlements.find((x) => x.id === me.settlement);
    let prev = null;
    for (let i = 0; i < 500; i++) {
      g.tick(0.1); g.draw();
      const p = s.controls.project(st.x, sm.world.heightAt(st.x, st.z), st.z);
      if (prev && p && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.3 && i > 15) break;
      prev = p;
    }
  });

  console.log(`-- ${W}x${H}`);
  try {
    await page.goto(`http://localhost:${PORT}/?seed=${encodeURIComponent(seed)}&quality=medium&shots=1&autostart=1`, { timeout: 240000 });
    await page.waitForFunction(() => window.__game && window.__game.session && window.__game.host.screen === 'game' && window.__ui, null, { timeout: 240000, polling: 400 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__game.freeze(true));
    await page.evaluate(async () => {
      const reg = await import('/src/ui/panels/extRegistry.ts');
      reg.registerPanel('liveAs', () => {
        const el = document.createElement('div');
        el.className = 'mu-modal';
        return { id: 'liveAs', captures: true, pauses: 'never', escape: 'close', el };
      });
    });
    await frames(10);

    // ---------------------------------------------------------------- a child: the cards that say why
    if (only.has('builder')) {
      await page.keyboard.press('KeyB');
      await frames(4);
      await shot('builder-card');
      await esc();
    }
    if (only.has('ruler')) {
      await page.keyboard.press('KeyU');
      await frames(4);
      await shot('ruler-card');
      await esc();
    }

    // ---------------------------------------------------------------- the map
    if (only.has('map')) {
      await page.keyboard.press('KeyM');
      await settleMap();
      await page.mouse.move(W - 40, H / 2);
      await shot('map-layers');
      await page.locator('.mu-map-row').nth(2).click();
      await frames(4);
      await shot('map-place');
      await page.locator('.mu-map-detail').getByRole('button', { name: 'People here' }).click();
      await frames(3);
      await shot('map-people');
      await page.getByRole('button', { name: 'Places' }).click();
      await frames(3);
      const pt = await page.evaluate((w) => {
        for (const e of document.querySelectorAll('.mu-map-dep:not(.mu-hide)')) {
          const b = e.getBoundingClientRect();
          if (b.left > 540 && b.right < w - 340 && b.top > 90 && b.bottom < 560 && e.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
        return null;
      }, W);
      if (pt) { await page.mouse.click(pt.x, pt.y); await frames(4); await shot('map-deposit'); }
      await page.waitForTimeout(130);
      await page.keyboard.press('KeyM');
      await frames(4);
    }

    // ---------------------------------------------------------------- the banner
    if (only.has('hud')) {
      await page.evaluate(() => window.__ui.showBanner());
      await frames(3);
      // the banner's own animation runs in real time and lasts six seconds: hold it where it is fully there
      await page.evaluate(() => { for (const a of document.querySelector('.mu-banner').getAnimations()) { a.pause(); a.currentTime = 1500; } });
      await page.mouse.move(W / 2, H / 2 + 120);
      await shot('banner');
      await frames(70); // its six seconds of the interface's time go by
    }

    // ---------------------------------------------------------------- live as the king of Basseance
    await page.evaluate(() => { const s = window.__game.session.sim; const me = s.state.persons.get(s.state.run.playerId); s.switchTo(s.services.realm.rulerOf(me.settlement)); });
    await stillCamera();

    if (only.has('builder')) {
      await page.keyboard.press('KeyB');
      await lift();
      await frames(10);
      await shot('builder-catalogue');
      await page.locator('.mu-bld-row[data-kind="cottage"]').click();
      await page.mouse.move(Math.round(W * 0.42), Math.round(H * 0.36));
      await frames(6);
      await shot('builder-tool');
      // over a building: red, with the reason
      const spot = await page.evaluate((w) => {
        const s = window.__game.session; const c = s.controls;
        for (const b of s.sim.state.buildingsAt.get(s.sim.state.persons.get(s.sim.state.run.playerId).settlement)) {
          if (b.construction < 1 || b.plot < 0) continue;
          const p = c.project(b.x, s.sim.world.heightAt(b.x, b.z), b.z);
          if (p && p.x > 340 && p.x < w - 900 + 500 && p.y > 100 && p.y < 440) return p;
        }
        return null;
      }, W);
      if (spot) { await page.mouse.move(spot.x, spot.y); await frames(5); await shot('builder-red'); }
      await page.getByRole('button', { name: 'Place for me' }).click();
      await live(24);
      await frames(4);
      await shot('builder-suggest');
      await page.getByRole('button', { name: 'Stake it out' }).click();
      await frames(6);
      await page.keyboard.press('Escape');
      await frames(2);
      await page.getByRole('tab', { name: /Works/ }).click();
      await frames(3);
      await page.locator('.mu-bld-qrow').first().click();
      await frames(24);
      await shot('builder-site');
      // a standing building
      await page.getByRole('tab', { name: /Build/ }).click();
      await frames(2);
      const target = await page.evaluate(() => {
        const s = window.__game.session; const c = s.controls; const out = [];
        for (const b of s.sim.state.buildingsAt.get(s.sim.state.persons.get(s.sim.state.run.playerId).settlement)) {
          if (b.construction < 1 || b.plot < 0) continue;
          const p = c.project(b.x, s.sim.world.heightAt(b.x, b.z), b.z);
          if (p && p.x > 340 && p.x < 800 && p.y > 100 && p.y < 440) out.push({ x: p.x, y: p.y, kind: b.kind });
        }
        return out.find((x) => /smithy|church|barn|mill|hall/.test(x.kind)) || out[0] || null;
      });
      if (target) { await page.mouse.click(target.x, target.y); await frames(6); await shot('builder-building'); }
      await esc();
      await esc();
      // an outpost in the wild, over a deposit with nothing but wild land round it
      const dep = await page.evaluate(() => {
        const sm = window.__game.session.sim; const t = sm.services.territory;
        const clear = (x) => t.landAt(x.x, x.z).kind === 'wild' && [0, 1, 2, 3, 4, 5, 6, 7].every((i) => t.landAt(x.x + Math.cos(i * Math.PI / 4) * 90, x.z + Math.sin(i * Math.PI / 4) * 90).kind === 'wild');
        const wild = (sm.world.deposits || []).filter((x) => x.settlement < 0 && clear(x));
        return wild.find((x) => x.kind === 'iron') || wild[0];
      });
      if (dep) {
        await page.evaluate(() => { const s = window.__game.session.sim; const h = s.state.households.get(s.state.persons.get(s.state.run.playerId).household); h.purse = 5e6; for (const g of ['timber', 'planks', 'stone', 'nails', 'iron', 'straw']) h.stores[g] = 5000; });
        await page.evaluate((dd) => window.__ui.openPanel({ panel: 'ext', name: 'builder', data: { at: { x: dd.x, z: dd.z }, kind: dd.kind === 'stone' ? 'quarry' : dd.kind === 'clay' ? 'clay_pit' : dd.kind === 'salt' ? 'salt_pan' : 'mine' } }), dep);
        await lift();
        await page.evaluate(() => { window.__game.settle(); window.__game.draw(); });
        await frames(10);
        await page.mouse.move(Math.round(W / 2), Math.round(H / 2));
        await frames(4);
        await page.mouse.click(Math.round(W / 2), Math.round(H / 2));
        await frames(4);
        await shot('builder-outpost');
        await page.locator('.mu-bld-name input').fill('Lone Hill Camp');
        await page.getByRole('button', { name: 'Found it' }).click();
        await frames(4);
        await esc();
        await esc();
      }
    }

    // ---------------------------------------------------------------- the seat of government
    if (only.has('ruler')) {
      await page.waitForTimeout(130);
      await page.keyboard.press('KeyU');
      await frames(6);
      for (const [label, name] of [['Overview', 'overview'], ['Lands & works', 'lands'], ['Fields & labour', 'fields'], ['Research', 'research'], ['Military', 'military'], ['Trade', 'trade'], ['Diplomacy', 'diplomacy'], ['Rivals', 'rivals']]) {
        await page.getByRole('tab', { name: label, exact: true }).click();
        await frames(4);
        await shot(`ruler-${name}`);
      }
      await esc();
    }

    // ---------------------------------------------------------------- the news toast
    if (only.has('hud')) {
      await page.evaluate(() => { window.__game.session.sim.events.emit('news', { id: 91001, kind: 'army', house: 1, settlement: 5, text: 'Lord Ralph has raised an army of 400 men.', threat: 0.8 }); });
      await frames(6);
      await shot('news-toast');
    }
  } catch (err) {
    failed++;
    console.log(`FAIL ${W}x${H}: ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
  }
  if (errors.length) { failed++; console.log(`browser errors: ${errors.slice(0, 3).join(' | ')}`); }
  await page.close();
}

await browser.close();
if (vite) { try { process.kill(-vite.pid); } catch { /* already gone */ } }
console.log(failed ? `\n${failed} problem(s)` : '\nall shots taken');
process.exit(failed ? 1 : 0);
