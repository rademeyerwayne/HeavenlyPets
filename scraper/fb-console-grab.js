// =============================================================================
// scraper/fb-console-grab.js  —  Facebook group image grabber (Chrome F12 console)
// =============================================================================
// The BROWSER alternative to verify/fb-grab.mjs. Runs entirely inside your own
// logged-in Chrome — no automation, no separate login, nothing hotlinked.
//
// PHILOSOPHY (v2): CAPTURE BROADLY, PRUNE IN THE INBOX.
//   Earlier this script tried to judge "trash" and "irrelevant" in the browser
//   (min-size, host, sponsored/suggested guesses) and threw away real photos.
//   It no longer does that. The ONLY thing it drops is exact duplicates (same
//   Facebook asset id across size variants) and un-saveable/1px tracking junk.
//   Deciding what's actually shop content happens AFTER, in scraper/inbox/,
//   where the images can be looked at one by one and the junk deleted.
//
// TWO MODES (set CFG.MODE below):
//   'grid' (DEFAULT, reliable) — scrolls the page and grabs every image it can,
//                         de-duped. Works on the group Photos page AND the feed.
//                         Use this. It's what you want 99% of the time.
//   'fullres' (EXPERIMENTAL — FEED ONLY) — tries to open the photo-viewer overlay
//                         and walk it with the Next (→) arrow for sharper images.
//                         ⚠ This ONLY works from the main group FEED. On the
//                         /media/photos GRID, clicking a thumbnail NAVIGATES to a
//                         new page, which kills this script (symptom: "it opens the
//                         first photo then stops"). Don't use fullres on the grid.
//                         Tip: the sharpest images come from the shop's own
//                         website, not Facebook — those are already in the gallery.
//
// OUTPUT: heavenly-pets-fb-inbox.zip
//   ├─ fb-0001.jpg …        ← the photos (broad capture)
//   ├─ captions.json        ← {file,caption,alt,permalink}[]  (ingest.mjs reads this)
//   └─ _urls.json           ← every source URL (audit / fallback)
//
// USE (owner, ~2 min):
//   1. Log into Facebook, open the group's PHOTOS page:
//        https://www.facebook.com/groups/2747893658723247/media/photos
//   2. F12 → Console. If asked, type  allow pasting  and Enter.
//   3. Paste this whole file, Enter. In 'fullres' mode DON'T touch the
//      mouse/keyboard while it walks the viewer.
//   4. It downloads heavenly-pets-fb-inbox.zip. Unzip its CONTENTS into
//        scraper/inbox/    then run:   node scraper/ingest.mjs
//      (ingest de-dupes again by SHA-256, self-hosts, strips tagged names,
//       auto-categorises, regenerates gallery-data.js.)
// =============================================================================

