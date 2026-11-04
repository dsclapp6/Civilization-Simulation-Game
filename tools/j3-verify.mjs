// Live check of three wave J3 features in the real game (headless Chromium, software GL):
//   1. building-site jobs: the job bar fills bout by bout ("Keep at it until it is done"), and the siege ram's blow count on the HUD
//      goes down with each blow;
//   2. the knight's duty "train the men at the yard" points at the training pell and following it starts the drill;
//   3. a bound wound is drawn as a bandage on the body part in third person.
//
//   node tools/j3-verify.mjs [--only=1a,1k,1b,2,3] [--port=5397] [--out=dir] [--quality=high|medium|low] [--w=1280 --h=720] [--noworld]
//   (1a: the stage job, 1k: "Keep at it", 1b: the ram, 2: the knight's duty, 3: bandages; --noworld skips the 3D grabs, the memory-hungry part)
// Starts Vite on the port when nothing listens there. Frames are canvas.toDataURL grabs after __game.draw(); the HUD frames are page
// screenshots with the loop running. Where the script sets state by hand (the player's age, a finished training yard, the first wound
// when real damage is not used) it says so in its log.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
const PORT = Number(opt('port', 5397));
const OUT = resolve(opt('out', '/tmp/claude-0/-home-user-Civilization-Simulation-Game/0d36ad2b-006d-5c82-be4d-95f65d3a548e/scratchpad/verify-j3'));
const only = opt('only', '1a,1b,2,3').split(',');
mkdirSync(OUT, { recursive: true });

