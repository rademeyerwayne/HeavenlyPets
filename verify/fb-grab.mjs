// verify/fb-grab.mjs — Heavenly Pets PETSHOP Facebook GROUP grabber
// =============================================================================
// THE OWNER RUNS THIS SCRIPT, in their OWN terminal, on their OWN machine:
//
//     node verify/fb-grab.mjs          (or: npm run grab)
//
// Why the owner and not the dashboard: this group's posts/photos live in a
// MEMBERS-ONLY feed. There is no Graph API for group feeds, so the only way in
// is a browser that is already logged in as a member/admin of the group. The
// dashboard sync job runs HEADLESS and would have any real-Chrome / login
// window killed — so grabbing is a manual, owner-run step. This script never
// runs from the sync job.
//
// It writes downloaded photos + captions into  scraper/inbox/  ONLY.
// It never touches the website files. Afterwards, run the ingest step
// (node scraper/ingest.mjs, or trigger a Sync) to wire the photos into the site.
// -----------------------------------------------------------------------------
// LOGIN LADDER (pick ONE — a) is best):
//
//   a) ATTACH over CDP  ── recommended, most reliable ──────────────────────────
//      Start YOUR normal Chrome once with a debug port, logged into Facebook:
//        Windows:  chrome.exe --remote-debugging-port=9222 --profile-directory="Profile 1"
//        (adjust the profile name to whichever Chrome profile is logged into FB)
//      Then in another terminal:
//        set FB_CDP_URL=http://localhost:9222   &&  node verify/fb-grab.mjs
//        (PowerShell: $env:FB_CDP_URL="http://localhost:9222"; node verify/fb-grab.mjs)
//
//   b) REUSE your real Chrome profile ──────────────────────────────────────────
//      CLOSE every Chrome window first, then:
//        set FB_REAL=1   &&  node verify/fb-grab.mjs
//        (optionally set FB_USER_DATA_DIR and FB_PROFILE to point at the right profile)
//
//   c) CLEAN login (fallback) ──────────────────────────────────────────────────
//        node verify/fb-grab.mjs
//      A Chrome window opens on a fresh profile under scraper/.userdata — log into
//      Facebook by hand once; the session is remembered for next time.
// -----------------------------------------------------------------------------
// Useful env vars:
//   FB_CDP_URL          e.g. http://localhost:9222   -> attach mode (a)
//   FB_REAL=1           -> reuse real Chrome profile (b)
//   FB_USER_DATA_DIR    Chrome "User Data" dir (b). Default: %LOCALAPPDATA%\Google\Chrome\User Data
//   FB_PROFILE          Chrome profile dir name (b). Default: "Default"
//   GROUP_URL           override the group URL (defaults to this site's group)
//   MAX_SCROLLS         max scroll steps per view (default 40)
//   HEADLESS=1          run headless (only works if the chosen session is already logged in)
// =============================================================================

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INBOX = path.join(ROOT, 'scraper', 'inbox');

const GROUP_URL = process.env.GROUP_URL || 'https://www.facebook.com/groups/2747893658723247';
const MEDIA_URL = GROUP_URL.replace(/\/+$/, '') + '/media';
const MAX_SCROLLS = parseInt(process.env.MAX_SCROLLS || '40', 10);
const HEADLESS = process.env.HEADLESS === '1';

const log = (...a) => console.log('[fb-grab]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(INBOX, { recursive: true });

// --- open a logged-in browser context via the ladder ------------------------
async function openContext() {
  // a) ATTACH over CDP
  if (process.env.FB_CDP_URL) {
    log(`Attaching over CDP → ${process.env.FB_CDP_URL}`);
    const browser = await chromium.connectOverCDP(process.env.FB_CDP_URL);
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('CDP: no browser context found. Is Chrome running with --remote-debugging-port?');
    return { ctx, close: () => browser.close(), mode: 'cdp' };
  }

  // b) REUSE the real Chrome profile
  if (process.env.FB_REAL === '1') {
    const userData =
      process.env.FB_USER_DATA_DIR ||
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    const profile = process.env.FB_PROFILE || 'Default';
    log(`Reusing real Chrome profile → ${userData}  [${profile}]  (all Chrome windows must be CLOSED)`);
    const ctx = await chromium.launchPersistentContext(userData, {
      channel: 'chrome',
      headless: HEADLESS,
      viewport: { width: 1366, height: 900 },
      args: [`--profile-directory=${profile}`],
    });
    return { ctx, close: () => ctx.close(), mode: 'real' };
  }

  // c) CLEAN login fallback
  const userData = path.join(ROOT, 'scraper', '.userdata');
  fs.mkdirSync(userData, { recursive: true });
  log(`Clean-login profile → ${userData}`);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(userData, {
      channel: 'chrome',
      headless: false, // must be headed so the owner can log in
      viewport: { width: 1366, height: 900 },
    });
  } catch (e) {
    log('Chrome channel not available, falling back to bundled Chromium (npx playwright install chromium).');
    ctx = await chromium.launchPersistentContext(userData, {
      headless: false,
      viewport: { width: 1366, height: 900 },
    });
  }
  return { ctx, close: () => ctx.close(), mode: 'clean' };
}

async function hasLogin(ctx) {
  const cookies = await ctx.cookies('https://www.facebook.com');
  return cookies.some((c) => c.name === 'c_user' && c.value);
}

// Wait (clean-login mode) until the owner has logged in.
async function ensureLoggedIn(ctx, page) {
  if (await hasLogin(ctx)) return true;
  log('Not logged in yet. Opening facebook.com — please LOG IN in the window that appears…');
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min to log in by hand
  while (Date.now() < deadline) {
    if (await hasLogin(ctx)) {
      log('Login detected (c_user cookie present). Continuing…');
      return true;
    }
    await sleep(2000);
  }
  return false;
}