(async () => {
  const CFG = {
    MODE: 'grid',          // 'grid' = reliable broad capture (RECOMMENDED) | 'fullres' = experimental, FEED-ONLY viewer walk
    MAX_SCROLLS: 120,      // grid mode: hard cap on scroll passes
    SCROLL_PAUSE: 1100,    // grid mode: ms wait after each scroll
    STOP_AFTER_STABLE: 4,  // grid mode: stop once height stops growing N times
    MAX_PHOTOS: 2000,      // fullres mode: safety cap on the Next-walk
    VIEWER_WAIT: 4500,     // fullres mode: ms to wait for the viewer / next image
    VIEWER_SETTLE: 850,    // fullres mode: ms to let each next image render
    END_STREAK: 8,         // fullres mode: stop after N consecutive already-seen photos (true wrap-around)
    MIN_BYTES: 500,        // ONLY drops 1x1 tracking/spacer pixels — NOT a content filter
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[fb-grab]', 'color:#8a63d2;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[fb-grab]', ...a);
  const waitFor = async (fn, ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch {} await sleep(120); }
    return false;
  };

  // ---- largest URL Facebook offers for an <img> ----------------------------
  function bestUrl(img) {
    let best = img.currentSrc || img.src || '';
    const ss = img.getAttribute && img.getAttribute('srcset');
    if (ss) {
      let bw = -1;
      for (const part of ss.split(',')) {
        const m = part.trim().match(/(\S+)\s+(\d+)w/);
        if (m && +m[2] > bw) { bw = +m[2]; best = m[1]; }
      }
    }
    return best;
  }

  // ---- DEDUP (kept — this is the only content decision the browser makes) ---
  // Facebook's numeric asset id is stable across every size/crop variant.
  function dedupId(url) {
    try {
      const u = new URL(url, location.href);
      const base = (u.pathname.split('/').pop() || u.pathname);
      const m = base.match(/(\d{7,})/);
      return m ? m[1] : u.pathname;
    } catch { return url; }
  }

  const found = new Map(); // dedupId -> { url, alt, caption, permalink }
  function record(url, alt, caption, permalink) {
    if (!url || /^(data:|blob:)/i.test(url)) return 'skip';   // un-saveable
    if (!/fbcdn|scontent/i.test(url)) return 'skip';          // FB-served images only (scope, not a trash filter)
    const id = dedupId(url);
    if (found.has(id)) return 'dup';
    found.set(id, { url, alt: alt || '', caption: caption || '', permalink: permalink || '' });
    return 'added';
  }

  // ---- caption/permalink helpers (context only — never used to reject) -----
  function longestAutoText(root) {
    let t = '';
    root.querySelectorAll('div[dir="auto"]').forEach((d) => {
      const s = (d.innerText || '').trim();
      if (s.length > t.length && s.length < 1500) t = s;
    });
    return t;
  }
  function nearestArticle(el) {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('role') === 'article') return n;
    }
    return null;
  }
  function gridContext(img) {
    const art = nearestArticle(img);
    if (!art) return { caption: '', permalink: '' };
    let permalink = '';
    const a = art.querySelector('a[href*="/posts/"],a[href*="/permalink/"],a[href*="story_fbid"],a[href*="/photo"]');
    if (a) permalink = (a.href || '').split('?')[0] || a.href;
    return { caption: longestAutoText(art), permalink };
  }

  // ===========================================================================
  // FULL-RES MODE — open the photo viewer, walk it with Next (→)
  // ===========================================================================
  function biggestVisibleImg(root) {
    let best = null, area = -1;
    root.querySelectorAll('img').forEach((im) => {
      const src = im.currentSrc || im.src || '';
      if (!/fbcdn|scontent/i.test(src)) return;
      const r = im.getBoundingClientRect();
      if (r.width < 60 || r.height < 60) return;                 // not the main photo
      const cx = r.left + r.width / 2;
      if (cx < 0 || cx > innerWidth) return;                     // off-screen (a preloaded neighbour)
      const a = (im.naturalWidth || 0) * (im.naturalHeight || 0);
      if (a > area) { area = a; best = im; }
    });
    return best;
  }
  function clickNext(dlg) {
    const next = dlg.querySelector(
      '[aria-label="Next photo"],[aria-label="Next"],[aria-label="See next photo"],div[aria-label*="Next"],a[aria-label*="Next"]'
    );
    if (next) { next.click(); return true; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
    return false;
  }
  async function fullResWalk() {
    const first = document.querySelector('a[href*="/photo/"],a[href*="fbid="],a[href*="/photo?"]');
    if (!first) { warn('No photo links on the page — switch to a group Photos page, or set MODE:"grid".'); return false; }
    first.click();
    if (!(await waitFor(() => document.querySelector('[role="dialog"] img'), CFG.VIEWER_WAIT))) {
      warn('Photo viewer did not open — falling back to grid mode.'); return false;
    }
    let steps = 0, streak = 0, misses = 0, prevId = null;
    while (steps++ < CFG.MAX_PHOTOS) {
      if (!document.querySelector('[role="dialog"]')) { warn('viewer closed/navigated away — stopping walk (use grid mode on the Photos page).'); break; }
      const dlg = document.querySelector('[role="dialog"]') || document;
      await waitFor(() => { const im = biggestVisibleImg(dlg); return im && im.naturalWidth > 0; }, CFG.VIEWER_WAIT);
      const im = biggestVisibleImg(dlg);
      let res = 'skip';
      if (im) {
        const url = bestUrl(im);
        const id = dedupId(url);
        res = record(url, im.alt || '', longestAutoText(dlg), (location.href || '').split('&set=')[0]);
        if (id && id === prevId) res = 'dup';
        prevId = id;
      }
      // added → reset. dup → count toward wrap-around end. no image → transient miss (don't end early).
      if (res === 'added') { streak = 0; misses = 0; }
      else if (res === 'dup') { streak++; }
      else { misses++; }
      if (steps % 10 === 0) log(`viewer ${steps} · ${found.size} unique so far`);
      if (streak >= CFG.END_STREAK) { log('viewer: looped back to already-seen photos — stopping.'); break; }
      if (misses >= 12) { warn('viewer: no images detected repeatedly — stopping (try grid mode).'); break; }
      clickNext(dlg);
      await sleep(CFG.VIEWER_SETTLE);
    }
    const close = document.querySelector('[role="dialog"] [aria-label="Close"],[aria-label="Close"]');
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
    return true;
  }

  // ===========================================================================
  // GRID MODE — scroll & harvest thumbnails (and CSS background photos)
  // ===========================================================================
  function harvestGrid() {
    for (const img of document.images) {
      try { const c = gridContext(img); record(bestUrl(img), img.alt || '', c.caption, c.permalink); } catch {}
    }
    for (const el of document.querySelectorAll('[style*="url("]')) {
      try {
        const m = (el.style.backgroundImage || '').match(/url\((['"]?)(.*?)\1\)/i);
        if (m) record(m[2], el.getAttribute('aria-label') || '', '', '');
      } catch {}
    }
  }
  async function gridScroll() {
    let lastH = 0, stable = 0;
    harvestGrid();
    for (let i = 0; i < CFG.MAX_SCROLLS; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await sleep(CFG.SCROLL_PAUSE);
      harvestGrid();
      const h = document.body.scrollHeight;
      if (h === lastH) { if (++stable >= CFG.STOP_AFTER_STABLE) { log('reached the end.'); break; } } else stable = 0;
      lastH = h;
      if ((i + 1) % 5 === 0) log(`scroll ${i + 1}/${CFG.MAX_SCROLLS} · height ${h} · ${found.size} unique so far`);
    }
    window.scrollTo(0, 0);
    harvestGrid();
  }

  // ---- run the chosen mode -------------------------------------------------
  log(`starting in ${CFG.MODE.toUpperCase()} mode — do not switch tabs…`);
  if (CFG.MODE === 'fullres') {
    const ok = await fullResWalk();
    if (!ok) { log('falling back to GRID mode…'); await gridScroll(); }
  } else {
    await gridScroll();
  }
  log(`harvest done — ${found.size} unique photos (duplicates already removed). Fetching bytes…`);
  if (found.size === 0) { warn('Nothing found. Make sure you are a group member and on the Photos/feed page, then re-run.'); return; }

  // ---- tiny STORE-only ZIP writer (no libraries; jpgs are already compressed)
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const u16 = (n) => { n >>>= 0; return new Uint8Array([n & 255, (n >>> 8) & 255]); };
  const u32 = (n) => { n >>>= 0; return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); };
  const cat = (...a) => { let len = 0; for (const x of a) len += x.length; const o = new Uint8Array(len); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  function makeZip(entries) {
    const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), data = e.data, crc = crc32(data);
      const local = cat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name);
      parts.push(local, data);
      central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name));
      offset += local.length + data.length;
    }
    const cdStart = offset; let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }
    parts.push(cat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0)));
    return new Blob(parts, { type: 'application/zip' });
  }

  // ---- fetch every image (no size/relevance filtering — prune later in inbox)
  const files = [], captions = [], urls = [];
  let i = 0, ok = 0, fail = 0;
  for (const item of found.values()) {
    i++;
    let blob;
    try {
      const r = await fetch(item.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      blob = await r.blob();
    } catch (e) { fail++; urls.push({ file: null, url: item.url, error: String(e.message || e), caption: item.caption, alt: item.alt, permalink: item.permalink }); continue; }
    if (!blob || blob.size < CFG.MIN_BYTES || !/^image\//.test(blob.type || 'image/')) { fail++; continue; }
    // extension from URL, else from mime type
    let ext = '.jpg';
    const em = item.url.split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
    if (em) ext = '.' + em[1].toLowerCase().replace('jpeg', 'jpg');
    else if (blob.type) { const mt = (blob.type.split('/')[1] || '').toLowerCase(); if (/^(jpeg|jpg|png|webp|gif)$/.test(mt)) ext = '.' + mt.replace('jpeg', 'jpg'); }
    const name = `fb-${String(++ok).padStart(4, '0')}${ext}`;
    files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    captions.push({ file: name, caption: item.caption, alt: item.alt, permalink: item.permalink });
    urls.push({ file: name, url: item.url, caption: item.caption, alt: item.alt, permalink: item.permalink });
    if (i % 10 === 0) log(`fetched ${i}/${found.size}  (saved ${ok}, skipped ${fail})`);
  }

  if (ok === 0) {
    warn('Every fetch failed (usually CORS). Fallback: run the Node grabber — node verify/fb-grab.mjs. URLs below:');
    console.log(JSON.stringify(urls, null, 2));
    return;
  }

  const enc = new TextEncoder();
  files.push({ name: 'captions.json', data: enc.encode(JSON.stringify(captions, null, 2)) });
  files.push({ name: '_urls.json', data: enc.encode(JSON.stringify(urls, null, 2)) });

  const zip = makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(zip);
  a.download = 'heavenly-pets-fb-inbox.zip';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);

  log(`DONE ✅  ${ok} images saved, ${fail} skipped, de-duped from ${found.size} candidates.`);
  log('Next: unzip heavenly-pets-fb-inbox.zip INTO scraper/inbox/  then run:  node scraper/ingest.mjs  (trash gets pruned there).');
})();
