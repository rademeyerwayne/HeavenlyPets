// scraper/ingest.mjs — turn scraper/inbox/ into self-hosted gallery content.
// =============================================================================
// Reads ONLY  scraper/inbox/  (never facebook.com). For each image it:
//   • de-dupes by SHA-256 (safe to re-run; already-ingested images are skipped),
//   • self-hosts it under  images/  (copied bytes — nothing is ever hotlinked),
//   • strips tagged people's NAMES from the caption (keeps the description),
//   • auto-categorises it (food / pets / accessories / store),
//   • regenerates  gallery-data.js  (window.GALLERY) + images/manifest.md.
//
// Run:  node scraper/ingest.mjs   (or: npm run ingest)
// Empty inbox is fine — it just writes an empty gallery (site shows a friendly
// "photos coming soon" state until the owner runs fb-grab).
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const INBOX = path.join(ROOT, 'scraper', 'inbox');
const IMAGES = path.join(ROOT, 'images');
const META = path.join(IMAGES, 'gallery-meta.json'); // sidecar: accumulates across runs
const GALLERY_JS = path.join(ROOT, 'gallery-data.js');
const MANIFEST = path.join(IMAGES, 'manifest.md');

const IMG_RE = /\.(jpe?g|png|webp|gif)$/i;
const log = (...a) => console.log('[ingest]', ...a);

fs.mkdirSync(IMAGES, { recursive: true });
fs.mkdirSync(INBOX, { recursive: true });

// ---- caption cleaning ------------------------------------------------------
// Remove Facebook's "tagged people" noise while keeping the real description.
function stripNames(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\r/g, ' ').replace(/\n+/g, ' ').trim();

  // FB auto-alt boilerplate -> drop (not a real caption)
  s = s.replace(/^\s*(may be|could be)\s+an?\s+image\s+of[^.]*\.?/i, '');
  s = s.replace(/\bno photo description available\.?/i, '');

  // "— with John Doe, Jane Roe and 3 others" tag lists
  s = s.replace(/\s*[—–-]?\s*\bwith\s+[A-Z][\w''.-]+(?:\s+[A-Z][\w''.-]+)*(?:\s*,\s*[A-Z][\w''.-]+(?:\s+[A-Z][\w''.-]+)*)*(?:\s*,?\s*and\s+\d+\s+others?)?/g, ' ');
  // "and 5 others" leftovers
  s = s.replace(/\s*,?\s*and\s+\d+\s+others?\b/gi, ' ');
  // "is with Jane" / "was with Jane" (proper-name tags only — case-sensitive [A-Z])
  s = s.replace(/\b(?:is|was|are|were)\s+with\s+[A-Z][\w''.-]+(?:\s+[A-Z][\w''.-]+)*/g, '');
  // "feeling excited" status noise
  s = s.replace(/\bfeeling\s+\w+/gi, '');
  // "Firstname Lastname shared/updated/posted ..." author prefixes.
  // NOTE: case-SENSITIVE (real proper names) and social-action verbs only — do NOT
  // include generic "is/was" or a normal caption like "This puppy is ..." gets wiped.
  s = s.replace(/^[A-Z][a-z''.-]+(?:\s+[A-Z][a-z''.-]+){1,2}\s+(?:shared|updated|posted|added|uploaded)\b.*$/, '');

  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  s = s.replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '').trim();

  // If what's left is basically just a person's name (1–3 capitalised words), drop it.
  if (/^[A-Z][\w''.-]+(?:\s+[A-Z][\w''.-]+){0,2}$/.test(s) && !/\b(dog|cat|pet|food|shop|store|treat|adopt)\b/i.test(s)) {
    return '';
  }
  return s;
}