// Confirm the session can actually SEE the group feed (not redirected to login /
// "join group" wall) before sweeping.
async function canSeeGroup(page) {
  await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(3500);
  const url = page.url();
  if (/login\.php|\/login\/|checkpoint/i.test(url)) return false;
  // A visible feed usually has at least one article and NOT a prominent "Join group" gate.
  const info = await page.evaluate(() => {
    const articles = document.querySelectorAll('[role="article"]').length;
    const body = (document.body.innerText || '').slice(0, 4000).toLowerCase();
    const joinWall = /join group\b/.test(body) && articles === 0;
    return { articles, joinWall, title: document.title };
  });
  log(`Group page: "${info.title}" — ${info.articles} article(s) visible, joinWall=${info.joinWall}`);
  return !info.joinWall;
}

// Harvest genuine content images currently in the DOM, paired with a caption.
async function harvest(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const img of document.querySelectorAll('img')) {
      const src = img.currentSrc || img.src || '';
      if (!src) continue;
      if (!/fbcdn|scontent/i.test(src)) continue;           // real content CDN only
      if (/rsrc\.php|emoji|sprite|static\.xx|\/rsrc/i.test(src)) continue; // UI chrome
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 200 || h < 200) continue;                     // skip icons/avatars
      let key;
      try { key = new URL(src).pathname; } catch { key = src; }
      if (seen.has(key)) continue;
      seen.add(key);

      // Best-effort caption: nearest post container's message text.
      let caption = '';
      let permalink = '';
      const article = img.closest('[role="article"]');
      if (article) {
        const msg = article.querySelector('[data-ad-comet-preview="message"], [data-ad-preview="message"], div[dir="auto"]');
        if (msg) caption = (msg.innerText || '').trim();
        const a = article.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]');
        if (a) permalink = a.href;
      }
      if (!caption && img.alt) caption = img.alt.trim();
      out.push({ src, w, h, alt: (img.alt || '').trim(), caption, permalink, key });
    }
    return out;
  });
}

// Scroll a view incrementally, harvesting as we go (FB unmounts off-screen posts).
async function sweep(page, label, store) {
  log(`Sweeping ${label} …`);
  let stale = 0;
  for (let i = 0; i < MAX_SCROLLS; i++) {
    const batch = await harvest(page);
    let added = 0;
    for (const it of batch) {
      if (!store.has(it.key)) { store.set(it.key, it); added++; }
    }
    log(`  ${label} scroll ${i + 1}/${MAX_SCROLLS}: +${added} (total ${store.size})`);
    if (added === 0) stale++; else stale = 0;
    if (stale >= 4) { log(`  ${label}: no new images in 4 scrolls — stopping.`); break; }
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
    await sleep(1600);
  }
}

// Download bytes THROUGH the logged-in session and write to inbox.
async function download(ctx, store) {
  const captions = [];
  let idx = 0;
  for (const [key, it] of store) {
    idx++;
    const base = (path.basename(key).split('?')[0] || `img${idx}`).replace(/[^a-zA-Z0-9._-]/g, '_');
    let name = `fb-${String(idx).padStart(3, '0')}-${base}`;
    if (!/\.(jpe?g|png|webp|gif)$/i.test(name)) name += '.jpg';
    const dest = path.join(INBOX, name);
    try {
      const resp = await ctx.request.get(it.src, {
        headers: { referer: 'https://www.facebook.com/' },
        timeout: 30000,
      });
      if (!resp.ok()) { log(`  ✗ ${name} HTTP ${resp.status()}`); continue; }
      const buf = await resp.body();
      if (buf.length < 3000) { log(`  ✗ ${name} too small (${buf.length}b), skipping`); continue; }
      fs.writeFileSync(dest, buf);
      captions.push({
        file: name,
        caption: it.caption || '',
        alt: it.alt || '',
        permalink: it.permalink || '',
        source: it.src,
        width: it.w,
        height: it.h,
      });
      log(`  ✓ ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      log(`  ✗ ${name} error: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(INBOX, 'captions.json'), JSON.stringify(captions, null, 2));
  return captions.length;
}

async function main() {
  log(`Group: ${GROUP_URL}`);
  log(`Inbox: ${INBOX}`);
  const { ctx, close, mode } = await openContext();
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());

    if (!(await hasLogin(ctx))) {
      if (mode === 'clean') {
        const ok = await ensureLoggedIn(ctx, page);
        if (!ok) throw new Error('Timed out waiting for Facebook login.');
      } else {
        throw new Error(
          'This Chrome session is NOT logged into Facebook (no c_user cookie).\n' +
          '  • CDP mode: log into Facebook in the Chrome you started with --remote-debugging-port.\n' +
          '  • Real-profile mode: pick the FB_PROFILE that is logged into Facebook.'
        );
      }
    } else {
      log('Login OK (c_user cookie present).');
    }

    if (!(await canSeeGroup(page))) {
      throw new Error(
        'Logged in, but this account cannot see the group feed (join/login wall).\n' +
        'Make sure the logged-in account is a MEMBER/ADMIN of the group, then re-run.'
      );
    }

    const store = new Map();
    await sweep(page, 'group feed', store);
    await page.goto(MEDIA_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(3000);
    await sweep(page, 'media tab', store);

    log(`Harvested ${store.size} unique content image(s). Downloading…`);
    const n = await download(ctx, store);
    log(`Done. Wrote ${n} image(s) + captions.json to scraper/inbox/`);
    log('Next: run  node scraper/ingest.mjs  (or trigger a Sync) to wire them into the site.');
  } finally {
    await close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('\n[fb-grab] FAILED:', e.message, '\n');
  process.exit(1);
});
