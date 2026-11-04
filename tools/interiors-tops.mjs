// The walkable tops of the fortifications (docs/INTERIORS.md): every tower, gatehouse, curtain wall and palisade at every level,
// seen from above in the asset gallery — a fighting top is open or crenellated, never roofed over.
//
//   PORT=5294 node tools/interiors-tops.mjs [culture ...]     → <SHOTS_OUT or docs/interiors>/tops-<kind><level>-<culture>.png
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.SHOTS_OUT ? resolve(process.env.SHOTS_OUT) : resolve(ROOT, 'docs/interiors');
const PORT = Number(process.env.PORT ?? 5294);
const cultures = process.argv.slice(2).length ? process.argv.slice(2) : ['anglo', 'norse'];
const items = [['tower', 1], ['tower', 2], ['gatehouse', 1], ['gatehouse', 2], ['wall', 1], ['wall', 2], ['palisade', 2]];

const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, BROWSER: 'none' }, detached: true });
await new Promise((r) => setTimeout(r, 6000));
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.setDefaultTimeout(120000);
try {
  for (const culture of cultures) for (const [item, level] of items) {
    const url = `http://localhost:${PORT}/?mode=gallery&shot=1&cat=buildings&item=${item}&level=${level}&culture=${culture}&az=-35&el=50`;
    await page.goto(url);
    await page.waitForFunction(() => window.__galleryReady === true, null, { timeout: 120000, polling: 250 });
    await page.waitForTimeout(500);
    const file = resolve(OUT, `tops-${item}${level}-${culture}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} finally {
  await browser.close();
  try { process.kill(-proc.pid); } catch { /* gone */ }
}