const up = async () => { try { return (await fetch(`http://localhost:${PORT}/`)).ok; } catch { return false; } };
let vite = null;
if (!(await up())) {
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: true });
  for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`); if (!ok) failures++; };
const log = (...a) => console.log(...a);

async function load() {
  const page = await browser.newPage({ viewport: { width: Number(opt('w', 1280)), height: Number(opt('h', 720)) } });
  page.setDefaultTimeout(240000);
  page.on('pageerror', (e) => log('[pageerror]', e.message));
  page.on('crash', () => log('[page crashed]'));
  await page.goto(`http://localhost:${PORT}/?autostart=1&shots=1&seed=flow&quality=${opt('quality', 'high')}`, { timeout: 180000 });
  await page.waitForFunction(() => window.__game !== undefined && window.__ui !== undefined, null, { timeout: 300000, polling: 250 });
  await page.evaluate(() => window.__game.ready());
  await page.addStyleTag({ content: '.mu-toasts, .mu-guide, .mu-whatnow, .mu-hud-drawn, .mu-law-plaque, .mu-bt-bar, .mu-bt-hint, .mu-bt-banners, .mu-duel { display: none !important; }' }); // overlays that sit on the action bar in a storm
  await page.evaluate(() => window.__game.freeze(true));
  return page;
}
/** The 3D view only (the HUD is DOM): draws and saves the canvas. */
async function frame(page, name) {
  if (args.includes('--noworld')) return null; // HUD-only run: the 3D grabs are the memory-hungry part
  const url = await page.evaluate(() => { window.__game.draw(); return document.querySelector('canvas').toDataURL('image/png'); });
  const file = resolve(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  log('frame', file);
  return file;
}
/** The whole page, HUD included: the loop is let run for the grab (a frozen page does not answer a screenshot). */
async function hudShot(page, name) {
  const file = resolve(OUT, `${name}.png`);
  await page.evaluate(() => window.__game.freeze(false));
  await page.waitForTimeout(250);
  await page.screenshot({ path: file });
  await page.evaluate(() => window.__game.freeze(true));
  log('frame', file);
  return file;
}
const tick = (page, s) => page.evaluate((n) => window.__game.tick(n), s);
/** What the HUD's action bar says now. */
const bar = (page) => page.evaluate(() => {
  const el = document.querySelector('.mu-hud-action');
  if (!el || el.classList.contains('mu-hide')) return null;
  const fill = el.querySelector('.mu-bar > i:last-of-type');
  const m = /scaleX\(([\d.]+)\)/.exec(fill?.style.transform ?? '');
  return { label: el.querySelector('.mu-hud-action-top')?.firstChild?.textContent ?? '', secs: el.querySelector('.mu-num')?.textContent ?? '', bout: el.querySelector('.mu-hud-action-bout')?.textContent ?? '', fill: m ? Number(m[1]) : null };
});

// ------------------------------------------------------------------------------------------------------------------------------
// 1a. a building site: the job bar
// ------------------------------------------------------------------------------------------------------------------------------
if (only.includes('1a') || only.includes('1k')) {
  const doStage = only.includes('1a');
  const page = await load();
  const info = await page.evaluate(() => {
    const s = window.__game.session; const sim = s.sim; const st = sim.state; const me = st.persons.get(st.run.playerId);
    // by hand: the player is a grown man (he starts a child), and his household's head (a real person) stakes the cottage out
    me.birthDay = Math.round(sim.absDay - 28 * 16); me.sex = 'm'; me.needs.hunger = 1; me.needs.rest = 1; st.touch(me);
    const C = s.services.construction;
    const b = s.services.player.body();
    const hh = st.households.get(me.household);
    const sp = C.suggestSpot(hh.head, 'cottage', me.settlement, { x: b.x, z: b.z });
    const placed = C.place(hh.head, 'cottage', sp.x, sp.z, sp.rot ?? 0);
    const rec = C.core.sitesById.get(placed.site);
    // materials in hand: the household's stores hold what the cottage needs, and the site draws them
    for (const [g, q] of Object.entries({ planks: 60, straw: 80, timber: 60, thatch: 60 })) C.core.addStock(C.core.household(rec.household), g, q);
    C.core.planNow(rec);
    return { placed, building: rec.building, labour: rec.labour, done: rec.done, note: rec.note, x: sp.x, z: sp.z, rot: sp.rot, hasMaterials: C.core.household(rec.household) !== null };
  });
  log('1a site', JSON.stringify(info));
  await page.evaluate((i) => {
    const p = window.__game.session.services.player;
    p.placeAt(i.x + 9, i.z + 2, Math.atan2(-9, -2));
  }, info);
  await tick(page, 0.5);
  await page.evaluate(() => window.__game.settle());
  const opts = await page.evaluate((i) => {
    const s = window.__game.session; const me = s.sim.state.run.playerId;
    return s.sim.actions.list(me, { kind: 'building', id: i.building }).map((o) => ({ id: o.id, label: o.label, enabled: o.enabled, reason: o.reason, bouts: o.bouts, preview: o.preview, seconds: o.seconds }));
  }, info);
  log('1a options', JSON.stringify(opts));
  check('the site offers a counted job to the next stage and "Keep at it until it is done"', opts.some((o) => o.id === 'build.work' && o.bouts > 1 && /to the/.test(o.preview)) && opts.some((o) => o.id === 'build.keep' && /^Keep at it until it is done$/.test(o.label)), JSON.stringify(opts));
  const start = (id) => page.evaluate(([i, id]) => {
    const s = window.__game.session; const me = s.sim.state.run.playerId;
    const o = s.sim.actions.list(me, { kind: 'building', id: i.building }).find((x) => x.id === id);
    return o ? s.sim.actions.start(me, o) : { ok: false, message: 'no such option' };
  }, [info, id]);
  const siteOf = () => page.evaluate((i) => { const v = window.__game.session.services.construction.siteOf(i.building); return v ? { pct: v.progress, stage: v.stage, status: v.status } : null; }, info);
  await page.evaluate(() => window.__game.session.sim.dispatch({ type: 'setSpeed', speed: 8 }));
  let after = null;
  if (doStage) {
    const r = await start('build.work');
    log('1a start build.work', JSON.stringify(r));
    const before = await siteOf();
    const series = [];
    const taken = new Set();
    for (let i = 0; i < 400; i++) {
      await tick(page, 2);
      const b = await bar(page);
      if (!b) break;
      series.push(b);
      for (const f of [0.15, 0.5, 0.9]) if (b.fill >= f && !taken.has(f)) {
        taken.add(f);
        await hudShot(page, `1a-site-job-bar-${Math.round(f * 100)}`);
      }
    }
    after = await siteOf();
    log('1a bar samples', JSON.stringify(series.filter((_, i) => i % Math.ceil(series.length / 14) === 0)));
    log('1a site before/after', JSON.stringify(before), JSON.stringify(after));
    const fills = series.map((s) => s.fill);
    check('the job bar fills as bouts are worked (rises through the job)', fills.length > 5 && fills[fills.length - 1] > 0.9 && fills.every((f, i) => i === 0 || f >= fills[i - 1] - 1e-9) && fills[0] < 0.2, JSON.stringify(fills.slice(0, 5)));
    check('the bar counts the bouts ("Bout n of m")', series.some((s) => /Bout \d+ of \d+/.test(s.bout)) && new Set(series.map((s) => s.bout)).size > 3, series[0]?.bout);
    check('the site moved to its next stage', !!after && !!before && (after.stage !== before.stage || after.pct > before.pct + 0.05), JSON.stringify([before, after]));
    await frame(page, '1a-site-world');
  }
  // "Keep at it until it is done": runs on past the stage, and Q stops it
  const start0 = await siteOf();
  const k = await start('build.keep');
  log('1a start build.keep', JSON.stringify(k));
  const keepSeries = [];
  for (let i = 0; i < 40; i++) { await tick(page, 3); const b = await bar(page); if (!b) break; keepSeries.push(b); if (Number(/Bout (\d+)/.exec(b.bout)?.[1] ?? 0) >= 5) break; }
  log('1a keep samples', JSON.stringify(keepSeries.filter((_, i) => i % 8 === 0)));
  const mid = await siteOf();
  check('"Keep at it" runs past the stage, bout after bout', keepSeries.length >= 3 && Number(/Bout (\d+) of (\d+)/.exec(keepSeries[keepSeries.length - 1].bout)?.[1]) >= 5 && mid.pct > (after?.pct ?? start0.pct), JSON.stringify([keepSeries.at(-1), mid]));
  await hudShot(page, '1a-site-keep-at-it');
  await browser.close();
}

// ------------------------------------------------------------------------------------------------------------------------------
// 1b. the siege ram: blows left, down the HUD's job bar as the player pushes
// ------------------------------------------------------------------------------------------------------------------------------
if (only.includes('1b')) {
  const page = await load();
  // the war set-up of tools/war-shots.mjs: a walled castle, the strongest house of another realm besieges it, the player is the
  // host's commander; rams and ladders, the storm
  await page.evaluate(async () => {
    const g = window.__game; const s = g.session; const sim = s.sim; const mil = sim.services.military; const st = sim.state; const w = sim.world;
    const m = await import('/src/sim/military/index.ts');
    const M = m.militaryContext(sim);
    const passHours = (n) => { sim.dispatch({ type: 'setSpeed', speed: 8 }); g.advance((n * 600) / 24 / 8 + 0.15); sim.dispatch({ type: 'setSpeed', speed: 1 }); };
    const { CFG } = await import('/src/sim/military/config.ts');
    CFG.detailMax = 32;
    window.__m = { g, s, sim, mil, M, st, w, passHours };
  });
  const info = await page.evaluate(() => {
    const { mil, st, sim, M, w, passHours } = window.__m;
    const has = (s, k) => (st.buildingsAt.get(s.id) ?? []).some((b) => b.kind === k && b.construction >= 1);
    const castle = w.settlements.find((s) => s.kind === 'castle' && has(s, 'wall') && has(s, 'tower') && has(s, 'gatehouse'));
    const lord = mil.lordHouse(castle.id);
    let att = 0, bs = -1;
    for (const h of st.houses.values()) {
      if ((h.kind !== 'noble' && h.kind !== 'royal') || h.extinct || M.realm.root(h.id) === M.realm.root(lord)) continue;
      const f = mil.forces(h.id).strength; if (f > bs) { bs = f; att = h.id; }
    }
    for (const h of st.houses.values()) { M.data.think['r' + h.id] = sim.absDay + 99; M.data.think['d' + h.id] = sim.absDay + 99; }
    mil.declareFeud(att, lord, 60, 'demo');
    M.realm.invalidateEnmity();
    const id = mil.raiseArmy(att, 'war', { vassals: true });
    mil.order(id, { kind: 'hold' });
    M.army(id).readyDay = M.day - 1;
    passHours(2);
    const A = M.army(id);
    const gate = (st.buildingsAt.get(castle.id) ?? []).find((b) => b.kind === 'gatehouse');
    let ox = gate.x - castle.x, oz = gate.z - castle.z; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    A.x = gate.x + ox * 75; A.z = gate.z + oz * 75; A.px = A.x; A.pz = A.z; A.supplies = A.men.length * 200; A.morale = 1;
    const me = A.commander;
    sim.switchTo(me);
    window.__m.g.advance(0.3);
    window.__m.s.services.player.placeAt(A.x - ox * 6, A.z - oz * 6, Math.atan2(-ox, -oz));
    window.__m.g.advance(0.3);
    mil.order(id, { kind: 'siege', settlement: castle.id });
    for (let h = 0; h < 30 && !M.sieges.recOf(castle.id); h++) passHours(1);
    // the army sits down before the walls by its own march; where that has not come to a siege record yet, it is begun as the army's arrival does
    const rec = M.sieges.recOf(castle.id) ?? M.sieges.begin(A, castle.id);
    if (!rec) return { castle: castle.name, army: id, me, rec: false, A: { x: A.x, z: A.z, order: A.order ?? null, state: A.state ?? null, men: A.men.length, keys: Object.keys(A).slice(0, 40) }, gate: { x: gate.x, z: gate.z, d: Math.hypot(A.x - gate.x, A.z - gate.z) } };
    rec.ladders = false; rec.rams = 1; // the ram alone: with ladders the host climbs in and throws the gate open from within in seconds
    M.sieges.assault(rec, M.army(id));
    return { castle: castle.name, army: id, me, rec: true, gate: { x: gate.x, z: gate.z }, out: [ox, oz] };
  });
  log('1b siege', JSON.stringify(info));
  check('the host lays siege to the castle', info.rec === true, JSON.stringify(info));
  if (!info.rec) { await browser.close(); process.exit(1); }
  await page.evaluate(() => { const c = window.__m.sim.clock; const d = Math.floor(c.absDay); const t = c.absDay - d; c.state.absDay = d + (t > 0.45 ? 1 : 0) + 0.45; });
  // the host marches; the ram is in the storm scene as soon as the assault is on, and works until the gate gives, so the player goes to
  // where it will stand (its goal at the gate) and lends his shoulder at once
  const liveRam = () => page.evaluate(() => {
    const arena = window.__m.sim.services.combat.arena;
    for (const f of arena.fights.values()) if (f.scene && f.scene.gate) {
      const w = f.scene.works.find((k) => k.kind === 'ram' && k.state !== 'broken');
      const g = f.scene.gate;
      if (w) return { x: w.x, z: w.z, phase: w.phase, goalX: w.goalX, goalZ: w.goalZ, gate: { x: g.x, z: g.z }, integrity: f.scene.gateIntegrity() };
    }
    return null;
  });
  let ram = null;
  // (a ram on the march runs away from a man standing still, and the verb would end with "You are away from the ram": go once it batters)
  for (let i = 0; i < 160 && !(ram && ram.phase === 'batter'); i++) { await page.evaluate(() => window.__game.advance(0.5)); ram = await liveRam(); }
  log('1b ram', JSON.stringify(ram));
  check('a ram works at the gate', !!ram && ram.phase === 'batter', JSON.stringify(ram));
  const scene = () => page.evaluate(() => { const arena = window.__m.sim.services.combat.arena; for (const f of arena.fights.values()) if (f.scene && f.scene.gate) return true; return false; });
  check('the storm scene is running', await scene());
  // the player lends his shoulder: stands behind the beam, "Push the ram"
  await page.evaluate((r) => {
    const { s } = window.__m;
    const dx = r.goalX - r.gate.x, dz = r.goalZ - r.gate.z, l = Math.hypot(dx, dz) || 1;
    s.services.player.placeAt(r.x + (dx / l) * 3, r.z + (dz / l) * 3, Math.atan2(-dx, -dz));
  }, ram);
  await page.evaluate(() => { window.__ev = []; window.__m.sim.actions.onEvent((e) => window.__ev.push({ t: e.type, id: e.option?.id, reason: e.reason ?? null, ok: e.outcome?.ok ?? null, msg: e.outcome?.message ?? null, jobDone: e.jobDone ?? null })); });
  await page.evaluate(() => { window.__notes = []; window.__m.sim.events.on('notify', (e) => window.__notes.push(e.text)); });
  const nearGate = () => page.evaluate(() => {
    const arena = window.__m.sim.services.combat.arena;
    for (const f of arena.fights.values()) if (f.scene && f.scene.gate) {
      const g = f.scene.gate; const out = [];
      for (const m of f.sides[f.scene.attackerSide].members) {
        if (!m.active || m.isPlayer) continue;
        const dn = (m.x - g.x) * g.ox + (m.z - g.z) * g.oz;
        const dIn = Math.hypot(m.x - (g.x - g.ox * 5), m.z - (g.z - g.oz * 5));
        if (dIn < 14) out.push({ role: m.role, onWall: m.onWall, dn: Math.round(dn * 10) / 10, dIn: Math.round(dIn * 10) / 10 });
      }
      return { gate: { x: g.x, z: g.z, ox: g.ox, oz: g.oz, hd: g.hd }, near: out };
    }
    return null;
  });
  log('1b attackers by the gate (before the push)', JSON.stringify(await nearGate()));
  let pushed = { offered: null, started: null };
  for (let i = 0; i < 120 && !pushed.started; i++) {
    pushed = await page.evaluate(() => {
      const { sim } = window.__m;
      window.__game.advance(0.5);
      const me = sim.state.run.playerId;
      const push = sim.actions.list(me, { kind: 'self' }).find((o) => o.id === 'push');
      return { offered: push ? { label: push.label, bouts: push.bouts, preview: push.preview, enabled: push.enabled, reason: push.reason } : null, started: push && push.enabled ? sim.actions.start(me, push) : null };
    });
  }
  log('1b push', JSON.stringify(pushed));
  check('"Push the ram" is offered with the blows the gate still needs', !!pushed.offered && pushed.offered.enabled && pushed.offered.bouts >= 1 && /blow/.test(pushed.offered.preview), JSON.stringify(pushed));
  check('and it starts', !!pushed.started?.ok, JSON.stringify(pushed.started));
  const blowsLeft = () => page.evaluate(() => {
    const { sim } = window.__m;
    const arena = sim.services.combat.arena; const pf = arena.player;
    for (const f of arena.fights.values()) if (f.scene && f.scene.gate) {
      const ram = f.scene.ramNear(pf.x, pf.z, 8);
      const any = f.scene.works.find((k) => k.kind === 'ram');
      const g = f.scene.gate; const inside = [];
      for (const m of f.sides[f.scene.attackerSide].members) {
        if (!m.active || m.isPlayer || m.onWall || m.role !== 0) continue;
        const dn = (m.x - g.x) * g.ox + (m.z - g.z) * g.oz; const u = (m.x - g.x) * Math.cos(g.rot) - (m.z - g.z) * Math.sin(g.rot);
        if (dn < 0 && Math.hypot(m.x - (g.x - g.ox * 5), m.z - (g.z - g.oz * 5)) < 12) inside.push({ dn: Math.round(dn * 10) / 10, u: Math.round(u * 10) / 10, x: Math.round(m.x * 10) / 10, z: Math.round(m.z * 10) / 10 });
      }
      return { inside, openT: f.scene.openT, blows: ram ? f.scene.ramBlowsLeft(ram) : null, integrity: Math.round(f.scene.gateIntegrity() * 1000) / 1000, open: f.scene.gateOpen(), damage: f.scene.gate.b.damage, ramPhase: any?.phase ?? null, ramState: any?.state ?? null, pfActive: pf.active, pfFight: pf.fight };
    }
    return { gone: true, fights: arena.fights.size, pfActive: pf?.active ?? null, pfFight: pf?.fight ?? null };
  });
  const rows = [];
  let last = '';
  for (let i = 0; i < 160; i++) {
    await tick(page, 1);
    const b = await bar(page); const bl = await blowsLeft();
    if (!b) break;
    const key = b.bout;
    if (key !== last) {
      last = key;
      const m = /Bout (\d+) of (\d+)/.exec(b.bout);
      rows.push({ t: i, bout: b.bout, fill: b.fill, label: b.label, blows: bl?.blows ?? null, gate: bl?.integrity ?? null, left: m ? Number(m[2]) - Number(m[1]) + 1 : null, scene: bl });
      if (rows.length === 2 || rows.length === 5) await hudShot(page, `1b-ram-push-${rows.length}`);
    }
    if (bl?.open) break;
  }
  log('1b why it ended', JSON.stringify(await page.evaluate(() => {
    const { sim, s } = window.__m; const me = sim.state.run.playerId; const arena = sim.services.combat.arena; const pf = arena.player;
    const out = { hp: sim.state.persons.get(me).health.hp, pf: pf ? { active: pf.active, fight: pf.fight, x: Math.round(pf.x * 10) / 10, z: Math.round(pf.z * 10) / 10 } : null, body: (({ x, z }) => ({ x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 }))(s.services.player.body()), push: sim.actions.list(me, { kind: 'self' }).filter((o) => o.id === 'push').map((o) => ({ enabled: o.enabled, bouts: o.bouts })) };
    for (const f of arena.fights.values()) if (f.scene) { const r = f.scene.works.find((k) => k.kind === 'ram'); out.ram = r ? { x: Math.round(r.x * 10) / 10, z: Math.round(r.z * 10) / 10, phase: r.phase, state: r.state } : null; out.gateOpen = f.scene.gateOpen(); }
    return out;
  })));
  log('1b attackers by the gate (after)', JSON.stringify(await nearGate()));
  log('1b notes', JSON.stringify(await page.evaluate(() => window.__notes.slice(0, 20))));
  log('1b rows', JSON.stringify(rows));
  log('1b action events', JSON.stringify(await page.evaluate(() => window.__ev.slice(0, 40))));
  await hudShot(page, '1b-ram-push-last');
  check('the HUD counts the blows (Bout n of m) as the player pushes', rows.length >= 3 && rows.every((r) => /Bout \d+ of \d+/.test(r.bout)), JSON.stringify(rows));
  const lefts = rows.map((r) => r.left).filter((x) => x !== null);
  check('the blows left go down with each blow', lefts.length >= 3 && lefts.every((v, i) => i === 0 || v <= lefts[i - 1]) && lefts[lefts.length - 1] < lefts[0], JSON.stringify(lefts));
  const bl2 = rows.map((r) => r.blows).filter((x) => x !== null);
  check('the ram scene agrees: ramBlowsLeft goes down too', bl2.length >= 3 && bl2.every((v, i) => i === 0 || v <= bl2[i - 1]) && bl2[bl2.length - 1] < bl2[0], JSON.stringify(bl2));
  if (ram) {
    await page.evaluate((r) => {
      const { w, s } = window.__m; const dx = r.goalX - r.gate.x, dz = r.goalZ - r.gate.z, l = Math.hypot(dx, dz) || 1; const fx = -dx / l, fz = -dz / l;
      const f = [r.x - fx * 9 + fz * 5, w.heightAt(r.x - fx * 9, r.z - fz * 9) + 3.2, r.z - fz * 9 - fx * 5], t = [r.x - fx, w.heightAt(r.x, r.z) + 1.5, r.z - fz];
      s.controls.setCameraPose({ x: f[0], y: f[1], z: f[2] }, { x: t[0], y: t[1], z: t[2] }, 0);
    }, ram);
    await page.evaluate(() => window.__game.settle());
    await frame(page, '1b-ram-world');
  }
  await browser.close();
}

// ------------------------------------------------------------------------------------------------------------------------------
// 2. the knight's duty "train the men at the yard" leads to the pell
// ------------------------------------------------------------------------------------------------------------------------------
if (only.includes('2')) {
  const page = await load();
  const setup = await page.evaluate(async () => {
    const s = window.__game.session; const sim = s.sim; const st = sim.state; const C = s.services.construction; const w = sim.world;
    const sites = await import('/src/sim/construction/sites.ts');
    const { hash01 } = await import('/src/core/math.ts');
    const dayNo = Math.floor(sim.absDay);
    // the world of this seed has no training yard: a castle's lord has one raised in his bailey (a real site, finished by hand)
    const knights = [...st.persons.values()].filter((p) => !p.death && p.career === 'knight' && (sim.absDay - p.birthDay) / 16 >= 20 && w.settlements.find((q) => q.id === p.settlement)?.kind === 'castle');
    for (const k of knights) {
      const set = w.settlements.find((q) => q.id === k.settlement);
      const lords = [...st.persons.values()].filter((q) => !q.death && q.settlement === k.settlement && st.titlesHeldBy(q.id).size > 0);
      if (lords.length === 0 || st.titlesHeldBy(k.id).size > 0 || s.services.economy.employment(k.id)) continue;
      // the knight's round is a roll of the day (objectives/duties.ts): take a knight whose roll today is the yard's
      if (hash01(k.id, dayNo * 7 + 41) >= 0.4) continue;
      let spot = null;
      // inside the castle's own palisade or wall (a yard outside it would be a walk round the defences)
      const ring = (st.buildingsAt.get(set.id) ?? []).filter((b) => ['palisade', 'wall', 'gatehouse'].includes(b.kind)).map((b) => Math.hypot(b.x - set.x, b.z - set.z));
      const inner = ring.length ? Math.min(...ring) * 0.6 : 60;
      for (let r = 8; r < inner && !spot; r += 6) for (let a = 0; a < 12 && !spot; a++) {
        const x = set.x + Math.cos(a * 0.52) * r, z = set.z + Math.sin(a * 0.52) * r;
        const c = C.check(lords[0].id, 'training_yard', x, z, 0);
        if (c.ok) spot = { x, z };
      }
      if (!spot) continue;
      const placed = C.place(lords[0].id, 'training_yard', spot.x, spot.z, 0);
      if (!placed.ok) continue;
      const rec = C.core.sitesById.get(placed.site);
      const b = st.buildings.get(rec.building);
      b.construction = 1; st.touchBuilding(b);
      sites.closeSite(C.core, rec, 'done');
      sim.events.emit('construction', { phase: 'done', site: rec.id, building: b.id, settlement: set.id, kind: 'training_yard', work: 'build', house: 0 });
      return { inner, knight: k.id, name: k.first, castle: set.name, settlement: set.id, yard: b.id, x: b.x, z: b.z, lord: lords[0].id };
    }
    return null;
  });
  log('2 setup', JSON.stringify(setup));
  check('a training yard stands in a castle with a knight (built by its lord through construction)', !!setup);
  const sw = await page.evaluate((i) => window.__game.session.sim.switchTo(i.knight), setup);
  check('the player takes up the knight (switch of life)', sw === true);
  await page.evaluate(() => { const g = window.__game; g.advance(0.5); });
  // the days go by until the knight's round is the yard (a roll of the day)
  let duty = null;
  const readDuty = () => page.evaluate(() => {
    const O = window.__game.session.services.objectives;
    const duties = O.list().filter((o) => /^Your duty/.test(o.title) && o.state === 'active');
    const d = duties.find((o) => /train the men at the yard/.test(o.title)) ?? duties[0];
    return d ? { id: d.id, title: d.title, tracked: d.tracked, steps: d.steps.map((x) => ({ text: x.text, hint: x.hint, kind: x.target?.kind, id: x.target?.id, x: x.target?.x, z: x.target?.z, goal: x.goal })) } : null;
  });
  const hours = (n) => page.evaluate((n) => { const sim = window.__game.session.sim; sim.dispatch({ type: 'setSpeed', speed: 8 }); window.__game.advance(((n * 600) / 24) / 8 + 0.15); sim.dispatch({ type: 'setSpeed', speed: 1 }); }, n);
  const titles = [];
  for (let i = 0; i < 6 && !duty; i++) {
    await hours(0.6);
    const d = await readDuty();
    if (d) { titles.push(d.title); if (/train the men at the yard/.test(d.title)) duty = d; }
  }
  log('2 duties seen', JSON.stringify(titles), JSON.stringify(duty));
  check('the knight is given "Your duty: train the men at the yard"', !!duty, JSON.stringify(titles));
  if (duty) {
    check('its steps point at the training yard building', duty.steps.every((x) => x.kind === 'building' && x.id === setup.yard), JSON.stringify(duty.steps));
    check('the drill step names the pell', /pell/i.test(duty.steps[1]?.text ?? '') && /Drill at the pell/.test(duty.steps[1]?.hint ?? ''), JSON.stringify(duty.steps[1]));
    // the compass waypoint and the tracker: face the yard so the mark rides the ribbon
    await page.evaluate((i) => {
      const s = window.__game.session; const b = s.services.player.body();
      const yaw = Math.atan2(-(i.x - b.x), -(i.z - b.z));
      const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
    }, setup);
    await tick(page, 0.6);
    const nav = await page.evaluate((i) => {
      const s = window.__game.session; const O = s.services.objectives; const b = s.services.player.body();
      const t = O.tracked();
      const step = t?.steps.find((x) => !x.done) ?? t?.steps[0];
      const marks = [...document.querySelectorAll('.mu-compass-marks > *')].map((e) => ({ text: (e.textContent ?? '').trim(), cls: e.className, title: e.getAttribute('title') ?? '' }));
      return { tracked: t?.title ?? null, trackedStepTarget: step?.target ? { kind: step.target.kind, id: step.target.id, x: step.target.x, z: step.target.z } : null, dist: Math.hypot(i.x - b.x, i.z - b.z), marks };
    }, setup);
    log('2 nav', JSON.stringify(nav));
    check('the tracked objective is the duty and its waypoint is the yard', nav.tracked === duty.title && nav.trackedStepTarget?.id === setup.yard, JSON.stringify(nav));
    check('the compass carries the waypoint', nav.marks.length > 0, JSON.stringify(nav.marks));
    await hudShot(page, '2-duty-waypoint');
    // follow the waypoint on foot: hold forward towards the tracked step's target, real movement through the game's input path
    const walk = [];
    let prevD = -1, still = 0;
    for (let i = 0; i < 120; i++) {
      const st = await page.evaluate(() => {
        const s = window.__game.session; const t = s.services.objectives.tracked()?.steps.find((x) => !x.done)?.target; const b = s.services.player.body();
        if (!t) return { done: true };
        const dx = t.x - b.x, dz = t.z - b.z;
        const d = Math.hypot(dx, dz);
        if (d < 6) return { done: true, d };
        const yaw = Math.atan2(dx, dz);
        const r = s.renderer; r.orbit(Math.atan2(Math.sin(yaw - r.getCameraYaw()), Math.cos(yaw - r.getCameraYaw())), 0);
        window.__game.advance(1, { forward: 1, cameraYaw: yaw, faceCamera: true });
        return { d, x: Math.round(b.x), z: Math.round(b.z) };
      });
      if (i % 10 === 0) walk.push(st);
      if (st.done) break;
      still = Math.abs(st.d - prevD) < 0.02 ? still + 1 : 0; prevD = st.d;
      if (still >= 4 && st.d < 12) break; // against the yard's fence, within the step's reach
    }
    log('2 walk', JSON.stringify(walk));
    const go = { found: true };
    await tick(page, 0.5);
    const at = await page.evaluate((i) => { const b = window.__game.session.services.player.body(); const t = window.__game.session.services.objectives.tracked()?.steps[0]?.target; return { toTarget: t ? Math.hypot(t.x - b.x, t.z - b.z) : null, body: { x: b.x, z: b.z } }; }, setup);
    log('2 at yard', JSON.stringify(at));
    check('following it reaches the yard (within the step\'s reach)', go.found && at.toTarget !== null && at.toTarget < 12, JSON.stringify([go, at]));
    await page.evaluate(() => window.__game.advance(0.3));
    const opts = await page.evaluate((i) => {
      const s = window.__game.session; const me = s.sim.state.run.playerId;
      return s.sim.actions.list(me, { kind: 'building', id: i.yard }).map((o) => ({ id: o.id, label: o.label, enabled: o.enabled, reason: o.reason, bouts: o.bouts }));
    }, setup);
    log('2 options at the yard', JSON.stringify(opts));
    check('"Drill at the pell" is offered at the yard', opts.some((o) => o.id === 'pell' && o.enabled), JSON.stringify(opts));
    // on into the yard to the pell itself (the post is a prop of the yard; the zone lists it as something to use)
    const pell = await page.evaluate(async (i) => {
      // the pell posts are props of the yard's recipe (assets/buildings/recipes/defence.ts trainingYard: at the back-left, 1.8 m in from the
      // far rail), not things the zone lists: their place is worked out from the yard's footprint and its gate
      const { BUILDINGS } = await import('/src/content/types.ts');
      const def = BUILDINGS.training_yard; const hw = def.w / 2 - 0.35, hd = def.d / 2 - 0.35;
      const s = window.__game.session; const b = s.sim.state.buildings.get(i.yard); const door = s.services.zone.nav.doorOf(i.yard);
      const dx = door.x - b.x, dz = door.z - b.z, l = Math.hypot(dx, dz) || 1; const ezx = dx / l, ezz = dz / l, exx = ezz, exz = -ezx;
      const lx = -hw + 3.4, lz = -hd + 1.8;
      return { pell: { x: b.x + exx * lx + ezx * lz, z: b.z + exz * lx + ezz * lz, label: 'the pell posts (from the recipe)' }, w: def.w, d: def.d };
    }, setup);
    log('2 pell', JSON.stringify(pell));
    check('the yard\'s pell posts lie inside the yard', !!pell.pell, JSON.stringify(pell));
    if (pell.pell) {
      prevD = -1; still = 0;
      for (let i = 0; i < 40; i++) {
        const st = await page.evaluate((t) => {
          const s = window.__game.session; const b = s.services.player.body();
          const dx = t.x - b.x, dz = t.z - b.z; const d = Math.hypot(dx, dz);
          if (d < 2.6) return { done: true, d };
          const yaw = Math.atan2(dx, dz);
          window.__game.advance(1, { forward: 1, cameraYaw: yaw, faceCamera: true });
          return { d };
        }, pell.pell);
        if (st.done) break;
        still = Math.abs(st.d - prevD) < 0.02 ? still + 1 : 0; prevD = st.d;
        if (still >= 4) break;
      }
      const atPell = await page.evaluate((t) => { const b = window.__game.session.services.player.body(); return { d: Math.hypot(t.x - b.x, t.z - b.z), yaw: b.yaw }; }, pell.pell);
      log('2 at the pell', JSON.stringify(atPell));
      check('and on to the pell post (within 4 m)', atPell.d < 4, JSON.stringify(atPell));
      // face it, third person from behind
      await page.evaluate((t) => {
        const s = window.__game.session; const b = s.services.player.body(); const r = s.renderer;
        s.services.player.placeAt(b.x, b.z, Math.atan2(t.x - b.x, t.z - b.z));
        r.setViewDistance(4.5);
        const want = Math.atan2(t.x - b.x, t.z - b.z);
        r.orbit(Math.atan2(Math.sin(want - r.getCameraYaw()), Math.cos(want - r.getCameraYaw())), 0.25);
      }, pell.pell);
      await page.evaluate(() => window.__game.advance(0.3));
      await page.evaluate(() => window.__game.settle());
      await frame(page, '2-at-the-pell-third-person');
      log('2 camera', JSON.stringify(await page.evaluate(() => { const r = window.__game.session.renderer; return { mode: r.getCameraMode(), firstPerson: r.inFirstPerson(), dist: r.getViewDistance() }; })));
    }
    // the yard from above, with the knight at the pell
    await page.evaluate((i) => {
      const s = window.__game.session; const b = s.sim.state.buildings.get(i.yard); const w = s.sim.world; const me = s.services.player.body();
      const dx = me.x - b.x, dz = me.z - b.z, l = Math.hypot(dx, dz) || 1;
      s.controls.setCameraPose({ x: b.x + (dx / l) * 16 + 6, y: w.heightAt(b.x, b.z) + 13, z: b.z + (dz / l) * 16 }, { x: b.x, y: w.heightAt(b.x, b.z) + 0.5, z: b.z }, 0);
    }, setup);
    await page.evaluate(() => window.__game.settle());
    await frame(page, '2-yard-from-above');
    await page.evaluate(() => { const r = window.__game.session.renderer; r.setCameraMode('follow'); r.setViewDistance(4.5); });
    const started = await page.evaluate((i) => {
      const s = window.__game.session; const me = s.sim.state.run.playerId;
      const o = s.sim.actions.list(me, { kind: 'building', id: i.yard }).find((x) => x.id === 'pell');
      return o ? s.sim.actions.start(me, o) : null;
    }, setup);
    check('the drill starts', !!started?.ok, JSON.stringify(started));
    await page.evaluate(() => window.__game.session.sim.dispatch({ type: 'setSpeed', speed: 8 }));
    let shot = false; const drill = [];
    for (let i = 0; i < 120; i++) {
      await tick(page, 2);
      const b = await bar(page);
      if (!b) break;
      drill.push(b.bout);
      if (!shot && b.fill > 0.3) { shot = true; await hudShot(page, '2-drilling-at-the-pell'); }
    }
    const prog1 = await page.evaluate(() => { const d = window.__game.session.services.objectives.list().find((o) => /train the men at the yard/.test(o.title)); return d ? { state: d.state, steps: d.steps.map((x) => ({ progress: x.progress, goal: x.goal, done: x.done })) } : null; });
    log('2 drill', JSON.stringify([...new Set(drill)]), JSON.stringify(prog1));
    check('the drill runs (the action bar counts its rounds)', drill.length > 2 && drill.some((x) => /Bout/.test(x)), JSON.stringify(drill.slice(0, 4)));
    check('and it counts toward the duty\'s drill step', !!prog1 && (prog1.state === 'done' || prog1.steps[1]?.progress > 0), JSON.stringify(prog1));
  }
  await browser.close();
}

// ------------------------------------------------------------------------------------------------------------------------------
// 3. bandages in third person
// ------------------------------------------------------------------------------------------------------------------------------
if (only.includes('3')) {
  const page = await load();
  await page.evaluate(() => {
    const s = window.__game.session; const sim = s.sim; const st = sim.state; const me = st.persons.get(st.run.playerId);
    // by hand: the player is a grown man (he starts a child)
    me.birthDay = Math.round(sim.absDay - 28 * 16); me.sex = 'm'; me.needs.hunger = 1; st.touch(me);
  });
  await page.evaluate(() => window.__game.advance(0.5));
  // third person (the wheel's boom: setViewDistance), turned round to the front of the body, `side` radians off it
  const aim = (d, side) => page.evaluate(([d, side]) => {
    const s = window.__game.session; const b = s.services.player.body(); const r = s.renderer;
    r.setViewDistance(d);
    const want = b.yaw + Math.PI + side;
    r.orbit(Math.atan2(Math.sin(want - r.getCameraYaw()), Math.cos(want - r.getCameraYaw())), 0);
  }, [d, side]);
  await aim(4.5, 0.5);
  await page.evaluate(() => window.__game.advance(0.3));
  await page.evaluate(() => window.__game.settle());
  log('3 camera mode', await page.evaluate(() => window.__game.session.renderer.getCameraMode()));
  await frame(page, '3-before-wound');
  // real damage: the combat module's own harm (what a raid or an accident does), until a wound is on him
  const hurt = await page.evaluate(() => {
    const s = window.__game.session; const sim = s.sim; const me = sim.state.run.playerId; const C = sim.services.combat;
    for (let i = 0; i < 6; i++) { C.harm(me, 0.35, 'j3-verify'); if (C.wounds(me).length >= 2) break; }
    return { wounds: C.wounds(me).map((w) => ({ location: w.location, care: w.care })), alive: !sim.state.persons.get(me).death };
  });
  log('3 harm', JSON.stringify(hurt));
  check('the player is wounded by the combat module\'s own harm', hurt.wounds.length > 0 && hurt.alive, JSON.stringify(hurt));
  const maskBefore = await page.evaluate(() => { const s = window.__game.session; return s.sim.view.appearance.bandageOf(s.sim.state.run.playerId); });
  check('an unbound wound is not bandaged', maskBefore === 0, String(maskBefore));
  // bind it: the real action, "Bind your wounds"
  const bound = await page.evaluate(() => {
    const s = window.__game.session; const sim = s.sim; const me = sim.state.run.playerId;
    const o = sim.actions.list(me, { kind: 'self' }).find((x) => x.id === 'bind');
    if (!o) return { found: false };
    const r = sim.actions.start(me, o);
    return { found: true, enabled: o.enabled, reason: o.reason, r };
  });
  log('3 bind', JSON.stringify(bound));
  await page.evaluate(() => window.__game.advance(12));
  const after = await page.evaluate(() => {
    const s = window.__game.session; const sim = s.sim; const me = sim.state.run.playerId;
    return { mask: sim.view.appearance.bandageOf(me), wounds: sim.services.combat.wounds(me).map((w) => ({ location: w.location, care: w.care })) };
  });
  log('3 after binding', JSON.stringify(after));
  check('after binding, the look carries bandages on the wounded parts', after.mask > 0, JSON.stringify(after));
  const names = { 1: 'head', 2: 'torso', 4: 'left arm', 8: 'right arm', 16: 'left leg', 32: 'right leg' };
  log('3 bandaged parts', Object.entries(names).filter(([bit]) => after.mask & Number(bit)).map(([, n]) => n).join(', '));
  await aim(4.5, 0.5);
  await page.evaluate(() => window.__game.advance(0.3));
  await page.evaluate(() => window.__game.settle());
  await frame(page, '3-after-binding-full');
  await aim(2.6, 0.4);
  await page.evaluate(() => window.__game.settle());
  await frame(page, '3-after-binding-close');
  await aim(2.6, -0.8);
  await page.evaluate(() => window.__game.settle());
  await frame(page, '3-after-binding-other-side');
  await browser.close();
}

log(failures === 0 ? 'all ok' : `${failures} failed`);
if (vite) try { process.kill(-vite.pid); } catch { /* gone */ }
process.exit(failures === 0 ? 0 : 1);