// ---- auto-categorise -------------------------------------------------------
const CATS = [
  { c: 'food', label: 'Food & Treats', words: /\b(food|kibble|treat|feed|feeding|biscuit|meal|nutrition|snack|chew|bone|wet food|dry food|montego|hills|eukanuba|royal canin|bobtail|pedigree|whiskas|acana|orijen|supawon|canine|feline diet|pellets)\b/i },
  { c: 'pets', label: 'Pets & Adoption', words: /\b(adopt|adoption|rehome|rescue|puppy|puppies|kitten|kittens|rabbit|bunny|hamster|guinea pig|fish|goldfish|bird|budgie|parrot|reptile|tortoise|snake|for adoption|new arrival)\b/i },
  { c: 'accessories', label: 'Accessories & Care', words: /\b(collar|leash|lead|harness|bed|bedding|blanket|toy|toys|bowl|cage|tank|aquarium|kennel|groom|grooming|shampoo|litter|scratch|scratching|carrier|crate|hutch|treat ball)\b/i },
  { c: 'store', label: 'In the Shop', words: /\b(shop|store|shelf|shelves|open|opening|hours|sneak peek|new stock|arrived|in store|in-store|sale|special|specials|promo|promotion|discount|counter|display)\b/i },
];
function categorise(text) {
  const t = (text || '').toLowerCase();
  for (const cat of CATS) if (cat.words.test(t)) return cat.c;
  return 'store'; // sensible default: general shop content
}

// ---- gather inbox ----------------------------------------------------------
let captionMap = {};
const capFile = path.join(INBOX, 'captions.json');
if (fs.existsSync(capFile)) {
  try {
    const arr = JSON.parse(fs.readFileSync(capFile, 'utf8'));
    for (const e of arr) captionMap[e.file] = e;
  } catch (e) { log('warning: could not parse captions.json —', e.message); }
}

const inboxImages = fs.existsSync(INBOX)
  ? fs.readdirSync(INBOX).filter((f) => IMG_RE.test(f)).sort()
  : [];

// existing meta (accumulates across runs)
let meta = [];
if (fs.existsSync(META)) {
  try { meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch { meta = []; }
}
const known = new Set(meta.map((m) => m.hash));
const usedNames = new Set(meta.map((m) => m.file));

function nextName(ext) {
  let i = meta.length + 1;
  let name;
  do { name = `hp-${String(i).padStart(3, '0')}${ext}`; i++; } while (usedNames.has(name) || fs.existsSync(path.join(IMAGES, name)));
  usedNames.add(name);
  return name;
}

let added = 0;
for (const f of inboxImages) {
  const src = path.join(INBOX, f);
  let buf;
  try { buf = fs.readFileSync(src); } catch { continue; }
  if (buf.length < 3000) { log(`skip ${f} (too small)`); continue; }
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (known.has(hash)) { log(`skip ${f} (already ingested)`); continue; }
  known.add(hash);

  const ext = (path.extname(f) || '.jpg').toLowerCase();
  const name = nextName(ext === '.jpeg' ? '.jpg' : ext);
  fs.writeFileSync(path.join(IMAGES, name), buf);

  const info = captionMap[f] || {};
  const cap = stripNames(info.caption || info.alt || '');
  const cat = categorise(`${info.caption || ''} ${info.alt || ''} ${cap}`);
  meta.push({ file: name, c: cat, cap, hash, permalink: info.permalink || '', from: f });
  added++;
  log(`+ ${f} → images/${name}  [${cat}]  "${cap || '(no caption)'}"`);
}

// ---- write outputs ---------------------------------------------------------
fs.writeFileSync(META, JSON.stringify(meta, null, 2));

const gallery = meta.map((m) => ({ f: `images/${m.file}`, c: m.c, cap: m.cap }));
const banner = '// AUTO-GENERATED by scraper/ingest.mjs — do not edit by hand.\n' +
  '// Source: this group\'s own Facebook posts, self-hosted under images/.\n';
fs.writeFileSync(GALLERY_JS, `${banner}window.GALLERY = ${JSON.stringify(gallery, null, 2)};\n`);

// manifest.md (one line per image)
const catLabel = Object.fromEntries(CATS.map((c) => [c.c, c.label]));
let md = '# images/ manifest\n\nSelf-hosted from the Heavenly Pets PETSHOP Facebook group. One line per image.\n\n';
if (meta.length === 0) {
  md += '_No images yet — run `node verify/fb-grab.mjs` (owner) then `node scraper/ingest.mjs`._\n';
} else {
  for (const m of meta) md += `- \`images/${m.file}\` — ${catLabel[m.c] || m.c} — ${m.cap || '(no caption)'}\n`;
}
fs.writeFileSync(MANIFEST, md);

log('—');
log(`inbox images: ${inboxImages.length}, newly ingested: ${added}, gallery total: ${meta.length}`);
log(`wrote: gallery-data.js (${gallery.length} item(s)), images/manifest.md, images/gallery-meta.json`);
if (meta.length === 0) {
  log('Gallery is empty. Owner: run  node verify/fb-grab.mjs  (log in once), then re-run this.');
}
