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

const OG_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Karla:wght@700&display=swap" rel="stylesheet">
<style>
  html,body{margin:0}
  .card{width:1200px;height:630px;display:flex;flex-direction:column;justify-content:center;padding:0 96px;
    background:radial-gradient(120% 90% at 80% 10%, #FFF4DC 0%, #EEF4FA 45%, #DDE9F5 100%);
    font-family:Karla,sans-serif;color:#28303B;box-sizing:border-box;position:relative;overflow:hidden}
  .halo{position:absolute;right:-60px;top:-40px;width:520px;height:520px;border-radius:50%;
    background:radial-gradient(closest-side, rgba(242,180,65,.42), transparent 70%)}
  .eyebrow{font-weight:700;letter-spacing:.24em;text-transform:uppercase;color:#C98A1E;font-size:22px;margin-bottom:18px}
  h1{font-family:Fraunces,serif;font-weight:600;font-size:78px;line-height:1.03;margin:0 0 22px;letter-spacing:-.01em;max-width:16ch}
  h1 em{font-style:italic;color:#2F6094}
  .row{display:flex;align-items:center;gap:16px;margin-top:8px}
  .mark{width:78px;height:78px;filter:drop-shadow(0 6px 14px rgba(47,96,148,.3))}
  .name{font-family:Fraunces,serif;font-weight:600;font-size:30px}
  .loc{font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#2F6094;font-size:16px}
</style></head><body>
<div class="card">
  <div class="halo"></div>
  <div class="eyebrow">Meyerton's neighbourhood pet shop</div>
  <h1>Everything your pets need, <em>under one heavenly roof.</em></h1>
  <div class="row">
    <svg class="mark" viewBox="0 0 64 64"><circle cx="32" cy="35" r="27" fill="#3E7CB1"/><ellipse cx="32" cy="14.5" rx="15" ry="5" fill="none" stroke="#F2B441" stroke-width="3"/><g fill="#FBF7F0"><circle cx="24" cy="35" r="4.4"/><circle cx="40" cy="35" r="4.4"/><circle cx="27.5" cy="27.5" r="3.8"/><circle cx="36.5" cy="27.5" r="3.8"/><path d="M32 34c5.8 0 9.6 4.8 9.6 9 0 3.8-3.4 5.3-6.3 4-2.1-.95-4.6-.95-6.7 0-2.9 1.3-6.3-.2-6.3-4 0-4.2 3.9-9 9.7-9z"/></g></svg>
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
