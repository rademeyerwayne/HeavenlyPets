// scraper/fb-grab.mjs — thin shim.
// The real grabber lives at verify/fb-grab.mjs. Some docs reference this path,
// so this simply runs the same script. Owner runs:  node scraper/fb-grab.mjs
import '../verify/fb-grab.mjs';
