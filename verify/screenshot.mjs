// verify/screenshot.mjs — headless verification of the built site.
// Renders index.html from file://, scrolls to trigger IntersectionObserver
// reveals + lazy images, captures 1440 + 390 screenshots, collects console
// errors, and generates images/og-cover.png (1200x630 social card).
// Run: node verify/screenshot.mjs   (or: npm run verify)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'verify', 'screenshots');
const INDEX = pathToFileURL(path.join(ROOT, 'index.html')).href;
fs.mkdirSync(SHOTS, { recursive: true });

const LOGO = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'images', 'logo-mark.png')).toString('base64');
const OG_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,600;0,9..144,700;1,9..144,600&family=Nunito+Sans:wght@700;800&display=swap" rel="stylesheet">
<style>
  html,body{margin:0}
  .card{width:1200px;height:630px;display:flex;flex-direction:column;justify-content:center;padding:0 92px;
    background:radial-gradient(120% 90% at 82% 8%, #EAF7EE 0%, #FBF7F0 46%, #F4ECDC 100%);
    font-family:"Nunito Sans",sans-serif;color:#233028;box-sizing:border-box;position:relative;overflow:hidden}
  .halo{position:absolute;right:-40px;top:-60px;width:520px;height:520px;border-radius:50%;
    background:radial-gradient(closest-side, rgba(32,177,79,.28), transparent 70%)}
  .halo2{position:absolute;left:-90px;bottom:-140px;width:420px;height:420px;border-radius:50%;
    background:radial-gradient(closest-side, rgba(242,180,65,.30), transparent 70%)}
  .eyebrow{font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:#12833B;font-size:21px;margin-bottom:18px;position:relative}
  h1{font-family:Fraunces,serif;font-weight:600;font-size:76px;line-height:1.02;margin:0 0 26px;letter-spacing:-.015em;max-width:15ch;position:relative}
  h1 em{font-style:italic;color:#12833B}
  .row{display:flex;align-items:center;gap:18px;position:relative}
  .mark{width:86px;height:86px;object-fit:contain;filter:drop-shadow(0 8px 16px rgba(15,51,32,.28))}
  .name{font-family:Fraunces,serif;font-weight:600;font-size:30px;color:#0F3320}
  .loc{font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#12833B;font-size:15px}
</style></head><body>
<div class="card">
  <div class="halo"></div><div class="halo2"></div>
  <div class="eyebrow">Meyerton's neighbourhood pet emporium</div>
  <h1>Everything your pets need, <em>under one heavenly roof.</em></h1>
  <div class="row">
    <img class="mark" src="${LOGO}" alt="">
    <div><div class="name">Heavenly Pets PETSHOP</div><div class="loc">Meyerton · Gauteng</div></div>
  </div>
</div></body></html>`;

const errors = [];
const browser = await chromium.launch({ headless: true });
try {
  // --- OG cover ---
  const ogPage = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await ogPage.setContent(OG_HTML, { waitUntil: 'networkidle' });
  await ogPage.waitForTimeout(600);
  fs.mkdirSync(path.join(ROOT, 'images'), { recursive: true });
  await ogPage.screenshot({ path: path.join(ROOT, 'images', 'og-cover.png') });
  console.log('[verify] wrote images/og-cover.png');
  await ogPage.close();

  // --- site screenshots at two widths ---
  for (const [label, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
    await page.goto(INDEX, { waitUntil: 'networkidle' });

    // Scroll through naturally, DRIVEN FROM NODE (one evaluate per step with a
    // real wait between) so scroll events + IntersectionObserver reveals actually
    // fire and lazy images load. Cramming this into a single async evaluate
    // starves those callbacks and screenshots blank sections.
    const docH = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < docH; y += Math.round(height * 0.8)) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(180);
    }
    await page.waitForTimeout(400);

    // audit facts
    const audit = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const galEmptyVisible = getComputedStyle(q('#gal-empty')).display !== 'none';
      const hiddenReveals = [...document.querySelectorAll('.reveal')].filter((el) => !el.classList.contains('in')).length;
      const anchors = [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href'));
      const brokenAnchors = anchors.filter((h) => h.length > 1 && !document.querySelector(h));
      return {
        title: document.title,
        galEmptyVisible,
        hiddenReveals,
        brokenAnchors,
        galItems: (window.GALLERY || []).length,
      };
    });
    console.log(`[verify] ${label} audit:`, JSON.stringify(audit));

    await page.screenshot({ path: path.join(SHOTS, `${label}.png`), fullPage: true });
    // above-the-fold at scroll 0 (truthful header/hero; backdrop-blur composites here)
    // instant (not smooth) so we don't screenshot mid scroll-animation
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `${label}-fold.png`), fullPage: false });
    console.log(`[verify] wrote verify/screenshots/${label}.png + ${label}-fold.png`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length) { console.log('\n[verify] CONSOLE/PAGE ERRORS:\n' + errors.join('\n')); process.exitCode = 2; }
else console.log('\n[verify] No console/page errors. ✅');
