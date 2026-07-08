# Heavenly Pets PETSHOP — website

A single-file static website for **Heavenly Pets PETSHOP** (Meyerton, Gauteng).

## What gets deployed
Only these three things are the live site — everything else is dev tooling:

```
index.html        ← the whole site (HTML + CSS + JS inline)
gallery-data.js   ← auto-generated gallery list (window.GALLERY)
images/           ← self-hosted photos + og-cover.png
```

Just open `index.html` in a browser, or host these files anywhere static.

## Adding your Facebook photos (owner, 2 steps)

The gallery is empty until you pull in your group's photos. There is **no Facebook
API for group feeds**, so photos come through **your own logged-in Chrome**. This is
a manual step you run on your own machine — it can't run from the dashboard.

**Step 1 — grab (run in your own terminal, logged into Facebook):**

```bash
npm install                 # first time only
node verify/fb-grab.mjs     # or:  node scraper/fb-grab.mjs
```

Easiest login method — attach to your normal Chrome:

```bash
# 1) start Chrome once with a debug port (adjust the profile that is logged into FB)
chrome.exe --remote-debugging-port=9222 --profile-directory="Profile 1"
# 2) then, in another terminal:
set FB_CDP_URL=http://localhost:9222 && node verify/fb-grab.mjs
```

(Alternatives: `FB_REAL=1` to reuse your real Chrome profile with all Chrome windows
closed, or just `node verify/fb-grab.mjs` to log in once in a fresh window.)

This downloads your posts' photos + captions into `scraper/inbox/`.

> **No-install alternative — browser console (F12).** If you'd rather not run Node
> for the grab, use [`scraper/fb-console-grab.js`](scraper/fb-console-grab.js).
> Log into Facebook, open the group's **Photos** page
> (`.../groups/<id>/media/photos`), press **F12 → Console**, paste the whole file,
> and Enter. It scrolls, drops scrap (avatars, emoji, icons, sponsored/suggested
> and link-preview junk), de-dupes Facebook's size variants, and downloads
> `heavenly-pets-fb-inbox.zip`. **Unzip its contents into `scraper/inbox/`**
> (you'll get `fb-0001.jpg …` + `captions.json`), then do Step 2. Same inbox, same
> ingest — so `ingest.mjs` still de-dupes again by SHA-256 and self-hosts everything.

**Step 2 — ingest (wire them into the site):**

```bash
node scraper/ingest.mjs
```

This self-hosts each photo under `images/`, strips tagged people's names from the
captions, auto-categorises them, and regenerates `gallery-data.js`. Re-open
`index.html` and the gallery is live. Both steps are safe to re-run — already-added
photos are skipped.

## Dev / verification
```bash
node verify/screenshot.mjs   # headless screenshots → verify/screenshots/ + regenerates og-cover.png
```

Everything self-hosts — no Facebook/fbcdn URLs are ever hotlinked, and only this
group's own content is used.
